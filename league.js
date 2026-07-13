// ============================================================
// FPL Companion — League HQ (Page 7)
// Reuses the Worker proxy pattern; league ID is a SEPARATE stored
// value from personal Team ID since a user may check others' leagues.
// ============================================================

const WORKER_BASE = 'https://fpl-proxy.neilstuart87.workers.dev/';

const LEAGUE_STORAGE_KEY = 'fplCompanionLeagueId';
const SIGNALS_URL = 'data/latest/signals.json';
const PHOTO_URL = code => `https://resources.premierleague.com/premierleague25/photos/players/110x140/${code}.png`;

// Cap on how many members we fetch full chip/history data for, so a huge
// public league (thousands of entries) can't hammer the Worker/FPL API.
const MAX_CHIP_LOOKUPS = 20;

const CHIP_LABELS = {
  wildcard: 'Wildcard',
  '3xc': 'Triple Captain',
  bboost: 'Bench Boost',
  freehit: 'Free Hit',
  manager: 'Assistant Manager',
};

let ALL_PLAYERS = [];
let SIGNALS_BY_ID = {};
let META = null;
let LEAGUE_ENTRIES = []; // standings results, enriched with chips once loaded

async function boot() {
  try {
    const res = await fetch(SIGNALS_URL, { cache: 'no-store' });
    const data = await res.json();
    META = data.meta;
    ALL_PLAYERS = data.players;
    SIGNALS_BY_ID = Object.fromEntries(data.players.map(p => [p.id, p]));
    document.getElementById('meta-pill').textContent =
      `${data.players.length} players · ${META.season_state} · updated ${META.generated_at_utc.slice(0, 10)}`;
  } catch (err) {
    document.getElementById('meta-pill').textContent = 'Signal data unavailable';
    console.error(err);
  }

  const savedLeagueId = localStorage.getItem(LEAGUE_STORAGE_KEY);
  if (savedLeagueId) {
    document.getElementById('league-id-input').value = savedLeagueId;
    loadLeague(savedLeagueId);
  }

  document.getElementById('league-id-submit').addEventListener('click', () => {
    const id = document.getElementById('league-id-input').value.trim();
    if (!/^\d+$/.test(id)) {
      setStatus('Please enter a numeric league ID.', true);
      return;
    }
    localStorage.setItem(LEAGUE_STORAGE_KEY, id);
    loadLeague(id);
  });

  document.getElementById('league-id-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('league-id-submit').click();
  });
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('league-status');
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

async function loadLeague(leagueId) {
  setStatus('Loading league standings...');
  document.getElementById('league-content').innerHTML = '';

  try {
    const data = await fetchProxied(`/leagues-classic/${leagueId}/standings/`);
    const results = (data.standings && data.standings.results) || [];

    if (results.length === 0) {
      document.getElementById('league-content').innerHTML =
        `<div class="empty-state">No standings found for league ${leagueId} - check the ID and try again.</div>`;
      setStatus('No results.', true);
      return;
    }

    LEAGUE_ENTRIES = results;
    renderStandings(data.league, results);
    setStatus(`Loaded ${data.league ? data.league.name : 'league'} (${results.length} managers).`);

    // Chip data loads in the background and fills in once ready, rather
    // than blocking the standings table from appearing immediately.
    loadChipsInBackground(results.slice(0, MAX_CHIP_LOOKUPS));
  } catch (err) {
    setStatus(`Could not load league ${leagueId}: ${err.message}`, true);
    console.error(err);
  }
}

