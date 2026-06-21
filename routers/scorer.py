import json
import os
import time
import threading
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request

from core.persistence import load, save

router = APIRouter()

_scorer_jobs: dict = {}


def _scorer_call_claude(client, prompt, *, max_tokens=1500, system=None, use_web_search=False):
    def _do_call(messages):
        for attempt in range(6):
            try:
                if use_web_search:
                    return client.beta.messages.create(
                        model="claude-sonnet-4-6",
                        max_tokens=max_tokens,
                        tools=[{"type": "web_search_20250305", "name": "web_search"}],
                        betas=["web-search-2025-03-05"],
                        messages=messages,
                    )
                else:
                    kwargs = {"model": "claude-sonnet-4-6", "max_tokens": max_tokens, "messages": messages}
                    if system:
                        kwargs["system"] = system
                    return client.messages.create(**kwargs)
            except Exception as e:
                if "rate_limit" in str(e).lower() and attempt < 5:
                    wait = 20 * (attempt + 1)  # 20s, 40s, 60s, 80s, 100s
                    time.sleep(wait)
                else:
                    raise
        raise RuntimeError("Rate limit retries exhausted")

    if use_web_search:
        messages = [{"role": "user", "content": prompt}]
        texts = []
        for _ in range(8):
            resp = _do_call(messages)
            texts = [b.text for b in resp.content if getattr(b, 'type', '') == 'text']
            if resp.stop_reason == "end_turn":
                return "\n".join(texts)
            if resp.stop_reason == "tool_use":
                asst = []
                for b in resp.content:
                    bt = getattr(b, 'type', '')
                    if bt == 'text':
                        asst.append({"type": "text", "text": b.text})
                    elif bt in ('tool_use', 'web_search_tool_use'):
                        asst.append({"type": bt, "id": b.id, "name": getattr(b, 'name', 'web_search'), "input": dict(getattr(b, 'input', {}))})
                messages.append({"role": "assistant", "content": asst})
                tool_results = [{"type": "tool_result", "tool_use_id": b.id, "content": ""} for b in resp.content if getattr(b, 'type', '') in ('tool_use', 'web_search_tool_use')]
                if tool_results:
                    messages.append({"role": "user", "content": tool_results})
            else:
                return "\n".join(texts)
        return "\n".join(texts) if texts else "Data unavailable"
    else:
        resp = _do_call([{"role": "user", "content": prompt}])
        return "\n".join(b.text for b in resp.content if getattr(b, 'type', '') == 'text')


def _scorer_call_json(client, prompt, *, max_tokens=1500):
    import re as _re
    sys = "You are an expert financial analyst. Return only valid JSON. Never invent financial data. If data is missing, state that explicitly."
    text = _scorer_call_claude(client, prompt, max_tokens=max_tokens, system=sys)
    m = _re.search(r'```json\s*(.*?)\s*```', text, _re.DOTALL)
    if m:
        text = m.group(1)
    else:
        m = _re.search(r'(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*)' , text, _re.DOTALL)
        if m:
            text = m.group(1)
    try:
        return json.loads(text.strip())
    except Exception:
        return {"error": "parse_failed", "raw": text[:300]}


def _build_forensics_prompt(ticker, screener_data):
    return f"""You are a forensic accounting expert for Indian listed companies.
Real financial data for {ticker} from Screener.in:
{screener_data}

Conduct a forensic check:
1. BRIEF SUMMARY: Key findings, Green/Yellow/Red checklist.
2. REVENUE RECOGNITION: Aggressive practices, channel stuffing.
3. CASH FLOW DISCREPANCIES: Compare CFO with PAT and EBITDA.
4. RELATED PARTY TRANSACTIONS: All major RPTs. Highlight suspicious.
5. BALANCE SHEET: Write-offs, inventory, receivables aging.
6. CONTINGENT LIABILITIES: Compare with net worth. Flag if >10%.
7. MISCELLANEOUS EXPENSES: Flag if >3% of sales.
8. MANAGEMENT DISCUSSION: Inconsistencies in guidance.
9. AUDITOR REPORT: CARO, Key Audit Matters, qualified opinion?

CRITICAL: Only use numbers from data provided. Do NOT hallucinate. Label confidence: High/Medium/Low.
Return JSON: {{"summary":"...","checklist":[{{"item":"...","status":"Green|Yellow|Red","detail":"...","data_confidence":"High|Medium|Low"}}],"cash_flow_table":[{{"year":"FY","cfo":"₹Cr","pat":"₹Cr","ratio":"x","verdict":"🟢|🟡|🔴"}}],"dso_table":[{{"year":"FY","revenue_growth":"%","receivables_growth":"%","dso":"days","risk":"signal"}}],"rpt_risk":"LOW|MEDIUM|HIGH|UNKNOWN","rpt_detail":"...","red_flags":["..."],"green_flags":["..."],"score":0,"accounting_quality":"Good|Average|Bad|Insufficient Data"}}"""


