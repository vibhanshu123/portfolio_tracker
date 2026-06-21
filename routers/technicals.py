import asyncio
import threading
import time
from datetime import date
from typing import Any

import pandas as pd
import yfinance as yf
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from core.persistence import load, save, load_technicals, save_technicals
from core.enrichment import _to_yahoo, _ema, _rsi, _adx

router = APIRouter()

_refresh_progress: dict = {
    "running": False, "phase": "", "done": 0,
    "total": 0, "current": "", "error": None, "last_result": None,
}


def _download_batch(tickers: list, retries: int = 3) -> pd.DataFrame:
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
                time.sleep(30 * (attempt + 1))
            else:
                break
    return pd.DataFrame()


def _compute_ticker_technicals(orig_ticker: str) -> dict:
    t = orig_ticker.strip()
    is_inr = (t.upper().startswith("NSE:") or t.upper().startswith("BSE:")
              or t.endswith(".NS") or t.endswith(".BO"))
    yt        = _to_yahoo(t, "INR") if is_inr else t.upper()
    benchmark = "^NSEI" if is_inr else "^GSPC"

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
    close = _s(yt, "Close")
    high  = _s(yt, "High")
    low   = _s(yt, "Low")

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
        "benchmark": benchmark,
    }


def _do_refresh_technicals():
    _refresh_progress.update({
        "running": True, "phase": "loading",
        "done": 0, "total": 0, "current": "", "error": None, "last_result": None,
    })
    try:
        data = load()
        seen: set = set()
        tickers: list = []
        for p in data.get("positions", []):
            t = p.get("ticker", "")
            if t and t not in seen:
                seen.add(t); tickers.append(t)
        for w in data.get("watchlist", []):
            t = w.get("ticker", "")
            if t and t not in seen:
                seen.add(t); tickers.append(t)
        for w in data.get("us_watchlist", []):
            t = w.get("ticker", "")
            if t and t not in seen:
                seen.add(t); tickers.append(t)

        if not tickers:
            _refresh_progress.update({"running": False, "phase": "done", "error": "No tickers"})
            return

        _refresh_progress["total"] = len(tickers)
        _refresh_progress["phase"] = "computing"

        ok = 0
        for i, orig in enumerate(tickers):
            _refresh_progress["done"]    = i
            _refresh_progress["current"] = orig
            result = _compute_ticker_technicals(orig)
            if "error" not in result:
                tech = load_technicals()
                tech[orig] = result
                save_technicals(tech)
                ok += 1
                for p in data.get("positions", []):
                    if p.get("ticker") == orig and "peak_52w" in result:
                        p["peak_price"] = round(
                            max(p.get("peak_price") or 0, result["peak_52w"]), 2
                        )
                save(data)
            time.sleep(5)

        _refresh_progress["last_result"] = {"updated": ok, "total": len(tickers)}
        _refresh_progress["done"] = len(tickers)
    except Exception as e:
        _refresh_progress["error"] = str(e)
    finally:
        _refresh_progress["running"] = False
        _refresh_progress["phase"]   = "done"


def _run_refresh_in_background() -> bool:
    if _refresh_progress["running"]:
        return False
    t = threading.Thread(target=_do_refresh_technicals, daemon=True)
    t.start()
    return True


@router.get("/api/technicals")
def get_technicals():
    return load_technicals()


@router.get("/api/technicals/progress")
def get_refresh_progress():
    return dict(_refresh_progress)


@router.post("/api/technicals/refresh")
def refresh_technicals():
    started = _run_refresh_in_background()
    return {"status": "started" if started else "already_running",
            "progress": dict(_refresh_progress)}


@router.post("/api/technicals/single")
def refresh_single_ticker(body: dict[str, Any]):
    ticker = (body.get("ticker") or "").strip()
    if not ticker:
        raise HTTPException(400, "ticker required")
    result = _compute_ticker_technicals(ticker)
    tech = load_technicals()
    tech[ticker] = result
    save_technicals(tech)
    return {"ticker": ticker, "data": result}


@router.websocket("/ws/signals")
async def ws_signals(websocket: WebSocket):
    await websocket.accept()
    loop = asyncio.get_event_loop()
    try:
        data = load()
        seen: set = set()
        tickers: list = []
        for p in data.get("positions", []):
            t = p.get("ticker", "")
            if t and t not in seen:
                seen.add(t); tickers.append(t)
        for w in data.get("watchlist", []):
            t = w.get("ticker", "")
            if t and t not in seen:
                seen.add(t); tickers.append(t)
        for w in data.get("us_watchlist", []):
            t = w.get("ticker", "")
            if t and t not in seen:
                seen.add(t); tickers.append(t)

        await websocket.send_json({"type": "start", "total": len(tickers)})

        ok = 0
        for i, orig in enumerate(tickers):
            result = await loop.run_in_executor(None, _compute_ticker_technicals, orig)
            if "error" not in result:
                tech = load_technicals()
                tech[orig] = result
                save_technicals(tech)
                ok += 1
                for p in data.get("positions", []):
                    if p.get("ticker") == orig and "peak_52w" in result:
                        p["peak_price"] = round(
                            max(p.get("peak_price") or 0, result["peak_52w"]), 2
                        )
                save(data)
            await websocket.send_json({
                "type": "ticker", "ticker": orig, "data": result,
                "done": i + 1, "total": len(tickers),
            })
            await asyncio.sleep(5)

        await websocket.send_json({"type": "done", "updated": ok, "total": len(tickers)})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
