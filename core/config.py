import os
import shutil
from pathlib import Path

BASE = Path(__file__).parent.parent

# On Fly.io DATA_DIR=/data (persistent volume); locally defaults to app dir
_data_dir = Path(os.getenv("DATA_DIR", str(BASE)))
_data_dir.mkdir(parents=True, exist_ok=True)

# Seed volume from bundled data.json on first cloud boot
_bundled = BASE / "data.json"
if _data_dir != BASE and not (_data_dir / "data.json").exists() and _bundled.exists():
    shutil.copy(_bundled, _data_dir / "data.json")

DATA_FILE        = _data_dir / "data.json"
TECH_FILE        = _data_dir / "technicals.json"
SCANS_CACHE_FILE = _data_dir / "stockscans_cache.json"
ALPHA_CACHE_FILE = _data_dir / "alpha_cache.json"

SOIC_DIR              = Path("/Users/arya/workspace/agents/soic-er-shashank-dashboard-generator")
CLAUDE_CLI            = "/Users/arya/.npm-global/bin/claude"
DASHBOARDS_DIR        = BASE / "dashboards"
MARKET_DASHBOARDS_DIR = BASE / "market_dashboards"
MARKET_DASHBOARDS_DIR.mkdir(exist_ok=True)

ACCOUNTS = ["vibhanshu", "manjari", "huf", "manjbhawna",
            "us_vibhanshu", "us_manjari", "us_huf"]

DEFAULT_SETTINGS = {
    "usd_inr_rate": 84.0, "portfolio_risk_pct": 1.0,
    "aif_invested": 0.0, "target_cash_pct": 10.0,
}
