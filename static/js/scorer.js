// ═══════════════════════════════════════════════════════════════════════
// ── PORTFOLIO SCORER  (with Razorpay pay-to-unlock)
// ═══════════════════════════════════════════════════════════════════════

const SCORER_DIMS = [
  { key: "forensics", label: "Forensics",      icon: "🔍", color: "#ef4444", max: 20 },
  { key: "valuation", label: "Valuation",      icon: "💰", color: "#f59e0b", max: 20 },
  { key: "management",label: "Management",     icon: "👤", color: "#8b5cf6", max: 15 },
  { key: "sector",    label: "Sector",         icon: "🌐", color: "#06b6d4", max: 15 },
  { key: "concall",   label: "Concall/Growth", icon: "🎙", color: "#10b981", max: 20 },
  { key: "technical", label: "Stage/Chart",    icon: "📈", color: "#3b82f6", max: 10 },
];

const _FREE_STOCKS      = 1;
const _MAX_TICKERS      = 5;
const _COST_PER_STOCK   = 30;   // ₹ — what we charge (= API cost, no markup)
const _USD_PER_STOCK    = 0.35; // for internal estimate display

let _scorerJobId       = null;
let _scorerPollTimer   = null;
let _scorerResults     = [];
let _scorerSort        = 'score';
let _scorerSavedId     = null;
let _scorerExpanded    = null;
let _scorerAllTickers  = [];    // full list user entered
let _scorerUnlockToken = null;  // set after payment

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _gradeColor(g) {
  if (!g) return 'var(--text-faint)';
  if (g.startsWith('A')) return '#10b981';
  if (g.startsWith('B')) return '#3b82f6';
  if (g === 'C') return '#f59e0b';
  if (g === 'D') return '#f97316';
  return '#ef4444';
}
function _actionColor(a) {
  if (!a) return 'var(--text-faint)';
  if (a.includes('Strong Buy')) return '#10b981';
  if (a.includes('Buy'))        return '#22d3ee';
  if (a.includes('Hold'))       return '#f59e0b';
  if (a.includes('Watch'))      return '#a78bfa';
  return '#ef4444';
}
function _scorerScoreBar(score, max, color) {
  const pct = Math.min(100, Math.round((score / max) * 100));
  return `<div style="display:flex;align-items:center;gap:8px">
    <div style="flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden">
      <div style="width:${pct}%;height:100%;background:${color};border-radius:3px"></div>
    </div>
    <span style="font-size:11px;color:var(--text-faint);min-width:36px;text-align:right;font-family:'JetBrains Mono',monospace">${score}/${max}</span>
  </div>`;
}
function _scorerRadar(scores) {
  const cx=100, cy=100, r=72, n=SCORER_DIMS.length;
  const pts = SCORER_DIMS.map((d,i) => {
    const a = (i/n)*2*Math.PI - Math.PI/2;
    const pct = Math.min(1,(scores[d.key]?.score||0)/d.max);
    return {x: cx+r*pct*Math.cos(a), y: cy+r*pct*Math.sin(a)};
  });
  const outer = SCORER_DIMS.map((_,i) => {
    const a=(i/n)*2*Math.PI-Math.PI/2;
    return {x:cx+r*Math.cos(a), y:cy+r*Math.sin(a)};
  });
  const grids = [0.25,0.5,0.75,1].map(f =>
    `<polygon points="${outer.map(p=>`${cx+(p.x-cx)*f},${cy+(p.y-cy)*f}`).join(' ')}" fill="none" stroke="var(--border)" stroke-width="${f===1?1.5:0.8}"/>`
  ).join('');
  const axes   = outer.map(p => `<line x1="${cx}" y1="${cy}" x2="${p.x}" y2="${p.y}" stroke="var(--border)" stroke-width="0.8"/>`).join('');
  const poly   = `<polygon points="${pts.map(p=>`${p.x},${p.y}`).join(' ')}" fill="rgba(99,102,241,0.15)" stroke="#6366f1" stroke-width="2"/>`;
  const dots   = pts.map((p,i) => `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${SCORER_DIMS[i].color}"/>`).join('');
  const labels = outer.map((p,i) => {
    const a=(i/n)*2*Math.PI-Math.PI/2;
    const lx=cx+(r+20)*Math.cos(a), ly=cy+(r+20)*Math.sin(a);
    return `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" font-size="9" fill="var(--text-faint)">${SCORER_DIMS[i].icon}</text>`;
  }).join('');
  return `<svg width="200" height="200" viewBox="0 0 200 200">${grids}${axes}${poly}${dots}${labels}</svg>`;
}

