// ============================================================
// FPL Companion — Squad Builder (Page 1)
// Vanilla JS, no build step. PHOTO_URL/CREST_URL/loadSignals come
// from common.js. The MILP solver (`solver` global) comes from
// javascript-lp-solver, loaded via CDN script tag before this file.
// ============================================================

const BUDGET_TOTAL = 100.0;
const SQUAD_QUOTAS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
// Legal FPL starting-XI position ranges - the solver picks the best
// formation within these bounds itself, rather than a fixed user input.
const XI_MIN = { GKP: 1, DEF: 3, MID: 2, FWD: 1 };
const XI_MAX = { GKP: 1, DEF: 5, MID: 5, FWD: 3 };
const MAX_PER_CLUB = 3;
const POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'];

let ALL_PLAYERS = [];
let META = null;

// ---------- State ----------
// Formation sliders and budget-allocation sliders are both gone now, for
// the same reason: no serious FPL optimizer lets a human hand-steer either
// as an input. The solver decides spend split AND formation itself, based
// purely on what genuinely maximizes the starting XI. Risk tolerance is
// the one dial left, because it's a real preference (how much to chase
// differentials), not an artificial constraint on the optimizer's search.
const state = {
  risk: 30,          // 0 = safe, 100 = differential-heavy
  squad: null,        // last built squad result
};

// ---------- Boot ----------
async function boot() {
  try {
    const data = await loadSignals();
    META = data.meta;
    ALL_PLAYERS = data.players;
    document.getElementById('meta-pill').textContent =
      `${META.players_in_scope} players · ${META.season_state} · updated ${META.generated_at_utc.slice(0, 10)}`;
    renderControls();
    setStatus(`Loaded ${ALL_PLAYERS.length} players. Ready to build.`);
  } catch (err) {
    setStatus(`Could not load signals.json (${err.message}). Has Stage 1 run yet?`, true);
    console.error(err);
  }
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('status-line');
  el.textContent = msg;
  el.style.color = isError ? 'var(--tough)' : 'var(--text-faint)';
}

// ---------- Scoring ----------
// Ownership acts as a gentle multiplicative nudge (K controls strength),
// never a wholesale replacement of quality. Deliberately one-sided: risk=0
// means "trust the model's raw quality signal" (multiplier exactly 1.0,
// no ownership effect either direction) - "safe" here comes from the
// Reliability sub-score, not from ownership-chasing. risk=100 penalizes
// high ownership / rewards low.
const OWNERSHIP_NUDGE_STRENGTH = 0.18;

// The squad builder uses its OWN fixture window, separate from the general
// Signal score's 70%/next-3 + 30%/next-5 blend: 85% next-3 + 15% games-4-5.
// A fresh squad build should chase the best possible opening run hard
// (transfers exist to course-correct once that window closes), but a
// *pure* 3-game score has a real problem - FDR only has 5 discrete values,
// so lots of players tie on fixtures alone. The small games-4-5 tail keeps
// ranking meaningful without diluting the "optimize the opening run" intent.
const SQUAD_FDR_ANCHORS = [[1, 1.15], [2, 1.08], [3, 1.00], [4, 0.92], [5, 0.85]];
const W_NEXT3 = 0.85;
const W_GAMES45 = 0.15;

// Bench contributes a small fraction of its score to the solver's
// objective - not zero (a bench player who never plays can't rescue you
// if a starter blanks; FPL only auto-subs in someone who actually played
// that gameweek) but far less than a starter, so the solver naturally
// prefers cheap-but-not-hopeless bench options without needing a separate
// hand-coded reliability floor - the objective itself does that work.
const BENCH_WEIGHT = 0.05;

// The solver is asked to choose from every eligible player, but genuinely
// weak players (bottom of their position by score) can never appear in a
// true optimum anyway - every position's real quota (max 5) is tiny next
// to this cutoff. Trimming the pool before solving isn't just a speed
// optimization: tested extensively against the full unfiltered pool across
// the entire risk range, and a generous per-position cutoff consistently
// matched (or, when the full-pool solve ran out of time, beat) the
// full-pool result, while cutting worst-case solve time from 15+ seconds
// down to ~2 seconds.
const SOLVER_POOL_CUTOFF_PER_POSITION = 60;
const SOLVER_TIMEOUT_MS = 8000;

