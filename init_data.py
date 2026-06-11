"""
Parse vibhanshu-jha-allocation sheet.xlsx → data.json
Run once: python3 init_data.py
"""
import json
import uuid
from pathlib import Path
from datetime import date, datetime
import openpyxl

EXCEL = Path(__file__).parent / "vibhanshu-jha-allocation sheet.xlsx"
DATA_FILE = Path(__file__).parent / "data.json"

wb = openpyxl.load_workbook(EXCEL, read_only=True, data_only=True)


def safe_float(v):
    try:
        f = float(v)
        return None if (f != f) else f  # NaN check
    except (TypeError, ValueError):
        return None


def safe_date(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return None


def to_yahoo(ticker, currency="INR"):
    if not ticker or not isinstance(ticker, str):
        return None
    t = ticker.strip()
    if currency == "USD":
        return t
    if t.startswith("NSE:"):
        return t[4:] + ".NS"
    if t.startswith("BSE:"):
        return t[4:] + ".BO"
    return t + ".NS"


# ── Parse consolidated sheet for buy dates, PE, targets, active flag ──
consolidated_meta = {}  # keyed by NSE ticker
ws_con = wb["consolidated"]
for i, row in enumerate(ws_con.iter_rows(values_only=True)):
    if i == 0:
        continue
    ticker = row[1] if len(row) > 1 else None
    if not ticker or not isinstance(ticker, str):
        continue
    ticker = ticker.strip()
    if not (ticker.startswith("NSE:") or ticker.startswith("BSE:")):
        continue
    buy_date = safe_date(row[8]) if len(row) > 8 else None
    pe = safe_float(row[12]) if len(row) > 12 else None
    max_price = safe_float(row[15]) if len(row) > 15 else None
    allowed_price = safe_float(row[14]) if len(row) > 14 else None
    active = bool(row[16]) if len(row) > 16 and row[16] is not None else True
    market_cap = safe_float(row[5]) if len(row) > 5 else None
    # sector lives in columns 18-23 — find first non-None string
    sector = None
    for ci in range(17, min(len(row), 30)):
        v = row[ci]
        if isinstance(v, str) and v.strip() and not v.strip().startswith("N/A"):
            sector = v.strip()
            break
    consolidated_meta[ticker] = {
        "buy_date": buy_date,
        "pe": pe,
        "max_price": max_price,
        "allowed_price": allowed_price,
        "active": active,
        "market_cap": market_cap,
        "sector": sector,
    }


def enrich(ticker, currency="INR"):
    """Merge consolidated metadata for a ticker."""
    base = {
        "buy_date": None,
        "pe": None,
        "max_price": None,
        "allowed_price": None,
        "active": True,
        "market_cap": None,
        "sector": None,
    }
    if currency == "INR" and ticker:
        meta = consolidated_meta.get(ticker.strip(), {})
        base.update({k: v for k, v in meta.items() if v is not None})
    return base


positions = []


def add(account, stock_name, ticker, avg_buy, qty, cmp, currency="INR", extra=None):
    if avg_buy is None or qty is None or avg_buy <= 0 or qty <= 0:
        return
    meta = enrich(ticker, currency)
    if extra:
        meta.update({k: v for k, v in extra.items() if v is not None})
    yahoo = to_yahoo(ticker, currency)
    positions.append({
        "id": str(uuid.uuid4()),
        "account": account,
        "stock_name": stock_name or ticker,
        "ticker": ticker or "",
        "yahoo_ticker": yahoo or "",
        "avg_buy_price": round(avg_buy, 4),
        "quantity": round(qty, 4),
        "cmp": round(cmp, 2) if cmp else round(avg_buy, 2),
        "currency": currency,
        **meta,
        "notes": "",
    })


def parse_standard_sheet(sheet_name, account, ticker_col=1, name_col=0):
    """Parse a sheet with standard layout: name, ticker, avg_buy, qty, cmp"""
    ws = wb[sheet_name]
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0 or len(row) < 5:
            continue
        ticker = row[ticker_col] if len(row) > ticker_col else None
        name = row[name_col] if len(row) > name_col else None
        avg_buy = safe_float(row[2])
        qty = safe_float(row[3])
        cmp = safe_float(row[4])
        if not isinstance(ticker, str) or not ticker.strip():
            continue
        if not (ticker.startswith("NSE:") or ticker.startswith("BSE:")):
            continue
        if ticker_col == 0:  # HUF/MANJBHAWNA: ticker in col 0, derive name
            name = ticker.split(":")[1] if ":" in ticker else ticker
            avg_buy = safe_float(row[1])
            qty = safe_float(row[2])
            cmp = safe_float(row[3])
        add(account, str(name) if name else ticker, ticker.strip(), avg_buy, qty, cmp)


# ── vibhanshu sheet ──
parse_standard_sheet("vibhanshu", "vibhanshu", ticker_col=1, name_col=0)

# ── manjari sheet ──
parse_standard_sheet("manjari", "manjari", ticker_col=1, name_col=0)

# ── HUF sheet (ticker is column 0, no separate stock name) ──
parse_standard_sheet("HUF", "huf", ticker_col=0, name_col=0)

# ── MANJBHAWNA sheet ──
parse_standard_sheet("MANJBHAWNA", "manjbhawna", ticker_col=0, name_col=0)

# ── US portfolio ── (3 sections: us_manjari, us_vibhanshu, us_huf)
ws = wb["US portfolio"]
all_rows = list(ws.iter_rows(values_only=True))

us_sections = [
    ("us_manjari",   1,  13),  # row indices (0-based), inclusive
    ("us_vibhanshu", 17, 30),
    ("us_huf",       32, 49),
]

for account, start, end in us_sections:
    for i in range(start, min(end + 1, len(all_rows))):
        row = all_rows[i]
        if not row or len(row) < 5:
            continue
        name = row[0]
        ticker = row[1]
        avg_buy = safe_float(row[2])
        qty = safe_float(row[3])
        cmp = safe_float(row[4])
        if not isinstance(ticker, str) or not ticker.strip():
            continue
        if ticker in ("Stock tikr",):  # header row
            continue
        if avg_buy is None or qty is None or avg_buy <= 0 or qty <= 0:
            continue
        add(account, str(name) if name else ticker.strip(), ticker.strip(), avg_buy, qty, cmp, currency="USD")


# ── Watchlist (pre-populate from MANJBHAWNA PE analysis table) ──
watchlist = []


data = {
    "positions": positions,
    "watchlist": watchlist,
    "settings": {
        "usd_inr_rate": 84.0,
    },
}

DATA_FILE.write_text(json.dumps(data, indent=2, default=str))
print(f"Wrote {len(positions)} positions to {DATA_FILE}")

# Summary
from collections import Counter
acct_counts = Counter(p["account"] for p in positions)
for acct, cnt in sorted(acct_counts.items()):
    print(f"  {acct}: {cnt} stocks")
