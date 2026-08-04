#!/usr/bin/env python3
"""
FPL Companion - Stage 1: Signal Rating Engine
==============================================
Reads the repo's snapshot data and computes, for every pickable player:

  Performance Score   - position-weighted composite of per-90 stats
                        (percentile-ranked within position, 0-100)
  Reliability Score   - 70% start rate + 30% minutes rate (0-100)
  Team Strength Score - attackers: team goals/match percentile
                        defenders/GKs: team clean-sheet rate percentile
  Fixture Multiplier  - FDR of next 3 (70%) and next 5 (30%) fixtures,
                        mapped 1->1.15 ... 5->0.85
  Availability Mult.  - from FPL status / chance_of_playing_next_round

  Signal      = (0.65*Performance + 0.20*Reliability + 0.15*TeamStrength)
                 x FixtureMultiplier x AvailabilityMultiplier
  ValueSignal = Signal / price

Handles three season states automatically:
  A) finished-season (API still serving completed 2025/26):
     stats come straight from current bootstrap elements
  B) new-season pre-season (game reset, 0 GWs played):
     stats come from data/baseline/season-2025-26.json, joined by
     permanent player `code`
  C) in-season: blends baseline and current-season stats using the
     agreed GW weighting schedule (100/0 at GW1 -> 0/100 by GW15)

Players with no PL history get a price-implied Performance prior capped
at the 60th percentile, neutral Reliability, and an `unproven` flag.

Output: data/latest/signals.json
"""

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

# === PATHS ===
REPO_ROOT = Path(__file__).resolve().parent.parent
LATEST_DIR = REPO_ROOT / "data" / "latest"
BASELINE_FILE = REPO_ROOT / "data" / "baseline" / "season-2025-26.json"
OUTPUT_FILE = LATEST_DIR / "signals.json"

# === MODEL CONFIG ===
POSITION_MAP = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}

# Position-specific Performance weights over per-90 metrics.
# All inputs are percentile ranks within position (0-100), so weights
# express relative emphasis directly.
PERFORMANCE_WEIGHTS = {
    1: {"points_p90": 0.45, "saves_p90": 0.35, "cs_p90": 0.20},
    2: {"points_p90": 0.40, "defcon_p90": 0.25, "cs_p90": 0.20, "gc_p90": 0.15},
    3: {"points_p90": 0.50, "gc_p90": 0.25, "xa_p90": 0.15, "defcon_p90": 0.10},
    4: {"points_p90": 0.60, "goals_p90": 0.25, "assists_p90": 0.10, "xa_p90": 0.05},
}

# Signal composition
W_PERFORMANCE = 0.65
W_RELIABILITY = 0.20
W_TEAM_STRENGTH = 0.15

# Per-90 stats are fully trusted at/above this many minutes; below it they
# are shrunk toward the positional average proportionally.
SHRINKAGE_MINUTES = 900

# Fixture multiplier anchors: average FDR -> multiplier (linear in between)
FDR_MULT_ANCHORS = [(1.0, 1.15), (2.0, 1.08), (3.0, 1.00), (4.0, 0.92), (5.0, 0.85)]
FIXTURE_HORIZON_SHORT = 3   # weight 0.7
FIXTURE_HORIZON_LONG = 5    # weight 0.3
W_FDR_SHORT = 0.7
W_FDR_LONG = 0.3

# Season weighting schedule: (gameweeks completed, weight on last season)
# Piecewise-linear between anchors; clamped outside.
SEASON_WEIGHT_ANCHORS = [(0, 1.00), (5, 0.60), (10, 0.20), (15, 0.00)]

# Unproven-player priors
UNPROVEN_PERFORMANCE_CAP = 60.0   # price-implied percentile ceiling
UNPROVEN_RELIABILITY = 50.0

FULL_SEASON_MATCHES = 38
MINUTES_PER_MATCH = 90


