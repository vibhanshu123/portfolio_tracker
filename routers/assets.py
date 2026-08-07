import json
import uuid
import urllib.request
import urllib.parse
from datetime import date, datetime
from typing import Optional, Any

from fastapi import APIRouter, HTTPException

from core.models import AifNavIn, AifInvestorMeetIn, AifHoldingsMonthIn, MutualFundIn, FixedIncomeIn, UnlistedIn, NpsIn
from core.persistence import load, save

router = APIRouter()


# ─── AIF NAV ───────────────────────────────────────────────────────────────────

@router.get("/api/aif_nav")
def get_aif_nav():
    return sorted(load().get("aif_nav", []), key=lambda x: x["month"])


@router.post("/api/aif_nav")
def upsert_aif_nav(item: AifNavIn):
    data     = load()
    nav_list = data.setdefault("aif_nav", [])
    for i, entry in enumerate(nav_list):
        if entry["month"] == item.month:
            nav_list[i]["value"] = item.value
            save(data)
            return item.model_dump()
    nav_list.append(item.model_dump())
    save(data)
    return item.model_dump()


@router.delete("/api/aif_nav/{month}")
def delete_aif_nav(month: str):
    data = load()
    data["aif_nav"] = [e for e in data.get("aif_nav", []) if e["month"] != month]
    save(data)
    return {"ok": True}


# ─── AIF Investor Meets ────────────────────────────────────────────────────────

@router.get("/api/aif_investor_meets")
def get_aif_investor_meets():
    data  = load()
    meets = sorted(data.get("aif_investor_meets", []), key=lambda x: x["month"], reverse=True)
    return meets


@router.post("/api/aif_investor_meets")
def add_aif_investor_meet(item: AifInvestorMeetIn):
    data  = load()
    meets = data.setdefault("aif_investor_meets", [])
    meet  = item.model_dump()
    if not meet.get("id"):
        meet["id"] = str(uuid.uuid4())[:8]
    if not meet.get("added_date"):
        meet["added_date"] = date.today().isoformat()
    meets.append(meet)
    save(data)
    return meet


@router.put("/api/aif_investor_meets/{mid}")
def update_aif_investor_meet(mid: str, item: AifInvestorMeetIn):
    data  = load()
    meets = data.setdefault("aif_investor_meets", [])
    for i, m in enumerate(meets):
        if m["id"] == mid:
            updated = {**m, **{k: v for k, v in item.model_dump().items() if v is not None}}
            updated["id"] = mid
            meets[i] = updated
            save(data)
            return updated
    raise HTTPException(status_code=404, detail="Not found")


@router.delete("/api/aif_investor_meets/{mid}")
def delete_aif_investor_meet(mid: str):
    data = load()
    data["aif_investor_meets"] = [m for m in data.get("aif_investor_meets", []) if m["id"] != mid]
    save(data)
    return {"ok": True}


# ─── AIF Holdings Breakdown ─────────────────────────────────────────────────────
# Stored as one flat list of {id, month, name, sector, weight_pct} rows (long format,
# one row per holding per month) — matches how a monthly factsheet is actually pasted
# in: a full list of names+weights for one month at a time. The frontend pivots this
# into the wide month-columns table it renders.

@router.get("/api/aif_holdings")
def get_aif_holdings():
    return load().get("aif_holdings", [])


@router.post("/api/aif_holdings/month")
def save_aif_holdings_month(payload: AifHoldingsMonthIn):
    data     = load()
    holdings = data.setdefault("aif_holdings", [])
    # Replace-all-for-month semantics: re-saving a month overwrites its previous rows,
    # so correcting a mistake is just "paste the corrected list again".
    holdings[:] = [h for h in holdings if h.get("month") != payload.month]
    saved = []
    for entry in payload.holdings:
        row = {
            "id":         str(uuid.uuid4())[:8],
            "month":      payload.month,
            "name":       entry.name,
            "sector":     entry.sector,
            "weight_pct": entry.weight_pct,
        }
        holdings.append(row)
        saved.append(row)
    save(data)
    return {"ok": True, "month": payload.month, "count": len(saved), "holdings": saved}