def _build_valuation_prompt(ticker, screener_data, news_data):
    return f"""You are an expert equity analyst for Indian listed companies.
Financial data for {ticker} from Screener.in:
{screener_data}
Recent news/analyst data:
{news_data or "Not available."}

Analyze:
1. PIOTROSKI F-SCORE (0-9): Calculate all 9 components using ACTUAL numbers. Table: Component|Metric|Current Value|Prior Value|Score
2. DUPONT ROE: Break into Net Profit Margin × Asset Turnover × Equity Multiplier for last 3 years.
3. CURRENT VALUATION: PE/PB/EV-EBITDA vs 5Y average and sector median. FCF yield.
4. BEAR CASE: 5 strongest reasons this stock could underperform. Reference actual data.

CRITICAL: Only use numbers from data provided. Do NOT invent ratios or targets.
Return JSON: {{"piotroski_score":0,"piotroski_table":[{{"component":"...","value":"...","prior":"...","score":0}}],"piotroski_verdict":"Strong|Average|Weak|Insufficient Data","dupont_table":[{{"year":"FY","roe":"%","npm":"%","asset_turnover":"x","equity_multiplier":"x"}}],"roe_driver":"...","valuation_comment":"...","fcf_yield":"%","bear_case":["..."],"score":0,"verdict":"..."}}"""


def _build_management_prompt(ticker, screener_data, news_data):
    return f"""You are an expert in corporate governance for Indian listed companies.
Data for {ticker}:
{screener_data}
News/promoter activity:
{news_data or "Not available."}

Analyze:
1. REMUNERATION: MD/CEO salary as % of PAT — trend over 5 years.
2. CAPITAL ALLOCATION: FCF investment, capex vs revenue growth.
3. PROMOTER ACTIVITY: Shareholding trend 5Y, pledge %, block deals.
4. GOVERNANCE: Independent directors — tenure, cross-directorships.
5. CFO CHANGES: Number of CFOs in last 5 years. (2+ = yellow; 3+ = red)
6. CORPORATE STRUCTURE: Subsidiary complexity, inter-company loans.
Also: SEBI enforcement actions, promoter pledge trend, dividend vs FCF consistency.

CRITICAL: Only cite data from provided sources. State "Not verifiable" if unavailable.
Return JSON: {{"promoter_holding_trend":"increasing|decreasing|stable|unknown","promoter_pledge_pct":"%","pledge_trend":"increasing|decreasing|stable|unknown","cfo_changes":"N","remuneration_concern":"Yes|No|Unknown","governance_rating":"Shareholder-Friendly|Neutral|Shareholder-Unfriendly|Insufficient Data","sebi_actions":"none known|...","red_flags":["..."],"green_flags":["..."],"score":0,"verdict":"..."}}"""


