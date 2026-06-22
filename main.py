from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from core.config import BASE
from core.persistence import load
from core.enrichment import enrich
from routers.assets import _compute_fi_value
from routers.groups import _DEFAULT_PORTFOLIO_GROUPS, _DEFAULT_WATCHLIST_GROUPS
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
)

app = FastAPI(title="Portfolio Tracker")

app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

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
    for fi in data.get("fixed_income", []):
        fi["_computed_value"] = _compute_fi_value(fi)
    return data


# Kick off deferred scans refresh on startup
scans.start_deferred_scans()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
