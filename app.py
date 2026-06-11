import json
import os
import platform
import shutil
import uuid
import asyncio
import threading
import subprocess
import pandas as pd
from pathlib import Path
from datetime import date, datetime
from typing import Optional, Any
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ─── Background refresh progress ──────────────────────────────────────────────
_refresh_progress: dict = {
    "running": False,
    "phase":   "",       # "downloading" | "computing" | "done"
    "done":    0,
    "total":   0,
    "current": "",
    "error":   None,
    "last_result": None,
}

def _run_refresh_in_background() -> bool:
    """Spawn a daemon thread to refresh all technicals. Returns False if already running."""
    if _refresh_progress["running"]:
        return False
    t = threading.Thread(target=_do_refresh_technicals, daemon=True)
    t.start()
    return True


app = FastAPI(title="Portfolio Tracker")
BASE      = Path(__file__).parent

# On Fly.io DATA_DIR=/data (persistent volume); locally defaults to app dir
_data_dir = Path(os.getenv("DATA_DIR", str(BASE)))
_data_dir.mkdir(parents=True, exist_ok=True)
# Seed volume from bundled data.json on first cloud boot
_bundled = BASE / "data.json"
if _data_dir != BASE and not (_data_dir / "data.json").exists() and _bundled.exists():
    shutil.copy(_bundled, _data_dir / "data.json")

DATA_FILE = _data_dir / "data.json"
TECH_FILE      = _data_dir / "technicals.json"
SCANS_CACHE_FILE = _data_dir / "stockscans_cache.json"

SOIC_DIR   = Path("/Users/arya/workspace/agents/soic-er-shashank-dashboard-generator")
CLAUDE_CLI = "/Users/arya/.npm-global/bin/claude"

app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

# ─── Analysis jobs ─────────────────────────────────────────────────────────────
# wid → { symbol, download:{status}, extract:{status,started_at,error},
#          deepdive:{status,started_at,error,dashboard_path} }
_analysis_jobs: dict = {}


def _get_symbol(ticker: str) -> str:
    t = ticker.strip()
    if ":" in t:
        return t.split(":", 1)[1].strip().upper()
    return t.upper()


def _get_dashboard_path(symbol: str) -> Path:
    return SOIC_DIR / "data" / "companies" / symbol / f"{symbol}_Dashboard.html"


def _get_extract_path(symbol: str) -> Path:
    return SOIC_DIR / "data" / "companies" / symbol / "extracted" / f"{symbol}_AR_Extracts.txt"


def _blank_job(symbol: str) -> dict:
    return {
        "symbol":   symbol,
        "download": {"status": "not_started"},
        "extract":  {"status": "not_started", "started_at": None, "error": None},
        "deepdive": {"status": "not_started", "started_at": None, "error": None,
                     "dashboard_path": None},
    }


def _detect_disk_state(symbol: str) -> dict:
    """Build a job dict reflecting what files already exist on disk."""
    job = _blank_job(symbol)
    ep  = _get_extract_path(symbol)
    dp  = _get_dashboard_path(symbol)
    if ep.exists():
        job["extract"]["status"] = "done"
    if dp.exists():
        job["deepdive"]["status"]         = "done"
        job["deepdive"]["dashboard_path"] = str(dp)
    return job


def _open_terminal(shortcode_hint: str) -> None:
    """Open Terminal, start claude, wait for it to load, then send the shortcode as input."""
    # delay 15s lets claude fully initialise before the command is sent.
    # do script "cmd" in newTab sends text to the *running* claude process (not to zsh),
    # so ! is NOT subject to zsh history expansion here.
    script = (
        f'tell application "Terminal"\n'
        f'  set newTab to do script "cd {SOIC_DIR} && {CLAUDE_CLI}"\n'
        f'  activate\n'
        f'  delay 15\n'
        f'  do script "{shortcode_hint}" in newTab\n'
        f'end tell'
    )
    if platform.system() == "Darwin":
        subprocess.Popen(["osascript", "-e", script])


def _watch_file(wid: str, step: str, path: Path, start_ts: float,
                interval: int = 10, max_iters: int = 360) -> None:
    """Poll for path to appear (mtime >= start_ts). Updates job status in-place."""
    import time
    for _ in range(max_iters):
        time.sleep(interval)
        job = _analysis_jobs.get(wid)
        if not job:
            return
        if path.exists() and path.stat().st_mtime >= start_ts - 5:
            job[step]["status"] = "done"
            if step == "deepdive":
                job[step]["dashboard_path"] = str(path)
            return
    job = _analysis_jobs.get(wid)
    if job and job[step]["status"] == "running":
        job[step]["status"] = "error"
        job[step]["error"]  = "Timed out waiting for output file (60 min)"


def _run_extract(wid: str, symbol: str) -> None:
    """Open Terminal for user to run !ra-dash, then poll for extract file."""
    _open_terminal(f"!ra-dash {symbol}")
    job = _analysis_jobs.get(wid)
    try:
        start_ts = datetime.fromisoformat(job["extract"]["started_at"]).timestamp()
    except Exception:
        import time; start_ts = time.time()
    _watch_file(wid, "extract", _get_extract_path(symbol), start_ts)


def _run_deepdive(wid: str, symbol: str) -> None:
    """Open Terminal for user to run !ra-dd, then poll for dashboard file."""
    _open_terminal(f"!ra-dd {symbol}")
    job = _analysis_jobs.get(wid)
    try:
        start_ts = datetime.fromisoformat(job["deepdive"]["started_at"]).timestamp()
    except Exception:
        import time; start_ts = time.time()
    _watch_file(wid, "deepdive", _get_dashboard_path(symbol), start_ts)


# ─── Persistence ───────────────────────────────────────────────────────────────

DEFAULT_SETTINGS = {
    "usd_inr_rate": 84.0, "portfolio_risk_pct": 1.0, "aif_invested": 0.0,
    "target_cash_pct": 10.0,
}

def load():
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
            "vibhanshu":    [],
            "manjari":      [],
            "huf":          [],
            "us_vibhanshu": [],
            "us_manjari":   [],
        })
        data.setdefault("sold_positions", [])
        # Normalize tickers: strip the space that appears after "NSE: " or "BSE: "
        # e.g. "NSE: DEEDEV" → "NSE:DEEDEV".  Positions store "NSE:DEEDEV" but
        # watchlist items entered via the form land as "NSE: DEEDEV", causing a
        # key mismatch when looking up technicals (keyed by position ticker).
        import re as _re
        _colon_space = _re.compile(r'^(NSE|BSE):\s+', _re.IGNORECASE)
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

_save_lock = __import__("threading").Lock()

def save(data):
    # Atomic write with a process-level lock + unique temp file per call.
    # Without this, two concurrent requests (or two server processes) racing
    # on the same data.tmp produce interleaved writes → corrupted JSON.
    import tempfile, os
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
            try: os.unlink(tmp_path)
            except OSError: pass
            raise

def _norm_ticker_key(k: str) -> str:
    """Normalize 'NSE: SYMBOL' → 'NSE:SYMBOL' so position and watchlist keys match."""
    import re as _re
    return _re.sub(r'^(NSE|BSE):\s+', lambda m: m.group(1).upper() + ":", k)

def load_technicals():
    if TECH_FILE.exists():
        raw = json.loads(TECH_FILE.read_text())
        # Normalize keys so "NSE: DEEDEV" and "NSE:DEEDEV" map to the same entry
        return {_norm_ticker_key(k): v for k, v in raw.items()}
    return {}

def save_technicals(t):
    # Normalize keys before persisting so the file stays clean
    normalized = {_norm_ticker_key(k): v for k, v in t.items()}
    TECH_FILE.write_text(json.dumps(normalized, indent=2, default=str))


# ─── Technical indicator helpers ───────────────────────────────────────────────

def _ema(s: pd.Series, span: int) -> pd.Series:
    return s.ewm(span=span, adjust=False).mean()

def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    d = close.diff()
    g = d.clip(lower=0).ewm(alpha=1/period, adjust=False).mean()
    l = (-d.clip(upper=0)).ewm(alpha=1/period, adjust=False).mean()
    return 100 - 100 / (1 + g / l.replace(0, float("nan")))

