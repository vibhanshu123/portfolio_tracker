"""
Tax P&L Calculator — STCG / LTCG on sold positions (Indian equity, INR only).
GET /api/tax?fy=2027  →  full breakdown for FY2027 (Apr 2026 – Mar 2027)

Tax rates post Budget 2024 (Jul 23, 2024):
  Equity STCG  < 12 months  →  20%
  ETF    STCG  < 12 months  →  30% (taxed at income slab rate; 30% assumed)
  LTCG   ≥ 12 months  →  12.5% above ₹1.25 L annual exemption per taxpayer
"""
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Query

from core.enrichment import enrich
from core.persistence import load

router = APIRouter()

_LTCG_DAYS       = 365
_EQUITY_STCG_RATE = 0.20
_ETF_STCG_RATE    = 0.30   # slab rate; highest bracket assumed
_LTCG_RATE        = 0.125
_LTCG_EXEMPT      = 125_000   # ₹1.25 L per FY per taxpayer


def _is_etf(stock_name: str) -> bool:
    return "etf" in (stock_name or "").lower()


def _stcg_rate(stock_name: str) -> float:
    return _ETF_STCG_RATE if _is_etf(stock_name) else _EQUITY_STCG_RATE


def _current_fy(today: date) -> int:
    """Return FY end-year: April 2026 → 2027, Jan 2026 → 2026."""
    return today.year + 1 if today.month >= 4 else today.year


def _fy_bounds(fy_end: int):
    return date(fy_end - 1, 4, 1), date(fy_end, 3, 31)


def _classify(buy_date_str, sell_date_str):
    """Return (type, holding_days) or (None, None) if buy_date missing."""
    if not buy_date_str:
        return None, None
    try:
        bd = datetime.fromisoformat(buy_date_str).date()
        sd = datetime.fromisoformat(sell_date_str).date()
        days = (sd - bd).days
        return ("LTCG" if days >= _LTCG_DAYS else "STCG"), days
    except Exception:
        return None, None


