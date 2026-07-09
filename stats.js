// ============================================================
// FPL Companion — Stats Explorer (Page 3)
// Reads data/latest/signals.json, no other network calls needed.
// ============================================================

const SIGNALS_URL = 'data/latest/signals.json';
const PHOTO_URL = code => `https://resources.premierleague.com/premierleague/photos/players/110x140/p${code}.png`;

const COMPARE_COLORS = ['#e8a33d', '#49a7c4', '#c4544a']; // signal, data, tough - matches token palette
const MAX_COMPARE = 3;

let ALL_PLAYERS = [];
let TEAMS = [];
let sortKey = 'signal';
let sortDir = 'desc';
let compareIds = []; // ordered list, oldest first

const filters = {
  position: 'ALL',
  team: 'ALL',
  minPrice: null,
  maxPrice: null,
  minMinutes: null,
  minSignal: null,
  search: '',
};

async function boot() {
  try {
    const res = await fetch(SIGNALS_URL, { cache: 'no-store' });
    const data = await res.json();
    ALL_PLAYERS = data.players;
    TEAMS = data.teams;
    document.getElementById('meta-pill').textContent =
      `${data.players.length} players · ${data.meta.season_state} · updated ${data.meta.generated_at_utc.slice(0, 10)}`;
    renderFilters();
    renderToolbar();
    renderTable();
    renderCompareBar();
  } catch (err) {
    document.getElementById('filters-panel').innerHTML = `<div class="empty-state">Could not load signals.json.<br>${err.message}</div>`;
    console.error(err);
  }
}

// ---------- Filtering ----------
function applyFilters() {
  return ALL_PLAYERS.filter(p => {
    if (filters.position !== 'ALL' && p.position !== filters.position) return false;
    if (filters.team !== 'ALL' && String(p.team) !== filters.team) return false;
    if (filters.minPrice != null && p.price < filters.minPrice) return false;
    if (filters.maxPrice != null && p.price > filters.maxPrice) return false;
    if (filters.minMinutes != null && (!p.raw || p.raw.minutes < filters.minMinutes)) return false;
    if (filters.minSignal != null && p.signal < filters.minSignal) return false;
    if (filters.search && !p.web_name.toLowerCase().includes(filters.search.toLowerCase())) return false;
    return true;
  });
}

function sortPlayers(list) {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const av = getSortValue(a, sortKey);
    const bv = getSortValue(b, sortKey);
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
}

function getSortValue(p, key) {
  switch (key) {
    case 'name': return p.web_name;
    case 'team': return p.team_short;
    case 'price': return p.price;
    case 'minutes': return p.raw ? p.raw.minutes : -1;
    case 'goals': return p.raw ? p.raw.goals : -1;
    case 'assists': return p.raw ? p.raw.assists : -1;
    case 'defcon': return p.raw ? p.raw.defensive_contribution : -1;
    case 'points': return p.raw ? p.raw.total_points : -1;
    case 'signal': return p.signal;
    case 'value_signal': return p.value_signal;
    case 'reliability': return p.reliability;
    default: return p.signal;
  }
}

// ---------- Filters panel ----------
function renderFilters() {
  const panel = document.getElementById('filters-panel');
  const teamOptions = [...TEAMS].sort((a, b) => a.short_name.localeCompare(b.short_name))
    .map(t => `<option value="${t.id}">${t.short_name}</option>`).join('');

  panel.innerHTML = `
    <div class="filter-group">
      <div class="filter-label">Position</div>
      <div class="pos-toggle-row">
        ${['ALL', 'GKP', 'DEF', 'MID', 'FWD'].map(pos =>
          `<div class="pos-toggle ${pos === filters.position ? 'active' : ''}" data-pos="${pos}">${pos}</div>`
        ).join('')}
      </div>
    </div>

    <div class="filter-group">
      <div class="filter-label">Team</div>
      <select id="filter-team">
        <option value="ALL">All teams</option>
        ${teamOptions}
      </select>
    </div>

    <div class="filter-group">
      <div class="filter-label">Price (£m)</div>
      <div style="display:flex;gap:8px">
        <input type="number" id="filter-min-price" placeholder="Min" min="3.5" max="16" step="0.1" style="width:50%">
        <input type="number" id="filter-max-price" placeholder="Max" min="3.5" max="16" step="0.1" style="width:50%">
      </div>
    </div>

    <div class="filter-group">
      <div class="filter-label">Min minutes played</div>
      <input type="number" id="filter-minutes" placeholder="e.g. 900" min="0" max="3500" step="90">
    </div>

    <div class="filter-group">
      <div class="filter-label">Min Signal Rating</div>
      <input type="number" id="filter-signal" placeholder="e.g. 60" min="0" max="100" step="1">
    </div>`;

  panel.querySelectorAll('.pos-toggle').forEach(el => {
    el.addEventListener('click', () => {
      filters.position = el.dataset.pos;
      panel.querySelectorAll('.pos-toggle').forEach(t => t.classList.toggle('active', t === el));
      renderTable();
    });
  });

  document.getElementById('filter-team').addEventListener('change', e => {
    filters.team = e.target.value;
    renderTable();
  });

  const numericFilter = (id, key, parser = parseFloat) => {
    document.getElementById(id).addEventListener('input', e => {
      const v = e.target.value.trim();
      filters[key] = v === '' ? null : parser(v);
      renderTable();
    });
  };
  numericFilter('filter-min-price', 'minPrice');
  numericFilter('filter-max-price', 'maxPrice');
  numericFilter('filter-minutes', 'minMinutes', parseInt);
  numericFilter('filter-signal', 'minSignal', parseInt);
}