def _adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    pc  = close.shift(1)
    tr  = pd.concat([high - low, (high - pc).abs(), (low - pc).abs()], axis=1).max(axis=1)
    up  = high.diff(); dn = -low.diff()
    pdm = up.where((up > dn) & (up > 0), 0.0)
    ndm = dn.where((dn > up) & (dn > 0), 0.0)
    a   = 1 / period
    atr = tr.ewm(alpha=a, adjust=False).mean()
    pdi = 100 * pdm.ewm(alpha=a, adjust=False).mean() / atr
    ndi = 100 * ndm.ewm(alpha=a, adjust=False).mean() / atr
    dx  = 100 * (pdi - ndi).abs() / (pdi + ndi).replace(0, float("nan"))
    return dx.ewm(alpha=a, adjust=False).mean()


# ─── Enrichment ────────────────────────────────────────────────────────────────

def cagr(invested, current, buy_date_str):
    if not buy_date_str or not invested or not current or invested <= 0:
        return None
    try:
        bd    = datetime.fromisoformat(buy_date_str).date() if isinstance(buy_date_str, str) else buy_date_str
        years = (date.today() - bd).days / 365.25
        if years < 1 / 365:
            return None
        return round(((current / invested) ** (1 / years) - 1) * 100, 2)
    except Exception:
        return None

def enrich(pos, usd_inr=84.0):
    avg     = pos.get("avg_buy_price", 0) or 0
    qty     = pos.get("quantity", 0) or 0
    cmp_val = pos.get("cmp") or avg
    cur     = pos.get("currency", "INR")
    rate    = usd_inr if cur == "USD" else 1.0

    invested   = avg * qty
    current    = cmp_val * qty
    inv_inr    = invested * rate
    cur_inr    = current * rate
    pnl        = current - invested
    pnl_pct    = round((pnl / invested) * 100, 2) if invested else 0

    stored_peak       = pos.get("peak_price") or 0
    pos["peak_price"] = round(max(stored_peak, avg, cmp_val), 4)

    pos["invested"]           = round(invested, 2)
    pos["current_value"]      = round(current, 2)
    pos["invested_inr"]       = round(inv_inr, 2)
    pos["current_value_inr"]  = round(cur_inr, 2)
    pos["pnl"]                = round(pnl, 2)
    pos["pnl_inr"]            = round(pnl * rate, 2)
    pos["pnl_pct"]            = pnl_pct
    pos["cagr"]               = cagr(invested, current, pos.get("buy_date"))
    return pos


# ─── Models ────────────────────────────────────────────────────────────────────

ACCOUNTS = ["vibhanshu", "manjari", "huf", "manjbhawna",
            "us_vibhanshu", "us_manjari", "us_huf"]

class PositionIn(BaseModel):
    account:       str
    stock_name:    str
    ticker:        str
    avg_buy_price: float
    quantity:      float
    buy_date:      Optional[str]   = None
    currency:      str             = "INR"
    pe:            Optional[float] = None
    market_cap:    Optional[float] = None
    sector:        Optional[str]   = None
    conviction:    Optional[float] = None
    notes:         Optional[str]   = ""
    active:        bool            = True

class WatchlistIn(BaseModel):
    stock_name:       str
    ticker:           str
    target_buy_price: Optional[float] = None
    added_price:      Optional[float] = None
    sector:           Optional[str]   = None
    notes:            Optional[str]   = ""

class SettingsIn(BaseModel):
    usd_inr_rate:       Optional[float] = None
    portfolio_risk_pct: Optional[float] = None
    aif_invested:       Optional[float] = None
    target_cash_pct:    Optional[float] = None


class HufTransferIn(BaseModel):
    date:         str
    from_account: str   # "vibhanshu" | "manjari"
    amount:       float
    notes:        Optional[str] = ""


# ─── Ticker helpers ────────────────────────────────────────────────────────────

def _to_yahoo(ticker, currency="INR"):
    if not ticker:
        return None
    t = ticker.strip()
    if currency == "USD":
        return t
    if t.startswith("NSE:"):
        return t[4:].strip() + ".NS"
    if t.startswith("BSE:"):
        return t[4:].strip() + ".BO"
    return t + ".NS"


# ─── Routes ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def index():
    return (BASE / "templates" / "index.html").read_text()


@app.get("/api/data")
def get_data():
    data = load()
    rate = data["settings"].get("usd_inr_rate", 84.0)
    data["positions"] = [enrich(p, rate) for p in data["positions"]]
    data["accounts"]  = ACCOUNTS
    # Inject computed FI values so header totals are accurate
    for fi in data.get("fixed_income", []):
        fi["_computed_value"] = _compute_fi_value(fi)
    return data


# ─── USD/INR auto-rate ─────────────────────────────────────────────────────────

@app.get("/api/usd_rate")
def get_usd_rate():
    """Fetch live USD/INR from Yahoo Finance (USDINR=X)."""
    try:
        import yfinance as yf
        ticker = yf.Ticker("USDINR=X")
        rate   = float(ticker.fast_info.last_price)
        if rate and rate > 0:
            data = load()
            data["settings"]["usd_inr_rate"] = round(rate, 2)
            save(data)
            return {"rate": round(rate, 2)}
    except Exception as e:
        return {"error": str(e)}
    return {"error": "Could not fetch rate"}


# ─── Quick quote (single ticker, for watchlist add) ───────────────────────────

@app.get("/api/quote")
def get_quote(ticker: str, on: Optional[str] = None):
    """Return price for a ticker. `on` = ISO date (YYYY-MM-DD) for historical close,
    omit for latest price."""
    try:
        import yfinance as yf
        from datetime import datetime, timedelta
        yt = _to_yahoo(ticker)
        tk = yf.Ticker(yt)
        if on:
            # Fetch a small window around the target date to handle weekends/holidays
            target = datetime.strptime(on, "%Y-%m-%d")
            start  = (target - timedelta(days=7)).strftime("%Y-%m-%d")
            end    = (target + timedelta(days=4)).strftime("%Y-%m-%d")
            hist   = tk.history(start=start, end=end)
            if not hist.empty:
                # Pick the closest trading day on or before the target date
                hist.index = hist.index.tz_localize(None) if hist.index.tzinfo else hist.index
                before = hist[hist.index <= target]
                row = before.iloc[-1] if not before.empty else hist.iloc[0]
                return {"ticker": ticker, "price": round(float(row["Close"]), 2), "date": str(row.name.date())}
            return {"error": "No history around that date"}
        # Latest price
        price = tk.fast_info.last_price
        if price and float(price) > 0:
            return {"ticker": ticker, "price": round(float(price), 2)}
        hist = tk.history(period="5d")
        if not hist.empty:
            return {"ticker": ticker, "price": round(float(hist["Close"].iloc[-1]), 2)}
    except Exception as e:
        return {"error": str(e)}
    return {"error": "Could not fetch price"}


# ─── Live price refresh ────────────────────────────────────────────────────────

@app.get("/api/prices")
def refresh_prices():
    data = load()
    rate = data["settings"].get("usd_inr_rate", 84.0)

    ticker_map: dict[str, str] = {}
    for p in data["positions"]:
        yt = p.get("yahoo_ticker") or _to_yahoo(p.get("ticker", ""), p.get("currency", "INR"))
        if yt:
            ticker_map[yt] = p["id"]

    updated = {}
    if ticker_map:
        import yfinance as yf
        yts = list(ticker_map.keys())

        def _extract(raw):
            # yfinance 1.x with group_by="ticker" returns a MultiIndex where
            # the first level is the ticker and the second is the field.
            # Access as raw[ticker]["Close"], NOT raw["Close"][ticker].
            result = {}
            for yt in yts:
                try:
                    col = raw[yt]["Close"].dropna()
                    price = float(col.iloc[-1])
                    if price > 0:
                        result[yt] = price
                except Exception:
                    pass
            return result

        # Try intraday (5m) first — current price during market hours
        try:
            raw = yf.download(yts, period="1d", interval="5m",
                              progress=False, auto_adjust=True, group_by="ticker")
            updated = _extract(raw)
        except Exception:
            pass

        # Fallback to daily close
        if not updated:
            try:
                raw = yf.download(yts, period="5d", interval="1d",
                                  progress=False, auto_adjust=True, group_by="ticker")
                updated = _extract(raw)
            except Exception as e:
                return {"error": str(e), "updated": 0}

    for p in data["positions"]:
        yt = p.get("yahoo_ticker") or _to_yahoo(p.get("ticker", ""), p.get("currency", "INR"))
        if yt and yt in updated:
            new_cmp      = round(updated[yt], 2)
            p["cmp"]     = new_cmp
            p["peak_price"] = round(max(p.get("peak_price") or 0,
                                        p.get("avg_buy_price") or 0, new_cmp), 4)
    save(data)
    data["positions"] = [enrich(p, rate) for p in data["positions"]]
    return {"updated": len(updated), "positions": data["positions"]}