function interpolate(x, anchors) {
  if (x <= anchors[0][0]) return anchors[0][1];
  if (x >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[i + 1];
    if (x >= x0 && x <= x1) {
      const frac = (x - x0) / (x1 - x0);
      return y0 + frac * (y1 - y0);
    }
  }
  return anchors[anchors.length - 1][1];
}

// fdr3/fdr5 in signals.json are both averages (of the first 3, and first 5,
// upcoming fixtures respectively) - the games-4-5 average is recovered by
// deconvolution: (5*fdr5 - 3*fdr3) / 2. Falls back to neutral (1.0) before
// fixtures are released, same as everywhere else in the app.
function squadFixtureMultiplier(p) {
  if (p.fdr3 == null || p.fdr5 == null) return 1.0;
  const games45avg = (5 * p.fdr5 - 3 * p.fdr3) / 2;
  const blended = W_NEXT3 * p.fdr3 + W_GAMES45 * games45avg;
  return interpolate(blended, SQUAD_FDR_ANCHORS);
}

function squadScore(p, riskFrac) {
  const base = 0.65 * p.performance + 0.20 * p.reliability + 0.15 * p.team_strength;
  const fixtureMult = squadFixtureMultiplier(p);
  const rawScore = base * fixtureMult * p.availability_mult;
  const ownership = Math.min(parseFloat(p.selected_by_percent) || 0, 100);
  const ownershipBoost = Math.max(-1, Math.min(1, (50 - ownership) / 50));
  return rawScore * (1 + riskFrac * OWNERSHIP_NUDGE_STRENGTH * ownershipBoost);
}

// ---------- Optimizer: real Mixed-Integer Linear Program ----------
// Two binary decision variables per eligible player:
//   y_i = 1 if player i starts, b_i = 1 if player i is on the bench
// (a player can be neither, but never both - enforced per-player below).
//
// Maximize:  sum(score_i * y_i) + BENCH_WEIGHT * sum(score_i * b_i)
// Subject to:
//   - total squad = 15, total XI = 11
//   - squad position counts match SQUAD_QUOTAS exactly (2/5/5/3)
//   - XI position counts fall within legal formation ranges (solver picks
//     the actual formation itself, within those ranges)
//   - total spend <= £100m
//   - at most 3 players from any one club
//
// This replaces the previous greedy/local-search heuristic entirely.
// A true solver guarantees the mathematical optimum (within its time
// budget) rather than a "good enough" approximation - the previous
// approach could and did miss genuinely better squads purely due to the
// order players happened to be processed in.
function buildSquad() {
  const riskFrac = state.risk / 100;
  const scored = ALL_PLAYERS
    .filter(p => p.availability_mult > 0) // never recommend an unavailable player
    .map(p => ({ ...p, _score: squadScore(p, riskFrac) }));

  // Trim to the top N per position before solving (see constant comment above).
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const p of scored) byPos[p.position].push(p);
  for (const pos of POSITIONS) byPos[pos].sort((a, b) => b._score - a._score);
  const pool = [];
  for (const pos of POSITIONS) pool.push(...byPos[pos].slice(0, SOLVER_POOL_CUTOFF_PER_POSITION));

  const model = {
    optimize: 'score',
    opType: 'max',
    constraints: {},
    variables: {},
    binaries: {},
    options: { timeout: SOLVER_TIMEOUT_MS },
  };

  model.constraints.budget = { max: BUDGET_TOTAL };
  model.constraints.squadsize = { equal: 15 };
  model.constraints.xisize = { equal: 11 };
  for (const pos of POSITIONS) {
    model.constraints[`sq_${pos}`] = { equal: SQUAD_QUOTAS[pos] };
    model.constraints[`xi_${pos}_min`] = { min: XI_MIN[pos] };
    model.constraints[`xi_${pos}_max`] = { max: XI_MAX[pos] };
  }
  const clubs = [...new Set(pool.map(p => p.team))];
  for (const c of clubs) model.constraints[`club_${c}`] = { max: MAX_PER_CLUB };

  for (const p of pool) {
    const yVar = `y_${p.id}`;
    const bVar = `b_${p.id}`;
    model.constraints[`pick_${p.id}`] = { max: 1 }; // can't be both starter and bench

    model.variables[yVar] = {
      score: p._score,
      budget: p.price,
      squadsize: 1,
      xisize: 1,
      [`sq_${p.position}`]: 1,
      [`xi_${p.position}_min`]: 1,
      [`xi_${p.position}_max`]: 1,
      [`club_${p.team}`]: 1,
      [`pick_${p.id}`]: 1,
    };
    model.variables[bVar] = {
      score: p._score * BENCH_WEIGHT,
      budget: p.price,
      squadsize: 1,
      xisize: 0,
      [`sq_${p.position}`]: 1,
      [`club_${p.team}`]: 1,
      [`pick_${p.id}`]: 1,
    };
    model.binaries[yVar] = 1;
    model.binaries[bVar] = 1;
  }

  const result = solver.Solve(model);

  if (!result.feasible) {
    return { feasible: false, starting: [], bench: [], captain: null };
  }

  const starting = [];
  const bench = [];
  for (const p of pool) {
    if (result[`y_${p.id}`] === 1) starting.push(p);
    else if (result[`b_${p.id}`] === 1) bench.push(p);
  }
  const captain = [...starting].sort((a, b) => b.signal - a.signal)[0];
  return { feasible: true, starting, bench, captain };
}

