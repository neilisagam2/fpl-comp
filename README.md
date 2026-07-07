# FPL Companion

Fantasy Premier League companion app. Data pipeline + Signal Rating engine + web frontend.

## Current status: Stage 0 (snapshot job)

A GitHub Actions cron job fetches core FPL API data daily and commits it to this repo.

## Repo structure

.github/workflows/snapshot.yml   Daily cron job (03:15 UTC, after price changes)
scripts/snapshot.py              Fetches bootstrap-static + fixtures
data/latest/                     Full latest bootstrap + fixtures (overwritten daily)
data/snapshots/                  Slim per-player daily snapshots (kept forever)

## Setup

1. Settings -> Actions -> General -> Workflow permissions -> "Read and write permissions"
2. Actions tab -> FPL Daily Snapshot -> Run workflow (manual test)
3. Confirm data/ folder appears after a green run