# ─── Technical analysis ────────────────────────────────────────────────────────

@app.get("/api/technicals")
def get_technicals():
    return load_technicals()


@app.get("/api/technicals/progress")
def get_refresh_progress():
    return dict(_refresh_progress)


@app.post("/api/technicals/refresh")
def refresh_technicals():
    """Kick off background refresh. Returns immediately; poll /api/technicals/progress."""
    started = _run_refresh_in_background()
    return {"status": "started" if started else "already_running",
            "progress": dict(_refresh_progress)}


def _download_batch(tickers: list, retries: int = 3) -> "pd.DataFrame":
    """Download 2Y weekly data for a batch of tickers, retrying on rate-limit."""
    import yfinance as yf, time
    for attempt in range(retries):
        try:
            raw = yf.download(tickers, period="2y", interval="1wk",
                              progress=False, auto_adjust=True, group_by="ticker")
            if raw.shape[0] > 0:
                return raw
            if attempt < retries - 1:
                time.sleep(15 * (attempt + 1))
        except Exception as e:
            err = str(e)
            if "rate" in err.lower() or "RateLimit" in type(e).__name__:
                wait = 30 * (attempt + 1)
                time.sleep(wait)
            else:
                break
    return pd.DataFrame()


def _do_refresh_technicals():
    """Background worker: download 2Y weekly data + compute signals for all INR tickers."""
    import yfinance as yf, time

    _refresh_progress.update({
        "running": True, "phase": "loading",
        "done": 0, "total": 0, "current": "", "error": None, "last_result": None,
    })

    try:
        data = load()
        ticker_map: dict[str, str] = {}  # yahoo_ticker → original NSE: ticker

        for p in data["positions"]:
            if p.get("currency", "INR") == "INR":
                yt = p.get("yahoo_ticker") or _to_yahoo(p.get("ticker", ""), "INR")
                if yt:
                    ticker_map[yt] = p.get("ticker", "")

        for w in data["watchlist"]:
            yt = w.get("yahoo_ticker") or _to_yahoo(w.get("ticker", ""), "INR")
            if yt:
                ticker_map[yt] = w.get("ticker", "")

        if not ticker_map:
            _refresh_progress.update({"running": False, "phase": "done", "error": "No tickers"})
            return

        all_yt = list(ticker_map.keys())
        _refresh_progress["total"] = len(all_yt)
        _refresh_progress["phase"] = "downloading"

        # Download in batches of 12 to avoid rate limits
        BATCH = 12
        nifty_close = pd.Series(dtype=float)
        raw_data: dict[str, dict] = {}   # yt → {close, high, low}

        for batch_start in range(0, len(all_yt), BATCH):
            batch = all_yt[batch_start : batch_start + BATCH] + ["^NSEI"]
            raw = _download_batch(batch)
            if raw.empty:
                continue

            def _s(raw, ticker, field):
                try:
                    return raw[ticker][field].dropna()
                except Exception:
                    return pd.Series(dtype=float)

            if len(nifty_close) == 0:
                nc = _s(raw, "^NSEI", "Close")
                if len(nc) > 0:
                    nifty_close = nc

            for yt in all_yt[batch_start : batch_start + BATCH]:
                close = _s(raw, yt, "Close")
                if len(close) >= 42:
                    raw_data[yt] = {
                        "close": close,
                        "high":  _s(raw, yt, "High"),
                        "low":   _s(raw, yt, "Low"),
                    }

            if batch_start + BATCH < len(all_yt):
                time.sleep(3)   # polite pause between batches

        results: dict = {}
        _refresh_progress["phase"] = "computing"

        for i, (yt, orig) in enumerate(ticker_map.items()):
            _refresh_progress["done"]    = i
            _refresh_progress["current"] = orig
            try:
                td = raw_data.get(yt)
                if not td:
                    results[orig] = {"error": "download failed or insufficient history"}
                    continue
                close = td["close"]
                high  = td["high"]
                low   = td["low"]
                if len(close) < 42:
                    results[orig] = {"error": "insufficient history"}
                    continue

                e10 = _ema(close, 10);  e21 = _ema(close, 21)
                e30 = _ema(close, 30);  e40 = _ema(close, 40)
                rsi_s = _rsi(close)
                adx_s = _adx(high, low, close) if len(high) >= 42 else None

                cmp   = float(close.iloc[-1])
                e10v  = float(e10.iloc[-1]); e21v = float(e21.iloc[-1])
                e30v  = float(e30.iloc[-1]); e40v = float(e40.iloc[-1])
                rsiv  = float(rsi_s.iloc[-1])
                adxv  = float(adx_s.iloc[-1]) if adx_s is not None else None
                adxp5 = float(adx_s.iloc[-5]) if adx_s is not None and len(adx_s) >= 5 else None
                p52   = float(close.tail(52).max())

                e30_4w     = float(e30.iloc[-4])
                e30_rising = e30v > e30_4w
                e30_flat   = abs((e30v - e30_4w) / e30_4w) < 0.015 if e30_4w else False

                crs_above_ma = None
                if len(nifty_close) > 0:
                    nf = nifty_close.reindex(close.index).ffill()
                    crs = close / nf
                    crs_ma = crs.rolling(52).mean()
                    if not pd.isna(crs_ma.iloc[-1]):
                        crs_above_ma = bool(float(crs.iloc[-1]) > float(crs_ma.iloc[-1]))

                if cmp > e30v and e30_rising:       stage = 2
                elif cmp < e30v and not e30_rising: stage = 4
                elif cmp >= e30v:                   stage = 3
                else:                               stage = 1

                adx_declining = bool(adxp5 and adxv and adxp5 > 28 and adxv < adxp5 - 3)
                s3_count = sum([
                    cmp < e30v, e30_flat or not e30_rising,
                    crs_above_ma is False, rsiv < 50, adx_declining,
                ])

                sell_signals = {
                    "below_10w_ema":  cmp < e10v,
                    "below_21w_ema":  cmp < e21v,
                    "below_40w_ema":  cmp < e40v,
                    "below_30w_ema":  cmp < e30v,
                    "rsi_weak":       rsiv < 45,
                    "stage3_warning": s3_count >= 2,
                    "crs_broken":     crs_above_ma is False,
                }
                entry_signals = {
                    "above_30w_ema":     cmp > e30v,
                    "ema30_rising":      e30_rising,
                    "rsi_buy_zone":      rsiv >= 45,
                    "adx_trending":      bool(adxv >= 20) if adxv else False,
                    "crs_outperforming": crs_above_ma is True,
                    "near_52w_high":     cmp >= p52 * 0.97,
                }
                results[orig] = {
                    "updated":      date.today().isoformat(),
                    "cmp":    round(cmp, 2),
                    "ema10":  round(e10v, 2),  "ema21": round(e21v, 2),
                    "ema30":  round(e30v, 2),  "ema40": round(e40v, 2),
                    "rsi":    round(rsiv, 1),
                    "adx":    round(adxv, 1) if adxv else None,
                    "crs_above_ma": crs_above_ma,
                    "peak_52w":     round(p52, 2),
                    "stage":        stage,
                    "ema30_rising": e30_rising,
                    "sell_signals":  sell_signals,
                    "entry_signals": entry_signals,
                    "entry_score":   sum(entry_signals.values()),
                }
            except Exception as e:
                results[orig] = {"error": str(e)}

        save_technicals(results)

        for p in data["positions"]:
            ot = p.get("ticker", "")
            if ot in results and "peak_52w" in results[ot]:
                p["peak_price"] = round(max(p.get("peak_price") or 0, results[ot]["peak_52w"]), 2)
        save(data)

        ok = len([r for r in results.values() if "error" not in r])
        _refresh_progress["last_result"] = {"updated": ok, "total": len(results)}
        _refresh_progress["done"] = len(ticker_map)

    except Exception as e:
        _refresh_progress["error"] = str(e)
    finally:
        _refresh_progress["running"] = False
        _refresh_progress["phase"]   = "done"


