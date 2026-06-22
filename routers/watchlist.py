import platform
import subprocess
import threading
import uuid
from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from core.config import SOIC_DIR, CLAUDE_CLI, DASHBOARDS_DIR
from core.models import WatchlistIn
from core.persistence import load, save
from core.enrichment import _to_yahoo, _get_symbol

router = APIRouter()

_analysis_jobs: dict = {}


def _find_wl_item(data: dict, wid: str):
    """Search all watchlist collections for an item by id."""
    all_lists = ["watchlist", "us_watchlist", "soic_research"]
    # also include any custom wl_* keys
    all_lists += [k for k in data if k.startswith("wl_") and k not in all_lists]
    for key in all_lists:
        for item in data.get(key, []):
            if item.get("id") == wid:
                return item
    return None


def _get_dashboard_path(symbol: str, stock_name: str = ""):
    local = DASHBOARDS_DIR / f"{symbol}_Dashboard.html"
    if local.exists():
        return local
    if stock_name:
        name_key = stock_name.upper().replace(" ", "")
        local_by_name = DASHBOARDS_DIR / f"{name_key}_Dashboard.html"
        if local_by_name.exists():
            return local_by_name
    return SOIC_DIR / "data" / "companies" / symbol / f"{symbol}_Dashboard.html"


def _get_extract_path(symbol: str):
    return SOIC_DIR / "data" / "companies" / symbol / "extracted" / f"{symbol}_AR_Extracts.txt"


def _blank_job(symbol: str) -> dict:
    return {
        "symbol":   symbol,
        "download": {"status": "not_started"},
        "extract":  {"status": "not_started", "started_at": None, "error": None},
        "deepdive": {"status": "not_started", "started_at": None, "error": None,
                     "dashboard_path": None},
    }


def _detect_disk_state(symbol: str, stock_name: str = "") -> dict:
    job = _blank_job(symbol)
    ep  = _get_extract_path(symbol)
    dp  = _get_dashboard_path(symbol, stock_name)
    if ep.exists():
        job["extract"]["status"] = "done"
    if dp.exists():
        job["deepdive"]["status"]         = "done"
        job["deepdive"]["dashboard_path"] = str(dp)
    return job


def _open_terminal(shortcode_hint: str) -> None:
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


def _watch_file(wid: str, step: str, path, start_ts: float,
                interval: int = 10, max_iters: int = 360) -> None:
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
    _open_terminal(f"!ra-dash {symbol}")
    job = _analysis_jobs.get(wid)
    try:
        start_ts = datetime.fromisoformat(job["extract"]["started_at"]).timestamp()
    except Exception:
        import time; start_ts = time.time()
    _watch_file(wid, "extract", _get_extract_path(symbol), start_ts)


def _run_deepdive(wid: str, symbol: str) -> None:
    _open_terminal(f"!ra-dd {symbol}")
    job = _analysis_jobs.get(wid)
    try:
        start_ts = datetime.fromisoformat(job["deepdive"]["started_at"]).timestamp()
    except Exception:
        import time; start_ts = time.time()
    _watch_file(wid, "deepdive", _get_dashboard_path(symbol), start_ts)


def _resolve_job(wid: str, ticker: str, stock_name: str = "") -> dict:
    symbol = _get_symbol(ticker)
    job    = _analysis_jobs.get(wid)
    if job is None:
        job = _detect_disk_state(symbol, stock_name)
        _analysis_jobs[wid] = job

    if job["extract"]["status"] == "running":
        ep = _get_extract_path(symbol)
        try:
            start_ts = datetime.fromisoformat(job["extract"]["started_at"]).timestamp()
        except Exception:
            start_ts = 0
        if ep.exists() and ep.stat().st_mtime >= start_ts - 5:
            job["extract"]["status"] = "done"

    if job["extract"]["status"] == "not_started" and _get_extract_path(symbol).exists():
        job["extract"]["status"] = "done"

    if job["deepdive"]["status"] == "running":
        dp = _get_dashboard_path(symbol, stock_name)
        try:
            start_ts = datetime.fromisoformat(job["deepdive"]["started_at"]).timestamp()
        except Exception:
            start_ts = 0
        if dp.exists() and dp.stat().st_mtime >= start_ts - 5:
            job["deepdive"]["status"]         = "done"
            job["deepdive"]["dashboard_path"] = str(dp)

    if job["deepdive"]["status"] == "not_started":
        dp = _get_dashboard_path(symbol, stock_name)
        if dp.exists():
            job["deepdive"]["status"]         = "done"
            job["deepdive"]["dashboard_path"] = str(dp)

    return job


@router.get("/api/watchlist/status/all")
def get_all_status():
    data   = load()
    result = {}
    # Cover all watchlist collections so SOIC Research / custom lists get status too
    all_lists = ["watchlist", "us_watchlist", "soic_research"]
    all_lists += [k for k in data if k.startswith("wl_") and k not in all_lists]
    for key in all_lists:
        for w in data.get(key, []):
            result[w["id"]] = _resolve_job(w["id"], w.get("ticker", ""), w.get("stock_name", ""))
    return result


@router.get("/api/watchlist/{wid}/status")
def get_status(wid: str):
    data = load()
    item = _find_wl_item(data, wid)
    if not item:
        raise HTTPException(404, "Not found")
    return _resolve_job(wid, item.get("ticker", ""), item.get("stock_name", ""))


@router.post("/api/watchlist/{wid}/download")
def wl_download(wid: str):
    data = load()
    item = _find_wl_item(data, wid)
    if not item:
        raise HTTPException(404, "Not found")
    symbol = _get_symbol(item.get("ticker", ""))
    job    = _resolve_job(wid, item.get("ticker", ""), item.get("stock_name", ""))
    job["download"]["status"] = "visited"
    return {"screener_url": f"https://www.screener.in/company/{symbol}/",
            "symbol": symbol, "job": job}


@router.post("/api/watchlist/{wid}/extract")
def wl_extract(wid: str):
    data = load()
    item = _find_wl_item(data, wid)
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


@router.post("/api/watchlist/{wid}/deepdive")
def wl_deepdive(wid: str):
    data = load()
    item = _find_wl_item(data, wid)
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


@router.get("/dashboard/{wid}", response_class=HTMLResponse)
def serve_dashboard(wid: str):
    data = load()
    item = _find_wl_item(data, wid)
    if not item:
        raise HTTPException(404, "Not found")
    dp = _get_dashboard_path(_get_symbol(item.get("ticker", "")), item.get("stock_name", ""))
    if not dp.exists():
        raise HTTPException(404, "Dashboard not generated yet")
    return dp.read_text()


@router.get("/api/watchlist")
def get_watchlist():
    return load()["watchlist"]


@router.post("/api/watchlist")
def add_watchlist(item: WatchlistIn):
    data = load()
    w    = item.model_dump()
    w["id"]           = str(uuid.uuid4())
    w["added_date"]   = date.today().isoformat()
    w["yahoo_ticker"] = _to_yahoo(item.ticker)
    data["watchlist"].append(w)
    save(data)
    return w


@router.put("/api/watchlist/{wid}")
def update_watchlist(wid: str, updates: dict[str, Any]):
    data = load()
    for i, w in enumerate(data["watchlist"]):
        if w["id"] == wid:
            data["watchlist"][i].update(updates)
            save(data)
            return data["watchlist"][i]
    raise HTTPException(404, "Not found")


@router.delete("/api/watchlist/{wid}")
def delete_watchlist(wid: str):
    data = load()
    data["watchlist"] = [w for w in data["watchlist"] if w["id"] != wid]
    save(data)
    return {"ok": True}