@router.delete("/api/aif_holdings/month/{month}")
def delete_aif_holdings_month(month: str):
    data = load()
    data["aif_holdings"] = [h for h in data.get("aif_holdings", []) if h.get("month") != month]
    save(data)
    return {"ok": True}


@router.delete("/api/aif_holdings/entry/{entry_id}")
def delete_aif_holding_entry(entry_id: str):
    data = load()
    data["aif_holdings"] = [h for h in data.get("aif_holdings", []) if h.get("id") != entry_id]
    save(data)
    return {"ok": True}


# ─── Mutual Funds ──────────────────────────────────────────────────────────────

@router.get("/api/mutual_funds")
def get_mutual_funds():
    return load().get("mutual_funds", [])


@router.post("/api/mutual_funds")
def add_mutual_fund(item: MutualFundIn):
    data = load()
    mf   = item.model_dump()
    mf["id"]         = str(uuid.uuid4())[:8]
    mf["added_date"] = date.today().isoformat()
    data.setdefault("mutual_funds", []).append(mf)
    save(data)
    return mf


@router.put("/api/mutual_funds/{mid}")
def update_mutual_fund(mid: str, updates: dict[str, Any]):
    data = load()
    for i, mf in enumerate(data.get("mutual_funds", [])):
        if mf["id"] == mid:
            data["mutual_funds"][i].update(updates)
            save(data)
            return data["mutual_funds"][i]
    raise HTTPException(404, "Not found")


@router.delete("/api/mutual_funds/{mid}")
def delete_mutual_fund(mid: str):
    data = load()
    data["mutual_funds"] = [m for m in data.get("mutual_funds", []) if m["id"] != mid]
    save(data)
    return {"ok": True}


@router.get("/api/mf_nav")
def get_mf_nav(scheme_code: str):
    try:
        url = f"https://api.mfapi.in/mf/{scheme_code}"
        with urllib.request.urlopen(url, timeout=8) as r:
            obj = json.loads(r.read())
        meta      = obj.get("meta", {})
        data_list = obj.get("data", [])
        if not data_list:
            return {"error": "No NAV data returned"}
        latest = data_list[0]
        return {
            "scheme_code": scheme_code,
            "fund_name":   meta.get("scheme_name", ""),
            "amc":         meta.get("fund_house", ""),
            "nav":         float(latest["nav"]),
            "nav_date":    latest["date"],
        }
    except Exception as e:
        return {"error": str(e)}


@router.get("/api/mf_nav/search")
def search_mf(q: str):
    try:
        url = f"https://api.mfapi.in/mf/search?q={urllib.parse.quote(q)}"
        with urllib.request.urlopen(url, timeout=8) as r:
            results = json.loads(r.read())
        return results[:20]
    except Exception as e:
        return {"error": str(e)}


@router.post("/api/mf_nav/refresh_all")
def refresh_all_mf_nav():
    data    = load()
    funds   = data.get("mutual_funds", [])
    updated = 0
    for mf in funds:
        sc = mf.get("scheme_code")
        if not sc:
            continue
        try:
            url = f"https://api.mfapi.in/mf/{sc}"
            with urllib.request.urlopen(url, timeout=8) as r:
                obj = json.loads(r.read())
            latest = obj.get("data", [{}])[0]
            if latest.get("nav"):
                mf["nav"]      = float(latest["nav"])
                mf["nav_date"] = latest["date"]
                updated += 1
        except Exception:
            pass
    if updated:
        save(data)
    return {"updated": updated, "total": len([m for m in funds if m.get("scheme_code")])}


# ─── Fixed Income ──────────────────────────────────────────────────────────────