def _compute_ticker_technicals(orig_ticker: str) -> dict:
    """Download 2Y weekly data for a single ticker and compute all signals."""
    import yfinance as yf

    t = orig_ticker.strip()
    # Detect INR (NSE/BSE) vs bare US ticker
    is_inr = (t.upper().startswith("NSE:") or t.upper().startswith("BSE:")
              or t.endswith(".NS") or t.endswith(".BO"))
    yt          = _to_yahoo(t, "INR") if is_inr else t.upper()
    benchmark   = "^NSEI" if is_inr else "^GSPC"
    bench_label = "Nifty 50" if is_inr else "S&P 500"

    if not yt:
        return {"error": "invalid ticker"}

    raw = _download_batch([yt, benchmark])
    if raw.empty:
        return {"error": "download failed (rate limited or no data — try again shortly)"}

    def _s(ticker, field):
        try:
            return raw[ticker][field].dropna()
        except Exception:
            return pd.Series(dtype=float)

    nifty_close = _s(benchmark, "Close")
    close = _s(yt, "Close");  high = _s(yt, "High");  low = _s(yt, "Low")

    if len(close) < 42:
        return {"error": "insufficient history"}

    e10 = _ema(close, 10);  e21 = _ema(close, 21)
    e30 = _ema(close, 30);  e40 = _ema(close, 40)
    rsi_s = _rsi(close)
    adx_s = _adx(high, low, close) if len(high) >= 42 else None

    cmp_v  = float(close.iloc[-1])
    e10v   = float(e10.iloc[-1]);  e21v = float(e21.iloc[-1])
    e30v   = float(e30.iloc[-1]);  e40v = float(e40.iloc[-1])
    rsiv   = float(rsi_s.iloc[-1])
    adxv   = float(adx_s.iloc[-1]) if adx_s is not None else None
    adxp5  = float(adx_s.iloc[-5]) if adx_s is not None and len(adx_s) >= 5 else None
    p52    = float(close.tail(52).max())

    e30_4w     = float(e30.iloc[-4])
    e30_rising = e30v > e30_4w
    e30_flat   = abs((e30v - e30_4w) / e30_4w) < 0.015 if e30_4w else False

    crs_above_ma = None
    if len(nifty_close) > 0:
        nf = nifty_close.reindex(close.index).ffill()
        crs = close / nf
        crs_ma = crs.rolling(52).mean()
        if not pd.isna(crs_ma.iloc[-1]):
            crs_above_ma = bool(float(crs.iloc[-1]) > float(crs_ma.iloc[-1]))

    if cmp_v > e30v and e30_rising:
        stage = 2
    elif cmp_v < e30v and not e30_rising:
        stage = 4
    elif cmp_v >= e30v and not e30_rising:
        stage = 3
    else:
        stage = 1

    adx_declining = bool(adxp5 and adxv and adxp5 > 28 and adxv < adxp5 - 3)
    s3_count = sum([cmp_v < e30v, e30_flat or not e30_rising,
                    crs_above_ma is False, rsiv < 50, adx_declining])

    sell_signals = {
        "below_10w_ema": cmp_v < e10v, "below_21w_ema": cmp_v < e21v,
        "below_40w_ema": cmp_v < e40v, "below_30w_ema": cmp_v < e30v,
        "rsi_weak": rsiv < 45, "stage3_warning": s3_count >= 2,
        "crs_broken": crs_above_ma is False,
    }
    entry_signals = {
        "above_30w_ema": cmp_v > e30v, "ema30_rising": e30_rising,
        "rsi_buy_zone": rsiv >= 45,
        "adx_trending": bool(adxv >= 20) if adxv else False,
        "crs_outperforming": crs_above_ma is True,
        "near_52w_high": cmp_v >= p52 * 0.97,
    }
    return {
        "updated": date.today().isoformat(),
        "cmp":    round(cmp_v, 2),
        "ema10": round(e10v, 2), "ema21": round(e21v, 2),
        "ema30": round(e30v, 2), "ema40": round(e40v, 2),
        "rsi": round(rsiv, 1), "adx": round(adxv, 1) if adxv else None,
        "crs_above_ma": crs_above_ma, "peak_52w": round(p52, 2),
        "stage": stage, "ema30_rising": e30_rising,
        "sell_signals": sell_signals, "entry_signals": entry_signals,
        "entry_score": sum(entry_signals.values()),
        "benchmark": bench_label,
    }


@app.post("/api/technicals/single")
def refresh_single_ticker(body: dict[str, Any]):
    """Refresh technicals for a single ticker (used on watchlist add)."""
    ticker = (body.get("ticker") or "").strip()
    if not ticker:
        raise HTTPException(400, "ticker required")
    result = _compute_ticker_technicals(ticker)
    tech = load_technicals()
    tech[ticker] = result
    save_technicals(tech)
    return {"ticker": ticker, "data": result}


# ─── StockScans.in scan-match cache ────────────────────────────────────────────

def _load_scans_cache() -> dict:
    if SCANS_CACHE_FILE.exists():
        try:
            with open(SCANS_CACHE_FILE) as f:
                cache = json.load(f)
            # Migrate old entries that only have "date" but no "fetched_at"
            changed = False
            for ticker, entry in cache.items():
                if "date" in entry and "fetched_at" not in entry:
                    # Treat as fetched at midnight of that date → will be stale
                    entry["fetched_at"] = entry["date"] + "T00:00:00"
                    changed = True
            if changed:
                _save_scans_cache(cache)
            return cache
        except Exception:
            pass
    return {}

def _save_scans_cache(cache: dict):
    with open(SCANS_CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=2)

def _fetch_scans_for_ticker(ticker: str) -> Optional[dict]:
    """Call stockscans.in API for one ticker. Returns parsed JSON or None on error."""
    import urllib.request, ssl, time
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode    = ssl.CERT_NONE
    url = f"https://www.stockscans.in/api/company/scans/search-company/{ticker}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept":     "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=12, context=ctx) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None

_scans_refresh_running = False

_SCAN_REFRESH_HOURS = 24   # minimum gap between fetches for the same ticker

def _scans_ticker_is_stale(cached_entry: dict) -> bool:
    """Return True if the cached entry is older than _SCAN_REFRESH_HOURS."""
    fetched_at = cached_entry.get("fetched_at")
    if not fetched_at:
        return True
    try:
        last = datetime.fromisoformat(fetched_at)
        return (datetime.now() - last).total_seconds() >= _SCAN_REFRESH_HOURS * 3600
    except Exception:
        return True

def _do_refresh_scans():
    """Background: fetch scan data for every active position ticker.
    Skips any ticker whose cache is fresher than _SCAN_REFRESH_HOURS hours."""
    global _scans_refresh_running
    if _scans_refresh_running:
        return
    _scans_refresh_running = True
    import time
    try:
        data    = load()
        cache   = _load_scans_cache()
        tickers = list({p["ticker"] for p in data["positions"] if p.get("ticker")})
        for ticker in tickers:
            if not _scans_ticker_is_stale(cache.get(ticker, {})):
                continue                          # still fresh — skip
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
            time.sleep(3)          # be polite — 1 req / 3 s
        _save_scans_cache(cache)
    finally:
        _scans_refresh_running = False

def _maybe_start_scans_refresh():
    """Start scan refresh only if at least one ticker is stale (>24 h)."""
    cache   = _load_scans_cache()
    data    = load()
    tickers = {p["ticker"] for p in data["positions"] if p.get("ticker")}
    if any(_scans_ticker_is_stale(cache.get(t, {})) for t in tickers):
        t = threading.Thread(target=_do_refresh_scans, daemon=True)
        t.start()

@app.get("/api/stockscans")
def get_stockscans():
    return _load_scans_cache()

@app.post("/api/stockscans/refresh")
def refresh_stockscans():
    """Manually trigger a scan refresh (rate-limited: skips tickers fetched <24 h ago)."""
    t = threading.Thread(target=_do_refresh_scans, daemon=True)
    t.start()
    return {"ok": True, "message": "Scan refresh started"}

# Kick off on startup (deferred 30 s so app fully boots first)
def _deferred_scans_start():
    import time; time.sleep(30)
    _maybe_start_scans_refresh()

threading.Thread(target=_deferred_scans_start, daemon=True).start()


# ─── WebSocket live prices ──────────────────────────────────────────────────────

