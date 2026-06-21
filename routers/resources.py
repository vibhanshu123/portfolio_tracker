import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from core.config import MARKET_DASHBOARDS_DIR
from core.models import MarketDashboardIn
from core.persistence import load, save

router = APIRouter()

_SOIC_FILES = {
    "SOIC_FY26_Analysis.html",
    "SOIC_FY26_Analysis_Part2.html",
    "SOIC_FY26_Analysis_Part3.html",
    "SOIC_FY26_Research.html",
}
_SOIC_DIR = Path("/Users/arya/workspace/agents")


@router.get("/api/market_dashboards")
def get_market_dashboards():
    return load().get("market_dashboards", [])


@router.post("/api/market_dashboards")
def add_market_dashboard(item: MarketDashboardIn):
    data  = load()
    entry = item.model_dump()
    entry["id"] = str(uuid.uuid4())
    data["market_dashboards"].append(entry)
    save(data)
    return entry


@router.put("/api/market_dashboards/{mid}")
def update_market_dashboard(mid: str, updates: dict[str, Any]):
    data = load()
    for i, m in enumerate(data["market_dashboards"]):
        if m["id"] == mid:
            data["market_dashboards"][i].update(updates)
            save(data)
            return data["market_dashboards"][i]
    raise HTTPException(404, "Not found")


@router.delete("/api/market_dashboards/{mid}")
def delete_market_dashboard(mid: str):
    data = load()
    data["market_dashboards"] = [m for m in data["market_dashboards"] if m["id"] != mid]
    save(data)
    return {"ok": True}


@router.get("/market_dashboard/{mid}", response_class=HTMLResponse)
def serve_market_dashboard(mid: str):
    data  = load()
    entry = next((m for m in data["market_dashboards"] if m["id"] == mid), None)

    def _err(msg: str) -> HTMLResponse:
        return HTMLResponse(f"""<!doctype html><html><head><meta charset=utf-8>
<title>Not Found</title>
<style>body{{font-family:system-ui,sans-serif;background:#111;color:#ccc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}
.box{{text-align:center;padding:40px}}.title{{font-size:22px;font-weight:700;color:#f5f5f5;margin-bottom:12px}}
.msg{{font-size:14px;color:#888;line-height:1.6}}</style></head>
<body><div class="box"><div class="title">File not available</div>
<div class="msg">{msg}</div></div></body></html>""", status_code=404)

    if not entry:
        return _err("Dashboard entry not found.")
    filename = entry.get("filename", "")
    if filename:
        fp = MARKET_DASHBOARDS_DIR / filename
        if fp.exists():
            return fp.read_text()
        return _err(f"HTML file <b>{filename}</b> not found in the <code>market_dashboards/</code> folder.<br><br>Drop the file there and reload.")
    return _err("No local file set for this dashboard. Edit the entry and add a filename or URL.")


@router.get("/soic/{filename}", response_class=HTMLResponse)
def serve_soic_research(filename: str):
    if filename not in _SOIC_FILES:
        raise HTTPException(status_code=404, detail="Not found")
    fp = _SOIC_DIR / filename
    if not fp.exists():
        raise HTTPException(status_code=404, detail=f"{filename} not found on disk")
    return HTMLResponse(fp.read_text())
