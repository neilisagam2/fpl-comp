#!/usr/bin/env python3
"""
FPL Companion - Stage 0: Daily Snapshot Job
============================================
Fetches core FPL API data and stores it in the repo:

  data/latest/bootstrap.json   - full bootstrap-static (overwritten daily)
  data/latest/fixtures.json    - full fixtures list   (overwritten daily)
  data/snapshots/YYYY-MM-DD.json - slim per-player daily snapshot
                                   (price, ownership, form, status...)
                                   kept forever -> powers price/trend history

Designed to run on a GitHub Actions cron schedule. Idempotent: re-running
on the same day simply overwrites that day's snapshot.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

# === CONFIG ===
BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/"
FIXTURES_URL = "https://fantasy.premierleague.com/api/fixtures/"

# Repo-relative output paths (script assumes it is run from the repo root)
REPO_ROOT = Path(__file__).resolve().parent.parent
LATEST_DIR = REPO_ROOT / "data" / "latest"
SNAPSHOTS_DIR = REPO_ROOT / "data" / "snapshots"

# Per-player fields kept in the slim daily snapshot.
# These are the fields whose *history over time* is valuable
# (price changes, ownership trends, form trajectory, availability).
SNAPSHOT_PLAYER_FIELDS = [
    "id",
    "code",                        # needed to build photo URLs later
    "web_name",
    "team",
    "element_type",
    "now_cost",
    "cost_change_event",
    "cost_change_start",
    "selected_by_percent",
    "transfers_in_event",
    "transfers_out_event",
    "form",
    "event_points",
    "total_points",
    "minutes",
    "starts",
    "status",
    "chance_of_playing_next_round",
    "news",
    "expected_goals",
    "expected_assists",
    "expected_goal_involvements",
    "defensive_contribution",
    "goals_scored",
    "assists",
    "clean_sheets",
    "saves",
    "bonus",
]

HEADERS = {
    # FPL API occasionally 403s default python-requests UA; use a browser-ish one
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}


# === FETCH ===
def fetch_json(url: str) -> dict | list:
    """Fetch a URL and return parsed JSON. Exits non-zero on failure so the
    Actions job clearly fails rather than committing partial data."""
    try:
        response = requests.get(url, headers=HEADERS, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"ERROR: failed to fetch {url}: {e}")
        sys.exit(1)


# === SNAPSHOT BUILDING ===
def current_event_id(bootstrap: dict) -> int | None:
    """Return the id of the current gameweek (is_current), or the next one
    pre-season, or None if neither exists (deep off-season)."""
    events = bootstrap.get("events", [])
    for e in events:
        if e.get("is_current"):
            return e.get("id")
    for e in events:
        if e.get("is_next"):
            return e.get("id")
    return None


def build_slim_snapshot(bootstrap: dict) -> dict:
    """Reduce bootstrap-static to the per-player fields worth keeping daily."""
    players = []
    for p in bootstrap.get("elements", []):
        players.append({field: p.get(field) for field in SNAPSHOT_PLAYER_FIELDS})

    return {
        "captured_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "event_id": current_event_id(bootstrap),
        "total_players_in_game": bootstrap.get("total_players"),
        "players": players,
    }


# === WRITE ===
def write_json(path: Path, data: dict | list, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(data, f, ensure_ascii=False, indent=1)
    size_kb = path.stat().st_size / 1024
    try:
        shown = path.relative_to(REPO_ROOT)
    except ValueError:
        shown = path
    print(f"Wrote {shown} ({size_kb:.0f} KB)")


# === MAIN ===
def main() -> None:
    print(f"FPL snapshot starting at {datetime.now(timezone.utc).isoformat()}")

    bootstrap = fetch_json(BOOTSTRAP_URL)
    fixtures = fetch_json(FIXTURES_URL)

    # Sanity checks - never commit obviously broken data
    if not bootstrap.get("elements") or not bootstrap.get("teams"):
        print("ERROR: bootstrap-static missing elements/teams. Aborting.")
        sys.exit(1)
    if not isinstance(fixtures, list) or len(fixtures) == 0:
        # Pre-season, fixtures can be present but unscheduled; empty list is
        # suspicious enough to abort rather than overwrite good data.
        print("ERROR: fixtures response empty. Aborting.")
        sys.exit(1)

    print(
        f"Fetched OK: {len(bootstrap['elements'])} players, "
        f"{len(bootstrap['teams'])} teams, {len(fixtures)} fixtures"
    )

    # 1. Full latest copies (overwritten every run) - engine/frontend read these
    write_json(LATEST_DIR / "bootstrap.json", bootstrap, compact=True)
    write_json(LATEST_DIR / "fixtures.json", fixtures, compact=True)

    # 2. Slim dated snapshot (kept forever) - history/trends read these
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    slim = build_slim_snapshot(bootstrap)
    write_json(SNAPSHOTS_DIR / f"{today}.json", slim, compact=True)

    print("Snapshot complete.")


if __name__ == "__main__":
    main()