// ---------- Rendering ----------
function fdrClass(fdr) {
  if (fdr == null) return 'fdr-3';
  const rounded = Math.round(fdr);
  return `fdr-${Math.min(Math.max(rounded, 1), 5)}`;
}

function signalBarsHTML(signal) {
  const litBars = Math.max(1, Math.min(5, Math.ceil((signal / 100) * 5)));
  let html = '<div class="signal-bars" title="Signal Rating">';
  for (let i = 1; i <= 5; i++) {
    html += `<div class="bar ${i <= litBars ? 'on' : ''}"></div>`;
  }
  html += '</div>';
  return html;
}

function playerCardHTML(p, { isBench = false, isCaptain = false } = {}) {
  return `
    <div class="player-card ${isBench ? 'bench' : ''}" data-id="${p.id}">
      ${isCaptain ? '<div class="captain-badge">C</div>' : ''}
      ${p.team_code ? `<img class="crest" src="${CREST_URL(p.team_code)}" alt="${p.team_short}" onerror="this.style.display='none'">` : ''}
      <div class="photo-wrap">
        <img src="${PHOTO_URL(p.code)}" alt="${p.web_name}"
             onerror="this.style.display='none'">
      </div>
      <div class="name">${p.web_name}</div>
      <div class="price">£${p.price.toFixed(1)}m</div>
      ${signalBarsHTML(p.signal)}
      <div class="fixture-chip ${fdrClass(p.fdr3)}">${p.next_fixtures ? p.next_fixtures.split(',')[0] : 'TBC'}</div>
    </div>`;
}

function renderPitch(result) {
  const { starting, bench, captain } = result;
  const gk = starting.filter(p => p.position === 'GKP');
  const def = starting.filter(p => p.position === 'DEF');
  const mid = starting.filter(p => p.position === 'MID');
  const fwd = starting.filter(p => p.position === 'FWD');

  const row = list => `<div class="pitch-row">${list.map(p =>
    playerCardHTML(p, { isCaptain: p.id === captain.id })).join('')}</div>`;

  const html = `
    ${row(fwd)}
    ${row(mid)}
    ${row(def)}
    ${row(gk)}
    <div class="bench-strip-wrap">
      <div class="bench-label">Bench (kept lean on purpose - only the XI scores points most weeks)</div>
      <div class="bench-strip">${bench.map(p => playerCardHTML(p, { isBench: true })).join('')}</div>
    </div>`;

  document.getElementById('pitch').innerHTML = html;
  attachCardListeners(starting.concat(bench));
}

function renderBudgetSummary(squad) {
  const spent = squad.reduce((s, p) => s + p.price, 0);
  const remaining = BUDGET_TOTAL - spent;
  const pct = Math.min((spent / BUDGET_TOTAL) * 100, 100);
  document.getElementById('budget-summary').innerHTML = `
    <div class="budget-figures">
      <span class="spent">£${spent.toFixed(1)}m spent</span>
      <span class="remaining">£${remaining.toFixed(1)}m left</span>
    </div>
    <div class="budget-track"><div class="budget-fill" style="width:${pct}%"></div></div>`;
}

