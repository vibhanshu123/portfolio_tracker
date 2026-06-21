import json
import os
import re
import tempfile
import threading
from .config import DATA_FILE, TECH_FILE, DEFAULT_SETTINGS

_save_lock = threading.Lock()


def _norm_ticker_key(k: str) -> str:
    return re.sub(r'^(NSE|BSE):\s+', lambda m: m.group(1).upper() + ":", k)


def load() -> dict:
    if DATA_FILE.exists():
        data = json.loads(DATA_FILE.read_text())
        for k, v in DEFAULT_SETTINGS.items():
            data["settings"].setdefault(k, v)
        data.setdefault("aif_nav", [])
        data.setdefault("huf_transfers", [])
        data.setdefault("cash_balances", {})
        data.setdefault("us_watchlist", [])
        data.setdefault("aif_investor_meets", [])
        data.setdefault("mutual_funds", [])
        data.setdefault("fixed_income", [])
        data.setdefault("unlisted", [])
        data.setdefault("nps", [])
        data.setdefault("capital_transferred", {
            "vibhanshu": [], "manjari": [], "huf": [],
            "us_vibhanshu": [], "us_manjari": [],
        })
        data.setdefault("sold_positions", [])
        data.setdefault("market_dashboards", [])
        _colon_space = re.compile(r'^(NSE|BSE):\s+', re.IGNORECASE)
        for row in data.get("positions", []) + data.get("watchlist", []):
            t = row.get("ticker")
            if t and isinstance(t, str):
                fixed = _colon_space.sub(lambda m: m.group(1).upper() + ":", t)
                if fixed != t:
                    row["ticker"] = fixed
            yt = row.get("yahoo_ticker")
            if yt and isinstance(yt, str):
                cleaned = yt.strip()
                if cleaned != yt:
                    row["yahoo_ticker"] = cleaned
        return data
    return {"positions": [], "watchlist": [], "settings": dict(DEFAULT_SETTINGS),
            "aif_nav": [], "huf_transfers": [], "cash_balances": {}, "aif_investor_meets": []}


def save(data: dict) -> None:
    with _save_lock:
        payload = json.dumps(data, indent=2, default=str)
        fd, tmp_path = tempfile.mkstemp(dir=DATA_FILE.parent, prefix=".data_", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, DATA_FILE)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise


def load_technicals() -> dict:
    if TECH_FILE.exists():
        raw = json.loads(TECH_FILE.read_text())
        return {_norm_ticker_key(k): v for k, v in raw.items()}
    return {}


def save_technicals(t: dict) -> None:
    normalized = {_norm_ticker_key(k): v for k, v in t.items()}
    TECH_FILE.write_text(json.dumps(normalized, indent=2, default=str))
