import uuid
from typing import Any

from fastapi import APIRouter

from core.models import SettingsIn, HufTransferIn, WatchlistIn
from core.persistence import load, save

router = APIRouter()


# ─── Settings ──────────────────────────────────────────────────────────────────

@router.put("/api/settings")
def update_settings(s: SettingsIn):
    data    = load()
    payload = {k: v for k, v in s.model_dump().items() if v is not None}
    data["settings"].update(payload)
    save(data)
    return data["settings"]


# ─── Cash Balances ─────────────────────────────────────────────────────────────

@router.get("/api/cash_balances")
def get_cash_balances():
    return load().get("cash_balances", {})


@router.put("/api/cash_balances")
def update_cash_balances(balances: dict[str, Any]):
    data = load()
    data["cash_balances"] = balances
    save(data)


# ─── Capital Transferred ───────────────────────────────────────────────────────

@router.get("/api/capital_transferred")
def get_capital_transferred():
    return load().get("capital_transferred", {})


@router.post("/api/capital_transferred/{account}")
def add_capital_entry(account: str, entry: dict[str, Any]):
    data = load()
    ct   = data.setdefault("capital_transferred", {})
    ct.setdefault(account, [])
    entry["id"] = str(uuid.uuid4())
    ct[account].append(entry)
    ct[account].sort(key=lambda e: e.get("date") or "9999-99-99")
    save(data)
    return ct[account]


@router.delete("/api/capital_transferred/{account}/{entry_id}")
def delete_capital_entry(account: str, entry_id: str):
    data = load()
    ct   = data.get("capital_transferred", {})
    ct[account] = [e for e in ct.get(account, []) if e["id"] != entry_id]
    save(data)
    return ct[account]


# ─── HUF Transfers ─────────────────────────────────────────────────────────────

@router.get("/api/huf_transfers")
def get_huf_transfers():
    return sorted(load().get("huf_transfers", []), key=lambda x: x["date"], reverse=True)


@router.post("/api/huf_transfers")
def add_huf_transfer(item: HufTransferIn):
    data = load()
    t    = item.model_dump()
    t["id"] = str(uuid.uuid4())
    data.setdefault("huf_transfers", []).append(t)
    save(data)
    return t


@router.delete("/api/huf_transfers/{tid}")
def delete_huf_transfer(tid: str):
    data = load()
    data["huf_transfers"] = [t for t in data.get("huf_transfers", []) if t["id"] != tid]
    save(data)
    return {"ok": True}


# ─── US Watchlist ──────────────────────────────────────────────────────────────

@router.get("/api/us_watchlist")
def get_us_watchlist():
    return load()["us_watchlist"]


@router.post("/api/us_watchlist")
def add_us_watchlist(item: WatchlistIn):
    data = load()
    w    = item.model_dump()
    w["id"]           = str(uuid.uuid4())
    w["added_date"]   = __import__("datetime").date.today().isoformat()
    w["yahoo_ticker"] = item.ticker.strip().upper()
    data["us_watchlist"].append(w)
    save(data)
    return w


@router.put("/api/us_watchlist/{wid}")
def update_us_watchlist(wid: str, updates: dict[str, Any]):
    data = load()
    for i, w in enumerate(data["us_watchlist"]):
        if w["id"] == wid:
            data["us_watchlist"][i].update(updates)
            save(data)
            return data["us_watchlist"][i]
    from fastapi import HTTPException
    raise HTTPException(404, "Not found")


@router.delete("/api/us_watchlist/{wid}")
def delete_us_watchlist(wid: str):
    data = load()
    data["us_watchlist"] = [w for w in data["us_watchlist"] if w["id"] != wid]
    save(data)
    return {"ok": True}
