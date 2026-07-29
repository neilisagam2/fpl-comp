// ============================================================
// FPL Companion — Squad Builder (Page 1)
// Vanilla JS, no build step. Reads data/latest/signals.json
// (same repo, same origin -> plain fetch works on GitHub Pages).
// ============================================================

const BUDGET_TOTAL = 100.0;
const SQUAD_QUOTAS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
const MAX_PER_CLUB = 3;

let ALL_PLAYERS = [];
let META = null;

// ---------- State ----------
const state = {
  formation: { DEF: 4, MID: 4, FWD: 2 }, // GKP fixed at 1 starting / 2 squad
  risk: 30,          // 0 = safe, 100 = differential-heavy
  allocation: { GKP: 8, DEF: 25, MID: 40, FWD: 27 }, // relative weights, auto-normalised
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

// ---------- Scoring (risk-blended pick score) ----------
// Ownership acts as a gentle multiplicative nudge (K controls strength),
// never a wholesale replacement of quality - so a clearly elite, high-owned
// player (e.g. Haaland) still outranks a low-owned bench forward at any
// risk setting, while genuinely comparable players do reshuffle toward
// differentials as risk rises.
const OWNERSHIP_NUDGE_STRENGTH = 0.18;

function pickScore(p, riskFrac) {
  const ownership = Math.min(parseFloat(p.selected_by_percent) || 0, 100);
  const ownershipBoost = Math.max(-1, Math.min(1, (50 - ownership) / 50));
  return p.signal * (1 + riskFrac * OWNERSHIP_NUDGE_STRENGTH * ownershipBoost);
}

// ---------- Optimizer: greedy fill + swap improvement ----------
function buildSquad() {
  const riskFrac = state.risk / 100;
  const pool = ALL_PLAYERS
    .filter(p => p.availability_mult > 0) // never recommend an unavailable player
    .map(p => ({ ...p, _score: pickScore(p, riskFrac) }));

  const byPos = {
    GKP: pool.filter(p => p.position === 'GKP').sort((a, b) => b._score - a._score),
    DEF: pool.filter(p => p.position === 'DEF').sort((a, b) => b._score - a._score),
    MID: pool.filter(p => p.position === 'MID').sort((a, b) => b._score - a._score),
    FWD: pool.filter(p => p.position === 'FWD').sort((a, b) => b._score - a._score),
  };

  // Allocation sliders are relative WEIGHTS, not fixed percentages - they're
  // normalised here so the effective split always sums to 100%, however the
  // sliders happen to be set (e.g. all four at max still splits evenly).
  const allocSum = Object.values(state.allocation).reduce((s, v) => s + v, 0) || 1;
  const posBudget = {};
  for (const pos of Object.keys(SQUAD_QUOTAS)) {
    posBudget[pos] = BUDGET_TOTAL * (state.allocation[pos] / allocSum);
  }

  let squad = [];
  const clubCount = {};

  function canAdd(p, currentSquad) {
    if (currentSquad.some(x => x.id === p.id)) return false;
    if ((clubCount[p.team] || 0) >= MAX_PER_CLUB) return false;
    return true;
  }

  function totalCost(list) {
    return list.reduce((sum, p) => sum + p.price, 0);
  }

  // Greedy fill per position within its budget pot, falling back to
  // cheapest-remaining if the pot runs out before the quota is filled.
  for (const pos of Object.keys(SQUAD_QUOTAS)) {
    const quota = SQUAD_QUOTAS[pos];
    const candidates = byPos[pos];
    let spent = 0;
    let picked = [];

    for (const p of candidates) {
      if (picked.length >= quota) break;
      if (!canAdd(p, squad.concat(picked))) continue;
      if (spent + p.price <= posBudget[pos]) {
        picked.push(p);
        spent += p.price;
        clubCount[p.team] = (clubCount[p.team] || 0) + 1;
      }
    }
    // Top up with cheapest remaining eligible players if short of quota
    if (picked.length < quota) {
      const cheapest = [...candidates].sort((a, b) => a.price - b.price);
      for (const p of cheapest) {
        if (picked.length >= quota) break;
        if (!canAdd(p, squad.concat(picked))) continue;
        picked.push(p);
        clubCount[p.team] = (clubCount[p.team] || 0) + 1;
      }
    }
    squad = squad.concat(picked);
  }

  // Over-budget correction: cut whichever swap causes the SMALLEST score
  // loss for the budget freed - not whoever has the worst raw score/price
  // ratio (that would always target premiums like Haaland first, since
  // expensive elite players naturally have a "worse" points-per-pound
  // ratio than cheap squad players despite being clearly better overall).
  let guard = 0;
  while (totalCost(squad) > BUDGET_TOTAL && guard < 200) {
    guard++;
    let bestCut = null; // { index, replacement, scoreLoss, oldTeam }
    for (let i = 0; i < squad.length; i++) {
      const current = squad[i];
      const altPool = byPos[current.position]
        .filter(p => p.price < current.price && canAdd(p, squad.filter(x => x.id !== current.id)))
        .sort((a, b) => b._score - a._score); // best-scoring cheaper alternative first
      if (altPool.length === 0) continue;
      const alt = altPool[0];
      const scoreLoss = current._score - alt._score;
      if (!bestCut || scoreLoss < bestCut.scoreLoss) {
        bestCut = { index: i, replacement: alt, scoreLoss, oldTeam: current.team };
      }
    }
    if (!bestCut) { squad.shift(); continue; } // no valid cut anywhere - fallback
    clubCount[bestCut.oldTeam]--;
    squad[bestCut.index] = bestCut.replacement;
    clubCount[bestCut.replacement.team] = (clubCount[bestCut.replacement.team] || 0) + 1;
  }

  // Improvement pass: try upgrading each player to a better-scoring
  // same-position alternative that still fits the budget & club limit.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < squad.length; i++) {
      const current = squad[i];
      const spareBudget = BUDGET_TOTAL - totalCost(squad) + current.price;
      const candidates = byPos[current.position]
        .filter(p => p.price <= spareBudget && p._score > current._score)
        .filter(p => canAdd(p, squad.filter(x => x.id !== current.id)));
      if (candidates.length > 0) {
        const upgrade = candidates[0];
        clubCount[current.team]--;
        squad[i] = upgrade;
        clubCount[upgrade.team] = (clubCount[upgrade.team] || 0) + 1;
      }
    }
  }

  // Spend-remaining-budget pass: convert idle leftover cash into an
  // equal-or-better alternative, preferring the priciest option available
  // so the squad ends close to the full £100m rather than leaving money
  // unused for no reason.
  let spendGuard = 0;
  let spentImproved = true;
  while (spentImproved && spendGuard < 100) {
    spentImproved = false;
    spendGuard++;
    const spare = BUDGET_TOTAL - totalCost(squad);
    if (spare < 0.1) break;
    for (let i = 0; i < squad.length; i++) {
      const current = squad[i];
      const maxAffordable = current.price + spare;
      const candidates = byPos[current.position]
        .filter(p => p.price <= maxAffordable + 0.001 && p._score >= current._score && p.price > current.price)
        .filter(p => canAdd(p, squad.filter(x => x.id !== current.id)));
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.price - a.price || b._score - a._score);
        const best = candidates[0];
        clubCount[current.team]--;
        squad[i] = best;
        clubCount[best.team] = (clubCount[best.team] || 0) + 1;
        spentImproved = true;
        break;
      }
    }
  }

  return squad;
}