def _build_concall_prompt(ticker, news_data, screener_data):
    return f"""You are an equity research analyst covering Indian listed companies.
Company: {ticker}
Available public data/news:
{news_data or "Not available."}
Screener financial data:
{screener_data}

Analyze using SOIC Concall framework:
1. KEY NUMBERS: Revenue, EBITDA, PAT trends vs prior periods (from Screener data)
2. GUIDANCE vs DELIVERY: Does management typically beat/miss/meet guidance?
3. MANAGEMENT TONE: Bullish/Cautious/Defensive
4. GROWTH TRIGGERS: Top 2-3 triggers with conviction (High/Medium/Low) — ONLY verifiable business facts
5. ANALYST CONCERNS: Most commonly cited risks

CRITICAL: Do NOT fabricate concall quotes, guidance numbers, or analyst targets.
Return JSON: {{"revenue_trend":"...","margin_trend":"expanding|stable|compressing|unknown","guidance_track_record":"Consistent beater|In-line|Serial miss|Insufficient data","mgmt_tone":"Bullish|Cautious|Defensive|Unknown","growth_triggers":[{{"trigger":"...","conviction":"High|Medium|Low","source":"Financial data|News|Sector"}}],"key_risks":["..."],"score":0,"verdict":"..."}}"""


def _build_sector_prompt(ticker, sector, news_data):
    return f"""You are a strategy consultant specialising in Indian equity sector analysis.
Company: {ticker}, Sector: {sector}
Recent sector news:
{news_data or "Not available."}

Build Porter's Five Forces for this company's sector in Indian context. For each force: rating 1-5, specific Indian evidence, how changed in last 2-3 years.
Also: sector cycle stage, government/policy tailwinds, key demand drivers 2025-2026, who is gaining/losing market share, margin trend.

CRITICAL: Use only publicly known, verifiable facts. Flag as "Well established"/"Inferred"/"Uncertain".
Return JSON: {{"sector_name":"...","competitive_intensity":1,"buyer_power":1,"supplier_power":1,"substitution_threat":1,"new_entrant_threat":1,"sector_cycle":"Early upcycle|Mid-cycle|Late cycle|Downcycle","policy_tailwind":"Strong|Moderate|Neutral|Headwind","key_tailwinds":["..."],"key_risks":["..."],"score":0,"verdict":"..."}}"""


def _build_technical_prompt(ticker, screener_data, news_data):
    return f"""You are a technical analyst specialising in Indian equity using Weinstein Stage Analysis.
Company: {ticker}
Financial/price data from Screener:
{screener_data}
Recent price/news data:
{news_data or "Not available."}

Assess Weinstein stage: Stage 1 (Basing/accumulation), Stage 2 (Advancing/uptrend above 200DMA — ideal buy), Stage 3 (Topping/distribution), Stage 4 (Declining/downtrend).
Also: Higher highs/lows, 52W high vs current, relative strength vs Nifty 50.

CRITICAL: Only use price data visible in Screener (52W high/low, current price). Do NOT invent moving averages or volume data. If real price data unavailable, state Stage as "Unknown".
Return JSON: {{"stage":1,"stage_label":"Basing|Advancing|Topping|Declining|Unknown","above_200dma":"Yes|No|Unknown","52w_position":"Near high|Mid-range|Near low|Unknown","relative_strength_vs_nifty":"Outperforming|Underperforming|In-line|Unknown","higher_highs":"Yes|No|Unknown","score":0,"verdict":"..."}}"""


def _build_aggregator_prompt(ticker, dimensions):
    return f"""You are a world-class Indian portfolio consultant.
6-dimension analysis of {ticker} using real data:
{json.dumps(dimensions, indent=2)}

Final score card:
1. AUTO-PENALTIES (subtract from total): Accounting quality "Bad"→-15, Promoter pledge >50%→-10, CFO/PAT ratio <0.5 in 2+ years→-10, CFO changes 3+→-8, Receivables growing 2x faster than revenue→-8, Stage 3 or 4→-5, SEBI enforcement action→-10, Piotroski ≤3→-5
2. TOP 5 RED FLAGS (only High/Medium confidence data)
3. TOP 3 GREEN FLAGS
4. 3-sentence overall verdict: Hold/Buy/Avoid/Watch with specific data citations.

GRADE THRESHOLDS (after penalties, cap 0 min): 90-100=A+ | 80-89=A | 70-79=B+ | 60-69=B | 50-59=C | 40-49=D | <40=F

Return JSON: {{"total_score_raw":0,"penalties_applied":[{{"reason":"...","points":-5}}],"total_score_final":0,"grade":"A+|A|B+|B|C|D|F","red_flags":["..."],"green_flags":["..."],"overall_verdict":"...","action":"Strong Buy|Buy|Hold|Watch|Avoid|Strong Avoid"}}"""