// ---------- Toolbar (search + count) ----------
function renderToolbar() {
  document.getElementById('explorer-toolbar').innerHTML = `
    <input type="text" id="search-input" placeholder="Search player name...">
    <div class="result-count" id="result-count"></div>`;

  document.getElementById('search-input').addEventListener('input', e => {
    filters.search = e.target.value;
    renderTable();
  });
}

// ---------- Table ----------
const COLUMNS = [
  { key: 'compare', label: '' },
  { key: 'name', label: 'Player' },
  { key: 'team', label: 'Team' },
  { key: 'position', label: 'Pos' },
  { key: 'price', label: 'Price' },
  { key: 'minutes', label: 'Mins' },
  { key: 'goals', label: 'G' },
  { key: 'assists', label: 'A' },
  { key: 'defcon', label: 'DefCon' },
  { key: 'points', label: 'Pts' },
  { key: 'signal', label: 'Signal' },
  { key: 'value_signal', label: 'Value' },
  { key: 'reliability', label: 'Rel%' },
];

function renderTable() {
  const filtered = applyFilters();
  const sorted = sortPlayers(filtered);

  document.getElementById('result-count').textContent = `${sorted.length} players`;

  const thead = document.querySelector('#explorer-table thead');
  thead.innerHTML = `<tr>${COLUMNS.map(col => {
    if (col.key === 'compare') return `<th></th>`;
    const isSorted = sortKey === col.key;
    return `<th data-key="${col.key}" class="${isSorted ? 'sorted' : ''} ${isSorted && sortDir === 'asc' ? 'asc' : ''}">${col.label}</th>`;
  }).join('')}</tr>`;

  thead.querySelectorAll('th[data-key]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortKey = key; sortDir = 'desc'; }
      renderTable();
    });
  });

  const tbody = document.querySelector('#explorer-table tbody');
  let rowsHTML = sorted.slice(0, 200).map(p => {
    const r = p.raw || {};
    const rowClasses = [
      p.availability_mult === 0 ? 'unavailable-row' : '',
      p.unproven ? 'unproven-row' : '',
    ].join(' ');
    const checked = compareIds.includes(p.id) ? 'checked' : '';
    return `<tr class="${rowClasses}">
      <td><input type="checkbox" class="compare-check" data-id="${p.id}" ${checked}></td>
      <td>${p.web_name}${p.unproven ? '<span class="unproven-tag">unproven</span>' : ''}</td>
      <td>${p.team_short}</td>
      <td>${p.position}</td>
      <td>£${p.price.toFixed(1)}m</td>
      <td>${p.raw ? p.raw.minutes : '-'}</td>
      <td>${p.raw ? r.goals : '-'}</td>
      <td>${p.raw ? r.assists : '-'}</td>
      <td>${p.raw ? r.defensive_contribution : '-'}</td>
      <td>${p.raw ? r.total_points : '-'}</td>
      <td style="color:${signalColor(p.signal)}">${p.signal.toFixed(1)}</td>
      <td>${p.value_signal.toFixed(1)}</td>
      <td>${p.reliability.toFixed(0)}</td>
    </tr>`;
  }).join('');

  // Build the whole tbody HTML - including the truncation notice - as ONE
  // string and set it ONCE. Using `innerHTML +=` here would re-serialise
  // and recreate every row (including ones that just got listeners
  // attached below), silently destroying those listeners. That's exactly
  // why compare checkboxes stopped working for any position with over 200
  // players (MID, DEF) but worked fine for smaller pools (GKP, FWD).
  if (sorted.length > 200) {
    rowsHTML += `<tr><td colspan="${COLUMNS.length}" style="text-align:center;color:var(--text-faint);font-family:var(--font-mono);font-size:11px">
      Showing top 200 of ${sorted.length} - narrow your filters to see more precisely
    </td></tr>`;
  }
  tbody.innerHTML = rowsHTML;

  tbody.querySelectorAll('.compare-check').forEach(cb => {
    cb.addEventListener('change', () => toggleCompare(parseInt(cb.dataset.id, 10), cb));
  });
}

