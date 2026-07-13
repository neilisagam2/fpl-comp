// ============================================================
// FPL Companion — Transfer Recommendations (Page 6)
// Reuses the Team ID + Worker proxy pattern from my-team.js/captain.js.
// Single-transfer scope only (v1) - each suggestion assumes it's the
// only transfer made, not a combined multi-transfer plan.
// ============================================================

const WORKER_BASE = 'https://fpl-proxy.neilstuart87.workers.dev/';

const STORAGE_KEY = 'fplCompanionTeamId'; // shared across pages on purpose
const SIGNALS_URL = 'data/latest/signals.json';
const PHOTO_URL = code => `https://resources.premierleague.com/premierleague25/photos/players/250x250/${code}.png`;

const MAX_PER_CLUB = 3;

// Tiering thresholds on Signal-point improvement (candidate - current)
const STRONG_BUY_THRESHOLD = 15;
const CONSIDER_THRESHOLD = 6;

let ALL_PLAYERS = [];
let META = null;
let CURRENT_SQUAD = []; // enriched squad players, set after a successful load
let CURRENT_BANK = 0;

async function boot() {
  try {
    const res = await fetch(SIGNALS_URL, { cache: 'no-store' });
    const data = await res.json();
    META = data.meta;
    ALL_PLAYERS = data.players;
    document.getElementById('meta-pill').textContent =
      `${data.players.length} players · ${META.season_state} · updated ${META.generated_at_utc.slice(0, 10)}`;
  } catch (err) {
    document.getElementById('meta-pill').textContent = 'Signal data unavailable';
    console.error(err);
  }

  const savedId = localStorage.getItem(STORAGE_KEY);
  if (savedId) {
    document.getElementById('team-id-input').value = savedId;
    loadTeam(savedId);
  }

  document.getElementById('team-id-submit').addEventListener('click', () => {
    const id = document.getElementById('team-id-input').value.trim();
    if (!/^\d+$/.test(id)) {
      setStatus('Please enter a numeric Team ID.', true);
      return;
    }
    localStorage.setItem(STORAGE_KEY, id);
    loadTeam(id);
  });

  document.getElementById('team-id-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('team-id-submit').click();
  });
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('transfers-status');
  el.textContent = msg;
  el.style.color = isError ? 'var(--tough)' : 'var(--text-faint)';
}