def _compute_fi_value(fi: dict) -> Optional[float]:
    if fi.get("current_value"):
        return fi["current_value"]
    p  = fi.get("principal")
    r  = fi.get("rate")
    sd = fi.get("start_date")
    if not (p and r and sd):
        return p
    try:
        from datetime import datetime as _dt
        today = _dt.today()
        start = _dt.strptime(sd, "%Y-%m-%d")
        mat   = fi.get("maturity_date")
        end   = min(today, _dt.strptime(mat, "%Y-%m-%d")) if mat else today
        t     = max((end - start).days / 365, 0)
        comp  = fi.get("compounding", "quarterly")
        if comp == "simple":
            return round(p * (1 + r * t / 100), 2)
        n = {"monthly": 12, "quarterly": 4, "annually": 1}.get(comp, 4)
        return round(p * (1 + r / (100 * n)) ** (n * t), 2)
    except Exception:
        return p


@router.get("/api/fixed_income")
def get_fixed_income():
    data  = load()
    items = data.get("fixed_income", [])
    for fi in items:
        fi["_computed_value"] = _compute_fi_value(fi)
    return items


@router.post("/api/fixed_income")
def add_fixed_income(item: FixedIncomeIn):
    data = load()
    fi   = item.model_dump()
    fi["id"]         = str(uuid.uuid4())[:8]
    fi["added_date"] = date.today().isoformat()
    data.setdefault("fixed_income", []).append(fi)
    save(data)
    fi["_computed_value"] = _compute_fi_value(fi)
    return fi


@router.put("/api/fixed_income/{fid}")
def update_fixed_income(fid: str, updates: dict[str, Any]):
    data = load()
    for i, fi in enumerate(data.get("fixed_income", [])):
        if fi["id"] == fid:
            data["fixed_income"][i].update(updates)
            save(data)
            r = dict(data["fixed_income"][i])
            r["_computed_value"] = _compute_fi_value(r)
            return r
    raise HTTPException(404, "Not found")


@router.delete("/api/fixed_income/{fid}")
def delete_fixed_income(fid: str):
    data = load()
    data["fixed_income"] = [f for f in data.get("fixed_income", []) if f["id"] != fid]
    save(data)
    return {"ok": True}


# ─── Unlisted ──────────────────────────────────────────────────────────────────

@router.get("/api/unlisted")
def get_unlisted():
    return load().get("unlisted", [])


@router.post("/api/unlisted")
def add_unlisted(item: UnlistedIn):
    data = load()
    ul   = item.model_dump()
    ul["id"]         = str(uuid.uuid4())[:8]
    ul["added_date"] = date.today().isoformat()
    data.setdefault("unlisted", []).append(ul)
    save(data)
    return ul


@router.put("/api/unlisted/{uid}")
def update_unlisted(uid: str, updates: dict[str, Any]):
    data = load()
    for i, ul in enumerate(data.get("unlisted", [])):
        if ul["id"] == uid:
            data["unlisted"][i].update(updates)
            save(data)
            return data["unlisted"][i]
    raise HTTPException(404, "Not found")


@router.delete("/api/unlisted/{uid}")
def delete_unlisted(uid: str):
    data = load()
    data["unlisted"] = [u for u in data.get("unlisted", []) if u["id"] != uid]
    save(data)
    return {"ok": True}


# ─── NPS ───────────────────────────────────────────────────────────────────────

@router.get("/api/nps")
def get_nps():
    return load().get("nps", [])


@router.post("/api/nps")
def add_nps(item: NpsIn):
    data = load()
    n    = item.model_dump()
    n["id"] = str(uuid.uuid4())[:8]
    data.setdefault("nps", []).append(n)
    save(data)
    return n


@router.put("/api/nps/{nid}")
def update_nps(nid: str, updates: dict[str, Any]):
    data = load()
    for i, n in enumerate(data.get("nps", [])):
        if n["id"] == nid:
            data["nps"][i].update(updates)
            save(data)
            return data["nps"][i]
    raise HTTPException(404, "Not found")


@router.delete("/api/nps/{nid}")
def delete_nps(nid: str):
    data = load()
    data["nps"] = [n for n in data.get("nps", []) if n["id"] != nid]
    save(data)
    return {"ok": True}