function signalColor(signal) {
  return signal >= 75 ? 'var(--good)' : signal >= 45 ? 'var(--text)' : 'var(--tough)';
}

// ---------- Compare ----------
function toggleCompare(id, checkboxEl) {
  const idx = compareIds.indexOf(id);
  if (idx >= 0) {
    compareIds.splice(idx, 1);
  } else {
    if (compareIds.length >= MAX_COMPARE) {
      compareIds.shift(); // drop oldest to make room
    }
    compareIds.push(id);
  }
  renderTable();
  renderCompareBar();
}

function renderCompareBar() {
  const bar = document.getElementById('compare-bar');
  if (compareIds.length === 0) {
    bar.innerHTML = `<div class="compare-empty">Tick up to ${MAX_COMPARE} players in the table to compare them side by side.</div>`;
    return;
  }

  const players = compareIds.map(id => ALL_PLAYERS.find(p => p.id === id)).filter(Boolean);

  const playerRows = players.map((p, i) => `
    <div class="compare-player-row">
      <span class="compare-swatch" style="background:${COMPARE_COLORS[i]}"></span>
      <strong>${p.web_name}</strong> (${p.team_short}, ${p.position}) — £${p.price.toFixed(1)}m
      · Signal ${p.signal.toFixed(1)} · Value ${p.value_signal.toFixed(1)}
    </div>`).join('');

  bar.innerHTML = `
    <div class="compare-header">
      <strong>Comparing ${players.length} player${players.length > 1 ? 's' : ''}</strong>
      <button class="clear-btn" id="clear-compare">Clear</button>
    </div>
    <div class="compare-grid">
      <div class="compare-players">${playerRows}</div>
      <div class="compare-radar">${radarChartSVG(players)}</div>
    </div>`;

  document.getElementById('clear-compare').addEventListener('click', () => {
    compareIds = [];
    renderTable();
    renderCompareBar();
  });
}

// ---------- Radar chart (hand-built SVG, no external library) ----------
function radarChartSVG(players) {
  const axes = [
    { key: 'performance', label: 'Performance' },
    { key: 'reliability', label: 'Reliability' },
    { key: 'team_strength', label: 'Team' },
    { key: 'fixtureScore', label: 'Fixtures' },
    { key: 'valueScore', label: 'Value' },
  ];

  const size = 260;
  const center = size / 2;
  const radius = size / 2 - 34;
  const n = axes.length;

  const angleFor = i => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pointFor = (i, frac) => {
    const angle = angleFor(i);
    const r = radius * frac;
    return [center + r * Math.cos(angle), center + r * Math.sin(angle)];
  };

  // Derived axis values, each normalised to roughly 0-100
  function axisValues(p) {
    const fixtureScore = Math.max(0, Math.min(100, ((p.fixture_mult - 0.85) / (1.15 - 0.85)) * 100));
    const valueScore = Math.max(0, Math.min(100, p.value_signal * 5)); // value_signal is typically 2-18
    return {
      performance: p.performance,
      reliability: p.reliability,
      team_strength: p.team_strength,
      fixtureScore,
      valueScore,
    };
  }

  // Grid rings
  let gridSVG = '';
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const pts = axes.map((_, i) => pointFor(i, frac).join(',')).join(' ');
    gridSVG += `<polygon points="${pts}" fill="none" stroke="var(--card-border)" stroke-width="1"/>`;
  }
  // Axis lines + labels
  let axisSVG = '';
  axes.forEach((ax, i) => {
    const [x, y] = pointFor(i, 1);
    axisSVG += `<line x1="${center}" y1="${center}" x2="${x}" y2="${y}" stroke="var(--card-border)" stroke-width="1"/>`;
    const [lx, ly] = pointFor(i, 1.18);
    axisSVG += `<text x="${lx}" y="${ly}" font-size="9" fill="var(--text-faint)" font-family="JetBrains Mono, monospace" text-anchor="middle" dominant-baseline="middle">${ax.label}</text>`;
  });

  // One polygon per player
  let dataSVG = '';
  players.forEach((p, pi) => {
    const values = axisValues(p);
    const pts = axes.map((ax, i) => pointFor(i, Math.max(0, Math.min(1, values[ax.key] / 100))).join(',')).join(' ');
    const color = COMPARE_COLORS[pi];
    dataSVG += `<polygon points="${pts}" fill="${color}" fill-opacity="0.15" stroke="${color}" stroke-width="2"/>`;
  });

  return `<svg viewBox="0 0 ${size} ${size}" width="100%" height="${size}" style="max-width:${size}px">
    ${gridSVG}${axisSVG}${dataSVG}
  </svg>`;
}

boot();
