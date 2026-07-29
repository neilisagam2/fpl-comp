// ============================================================
// FPL Companion — Captaincy Analyzer (Page 5)
// Reuses the Team ID + Worker proxy pattern from my-team.js.
// ============================================================

const STORAGE_KEY = 'fplCompanionTeamId'; // shared with my-team.js on purpose

// Captaincy cares about the SINGLE next fixture, not the general 5-game
// outlook the main Signal score uses - so this multiplier is steeper
// (bigger swing) than the engine's squad-building fixture multiplier.
const CAPTAINCY_FDR_ANCHORS = [[1, 1.25], [2, 1.12], [3, 1.00], [4, 0.90], [5, 0.78]];

let SIGNALS_BY_ID = {};
let META = null;

const setStatus = makeStatusSetter('captain-status');

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
  setStatus('Loading your squad...');
  document.getElementById('captain-content').innerHTML = '';

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

    renderCaptaincy(picksData, picksError, gw);
    setStatus(`Analyzed ${entry.name || 'your team'}.`);
  } catch (err) {
    setStatus(`Could not load team ${teamId}: ${err.message}`, true);
    console.error(err);
  }
}

// ---------- Next-fixture parsing ----------
function parseNextFixtureDifficulty(nextFixturesStr) {
  if (!nextFixturesStr || nextFixturesStr === 'TBC') return null;
  const first = nextFixturesStr.split(',')[0].trim();
  const match = first.match(/\((\w)(\d)\)$/);
  if (!match) return null;
  return { venue: match[1], difficulty: parseInt(match[2], 10) };
}

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

// ---------- Captaincy scoring ----------
function captaincyScore(p) {
  const base = 0.65 * p.performance + 0.20 * p.reliability + 0.15 * p.team_strength;
  const nextFixture = parseNextFixtureDifficulty(p.next_fixtures);
  const fixtureMult = nextFixture ? interpolate(nextFixture.difficulty, CAPTAINCY_FDR_ANCHORS) : 1.0;
  return {
    score: base * fixtureMult * p.availability_mult,
    fixtureMult,
    nextFixture,
  };
}

function renderCaptaincy(picksData, picksError, gw) {
  const container = document.getElementById('captain-content');

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
  const starters = picks
    .filter(pick => pick.position <= 11) // squad slot 1-11 = starting XI
    .map(pick => {
      const sig = SIGNALS_BY_ID[pick.element];
      if (!sig) return null;
      const { score, fixtureMult, nextFixture } = captaincyScore(sig);
      return { ...sig, captainScore: score, fixtureMult, nextFixture };
    })
    .filter(Boolean)
    .sort((a, b) => b.captainScore - a.captainScore);

  if (starters.length === 0) {
    container.innerHTML = `<div class="empty-state">Couldn't match your starting XI against current Signal data.</div>`;
    return;
  }

  const top = starters.slice(0, 5);
  const captainPick = top[0];
  const vicePick = top[1];

  const fdrLabel = fx => {
    if (!fx) return '<span class="fixture-chip fdr-3">TBC</span>';
    return `<span class="fixture-chip ${fdrClass(fx.difficulty)}">${fx.venue}${fx.difficulty}</span>`;
  };

  const topCardsHTML = top.map((p, i) => `
    <div class="captain-card ${i === 0 ? 'top-pick' : ''}">
      <div class="captain-rank">${i === 0 ? '👑' : '#' + (i + 1)}</div>
      <div class="mini-photo" style="width:44px;height:44px">
        <img src="${PHOTO_URL(p.code)}" alt="" onerror="this.style.display='none'">
      </div>
      <div class="captain-info">
        <div class="captain-name">${p.web_name} <span style="color:var(--text-faint);font-weight:400">(${p.team_short})</span></div>
        <div class="captain-meta">
          Signal ${p.signal.toFixed(1)} · Reliability ${p.reliability.toFixed(0)}% · Next: ${fdrLabel(p.nextFixture)}
        </div>
      </div>
      <div class="captain-score">${p.captainScore.toFixed(1)}</div>
    </div>`).join('');

  const fixtureNote = captainPick.nextFixture
    ? `next fixture is ${captainPick.nextFixture.venue === 'H' ? 'at home' : 'away'} against a difficulty-${captainPick.nextFixture.difficulty} opponent`
    : 'fixtures for the upcoming gameweek aren\'t released yet, so this is based purely on underlying quality and reliability';

  container.innerHTML = `
    <div class="section-heading">Captaincy recommendation</div>
    <div class="captain-summary">
      <strong>${captainPick.web_name}</strong> is the top pick this week (score ${captainPick.captainScore.toFixed(1)}) —
      ${fixtureNote}. <strong>${vicePick.web_name}</strong> is the recommended vice-captain as backup.
    </div>

    <div class="section-heading">Top 5 candidates from your squad</div>
    <div class="captain-list">${topCardsHTML}</div>

    <div class="control-hint" style="margin-top:16px">
      Score = 65% Performance + 20% Reliability + 15% Team Strength, multiplied by a fixture factor based on
      <em>just the next match</em> (not the 5-game outlook used elsewhere) and current availability.
      ${META && META.season_state !== 'in-season' ? 'Recent-form weighting will sharpen this further once a few gameweeks of the new season exist.' : ''}
    </div>`;
}

function fdrClass(fdr) {
  const rounded = Math.round(fdr);
  return `fdr-${Math.min(Math.max(rounded, 1), 5)}`;
}

boot();