# === SMALL HELPERS ===
def load_json(path: Path):
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def to_float(value, default=0.0) -> float:
    """FPL serves many numeric fields as strings; coerce safely."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def interpolate(x: float, anchors: list[tuple[float, float]]) -> float:
    """Piecewise-linear interpolation through sorted (x, y) anchors,
    clamped at the ends."""
    if x <= anchors[0][0]:
        return anchors[0][1]
    if x >= anchors[-1][0]:
        return anchors[-1][1]
    for (x0, y0), (x1, y1) in zip(anchors, anchors[1:]):
        if x0 <= x <= x1:
            span = x1 - x0
            frac = (x - x0) / span if span else 0.0
            return y0 + frac * (y1 - y0)
    return anchors[-1][1]


def percentile_ranks(values: list[float]) -> list[float]:
    """Percentile rank (0-100) of each value within the list.
    Average-rank method so ties share a percentile."""
    n = len(values)
    if n == 0:
        return []
    if n == 1:
        return [50.0]
    indexed = sorted(range(n), key=lambda i: values[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[indexed[j + 1]] == values[indexed[i]]:
            j += 1
        avg_rank = (i + j) / 2.0
        pct = 100.0 * avg_rank / (n - 1)
        for k in range(i, j + 1):
            ranks[indexed[k]] = pct
        i = j + 1
    return ranks


# === SEASON STATE DETECTION ===
def detect_season_state(bootstrap: dict) -> tuple[str, int]:
    """Returns (state, gameweeks_completed):
    'finished-season' - every event finished (old season still served)
    'pre-season'      - new season loaded, nothing played
    'in-season'       - season under way
    """
    events = bootstrap.get("events", [])
    finished = [e for e in events if e.get("finished")]
    if events and len(finished) == len(events):
        return "finished-season", FULL_SEASON_MATCHES
    return ("pre-season", 0) if not finished else ("in-season", len(finished))


# === STATS EXTRACTION ===
STAT_FIELDS = [
    "total_points", "minutes", "starts", "goals_scored", "assists",
    "clean_sheets", "saves", "expected_assists", "defensive_contribution",
]


def extract_stats(source: dict, matches_played: int) -> dict:
    """Pull raw season stats from an element-style dict into a uniform
    stats record; matches_played is the team-matches denominator for
    the reliability rates."""
    return {
        "total_points": to_float(source.get("total_points")),
        "minutes": to_float(source.get("minutes")),
        "starts": to_float(source.get("starts")),
        "goals_scored": to_float(source.get("goals_scored")),
        "assists": to_float(source.get("assists")),
        "clean_sheets": to_float(source.get("clean_sheets")),
        "saves": to_float(source.get("saves")),
        "expected_assists": to_float(source.get("expected_assists")),
        "defensive_contribution": to_float(source.get("defensive_contribution")),
        "matches_played": max(matches_played, 1),
    }


def blend_stats(last: dict | None, current: dict | None, w_last: float) -> dict | None:
    """Blend two stats records by weight on last season. Either side may be
    None (unproven players / finished-season mode)."""
    if last is None and current is None:
        return None
    if last is None:
        return current
    if current is None or w_last >= 0.999:
        return last
    if w_last <= 0.001:
        return current
    out = {}
    for k in list(last.keys()):
        out[k] = w_last * last.get(k, 0.0) + (1 - w_last) * current.get(k, 0.0)
    return out


# === PER-90 METRICS WITH SHRINKAGE ===
PER90_METRICS = {
    "points_p90": "total_points",
    "saves_p90": "saves",
    "cs_p90": "clean_sheets",
    "defcon_p90": "defensive_contribution",
    "goals_p90": "goals_scored",
    "assists_p90": "assists",
    "xa_p90": "expected_assists",
}
# gc_p90 (goal contributions) = goals + assists, handled separately

# Real FPL Defensive Contribution scoring is a per-match THRESHOLD bonus,
# not a continuous per-action reward: defenders earn a flat +2 points for
# hitting 10+ CBIT actions in a match, midfielders/forwards for 12+ CBIRT -
# capped at +2 regardless of how far past the threshold a player goes.
#
# A season-average "actions per 90" rate doesn't map cleanly onto that: a
# player averaging exactly the threshold does NOT clear it every match -
# by Poisson variance around that mean, they clear it roughly half the
# time. So rather than just capping the rate at the threshold (which stops
# rewarding excess volume but still treats "averages 11/90" and "averages
# 20/90" as similarly reliable), this computes the actual probability of
# clearing the threshold in a given match: P(X >= threshold) where
# X ~ Poisson(season-average rate). This needs only the season-aggregate
# rate we already have - no match-by-match data required - and correctly
# captures that a player sitting just under the threshold on average still
# earns the bonus a meaningful fraction of the time, while someone racking
# up huge excess volume gets a probability approaching (but never
# exceeding) 1, matching the real payout ceiling.
DEFCON_MATCH_THRESHOLD = {1: None, 2: 10, 3: 12, 4: 12}


def poisson_sf(k: int, lam: float) -> float:
    """P(X >= k) for X ~ Poisson(lam). Computed directly (not via a
    library) since defensive-contribution rates are small enough (roughly
    0-25 actions/90) that this is numerically well-behaved without
    log-space tricks. Verified against scipy.stats.poisson.sf."""
    if lam <= 0:
        return 0.0
    cdf = 0.0
    term = math.exp(-lam)
    cdf += term
    for i in range(1, k):
        term *= lam / i
        cdf += term
    return max(0.0, min(1.0, 1.0 - cdf))


def raw_per90(stats: dict, field: str) -> float:
    mins = stats["minutes"]
    if mins <= 0:
        return 0.0
    return stats[field] * 90.0 / mins


def compute_per90_with_shrinkage(players: list[dict]) -> None:
    """For each position, compute per-90 metrics shrunk toward the
    positional average (average taken over players with >=SHRINKAGE_MINUTES).
    Writes metrics into p['metrics']. Unproven players (no stats) skipped."""
    for pos_id in POSITION_MAP:
        pool = [p for p in players if p["element_type"] == pos_id and p["stats"]]
        if not pool:
            continue

        defcon_threshold = DEFCON_MATCH_THRESHOLD.get(pos_id)

        def per90_for(stats: dict, metric: str, field: str) -> float:
            rate = raw_per90(stats, field)
            if metric == "defcon_p90" and defcon_threshold is not None:
                return poisson_sf(defcon_threshold, rate)
            return rate

        # Positional averages from well-sampled players only
        anchors = [p for p in pool if p["stats"]["minutes"] >= SHRINKAGE_MINUTES]
        ref = anchors if anchors else pool

        pos_avg = {}
        for metric, field in PER90_METRICS.items():
            vals = [per90_for(p["stats"], metric, field) for p in ref]
            pos_avg[metric] = sum(vals) / len(vals)
        gc_vals = [
            raw_per90(p["stats"], "goals_scored") + raw_per90(p["stats"], "assists")
            for p in ref
        ]
        pos_avg["gc_p90"] = sum(gc_vals) / len(gc_vals)

        for p in pool:
            mins = p["stats"]["minutes"]
            w = min(mins / SHRINKAGE_MINUTES, 1.0)
            metrics = {}
            for metric, field in PER90_METRICS.items():
                metrics[metric] = w * per90_for(p["stats"], metric, field) + (1 - w) * pos_avg[metric]
            gc = raw_per90(p["stats"], "goals_scored") + raw_per90(p["stats"], "assists")
            metrics["gc_p90"] = w * gc + (1 - w) * pos_avg["gc_p90"]
            p["metrics"] = metrics
            p["shrinkage_weight"] = round(w, 3)


# === COMPONENT SCORES ===
def compute_performance(players: list[dict]) -> None:
    """Percentile-rank each needed metric within position, then apply the
    position weights. Unproven players get a price-implied prior."""
    for pos_id, weights in PERFORMANCE_WEIGHTS.items():
        pool = [p for p in players if p["element_type"] == pos_id]
        proven = [p for p in pool if p.get("metrics")]

        # Percentile-rank each metric among proven players
        metric_pcts: dict[str, list[float]] = {}
        for metric in weights:
            vals = [p["metrics"][metric] for p in proven]
            metric_pcts[metric] = percentile_ranks(vals)

        for i, p in enumerate(proven):
            score = 0.0
            components = {}
            for metric, w in weights.items():
                pct = metric_pcts[metric][i]
                components[metric] = round(pct, 1)
                score += w * pct
            p["performance"] = round(score, 2)
            p["performance_components"] = components

        # Unproven: price percentile within position, capped
        unproven = [p for p in pool if not p.get("metrics")]
        if unproven:
            prices = [p["now_cost"] for p in pool]
            price_pcts = percentile_ranks(prices)
            price_pct_by_id = {pool[i]["id"]: price_pcts[i] for i in range(len(pool))}
            for p in unproven:
                p["performance"] = round(
                    min(price_pct_by_id[p["id"]], UNPROVEN_PERFORMANCE_CAP), 2
                )
                p["performance_components"] = {"price_implied": p["performance"]}


def compute_reliability(players: list[dict]) -> None:
    for p in players:
        stats = p["stats"]
        if not stats:
            p["reliability"] = UNPROVEN_RELIABILITY
            continue
        matches = stats["matches_played"]
        start_rate = min(stats["starts"] / matches, 1.0)
        mins_rate = min(stats["minutes"] / (matches * MINUTES_PER_MATCH), 1.0)
        p["reliability"] = round((0.7 * start_rate + 0.3 * mins_rate) * 100, 2)


def compute_team_strength(players: list[dict], team_stats: dict) -> None:
    """team_stats: team_id -> {goals_per_match, cs_rate}. Percentile-rank
    each measure across teams, assign by player role."""
    team_ids = list(team_stats.keys())
    if not team_ids:
        for p in players:
            p["team_strength"] = 50.0
        return
    goals = [team_stats[t]["goals_per_match"] for t in team_ids]
    cs = [team_stats[t]["cs_rate"] for t in team_ids]
    goals_pct = dict(zip(team_ids, percentile_ranks(goals)))
    cs_pct = dict(zip(team_ids, percentile_ranks(cs)))

    for p in players:
        t = p["team"]
        if t not in goals_pct:
            p["team_strength"] = 25.0  # promoted/unknown team: conservative
            continue
        if p["element_type"] in (1, 2):
            p["team_strength"] = round(cs_pct[t], 2)
        else:
            p["team_strength"] = round(goals_pct[t], 2)


def build_team_stats(players: list[dict]) -> dict:
    """Aggregate team attacking/defensive output from player stats.
    Team goals = sum of player goals; team clean sheets = sum of GK clean
    sheets (one keeper per match, so GK CS total == team CS total)."""
    agg: dict[int, dict] = {}
    for p in players:
        stats = p["stats"]
        if not stats:
            continue
        t = p["team"]
        entry = agg.setdefault(t, {"goals": 0.0, "gk_cs": 0.0, "matches": stats["matches_played"]})
        entry["goals"] += stats["goals_scored"]
        if p["element_type"] == 1:
            entry["gk_cs"] += stats["clean_sheets"]
        entry["matches"] = max(entry["matches"], stats["matches_played"])

    return {
        t: {
            "goals_per_match": v["goals"] / v["matches"],
            "cs_rate": v["gk_cs"] / v["matches"],
        }
        for t, v in agg.items()
    }


# === FIXTURES ===
def build_fixture_outlook(fixtures: list, teams_short: dict) -> dict:
    """team_id -> {fdr3, fdr5, mult, next_fixtures}. If no upcoming fixtures
    exist (finished season / fixtures not yet released), returns neutral."""
    upcoming: dict[int, list[tuple[float, str]]] = {t: [] for t in teams_short}
    relevant = sorted(
        (f for f in fixtures if not f.get("finished") and f.get("event")),
        key=lambda f: (f["event"], f.get("kickoff_time") or ""),
    )
    for f in relevant:
        h, a = f["team_h"], f["team_a"]
        dh = f.get("team_h_difficulty", 3)
        da = f.get("team_a_difficulty", 3)
        if h in upcoming and len(upcoming[h]) < FIXTURE_HORIZON_LONG:
            upcoming[h].append((dh, f"{teams_short.get(a, '?')}(H{dh})"))
        if a in upcoming and len(upcoming[a]) < FIXTURE_HORIZON_LONG:
            upcoming[a].append((da, f"{teams_short.get(h, '?')}(A{da})"))

    outlook = {}
    for t, fixs in upcoming.items():
        if not fixs:
            outlook[t] = {"fdr3": None, "fdr5": None, "mult": 1.0, "next_fixtures": "TBC"}
            continue
        d3 = [d for d, _ in fixs[:FIXTURE_HORIZON_SHORT]]
        d5 = [d for d, _ in fixs[:FIXTURE_HORIZON_LONG]]
        fdr3 = sum(d3) / len(d3)
        fdr5 = sum(d5) / len(d5)
        blended = W_FDR_SHORT * fdr3 + W_FDR_LONG * fdr5
        outlook[t] = {
            "fdr3": round(fdr3, 2),
            "fdr5": round(fdr5, 2),
            "mult": round(interpolate(blended, FDR_MULT_ANCHORS), 4),
            "next_fixtures": ", ".join(label for _, label in fixs[:FIXTURE_HORIZON_LONG]),
        }
    return outlook


# === AVAILABILITY ===
def availability_multiplier(p_raw: dict) -> float:
    status = p_raw.get("status", "a")
    chance = p_raw.get("chance_of_playing_next_round")
    if status == "a":
        return 1.0
    if status in ("i", "s", "n"):  # injured / suspended / not eligible
        return (to_float(chance) / 100.0) if chance is not None else 0.0
    if status == "d":  # doubtful
        return (to_float(chance) / 100.0) if chance is not None else 0.75
    return 0.0


# === EXPLANATIONS ===
def build_why(p: dict, pos_name: str) -> list[str]:
    why = []
    if p.get("unproven"):
        why.append("Unproven: no PL minutes on record - rating is price-implied")
    else:
        perf = p["performance"]
        if perf >= 85:
            why.append(f"Elite underlying performance ({perf:.0f}th pct of {pos_name}s)")
        elif perf >= 65:
            why.append(f"Strong underlying performance ({perf:.0f}th pct of {pos_name}s)")
        rel = p["reliability"]
        if rel >= 85:
            why.append(f"Nailed starter ({rel:.0f}% reliability)")
        elif rel < 50:
            why.append(f"Rotation risk ({rel:.0f}% reliability)")
    ts = p["team_strength"]
    if ts >= 75:
        role = "defensive" if p["element_type"] in (1, 2) else "attacking"
        why.append(f"Plays in a top {role} side")
    mult = p["fixture_mult"]
    if mult >= 1.05:
        why.append(f"Kind upcoming fixtures (x{mult:.2f})")
    elif mult <= 0.95:
        why.append(f"Tough upcoming fixtures (x{mult:.2f})")
    avail = p["availability_mult"]
    if avail == 0:
        why.append("Currently unavailable (injury/suspension)")
    elif avail < 1:
        why.append(f"Fitness doubt ({int(avail * 100)}% chance of playing)")
    return why


# === MAIN ===
def main() -> None:
    print(f"Signal engine starting at {datetime.now(timezone.utc).isoformat()}")

    bootstrap = load_json(LATEST_DIR / "bootstrap.json")
    fixtures = load_json(LATEST_DIR / "fixtures.json")
    baseline = load_json(BASELINE_FILE)

    if not bootstrap or not fixtures:
        print("ERROR: data/latest/bootstrap.json or fixtures.json missing. "
              "Run scripts/snapshot.py first.")
        sys.exit(1)

    state, gws_completed = detect_season_state(bootstrap)
    print(f"Season state: {state} ({gws_completed} GWs completed)")

    # Weight on last-season data
    if state == "finished-season":
        w_last = 0.0   # current elements ARE last season; no blending needed
    else:
        w_last = interpolate(gws_completed, SEASON_WEIGHT_ANCHORS)
    print(f"Last-season blend weight: {w_last if state != 'finished-season' else 'n/a (direct)'}")

    # Baseline lookup by permanent player code
    baseline_by_code = {}
    if baseline:
        baseline_by_code = {bp["code"]: bp for bp in baseline.get("players", [])}
    elif state != "finished-season":
        print("WARNING: no baseline file - all last-season data unavailable.")

    teams_short = {t["id"]: t.get("short_name", "?") for t in bootstrap["teams"]}
    teams_code = {t["id"]: t.get("code") for t in bootstrap["teams"]}
    teams_ref = [
        {
            "id": t["id"],
            "code": t.get("code"),   # for crest URL: badges/70/t{code}.png
            "name": t.get("name"),
            "short_name": t.get("short_name"),
        }
        for t in bootstrap["teams"]
    ]

    # --- Build player records ---
    players = []
    excluded_unavailable = 0
    for raw in bootstrap["elements"]:
        if raw.get("status") == "u":   # left the league / not in game
            excluded_unavailable += 1
            continue

        if state == "finished-season":
            stats = extract_stats(raw, FULL_SEASON_MATCHES)
            if stats["minutes"] <= 0:
                stats = None
        else:
            last_bp = baseline_by_code.get(raw.get("code"))
            last_stats = None
            if last_bp and to_float(last_bp.get("minutes")) > 0:
                last_stats = extract_stats(last_bp, FULL_SEASON_MATCHES)
            cur_stats = None
            if state == "in-season" and to_float(raw.get("minutes")) > 0:
                cur_stats = extract_stats(raw, max(gws_completed, 1))
            stats = blend_stats(last_stats, cur_stats, w_last)

        players.append({
            "id": raw["id"],
            "code": raw.get("code"),          # photo URL: p{code}.png
            "web_name": raw.get("web_name", "?"),
            "first_name": raw.get("first_name", ""),
            "second_name": raw.get("second_name", ""),
            "team": raw.get("team"),
            "team_short": teams_short.get(raw.get("team"), "?"),
            "team_code": teams_code.get(raw.get("team")),
            "element_type": raw.get("element_type"),
            "position": POSITION_MAP.get(raw.get("element_type"), "?"),
            "now_cost": raw.get("now_cost", 0),
            "price": raw.get("now_cost", 0) / 10,
            "status": raw.get("status"),
            "news": raw.get("news", ""),
            "selected_by_percent": raw.get("selected_by_percent"),
            "stats": stats,
            "unproven": stats is None,
            "availability_mult": round(availability_multiplier(raw), 2),
        })

    print(f"Players in scope: {len(players)} "
          f"(excluded {excluded_unavailable} marked unavailable)")

    # --- Component scores ---
    compute_per90_with_shrinkage(players)
    compute_performance(players)
    compute_reliability(players)
    team_stats = build_team_stats(players)
    compute_team_strength(players, team_stats)

    # --- Fixtures ---
    fixture_outlook = build_fixture_outlook(fixtures, teams_short)
    neutral = {"fdr3": None, "fdr5": None, "mult": 1.0, "next_fixtures": "TBC"}
    for p in players:
        fo = fixture_outlook.get(p["team"], neutral)
        p["fdr3"] = fo["fdr3"]
        p["fdr5"] = fo["fdr5"]
        p["fixture_mult"] = fo["mult"]
        p["next_fixtures"] = fo["next_fixtures"]

    # --- Final Signal ---
    for p in players:
        base = (
            W_PERFORMANCE * p["performance"]
            + W_RELIABILITY * p["reliability"]
            + W_TEAM_STRENGTH * p["team_strength"]
        )
        p["signal"] = round(base * p["fixture_mult"] * p["availability_mult"], 2)
        p["signal_if_fit"] = round(base * p["fixture_mult"], 2)  # ignores availability
        p["value_signal"] = round(p["signal"] / p["price"], 2) if p["price"] else 0.0
        p["why"] = build_why(p, p["position"])

        # Keep a slim set of raw counting stats for display (Stats Explorer
        # etc.) - these are blended per the season-weighting rules same as
        # everything else, so they reflect current-season form once GWs
        # have been played, not just last season's totals.
        s = p.get("stats")
        if s:
            p["raw"] = {
                "total_points": round(s["total_points"], 1),
                "minutes": round(s["minutes"]),
                "goals": round(s["goals_scored"], 1),
                "assists": round(s["assists"], 1),
                "clean_sheets": round(s["clean_sheets"], 1),
                "saves": round(s["saves"], 1),
                "defensive_contribution": round(s["defensive_contribution"], 1),
            }
        else:
            p["raw"] = None

        # internal-only fields not needed by the frontend
        for internal_field in ("stats", "metrics", "shrinkage_weight"):
            p.pop(internal_field, None)

    players.sort(key=lambda p: p["signal"], reverse=True)

    output = {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "season_state": state,
            "gameweeks_completed": gws_completed if state != "finished-season" else 0,
            "last_season_weight": w_last if state != "finished-season" else 1.0,
            "players_in_scope": len(players),
            "model": {
                "signal": "0.65*Perf + 0.20*Rel + 0.15*TeamStr, x fixture, x availability",
                "shrinkage_minutes": SHRINKAGE_MINUTES,
                "fixture_blend": "70% next-3 FDR / 30% next-5 FDR",
                "unproven_cap_pct": UNPROVEN_PERFORMANCE_CAP,
            },
        },
        "teams": teams_ref,
        "players": players,
    }

    LATEST_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {OUTPUT_FILE.relative_to(REPO_ROOT)} "
          f"({OUTPUT_FILE.stat().st_size / 1024:.0f} KB)")
    print("Signal engine complete.")


if __name__ == "__main__":
    main()
