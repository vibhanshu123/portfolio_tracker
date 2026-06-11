# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run locally (port 8001, hot-reload)
./run.sh

# Or directly
python3 -m uvicorn app:app --host 0.0.0.0 --port 8001 --reload

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

**Single-file backend** (`app.py`) + **single-file SPA frontend** (`templates/index.html`).

### Data layer
- `data.json` — positions, watchlist, settings, aif_nav, huf_transfers, cash_balances. Read/written on every request (no DB). `load()` / `save()` are the only persistence calls.
- `technicals.json` — cached weekly EMA/RSI/ADX signals keyed by original ticker string (`NSE:SYMBOL`).
- On Fly.io `DATA_DIR=/data` (persistent volume). Locally defaults to the app directory. The bundled `data.json` is seeded to `/data` on first cloud boot if absent.

### Ticker conventions
- Stored as `NSE:SYMBOL` or `BSE:SYMBOL` or bare USD ticker
- `_to_yahoo()` converts to Yahoo Finance format: `NSE:X` → `X.NS`, `BSE:X` → `X.BO`
- Each position/watchlist item also stores a `yahoo_ticker` field (pre-converted) to avoid re-conversion
- `_get_symbol()` strips the exchange prefix to get bare `SYMBOL`

### Accounts
Seven accounts tracked: `vibhanshu`, `manjari`, `huf`, `manjbhawna`, `us_vibhanshu`, `us_manjari`, `us_huf`. Defined in `ACCOUNTS` list in `app.py`.

### Live price feed — WebSocket
`/ws/prices` streams updates every 30 seconds:
- Every tick: batch CMP via `yf.download()` (5m intraday → 1d fallback)
- Every 10th tick (~5 min): trailing PE + daily % change via `yf.Tickers.fast_info`
- Sends `{type, prices, usd_inr, pe, timestamp, count}`

### Technical indicators
`/api/technicals/refresh` spawns a background daemon thread (`_do_refresh_technicals`). Progress polled via `/api/technicals/progress`. Computes per-ticker on 2Y weekly data:
- EMA 10/21/30/40, RSI-14, ADX-14
- Stage classification: 2 (CMP > EMA30 + rising), 3 (CMP > EMA30, not rising), 4 (CMP < EMA30, declining), 1 (otherwise)
- `sell_signals` dict (below_Xw_ema, rsi_weak, stage3_warning, crs_broken)
- `entry_signals` dict + `entry_score` (0–6)
- `crs_above_ma`: price relative to Nifty 50 (`^NSEI`) vs its 52-week rolling mean

### SOIC research pipeline (Watchlist tab)
Each watchlist item has a 3-step research pipeline managed by `_analysis_jobs` (in-memory dict, lost on restart):

| Step | Button | Terminal command sent | Output file watched |
|------|--------|----------------------|---------------------|
| Extract | Extract | `!ra-dash SYMBOL` | `{SOIC_DIR}/data/companies/{SYMBOL}/extracted/{SYMBOL}_AR_Extracts.txt` |
| Deep Dive | Deep Dive | `!ra-dd SYMBOL` | `{SOIC_DIR}/data/companies/{SYMBOL}/{SYMBOL}_Dashboard.html` |
| Dashboard | View | served at `/dashboard/{wid}` | same HTML file |

`_open_terminal()` opens macOS Terminal via AppleScript, launches `claude` in `SOIC_DIR`, waits 15s for it to load, then sends the command. `_watch_file()` polls for the output file every 10s (60 min timeout). `_detect_disk_state()` rebuilds job state from disk on page reload.

`SOIC_DIR = /Users/arya/workspace/agents/soic-er-shashank-dashboard-generator`  
`CLAUDE_CLI = /Users/arya/.npm-global/bin/claude`

**Note:** `!extract all SYMBOL` (from the parent CLAUDE.md) triggers the growth-trigger-analysis skill, which writes to `data/companies/{SYMBOL}/growth_trigger_analysis.md` — separate from the Extract pipeline button above.

### Position enrichment
`enrich()` computes `invested`, `current_value`, `pnl`, `pnl_pct`, `cagr`, `invested_inr`, `current_value_inr` from raw position data. USD positions are converted using `usd_inr_rate` from settings. `peak_price` is a high-water mark updated on every price fetch.

## Deployment (Fly.io)
- App: `portfolio-tracker-vj`, region: `bom` (Mumbai)
- Internal port 8080 (Dockerfile must expose 8080, not 8001)
- Persistent volume `portfolio_data` mounted at `/data`
- `DATA_DIR=/data` env var switches data files to the volume
