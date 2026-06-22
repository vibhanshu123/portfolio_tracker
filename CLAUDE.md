# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run locally (port 8001, hot-reload)
./run.sh

# Or directly
python3 -m uvicorn main:app --host 0.0.0.0 --port 8001 --reload

# Install dependencies
pip install -r requirements.txt

# One-time import from Excel
python3 init_data.py

# Deploy
fly deploy
fly logs
```

Stop server: `lsof -ti:8001 | xargs kill -9`

## Architecture

**FastAPI backend** (`main.py` + `core/` + `routers/`) + **single-file SPA frontend** (`templates/index.html` + `static/js/app.js`).

### Module layout

| Path | Purpose |
|------|---------|
| `main.py` | FastAPI app, router registration, `/api/data` aggregator |
| `core/config.py` | All path constants (`DATA_FILE`, `TECH_FILE`, `SCANS_CACHE_FILE`, `SOIC_DIR`, `DASHBOARDS_DIR`), `ACCOUNTS` list, `DEFAULT_SETTINGS` |
| `core/persistence.py` | `load()` / `save()` (atomic write via temp-file + `os.replace` + lock), `load_technicals()` / `save_technicals()` |
| `core/models.py` | All Pydantic request models (`PositionIn`, `WatchlistIn`, `FixedIncomeIn`, etc.) |
| `core/enrichment.py` | `enrich()`, `_to_yahoo()`, `_get_symbol()`, indicator math (`_ema`, `_rsi`, `_adx`) |
| `routers/` | One file per feature domain (see below) |

### Routers

| Router | Key responsibility |
|--------|--------------------|
| `positions.py` | CRUD for `data["positions"]`; sell/buy-more flow writes to `sold_positions` |
| `watchlist.py` | CRUD for `data["watchlist"]` + SOIC research pipeline (Extract → Deep Dive → View) |
| `prices.py` | `/ws/prices` WebSocket broadcast loop; `/api/prices` bulk refresh; `/api/quote` single-ticker |
| `technicals.py` | Background thread for EMA/RSI/ADX refresh; progress polling |
| `scans.py` | stockscans.in scan-badge cache in `stockscans_cache.json`; deferred refresh on startup |
| `assets.py` | Mutual funds, fixed income, unlisted, NPS CRUD; `/api/assets/summary` |
| `transfers.py` | HUF transfers, capital-transferred, AIF NAV/investor-meets |
| `groups.py` | Portfolio group + watchlist group management; generic watchlist CRUD at `/api/wl/{list_id}` |
| `top_ideas.py` | stockscans.in Top Ideas proxy (login, refresh, cache) |
| `resources.py` | Market dashboards CRUD + serving static HTML |
| `scorer.py` | Position scoring / ranking logic |
| `payments.py` | Razorpay payment tracking |

### Data layer

- `data.json` — single source of truth. Top-level keys: `positions`, `watchlist`, `us_watchlist`, `soic_research`, `sold_positions`, `aif_nav`, `huf_transfers`, `cash_balances`, `mutual_funds`, `fixed_income`, `unlisted`, `nps`, `capital_transferred`, `aif_investor_meets`, `market_dashboards`, `settings`, plus any `wl_*` keys for custom watchlist groups.
- `data["settings"]` stores: `usd_inr_rate`, `portfolio_risk_pct`, `portfolio_groups`, `watchlist_groups`, `stockscans_cookie`, `stockscans_cache`, and more.
- `technicals.json` — weekly EMA/RSI/ADX signals keyed by original ticker string (`NSE:SYMBOL`).
- `stockscans_cache.json` — per-ticker scan badges from stockscans.in, refreshed every 24h.
- `save()` is atomic: writes to a temp file in the same directory, then `os.replace()` under a threading lock. Never write `data.json` directly.
- On Fly.io `DATA_DIR=/data` (persistent volume). Locally defaults to app directory.

### Ticker conventions

- Stored as `NSE:SYMBOL`, `BSE:SYMBOL`, or bare USD ticker.
- `_to_yahoo()` in `core/enrichment.py`: `NSE:X` → `X.NS`, `BSE:X` → `X.BO`, USD tickers pass through.
- Each position/watchlist item also stores a `yahoo_ticker` field (pre-converted).
- `_get_symbol()` strips the exchange prefix to return bare `SYMBOL`.

### Accounts & groups

Accounts are no longer a fixed list in code. They are derived at runtime from `data["settings"]["portfolio_groups"]`, which defaults to two groups (`indian`, `us`) defined in `routers/groups.py::_DEFAULT_PORTFOLIO_GROUPS`. The canonical seven are: `vibhanshu`, `manjari`, `huf`, `manjbhawna`, `us_vibhanshu`, `us_manjari`, `us_huf`.

Custom watchlist groups are stored in `data["settings"]["watchlist_groups"]` and their items live at a matching top-level key in `data.json` (e.g. group id `wl_mylist` → `data["wl_mylist"]`). Built-in lists (`watchlist`, `us_watchlist`) cannot be deleted.

### Live price feed — WebSocket

`/ws/prices` broadcasts every 30 seconds:
- Every tick: batch CMP via `yf.download()` (5m intraday → 1d fallback), keyed by `orig` ticker string.
- Every 10th tick (~5 min): trailing PE + daily % change via `yf.Tickers.fast_info`.
- Sends `{type, prices, usd_inr, pe, timestamp, count}`.
- Single broadcast loop shared across all connected clients; replays last message to new joiners.

### Technical indicators (`routers/technicals.py`)

`/api/technicals/refresh` spawns a background daemon thread. Progress polled via `/api/technicals/progress`. Computes on 2Y weekly data per ticker:
- EMA 10/21/30/40, RSI-14, ADX-14 (math in `core/enrichment.py`)
- Stage 2/3/4/1 classification based on CMP vs EMA30 and trend direction
- `sell_signals` (below_Xw_ema, rsi_weak, stage3_warning, crs_broken)
- `entry_signals` + `entry_score` (0–6)
- `crs_above_ma`: CMP/Nifty50 ratio vs its 52-week rolling mean

### SOIC research pipeline (`routers/watchlist.py`)

Per-watchlist-item 3-step pipeline tracked in `_analysis_jobs` (in-memory, lost on restart; `_detect_disk_state()` rebuilds from disk):

| Step | Endpoint | Terminal command | Output file |
|------|----------|-----------------|-------------|
| Extract | `POST /api/watchlist/{wid}/extract` | `!ra-dash SYMBOL` | `{SOIC_DIR}/data/companies/{SYMBOL}/extracted/{SYMBOL}_AR_Extracts.txt` |
| Deep Dive | `POST /api/watchlist/{wid}/deepdive` | `!ra-dd SYMBOL` | `{SOIC_DIR}/data/companies/{SYMBOL}/{SYMBOL}_Dashboard.html` |
| View | `GET /dashboard/{wid}` | — | same HTML (also checked in `dashboards/`) |

`_open_terminal()` opens macOS Terminal via AppleScript, launches `claude` in `SOIC_DIR`, waits 15s, then sends the command. `_watch_file()` polls every 10s (60 min timeout).

`SOIC_DIR = /Users/arya/workspace/agents/soic-er-shashank-dashboard-generator`

### stockscans.in Top Ideas (`routers/top_ideas.py`)

Proxy endpoints for stockscans.in. Session cookie stored in `data["settings"]["stockscans_cookie"]`. Company cache in `data["settings"]["stockscans_cache"]`. Flow: `POST /api/top-ideas/login` → `POST /api/top-ideas/refresh` → `GET /api/top-ideas/data` (cached, no external call).

### Position enrichment (`core/enrichment.py`)

`enrich(pos, usd_inr)` computes `invested`, `current_value`, `pnl`, `pnl_pct`, `pnl_inr`, `cagr`, `invested_inr`, `current_value_inr`. Updates `peak_price` (high-water mark: max of stored peak, avg_buy_price, cmp). USD positions multiplied by `usd_inr_rate`.

## Deployment (Fly.io)

- App: `portfolio-tracker-vj`, region: `bom` (Mumbai)
- Internal port 8080 (Dockerfile exposes 8080, not 8001)
- Persistent volume `portfolio_data` mounted at `/data`
- `DATA_DIR=/data` env var switches all data files to the volume