async function fetchProxied(path) {
  const base = WORKER_BASE.replace(/\/+$/, '');
  const res = await fetch(base + path);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${path}${body ? ' - ' + body.slice(0, 150) : ''}`);
  }
  return res.json();
}

async function loadTeam(teamId) {
  setStatus('Loading your squad...');
  document.getElementById('transfers-content').innerHTML = '';

  try {
    const entry = await fetchProxied(`/entry/${teamId}/`);
    const gw = entry.current_event || (META && META.gameweeks_completed) || 1;

    let picksData = null;
    let picksError = null;
    try {
      picksData = await fetchProxied(`/entry/${teamId}/event/${gw}/picks/`);
    } catch (err) {
      picksError = err;
    }

    CURRENT_BANK = entry.last_deadline_bank != null ? entry.last_deadline_bank / 10 : 0;
    renderTransfers(picksData, picksError, gw);
    setStatus(`Analyzed ${entry.name || 'your team'}.`);
  } catch (err) {
    setStatus(`Could not load team ${teamId}: ${err.message}`, true);
    console.error(err);
  }
}

// ---------- Approximate sell price (documented limitation) ----------
// FPL's real sell price = purchase price + half any rise since (rounded
// down), or current price if it fell. The public API doesn't expose
// purchase price for a manager's original squad, so this approximates
// sell price as current price. Close enough for judging AFFORDABILITY of
// a transfer; the official app remains the source of truth for the exact
// sell value shown at confirm-time.
function approxSellPrice(p) {
  return p.price;
}

// ---------- Candidate search ----------
function clubCounts(squad) {
  const counts = {};
  for (const p of squad) counts[p.team] = (counts[p.team] || 0) + 1;
  return counts;
}

function findBestReplacement(sellPlayer, squad, budget) {
  const squadIds = new Set(squad.map(p => p.id));
  const counts = clubCounts(squad);
  // Club count "as if" sellPlayer is already gone, so a same-club
  // replacement isn't wrongly blocked by its own presence.
  const adjustedCounts = { ...counts };
  adjustedCounts[sellPlayer.team] = (adjustedCounts[sellPlayer.team] || 1) - 1;

  const candidates = ALL_PLAYERS.filter(p =>
    p.position === sellPlayer.position &&
    p.availability_mult > 0 &&
    !squadIds.has(p.id) &&
    p.price <= budget + 0.001 &&
    (adjustedCounts[p.team] || 0) < MAX_PER_CLUB
  ).sort((a, b) => b.signal - a.signal);

  return candidates[0] || null;
}

function tierFor(delta) {
  if (delta >= STRONG_BUY_THRESHOLD) return { label: 'Strong Buy', cls: 'good' };
  if (delta >= CONSIDER_THRESHOLD) return { label: 'Consider', cls: 'signal' };
  return { label: 'Avoid', cls: 'tough' };
}

// ---------- Main render ----------
function renderTransfers(picksData, picksError, gw) {
  const container = document.getElementById('transfers-content');

  if (!picksData) {
    container.innerHTML = `
      <div class="empty-state">
        No squad picks available yet for gameweek ${gw}.<br>
        This is expected pre-season, before your team's first gameweek has locked in.<br>
        ${picksError ? '<br><span style="opacity:0.6">(' + picksError.message + ')</span>' : ''}
      </div>`;
    return;
  }

  const picks = picksData.picks || [];
  const squad = picks.map(pick => {
    const sig = ALL_PLAYERS.find(p => p.id === pick.element);
    return sig ? { ...sig, squadSlot: pick.position } : null;
  }).filter(Boolean);

  if (squad.length === 0) {
    container.innerHTML = `<div class="empty-state">Couldn't match your squad against current Signal data.</div>`;
    return;
  }

  CURRENT_SQUAD = squad;

  // Weakest player per position: lowest Signal among that position's squad members
  const byPosition = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const p of squad) byPosition[p.position].push(p);

  const suggestions = [];
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD']) {
    const players = byPosition[pos];
    if (players.length === 0) continue;
    const weakest = [...players].sort((a, b) => a.signal - b.signal)[0];
    const budget = approxSellPrice(weakest) + CURRENT_BANK;
    const best = findBestReplacement(weakest, squad, budget);
    // Only worth suggesting if it's an actual upgrade - the top affordable
    // candidate can still be worse than what you already own, especially
    // when your weakest-in-position player is still decent.
    if (best && best.signal > weakest.signal) {
      const delta = best.signal - weakest.signal;
      suggestions.push({ sell: weakest, buy: best, delta, budget });
    }
  }
  suggestions.sort((a, b) => b.delta - a.delta);

  const suggestionsHTML = suggestions.length
    ? suggestions.map(s => {
        const tier = tierFor(s.delta);
        return `
        <div class="transfer-card">
          <div class="transfer-tier ${tier.cls}">${tier.label}</div>
          <div class="transfer-swap">
            <div class="transfer-player sell">
              <div class="mini-photo"><img src="${PHOTO_URL(s.sell.code)}" alt="" onerror="this.style.display='none'"></div>
              <div>
                <div class="transfer-name">${s.sell.web_name}</div>
                <div class="transfer-meta">${s.sell.team_short} · £${s.sell.price.toFixed(1)}m · Signal ${s.sell.signal.toFixed(1)}</div>
              </div>
            </div>
            <div class="transfer-arrow">→</div>
            <div class="transfer-player buy">
              <div class="mini-photo"><img src="${PHOTO_URL(s.buy.code)}" alt="" onerror="this.style.display='none'"></div>
              <div>
                <div class="transfer-name">${s.buy.web_name}</div>
                <div class="transfer-meta">${s.buy.team_short} · £${s.buy.price.toFixed(1)}m · Signal ${s.buy.signal.toFixed(1)}</div>
              </div>
            </div>
          </div>
          <div class="transfer-delta">+${s.delta.toFixed(1)} Signal</div>
        </div>`;
      }).join('')
    : '<div class="empty-state">No upgrades found within your bank across any position - your squad looks well-optimised right now.</div>';

  container.innerHTML = `
    <div class="section-heading">Transfer suggestions (one at a time)</div>
    <div class="control-hint" style="margin-bottom:14px">
      Each card is an independent single-transfer idea - weakest player in each position vs. the best affordable
      replacement (sell price approximated as current price; bank: £${CURRENT_BANK.toFixed(1)}m).
      These are not a combined multi-transfer plan.
    </div>
    <div class="transfer-list">${suggestionsHTML}</div>

    <div class="section-heading">What-if simulator</div>
    <div class="simulator-card" id="simulator-card"></div>`;

  renderSimulator(squad);
}