def _do_score_analysis(job_id: str, tickers: list):
    try:
        import anthropic as _ac
        import re as _re
        client = _ac.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
        job     = _scorer_jobs[job_id]
        results = []

        for i, ticker in enumerate(tickers):
            job.update({"current_idx": i, "current_ticker": ticker})
            try:
                screener_data = _scorer_call_claude(client, f"""Fetch financial data for {ticker} from Screener.in.
Try: https://www.screener.in/company/{ticker}/consolidated/ or https://www.screener.in/company/{ticker}/
Extract: company name, sector, market cap, current price, 52W high/low, P/E, P/B, EV/EBITDA,
5Y revenue/net profit/EBITDA margin/ROE/ROCE/DE ratio, 3Y CFO/FCF, 3Y trade receivables,
promoter holding % (current + 3Y ago), pledge %, dividend payout %, subsidiary count.
Only factual data found. Write "Not available" for missing fields. Do NOT estimate.""",
                    max_tokens=1200, use_web_search=True)

                news_data = _scorer_call_claude(client, f"""Search recent news about {ticker} Indian stock. Find:
1. SEBI enforcement actions or court cases (last 3Y)
2. Promoter shareholding/pledge changes (last 1Y)
3. Management changes (CEO, CFO, board)
4. Latest earnings/guidance (recent quarter)
5. Auditor resignations or changes
6. Major order wins or business developments
7. 52W price vs Nifty performance
8. Analyst consensus
Only report what you actually find. State source for each point. Do NOT fabricate.""",
                    max_tokens=1000, use_web_search=True)

                sm = _re.search(r'sector[:\s]+([^\n]+)', screener_data, _re.IGNORECASE)
                sector = sm.group(1).strip()[:60] if sm else "Unknown"
                nm = _re.search(r'company[:\s]+([^\n]+)', screener_data, _re.IGNORECASE)
                company_name = nm.group(1).strip()[:80] if nm else ticker
            except Exception as e:
                screener_data = f"Data fetch failed: {e}"
                news_data     = "News fetch failed"
                sector        = "Unknown"
                company_name  = ticker

            dim_prompts = {
                "forensics": _build_forensics_prompt(ticker, screener_data),
                "valuation":  _build_valuation_prompt(ticker, screener_data, news_data),
                "management": _build_management_prompt(ticker, screener_data, news_data),
                "concall":    _build_concall_prompt(ticker, news_data, screener_data),
                "sector":     _build_sector_prompt(ticker, sector, news_data),
                "technical":  _build_technical_prompt(ticker, screener_data, news_data),
            }

            dimensions = {}
            for k, p in dim_prompts.items():
                dimensions[k] = _scorer_call_json(client, p, max_tokens=1500)
                time.sleep(3)

            final = _scorer_call_json(client, _build_aggregator_prompt(ticker, dimensions), max_tokens=1000)
            results.append({"ticker": ticker, "company_name": company_name, "sector": sector, "dimensions": dimensions, "final": final})
            job["results"] = list(results)

        job.update({"status": "done", "current_idx": len(tickers)})
    except Exception as e:
        _scorer_jobs[job_id].update({"status": "error", "error": str(e)})


MAX_TICKERS_PER_JOB  = 5
FREE_TICKERS         = 1    # must match payments.FREE_STOCKS
EST_COST_PER_TICKER  = 0.35 # USD

