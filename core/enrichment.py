from datetime import date, datetime
from typing import Optional
import pandas as pd


def cagr(invested, current, buy_date_str) -> Optional[float]:
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


def enrich(pos: dict, usd_inr: float = 84.0) -> dict:
    avg     = pos.get("avg_buy_price", 0) or 0
    qty     = pos.get("quantity", 0) or 0
    cmp_val = pos.get("cmp") or avg
    cur     = pos.get("currency", "INR")
    rate    = usd_inr if cur == "USD" else 1.0

    invested = avg * qty
    current  = cmp_val * qty
    inv_inr  = invested * rate
    cur_inr  = current * rate
    pnl      = current - invested
    pnl_pct  = round((pnl / invested) * 100, 2) if invested else 0

    stored_peak       = pos.get("peak_price") or 0
    pos["peak_price"] = round(max(stored_peak, avg, cmp_val), 4)

    pos["invested"]          = round(invested, 2)
    pos["current_value"]     = round(current, 2)
    pos["invested_inr"]      = round(inv_inr, 2)
    pos["current_value_inr"] = round(cur_inr, 2)
    pos["pnl"]               = round(pnl, 2)
    pos["pnl_inr"]           = round(pnl * rate, 2)
    pos["pnl_pct"]           = pnl_pct
    pos["cagr"]              = cagr(invested, current, pos.get("buy_date"))
    return pos


def _to_yahoo(ticker: str, currency: str = "INR") -> Optional[str]:
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


def _get_symbol(ticker: str) -> str:
    t = ticker.strip()
    if ":" in t:
        return t.split(":", 1)[1].strip().upper()
    return t.upper()


def _ema(s: pd.Series, span: int) -> pd.Series:
    return s.ewm(span=span, adjust=False).mean()


def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    d = close.diff()
    g = d.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    l = (-d.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    return 100 - 100 / (1 + g / l.replace(0, float("nan")))


def _adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    pc  = close.shift(1)
    tr  = pd.concat([high - low, (high - pc).abs(), (low - pc).abs()], axis=1).max(axis=1)
    up  = high.diff()
    dn  = -low.diff()
    pdm = up.where((up > dn) & (up > 0), 0.0)
    ndm = dn.where((dn > up) & (dn > 0), 0.0)
    a   = 1 / period
    atr = tr.ewm(alpha=a, adjust=False).mean()
    pdi = 100 * pdm.ewm(alpha=a, adjust=False).mean() / atr
    ndi = 100 * ndm.ewm(alpha=a, adjust=False).mean() / atr
    dx  = 100 * (pdi - ndi).abs() / (pdi + ndi).replace(0, float("nan"))
    return dx.ewm(alpha=a, adjust=False).mean()
