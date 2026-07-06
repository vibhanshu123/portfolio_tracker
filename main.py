import uuid
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from core.config import BASE, UPLOADS_DIR
from core.persistence import load
from core.enrichment import enrich
from routers.assets import _compute_fi_value
from routers.groups import _DEFAULT_PORTFOLIO_GROUPS, _DEFAULT_WATCHLIST_GROUPS
from routers.resources import _DEFAULT_RESOURCE_CATEGORIES, _get_resource_cats
from routers import (
    positions,
    watchlist,
    prices,
    technicals,
    scans,
    assets,
    transfers,
    resources,
    scorer,
    payments,
    groups,
    top_ideas,
    alpha,
    tax,
    diary,
)

app = FastAPI(title="Portfolio Tracker")

app.mount("/static",  StaticFiles(directory=BASE / "static"), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR),    name="uploads")

app.include_router(positions.router)
app.include_router(watchlist.router)
app.include_router(prices.router)
app.include_router(technicals.router)
app.include_router(scans.router)
app.include_router(assets.router)
app.include_router(transfers.router)
app.include_router(resources.router)
app.include_router(scorer.router)
app.include_router(payments.router)
app.include_router(groups.router)
app.include_router(top_ideas.router)
app.include_router(alpha.router)
app.include_router(tax.router)
app.include_router(diary.router)


@app.get("/", response_class=HTMLResponse)
def index():
    js   = BASE / "static" / "js" / "app.js"
    v    = int(js.stat().st_mtime) if js.exists() else 0
    html = (BASE / "templates" / "index.html").read_text()
    html = html.replace('/static/js/app.js"',     f'/static/js/app.js?v={v}"')
    html = html.replace('/static/js/scorer.js"',  f'/static/js/scorer.js?v={v}"')
    return html


@app.get("/api/data")
def get_data():
    data = load()
    rate = data["settings"].get("usd_inr_rate", 84.0)
    data["positions"] = [enrich(p, rate) for p in data["positions"]]
    # Build dynamic accounts list from portfolio groups
    pg = data["settings"].get("portfolio_groups", _DEFAULT_PORTFOLIO_GROUPS)
    data["accounts"] = [p["id"] for grp in pg.values() for p in grp]
    data["settings"].setdefault("portfolio_groups", _DEFAULT_PORTFOLIO_GROUPS)
    data["settings"].setdefault("watchlist_groups", list(_DEFAULT_WATCHLIST_GROUPS))
    _get_resource_cats(data)   # seeds resource_categories into settings if missing
    for fi in data.get("fixed_income", []):
        fi["_computed_value"] = _compute_fi_value(fi)
    return data


_ALLOWED_IMG_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"}
_ALLOWED_IMG_EXT   = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}

_ALLOWED_DOC_EXT   = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".md"}

async def _save_upload(file: UploadFile, allowed_ext: set, max_mb: int = 50) -> dict:
    ext = "." + (file.filename or "file").rsplit(".", 1)[-1].lower()
    if ext not in allowed_ext:
        raise HTTPException(415, f"Unsupported file type '{ext}'")
    content = await file.read()
    if len(content) > max_mb * 1024 * 1024:
        raise HTTPException(413, f"File too large (max {max_mb} MB)")
    orig_stem = (file.filename or "file").rsplit(".", 1)[0][:40]
    filename = f"{uuid.uuid4().hex[:8]}_{orig_stem}{ext}"
    (UPLOADS_DIR / filename).write_bytes(content)
    return {"url": f"/uploads/{filename}", "filename": filename, "original_name": file.filename or filename}

@app.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...)):
    return await _save_upload(file, _ALLOWED_IMG_EXT, max_mb=20)

@app.post("/api/upload-doc")
async def upload_doc(file: UploadFile = File(...)):
    return await _save_upload(file, _ALLOWED_DOC_EXT, max_mb=50)


# Kick off deferred scans refresh on startup
scans.start_deferred_scans()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