// ─── Scored card ──────────────────────────────────────────────────────────────
function _scorerCard(stock, expanded) {
  const { ticker, company_name, sector, dimensions={}, final={} } = stock;
  const gc = _gradeColor(final.grade);
  const ac = _actionColor(final.action);
  const dimBars = SCORER_DIMS.map(d => {
    const s = dimensions[d.key]?.score ?? 0;
    const pct = Math.round((s/d.max)*100);
    return `<div title="${d.label}: ${s}/${d.max}" style="width:28px;height:5px;border-radius:2px;background:${d.color}${pct>60?'ff':pct>30?'88':'33'}"></div>`;
  }).join('');

  let detail = '';
  if (expanded) {
    const dimCards = SCORER_DIMS.map(dim => {
      const d = dimensions[dim.key] || {};
      const score = d.score ?? 0;
      let extra = '';
      if (dim.key === 'forensics' && d.checklist?.length) {
        extra = `<details style="margin-top:8px"><summary style="font-size:11px;color:var(--accent);cursor:pointer">Forensic checklist</summary>
          <div style="margin-top:6px">${d.checklist.slice(0,5).map(c =>
            `<div style="display:flex;gap:6px;margin-bottom:3px;font-size:10px;color:var(--text-muted);line-height:1.4">
              <span>${c.status==='Green'?'🟢':c.status==='Yellow'?'🟡':'🔴'}</span>
              <span>${esc(c.item||'')} — ${esc(c.detail||'')}</span>
            </div>`).join('')}</div></details>`;
      }
      if (dim.key === 'valuation' && d.bear_case?.length) {
        extra = `<details style="margin-top:8px"><summary style="font-size:11px;color:var(--accent);cursor:pointer">Bear case (${d.bear_case.length} reasons)</summary>
          <div style="margin-top:6px">${d.bear_case.map((r,i) =>
            `<div style="font-size:10px;color:var(--text-muted);padding:2px 0;line-height:1.5"><span style="color:#ef4444;margin-right:4px">${i+1}.</span>${esc(r)}</div>`).join('')}</div></details>`;
      }
      if (dim.key === 'management' && d.governance_rating) {
        const gc2 = d.governance_rating==='Shareholder-Friendly'?'#4ade80':d.governance_rating==='Neutral'?'var(--text-muted)':'#f87171';
        extra = `<div style="margin-top:6px;font-size:10px"><span style="color:${gc2};font-weight:600">${esc(d.governance_rating)}</span>${d.promoter_pledge_pct?` · Pledge: ${esc(d.promoter_pledge_pct)}`:''}${d.sebi_actions&&d.sebi_actions!=='none known'?` · <span style="color:#ef4444">⚠ SEBI</span>`:''}</div>`;
      }
      if (dim.key === 'concall' && d.growth_triggers?.length) {
        extra = `<div style="margin-top:6px">${d.growth_triggers.map(t =>
          `<div style="font-size:10px;color:var(--text-muted);padding:2px 0;line-height:1.4">▸ ${esc(t.trigger||'')} <span style="color:${t.conviction==='High'?'#4ade80':t.conviction==='Medium'?'#f59e0b':'var(--text-faint)'}">(${t.conviction})</span></div>`).join('')}</div>`;
      }
      if (dim.key === 'sector' && d.sector_cycle) {
        extra = `<div style="margin-top:6px;font-size:10px;color:var(--text-faint)">Cycle: <span style="color:var(--text)">${esc(d.sector_cycle)}</span> · Policy: <span style="color:${d.policy_tailwind==='Strong'?'#4ade80':d.policy_tailwind==='Headwind'?'#ef4444':'#f59e0b'}">${esc(d.policy_tailwind||'?')}</span></div>`;
      }
      if (dim.key === 'technical' && d.stage_label) {
        const sc = ['','#10b981','#3b82f6','#f59e0b','#ef4444'][d.stage] || 'var(--text-faint)';
        extra = `<div style="margin-top:6px;font-size:10px;color:var(--text-faint)">Stage <span style="color:${sc};font-weight:700">${d.stage||'?'}</span> — ${esc(d.stage_label)} · 52W: ${esc(d['52w_position']||'unknown')}</div>`;
      }
      return `<div style="background:var(--bg);border-radius:8px;padding:12px;border:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:12px;color:var(--text-muted);font-weight:600">${dim.icon} ${dim.label}</span>
          <span style="font-size:12px;font-weight:800;color:${dim.color};font-family:'JetBrains Mono',monospace">${score}/${dim.max}</span>
        </div>
        ${_scorerScoreBar(score, dim.max, dim.color)}
        <div style="font-size:11px;color:var(--text-faint);margin-top:6px;line-height:1.5">${esc(d.verdict || (d.accounting_quality && `Accounting: ${d.accounting_quality}`) || 'No data')}</div>
        ${extra}
      </div>`;
    }).join('');
    const penalties = (final.penalties_applied||[]).map(p =>
      `<span style="font-size:10px;color:#fca5a5;margin-right:8px">−${Math.abs(p.points)} ${esc(p.reason||'')}</span>`).join('');
    const greenF = (final.green_flags||[]).map(f =>
      `<span style="font-size:10px;background:rgba(5,46,22,0.6);color:#4ade80;padding:2px 8px;border-radius:20px;border:1px solid #166534">✓ ${esc(f)}</span>`).join('');
    const redF = (final.red_flags||[]).map(f =>
      `<span style="font-size:10px;background:rgba(45,0,0,0.6);color:#f87171;padding:2px 8px;border-radius:20px;border:1px solid #7f1d1d">⚠ ${esc(f)}</span>`).join('');
    detail = `<div style="border-top:1px solid var(--border);padding:16px">
      <div style="display:grid;grid-template-columns:200px 1fr;gap:16px;margin-bottom:16px;align-items:start">
        ${_scorerRadar(dimensions)}
        <div>
          <div style="font-size:13px;color:var(--text);line-height:1.7;margin-bottom:10px">${esc(final.overall_verdict||'')}</div>
          ${penalties ? `<div style="margin-bottom:8px"><span style="font-size:10px;color:var(--text-faint);margin-right:6px">Penalties:</span>${penalties}</div>` : ''}
          <div style="display:flex;gap:6px;flex-wrap:wrap">${greenF}${redF}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">${dimCards}</div>
    </div>`;
  }
  return `<div style="background:var(--surface);border:1px solid ${expanded?'var(--border2)':'var(--border)'};border-radius:12px;overflow:hidden">
    <div onclick="toggleScorerCard('${ticker}')" style="cursor:pointer;padding:14px 16px;display:flex;align-items:center;gap:12px">
      <div style="min-width:48px;height:48px;border-radius:10px;background:${gc}22;border:2px solid ${gc};display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0">
        <span style="font-size:16px;font-weight:900;color:${gc};font-family:'JetBrains Mono',monospace">${final.grade||'?'}</span>
      </div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:14px;font-weight:700;color:var(--text-strong);font-family:'JetBrains Mono',monospace">${ticker}</span>
          <span style="font-size:11px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${esc(company_name)}</span>
        </div>
        <div style="font-size:10px;color:var(--text-faint);margin-top:1px">${esc(sector)}</div>
        <div style="margin-top:6px;display:flex;gap:3px">${dimBars}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:24px;font-weight:900;color:${gc};font-family:'JetBrains Mono',monospace">${final.total_score_final??'?'}</div>
        <div style="font-size:9px;color:var(--text-faint);margin-bottom:3px">/100</div>
        <div style="font-size:10px;font-weight:700;color:${ac};background:${ac}22;padding:2px 8px;border-radius:10px;border:1px solid ${ac}44">${final.action||'?'}</div>
      </div>
      <span style="color:var(--text-faint);font-size:11px">${expanded?'▲':'▼'}</span>
    </div>
    ${detail}
  </div>`;
}