def _ws_fetch_cmp() -> dict:
    """Batch-fetch latest CMPs via yfinance download. Returns {orig_ticker: cmp}."""
    import yfinance as yf

    data       = load()
    ticker_map = {}  # yahoo_ticker → original NSE/USD ticker
    for p in data["positions"]:
        yt   = p.get("yahoo_ticker", "")
        orig = p.get("ticker", "")
        if yt and orig:
            ticker_map[yt] = orig

    if not ticker_map:
        return {}

    all_yt = list(ticker_map.keys()) + ["USDINR=X"]
    prices = {}
    usd_inr = None

    def _last(raw, sym, field="Close"):
        try:
            s = raw[sym][field].dropna()
            return float(s.iloc[-1]) if len(s) else None
        except Exception:
            return None

    # Try intraday (5 min) first — works during market hours
    try:
        raw = yf.download(all_yt, period="1d", interval="5m",
                          progress=False, auto_adjust=True, group_by="ticker")
        if raw.empty:
            raise ValueError("empty")
        for yt, orig in ticker_map.items():
            v = _last(raw, yt)
            if v:
                prices[orig] = round(v, 2)
        usd_inr = _last(raw, "USDINR=X")
    except Exception:
        pass

    # Fallback to daily close (pre/post market or weekend)
    if not prices:
        try:
            raw = yf.download(all_yt, period="5d", interval="1d",
                              progress=False, auto_adjust=True, group_by="ticker")
            for yt, orig in ticker_map.items():
                v = _last(raw, yt)
                if v:
                    prices[orig] = round(v, 2)
            usd_inr = _last(raw, "USDINR=X")
        except Exception:
            pass

    return {"prices": prices, "usd_inr": round(usd_inr, 2) if usd_inr else None}


def _ws_fetch_pe() -> dict:
    """Fetch trailing PE and today's % change for all positions via fast_info."""
    import yfinance as yf

    data       = load()
    ticker_map = {}
    for p in data["positions"]:
        yt   = p.get("yahoo_ticker", "")
        orig = p.get("ticker", "")
        if yt and orig:
            ticker_map[yt] = orig

    if not ticker_map:
        return {}

    pe_data = {}
    try:
        obj = yf.Tickers(" ".join(ticker_map.keys()))
        for yt, orig in ticker_map.items():
            try:
                fi   = obj.tickers[yt].fast_info
                pe   = getattr(fi, "trailing_pe", None)
                prev = getattr(fi, "previous_close", None)
                cmp  = getattr(fi, "last_price", None)
                chg  = round((cmp - prev) / prev * 100, 2) if cmp and prev else None
                if pe and pe == pe:           # NaN guard
                    pe_data[orig] = {
                        "pe":         round(float(pe), 1),
                        "change_pct": chg,
                    }
                elif chg is not None:
                    pe_data[orig] = {"change_pct": chg}
            except Exception:
                pass
    except Exception:
        pass

    return pe_data


@app.websocket("/ws/prices")
async def ws_prices(websocket: WebSocket):
    await websocket.accept()
    loop   = asyncio.get_event_loop()
    tick   = 0
    try:
        while True:
            tick += 1
            # Every tick: CMP (fast batch download)
            cmp_data = await loop.run_in_executor(None, _ws_fetch_cmp)

            # Every 10th tick (~5 min): also fetch PE + % change via fast_info
            pe_data: dict = {}
            if tick % 10 == 1:
                pe_data = await loop.run_in_executor(None, _ws_fetch_pe)

            await websocket.send_json({
                "type":      "update",
                "prices":    cmp_data.get("prices", {}),
                "usd_inr":   cmp_data.get("usd_inr"),
                "pe":        pe_data,
                "timestamp": datetime.now().strftime("%H:%M:%S"),
                "count":     len(cmp_data.get("prices", {})),
            })

            await asyncio.sleep(30)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass


# ─── Position CRUD ─────────────────────────────────────────────────────────────

@app.post("/api/positions")
def add_position(p: PositionIn):
    data = load()
    pos  = p.model_dump()
    pos["id"]           = str(uuid.uuid4())
    pos["created_at"]   = date.today().isoformat()
    pos["cmp"]          = p.avg_buy_price
    pos["peak_price"]   = p.avg_buy_price
    pos["yahoo_ticker"] = _to_yahoo(p.ticker, p.currency)
    # Seed the trade log with the initial buy entry
    pos["trades"] = [{
        "id":    str(uuid.uuid4()),
        "date":  p.buy_date or date.today().isoformat(),
        "type":  "buy",
        "qty":   p.quantity,
        "price": p.avg_buy_price,
        "note":  "Initial buy",
    }]
    data["positions"].append(pos)
    save(data)
    return enrich(pos, data["settings"].get("usd_inr_rate", 84.0))


@app.put("/api/positions/{pos_id}")
def update_position(pos_id: str, updates: dict[str, Any]):
    data = load()
    rate = data["settings"].get("usd_inr_rate", 84.0)
    for i, p in enumerate(data["positions"]):
        if p["id"] == pos_id:
            data["positions"][i].update(updates)
            row = data["positions"][i]
            if "cmp" in updates:
                row["peak_price"] = round(
                    max(row.get("peak_price") or 0,
                        row.get("avg_buy_price") or 0,
                        updates["cmp"]), 4)
            row["yahoo_ticker"] = _to_yahoo(row.get("ticker", ""), row.get("currency", "INR"))
            save(data)
            return enrich(row, rate)
    raise HTTPException(404, "Not found")


@app.delete("/api/positions/{pos_id}")
def delete_position(pos_id: str):
    data = load()
    data["positions"] = [p for p in data["positions"] if p["id"] != pos_id]
    save(data)
    return {"ok": True}


@app.post("/api/positions/{pos_id}/sell")
def sell_position(pos_id: str, journal: dict[str, Any]):
    """Archive a position into sold_positions journal and remove from active positions."""
    data = load()
    pos  = next((p for p in data["positions"] if p["id"] == pos_id), None)
    if not pos:
        raise HTTPException(404, "Position not found")
    rate = data["settings"].get("usd_inr_rate", 84.0)
    enriched = enrich(pos, rate)
    sell_price = journal.get("sell_price") or enriched.get("cmp") or pos.get("avg_buy_price", 0)
    sell_qty   = journal.get("sell_qty") or pos.get("quantity", 0)
    invested   = pos.get("avg_buy_price", 0) * sell_qty
    proceeds   = sell_price * sell_qty
    realized_pnl     = proceeds - invested
    realized_pnl_pct = (realized_pnl / invested * 100) if invested else 0
    entry = {
        "id":               str(uuid.uuid4()),
        "original_id":      pos_id,
        "account":          pos.get("account"),
        "stock_name":       pos.get("stock_name"),
        "ticker":           pos.get("ticker"),
        "sector":           pos.get("sector"),
        "currency":         pos.get("currency", "INR"),
        "buy_date":         pos.get("buy_date"),
        "sell_date":        journal.get("sell_date") or date.today().isoformat(),
        "avg_buy_price":    pos.get("avg_buy_price"),
        "sell_price":       sell_price,
        "sell_qty":         sell_qty,
        "invested":         round(invested, 2),
        "proceeds":         round(proceeds, 2),
        "realized_pnl":     round(realized_pnl, 2),
        "realized_pnl_pct": round(realized_pnl_pct, 2),
        "peak_price":       pos.get("peak_price"),
        "trades":           pos.get("trades", []),
        "thesis":           journal.get("thesis", ""),
        "antithesis":       journal.get("antithesis", ""),
        "lessons":          journal.get("lessons", ""),
        "archived_at":      date.today().isoformat(),
    }
    data.setdefault("sold_positions", []).append(entry)
    data["positions"] = [p for p in data["positions"] if p["id"] != pos_id]
    # Also remove from watchlist if the same ticker is tracked there
    sold_ticker = pos.get("ticker")
    if sold_ticker:
        data["watchlist"] = [w for w in data.get("watchlist", []) if w.get("ticker") != sold_ticker]
    save(data)
    return entry


@app.get("/api/sold_positions")
def get_sold_positions():
    return load().get("sold_positions", [])


@app.put("/api/sold_positions/{sid}")
def update_sold_position(sid: str, updates: dict[str, Any]):
    data = load()
    for i, s in enumerate(data.get("sold_positions", [])):
        if s["id"] == sid:
            data["sold_positions"][i].update(updates)
            save(data)
            return data["sold_positions"][i]
    raise HTTPException(404, "Not found")


@app.delete("/api/sold_positions/{sid}")
def delete_sold_position(sid: str):
    data = load()
    data["sold_positions"] = [s for s in data.get("sold_positions", []) if s["id"] != sid]
    save(data)
    return {"ok": True}


