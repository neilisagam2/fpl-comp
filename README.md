# FPL Companion

Fantasy Premier League companion app: a daily data pipeline, a Signal Rating engine, and a 6-page web frontend, all served straight from this repo via GitHub Pages (no build step, no framework).

## Pages

| Page | File | What it does |
|---|---|---|
| Squad Builder | `index.html` / `app.js` | Builds a full 15-man squad within budget/formation/risk constraints using the Signal Rating |
| My Team | `my-team.html` / `my-team.js` | Loads your live squad (via Team ID) and flags weak links, rotation risk, and tough fixtures |
| Stats Explorer | `stats.html` / `stats.js` | Filterable/sortable player table with a side-by-side radar chart comparison |
| Captaincy | `captain.html` / `captain.js` | Ranks your starting XI for captain/vice-captain based on next-fixture-weighted Signal |
| Transfers | `transfers.html` / `transfers.js` | Suggests single-transfer upgrades per position, plus a what-if simulator |
| League HQ | `league.html` / `league.js` | Mini-league standings, chip tracker, and a rival-squad viewer |

`common.js` holds the logic shared across pages: signal data loading, the Worker-proxy fetch (with a short sessionStorage cache), HTML escaping, and the Team-ID/League-ID input wiring.

## Data pipeline

- `scripts/snapshot.py` — daily GitHub Actions cron (03:15 UTC, after FPL's price changes) fetches `bootstrap-static` + `fixtures` from the FPL API.
  - `data/latest/` — full bootstrap + fixtures, overwritten every run.
  - `data/snapshots/YYYY-MM-DD.json` — slim per-player daily snapshot (price, ownership, form, status), kept forever to power price/trend history.
  - `data/baseline/season-2025-26.json` — full end-of-season stats, refreshed only while the API still serves the finished season; freezes automatically once the new season resets.
- `scripts/signals.py` — runs right after the snapshot job. Computes the **Signal Rating** for every pickable player:
  `Signal = (0.65×Performance + 0.20×Reliability + 0.15×TeamStrength) × FixtureMultiplier × AvailabilityMultiplier`
  Handles finished-season / pre-season / in-season states automatically, blending last-season baseline stats with current-season form as gameweeks accumulate. Output: `data/latest/signals.json`, read directly by every frontend page.

## My Team / Captaincy / Transfers / League HQ data source

These pages call the official FPL API (which doesn't allow browser CORS) through a small Cloudflare Worker proxy, then cross-reference the results with `signals.json` for ratings.

## Setup

1. Repo settings → Actions → General → Workflow permissions → "Read and write permissions" (the snapshot job commits data back to the repo).
2. Actions tab → **FPL Daily Snapshot** → Run workflow (manual test).
3. Confirm `data/` is populated after a green run, then enable GitHub Pages (serve from the repo root).