// ─── Locked placeholder card ─────────────────────────────────────────────────
function _lockedCard(ticker) {
  return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;position:relative">
    <!-- blurred fake content -->
    <div style="padding:14px 16px;display:flex;align-items:center;gap:12px;filter:blur(6px);user-select:none;pointer-events:none">
      <div style="min-width:48px;height:48px;border-radius:10px;background:#3b82f622;border:2px solid #3b82f6;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <span style="font-size:16px;font-weight:900;color:#3b82f6;font-family:'JetBrains Mono',monospace">B+</span>
      </div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:700;color:var(--text-strong);font-family:'JetBrains Mono',monospace">${ticker}</div>
        <div style="font-size:10px;color:var(--text-faint);margin-top:1px">Analysis ready</div>
        <div style="margin-top:6px;display:flex;gap:3px">
          ${SCORER_DIMS.map(d=>`<div style="width:28px;height:5px;border-radius:2px;background:${d.color}88"></div>`).join('')}
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:24px;font-weight:900;color:#3b82f6;font-family:'JetBrains Mono',monospace">74</div>
        <div style="font-size:9px;color:var(--text-faint);margin-bottom:3px">/100</div>
        <div style="font-size:10px;font-weight:700;color:#22d3ee;background:#22d3ee22;padding:2px 8px;border-radius:10px;border:1px solid #22d3ee44">Buy</div>
      </div>
    </div>
    <!-- lock overlay -->
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:rgba(0,0,0,0.35);backdrop-filter:blur(1px)">
      <div style="font-size:22px">🔒</div>
      <div style="font-size:12px;font-weight:700;color:#fff">${ticker} — Locked</div>
      <div style="font-size:10px;color:rgba(255,255,255,0.6)">Pay to reveal this analysis</div>
    </div>
  </div>`;
}

function toggleScorerCard(ticker) {
  _scorerExpanded = _scorerExpanded === ticker ? null : ticker;
  _renderScorerCards();
}

function _renderScorerCards() {
  const scored  = _scorerResults;
  const locked  = _scorerAllTickers.slice(_FREE_STOCKS).filter(t => !scored.find(s => s.ticker === t));
  const sorted  = [...scored].sort((a,b) => {
    if (_scorerSort==='score')     return (b.final?.total_score_final??0)-(a.final?.total_score_final??0);
    if (_scorerSort==='forensics') return (b.dimensions?.forensics?.score??0)-(a.dimensions?.forensics?.score??0);
    if (_scorerSort==='action')    return (a.final?.action||'').localeCompare(b.final?.action||'');
    return 0;
  });
  document.getElementById('scorer-cards').innerHTML =
    sorted.map(s => _scorerCard(s, _scorerExpanded===s.ticker)).join('') +
    locked.map(t => _lockedCard(t)).join('');

  // unlock banner if locked cards present
  const existingBanner = document.getElementById('scorer-unlock-banner');
  if (existingBanner) existingBanner.remove();
  if (locked.length) {
    const banner = document.createElement('div');
    banner.id = 'scorer-unlock-banner';
    banner.innerHTML = `<div style="background:linear-gradient(135deg,#1e1b4b,#14213d);border:1px solid #4f46e5;border-radius:12px;padding:20px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:12px">
      <div style="font-size:28px">🔐</div>
      <div style="flex:1;min-width:200px">
        <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:4px">Unlock ${locked.length} more stock${locked.length>1?'s':''}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.6);line-height:1.6">
          ${locked.join(', ')} · Actual API cost, zero markup
        </div>
        <div style="margin-top:8px;display:flex;gap:16px;flex-wrap:wrap">
          <div style="font-size:11px;color:rgba(255,255,255,0.5)">🤖 Claude AI · Web search · 6 dimensions</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.5)">💸 ₹${locked.length * _COST_PER_STOCK} total (₹${_COST_PER_STOCK}/stock)</div>
        </div>
      </div>
      <button onclick="startPaymentFlow()" style="background:linear-gradient(135deg,#6366f1,#4f46e5);border:none;border-radius:10px;color:#fff;font-size:13px;font-weight:700;padding:12px 24px;cursor:pointer;white-space:nowrap;box-shadow:0 4px 14px rgba(99,102,241,0.4)">
        🔓 Unlock for ₹${locked.length * _COST_PER_STOCK}
      </button>
    </div>`;
    document.getElementById('scorer-cards').prepend(banner);
  }

  // summary bar
  if (scored.length) {
    const avg = Math.round(scored.reduce((s,x)=>s+(x.final?.total_score_final??0),0)/scored.length);
    document.getElementById('scorer-avg-score').textContent = avg;
    document.getElementById('scorer-avg-score').style.color = _gradeColor(avg>=80?'A':avg>=60?'B':avg>=40?'C':'F');
    const actionCounts = {};
    scored.forEach(s => { const a=s.final?.action||'?'; actionCounts[a]=(actionCounts[a]||0)+1; });
    document.getElementById('scorer-action-counts').innerHTML = Object.entries(actionCounts).map(([a,c]) =>
      `<div><div style="font-size:9px;color:var(--text-faint)">${a.toUpperCase()}</div><div style="font-size:20px;font-weight:800;color:${_actionColor(a)};font-family:'JetBrains Mono',monospace">${c}</div></div>`
    ).join('');
    document.getElementById('scorer-summary').style.display = 'block';
  }
}

function setScorerSort(s) {
  _scorerSort = s;
  document.querySelectorAll('.scorer-sort-btn').forEach(b => {
    b.style.borderColor='var(--border)'; b.style.color='var(--text-faint)'; b.style.background='transparent';
  });
  const active = document.getElementById('sort-'+s);
  if (active) { active.style.borderColor='var(--accent)'; active.style.color='var(--accent)'; active.style.background='var(--surface2)'; }
  _renderScorerCards();
}

function _updateScorerProgress(job) {
  const allTickers = job._tickers || [];
  document.getElementById('scorer-pipeline').innerHTML = allTickers.map((t,i) => {
    const done   = !!(job.results||[]).find(r=>r.ticker===t);
    const active = t === job.current_ticker && !done;
    return `<div style="display:flex;align-items:center;gap:6px;padding:5px 0">
      <div style="width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0;
        background:${done?'#10b981':active?'var(--accent)':'var(--border)'};
        border:2px solid ${done?'#10b981':active?'var(--accent)':'var(--border2)'};
        color:${done||active?'#fff':'var(--text-faint)'}">
        ${done?'✓':active?'⟳':'·'}
      </div>
      <span style="font-size:12px;color:${done?'var(--text-faint)':active?'var(--text-strong)':'var(--border2)'};font-family:'JetBrains Mono',monospace">
        ${t}${done?' — Done':active?' — Analysing…':''}
      </span>
    </div>`;
  }).join('');
}

// ─── Cost dialog ──────────────────────────────────────────────────────────────
function _showCostDialog(tickers, onFree, onPay) {
  const paid      = tickers.slice(_FREE_STOCKS);
  const totalCost = paid.length * _COST_PER_STOCK;
  const minutes   = tickers.length * 3;

  // Remove any existing dialog
  const old = document.getElementById('scorer-cost-dialog');
  if (old) old.remove();

  const el = document.createElement('div');
  el.id = 'scorer-cost-dialog';
  el.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px)';
  el.innerHTML = `
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;width:100%;max-width:480px;overflow:hidden">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0f172a,#1e1b4b);padding:24px;text-align:center;border-bottom:1px solid var(--border)">
      <div style="font-size:32px;margin-bottom:8px">📊</div>
      <div style="font-size:18px;font-weight:800;color:#fff;margin-bottom:4px">Portfolio Scorer</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.5)">AI-powered 6-dimension forensic analysis</div>
    </div>

    <!-- Tickers -->
    <div style="padding:20px 24px 0">
      <div style="font-size:10px;color:var(--text-faint);letter-spacing:1px;margin-bottom:8px">STOCKS TO SCORE</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${tickers.map((t,i) => `
          <span style="font-size:12px;font-weight:700;font-family:'JetBrains Mono',monospace;padding:4px 12px;border-radius:20px;border:1px solid ${i===0?'#10b981':'#4f46e5'};background:${i===0?'rgba(16,185,129,0.1)':'rgba(99,102,241,0.1)'};color:${i===0?'#10b981':'#a5b4fc'}">
            ${t}${i===0?' ✦ free':''}
          </span>`).join('')}
      </div>
    </div>

    <!-- Cost breakdown -->
    <div style="padding:20px 24px">
      <div style="background:var(--bg);border-radius:10px;border:1px solid var(--border);overflow:hidden">
        <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:var(--text-faint)">1 free stock (${tickers[0]})</span>
          <span style="font-size:12px;color:#10b981;font-weight:600">₹0</span>
        </div>
        ${paid.length ? `
        <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:var(--text-faint)">${paid.length} additional stock${paid.length>1?'s':''} × ₹${_COST_PER_STOCK}</span>
          <span style="font-size:12px;color:var(--text);font-weight:600">₹${totalCost}</span>
        </div>
        <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:var(--text-faint)">Platform fee / markup</span>
          <span style="font-size:12px;color:#10b981;font-weight:600">₹0 — zero markup</span>
        </div>` : ''}
        <div style="padding:12px 14px;display:flex;justify-content:space-between;align-items:center;background:var(--surface)">
          <span style="font-size:13px;font-weight:700;color:var(--text-strong)">You pay</span>
          <span style="font-size:18px;font-weight:900;color:var(--accent);font-family:'JetBrains Mono',monospace">₹${totalCost}</span>
        </div>
      </div>

      <!-- What you get -->
      <div style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${['🔍 Forensic accounting','💰 Piotroski + DuPont','👤 Management quality','🌐 Porter Five Forces','🎙 Growth triggers','📈 Weinstein stage'].map(f =>
          `<div style="font-size:10px;color:var(--text-faint);display:flex;align-items:center;gap:4px">${f}</div>`).join('')}
      </div>

      <!-- Transparency note -->
      <div style="margin-top:12px;padding:10px 12px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:8px;font-size:10px;color:rgba(16,185,129,0.8);line-height:1.6">
        ✦ This is the actual Claude AI + web search cost. We pass it through at cost — no markup, no profit. You're paying for compute, not a subscription.
      </div>

      <!-- Time estimate -->
      <div style="margin-top:8px;font-size:10px;color:var(--text-faint);text-align:center">
        ⏱ Estimated time: ${minutes}–${minutes+tickers.length*2} minutes
      </div>
    </div>

    <!-- Action buttons -->
    <div style="padding:0 24px 24px;display:flex;gap:10px">
      <button onclick="document.getElementById('scorer-cost-dialog').remove()" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--text-muted);font-size:13px;cursor:pointer">
        Cancel
      </button>
      <button onclick="document.getElementById('scorer-cost-dialog').remove(); _doStartScoring(['${tickers[0]}'])" style="flex:1;padding:12px;border-radius:10px;border:1px solid #10b981;background:rgba(16,185,129,0.1);color:#10b981;font-size:13px;font-weight:600;cursor:pointer">
        Score 1 Free
      </button>
      ${paid.length ? `
      <button onclick="document.getElementById('scorer-cost-dialog').remove(); startPaymentFlow()" style="flex:2;padding:12px;border-radius:10px;border:none;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(99,102,241,0.4)">
        Pay ₹${totalCost} &amp; Score All
      </button>` : `
      <button onclick="document.getElementById('scorer-cost-dialog').remove(); _doStartScoring(['${tickers.join("','")}'])" style="flex:2;padding:12px;border-radius:10px;border:none;background:linear-gradient(135deg,#10b981,#059669);color:#fff;font-size:13px;font-weight:700;cursor:pointer">
        Score Free ✓
      </button>`}
    </div>
  </div>`;
  document.body.appendChild(el);
  // Close on backdrop click
  el.addEventListener('click', e => { if (e.target === el) el.remove(); });
}

// ─── Main entry point ─────────────────────────────────────────────────────────
async function startScoring() {
  const input = document.getElementById('scorer-input').value.trim();
  if (!input) return;
  const tickers = input.split(/[\n,\s]+/).map(t=>t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) return;

  if (tickers.length > _MAX_TICKERS) {
    _scorerShowError(`Max ${_MAX_TICKERS} tickers per run. You entered ${tickers.length}. Split into batches.`);
    return;
  }

  _scorerAllTickers = tickers;
  _scorerUnlockToken = null;
  _scorerResults = [];
  _scorerExpanded = null;
  _scorerSavedId = null;

  // Always show cost dialog first
  _showCostDialog(tickers);
}

// ─── Razorpay payment flow ────────────────────────────────────────────────────
async function startPaymentFlow() {
  const tickers = _scorerAllTickers;
  if (!tickers.length) return;

  // Check Razorpay is loaded
  if (typeof Razorpay === 'undefined') {
    _scorerShowError('Payment system not loaded. Please refresh the page.');
    return;
  }

  try {
    const orderRes = await fetch('/api/payments/create-order', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({tickers}),
    });
    if (!orderRes.ok) {
      let msg = 'Could not create payment order';
      try { msg = (await orderRes.json()).detail || msg; } catch(_) { msg = await orderRes.text() || msg; }
      throw new Error(msg);
    }
    const order = await orderRes.json();

    const options = {
      key:         order.key_id,
      amount:      order.amount_paise,
      currency:    'INR',
      name:        'Portfolio Scorer',
      description: `Score ${order.paid_count} stock${order.paid_count>1?'s':''} (${tickers.slice(_FREE_STOCKS).join(', ')})`,
      order_id:    order.order_id,
      prefill: {
        name:  '',
        email: '',
      },
      theme: { color: '#6366f1' },
      modal: {
        ondismiss: () => { /* user cancelled — no action needed */ }
      },
      handler: async (response) => {
        // Payment success — verify on backend
        try {
          const verifyRes = await fetch('/api/payments/verify', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
              razorpay_order_id:   response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature:  response.razorpay_signature,
              tickers,
            }),
          });
          if (!verifyRes.ok) throw new Error('Payment verification failed');
          const {unlock_token} = await verifyRes.json();
          _scorerUnlockToken = unlock_token;
          // Run full analysis with token
          _doStartScoring(tickers, unlock_token);
        } catch(e) {
          _scorerShowError(`Payment verified but analysis failed: ${e.message}. Contact support with your payment ID: ${response.razorpay_payment_id}`);
        }
      },
    };
    const rzp = new Razorpay(options);
    rzp.open();
  } catch(e) {
    _scorerShowError(`Payment error: ${e.message}`);
  }
}

// ─── Run the actual scoring job ───────────────────────────────────────────────
async function _doStartScoring(tickers, unlockToken = null) {
  _scorerResults = [];
  _scorerExpanded = null;
  _scorerSavedId = null;

  document.getElementById('scorer-cards').innerHTML = '';
  document.getElementById('scorer-summary').style.display = 'none';
  document.getElementById('scorer-error').style.display = 'none';
  document.getElementById('scorer-action-bar').style.display = 'none';
  document.getElementById('scorer-progress').style.display = 'block';
  document.getElementById('scorer-run-btn').disabled = true;
  document.getElementById('scorer-run-btn').textContent = '⟳ Scoring…';

  document.getElementById('scorer-pipeline').innerHTML = tickers.map(t =>
    `<div style="display:flex;align-items:center;gap:6px;padding:5px 0">
      <div style="width:18px;height:18px;border-radius:50%;background:var(--border);border:2px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--text-faint)">·</div>
      <span style="font-size:12px;color:var(--border2);font-family:'JetBrains Mono',monospace">${t}</span>
    </div>`).join('');

  try {
    const body = {tickers};
    if (unlockToken) body.unlock_token = unlockToken;

    const res = await fetch('/api/scorer/analyze', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    if (!res.ok) { const e=await res.json(); throw new Error(e.detail||'Server error'); }
    const {job_id} = await res.json();
    _scorerJobId = job_id;

    if (_scorerPollTimer) clearInterval(_scorerPollTimer);
    _scorerPollTimer = setInterval(async () => {
      try {
        const p = await fetch(`/api/scorer/progress/${job_id}`).then(r=>r.json());
        p._tickers = tickers;
        _updateScorerProgress(p);
        if (p.results?.length) {
          _scorerResults = p.results;
          _renderScorerCards();
        }
        if (p.status === 'done' || p.status === 'error') {
          clearInterval(_scorerPollTimer);
          document.getElementById('scorer-run-btn').disabled = false;
          document.getElementById('scorer-run-btn').textContent = '▶ Score Portfolio';
          document.getElementById('scorer-progress').style.display = 'none';
          if (p.status === 'error') {
            _scorerShowError(`Error: ${p.error}`);
          } else {
            document.getElementById('scorer-action-bar').style.display = 'flex';
            // Show locked cards for the stocks we didn't score (free run only scored 1)
            _renderScorerCards();
          }
        }
      } catch(e) {
        clearInterval(_scorerPollTimer);
        _scorerShowError(`Poll error: ${e.message}`);
      }
    }, 3000);
  } catch(e) {
    _scorerShowError(e.message);
    document.getElementById('scorer-progress').style.display = 'none';
    document.getElementById('scorer-run-btn').disabled = false;
    document.getElementById('scorer-run-btn').textContent = '▶ Score Portfolio';
  }
}

function _scorerShowError(msg) {
  const el = document.getElementById('scorer-error');
  el.style.display = 'block';
  el.textContent = msg;
}

// ─── Save / Email / View / Delete ────────────────────────────────────────────
async function saveScorerReport() {
  if (!_scorerResults.length) return;
  const name = prompt('Report name:', `Score — ${new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}`);
  if (!name) return;
  const res = await fetch('/api/scorer/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,results:_scorerResults})});
  const d = await res.json();
  _scorerSavedId = d.id;
  alert('Saved to Resources → Scorer Reports');
}

async function emailScorerReport() {
  if (!_scorerSavedId) {
    // auto-save first
    const res = await fetch('/api/scorer/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:`Score — ${new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}`,results:_scorerResults})});
    const d = await res.json(); _scorerSavedId = d.id;
  }
  const r = await fetch(`/api/scorer/email/${_scorerSavedId}`,{method:'POST'}).then(x=>x.json());
  document.getElementById('scorer-email-content').textContent = r.body || r.text || JSON.stringify(r,null,2);
  document.getElementById('scorer-email-modal').style.display = 'flex';
}

function openScorer() {
  document.getElementById('scorer-panel').style.display = 'block';
}
function closeScorer() {
  document.getElementById('scorer-panel').style.display = 'none';
  if (_scorerPollTimer) clearInterval(_scorerPollTimer);
}

async function viewScorerReport(id) {
  const r = await fetch(`/api/scorer/reports/${id}`).then(x=>x.json());
  _scorerResults    = r.results || [];
  _scorerAllTickers = _scorerResults.map(s=>s.ticker);
  _scorerSavedId    = id;
  _scorerExpanded   = null;
  document.getElementById('scorer-panel').style.display = 'block';
  document.getElementById('scorer-input').value = _scorerAllTickers.join(', ');
  document.getElementById('scorer-progress').style.display = 'none';
  document.getElementById('scorer-action-bar').style.display = 'flex';
  document.getElementById('scorer-error').style.display = 'none';
  _renderScorerCards();
}

async function deleteScorerReport(id) {
  if (!confirm('Delete this scorer report?')) return;
  await fetch(`/api/scorer/reports/${id}`,{method:'DELETE'});
  await fetchData(); renderTab();
}