# ─── Trades within a position ──────────────────────────────────────────────────

@app.post("/api/positions/{pos_id}/trades")
def add_trade(pos_id: str, trade: dict[str, Any]):
    data = load()
    for i, p in enumerate(data["positions"]):
        if p["id"] == pos_id:
            new_trade = {
                "id":    str(uuid.uuid4()),
                "date":  trade.get("date", date.today().isoformat()),
                "type":  trade.get("type", "buy"),   # buy | sell
                "qty":   trade.get("qty", 0),
                "price": trade.get("price", 0),
                "note":  trade.get("note", ""),
            }
            data["positions"][i].setdefault("trades", []).append(new_trade)
            all_trades = data["positions"][i]["trades"]

            # Auto-archive when total sold qty covers the full position
            if new_trade["type"] == "sell":
                total_sold = sum(t.get("qty", 0) for t in all_trades if t.get("type") == "sell")
                pos_qty    = p.get("quantity", 0) or 0
                if pos_qty > 0 and total_sold >= pos_qty:
                    sell_trades     = [t for t in all_trades if t.get("type") == "sell"]
                    total_proceeds  = sum(t.get("qty", 0) * t.get("price", 0) for t in sell_trades)
                    avg_sell_price  = total_proceeds / total_sold if total_sold else 0
                    invested        = p.get("avg_buy_price", 0) * pos_qty
                    realized_pnl    = total_proceeds - invested
                    realized_pnl_pct = (realized_pnl / invested * 100) if invested else 0
                    sell_date       = max((t.get("date", "") for t in sell_trades), default=date.today().isoformat())
                    entry = {
                        "id":               str(uuid.uuid4()),
                        "original_id":      pos_id,
                        "account":          p.get("account"),
                        "stock_name":       p.get("stock_name"),
                        "ticker":           p.get("ticker"),
                        "sector":           p.get("sector"),
                        "currency":         p.get("currency", "INR"),
                        "buy_date":         p.get("buy_date"),
                        "sell_date":        sell_date,
                        "avg_buy_price":    p.get("avg_buy_price"),
                        "sell_price":       round(avg_sell_price, 2),
                        "sell_qty":         total_sold,
                        "invested":         round(invested, 2),
                        "proceeds":         round(total_proceeds, 2),
                        "realized_pnl":     round(realized_pnl, 2),
                        "realized_pnl_pct": round(realized_pnl_pct, 2),
                        "peak_price":       p.get("peak_price"),
                        "trades":           all_trades,
                        "thesis":           "",
                        "antithesis":       "",
                        "lessons":          "",
                        "archived_at":      date.today().isoformat(),
                        "auto_archived":    True,
                    }
                    data.setdefault("sold_positions", []).append(entry)
                    data["positions"] = [pos for pos in data["positions"] if pos["id"] != pos_id]
                    # Also remove from watchlist
                    sold_ticker = p.get("ticker")
                    if sold_ticker:
                        data["watchlist"] = [w for w in data.get("watchlist", []) if w.get("ticker") != sold_ticker]
                    save(data)
                    return {"archived": True, "entry": entry}

            save(data)
            return data["positions"][i]["trades"]
    raise HTTPException(404, "Not found")


@app.delete("/api/positions/{pos_id}/trades/{trade_id}")
def delete_trade(pos_id: str, trade_id: str):
    data = load()
    for i, p in enumerate(data["positions"]):
        if p["id"] == pos_id:
            data["positions"][i]["trades"] = [
                t for t in p.get("trades", []) if t["id"] != trade_id
            ]
            save(data)
            return data["positions"][i]["trades"]
    raise HTTPException(404, "Not found")


# ─── Watchlist CRUD ────────────────────────────────────────────────────────────

def _resolve_job(wid: str, ticker: str) -> dict:
    """Return the job for wid, eagerly resolving running steps whose file already appeared."""
    symbol = _get_symbol(ticker)
    job    = _analysis_jobs.get(wid)
    if job is None:
        job = _detect_disk_state(symbol)
        _analysis_jobs[wid] = job

    # Eagerly promote running → done if file appeared
    if job["extract"]["status"] == "running":
        ep = _get_extract_path(symbol)
        try:
            start_ts = datetime.fromisoformat(job["extract"]["started_at"]).timestamp()
        except Exception:
            start_ts = 0
        if ep.exists() and ep.stat().st_mtime >= start_ts - 5:
            job["extract"]["status"] = "done"

    # Also promote not_started → done if extract file exists (generated externally)
    if job["extract"]["status"] == "not_started" and _get_extract_path(symbol).exists():
        job["extract"]["status"] = "done"

    if job["deepdive"]["status"] == "running":
        dp = _get_dashboard_path(symbol)
        try:
            start_ts = datetime.fromisoformat(job["deepdive"]["started_at"]).timestamp()
        except Exception:
            start_ts = 0
        if dp.exists() and dp.stat().st_mtime >= start_ts - 5:
            job["deepdive"]["status"]         = "done"
            job["deepdive"]["dashboard_path"] = str(dp)

    # Also promote not_started → done if dashboard file exists (generated externally)
    if job["deepdive"]["status"] == "not_started":
        dp = _get_dashboard_path(symbol)
        if dp.exists():
            job["deepdive"]["status"]         = "done"
            job["deepdive"]["dashboard_path"] = str(dp)

    return job


@app.get("/api/watchlist/status/all")
def get_all_status():
    data   = load()
    result = {}
    for w in data["watchlist"]:
        result[w["id"]] = _resolve_job(w["id"], w.get("ticker", ""))
    return result


@app.get("/api/watchlist/{wid}/status")
def get_status(wid: str):
    data = load()
    item = next((w for w in data["watchlist"] if w["id"] == wid), None)
    if not item:
        raise HTTPException(404, "Not found")
    return _resolve_job(wid, item.get("ticker", ""))


@app.post("/api/watchlist/{wid}/download")
def wl_download(wid: str):
    data = load()
    item = next((w for w in data["watchlist"] if w["id"] == wid), None)
    if not item:
        raise HTTPException(404, "Not found")
    symbol = _get_symbol(item.get("ticker", ""))
    job    = _resolve_job(wid, item.get("ticker", ""))
    job["download"]["status"] = "visited"
    return {"screener_url": f"https://www.screener.in/company/{symbol}/",
            "symbol": symbol, "job": job}


@app.post("/api/watchlist/{wid}/extract")
def wl_extract(wid: str):
    data = load()
    item = next((w for w in data["watchlist"] if w["id"] == wid), None)
    if not item:
        raise HTTPException(404, "Not found")
    ticker = item.get("ticker", "")
    symbol = _get_symbol(ticker)
    job    = _resolve_job(wid, ticker)
    if job["extract"]["status"] == "running":
        return {"status": "already_running", "job": job}
    job["extract"].update({"status": "running", "started_at": datetime.now().isoformat(), "error": None})
    threading.Thread(target=_run_extract, args=(wid, symbol), daemon=True).start()
    return {"status": "started", "job": job}


@app.post("/api/watchlist/{wid}/deepdive")
def wl_deepdive(wid: str):
    data = load()
    item = next((w for w in data["watchlist"] if w["id"] == wid), None)
    if not item:
        raise HTTPException(404, "Not found")
    ticker = item.get("ticker", "")
    symbol = _get_symbol(ticker)
    job    = _resolve_job(wid, ticker)
    if job["deepdive"]["status"] == "running":
        return {"status": "already_running", "job": job}
    job["deepdive"].update({"status": "running", "started_at": datetime.now().isoformat(), "error": None})
    threading.Thread(target=_run_deepdive, args=(wid, symbol), daemon=True).start()
    return {"status": "started", "job": job}


@app.get("/dashboard/{wid}", response_class=HTMLResponse)
def serve_dashboard(wid: str):
    data = load()
    item = next((w for w in data["watchlist"] if w["id"] == wid), None)
    if not item:
        raise HTTPException(404, "Not found")
    dp = _get_dashboard_path(_get_symbol(item.get("ticker", "")))
    if not dp.exists():
        raise HTTPException(404, "Dashboard not generated yet")
    return dp.read_text()


@app.get("/api/watchlist")
def get_watchlist():
    return load()["watchlist"]

