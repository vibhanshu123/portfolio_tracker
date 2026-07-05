"""
Portfolio group and watchlist group management.
Groups are stored in data.json["settings"]["portfolio_groups"] and
data.json["settings"]["watchlist_groups"].
"""
import re
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core.persistence import load, save

router = APIRouter()

_DEFAULT_PORTFOLIO_GROUPS = {
    "indian": [
        {"id": "vibhanshu",  "name": "Vibhanshu"},
        {"id": "manjari",    "name": "Manjari"},
        {"id": "huf",        "name": "HUF"},
        {"id": "manjbhawna", "name": "Manj/Bhawna"},
    ],
    "us": [
        {"id": "us_vibhanshu", "name": "Vibhanshu"},
        {"id": "us_manjari",   "name": "Manjari"},
        {"id": "us_huf",       "name": "HUF"},
    ],
}

_DEFAULT_WATCHLIST_GROUPS = [
    {"id": "watchlist",     "name": "India"},
    {"id": "us_watchlist",  "name": "US"},
    {"id": "soic_research", "name": "SOIC Research"},
    {"id": "top_ideas",     "name": "Top Ideas"},
]


def _get_groups(data: dict) -> dict:
    return data["settings"].setdefault("portfolio_groups", _DEFAULT_PORTFOLIO_GROUPS)


def _get_wl_groups(data: dict) -> list:
    return data["settings"].setdefault("watchlist_groups", list(_DEFAULT_WATCHLIST_GROUPS))


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.lower().strip()).strip("_")
    return s or "portfolio"


# ── Portfolio groups ──────────────────────────────────────────────────────────

@router.get("/api/portfolio-groups")
def get_portfolio_groups():
    data = load()
    return _get_groups(data)


@router.post("/api/portfolio-groups/{group}")
async def add_portfolio(group: str, request: Request):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "name is required")

    data = load()
    groups = _get_groups(data)
    if group not in groups:
        raise HTTPException(404, f"Group '{group}' not found")

    # Generate unique id
    base = ("us_" if group == "us" else "") + _slug(name)
    existing_ids = {p["id"] for p in groups[group]}
    pid = base
    if pid in existing_ids:
        pid = f"{base}_{uuid.uuid4().hex[:4]}"

    consolidated = body.get("consolidated", True)
    entry = {"id": pid, "name": name, "consolidated": consolidated}
    groups[group].append(entry)
    data["settings"]["portfolio_groups"] = groups
    save(data)
    return entry


@router.patch("/api/portfolio-groups/{group}/{pid}")
async def rename_portfolio(group: str, pid: str, request: Request):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "name is required")

    data = load()
    groups = _get_groups(data)
    if group not in groups:
        raise HTTPException(404, f"Group '{group}' not found")

    entry = next((p for p in groups[group] if p["id"] == pid), None)
    if not entry:
        raise HTTPException(404, f"Portfolio '{pid}' not found in group '{group}'")

    entry["name"] = name
    data["settings"]["portfolio_groups"] = groups
    save(data)
    return entry


@router.delete("/api/portfolio-groups/{group}/{pid}")
def delete_portfolio(group: str, pid: str):
    data = load()
    groups = _get_groups(data)
    if group not in groups:
        raise HTTPException(404, f"Group '{group}' not found")
    groups[group] = [p for p in groups[group] if p["id"] != pid]
    data["settings"]["portfolio_groups"] = groups
    save(data)
    return {"ok": True}


# ── Watchlist groups ──────────────────────────────────────────────────────────

@router.get("/api/watchlist-groups")
def get_watchlist_groups():
    data = load()
    return _get_wl_groups(data)


@router.post("/api/watchlist-groups")
async def add_watchlist_group(request: Request):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "name is required")

    data = load()
    wl_groups = _get_wl_groups(data)

    base = "wl_" + _slug(name)
    existing_ids = {w["id"] for w in wl_groups}
    wid = base
    if wid in existing_ids:
        wid = f"{base}_{uuid.uuid4().hex[:4]}"

    region = body.get("region", "india")
    entry = {"id": wid, "name": name, "region": region}
    wl_groups.append(entry)
    data["settings"]["watchlist_groups"] = wl_groups
    data.setdefault(wid, [])   # create empty list for this watchlist
    save(data)
    return entry


