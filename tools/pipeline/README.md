# Data pipeline (optional)

You don't need this to run DSM. The repo ships a ready-made 3-week sample
(`data/sample.csv.gz`), and `npm run data:full` downloads the full 4-year replay.

This is the Python script that **produced** those files from the raw UCI
"Individual Household Electric Power Consumption" dataset. Use it only if you
want to change how the six grid signals are derived (`config.py`) and rebuild
the replay yourself.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r tools/pipeline/requirements.txt

# Download household_power_consumption.zip from
# https://archive.ics.uci.edu/dataset/235 into data/, then:
python tools/pipeline/transform.py        # writes data/full.csv.gz
```

Then set `DATASET=full` in `.env` and restart. Every random step is seeded, so
the same input always produces the same output.

The server reads only these columns: `datetime` plus the 22 listed in
`src/server/grid/dataset.ts`. Extra columns are ignored.