@router.post("/api/scorer/analyze")
async def scorer_analyze(request: Request):
    from routers.payments import validate_unlock_token

    body         = await request.json()
    tickers      = [t.strip().upper() for t in body.get("tickers", []) if t.strip()]
    unlock_token = body.get("unlock_token", "")

    if not tickers:
        raise HTTPException(400, "No tickers provided")
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise HTTPException(503, "ANTHROPIC_API_KEY not configured")
    if len(tickers) > MAX_TICKERS_PER_JOB:
        raise HTTPException(400, f"Max {MAX_TICKERS_PER_JOB} tickers per run")

    # Enforce free tier: only 1 ticker without a valid unlock token
    if len(tickers) > FREE_TICKERS and not validate_unlock_token(unlock_token, tickers):
        raise HTTPException(402, "Payment required to score more than 1 stock")

    est_cost = len(tickers) * EST_COST_PER_TICKER
    job_id   = str(uuid.uuid4())[:8]
    _scorer_jobs[job_id] = {
        "status": "running", "results": [], "current_idx": 0,
        "current_ticker": tickers[0], "total": len(tickers),
        "est_cost_usd": round(est_cost, 2), "error": None,
    }
    threading.Thread(target=_do_score_analysis, args=(job_id, tickers), daemon=True).start()
    return {"job_id": job_id, "est_cost_usd": round(est_cost, 2)}


@router.get("/api/scorer/progress/{job_id}")
async def scorer_progress(job_id: str):
    job = _scorer_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.post("/api/scorer/save")
async def scorer_save(request: Request):
    body    = await request.json()
    d       = load()
    d.setdefault("scorer_reports", [])
    results = body.get("results", [])
    scores  = [r.get("final", {}).get("total_score_final", 0) for r in results]
    avg     = round(sum(scores) / len(scores)) if scores else 0
    report  = {
        "id":         str(uuid.uuid4())[:8],
        "name":       body.get("name", f"Report {datetime.now().strftime('%d %b %Y')}"),
        "created_at": datetime.now().isoformat(),
        "tickers":    [r.get("ticker") for r in results],
        "avg_score":  avg,
        "results":    results,
    }
    d["scorer_reports"].insert(0, report)
    save(d)
    return {"ok": True, "id": report["id"], "report": report}


@router.get("/api/scorer/reports")
async def scorer_reports():
    return load().get("scorer_reports", [])


@router.delete("/api/scorer/reports/{rid}")
async def scorer_delete_report(rid: str):
    d = load()
    d["scorer_reports"] = [r for r in d.get("scorer_reports", []) if r["id"] != rid]
    save(d)
    return {"ok": True}


@router.post("/api/scorer/email/{rid}")
async def scorer_email_report(rid: str):
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    d      = load()
    report = next((r for r in d.get("scorer_reports", []) if r["id"] == rid), None)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    lines = [f"Portfolio Scorer Report — {report['name']}", f"Date: {report['created_at'][:10]}", ""]
    for r in report.get("results", []):
        f = r.get("final", {})
        lines.append(f"{r['ticker']} ({r.get('company_name','')}) — Grade: {f.get('grade','?')} | Score: {f.get('total_score_final','?')}/100 | Action: {f.get('action','?')}")
        lines.append(f"  {f.get('overall_verdict','')}")
        if f.get("green_flags"):
            lines.append("  ✓ " + " · ".join(f["green_flags"]))
        if f.get("red_flags"):
            lines.append("  ⚠ " + " · ".join(f["red_flags"]))
        lines.append("")
    summary_text = "\n".join(lines)

    smtp_host = os.getenv("SMTP_HOST", "")
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASS", "")
    to_email  = os.getenv("REPORT_EMAIL", "vibhanshjha@gmail.com")

    if smtp_host and smtp_user and smtp_pass:
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = f"Portfolio Scorer: {report['name']}"
            msg["From"]    = smtp_user
            msg["To"]      = to_email
            msg.attach(MIMEText(summary_text, "plain"))
            with smtplib.SMTP(smtp_host, int(os.getenv("SMTP_PORT", "587"))) as srv:
                srv.starttls()
                srv.login(smtp_user, smtp_pass)
                srv.sendmail(smtp_user, to_email, msg.as_string())
            return {"ok": True, "method": "smtp", "to": to_email}
        except Exception as e:
            return {"ok": False, "method": "smtp_failed", "error": str(e), "summary": summary_text}
    else:
        return {"ok": True, "method": "no_smtp", "summary": summary_text, "to": to_email}
