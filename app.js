// ============================================================
// FPL Companion — Squad Builder (Page 1)
// Vanilla JS, no build step. PHOTO_URL/CREST_URL/loadSignals come
// from common.js, loaded before this file.
// ============================================================

const BUDGET_TOTAL = 100.0;
const SQUAD_QUOTAS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
const MAX_PER_CLUB = 3;
const POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'];

let ALL_PLAYERS = [];
let META = null;

// ---------- State ----------
// Budget allocation sliders were removed: no serious FPL optimizer lets a
// human hand-steer spend-by-position as an input (checked several public
// projects before this change) - the optimizer decides its own spend split
// based on maximizing the starting XI, which is what actually scores
// points most weeks. Formation and risk remain genuine preferences.
const state = {
  formation: { DEF: 4, MID: 4, FWD: 2 }, // GKP fixed at 1 starting / 2 squad
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
// never a wholesale replacement of quality - a clearly elite, high-owned
// player (e.g. Haaland) still outranks a low-owned bench forward at any
// risk setting, while genuinely comparable players do reshuffle toward
// differentials as risk rises.
const OWNERSHIP_NUDGE_STRENGTH = 0.18;

// The squad builder uses its OWN fixture window, separate from the general
// Signal score's 70%/next-3 + 30%/next-5 blend: 85% next-3 + 15% games-4-5.
// Rationale: a fresh squad build should chase the best possible opening
// run hard (transfers exist to course-correct once that window closes),
// but a *pure* 3-game score has a real problem - FDR only has 5 discrete
// values, so lots of players tie on fixtures alone with nothing to break
// the tie sensibly. The small games-4-5 tail keeps ranking meaningful
// without diluting the "optimize the opening run" intent much.
const SQUAD_FDR_ANCHORS = [[1, 1.15], [2, 1.08], [3, 1.00], [4, 0.92], [5, 0.85]];
const W_NEXT3 = 0.85;
const W_GAMES45 = 0.15;

// Bench should be near-minimum cost (only the XI scores points most weeks)
// but not literally the single cheapest legal player regardless of
// reliability - a bench player who never plays can't rescue you if a
// starter blanks unexpectedly (FPL only auto-subs in a player who actually
// played that gameweek). This floor is deliberately low: it just filters
// out total no-hopers, not a real quality bar.
const BENCH_RELIABILITY_FLOOR = 25;

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

// ---------- Optimizer: XI-first, bench near-minimum, leftover reinvested ----------
function buildSquad() {
  const riskFrac = state.risk / 100;
  const pool = ALL_PLAYERS
    .filter(p => p.availability_mult > 0) // never recommend an unavailable player
    .map(p => ({ ...p, _score: squadScore(p, riskFrac) }));

  const byPos = {
    GKP: pool.filter(p => p.position === 'GKP').sort((a, b) => b._score - a._score),
    DEF: pool.filter(p => p.position === 'DEF').sort((a, b) => b._score - a._score),
    MID: pool.filter(p => p.position === 'MID').sort((a, b) => b._score - a._score),
    FWD: pool.filter(p => p.position === 'FWD').sort((a, b) => b._score - a._score),
  };

  const xiCounts = { GKP: 1, DEF: state.formation.DEF, MID: state.formation.MID, FWD: state.formation.FWD };
  const benchCounts = {
    GKP: SQUAD_QUOTAS.GKP - xiCounts.GKP,
    DEF: SQUAD_QUOTAS.DEF - xiCounts.DEF,
    MID: SQUAD_QUOTAS.MID - xiCounts.MID,
    FWD: SQUAD_QUOTAS.FWD - xiCounts.FWD,
  };

  // Reserve a realistic minimum for the bench (cheapest N per position),
  // so the XI never accidentally spends money that the bench structurally
  // needs just to exist.
  function cheapestSum(pos, n) {
    if (n <= 0) return 0;
    const cheapest = [...byPos[pos]].sort((a, b) => a.price - b.price).slice(0, n);
    return cheapest.reduce((s, p) => s + p.price, 0);
  }
  let benchReserve = 0;
  for (const pos of POSITIONS) benchReserve += cheapestSum(pos, benchCounts[pos]);
  const xiBudget = BUDGET_TOTAL - benchReserve;

  let xi = [];
  const clubCount = {};

  function canAdd(p, currentList) {
    if (currentList.some(x => x.id === p.id)) return false;
    if ((clubCount[p.team] || 0) >= MAX_PER_CLUB) return false;
    return true;
  }
  function totalCost(list) {
    return list.reduce((sum, p) => sum + p.price, 0);
  }

  // --- Build the XI within xiBudget ---
  for (const pos of POSITIONS) {
    const quota = xiCounts[pos];
    if (quota <= 0) continue;
    const candidates = byPos[pos];
    let picked = [];
    for (const p of candidates) {
      if (picked.length >= quota) break;
      if (!canAdd(p, xi.concat(picked))) continue;
      if (totalCost(xi.concat(picked)) + p.price <= xiBudget) {
        picked.push(p);
        clubCount[p.team] = (clubCount[p.team] || 0) + 1;
      }
    }
    if (picked.length < quota) {
      const cheapest = [...candidates].sort((a, b) => a.price - b.price);
      for (const p of cheapest) {
        if (picked.length >= quota) break;
        if (!canAdd(p, xi.concat(picked))) continue;
        picked.push(p);
        clubCount[p.team] = (clubCount[p.team] || 0) + 1;
      }
    }
    xi = xi.concat(picked);
  }

  // --- Over-budget correction (rare - only if the fallback top-up overshot) ---
  // Cuts whichever swap loses the LEAST score for the budget freed, not
  // whoever has the worst raw score/price ratio (that would always target
  // premiums first, since expensive elite players naturally look "worse"
  // per-pound than cheap squad players despite being clearly better).
  let guard = 0;
  while (totalCost(xi) > xiBudget && guard < 200) {
    guard++;
    let bestCut = null;
    for (let i = 0; i < xi.length; i++) {
      const current = xi[i];
      const altPool = byPos[current.position]
        .filter(p => p.price < current.price && canAdd(p, xi.filter(x => x.id !== current.id)))
        .sort((a, b) => b._score - a._score);
      if (altPool.length === 0) continue;
      const alt = altPool[0];
      const scoreLoss = current._score - alt._score;
      if (!bestCut || scoreLoss < bestCut.scoreLoss) {
        bestCut = { index: i, replacement: alt, scoreLoss, oldTeam: current.team };
      }
    }
    if (!bestCut) { xi.shift(); continue; }
    clubCount[bestCut.oldTeam]--;
    xi[bestCut.index] = bestCut.replacement;
    clubCount[bestCut.replacement.team] = (clubCount[bestCut.replacement.team] || 0) + 1;
  }

  // --- Upgrade pass within xiBudget ---
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < xi.length; i++) {
      const current = xi[i];
      const spare = xiBudget - totalCost(xi) + current.price;
      const candidates = byPos[current.position]
        .filter(p => p.price <= spare && p._score > current._score)
        .filter(p => canAdd(p, xi.filter(x => x.id !== current.id)));
      if (candidates.length > 0) {
        const upgrade = candidates[0];
        clubCount[current.team]--;
        xi[i] = upgrade;
        clubCount[upgrade.team] = (clubCount[upgrade.team] || 0) + 1;
      }
    }
  }

  // --- Fill the bench: near-minimum cost, with a low reliability floor ---
  let bench = [];
  for (const pos of POSITIONS) {
    const need = benchCounts[pos];
    if (need <= 0) continue;
    const eligible = byPos[pos].filter(p => canAdd(p, xi.concat(bench)));
    const reliableCheap = eligible.filter(p => p.reliability >= BENCH_RELIABILITY_FLOOR).sort((a, b) => a.price - b.price);
    const anyCheap = [...eligible].sort((a, b) => a.price - b.price);
    const source = reliableCheap.length >= need ? reliableCheap : anyCheap;
    let picked = [];
    for (const p of source) {
      if (picked.length >= need) break;
      if (!canAdd(p, xi.concat(bench).concat(picked))) continue;
      picked.push(p);
      clubCount[p.team] = (clubCount[p.team] || 0) + 1;
    }
    if (picked.length < need) {
      for (const p of anyCheap) {
        if (picked.length >= need) break;
        if (!canAdd(p, xi.concat(bench).concat(picked))) continue;
        picked.push(p);
        clubCount[p.team] = (clubCount[p.team] || 0) + 1;
      }
    }
    bench = bench.concat(picked);
  }

  // --- Reinvest any true leftover budget back into the XI only ---
  // The bench reserve above was an estimate; actual bench cost usually
  // comes in a bit under it. Rather than let that slack sit unused, funnel
  // it into further XI upgrades - the bench stays lean on purpose, it
  // never gets a share of this.
  let spendGuard = 0;
  let improved = true;
  while (improved && spendGuard < 100) {
    improved = false;
    spendGuard++;
    const spentTotal = totalCost(xi) + totalCost(bench);
    const spare = BUDGET_TOTAL - spentTotal;
    if (spare < 0.1) break;
    for (let i = 0; i < xi.length; i++) {
      const current = xi[i];
      const maxAffordable = current.price + spare;
      const candidates = byPos[current.position]
        .filter(p => p.price <= maxAffordable + 0.001 && p._score >= current._score && p.price > current.price)
        .filter(p => canAdd(p, xi.filter(x => x.id !== current.id).concat(bench)));
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.price - a.price || b._score - a._score);
        const best = candidates[0];
        clubCount[current.team]--;
        xi[i] = best;
        clubCount[best.team] = (clubCount[best.team] || 0) + 1;
        improved = true;
        break;
      }
    }
  }

  const captain = [...xi].sort((a, b) => b.signal - a.signal)[0];
  return { starting: xi, bench, captain, xiBudget, benchReserve };
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
      <div class="fixture-chip ${fdrClass(p.fdr3)}">${p.next_fixtures.split(',')[0] || 'TBC'}</div>
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
        ${p.why.map(reason => `<li>${reason}</li>`).join('') || '<li>No standout factors either way.</li>'}
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
      <div class="control-label"><span>Formation</span></div>
      <div class="formation-summary" id="formation-summary">4-4-2</div>
      ${['DEF', 'MID', 'FWD'].map(pos => `
        <div class="formation-row">
          <label>${pos}</label>
          <input type="range" id="form-${pos}" min="${pos === 'FWD' ? 1 : pos === 'DEF' ? 3 : 2}"
                 max="${pos === 'FWD' ? 3 : 5}" value="${state.formation[pos]}">
          <span class="value" id="form-${pos}-val">${state.formation[pos]}</span>
        </div>`).join('')}
      <div class="control-hint">GK is always 1 starting / 2 in squad. Outfield must total 10.</div>
    </div>

    <div class="control-group">
      <div class="control-label"><span>Risk tolerance</span><span class="value" id="risk-val">${state.risk}</span></div>
      <input type="range" id="risk-slider" min="0" max="100" value="${state.risk}">
      <div class="control-hint">Low = safe, reliable picks. High = cheaper differentials with lower ownership.</div>
    </div>

    <div class="control-group">
      <div class="control-hint">
        Budget isn't manually split by position anymore - the optimizer spends almost everything on your
        starting XI (since only the XI scores points most weeks) and keeps the 4 bench slots near-minimum
        cost, with a light reliability floor so they're not pure dead wood if you need an emergency auto-sub.
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

  ['DEF', 'MID', 'FWD'].forEach(pos => {
    document.getElementById(`form-${pos}`).addEventListener('input', e => {
      state.formation[pos] = parseInt(e.target.value, 10);
      document.getElementById(`form-${pos}-val`).textContent = state.formation[pos];
      updateFormationSummary();
    });
  });

  document.getElementById('risk-slider').addEventListener('input', e => {
    state.risk = parseInt(e.target.value, 10);
    document.getElementById('risk-val').textContent = state.risk;
  });

  document.getElementById('build-btn').addEventListener('click', onBuildClick);
  updateFormationSummary();
}