// ---------- Simulator ----------
function renderSimulator(squad) {
  const card = document.getElementById('simulator-card');

  const sellOptions = squad
    .slice()
    .sort((a, b) => a.signal - b.signal)
    .map(p => `<option value="${p.id}">${p.web_name} (${p.position}, £${p.price.toFixed(1)}m, Sig ${p.signal.toFixed(1)})</option>`)
    .join('');

  card.innerHTML = `
    <div class="sim-row">
      <label>Sell</label>
      <select id="sim-sell">${sellOptions}</select>
    </div>
    <div class="sim-row">
      <label>Buy</label>
      <select id="sim-buy"></select>
    </div>
    <div class="sim-result" id="sim-result"></div>`;

  const sellSelect = document.getElementById('sim-sell');
  const buySelect = document.getElementById('sim-buy');

  function refreshBuyOptions() {
    const sellId = parseInt(sellSelect.value, 10);
    const sellPlayer = squad.find(p => p.id === sellId);
    const squadIds = new Set(squad.map(p => p.id));
    const budget = approxSellPrice(sellPlayer) + CURRENT_BANK;
    const counts = clubCounts(squad);
    const adjustedCounts = { ...counts };
    adjustedCounts[sellPlayer.team] = (adjustedCounts[sellPlayer.team] || 1) - 1;

    const candidates = ALL_PLAYERS
      .filter(p => p.position === sellPlayer.position && !squadIds.has(p.id) && p.availability_mult > 0)
      .sort((a, b) => b.signal - a.signal)
      .slice(0, 60); // keep dropdown manageable; already sorted best-first

    buySelect.innerHTML = candidates.map(p => {
      const affordable = p.price <= budget + 0.001 && (adjustedCounts[p.team] || 0) < MAX_PER_CLUB;
      return `<option value="${p.id}" ${affordable ? '' : 'disabled'}>${p.web_name} (£${p.price.toFixed(1)}m, Sig ${p.signal.toFixed(1)})${affordable ? '' : ' - unaffordable/club limit'}</option>`;
    }).join('');

    runSimulation();
  }

  function runSimulation() {
    const sellId = parseInt(sellSelect.value, 10);
    const buyId = parseInt(buySelect.value, 10);
    const sellPlayer = squad.find(p => p.id === sellId);
    const buyPlayer = ALL_PLAYERS.find(p => p.id === buyId);
    const result = document.getElementById('sim-result');

    if (!sellPlayer || !buyPlayer) {
      result.innerHTML = '';
      return;
    }

    const before = squad.reduce((s, p) => s + p.signal, 0) / squad.length;
    const after = squad.filter(p => p.id !== sellPlayer.id).concat(buyPlayer)
      .reduce((s, p) => s + p.signal, 0) / squad.length;

    const spend = buyPlayer.price;
    const gain = approxSellPrice(sellPlayer);
    const netSpend = spend - gain;
    const bankAfter = CURRENT_BANK - netSpend;

    result.innerHTML = `
      <div class="sim-stat">
        <div class="label">Avg squad Signal</div>
        <div class="figure">${before.toFixed(1)} → <span style="color:${after >= before ? 'var(--good)' : 'var(--tough)'}">${after.toFixed(1)}</span></div>
      </div>
      <div class="sim-stat">
        <div class="label">Bank after transfer</div>
        <div class="figure" style="color:${bankAfter >= 0 ? 'var(--text)' : 'var(--tough)'}">£${bankAfter.toFixed(1)}m</div>
      </div>`;
  }

  sellSelect.addEventListener('change', refreshBuyOptions);
  buySelect.addEventListener('change', runSimulation);
  refreshBuyOptions();
}

boot();
