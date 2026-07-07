name: FPL Daily Snapshot

on:
  schedule:
    # 03:15 UTC daily - FPL price changes happen ~01:30-02:30 UTC,
    # so this captures fresh prices every day.
    - cron: "15 3 * * *"
  workflow_dispatch: {}   # allows manual "Run workflow" button for testing

permissions:
  contents: write         # required so the job can commit data back to the repo

concurrency:
  group: fpl-snapshot
  cancel-in-progress: false

jobs:
  snapshot:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repo
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install dependencies
        run: pip install requests

      - name: Run snapshot script
        run: python scripts/snapshot.py

      - name: Commit and push snapshot
        run: |
          git config user.name "fpl-snapshot-bot"
          git config user.email "actions@users.noreply.github.com"
          git add data/
          if git diff --cached --quiet; then
            echo "No changes to commit."
          else
            git commit -m "Snapshot: $(date -u +%Y-%m-%d)"
            git push
          fi