// ---------- Starting XI selection from the 15 ----------
function pickStartingXI(squad) {
  const gk = squad.filter(p => p.position === 'GKP').sort((a, b) => b.signal - a.signal);
  const def = squad.filter(p => p.position === 'DEF').sort((a, b) => b.signal - a.signal);
  const mid = squad.filter(p => p.position === 'MID').sort((a, b) => b.signal - a.signal);
  const fwd = squad.filter(p => p.position === 'FWD').sort((a, b) => b.signal - a.signal);

  const startGK = gk.slice(0, 1);
  const startDEF = def.slice(0, state.formation.DEF);
  const startMID = mid.slice(0, state.formation.MID);
  const startFWD = fwd.slice(0, state.formation.FWD);

  const startingIds = new Set([...startGK, ...startDEF, ...startMID, ...startFWD].map(p => p.id));
  const bench = squad.filter(p => !startingIds.has(p.id));
  // Bench order: reserve GK first, then outfield by descending signal
  const benchGK = bench.filter(p => p.position === 'GKP');
  const benchOutfield = bench.filter(p => p.position !== 'GKP').sort((a, b) => b.signal - a.signal);

  const starting = [...startGK, ...startDEF, ...startMID, ...startFWD];
  const captain = [...starting].sort((a, b) => b.signal - a.signal)[0];

  return { starting, bench: [...benchOutfield, ...benchGK], captain };
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
      <div class="bench-label">Bench</div>
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
      <div class="control-label"><span>Budget allocation</span><span class="value" id="alloc-total">Effective split shown</span></div>
      ${['GKP', 'DEF', 'MID', 'FWD'].map(pos => `
        <div class="alloc-row">
          <label>${pos}</label>
          <input type="range" id="alloc-${pos}" min="5" max="60" value="${state.allocation[pos]}">
          <span class="value" id="alloc-${pos}-val">${state.allocation[pos]}%</span>
        </div>`).join('')}
      <div class="control-hint">Relative spend weights per position - automatically normalised to a 100% split, whatever values you set.</div>
    </div>

    <div class="control-group">
      <div class="budget-bar-wrap" id="budget-summary">
        <div class="budget-figures"><span class="spent">£0.0m spent</span><span class="remaining">£100.0m left</span></div>
        <div class="budget-track"><div class="budget-fill" style="width:0%"></div></div>
      </div>
      <button class="build-btn" id="build-btn">Build me a team</button>
      <div class="status-line" id="status-line"></div>
    </div>`;

  // Wire up listeners
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

  ['GKP', 'DEF', 'MID', 'FWD'].forEach(pos => {
    document.getElementById(`alloc-${pos}`).addEventListener('input', e => {
      state.allocation[pos] = parseInt(e.target.value, 10);
      updateAllocTotal();
    });
  });

  document.getElementById('build-btn').addEventListener('click', onBuildClick);
  updateFormationSummary();
  updateAllocTotal();
}

function updateAllocTotal() {
  const sum = Object.values(state.allocation).reduce((s, v) => s + v, 0) || 1;
  ['GKP', 'DEF', 'MID', 'FWD'].forEach(pos => {
    const effectivePct = Math.round((state.allocation[pos] / sum) * 100);
    document.getElementById(`alloc-${pos}-val`).textContent = `${effectivePct}%`;
  });
  document.getElementById('alloc-total').textContent = 'Effective split shown';
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
    const squad = buildSquad();
    const spent = squad.reduce((s, p) => s + p.price, 0);
    if (squad.length < 15) {
      setStatus(`Could only fill ${squad.length}/15 slots within constraints - try loosening allocation sliders.`, true);
    } else if (spent > BUDGET_TOTAL + 0.05) {
      setStatus(`Best squad found is £${spent.toFixed(1)}m - £${(spent - BUDGET_TOTAL).toFixed(1)}m over budget.`, true);
    } else {
      setStatus(`Squad built: £${spent.toFixed(1)}m of £${BUDGET_TOTAL.toFixed(1)}m used.`);
    }
    state.squad = squad;
    const result = pickStartingXI(squad);
    renderPitch(result);
    renderBudgetSummary(squad);
  }, 30);
}

boot();