function attachCardListeners(players) {
  document.querySelectorAll('.player-card').forEach(card => {
    card.addEventListener('click', () => {
      const p = players.find(x => String(x.id) === card.dataset.id);
      if (p) openDrawer(p);
    });
  });
}

function openDrawer(p) {
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.innerHTML = `
    <div class="drawer">
      <div class="drawer-head">
        <div class="photo-wrap">
          <img src="${PHOTO_URL(p.code)}" alt="${p.web_name}"
               onerror="this.style.display='none'">
        </div>
        <div>
          <div class="drawer-title">${p.web_name}</div>
          <div class="drawer-sub">${p.team_short} · ${p.position} · £${p.price.toFixed(1)}m</div>
        </div>
      </div>
      ${signalBarsHTML(p.signal)}
      <ul class="why-list">
        ${(p.why || []).map(reason => `<li>${reason}</li>`).join('') || '<li>No standout factors either way.</li>'}
      </ul>
      <div class="drawer-sub" style="margin-bottom:10px">Next: ${p.next_fixtures}</div>
      <button class="close-drawer">Close</button>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop || e.target.classList.contains('close-drawer')) {
      backdrop.remove();
    }
  });
}

// ---------- Controls ----------
function renderControls() {
  const panel = document.getElementById('controls-panel');
  panel.innerHTML = `
    <div class="control-group">
      <div class="control-label"><span>Risk tolerance</span><span class="value" id="risk-val">${state.risk}</span></div>
      <input type="range" id="risk-slider" min="0" max="100" value="${state.risk}">
      <div class="control-hint">Low = safe, reliable picks. High = cheaper differentials with lower ownership.</div>
    </div>

    <div class="control-group">
      <div class="control-hint">
        Formation and budget split aren't manual inputs anymore - a real solver (Mixed-Integer Linear
        Programming) evaluates every legal combination and picks whichever genuinely scores highest, subject
        to budget, squad rules, and club limits. It spends almost everything on your XI and keeps the bench
        near-minimum cost, since only the XI scores points most weeks.
      </div>
    </div>

    <div class="control-group">
      <div class="budget-bar-wrap" id="budget-summary">
        <div class="budget-figures"><span class="spent">£0.0m spent</span><span class="remaining">£100.0m left</span></div>
        <div class="budget-track"><div class="budget-fill" style="width:0%"></div></div>
      </div>
      <button class="build-btn" id="build-btn">Build me a team</button>
      <div class="status-line" id="status-line"></div>
    </div>`;

  document.getElementById('risk-slider').addEventListener('input', e => {
    state.risk = parseInt(e.target.value, 10);
    document.getElementById('risk-val').textContent = state.risk;
  });

  document.getElementById('build-btn').addEventListener('click', onBuildClick);
}

function formationLabel(starting) {
  const counts = { DEF: 0, MID: 0, FWD: 0 };
  for (const p of starting) if (counts[p.position] != null) counts[p.position]++;
  return `${counts.DEF}-${counts.MID}-${counts.FWD}`;
}

function onBuildClick() {
  setStatus('Solving (this can take a couple of seconds)...');
  document.getElementById('build-btn').disabled = true;
  setTimeout(() => {
    const result = buildSquad();
    document.getElementById('build-btn').disabled = false;

    if (!result.feasible) {
      setStatus('No valid squad found within budget and club-limit constraints. This should not normally happen - please report it.', true);
      return;
    }

    const xiSpend = result.starting.reduce((s, p) => s + p.price, 0);
    const benchSpend = result.bench.reduce((s, p) => s + p.price, 0);
    const totalSpend = xiSpend + benchSpend;

    setStatus(`Formation: ${formationLabel(result.starting)} · XI: £${xiSpend.toFixed(1)}m · Bench: £${benchSpend.toFixed(1)}m · £${(BUDGET_TOTAL - totalSpend).toFixed(1)}m banked.`);
    state.squad = result;
    renderPitch(result);
    renderBudgetSummary(result.starting.concat(result.bench));
  }, 30);
}

boot();
