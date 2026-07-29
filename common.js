// ============================================================
// FPL Companion — Shared utilities
// Loaded before each page's own script. Holds everything that was
// previously copy-pasted across app.js/stats.js/my-team.js/captain.js/
// transfers.js/league.js: URL builders, signal data loading, the Worker
// proxy fetch (with a short session cache), HTML escaping, and the
// Team-ID input wiring shared by the four proxy-backed pages.
// ============================================================

const WORKER_BASE = 'https://fpl-proxy.neilstuart87.workers.dev/';
const SIGNALS_URL = 'data/latest/signals.json';

const PHOTO_URL = code => `https://resources.premierleague.com/premierleague25/photos/players/110x140/${code}.png`;
const CREST_URL = code => `https://resources.premierleague.com/premierleague/badges/50/t${code}.png`;

// ---------- HTML escaping ----------
// Player names (web_name) come from FPL's own curated player data, but FPL
// team names and manager names are freely chosen by other managers - once
// those reach our page (My Team, League HQ) they're untrusted input and
// must be escaped before going into innerHTML.
function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Signal data loading ----------
async function loadSignals() {
  const res = await fetch(SIGNALS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- Proxied FPL API fetch, with a short sessionStorage cache ----------
// Team/picks/league data barely changes within a browsing session, so
// caching avoids re-fetching identical data as a user hops between My Team,
// Captaincy, Transfers and League HQ. A short TTL keeps it from serving
// stale data across separate visits.
const PROXY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PROXY_CACHE_PREFIX = 'fplProxyCache:';

function readProxyCache(path) {
  try {
    const raw = sessionStorage.getItem(PROXY_CACHE_PREFIX + path);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > PROXY_CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeProxyCache(path, data) {
  try {
    sessionStorage.setItem(PROXY_CACHE_PREFIX + path, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // sessionStorage full or unavailable (e.g. private browsing) - caching
    // is purely an optimization, so fail silently and just skip it.
  }
}

async function fetchProxied(path, { cache = true } = {}) {
  if (cache) {
    const cached = readProxyCache(path);
    if (cached) return cached;
  }
  const base = WORKER_BASE.replace(/\/+$/, ''); // strip any trailing slash(es), avoids double-slash paths
  const res = await fetch(base + path);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${path}${body ? ' - ' + body.slice(0, 150) : ''}`);
  }
  const data = await res.json();
  if (cache) writeProxyCache(path, data);
  return data;
}

// ---------- Status line helper ----------
function makeStatusSetter(elementId) {
  return function setStatus(msg, isError = false) {
    const el = document.getElementById(elementId);
    el.textContent = msg;
    el.style.color = isError ? 'var(--tough)' : 'var(--text-faint)';
  };
}

// ---------- Team/League-ID input wiring ----------
// Shared boot pattern for My Team / Captaincy / Transfers / League HQ:
// restore a saved ID from localStorage and auto-load, wire up the submit
// button + Enter key, and validate as numeric before calling onSubmit.
function wireIdInput({ inputId, submitId, storageKey, setStatus, onSubmit, invalidMsg = 'Please enter a numeric ID.' }) {
  const input = document.getElementById(inputId);
  const submit = document.getElementById(submitId);

  const saved = localStorage.getItem(storageKey);
  if (saved) {
    input.value = saved;
    onSubmit(saved);
  }

  submit.addEventListener('click', () => {
    const id = input.value.trim();
    if (!/^\d+$/.test(id)) {
      setStatus(invalidMsg, true);
      return;
    }
    localStorage.setItem(storageKey, id);
    onSubmit(id);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') submit.click();
  });
}
