import uuid
from datetime import date
from fastapi import APIRouter, HTTPException, Request

from core.persistence import load, save

router = APIRouter()

OPEN_GOAL_LIMIT = 20


def _period(data: dict, period: str) -> dict:
    return data.setdefault("diary", {}).setdefault(period, {
        "notes": "", "goals": [], "resources": []
    })


def _count_open_goals(data: dict) -> int:
    return sum(
        1 for p in data.get("diary", {}).values()
        for g in p.get("goals", [])
        if not g.get("completed", False)
    )


@router.get("/api/diary")
def get_diary():
    return load().get("diary", {})


@router.put("/api/diary/{period}/notes")
async def update_notes(period: str, request: Request):
    body = await request.json()
    data = load()
    _period(data, period)["notes"] = body.get("notes", "")
    save(data)
    return {"ok": True}


@router.post("/api/diary/{period}/goals")
async def add_goal(period: str, request: Request):
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text required")
    data = load()
    open_count = _count_open_goals(data)
    if open_count >= OPEN_GOAL_LIMIT:
        raise HTTPException(400, f"limit_reached: {open_count} open goals — close some before adding more")
    goal = {
        "id":           uuid.uuid4().hex[:8],
        "text":         text,
        "completed":    False,
        "created_date": date.today().isoformat(),
        "closed_date":  None,
    }
    _period(data, period).setdefault("goals", []).append(goal)
    save(data)
    return goal


@router.put("/api/diary/{period}/goals/{gid}")
async def update_goal(period: str, gid: str, request: Request):
    body = await request.json()
    data = load()
    p = _period(data, period)
    for g in p.get("goals", []):
        if g["id"] == gid:
            if "completed" in body:
                was_done = g.get("completed", False)
                g["completed"] = bool(body["completed"])
                if g["completed"] and not was_done:
                    g["closed_date"] = date.today().isoformat()
                elif not g["completed"] and was_done:
                    g["closed_date"] = None
            if "text" in body:
                g["text"] = body["text"]
            save(data)
            return g
    raise HTTPException(404, "Goal not found")


@router.delete("/api/diary/{period}/goals/{gid}")
def delete_goal(period: str, gid: str):
    data = load()
    p = _period(data, period)
    p["goals"] = [g for g in p.get("goals", []) if g["id"] != gid]
    save(data)
    return {"ok": True}


@router.post("/api/diary/{period}/resources")
async def add_resource(period: str, request: Request):
    body = await request.json()
    data = load()
    res = {
        "id":        uuid.uuid4().hex[:8],
        "heading":   (body.get("heading")   or "").strip(),
        "url":       (body.get("url")       or "").strip(),
        "learnings": (body.get("learnings") or "").strip(),
    }
    _period(data, period).setdefault("resources", []).append(res)
    save(data)
    return res


@router.put("/api/diary/{period}/resources/{rid}")
async def update_resource(period: str, rid: str, request: Request):
    body = await request.json()
    data = load()
    p = _period(data, period)
    for r in p.get("resources", []):
        if r["id"] == rid:
            for k in ("heading", "url", "learnings"):
                if k in body:
                    r[k] = body[k]
            save(data)
            return r
    raise HTTPException(404, "Resource not found")


@router.delete("/api/diary/{period}/resources/{rid}")
def delete_resource(period: str, rid: str):
    data = load()
    p = _period(data, period)
    p["resources"] = [r for r in p.get("resources", []) if r["id"] != rid]
    save(data)
    return {"ok": True}