@router.get("/api/tax")
def get_tax(fy: int = Query(default=None)):
    today   = date.today()
    fy      = fy or _current_fy(today)
    fy_start, fy_end = _fy_bounds(fy)

    data    = load()
    rate    = data["settings"].get("usd_inr_rate", 84.0)
    sold    = data.get("sold_positions", [])

    # ── Filter to this FY's INR sales ────────────────────────────────────────
    # Equity STCG bucket
    eq_stcg_gains  = eq_stcg_losses  = 0.0
    eq_stcg_count  = 0
    # ETF STCG bucket
    etf_stcg_gains = etf_stcg_losses = 0.0
    etf_stcg_count = 0
    # LTCG (same rate for equity + ETF)
    ltcg_gains = ltcg_losses = 0.0
    ltcg_count = 0
    # Unknown
    unk_pnl   = 0.0
    unk_count = 0
    processed = []

    for s in sold:
        if s.get("currency", "INR") != "INR":
            continue
        sd_str = s.get("sell_date") or s.get("archived_at", "")
        if not sd_str:
            continue
        try:
            sd = datetime.fromisoformat(sd_str).date()
        except Exception:
            continue
        if not (fy_start <= sd <= fy_end):
            continue

        pnl    = float(s.get("realized_pnl") or 0)
        name   = s.get("stock_name", "")
        is_etf = _is_etf(name)
        htype, hdays = _classify(s.get("buy_date"), sd_str)

        if htype == "STCG":
            if is_etf:
                if pnl >= 0: etf_stcg_gains  += pnl
                else:        etf_stcg_losses += pnl
                etf_stcg_count += 1
            else:
                if pnl >= 0: eq_stcg_gains  += pnl
                else:        eq_stcg_losses += pnl
                eq_stcg_count += 1
        elif htype == "LTCG":
            if pnl >= 0: ltcg_gains  += pnl
            else:        ltcg_losses += pnl
            ltcg_count += 1
        else:
            unk_pnl   += pnl
            unk_count += 1

        processed.append({
            "id":               s.get("id"),
            "stock_name":       name,
            "ticker":           s.get("ticker"),
            "account":          s.get("account"),
            "is_etf":           is_etf,
            "buy_date":         s.get("buy_date"),
            "sell_date":        str(sd),
            "holding_days":     hdays,
            "type":             htype or "Unknown",
            "stcg_rate":        _stcg_rate(name) if htype == "STCG" else None,
            "proceeds":         round(float(s.get("proceeds") or 0), 2),
            "invested":         round(float(s.get("invested") or 0), 2),
            "realized_pnl":     round(pnl, 2),
            "realized_pnl_pct": round(float(s.get("realized_pnl_pct") or 0), 2),
        })

    net_eq_stcg     = eq_stcg_gains  + eq_stcg_losses
    net_etf_stcg    = etf_stcg_gains + etf_stcg_losses
    net_ltcg        = ltcg_gains     + ltcg_losses
    eq_stcg_tax     = max(0, net_eq_stcg)  * _EQUITY_STCG_RATE
    etf_stcg_tax    = max(0, net_etf_stcg) * _ETF_STCG_RATE
    stcg_tax        = eq_stcg_tax + etf_stcg_tax
    ltcg_taxable    = max(0, net_ltcg - _LTCG_EXEMPT)
    ltcg_tax        = ltcg_taxable * _LTCG_RATE
    total_tax       = stcg_tax + ltcg_tax

    # ── LTCG countdown for active positions (gains only) ─────────────────────
    active   = [p for p in data["positions"]
                if p.get("active", True) and p.get("currency", "INR") == "INR"]
    enriched = [enrich(dict(p), rate) for p in active]

    ltcg_countdown        = []
    harvesting_candidates = []

    for p in enriched:
        bd_str = p.get("buy_date")
        if not bd_str:
            continue
        try:
            bd           = datetime.fromisoformat(bd_str).date()
            holding_days = (today - bd).days
            unrealized   = float(p.get("pnl_inr") or p.get("pnl") or 0)
            ltcg_date    = bd + timedelta(days=_LTCG_DAYS)
            sr           = _stcg_rate(p.get("stock_name", ""))

            if holding_days < _LTCG_DAYS and unrealized > 0:
                days_left = _LTCG_DAYS - holding_days
                tax_today = unrealized * sr
                tax_after = max(0, unrealized - _LTCG_EXEMPT) * _LTCG_RATE
                ltcg_countdown.append({
                    "id":               p.get("id"),
                    "stock_name":       p.get("stock_name"),
                    "ticker":           p.get("ticker"),
                    "account":          p.get("account"),
                    "is_etf":           _is_etf(p.get("stock_name", "")),
                    "buy_date":         bd_str,
                    "ltcg_date":        str(ltcg_date),
                    "days_until_ltcg":  days_left,
                    "holding_days":     holding_days,
                    "unrealized_pnl":   round(unrealized, 0),
                    "unrealized_pct":   round(float(p.get("pnl_pct") or 0), 2),
                    "tax_if_sold_now":  round(tax_today, 0),
                    "tax_if_waited":    round(tax_after, 0),
                    "tax_saving":       round(tax_today - tax_after, 0),
                    "stcg_rate":        sr,
                })

            if unrealized < 0:
                is_ltcg = holding_days >= _LTCG_DAYS
                saving  = abs(unrealized) * (_LTCG_RATE if is_ltcg else sr)
                harvesting_candidates.append({
                    "id":               p.get("id"),
                    "stock_name":       p.get("stock_name"),
                    "ticker":           p.get("ticker"),
                    "account":          p.get("account"),
                    "is_etf":           _is_etf(p.get("stock_name", "")),
                    "holding_days":     holding_days,
                    "type":             "LTCG" if is_ltcg else "STCG",
                    "stcg_rate":        sr,
                    "unrealized_pnl":   round(unrealized, 0),
                    "unrealized_pct":   round(float(p.get("pnl_pct") or 0), 2),
                    "tax_saving":       round(saving, 0),
                })
        except Exception:
            pass

    ltcg_countdown.sort(key=lambda x: x["days_until_ltcg"])
    harvesting_candidates.sort(key=lambda x: x["unrealized_pnl"])

    return {
        "fy":         fy,
        "fy_label":   f"FY{str(fy)[2:]}",
        "fy_start":   str(fy_start),
        "fy_end":     str(fy_end),
        "realized": {
            "stcg_equity": {
                "gains":   round(eq_stcg_gains,  2),
                "losses":  round(eq_stcg_losses, 2),
                "net":     round(net_eq_stcg,    2),
                "tax":     round(eq_stcg_tax,    2),
                "rate":    _EQUITY_STCG_RATE,
                "count":   eq_stcg_count,
            },
            "stcg_etf": {
                "gains":   round(etf_stcg_gains,  2),
                "losses":  round(etf_stcg_losses, 2),
                "net":     round(net_etf_stcg,    2),
                "tax":     round(etf_stcg_tax,    2),
                "rate":    _ETF_STCG_RATE,
                "count":   etf_stcg_count,
            },
            "ltcg": {
                "gains":    round(ltcg_gains,   2),
                "losses":   round(ltcg_losses,  2),
                "net":      round(net_ltcg,     2),
                "exempt":   _LTCG_EXEMPT,
                "taxable":  round(ltcg_taxable, 2),
                "tax":      round(ltcg_tax,     2),
                "rate":     _LTCG_RATE,
                "count":    ltcg_count,
            },
            "unknown": {
                "pnl":   round(unk_pnl, 2),
                "count": unk_count,
            },
        },
        "total_tax_estimate": round(total_tax, 2),
        "positions": sorted(processed, key=lambda x: x["sell_date"], reverse=True),
        "ltcg_countdown":        ltcg_countdown,
        "harvesting_candidates": harvesting_candidates,
    }
