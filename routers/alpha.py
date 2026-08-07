"""
Alpha Tracker — computes per-position and portfolio-level returns vs benchmarks.
GET  /api/alpha         → cached result  {status: idle|loading|ready|error}
POST /api/alpha/refresh → kick off background computation
"""
import json
import threading
from datetime import date, datetime, timedelta

import pandas as pd
import yfinance as yf
from fastapi import APIRouter

from core.config import ALPHA_CACHE_FILE
from core.enrichment import _to_yahoo, enrich
from core.persistence import load

router = APIRouter()

_cache:   dict = {}
_lock         = threading.Lock()
_running      = False


def _load_disk_cache():
    try:
        if ALPHA_CACHE_FILE.exists():
            data = json.loads(ALPHA_CACHE_FILE.read_text())
            if data.get("status") == "ready":
                _cache.update(data)
    except Exception:
        pass

def _save_disk_cache():
    try:
        tmp = ALPHA_CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_cache))
        tmp.replace(ALPHA_CACHE_FILE)
    except Exception:
        pass

_load_disk_cache()

PERIODS = {"1m": 30, "3m": 91, "6m": 182, "1y": 365}
_NIFTY   = "^NSEI"
_SP500   = "^GSPC"
_MIDCAP  = "^NSEMDCP150"


def _close(raw, yt: str, target: date):
    """Last Close on or before `target` for ticker `yt`."""
    try:
        s = raw[yt]["Close"].dropna()
        if getattr(s.index, "tz", None) is not None:
            s.index = s.index.tz_convert(None)
        s = s[s.index.normalize() <= pd.Timestamp(target)]
        return float(s.iloc[-1]) if len(s) else None
    except Exception:
        return None


def _ret(p_now, p_then):
    if p_now and p_then and p_then > 0:
        return round((p_now - p_then) / p_then * 100, 2)
    return None


def _do_compute():
    global _running
    try:
        data     = load()
        rate     = data["settings"].get("usd_inr_rate", 84.0)
        fx_rates = data["settings"].get("fx_rates", {})
        active   = [p for p in data["positions"] if p.get("active", True)]
        enriched = [enrich(dict(p), rate, fx_rates) for p in active]

        inr_pos = [p for p in enriched if p.get("currency", "INR") == "INR"]

        # yahoo-ticker → enriched position (deduplicate by ticker)
        yt_map: dict[str, dict] = {}
        for p in enriched:
            yt = p.get("yahoo_ticker") or _to_yahoo(
                p.get("ticker", ""), p.get("currency", "INR")
            )
            if yt:
                p["_yt"] = yt
                yt_map[yt] = p

        all_tickers = list(yt_map.keys()) + [_NIFTY, _SP500, _MIDCAP]
        today       = date.today()
        start       = today - timedelta(days=400)

        raw = yf.download(
            all_tickers,
            start=str(start),
            end=str(today + timedelta(days=1)),
            progress=False,
            auto_adjust=True,
            group_by="ticker",
        )

        if raw.empty:
            raise ValueError("yfinance returned no data")

        def bench_rets(bench_yt: str) -> dict:
            now = _close(raw, bench_yt, today)
            return {
                p: _ret(now, _close(raw, bench_yt, today - timedelta(days=d)))
                for p, d in PERIODS.items()
            }

        nifty_ret   = bench_rets(_NIFTY)
        sp500_ret   = bench_rets(_SP500)
        midcap_ret  = bench_rets(_MIDCAP)

        total_inr = sum(p.get("current_value_inr", 0) for p in enriched) or 1
        result_pos = []

        for yt, p in yt_map.items():
            cur     = p.get("currency", "INR")
            bench_r = nifty_ret if cur == "INR" else sp500_ret
            now     = _close(raw, yt, today)

            pos_ret = {
                period: _ret(now, _close(raw, yt, today - timedelta(days=d)))
                for period, d in PERIODS.items()
            }
            alpha = {
                period: round(pos_ret[period] - bench_r[period], 2)
                if pos_ret[period] is not None and bench_r[period] is not None
                else None
                for period in PERIODS
            }
            weight = p.get("current_value_inr", 0) / total_inr * 100
            alpha_contribution = {
                period: round(weight / 100 * alpha[period], 2)
                if alpha[period] is not None else None
                for period in PERIODS
            }

            # Since-buy
            since_buy = None
            bd_str = p.get("buy_date")
            if bd_str:
                try:
                    bd      = datetime.fromisoformat(bd_str).date()
                    bench_yt = _NIFTY if cur == "INR" else _SP500
                    p_buy   = _close(raw, yt, bd)
                    bn_buy  = _close(raw, bench_yt, bd)
                    bn_now  = _close(raw, bench_yt, today)
                    if p_buy and now and bn_buy and bn_now:
                        years  = (today - bd).days / 365.25
                        sr     = round((now - p_buy)   / p_buy  * 100, 2)
                        br     = round((bn_now - bn_buy) / bn_buy * 100, 2)
                        since_buy = {
                            "stock_return": sr,
                            "bench_return": br,
                            "alpha":        round(sr - br, 2),
                            "years":        round(years, 1),
                        }
                except Exception:
                    pass

            result_pos.append({
                "ticker":             p.get("ticker"),
                "stock_name":         p.get("stock_name"),
                "account":            p.get("account"),
                "currency":           cur,
                "weight_pct":         round(weight, 2),
                "returns":            pos_ret,
                "alpha":              alpha,
                "alpha_contribution": alpha_contribution,
                "since_buy":          since_buy,
            })

        # Portfolio-level weighted return vs benchmark
        def portfolio_summary(positions_list: list, bench_yt: str) -> dict:
            total = sum(p.get("current_value_inr", 0) for p in positions_list) or 1
            result = {}
            for period, days in PERIODS.items():
                weighted = 0.0
                for p in positions_list:
                    yt = p.get("_yt")
                    if not yt:
                        continue
                    entry = next(
                        (x for x in result_pos if x["ticker"] == p.get("ticker")), None
                    )
                    if entry and entry["returns"].get(period) is not None:
                        w = p.get("current_value_inr", 0) / total
                        weighted += w * entry["returns"][period]
                bn = _close(raw, bench_yt, today)
                bn_then = _close(raw, bench_yt, today - timedelta(days=days))
                br = _ret(bn, bn_then)
                result[period] = {
                    "portfolio": round(weighted, 2),
                    "benchmark": br,
                    "alpha":     round(weighted - br, 2) if br is not None else None,
                }
            return result

        with _lock:
            _cache.clear()
            _cache.update({
                "status":      "ready",
                "as_of":       str(today),
                "computed_at": datetime.now().isoformat(timespec="seconds"),
                "benchmarks": {
                    "nifty50":   nifty_ret,
                    "midcap150": midcap_ret,
                    "sp500":     sp500_ret,
                },
                "portfolio": portfolio_summary(inr_pos, _NIFTY),
                "positions": result_pos,
            })
        _save_disk_cache()

    except Exception as e:
        with _lock:
            _cache.clear()
            _cache["status"]  = "error"
            _cache["message"] = str(e)
    finally:
        _running = False


@router.get("/api/alpha")
def get_alpha():
    with _lock:
        return dict(_cache) if _cache else {"status": "idle"}


@router.post("/api/alpha/refresh")
def refresh_alpha():
    global _running
    with _lock:
        if _running:
            return {"status": "already_running"}
        _running = True
        _cache.clear()
        _cache["status"] = "loading"
    threading.Thread(target=_do_compute, daemon=True).start()
    return {"status": "started"}