@router.patch("/api/watchlist-groups/{wid}")
async def rename_watchlist_group(wid: str, request: Request):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "name is required")

    data = load()
    wl_groups = _get_wl_groups(data)
    entry = next((w for w in wl_groups if w["id"] == wid), None)
    if not entry:
        raise HTTPException(404, f"Watchlist '{wid}' not found")

    entry["name"] = name
    data["settings"]["watchlist_groups"] = wl_groups
    save(data)
    return entry


@router.delete("/api/watchlist-groups/{wid}")
def delete_watchlist_group(wid: str):
    protected = {"watchlist", "us_watchlist"}
    if wid in protected:
        raise HTTPException(400, "Cannot delete built-in watchlists")
    data = load()
    wl_groups = _get_wl_groups(data)
    wl_groups = [w for w in wl_groups if w["id"] != wid]
    data["settings"]["watchlist_groups"] = wl_groups
    save(data)
    return {"ok": True}


# ── Generic watchlist CRUD (for custom lists like soic_research) ──────────────

class WatchlistItemIn(BaseModel):
    ticker: str
    stock_name: str
    sector: Optional[str] = None
    notes: Optional[str] = None
    target_buy_price: Optional[float] = None
    added_date: Optional[str] = None
    yahoo_ticker: Optional[str] = None
    added_price: Optional[float] = None
    source: Optional[str] = None


@router.get("/api/wl/{list_id}")
def get_generic_wl(list_id: str):
    data = load()
    return data.get(list_id, [])


@router.post("/api/wl/{list_id}")
async def add_generic_wl_item(list_id: str, request: Request):
    body = await request.json()
    data = load()
    items = data.setdefault(list_id, [])
    item = {
        "id": str(uuid.uuid4()),
        "ticker":           body.get("ticker", "").strip().upper(),
        "stock_name":       body.get("stock_name", "").strip(),
        "sector":           body.get("sector"),
        "notes":            body.get("notes"),
        "target_buy_price": body.get("target_buy_price"),
        "added_date":       body.get("added_date"),
        "yahoo_ticker":     body.get("yahoo_ticker"),
        "added_price":      body.get("added_price"),
        "source":           body.get("source"),
    }
    items.append(item)
    save(data)
    return item


@router.put("/api/wl/{list_id}/{item_id}")
async def update_generic_wl_item(list_id: str, item_id: str, request: Request):
    updates = await request.json()
    data = load()
    items = data.get(list_id, [])
    for i, it in enumerate(items):
        if it["id"] == item_id:
            items[i].update(updates)
            save(data)
            return items[i]
    raise HTTPException(404, "Item not found")


@router.delete("/api/wl/{list_id}/{item_id}")
def delete_generic_wl_item(list_id: str, item_id: str):
    data = load()
    data[list_id] = [it for it in data.get(list_id, []) if it["id"] != item_id]
    save(data)
    return {"ok": True}


@router.post("/api/wl-move")
async def move_wl_item(request: Request):
    """Move an item from one watchlist to another atomically."""
    body      = await request.json()
    item_id   = body.get("item_id")
    from_list = body.get("from_list")
    to_list   = body.get("to_list")
    if not all([item_id, from_list, to_list]):
        raise HTTPException(400, "item_id, from_list, to_list required")
    if from_list == to_list:
        raise HTTPException(400, "Source and destination are the same")

    data = load()
    src = data.get(from_list, [])
    item = next((it for it in src if it["id"] == item_id), None)
    if not item:
        raise HTTPException(404, f"Item {item_id} not found in {from_list}")

    # Remove from source
    data[from_list] = [it for it in src if it["id"] != item_id]

    # Add to destination with a fresh ID (keep all other fields)
    new_item = {**item, "id": str(uuid.uuid4())}
    data.setdefault(to_list, []).append(new_item)

    save(data)
    return {"ok": True, "new_id": new_item["id"], "to_list": to_list}