@app.post("/api/watchlist")
def add_watchlist(item: WatchlistIn):
    data = load()
    w    = item.model_dump()
    w["id"]           = str(uuid.uuid4())
    w["added_date"]   = date.today().isoformat()
    w["yahoo_ticker"] = _to_yahoo(item.ticker)
    data["watchlist"].append(w)
    save(data)
    return w

@app.put("/api/watchlist/{wid}")
def update_watchlist(wid: str, updates: dict[str, Any]):
    data = load()
    for i, w in enumerate(data["watchlist"]):
        if w["id"] == wid:
            data["watchlist"][i].update(updates)
            save(data)
            return data["watchlist"][i]
    raise HTTPException(404, "Not found")

@app.delete("/api/watchlist/{wid}")
def delete_watchlist(wid: str):
    data = load()
    data["watchlist"] = [w for w in data["watchlist"] if w["id"] != wid]
    save(data)
    return {"ok": True}


# ─── AIF NAV ───────────────────────────────────────────────────────────────────

class AifNavIn(BaseModel):
    month: str   # "YYYY-MM"
    value: float

@app.get("/api/aif_nav")
def get_aif_nav():
    data = load()
    return sorted(data.get("aif_nav", []), key=lambda x: x["month"])

@app.post("/api/aif_nav")
def upsert_aif_nav(item: AifNavIn):
    data = load()
    nav_list = data.setdefault("aif_nav", [])
    for i, entry in enumerate(nav_list):
        if entry["month"] == item.month:
            nav_list[i]["value"] = item.value
            save(data)
            return item.model_dump()
    nav_list.append(item.model_dump())
    save(data)
    return item.model_dump()

@app.delete("/api/aif_nav/{month}")
def delete_aif_nav(month: str):
    data = load()
    data["aif_nav"] = [e for e in data.get("aif_nav", []) if e["month"] != month]
    save(data)
    return {"ok": True}


# ─── AIF Investor Meets ────────────────────────────────────────────────────────

class AifInvestorMeetIn(BaseModel):
    id:           Optional[str] = None
    month:        str            # "YYYY-MM" — the investor meet month
    title:        Optional[str] = None
    youtube_url:  Optional[str] = None
    summary_url:  Optional[str] = None
    notes:        Optional[str] = None
    added_date:   Optional[str] = None  # ISO date string set server-side if missing

@app.get("/api/aif_investor_meets")
def get_aif_investor_meets():
    data = load()
    meets = sorted(data.get("aif_investor_meets", []), key=lambda x: x["month"], reverse=True)
    return meets

@app.post("/api/aif_investor_meets")
def add_aif_investor_meet(item: AifInvestorMeetIn):
    import uuid as _uuid, datetime as _dt
    data  = load()
    meets = data.setdefault("aif_investor_meets", [])
    meet  = item.model_dump()
    if not meet.get("id"):
        meet["id"] = str(_uuid.uuid4())[:8]
    if not meet.get("added_date"):
        meet["added_date"] = _dt.date.today().isoformat()
    meets.append(meet)
    save(data)
    return meet

@app.put("/api/aif_investor_meets/{mid}")
def update_aif_investor_meet(mid: str, item: AifInvestorMeetIn):
    data  = load()
    meets = data.setdefault("aif_investor_meets", [])
    for i, m in enumerate(meets):
        if m["id"] == mid:
            updated = {**m, **{k: v for k, v in item.model_dump().items() if v is not None}}
            updated["id"] = mid
            meets[i] = updated
            save(data)
            return updated
    raise HTTPException(status_code=404, detail="Not found")

@app.delete("/api/aif_investor_meets/{mid}")
def delete_aif_investor_meet(mid: str):
    data  = load()
    data["aif_investor_meets"] = [m for m in data.get("aif_investor_meets", []) if m["id"] != mid]
    save(data)
    return {"ok": True}


# ─── Settings ──────────────────────────────────────────────────────────────────

@app.put("/api/settings")
def update_settings(s: SettingsIn):
    data    = load()
    payload = {k: v for k, v in s.model_dump().items() if v is not None}
    data["settings"].update(payload)
    save(data)
    return data["settings"]


# ─── Cash balances ─────────────────────────────────────────────────────────────

@app.get("/api/cash_balances")
def get_cash_balances():
    return load().get("cash_balances", {})

@app.put("/api/cash_balances")
def update_cash_balances(balances: dict[str, Any]):
    data = load()
    data["cash_balances"] = balances
    save(data)


# ─── Capital transferred ────────────────────────────────────────────────────────

@app.get("/api/capital_transferred")
def get_capital_transferred():
    return load().get("capital_transferred", {})

@app.post("/api/capital_transferred/{account}")
def add_capital_entry(account: str, entry: dict[str, Any]):
    import uuid as _uuid
    data = load()
    ct = data.setdefault("capital_transferred", {})
    ct.setdefault(account, [])
    entry["id"] = str(_uuid.uuid4())
    ct[account].append(entry)
    # keep sorted by date (empty dates go last)
    ct[account].sort(key=lambda e: e.get("date") or "9999-99-99")
    save(data)
    return ct[account]

@app.delete("/api/capital_transferred/{account}/{entry_id}")
def delete_capital_entry(account: str, entry_id: str):
    data = load()
    ct = data.get("capital_transferred", {})
    ct[account] = [e for e in ct.get(account, []) if e["id"] != entry_id]
    save(data)
    return ct[account]
    return data["cash_balances"]


# ─── HUF Transfers ─────────────────────────────────────────────────────────────

@app.get("/api/huf_transfers")
def get_huf_transfers():
    return sorted(load().get("huf_transfers", []), key=lambda x: x["date"], reverse=True)

@app.post("/api/huf_transfers")
def add_huf_transfer(item: HufTransferIn):
    data = load()
    t = item.model_dump()
    t["id"] = str(uuid.uuid4())
    data.setdefault("huf_transfers", []).append(t)
    save(data)
    return t

@app.delete("/api/huf_transfers/{tid}")
def delete_huf_transfer(tid: str):
    data = load()
    data["huf_transfers"] = [t for t in data.get("huf_transfers", []) if t["id"] != tid]
    save(data)
    return {"ok": True}


# ─── US Watchlist CRUD ─────────────────────────────────────────────────────────

@app.get("/api/us_watchlist")
def get_us_watchlist():
    return load()["us_watchlist"]

@app.post("/api/us_watchlist")
def add_us_watchlist(item: WatchlistIn):
    data = load()
    w    = item.model_dump()
    w["id"]           = str(uuid.uuid4())
    w["added_date"]   = date.today().isoformat()
    w["yahoo_ticker"] = item.ticker.strip().upper()   # US tickers: bare symbol
    data["us_watchlist"].append(w)
    save(data)
    return w

@app.put("/api/us_watchlist/{wid}")
def update_us_watchlist(wid: str, updates: dict[str, Any]):
    data = load()
    for i, w in enumerate(data["us_watchlist"]):
        if w["id"] == wid:
            data["us_watchlist"][i].update(updates)
            save(data)
            return data["us_watchlist"][i]
    raise HTTPException(404, "Not found")

@app.delete("/api/us_watchlist/{wid}")
def delete_us_watchlist(wid: str):
    data = load()
    data["us_watchlist"] = [w for w in data["us_watchlist"] if w["id"] != wid]
    save(data)
    return {"ok": True}


# ─── Mutual Funds ─────────────────────────────────────────────────────────────

class MutualFundIn(BaseModel):
    fund_name:       str
    amc:             Optional[str]   = None
    scheme_code:     Optional[str]   = None   # AMFI scheme code
    holder:          str = "vibhanshu"         # vibhanshu | manjari
    units:           Optional[float] = None
    nav:             Optional[float] = None    # cached NAV
    nav_date:        Optional[str]   = None
    sip_amount:      Optional[float] = None
    sip_frequency:   Optional[str]   = "monthly"  # monthly/quarterly/lumpsum
    sip_start_date:  Optional[str]   = None
    total_invested:  Optional[float] = None   # manual override
    notes:           Optional[str]   = ""

@app.get("/api/mutual_funds")
def get_mutual_funds():
    return load().get("mutual_funds", [])

@app.post("/api/mutual_funds")
def add_mutual_fund(item: MutualFundIn):
    data = load()
    mf   = item.model_dump()
    mf["id"]         = str(uuid.uuid4())[:8]
    mf["added_date"] = date.today().isoformat()
    data.setdefault("mutual_funds", []).append(mf)
    save(data)
    return mf

