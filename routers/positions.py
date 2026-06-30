import uuid
from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException

from core.models import PositionIn
from core.persistence import load, save
from core.enrichment import enrich, _to_yahoo

router = APIRouter()


@router.post("/api/positions")
def add_position(p: PositionIn):
    data = load()
    pos  = p.model_dump()
    pos["id"]           = str(uuid.uuid4())
    pos["created_at"]   = date.today().isoformat()
    pos["cmp"]          = p.avg_buy_price
    pos["peak_price"]   = p.avg_buy_price
    pos["yahoo_ticker"] = _to_yahoo(p.ticker, p.currency)
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


@router.put("/api/positions/{pos_id}")
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


@router.delete("/api/positions/{pos_id}")
def delete_position(pos_id: str):
    data = load()
    data["positions"] = [p for p in data["positions"] if p["id"] != pos_id]
    save(data)
    return {"ok": True}


@router.post("/api/positions/{pos_id}/sell")
def sell_position(pos_id: str, journal: dict[str, Any]):
    data = load()
    pos  = next((p for p in data["positions"] if p["id"] == pos_id), None)
    if not pos:
        raise HTTPException(404, "Position not found")
    rate      = data["settings"].get("usd_inr_rate", 84.0)
    enriched  = enrich(pos, rate)
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
    sold_ticker = pos.get("ticker")
    if sold_ticker:
        data["watchlist"] = [w for w in data.get("watchlist", []) if w.get("ticker") != sold_ticker]
    save(data)
    return entry


@router.get("/api/sold_positions")
def get_sold_positions():
    return load().get("sold_positions", [])


@router.put("/api/sold_positions/{sid}")
def update_sold_position(sid: str, updates: dict[str, Any]):
    data = load()
    for i, s in enumerate(data.get("sold_positions", [])):
        if s["id"] == sid:
            data["sold_positions"][i].update(updates)
            save(data)
            return data["sold_positions"][i]
    raise HTTPException(404, "Not found")


@router.delete("/api/sold_positions/{sid}")
def delete_sold_position(sid: str):
    data = load()
    data["sold_positions"] = [s for s in data.get("sold_positions", []) if s["id"] != sid]
    save(data)
    return {"ok": True}


@router.post("/api/positions/{pos_id}/trades")
def add_trade(pos_id: str, trade: dict[str, Any]):
    data = load()
    for i, p in enumerate(data["positions"]):
        if p["id"] == pos_id:
            new_trade = {
                "id":    str(uuid.uuid4()),
                "date":  trade.get("date", date.today().isoformat()),
                "type":  trade.get("type", "buy"),
                "qty":   trade.get("qty", 0),
                "price": trade.get("price", 0),
                "note":  trade.get("note", ""),
            }
            data["positions"][i].setdefault("trades", []).append(new_trade)
            all_trades = data["positions"][i]["trades"]

            if new_trade["type"] == "buy":
                buy_qty    = new_trade["qty"]
                buy_price  = new_trade["price"]
                current_qty = p.get("quantity", 0) or 0
                avg_buy     = p.get("avg_buy_price", 0) or 0
                new_qty     = current_qty + buy_qty
                if new_qty > 0:
                    new_avg = ((avg_buy * current_qty) + (buy_price * buy_qty)) / new_qty
                    data["positions"][i]["avg_buy_price"] = round(new_avg, 4)
                data["positions"][i]["quantity"] = new_qty

            elif new_trade["type"] == "sell":
                sell_qty      = new_trade["qty"]
                sell_price    = new_trade["price"]
                current_qty   = p.get("quantity", 0) or 0
                avg_buy       = p.get("avg_buy_price", 0) or 0
                remaining_qty = max(0, current_qty - sell_qty)
                data["positions"][i]["quantity"] = remaining_qty

                invested_this = avg_buy * sell_qty
                proceeds_this = sell_price * sell_qty
                pnl           = proceeds_this - invested_this
                pnl_pct       = (pnl / invested_this * 100) if invested_this else 0
                entry = {
                    "id":               str(uuid.uuid4()),
                    "original_id":      pos_id,
                    "account":          p.get("account"),
                    "stock_name":       p.get("stock_name"),
                    "ticker":           p.get("ticker"),
                    "sector":           p.get("sector"),
                    "currency":         p.get("currency", "INR"),
                    "buy_date":         p.get("buy_date"),
                    "sell_date":        new_trade["date"],
                    "avg_buy_price":    avg_buy,
                    "sell_price":       sell_price,
                    "sell_qty":         sell_qty,
                    "invested":         round(invested_this, 2),
                    "proceeds":         round(proceeds_this, 2),
                    "realized_pnl":     round(pnl, 2),
                    "realized_pnl_pct": round(pnl_pct, 2),
                    "peak_price":       p.get("peak_price"),
                    "trades":           all_trades,
                    "thesis":           "",
                    "antithesis":       "",
                    "lessons":          new_trade.get("note", ""),
                    "archived_at":      date.today().isoformat(),
                    "auto_archived":    True,
                    "partial":          remaining_qty > 0,
                }
                data.setdefault("sold_positions", []).append(entry)

                if remaining_qty <= 0:
                    data["positions"] = [pos for pos in data["positions"] if pos["id"] != pos_id]
                    sold_ticker = p.get("ticker")
                    if sold_ticker:
                        data["watchlist"] = [w for w in data.get("watchlist", []) if w.get("ticker") != sold_ticker]
                    save(data)
                    return {"archived": True, "entry": entry}

            save(data)
            return data["positions"][i]["trades"]
    raise HTTPException(404, "Not found")


@router.delete("/api/positions/{pos_id}/trades/{trade_id}")
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
