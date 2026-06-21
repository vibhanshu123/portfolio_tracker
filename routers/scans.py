import json
import ssl
import threading
import time
import urllib.request
from datetime import datetime

from fastapi import APIRouter

from core.config import SCANS_CACHE_FILE
from core.persistence import load

router = APIRouter()

_scans_refresh_running = False
_SCAN_REFRESH_HOURS    = 24


def _load_scans_cache() -> dict:
    if SCANS_CACHE_FILE.exists():
        try:
            with open(SCANS_CACHE_FILE) as f:
                cache = json.load(f)
            changed = False
            for ticker, entry in cache.items():
                if "date" in entry and "fetched_at" not in entry:
                    entry["fetched_at"] = entry["date"] + "T00:00:00"
                    changed = True
            if changed:
                _save_scans_cache(cache)
            return cache
        except Exception:
            pass
    return {}


def _save_scans_cache(cache: dict) -> None:
    with open(SCANS_CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=2)


def _fetch_scans_for_ticker(ticker: str):
    from core.enrichment import _get_symbol
    symbol = _get_symbol(ticker)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode    = ssl.CERT_NONE
    url = f"https://www.stockscans.in/api/company/scans/search-company/{symbol}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept":     "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=12, context=ctx) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def _scans_ticker_is_stale(cached_entry: dict) -> bool:
    fetched_at = cached_entry.get("fetched_at")
    if not fetched_at:
        return True
    try:
        last = datetime.fromisoformat(fetched_at)
        return (datetime.now() - last).total_seconds() >= _SCAN_REFRESH_HOURS * 3600
    except Exception:
        return True


def _do_refresh_scans():
    global _scans_refresh_running
    if _scans_refresh_running:
        return
    _scans_refresh_running = True
    try:
        data    = load()
        cache   = _load_scans_cache()
        tickers = list({p["ticker"] for p in data["positions"] if p.get("ticker")})
        for ticker in tickers:
            if not _scans_ticker_is_stale(cache.get(ticker, {})):
                continue
            result = _fetch_scans_for_ticker(ticker)
            if result is not None:
                popular   = result.get("popularScans", [])
                saved     = result.get("savedScans",   [])
                all_scans = popular + saved
                cache[ticker] = {
                    "fetched_at":    datetime.now().isoformat(timespec="seconds"),
                    "popular_scans": popular,
                    "saved_scans":   saved,
                    "count":         len(all_scans),
                    "scan_names":    [s["scanName"] for s in all_scans],
                }
            time.sleep(3)
        _save_scans_cache(cache)
    finally:
        _scans_refresh_running = False


def _maybe_start_scans_refresh():
    cache   = _load_scans_cache()
    data    = load()
    tickers = {p["ticker"] for p in data["positions"] if p.get("ticker")}
    if any(_scans_ticker_is_stale(cache.get(t, {})) for t in tickers):
        t = threading.Thread(target=_do_refresh_scans, daemon=True)
        t.start()


@router.get("/api/stockscans")
def get_stockscans():
    return _load_scans_cache()


@router.post("/api/stockscans/refresh")
def refresh_stockscans():
    t = threading.Thread(target=_do_refresh_scans, daemon=True)
    t.start()
    return {"ok": True, "message": "Scan refresh started"}


def start_deferred_scans():
    def _deferred():
        time.sleep(30)
        _maybe_start_scans_refresh()
    threading.Thread(target=_deferred, daemon=True).start()