@app.put("/api/mutual_funds/{mid}")
def update_mutual_fund(mid: str, updates: dict[str, Any]):
    data = load()
    for i, mf in enumerate(data.get("mutual_funds", [])):
        if mf["id"] == mid:
            data["mutual_funds"][i].update(updates)
            save(data)
            return data["mutual_funds"][i]
    raise HTTPException(404, "Not found")

@app.delete("/api/mutual_funds/{mid}")
def delete_mutual_fund(mid: str):
    data = load()
    data["mutual_funds"] = [m for m in data.get("mutual_funds", []) if m["id"] != mid]
    save(data)
    return {"ok": True}

@app.get("/api/mf_nav")
def get_mf_nav(scheme_code: str):
    """Fetch latest NAV from AMFI via mfapi.in."""
    try:
        import urllib.request as _ur
        url  = f"https://api.mfapi.in/mf/{scheme_code}"
        with _ur.urlopen(url, timeout=8) as r:
            obj = json.loads(r.read())
        meta = obj.get("meta", {})
        data_list = obj.get("data", [])
        if not data_list:
            return {"error": "No NAV data returned"}
        latest = data_list[0]   # most recent first
        return {
            "scheme_code":  scheme_code,
            "fund_name":    meta.get("scheme_name", ""),
            "amc":          meta.get("fund_house", ""),
            "nav":          float(latest["nav"]),
            "nav_date":     latest["date"],
        }
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/mf_nav/search")
def search_mf(q: str):
    """Search AMFI schemes by name."""
    try:
        import urllib.request as _ur, urllib.parse as _up
        url = f"https://api.mfapi.in/mf/search?q={_up.quote(q)}"
        with _ur.urlopen(url, timeout=8) as r:
            results = json.loads(r.read())
        return results[:20]   # cap at 20
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/mf_nav/refresh_all")
def refresh_all_mf_nav():
    """Refresh NAV for every MF that has a scheme_code."""
    import urllib.request as _ur
    data  = load()
    funds = data.get("mutual_funds", [])
    updated = 0
    for mf in funds:
        sc = mf.get("scheme_code")
        if not sc:
            continue
        try:
            url = f"https://api.mfapi.in/mf/{sc}"
            with _ur.urlopen(url, timeout=8) as r:
                obj = json.loads(r.read())
            latest = obj.get("data", [{}])[0]
            if latest.get("nav"):
                mf["nav"]      = float(latest["nav"])
                mf["nav_date"] = latest["date"]
                updated += 1
        except Exception:
            pass
    if updated:
        save(data)
    return {"updated": updated, "total": len([m for m in funds if m.get("scheme_code")])}


# ─── Fixed Income ──────────────────────────────────────────────────────────────

class FixedIncomeIn(BaseModel):
    name:         str
    type:         str = "FD"   # FD | Bond | NCD | PPF | EPF | SGB | Other
    holder:       str = "vibhanshu"
    principal:    float
    rate:         Optional[float] = None   # % per annum
    start_date:   Optional[str]  = None
    maturity_date: Optional[str] = None
    compounding:  Optional[str]  = "quarterly"  # simple | monthly | quarterly | annually
    current_value: Optional[float] = None   # manual override; else auto-computed
    notes:        Optional[str]  = ""

def _compute_fi_value(fi: dict) -> Optional[float]:
    """Compute FD/bond current value using compound interest if no manual override."""
    if fi.get("current_value"):
        return fi["current_value"]
    p = fi.get("principal")
    r = fi.get("rate")
    sd = fi.get("start_date")
    if not (p and r and sd):
        return p   # just return principal if not enough info
    try:
        from datetime import datetime as _dt
        today = _dt.today()
        start = _dt.strptime(sd, "%Y-%m-%d")
        mat   = fi.get("maturity_date")
        end   = min(today, _dt.strptime(mat, "%Y-%m-%d")) if mat else today
        t = max((end - start).days / 365, 0)
        comp = fi.get("compounding", "quarterly")
        if comp == "simple":
            return round(p * (1 + r * t / 100), 2)
        n = {"monthly": 12, "quarterly": 4, "annually": 1}.get(comp, 4)
        return round(p * (1 + r / (100 * n)) ** (n * t), 2)
    except Exception:
        return p

@app.get("/api/fixed_income")
def get_fixed_income():
    data = load()
    items = data.get("fixed_income", [])
    for fi in items:
        fi["_computed_value"] = _compute_fi_value(fi)
    return items

@app.post("/api/fixed_income")
def add_fixed_income(item: FixedIncomeIn):
    data = load()
    fi   = item.model_dump()
    fi["id"]         = str(uuid.uuid4())[:8]
    fi["added_date"] = date.today().isoformat()
    data.setdefault("fixed_income", []).append(fi)
    save(data)
    fi["_computed_value"] = _compute_fi_value(fi)
    return fi

@app.put("/api/fixed_income/{fid}")
def update_fixed_income(fid: str, updates: dict[str, Any]):
    data = load()
    for i, fi in enumerate(data.get("fixed_income", [])):
        if fi["id"] == fid:
            data["fixed_income"][i].update(updates)
            save(data)
            r = dict(data["fixed_income"][i])
            r["_computed_value"] = _compute_fi_value(r)
            return r
    raise HTTPException(404, "Not found")

@app.delete("/api/fixed_income/{fid}")
def delete_fixed_income(fid: str):
    data = load()
    data["fixed_income"] = [f for f in data.get("fixed_income", []) if f["id"] != fid]
    save(data)
    return {"ok": True}


# ─── Unlisted Investments ──────────────────────────────────────────────────────

class UnlistedIn(BaseModel):
    company_name:       str
    sector:             Optional[str]  = None
    holder:             str = "vibhanshu"
    invested_amount:    float
    current_valuation:  Optional[float] = None   # manually updated
    investment_date:    Optional[str]   = None
    stage:              Optional[str]   = None   # Pre-IPO, Series A/B/C…
    notes:              Optional[str]   = ""

@app.get("/api/unlisted")
def get_unlisted():
    return load().get("unlisted", [])

@app.post("/api/unlisted")
def add_unlisted(item: UnlistedIn):
    data = load()
    ul   = item.model_dump()
    ul["id"]         = str(uuid.uuid4())[:8]
    ul["added_date"] = date.today().isoformat()
    data.setdefault("unlisted", []).append(ul)
    save(data)
    return ul

@app.put("/api/unlisted/{uid}")
def update_unlisted(uid: str, updates: dict[str, Any]):
    data = load()
    for i, ul in enumerate(data.get("unlisted", [])):
        if ul["id"] == uid:
            data["unlisted"][i].update(updates)
            save(data)
            return data["unlisted"][i]
    raise HTTPException(404, "Not found")

@app.delete("/api/unlisted/{uid}")
def delete_unlisted(uid: str):
    data = load()
    data["unlisted"] = [u for u in data.get("unlisted", []) if u["id"] != uid]
    save(data)
    return {"ok": True}


# ─── NPS ───────────────────────────────────────────────────────────────────────

class NpsIn(BaseModel):
    holder:        str            = "vibhanshu"   # vibhanshu | manjari
    pran:          Optional[str]  = None
    tier:          str            = "Tier I"      # Tier I | Tier II
    fund_manager:  Optional[str]  = None          # SBI, HDFC, LIC, UTI, Kotak, etc.
    scheme:        Optional[str]  = None          # E / C / G / A
    total_invested: Optional[float] = None
    current_value:  Optional[float] = None        # latest corpus value
    as_of_date:    Optional[str]  = None          # date of last valuation
    notes:         Optional[str]  = ""

@app.get("/api/nps")
def get_nps():
    return load().get("nps", [])

@app.post("/api/nps")
def add_nps(item: NpsIn):
    data = load()
    n    = item.model_dump()
    n["id"] = str(uuid.uuid4())[:8]
    data.setdefault("nps", []).append(n)
    save(data)
    return n

@app.put("/api/nps/{nid}")
def update_nps(nid: str, updates: dict[str, Any]):
    data = load()
    for i, n in enumerate(data.get("nps", [])):
        if n["id"] == nid:
            data["nps"][i].update(updates)
            save(data)
            return data["nps"][i]
    raise HTTPException(404, "Not found")

@app.delete("/api/nps/{nid}")
def delete_nps(nid: str):
    data = load()
    data["nps"] = [n for n in data.get("nps", []) if n["id"] != nid]
    save(data)
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
