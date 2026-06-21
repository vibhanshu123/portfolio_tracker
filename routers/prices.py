import asyncio
from datetime import datetime
from typing import Optional

import yfinance as yf
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from core.persistence import load, save
from core.enrichment import enrich, _to_yahoo

router = APIRouter()

_ws_clients:  set  = set()
_ws_last_msg: dict = {}
_ws_loop_task       = None


def _ws_fetch_cmp() -> dict:
    data       = load()
    ticker_map = {}
    for p in data["positions"]:
        yt   = p.get("yahoo_ticker", "")
        orig = p.get("ticker", "")
        if yt and orig:
            ticker_map[yt] = orig

    if not ticker_map:
        return {}

    all_yt  = list(ticker_map.keys()) + ["USDINR=X"]
    prices  = {}
    usd_inr = None

    def _last(raw, sym, field="Close"):
        try:
            s = raw[sym][field].dropna()
            return float(s.iloc[-1]) if len(s) else None
        except Exception:
            return None

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
                if pe and pe == pe:
                    pe_data[orig] = {"pe": round(float(pe), 1), "change_pct": chg}
                elif chg is not None:
                    pe_data[orig] = {"change_pct": chg}
            except Exception:
                pass
    except Exception:
        pass

    return pe_data


async def _ws_broadcast_loop():
    loop = asyncio.get_event_loop()
    tick = 0
    while True:
        tick += 1
        try:
            cmp_data = await loop.run_in_executor(None, _ws_fetch_cmp)
            pe_data: dict = {}
            if tick % 10 == 1:
                pe_data = await loop.run_in_executor(None, _ws_fetch_pe)
            msg = {
                "type":      "update",
                "prices":    cmp_data.get("prices", {}),
                "usd_inr":   cmp_data.get("usd_inr"),
                "pe":        pe_data,
                "timestamp": datetime.now().strftime("%H:%M:%S"),
                "count":     len(cmp_data.get("prices", {})),
            }
            _ws_last_msg.clear()
            _ws_last_msg.update(msg)
            dead = set()
            for ws in list(_ws_clients):
                try:
                    await ws.send_json(msg)
                except Exception:
                    dead.add(ws)
            _ws_clients.difference_update(dead)
        except Exception:
            pass
        await asyncio.sleep(30)


@router.websocket("/ws/prices")
async def ws_prices(websocket: WebSocket):
    global _ws_loop_task
    await websocket.accept()
    _ws_clients.add(websocket)
    if _ws_loop_task is None or _ws_loop_task.done():
        _ws_loop_task = asyncio.create_task(_ws_broadcast_loop())
    if _ws_last_msg:
        try:
            await websocket.send_json(_ws_last_msg)
        except Exception:
            pass
    try:
        while True:
            await websocket.receive_text()
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        _ws_clients.discard(websocket)


@router.get("/api/usd_rate")
def get_usd_rate():
    try:
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


@router.get("/api/quote")
def get_quote(ticker: str, on: Optional[str] = None):
    try:
        from datetime import datetime as _dt, timedelta
        t = ticker.strip()
        is_inr = (t.upper().startswith("NSE:") or t.upper().startswith("BSE:")
                  or t.endswith(".NS") or t.endswith(".BO"))
        yt = _to_yahoo(t, "INR") if is_inr else t.upper()
        tk = yf.Ticker(yt)
        if on:
            target = _dt.strptime(on, "%Y-%m-%d")
            start  = (target - timedelta(days=7)).strftime("%Y-%m-%d")
            end    = (target + timedelta(days=4)).strftime("%Y-%m-%d")
            hist   = tk.history(start=start, end=end)
            if not hist.empty:
                hist.index = hist.index.tz_localize(None) if hist.index.tzinfo else hist.index
                before = hist[hist.index <= target]
                row = before.iloc[-1] if not before.empty else hist.iloc[0]
                return {"ticker": ticker, "price": round(float(row["Close"]), 2), "date": str(row.name.date())}
            return {"error": "No history around that date"}
        price = tk.fast_info.last_price
        if price and float(price) > 0:
            return {"ticker": ticker, "price": round(float(price), 2)}
        hist = tk.history(period="5d")
        if not hist.empty:
            return {"ticker": ticker, "price": round(float(hist["Close"].iloc[-1]), 2)}
    except Exception as e:
        return {"error": str(e)}
    return {"error": "Could not fetch price"}


@router.get("/api/prices")
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
        yts = list(ticker_map.keys())

        def _extract(raw):
            result = {}
            for yt in yts:
                try:
                    col   = raw[yt]["Close"].dropna()
                    price = float(col.iloc[-1])
                    if price > 0:
                        result[yt] = price
                except Exception:
                    pass
            return result

        try:
            raw = yf.download(yts, period="1d", interval="5m",
                              progress=False, auto_adjust=True, group_by="ticker")
            updated = _extract(raw)
        except Exception:
            pass

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
            new_cmp         = round(updated[yt], 2)
            p["cmp"]        = new_cmp
            p["peak_price"] = round(max(p.get("peak_price") or 0,
                                        p.get("avg_buy_price") or 0, new_cmp), 4)
    save(data)
    data["positions"] = [enrich(p, rate) for p in data["positions"]]
    return {"updated": len(updated), "positions": data["positions"]}
