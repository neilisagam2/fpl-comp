// ============================================================
// FPL Companion — My Team Dashboard (Page 2)
// Calls the FPL API through a Cloudflare Worker proxy (CORS),
// cross-references with data/latest/signals.json for ratings.
// ============================================================

const STORAGE_KEY = 'fplCompanionTeamId';

let SIGNALS_BY_ID = {};
let META = null;

const setStatus = makeStatusSetter('myteam-status');

async function boot() {
  try {
    const data = await loadSignals();
    META = data.meta;
    SIGNALS_BY_ID = Object.fromEntries(data.players.map(p => [p.id, p]));
    document.getElementById('meta-pill').textContent =
      `${data.players.length} players · ${META.season_state} · updated ${META.generated_at_utc.slice(0, 10)}`;
  } catch (err) {
    document.getElementById('meta-pill').textContent = 'Signal data unavailable';
    console.error(err);
  }

  wireIdInput({
    inputId: 'team-id-input',
    submitId: 'team-id-submit',
    storageKey: STORAGE_KEY,
    setStatus,
    onSubmit: loadTeam,
    invalidMsg: 'Please enter a numeric Team ID.',
  });
}

async function loadTeam(teamId) {
  setStatus('Loading your team...');
  document.getElementById('myteam-content').innerHTML = '';

  try {
    const entry = await fetchProxied(`/entry/${teamId}/`);

    // Figure out which gameweek to request picks for. Prefer the entry's
    // own "current_event"; fall back to signals meta if that's missing
    // (e.g. brand new entry pre-season).
    const gw = entry.current_event || (META && META.gameweeks_completed) || 1;

    let picksData = null;
    let picksError = null;
    try {
      picksData = await fetchProxied(`/entry/${teamId}/event/${gw}/picks/`);
    } catch (err) {
      picksError = err;
    }

    renderTeam(entry, picksData, picksError, gw);
    setStatus(`Loaded ${entry.name || 'your team'}.`);
  } catch (err) {
    setStatus(`Could not load team ${teamId}: ${err.message}`, true);
    console.error(err);
  }
}

function renderTeam(entry, picksData, picksError, gw) {
  const container = document.getElementById('myteam-content');

  const summaryHTML = `
    <div class="summary-cards">
      <div class="summary-card">
        <div class="label">Team</div>
        <div class="figure" style="font-size:16px">${escapeHtml(entry.name) || '-'}</div>
      </div>
      <div class="summary-card">
        <div class="label">Overall rank</div>
        <div class="figure">${entry.summary_overall_rank ? entry.summary_overall_rank.toLocaleString() : '-'}</div>
      </div>
      <div class="summary-card">
        <div class="label">Total points</div>
        <div class="figure">${entry.summary_overall_points ?? '-'}</div>
      </div>
      <div class="summary-card">
        <div class="label">Team value</div>
        <div class="figure">£${entry.last_deadline_value ? (entry.last_deadline_value / 10).toFixed(1) : '-'}m</div>
      </div>
      <div class="summary-card">
        <div class="label">In the bank</div>
        <div class="figure">£${entry.last_deadline_bank != null ? (entry.last_deadline_bank / 10).toFixed(1) : '-'}m</div>
      </div>
    </div>`;

  if (!picksData) {
    container.innerHTML = summaryHTML + `
      <div class="empty-state">
        No squad picks available yet for gameweek ${gw}.<br>
        This is expected pre-season, before your team's first gameweek has locked in.<br>
        ${picksError ? '<br><span style="opacity:0.6">(' + picksError.message + ')</span>' : ''}
      </div>`;
    return;
  }

  const picks = picksData.picks || [];
  const enriched = picks.map(pick => {
    const sig = SIGNALS_BY_ID[pick.element];
    if (!sig) return null;
    return {
      ...sig,
      squadSlot: pick.position,       // 1-15 squad slot, NOT the GKP/DEF/MID/FWD string
      multiplier: pick.multiplier,
      is_captain: pick.is_captain,
      is_vice_captain: pick.is_vice_captain,
    };
  }).filter(Boolean);

  const starters = enriched.filter(p => p.squadSlot <= 11);
  const bench = enriched.filter(p => p.squadSlot > 11);
  const captain = enriched.find(p => p.is_captain);
  const vice = enriched.find(p => p.is_vice_captain);

  // ---- Flags: weak links, fixture problems, injuries/rotation ----
  const flags = [];
  for (const p of enriched) {
    if (p.availability_mult === 0) {
      flags.push({ level: 'tough', text: `${p.web_name} is unavailable (${p.news || 'injury/suspension'}).` });
    } else if (p.availability_mult < 1) {
      flags.push({ level: 'warn', text: `${p.web_name} is a fitness doubt (${Math.round(p.availability_mult * 100)}% chance of playing).` });
    }
    if (p.reliability < 50 && p.availability_mult > 0) {
      flags.push({ level: 'warn', text: `${p.web_name} carries rotation risk (${Math.round(p.reliability)}% reliability).` });
    }
    if (p.fixture_mult <= 0.92) {
      flags.push({ level: 'warn', text: `${p.web_name} has a tough run of fixtures ahead (x${p.fixture_mult.toFixed(2)}).` });
    }
    if (p.signal < 40 && p.now_cost >= 55) {
      flags.push({ level: 'tough', text: `${p.web_name} (£${p.price.toFixed(1)}m) is underperforming for the price - possible weak link.` });
    }
  }

  const flagsHTML = flags.length
    ? flags.map(f => `<div class="flag-row ${f.level}"><span class="flag-icon"></span>${f.text}</div>`).join('')
    : '<div class="flag-row"><span class="flag-icon" style="background:var(--good)"></span>No major concerns spotted in your squad right now.</div>';

  const tableRows = (list, isBench) => list.map(p => `
    <tr class="${isBench ? 'bench-row' : ''}">
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
      <td>${signalCellHTML(p.signal)}</td>
      <td>${p.next_fixtures}</td>
    </tr>`).join('');

  container.innerHTML = summaryHTML + `
    <div class="section-heading">Squad flags</div>
    <div class="flags-list">${flagsHTML}</div>

    <div class="section-heading">Starting XI</div>
    <table class="squad-table">
      <thead><tr><th>Player</th><th>Team</th><th>Pos</th><th>Price</th><th>Signal</th><th>Next 3</th></tr></thead>
      <tbody>${tableRows(starters, false)}</tbody>
    </table>

    <div class="section-heading">Bench</div>
    <table class="squad-table">
      <thead><tr><th>Player</th><th>Team</th><th>Pos</th><th>Price</th><th>Signal</th><th>Next 3</th></tr></thead>
      <tbody>${tableRows(bench, true)}</tbody>
    </table>`;
}

function signalCellHTML(signal) {
  const color = signal >= 75 ? 'var(--good)' : signal >= 45 ? 'var(--text)' : 'var(--tough)';
  return `<span style="color:${color};font-family:var(--font-mono)">${signal.toFixed(1)}</span>`;
}

boot();