// ---------- Standings table ----------
function renderStandings(league, results) {
  const container = document.getElementById('league-content');

  const rows = results.map(r => {
    const movement = r.last_rank && r.last_rank > 0
      ? (r.rank < r.last_rank ? 'up' : r.rank > r.last_rank ? 'down' : 'same')
      : 'same';
    const arrow = movement === 'up' ? '▲' : movement === 'down' ? '▼' : '–';
    const arrowColor = movement === 'up' ? 'var(--good)' : movement === 'down' ? 'var(--tough)' : 'var(--text-faint)';
    return `
      <tr data-entry="${r.entry}">
        <td>${r.rank}</td>
        <td style="color:${arrowColor}">${arrow}</td>
        <td>${r.entry_name}</td>
        <td style="color:var(--text-muted)">${r.player_name}</td>
        <td>${r.event_total}</td>
        <td><strong>${r.total}</strong></td>
        <td id="chips-${r.entry}"><span style="color:var(--text-faint);font-family:var(--font-mono);font-size:10px">…</span></td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="section-heading">${league ? league.name : 'League'} standings</div>
    <div class="table-wrap" style="margin-bottom:30px">
      <table class="squad-table">
        <thead><tr><th>Rank</th><th></th><th>Team</th><th>Manager</th><th>GW pts</th><th>Total</th><th>Chips used</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="section-heading">View a manager's squad</div>
    <div class="team-id-card" style="margin-bottom:0">
      <select id="rival-select" style="width:100%;background:var(--bg);border:1px solid var(--card-border);color:var(--text);padding:10px 14px;border-radius:var(--radius-sm);font-family:var(--font-body);font-size:13px">
        <option value="">Select a manager...</option>
        ${results.map(r => `<option value="${r.entry}">${r.entry_name} (${r.player_name})</option>`).join('')}
      </select>
    </div>
    <div id="rival-squad-content"></div>`;

  document.getElementById('rival-select').addEventListener('change', e => {
    if (e.target.value) loadRivalSquad(parseInt(e.target.value, 10));
    else document.getElementById('rival-squad-content').innerHTML = '';
  });
}

// ---------- Chip tracker (background-loaded) ----------
async function loadChipsInBackground(entries) {
  for (const r of entries) {
    try {
      const history = await fetchProxied(`/entry/${r.entry}/history/`);
      const chips = history.chips || [];
      const cell = document.getElementById(`chips-${r.entry}`);
      if (!cell) continue;
      cell.innerHTML = chips.length
        ? chips.map(c => `<span class="pill vice" title="GW${c.event}">${CHIP_LABELS[c.name] || c.name}</span>`).join(' ')
        : '<span style="color:var(--text-faint);font-family:var(--font-mono);font-size:10px">none yet</span>';
    } catch (err) {
      const cell = document.getElementById(`chips-${r.entry}`);
      if (cell) cell.innerHTML = '<span style="color:var(--text-faint);font-family:var(--font-mono);font-size:10px">-</span>';
      console.error(`Chip lookup failed for entry ${r.entry}:`, err);
    }
  }

  // Anything beyond the cap just shows a dash rather than spinning forever
  const capped = LEAGUE_ENTRIES.slice(MAX_CHIP_LOOKUPS);
  for (const r of capped) {
    const cell = document.getElementById(`chips-${r.entry}`);
    if (cell) cell.innerHTML = '<span style="color:var(--text-faint);font-family:var(--font-mono);font-size:10px">-</span>';
  }
}

// ---------- Rival squad viewer ----------
async function loadRivalSquad(entryId) {
  const container = document.getElementById('rival-squad-content');
  container.innerHTML = `<div class="empty-state">Loading squad...</div>`;

  try {
    const entry = await fetchProxied(`/entry/${entryId}/`);
    const gw = entry.current_event || (META && META.gameweeks_completed) || 1;
    const picksData = await fetchProxied(`/entry/${entryId}/event/${gw}/picks/`);

    const picks = picksData.picks || [];
    const squad = picks.map(pick => {
      const sig = SIGNALS_BY_ID[pick.element];
      if (!sig) return null;
      return { ...sig, squadSlot: pick.position, is_captain: pick.is_captain, is_vice_captain: pick.is_vice_captain };
    }).filter(Boolean);

    if (squad.length === 0) {
      container.innerHTML = `<div class="empty-state">No squad data available for this manager yet (pre-season or picks not public).</div>`;
      return;
    }

    const starters = squad.filter(p => p.squadSlot <= 11).sort((a, b) => a.squadSlot - b.squadSlot);
    const bench = squad.filter(p => p.squadSlot > 11).sort((a, b) => a.squadSlot - b.squadSlot);

    const rows = list => list.map(p => `
      <tr>
        <td>
          <div class="player-cell">
            <div class="mini-photo"><img src="${PHOTO_URL(p.code)}" alt="" onerror="this.style.display='none'"></div>
            <span>${p.web_name}</span>
            ${p.is_captain ? '<span class="pill captain">C</span>' : ''}
            ${p.is_vice_captain ? '<span class="pill vice">VC</span>' : ''}
          </div>
        </td>
        <td>${p.team_short}</td>
        <td>${p.position}</td>
        <td>£${p.price.toFixed(1)}m</td>
        <td style="color:${p.signal >= 75 ? 'var(--good)' : p.signal >= 45 ? 'var(--text)' : 'var(--tough)'}">${p.signal.toFixed(1)}</td>
      </tr>`).join('');

    container.innerHTML = `
      <div class="section-heading">${entry.name} - Starting XI</div>
      <table class="squad-table">
        <thead><tr><th>Player</th><th>Team</th><th>Pos</th><th>Price</th><th>Signal</th></tr></thead>
        <tbody>${rows(starters)}</tbody>
      </table>
      <div class="section-heading">Bench</div>
      <table class="squad-table">
        <thead><tr><th>Player</th><th>Team</th><th>Pos</th><th>Price</th><th>Signal</th></tr></thead>
        <tbody>${rows(bench)}</tbody>
      </table>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Could not load this manager's squad: ${err.message}</div>`;
    console.error(err);
  }
}

boot();