function updateFormationSummary() {
  const { DEF, MID, FWD } = state.formation;
  const total = DEF + MID + FWD;
  const el = document.getElementById('formation-summary');
  el.textContent = `${DEF}-${MID}-${FWD}`;
  el.style.color = total === 10 ? 'var(--text)' : 'var(--tough)';
  if (total !== 10) el.textContent += ` (needs 10, has ${total})`;
}

function onBuildClick() {
  const total = state.formation.DEF + state.formation.MID + state.formation.FWD;
  if (total !== 10) {
    setStatus(`Formation must total 10 outfield players (currently ${total}).`, true);
    return;
  }
  setStatus('Building squad...');
  setTimeout(() => {
    const result = buildSquad();
    const full = result.starting.concat(result.bench);
    const xiSpend = result.starting.reduce((s, p) => s + p.price, 0);
    const benchSpend = result.bench.reduce((s, p) => s + p.price, 0);
    const totalSpend = xiSpend + benchSpend;

    if (full.length < 15) {
      setStatus(`Could only fill ${full.length}/15 slots within constraints.`, true);
    } else if (totalSpend > BUDGET_TOTAL + 0.05) {
      setStatus(`Best squad found is £${totalSpend.toFixed(1)}m - £${(totalSpend - BUDGET_TOTAL).toFixed(1)}m over budget.`, true);
    } else {
      setStatus(`XI: £${xiSpend.toFixed(1)}m · Bench: £${benchSpend.toFixed(1)}m (lean, on purpose) · £${(BUDGET_TOTAL - totalSpend).toFixed(1)}m banked.`);
    }
    state.squad = result;
    renderPitch(result);
    renderBudgetSummary(full);
  }, 30);
}

boot();
