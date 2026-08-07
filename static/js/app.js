// ─── Theme ────────────────────────────────────────────────────────────────────
(function () {
  const saved = localStorage.getItem('pt-theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  // btn emoji set after DOM ready below
})();

function toggleTheme() {
  const html = document.documentElement;
  const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
  html.dataset.theme = next;
  localStorage.setItem('pt-theme', next);
  document.getElementById('theme-btn').textContent = next === 'dark' ? '🌙' : '☀️';
}

// ─── State ────────────────────────────────────────────────────────────────────
let state = { positions: [], watchlist: [], us_watchlist: [], settings: { usd_inr_rate: 84 }, aifNav: [] };
let technicals = {};
let currentTab = 'consolidated';
let NUMBERS_VISIBLE = false;
document.body.classList.add('numbers-hidden');
let sortKey = null, sortDir = -1;
let wlSortKey = null, wlSortDir = -1;
let currentIndianTab    = 'vibhanshu';
let currentUSTab        = 'us_consolidated';
let currentWatchlistTab    = 'watchlist';
let currentWatchlistRegion = 'india'; // 'india' | 'international'
let currentRegion          = 'indian'; // 'indian' | 'us'
let allocMode = 'current'; // 'current' = by market value, 'invested' = by cost basis
let iyerExpanded = false;
let analysisJobs = {};
let analysisPollers = {};
let alphaData = null;
let _alphaPoller = null;
let taxData = null;
let taxFY = null;

const ACCT_LABELS = {
  vibhanshu: 'Vibhanshu', manjari: 'Manjari', huf: 'HUF',
  manjbhawna: 'Manj/Bhawna', us_vibhanshu: 'US–Vib',
  us_manjari: 'US–Manj', us_huf: 'US–HUF',
};

// Shared currency → symbol map, so a position's own `currency` field (not just
// the Indian/US tab it lives in) drives what symbol is shown.
const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£', SGD: 'S$', AUD: 'A$' };
function curSym(currency) { return CURRENCY_SYMBOLS[currency] || '₹'; }
// currency -> INR rate, reading whichever settings field actually holds it
// (USD has its own dedicated `usd_inr_rate`; everything else lives in `fx_rates`).
function rateFor(currency) {
  if (currency === 'INR') return 1;
  if (currency === 'USD') return state.settings?.usd_inr_rate || 84;
  return (state.settings?.fx_rates || {})[currency] || 1;
}
// Non-USD global currencies that get their own live-rate card + fetch button
// in the "US"/global tab, alongside the existing dedicated USD rate.
const GLOBAL_FX_CURRENCIES = ['EUR', 'GBP', 'SGD', 'AUD'];

// Lists that get extra columns: Market Cap, Conviction, Exchange
const _INTL_WL_IDS = new Set(['wl_soic_research_international', 'wl_rick_rule_s_stocks']);

// Watchlist region membership: India vs International
const _WL_INDIA_IDS = new Set(['watchlist', 'soic_research', 'top_ideas']);
function _wlRegionOf(id) {
  if (_WL_INDIA_IDS.has(id)) return 'india';
  // Check stored region on dynamic groups (set when group was created)
  const g = (state?.settings?.watchlist_groups || []).find(x => x.id === id);
  return g?.region || 'international';
}

function _extractExchange(item) {
  if (item.exchange) return item.exchange;
  const t = (item.ticker || '').toUpperCase();
  if (t.endsWith('.AX'))  return 'ASX';
  if (t.endsWith('.TO'))  return 'TSX';
  if (t.endsWith('.V'))   return 'TSXV';
  if (t.endsWith('.L'))   return 'LSE';
  if (t.endsWith('.DE'))  return 'Frankfurt';
  if (t.endsWith('.NS') || t.startsWith('NSE:')) return 'NSE';
  if (t.endsWith('.BO') || t.startsWith('BSE:')) return 'BSE';
  return 'US';
}

// TVGP = Theme, Value, Growth, Promoter — colored dot badges
const _TVGP_COLORS = {
  G: { bg: 'rgba(52,211,153,.2)',  fg: '#34d399', bd: 'rgba(52,211,153,.5)'  },
  Y: { bg: 'rgba(251,191,36,.2)',  fg: '#f59e0b', bd: 'rgba(251,191,36,.5)'  },
  R: { bg: 'rgba(248,113,113,.2)', fg: '#f87171', bd: 'rgba(248,113,113,.5)' },
};
const _TVGP_LABELS = { T: 'Theme', V: 'Value', G: 'Growth', P: 'Promoter' };

function _tvgpDot(val, key) {
  const c = _TVGP_COLORS[val] || { bg: 'rgba(148,163,184,.15)', fg: '#64748b', bd: 'rgba(148,163,184,.3)' };
  const label = _TVGP_LABELS[key] || key;
  const valLabel = val === 'G' ? 'Green' : val === 'Y' ? 'Yellow' : val === 'R' ? 'Red' : '—';
  return `<span title="${label}: ${valLabel}"
    style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;
           border-radius:50%;font-size:9px;font-weight:700;
           background:${c.bg};color:${c.fg};border:1px solid ${c.bd};margin:1px">${key}</span>`;
}

function _tvgpCell(w) {
  return `<td style="white-space:nowrap;padding:4px 8px">
    ${_tvgpDot(w.tvgp_theme,    'T')}${_tvgpDot(w.tvgp_value,    'V')}${_tvgpDot(w.tvgp_growth,   'G')}${_tvgpDot(w.tvgp_promoter, 'P')}
  </td>`;
}

const _TVGP_FIELD_MAP = { T: 'tvgp_theme', V: 'tvgp_value', G: 'tvgp_growth', P: 'tvgp_promoter' };

function _tvgpDotEditable(val, key, itemId, listId) {
  const c = _TVGP_COLORS[val] || { bg: 'rgba(148,163,184,.15)', fg: '#64748b', bd: 'rgba(148,163,184,.3)' };
  const label = _TVGP_LABELS[key] || key;
  const valLabel = val === 'G' ? 'Green' : val === 'Y' ? 'Yellow' : val === 'R' ? 'Red' : '—';
  const safeId   = itemId.replace(/'/g, "\\'");
  const safeList = listId.replace(/'/g, "\\'");
  return `<span title="${label}: ${valLabel} — click to cycle"
    onclick="cycleTvgp('${safeId}','${safeList}','${_TVGP_FIELD_MAP[key]}','${val || ''}')"
    style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;
           border-radius:50%;font-size:9px;font-weight:700;cursor:pointer;
           background:${c.bg};color:${c.fg};border:1px solid ${c.bd};margin:1px">${key}</span>`;
}

function _tvgpCellEditable(w, listId) {
  return `<td style="white-space:nowrap;padding:4px 8px">
    ${_tvgpDotEditable(w.tvgp_theme,    'T', w.id, listId)}
    ${_tvgpDotEditable(w.tvgp_value,    'V', w.id, listId)}
    ${_tvgpDotEditable(w.tvgp_growth,   'G', w.id, listId)}
    ${_tvgpDotEditable(w.tvgp_promoter, 'P', w.id, listId)}
  </td>`;
}

async function cycleTvgp(itemId, listId, field, currentVal) {
  const cycle = { '': 'G', G: 'Y', Y: 'R', R: '' };
  const nextVal = (cycle[currentVal] !== undefined) ? cycle[currentVal] : 'G';
  await fetch(`${_wlApiBase(listId)}/${itemId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [field]: nextVal || null })
  });
  await fetchData();
  renderTab();
}

function _wlDateCell(w, listId) {
  const safeId   = w.id.replace(/'/g, "\\'");
  const safeList = listId.replace(/'/g, "\\'");
  const isoDate  = w.added_date || '';
  return `<td class="t-faint" data-date="${isoDate}"
    style="font-size:12px;cursor:pointer;white-space:nowrap;
           border-bottom:1px dashed transparent;transition:border-color .15s"
    onmouseover="this.style.borderBottomColor='var(--border)'"
    onmouseout="this.style.borderBottomColor='transparent'"
    onclick="editWlDate('${safeId}','${safeList}',this)">${isoDate || '—'}</td>`;
}

async function editWlDate(itemId, listId, cell) {
  if (cell.querySelector('input')) return;
  const currentDate = cell.dataset.date || '';
  const orig = cell.innerHTML;
  cell.innerHTML = `<input type="date" value="${currentDate}"
    style="background:var(--surface2);border:1px solid var(--accent);border-radius:4px;
           color:var(--text);font-size:11px;padding:2px 4px;width:115px" />`;
  const input = cell.querySelector('input');
  input.focus();
  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newDate = input.value;
    if (!newDate || newDate === currentDate) { cell.innerHTML = orig; return; }
    cell.innerHTML = '<span style="font-size:10px;color:var(--text-faint)">…</span>';
    try {
      // Find ticker for this item so we can fetch the historical price
      const allLists = ['watchlist','us_watchlist',...(state.settings?.watchlist_groups||[]).map(g=>g.id)];
      let ticker = null;
      for (const lid of allLists) {
        const item = (state[lid]||[]).find(x => x.id === itemId);
        if (item) { ticker = item.ticker; break; }
      }

      // Fetch historical close on the new date (non-blocking fallback if it fails)
      const updates = { added_date: newDate };
      if (ticker) {
        try {
          const qRes  = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}&on=${newDate}`);
          const qData = await qRes.json();
          if (qData.price) updates.added_price = qData.price;
        } catch { /* ignore — date save still proceeds */ }
      }

      await fetch(`${_wlApiBase(listId)}/${itemId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      await fetchData();
      renderTab();
    } catch(e) { cell.innerHTML = orig; }
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { committed = true; cell.innerHTML = orig; }
    if (e.key === 'Enter')  input.blur();
  });
}

function _convBadge(conviction) {
  if (!conviction) return '<span class="t-faint">—</span>';
  const colors = { High: '#34d399', Medium: '#f59e0b', Low: '#94a3b8' };
  const c = colors[conviction] || '#94a3b8';
  return `<span style="font-size:11px;font-weight:600;color:${c};border:1px solid ${c}44;padding:1px 6px;border-radius:4px">${conviction}</span>`;
}
let US_ACCTS  = ['us_vibhanshu', 'us_manjari', 'us_huf'];
let INR_ACCTS = ['vibhanshu', 'manjari', 'huf', 'manjbhawna'];
const SECTOR_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
  '#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6',
  '#6366f1','#fb923c','#f472b6','#a78bfa','#34d399','#60a5fa','#94a3b8',
  '#e879f9','#2dd4bf','#fbbf24','#7dd3fc',
];

// ─── Portfolio classification ─────────────────────────────────────────────────
const GOLD_SECTORS = new Set([
  'Gold Commodity ETF', 'Silver Commodity ETF',
  'Gold Miners', 'Silver Miners', 'Gold Financiers',
  'Gold/Silver ETF', 'Precious Metals',
]);
const COMMODITY_METALS_TICKERS = new Set(['COPX', 'URNM', 'REMX']);

function classifyPortfolio(p) {
  const rawTicker = (p.ticker || '').replace(/^(NSE:|BSE:)/, '').toUpperCase().trim();
  if (COMMODITY_METALS_TICKERS.has(rawTicker)) return 'commodity';
  if (GOLD_SECTORS.has(p.sector || ''))        return 'gold';
  return 'equity';
}

// Sectors that collapse into a single pie slice (individual names still show in the table)
const PIE_GROUPS = {
  'Metals':               'Commodities',
  'Precious Metals':      'Commodities',
  'Gold/Silver ETF':      'Commodities',
  'Commodities':          'Commodities',
  'Energy':               'Electrification Theme',
  'Electrification Theme':'Electrification Theme',
  'Alternative Energy':   'Electrification Theme',
};

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function init() {
  document.getElementById('theme-btn').textContent =
    document.documentElement.dataset.theme === 'dark' ? '🌙' : '☀️';

  await fetchData();
  buildSectorDatalist();
  await loadTechnicals();
  loadAnalysisStatuses();        // fire-and-forget
  silentBackfillAddedPrices();   // fire-and-forget: fills missing added_price from history
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab))
  );
}

let stockscans   = {};   // ticker → { date, count, scan_names, popular_scans }
let livePrices      = {};   // orig ticker → latest cmp (refreshed by Fetch Prices)
let liveMarketCaps  = {};   // orig ticker → market cap integer (refreshed with prices)
let _lastFetchTs = '';   // time string of last successful price fetch
let _ttsBtn      = null; // button currently showing ⏹ (active TTS)

function speakNotes(rawText, btn) {
  // Toggle off if same button tapped again or something else is speaking
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    if (_ttsBtn) { _ttsBtn.textContent = '🔊'; _ttsBtn.title = 'Listen'; }
    if (_ttsBtn === btn) { _ttsBtn = null; return; }
  }
  // Strip soic markers, HTML tags, excess whitespace
  const clean = rawText
    .replace(/soic:\d+/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return;

  const utt  = new SpeechSynthesisUtterance(clean);
  utt.rate   = 0.92;
  utt.lang   = 'en-IN';
  const done = () => {
    if (_ttsBtn) { _ttsBtn.textContent = '🔊'; _ttsBtn.title = 'Listen'; }
    _ttsBtn = null;
  };
  utt.onend  = done;
  utt.onerror = done;

  _ttsBtn = btn;
  btn.textContent = '⏹';
  btn.title = 'Stop';
  window.speechSynthesis.speak(utt);
}

function _ttsBtn_html(notesEscaped) {
  return `<button data-notes="${notesEscaped}" onclick="event.stopPropagation();speakNotes(this.dataset.notes,this)" title="Listen"
    style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--text-faint);padding:1px 3px;line-height:1;opacity:.5"
    onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.5'">🔊</button>`;
}

async function fetchData() {
  const [dataRes, navRes, scansRes] = await Promise.all([
    fetch('/api/data'), fetch('/api/aif_nav'), fetch('/api/stockscans')
  ]);
  state = await dataRes.json();
  state.aifNav       = await navRes.json();
  stockscans         = await scansRes.json().catch(() => ({}));
  state.us_watchlist  = state.us_watchlist  || [];
  // Ensure all custom watchlist arrays are initialised
  (state.settings?.watchlist_groups || []).forEach(g => { state[g.id] = state[g.id] || []; });
  // Sync currentWatchlistTab to first group if not yet valid (but preserve virtual tabs like '_overlap')
  const _wg = state.settings?.watchlist_groups || [];
  if (_wg.length && currentWatchlistTab !== '_overlap' && !_wg.find(g => g.id === currentWatchlistTab)) currentWatchlistTab = _wg[0].id;
  state.mutual_funds  = state.mutual_funds  || [];
  state.fixed_income  = state.fixed_income  || [];
  state.unlisted      = state.unlisted      || [];
  state.capital_transferred = state.capital_transferred || {};
  state.nps                 = state.nps                 || [];
  state.sold_positions      = state.sold_positions      || [];
  state.market_dashboards   = state.market_dashboards   || [];
  state.scorer_reports      = state.scorer_reports      || [];
  state.diary               = state.diary               || {};
  // Derive consolidated account lists from portfolio_groups (consolidated !== false)
  const _pg = state.settings?.portfolio_groups || {};
  INR_ACCTS = (_pg.indian || []).filter(p => p.consolidated !== false).map(p => p.id);
  US_ACCTS  = (_pg.us     || []).filter(p => p.consolidated !== false).map(p => p.id);
  if (!INR_ACCTS.length) INR_ACCTS = ['vibhanshu', 'manjari', 'huf', 'manjbhawna']; // fallback
  // Also fetch scorer reports
  fetch('/api/scorer/reports').then(r=>r.json()).then(r => { state.scorer_reports = r; }).catch(()=>{});
  // update journal tab badge
  const jbtn = document.getElementById('journal-tab-btn');
  if (jbtn) {
    const n = (state.sold_positions || []).length;
    jbtn.textContent = n ? `📓 Journal (${n})` : '📓 Journal';
  }
  document.getElementById('risk-pct').value  = state.settings.portfolio_risk_pct ?? 1.0;
  renderHeader();
  renderTab();
}

function aifLatestNav() {
  const nav = state.aifNav || [];
  if (!nav.length) return 0;
  return nav[nav.length - 1].value;   // already sorted ascending by month from backend
}

// ─── Header summary ───────────────────────────────────────────────────────────
function renderHeader() {
  const pos         = state.positions;
  const aifVal      = aifLatestNav();
  const aifInvested = state.settings.aif_invested || 0;

  // Other Assets totals
  const mfs   = state.mutual_funds  || [];
  const npss  = state.nps           || [];
  const fis   = state.fixed_income  || [];
  const uls   = state.unlisted      || [];
  const mfVal  = mfs.reduce((s, m) => s + (m.units && m.nav ? m.units * m.nav : 0), 0);
  const mfInv  = mfs.reduce((s, m) => s + (m.total_invested || 0), 0);
  const npsVal = npss.reduce((s, n) => s + (n.current_value || 0), 0);
  const npsInv = npss.reduce((s, n) => s + (n.total_invested || 0), 0);
  const fiVal  = fis.reduce((s, f) => s + (f._computed_value || f.principal || 0), 0);
  const fiInv  = fis.reduce((s, f) => s + (f.principal || 0), 0);
  const ulVal  = uls.reduce((s, u) => s + (u.current_valuation || u.invested_amount || 0), 0);
  const ulInv  = uls.reduce((s, u) => s + (u.invested_amount || 0), 0);
  const otherVal = mfVal + npsVal + fiVal + ulVal;
  const otherInv = mfInv + npsInv + fiInv + ulInv;

  const totalInv = sum(pos, p => p.invested_inr) + aifInvested + otherInv;
  const totalVal = sum(pos, p => p.current_value_inr) + aifVal + otherVal;
  const pnl    = totalVal - totalInv;
  const pnlPct = totalInv > 0 ? (pnl / totalInv) * 100 : 0;
  const pnlClass = pnl >= 0 ? 't-pos' : 't-neg';
  const pnlSign  = pnl >= 0 ? '+' : '';

  const pnlChipCls = pnl >= 0 ? 'hdr-chip-pos' : 'hdr-chip-neg';
  const cb2 = state.cash_balances || {};
  const cash2 = (cb2.vibhanshu||0)+(cb2.manjari||0)+(cb2.huf||0)+(cb2.manjbhawna||0);
  const totalCapital2 = totalVal + cash2;
  const cashPct2 = totalCapital2 > 0 ? (cash2/totalCapital2*100).toFixed(1) : '0.0';

  document.getElementById('hdr-summary').innerHTML = `
    <div class="hdr-chip-hero" title="Total portfolio value across all accounts">
      <span class="chip-label">Total Portfolio</span>
      <span class="chip-val">${fmt(totalVal)}</span>
    </div>
    <div class="hdr-chip ${pnlChipCls}">
      <span class="chip-label">Total P&amp;L</span>
      <span class="chip-val">${pnlSign}${fmt(pnl)}</span>
    </div>
    <div class="hdr-chip ${pnlChipCls}">
      <span class="chip-label">Return</span>
      <span class="chip-val">${pnlSign}${pnlPct.toFixed(1)}%</span>
    </div>
    <div class="hdr-chip">
      <span class="chip-label">Invested</span>
      <span class="chip-val t-muted">${fmt(totalInv)}</span>
    </div>
    ${aifVal > 0 ? `<div class="hdr-chip" style="border-color:rgba(99,102,241,.3);background:rgba(99,102,241,.06);cursor:pointer" onclick="switchTab('aif')">
      <span class="chip-label">AIF · NAV</span>
      <span class="chip-val t-blue">${fmt(aifVal)}</span>
    </div>` : ''}
    ${otherVal > 0 ? `<div class="hdr-chip" style="border-color:rgba(6,182,212,.25);background:rgba(6,182,212,.05);cursor:pointer" onclick="switchTab('other_assets')">
      <span class="chip-label">Other Assets</span>
      <span class="chip-val" style="color:#06b6d4">${fmt(otherVal)}</span>
    </div>` : ''}
    ${cash2 > 0 ? `<div class="hdr-chip" style="border-color:rgba(245,158,11,.25);background:rgba(245,158,11,.05);cursor:pointer" onclick="switchTab('cash')">
      <span class="chip-label">Cash · ${cashPct2}%</span>
      <span class="chip-val glow-gold">${fmt(cash2)}</span>
    </div>` : ''}
  `;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function _indianAccounts() {
  const pg = state.settings?.portfolio_groups?.indian || [];
  return pg.length ? pg.map(p => p.id) : ['vibhanshu', 'manjari', 'huf', 'manjbhawna'];
}

function _usAccounts() {
  const pg = state.settings?.portfolio_groups?.us || [];
  return pg.map(p => p.id);
}

function _wlIds() {
  return (state.settings?.watchlist_groups || []).map(w => w.id);
}

function switchTab(tab) {
  // Stop any in-progress TTS when navigating away
  if (window.speechSynthesis?.speaking) {
    window.speechSynthesis.cancel();
    if (_ttsBtn) { _ttsBtn.textContent = '🔊'; _ttsBtn.title = 'Listen'; _ttsBtn = null; }
  }
  if (_indianAccounts().includes(tab)) { currentIndianTab = tab; currentRegion = 'indian'; tab = 'portfolio'; }
  if (_usAccounts().includes(tab))    { currentUSTab = tab;     currentRegion = 'us';     tab = 'portfolio'; }
  if (tab === 'indian')               { currentRegion = 'indian'; tab = 'portfolio'; }
  if (tab === 'us')                   { currentRegion = 'us';     tab = 'portfolio'; }
  if (_wlIds().includes(tab) && tab !== 'watchlist') { currentWatchlistTab = tab; currentWatchlistRegion = _wlRegionOf(tab); tab = 'watchlist'; }
  if (tab === 'us_watchlist') { currentWatchlistTab = 'us_watchlist'; currentWatchlistRegion = 'international'; tab = 'watchlist'; }
  currentTab = tab;
  sortKey = null;
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  if (tab === 'alpha' && !alphaData) loadAlpha().then(() => renderTab());
  else if (tab === 'tax' && !taxData) loadTax().then(() => renderTab());
  else renderTab();
}

function toggleIyerCol() {
  iyerExpanded = !iyerExpanded;
  renderTab();
}

// ─── Portfolio group management ───────────────────────────────────────────────
async function _portfolioGroupAction(group, id, name, extra = {}) {
  const url    = id ? `/api/portfolio-groups/${group}/${id}` : `/api/portfolio-groups/${group}`;
  const method = id ? 'PATCH' : 'POST';
  const res    = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify({name, ...extra}) });
  if (!res.ok) { alert((await res.json()).detail || 'Error'); return; }
  await fetchData();
  renderTab();
}

function openAddPortfolioModal_indian() { _openAddPortfolioModal('indian'); }
function openAddPortfolioModal_us()     { _openAddPortfolioModal('us'); }

function _openAddPortfolioModal(group) {
  const existing = document.getElementById('add-portfolio-modal');
  if (existing) existing.remove();
  const html = `
  <div id="add-portfolio-modal" onclick="if(event.target===this)this.remove()"
    style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center">
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:24px;width:340px;box-shadow:0 20px 60px rgba(0,0,0,.4)">
      <div style="font-size:14px;font-weight:700;color:var(--text-strong);margin-bottom:20px">Add Portfolio</div>

      <label style="font-size:11px;color:var(--text-faint);display:block;margin-bottom:6px;letter-spacing:.05em">NAME</label>
      <input id="add-port-name" placeholder="e.g. Arya"
        style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box;margin-bottom:16px"
        onkeydown="if(event.key==='Enter')_submitAddPortfolio('${group}')">

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:20px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <div style="font-size:13px;color:var(--text-strong);font-weight:600">Include in Consolidated</div>
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px">Count these trades in total portfolio numbers and allocation</div>
          </div>
          <div id="add-port-toggle" onclick="_togglePortConsolidated()"
            style="flex-shrink:0;width:40px;height:22px;background:var(--accent);border-radius:22px;cursor:pointer;position:relative;transition:background .2s">
            <div id="add-port-knob" style="position:absolute;top:3px;left:3px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .2s;transform:translateX(18px)"></div>
          </div>
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="document.getElementById('add-portfolio-modal').remove()"
          style="padding:8px 16px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);font-size:13px;cursor:pointer">Cancel</button>
        <button onclick="_submitAddPortfolio('${group}')"
          style="padding:8px 16px;background:var(--accent);border:none;border-radius:6px;color:#fff;font-size:13px;font-weight:600;cursor:pointer">Add</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  setTimeout(() => document.getElementById('add-port-name')?.focus(), 50);
}

let _addPortConsolidated = true;
function _togglePortConsolidated() {
  _addPortConsolidated = !_addPortConsolidated;
  document.getElementById('add-port-toggle').style.background = _addPortConsolidated ? 'var(--accent)' : 'var(--border)';
  document.getElementById('add-port-knob').style.transform    = _addPortConsolidated ? 'translateX(18px)' : 'translateX(0)';
}
async function _submitAddPortfolio(group) {
  const name = document.getElementById('add-port-name')?.value.trim();
  if (!name) { document.getElementById('add-port-name')?.focus(); return; }
  const consolidated = _addPortConsolidated;
  document.getElementById('add-portfolio-modal').remove();
  _addPortConsolidated = true; // reset for next open
  await _portfolioGroupAction(group, null, name, { consolidated });
}
function openRenamePortfolioModal_indian(id, name) { _openNameModal('Rename Portfolio', name, n => _portfolioGroupAction('indian', id, n)); }
function openRenamePortfolioModal_us(id, name)     { _openNameModal('Rename Portfolio', name, n => _portfolioGroupAction('us',     id, n)); }
function openDeletePortfolioModal_indian(id, name) { _confirmDelete(`Remove portfolio "${name}"? Positions remain in the data but the tab will be hidden.`, () => _deletePortfolioGroup('indian', id)); }
function openDeletePortfolioModal_us(id, name) {
  if (id === 'us_consolidated') return;
  _confirmDelete(`Remove portfolio "${name}"? Positions remain in the data but the tab will be hidden.`, () => _deletePortfolioGroup('us', id));
}

async function _deletePortfolioGroup(group, id) {
  const res = await fetch(`/api/portfolio-groups/${group}/${id}`, { method: 'DELETE' });
  if (!res.ok) { alert((await res.json()).detail || 'Error'); return; }
  if (currentIndianTab === id) currentIndianTab = 'vibhanshu';
  if (currentUSTab === id)     currentUSTab = 'us_consolidated';
  await fetchData();
  renderTab();
}

// ─── Watchlist group management ───────────────────────────────────────────────
async function _watchlistGroupAction(id, name) {
  const url    = id ? `/api/watchlist-groups/${id}` : '/api/watchlist-groups';
  const method = id ? 'PATCH' : 'POST';
  const body   = id ? { name } : { name, region: currentWatchlistRegion };
  const res    = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!res.ok) { alert((await res.json()).detail || 'Error'); return; }
  await fetchData();
  if (!id) {
    const created = await res.clone().json().catch(() => null);
    if (created?.id) currentWatchlistTab = created.id;
  }
  renderTab();
}

function openAddWatchlistModal()            { _openNameModal('New Watchlist',      '',   n => _watchlistGroupAction(null, n)); }
function openRenameWatchlistModal(id, name) { _openNameModal('Rename Watchlist', name, n => _watchlistGroupAction(id,   n)); }
function openDeleteWatchlistModal(id, name) {
  const isBuiltIn = id === 'watchlist' || id === 'us_watchlist';
  const warn = isBuiltIn ? ' This is a built-in list and cannot be deleted.' : '';
  if (isBuiltIn) { alert(`"${name}" is a built-in watchlist and cannot be removed.`); return; }
  _confirmDelete(`Remove watchlist "${name}"? All items in it will be lost.`, async () => {
    const res = await fetch(`/api/watchlist-groups/${id}`, { method: 'DELETE' });
    if (!res.ok) { alert((await res.json()).detail || 'Error'); return; }
    const groups = state.settings?.watchlist_groups || [];
    currentWatchlistTab = groups.find(g => g.id !== id)?.id || 'watchlist';
    await fetchData();
    renderTab();
  });
}

// ─── Generic confirm-delete modal ────────────────────────────────────────────
function _confirmDelete(message, onConfirm) {
  const existing = document.getElementById('_confirm-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = '_confirm-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:var(--overlay);z-index:9999;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border2);border-radius:14px;padding:28px 32px;min-width:320px;max-width:420px;box-shadow:0 20px 60px #0008">
      <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#ef4444">Remove</div>
      <div style="font-size:13px;line-height:1.6" class="t-muted">${esc(message)}</div>
      <div style="display:flex;gap:10px;margin-top:20px;justify-content:flex-end">
        <button class="btn btn-ghost" onclick="document.getElementById('_confirm-modal-overlay').remove()">Cancel</button>
        <button class="btn btn-red" id="_confirm-modal-ok">Remove</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('_confirm-modal-ok').onclick = () => { overlay.remove(); onConfirm(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ─── Generic name input modal ─────────────────────────────────────────────────
function _openNameModal(title, initialValue, onConfirm) {
  const existing = document.getElementById('_name-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = '_name-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:var(--overlay);z-index:9999;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border2);border-radius:14px;padding:28px 32px;min-width:320px;box-shadow:0 20px 60px #0008">
      <div style="font-size:15px;font-weight:700;margin-bottom:18px" class="t-strong">${esc(title)}</div>
      <input id="_name-modal-input" type="text" value="${esc(initialValue)}"
             style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--border2);background:var(--input-bg);color:var(--text-strong);font-size:14px;outline:none"
             placeholder="Name..." />
      <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end">
        <button class="btn btn-ghost" onclick="document.getElementById('_name-modal-overlay').remove()">Cancel</button>
        <button class="btn" id="_name-modal-confirm">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input = document.getElementById('_name-modal-input');
  input.focus();
  input.select();

  const doConfirm = () => {
    const val = input.value.trim();
    if (!val) { input.focus(); return; }
    overlay.remove();
    onConfirm(val);
  };
  document.getElementById('_name-modal-confirm').onclick = doConfirm;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doConfirm(); if (e.key === 'Escape') overlay.remove(); });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}


function switchIndianTab(account) {
  currentIndianTab = account;
  sortKey = null;
  renderTab();
}

function switchUSTab(account) {
  currentUSTab = account;
  sortKey = null;
  renderTab();
}

function switchWatchlistTab(id) {
  currentWatchlistTab = id;
  if (id !== '_overlap') currentWatchlistRegion = _wlRegionOf(id);
  wlSortKey = null; wlSortDir = -1;
  renderTab();
}

function switchWatchlistRegion(region) {
  currentWatchlistRegion = region;
  const allGroups = state.settings?.watchlist_groups || [];
  const regionGroups = allGroups.filter(g => _wlRegionOf(g.id) === region);
  // Reset to first real tab if current tab doesn't belong to the new region
  // (_overlap is always reset so clicking a region pill always lands on the main list)
  if (!regionGroups.find(g => g.id === currentWatchlistTab)) {
    currentWatchlistTab = regionGroups[0]?.id || (region === 'india' ? 'watchlist' : 'us_watchlist');
  }
  renderTab();
}

function _animateRows() {
  document.querySelectorAll('.tbl tbody tr').forEach((tr, i) => {
    tr.classList.remove('row-animate');
    tr.style.animationDelay = `${i * 22}ms`;
    void tr.offsetWidth; // reflow
    tr.classList.add('row-animate');
  });
}

function renderTab() {
  const el = document.getElementById('tab-content');
  // Re-trigger fade-up animation on tab switch
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  if (currentTab === 'watchlist')         { el.innerHTML = renderWatchlistHub();     return; }
  if (currentTab === 'sectors')           { el.innerHTML = renderSectors();          return; }
  if (currentTab === 'portfolio')         { el.innerHTML = renderPortfolioTab();     _animateRows(); return; }
  // legacy deep-links still work
  if (currentTab === 'us')               { currentTab = 'portfolio'; currentRegion = 'us';     el.innerHTML = renderPortfolioTab(); _animateRows(); return; }
  if (currentTab === 'indian')           { currentTab = 'portfolio'; currentRegion = 'indian'; el.innerHTML = renderPortfolioTab(); _animateRows(); return; }
  if (currentTab === 'aif')              { el.innerHTML = renderAIF();              return; }
  if (currentTab === 'other_assets')     { el.innerHTML = renderOtherAssets();      return; }
  if (currentTab === 'cash')             { el.innerHTML = renderCash();             return; }
  if (currentTab === 'journal')          { el.innerHTML = renderJournal();          return; }
  if (currentTab === 'alpha')            { el.innerHTML = renderAlpha();           return; }
  if (currentTab === 'tax')             { el.innerHTML = renderTax();             return; }
  if (currentTab === 'market_dashboards'){ el.innerHTML = renderMarketDashboards(); return; }
  if (currentTab === 'diary')           { el.innerHTML = renderDiary(); if (!_diaryLoaded) _loadDiary(); return; }

  let positions;
  if (currentTab === 'consolidated') positions = state.positions.filter(p => INR_ACCTS.includes(p.account));
  else                               positions = state.positions.filter(p => p.account === currentTab);

  const isCon = currentTab === 'consolidated';
  el.innerHTML = renderSummaryCards(positions, currentTab)
               + renderTable(positions, currentTab)
               + (isCon ? renderIyerExplainer(positions) : '');
  _animateRows();
}

// ─── Indian Portfolio sub-tabs ───────────────────────────────────────────────
const _INDIAN_SUB_TABS = [
  { id: 'vibhanshu',  label: 'Vibhanshu' },
  { id: 'manjari',    label: 'Manjari'   },
  { id: 'huf',        label: 'HUF'       },
  { id: 'manjbhawna', label: 'Manj/Bhawna' },
];

function _subTabBar(tabs, activeId, onSwitch, onAdd, onRename, onDelete) {
  return `<div class="sub-tab-bar">
    ${tabs.map(t => {
      const isActive   = activeId === t.id;
      const showManage = isActive && !t.noManage && (onRename || onDelete);
      const sep = t.separator
        ? `<div style="width:1px;background:var(--border);align-self:stretch;margin:6px 6px 0"></div>`
        : '';
      return sep + `<div class="sub-tab-item ${isActive ? 'active' : ''}">
        <button class="sub-tab-btn ${isActive ? 'active' : ''}"
                onclick="${onSwitch}('${t.id}')">${t.name}</button>
        ${showManage ? `<button class="sub-tab-manage" onclick="openTabManageModal('${t.id}','${esc(t.name)}','${onRename||''}','${onDelete||''}')" title="Manage">⚙</button>` : ''}
      </div>`;
    }).join('')}
    <button class="sub-tab-add" onclick="${onAdd}()">+ Add</button>
  </div>`;
}

function openTabManageModal(id, name, onRename, onDelete) {
  const existing = document.getElementById('tab-manage-modal');
  if (existing) existing.remove();
  const close = "document.getElementById('tab-manage-modal').remove();";
  const html = `
  <div id="tab-manage-modal" onclick="if(event.target===this)this.remove()" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center">
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:8px;width:200px;box-shadow:0 12px 40px rgba(0,0,0,.35)">
      <div style="font-size:11px;color:var(--text-faint);padding:8px 12px 6px;font-weight:600;letter-spacing:.05em;text-transform:uppercase">${esc(name)}</div>
      ${onRename ? `<button onclick="${close}${onRename}('${id}','${esc(name)}')"
        style="display:block;width:100%;padding:9px 14px;border:none;background:none;text-align:left;font-size:13px;color:var(--text-muted);cursor:pointer;border-radius:6px"
        onmouseover="this.style.background='var(--row-hover)';this.style.color='var(--text)'"
        onmouseout="this.style.background='none';this.style.color='var(--text-muted)'">Rename</button>` : ''}
      ${onDelete ? `<button onclick="${close}${onDelete}('${id}','${esc(name)}')"
        style="display:block;width:100%;padding:9px 14px;border:none;background:none;text-align:left;font-size:13px;color:#f87171;cursor:pointer;border-radius:6px"
        onmouseover="this.style.background='rgba(239,68,68,.1)'"
        onmouseout="this.style.background='none'">Remove tab</button>` : ''}
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ─── Portfolio hub: region pill + nested account tabs ────────────────────────
function switchRegion(region) {
  currentRegion = region;
  renderTab();
}

function renderPortfolioTab() {
  const regionBar = `
    <div class="region-switcher">
      <button class="region-pill${currentRegion === 'indian' ? ' active' : ''}"
              onclick="switchRegion('indian')">🇮🇳 India</button>
      <button class="region-pill${currentRegion === 'us' ? ' active' : ''}"
              onclick="switchRegion('us')">🇺🇸 US</button>
    </div>`;

  if (currentRegion === 'us') return regionBar + _renderUSTabContent();
  return regionBar + _renderIndianTabContent();
}

function renderIndianTab() { return _renderIndianTabContent(); }
function renderUSTab()    { return _renderUSTabContent(); }

function _isNonConsolidated(group, tabId) {
  const pg = state.settings?.portfolio_groups?.[group] || [];
  const entry = pg.find(p => p.id === tabId);
  return entry?.consolidated === false;
}

function _renderIndianTabContent() {
  const tabs = state.settings?.portfolio_groups?.indian || _INDIAN_SUB_TABS.map(t => ({id:t.id, name:t.label}));
  const bar  = _subTabBar(tabs, currentIndianTab, 'switchIndianTab', 'openAddPortfolioModal_indian', 'openRenamePortfolioModal_indian', 'openDeletePortfolioModal_indian');

  if (!tabs.find(t => t.id === currentIndianTab)) currentIndianTab = tabs[0]?.id || 'vibhanshu';

  const positions  = state.positions.filter(p => p.account === currentIndianTab);
  const nonCon     = _isNonConsolidated('indian', currentIndianTab);
  const extras     = nonCon
    ? renderSectorPieChart(positions) + renderPortfolioCashCard(currentIndianTab)
    : '';
  return bar
    + renderSummaryCards(positions, currentIndianTab)
    + renderTable(positions, currentIndianTab)
    + extras;
}

function _renderUSTabContent() {
  const portfolios = state.settings?.portfolio_groups?.us || [
    {id:'us_vibhanshu', name:'Vibhanshu'}, {id:'us_manjari', name:'Manjari'}, {id:'us_huf', name:'HUF'}
  ];
  const allTabs = [{id:'us_consolidated', name:'Consolidated'}, ...portfolios];

  if (!allTabs.find(t => t.id === currentUSTab)) currentUSTab = 'us_consolidated';

  const bar = _subTabBar(allTabs, currentUSTab, 'switchUSTab', 'openAddPortfolioModal_us', 'openRenamePortfolioModal_us', 'openDeletePortfolioModal_us');

  if (currentUSTab === 'us_consolidated') {
    const allIds    = portfolios.map(p => p.id);
    const positions = state.positions.filter(p => allIds.includes(p.account));
    return bar
      + renderSummaryCards(positions, 'us')
      + renderUSCapitalSection(null, allIds)
      + renderTable(positions, 'us_con');
  }

  // Individual portfolio sub-tab
  const positions = state.positions.filter(p => p.account === currentUSTab);
  const nonCon    = _isNonConsolidated('us', currentUSTab);
  const addBtn = `<div class="flex justify-end mb-3">
    <button class="btn btn-blue text-xs" onclick="openAdd('${currentUSTab}')">+ Add US Stock</button>
  </div>`;
  return bar
    + addBtn
    + renderSummaryCards(positions, 'us')
    + renderUSCapitalSection(null, [currentUSTab])
    + renderTable(positions, 'us')
    + (nonCon ? renderSectorPieChart(positions, true) : '');
}

function renderSectorPieChart(positions, isUS = false) {
  const rate = state.settings?.usd_inr_rate || 84;
  // group by sector, weighted by current value in INR
  const map = {};
  for (const p of positions) {
    const sector = (p.sector || 'Other').trim() || 'Other';
    const val    = isUS
      ? (p.current_value || 0) * rate
      : (p.current_value_inr || p.current_value || 0);
    map[sector] = (map[sector] || 0) + val;
  }
  const total = Object.values(map).reduce((a, b) => a + b, 0);
  if (!total || Object.keys(map).length === 0) return '';

  const sectors = Object.entries(map)
    .map(([name, val]) => ({ name, val, pct: val / total * 100 }))
    .sort((a, b) => b.val - a.val);

  // SVG donut
  const cx = 110, cy = 110, R = 88, ri = 52;
  let angle = -Math.PI / 2;
  const paths = sectors.map((s, i) => {
    const color  = SECTOR_COLORS[i % SECTOR_COLORS.length];
    const sweep  = s.pct / 100 * 2 * Math.PI;
    const end    = angle + sweep;
    const large  = sweep > Math.PI ? 1 : 0;
    const x1 = cx + R  * Math.cos(angle), y1 = cy + R  * Math.sin(angle);
    const x2 = cx + R  * Math.cos(end),   y2 = cy + R  * Math.sin(end);
    const xi1= cx + ri * Math.cos(angle), yi1= cy + ri * Math.sin(angle);
    const xi2= cx + ri * Math.cos(end),   yi2= cy + ri * Math.sin(end);
    const d  = `M${x1},${y1} A${R},${R} 0 ${large},1 ${x2},${y2} L${xi2},${yi2} A${ri},${ri} 0 ${large},0 ${xi1},${yi1}Z`;
    angle = end;
    return `<path d="${d}" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`;
  }).join('');

  const legend = sectors.map((s, i) => {
    const color = SECTOR_COLORS[i % SECTOR_COLORS.length];
    const warn  = s.pct > 30 ? ' ⚠️' : s.pct > 20 ? ' ▲' : '';
    const wclr  = s.pct > 30 ? '#f87171' : s.pct > 20 ? '#f59e0b' : 'var(--text-strong)';
    return `<div style="display:flex;align-items:center;gap:7px;padding:4px 0;border-bottom:1px solid var(--border)">
      <div style="width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0"></div>
      <div style="font-size:12px;color:var(--text-muted);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</div>
      <div style="font-size:12px;font-weight:700;color:${wclr};white-space:nowrap">${s.pct.toFixed(1)}%${warn}</div>
    </div>`;
  }).join('');

  return `
  <div style="padding:20px 20px 32px;border-top:1px solid var(--border);margin-top:8px">
    <div style="font-size:13px;font-weight:700;color:var(--text-strong);margin-bottom:4px">Sector Allocation</div>
    <div style="font-size:11px;color:var(--text-faint);margin-bottom:16px">⚠️ &gt;30% · ▲ &gt;20% concentration warning</div>
    <div style="display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap">
      <svg width="220" height="220" viewBox="0 0 220 220" style="flex-shrink:0">
        ${paths}
      </svg>
      <div style="flex:1;min-width:180px">${legend}</div>
    </div>
  </div>`;
}

function renderPortfolioCashCard(accountId) {
  const cb       = state.cash_balances || {};
  const cash     = cb[accountId] || 0;
  const pg       = state.settings?.portfolio_groups?.indian || [];
  const entry    = pg.find(p => p.id === accountId);
  const name     = entry?.name || accountId;
  const positions = state.positions.filter(p => p.account === accountId);
  const portVal  = positions.reduce((s, p) => s + (p.current_value_inr || p.current_value || 0), 0);
  const total    = portVal + cash;
  const cashPct  = total > 0 ? (cash / total * 100) : 0;
  const cashClr  = cashPct < 5 ? 'var(--neg)' : cashPct > 30 ? '#f59e0b' : 'var(--pos)';

  return `
  <div style="padding:20px;border-top:1px solid var(--border);margin-top:0">
    <div style="font-size:13px;font-weight:700;color:var(--text-strong);margin-bottom:12px">Cash Position — ${esc(name)}</div>
    <div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">
      <div>
        <div style="font-size:11px;color:var(--text-faint);margin-bottom:4px">Cash Balance (₹)</div>
        <input id="pcash-${accountId}" type="text"
          value="${cash ? cash.toLocaleString('en-IN') : ''}"
          placeholder="0"
          style="font-family:'JetBrains Mono',monospace;font-size:13px;text-align:right;width:160px"
          oninput="recalcPortfolioCash('${accountId}')">
      </div>
      <div id="pcash-stats-${accountId}" style="font-size:12px;color:var(--text-muted)">
        ${cash > 0 ? `<span style="color:var(--text-faint)">Portfolio:</span> <strong>${fmt(portVal)}</strong>
        &nbsp;·&nbsp; <span style="color:var(--text-faint)">Total:</span> <strong>${fmt(total)}</strong>
        &nbsp;·&nbsp; <span style="color:${cashClr};font-weight:700">${cashPct.toFixed(1)}% cash</span>` : ''}
      </div>
      <button onclick="savePortfolioCash('${accountId}')" class="btn btn-blue text-xs" style="height:34px">Save Cash</button>
      <span id="pcash-msg-${accountId}" style="font-size:11px;color:var(--pos);min-width:60px"></span>
    </div>
  </div>`;
}

function recalcPortfolioCash(accountId) {
  const inp      = document.getElementById('pcash-' + accountId);
  const statsEl  = document.getElementById('pcash-stats-' + accountId);
  if (!inp || !statsEl) return;
  const cash     = parseRupees(inp.value || '0');
  const positions = state.positions.filter(p => p.account === accountId);
  const portVal  = positions.reduce((s, p) => s + (p.current_value_inr || p.current_value || 0), 0);
  const total    = portVal + cash;
  const cashPct  = total > 0 ? (cash / total * 100) : 0;
  const cashClr  = cashPct < 5 ? 'var(--neg)' : cashPct > 30 ? '#f59e0b' : 'var(--pos)';
  statsEl.innerHTML = cash > 0
    ? `<span style="color:var(--text-faint)">Portfolio:</span> <strong>${fmt(portVal)}</strong>
       &nbsp;·&nbsp; <span style="color:var(--text-faint)">Total:</span> <strong>${fmt(total)}</strong>
       &nbsp;·&nbsp; <span style="color:${cashClr};font-weight:700">${cashPct.toFixed(1)}% cash</span>`
    : '';
}

async function savePortfolioCash(accountId) {
  const inp  = document.getElementById('pcash-' + accountId);
  const msgEl = document.getElementById('pcash-msg-' + accountId);
  if (!inp) return;
  const cash = parseRupees(inp.value || '0');
  // Merge with existing balances so we don't overwrite other accounts
  const existing = { ...(state.cash_balances || {}) };
  existing[accountId] = cash;
  const res = await fetch('/api/cash_balances', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(existing),
  });
  if (res.ok) {
    if (msgEl) { msgEl.textContent = '✓ Saved'; setTimeout(() => { if (msgEl) msgEl.textContent = ''; }, 2000); }
    await fetchData();
  } else {
    if (msgEl) { msgEl.style.color = 'var(--neg)'; msgEl.textContent = '✕ Failed'; }
  }
}



function renderWatchlistHub() {
  const allGroups = state.settings?.watchlist_groups ||
                   [{id:'watchlist', name:'India - MyResearch'}, {id:'us_watchlist', name:'US - MyResearch'}];

  // Sync region from current tab in case state drifted
  if (currentWatchlistTab && currentWatchlistTab !== '_overlap') currentWatchlistRegion = _wlRegionOf(currentWatchlistTab);

  const regionGroups = allGroups.filter(g => _wlRegionOf(g.id) === currentWatchlistRegion);

  // Ensure currentWatchlistTab belongs to the active region (ignore '_overlap' — it's always valid)
  if (currentWatchlistTab !== '_overlap' && !regionGroups.find(g => g.id === currentWatchlistTab)) {
    currentWatchlistTab = regionGroups[0]?.id || 'watchlist';
  }

  const regionBar = `
    <div class="region-switcher">
      <button class="region-pill${currentWatchlistRegion === 'india' ? ' active' : ''}"
              onclick="switchWatchlistRegion('india')">🇮🇳 India</button>
      <button class="region-pill${currentWatchlistRegion === 'international' ? ' active' : ''}"
              onclick="switchWatchlistRegion('international')">🌐 International</button>
    </div>`;

  // Append Overlap as a visually separated last tab in the sub-tab-bar
  const tabsForBar = [
    ...regionGroups,
    { id: '_overlap', name: '⊕ Overlap', noManage: true, separator: true }
  ];
  const bar = _subTabBar(tabsForBar, currentWatchlistTab, 'switchWatchlistTab', 'openAddWatchlistModal', 'openRenameWatchlistModal', 'openDeleteWatchlistModal');

  if (currentWatchlistTab === '_overlap')     return regionBar + bar + renderOverlapTab();
  if (currentWatchlistTab === 'us_watchlist') return regionBar + bar + renderUSWatchlist();
  if (currentWatchlistTab === 'top_ideas')    return regionBar + bar + renderTopIdeas();
  return regionBar + bar + renderWatchlistById(currentWatchlistTab);
}

function renderOverlapTab() {
  const region = currentWatchlistRegion;
  const allGroups = state.settings?.watchlist_groups || [];

  // Collect all list IDs for this region — exclude built-ins from custom to prevent duplicates
  const _INDIA_BUILTINS = ['watchlist', 'soic_research'];
  const _INTL_BUILTINS  = ['us_watchlist'];
  let listIds;
  if (region === 'india') {
    const customIndia = allGroups
      .filter(g => _wlRegionOf(g.id) === 'india' && !_INDIA_BUILTINS.includes(g.id))
      .map(g => g.id);
    listIds = [..._INDIA_BUILTINS, ...customIndia];
  } else {
    const customIntl = allGroups
      .filter(g => _wlRegionOf(g.id) === 'international' && !_INTL_BUILTINS.includes(g.id))
      .map(g => g.id);
    listIds = [..._INTL_BUILTINS, ...customIntl];
  }

  // Map listId → display name
  const listName = id => {
    if (id === 'watchlist')    return 'My Research';
    if (id === 'us_watchlist') return 'US Research';
    if (id === 'soic_research') return 'SOIC Research';
    return allGroups.find(g => g.id === id)?.name || id;
  };

  // Build ticker → { item, itemsPerList, lists[] } map
  const tickerMap = {};
  for (const lid of listIds) {
    const items = lid === 'watchlist' ? (state.watchlist || []) : (state[lid] || []);
    for (const w of items) {
      const tk = w.ticker || '';
      if (!tk) continue;
      if (!tickerMap[tk]) tickerMap[tk] = { item: w, itemsPerList: {}, lists: [] };
      if (!tickerMap[tk].lists.includes(lid)) {
        tickerMap[tk].lists.push(lid);
        tickerMap[tk].itemsPerList[lid] = w;
      }
    }
  }

  // Keep only tickers in 2+ lists
  const overlaps = Object.values(tickerMap)
    .filter(v => v.lists.length >= 2)
    .sort((a, b) => b.lists.length - a.lists.length || (a.item.stock_name||'').localeCompare(b.item.stock_name||''));

  // Helper: combined notes + research for all lists this ticker appears in
  const combinedNotes = (itemsPerList, lists) => {
    const sections = lists.map(lid => {
      const w = itemsPerList[lid];
      if (!w) return null;
      const notesText = (w.notes || '').trim();
      const hasNotes = !!notesText;
      const hasLinks = (w.research_links && w.research_links.trim()) || w.dashboard_url;
      if (!hasNotes && !hasLinks) return null;
      const lname = listName(lid);
      let inner = '';
      if (hasNotes) {
        inner += `<div style="margin-top:4px;background:var(--surface2);border-left:2px solid var(--accent)55;border-radius:0 4px 4px 0;padding:5px 8px;font-size:11px;color:var(--text-muted);line-height:1.55;white-space:pre-wrap">${_linkifyNotes(notesText)}</div>`;
      }
      if (hasLinks) {
        inner += `<div style="margin-top:5px">${_renderResearchLinks(w, { collapsible: true })}</div>`;
      }
      return `<div style="margin-bottom:6px">
        <button onclick="const nb=this.closest('div').querySelector('.ol-body');nb.style.display=nb.style.display==='none'?'block':'none';this.querySelector('.cn-icon').textContent=nb.style.display==='none'?'▶':'▼'"
          style="background:none;border:none;padding:0;cursor:pointer;display:flex;align-items:center;gap:4px">
          <span class="cn-icon" style="font-size:9px;color:var(--text-faint)">▶</span>
          <span style="font-size:9px;color:var(--accent);font-weight:600;text-transform:uppercase;letter-spacing:.05em">${esc(lname)}</span>
        </button>
        <div class="ol-body" style="display:none">${inner}</div>
      </div>`;
    }).filter(Boolean);
    if (!sections.length) return '<span class="t-faint" style="font-size:11px">—</span>';
    return `<div style="display:flex;flex-direction:column">${sections.join('')}</div>`;
  };

  if (overlaps.length === 0) {
    return `<div style="text-align:center;padding:60px 0;color:var(--text-faint);font-size:13px">
      No overlaps yet — a stock appears here when it's in 2 or more ${region === 'india' ? 'India' : 'International'} watchlists.
    </div>`;
  }

  const rows = overlaps.map(({ item: w, itemsPerList, lists }) => {
    const ticker = w.ticker || '';
    const isIndian = _isIndianTicker(ticker);
    const stockUrl = isIndian
      ? `https://www.stockscans.in/company/${ticker.replace(/\s+/g, '')}`
      : `https://www.perplexity.ai/finance/${ticker.replace(/^[A-Z]+:/i, '')}`;
    const listPills = lists.map(lid =>
      `<span style="background:var(--accent)22;color:var(--accent);border:1px solid var(--accent)44;
        border-radius:12px;padding:2px 9px;font-size:10px;white-space:nowrap">${esc(listName(lid))}</span>`
    ).join('');
    return `<tr class="hover:bg-row-hover" style="border-bottom:1px solid var(--border)">
      <td style="padding:10px 12px;font-weight:600;color:var(--text-strong)">${esc(w.stock_name||ticker)}</td>
      <td style="padding:10px 12px;font-family:'JetBrains Mono',monospace;font-size:12px">
        <a href="${stockUrl}" target="_blank" style="color:var(--accent);text-decoration:none">${esc(ticker)}</a>
      </td>
      <td style="padding:10px 12px;text-align:center">
        <span style="background:var(--surface2);border-radius:12px;padding:2px 10px;font-size:12px;font-weight:700;color:var(--text-strong)">${lists.length}</span>
      </td>
      <td style="padding:10px 12px">
        <div style="display:flex;gap:5px;flex-wrap:wrap">${listPills}</div>
      </td>
      <td style="padding:10px 12px;color:var(--text-muted);font-size:12px">${w.sector||'—'}</td>
      <td style="padding:10px 12px;font-size:12px;max-width:260px">${combinedNotes(itemsPerList, lists)}</td>
    </tr>`;
  }).join('');

  return `
  <div style="padding:4px 0 0">
    <div style="font-size:11px;color:var(--text-faint);margin-bottom:12px">
      ${overlaps.length} stock${overlaps.length!==1?'s':''} appear in multiple ${region === 'india' ? '🇮🇳 India' : '🌐 International'} watchlists
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="border-bottom:2px solid var(--border)">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Stock</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Ticker</th>
          <th style="padding:8px 12px;text-align:center;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em"># Lists</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Appears In</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Sector</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Research & Notes</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function renderWatchlistById(id) {
  // Always route through renderWatchlist/renderUSWatchlist but with state[id] injected
  const wl = (id === 'watchlist') ? state.watchlist : (state[id] || []);
  const lbl = (state.settings?.watchlist_groups || []).find(g => g.id === id)?.name || id;
  const addBtn = `<button class="btn btn-blue text-xs" onclick="openWlAdd('${id}')">+ Add to ${esc(lbl)}</button>`;

  if (!wl.length) return `<div class="flex justify-end mb-3">${addBtn}</div>
    <div class="t-faint text-center py-12">No items yet — add the first one above.</div>`;

  // All international-region lists use the intl renderer (with signals vs S&P 500)
  if (_INTL_WL_IDS.has(id) || _wlRegionOf(id) === 'international') return _renderIntlWatchlist(id, wl, addBtn);

  // Temporarily swap state so renderWatchlist picks up the right items
  const saved = state.watchlist;
  state.watchlist = wl;
  // Patch delete and edit calls to include listId
  const html = renderWatchlist(id, addBtn);
  state.watchlist = saved;
  return html;
}

function _renderIntlWatchlist(listId, wl, addBtn) {
  const showExtraCols = _INTL_WL_IDS.has(listId);
  const colCount = 9 + (showExtraCols ? 3 : 0);
  const rows = _sortWl(wl).map(w => {
    const safeId   = w.id.replace(/'/g, "\\'");
    const ticker   = w.ticker || '';
    const yhLink   = `https://www.perplexity.ai/finance/${encodeURIComponent(ticker)}`;
    const exchange = _extractExchange(w);
    const t        = technicals[ticker] || null;
    const tJson    = JSON.stringify(t || null).replace(/&/g,'&amp;').replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/"/g,'&quot;');

    // Market cap: prefer live (current session) → stored numeric (last refresh) → manual string
    const liveMc    = liveMarketCaps[ticker];
    const storedNum = w.market_cap_live;
    const mcNum     = liveMc ?? storedNum ?? null;
    const mcFmt     = mcNum ? fmtMktCap(mcNum) : null;
    const mcIsLive  = liveMc != null;
    const mcHtml = mcFmt
      ? `<span style="font-size:12px;font-weight:500${mcIsLive ? '' : ';color:var(--text-faint)'}">${mcFmt}</span>`
      : (w.market_cap ? `<span style="font-size:11px" class="t-faint">${esc(w.market_cap)}</span>` : '<span class="t-faint">—</span>');

    const resHtml = _renderResearchLinks(w, { collapsible: true });

    const extraCols = showExtraCols ? `
      <td>${mcHtml}</td>
      <td>${_convBadge(w.conviction)}</td>
      <td style="font-size:12px;color:var(--text-muted)">${esc(exchange)}</td>` : '';

    return `
    <tr>
      <td>
        <a href="${yhLink}" target="_blank" rel="noopener"
           style="font-weight:500;color:var(--text-strong);text-decoration:none;border-bottom:1px dotted var(--border)"
           onmouseover="this.style.color='#3b82f6'" onmouseout="this.style.color='var(--text-strong)'"
        >${esc(w.stock_name)}</a>
        <div style="font-size:10px" class="t-faint">${esc(ticker)}</div>
      </td>
      <td style="max-width:130px"><div style="white-space:normal;line-height:1.4">${w.sector ? `<span class="badge" style="white-space:normal;line-height:1.4;display:inline">${esc(w.sector)}</span>` : '<span class="t-faint">—</span>'}</div></td>
      ${extraCols}
      <td class="hoverable"
          onmouseenter="showUSEntryTooltip(event, ${tJson})"
          onmousemove="moveSigTooltip(event)"
          onmouseleave="hideSigTooltip()">${getEntryBadges(t)}</td>
      ${wlPriceCells(w, t)}
      <td>${resHtml}</td>
      ${_wlDateCell(w, listId)}
      <td style="font-size:12px;max-width:180px">${inlineCollapsibleNotes(w.notes)}</td>
      <td>
        <div class="flex gap-1">
          ${_wlMoveSelect(w.id, listId)}
          <button class="btn btn-ghost text-xs py-1 px-2" onclick="editWl('${safeId}','${listId}')">✎</button>
          <button class="btn btn-red text-xs py-1 px-2" onclick="deleteWl('${safeId}','${listId}')">✕</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  const extraHeaders = showExtraCols ? `
    ${_wlTh('Mkt Cap',    'market_cap')}
    ${_wlTh('Conviction', 'conviction')}
    ${_wlTh('Exchange',   'exchange')}` : '';

  const safeListId = listId.replace(/'/g, "\\'");
  return `
    <div class="flex items-center gap-2 flex-wrap mb-3">
      <button class="btn btn-ghost text-xs" id="intl-wl-signals-btn"
              onclick="refreshIntlWatchlistSignals('${safeListId}')">⟳ Refresh Signals</button>
      <span class="text-xs t-faint">Fetches EMAs, RSI, ADX, Weinstein Stage vs S&amp;P 500</span>
      ${addBtn}
    </div>
    <div style="overflow-x:auto">
      <table class="tbl">
        <thead><tr>
          ${_wlTh('Stock',       'stock_name')}
          ${_wlTh('Industry',    'sector')}
          ${extraHeaders}
          <th class="text-left">Signals</th>
          ${_wlTh('CMP',         'cmp',     'right')}
          ${_wlTh('Since Added', 'pct_chg', 'right')}
          <th class="text-left">Research</th>
          ${_wlTh('Added',       'added_date')}
          <th class="text-left">Notes</th>
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${colCount}" class="text-center t-faint py-8">No items yet</td></tr>`}</tbody>
      </table>
    </div>`;
}

// ─── Top Ideas (stockscans.in proxy) ────────────────────────────────────────
// All company data is persisted server-side (data.json). This state is only
// in-memory; on first tab visit we load from cache, never from stockscans.in.
let _topIdeasState = {
  // null = not yet loaded from server cache; [] = loaded (may be empty)
  companies:      null,
  fetchedAt:      null,   // ISO string from server
  loggedIn:       null,   // null = unknown
  includePopular: true,
  loading:        false,
  refreshing:     false,  // true only when hitting stockscans.in
  error:          null,
  sort: { col: 'Scans', dir: 'desc' },
};

function renderTopIdeas() {
  // First visit: load status + cached data from server (no external call)
  if (_topIdeasState.loggedIn === null && !_topIdeasState.loading) {
    _topIdeasInit();
    return `<div class="ti-wrap"><div class="t-faint text-center py-12">Loading…</div></div>`;
  }
  if (_topIdeasState.loading) {
    return `<div class="ti-wrap"><div class="t-faint text-center py-12">Loading…</div></div>`;
  }

  // Show cached data even when logged out — just hide the refresh controls
  const hasCached = _topIdeasState.companies !== null && _topIdeasState.companies.length > 0;

  // If no cache and not logged in: show login
  if (!hasCached && !_topIdeasState.loggedIn) return _renderTopIdeasLogin();

  // If logged out but have cached data: show table + re-login prompt
  return _renderTopIdeasTable();
}

function _renderTopIdeasLogin(showAbove = false) {
  const loginHtml = `
  <div class="ti-login-card${showAbove ? ' ti-login-inline' : ''}">
    <div class="ti-login-title">Sign in to stockscans.in</div>
    <div class="ti-login-sub">Credentials sent only to stockscans.in — never stored here.</div>
    <div class="ti-login-form">
      <input id="ti-email" type="email" class="ti-input" placeholder="Email" autocomplete="email"/>
      <input id="ti-pass"  type="password" class="ti-input" placeholder="Password" autocomplete="current-password"/>
      <div id="ti-login-err" class="ti-err" style="display:none"></div>
      <button class="btn btn-blue ti-login-btn" onclick="_topIdeasLogin()">Sign in</button>
    </div>
  </div>`;
  if (showAbove) return loginHtml;
  return `<div class="ti-wrap">${loginHtml}</div>`;
}

function _fmtFetchedAt(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch { return iso; }
}

function _renderTopIdeasTable() {
  const cos = _topIdeasState.companies || [];
  const { col, dir } = _topIdeasState.sort;

  const sorted = [...cos].sort((a, b) => {
    let va = a[col], vb = b[col];
    if (col === 'Name' || col === 'Industry') {
      va = (va || '').toLowerCase(); vb = (vb || '').toLowerCase();
      return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    va = va ?? 0; vb = vb ?? 0;
    return dir === 'asc' ? va - vb : vb - va;
  });

  const th = (label, key) => {
    const active = col === key;
    const arrow  = active ? (dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th class="tbl-th${active ? ' ti-th-active' : ''}" onclick="_topIdeasSort('${key}')"
              style="cursor:pointer;white-space:nowrap">${label}${arrow}</th>`;
  };

  const fmtNum = (v, dec=0) => v == null ? '—' : Number(v).toLocaleString('en-IN', {maximumFractionDigits: dec});
  const fmtPct = v => v == null ? '—' : `<span style="color:${v>=0?'#34d399':'#f87171'}">${v>=0?'+':''}${Number(v).toFixed(2)}%</span>`;

  const rows = sorted.map(c => {
    const [exch, sym] = (c.companyId || ':').split(':');
    const exchBadge = `<span class="ti-exch-badge ti-exch-${(exch||'').toLowerCase()}">${esc(exch||'')}</span>`;
    const scLink = `https://www.stockscans.in/company/${encodeURIComponent(c.companyId||'')}`;
    return `<tr class="tbl-row">
      <td class="tbl-td">
        <a href="${scLink}" target="_blank" rel="noopener" class="ti-name-link">
          <div class="ti-name">${esc(c.Name||'')}</div>
          <div class="ti-sym">${exchBadge} ${esc(sym||c.companyId||'')}</div>
        </a>
      </td>
      <td class="tbl-td t-faint text-xs">${esc(c.Industry||'—')}</td>
      <td class="tbl-td text-right font-mono text-xs">₹${fmtNum(c['Close Price'], 2)}</td>
      <td class="tbl-td text-right font-mono text-xs">${fmtPct(c['Returns 1D'])}</td>
      <td class="tbl-td text-right font-mono text-xs">${fmtPct(c['Returns 1W'])}</td>
      <td class="tbl-td text-right font-mono text-xs">${fmtNum(c['Market Capitalization'], 0)} Cr</td>
      <td class="tbl-td text-right">
        <span class="ti-scans-badge">${c.Scans ?? '—'}</span>
      </td>
    </tr>`;
  }).join('');

  const toggleLabel = _topIdeasState.includePopular ? 'Hide Popular Scans' : 'Include Popular Scans';
  const fetchedStr  = _fmtFetchedAt(_topIdeasState.fetchedAt);
  const tsHtml      = fetchedStr
    ? `<span class="ti-fetched-at">Data as of ${fetchedStr}</span>`
    : `<span class="ti-fetched-at t-faint">Never refreshed</span>`;
  const refreshing  = _topIdeasState.refreshing;

  const toolbarRight = _topIdeasState.loggedIn
    ? `<button class="btn btn-sm" onclick="_topIdeasTogglePopular()" ${refreshing?'disabled':''}>
         ${toggleLabel}
       </button>
       <button class="btn btn-sm${refreshing?' ti-refreshing':''}" onclick="_topIdeasRefresh()" ${refreshing?'disabled':''}>
         ${refreshing ? '↺ Refreshing…' : '↺ Refresh'}
       </button>
       <button class="btn btn-sm ti-logout-btn" onclick="_topIdeasLogout()">Log out</button>`
    : `<button class="btn btn-sm btn-blue" onclick="_topIdeasShowLogin()">Log in to refresh</button>`;

  const loginModal = _topIdeasState._showLogin ? _renderTopIdeasLogin(true) : '';
  const errHtml = _topIdeasState.error
    ? `<div class="ti-error">${esc(_topIdeasState.error)}
         <button class="btn btn-sm ml-3" onclick="_topIdeasRefresh()">Retry</button>
       </div>`
    : '';

  const emptyHtml = !cos.length
    ? `<div class="t-faint text-center py-8">No companies in cache. Click Refresh to load.</div>`
    : '';

  return `
  <div class="ti-wrap">
    ${loginModal}
    ${errHtml}
    <div class="ti-toolbar">
      <div class="ti-toolbar-left">
        ${tsHtml}
        ${cos.length ? `<span class="ti-count">${cos.length} companies</span>` : ''}
      </div>
      <div class="ti-toolbar-right">${toolbarRight}</div>
    </div>
    ${emptyHtml}
    ${cos.length ? `
    <div class="tbl-scroll">
      <table class="tbl">
        <thead><tr>
          ${th('Company', 'Name')}
          ${th('Industry', 'Industry')}
          ${th('CMP', 'Close Price')}
          ${th('1D %', 'Returns 1D')}
          ${th('1W %', 'Returns 1W')}
          ${th('Mkt Cap', 'Market Capitalization')}
          ${th('Scans', 'Scans')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : ''}
  </div>`;
}

// Load status + cached data in one shot (no stockscans.in call)
async function _topIdeasInit() {
  _topIdeasState.loading = true;
  try {
    const [statusRes, dataRes] = await Promise.all([
      fetch('/api/top-ideas/status'),
      fetch('/api/top-ideas/data'),
    ]);
    const status = await statusRes.json();
    const cache  = await dataRes.json();
    _topIdeasState.loggedIn       = status.logged_in;
    _topIdeasState.companies      = cache.companies || [];
    _topIdeasState.fetchedAt      = cache.fetched_at || null;
    _topIdeasState.includePopular = cache.include_popular ?? true;
  } catch(e) {
    _topIdeasState.loggedIn  = false;
    _topIdeasState.companies = [];
  }
  _topIdeasState.loading = false;
  renderTab();
}

async function _topIdeasLogin() {
  const email = document.getElementById('ti-email')?.value.trim();
  const pass  = document.getElementById('ti-pass')?.value;
  const errEl = document.getElementById('ti-login-err');
  if (!email || !pass) {
    if (errEl) { errEl.textContent = 'Email and password required'; errEl.style.display = ''; }
    return;
  }
  const btn = document.querySelector('.ti-login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  if (errEl) errEl.style.display = 'none';

  try {
    const r = await fetch('/api/top-ideas/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({email, password: pass}),
    });
    if (r.ok) {
      _topIdeasState.loggedIn   = true;
      _topIdeasState._showLogin = false;
      _topIdeasState.error      = null;
      renderTab();
    } else {
      const j = await r.json().catch(() => ({}));
      if (errEl) { errEl.textContent = j.detail || 'Login failed'; errEl.style.display = ''; }
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
    }
  } catch(e) {
    if (errEl) { errEl.textContent = 'Network error'; errEl.style.display = ''; }
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
  }
}

// Only called when user clicks Refresh — actually hits stockscans.in
async function _topIdeasRefresh() {
  if (_topIdeasState.refreshing) return;
  _topIdeasState.refreshing = true;
  _topIdeasState.error      = null;
  renderTab();
  try {
    const r = await fetch('/api/top-ideas/refresh', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({includePopular: _topIdeasState.includePopular}),
    });
    if (r.status === 401) {
      _topIdeasState.loggedIn = false;
      _topIdeasState.error    = 'Session expired — please log in again';
    } else if (r.ok) {
      const j = await r.json();
      _topIdeasState.companies = j.companies || [];
      _topIdeasState.fetchedAt = j.fetched_at || null;
    } else {
      const j = await r.json().catch(() => ({}));
      _topIdeasState.error = j.detail || 'Refresh failed';
    }
  } catch(e) {
    _topIdeasState.error = 'Network error — please try again';
  }
  _topIdeasState.refreshing = false;
  renderTab();
}

async function _topIdeasLogout() {
  await fetch('/api/top-ideas/logout', {method:'POST'}).catch(()=>{});
  _topIdeasState.loggedIn   = false;
  _topIdeasState._showLogin = false;
  // Keep companies + fetchedAt so cached data stays visible
  renderTab();
}

function _topIdeasShowLogin() {
  _topIdeasState._showLogin = !_topIdeasState._showLogin;
  renderTab();
}

function _topIdeasSort(col) {
  if (_topIdeasState.sort.col === col) {
    _topIdeasState.sort.dir = _topIdeasState.sort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    _topIdeasState.sort = { col, dir: col === 'Name' || col === 'Industry' ? 'asc' : 'desc' };
  }
  renderTab();
}

function _topIdeasTogglePopular() {
  _topIdeasState.includePopular = !_topIdeasState.includePopular;
  _topIdeasRefresh();
}

// ─── Capital Transferred card + timeline ─────────────────────────────────────
function renderCapitalCard(account, portfolioVal) {
  const ct        = state.capital_transferred || {};
  const entries   = ct[account] || [];
  const deposited = entries.filter(e => e.type !== 'withdrawal').reduce((s, e) => s + (e.amount || 0), 0);
  const withdrawn = entries.filter(e => e.type === 'withdrawal').reduce((s, e) => s + (e.amount || 0), 0);
  const netCapital = deposited - withdrawn;
  const gain      = portfolioVal - netCapital;
  const gainPct   = netCapital > 0 ? (gain / netCapital * 100) : null;
  const gainCol   = gain >= 0 ? '#34d399' : '#f87171';
  const gainSign  = gain >= 0 ? '+' : '';

  const timelineRows = entries.map(e => {
    const isW   = e.type === 'withdrawal';
    const dot   = isW ? '#f87171' : '#34d399';
    const arrow = isW ? '↑' : '↓';
    const arrowCol = isW ? '#f87171' : '#34d399';
    return `
    <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)">
      <div style="width:6px;height:6px;border-radius:50%;background:${dot};flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:600">
          <span style="color:${arrowCol}">${arrow}</span>
          <span style="color:var(--text-strong)"> ₹${Math.round(e.amount||0).toLocaleString('en-IN')}</span>
          <span style="font-size:10px;font-weight:400;color:${arrowCol};margin-left:3px">${isW ? 'withdrawal' : 'deposit'}</span>
        </div>
        <div style="font-size:10px;color:var(--text-faint)">${e.date || 'No date'}${e.note ? ' · '+esc(e.note) : ''}</div>
      </div>
      <button onclick="deleteCapitalEntry('${account}','${e.id}')" style="background:none;border:none;cursor:pointer;font-size:10px;color:var(--text-faint);padding:0 2px" title="Remove">✕</button>
    </div>`;
  }).join('');

  const addForm = `
    <div id="capital-add-${account}" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
      <div style="display:flex;flex-direction:column;gap:5px">
        <div style="display:flex;gap:4px">
          <button id="ct-type-dep-${account}" onclick="setCtType('${account}','deposit')"
            style="flex:1;background:#34d39922;border:1px solid #34d39955;color:#34d399;border-radius:4px;padding:4px 0;font-size:11px;font-weight:700;cursor:pointer">
            ↓ Deposit
          </button>
          <button id="ct-type-wdw-${account}" onclick="setCtType('${account}','withdrawal')"
            style="flex:1;background:transparent;border:1px solid var(--border);color:var(--text-faint);border-radius:4px;padding:4px 0;font-size:11px;font-weight:600;cursor:pointer">
            ↑ Withdrawal
          </button>
        </div>
        <input id="ct-amount-${account}" type="number" placeholder="Amount (₹)" min="0"
          style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 7px;color:var(--text-strong);font-size:12px;width:100%">
        <input id="ct-date-${account}" type="date"
          style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 7px;color:var(--text-strong);font-size:12px;width:100%">
        <input id="ct-note-${account}" type="text" placeholder="Note (optional)"
          style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 7px;color:var(--text-strong);font-size:12px;width:100%">
        <div style="display:flex;gap:4px">
          <button onclick="saveCapitalEntry('${account}')" style="flex:1;background:var(--accent)22;border:1px solid var(--accent)55;color:var(--accent);border-radius:4px;padding:3px 0;font-size:11px;font-weight:600;cursor:pointer">Save</button>
          <button onclick="document.getElementById('capital-add-${account}').style.display='none'" style="background:none;border:1px solid var(--border);color:var(--text-faint);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer">✕</button>
        </div>
      </div>
    </div>`;

  return `
    <div class="card min-w-[170px]" style="border-color:#a78bfa44;padding:10px 12px" id="capital-card-${account}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
        <span style="font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.4px">Net Capital</span>
        <button onclick="toggleCapitalTimeline('${account}')" style="background:none;border:none;cursor:pointer;font-size:10px;color:#a78bfa;padding:0" title="View timeline">▼ ${entries.length}</button>
      </div>
      <div style="font-size:17px;font-weight:700;color:#a78bfa">₹${fmtNum(netCapital)}</div>
      ${withdrawn > 0 ? `<div style="font-size:10px;color:var(--text-faint)">↓ ${fmtNum(deposited)} &nbsp;↑ ${fmtNum(withdrawn)}</div>` : ''}
      ${gainPct != null ? `<div style="font-size:10px;font-weight:600;color:${gainCol}">${gainSign}${gainPct.toFixed(1)}% on capital</div>` : ''}
      <div id="capital-timeline-${account}" style="display:none;margin-top:8px">
        ${timelineRows || '<div style="font-size:10px;color:var(--text-faint);padding:4px 0">No entries yet</div>'}
        <button onclick="openCapitalAdd('${account}')" style="margin-top:6px;width:100%;background:var(--accent)11;border:1px dashed var(--accent)55;color:var(--accent);border-radius:4px;padding:3px 0;font-size:11px;cursor:pointer">+ Add entry</button>
        ${addForm}
      </div>
    </div>`;
}

// track selected type per account
const _ctType = {};
function setCtType(account, type) {
  _ctType[account] = type;
  const depBtn = document.getElementById('ct-type-dep-' + account);
  const wdwBtn = document.getElementById('ct-type-wdw-' + account);
  if (type === 'deposit') {
    depBtn.style.cssText += ';background:#34d39922;border-color:#34d39955;color:#34d399;font-weight:700';
    wdwBtn.style.cssText += ';background:transparent;border-color:var(--border);color:var(--text-faint);font-weight:600';
  } else {
    wdwBtn.style.cssText += ';background:#f8717122;border-color:#f8717155;color:#f87171;font-weight:700';
    depBtn.style.cssText += ';background:transparent;border-color:var(--border);color:var(--text-faint);font-weight:600';
  }
}

function openCapitalAdd(account) {
  _ctType[account] = 'deposit';
  document.getElementById('capital-add-' + account).style.display = 'flex';
  document.getElementById('ct-amount-' + account)?.focus();
}

function toggleCapitalTimeline(account) {
  const tl = document.getElementById('capital-timeline-' + account);
  if (tl) tl.style.display = tl.style.display === 'none' ? 'block' : 'none';
}

async function saveCapitalEntry(account) {
  const amount = parseFloat(document.getElementById('ct-amount-' + account)?.value);
  if (isNaN(amount) || amount <= 0) return;
  const date = document.getElementById('ct-date-' + account)?.value || '';
  const note = document.getElementById('ct-note-' + account)?.value || '';
  const type = _ctType[account] || 'deposit';
  await fetch(`/api/capital_transferred/${account}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ amount, date, note, type })
  });
  await fetchData();
}

async function deleteCapitalEntry(account, id) {
  if (!confirm('Remove this entry?')) return;
  await fetch(`/api/capital_transferred/${account}/${id}`, { method: 'DELETE' });
  await fetchData();
}

// ─── Summary cards ────────────────────────────────────────────────────────────
function renderSummaryCards(positions, tab) {
  const isUS = tab === 'us';
  const cur = isUS ? '$' : '₹';
  // The "us" tab can now hold mixed currencies (USD/EUR/GBP/SGD/AUD), so raw
  // per-position amounts can't just be summed together. Always total via the
  // already-INR-converted fields, then (for the US/global tab only) re-express
  // that INR total in USD-equivalent terms so the display stays $-denominated
  // and unchanged for anyone with a pure-USD portfolio.
  const usdRate = state.settings?.usd_inr_rate || 84;
  const invInr = sum(positions, p => p.invested_inr);
  const valInr = sum(positions, p => p.current_value_inr);
  const inv = isUS ? invInr / usdRate : invInr;
  const val = isUS ? valInr / usdRate : valInr;
  const pnl = val - inv;
  const pnlPct = inv > 0 ? (pnl / inv) * 100 : 0;
  const pnlClass = pnl >= 0 ? 't-pos' : 't-neg';

  // CAGR from earliest buy date
  let cagrStr = '—', cagrClass = 't-neu';
  const dated = positions.filter(p => p.buy_date);
  if (dated.length) {
    const earliest = new Date(Math.min(...dated.map(p => new Date(p.buy_date))));
    const years = (Date.now() - earliest) / (365.25 * 864e5);
    if (years > 0.01 && inv > 0) {
      const c = ((val / inv) ** (1 / years) - 1) * 100;
      cagrStr = `<span class="pn">${c >= 0 ? '+' : ''}${c.toFixed(1)}%</span>`;
      cagrClass = c >= 0 ? 't-pos' : 't-neg';
    }
  }

  const defaultAcct = tab === 'us' ? 'us_vibhanshu' : tab === 'consolidated' ? 'vibhanshu' : tab;
  const isCon = tab === 'consolidated';

  const usdRateCard = isUS ? `
    <div class="card text-center min-w-[118px]">
      <div class="text-lg font-bold t-strong" id="usd-rate-display">₹${(state.settings.usd_inr_rate || 84).toFixed(1)}</div>
      <div class="text-xs t-faint mt-0.5 flex items-center justify-center gap-1">
        USD/INR
        <button class="btn btn-ghost text-xs py-0 px-1" onclick="fetchUsdRate()" id="fetch-rate-btn" title="Fetch live rate">⟳</button>
      </div>
    </div>` : '';

  // One rate card per non-USD currency actually held in this tab, so EUR/GBP/
  // SGD/AUD only show up once you actually have a position in that currency.
  const heldFxCurrencies = isUS
    ? GLOBAL_FX_CURRENCIES.filter(c => positions.some(p => p.currency === c))
    : [];
  const fxRateCards = heldFxCurrencies.map(c => {
    const rate = (state.settings?.fx_rates || {})[c];
    return `
    <div class="card text-center min-w-[118px]">
      <div class="text-lg font-bold t-strong" id="fx-rate-display-${c}">${rate != null ? '₹' + rate.toFixed(2) : '—'}</div>
      <div class="text-xs t-faint mt-0.5 flex items-center justify-center gap-1">
        ${c}/INR
        <button class="btn btn-ghost text-xs py-0 px-1" onclick="fetchFxRate('${c}')" title="Fetch live rate">⟳</button>
      </div>
    </div>`;
  }).join('');

  const signalsBtn = isCon ? `
    <button class="btn btn-ghost text-xs" onclick="refreshTechnicals()" id="signals-btn" title="Refresh EMA, RSI, Stage signals">⟳ Signals</button>` : '';

  const marketScanBtn = isCon ? `
    <a href="https://www.stockscans.in/market-scans/dashboard" target="_blank" rel="noopener"
       class="btn btn-ghost text-xs" title="Open Market Scans on stockscans.in">📡 Market Scan</a>` : '';

  return `
    <div class="flex items-center gap-3 flex-wrap mb-4">
      <div class="card text-center min-w-[118px]">
        <div class="text-lg font-bold t-strong">${fmtCur(val, isUS)}</div>
        <div class="text-xs t-faint mt-0.5">Current Value</div>
      </div>
      <div class="card text-center min-w-[118px]">
        <div class="text-lg font-bold t-muted">${fmtCur(inv, isUS)}</div>
        <div class="text-xs t-faint mt-0.5">Invested</div>
      </div>
      <div class="card text-center min-w-[118px]">
        <div class="text-lg font-bold ${pnlClass}">${fmtCur(pnl, isUS, true)}</div>
        <div class="text-xs t-faint mt-0.5">P&amp;L (<span class="pn">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</span>)</div>
      </div>
      <div class="card text-center min-w-[100px]">
        <div class="text-lg font-bold ${cagrClass}">${cagrStr}</div>
        <div class="text-xs t-faint mt-0.5">CAGR</div>
      </div>
      <div class="card text-center">
        <div class="text-lg font-bold t-strong">${isCon ? new Set(positions.map(p => normKey(p.ticker, p.stock_name))).size : positions.length}</div>
        <div class="text-xs t-faint mt-0.5">Holdings</div>
      </div>
      ${usdRateCard}
      ${fxRateCards}
      ${isCon ? (function(){
        const cb = state.cash_balances || {};
        const cash = (cb.vibhanshu||0)+(cb.manjari||0)+(cb.huf||0)+(cb.manjbhawna||0);
        const totalCapital = val + cash;
        const cashPct = totalCapital > 0 ? (cash/totalCapital*100).toFixed(1) : '0.0';
        const target = state.settings.target_cash_pct || 10;
        const targetCls = parseFloat(cashPct) < target ? 't-neg' : 't-pos';
        return `<div class="card text-center min-w-[110px]" style="border-color:#f59e0b44;cursor:pointer" onclick="switchTab('cash')" title="Manage cash in Cash & HUF tab">
          <div class="text-lg font-bold" style="color:#f59e0b">${fmt(cash)}</div>
          <div class="text-xs t-faint mt-0.5">Cash <span class="${targetCls}">${cashPct}%</span> <span class="t-faint">(tgt ${target}%)</span></div>
        </div>`;
      })() : ''}
      ${['vibhanshu','manjari','huf'].includes(tab) ? renderCapitalCard(tab, val) : ''}
      ${isCon ? (function(){
        const ct = state.capital_transferred || {};
        const inrAccts = ['vibhanshu','manjari','huf'];
        const acctLabels = { vibhanshu: 'Vibhanshu', manjari: 'Manjari', huf: 'HUF' };

        const breakdown = inrAccts.map(acct => {
          const entries = ct[acct] || [];
          const deposited = entries.filter(e=>e.type!=='withdrawal').reduce((a,e)=>a+(e.amount||0),0);
          const withdrawn = entries.filter(e=>e.type==='withdrawal').reduce((a,e)=>a+(e.amount||0),0);
          const net = deposited - withdrawn;
          return { acct, deposited, withdrawn, net, count: entries.length };
        });

        const netCap = breakdown.reduce((s, b) => s + b.net, 0);
        if (!netCap) return '';

        const gain     = val - netCap;
        const gainPct  = netCap > 0 ? (gain / netCap * 100) : null;
        const gainCol  = gain >= 0 ? '#34d399' : '#f87171';
        const gainSign = gain >= 0 ? '+' : '';

        const breakdownRows = breakdown.filter(b => b.net > 0).map(b => {
          const pct = netCap > 0 ? (b.net / netCap * 100).toFixed(1) : '0';
          return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)">
            <div style="width:6px;height:6px;border-radius:50%;background:#a78bfa;flex-shrink:0"></div>
            <div style="flex:1;font-size:11px;color:var(--text-strong);font-weight:500">${acctLabels[b.acct]}</div>
            <div style="font-size:11px;font-weight:600;color:#a78bfa">${fmt(b.net)}</div>
            <div style="font-size:10px;color:var(--text-faint);width:32px;text-align:right">${pct}%</div>
            ${b.withdrawn > 0 ? `<div style="font-size:9px;color:#f87171">↑${fmt(b.withdrawn)}</div>` : ''}
          </div>`;
        }).join('');

        return `<div class="card min-w-[150px]" style="border-color:#a78bfa44;padding:10px 12px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
            <span style="font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.4px">Net Capital</span>
            <button onclick="const bd=document.getElementById('con-cap-breakdown');bd.style.display=bd.style.display==='none'?'block':'none'"
              style="background:none;border:none;cursor:pointer;font-size:10px;color:#a78bfa;padding:0">▼</button>
          </div>
          <div style="font-size:17px;font-weight:700;color:#a78bfa">${fmt(netCap)}</div>
          ${gainPct != null ? `<div style="font-size:10px;font-weight:600;color:${gainCol}">${gainSign}${gainPct.toFixed(1)}% on capital</div>` : ''}
          <div id="con-cap-breakdown" style="display:none;margin-top:8px">
            ${breakdownRows}
            <div style="display:flex;justify-content:space-between;padding-top:5px;font-size:11px;border-top:1px solid var(--border);margin-top:2px">
              <span class="t-faint">Total</span>
              <span style="font-weight:700;color:#a78bfa">${fmt(netCap)}</span>
            </div>
          </div>
        </div>`;
      })() : ''}
      <div class="ml-auto flex gap-2">
        ${marketScanBtn}
        ${signalsBtn}
        <button class="btn btn-blue text-xs" onclick="openAdd('${defaultAcct}')">+ Add Stock</button>
      </div>
    </div>`;
}

// ─── Table ────────────────────────────────────────────────────────────────────
function renderTable(positions, tab) {
  const isCon   = tab === 'consolidated';
  const isUSCon = tab === 'us_con';          // consolidated US (Vib + Manj merged)
  const isUS    = tab === 'us' || isUSCon;
  // The "us"/global tab can hold mixed currencies now, so a single header-level
  // symbol would be misleading — leave it blank there and rely on each row's
  // own currency symbol instead (see the trs cells below).
  const cur     = isUS ? '' : '₹';

  const headers = [
    { k: 'stock_name', l: 'Stock' },
    { k: 'sector',     l: 'Sector' },
    { k: 'avg_buy_price', l: `Avg Buy ${cur}`.trim() },
    { k: 'quantity',   l: 'Qty' },
    { k: 'cmp',        l: `CMP ${cur}`.trim() },
    { k: 'invested',   l: `Invested ${cur}`.trim() },
    { k: 'current_value', l: `Value ${cur}`.trim() },
    { k: 'pnl',        l: `P&L ${cur}`.trim() },
    { k: 'pnl_pct',   l: 'P&L %' },
    { k: 'cagr', l: 'CAGR' },
    ...(isCon ? [
      { k: 'buy_date',  l: 'Buy Date' },
      { k: 'pe',        l: 'PE' },
      ...(iyerExpanded ? [{ k: 'iyer_exit', l: 'Iyer Exit ₹' }] : []),
      { k: 'technicals', l: 'Technicals' },
      { k: 'sell_call',  l: `Sell Call <button onclick="event.stopPropagation();toggleIyerCol()" title="${iyerExpanded ? 'Hide Iyer Exit column' : 'Show Iyer Exit price'}" style="background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.3);color:var(--accent);border-radius:4px;padding:1px 5px;font-size:9px;font-weight:700;cursor:pointer;margin-left:4px;vertical-align:middle">${iyerExpanded ? '📐−' : '📐+'}</button>` },
    ] : []),
    { k: 'alloc',  l: `Alloc% <span onclick="allocMode=allocMode==='current'?'invested':'current';render()" style="cursor:pointer;display:inline-flex;gap:2px;vertical-align:middle;margin-left:4px" title="Toggle cost vs value allocation">${['current','invested'].map(m=>`<span style="padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;background:${allocMode===m?'rgba(59,130,246,0.2)':'transparent'};color:${allocMode===m?'#60a5fa':'var(--text-faint)'};border:1px solid ${allocMode===m?'#3b82f6':'var(--border)'}">${m==='current'?'Val':'Cost'}</span>`).join('')}</span>` },
    ...((isCon || isUSCon) ? [{ k: 'accounts', l: 'Accounts' }] : []),
    { k: '_actions', l: '' },
  ];

  const grouped  = isCon    ? groupConsolidated(positions)
                 : isUSCon  ? groupUS(positions)
                 : positions.map(p => ({...p, _accounts: [p.account]}));
  // Allocation % must always be computed on a common-currency basis — the "us"
  // tab can mix USD/EUR/GBP/SGD/AUD, so this uses the INR-converted fields
  // regardless of tab (unlike the native-currency `inv`/`val` used for display
  // further down in `trs`, which intentionally stays per-position).
  const totalInv = sum(grouped, p => p.invested_inr);
  const totalVal = sum(grouped, p => p.current_value_inr);
  const withAlloc = grouped.map(p => {
    const inv = p.invested_inr;
    const val = p.current_value_inr;
    return {
      ...p,
      alloc_invested: totalInv > 0 ? (inv / totalInv) * 100 : 0,
      alloc_current:  totalVal > 0 ? (val / totalVal) * 100 : 0,
      alloc: allocMode === 'current'
        ? (totalVal > 0 ? (val / totalVal) * 100 : 0)
        : (totalInv > 0 ? (inv / totalInv) * 100 : 0),
    };
  });
  const sorted = sortPositions(withAlloc);

  // Iyer Exit Price: computed once per render using total portfolio value (INR accounts only)
  const riskPct      = parseFloat(state.settings.portfolio_risk_pct ?? 1.0);
  const totalPortVal = sum(state.positions.filter(p => INR_ACCTS.includes(p.account)), p => p.current_value_inr);
  const riskAmount   = totalPortVal * (riskPct / 100); // ₹ at risk per position

  const ths = headers.map(h =>
    h.k === '_actions'
      ? '<th></th>'
      : h.k.startsWith('_')
        ? `<th class="text-left">${h.l}</th>`
        : `<th class="sort-th text-left" onclick="sortBy('${h.k}')">${h.l}${sortKey === h.k ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}</th>`
  ).join('');

  const trs = sorted.map(p => {
    const inv    = isUS ? p.invested      : p.invested_inr;
    const val    = isUS ? p.current_value : p.current_value_inr;
    const pnl    = val - inv;
    const pnlPct = inv > 0 ? (pnl / inv) * 100 : 0;
    const alloc  = p.alloc ?? 0;
    const cgrv   = p.cagr;

    // Iyer Exit Price (consolidated only)
    const peak     = p.peak_price || Math.max(p.avg_buy_price || 0, p.cmp || 0);
    const iyerExit = (isCon && p.quantity > 0) ? (peak - (riskAmount / p.quantity)) : null;
    const isSell   = iyerExit !== null && p.cmp != null && p.cmp < iyerExit;

    const pnlCls  = pnl  >= 0 ? 't-pos' : 't-neg';
    const cagrCls = cgrv !== null ? (cgrv >= 0 ? 't-pos' : 't-neg') : 't-neu';

    // safe JSON for onclick (avoid XSS via escaping)
    const safeJson = JSON.stringify(p).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    const tJson = JSON.stringify(technicals[p.ticker] || null).replace(/&/g,'&amp;').replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/"/g,'&quot;');

    return `<tr>
      <td>
        ${_stockLink(p.ticker, p.stock_name)}
        <div style="font-size:10px" class="t-faint">${esc(p.ticker)}</div>
        ${p.conviction ? `<div style="font-size:10px" class="t-yellow">⭐ ${p.conviction}</div>` : ''}
        ${(function(){
          const tc = (p.trades||[]).length;
          const ac = (p._accounts||[]).length;
          const lbl = tc + ' trade' + (tc !== 1 ? 's' : '') + (ac > 1 ? ' (' + ac + ' accts)' : '');
          return '<button onclick="toggleTradesRow(\'' + p.id + '\')" style="background:none;border:none;cursor:pointer;font-size:9px;color:var(--text-faint);padding:0;margin-top:2px" title="Show trades">▶ ' + lbl + '</button>';
        })()}
      </td>
      <td>${p.sector ? `<span class="badge">${esc(p.sector)}</span>` : `<span class="t-faint" style="font-size:11px">—</span>`}</td>
      <td class="text-right">${isUS
        ? `<span class="pn t-faint" style="font-size:10px">${curSym(p.currency)}</span>${num(p.avg_buy_price)}`
        : num(p.avg_buy_price)}</td>
      <td class="text-right">${num(p.quantity, isUS ? 4 : 0)}</td>
      <td class="text-right">
        ${isUS ? `<span class="pn t-faint" style="font-size:10px">${curSym(p.currency)}</span>` : ''}
        <input class="inline-edit" type="number" value="${p.cmp ? p.cmp.toFixed(2) : ''}"
               onblur="updateCmp('${p.id}', this.value)" title="Edit CMP">
      </td>
      <td class="text-right t-muted">${fmtCur(inv, isUS, false, isUS ? p.currency : undefined)}</td>
      <td class="text-right t-strong font-medium">${fmtCur(val, isUS, false, isUS ? p.currency : undefined)}</td>
      <td class="text-right ${pnlCls}" style="${pnlBg(pnlPct)}padding:9px 12px;font-weight:600">${fmtCur(pnl, isUS, true, isUS ? p.currency : undefined)}</td>
      <td class="text-right ${pnlCls}" style="${pnlBg(pnlPct)}padding:9px 12px;font-weight:700">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</td>
      <td class="text-right ${cagrCls}" style="${cgrv !== null ? pnlBg(cgrv) : ''}padding:9px 12px">${cgrv !== null ? `<span class="pn">${(cgrv >= 0 ? '+' : '') + cgrv.toFixed(1)}%</span>` : '—'}</td>
      ${isCon ? `
        <td class="t-muted" style="font-size:12px">${p.buy_date ? p.buy_date.slice(0,7) : '—'}</td>
        <td class="text-right t-muted">${p.pe ? p.pe.toFixed(1) : '—'}</td>
        ${iyerExpanded ? `
        <td class="text-right font-semibold"
            style="${isSell ? 'background:rgba(220,38,38,0.15);color:#f87171;border-radius:4px;padding:4px 8px;' : ''}">
          ${iyerExit !== null ? `${num(iyerExit)}${isSell ? ' 🔴' : ''}` : '—'}
        </td>` : ''}
        <td style="cursor:pointer;user-select:none" onclick="toggleSigRow('${p.id}')">
          ${getTechCell(p.cmp, technicals[p.ticker], p.id)}
        </td>
        <td style="cursor:pointer;user-select:none" onclick="toggleSigRow('${p.id}')">
          ${getSellCell(p.cmp, iyerExit, technicals[p.ticker])}
        </td>
      ` : ''}
      <td class="text-right" style="white-space:nowrap">
        <span style="font-weight:600;color:var(--text-strong)">${alloc.toFixed(1)}%</span>
        <div style="font-size:10px;color:var(--text-faint);margin-top:1px">
          ${allocMode === 'current'
            ? `cost ${(p.alloc_invested??0).toFixed(1)}%`
            : `val ${(p.alloc_current??0).toFixed(1)}%`}
        </div>
      </td>
      ${(isCon || isUSCon) ? `<td style="font-size:12px" class="t-faint">${(p._accounts || []).map(a => ACCT_LABELS[a] || a).join(', ')}</td>` : ''}
      <td>
        <div class="flex gap-1">
          <button class="btn btn-ghost text-xs py-1 px-2" onclick="openEditById('${p.id}')">✏️</button>
          <button class="btn btn-ghost text-xs py-1 px-2" style="color:#f87171;border-color:#f8717133" onclick="openSellModal('${p.id}','${esc(p.stock_name)}',${p.cmp||p.avg_buy_price},${p.quantity})" title="Sell & Archive">📤</button>
          <button class="btn btn-ghost text-xs py-1 px-2" style="color:#f87171;border-color:#f8717133" onclick="deletePos('${p.id}')" title="Delete Position">🗑️</button>
        </div>
      </td>
    </tr>
    <tr id="trades-row-${p.id}" style="display:none">
      <td colspan="20" style="padding:0 0 0 24px;background:var(--bg2);border-bottom:1px solid var(--border)">
        ${renderTradesPanel(p, isCon || isUSCon, isUS)}
      </td>
    </tr>
    ${isCon ? `<tr id="sig-row-${p.id}" style="display:none">
      <td colspan="20" style="padding:0;border-bottom:2px solid var(--border2)">
        ${getSigPanel(p.cmp, iyerExit, technicals[p.ticker], p.ticker)}
      </td>
    </tr>` : ''}`;
  }).join('');

  return `
    <div style="overflow-x:auto">
      <table class="tbl">
        <thead><tr>${ths}</tr></thead>
        <tbody>${trs || `<tr><td colspan="20" class="text-center t-faint py-8">No positions</td></tr>`}</tbody>
      </table>
    </div>`;
}

// ─── Consolidation ────────────────────────────────────────────────────────────
function normKey(ticker, name) {
  // Strip exchange prefix (NSE:, BSE:) and suffix (.NS, .BO) for grouping
  const t = (ticker || '').replace(/^(nse:|bse:)\s*/i, '').replace(/\.(ns|bo)$/i, '').trim().toLowerCase();
  return t || (name || '').toLowerCase();
}

function groupConsolidated(positions) {
  const map = new Map();
  for (const p of positions) {
    const key = normKey(p.ticker, p.stock_name);
    if (!map.has(key)) {
      // Tag each trade with its source account
      const taggedTrades = (p.trades || []).map(t => Object.assign({}, t, { _account: p.account }));
      map.set(key, { ...p, _accounts: [p.account], _mergedTrades: taggedTrades });
    } else {
      const g = map.get(key);
      const totalQty = g.quantity + p.quantity;
      g.avg_buy_price = (g.avg_buy_price * g.quantity + p.avg_buy_price * p.quantity) / totalQty;
      g.quantity      = totalQty;
      g.cmp           = g.cmp || p.cmp;
      g.invested      = g.avg_buy_price * g.quantity;
      g.invested_inr  = g.invested;
      g.current_value = (g.cmp || g.avg_buy_price) * g.quantity;
      g.current_value_inr = g.current_value;
      g._accounts.push(p.account);
      // Merge trades from this account
      const taggedTrades = (p.trades || []).map(t => Object.assign({}, t, { _account: p.account }));
      g._mergedTrades = g._mergedTrades.concat(taggedTrades);
      if (p.buy_date && (!g.buy_date || p.buy_date < g.buy_date)) g.buy_date = p.buy_date;
      if (!g.sector      && p.sector)        g.sector = p.sector;
      if (!g.max_price   && p.max_price)     g.max_price = p.max_price;
      if (!g.pe          && p.pe)            g.pe = p.pe;
      if (!g.allowed_price && p.allowed_price) g.allowed_price = p.allowed_price;
    }
  }
  return Array.from(map.values()).map(g => {
    // Replace trades with merged+sorted array (newest first)
    g._mergedTrades.sort((a, b) => (b.date || '') > (a.date || '') ? 1 : -1);
    g.trades = g._mergedTrades;
    g.cagr = calcCagr(g.invested_inr, g.current_value_inr, g.buy_date);
    return g;
  });
}

function calcCagr(inv, val, dateStr) {
  if (!dateStr || !inv || inv <= 0 || !val) return null;
  const years = (Date.now() - new Date(dateStr)) / (365.25 * 864e5);
  if (years < 0.003) return null;
  return ((val / inv) ** (1 / years) - 1) * 100;
}

// ─── US grouping helper ───────────────────────────────────────────────────────
function groupUS(positions) {
  const map = new Map();
  for (const p of positions) {
    const key = normKey(p.ticker, p.stock_name).toUpperCase();
    if (!map.has(key)) {
      const taggedTrades = (p.trades || []).map(t => Object.assign({}, t, { _account: p.account }));
      map.set(key, { ...p, _accounts: [p.account], _mergedTrades: taggedTrades });
    } else {
      const g       = map.get(key);
      const total   = g.quantity + p.quantity;
      g.avg_buy_price      = (g.avg_buy_price * g.quantity + p.avg_buy_price * p.quantity) / total;
      g.quantity           = total;
      g.cmp                = g.cmp || p.cmp;
      g.invested           = g.avg_buy_price * g.quantity;
      g.current_value      = (g.cmp || g.avg_buy_price) * g.quantity;
      g.pnl                = g.current_value - g.invested;
      g.pnl_pct            = g.invested > 0 ? (g.pnl / g.invested) * 100 : 0;
      // keep INR values in sync (for header summary cards) — same ticker/name
      // always implies the same currency, so g.currency already reflects it.
      const rate           = rateFor(g.currency);
      g.invested_inr       = g.invested * rate;
      g.current_value_inr  = g.current_value * rate;
      if (!g._accounts.includes(p.account)) g._accounts.push(p.account);
      const taggedTrades = (p.trades || []).map(t => Object.assign({}, t, { _account: p.account }));
      g._mergedTrades = g._mergedTrades.concat(taggedTrades);
    }
  }
  return Array.from(map.values()).map(function(g) {
    g._mergedTrades.sort((a, b) => (b.date || '') > (a.date || '') ? 1 : -1);
    g.trades = g._mergedTrades;
    return g;
  });
}

// ─── US Portfolio (split by sub-account) ─────────────────────────────────────
function renderUS() {
  const usdRate = state.settings.usd_inr_rate || 84;
  const vibPos  = state.positions.filter(p => p.account === 'us_vibhanshu');
  const manjPos = state.positions.filter(p => p.account === 'us_manjari');
  const conPos  = [...vibPos, ...manjPos];

  // Sum via the already-INR-converted fields (safe for mixed USD/EUR/GBP/SGD/
  // AUD holdings), then re-express as a USD-equivalent for the $ headline —
  // identical to a pure-USD sum when every position really is USD.
  const totalInvInr = sum(conPos, p => p.invested_inr);
  const totalValInr = sum(conPos, p => p.current_value_inr);
  const totalInv    = totalInvInr / usdRate;
  const totalVal    = totalValInr / usdRate;
  const pnl         = totalVal - totalInv;
  const pnlPct      = totalInv > 0 ? (pnl / totalInv) * 100 : 0;
  const pnlCls      = pnl >= 0 ? 't-pos' : 't-neg';
  const uniqueTkr   = new Set(conPos.map(p => p.ticker)).size;

  const summaryHtml = `
    <div class="flex items-center gap-3 flex-wrap mb-6">
      <div class="card min-w-[140px]">
        <div class="text-xs t-faint mb-1">US Portfolio Value</div>
        <div class="text-lg font-bold t-strong">${fmtCur(totalVal, true)}</div>
        <div class="text-xs t-faint mt-1">≈ ${fmtCur(totalValInr, false)} @ ₹${usdRate}/$</div>
      </div>
      <div class="card min-w-[120px]">
        <div class="text-xs t-faint mb-1">Invested</div>
        <div class="text-lg font-bold t-muted">${fmtCur(totalInv, true)}</div>
        <div class="text-xs t-faint mt-1">${fmtCur(totalInvInr, false)}</div>
      </div>
      <div class="card min-w-[120px]">
        <div class="text-xs t-faint mb-1">P&amp;L</div>
        <div class="text-lg font-bold ${pnlCls}">${fmtCur(pnl, true, true)}</div>
        <div class="text-xs ${pnlCls} mt-1">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</div>
      </div>
      <div class="card min-w-[100px]">
        <div class="text-xs t-faint mb-1">Tickers</div>
        <div class="text-lg font-bold t-strong">${uniqueTkr}</div>
        <div class="text-xs t-faint mt-1">${conPos.length} positions</div>
      </div>
      <div class="card min-w-[110px]">
        <div class="text-xs t-faint mb-1">USD/INR</div>
        <div class="text-lg font-bold t-strong">₹${usdRate.toFixed(1)}</div>
        <div class="text-xs t-faint mt-1 flex items-center gap-1">
          live rate <button class="btn btn-ghost text-xs py-0 px-1" onclick="fetchUsdRate()" title="Fetch live rate">⟳</button>
        </div>
      </div>
      <div class="ml-auto flex gap-2">
        <button class="btn btn-blue text-xs" onclick="openAdd('us_vibhanshu')">+ Add US Stock</button>
      </div>
    </div>`;

  function sectionHtml(pos, label, acctKey) {
    if (!pos.length) return '';
    // INR-based sums re-expressed in USD-equivalent terms — safe once a
    // section mixes USD with EUR/GBP/SGD/AUD positions.
    const sInv    = sum(pos, p => p.invested_inr) / usdRate;
    const sVal    = sum(pos, p => p.current_value_inr) / usdRate;
    const sPnl    = sVal - sInv;
    const sPnlPct = sInv > 0 ? (sPnl / sInv) * 100 : 0;
    const sCls    = sPnl >= 0 ? 't-pos' : 't-neg';
    return `
      <div class="mb-8">
        <div class="flex items-center gap-3 mb-3 flex-wrap">
          <h3 class="font-semibold t-strong text-sm">${label}</h3>
          <span class="badge">${fmtCur(sVal, true)}</span>
          <span class="${sCls} text-xs font-semibold">
            ${fmtCur(sPnl, true, true)} (${sPnlPct >= 0 ? '+' : ''}${sPnlPct.toFixed(1)}%)
          </span>
          <span class="text-xs t-faint">≈ ${fmtCur(sum(pos, p => p.current_value_inr), false)}</span>
          ${acctKey ? `<button class="btn btn-ghost text-xs ml-auto" onclick="openAdd('${acctKey}')">+ Add</button>` : ''}
        </div>
        ${renderTable(pos, acctKey ? 'us' : 'us_con')}
      </div>`;
  }

  return summaryHtml
    + renderUSCapitalSection(totalVal)
    + sectionHtml(vibPos,  'Vibhanshu — US Positions', 'us_vibhanshu')
    + sectionHtml(manjPos, 'Manjari — US Positions',   'us_manjari')
    + sectionHtml(conPos,  'Consolidated US (Vibhanshu + Manjari)', null);
}

function renderUSCapitalSection(portfolioVal, accountKeys) {
  const ct = state.capital_transferred || {};
  const portfolios = state.settings?.portfolio_groups?.us || [
    {id:'us_vibhanshu', name:'Vibhanshu'}, {id:'us_manjari', name:'Manjari'}
  ];
  // Filter to requested keys, or all if not specified
  const accounts = portfolios
    .filter(p => !accountKeys || accountKeys.includes(p.id))
    .map(p => ({ key: p.id, label: p.name }))
    .filter(a => (ct[a.key] || []).length > 0 || (accountKeys && accountKeys.length === 1)); // always show card in individual tab so user can add first entry

  const cards = accounts.map(({ key, label }) => {
    const entries   = ct[key] || [];
    const deposited = entries.filter(e => e.type !== 'withdrawal').reduce((s, e) => s + (e.amount || 0), 0);
    const withdrawn = entries.filter(e => e.type === 'withdrawal').reduce((s, e) => s + (e.amount || 0), 0);
    const net       = deposited - withdrawn;

    const timelineRows = entries.map(e => {
      const isW = e.type === 'withdrawal';
      const col = isW ? '#f87171' : '#34d399';
      return `<div style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
        <div style="width:7px;height:7px;border-radius:50%;background:${col};flex-shrink:0;margin-top:3px"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600">
            <span style="color:${col}">${isW ? '↑' : '↓'}</span>
            <span style="color:var(--text-strong)"> $${(e.amount||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
            ${e.inr_amount ? `<span style="font-size:10px;color:var(--text-faint);margin-left:4px">₹${Math.round(e.inr_amount).toLocaleString('en-IN')}</span>` : ''}
            ${e.rate ? `<span style="font-size:10px;color:var(--text-faint);margin-left:2px">@ ${e.rate}</span>` : ''}
          </div>
          <div style="font-size:10px;color:var(--text-faint)">${e.date || 'No date'}${e.note ? ' · '+esc(e.note.replace(/[@₹][^\s]*/g,'').trim()) : ''}</div>
        </div>
        <button onclick="deleteCapitalEntry('${key}','${e.id}')" style="background:none;border:none;cursor:pointer;font-size:10px;color:var(--text-faint);padding:0 2px;flex-shrink:0">✕</button>
      </div>`;
    }).join('');

    const addForm = `
      <div id="capital-add-${key}" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
        <div style="display:flex;flex-direction:column;gap:5px">
          <div style="display:flex;gap:4px">
            <button id="ct-type-dep-${key}" onclick="setCtType('${key}','deposit')"
              style="flex:1;background:#34d39922;border:1px solid #34d39955;color:#34d399;border-radius:4px;padding:4px 0;font-size:11px;font-weight:700;cursor:pointer">↓ Deposit</button>
            <button id="ct-type-wdw-${key}" onclick="setCtType('${key}','withdrawal')"
              style="flex:1;background:transparent;border:1px solid var(--border);color:var(--text-faint);border-radius:4px;padding:4px 0;font-size:11px;cursor:pointer">↑ Withdrawal</button>
          </div>
          <div style="display:flex;gap:4px">
            <input id="ct-amount-${key}" type="number" step="0.01" placeholder="USD amount" min="0"
              style="flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 7px;color:var(--text-strong);font-size:12px">
            <input id="ct-inr-${key}" type="number" step="1" placeholder="₹ INR sent" min="0"
              style="flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 7px;color:var(--text-strong);font-size:12px">
          </div>
          <div style="display:flex;gap:4px">
            <input id="ct-rate-${key}" type="number" step="0.01" placeholder="Rate (₹/$)" min="0"
              style="flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 7px;color:var(--text-strong);font-size:12px">
            <input id="ct-date-${key}" type="date"
              style="flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 7px;color:var(--text-strong);font-size:12px">
          </div>
          <input id="ct-note-${key}" type="text" placeholder="Note / ref (optional)"
            style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 7px;color:var(--text-strong);font-size:12px">
          <div style="display:flex;gap:4px">
            <button onclick="saveUSCapitalEntry('${key}')" style="flex:1;background:var(--accent)22;border:1px solid var(--accent)55;color:var(--accent);border-radius:4px;padding:3px 0;font-size:11px;font-weight:600;cursor:pointer">Save</button>
            <button onclick="document.getElementById('capital-add-${key}').style.display='none'" style="background:none;border:1px solid var(--border);color:var(--text-faint);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer">✕</button>
          </div>
        </div>
      </div>`;

    // For accounts with no entries yet, start the timeline open so the add button is immediately visible
    const timelineOpen = entries.length === 0;
    return `<div class="card" style="flex:1;min-width:260px;border-color:#a78bfa44">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:12px;font-weight:600;color:var(--text-strong)">${label}</span>
        <button onclick="toggleCapitalTimeline('${key}')" style="background:none;border:none;cursor:pointer;font-size:10px;color:#a78bfa" title="Timeline">▼ ${entries.length}</button>
      </div>
      <div style="font-size:18px;font-weight:700;color:#a78bfa">$${net.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      ${withdrawn > 0 ? `<div style="font-size:10px;color:var(--text-faint)">↓ $${deposited.toFixed(2)} &nbsp;↑ $${withdrawn.toFixed(2)}</div>` : ''}
      ${(function(){
        const usdR = state.settings.usd_inr_rate || 84;
        const inrEq = entries.filter(e=>e.type!=='withdrawal').reduce((a,e)=>a+(e.amount*(e.rate||usdR)),0)
                    - entries.filter(e=>e.type==='withdrawal').reduce((a,e)=>a+(e.amount*(e.rate||usdR)),0);
        return inrEq > 0 ? `<div style="font-size:11px;color:#a78bfa;font-weight:600">≈ ₹${Math.round(inrEq).toLocaleString('en-IN')}</div>` : '';
      })()}
      <div id="capital-timeline-${key}" style="display:${timelineOpen?'block':'none'};margin-top:8px">
        ${timelineRows || '<div style="font-size:10px;color:var(--text-faint);padding:4px 0">No remittances yet</div>'}
        <button onclick="openCapitalAdd('${key}')" style="margin-top:6px;width:100%;background:var(--accent)11;border:1px dashed var(--accent)55;color:var(--accent);border-radius:4px;padding:3px 0;font-size:11px;cursor:pointer">+ Add remittance</button>
        ${addForm}
      </div>
    </div>`;
  }).join('');

  const usdRate = state.settings.usd_inr_rate || 84;
  const inrForEntry = e => e.amount * (e.rate || usdRate);

  const totalNet    = accounts.reduce((s, {key}) => {
    const entries = ct[key] || [];
    return s + entries.filter(e=>e.type!=='withdrawal').reduce((a,e)=>a+(e.amount||0),0)
             - entries.filter(e=>e.type==='withdrawal').reduce((a,e)=>a+(e.amount||0),0);
  }, 0);
  const totalInrEq = accounts.reduce((s, {key}) => {
    const entries = ct[key] || [];
    return s + entries.filter(e=>e.type!=='withdrawal').reduce((a,e)=>a+inrForEntry(e),0)
             - entries.filter(e=>e.type==='withdrawal').reduce((a,e)=>a+inrForEntry(e),0);
  }, 0);

  return `<div class="mb-6">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <div class="text-sm font-semibold t-muted">💸 Capital Remitted to US</div>
      <span class="badge" style="background:#a78bfa18;color:#a78bfa;font-weight:700">$${totalNet.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
      <span class="badge" style="background:#a78bfa11;color:#a78bfa;font-weight:600">≈ ₹${Math.round(totalInrEq).toLocaleString('en-IN')}</span>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap">${cards}</div>
  </div>`;
}

async function saveUSCapitalEntry(key) {
  const amount  = parseFloat(document.getElementById('ct-amount-' + key)?.value);
  if (isNaN(amount) || amount <= 0) return;
  const inr_amount = parseFloat(document.getElementById('ct-inr-'  + key)?.value) || null;
  const rate       = parseFloat(document.getElementById('ct-rate-' + key)?.value) || null;
  const date       = document.getElementById('ct-date-' + key)?.value || '';
  const note       = document.getElementById('ct-note-' + key)?.value || '';
  const type       = _ctType[key] || 'deposit';
  await fetch(`/api/capital_transferred/${key}`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ amount, inr_amount, rate, date, note, type })
  });
  await fetchData();
}

// ─── Sector Allocation Tab ────────────────────────────────────────────────────

// Build a {sliceArray, total} for a sub-portfolio, grouping by groupFn(p)
function _buildSubPieData(positions, groupFn, colorOffset) {
  const map = new Map();
  for (const p of positions) {
    const key = groupFn(p);
    if (!map.has(key)) map.set(key, { value: 0, invested: 0, count: 0 });
    const s = map.get(key);
    s.value    += p.current_value_inr || 0;
    s.invested += p.invested_inr || 0;
    s.count    += 1;
  }
  const sorted = [...map.entries()].sort((a, b) => b[1].value - a[1].value);
  const total  = sorted.reduce((a, [, d]) => a + d.value, 0);
  const slices = sorted.map(([label, d], i) => ({
    label, value: d.value, invested: d.invested, count: d.count,
    color: SECTOR_COLORS[(i + colorOffset) % SECTOR_COLORS.length],
  }));
  return { slices, total };
}

// Render a single pie card (270×270 SVG, shows % of grand total in center)
function _renderPieCard(title, slices, subTotal, grandTotal) {
  const pct = grandTotal > 0 ? (subTotal / grandTotal * 100) : 0;
  const cx = 130, cy = 130, outerR = 108, innerR = 50;
  const svgPaths = slices.length ? _buildPie(slices, cx, cy, outerR, innerR, subTotal) : '';
  const pnl = slices.reduce((a, s) => a + s.value - s.invested, 0);
  const pnlPct = subTotal > 0 ? (pnl / slices.reduce((a, s) => a + s.invested, 0) * 100) : 0;
  const pnlCls = pnl >= 0 ? '#34d399' : '#f87171';

  const legend = slices.map(s => {
    const sp = subTotal > 0 ? (s.value / subTotal * 100) : 0;
    return `<div style="display:flex;align-items:center;gap:5px;font-size:11px;margin-bottom:2px">
      <span style="width:8px;height:8px;border-radius:2px;background:${s.color};flex-shrink:0"></span>
      <span class="t-muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.label)}</span>
      <span class="t-faint" style="font-size:10px">${sp.toFixed(1)}%</span>
    </div>`;
  }).join('');

  return `
  <div class="card flex-1" style="min-width:270px;max-width:380px">
    <div class="font-semibold t-strong text-sm mb-0.5">${title}</div>
    <div style="display:flex;gap:10px;margin-bottom:4px;font-size:12px">
      <span class="t-strong font-semibold">₹${fmtNum(subTotal)}</span>
      <span class="t-faint">${pct.toFixed(1)}% of portfolio</span>
      <span style="color:${pnlCls}">${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</span>
    </div>
    <svg width="260" height="260" viewBox="0 0 260 260" style="display:block;margin:0 auto">
      ${svgPaths}
      <text x="130" y="123" text-anchor="middle" font-size="18" font-weight="bold" fill="var(--text-strong)">${pct.toFixed(1)}%</text>
      <text x="130" y="141" text-anchor="middle" font-size="10" fill="var(--text-muted)">of total</text>
    </svg>
    <div style="margin-top:6px">${legend}</div>
  </div>`;
}

function renderSectors() {
  const validAccts = [...INR_ACCTS, 'us_vibhanshu', 'us_manjari'];
  const allPos  = state.positions.filter(p => validAccts.includes(p.account));

  const aifVal = aifLatestNav();

  // ── Classify into 3 sub-portfolios ──
  const equityPos    = allPos.filter(p => classifyPortfolio(p) === 'equity');
  const goldPos      = allPos.filter(p => classifyPortfolio(p) === 'gold');
  const commodityPos = allPos.filter(p => classifyPortfolio(p) === 'commodity');

  const grandTotal    = sum(allPos, p => p.current_value_inr || 0) + aifVal;
  const equityTotal   = sum(equityPos,   p => p.current_value_inr || 0) + aifVal;
  const goldTotal     = sum(goldPos,     p => p.current_value_inr || 0);
  const commodityTotal= sum(commodityPos,p => p.current_value_inr || 0);

  // ── Build pie data for each sub-portfolio ──
  // Equity pie: group by PIE_GROUPS[sector] || sector; add AIF as its own slice
  const { slices: rawEquitySlices } = _buildSubPieData(
    equityPos,
    p => PIE_GROUPS[p.sector || 'Other'] || p.sector || 'Other',
    0
  );
  const equitySlices = aifVal > 0
    ? [...rawEquitySlices, { label: 'AIF – Equity Fund', value: aifVal, color: '#818cf8' }]
    : rawEquitySlices;
  // Gold pie: group by sector (granular)
  const { slices: goldSlices } = _buildSubPieData(
    goldPos,
    p => p.sector || 'Other',
    6
  );
  // Commodity metals pie: group by stock name (only 3 tickers, names are more readable)
  const { slices: commoditySlices } = _buildSubPieData(
    commodityPos,
    p => p.stock_name || p.ticker,
    12
  );

  // ── Individual sector map for full breakdown table ──
  const sectorMap = new Map();
  for (const p of allPos) {
    const sector = p.sector || 'Other';
    const valInr = p.current_value_inr || 0;
    const invInr = p.invested_inr || 0;
    if (!sectorMap.has(sector)) sectorMap.set(sector, { value: 0, invested: 0, count: 0, accounts: new Set(), portfolio: classifyPortfolio(p), tickers: [] });
    const s = sectorMap.get(sector);
    s.value += valInr; s.invested += invInr; s.count += 1; s.accounts.add(p.account);
    const existing = s.tickers.find(t => t.ticker === p.ticker);
    if (!existing) s.tickers.push({ ticker: p.ticker, name: p.stock_name, ids: [p.id] });
    else existing.ids.push(p.id);
  }
  if (aifVal > 0) {
    const aifInv = state.settings.aif_invested || 0;
    sectorMap.set('AIF – Equity Fund', { value: aifVal, invested: aifInv, count: 1, accounts: new Set(['aif']), portfolio: 'equity', tickers: [] });
  }
  const sorted = [...sectorMap.entries()].sort((a, b) => b[1].value - a[1].value);

  const portfolioTag = { equity: ['#3b82f6','Equity'], gold: ['#f59e0b','Gold'], commodity: ['#10b981','Commodity'] };

  const rows = sorted.map(([sector, d]) => {
    const pct    = grandTotal > 0 ? (d.value / grandTotal * 100) : 0;
    const pnl    = d.value - d.invested;
    const pnlPct = d.invested > 0 ? (pnl / d.invested) * 100 : 0;
    const accts  = [...d.accounts].map(a => ACCT_LABELS[a] || a).join(', ');
    const pnlCls = pnl >= 0 ? 't-pos' : 't-neg';
    const [tagCol, tagLbl] = portfolioTag[d.portfolio] || ['#94a3b8', ''];
    const mergeTag = PIE_GROUPS[sector] && PIE_GROUPS[sector] !== sector
      ? `<span style="font-size:9px;color:var(--text-faint);margin-left:4px">→ ${esc(PIE_GROUPS[sector])}</span>` : '';
    const tickerChips = d.tickers.map(({ticker, name, ids}) => {
      const chipKey = 'sc_' + ticker.replace(/[^a-zA-Z0-9]/g,'_');
      const idsJson = JSON.stringify(ids).replace(/"/g,'&quot;');
      return `<span id="${chipKey}" title="${esc(name)}" style="display:inline-flex;align-items:center;gap:3px;background:var(--surface3);color:var(--text-muted);border:1px solid var(--border);border-radius:3px;padding:1px 5px 1px 6px;font-size:10px;font-family:'JetBrains Mono',monospace;white-space:nowrap">
        ${esc(ticker.replace(/\.(NS|BO)$/i,''))}
        <button onclick="editSectorTag('${chipKey}','${esc(sector)}','${esc(ticker)}',${idsJson})"
          title="Change sector for ${esc(name)}"
          style="background:none;border:none;cursor:pointer;font-size:9px;color:var(--text-faint);padding:0 1px;line-height:1;opacity:.6"
          onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.6'">✎</button>
      </span>`;
    }).join('');
    return `<tr>
      <td style="padding:7px 10px">
        <div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">
          <span style="background:${tagCol}22;color:${tagCol};border-radius:3px;padding:1px 5px;font-size:9px;font-weight:700">${tagLbl}</span>
          <span class="t-strong font-medium">${esc(sector)}</span>${mergeTag}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:3px">${tickerChips}</div>
      </td>
      <td style="padding:7px 10px" class="text-right t-muted">${d.count}</td>
      <td style="padding:7px 10px" class="text-right t-strong font-medium">₹${fmtNum(d.value)}</td>
      <td style="padding:7px 10px;${pnlBg(pnlPct)}" class="text-right ${pnlCls} font-medium">
        ${pnl >= 0 ? '+' : ''}₹${fmtNum(Math.abs(pnl))}
        <span class="text-xs">(${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)</span>
      </td>
      <td style="padding:7px 10px">
        <div class="flex items-center gap-2">
          <div style="width:90px;height:5px;background:var(--surface2);border-radius:3px;flex-shrink:0">
            <div style="width:${Math.min(pct,100).toFixed(1)}%;height:100%;background:${tagCol};border-radius:3px"></div>
          </div>
          <span class="t-muted text-xs">${pct.toFixed(1)}%</span>
        </div>
      </td>
      <td style="padding:7px 10px;font-size:11px" class="t-faint">${accts}</td>
    </tr>`;
  }).join('');

  return `
    <!-- Summary cards -->
    <div class="flex gap-3 flex-wrap mb-5">
      <div class="card text-center min-w-[130px]">
        <div class="text-lg font-bold t-strong">₹${fmtNum(grandTotal)}</div>
        <div class="text-xs t-faint mt-0.5">Total Portfolio</div>
      </div>
      <div class="card text-center min-w-[130px]" style="border-color:#3b82f655">
        <div class="text-lg font-bold" style="color:#3b82f6">₹${fmtNum(equityTotal)}</div>
        <div class="text-xs t-faint mt-0.5">Equity · ${grandTotal > 0 ? (equityTotal/grandTotal*100).toFixed(1) : 0}%</div>
      </div>
      <div class="card text-center min-w-[130px]" style="border-color:#f59e0b55">
        <div class="text-lg font-bold" style="color:#f59e0b">₹${fmtNum(goldTotal)}</div>
        <div class="text-xs t-faint mt-0.5">Gold · ${grandTotal > 0 ? (goldTotal/grandTotal*100).toFixed(1) : 0}%</div>
      </div>
      <div class="card text-center min-w-[130px]" style="border-color:#10b98155">
        <div class="text-lg font-bold" style="color:#10b981">₹${fmtNum(commodityTotal)}</div>
        <div class="text-xs t-faint mt-0.5">Commodity Metals · ${grandTotal > 0 ? (commodityTotal/grandTotal*100).toFixed(1) : 0}%</div>
      </div>
      <div class="card text-center min-w-[80px]">
        <div class="text-lg font-bold t-strong">${sorted.length}</div>
        <div class="text-xs t-faint mt-0.5">Sectors</div>
      </div>
    </div>

    <!-- 3 Pie charts row -->
    <div class="flex gap-4 flex-wrap mb-6">
      ${_renderPieCard('Equity Portfolio', equitySlices, equityTotal, grandTotal)}
      ${_renderPieCard('Gold Portfolio', goldSlices, goldTotal, grandTotal)}
      ${_renderPieCard('Commodity Metals', commoditySlices, commodityTotal, grandTotal)}
    </div>

    <!-- Full sector breakdown table -->
    <div class="card" style="overflow-x:auto">
      <div class="text-sm font-semibold t-strong mb-2">Full Sector Breakdown
        <span class="t-faint" style="font-size:11px;font-weight:400"> — click ✎ on any ticker to reassign its sector</span>
      </div>
      <table class="tbl">
        <thead><tr>
          <th class="text-left">Sector · Tickers</th>
          <th class="text-right">#</th>
          <th class="text-right">Value (₹)</th>
          <th class="text-right">P&amp;L</th>
          <th class="text-left" style="min-width:140px">% of Total</th>
          <th class="text-left">Accounts</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <!-- Manage Sectors -->
    ${_renderSectorMgmtCard(sorted.map(([s]) => s))}`;
}

function _renderSectorMgmtCard(inUseSectors) {
  const custom = state.settings?.custom_sectors || [];
  return `
    <div class="card mt-6">
      <div class="text-xs font-semibold t-muted mb-3 uppercase tracking-wide">Manage Sectors</div>
      <div style="font-size:11px;color:var(--text-faint);margin-bottom:10px">
        Custom sectors appear in the sector dropdown everywhere. To reassign a ticker, click ✎ next to it in the table above.
      </div>
      <div style="margin-bottom:6px;font-size:11px;font-weight:600;color:var(--text-muted)">In use (${inUseSectors.length})</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:14px">
        ${inUseSectors.map(s => `<span style="display:inline-block;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:11px;color:var(--text-muted)">${esc(s)}</span>`).join('')}
      </div>
      <div style="margin-bottom:6px;font-size:11px;font-weight:600;color:var(--text-muted)">Custom added (${custom.length})</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:14px">
        ${custom.length ? custom.map(s => `
          <span style="display:inline-flex;align-items:center;gap:4px;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.3);border-radius:4px;padding:2px 8px;font-size:11px;color:#a5b4fc">
            ${esc(s)}
            <button onclick="removeCustomSector('${esc(s).replace(/'/g,"\\'")}')"
              style="background:none;border:none;cursor:pointer;color:var(--text-faint);font-size:10px;line-height:1;padding:0 1px"
              title="Remove">✕</button>
          </span>`).join('') : '<span class="t-faint" style="font-size:11px">None yet</span>'}
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <input id="new-sector-input" type="text" list="sector-datalist" placeholder="New sector name…"
          style="flex:1;max-width:260px"
          onkeydown="if(event.key==='Enter'){event.preventDefault();addCustomSector();}">
        <button onclick="addCustomSector()" class="btn btn-blue text-xs">+ Add Sector</button>
      </div>
    </div>`;
}

function editSectorTag(chipKey, currentSector, ticker, ids) {
  const el = document.getElementById(chipKey);
  if (!el) return;
  const shortTicker = ticker.replace(/\.(NS|BO)$/i,'');
  const idsAttr = JSON.stringify(ids).replace(/"/g,'&quot;');
  el.style.background = 'rgba(99,102,241,.12)';
  el.style.borderColor = 'rgba(99,102,241,.4)';
  el.innerHTML = `
    <input id="sec-inp-${chipKey}" type="text" list="sector-datalist"
      value="${esc(currentSector)}"
      style="width:140px;font-size:11px;padding:2px 6px;font-family:inherit"
      onkeydown="if(event.key==='Enter')saveSectorTag('${chipKey}','${esc(ticker)}',${idsAttr});if(event.key==='Escape')render();">
    <button onclick="saveSectorTag('${chipKey}','${esc(ticker)}',${idsAttr})"
      style="background:rgba(59,130,246,.2);border:1px solid #3b82f6;color:#60a5fa;border-radius:3px;padding:1px 6px;font-size:10px;cursor:pointer">✓</button>
    <button onclick="render()"
      style="background:none;border:1px solid var(--border);color:var(--text-faint);border-radius:3px;padding:1px 5px;font-size:10px;cursor:pointer">✕</button>`;
  document.getElementById('sec-inp-' + chipKey)?.focus();
}

async function saveSectorTag(chipKey, ticker, ids) {
  const newSector = (document.getElementById('sec-inp-' + chipKey)?.value || '').trim();
  if (!newSector) return;
  await Promise.all(ids.map(id =>
    fetch(`/api/positions/${id}`, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sector: newSector }),
    })
  ));
  // Update local state immediately so everything reflects before full re-fetch
  state.positions.forEach(p => { if (ids.includes(p.id)) p.sector = newSector; });
  buildSectorDatalist();
  render();
  // Then sync with server in background
  fetchData().then(() => { buildSectorDatalist(); render(); });
}

function _buildPie(slices, cx, cy, outerR, innerR, total) {
  let angle = -Math.PI / 2;
  return slices.map(s => {
    const sweep = (s.value / total) * 2 * Math.PI;
    if (sweep < 0.005) return '';

    const x1  = cx + outerR * Math.cos(angle);
    const y1  = cy + outerR * Math.sin(angle);
    const x2  = cx + outerR * Math.cos(angle + sweep);
    const y2  = cy + outerR * Math.sin(angle + sweep);
    const ix1 = cx + innerR * Math.cos(angle + sweep);
    const iy1 = cy + innerR * Math.sin(angle + sweep);
    const ix2 = cx + innerR * Math.cos(angle);
    const iy2 = cy + innerR * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    const d = `M${x1.toFixed(2)},${y1.toFixed(2)} A${outerR},${outerR} 0 ${large},1 ${x2.toFixed(2)},${y2.toFixed(2)} L${ix1.toFixed(2)},${iy1.toFixed(2)} A${innerR},${innerR} 0 ${large},0 ${ix2.toFixed(2)},${iy2.toFixed(2)} Z`;
    angle += sweep;
    return `<path d="${d}" fill="${s.color}" stroke="var(--bg)" stroke-width="2" opacity="0.9">
      <title>${esc(s.label)}: ${(s.value/total*100).toFixed(1)}% (₹${Math.round(s.value/1e5)/10}L)</title></path>`;
  }).join('');
}

// ─── Analysis pipeline ────────────────────────────────────────────────────────
async function loadAnalysisStatuses() {
  try {
    const resp = await fetch('/api/watchlist/status/all');
    const data = await resp.json();
    Object.assign(analysisJobs, data);
    for (const [wid, job] of Object.entries(data)) {
      if (job.extract?.status === 'running' || job.deepdive?.status === 'running') {
        startStepPolling(wid);
      }
    }
    if (currentTab === 'watchlist') renderTab();
  } catch(e) {}
}

function startStepPolling(wid) {
  if (analysisPollers[wid]) return;
  analysisPollers[wid] = setInterval(async () => {
    try {
      const resp = await fetch(`/api/watchlist/${wid}/status`);
      const job  = await resp.json();
      analysisJobs[wid] = job;
      const done = job.extract?.status !== 'running' && job.deepdive?.status !== 'running';
      if (done) { clearInterval(analysisPollers[wid]); delete analysisPollers[wid]; }
      if (currentTab === 'watchlist') renderTab();
    } catch(e) {}
  }, 10000);
}

async function wlDownload(wid, ticker) {
  try {
    const resp = await fetch(`/api/watchlist/${wid}/download`, { method: 'POST' });
    const data = await resp.json();
    analysisJobs[wid] = data.job;
    window.open(data.screener_url, '_blank');
  } catch(e) {}
  if (currentTab === 'watchlist') renderTab();
}

async function wlExtract(wid) {
  if (analysisJobs[wid]?.extract?.status === 'running') return;
  try {
    const resp = await fetch(`/api/watchlist/${wid}/extract`, { method: 'POST' });
    const data = await resp.json();
    analysisJobs[wid] = data.job;
  } catch(e) {}
  startStepPolling(wid);
  if (currentTab === 'watchlist') renderTab();
}

async function wlDeepDive(wid) {
  if (analysisJobs[wid]?.deepdive?.status === 'running') return;
  try {
    const resp = await fetch(`/api/watchlist/${wid}/deepdive`, { method: 'POST' });
    const data = await resp.json();
    analysisJobs[wid] = data.job;
  } catch(e) {}
  startStepPolling(wid);
  if (currentTab === 'watchlist') renderTab();
}

function _stepSpinner(label) {
  return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--t-faint)">
    <span style="width:8px;height:8px;border:1.5px solid rgba(255,255,255,.2);border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0"></span>${label}</span>`;
}
function _stepDone(label)    { return `<span style="font-size:10px;color:#34d399">✓ ${label}</span>`; }
function _stepError(label)   { return `<span style="font-size:10px;color:#f87171" title="${label}">⚠ ${esc(label.slice(0,30))}</span>`; }
function _stepBtn(label, onclick, disabled) {
  const dim = disabled ? 'opacity:.35;cursor:not-allowed' : '';
  return `<button class="btn btn-ghost text-xs py-1 px-2" style="${dim}" ${disabled?'disabled':''} onclick="${onclick}">${label}</button>`;
}

function getResearchButtons(w) {
  const wid    = w.id;
  const ticker = (w.ticker || '').replace(/'/g, "\\'");
  const job    = analysisJobs[wid] || {};
  const dl     = job.download || {};
  const dd     = job.deepdive || {};

  // ── Download button ──
  const dlLabel = dl.status === 'visited' ? '✓ Screener' : '📥 Download';
  const dlStyle = dl.status === 'visited'
    ? 'background:rgba(52,211,153,.1);color:#34d399;border:1px solid rgba(52,211,153,.25)'
    : '';
  const dlBtn = `<button class="btn btn-ghost text-xs py-1 px-2" style="${dlStyle}"
    onclick="wlDownload('${wid}','${ticker}')">${dlLabel}</button>`;

  // ── Dashboard button ──
  let dashBtn;
  if (w.dashboard_url) {
    dashBtn = `<a href="${esc(w.dashboard_url)}" target="_blank" rel="noopener" class="btn text-xs py-1 px-2"
      style="background:rgba(52,211,153,.15);color:#34d399;border:1px solid rgba(52,211,153,.3)">📊 Dashboard</a>`;
  } else if (dd.status === 'running')
    dashBtn = _stepSpinner('Generating…');
  else if (dd.status === 'done')
    dashBtn = `<a href="/dashboard/${wid}" target="_blank" class="btn text-xs py-1 px-2"
      style="background:rgba(52,211,153,.15);color:#34d399;border:1px solid rgba(52,211,153,.3)">📊 Dashboard</a>`;
  else if (dd.status === 'error')
    dashBtn = `${_stepError(dd.error||'Error')} ${_stepBtn('↺', `wlDeepDive('${wid}')`, false)}`;
  else
    dashBtn = _stepBtn('📊 Dashboard', `wlDeepDive('${wid}')`, false);

  const extraLinks = _renderResearchLinks(w, { skipDashboardUrl: true, collapsible: true });
  const hasExtra = w.research_links?.trim();
  return `<div class="flex gap-1 items-center flex-wrap">
    ${dlBtn}
    ${dashBtn}
    ${hasExtra ? extraLinks : ''}
  </div>`;
}

// ─── AIF Portfolio ────────────────────────────────────────────────────────────
async function promptAifInvested() {
  const cur = state.settings.aif_invested || 0;
  const raw = prompt('AIF invested amount (₹):', cur);
  if (raw === null) return;
  const val = parseFloat(raw.replace(/,/g, ''));
  if (isNaN(val) || val < 0) { alert('Invalid amount'); return; }
  await fetch('/api/settings', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ aif_invested: val }) });
  const dataRes = await fetch('/api/data');
  const d = await dataRes.json();
  state.settings = d.settings;
  renderHeader();
  renderTab();
}

async function saveAifNav() {
  const monthEl = document.getElementById('aif-month');
  const valEl   = document.getElementById('aif-value');
  // .value may be empty on Safari (type=month unsupported) — fall back to the attribute
  const month = (monthEl.value || monthEl.getAttribute('value') || '').trim();
  // strip ₹, spaces, and any other non-numeric chars except decimal point
  const value = parseFloat((valEl.value || '').replace(/[^\d.]/g, ''));
  if (!month) { alert('Enter a month (format: YYYY-MM, e.g. 2026-07)'); return; }
  if (isNaN(value) || value <= 0) { alert('Enter a valid NAV value'); return; }
  await fetch('/api/aif_nav', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ month, value }) });
  const navRes = await fetch('/api/aif_nav');
  state.aifNav = await navRes.json();
  renderHeader();
  renderTab();
}

async function deleteAifNav(month) {
  if (!confirm(`Remove ${month} NAV entry?`)) return;
  await fetch(`/api/aif_nav/${month}`, { method: 'DELETE' });
  const navRes = await fetch('/api/aif_nav');
  state.aifNav = await navRes.json();
  renderHeader();
  renderTab();
}

// ─── AIF Investor Meets ────────────────────────────────────────────────────────
function monthLabel(ym) {
  if (!ym) return '—';
  const [yr, mo] = ym.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[parseInt(mo,10)-1]} ${yr}`;
}

function renderAIFInvestorMeets() {
  const meets = [...(state.aif_investor_meets || [])].sort((a,b) => b.month.localeCompare(a.month));

  const cards = meets.map(m => {
    const hasYT  = m.youtube_url  && m.youtube_url.trim();
    const hasSUM = m.summary_url  && m.summary_url.trim();
    const hasNotes = m.notes && m.notes.trim();

    return `<div class="card" style="min-width:240px;max-width:300px;flex:1;position:relative">
      <!-- header row -->
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:10px">
        <span style="background:var(--accent)22;color:var(--accent);border:1px solid var(--accent)44;border-radius:5px;padding:3px 10px;font-size:11px;font-weight:700;letter-spacing:.4px">${monthLabel(m.month)}</span>
        <div style="display:flex;gap:3px">
          <button onclick="editAifMeet('${m.id}')" title="Edit"
            style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:11px;color:var(--text-muted);cursor:pointer">✎</button>
          <button onclick="deleteAifMeet('${m.id}')" title="Delete"
            style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:11px;color:var(--neg);cursor:pointer">✕</button>
        </div>
      </div>

      ${m.title ? `<div style="font-size:12px;font-weight:600;color:var(--text-strong);margin-bottom:8px">${esc(m.title)}</div>` : ''}

      <!-- action buttons -->
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:${hasNotes?'10':'0'}px">
        ${hasYT ? `<a href="${esc(m.youtube_url)}" target="_blank"
          style="display:inline-flex;align-items:center;gap:5px;background:#ff000018;border:1px solid #ff000044;color:#ff6b6b;border-radius:5px;padding:5px 11px;font-size:11px;font-weight:600;text-decoration:none;cursor:pointer">
          ▶ Watch</a>` : ''}
        ${hasSUM ? `<a href="${esc(m.summary_url)}" target="_blank"
          style="display:inline-flex;align-items:center;gap:5px;background:var(--accent)18;border:1px solid var(--accent)44;color:var(--accent);border-radius:5px;padding:5px 11px;font-size:11px;font-weight:600;text-decoration:none;cursor:pointer">
          📋 Summary</a>` : ''}
        ${!hasYT && !hasSUM ? `<span class="t-faint" style="font-size:11px;font-style:italic">No links yet</span>` : ''}
      </div>

      <!-- notes — collapsible -->
      ${hasNotes ? `
        <div>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">
            <button onclick="const nb=this.parentElement.nextElementSibling;nb.style.display=nb.style.display==='none'?'block':'none';this.querySelector('.meet-note-icon').textContent=nb.style.display==='none'?'▶':'▼'"
              style="background:none;border:none;padding:0;cursor:pointer;display:flex;align-items:center;gap:5px">
              <span class="meet-note-icon" style="font-size:9px;color:var(--text-faint)">▶</span>
              <span style="font-size:10px;color:var(--text-faint);font-weight:500">Notes</span>
            </button>
            <button data-notes="${esc(m.notes)}" onclick="copyNotes(this)" title="Copy notes"
              style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--text-faint);padding:1px 4px;border-radius:3px;line-height:1;opacity:.6"
              onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.6'">⎘</button>
          </div>
          <div style="display:none;background:var(--surface2);border-left:2px solid var(--accent)55;border-radius:0 4px 4px 0;padding:7px 10px;font-size:11px;color:var(--text-muted);line-height:1.55;white-space:pre-wrap">${esc(m.notes)}</div>
        </div>` : ''}

      <!-- footer: added date -->
      <div style="margin-top:8px;font-size:10px;color:var(--text-faint)">Added: ${m.added_date || '—'}</div>
    </div>`;
  }).join('');

  return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <div class="text-sm font-semibold t-muted">📹 Monthly Investor Meets</div>
      <button onclick="showAifMeetModal()"
        style="background:var(--accent)22;border:1px solid var(--accent)55;color:var(--accent);border-radius:5px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer">+ Add</button>
    </div>
    ${meets.length
      ? `<div style="display:flex;flex-wrap:wrap;gap:12px">${cards}</div>`
      : `<div class="t-faint text-xs" style="padding:8px 0">No investor meets added yet — click + Add to start tracking</div>`
    }`;
}

function showAifMeetModal(id) {
  const modal = document.getElementById('aif-meet-modal');
  document.getElementById('aif-meet-modal-title').textContent = id ? 'Edit Investor Meet' : 'Add Investor Meet';
  document.getElementById('aif-meet-edit-id').value  = id || '';
  if (id) {
    const m = (state.aif_investor_meets || []).find(x => x.id === id);
    if (m) {
      document.getElementById('aif-meet-month').value   = m.month || '';
      document.getElementById('aif-meet-title').value   = m.title || '';
      document.getElementById('aif-meet-youtube').value = m.youtube_url || '';
      document.getElementById('aif-meet-summary').value = m.summary_url || '';
      document.getElementById('aif-meet-notes').value   = m.notes || '';
    }
  } else {
    document.getElementById('aif-meet-month').value   = '';
    document.getElementById('aif-meet-title').value   = '';
    document.getElementById('aif-meet-youtube').value = '';
    document.getElementById('aif-meet-summary').value = '';
    document.getElementById('aif-meet-notes').value   = '';
  }
  modal.classList.remove('hidden');
}

function closeAifMeetModal() {
  document.getElementById('aif-meet-modal').classList.add('hidden');
}

async function saveAifMeet(e) {
  e.preventDefault();
  const id       = document.getElementById('aif-meet-edit-id').value;
  const payload  = {
    month:       document.getElementById('aif-meet-month').value,
    title:       document.getElementById('aif-meet-title').value || null,
    youtube_url: document.getElementById('aif-meet-youtube').value || null,
    summary_url: document.getElementById('aif-meet-summary').value || null,
    notes:       document.getElementById('aif-meet-notes').value || null,
  };
  if (id) {
    await fetch(`/api/aif_investor_meets/${id}`, {
      method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
  } else {
    await fetch('/api/aif_investor_meets', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
  }
  closeAifMeetModal();
  await fetchData();
}

function editAifMeet(id) { showAifMeetModal(id); }

async function deleteAifMeet(id) {
  if (!confirm('Delete this investor meet entry?')) return;
  await fetch(`/api/aif_investor_meets/${id}`, { method:'DELETE' });
  await fetchData();
}

function renderAIF() {
  const nav     = [...(state.aifNav || [])].reverse();  // newest first
  const latest  = nav[0];
  const prev    = nav[1];

  const latestVal   = latest?.value || 0;
  const prevVal     = prev?.value   || 0;
  const aifInvested = state.settings.aif_invested || 0;
  const change      = latestVal - prevVal;
  const changePct   = prevVal > 0 ? (change / prevVal) * 100 : null;
  const totalPnl    = aifInvested > 0 ? latestVal - aifInvested : null;
  const totalPnlPct = aifInvested > 0 ? (totalPnl / aifInvested * 100) : null;

  const today = new Date();
  const defaultMonth = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;

  const navRows = nav.map(e => {
    const isLatest = e === latest;
    const pChangeVal = nav[nav.indexOf(e)+1]?.value;
    const pct = pChangeVal ? ((e.value - pChangeVal) / pChangeVal * 100) : null;
    const pctStr = pct !== null ? `<span style="font-size:11px;color:${pct>=0?'#34d399':'#f87171'}">${pct>=0?'+':''}${pct.toFixed(1)}%</span>` : `<span class="t-faint" style="font-size:11px">—</span>`;
    return `<tr>
      <td style="padding:8px 12px;color:var(--text-strong);font-weight:${isLatest?'600':'400'}">${e.month}</td>
      <td style="padding:8px 12px" class="num t-strong">₹${e.value.toLocaleString('en-IN')}</td>
      <td style="padding:8px 12px">${pctStr}</td>
      <td style="padding:8px 12px;text-align:right">
        <button onclick="deleteAifNav('${e.month}')" class="btn btn-ghost text-xs py-0 px-2" style="color:var(--neg)">✕</button>
      </td>
    </tr>`;
  }).join('');

  return `
    <div class="flex gap-3 flex-wrap mb-5">
      <div class="card min-w-[160px]">
        <div class="text-xs t-faint mb-1">Current NAV ${latest ? `(${latest.month})` : ''}</div>
        <div class="text-xl font-bold t-strong">₹${latestVal ? latestVal.toLocaleString('en-IN') : '—'}</div>
        ${changePct !== null ? `<div class="text-xs mt-1" style="color:${change>=0?'#34d399':'#f87171'}">${change>=0?'+':''}₹${Math.abs(change).toLocaleString('en-IN')} (${changePct>=0?'+':''}${changePct.toFixed(1)}% MoM)</div>` : ''}
      </div>
      <div class="card min-w-[150px]">
        <div class="text-xs t-faint mb-1">Invested (constant)</div>
        <div class="text-xl font-bold t-muted">₹${aifInvested.toLocaleString('en-IN')}</div>
        <button onclick="promptAifInvested()" class="text-xs t-faint mt-1" style="background:none;border:none;cursor:pointer;padding:0;text-decoration:underline">edit</button>
      </div>
      ${totalPnl !== null ? `<div class="card min-w-[140px]" style="border-color:${totalPnl>=0?'#34d39944':'#f8717144'}">
        <div class="text-xs t-faint mb-1">P&amp;L</div>
        <div class="text-xl font-bold" style="color:${totalPnl>=0?'#34d399':'#f87171'}">${totalPnl>=0?'+':''}₹${Math.abs(totalPnl).toLocaleString('en-IN')}</div>
        <div class="text-xs mt-1" style="color:${totalPnl>=0?'#34d399':'#f87171'}">${totalPnlPct>=0?'+':''}${totalPnlPct.toFixed(1)}%</div>
      </div>` : ''}
      <div class="card min-w-[130px]" style="border-color:var(--accent)55">
        <div class="text-xs t-faint mb-1">Counted As</div>
        <div class="text-sm font-semibold t-blue">Equity</div>
        <div class="text-xs t-faint mt-1">Included in header &amp; sectors</div>
      </div>
    </div>

    <!-- Add / update NAV -->
    <div class="card mb-5" style="max-width:420px">
      <div class="text-xs font-semibold t-muted mb-3">Add / Update Monthly NAV</div>
      <div class="flex gap-2 items-end flex-wrap">
        <div>
          <div class="text-xs t-faint mb-1">Month</div>
          <input id="aif-month" type="month" value="${defaultMonth}" placeholder="YYYY-MM"
            style="background:var(--input-bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;color:var(--text);outline:none">
        </div>
        <div>
          <div class="text-xs t-faint mb-1">NAV Value (₹)</div>
          <input id="aif-value" type="text" placeholder="e.g. 1,33,38,528"
            style="background:var(--input-bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;color:var(--text);outline:none;width:160px">
        </div>
        <button onclick="saveAifNav()" class="btn btn-blue text-xs">Save</button>
      </div>
    </div>

    <!-- NAV history table -->
    <div class="card" style="padding:0;overflow-x:auto;max-width:500px">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px;font-weight:600;color:var(--text-muted)">NAV History</div>
      <table class="tbl">
        <thead><tr>
          <th class="text-left">Month</th>
          <th class="text-left">NAV (₹)</th>
          <th class="text-left">MoM Change</th>
          <th></th>
        </tr></thead>
        <tbody>${navRows || `<tr><td colspan="4" class="text-center t-faint py-6">No entries yet</td></tr>`}</tbody>
      </table>
    </div>

    <!-- Investor Meets timeline -->
    <div class="mt-6 mb-6">
      ${renderAIFInvestorMeets()}
    </div>

    <!-- Holdings breakdown -->
    <div class="mt-6">
      <div class="flex items-center justify-between mb-3" style="padding-left:2px">
        <div class="text-sm font-semibold t-muted">AIF Holdings Breakdown</div>
        <button class="btn btn-blue text-xs" onclick="openAifHoldingsModal()">+ Update Holdings</button>
      </div>
      ${renderAIFHoldings()}
    </div>`;
}

let aifFilter = 'all';

// ─── AIF Holdings: long-format state → wide table pivot ────────────────────────
function _aifMonthLabel(ym) {
  const MON = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [y, m] = (ym || '').split('-');
  return m ? `${MON[parseInt(m, 10)]}'${y.slice(2)}` : ym;
}

// Classify a holding that IS still held as of latestM (hasNow=true) — increased/
// decreased/stable/new/recovery. Exited holdings (hasNow=false) are handled
// separately in _buildAifData, since "exited" needs the actual month it left,
// not just a prev-vs-latest delta (which breaks once the exit is >1 month old).
function _aifClassifyHeld(prevVal, latVal, everHeldEarlier) {
  const hadPrev = (prevVal || 0) > 0;
  if (!hadPrev) return everHeldEarlier ? { type: 'recovery', label: 'RECOVERY' } : { type: 'new', label: 'NEW' };
  const delta = (latVal || 0) - (prevVal || 0);
  if (delta >= 0.5)  return { type: 'increased', label: 'STRONG ADD' };
  if (delta >= 0.15) return { type: 'increased', label: 'ADDING' };
  if (delta > -0.15) return { type: 'stable', label: delta > 0.02 ? 'STABLE+' : (delta < -0.02 ? 'MICRO TRIM' : 'STABLE') };
  if (delta > -0.5)  return { type: 'decreased', label: 'TRIMMING' };
  return { type: 'decreased', label: 'STRONG TRIM' };
}

function _buildAifData() {
  const rows = state.aif_holdings || [];
  const allMonths = Array.from(new Set(rows.map(r => r.month))).sort(); // "YYYY-MM" sorts chronologically
  const visibleMonths = allMonths.slice(-6);
  const latestM = visibleMonths[visibleMonths.length - 1];
  const prevM   = visibleMonths[visibleMonths.length - 2];

  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, { name: r.name, sector: r.sector, values: {} });
    const g = byName.get(r.name);
    g.values[r.month] = r.weight_pct;
    if (r.sector) g.sector = r.sector; // most-recently-seen sector wins (rows are appended in month order)
  }

  const data = [];
  for (const g of byName.values()) {
    if (!visibleMonths.some(m => (g.values[m] || 0) > 0)) continue; // fully outside the visible window
    const latVal = latestM ? (g.values[latestM] || 0) : 0;
    const prvVal = prevM   ? (g.values[prevM]   || 0) : 0;
    let cls, monthForSuffix;
    if (latVal > 0) {
      const everHeldEarlier = allMonths.some(m => m < prevM && (g.values[m] || 0) > 0);
      cls = _aifClassifyHeld(prvVal, latVal, everHeldEarlier);
      monthForSuffix = latestM;
    } else {
      // No longer held as of latestM — label with the actual last month it was
      // held, not latestM, so an old exit doesn't read as "EXITED <this month>".
      const lastHeldMonth = allMonths.slice().reverse().find(m => (g.values[m] || 0) > 0);
      cls = { type: 'exited', label: 'EXITED' };
      monthForSuffix = lastHeldMonth;
    }
    const needsMonthSuffix = ['new', 'exited', 'recovery'].includes(cls.type);
    data.push({
      name: g.name, sector: g.sector || '—', values: g.values,
      type: cls.type,
      label: needsMonthSuffix && monthForSuffix ? `${cls.label} - ${_aifMonthLabel(monthForSuffix).split("'")[0].toUpperCase()}` : cls.label,
    });
  }
  data.sort((a, b) => {
    const av = latestM ? (a.values[latestM] || 0) : 0;
    const bv = latestM ? (b.values[latestM] || 0) : 0;
    if (av !== bv) return bv - av;
    const findLast = h => visibleMonths.slice().reverse().find(m => (h.values[m] || 0) > 0) || '';
    return findLast(b).localeCompare(findLast(a));
  });
  return { data, visibleMonths, latestM, prevM };
}

function renderAIFHoldings() {
  const TYPE_CFG = {
    increased: { bg:'rgba(52,211,153,0.15)', border:'#34d399', col:'#34d399',  label:'Increased' },
    decreased: { bg:'rgba(248,113,113,0.1)', border:'#f87171', col:'#f87171',  label:'Decreased' },
    recovery:  { bg:'rgba(59,130,246,0.12)', border:'#60a5fa', col:'#60a5fa',  label:'Recovery'  },
    stable:    { bg:'rgba(148,163,184,0.1)', border:'#94a3b8', col:'#94a3b8',  label:'Stable'    },
    new:       { bg:'rgba(236,72,153,0.12)', border:'#f472b6', col:'#f472b6',  label:'New'       },
    exited:    { bg:'rgba(107,114,128,0.1)', border:'#6b7280', col:'#6b7280',  label:'Exited'    },
  };

  const { data: AIF_DATA, visibleMonths, latestM, prevM } = _buildAifData();

  if (!visibleMonths.length) {
    return `<div class="card text-center py-10 t-faint">
      No AIF holdings recorded yet. Click <b>+ Update Holdings</b> above and paste in a month's factsheet to get started.
    </div>`;
  }

  const rangeLabel = visibleMonths.map(_aifMonthLabel).join(' → ');
  const newLabel = `New ${latestM ? _aifMonthLabel(latestM).split("'")[0] : ''}`;

  const counts = {};
  for (const d of AIF_DATA) counts[d.type] = (counts[d.type] || 0) + 1;

  const filterBtns = ['all', 'increased', 'decreased', 'new', 'recovery', 'stable', 'exited'].map(f => {
    const cfg  = TYPE_CFG[f];
    const cnt  = f === 'all' ? AIF_DATA.length : (counts[f] || 0);
    const active = aifFilter === f;
    const col  = cfg ? cfg.col : 'var(--accent)';
    return `<button onclick="setAifFilter('${f}')"
      style="padding:4px 12px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid ${active ? col : 'var(--border)'};background:${active ? (cfg ? cfg.bg : 'rgba(59,130,246,0.12)') : 'transparent'};color:${active ? col : 'var(--text-muted)'};transition:all .15s">
      ${f === 'all' ? 'All' : TYPE_CFG[f].label} (${cnt})
    </button>`;
  }).join('');

  const filtered = aifFilter === 'all' ? AIF_DATA : AIF_DATA.filter(d => d.type === aifFilter);

  // Summary chips — latest month drives holdings count and new label
  const chips = [
    { l:'Holdings',   v: latestM ? AIF_DATA.filter(d=>(d.values[latestM]||0)>0).length : 0 },
    { l:'Increased',  v: counts.increased||0, col:'#34d399' },
    { l:'Decreased',  v: counts.decreased||0, col:'#f87171' },
    { l:newLabel,     v: counts.new||0,        col:'#f472b6' },
    { l:'Exited',     v: counts.exited||0,     col:'#6b7280' },
    { l:'Recovery',   v: counts.recovery||0,   col:'#60a5fa' },
  ].map(c => `<div class="card text-center" style="min-width:90px;${c.col ? 'border-color:'+c.col+'44':'' }">
    <div style="font-size:18px;font-weight:700;color:${c.col||'var(--text-strong)'}">${c.v}</div>
    <div style="font-size:10px;color:var(--text-faint);margin-top:2px">${c.l}</div>
  </div>`).join('');

  // Table rows — dynamic month columns; change = latest vs previous month
  const rows = filtered.map(p => {
    const cfg    = TYPE_CFG[p.type] || TYPE_CFG.stable;
    const latVal = latestM ? (p.values[latestM] || 0) : 0;
    const prvVal = prevM   ? (p.values[prevM]   || 0) : 0;
    const change = (latVal - prvVal).toFixed(2);
    const chgCol = parseFloat(change) > 0 ? '#34d399' : parseFloat(change) < 0 ? '#f87171' : '#94a3b8';
    const arrow  = parseFloat(change) > 0 ? '↑' : parseFloat(change) < 0 ? '↓' : '→';
    const maxVal = Math.max(...visibleMonths.map(m => p.values[m] || 0), 0.1);

    function miniBar(val, isLatest) {
      const pct = ((val || 0) / maxVal) * 100;
      const col = isLatest ? chgCol : 'var(--text-faint)';
      return `<div style="display:flex;align-items:center;gap:5px">
        <div style="width:52px;height:4px;background:var(--surface2);border-radius:2px;flex-shrink:0">
          <div style="width:${pct.toFixed(0)}%;height:100%;background:${col};border-radius:2px"></div>
        </div>
        <span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:${isLatest?col:'var(--text-faint)'}">
          ${(val || 0) > 0 ? Number(val).toFixed(1)+'%' : '—'}
        </span>
      </div>`;
    }

    const monthCells = visibleMonths.map((m, i) =>
      `<td>${miniBar(p.values[m] || 0, i === visibleMonths.length - 1)}</td>`
    ).join('');

    return `<tr>
      <td style="font-weight:500;color:var(--text-strong)">${esc(p.name)}</td>
      <td><span class="badge">${esc(p.sector)}</span></td>
      ${monthCells}
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;color:${chgCol}">
        ${arrow} ${parseFloat(change) > 0 ? '+' : ''}${change}%
      </td>
      <td>
        <span style="background:${cfg.bg};color:${cfg.col};border:1px solid ${cfg.border};border-radius:4px;padding:2px 8px;font-size:10px;font-weight:600;white-space:nowrap">
          ${esc(p.label)}
        </span>
      </td>
    </tr>`;
  }).join('');

  const colSpan = 4 + visibleMonths.length; // Holding + Sector + months + Change + Signal
  const monthHeaders = visibleMonths.map((m, i) =>
    `<th class="text-left"${i === visibleMonths.length-1 ? ' style="color:var(--accent)"' : ''}>${_aifMonthLabel(m)} %</th>`
  ).join('');
  const changeHeader = prevM && latestM ? `${_aifMonthLabel(prevM)}→${_aifMonthLabel(latestM)}` : 'Change';

  return `
    <div class="flex gap-3 flex-wrap mb-4">${chips}</div>
    <div class="flex gap-2 flex-wrap mb-4">${filterBtns}</div>
    <div class="card" style="padding:0;overflow-x:auto">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:12px;font-weight:600;color:var(--text-muted);display:flex;justify-content:space-between;align-items:center">
        <span>${rangeLabel} · AIF Holdings · ${filtered.length} shown</span>
        ${latestM ? `<button onclick="openAifHoldingsModal('${latestM}')" class="btn btn-ghost text-xs py-1 px-2" title="Edit or delete ${_aifMonthLabel(latestM)}'s data">✏️ Edit ${_aifMonthLabel(latestM)}</button>` : ''}
      </div>
      <table class="tbl">
        <thead><tr>
          <th class="text-left">Holding</th>
          <th class="text-left">Sector</th>
          ${monthHeaders}
          <th class="text-left">${changeHeader}</th>
          <th class="text-left">Signal</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${colSpan}" class="text-center t-faint py-8">No holdings</td></tr>`}</tbody>
      </table>
    </div>`;
}

function setAifFilter(f) {
  aifFilter = f;
  document.getElementById('tab-content').innerHTML = renderAIF();
  // re-render only the holdings section without re-rendering the whole tab
}

// ─── AIF Holdings: Update-Month modal ───────────────────────────────────────────
// Parses pasted factsheet text into [{name, weight_pct}]. Handles both "one holding
// per line" and the natural two-column newspaper-style paste (e.g. "Centum
// Electronics 3.8% NRB Bearings 2.1%") since it scans for every "<name> <num>%"
// pattern in the whole blob rather than splitting on line breaks first.
function _aifParseTextarea(text) {
  const re = /([A-Za-z][A-Za-z0-9&.,'()/\-\s]*?)\s+(\d+(?:\.\d+)?)\s*%/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].replace(/\s+/g, ' ').trim();
    const weight_pct = parseFloat(m[2]);
    if (name && !isNaN(weight_pct)) out.push({ name, weight_pct });
  }
  return out;
}

// Look up the most recent historical sector for a holding name, so re-pasted
// months don't need sector typed in every time — only genuinely new names lack one.
function _aifSectorFor(name) {
  const rows = (state.aif_holdings || []).filter(r => r.name === name && r.sector).sort((a, b) => a.month.localeCompare(b.month));
  return rows.length ? rows[rows.length - 1].sector : null;
}

function _aifEntriesToText(month) {
  return (state.aif_holdings || [])
    .filter(r => r.month === month)
    .sort((a, b) => b.weight_pct - a.weight_pct)
    .map(r => `${r.name} ${r.weight_pct}%`)
    .join('\n');
}

function openAifHoldingsModal(month) {
  const today = new Date();
  const defaultMonth = month || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  document.getElementById('aifh-month').value = defaultMonth;
  onAifHoldingsMonthChange();
  document.getElementById('aifh-modal').classList.remove('hidden');
}

function closeAifHoldingsModal() {
  document.getElementById('aifh-modal').classList.add('hidden');
}

function onAifHoldingsMonthChange() {
  const month = document.getElementById('aifh-month').value;
  const existingText = _aifEntriesToText(month);
  document.getElementById('aifh-text').value = existingText;
  document.getElementById('aifh-delete-btn').style.display = existingText ? 'inline-flex' : 'none';
  _aifUpdatePreview();
}

function _aifUpdatePreview() {
  const text = document.getElementById('aifh-text').value;
  const parsed = _aifParseTextarea(text);
  const total = parsed.reduce((s, p) => s + p.weight_pct, 0);
  const el = document.getElementById('aifh-preview');
  if (!parsed.length) {
    el.textContent = text.trim() ? 'No "Name X.X%" patterns recognized yet.' : 'Paste holdings above — one or two per line, e.g. "Centum Electronics 3.8%".';
    el.style.color = 'var(--text-faint)';
    return;
  }
  el.textContent = `${parsed.length} holdings parsed, totaling ${total.toFixed(1)}%${Math.abs(total - 100) > 3 ? '  ⚠️ far from 100% — check for a missed or duplicated line' : ''}`;
  el.style.color = Math.abs(total - 100) > 3 ? '#f87171' : 'var(--text-faint)';
}

async function saveAifHoldingsMonth() {
  const month = document.getElementById('aifh-month').value;
  if (!month) { alert('Pick a month first'); return; }
  const parsed = _aifParseTextarea(document.getElementById('aifh-text').value);
  if (!parsed.length) { alert('No holdings parsed — check the pasted text'); return; }
  const holdings = parsed.map(p => ({ name: p.name, weight_pct: p.weight_pct, sector: _aifSectorFor(p.name) }));
  const btn = document.getElementById('aifh-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await fetch('/api/aif_holdings/month', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month, holdings }),
    });
    closeAifHoldingsModal();
    await fetchData();
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

async function deleteAifHoldingsMonth() {
  const month = document.getElementById('aifh-month').value;
  if (!month) return;
  if (!confirm(`Delete all holdings recorded for ${_aifMonthLabel(month)}? This can't be undone.`)) return;
  await fetch(`/api/aif_holdings/month/${month}`, { method: 'DELETE' });
  closeAifHoldingsModal();
  await fetchData();
}

// ─── Watchlist ────────────────────────────────────────────────────────────────
// ── Watchlist helper: CMP + % since added (2 <td> cells) ─────────────────────
function wlPriceCells(w, t) {
  // Auto-detect currency from ticker: Indian = ₹, everything else = $
  const isIndian = _isIndianTicker(w.ticker);
  // livePrices is populated after Fetch Prices; technicals.cmp is from last technical run
  const cmp = livePrices[w.ticker] ?? t?.cmp ?? null;
  const ap  = w.added_price ?? null;
  const fmt = isIndian
    ? v => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })
    : v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // CMP cell — prefer live price timestamp over stale technicals timestamp
  const cmpTs = livePrices[w.ticker] != null ? _lastFetchTs : (t?.updated || '');
  const cmpCell = cmp != null
    ? `<td class="text-right num" style="font-size:12px;font-weight:600;color:var(--text-strong)">${fmt(cmp)}<div style="font-size:9px;color:var(--text-faint);font-weight:400;margin-top:1px">${cmpTs}</div></td>`
    : `<td class="text-right t-faint" style="font-size:11px">—</td>`;

  // Since added cell
  let sinceCell;
  if (cmp != null && ap != null && ap > 0) {
    const pct    = ((cmp - ap) / ap) * 100;
    const col    = pct >= 0 ? '#34d399' : '#f87171';
    const arrow  = pct >= 0 ? '▲' : '▼';
    sinceCell = `<td class="text-right" style="font-size:12px;font-weight:700;color:${col}">
      ${arrow} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%
      <div style="font-size:9px;color:var(--text-faint);font-weight:400;margin-top:1px">${fmt(ap)} → ${fmt(cmp)}</div>
    </td>`;
  } else if (ap != null) {
    sinceCell = `<td class="text-right t-faint" style="font-size:11px">at ${fmt(ap)}<div style="font-size:9px">no signals yet</div></td>`;
  } else {
    sinceCell = `<td class="text-right t-faint" style="font-size:11px">—</td>`;
  }

  return cmpCell + sinceCell;
}

// ── Watchlist helper: inline collapsible notes cell content ───────────────────
function soicResearchUrl(num) {
  return `https://visionary-selkie-8c85fe.netlify.app/#c${num}`;
}

const _IMG_URL_RE = /\.(jpe?g|png|gif|webp|svg)(\?[^\s]*)?$/i;

function _linkifyNotes(text) {
  return text.split(/(https?:\/\/[^\s]+|\/uploads\/[^\s]+)/g).map((part, i) => {
    if (i % 2 === 1) {
      const href = esc(part);
      if (_IMG_URL_RE.test(part)) {
        return `<span style="display:inline-block;vertical-align:top;margin:3px 6px 3px 0">
          <button onclick="const nb=this.nextElementSibling;nb.style.display=nb.style.display==='none'?'block':'none';this.querySelector('.cn-icon').textContent=nb.style.display==='none'?'▶':'▼'"
            style="background:none;border:none;padding:0;cursor:pointer;display:flex;align-items:center;gap:4px">
            <span class="cn-icon" style="font-size:9px;color:var(--text-faint)">▶</span>
            <span style="font-size:11px;color:var(--text-faint)">Image</span>
          </button>
          <div style="display:none;margin-top:4px">
            <a href="${href}" target="_blank" rel="noopener" style="display:block">
              <img src="${href}" loading="lazy"
                style="max-width:240px;max-height:160px;border-radius:6px;object-fit:contain;
                       border:1px solid var(--border);cursor:zoom-in;display:block" />
            </a>
          </div>
        </span>`;
      }
      return `<a href="${href}" target="_blank" rel="noopener"
        style="color:#60a5fa;text-decoration:underline;word-break:break-all"
        onmouseover="this.style.color='#93c5fd'" onmouseout="this.style.color='#60a5fa'">${esc(part)}</a>`;
    }
    return esc(part);
  }).join('');
}

// Parse research_links (newline-separated, "Label::URL" or bare URL) + legacy dashboard_url
function _parseResearchLinks(w, { skipDashboardUrl = false } = {}) {
  const links = [];
  const seen  = new Set();
  const add   = (url, label) => {
    url = (url || '').trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ url, label: (label || '').trim() || null });
  };
  if (w.research_links) {
    w.research_links.split('\n').forEach(line => {
      line = line.trim();
      if (!line) return;
      const sep = line.indexOf('::');
      if (sep > 0) add(line.slice(sep + 2), line.slice(0, sep));
      else add(line, null);
    });
  }
  if (!skipDashboardUrl && w.dashboard_url) add(w.dashboard_url, '📊 Report');
  return links;
}

function _renderResearchLinks(w, opts = {}) {
  const links = _parseResearchLinks(w, opts);
  if (!links.length) return '<span class="t-faint" style="font-size:11px">—</span>';
  const pillsHtml = `<div class="flex gap-1 flex-wrap items-center">${links.map(({ url, label }) => {
    const href = esc(url);
    if (_IMG_URL_RE.test(url)) {
      const caption = esc(label || '');
      return `<a href="${href}" target="_blank" rel="noopener"
        style="display:inline-flex;flex-direction:column;align-items:center;gap:2px;text-decoration:none">
        <img src="${href}" loading="lazy"
          style="max-width:56px;max-height:38px;border-radius:4px;object-fit:cover;
                 border:1px solid var(--border);cursor:zoom-in" />
        ${caption ? `<span style="font-size:9px;color:var(--text-faint);max-width:60px;overflow:hidden;
          text-overflow:ellipsis;white-space:nowrap;text-align:center">${caption}</span>` : ''}
      </a>`;
    }
    const display = esc(label || '📊 Report');
    return `<a href="${href}" target="_blank" rel="noopener" class="btn text-xs py-1 px-2"
      style="background:rgba(52,211,153,.15);color:#34d399;border:1px solid rgba(52,211,153,.3);
             white-space:nowrap">${display}</a>`;
  }).join('')}</div>`;
  if (opts.collapsible && links.length >= 1) {
    return `<div>
      <button onclick="const nb=this.closest('div').querySelector('.rl-body');nb.style.display=nb.style.display==='none'?'flex':'none';this.querySelector('.cn-icon').textContent=nb.style.display==='none'?'▶':'▼'"
        style="background:none;border:none;padding:0;cursor:pointer;display:flex;align-items:center;gap:4px">
        <span class="cn-icon" style="font-size:9px;color:var(--text-faint)">▶</span>
        <span style="font-size:11px;color:var(--text-faint)">Research (${links.length})</span>
      </button>
      <div class="rl-body" style="display:none;margin-top:4px">${pillsHtml}</div>
    </div>`;
  }
  return pillsHtml;
}

// ── Research link rows UI ─────────────────────────────────────────────────────
let _uploadTargetPrefix = null;

function _wlLinkRowHtml(name, url) {
  const safeName = (name || '').replace(/"/g, '&quot;');
  const safeUrl  = (url  || '').replace(/"/g, '&quot;');
  return `<div style="display:flex;gap:4px;align-items:center">
    <input type="text" class="wl-link-name" value="${safeName}"
      placeholder="Name (e.g. Dashboard)"
      style="flex:0 0 120px;font-size:11px;padding:4px 6px;min-width:0;
             background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text)">
    <input type="text" class="wl-link-url" value="${safeUrl}"
      placeholder="https://… or /uploads/…"
      style="flex:1;font-size:11px;padding:4px 6px;min-width:0;
             background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text)">
    <button type="button" onclick="this.closest('div').remove()"
      style="background:none;border:none;cursor:pointer;font-size:16px;line-height:1;
             color:var(--text-faint);padding:0 4px;flex-shrink:0"
      title="Remove">×</button>
  </div>`;
}

function addWlLinkRow(prefix) {
  const c = document.getElementById(`${prefix}-research-link-rows`);
  if (!c) return;
  c.insertAdjacentHTML('beforeend', _wlLinkRowHtml('', ''));
  c.querySelector('div:last-child .wl-link-name')?.focus();
}

function _wlLinksSerialize(prefix) {
  const c = document.getElementById(`${prefix}-research-link-rows`);
  if (!c) return '';
  const lines = [];
  c.querySelectorAll('div').forEach(row => {
    const name = row.querySelector('.wl-link-name')?.value.trim() || '';
    const url  = row.querySelector('.wl-link-url')?.value.trim()  || '';
    if (!url) return;
    lines.push(name ? `${name}::${url}` : url);
  });
  return lines.join('\n');
}

function _wlLinksPopulate(prefix, researchLinks, dashboardUrl) {
  const c = document.getElementById(`${prefix}-research-link-rows`);
  if (!c) return;
  c.innerHTML = '';
  const src = { research_links: researchLinks || null, dashboard_url: (dashboardUrl && !researchLinks) ? dashboardUrl : null };
  const links = _parseResearchLinks(src);
  links.forEach(({ label, url }) => c.insertAdjacentHTML('beforeend', _wlLinkRowHtml(label || '', url)));
}

function uploadWlImage(prefix) {
  _uploadTargetPrefix = prefix;
  const inp = document.getElementById('wl-img-file-input');
  if (inp) { inp.value = ''; inp.click(); }
}

async function handleWlImageUpload(event) {
  const file = event.target.files[0];
  if (!file || !_uploadTargetPrefix) return;

  const prefix = _uploadTargetPrefix;
  const c = document.getElementById(`${prefix}-research-link-rows`);

  // Notes prefix falls back to textarea append
  const notesEl = !c ? document.getElementById(`${prefix}`) : null;

  if (!c && !notesEl) return;

  if (c) {
    // Add a placeholder row
    c.insertAdjacentHTML('beforeend', _wlLinkRowHtml('Screenshot', ''));
    const lastRow = c.querySelector('div:last-child');
    const urlInput = lastRow?.querySelector('.wl-link-url');
    if (urlInput) urlInput.placeholder = '⏳ Uploading…';

    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload-image', { method: 'POST', body: fd });
      if (!res.ok) { const e = await res.json().catch(()=>{}); alert('Upload failed: '+(e?.detail||res.status)); lastRow?.remove(); return; }
      const { url } = await res.json();
      if (urlInput) { urlInput.value = url; urlInput.placeholder = 'https://… or /uploads/…'; }
      lastRow?.querySelector('.wl-link-name')?.focus();
    } catch(e) { alert('Upload error: '+e.message); c.querySelector('div:last-child')?.remove(); }
  } else {
    // Notes textarea fallback
    const origPh = notesEl.placeholder;
    notesEl.disabled = true; notesEl.placeholder = '⏳ Uploading…';
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch('/api/upload-image', { method: 'POST', body: fd });
      if (!res.ok) { const e = await res.json().catch(()=>{}); alert('Upload failed: '+(e?.detail||res.status)); return; }
      const { url } = await res.json();
      const cur = notesEl.value.trim();
      notesEl.value = cur ? cur + '\n' + url : url;
    } catch(e) { alert('Upload error: '+e.message); }
    finally { notesEl.placeholder = origPh; notesEl.disabled = false; notesEl.focus(); }
  }
}

function inlineCollapsibleNotes(notes) {
  if (!notes) return '<span class="t-faint">—</span>';
  const escaped = esc(notes);
  // SOIC research link — marker "soic:N" anywhere in notes, or legacy HTML with id="cN"
  const soicMatch = notes.match(/soic:(\d+)/) || notes.match(/id="c(\d+)"/);
  if (soicMatch) {
    const url = soicResearchUrl(parseInt(soicMatch[1]));
    const link = `<a href="${url}" target="_blank" rel="noopener"
      style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#a78bfa;text-decoration:none;padding:2px 7px;border:1px solid rgba(139,92,246,0.3);border-radius:4px;background:rgba(139,92,246,0.08);white-space:nowrap"
      onmouseover="this.style.background='rgba(139,92,246,0.18)'" onmouseout="this.style.background='rgba(139,92,246,0.08)'">
      📄 View Research
    </a>`;
    const extra = notes.replace(/soic:\d+/,'').trim();
    if (!extra) return link;
    const escapedExtra = esc(extra);
    const contentStyle = `display:none;margin-top:5px;background:var(--surface2);border-left:2px solid var(--accent)55;border-radius:0 4px 4px 0;padding:6px 9px;font-size:11px;color:var(--text-muted);line-height:1.55;max-width:300px;white-space:pre-wrap`;
    return `<div style="display:flex;flex-direction:column;gap:4px">${link}
      <div>
        <div style="display:flex;align-items:center;gap:5px">
          <button onclick="const nb=this.closest('div').nextElementSibling;nb.style.display=nb.style.display==='none'?'block':'none';this.querySelector('.cn-icon').textContent=nb.style.display==='none'?'▶':'▼'"
            style="background:none;border:none;padding:0;cursor:pointer;display:flex;align-items:center;gap:4px">
            <span class="cn-icon" style="font-size:9px;color:var(--text-faint)">▶</span>
            <span style="font-size:11px;color:var(--text-faint)">Notes</span>
          </button>
          ${_ttsBtn_html(escapedExtra)}
        </div>
        <div style="${contentStyle}">${_linkifyNotes(extra)}</div>
      </div>
    </div>`;
  }
  // Plain text notes — collapsible as before
  const contentStyle = `display:none;margin-top:5px;background:var(--surface2);border-left:2px solid var(--accent)55;border-radius:0 4px 4px 0;padding:6px 9px;font-size:11px;color:var(--text-muted);line-height:1.55;max-width:300px;white-space:pre-wrap`;
  return `
    <div>
      <div style="display:flex;align-items:center;gap:5px">
        <button onclick="const nb=this.closest('div').nextElementSibling;nb.style.display=nb.style.display==='none'?'block':'none';this.querySelector('.cn-icon').textContent=nb.style.display==='none'?'▶':'▼'"
          style="background:none;border:none;padding:0;cursor:pointer;display:flex;align-items:center;gap:4px;white-space:nowrap">
          <span class="cn-icon" style="font-size:9px;color:var(--text-faint)">▶</span>
          <span style="font-size:11px;color:var(--text-faint)">Notes</span>
        </button>
        <button data-notes="${escaped}" onclick="event.stopPropagation();copyNotes(this)" title="Copy"
          style="background:none;border:none;cursor:pointer;font-size:10px;color:var(--text-faint);padding:1px 3px;line-height:1;opacity:.5"
          onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.5'">⎘</button>
        ${_ttsBtn_html(escaped)}
      </div>
      <div style="${contentStyle}">${_linkifyNotes(notes)}</div>
    </div>`;
}

// ─── Mutual Funds ─────────────────────────────────────────────────────────────
function mfEstimatedInvested(mf) {
  if (mf.total_invested) return mf.total_invested;
  if (!mf.sip_amount || !mf.sip_start_date) return null;
  const start = new Date(mf.sip_start_date);
  const today = new Date();
  const freq  = mf.sip_frequency || 'monthly';
  let months  = (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth()) + 1;
  if (months < 0) months = 0;
  const periods = freq === 'quarterly' ? Math.floor(months / 3) : freq === 'lumpsum' ? 1 : months;
  return mf.sip_amount * periods;
}

function renderMutualFunds() {
  const funds = state.mutual_funds || [];
  const vib   = funds.filter(m => m.holder === 'vibhanshu');
  const man   = funds.filter(m => m.holder === 'manjari');

  const totalVal = (arr) => arr.reduce((s, m) => s + (m.units && m.nav ? m.units * m.nav : 0), 0);
  const totalInv = (arr) => arr.reduce((s, m) => s + (mfEstimatedInvested(m) || 0), 0);

  function holderSection(arr, label) {
    if (!arr.length) return '';
    const tv = totalVal(arr), ti = totalInv(arr);
    const pct = ti > 0 ? ((tv - ti) / ti * 100) : null;
    const rows = arr.map(m => {
      const cv   = m.units && m.nav ? m.units * m.nav : null;
      const inv  = mfEstimatedInvested(m);
      const ret  = cv && inv && inv > 0 ? ((cv - inv) / inv * 100) : null;
      return `<tr>
        <td style="font-weight:500;color:var(--text-strong)">
          ${esc(m.fund_name)}
          ${m.amc ? `<div class="t-faint" style="font-size:10px">${esc(m.amc)}</div>` : ''}
        </td>
        <td class="num t-muted">${m.units != null ? Number(m.units).toLocaleString('en-IN', {maximumFractionDigits:3}) : '—'}</td>
        <td class="num t-muted">${m.nav ? '₹' + Number(m.nav).toLocaleString('en-IN', {maximumFractionDigits:4}) : '—'}<div class="t-faint" style="font-size:9px">${m.nav_date || ''}</div></td>
        <td class="num t-strong">${cv ? '₹' + Math.round(cv).toLocaleString('en-IN') : '—'}</td>
        <td class="num t-muted">${inv ? '₹' + Math.round(inv).toLocaleString('en-IN') : '—'}</td>
        <td class="num" style="font-weight:700;color:${ret == null ? 'var(--text-faint)' : ret >= 0 ? '#34d399' : '#f87171'}">
          ${ret != null ? (ret >= 0 ? '+' : '') + ret.toFixed(1) + '%' : '—'}
        </td>
        <td>
          <div style="display:flex;gap:4px">
            ${m.scheme_code ? `<button onclick="refreshMfNav('${m.id}')" class="btn btn-ghost text-xs py-1 px-2" title="Refresh NAV">⟳</button>` : ''}
            <button onclick="editMf('${m.id}')" class="btn btn-ghost text-xs py-1 px-2">✎</button>
            <button onclick="deleteMf('${m.id}')" class="btn btn-red text-xs py-1 px-2">✕</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    return `<div class="mb-5">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <span class="text-xs font-semibold t-muted uppercase tracking-wide">${label}</span>
        <span class="badge" style="background:var(--accent)18;color:var(--accent)">₹${Math.round(tv).toLocaleString('en-IN')}</span>
        ${ti > 0 ? `<span class="t-faint text-xs">invested ₹${Math.round(ti).toLocaleString('en-IN')}</span>` : ''}
        ${pct != null ? `<span style="font-size:11px;font-weight:700;color:${pct>=0?'#34d399':'#f87171'}">${pct>=0?'+':''}${pct.toFixed(1)}%</span>` : ''}
      </div>
      <div class="card" style="padding:0;overflow-x:auto">
        <table class="tbl">
          <thead><tr>
            <th class="text-left">Fund</th>
            <th class="text-right">Units</th>
            <th class="text-right">NAV</th>
            <th class="text-right">Current Value</th>
            <th class="text-right">Invested</th>
            <th class="text-right">Returns</th>
            <th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  const grandVal = totalVal(funds), grandInv = totalInv(funds);
  const grandPct = grandInv > 0 ? ((grandVal - grandInv) / grandInv * 100) : null;

  return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <div class="text-sm font-semibold t-muted">📈 Mutual Funds</div>
      ${funds.length ? `<span class="badge" style="background:var(--accent)18;color:var(--accent);font-weight:700">₹${Math.round(grandVal).toLocaleString('en-IN')}</span>` : ''}
      ${grandPct != null ? `<span style="font-size:11px;font-weight:700;color:${grandPct>=0?'#34d399':'#f87171'}">${grandPct>=0?'+':''}${grandPct.toFixed(1)}% overall</span>` : ''}
      <button onclick="refreshAllMfNav()" class="btn btn-ghost text-xs" style="margin-left:4px">⟳ Refresh All NAVs</button>
      <button onclick="openMfAdd()" style="background:var(--accent)22;border:1px solid var(--accent)55;color:var(--accent);border-radius:5px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;margin-left:auto">+ Add Fund</button>
    </div>
    ${!funds.length ? `<div class="t-faint text-xs">No mutual funds added yet</div>` : ''}
    ${holderSection(vib, 'Vibhanshu')}
    ${holderSection(man, 'Manjari')}`;
}

// MF CRUD
function openMfAdd() {
  document.getElementById('mf-modal-title').textContent = 'Add Mutual Fund';
  ['mf-edit-id','mf-name','mf-amc','mf-scheme-code','mf-units','mf-nav','mf-sip-amount','mf-sip-start','mf-total-invested','mf-notes']
    .forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  document.getElementById('mf-nav-date').textContent = '';
  document.getElementById('mf-holder').value = 'vibhanshu';
  document.getElementById('mf-sip-freq').value = 'monthly';
  document.getElementById('mf-search-results').style.display = 'none';
  document.getElementById('mf-modal').classList.remove('hidden');
}

function editMf(id) {
  const m = (state.mutual_funds || []).find(x => x.id === id);
  if (!m) return;
  document.getElementById('mf-modal-title').textContent = 'Edit Mutual Fund';
  document.getElementById('mf-edit-id').value         = m.id;
  document.getElementById('mf-name').value             = m.fund_name || '';
  document.getElementById('mf-amc').value              = m.amc || '';
  document.getElementById('mf-scheme-code').value      = m.scheme_code || '';
  document.getElementById('mf-holder').value           = m.holder || 'vibhanshu';
  document.getElementById('mf-units').value            = m.units ?? '';
  document.getElementById('mf-nav').value              = m.nav ?? '';
  document.getElementById('mf-nav-date').textContent   = m.nav_date ? `(${m.nav_date})` : '';
  document.getElementById('mf-sip-amount').value       = m.sip_amount ?? '';
  document.getElementById('mf-sip-freq').value         = m.sip_frequency || 'monthly';
  document.getElementById('mf-sip-start').value        = m.sip_start_date || '';
  document.getElementById('mf-total-invested').value   = m.total_invested ?? '';
  document.getElementById('mf-notes').value            = m.notes || '';
  document.getElementById('mf-search-results').style.display = 'none';
  document.getElementById('mf-modal').classList.remove('hidden');
}

function closeMfModal() { document.getElementById('mf-modal').classList.add('hidden'); }

async function saveMf(e) {
  e.preventDefault();
  const id = document.getElementById('mf-edit-id').value;
  const body = {
    fund_name:      document.getElementById('mf-name').value,
    amc:            document.getElementById('mf-amc').value || null,
    scheme_code:    document.getElementById('mf-scheme-code').value || null,
    holder:         document.getElementById('mf-holder').value,
    units:          parseFloat(document.getElementById('mf-units').value) || null,
    nav:            parseFloat(document.getElementById('mf-nav').value) || null,
    nav_date:       document.getElementById('mf-nav-date').textContent.replace(/[()]/g,'').trim() || null,
    sip_amount:     parseFloat(document.getElementById('mf-sip-amount').value) || null,
    sip_frequency:  document.getElementById('mf-sip-freq').value,
    sip_start_date: document.getElementById('mf-sip-start').value || null,
    total_invested: parseFloat(document.getElementById('mf-total-invested').value) || null,
    notes:          document.getElementById('mf-notes').value,
  };
  const url = id ? `/api/mutual_funds/${id}` : '/api/mutual_funds';
  const method = id ? 'PUT' : 'POST';
  await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  closeMfModal();
  await fetchData();
}

async function deleteMf(id) {
  if (!confirm('Remove this mutual fund?')) return;
  await fetch(`/api/mutual_funds/${id}`, { method:'DELETE' });
  await fetchData();
}

async function fetchMfNav() {
  const sc = document.getElementById('mf-scheme-code').value.trim();
  if (!sc) { alert('Enter a scheme code first'); return; }
  const res  = await fetch(`/api/mf_nav?scheme_code=${encodeURIComponent(sc)}`);
  const data = await res.json();
  if (data.error) { alert('NAV fetch error: ' + data.error); return; }
  document.getElementById('mf-nav').value   = data.nav;
  document.getElementById('mf-nav-date').textContent = `(${data.nav_date})`;
  if (!document.getElementById('mf-name').value) document.getElementById('mf-name').value = data.fund_name;
  if (!document.getElementById('mf-amc').value)  document.getElementById('mf-amc').value  = data.amc;
}

async function searchMfScheme() {
  const q = document.getElementById('mf-name').value.trim();
  if (!q) return;
  const res     = await fetch(`/api/mf_nav/search?q=${encodeURIComponent(q)}`);
  const results = await res.json();
  const box     = document.getElementById('mf-search-results');
  if (!results.length || results.error) { box.style.display = 'none'; return; }
  box.innerHTML = results.map(r =>
    `<div onclick="pickMfScheme('${r.schemeCode}','${esc(r.schemeName).replace(/'/g,'\\\'')}')"
      style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--border)"
      onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
      <span style="font-weight:500;color:var(--text-strong)">${esc(r.schemeName)}</span>
      <span class="t-faint" style="font-size:10px;margin-left:6px">#${r.schemeCode}</span>
    </div>`).join('');
  box.style.display = 'block';
}

function pickMfScheme(code, name) {
  document.getElementById('mf-scheme-code').value = code;
  document.getElementById('mf-name').value = name;
  document.getElementById('mf-search-results').style.display = 'none';
  fetchMfNav();
}

async function refreshMfNav(id) {
  const m = (state.mutual_funds || []).find(x => x.id === id);
  if (!m?.scheme_code) return;
  const res  = await fetch(`/api/mf_nav?scheme_code=${encodeURIComponent(m.scheme_code)}`);
  const data = await res.json();
  if (data.nav) {
    await fetch(`/api/mutual_funds/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ nav: data.nav, nav_date: data.nav_date }) });
    await fetchData();
  }
}

async function refreshAllMfNav() {
  const res  = await fetch('/api/mf_nav/refresh_all', { method:'POST' });
  const data = await res.json();
  await fetchData();
  alert(`Updated NAV for ${data.updated} of ${data.total} funds`);
}

// ─── Other Assets tab (Mutual Funds + NPS + Fixed Income + Unlisted) ────────
function renderOtherAssets() {
  return `
    <div class="flex gap-2 mb-6 flex-wrap">
      ${renderOtherSummaryChips()}
    </div>
    <div class="mb-8">
      ${renderMutualFunds()}
    </div>
    <div class="mb-8">
      ${renderNps()}
    </div>
    <div class="mb-8">
      ${renderFixedIncome()}
    </div>
    <div>
      ${renderUnlisted()}
    </div>`;
}

function renderOtherSummaryChips() {
  const mfs = state.mutual_funds || [];
  const nps = state.nps          || [];
  const fi  = state.fixed_income || [];
  const ul  = state.unlisted     || [];
  const mfVal  = mfs.reduce((s, m) => s + (m.units && m.nav ? m.units * m.nav : 0), 0);
  const mfInv  = mfs.reduce((s, m) => s + (m.total_invested || 0), 0);
  const mfPct  = mfInv > 0 ? ((mfVal - mfInv) / mfInv * 100) : null;
  const npsVal = nps.reduce((s, n) => s + (n.current_value || 0), 0);
  const npsInv = nps.reduce((s, n) => s + (n.total_invested || 0), 0);
  const npsPct = npsInv > 0 ? ((npsVal - npsInv) / npsInv * 100) : null;
  const fiVal  = fi.reduce((s, f) => s + (f._computed_value || f.principal || 0), 0);
  const ulVal  = ul.reduce((s, u) => s + (u.current_valuation || u.invested_amount || 0), 0);
  const ulInv  = ul.reduce((s, u) => s + (u.invested_amount || 0), 0);
  const ulPct  = ulInv > 0 ? ((ulVal - ulInv) / ulInv * 100) : null;
  const total  = mfVal + npsVal + fiVal + ulVal;
  return [
    { l:'Mutual Funds', v:'₹'+Math.round(mfVal).toLocaleString('en-IN'),  col:'#34d399',
      sub: mfPct != null ? `${mfPct>=0?'+':''}${mfPct.toFixed(1)}%` : null },
    { l:'NPS',          v:'₹'+Math.round(npsVal).toLocaleString('en-IN'), col:'#f59e0b',
      sub: npsPct != null ? `${npsPct>=0?'+':''}${npsPct.toFixed(1)}%` : null },
    { l:'Fixed Income', v:'₹'+Math.round(fiVal).toLocaleString('en-IN'),  col:'#60a5fa' },
    { l:'Unlisted',     v:'₹'+Math.round(ulVal).toLocaleString('en-IN'),  col:'#f472b6',
      sub: ulPct != null ? `${ulPct>=0?'+':''}${ulPct.toFixed(1)}%` : null },
    { l:'Total',        v:'₹'+Math.round(total).toLocaleString('en-IN'),  col:'var(--accent)' },
  ].map(c => `<div class="card text-center" style="min-width:130px;border-color:${c.col}44">
    <div style="font-size:17px;font-weight:700;color:${c.col}">${c.v}</div>
    ${c.sub ? `<div style="font-size:11px;font-weight:600;color:${c.col}">${c.sub}</div>` : ''}
    <div style="font-size:10px;color:var(--text-faint);margin-top:2px">${c.l}</div>
  </div>`).join('');
}

// NPS
function renderNps() {
  const items = state.nps || [];
  const byHolder = { vibhanshu: items.filter(n => n.holder !== 'manjari'), manjari: items.filter(n => n.holder === 'manjari') };

  function holderSection(holder, label) {
    const hItems = byHolder[holder];
    const totalVal = hItems.reduce((s, n) => s + (n.current_value || 0), 0);
    const totalInv = hItems.reduce((s, n) => s + (n.total_invested || 0), 0);
    const gainPct  = totalInv > 0 ? ((totalVal - totalInv) / totalInv * 100) : null;
    const rows = hItems.map(n => {
      const gain    = (n.current_value || 0) - (n.total_invested || 0);
      const pct     = n.total_invested > 0 ? (gain / n.total_invested * 100) : null;
      const gainCol = gain >= 0 ? '#34d399' : '#f87171';
      return `<tr>
        <td>
          <div style="font-weight:500;color:var(--text-strong)">${n.tier}</div>
          ${n.pran ? `<div style="font-size:10px;color:var(--text-faint)">PRAN: ${esc(n.pran)}</div>` : ''}
        </td>
        <td>${n.fund_manager ? `<span class="badge">${esc(n.fund_manager)}</span>` : '<span class="t-faint">—</span>'}</td>
        <td>${n.scheme ? `<span class="badge" style="background:#f59e0b18;color:#f59e0b;border-color:#f59e0b44">${esc(n.scheme)}</span>` : '<span class="t-faint">—</span>'}</td>
        <td class="num t-muted">₹${Math.round(n.total_invested || 0).toLocaleString('en-IN')}</td>
        <td class="num" style="font-weight:600;color:var(--text-strong)">
          ₹${Math.round(n.current_value || 0).toLocaleString('en-IN')}
          ${pct != null ? `<div style="font-size:10px;color:${gainCol}">${pct>=0?'+':''}${pct.toFixed(1)}%</div>` : ''}
        </td>
        <td class="t-faint" style="font-size:11px">${n.as_of_date || '—'}</td>
        <td style="font-size:12px;max-width:140px">${inlineCollapsibleNotes(n.notes)}</td>
        <td>
          <div style="display:flex;gap:3px">
            <button onclick="editNps('${n.id}')" class="btn btn-ghost text-xs py-1 px-2">✎</button>
            <button onclick="deleteNps('${n.id}')" class="btn btn-red text-xs py-1 px-2">✕</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    return `<div style="margin-bottom:${holder==='vibhanshu'?'14px':'0'}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;color:var(--text-muted)">${label}</span>
        ${totalVal > 0 ? `<span class="badge" style="background:#f59e0b18;color:#f59e0b;font-weight:700">₹${Math.round(totalVal).toLocaleString('en-IN')}</span>` : ''}
        ${gainPct != null ? `<span style="font-size:11px;font-weight:600;color:${gainPct>=0?'#34d399':'#f87171'}">${gainPct>=0?'+':''}${gainPct.toFixed(1)}%</span>` : ''}
      </div>
      ${hItems.length ? `<table class="tbl"><thead><tr>
        <th class="text-left">Tier</th><th class="text-left">Fund Manager</th><th class="text-left">Scheme</th>
        <th class="text-right">Invested</th><th class="text-right">Current Value</th>
        <th class="text-left">As Of</th><th class="text-left">Notes</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="t-faint text-xs">No NPS entries for ${label}</div>`}
    </div>`;
  }

  const totalVal = items.reduce((s, n) => s + (n.current_value || 0), 0);
  return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <div class="text-sm font-semibold t-muted">🏛️ NPS</div>
      ${items.length ? `<span class="badge" style="background:#f59e0b18;color:#f59e0b;font-weight:700">₹${Math.round(totalVal).toLocaleString('en-IN')}</span>` : ''}
      <button onclick="openNpsAdd()" style="background:var(--accent)22;border:1px solid var(--accent)55;color:var(--accent);border-radius:5px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;margin-left:auto">+ Add</button>
    </div>
    <div class="card" style="padding:14px 16px">
      ${holderSection('vibhanshu', 'Vibhanshu')}
      ${holderSection('manjari',   'Manjari')}
    </div>`;
}

// NPS CRUD
function openNpsAdd() {
  document.getElementById('nps-modal-title').textContent = 'Add NPS Account';
  ['nps-edit-id','nps-pran','nps-invested','nps-current-value','nps-notes'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('nps-holder').value       = 'vibhanshu';
  document.getElementById('nps-tier').value         = 'Tier I';
  document.getElementById('nps-fund-manager').value = '';
  document.getElementById('nps-scheme').value       = '';
  document.getElementById('nps-as-of-date').value   = '';
  document.getElementById('nps-modal').classList.remove('hidden');
}

function editNps(id) {
  const n = (state.nps || []).find(x => x.id === id);
  if (!n) return;
  document.getElementById('nps-modal-title').textContent   = 'Edit NPS Account';
  document.getElementById('nps-edit-id').value             = n.id;
  document.getElementById('nps-holder').value              = n.holder || 'vibhanshu';
  document.getElementById('nps-tier').value                = n.tier || 'Tier I';
  document.getElementById('nps-fund-manager').value        = n.fund_manager || '';
  document.getElementById('nps-scheme').value              = n.scheme || '';
  document.getElementById('nps-pran').value                = n.pran || '';
  document.getElementById('nps-invested').value            = n.total_invested ?? '';
  document.getElementById('nps-current-value').value       = n.current_value ?? '';
  document.getElementById('nps-as-of-date').value          = n.as_of_date || '';
  document.getElementById('nps-notes').value               = n.notes || '';
  document.getElementById('nps-modal').classList.remove('hidden');
}

function closeNpsModal() { document.getElementById('nps-modal').classList.add('hidden'); }

async function saveNps(e) {
  e.preventDefault();
  const id      = document.getElementById('nps-edit-id').value;
  const payload = {
    holder:         document.getElementById('nps-holder').value,
    tier:           document.getElementById('nps-tier').value,
    fund_manager:   document.getElementById('nps-fund-manager').value || null,
    scheme:         document.getElementById('nps-scheme').value || null,
    pran:           document.getElementById('nps-pran').value || null,
    total_invested: parseFloat(document.getElementById('nps-invested').value) || null,
    current_value:  parseFloat(document.getElementById('nps-current-value').value) || null,
    as_of_date:     document.getElementById('nps-as-of-date').value || null,
    notes:          document.getElementById('nps-notes').value || '',
  };
  const url    = id ? `/api/nps/${id}` : '/api/nps';
  const method = id ? 'PUT' : 'POST';
  await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  closeNpsModal();
  await fetchData();
}

async function deleteNps(id) {
  if (!confirm('Remove this NPS entry?')) return;
  await fetch(`/api/nps/${id}`, { method: 'DELETE' });
  await fetchData();
}

// Fixed Income
function renderFixedIncome() {
  const items = state.fixed_income || [];
  const rows = items.map(f => {
    const val = f._computed_value || f.principal || 0;
    const gain = val - (f.principal || 0);
    const gainPct = f.principal > 0 ? (gain / f.principal * 100) : null;
    const daysLeft = f.maturity_date
      ? Math.ceil((new Date(f.maturity_date) - new Date()) / 86400000) : null;
    const matColor = daysLeft != null ? (daysLeft < 30 ? '#f87171' : daysLeft < 90 ? '#f59e0b' : 'var(--text-muted)') : 'var(--text-faint)';
    return `<tr>
      <td style="font-weight:500;color:var(--text-strong)">${esc(f.name)}</td>
      <td><span class="badge">${esc(f.type)}</span></td>
      <td><span class="t-faint" style="font-size:11px">${f.holder === 'manjari' ? 'Manjari' : 'Vibhanshu'}</span></td>
      <td class="num t-muted">₹${Math.round(f.principal||0).toLocaleString('en-IN')}</td>
      <td class="num t-faint" style="font-size:11px">${f.rate ? f.rate+'% p.a.' : '—'}</td>
      <td class="num t-strong" style="font-weight:600">₹${Math.round(val).toLocaleString('en-IN')}
        ${gainPct != null ? `<div style="font-size:10px;color:${gainPct>=0?'#34d399':'#f87171'}">${gainPct>=0?'+':''}${gainPct.toFixed(1)}%</div>` : ''}
      </td>
      <td style="font-size:11px;color:${matColor}">${f.maturity_date || '—'}${daysLeft!=null?`<div style="font-size:9px">${daysLeft>0?daysLeft+'d left':'matured'}</div>`:''}
      </td>
      <td>
        <div style="display:flex;gap:3px">
          <button onclick="editFi('${f.id}')" class="btn btn-ghost text-xs py-1 px-2">✎</button>
          <button onclick="deleteFi('${f.id}')" class="btn btn-red text-xs py-1 px-2">✕</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  const total = items.reduce((s, f) => s + (f._computed_value || f.principal || 0), 0);
  return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <div class="text-sm font-semibold t-muted">🏦 Fixed Income</div>
      ${items.length ? `<span class="badge" style="background:#60a5fa18;color:#60a5fa;font-weight:700">₹${Math.round(total).toLocaleString('en-IN')}</span>` : ''}
      <button onclick="openFiAdd()" style="background:var(--accent)22;border:1px solid var(--accent)55;color:var(--accent);border-radius:5px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;margin-left:auto">+ Add</button>
    </div>
    <div class="card" style="padding:0;overflow-x:auto">
      <table class="tbl">
        <thead><tr>
          <th class="text-left">Name</th>
          <th class="text-left">Type</th>
          <th class="text-left">Holder</th>
          <th class="text-right">Principal</th>
          <th class="text-right">Rate</th>
          <th class="text-right">Current Value</th>
          <th class="text-left">Maturity</th>
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="8" class="text-center t-faint py-6">No fixed income entries yet</td></tr>`}</tbody>
      </table>
    </div>`;
}

// Fixed Income CRUD
function openFiAdd() {
  document.getElementById('fi-modal-title').textContent = 'Add Fixed Income';
  ['fi-edit-id','fi-name','fi-principal','fi-rate','fi-start','fi-maturity','fi-current-value','fi-notes']
    .forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  document.getElementById('fi-type').value = 'FD';
  document.getElementById('fi-holder').value = 'vibhanshu';
  document.getElementById('fi-compounding').value = 'quarterly';
  document.getElementById('fi-modal').classList.remove('hidden');
}

function editFi(id) {
  const f = (state.fixed_income || []).find(x => x.id === id);
  if (!f) return;
  document.getElementById('fi-modal-title').textContent = 'Edit Fixed Income';
  document.getElementById('fi-edit-id').value        = f.id;
  document.getElementById('fi-name').value            = f.name || '';
  document.getElementById('fi-type').value            = f.type || 'FD';
  document.getElementById('fi-holder').value          = f.holder || 'vibhanshu';
  document.getElementById('fi-principal').value       = f.principal ?? '';
  document.getElementById('fi-rate').value            = f.rate ?? '';
  document.getElementById('fi-compounding').value     = f.compounding || 'quarterly';
  document.getElementById('fi-start').value           = f.start_date || '';
  document.getElementById('fi-maturity').value        = f.maturity_date || '';
  document.getElementById('fi-current-value').value   = f.current_value ?? '';
  document.getElementById('fi-notes').value           = f.notes || '';
  document.getElementById('fi-modal').classList.remove('hidden');
}

function closeFiModal() { document.getElementById('fi-modal').classList.add('hidden'); }

async function saveFi(e) {
  e.preventDefault();
  const id   = document.getElementById('fi-edit-id').value;
  const body = {
    name:          document.getElementById('fi-name').value,
    type:          document.getElementById('fi-type').value,
    holder:        document.getElementById('fi-holder').value,
    principal:     parseFloat(document.getElementById('fi-principal').value) || 0,
    rate:          parseFloat(document.getElementById('fi-rate').value) || null,
    compounding:   document.getElementById('fi-compounding').value,
    start_date:    document.getElementById('fi-start').value || null,
    maturity_date: document.getElementById('fi-maturity').value || null,
    current_value: parseFloat(document.getElementById('fi-current-value').value) || null,
    notes:         document.getElementById('fi-notes').value,
  };
  const url = id ? `/api/fixed_income/${id}` : '/api/fixed_income';
  await fetch(url, { method: id?'PUT':'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  closeFiModal();
  await fetchData();
}

async function deleteFi(id) {
  if (!confirm('Delete this fixed income entry?')) return;
  await fetch(`/api/fixed_income/${id}`, { method:'DELETE' });
  await fetchData();
}

// Unlisted
function renderUnlisted() {
  const items = state.unlisted || [];
  const rows = items.map(u => {
    const val  = u.current_valuation || u.invested_amount || 0;
    const gain = val - (u.invested_amount || 0);
    const pct  = u.invested_amount > 0 ? (gain / u.invested_amount * 100) : null;
    const notesTrimmed = (u.notes || '').trim();
    const isBareUrl = /^https?:\/\/\S+$/.test(notesTrimmed);
    const nameCell = isBareUrl
      ? `<a href="${esc(notesTrimmed)}" target="_blank" rel="noopener" style="font-weight:500;color:var(--accent);text-decoration:none" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${esc(u.company_name)}</a>`
      : `<span style="font-weight:500;color:var(--text-strong)">${esc(u.company_name)}</span>`;
    const notesCell = inlineCollapsibleNotes(u.notes);
    return `<tr>
      <td>
        ${nameCell}
        ${u.stage ? `<span class="badge" style="margin-left:5px;background:rgba(244,114,182,.12);color:#f472b6;border-color:rgba(244,114,182,.3)">${esc(u.stage)}</span>` : ''}
      </td>
      <td>${u.sector ? `<span class="badge">${esc(u.sector)}</span>` : '<span class="t-faint">—</span>'}</td>
      <td><span class="t-faint" style="font-size:11px">${u.holder === 'manjari' ? 'Manjari' : 'Vibhanshu'}</span></td>
      <td class="num t-muted">₹${Math.round(u.invested_amount||0).toLocaleString('en-IN')}</td>
      <td class="num t-strong" style="font-weight:600">₹${Math.round(val).toLocaleString('en-IN')}
        ${pct != null ? `<div style="font-size:10px;color:${pct>=0?'#34d399':'#f87171'}">${pct>=0?'+':''}${pct.toFixed(1)}%</div>` : ''}
      </td>
      <td class="t-faint" style="font-size:11px">${u.investment_date || '—'}</td>
      <td style="font-size:12px;max-width:160px">${notesCell}</td>
      <td>
        <div style="display:flex;gap:3px">
          <button onclick="editUl('${u.id}')" class="btn btn-ghost text-xs py-1 px-2">✎</button>
          <button onclick="deleteUl('${u.id}')" class="btn btn-red text-xs py-1 px-2">✕</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  const totalVal = items.reduce((s, u) => s + (u.current_valuation || u.invested_amount || 0), 0);
  const totalInv = items.reduce((s, u) => s + (u.invested_amount || 0), 0);
  const pct = totalInv > 0 ? ((totalVal - totalInv) / totalInv * 100) : null;
  return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <div class="text-sm font-semibold t-muted">🔒 Unlisted Investments</div>
      ${items.length ? `<span class="badge" style="background:rgba(244,114,182,.12);color:#f472b6;font-weight:700">₹${Math.round(totalVal).toLocaleString('en-IN')}</span>` : ''}
      ${pct != null ? `<span style="font-size:11px;font-weight:700;color:${pct>=0?'#34d399':'#f87171'}">${pct>=0?'+':''}${pct.toFixed(1)}%</span>` : ''}
      <button onclick="openUlAdd()" style="background:var(--accent)22;border:1px solid var(--accent)55;color:var(--accent);border-radius:5px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;margin-left:auto">+ Add</button>
    </div>
    <div class="card" style="padding:0;overflow-x:auto">
      <table class="tbl">
        <thead><tr>
          <th class="text-left">Company</th>
          <th class="text-left">Sector</th>
          <th class="text-left">Holder</th>
          <th class="text-right">Invested</th>
          <th class="text-right">Current Value</th>
          <th class="text-left">Date</th>
          <th class="text-left">Notes</th>
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="8" class="text-center t-faint py-6">No unlisted investments yet</td></tr>`}</tbody>
      </table>
    </div>`;
}

// Unlisted CRUD
function openUlAdd() {
  document.getElementById('ul-modal-title').textContent = 'Add Unlisted Investment';
  ['ul-edit-id','ul-company','ul-sector','ul-stage','ul-invested','ul-valuation','ul-date','ul-notes']
    .forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  document.getElementById('ul-holder').value = 'vibhanshu';
  document.getElementById('ul-modal').classList.remove('hidden');
}

function editUl(id) {
  const u = (state.unlisted || []).find(x => x.id === id);
  if (!u) return;
  document.getElementById('ul-modal-title').textContent = 'Edit Unlisted Investment';
  document.getElementById('ul-edit-id').value        = u.id;
  document.getElementById('ul-company').value         = u.company_name || '';
  document.getElementById('ul-sector').value          = u.sector || '';
  document.getElementById('ul-holder').value          = u.holder || 'vibhanshu';
  document.getElementById('ul-stage').value           = u.stage || '';
  document.getElementById('ul-invested').value        = u.invested_amount ?? '';
  document.getElementById('ul-valuation').value       = u.current_valuation ?? '';
  document.getElementById('ul-date').value            = u.investment_date || '';
  document.getElementById('ul-notes').value           = u.notes || '';
  document.getElementById('ul-modal').classList.remove('hidden');
}

function closeUlModal() { document.getElementById('ul-modal').classList.add('hidden'); }

async function saveUl(e) {
  e.preventDefault();
  const id   = document.getElementById('ul-edit-id').value;
  const body = {
    company_name:      document.getElementById('ul-company').value,
    sector:            document.getElementById('ul-sector').value || null,
    holder:            document.getElementById('ul-holder').value,
    stage:             document.getElementById('ul-stage').value || null,
    invested_amount:   parseFloat(document.getElementById('ul-invested').value) || 0,
    current_valuation: parseFloat(document.getElementById('ul-valuation').value) || null,
    investment_date:   document.getElementById('ul-date').value || null,
    notes:             document.getElementById('ul-notes').value,
  };
  const url = id ? `/api/unlisted/${id}` : '/api/unlisted';
  await fetch(url, { method: id?'PUT':'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  closeUlModal();
  await fetchData();
}

async function deleteUl(id) {
  if (!confirm('Delete this unlisted investment?')) return;
  await fetch(`/api/unlisted/${id}`, { method:'DELETE' });
  await fetchData();
}

function renderWatchlist(listId, extraAddBtn) {
  listId = listId || 'watchlist';
  const isSoicIndia = listId === 'soic_research';
  const wl  = _sortWl(state.watchlist);  // caller may have swapped this via renderWatchlistById
  const lbl = (state.settings?.watchlist_groups || []).find(g => g.id === listId)?.name || 'Watchlist';

  const rows = wl.map(w => {
    const t = technicals[w.ticker] || null;
    const entryHtml = getEntryBadges(t);
    const tJson = JSON.stringify(t || null).replace(/&/g,'&amp;').replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/"/g,'&quot;');
    return `
    <tr>
      <td>
        ${_stockLink(w.ticker, w.stock_name)}
        <div style="font-size:10px" class="t-faint">${esc(w.ticker)}</div>
      </td>
      <td style="max-width:130px"><div style="white-space:normal;line-height:1.4">${w.sector ? `<span class="badge" style="white-space:normal;line-height:1.4;display:inline">${esc(w.sector)}</span>` : '<span class="t-faint">—</span>'}</div></td>
      ${isSoicIndia ? _tvgpCellEditable(w, listId) : ''}
      <td class="hoverable"
          onmouseenter="showEntryTooltip(event, ${tJson})"
          onmousemove="moveSigTooltip(event)"
          onmouseleave="hideSigTooltip()">${entryHtml}</td>
      ${wlPriceCells(w, technicals[w.ticker])}
      <td>${getResearchButtons(w)}</td>
      ${_wlDateCell(w, listId)}
      <td style="font-size:12px;max-width:200px">
        ${inlineCollapsibleNotes(w.notes)}
      </td>
      <td>
        <div class="flex gap-1">
          <button class="btn btn-blue text-xs py-1 px-2"
            onclick="moveToPortfolio('${w.id}','${esc(w.stock_name)}','${esc(w.ticker)}')">→ Portfolio</button>
          ${_wlMoveSelect(w.id, listId)}
          <button class="btn btn-ghost text-xs py-1 px-2" onclick="editWl('${w.id}','${listId}')">✎</button>
          <button class="btn btn-red text-xs py-1 px-2" onclick="deleteWl('${w.id}','${listId}')">✕</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  const addBtn = extraAddBtn || `<button class="btn btn-blue text-xs ml-auto" onclick="openWlAdd('${listId}')">+ Add to ${esc(lbl)}</button>`;
  const colCount = 9 + (isSoicIndia ? 1 : 0);

  // "Last updated" banner for SOIC Research India
  const updatedRaw = isSoicIndia && state.settings?.soic_research_updated;
  const updatedBanner = updatedRaw
    ? `<div style="font-size:11px;color:var(--text-faint);margin-bottom:8px">
         🕐 List last refreshed: <strong>${new Date(updatedRaw).toLocaleDateString('en-IN', {day:'numeric',month:'long',year:'numeric'})}</strong>
       </div>`
    : '';

  return `
    ${updatedBanner}
    <div class="flex items-center gap-2 flex-wrap mb-3">
      <button class="btn btn-ghost text-xs" onclick="refreshWatchlistSignals()" id="wl-signals-btn">⟳ Refresh Signals</button>
      <span class="text-xs t-faint">Fetches live EMAs, RSI, ADX, Stage for each watchlist stock</span>
      ${addBtn}
    </div>
    <div style="overflow-x:auto">
      <table class="tbl">
        <thead><tr>
          ${_wlTh('Stock',       'stock_name')}
          ${_wlTh('Sector',      'sector')}
          ${isSoicIndia ? '<th class="text-left">TVGP</th>' : ''}
          <th class="text-left">Signals</th>
          ${_wlTh('CMP',         'cmp',       'right')}
          ${_wlTh('Since Added', 'pct_chg',   'right')}
          <th class="text-left">Research</th>
          ${_wlTh('Added',       'added_date')}
          <th class="text-left">Notes</th>
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${colCount}" class="text-center t-faint py-8">No watchlist items</td></tr>`}</tbody>
      </table>
    </div>`;
}

// ─── US Watchlist ─────────────────────────────────────────────────────────────
function renderUSWatchlist() {
  const wl  = _sortWl(state.us_watchlist || []);
  const rows = wl.map(w => {
    const t = technicals[w.ticker] || null;
    const entryHtml = getEntryBadges(t);
    const tJson = JSON.stringify(t || null).replace(/&/g,'&amp;').replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/"/g,'&quot;');
    const yhLink = `https://www.perplexity.ai/finance/${encodeURIComponent(w.ticker)}`;
    const safeId     = w.id.replace(/'/g, "\\'");
    const safeName   = esc(w.stock_name).replace(/'/g, "\\'");
    const safeTicker = esc(w.ticker).replace(/'/g, "\\'");
    return `
    <tr>
      <td>
        <a href="${yhLink}" target="_blank" rel="noopener"
           style="font-weight:500;color:var(--text-strong);text-decoration:none;border-bottom:1px dotted var(--border)"
           onmouseover="this.style.color='#3b82f6'" onmouseout="this.style.color='var(--text-strong)'"
        >${esc(w.stock_name)}</a>
        ${w.source ? `<span style="display:inline-block;margin-left:5px;font-size:9px;font-weight:600;padding:1px 5px;border-radius:3px;background:rgba(139,92,246,0.15);color:#a78bfa;border:1px solid rgba(139,92,246,0.3);vertical-align:middle" title="${esc(w.source)}">${esc(w.source)}</span>` : ''}
        <div style="font-size:10px" class="t-faint">${esc(w.ticker)}</div>
      </td>
      <td style="max-width:130px"><div style="white-space:normal;line-height:1.4">${w.sector ? `<span class="badge" style="white-space:normal;line-height:1.4;display:inline">${esc(w.sector)}</span>` : '<span class="t-faint">—</span>'}</div></td>
      <td class="hoverable"
          onmouseenter="showUSEntryTooltip(event, ${tJson})"
          onmousemove="moveSigTooltip(event)"
          onmouseleave="hideSigTooltip()">${entryHtml}</td>
      ${wlPriceCells(w, technicals[w.ticker])}
      <td>${_renderResearchLinks(w, { collapsible: true })}</td>
      ${_wlDateCell(w, 'us_watchlist')}
      <td style="font-size:12px;max-width:200px">
        ${inlineCollapsibleNotes(w.notes)}
      </td>
      <td>
        <div class="flex gap-1">
          <button class="btn btn-blue text-xs py-1 px-2"
            onclick="usWlMoveToPortfolio('${safeId}','${safeName}','${safeTicker}')">→ Portfolio</button>
          ${_wlMoveSelect(w.id, 'us_watchlist')}
          <button class="btn btn-ghost text-xs py-1 px-2" onclick="editUSWl('${safeId}')">✎</button>
          <button class="btn btn-red text-xs py-1 px-2" onclick="deleteUSWl('${safeId}')">✕</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  const crs_label = 'S&amp;P 500';
  return `
    <div class="flex items-center gap-2 flex-wrap mb-3">
      <button class="btn btn-ghost text-xs" onclick="refreshUSWatchlistSignals()" id="us-wl-signals-btn">⟳ Refresh Signals</button>
      <span class="text-xs t-faint">Fetches EMAs, RSI, ADX, Weinstein Stage vs ${crs_label} for each US stock</span>
      <button class="btn btn-blue text-xs ml-auto" onclick="openUSWlAdd()">+ Add US Stock</button>
    </div>
    <div style="overflow-x:auto">
      <table class="tbl">
        <thead><tr>
          ${_wlTh('Stock / ETF', 'stock_name')}
          ${_wlTh('Sector',      'sector')}
          <th class="text-left">Signals</th>
          ${_wlTh('CMP',         'cmp',       'right')}
          ${_wlTh('Since Added', 'pct_chg',   'right')}
          <th class="text-left">Research</th>
          ${_wlTh('Added',       'added_date')}
          <th class="text-left">Notes</th>
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="9" class="text-center t-faint py-8">No US watchlist items — click + Add US Stock</td></tr>`}</tbody>
      </table>
    </div>`;
}

// US-specific entry tooltip (uses $ instead of ₹, shows S&P 500 as benchmark)
function _rUS(v, d = 2) {
  if (v == null || isNaN(v)) return '—';
  return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
}

function showUSEntryTooltip(event, t) {
  if (!t || !t.entry_signals) {
    _showTT(event, '<div class="t-faint" style="font-size:12px">No data — click ⟳ Refresh Signals</div>');
    return;
  }
  const s = t.entry_signals;
  const benchmark = t.benchmark || 'S&P 500';
  const defs = [
    ['Above 30W EMA',          s.above_30w_ema,     _rUS(t.ema30)],
    ['30W EMA Rising',         s.ema30_rising,      t.ema30_rising ? 'Uptrend' : 'Flat/Down'],
    ['RSI Buy Zone ≥45',       s.rsi_buy_zone,      t.rsi  != null ? t.rsi.toFixed(1)  : '—'],
    ['ADX Trending ≥20',       s.adx_trending,      t.adx  != null ? t.adx.toFixed(1)  : '—'],
    [`CRS vs ${benchmark}`,    s.crs_outperforming, t.crs_above_ma ? 'Outperforming' : 'Underperforming'],
    ['Near 52W High',          s.near_52w_high,     _rUS(t.peak_52w)],
  ];
  const rows = defs.map(([lbl, ok, val]) => `<tr>
    <td style="padding-right:6px">${ok ? '✓' : '✗'}</td>
    <td class="${ok ? 't-pos' : 't-neg'}" style="padding-right:12px">${lbl}</td>
    <td class="tt-val t-muted">${val}</td></tr>`);
  const score = t.entry_score ?? 0;
  const sc = score >= 4 ? '#34d399' : score >= 2 ? '#f59e0b' : '#f87171';
  const html = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-weight:700;font-size:14px;color:${sc}">${score}/6</span>
      <span class="t-strong" style="font-size:12px;font-weight:600">SOIC Entry Signals</span>
    </div>
    <table>${rows.join('')}</table>
    <div style="margin-top:8px;font-size:10px" class="t-faint">
      Weinstein Stage ${t.stage} · RS vs ${benchmark} · Updated ${t.updated || '—'}
    </div>`;
  _showTT(event, html);
}

// US Watchlist CRUD
function openUSWlAdd() {
  document.getElementById('us-wl-modal-title').textContent = 'Add to US Watchlist';
  ['us-wl-edit-id','us-wl-name','us-wl-ticker','us-wl-added-price','us-wl-notes']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  _wlLinksPopulate('us-wl', '', '');
  document.getElementById('us-wl-sector').value = '';
  document.getElementById('us-wl-modal').classList.remove('hidden');
}

function editUSWl(id) {
  const w = (state.us_watchlist || []).find(x => x.id === id);
  if (!w) return;
  document.getElementById('us-wl-modal-title').textContent = 'Edit US Watchlist';
  document.getElementById('us-wl-edit-id').value         = w.id;
  document.getElementById('us-wl-name').value             = w.stock_name || '';
  document.getElementById('us-wl-ticker').value           = w.ticker || '';
  document.getElementById('us-wl-added-price').value      = w.added_price ?? '';
  document.getElementById('us-wl-sector').value           = w.sector || '';
  document.getElementById('us-wl-notes').value            = w.notes || '';
  _wlLinksPopulate('us-wl', w.research_links || '', w.dashboard_url || '');
  document.getElementById('us-wl-modal').classList.remove('hidden');
}

function closeUSWlModal() { document.getElementById('us-wl-modal').classList.add('hidden'); }

async function saveUSWatchlist(e) {
  e.preventDefault();
  const id     = document.getElementById('us-wl-edit-id').value;
  const ticker = document.getElementById('us-wl-ticker').value.trim().toUpperCase();
  const body   = {
    stock_name:       document.getElementById('us-wl-name').value,
    ticker,
    added_price:      parseFloat(document.getElementById('us-wl-added-price').value) || null,
    sector:           document.getElementById('us-wl-sector').value || null,
    notes:            document.getElementById('us-wl-notes').value,
    research_links:   _wlLinksSerialize('us-wl') || null,
  };
  const url    = id ? `/api/us_watchlist/${id}` : '/api/us_watchlist';
  const method = id ? 'PUT' : 'POST';
  await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  closeUSWlModal();
  await fetchData();
  if (ticker) refreshSingleTicker(ticker);
}

async function deleteUSWl(id) {
  if (!confirm('Remove from US watchlist?')) return;
  await fetch(`/api/us_watchlist/${id}`, { method: 'DELETE' });
  await fetchData();
}

function usWlMoveToPortfolio(wlId, name, ticker) {
  openAdd('us_vibhanshu');
  document.getElementById('f-name').value     = name;
  document.getElementById('f-ticker').value   = ticker;
  document.getElementById('f-currency').value = 'USD';
}

// On page load: silently fill added_price for any items still missing it
async function silentBackfillAddedPrices() {
  const allGroups = state.settings?.watchlist_groups || [{id:'watchlist'},{id:'us_watchlist'}];
  const pairs = allGroups.flatMap(g => (state[g.id] || []).filter(w => !w.added_price && w.added_date).map(w => [w, g.id]));
  if (!pairs.length) return;
  for (const [w, key] of pairs) {
    await backfillAddedPrice(w, key);
  }
  if (pairs.length) renderTab();
}

// Auto-fill added_price from historical close on added_date if missing
async function backfillAddedPrice(w, listKey) {
  if (w.added_price || !w.added_date || !w.ticker) return;
  try {
    const res  = await fetch(`/api/quote?ticker=${encodeURIComponent(w.ticker)}&on=${w.added_date}`);
    const data = await res.json();
    if (!data.price) return;
    // Persist to server
    const endpoint = `${_wlApiBase(listKey)}/${w.id}`;
    await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ added_price: data.price }),
    });
    // Update local state immediately so the column renders without a full fetchData
    const arr = state[listKey] || [];
    const item = arr.find(x => x.id === w.id);
    if (item) item.added_price = data.price;
  } catch { /* silent — non-critical */ }
}

async function refreshUSWatchlistSignals() {
  await fetchData();  // ensure fresh tickers from server before iterating
  const wl      = state.us_watchlist || [];
  const tickers = wl.map(w => w.ticker).filter(Boolean);
  if (!tickers.length) return;

  const setBtn = (txt, dis) => {
    const b = document.getElementById('us-wl-signals-btn');
    if (b) { b.textContent = txt; b.disabled = dis; }
  };
  setBtn(`⟳ 0/${tickers.length}`, true);

  let done = 0;
  for (const w of wl) {
    if (!w.ticker) continue;
    try {
      const res  = await fetch('/api/technicals/single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: w.ticker }),
      });
      const data = await res.json();
      technicals[w.ticker] = data.data || { error: 'no data' };
    } catch (e) {
      technicals[w.ticker] = { error: String(e) };
    }
    // Backfill added_price in parallel (non-blocking)
    backfillAddedPrice(w, 'us_watchlist').then(() => renderTab());
    done++;
    renderTab();
    setBtn(`⟳ ${done}/${tickers.length}`, true);
  }
  setTimeout(() => { renderTab(); setBtn('⟳ Refresh Signals', false); }, 100);
}

async function refreshIntlWatchlistSignals(listId) {
  await fetchData();
  const wl = (state[listId] || []);
  if (!wl.length) return;

  const setBtn = (txt, dis) => {
    const b = document.getElementById('intl-wl-signals-btn');
    if (b) { b.textContent = txt; b.disabled = dis; }
  };
  setBtn(`⟳ 0/${wl.length}`, true);

  let done = 0;
  for (const w of wl) {
    if (!w.ticker) continue;
    try {
      const res  = await fetch('/api/technicals/single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: w.ticker }),
      });
      const data = await res.json();
      technicals[w.ticker] = data.data || { error: 'no data' };
    } catch (e) {
      technicals[w.ticker] = { error: String(e) };
    }
    done++;
    renderTab();
    setBtn(`⟳ ${done}/${wl.length}`, true);
  }
  setTimeout(() => { renderTab(); setBtn('⟳ Refresh Signals', false); }, 100);
}

// ─── Sorting ──────────────────────────────────────────────────────────────────
function sortBy(key) {
  if (sortKey === key) sortDir *= -1;
  else { sortKey = key; sortDir = -1; }
  renderTab();
}

function sortPositions(arr) {
  if (!sortKey) return arr;
  return [...arr].sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    const inf = sortDir > 0 ? Infinity : -Infinity;
    if (va == null) va = inf;
    if (vb == null) vb = inf;
    if (typeof va === 'string') return sortDir * va.localeCompare(vb);
    return sortDir * (vb - va);
  });
}

// ─── Watchlist sort helpers ───────────────────────────────────────────────────
function sortWlBy(key) {
  if (wlSortKey === key) wlSortDir *= -1;
  else { wlSortKey = key; wlSortDir = -1; }
  renderTab();
}

const _CONV_ORDER = { High: 3, Medium: 2, Low: 1 };

function _wlSortVal(w, key) {
  const cmp = livePrices[w.ticker] ?? technicals[w.ticker]?.cmp ?? null;
  switch (key) {
    case 'stock_name':  return (w.stock_name || '').toLowerCase();
    case 'sector':      return (w.sector || '').toLowerCase();
    case 'added_date':  return w.added_date || '';
    case 'added_price': return w.added_price ?? null;
    case 'cmp':         return cmp;
    case 'pct_chg': {
      if (cmp == null || !w.added_price) return null;
      return (cmp - w.added_price) / w.added_price * 100;
    }
    case 'market_cap': {
      const live = liveMarketCaps[w.ticker] ?? w.market_cap_live ?? null;
      if (live) return live;
      // try to parse stored string like "$2.93T USD" → rough numeric
      const raw = (w.market_cap || '').replace(/[,$\s]/g, '');
      const m = raw.match(/([\d.]+)([TBMK]?)/i);
      if (!m) return null;
      const n = parseFloat(m[1]);
      const u = (m[2] || '').toUpperCase();
      return n * (u === 'T' ? 1e12 : u === 'B' ? 1e9 : u === 'M' ? 1e6 : u === 'K' ? 1e3 : 1);
    }
    case 'conviction':  return _CONV_ORDER[w.conviction] ?? 0;
    case 'exchange':    return (w.exchange || _extractExchange(w)).toLowerCase();
    default:            return null;
  }
}

function _sortWl(arr) {
  if (!wlSortKey) return arr;
  return [...arr].sort((a, b) => {
    let va = _wlSortVal(a, wlSortKey);
    let vb = _wlSortVal(b, wlSortKey);
    const inf = wlSortDir > 0 ? Infinity : -Infinity;
    if (va == null) va = typeof vb === 'string' ? '￿' : inf;
    if (vb == null) vb = typeof va === 'string' ? '￿' : inf;
    if (typeof va === 'string') return wlSortDir * va.localeCompare(vb);
    return wlSortDir * (vb - va);
  });
}

// Render a sortable <th> for watchlist tables
function _wlTh(label, key, align = 'left') {
  const active = wlSortKey === key;
  const arrow  = active ? (wlSortDir > 0 ? ' ↑' : ' ↓') : '';
  return `<th class="sort-th text-${align}" onclick="sortWlBy('${key}')">${label}${arrow}</th>`;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
async function updateCmp(id, val) {
  const cmp = parseFloat(val);
  if (isNaN(cmp) || cmp <= 0) return;
  await fetch(`/api/positions/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmp }),
  });
  await fetchData();
}

function _rebuildAccountSelect(selectedId) {
  const sel = document.getElementById('f-account');
  if (!sel) return;
  const pg  = state.settings?.portfolio_groups || {};
  const indian = (pg.indian || []);
  const us     = (pg.us     || []);
  sel.innerHTML =
    indian.map(p => `<option value="${p.id}">${p.name}</option>`).join('') +
    us.map(p => `<option value="${p.id}">US – ${p.name}</option>`).join('');
  if (selectedId) sel.value = selectedId;
}

function openAdd(account) {
  document.getElementById('modal-title').textContent = 'Add Position';
  document.getElementById('edit-id').value = '';
  document.getElementById('pos-form').reset();
  const allAccts = [
    ..._indianAccounts(),
    ..._usAccounts(),
  ];
  const resolved = account
    || (allAccts.includes(currentTab) ? currentTab : null)
    || (currentRegion === 'us' ? _usAccounts()[0] || 'us_vibhanshu' : _indianAccounts()[0] || 'vibhanshu');
  _rebuildAccountSelect(resolved);
  document.getElementById('modal').classList.remove('hidden');
}

function openEdit(p) {
  document.getElementById('modal-title').textContent = 'Edit Position';
  document.getElementById('edit-id').value       = p.id;
  _rebuildAccountSelect(p.account || 'vibhanshu');
  document.getElementById('f-currency').value    = p.currency    || 'INR';
  document.getElementById('f-name').value        = p.stock_name  || '';
  document.getElementById('f-ticker').value      = p.ticker      || '';
  document.getElementById('f-buy').value         = p.avg_buy_price || '';
  document.getElementById('f-qty').value         = p.quantity    || '';
  document.getElementById('f-cmp').value         = p.cmp         || '';
  document.getElementById('f-date').value        = p.buy_date    || '';
  document.getElementById('f-sector').value      = p.sector      || '';
  document.getElementById('f-pe').value          = p.pe          || '';
  document.getElementById('f-conviction').value  = p.conviction  || '';
  document.getElementById('f-active').value      = p.active ? 'true' : 'false';
  document.getElementById('f-notes').value       = p.notes       || '';
  document.getElementById('modal').classList.remove('hidden');
}

function openEditById(id) {
  const p = (state.positions || []).find(x => x.id === id);
  if (p) openEdit(p);
}
function closeModal() { document.getElementById('modal').classList.add('hidden'); }

async function savePosition(e) {
  e.preventDefault();
  const id     = document.getElementById('edit-id').value;
  const buyRaw = parseFloat(document.getElementById('f-buy').value);
  const qtyRaw = parseFloat(document.getElementById('f-qty').value);
  const cmpRaw = parseFloat(document.getElementById('f-cmp').value);

  if (isNaN(buyRaw) || isNaN(qtyRaw)) {
    alert('Avg Buy Price and Quantity are required numbers.');
    return;
  }

  const body   = {
    account:       document.getElementById('f-account').value,
    currency:      document.getElementById('f-currency').value,
    stock_name:    document.getElementById('f-name').value.trim(),
    ticker:        document.getElementById('f-ticker').value.trim(),
    avg_buy_price: buyRaw,
    quantity:      qtyRaw,
    cmp:           isNaN(cmpRaw) ? undefined : cmpRaw,
    buy_date:      document.getElementById('f-date').value      || null,
    sector:        document.getElementById('f-sector').value    || null,
    pe:            parseFloat(document.getElementById('f-pe').value)         || null,
    conviction:    parseFloat(document.getElementById('f-conviction').value) || null,
    active:        document.getElementById('f-active').value === 'true',
    notes:         document.getElementById('f-notes').value,
  };
  const url    = id ? `/api/positions/${id}` : '/api/positions';
  const method = id ? 'PUT' : 'POST';
  const res    = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    alert('Save failed: ' + (err.detail || JSON.stringify(err)));
    return;
  }
  closeModal();
  await fetchData();
}

async function deletePos(id) {
  if (!confirm('Remove this position?')) return;
  await fetch(`/api/positions/${id}`, { method: 'DELETE' });
  await fetchData();
}

// ─── Toast notification ───────────────────────────────────────────────────────
function showToast(msg, durationMs = 3000) {
  let t = document.getElementById('_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '_toast';
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e293b;color:#f1f5f9;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:500;z-index:9999;box-shadow:0 4px 12px #0008;pointer-events:none;transition:opacity .3s';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.style.opacity = '0'; }, durationMs);
}

// ─── Sell & Archive ───────────────────────────────────────────────────────────
function openSellModal(posId, name, cmp, qty) {
  document.getElementById('sell-pos-id').value  = posId;
  document.getElementById('sell-modal-name').textContent = name;
  document.getElementById('sell-price').value   = cmp || '';
  document.getElementById('sell-qty').value     = qty || '';
  document.getElementById('sell-date').value    = new Date().toISOString().slice(0,10);
  document.getElementById('sell-thesis').value  = '';
  document.getElementById('sell-antithesis').value = '';
  document.getElementById('sell-lessons').value = '';
  updateSellPreview();
  document.getElementById('sell-modal').classList.remove('hidden');
  document.getElementById('sell-price').addEventListener('input', updateSellPreview);
  document.getElementById('sell-qty').addEventListener('input', updateSellPreview);
}

function updateSellPreview() {
  const price = parseFloat(document.getElementById('sell-price')?.value) || 0;
  const qty   = parseFloat(document.getElementById('sell-qty')?.value)   || 0;
  const posId = document.getElementById('sell-pos-id')?.value;
  const pos   = (state.positions || []).find(p => p.id === posId);
  if (!pos || !price || !qty) { document.getElementById('sell-pnl-preview').textContent = ''; return; }
  const cost     = pos.avg_buy_price * qty;
  const proceeds = price * qty;
  const pnl      = proceeds - cost;
  const pct      = cost > 0 ? (pnl/cost*100) : 0;
  const col      = pnl >= 0 ? '#34d399' : '#f87171';
  document.getElementById('sell-pnl-preview').innerHTML =
    `<span style="color:${col};font-weight:700">${pnl>=0?'+':''}₹${Math.round(Math.abs(pnl)).toLocaleString('en-IN')} (${pct>=0?'+':''}${pct.toFixed(1)}%)</span>`;
}

function closeSellModal() { document.getElementById('sell-modal').classList.add('hidden'); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeSellModal();
    closeJournalEditModal();
  }
});

async function confirmSell(e) {
  e.preventDefault();
  const posId = document.getElementById('sell-pos-id').value;
  const payload = {
    sell_price:  parseFloat(document.getElementById('sell-price').value),
    sell_qty:    parseFloat(document.getElementById('sell-qty').value),
    sell_date:   document.getElementById('sell-date').value,
    thesis:      document.getElementById('sell-thesis').value,
    antithesis:  document.getElementById('sell-antithesis').value,
    lessons:     document.getElementById('sell-lessons').value,
  };
  await fetch(`/api/positions/${posId}/sell`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  closeSellModal();
  await fetchData();
}

// ─── Trades panel (collapsible per position) ──────────────────────────────────
function toggleTradesRow(posId) {
  const row = document.getElementById('trades-row-' + posId);
  if (row) row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
}

function renderTradesPanel(p, isCon, isUS) {
  const trades = p.trades || [];
  const sym = isUS ? curSym(p.currency) : '₹';
  const cur = sym;
  const fmtPrice = isUS
    ? v => sym + (v||0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})
    : v => '₹' + (v||0).toLocaleString('en-IN');
  const ACCT_COLOURS = { vibhanshu:'#6366f1', manjari:'#ec4899', huf:'#f59e0b',
                         manjbhawna:'#14b8a6', us_vibhanshu:'#3b82f6', us_manjari:'#8b5cf6', us_huf:'#10b981' };
  const rows = trades.map(function(t) {
    const isSell = t.type === 'sell';
    const col    = isSell ? '#f87171' : '#34d399';
    let badge = '';
    if (t._account) {
      const bc = ACCT_COLOURS[t._account] || '#64748b';
      badge = '<span style="font-size:9px;padding:1px 5px;border-radius:99px;font-weight:700;' +
              'background:' + bc + '22;color:' + bc + ';border:1px solid ' + bc + '44;flex-shrink:0">' +
              (ACCT_LABELS[t._account] || t._account) + '</span>';
    }
    const delBtn = !isCon
      ? '<button onclick="deleteTrade(\'' + p.id + '\',\'' + t.id + '\')" style="margin-left:auto;background:none;border:none;cursor:pointer;font-size:10px;color:var(--text-faint)">✕</button>'
      : '';
    return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">' +
      '<span style="color:' + col + ';font-weight:700;width:28px">' + (isSell ? '↑ S' : '↓ B') + '</span>' +
      '<span class="t-faint" style="width:88px">' + (t.date || '—') + '</span>' +
      badge +
      '<span style="width:62px">' + t.qty + ' shares</span>' +
      '<span style="width:82px">@ ' + fmtPrice(t.price) + '</span>' +
      '<span class="t-faint">' + (t.note ? esc(t.note) : '') + '</span>' +
      delBtn +
      '</div>';
  }).join('');

  const pricePlaceholder = isUS ? 'Price ($)' : 'Price (₹)';
  const addForm = isCon
    ? '<div style="font-size:11px;color:var(--text-faint);padding:6px 0;margin-top:4px">Go to the individual account tab to add trades.</div>'
    : '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
        '<select id="trade-type-' + p.id + '" style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px;color:var(--text-strong)">' +
          '<option value="buy">↓ Buy</option>' +
          '<option value="sell">↑ Sell</option>' +
        '</select>' +
        '<input id="trade-qty-' + p.id + '" type="number" placeholder="Qty" min="0" style="width:70px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px;color:var(--text-strong)">' +
        '<input id="trade-price-' + p.id + '" type="number" placeholder="' + pricePlaceholder + '" min="0" style="width:90px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px;color:var(--text-strong)">' +
        '<input id="trade-date-' + p.id + '" type="date" style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px;color:var(--text-strong)">' +
        '<input id="trade-note-' + p.id + '" type="text" placeholder="Note (optional)" style="flex:1;min-width:100px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px;color:var(--text-strong)">' +
        '<button onclick="addTrade(\'' + p.id + '\')" style="background:var(--accent)22;border:1px solid var(--accent)55;color:var(--accent);border-radius:4px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer">+ Log</button>' +
      '</div>';

  // ── "Why I bought" notes block ──────────────────────────────────────────────
  const whyBlock = (p.notes && p.notes.trim())
    ? '<div style="background:rgba(99,102,241,0.07);border-left:3px solid #6366f155;border-radius:0 6px 6px 0;' +
        'padding:8px 12px;margin-bottom:10px;position:relative">' +
        '<div style="font-size:10px;font-weight:700;color:#6366f1;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">💡 Why I bought</div>' +
        '<div style="font-size:12px;color:var(--text-strong);line-height:1.55;white-space:pre-wrap">' + esc(p.notes.trim()) + '</div>' +
        (!isCon
          ? '<button onclick="openEditById(\'' + p.id + '\');setTimeout(()=>document.getElementById(\'f-notes\')?.focus(),100)" ' +
              'style="position:absolute;top:6px;right:8px;background:none;border:none;cursor:pointer;font-size:10px;color:var(--text-faint)" title="Edit notes">✏️</button>'
          : '') +
      '</div>'
    : (!isCon
        ? '<div style="font-size:11px;color:var(--text-faint);padding:2px 0 8px;cursor:pointer" ' +
            'onclick="openEditById(\'' + p.id + '\');setTimeout(()=>document.getElementById(\'f-notes\')?.focus(),100)" ' +
            'title="Add your investment thesis">' +
            '💡 <em>Add your investment thesis…</em></div>'
        : '');

  return '<div style="padding:8px 12px 10px">' +
    whyBlock +
    '<div style="font-size:11px;font-weight:600;color:var(--text-faint);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px">Trade Log</div>' +
    (rows || '<div style="font-size:11px;color:var(--text-faint);padding:4px 0">No trades logged yet</div>') +
    addForm +
    '</div>';
}

async function addTrade(posId) {
  const type  = document.getElementById('trade-type-'  + posId)?.value || 'buy';
  const qty   = parseFloat(document.getElementById('trade-qty-'   + posId)?.value);
  const price = parseFloat(document.getElementById('trade-price-' + posId)?.value);
  const date  = document.getElementById('trade-date-'  + posId)?.value || '';
  const note  = document.getElementById('trade-note-'  + posId)?.value || '';
  if (isNaN(qty) || isNaN(price) || qty <= 0) return;
  // Swap-guard: warn if qty looks like a price (much larger than position size or >500 for sell)
  const pos = (state.positions || []).find(x => x.id === posId);
  if (pos && type === 'sell' && qty > (pos.quantity || 0) * 2) {
    if (!confirm(`Qty ${qty} is larger than position size ${pos.quantity}.\nDid you accidentally swap Qty and Price?\n\nContinue anyway?`)) return;
  }
  const res  = await fetch(`/api/positions/${posId}/trades`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ type, qty, price, date, note })
  });
  const json = await res.json().catch(() => null);
  await fetchData();
  if (json && json.archived) {
    // Position fully sold — switch to journal tab and show a toast
    showToast(`✅ Position archived to Journal`);
    switchTab('journal');
  } else {
    // re-open the trades row after refresh
    setTimeout(() => {
      const row = document.getElementById('trades-row-' + posId);
      if (row) row.style.display = 'table-row';
    }, 100);
  }
}

async function deleteTrade(posId, tradeId) {
  await fetch(`/api/positions/${posId}/trades/${tradeId}`, { method: 'DELETE' });
  await fetchData();
  setTimeout(() => {
    const row = document.getElementById('trades-row-' + posId);
    if (row) row.style.display = 'table-row';
  }, 100);
}

// ─── Journal tab ──────────────────────────────────────────────────────────────

// Render notes block (thesis / antithesis / lessons) — always a plain div list
function renderJournalNotes(p) {
  const parts = [];
  if (p.thesis)     parts.push(['📌 Thesis',    '#60a5fa', p.thesis]);
  if (p.antithesis) parts.push(['⚡ Why Sold',  '#f87171', p.antithesis]);
  if (p.lessons)    parts.push(['📚 Lessons',   '#f59e0b', p.lessons]);
  if (!parts.length) return '';
  return '<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">' +
    parts.map(([label, col, text]) =>
      '<div style="background:var(--bg2);border-left:3px solid ' + col + ';border-radius:0 6px 6px 0;padding:7px 10px">' +
        '<div style="font-size:10px;font-weight:700;color:' + col + ';text-transform:uppercase;margin-bottom:3px">' + label + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted);line-height:1.6;white-space:pre-wrap">' + esc(text) + '</div>' +
      '</div>'
    ).join('') +
  '</div>';
}

// Render trades collapsible
function renderJournalTrades(trades, currency) {
  if (!trades || !trades.length) return '';
  const sym = curSym(currency);
  const rows = trades.map(t => {
    const col = t.type === 'sell' ? '#f87171' : '#34d399';
    return '<div style="font-size:11px;display:flex;gap:10px;padding:3px 0;border-bottom:1px solid var(--border)">' +
      '<span style="color:' + col + ';width:14px">' + (t.type==='sell'?'↑':'↓') + '</span>' +
      '<span style="color:var(--text-faint);width:88px">' + (t.date||'—') + '</span>' +
      '<span style="color:var(--text-strong)">' + t.qty + ' shares @ ' + sym + (t.price||0).toLocaleString('en-IN') + '</span>' +
      (t.note ? '<span style="color:var(--text-muted);flex:1">' + esc(t.note) + '</span>' : '') +
    '</div>';
  }).join('');
  return '<details style="margin-top:8px">' +
    '<summary style="font-size:11px;color:var(--text-faint);cursor:pointer">▶ ' + trades.length + ' trade' + (trades.length>1?'s':'') + '</summary>' +
    '<div style="margin-top:5px;padding-left:4px">' + rows + '</div>' +
  '</details>';
}

// Account badge chip
function acctBadge(account) {
  const colours = { vibhanshu:'#6366f1', manjari:'#ec4899', huf:'#f59e0b',
                    manjbhawna:'#14b8a6', us_vibhanshu:'#3b82f6', us_manjari:'#8b5cf6', us_huf:'#10b981' };
  const col = colours[account] || '#64748b';
  return '<span style="display:inline-block;padding:1px 8px;border-radius:99px;font-size:10px;font-weight:700;' +
         'background:' + col + '22;color:' + col + ';border:1px solid ' + col + '44;text-transform:capitalize">' +
         account + '</span>';
}

function journalToggle(el) {
  const body = el.closest('.jt-section').querySelector('.jt-body');
  const icon = el.querySelector('.jt-icon');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (icon) icon.textContent = open ? '▶' : '▼';
}

function renderJournal() {
  const sold = [...(state.sold_positions || [])].sort((a,b) => (b.sell_date||'').localeCompare(a.sell_date||''));
  if (!sold.length) return `
    <div style="text-align:center;padding:60px 20px;color:var(--text-faint)">
      <div style="font-size:40px;margin-bottom:12px">📓</div>
      <div style="font-size:16px;font-weight:600;margin-bottom:6px">No archived positions yet</div>
      <div style="font-size:13px">When you sell a position, it moves here with your thesis and lessons.</div>
    </div>`;

  const cur = p => curSym(p.currency);
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  const totalPnl = sold.reduce((s, p) => s + (p.realized_pnl || 0), 0);
  const pnlCol0  = totalPnl >= 0 ? '#34d399' : '#f87171';

  // Helper: render per-trade detail row; suppress notes already shown at ticker level
  function renderTradeDetail(p, suppressThesis, suppressAntithesis, suppressLessons) {
    const pc = (p.realized_pnl||0) >= 0 ? '#34d399' : '#f87171';
    const ps = (p.realized_pnl||0) >= 0 ? '+' : '';
    const hd = p.buy_date && p.sell_date
      ? Math.round((new Date(p.sell_date)-new Date(p.buy_date))/864e5) : null;
    const partialBadge = p.partial
      ? '<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(251,191,36,0.15);color:#fbbf24;border:1px solid rgba(251,191,36,0.3);margin-left:6px">PARTIAL</span>'
      : '';
    const filtered = Object.assign({}, p, {
      thesis:     (p.thesis     === suppressThesis     && suppressThesis)     ? '' : p.thesis,
      antithesis: (p.antithesis === suppressAntithesis && suppressAntithesis) ? '' : p.antithesis,
      lessons:    (p.lessons    === suppressLessons    && suppressLessons)    ? '' : p.lessons,
    });
    return '<div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;background:var(--bg)">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          acctBadge(p.account) + partialBadge +
          '<span style="font-size:11px;color:var(--text-faint)">' + (p.sell_qty||0) + ' shares</span>' +
          '<span style="font-size:11px;color:var(--text-faint)">Buy ' + cur(p) + (p.avg_buy_price||0).toLocaleString('en-IN') + ' → Sell ' + cur(p) + (p.sell_price||0).toLocaleString('en-IN') + '</span>' +
          '<span style="font-size:11px;color:var(--text-faint)">' + (p.buy_date||'?') + ' → ' + (p.sell_date||'?') + (hd?' ('+hd+'d)':'') + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<div style="text-align:right">' +
            '<span style="font-size:13px;font-weight:700;color:'+pc+'">' + ps + cur(p) + Math.abs(Math.round(p.realized_pnl||0)).toLocaleString('en-IN') + '</span>' +
            '<span style="font-size:11px;color:'+pc+';margin-left:4px">(' + ps + (p.realized_pnl_pct||0).toFixed(1) + '%)</span>' +
          '</div>' +
          '<button onclick="editJournalEntry(\'' + p.id + '\')" class="btn btn-ghost text-xs py-1 px-2" title="Edit trade / notes">✎</button>' +
          '<button onclick="undoJournalTrade(\'' + p.id + '\',\'' + esc(p.stock_name||'') + '\')" class="btn btn-ghost text-xs py-1 px-2" title="Undo sell — restore position" style="color:#60a5fa">↩</button>' +
          '<button onclick="deleteJournalEntry(\'' + p.id + '\')" class="btn btn-ghost text-xs py-1 px-2" style="color:var(--neg)" title="Delete journal entry">✕</button>' +
        '</div>' +
      '</div>' +
      renderJournalNotes(filtered) +
      renderJournalTrades(p.trades, p.currency) +
    '</div>';
  }

  // Group: year → month → ticker → trades
  const byYear = new Map();
  for (const p of sold) {
    const d  = p.sell_date || '';
    const yr = d.slice(0,4) || 'Unknown';
    const mo = d.slice(5,7) || '00';
    const tk = p.ticker || p.stock_name;
    if (!byYear.has(yr)) byYear.set(yr, new Map());
    const moMap = byYear.get(yr);
    if (!moMap.has(mo)) moMap.set(mo, new Map());
    const tkMap = moMap.get(mo);
    if (!tkMap.has(tk)) tkMap.set(tk, []);
    tkMap.get(tk).push(p);
  }
  const years = [...byYear.keys()].sort((a,b) => b.localeCompare(a));

  let yearHtml = '';
  years.forEach((yr, yi) => {
    const moMap    = byYear.get(yr);
    const allYrTrades = [...moMap.values()].flatMap(m => [...m.values()].flat());
    const yrPnl    = allYrTrades.reduce((s,p) => s+(p.realized_pnl||0), 0);
    const yrTrades = allYrTrades.length;
    const yrCol    = yrPnl >= 0 ? '#34d399' : '#f87171';
    const yrSign   = yrPnl >= 0 ? '+' : '';
    const yrOpen   = yi === 0;
    const months   = [...moMap.keys()].sort((a,b) => b.localeCompare(a));

    let monthHtml = '';
    months.forEach((mo, mi) => {
      const tkMap    = moMap.get(mo);
      const allMoTrades = [...tkMap.values()].flat();
      const moPnl    = allMoTrades.reduce((s,p) => s+(p.realized_pnl||0), 0);
      const moCol    = moPnl >= 0 ? '#34d399' : '#f87171';
      const moSign   = moPnl >= 0 ? '+' : '';
      const moName   = mo !== '00' ? MONTHS[parseInt(mo,10)-1] : 'Unknown';
      const moOpen   = mi === 0 && yrOpen;
      const tickers  = [...tkMap.keys()];

      let tickerHtml = '';
      tickers.forEach((tk, ti) => {
        const tTrades  = tkMap.get(tk);
        const tPnl     = tTrades.reduce((s,p) => s+(p.realized_pnl||0), 0);
        const tInv     = tTrades.reduce((s,p) => s+(p.invested||0), 0);
        const tPct     = tInv > 0 ? (tPnl/tInv*100) : 0;
        const tCol     = tPnl >= 0 ? '#34d399' : '#f87171';
        const tSign    = tPnl >= 0 ? '+' : '';
        const rep      = tTrades[0];
        const accts    = [...new Set(tTrades.map(p=>p.account))].map(acctBadge).join(' ');
        const tkOpen   = ti === 0 && moOpen;

        // Hoist notes to ticker level if all trades share the same value (dedup)
        const uniqThesis     = [...new Set(tTrades.map(p=>p.thesis||''))];
        const uniqAntithesis = [...new Set(tTrades.map(p=>p.antithesis||''))];
        const uniqLessons    = [...new Set(tTrades.map(p=>p.lessons||''))];
        const commonThesis     = uniqThesis.length === 1     ? uniqThesis[0]     : null;
        const commonAntithesis = uniqAntithesis.length === 1 ? uniqAntithesis[0] : null;
        const commonLessons    = uniqLessons.length === 1    ? uniqLessons[0]    : null;
        const tickerNotes = renderJournalNotes({
          thesis: commonThesis || '', antithesis: commonAntithesis || '', lessons: commonLessons || ''
        });

        tickerHtml += `
          <div class="jt-section" style="margin-bottom:6px">
            <div onclick="journalToggle(this)" style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;cursor:pointer;user-select:none"
              onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <span class="jt-icon" style="font-size:9px;color:var(--text-faint)">${tkOpen?'▼':'▶'}</span>
                <span style="font-size:13px;font-weight:700;color:var(--text-strong)">${esc(rep.stock_name)}</span>
                <span style="font-size:10px;color:var(--text-faint)">${esc(tk)}</span>
                ${accts}
                ${tTrades.length > 1 ? '<span style="font-size:10px;color:var(--text-faint)">'+tTrades.length+' trades</span>' : ''}
              </div>
              <div style="text-align:right;flex-shrink:0">
                <span style="font-size:13px;font-weight:700;color:${tCol}">${tSign}₹${Math.abs(Math.round(tPnl)).toLocaleString('en-IN')}</span>
                <span style="font-size:10px;color:${tCol};margin-left:4px">(${tSign}${tPct.toFixed(1)}%)</span>
              </div>
            </div>
            <div class="jt-body" style="display:${tkOpen?'block':'none'};padding:8px 0 0">
              ${tickerNotes}
              ${tTrades.map(p => renderTradeDetail(p, commonThesis, commonAntithesis, commonLessons)).join('')}
            </div>
          </div>`;
      });

      monthHtml += `
        <div class="jt-section" style="margin-bottom:6px;padding-left:12px;border-left:2px solid var(--border)">
          <div onclick="journalToggle(this)" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--surface2);border-radius:8px;cursor:pointer;user-select:none"
            onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background='var(--surface2)'">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="jt-icon" style="font-size:9px;color:var(--text-faint)">${moOpen?'▼':'▶'}</span>
              <span style="font-size:14px;font-weight:700;color:var(--text-strong)">${moName}</span>
              <span style="font-size:11px;color:var(--text-faint)">${tickers.length} stock${tickers.length!==1?'s':''} · ${allMoTrades.length} trade${allMoTrades.length!==1?'s':''}</span>
            </div>
            <span style="font-size:13px;font-weight:700;color:${moCol}">${moSign}₹${Math.abs(Math.round(moPnl)).toLocaleString('en-IN')}</span>
          </div>
          <div class="jt-body" style="display:${moOpen?'block':'none'};padding:8px 0 4px">
            ${tickerHtml}
          </div>
        </div>`;
    });

    yearHtml += `
      <div class="jt-section" style="margin-bottom:14px">
        <div onclick="journalToggle(this)" style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;cursor:pointer;user-select:none"
          onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background='var(--surface2)'">
          <div style="display:flex;align-items:center;gap:14px">
            <span class="jt-icon" style="font-size:11px;color:var(--text-faint)">${yrOpen?'▼':'▶'}</span>
            <span style="font-size:22px;font-weight:900;color:var(--text-strong)">${yr}</span>
            <span style="font-size:11px;color:var(--text-faint)">${yrTrades} trade${yrTrades!==1?'s':''} · ${months.length} month${months.length!==1?'s':''}</span>
          </div>
          <span style="font-size:18px;font-weight:700;color:${yrCol}">${yrSign}₹${Math.abs(Math.round(yrPnl)).toLocaleString('en-IN')}</span>
        </div>
        <div class="jt-body" style="display:${yrOpen?'block':'none'};padding:12px 4px 0">
          ${monthHtml}
        </div>
      </div>`;
  });

  const totalTrades = sold.length;
  const winners = sold.filter(p => (p.realized_pnl||0) >= 0).length;

  return `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">
      <div class="card text-center" style="min-width:130px">
        <div style="font-size:17px;font-weight:700;color:${pnlCol0}">${totalPnl>=0?'+':''}₹${Math.round(Math.abs(totalPnl)).toLocaleString('en-IN')}</div>
        <div class="text-xs t-faint mt-0.5">Total Realised P&L</div>
      </div>
      <div class="card text-center" style="min-width:100px">
        <div style="font-size:17px;font-weight:700;color:var(--text-strong)">${totalTrades}</div>
        <div class="text-xs t-faint mt-0.5">Total Trades</div>
      </div>
      <div class="card text-center" style="min-width:100px">
        <div style="font-size:17px;font-weight:700;color:#34d399">${winners} / ${totalTrades}</div>
        <div class="text-xs t-faint mt-0.5">Winners</div>
      </div>
      <div class="card text-center" style="min-width:80px">
        <div style="font-size:17px;font-weight:700;color:var(--text-strong)">${years.length}</div>
        <div class="text-xs t-faint mt-0.5">Year${years.length!==1?'s':''}</div>
      </div>
    </div>
    ${yearHtml}`;
}

function editJournalEntry(id) {
  const p = (state.sold_positions || []).find(x => x.id === id);
  if (!p) return;
  document.getElementById('jem-id').value          = id;
  document.getElementById('jem-currency').value    = p.currency || 'INR';
  document.getElementById('jem-name').textContent  = p.stock_name || '';
  document.getElementById('jem-sell-date').value   = p.sell_date  || '';
  document.getElementById('jem-sell-price').value  = p.sell_price || '';
  document.getElementById('jem-sell-qty').value    = p.sell_qty   || '';
  const cur = curSym(p.currency);
  document.getElementById('jem-buy-price-disp').textContent =
    `${cur}${(p.avg_buy_price||0).toLocaleString('en-IN')}`;
  document.getElementById('jem-thesis').value      = p.thesis     || '';
  document.getElementById('jem-antithesis').value  = p.antithesis || '';
  document.getElementById('jem-lessons').value     = p.lessons    || '';
  document.getElementById('journal-edit-modal').classList.remove('hidden');
  document.getElementById('jem-sell-date').focus();
}

function closeJournalEditModal() {
  document.getElementById('journal-edit-modal').classList.add('hidden');
}

async function saveJournalEdit(e) {
  e.preventDefault();
  const id         = document.getElementById('jem-id').value;
  const sell_date  = document.getElementById('jem-sell-date').value;
  const sell_price = parseFloat(document.getElementById('jem-sell-price').value) || undefined;
  const sell_qty   = parseFloat(document.getElementById('jem-sell-qty').value)   || undefined;
  const thesis     = document.getElementById('jem-thesis').value;
  const antithesis = document.getElementById('jem-antithesis').value;
  const lessons    = document.getElementById('jem-lessons').value;
  const payload = { thesis, antithesis, lessons };
  if (sell_date)  payload.sell_date  = sell_date;
  if (sell_price) payload.sell_price = sell_price;
  if (sell_qty)   payload.sell_qty   = sell_qty;
  await fetch(`/api/sold_positions/${id}`, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  closeJournalEditModal();
  await fetchData();
  showToast('📓 Trade updated');
}

async function undoJournalTrade(id, name) {
  if (!confirm(`Undo the sell of "${name}"? This will restore the position back to your portfolio.`)) return;
  const res = await fetch(`/api/sold_positions/${id}/undo`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast('❌ ' + (err.detail || 'Undo failed'), 4000);
    return;
  }
  await fetchData();
  showToast(`↩ ${name} restored to positions`);
}

async function deleteJournalEntry(id) {
  if (!confirm('Permanently delete this journal entry?')) return;
  await fetch(`/api/sold_positions/${id}`, { method: 'DELETE' });
  await fetchData();
}

function openWlAdd(listId) {
  const lid = listId || currentWatchlistTab;
  const lbl = (state.settings?.watchlist_groups || []).find(g => g.id === lid)?.name || 'Watchlist';
  document.getElementById('wl-modal-title').textContent = `Add to ${lbl}`;
  ['wl-edit-id','wl-name','wl-ticker','wl-added-price','wl-notes','wl-market-cap','wl-exchange']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  _wlLinksPopulate('wl', '', '');
  document.getElementById('wl-sector').value  = '';
  const convEl = document.getElementById('wl-conviction');
  if (convEl) convEl.value = '';
  if (document.getElementById('wl-list-id')) document.getElementById('wl-list-id').value = lid;
  const intlFields = document.getElementById('wl-intl-fields');
  if (intlFields) intlFields.classList.toggle('hidden', !_INTL_WL_IDS.has(lid));
  document.getElementById('wl-modal').classList.remove('hidden');
}

function editWl(id, listId) {
  const lid  = listId || currentWatchlistTab;
  const list = (lid === 'watchlist' ? state.watchlist : lid === 'us_watchlist' ? state.us_watchlist : state[lid]) || [];
  const w    = list.find(x => x.id === id);
  if (!w) return;
  document.getElementById('wl-modal-title').textContent   = 'Edit Item';
  document.getElementById('wl-edit-id').value             = w.id;
  document.getElementById('wl-name').value                = w.stock_name || '';
  document.getElementById('wl-ticker').value              = w.ticker || '';
  document.getElementById('wl-added-price').value         = w.added_price ?? '';
  document.getElementById('wl-sector').value              = w.sector || '';
  document.getElementById('wl-notes').value               = w.notes || '';
  _wlLinksPopulate('wl', w.research_links || '', w.dashboard_url || '');
  if (document.getElementById('wl-list-id')) document.getElementById('wl-list-id').value = lid;
  const intlFields = document.getElementById('wl-intl-fields');
  const isIntl = _INTL_WL_IDS.has(lid);
  if (intlFields) intlFields.classList.toggle('hidden', !isIntl);
  if (isIntl) {
    const mcEl = document.getElementById('wl-market-cap');
    const cvEl = document.getElementById('wl-conviction');
    const exEl = document.getElementById('wl-exchange');
    if (mcEl) mcEl.value = w.market_cap || '';
    if (cvEl) cvEl.value = w.conviction || '';
    if (exEl) exEl.value = w.exchange   || '';
  }
  document.getElementById('wl-modal').classList.remove('hidden');
}

function closeWlModal() { document.getElementById('wl-modal').classList.add('hidden'); }

function _wlApiBase(listId) {
  if (!listId) listId = currentWatchlistTab;
  if (listId === 'watchlist')    return '/api/watchlist';
  if (listId === 'us_watchlist') return '/api/us_watchlist';
  return `/api/wl/${listId}`;
}

async function saveWatchlist(e) {
  e.preventDefault();
  const id     = document.getElementById('wl-edit-id').value;
  const listId = document.getElementById('wl-list-id')?.value || currentWatchlistTab;
  const ticker = document.getElementById('wl-ticker').value.trim();
  const body   = {
    stock_name:       document.getElementById('wl-name').value,
    ticker,
    added_price:      parseFloat(document.getElementById('wl-added-price').value) || null,
    sector:           document.getElementById('wl-sector').value || null,
    notes:            document.getElementById('wl-notes').value,
    research_links:   _wlLinksSerialize('wl') || null,
  };
  if (_INTL_WL_IDS.has(listId)) {
    const mcEl = document.getElementById('wl-market-cap');
    const cvEl = document.getElementById('wl-conviction');
    const exEl = document.getElementById('wl-exchange');
    if (mcEl) body.market_cap  = mcEl.value.trim() || null;
    if (cvEl) body.conviction  = cvEl.value || null;
    if (exEl) body.exchange    = exEl.value.trim() || null;
  }
  const base   = _wlApiBase(listId);
  const url    = id ? `${base}/${id}` : base;
  const method = id ? 'PUT' : 'POST';
  await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  closeWlModal();
  await fetchData();
  if (ticker) refreshSingleTicker(ticker);
}

async function deleteWl(id, listId) {
  if (!confirm('Remove from watchlist?')) return;
  await fetch(`${_wlApiBase(listId || currentWatchlistTab)}/${id}`, { method: 'DELETE' });
  await fetchData();
}

function _wlMoveSelect(itemId, fromListId) {
  const groups = (state.settings?.watchlist_groups || [])
    .filter(g => g.id !== fromListId && g.id !== 'top_ideas');
  if (!groups.length) return '';
  const opts = groups.map(g =>
    `<option value="${esc(g.id)}">${esc(g.name)}</option>`
  ).join('');
  return `<select title="Move to…" onchange="moveWlItem('${itemId}','${fromListId}',this.value);this.value=''"
    style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;
           font-size:10px;color:var(--text-muted);cursor:pointer;padding:2px 4px;height:26px;max-width:80px">
    <option value="">⇄ Move</option>
    ${opts}
  </select>`;
}

async function moveWlItem(itemId, fromListId, toListId) {
  if (!toListId || toListId === fromListId) return;
  const r = await fetch('/api/wl-move', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ item_id: itemId, from_list: fromListId, to_list: toListId }),
  });
  if (!r.ok) { alert('Move failed'); return; }
  await fetchData();
  render();
}

// Fetch live price for watchlist add form. prefix = 'wl' | 'us-wl'
async function fetchWlAddedPrice(prefix) {
  const tickerEl = document.getElementById(`${prefix}-ticker`);
  const priceEl  = document.getElementById(`${prefix}-added-price`);
  const ticker   = tickerEl?.value?.trim();
  if (!ticker) { tickerEl?.focus(); return; }
  priceEl.placeholder = 'fetching…';
  try {
    const res  = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`);
    const data = await res.json();
    if (data.price) {
      priceEl.value = data.price;
      priceEl.style.borderColor = '#34d399';
      setTimeout(() => priceEl.style.borderColor = '', 1500);
    } else {
      priceEl.placeholder = 'not found';
    }
  } catch { priceEl.placeholder = 'error'; }
}

function moveToPortfolio(wlId, name, ticker) {
  openAdd('vibhanshu');
  document.getElementById('f-name').value   = name;
  document.getElementById('f-ticker').value = ticker;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function saveRiskPct() {
  const pct = parseFloat(document.getElementById('risk-pct').value);
  if (isNaN(pct) || pct <= 0) return;
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usd_inr_rate: state.settings.usd_inr_rate || 84, portfolio_risk_pct: pct }),
  });
  await fetchData();
}

// ─── USD/INR live rate ────────────────────────────────────────────────────────
async function fetchUsdRate() {
  const btn = document.getElementById('fetch-rate-btn');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const res  = await fetch('/api/usd_rate');
    const data = await res.json();
    if (data.rate) {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usd_inr_rate: data.rate, portfolio_risk_pct: state.settings.portfolio_risk_pct || 1.0 }),
      });
      await fetchData();
    }
  } finally {
    if (btn) { btn.textContent = '⟳'; btn.disabled = false; }
  }
}

// ─── Non-USD global FX rates (EUR/GBP/SGD/AUD) ─────────────────────────────────
async function fetchFxRate(currency) {
  const display = document.getElementById(`fx-rate-display-${currency}`);
  const prevText = display ? display.textContent : null;
  if (display) display.textContent = '…';
  try {
    const res  = await fetch(`/api/fx_rate/${currency}`);
    const data = await res.json();
    if (data.rate) {
      await fetchData(); // /api/fx_rate already persisted the rate server-side
    } else if (display) {
      display.textContent = prevText;
    }
  } catch (e) {
    if (display) display.textContent = prevText;
  }
}

// ─── Technicals ───────────────────────────────────────────────────────────────
async function loadTechnicals() {
  try {
    const res = await fetch('/api/technicals');
    if (res.ok) technicals = await res.json();
  } catch { /* ignore if not yet generated */ }
}

// ─── StockScans refresh ────────────────────────────────────────────────────────
async function refreshStockScans() {
  const btn = document.getElementById('scans-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Refreshing…'; }
  try {
    await fetch('/api/stockscans/refresh', { method: 'POST' });
    showToast('📡 Scan refresh started — takes ~1 min for all tickers');
    // Poll until cache updates (check once after 90s)
    setTimeout(async () => {
      await fetchData();
      if (btn) { btn.disabled = false; btn.textContent = '⟳ Scans'; }
      showToast('✅ StockScans data updated');
    }, 90000);
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = '⟳ Scans'; }
    showToast('❌ Scan refresh failed');
  }
}

// ─── Tax P&L ──────────────────────────────────────────────────────────────────

async function loadTax(fy) {
  try {
    const url = '/api/tax' + (fy ? `?fy=${fy}` : '');
    const res = await fetch(url);
    taxData = await res.json();
    taxFY   = taxData.fy;
  } catch(e) {
    taxData = null;
  }
}

function taxNavFY(fy) { loadTax(fy).then(() => renderTab()); }

function renderTax() {
  const d = taxData;
  const INR = v => '₹' + Math.abs(Math.round(v)).toLocaleString('en-IN');
  const pct = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  const clr = v => v >= 0 ? 'var(--pos)' : 'var(--neg)';
  const etfBadge = `<span style="font-size:9px;font-weight:700;color:#8b5cf6;background:#8b5cf622;padding:1px 5px;border-radius:3px;margin-left:4px">ETF</span>`;

  // FY selector — arrow navigation
  const now = new Date();
  const curFY = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
  const fy = taxFY || curFY;
  const fyBtn = (y, label, active, disabled) => {
    const base = 'padding:4px 10px;background:none;border:none;font-size:13px;';
    if (disabled) return `<button disabled style="${base}cursor:default;color:var(--border)">${label}</button>`;
    return `<button onclick="taxNavFY(${y})" style="${base}cursor:pointer;font-weight:${active?'800':'500'};`
      + `color:${active?'var(--accent)':'var(--text-muted)'};`
      + `border-bottom:${active?'2px solid var(--accent)':'2px solid transparent'}">${label}</button>`;
  };
  const fyOpts = fyBtn(fy - 1, '‹', false, false)
    + [fy - 1, fy, fy + 1].filter(y => y >= 2020 && y <= curFY).map(y =>
        fyBtn(y, `FY${String(y).slice(2)}`, y === fy, false)
      ).join('')
    + fyBtn(fy + 1, '›', false, fy >= curFY);

  const hdr = `
  <div style="padding:20px;max-width:1100px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-size:16px;font-weight:700;color:var(--text-strong)">Tax P&L — Capital Gains</div>
      <div>${fyOpts}</div>
    </div>
    <div style="font-size:11px;color:var(--text-faint);margin-bottom:24px">
      Post Budget 2024 · Equity STCG 20% · ETF STCG 30% (slab) · LTCG 12.5% above ₹1.25L · INR only
    </div>`;

  if (!d) return hdr + `<div style="color:var(--text-faint);padding:40px 0;text-align:center">Loading…</div></div>`;

  const r   = d.realized;
  const seq = r.stcg_equity;
  const set = r.stcg_etf;
  const lt  = r.ltcg;
  const uk  = r.unknown;

  // Summary cards
  const summaryCard = (label, net, tax, sub) => {
    const nc = clr(net);
    return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 20px;flex:1;min-width:160px">
      <div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">${label}</div>
      <div style="font-size:22px;font-weight:800;color:${nc};margin-bottom:4px">${net >= 0 ? '' : '-'}${INR(net)}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">${sub}</div>
      <div style="border-top:1px solid var(--border);padding-top:8px">
        <div style="font-size:13px;font-weight:700;color:var(--neg)">Est. tax: ${INR(tax)}</div>
      </div>
    </div>`;
  };

  const totalCard = `
  <div style="background:var(--accent-dim);border:2px solid var(--accent);border-radius:10px;padding:16px 20px;flex:1;min-width:160px">
    <div style="font-size:10px;color:var(--accent);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Total Estimated Tax</div>
    <div style="font-size:26px;font-weight:900;color:var(--accent)">${INR(d.total_tax_estimate)}</div>
    <div style="font-size:10px;color:var(--text-faint);margin-top:6px">${d.fy_label} · ${d.fy_start} → ${d.fy_end}</div>
  </div>`;

  const cards = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px">
    ${seq.count > 0 ? summaryCard(`Equity STCG (${seq.count})`, seq.net, seq.tax, `20% rate`) : ''}
    ${set.count > 0 ? summaryCard(`ETF STCG (${set.count})`, set.net, set.tax, `30% slab rate`) : ''}
    ${lt.count  > 0 ? summaryCard(`LTCG (${lt.count})`, lt.net, lt.tax, `12.5% · ₹1.25L exempt`) : ''}
    ${uk.count  > 0 ? summaryCard(`Unknown (${uk.count})`, uk.pnl, 0, 'No buy date') : ''}
    ${totalCard}
  </div>`;

  // STCG detail rows (equity + ETF side by side if both present)
  const stcgRows = [];
  if (seq.count > 0) stcgRows.push({ label: 'Equity STCG', gains: seq.gains, losses: seq.losses, net: seq.net, rate: '20%' });
  if (set.count > 0) stcgRows.push({ label: 'ETF STCG', gains: set.gains, losses: set.losses, net: set.net, rate: '30%' });

  const stcgDetail = stcgRows.length === 0 ? '' : `
  <div style="margin-bottom:24px">
    ${stcgRows.map(row => `
    <div style="display:grid;grid-template-columns:140px 1fr 1fr 1fr;gap:8px;margin-bottom:8px;font-size:12px;align-items:center">
      <div style="color:var(--text-muted);font-size:11px;font-weight:600">${row.label} <span style="color:var(--text-faint)">(${row.rate})</span></div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
        <div style="color:var(--text-faint);font-size:9px;margin-bottom:3px">GAINS</div>
        <div style="color:var(--pos);font-weight:700">${INR(row.gains)}</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
        <div style="color:var(--text-faint);font-size:9px;margin-bottom:3px">LOSSES</div>
        <div style="color:var(--neg);font-weight:700">−${INR(row.losses)}</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
        <div style="color:var(--text-faint);font-size:9px;margin-bottom:3px">NET TAXABLE</div>
        <div style="color:${clr(row.net)};font-weight:700">${INR(row.net)}</div>
      </div>
    </div>`).join('')}
  </div>`;

  const ltcgDetail = lt.count > 0 ? `
  <div style="display:grid;grid-template-columns:140px 1fr 1fr 1fr 1fr;gap:8px;margin-bottom:28px;font-size:12px;align-items:center">
    <div style="color:var(--text-muted);font-size:11px;font-weight:600">LTCG <span style="color:var(--text-faint)">(12.5%)</span></div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <div style="color:var(--text-faint);font-size:9px;margin-bottom:3px">GAINS</div>
      <div style="color:var(--pos);font-weight:700">${INR(lt.gains)}</div>
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <div style="color:var(--text-faint);font-size:9px;margin-bottom:3px">LOSSES</div>
      <div style="color:var(--neg);font-weight:700">−${INR(lt.losses)}</div>
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <div style="color:var(--text-faint);font-size:9px;margin-bottom:3px">EXEMPT ₹1.25L</div>
      <div style="color:var(--text-muted);font-weight:700">−${INR(Math.min(lt.exempt, Math.max(0, lt.net)))}</div>
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <div style="color:var(--text-faint);font-size:9px;margin-bottom:3px">TAXABLE</div>
      <div style="color:${lt.taxable > 0 ? 'var(--neg)' : 'var(--pos)'};font-weight:700">${INR(lt.taxable)}</div>
    </div>
  </div>` : '';

  // LTCG Countdown
  const countdown = d.ltcg_countdown || [];
  const countdownHtml = countdown.length === 0 ? '' : `
  <div style="margin-bottom:28px">
    <div style="font-size:13px;font-weight:700;color:var(--text-strong);margin-bottom:4px">⏳ LTCG Countdown — Hold to Save Tax</div>
    <div style="font-size:11px;color:var(--text-faint);margin-bottom:12px">Active positions with unrealized gains not yet past the 12-month LTCG threshold</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="border-bottom:2px solid var(--border)">
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase">Stock</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Days Left</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">LTCG Date</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Unrealised Gain</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">STCG Rate</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Tax if Sold Now</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Tax if Waited</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Tax Saving</th>
          </tr>
        </thead>
        <tbody>
          ${countdown.map(c => {
            const urgency = c.days_until_ltcg <= 30 ? 'var(--neg)' : c.days_until_ltcg <= 90 ? '#f59e0b' : 'var(--text-muted)';
            const rateStr = c.is_etf ? '30% (ETF)' : '20%';
            return `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:8px 12px">
                <div style="font-weight:600;color:var(--text-strong)">${esc(c.stock_name)}${c.is_etf ? etfBadge : ''}</div>
                <div style="font-size:10px;color:var(--text-faint)">${esc(c.ticker)} · ${c.account} · ${c.holding_days}d held</div>
              </td>
              <td style="padding:8px 12px;text-align:right;font-weight:700;color:${urgency}">${c.days_until_ltcg}d</td>
              <td style="padding:8px 12px;text-align:right;color:var(--text-muted);font-size:11px">${c.ltcg_date}</td>
              <td style="padding:8px 12px;text-align:right;color:var(--pos);font-weight:600">${INR(c.unrealized_pnl)} <span style="font-size:10px">(${pct(c.unrealized_pct)})</span></td>
              <td style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-muted)">${rateStr}</td>
              <td style="padding:8px 12px;text-align:right;color:var(--neg)">${INR(c.tax_if_sold_now)}</td>
              <td style="padding:8px 12px;text-align:right;color:var(--text-muted)">${INR(c.tax_if_waited)}</td>
              <td style="padding:8px 12px;text-align:right;font-weight:700;color:var(--pos)">${INR(c.tax_saving)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>`;

  // Harvesting candidates
  const harv = d.harvesting_candidates || [];
  const harvHtml = harv.length === 0 ? '' : `
  <div style="margin-bottom:28px">
    <div style="font-size:13px;font-weight:700;color:var(--text-strong);margin-bottom:4px">🌾 Tax-Loss Harvesting Candidates</div>
    <div style="font-size:11px;color:var(--text-faint);margin-bottom:12px">Book these losses to offset gains and reduce tax liability</div>
    <div style="display:flex;flex-wrap:wrap;gap:10px">
      ${harv.map(h => {
        const rateStr = h.type === 'LTCG' ? '12.5%' : (h.is_etf ? '30%' : '20%');
        return `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;min-width:220px">
          <div style="font-weight:600;color:var(--text-strong);margin-bottom:2px">${esc(h.stock_name)}${h.is_etf ? etfBadge : ''}</div>
          <div style="font-size:10px;color:var(--text-faint);margin-bottom:8px">${h.account} · ${h.type} (${rateStr}) · ${h.holding_days}d</div>
          <div style="font-size:13px;color:var(--neg);font-weight:700;margin-bottom:2px">−${INR(Math.abs(h.unrealized_pnl))} <span style="font-size:10px">(${pct(h.unrealized_pct)})</span></div>
          <div style="font-size:11px;color:var(--text-muted)">Tax saving: <strong style="color:var(--pos)">${INR(h.tax_saving)}</strong></div>
        </div>`;
      }).join('')}
    </div>
  </div>`;

  // Sold positions table
  const posRows = (d.positions || []).map(p => {
    const tc  = p.type === 'STCG' ? '#f59e0b' : p.type === 'LTCG' ? 'var(--pos)' : 'var(--text-faint)';
    const pc  = clr(p.realized_pnl);
    const hd  = p.holding_days != null ? `${p.holding_days}d` : '—';
    const rateLabel = p.type === 'STCG' ? (p.is_etf ? '30%' : '20%')
                    : p.type === 'LTCG' ? '12.5%' : '—';
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 12px;white-space:nowrap">
        <div style="font-weight:600;color:var(--text-strong);font-size:12px">${esc(p.stock_name)}${p.is_etf ? etfBadge : ''}</div>
        <div style="font-size:10px;color:var(--text-faint)">${esc(p.ticker)} · ${p.account}</div>
      </td>
      <td style="padding:8px 12px;text-align:center">
        <span style="font-size:10px;font-weight:700;color:${tc};background:${tc}22;padding:2px 8px;border-radius:4px">${p.type}</span>
        <div style="font-size:9px;color:var(--text-faint);margin-top:2px">${rateLabel}</div>
      </td>
      <td style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-muted)">${p.buy_date || '—'}</td>
      <td style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-muted)">${p.sell_date}</td>
      <td style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-muted)">${hd}</td>
      <td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--text-muted)">${INR(p.proceeds)}</td>
      <td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:600;color:${pc}">
        ${p.realized_pnl >= 0 ? '' : '−'}${INR(p.realized_pnl)}
        <div style="font-size:10px;font-weight:400">${pct(p.realized_pnl_pct)}</div>
      </td>
    </tr>`;
  }).join('');

  const posTable = `
  <div style="margin-bottom:12px">
    <div style="font-size:13px;font-weight:700;color:var(--text-strong);margin-bottom:12px">All Sales — ${d.fy_label}</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="border-bottom:2px solid var(--border)">
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase">Stock</th>
            <th style="padding:8px 12px;text-align:center;font-size:11px;color:var(--text-faint);font-weight:600">Type / Rate</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Buy Date</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Sell Date</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Held</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Proceeds</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Realised P&L</th>
          </tr>
        </thead>
        <tbody>${posRows || '<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--text-faint)">No sales in this FY</td></tr>'}</tbody>
      </table>
    </div>
  </div>`;

  return hdr + cards + stcgDetail + ltcgDetail + countdownHtml + harvHtml + posTable + '</div>';
}

// ─── Alpha Tracker ────────────────────────────────────────────────────────────

async function loadAlpha() {
  try {
    const res = await fetch('/api/alpha');
    alphaData = await res.json();
    if (alphaData.status === 'loading' && !_alphaPoller) {
      _alphaPoller = setInterval(async () => {
        const r = await fetch('/api/alpha');
        alphaData = await r.json();
        if (alphaData.status !== 'loading') {
          clearInterval(_alphaPoller); _alphaPoller = null;
        }
        if (currentTab === 'alpha') renderTab();
      }, 3000);
    }
  } catch(e) {
    alphaData = { status: 'error', message: e.message };
  }
}

async function refreshAlpha() {
  if (_alphaPoller) { clearInterval(_alphaPoller); _alphaPoller = null; }
  await fetch('/api/alpha/refresh', { method: 'POST' });
  alphaData = { status: 'loading' };
  renderTab();
  await loadAlpha();
}

function renderAlpha() {
  const d = alphaData;

  const fmtA = (v) => {
    if (v == null) return `<span style="color:var(--text-faint)">—</span>`;
    const s = v >= 0 ? '+' : '';
    const c = v >= 0 ? 'var(--pos)' : 'var(--neg)';
    return `<span style="color:${c};font-weight:600">${s}${v.toFixed(1)}%</span>`;
  };
  const fmtR = (v) => {
    if (v == null) return `<span style="color:var(--text-faint)">—</span>`;
    const s = v >= 0 ? '+' : '';
    const c = v >= 0 ? 'var(--pos)' : 'var(--neg)';
    return `<span style="color:${c}">${s}${v.toFixed(1)}%</span>`;
  };

  const computing = d?.status === 'loading';

  let staleLabel = '';
  if (d?.computed_at) {
    const mins = Math.round((Date.now() - new Date(d.computed_at)) / 60000);
    if      (mins < 60)             staleLabel = `${mins}m ago`;
    else if (mins < 60 * 24)        staleLabel = `${Math.round(mins/60)}h ago`;
    else                            staleLabel = `${Math.round(mins/1440)}d ago`;
  }

  const hdr = `
  <div style="padding:20px;max-width:1200px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--text-strong)">Alpha vs Benchmarks</div>
        <div style="font-size:11px;color:var(--text-faint);margin-top:2px">
          Rolling returns vs Nifty 50 · sorted by 1Y alpha
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        ${staleLabel ? `<span style="font-size:11px;color:var(--text-faint)">Last computed: <strong style="color:var(--text-muted)">${staleLabel}</strong></span>` : ''}
        <button onclick="refreshAlpha()" class="btn btn-ghost text-xs"
          style="border:1px solid var(--accent);color:var(--accent);padding:6px 14px" ${computing ? 'disabled' : ''}>
          ${computing ? '⟳ Computing…' : '⟳ Compute'}
        </button>
      </div>
    </div>`;

  if (!d || d.status === 'idle') {
    return hdr + `
    <div style="text-align:center;padding:80px 0;color:var(--text-faint);font-size:13px">
      Click <strong>Compute</strong> to calculate your alpha vs Nifty 50.<br>
      <span style="font-size:11px">Fetches 1 year of daily data — takes ~20 seconds.</span>
    </div>
  </div>`;
  }

  if (d.status === 'loading') {
    return hdr + `
    <div style="text-align:center;padding:80px 0;color:var(--text-muted);font-size:13px">
      ⟳ Fetching price history for all positions + Nifty 50…<br>
      <span style="font-size:11px;color:var(--text-faint)">This takes about 20–40 seconds.</span>
    </div>
  </div>`;
  }

  if (d.status === 'error') {
    return hdr + `
    <div style="text-align:center;padding:60px 0;color:var(--neg);font-size:13px">
      Error computing alpha: ${esc(d.message || 'unknown error')}
    </div>
  </div>`;
  }

  // ── Portfolio summary cards ──────────────────────────────────────────────
  const PERIODS = [
    { key: '1m', label: '1 Month' },
    { key: '3m', label: '3 Month' },
    { key: '6m', label: '6 Month' },
    { key: '1y', label: '1 Year'  },
  ];
  const pf = d.portfolio || {};
  const summaryCards = PERIODS.map(({ key, label }) => {
    const p   = pf[key] || {};
    const ac  = p.alpha == null ? 'var(--text-faint)' : p.alpha >= 0 ? 'var(--pos)' : 'var(--neg)';
    const asn = p.alpha != null ? (p.alpha >= 0 ? '+' : '') + p.alpha.toFixed(1) + '%' : '—';
    const pfn = p.portfolio != null ? (p.portfolio >= 0 ? '+' : '') + p.portfolio.toFixed(1) + '%' : '—';
    const bfn = p.benchmark  != null ? (p.benchmark  >= 0 ? '+' : '') + p.benchmark.toFixed(1)  + '%' : '—';
    const pfc = p.portfolio  != null ? (p.portfolio  >= 0 ? 'var(--pos)' : 'var(--neg)') : 'var(--text-faint)';
    return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 20px;flex:1;min-width:160px">
      <div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">${label}</div>
      <div style="font-size:22px;font-weight:800;color:${pfc};margin-bottom:2px">${pfn}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">Portfolio</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:2px">${bfn}</div>
      <div style="font-size:10px;color:var(--text-faint);margin-bottom:10px">Nifty 50</div>
      <div style="border-top:1px solid var(--border);padding-top:10px">
        <div style="font-size:16px;font-weight:700;color:${ac}">${asn}</div>
        <div style="font-size:10px;color:var(--text-faint)">Alpha</div>
      </div>
    </div>`;
  }).join('');

  // ── Per-position table ───────────────────────────────────────────────────
  const positions = (d.positions || [])
    .filter(p => p.currency !== 'USD')   // INR positions only vs Nifty
    .slice()
    .sort((a, b) => (b.alpha?.['1y'] ?? -9999) - (a.alpha?.['1y'] ?? -9999));

  const rows = positions.map(p => {
    const sb = p.since_buy;
    const sbHtml = sb
      ? `${fmtA(sb.alpha)} <span style="font-size:10px;color:var(--text-faint)">(${sb.years}y)</span>`
      : '<span style="color:var(--text-faint)">—</span>';

    const acct = (p.account || '').replace('_', ' ');
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:9px 12px;white-space:nowrap">
        <div style="font-weight:600;color:var(--text-strong);font-size:12px">${esc(p.stock_name || p.ticker)}</div>
        <div style="font-size:10px;color:var(--text-faint);margin-top:1px">${esc(p.ticker)} · ${acct}</div>
      </td>
      <td style="padding:9px 12px;text-align:right;font-size:12px;color:var(--text-muted)">${p.weight_pct.toFixed(1)}%</td>
      <td style="padding:9px 12px;text-align:right;font-size:12px">${fmtR(p.returns?.['1m'])}</td>
      <td style="padding:9px 12px;text-align:right;font-size:12px">${fmtR(p.returns?.['1y'])}</td>
      <td style="padding:9px 12px;text-align:right;font-size:12px">${fmtA(p.alpha?.['1m'])}</td>
      <td style="padding:9px 12px;text-align:right;font-size:12px">${fmtA(p.alpha?.['3m'])}</td>
      <td style="padding:9px 12px;text-align:right;font-size:12px">${fmtA(p.alpha?.['6m'])}</td>
      <td style="padding:9px 12px;text-align:right;font-size:12px">${fmtA(p.alpha?.['1y'])}</td>
      <td style="padding:9px 12px;text-align:right;font-size:12px">${sbHtml}</td>
    </tr>`;
  }).join('');

  // ── Best / worst contributors ────────────────────────────────────────────
  const withAlpha1y = positions.filter(p => p.alpha?.['1y'] != null);
  const top3    = withAlpha1y.slice(0, 3);
  const bottom3 = [...withAlpha1y].sort((a, b) => (a.alpha['1y'] ?? 9999) - (b.alpha['1y'] ?? 9999)).slice(0, 3);

  const chipList = (arr, pos) => arr.map(p => {
    const c = pos ? 'var(--pos)' : 'var(--neg)';
    const sign = p.alpha['1y'] >= 0 ? '+' : '';
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:16px">
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--text-strong)">${esc(p.stock_name || p.ticker)}</div>
        <div style="font-size:10px;color:var(--text-faint)">${p.weight_pct.toFixed(1)}% of portfolio</div>
      </div>
      <div style="font-size:15px;font-weight:700;color:${c}">${sign}${p.alpha['1y'].toFixed(1)}%</div>
    </div>`;
  }).join('');

  return hdr + `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:32px">${summaryCards}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:32px">
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--pos);margin-bottom:10px">🏆 Top Alpha Generators (1Y)</div>
        <div style="display:flex;flex-direction:column;gap:8px">${chipList(top3, true)}</div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--neg);margin-bottom:10px">⚠ Alpha Destroyers (1Y)</div>
        <div style="display:flex;flex-direction:column;gap:8px">${chipList(bottom3, false)}</div>
      </div>
    </div>

    <div style="font-size:13px;font-weight:700;color:var(--text-strong);margin-bottom:12px">All Positions — Alpha vs Nifty 50</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="border-bottom:2px solid var(--border)">
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Stock</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Wt%</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">1M Ret</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">1Y Ret</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600;border-left:1px solid var(--border)">1M α</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">3M α</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">6M α</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">1Y α</th>
            <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-faint);font-weight:600">Since Buy α</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="9" style="padding:40px;text-align:center;color:var(--text-faint)">No INR positions found</td></tr>'}</tbody>
      </table>
    </div>
  </div>`;
}

// ─── Market Dashboards ────────────────────────────────────────────────────────

let _rsYear = null, _rsMonth = null, _rsCategory = null;
let _diaryYear = null, _diaryMonth = null;
let _diaryLoaded = false;
let _diaryNotesTimer = null;
let _diaryEditResId = null, _diaryEditPeriod = null, _diaryEditResImage = '';

const _MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function _rsCategories() {
  return state.settings?.resource_categories || [
    {id:'rick_rule',name:'Rick Rule'},{id:'my_resources',name:'My Resources'},
    {id:'sajal_kapoor',name:'Sajal Kapoor'},{id:'soic_research',name:'SOIC Research'},
  ];
}

function switchResourceCat(c)   { _rsCategory = c; _rsYear = null; _rsMonth = null; renderTab(); }
function switchResourceYear(y)  { _rsYear = y; _rsMonth = null; renderTab(); }
function switchResourceMonth(m) { _rsMonth = m; renderTab(); }

async function addResourceCategory() {
  const name = prompt('New category name:');
  if (!name?.trim()) return;
  const res = await fetch('/api/resource-categories', {
    method: 'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name: name.trim()})
  });
  if (!res.ok) { showToast('Error adding category'); return; }
  const cat = await res.json();
  if (!state.settings.resource_categories) state.settings.resource_categories = _rsCategories();
  state.settings.resource_categories.push(cat);
  _rsCategory = cat.id;
  renderTab();
}

async function deleteResourceCategory(cid) {
  const cat = _rsCategories().find(c => c.id === cid);
  if (!confirm(`Remove tab "${cat?.name}"? Items in it will keep their data but show under "My Resources".`)) return;
  await fetch(`/api/resource-categories/${cid}`, {method:'DELETE'});
  state.settings.resource_categories = _rsCategories().filter(c => c.id !== cid);
  if (_rsCategory === cid) _rsCategory = null;
  renderTab();
}

function renderMarketDashboards() {
  const allItems = (state.market_dashboards || []);
  const _MONTH_NAMES_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // ── 1. Resolve active category ──────────────────────────────────────────────
  const cats = _rsCategories();
  if (!_rsCategory || !cats.find(c => c.id === _rsCategory)) _rsCategory = cats[0]?.id || 'my_resources';

  // Items in the active category
  const catItems = allItems.filter(m => (m.category || 'my_resources') === _rsCategory && m.created_date);

  // ── 2. Resolve active year (within this category) ───────────────────────────
  const years = [...new Set(catItems.map(m => m.created_date.slice(0,4)))].sort((a,b) => b-a);
  if (!_rsYear || !years.includes(_rsYear)) _rsYear = years[0] || String(new Date().getFullYear());

  // ── 3. Resolve active month (within category + year) ───────────────────────
  const monthsWithContent = [...new Set(
    catItems.filter(m => m.created_date.startsWith(_rsYear)).map(m => +m.created_date.slice(5,7))
  )].sort((a,b) => a-b);
  if (!_rsMonth || !monthsWithContent.includes(_rsMonth)) _rsMonth = monthsWithContent[monthsWithContent.length-1] || null;

  // ── 4. Visible items ────────────────────────────────────────────────────────
  const periodPfx = _rsMonth ? `${_rsYear}-${String(_rsMonth).padStart(2,'0')}` : null;
  const visibleItems = periodPfx
    ? catItems.filter(m => m.created_date.startsWith(periodPfx)).sort((a,b) => (b.created_date||'').localeCompare(a.created_date||''))
    : [];

  // ── Build rows ──────────────────────────────────────────────────────────────
  const rows = visibleItems.map(m => {
    const viewBtn = m.filename
      ? `<a href="/market_dashboard/${m.id}" target="_blank" class="btn btn-ghost text-xs py-1 px-2">↗ View</a>`
      : m.url
        ? `<a href="${esc(m.url)}" target="_blank" class="btn btn-ghost text-xs py-1 px-2">↗ View</a>`
        : `<span style="color:var(--text-faint);font-size:11px">—</span>`;
    const promptId = `md-prompt-${m.id}`;
    const short = (m.prompt||'').length > 120 ? esc(m.prompt.slice(0,120))+'…' : esc(m.prompt||'');
    const imgs = m.images || [];
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:10px 12px">
        ${imgs.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap;max-width:110px">
          ${imgs.map(im => `<img src="${esc(im.url)}" alt="${esc(im.heading || m.title)}"
              onclick="openMdImageLightbox('${m.id}','${im.id}')"
              style="width:40px;height:40px;object-fit:cover;border-radius:5px;border:1px solid var(--border);cursor:zoom-in"
              title="${esc(im.heading || 'Click to view full size')}">`).join('')}
        </div>` : `<span style="color:var(--text-faint);font-size:11px">—</span>`}
      </td>
      <td style="padding:10px 12px;font-weight:600;color:var(--text-strong);min-width:160px">${esc(m.title)}</td>
      <td style="padding:10px 12px;color:var(--text-muted);white-space:nowrap;font-size:12px">${m.created_date||'—'}</td>
      <td style="padding:10px 12px;max-width:380px">
        <div id="${promptId}-s" style="font-size:11px;color:var(--text-muted);line-height:1.5">${short}
          ${(m.prompt||'').length>120?`<span onclick="document.getElementById('${promptId}-s').style.display='none';document.getElementById('${promptId}-f').style.display='block'"
            style="color:var(--accent);cursor:pointer;margin-left:4px;font-size:10px">more</span>`:''}
        </div>
        <div id="${promptId}-f" style="display:none;font-size:11px;color:var(--text-muted);line-height:1.6;white-space:pre-wrap">${esc(m.prompt||'')}
          <span onclick="document.getElementById('${promptId}-f').style.display='none';document.getElementById('${promptId}-s').style.display='block'"
            style="color:var(--accent);cursor:pointer;font-size:10px;display:block;margin-top:4px">less</span>
        </div>
        ${m.notes?`<div style="margin-top:6px">
          <span onclick="const nb=document.getElementById('${promptId}-notes');nb.style.display=nb.style.display==='none'?'block':'none';this.querySelector('.mn-icon').textContent=nb.style.display==='none'?'▶':'▼'"
            style="cursor:pointer;font-size:10px;color:var(--text-faint);display:inline-flex;align-items:center;gap:3px;user-select:none">
            <span class="mn-icon" style="font-size:9px">▶</span> Notes
          </span>
          <div id="${promptId}-notes" style="display:none;font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.55;white-space:pre-wrap">${_linkifyNotes(m.notes)}</div>
        </div>`:''}
      </td>
      <td style="padding:10px 12px">${viewBtn}</td>
      <td style="padding:10px 12px;white-space:nowrap">
        <button onclick="openEditMarketDashboard('${m.id}')" class="btn btn-ghost text-xs py-1 px-2">✎</button>
        <button onclick="deleteMarketDashboard('${m.id}')" class="btn btn-ghost text-xs py-1 px-2" style="color:var(--neg)">✕</button>
      </td>
    </tr>`;
  }).join('');

  // ── Scorer reports section ──────────────────────────────────────────────────
  const scorerReports = (state.scorer_reports || []);
  const scorerSection = scorerReports.length === 0 ? '' : `
  <div style="margin-bottom:28px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-size:14px;font-weight:700;color:var(--text-strong)">📊 Portfolio Scorer Reports</div>
      <button onclick="openScorer()" class="btn btn-ghost text-xs" style="border:1px solid var(--accent);color:var(--accent);padding:5px 12px">+ New Score</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">
      ${scorerReports.map(r => {
        const gc = _gradeColor(r.avg_score >= 80 ? 'A' : r.avg_score >= 60 ? 'B' : r.avg_score >= 40 ? 'C' : 'F');
        return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <div style="width:40px;height:40px;border-radius:8px;background:${gc}22;border:2px solid ${gc};display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <span style="font-size:14px;font-weight:900;color:${gc};font-family:'JetBrains Mono',monospace">${r.avg_score}</span>
            </div>
            <div>
              <div style="font-size:13px;font-weight:600;color:var(--text-strong)">${esc(r.name)}</div>
              <div style="font-size:10px;color:var(--text-faint)">${(r.created_at||'').slice(0,10)} · ${(r.tickers||[]).length} stocks</div>
            </div>
          </div>
          <div style="font-size:11px;color:var(--text-faint);margin-bottom:10px">${(r.tickers||[]).map(t=>`<span style="background:var(--surface2);padding:1px 6px;border-radius:4px;margin-right:4px;font-family:'JetBrains Mono',monospace">${t}</span>`).join('')}</div>
          <div style="display:flex;gap:6px">
            <button onclick="viewScorerReport('${r.id}')" class="btn btn-ghost text-xs" style="flex:1;font-size:11px;padding:5px 0">View</button>
            <button onclick="emailScorerReportById('${r.id}')" class="btn btn-ghost text-xs" style="font-size:11px;padding:5px 10px" title="Email">✉</button>
            <button onclick="deleteScorerReport('${r.id}')" class="btn btn-ghost text-xs" style="font-size:11px;padding:5px 10px;color:var(--neg)" title="Delete">✕</button>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div style="border-bottom:1px solid var(--border);margin:24px 0"></div>
  </div>`;

  // ── Category tabs (top level) ───────────────────────────────────────────────
  const catTabs = cats.map(c => {
    const active = c.id === _rsCategory;
    const total  = allItems.filter(m => (m.category||'my_resources') === c.id).length;
    const isBuiltIn = ['rick_rule','my_resources','sajal_kapoor','soic_research'].includes(c.id);
    return `<div style="display:inline-flex;align-items:center;gap:1px">
      <button onclick="switchResourceCat('${c.id}')"
        style="padding:7px 16px;border-radius:${isBuiltIn||!active?'6px':'6px 0 0 6px'};
               background:${active?'var(--accent)':'var(--surface2)'};
               border:1px solid ${active?'var(--accent)':'var(--border)'};
               color:${active?'#000':'var(--text-muted)'};
               font-size:12px;font-weight:${active?'700':'400'};cursor:pointer;white-space:nowrap">
        ${esc(c.name)}${total?` <span style="font-size:10px;opacity:.75;margin-left:3px">${total}</span>`:''}
      </button>
      ${!isBuiltIn ? `<button onclick="deleteResourceCategory('${c.id}')" title="Remove tab"
          style="padding:7px 6px;border-radius:0 6px 6px 0;border:1px solid var(--border);border-left:none;
                 background:var(--surface2);cursor:pointer;color:var(--text-faint);font-size:11px;line-height:1">×</button>` : ''}
    </div>`;
  }).join('');

  // ── Year pills (scoped to active category) ──────────────────────────────────
  const yearPills = years.map(y => {
    const active = y === _rsYear;
    return `<button onclick="switchResourceYear('${y}')"
      style="padding:3px 12px;border-radius:20px;border:1px solid ${active?'var(--accent)':'var(--border)'};
             background:${active?'var(--accent)22':'transparent'};
             color:${active?'var(--accent)':'var(--text-muted)'};font-size:11px;font-weight:${active?'700':'400'};cursor:pointer">${y}</button>`;
  }).join('');

  // ── Month tabs (scoped to active category + year) ───────────────────────────
  const monthTabs = monthsWithContent.map(mn => {
    const active = mn === _rsMonth;
    const cnt    = catItems.filter(m => m.created_date.startsWith(`${_rsYear}-${String(mn).padStart(2,'0')}`)).length;
    return `<button onclick="switchResourceMonth(${mn})"
      style="padding:5px 14px;border-bottom:2px solid ${active?'var(--accent)':'transparent'};
             background:transparent;border-top:none;border-left:none;border-right:none;
             color:${active?'var(--accent)':'var(--text-muted)'};font-size:12px;font-weight:${active?'700':'400'};
             cursor:pointer;white-space:nowrap">
      ${_MONTH_NAMES[mn-1]}${cnt>1?` <span style="font-size:10px;opacity:.6">${cnt}</span>`:''}
    </button>`;
  }).join('');

  return `
  <div style="padding:20px;max-width:1100px">
    ${scorerSection}

    <!-- Header + Add button -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div style="font-size:16px;font-weight:700;color:var(--text-strong)">Resources</div>
      <button onclick="openAddMarketDashboard()"
        class="btn btn-ghost text-xs" style="border:1px solid var(--accent);color:var(--accent);padding:6px 14px">
        + Add Resource
      </button>
    </div>

    <!-- Category tabs (top level) -->
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:20px">
      ${catTabs}
      <button onclick="addResourceCategory()"
        style="padding:7px 10px;border-radius:6px;border:1px dashed var(--border);
               background:transparent;color:var(--text-faint);font-size:11px;cursor:pointer">+ New Tab</button>
    </div>

    ${years.length === 0 ? `
      <div style="text-align:center;padding:60px 0;color:var(--text-faint);font-size:13px">
        No resources in this tab yet.<br>
        <button onclick="openAddMarketDashboard()" style="margin-top:12px;background:none;border:1px solid var(--border);
          border-radius:6px;padding:6px 16px;color:var(--accent);cursor:pointer;font-size:12px">+ Add one</button>
      </div>
    ` : `
      <!-- Year pills -->
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
        <span style="font-size:11px;color:var(--text-faint);margin-right:2px">Year:</span>
        ${yearPills}
      </div>

      <!-- Month underline tabs -->
      ${monthsWithContent.length === 0 ? `
        <div style="text-align:center;padding:40px 0;color:var(--text-faint);font-size:13px">No resources for ${_rsYear}.</div>
      ` : `
        <div style="border-bottom:1px solid var(--border);margin-bottom:18px">
          <div style="display:flex;gap:0;align-items:flex-end">${monthTabs}</div>
        </div>

        <!-- Items table -->
        ${visibleItems.length === 0 ? `
          <div style="text-align:center;padding:40px 0;color:var(--text-faint);font-size:13px">
            No items for ${_MONTH_NAMES_FULL[(_rsMonth||1)-1]} ${_rsYear}.
            <button onclick="openAddMarketDashboard()" style="margin-top:10px;display:block;margin-left:auto;margin-right:auto;
              background:none;border:1px solid var(--border);border-radius:6px;padding:5px 14px;color:var(--accent);cursor:pointer;font-size:12px">+ Add here</button>
          </div>
        ` : `
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr style="border-bottom:2px solid var(--border)">
                <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Image</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Title</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Date</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Notes / Prompt</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Link</th>
                <th></th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `}
      `}
    `}
  </div>

  <!-- Add / Edit modal -->
  <div id="md-modal" style="display:none;position:fixed;inset:0;background:#0009;z-index:200;align-items:flex-start;justify-content:center;overflow-y:auto;padding:40px 16px">
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:24px;width:560px;max-width:100%;flex-shrink:0">
      <div id="md-modal-title" style="font-size:15px;font-weight:700;color:var(--text-strong);margin-bottom:16px">Add Resource</div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">Title *</label>
            <input id="md-title" type="text" placeholder="e.g. Nifty Overview"
              style="width:100%;background:var(--surface2);border:2px solid var(--accent);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text);box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">Date *</label>
            <input id="md-date" type="date"
              style="width:100%;background:var(--surface2);border:1px solid var(--text-muted);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text);box-sizing:border-box">
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">Category / Tab</label>
          <select id="md-category"
            style="width:100%;background:var(--surface2);border:1px solid var(--text-muted);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text);box-sizing:border-box">
            ${cats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">Prompt Used (optional)</label>
          <textarea id="md-prompt" rows="4" placeholder="Paste the prompt used to generate this…"
            style="width:100%;background:var(--surface2);border:1px solid var(--text-muted);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);resize:vertical;box-sizing:border-box;line-height:1.5"></textarea>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">External URL</label>
          <input id="md-url" type="text" placeholder="https://…"
            style="width:100%;background:var(--surface2);border:1px solid var(--text-muted);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text);box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">HTML File (in market_dashboards/ folder)</label>
          <input id="md-filename" type="text" placeholder="e.g. nifty_june_2026.html"
            style="width:100%;background:var(--surface2);border:1px solid var(--text-muted);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text);box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">Images (optional — each can have its own heading &amp; link)</label>
          <div id="md-images-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:8px"></div>
          <button type="button" id="md-image-btn" onclick="uploadMdImage()"
            style="background:none;border:1px solid var(--border);border-radius:4px;padding:5px 10px;font-size:12px;color:var(--text-muted);cursor:pointer">
            🖼️ + Add Image
          </button>
          <input type="file" id="md-img-file-input" accept="image/*" style="display:none"
            onchange="handleMdImageUpload(event)">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">Notes (optional)</label>
          <textarea id="md-notes" rows="3"
            style="width:100%;background:var(--surface2);border:1px solid var(--text-muted);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);resize:vertical;box-sizing:border-box"
            placeholder="Text notes…"></textarea>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:18px;justify-content:flex-end">
        <button onclick="closeAddMarketDashboard()" class="btn btn-ghost text-xs" style="padding:7px 16px">Cancel</button>
        <button onclick="saveMarketDashboard()" class="btn text-xs" style="background:var(--accent);color:#000;padding:7px 16px;font-weight:700;border-radius:6px">Save</button>
      </div>
    </div>
  </div>

  <!-- Image lightbox -->
  <div id="md-img-lightbox" onclick="if(event.target===this)closeMdImageLightbox()"
    style="display:none;position:fixed;inset:0;background:#000c;z-index:300;
           align-items:center;justify-content:center;padding:32px;cursor:zoom-out;flex-direction:column;gap:12px">
    <img id="md-img-lightbox-img" src="" alt=""
      style="max-width:100%;max-height:80vh;border-radius:8px;box-shadow:0 20px 60px #0009;cursor:default">
    <div id="md-img-lightbox-caption" style="text-align:center;max-width:80vw"></div>
  </div>`;
}

let _mdEditId = null, _mdEditImages = [];

function _renderMdImagesList() {
  const list = document.getElementById('md-images-list');
  if (!list) return;
  list.innerHTML = _mdEditImages.map((im, i) => `
    <div style="display:flex;gap:8px;align-items:flex-start;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px">
      <img src="${esc(im.url)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:5px;border:1px solid var(--border);flex-shrink:0">
      <div style="flex:1;display:flex;flex-direction:column;gap:5px;min-width:0">
        <input type="text" value="${esc(im.heading || '')}" placeholder="Heading / caption"
          oninput="_mdEditImages[${i}].heading = this.value"
          style="width:100%;background:var(--surface);border:1px solid var(--text-muted);border-radius:5px;padding:5px 8px;font-size:12px;color:var(--text);box-sizing:border-box">
        <input type="text" value="${esc(im.link || '')}" placeholder="Link (optional) — https://…"
          oninput="_mdEditImages[${i}].link = this.value"
          style="width:100%;background:var(--surface);border:1px solid var(--text-muted);border-radius:5px;padding:5px 8px;font-size:12px;color:var(--text);box-sizing:border-box">
      </div>
      <button type="button" onclick="removeMdImageAt(${i})"
        style="flex-shrink:0;background:none;border:none;cursor:pointer;color:var(--neg);font-size:14px;opacity:.5;padding:2px 4px"
        onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.5'" title="Remove image">✕</button>
    </div>`).join('');
}

function openAddMarketDashboard() {
  _mdEditId = null;
  document.getElementById('md-modal-title').textContent = 'Add Resource';
  document.getElementById('md-date').value     = new Date().toISOString().split('T')[0];
  document.getElementById('md-title').value    = '';
  document.getElementById('md-prompt').value   = '';
  document.getElementById('md-filename').value = '';
  document.getElementById('md-url').value      = '';
  document.getElementById('md-notes').value    = '';
  _mdEditImages = [];
  _renderMdImagesList();
  const catSel = document.getElementById('md-category');
  if (catSel) catSel.value = _rsCategory || catSel.options[0]?.value || 'my_resources';
  document.getElementById('md-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('md-title')?.focus(), 50);
}

function openEditMarketDashboard(id) {
  const m = (state.market_dashboards || []).find(x => x.id === id);
  if (!m) return;
  _mdEditId = id;
  document.getElementById('md-modal-title').textContent = 'Edit Resource';
  document.getElementById('md-title').value    = m.title || '';
  document.getElementById('md-date').value     = m.created_date || '';
  document.getElementById('md-prompt').value   = m.prompt || '';
  document.getElementById('md-filename').value = m.filename || '';
  document.getElementById('md-url').value      = m.url || '';
  document.getElementById('md-notes').value    = m.notes || '';
  _mdEditImages = (m.images || []).map(im => ({ ...im }));
  _renderMdImagesList();
  const catSel = document.getElementById('md-category');
  if (catSel) catSel.value = m.category || 'my_resources';
  document.getElementById('md-modal').style.display = 'flex';
}

function closeAddMarketDashboard() {
  document.getElementById('md-modal').style.display = 'none';
  _mdEditId = null;
}

async function saveMarketDashboard() {
  const title    = document.getElementById('md-title').value.trim();
  const date     = document.getElementById('md-date').value;
  const prompt   = document.getElementById('md-prompt').value.trim();
  const filename = document.getElementById('md-filename').value.trim();
  const url      = document.getElementById('md-url').value.trim();
  const notes    = document.getElementById('md-notes').value.trim();
  const images   = _mdEditImages;
  const category = document.getElementById('md-category')?.value || _rsCategory || 'my_resources';

  if (!title || !date) {
    showToast('Title and date are required'); return;
  }

  const payload = { title, created_date: date, category, prompt, filename: filename || null, url: url || null, notes, images };

  if (_mdEditId) {
    const res = await fetch(`/api/market_dashboards/${_mdEditId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { showToast('Failed to update'); return; }
    const updated = await res.json();
    state.market_dashboards = state.market_dashboards.map(m => m.id === _mdEditId ? updated : m);
    _rsCategory = updated.category || 'my_resources';
    showToast('Resource updated');
  } else {
    const res = await fetch('/api/market_dashboards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { showToast('Failed to save'); return; }
    const entry = await res.json();
    state.market_dashboards.push(entry);
    // Navigate to the newly saved item
    _rsYear     = (entry.created_date || '').slice(0,4) || _rsYear;
    _rsMonth    = +(entry.created_date || '').slice(5,7) || _rsMonth;
    _rsCategory = entry.category || 'my_resources';
    showToast('Resource saved');
  }
  closeAddMarketDashboard();
  renderTab();
}

function uploadMdImage() {
  const inp = document.getElementById('md-img-file-input');
  if (inp) { inp.value = ''; inp.click(); }
}

async function handleMdImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const btn = document.getElementById('md-image-btn');
  const orig = btn ? btn.textContent : '🖼️ + Add Image';
  if (btn) { btn.textContent = '⏳ Uploading…'; btn.disabled = true; }
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload-image', { method: 'POST', body: fd });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert('Upload failed: ' + (e?.detail || res.status));
      return;
    }
    const { url } = await res.json();
    _mdEditImages.push({ id: (crypto.randomUUID ? crypto.randomUUID() : `img_${Date.now()}_${Math.random().toString(36).slice(2,8)}`), url, heading: '', link: '' });
    _renderMdImagesList();
  } catch (e) {
    alert('Upload error: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

function removeMdImageAt(i) {
  _mdEditImages.splice(i, 1);
  _renderMdImagesList();
}

function openMdImageLightbox(mid, imgId) {
  const m  = (state.market_dashboards || []).find(x => x.id === mid);
  const im = m && (m.images || []).find(x => x.id === imgId);
  if (!im) return;
  const box = document.getElementById('md-img-lightbox');
  const img = document.getElementById('md-img-lightbox-img');
  const cap = document.getElementById('md-img-lightbox-caption');
  if (!box || !img) return;
  img.src = im.url;
  if (cap) {
    const heading = im.heading ? `<div style="font-size:14px;color:#fff;font-weight:600">${esc(im.heading)}</div>` : '';
    const link = im.link ? `<a href="${esc(im.link)}" target="_blank" rel="noopener" style="font-size:12px;color:#93c5fd;text-decoration:underline">${esc(im.link)}</a>` : '';
    cap.innerHTML = heading + link;
  }
  box.style.display = 'flex';
}

function closeMdImageLightbox() {
  const box = document.getElementById('md-img-lightbox');
  if (box) box.style.display = 'none';
}

async function deleteMarketDashboard(id) {
  if (!confirm('Remove this dashboard entry?')) return;
  await fetch(`/api/market_dashboards/${id}`, { method: 'DELETE' });
  state.market_dashboards = state.market_dashboards.filter(m => m.id !== id);
  renderTab();
}

// ─── Diary ────────────────────────────────────────────────────────────────────
const _DIARY_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

async function _loadDiary() {
  const res = await fetch('/api/diary');
  state.diary = await res.json();
  _diaryLoaded = true;
  if (currentTab === 'diary') renderTab();
}

function _diaryPeriod() {
  return `${_diaryYear}-${String(_diaryMonth).padStart(2,'0')}`;
}

function _diaryMonthData(period) {
  return state.diary[period] || { notes: '', goals: [], resources: [] };
}

function _diaryResLink(url) {
  const href = esc(url);
  const fname = url.split('/').pop().split('?')[0];
  const ext = fname.includes('.') ? fname.split('.').pop().toLowerCase() : '';
  const icon = { pdf: '📄', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊',
                 ppt: '📑', pptx: '📑', txt: '📃', csv: '📊', md: '📃' }[ext] || '🔗';
  const isUpload = url.startsWith('/uploads/');
  const label = isUpload
    ? esc(decodeURIComponent(fname).replace(/^[a-f0-9]{8}_/, ''))
    : esc(url.length > 55 ? url.slice(0, 55) + '…' : url);
  return `<a href="${href}" target="_blank" rel="noopener"
    style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--accent);text-decoration:none;
           padding:2px 8px;border:1px solid var(--accent)44;border-radius:4px;background:var(--accent)0d"
    onmouseover="this.style.background='var(--accent)22'" onmouseout="this.style.background='var(--accent)0d'">
    ${icon} ${label}
  </a>`;
}

function renderDiary() {
  const diary = state.diary || {};
  const now   = new Date();

  // Init year/month to current if not set
  if (!_diaryYear)  _diaryYear  = String(now.getFullYear());
  if (!_diaryMonth) _diaryMonth = now.getMonth() + 1;

  // Years: current year + any year with content
  const allYears = new Set([String(now.getFullYear())]);
  Object.keys(diary).forEach(k => allYears.add(k.slice(0, 4)));
  const years = [...allYears].sort((a, b) => b - a);

  const period    = _diaryPeriod();
  const monthData = _diaryMonthData(period);
  const goals     = monthData.goals     || [];
  const resources = monthData.resources || [];

  // Year pills
  const yearPills = years.map(y =>
    `<button class="region-pill${_diaryYear === y ? ' active' : ''}" onclick="switchDiaryYear('${y}')">${y}</button>`
  ).join('');

  // Month row — all 12, dim months with no content
  const monthBtns = _DIARY_MONTHS.map((m, i) => {
    const mn = i + 1;
    const p  = `${_diaryYear}-${String(mn).padStart(2,'0')}`;
    const hasContent = !!diary[p];
    const isActive   = _diaryMonth === mn;
    return `<button class="sub-tab-btn${isActive ? ' active' : ''}"
      style="${!hasContent && !isActive ? 'color:var(--text-faint);opacity:.5' : ''}"
      onclick="switchDiaryMonth(${mn})">${m}</button>`;
  }).join('');

  // Collect spilled-over (incomplete) goals from previous months (up to 3 months back)
  const spilledGoals = [];
  for (let back = 1; back <= 3; back++) {
    let sy = parseInt(_diaryYear, 10), sm = _diaryMonth - back;
    while (sm <= 0) { sm += 12; sy--; }
    const sp = `${sy}-${String(sm).padStart(2,'0')}`;
    if (!diary[sp]) break;
    const prevIncomplete = (diary[sp].goals || []).filter(g => !g.completed);
    if (!prevIncomplete.length) break;
    const mLabel = _DIARY_MONTHS[sm - 1];
    prevIncomplete.forEach(g => spilledGoals.push({ ...g, _fromPeriod: sp, _fromLabel: mLabel }));
  }

  // Goals rows
  const doneCount = goals.filter(g => g.completed).length;
  const openCount = goals.filter(g => !g.completed).length;
  // Count open goals across ALL diary periods for limit display
  const globalOpenCount = Object.values(state.diary || {}).reduce((acc, p) => acc + (p.goals || []).filter(g => !g.completed).length, 0);
  const _renderGoalRow = (g, ownerPeriod) => {
    const dateLine = [
      g.created_date ? `created ${g.created_date}` : '',
      g.closed_date  ? `closed ${g.closed_date}`   : '',
      g._fromLabel   ? `↩ from ${g._fromLabel}`    : '',
    ].filter(Boolean).join(' · ');
    return `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">
      <input type="checkbox" ${g.completed ? 'checked' : ''}
        onchange="toggleDiaryGoal('${ownerPeriod}','${g.id}',this.checked)"
        style="width:15px;height:15px;margin-top:3px;flex-shrink:0;cursor:pointer;accent-color:var(--accent)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;line-height:1.5;color:${g.completed ? 'var(--text-faint)' : 'var(--text-strong)'};
          ${g.completed ? 'text-decoration:line-through' : ''}">${esc(g.text)}</div>
        ${dateLine ? `<div style="font-size:10px;color:var(--text-faint);margin-top:1px">${dateLine}</div>` : ''}
      </div>
      <button onclick="deleteDiaryGoal('${ownerPeriod}','${g.id}')"
        style="flex-shrink:0;background:none;border:none;cursor:pointer;color:var(--neg);font-size:14px;opacity:.35;line-height:1;padding:0 2px"
        onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.35'">✕</button>
    </div>`;
  };
  const spilledRows = spilledGoals.map(g => _renderGoalRow(g, g._fromPeriod)).join('');
  const goalRows    = goals.map(g => _renderGoalRow(g, period)).join('');

  // Resource cards
  const resCards = resources.map(r => `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:10px">
      <div style="display:flex;gap:12px;align-items:flex-start">
        ${r.image ? `
        <img src="${esc(r.image)}" alt="${esc(r.heading || 'Resource image')}"
          onclick="openDiaryImageLightbox('${esc(r.image)}')"
          style="width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid var(--border);
                 cursor:zoom-in;flex-shrink:0" title="Click to view full size">` : ''}
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px">
            <div style="font-size:13px;font-weight:600;color:var(--text-strong);line-height:1.4">${esc(r.heading || '—')}</div>
            <div style="display:flex;gap:2px;flex-shrink:0">
              <button onclick="openDiaryResModal('${period}','${r.id}')"
                style="background:none;border:none;cursor:pointer;color:var(--text-faint);font-size:13px;padding:1px 5px;opacity:.5"
                onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.5'" title="Edit">✎</button>
              <button onclick="deleteDiaryRes('${period}','${r.id}')"
                style="background:none;border:none;cursor:pointer;color:var(--neg);font-size:13px;padding:1px 5px;opacity:.4"
                onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.4'" title="Delete">✕</button>
            </div>
          </div>
          ${r.url ? `<div style="margin-bottom:8px">${_diaryResLink(r.url)}</div>` : ''}
          ${r.learnings ? `
            <div style="font-size:12px;color:var(--text-muted);line-height:1.6;white-space:pre-wrap;
                        border-left:2px solid var(--accent)44;padding:5px 10px;border-radius:0 4px 4px 0;
                        background:var(--surface)">${_linkifyNotes(r.learnings)}</div>` : ''}
        </div>
      </div>
    </div>`).join('');

  return `
  <div style="max-width:900px;margin:0 auto">
    <!-- Year pills -->
    <div class="region-switcher" style="margin-bottom:14px">${yearPills}</div>

    <!-- Month tabs -->
    <div class="sub-tab-bar" style="margin-bottom:20px;flex-wrap:wrap">${monthBtns}</div>

    ${!_diaryLoaded ? `<div style="text-align:center;padding:60px 0;color:var(--text-faint);font-size:13px">Loading…</div>` : `
    <!-- Two-column layout -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start">

      <!-- Left: Goals + Notes -->
      <div style="display:flex;flex-direction:column;gap:16px">

        <!-- Goals card -->
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <div style="font-size:14px;font-weight:700;color:var(--text-strong)">🎯 Goals</div>
            <div style="display:flex;align-items:center;gap:8px">
              ${goals.length ? `<span style="font-size:11px;color:var(--text-faint)">${doneCount}/${goals.length} done</span>` : ''}
              <span style="font-size:11px;font-weight:600;color:${globalOpenCount >= 20 ? 'var(--neg)' : globalOpenCount >= 15 ? '#f59e0b' : 'var(--text-faint)'}"
                title="Open goals across all months">${globalOpenCount}/20 open</span>
            </div>
          </div>
          ${spilledRows ? `
            <div style="margin-bottom:4px">
              <div style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-faint);margin-bottom:2px;padding:0 0 4px;border-bottom:1px dashed var(--border)">↩ Carried over</div>
              ${spilledRows}
            </div>` : ''}
          ${spilledRows && goalRows ? `<div style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-faint);margin:6px 0 2px;padding-bottom:4px;border-bottom:1px dashed var(--border)">This month</div>` : ''}
          ${goalRows || (!spilledRows ? `<div style="text-align:center;padding:16px 0;font-size:12px;color:var(--text-faint)">No goals yet</div>` : '')}
          <div style="display:flex;gap:6px;margin-top:10px">
            <input id="diary-goal-input" type="text" placeholder="Add a goal…"
              style="flex:1;font-size:12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text)"
              onkeydown="if(event.key==='Enter')addDiaryGoal('${period}')">
            <button onclick="addDiaryGoal('${period}')" class="btn btn-blue text-xs" style="white-space:nowrap">+ Add</button>
          </div>
        </div>

        <!-- Notes card -->
        <div class="card">
          <div style="font-size:14px;font-weight:700;color:var(--text-strong);margin-bottom:12px">📝 Notes</div>
          <textarea id="diary-notes-ta" rows="10" placeholder="Journal notes, reflections, market thoughts for this month…"
            oninput="debouncedSaveDiaryNotes('${period}')" onblur="saveDiaryNotes('${period}')"
            style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:6px;
                   padding:8px 10px;font-size:12px;color:var(--text);resize:vertical;box-sizing:border-box;line-height:1.6"
          >${esc(monthData.notes || '')}</textarea>
          <button onclick="saveDiaryNotes('${period}')" class="btn btn-blue text-xs" style="margin-top:10px">Save Notes</button>
          <span id="diary-notes-saved" style="font-size:11px;color:var(--pos);margin-left:8px;opacity:0;transition:opacity .3s"></span>
          <span style="font-size:11px;color:var(--text-faint);margin-left:8px">autosaves as you type</span>
        </div>
      </div>

      <!-- Right: Resources -->
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div style="font-size:14px;font-weight:700;color:var(--text-strong)">📚 Resources & Learnings</div>
          <button onclick="openDiaryResModal('${period}',null)" class="btn btn-blue text-xs">+ Add</button>
        </div>
        ${resCards || `<div style="text-align:center;padding:24px 0;font-size:12px;color:var(--text-faint)">No resources yet — add links, videos, or articles you want to track</div>`}
      </div>
    </div>
    `}

    <!-- Resource add/edit modal -->
    <div id="diary-res-modal" style="display:none;position:fixed;inset:0;background:#0009;z-index:200;
         align-items:flex-start;justify-content:center;overflow-y:auto;padding:40px 16px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;
                  padding:24px;width:520px;max-width:100%;flex-shrink:0">
        <div id="diary-res-modal-ttl" style="font-size:15px;font-weight:700;color:var(--text-strong);margin-bottom:16px">Add Resource</div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">Heading *</label>
            <input id="diary-res-heading" type="text" placeholder="e.g. HDFC Bank Q1 Results"
              style="width:100%;background:var(--surface2);border:2px solid var(--accent);border-radius:6px;
                     padding:7px 10px;font-size:13px;color:var(--text);box-sizing:border-box">
          </div>
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
              <label style="font-size:11px;color:var(--text-muted)">Link / URL or Upload</label>
              <button type="button" onclick="uploadDiaryDoc()"
                style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 8px;
                       font-size:10px;color:var(--text-faint);cursor:pointer">📎 Upload Document</button>
            </div>
            <input id="diary-res-url" type="text" placeholder="https://… or upload a file above"
              style="width:100%;background:var(--surface2);border:1px solid var(--text-muted);border-radius:6px;
                     padding:7px 10px;font-size:13px;color:var(--text);box-sizing:border-box">
            <input type="file" id="diary-doc-file-input"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.md,image/*"
              style="display:none" onchange="handleDiaryDocUpload(event)">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">Image (optional — shown as a thumbnail on the card)</label>
            <div id="diary-res-image-preview-wrap" style="display:none;margin-bottom:8px;position:relative;width:fit-content">
              <img id="diary-res-image-preview" src="" alt="Preview"
                style="width:96px;height:96px;object-fit:cover;border-radius:6px;border:1px solid var(--border);display:block">
              <button type="button" onclick="removeDiaryResImage()"
                style="position:absolute;top:-8px;right:-8px;width:20px;height:20px;border-radius:50%;
                       background:var(--neg);color:#fff;border:2px solid var(--surface);cursor:pointer;
                       font-size:11px;line-height:1;padding:0" title="Remove image">✕</button>
            </div>
            <button type="button" id="diary-res-image-btn" onclick="uploadDiaryResImage()"
              style="background:none;border:1px solid var(--border);border-radius:4px;padding:5px 10px;
                     font-size:12px;color:var(--text-muted);cursor:pointer">🖼️ Upload Image</button>
            <input type="file" id="diary-res-image-input" accept="image/*"
              style="display:none" onchange="handleDiaryResImageUpload(event)">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:4px">Learnings / Notes</label>
            <textarea id="diary-res-learnings" rows="6" placeholder="Key takeaways, insights, questions raised…"
              style="width:100%;background:var(--surface2);border:1px solid var(--text-muted);border-radius:6px;
                     padding:7px 10px;font-size:12px;color:var(--text);resize:vertical;box-sizing:border-box;line-height:1.5"></textarea>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:18px;justify-content:flex-end">
          <button onclick="closeDiaryResModal()" class="btn btn-ghost text-xs" style="padding:7px 16px">Cancel</button>
          <button onclick="saveDiaryRes()" class="btn text-xs"
            style="background:var(--accent);color:#000;padding:7px 16px;font-weight:700;border-radius:6px">Save</button>
        </div>
      </div>
    </div>

    <!-- Image lightbox -->
    <div id="diary-img-lightbox" onclick="closeDiaryImageLightbox()"
      style="display:none;position:fixed;inset:0;background:#000c;z-index:300;
             align-items:center;justify-content:center;padding:32px;cursor:zoom-out">
      <img id="diary-img-lightbox-img" src="" alt=""
        style="max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 20px 60px #0009">
    </div>
  </div>`;
}

function switchDiaryYear(y)  { _diaryYear = y; renderTab(); }
function switchDiaryMonth(m) { _diaryMonth = m; renderTab(); }

async function toggleDiaryGoal(period, gid, completed) {
  const res = await fetch(`/api/diary/${period}/goals/${gid}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ completed }),
  });
  const updated = await res.json().catch(() => null);
  const p = (state.diary[period] = state.diary[period] || {});
  const g = (p.goals || []).find(x => x.id === gid);
  if (g) {
    g.completed = completed;
    g.closed_date = updated?.closed_date ?? (completed ? new Date().toISOString().slice(0, 10) : null);
  }
  renderTab();
}

async function addDiaryGoal(period) {
  const inp = document.getElementById('diary-goal-input');
  const text = (inp?.value || '').trim();
  if (!text) return;
  const res = await fetch(`/api/diary/${period}/goals`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.detail || 'Could not add goal';
    if (msg.startsWith('limit_reached')) {
      showToast('⚠️ 20 open goals limit reached — close some before adding more', 5000);
    } else {
      showToast(msg, 4000);
    }
    return;
  }
  const goal = await res.json();
  state.diary[period] = state.diary[period] || { notes: '', goals: [], resources: [] };
  state.diary[period].goals = state.diary[period].goals || [];
  state.diary[period].goals.push(goal);
  if (inp) inp.value = '';
  renderTab();
}

async function deleteDiaryGoal(period, gid) {
  await fetch(`/api/diary/${period}/goals/${gid}`, { method: 'DELETE' });
  const p = state.diary[period];
  if (p) p.goals = (p.goals || []).filter(g => g.id !== gid);
  renderTab();
}

function debouncedSaveDiaryNotes(period) {
  clearTimeout(_diaryNotesTimer);
  _diaryNotesTimer = setTimeout(() => saveDiaryNotes(period), 900);
}

async function saveDiaryNotes(period) {
  clearTimeout(_diaryNotesTimer);
  const ta = document.getElementById('diary-notes-ta');
  if (!ta) return;
  const notes = ta.value;
  await fetch(`/api/diary/${period}/notes`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ notes }),
  });
  state.diary[period] = state.diary[period] || { notes: '', goals: [], resources: [] };
  state.diary[period].notes = notes;
  const badge = document.getElementById('diary-notes-saved');
  if (badge) { badge.textContent = '✓ Saved'; badge.style.opacity = '1'; setTimeout(() => badge.style.opacity = '0', 2000); }
}

function _setDiaryResImagePreview(url) {
  _diaryEditResImage = url || '';
  const wrap = document.getElementById('diary-res-image-preview-wrap');
  const img  = document.getElementById('diary-res-image-preview');
  const btn  = document.getElementById('diary-res-image-btn');
  if (!wrap || !img || !btn) return;
  if (_diaryEditResImage) {
    img.src = _diaryEditResImage;
    wrap.style.display = 'block';
    btn.textContent = '🖼️ Replace Image';
  } else {
    img.src = '';
    wrap.style.display = 'none';
    btn.textContent = '🖼️ Upload Image';
  }
}

function openDiaryResModal(period, rid) {
  _diaryEditPeriod = period;
  _diaryEditResId  = rid || null;
  const modal = document.getElementById('diary-res-modal');
  if (!modal) return;
  document.getElementById('diary-res-modal-ttl').textContent = rid ? 'Edit Resource' : 'Add Resource';
  if (rid) {
    const r = (state.diary[period]?.resources || []).find(x => x.id === rid);
    document.getElementById('diary-res-heading').value   = r?.heading   || '';
    document.getElementById('diary-res-url').value       = r?.url       || '';
    document.getElementById('diary-res-learnings').value = r?.learnings || '';
    _setDiaryResImagePreview(r?.image || '');
  } else {
    document.getElementById('diary-res-heading').value   = '';
    document.getElementById('diary-res-url').value       = '';
    document.getElementById('diary-res-learnings').value = '';
    _setDiaryResImagePreview('');
  }
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('diary-res-heading')?.focus(), 50);
}

function closeDiaryResModal() {
  const modal = document.getElementById('diary-res-modal');
  if (modal) modal.style.display = 'none';
  _diaryEditResId = null;
}

function uploadDiaryResImage() {
  const inp = document.getElementById('diary-res-image-input');
  if (inp) { inp.value = ''; inp.click(); }
}

async function handleDiaryResImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const btn = document.getElementById('diary-res-image-btn');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '⏳ Uploading…'; btn.disabled = true; }
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload-image', { method: 'POST', body: fd });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert('Image upload failed: ' + (e?.detail || res.status));
      return;
    }
    const { url } = await res.json();
    _setDiaryResImagePreview(url);
  } catch (e) {
    alert('Image upload error: ' + e.message);
  } finally {
    if (btn) btn.disabled = false;
    if (!_diaryEditResImage && btn) btn.textContent = orig;
  }
}

function removeDiaryResImage() {
  _setDiaryResImagePreview('');
}

function openDiaryImageLightbox(url) {
  const box = document.getElementById('diary-img-lightbox');
  const img = document.getElementById('diary-img-lightbox-img');
  if (!box || !img) return;
  img.src = url;
  box.style.display = 'flex';
}

function closeDiaryImageLightbox() {
  const box = document.getElementById('diary-img-lightbox');
  if (box) box.style.display = 'none';
}

function uploadDiaryDoc() {
  const inp = document.getElementById('diary-doc-file-input');
  if (inp) { inp.value = ''; inp.click(); }
}

async function handleDiaryDocUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const urlEl = document.getElementById('diary-res-url');
  if (!urlEl) return;
  const orig = urlEl.placeholder;
  urlEl.disabled = true; urlEl.placeholder = '⏳ Uploading…';
  try {
    const isImage = /\.(jpe?g|png|gif|webp|svg)$/i.test(file.name);
    const endpoint = isImage ? '/api/upload-image' : '/api/upload-doc';
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(endpoint, { method: 'POST', body: fd });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert('Upload failed: ' + (e?.detail || res.status));
      return;
    }
    const { url, original_name } = await res.json();
    urlEl.value = url;
    // Auto-fill heading from filename if empty
    const headingEl = document.getElementById('diary-res-heading');
    if (headingEl && !headingEl.value.trim()) {
      headingEl.value = (original_name || file.name).replace(/\.[^.]+$/, '');
    }
  } catch (e) {
    alert('Upload error: ' + e.message);
  } finally {
    urlEl.disabled = false;
    urlEl.placeholder = orig;
  }
}

async function saveDiaryRes() {
  const heading   = document.getElementById('diary-res-heading').value.trim();
  const url       = document.getElementById('diary-res-url').value.trim();
  const learnings = document.getElementById('diary-res-learnings').value.trim();
  const image     = _diaryEditResImage || '';
  if (!heading) { showToast('Heading is required'); return; }
  const period = _diaryEditPeriod;
  state.diary[period] = state.diary[period] || { notes: '', goals: [], resources: [] };
  if (_diaryEditResId) {
    const res = await fetch(`/api/diary/${period}/resources/${_diaryEditResId}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ heading, url, learnings, image }),
    });
    const updated = await res.json();
    state.diary[period].resources = (state.diary[period].resources || []).map(r => r.id === _diaryEditResId ? updated : r);
  } else {
    const res = await fetch(`/api/diary/${period}/resources`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ heading, url, learnings, image }),
    });
    const created = await res.json();
    state.diary[period].resources = state.diary[period].resources || [];
    state.diary[period].resources.push(created);
  }
  closeDiaryResModal();
  renderTab();
}

async function deleteDiaryRes(period, rid) {
  if (!confirm('Remove this resource?')) return;
  await fetch(`/api/diary/${period}/resources/${rid}`, { method: 'DELETE' });
  const p = state.diary[period];
  if (p) p.resources = (p.resources || []).filter(r => r.id !== rid);
  renderTab();
}

// ─── All-signals refresh via WebSocket ────────────────────────────────────────
let _signalsWs = null;

function startAllSignalsRefresh() {
  if (_signalsWs && _signalsWs.readyState === WebSocket.OPEN) return;

  const btn      = document.getElementById('all-signals-btn');
  const progBar  = document.getElementById('signals-progress');
  const pb       = document.getElementById('signals-pb');
  const progText = document.getElementById('signals-prog-text');

  if (btn) { btn.textContent = '⟳ Connecting…'; btn.disabled = true; }
  progBar?.classList.remove('hidden');

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _signalsWs  = new WebSocket(`${proto}//${location.host}/ws/signals`);

  _signalsWs.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'start') {
      if (pb)       pb.style.width      = '0%';
      if (progText) progText.textContent = `0/${msg.total}`;
      if (btn)      btn.textContent      = `⟳ 0/${msg.total}`;
    } else if (msg.type === 'ticker') {
      if (!msg.data.error) {
        technicals[msg.ticker] = msg.data;
        renderTab();
      }
      const pct = msg.total > 0 ? (msg.done / msg.total * 100) : 0;
      if (pb)       pb.style.width      = pct + '%';
      if (progText) progText.textContent = `${msg.done}/${msg.total}`;
      if (btn)      btn.textContent      = `⟳ ${msg.done}/${msg.total}`;
    } else if (msg.type === 'done') {
      const now = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      const ts  = document.getElementById('signals-ts');
      if (ts)  ts.textContent  = `signals ${now}`;
      if (pb)  pb.style.width  = '100%';
      if (btn) btn.textContent = `✓ ${msg.updated}/${msg.total} signals`;
      loadTechnicals().then(() => { fetchData().then(() => renderTab()); });
      setTimeout(() => {
        if (btn) { btn.textContent = '⟳ Signals'; btn.disabled = false; }
        progBar?.classList.add('hidden');
      }, 4000);
    } else if (msg.type === 'error') {
      if (btn) { btn.textContent = '⚠ Error'; btn.disabled = false; }
      progBar?.classList.add('hidden');
    }
  };

  _signalsWs.onerror = () => {
    if (btn) { btn.textContent = '⚠ Error'; btn.disabled = false; }
    progBar?.classList.add('hidden');
  };

  _signalsWs.onclose = () => {
    _signalsWs = null;
    if (btn && btn.disabled) {
      btn.textContent = '⟳ Signals';
      btn.disabled    = false;
      progBar?.classList.add('hidden');
    }
  };
}

// "⟳ Signals" button in Consolidated tab — delegates to the same flow
function refreshTechnicals() {
  startAllSignalsRefresh();
}

// ─── Live prices ──────────────────────────────────────────────────────────────
async function refreshPrices() {
  const btn = document.getElementById('refresh-btn');
  btn.textContent = '⟳ Fetching…';
  btn.disabled = true;
  const reset = () => { btn.textContent = '⟳ Prices'; btn.disabled = false; };
  try {
    const res  = await fetch('/api/prices');
    const data = await res.json();
    if (data.error) { alert('Price fetch error: ' + data.error); reset(); return; }
    if (data.positions) {
      state.positions = data.positions;
    }
    if (data.prices) {
      livePrices   = data.prices;
      _lastFetchTs = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    }
    if (data.market_caps) {
      liveMarketCaps = data.market_caps;
    }
    if (data.positions || data.prices) {
      renderHeader();
      renderTab();
    }
    const now = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const ts = document.getElementById('prices-ts');
    if (ts) ts.innerHTML = `<span class="ws-live" style="vertical-align:middle;margin-right:4px"></span>${now}`;
    btn.textContent = `✓ ${data.updated} updated`;
    setTimeout(reset, 3000);
  } catch(e) {
    reset();
  }
}

// ─── Single-ticker technicals refresh ────────────────────────────────────────
async function refreshSingleTicker(ticker) {
  try {
    const res  = await fetch('/api/technicals/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker }),
    });
    const data = await res.json();
    if (data.data && !data.data.error) {
      technicals[ticker] = data.data;
      renderTab(); // re-render with fresh signals
    }
  } catch { /* silent */ }
}

// ─── P&L heat-map background ─────────────────────────────────────────────────
function pnlBg(pct) {
  if (pct == null || isNaN(pct)) return '';
  const abs = Math.abs(pct);
  // opacity scales: 0–5% → 0.06, 5–15% → 0.12, 15–30% → 0.20, 30–60% → 0.30, 60%+ → 0.40
  const op = abs < 5 ? 0.06 : abs < 15 ? 0.12 : abs < 30 ? 0.20 : abs < 60 ? 0.30 : 0.40;
  const rgb = pct >= 0 ? '52,211,153' : '248,113,113';
  return `background:rgba(${rgb},${op});`;
}

// ─── Signal helpers ───────────────────────────────────────────────────────────
function _emaDist(cmp, ema) {
  return (ema && cmp) ? ((cmp - ema) / ema) * 100 : null;
}
function _emaStatus(dist) {
  if (dist === null) return null;
  if (dist < 0)  return { col: 'var(--neg)', label: 'broken' };
  if (dist < 3)  return { col: '#f59e0b',    label: 'danger' };
  if (dist < 8)  return { col: '#f97316',    label: 'caution' };
  return           { col: 'var(--pos)',   label: 'safe' };
}

// Compact Technicals cell: entry score + stage pill + chevron
function getTechCell(cmp, t, id) {
  const chev = `<span id="chev-${id}" style="font-size:9px;color:var(--text-faint);transition:transform .2s;display:inline-block;margin-left:4px">▶</span>`;
  if (!t || t.error)
    return `<span class="t-faint" style="font-size:11px">— no data${chev}</span>`;
  if (!t.entry_signals)
    return `<span class="t-faint" style="font-size:11px">…${chev}</span>`;
  const score = t.entry_score ?? 0;
  const col   = score >= 4 ? 'var(--pos)' : score >= 2 ? '#f59e0b' : 'var(--neg)';
  const SC    = {1:['#1a2f4a','#60a5fa'],2:['#0d3321','#4ade80'],3:['#3d2200','#fb923c'],4:['#3d0a0a','#f87171']};
  const [sBg, sFg] = SC[t.stage] || SC[1];
  return `<div style="display:flex;align-items:center;gap:5px">
    <div style="display:flex;flex-direction:column;align-items:flex-start;gap:3px">
      <span style="font-weight:700;font-size:13px;color:${col}">${score}<span style="font-size:9px;color:var(--text-faint)">/6</span></span>
      <span style="background:${sBg};color:${sFg};border-radius:4px;padding:1px 6px;font-size:9px;font-weight:700;letter-spacing:.04em">Stage ${t.stage}</span>
    </div>
    ${chev}
  </div>`;
}

function toggleSigRow(id) {
  const row  = document.getElementById('sig-row-' + id);
  const chev = document.getElementById('chev-' + id);
  if (!row) return;
  const open = row.style.display !== 'none';
  row.style.display = open ? 'none' : '';
  if (chev) chev.style.transform = open ? '' : 'rotate(90deg)';
}

// Inline panel: entry signals (left) + sell signals (right)
function getSigPanel(cmp, iyerExit, t, ticker) {
  const base = 'background:var(--surface2);border-top:1px solid var(--border)';
  if (!t || t.error) {
    return `<div style="${base};padding:10px 20px;font-size:12px;color:var(--text-faint)">
      No signal data — click ⟳ Signals to fetch</div>`;
  }

  // ── Entry signals (left) ──
  const s    = t.entry_signals || {};
  const SC   = {1:['#1a2f4a','#60a5fa','Stage 1'],2:['#0d3321','#4ade80','Stage 2'],3:['#3d2200','#fb923c','Stage 3'],4:['#3d0a0a','#f87171','Stage 4']};
  const [sBg, sFg, sLbl] = SC[t.stage] || SC[1];
  const score    = t.entry_score ?? 0;
  const scoreCol = score >= 4 ? 'var(--pos)' : score >= 2 ? '#f59e0b' : 'var(--neg)';

  const entryCriteria = [
    { ok: s.above_30w_ema,     label: 'Above 30W EMA',  val: t.ema30  ? _r(t.ema30)  : '—' },
    { ok: s.ema30_rising,      label: '30W Rising',     val: t.ema30_rising ? 'Uptrend' : 'Flat/Down' },
    { ok: s.rsi_buy_zone,      label: 'RSI ≥ 45',       val: t.rsi  != null ? t.rsi.toFixed(1)  : '—' },
    { ok: s.adx_trending,      label: 'ADX ≥ 20',       val: t.adx  != null ? t.adx.toFixed(1)  : '—' },
    { ok: s.crs_outperforming, label: 'CRS vs Nifty',   val: t.crs_above_ma ? 'Outperform' : 'Lagging' },
    { ok: s.near_52w_high,     label: 'Near 52W High',  val: t.peak_52w ? _r(t.peak_52w) : '—' },
  ];

  const entryRows = entryCriteria.map(({ok, label, val}) => {
    const c = ok ? 'var(--pos)' : 'var(--neg)';
    return `<tr>
      <td style="padding:3px 6px 3px 0;color:${c};font-weight:700">${ok ? '✓' : '✗'}</td>
      <td style="padding:3px 10px 3px 0;font-size:11px;color:${ok ? 'var(--text-muted)' : 'var(--text-faint)'}">${label}</td>
      <td style="padding:3px 0;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-faint)">${val}</td>
    </tr>`;
  }).join('');

  // ── Sell signals (right) ──
  const isSell = iyerExit !== null && cmp != null && cmp < iyerExit;
  const emaDefs = [
    ['40W EMA', t.ema40], ['30W EMA', t.ema30], ['21W EMA', t.ema21], ['10W EMA', t.ema10],
  ];
  const ss = t.sell_signals || {};

  const sellRows = [];
  // Iyer Exit
  const iyerOk = !isSell;
  sellRows.push(`<tr>
    <td style="padding:3px 6px 3px 0;color:${isSell ? 'var(--neg)' : 'var(--pos)'};font-weight:700">${isSell ? '✗' : '✓'}</td>
    <td style="padding:3px 10px 3px 0;font-size:11px;color:${isSell ? 'var(--neg)' : 'var(--text-muted)'}">Iyer Exit</td>
    <td style="padding:3px 0;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-faint)">${iyerExit != null ? _r(iyerExit) : '—'}</td>
  </tr>`);
  for (const [lbl, val] of emaDefs) {
    const d   = _emaDist(cmp, val);
    const hit = d !== null && d < 0;
    sellRows.push(`<tr>
      <td style="padding:3px 6px 3px 0;color:${hit ? 'var(--neg)' : 'var(--pos)'};font-weight:700">${hit ? '✗' : '✓'}</td>
      <td style="padding:3px 10px 3px 0;font-size:11px;color:${hit ? 'var(--neg)' : 'var(--text-muted)'}">${lbl}</td>
      <td style="padding:3px 0;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-faint)">${val ? _r(val) : '—'}${d !== null ? ' <span style="font-size:10px;color:' + (d >= 0 ? 'var(--pos)' : 'var(--neg)') + '">' + (d >= 0 ? '+' : '') + d.toFixed(1) + '%</span>' : ''}</td>
    </tr>`);
  }
  if (ss.stage3_warning)
    sellRows.push(`<tr><td style="color:var(--neg);font-weight:700;padding:3px 6px 3px 0">✗</td><td colspan="2" style="font-size:11px;color:var(--neg)">Stage 3 Warning</td></tr>`);
  if (ss.crs_broken)
    sellRows.push(`<tr><td style="color:var(--neg);font-weight:700;padding:3px 6px 3px 0">✗</td><td colspan="2" style="font-size:11px;color:var(--neg)">CRS below MA</td></tr>`);

  // ── StockScans panel (Indian tickers only) ──
  const isIndian   = _isIndianTicker(ticker);
  const sc         = isIndian && ticker ? (stockscans[ticker] || null) : null;
  const scCount    = sc ? sc.count : null;
  const scNames    = sc ? (sc.scan_names || []) : [];
  const scFetchedAt = sc ? sc.fetched_at : null;
  const scCountCol = scCount > 3 ? '#34d399' : scCount > 0 ? '#f59e0b' : '#64748b';
  const scansUrl   = ticker ? 'https://www.stockscans.in/company/' + ticker.replace(/\s+/g,'') : '#';

  // Format fetched_at → "8 Jun 2026, 3:42 PM" + hours-ago hint
  let scTimestamp = '';
  if (scFetchedAt) {
    try {
      const dt      = new Date(scFetchedAt);
      const dtStr   = dt.toLocaleString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true });
      const hoursAgo = Math.round((Date.now() - dt.getTime()) / 36e5);
      const agoStr  = hoursAgo < 1 ? 'just now' : hoursAgo < 24 ? hoursAgo + 'h ago' : Math.round(hoursAgo/24) + 'd ago';
      scTimestamp   = dtStr + ' (' + agoStr + ')';
    } catch(e) { scTimestamp = scFetchedAt; }
  }

  const scPanel = !isIndian ? '' : '<div>' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span style="font-size:11px;font-weight:700;color:var(--text-strong)">StockScans</span>' +
      (scCount !== null
        ? '<span style="font-weight:700;font-size:13px;color:' + scCountCol + '">' + scCount + '</span>' +
          '<span style="font-size:10px;color:var(--text-faint)">scan' + (scCount!==1?'s':'') + '</span>'
        : '<span style="font-size:10px;color:var(--text-faint)">not yet fetched</span>') +
      '<a href="' + scansUrl + '" target="_blank" style="font-size:10px;color:var(--accent);text-decoration:none;margin-left:2px" title="Open on StockScans">↗</a>' +
    '</div>' +
    (scNames.length
      ? '<div style="display:flex;flex-direction:column;gap:4px">' +
          scNames.map(n =>
            '<div style="display:flex;align-items:center;gap:5px">' +
              '<span style="width:6px;height:6px;border-radius:50%;background:' + scCountCol + ';flex-shrink:0"></span>' +
              '<span style="font-size:11px;color:var(--text-muted)">' + esc(n) + '</span>' +
            '</div>'
          ).join('') +
        '</div>'
      : '<div style="font-size:11px;color:var(--text-faint)">' + (sc ? 'No scan matches' : '—') + '</div>') +
    (scTimestamp
      ? '<div style="font-size:10px;color:var(--text-faint);margin-top:8px">🕐 ' + scTimestamp + '</div>'
      : '') +
  '</div>';

  return `<div style="${base};padding:12px 20px;display:flex;gap:32px;flex-wrap:wrap">
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:11px;font-weight:700;color:var(--text-strong)">Entry Signals</span>
        <span style="font-weight:700;font-size:12px;color:${scoreCol}">${score}/6</span>
        <span style="background:${sBg};color:${sFg};border-radius:4px;padding:1px 7px;font-size:9px;font-weight:700">${sLbl}</span>
      </div>
      <table style="border-spacing:0">${entryRows}</table>
    </div>
    <div style="width:1px;background:var(--border);align-self:stretch"></div>
    <div>
      <div style="font-size:11px;font-weight:700;color:var(--text-strong);margin-bottom:8px">Sell Signals</div>
      <table style="border-spacing:0">${sellRows.join('')}</table>
    </div>
    ${scPanel ? `<div style="width:1px;background:var(--border);align-self:stretch"></div>${scPanel}` : ''}
  </div>`;
}

// Sell Call cell: show worst signal only (hover for all)
function getSellCell(cmp, iyerExit, t) {
  if (iyerExit !== null && cmp != null && cmp < iyerExit)
    return `<span class="sig-badge sig-red-strong">Iyer ✕</span>`;
  if (!t || t.error)
    return `<span class="t-faint" style="font-size:11px">—</span>`;

  const d40 = _emaDist(cmp, t.ema40);
  const d30 = _emaDist(cmp, t.ema30);
  const d21 = _emaDist(cmp, t.ema21);
  const d10 = _emaDist(cmp, t.ema10);

  if (d40 !== null && d40 < 0)  return `<span class="sig-badge sig-red-strong">40W ↓</span>`;
  if (d30 !== null && d30 < 0)  return `<span class="sig-badge sig-red">30W ↓</span>`;
  if (d21 !== null && d21 < 0)  return `<span class="sig-badge sig-red">21W ↓</span>`;
  if (d10 !== null && d10 < 0)  return `<span class="sig-badge sig-amber">10W ↓</span>`;
  if (d40 !== null && d40 < 8)  return `<span class="sig-badge sig-amber">40W ⚠</span>`;
  if (d30 !== null && d30 < 5)  return `<span class="sig-badge sig-amber">30W ⚠</span>`;
  if (t.sell_signals?.stage3_warning) return `<span class="sig-badge sig-purple">S3 ⚠</span>`;
  return `<span class="sig-badge sig-green">✓ Hold</span>`;
}

// Hover tooltip for Sell Call: shows all triggered signals + EMA distances
function showSellTooltip(event, cmp, iyerExit, t) {
  const rows = [];

  // Iyer Exit row
  const iyerHit = iyerExit !== null && cmp != null && cmp < iyerExit;
  rows.push(`<tr>
    <td style="padding-right:4px">${iyerHit ? '<span style="color:var(--neg)">✗</span>' : '<span style="color:var(--pos)">✓</span>'}</td>
    <td class="${iyerHit ? 't-neg' : 't-pos'}" style="padding-right:12px">Iyer Exit</td>
    <td class="tt-val t-muted">${iyerExit != null ? _r(iyerExit) : '—'}</td>
  </tr>`);

  if (t && !t.error) {
    const emaDefs = [
      ['40W EMA', t.ema40], ['30W EMA', t.ema30], ['21W EMA', t.ema21], ['10W EMA', t.ema10],
    ];
    for (const [lbl, val] of emaDefs) {
      const d   = _emaDist(cmp, val);
      const hit = d !== null && d < 0;
      rows.push(`<tr>
        <td style="padding-right:4px">${hit ? '<span style="color:var(--neg)">✗</span>' : '<span style="color:var(--pos)">✓</span>'}</td>
        <td class="${hit ? 't-neg' : 't-pos'}" style="padding-right:12px">${lbl}</td>
        <td class="tt-val t-muted">${val ? _r(val) : '—'}</td>
        <td style="padding-left:6px">${d !== null ? _pct(cmp, val) : ''}</td>
      </tr>`);
    }
    const ss = t.sell_signals || {};
    if (ss.stage3_warning)
      rows.push(`<tr><td><span style="color:var(--neg)">✗</span></td><td class="t-neg" colspan="3">Stage 3 Warning</td></tr>`);
    if (ss.crs_broken)
      rows.push(`<tr><td><span style="color:var(--neg)">✗</span></td><td class="t-neg" colspan="3">CRS below MA</td></tr>`);
  }

  _showTT(event, `<div style="font-weight:700;margin-bottom:8px;font-size:12px" class="t-strong">Sell Signals</div>
    <table style="border-spacing:0 3px">${rows.join('')}</table>`);
}

function getEntryBadges(t) {
  if (!t)
    return '<span class="t-faint" style="font-size:11px">— no data</span>';
  if (t.error)
    return `<span class="t-neg" style="font-size:10px" title="${esc(t.error)}">⚠ ${esc(t.error.slice(0,30))}</span>`;
  if (!t.entry_signals)
    return '<span class="t-faint" style="font-size:11px">— loading</span>';
  const s = t.entry_signals;
  const score = t.entry_score ?? 0;
  const total = 6;
  const scoreColor = score >= 4 ? 'var(--pos)' : score >= 2 ? '#f59e0b' : 'var(--neg)';
  const items = [
    [s.above_30w_ema,     '30W'],
    [s.ema30_rising,      'EMA'],
    [s.rsi_buy_zone,      'RSI'],
    [s.adx_trending,      'ADX'],
    [s.crs_outperforming, 'CRS'],
    [s.near_52w_high,     '52H'],
  ];
  const bgs = items.map(([ok, lbl]) =>
    `<span class="badge entry-badge-${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${lbl}</span>`
  ).join('');
  return `<div style="display:flex;gap:3px;flex-wrap:nowrap;align-items:center;white-space:nowrap">
    <span style="font-size:12px;font-weight:700;color:${scoreColor};margin-right:3px">${score}/${total}</span>${bgs}
    <span style="font-size:10px;color:var(--text-faint);margin-left:2px">ⓘ</span></div>`;
}

// ─── Tooltip system ───────────────────────────────────────────────────────────
function _r(v, d = 2) {
  if (v == null || isNaN(v)) return '—';
  return '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
}
function _pct(cmp, ema) {
  if (!cmp || !ema) return '';
  const p = ((cmp - ema) / ema) * 100;
  return `<span class="${p >= 0 ? 't-pos' : 't-neg'}" style="font-size:10px">${p >= 0 ? '+' : ''}${p.toFixed(1)}%</span>`;
}

function showSigTooltip(event, cmp, iyerExit, t) {
  const rows = [];
  const iyerOk = iyerExit !== null && cmp != null && cmp < iyerExit;

  rows.push(`<tr>
    <td class="t-faint">CMP</td>
    <td class="tt-val t-strong">${_r(cmp)}</td>
    <td></td></tr>`);

  rows.push(`<tr>
    <td class="t-faint">Iyer Exit</td>
    <td class="tt-val ${iyerOk ? 't-neg' : 't-muted'}">${_r(iyerExit)}</td>
    <td style="padding-left:8px">${iyerExit ? (iyerOk ? '<span class="t-neg">↓ SELL</span>' : '<span class="t-pos">✓ Safe</span>') : ''}</td></tr>`);

  if (t) {
    const ss = t.sell_signals || {};
    const emaDefs = [
      ['10W EMA', t.ema10, ss.below_10w_ema],
      ['21W EMA', t.ema21, ss.below_21w_ema],
      ['30W EMA', t.ema30, ss.below_30w_ema],
      ['40W EMA', t.ema40, ss.below_40w_ema],
    ];
    rows.push('<tr><td colspan="3" style="padding-top:8px;padding-bottom:2px;border-top:1px solid var(--border)" class="t-faint">─ EMAs ─</td></tr>');
    for (const [lbl, val, below] of emaDefs) {
      rows.push(`<tr>
        <td class="t-faint">${lbl}</td>
        <td class="tt-val t-muted">${_r(val)}</td>
        <td style="padding-left:8px">${val ? _pct(cmp, val) : ''}${below ? ' <span class="t-neg" style="font-size:10px">↓</span>' : ''}</td></tr>`);
    }
    rows.push('<tr><td colspan="3" style="padding-top:8px;padding-bottom:2px;border-top:1px solid var(--border)" class="t-faint">─ Indicators ─</td></tr>');
    rows.push(`<tr>
      <td class="t-faint">RSI (14)</td>
      <td class="tt-val ${t.rsi >= 50 ? 't-pos' : t.rsi >= 40 ? 't-yellow' : 't-neg'}">${t.rsi != null ? t.rsi.toFixed(1) : '—'}</td>
      <td style="padding-left:8px;font-size:10px" class="t-faint">${t.rsi >= 60 ? 'Strong' : t.rsi >= 45 ? 'Neutral' : 'Weak'}</td></tr>`);
    rows.push(`<tr>
      <td class="t-faint">ADX</td>
      <td class="tt-val t-muted">${t.adx != null ? t.adx.toFixed(1) : '—'}</td>
      <td style="padding-left:8px;font-size:10px" class="t-faint">${t.adx >= 25 ? 'Trending' : t.adx >= 20 ? 'Building' : 'Ranging'}</td></tr>`);
    rows.push(`<tr>
      <td class="t-faint">CRS vs Nifty</td>
      <td class="tt-val ${t.crs_above_ma ? 't-pos' : 't-neg'}">${t.crs_above_ma == null ? '—' : t.crs_above_ma ? 'Out' : 'Under'}</td>
      <td></td></tr>`);
    rows.push(`<tr>
      <td class="t-faint">Stage (Weinstein)</td>
      <td class="tt-val ${t.stage === 2 ? 't-pos' : t.stage === 4 ? 't-neg' : 't-yellow'}">Stage ${t.stage}</td>
      <td></td></tr>`);
    rows.push(`<tr>
      <td class="t-faint">52W High</td>
      <td class="tt-val t-muted">${_r(t.peak_52w)}</td>
      <td></td></tr>`);
    rows.push(`<tr>
      <td class="t-faint" style="font-size:10px">Updated</td>
      <td class="tt-val t-faint" style="font-size:10px" colspan="2">${t.updated || '—'}</td></tr>`);
  } else {
    rows.push('<tr><td colspan="3" class="t-faint" style="padding-top:8px">No signal data — click ⟳ Signals to fetch</td></tr>');
  }

  const html = `<div style="font-weight:700;margin-bottom:8px;font-size:12px" class="t-strong">Exit Signal Details</div>
    <table>${rows.join('')}</table>`;
  _showTT(event, html);
}

function showEntryTooltip(event, t) {
  if (!t || !t.entry_signals) {
    _showTT(event, '<div class="t-faint" style="font-size:12px">No data — stock was just added.<br>Fetching signals automatically…</div>');
    return;
  }
  const s = t.entry_signals;
  const defs = [
    ['Above 30W EMA',     s.above_30w_ema,     `${_r(t.ema30)}`],
    ['30W EMA Rising',    s.ema30_rising,       t.ema30_rising ? 'Uptrend' : 'Flat/Down'],
    ['RSI Buy Zone ≥45',  s.rsi_buy_zone,       t.rsi != null ? t.rsi.toFixed(1) : '—'],
    ['ADX Trending ≥20',  s.adx_trending,       t.adx != null ? t.adx.toFixed(1) : '—'],
    ['CRS vs Nifty',      s.crs_outperforming,  t.crs_above_ma ? 'Outperforming' : 'Underperforming'],
    ['Near 52W High',     s.near_52w_high,      _r(t.peak_52w)],
  ];
  const rows = defs.map(([lbl, ok, val]) => `<tr>
    <td style="padding-right:6px">${ok ? '✓' : '✗'}</td>
    <td class="${ok ? 't-pos' : 't-neg'}" style="padding-right:12px">${lbl}</td>
    <td class="tt-val t-muted">${val}</td></tr>`);

  const score = t.entry_score ?? 0;
  const sc = score >= 4 ? '#34d399' : score >= 2 ? '#f59e0b' : '#f87171';
  const html = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-weight:700;font-size:14px;color:${sc}">${score}/6</span>
      <span class="t-strong" style="font-size:12px;font-weight:600">SOIC Entry Signals</span>
    </div>
    <table>${rows.join('')}</table>
    <div style="margin-top:8px;font-size:10px" class="t-faint">Weinstein Stage ${t.stage} · Updated ${t.updated || '—'}</div>`;
  _showTT(event, html);
}

function showNotesTooltip(event, el) {
  const text = el.dataset.notes;
  if (!text) return;
  const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const html = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px">
      <span style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint)">Notes / Thesis</span>
      <button data-notes="${escaped}" onclick="copyNotes(this)" title="Copy"
        style="background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:11px;color:var(--text-faint);padding:2px 7px;line-height:1.4;flex-shrink:0">⎘ Copy</button>
    </div>
    <div style="font-size:12.5px;line-height:1.7;color:var(--text-strong);max-width:320px;white-space:pre-wrap;word-break:break-word">${escaped}</div>`;
  _showTT(event, html);
}

function _showTT(event, html) {
  const tt = document.getElementById('sig-tooltip');
  tt.innerHTML = html;
  tt.classList.remove('hidden');
  _positionTT(event);
}

function moveSigTooltip(event) { _positionTT(event); }

function _positionTT(event) {
  const tt  = document.getElementById('sig-tooltip');
  const pad = 12;
  let   x   = event.clientX + pad;
  let   y   = event.clientY + pad;
  const w   = tt.offsetWidth  || 250;
  const h   = tt.offsetHeight || 200;
  if (x + w > window.innerWidth  - pad) x = event.clientX - w - pad;
  if (y + h > window.innerHeight - pad) y = event.clientY - h - pad;
  tt.style.left = x + 'px';
  tt.style.top  = y + 'px';
}

function hideSigTooltip() {
  document.getElementById('sig-tooltip').classList.add('hidden');
}

// ─── Watchlist signal refresh ─────────────────────────────────────────────────
async function refreshWatchlistSignals() {
  await fetchData();  // ensure fresh tickers from server before iterating
  const wl = state.watchlist || [];
  if (!wl.length) return;

  const setBtn = (txt, dis) => {
    const b = document.getElementById('wl-signals-btn');
    if (b) { b.textContent = txt; b.disabled = dis; }
  };

  setBtn(`⟳ 0/${wl.length}`, true);

  let done = 0;
  for (const w of wl) {
    if (!w.ticker) continue;
    try {
      const res  = await fetch('/api/technicals/single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: w.ticker }),
      });
      const data = await res.json();
      technicals[w.ticker] = data.data || { error: 'no data' };
    } catch (e) {
      technicals[w.ticker] = { error: e.message };
    }
    // Backfill added_price in parallel (non-blocking)
    backfillAddedPrice(w, 'watchlist').then(() => renderTab());
    done++;
    setBtn(`⟳ ${done}/${wl.length}`, true);
  }

  renderTab();
  setTimeout(() => setBtn('⟳ Refresh Signals', false), 100);
}

// ─── Iyer Exit explainer ──────────────────────────────────────────────────────
function renderIyerExplainer(positions) {
  const riskPct      = parseFloat(state.settings.portfolio_risk_pct ?? 1.0);
  const totalPortVal = sum(state.positions.filter(p => INR_ACCTS.includes(p.account)), p => p.current_value_inr);
  const riskAmount   = totalPortVal * (riskPct / 100);
  const grouped      = groupConsolidated(positions);

  const rows = [...grouped].sort((a, b) => (b.current_value_inr || 0) - (a.current_value_inr || 0)).map(p => {
    const peak     = p.peak_price || Math.max(p.avg_buy_price || 0, p.cmp || 0);
    const riskPerShare = p.quantity > 0 ? riskAmount / p.quantity : null;
    const iyerExit = riskPerShare !== null ? peak - riskPerShare : null;
    const isSell   = iyerExit !== null && p.cmp != null && p.cmp < iyerExit;
    const pnlCls   = isSell ? 't-neg' : (iyerExit && p.cmp && p.cmp > iyerExit * 1.1 ? 't-pos' : 't-muted');
    const cushion  = (iyerExit && p.cmp) ? ((p.cmp - iyerExit) / p.cmp * 100) : null;

    return `<tr>
      <td>
        <div class="t-strong font-medium" style="font-size:12px">${esc(p.stock_name)}</div>
        <div class="t-faint" style="font-size:10px">${esc(p.ticker)}</div>
      </td>
      <td class="text-right t-muted">${num(p.avg_buy_price)}</td>
      <td class="text-right ${peak > p.avg_buy_price ? 't-pos' : 't-muted'}">${num(peak)}</td>
      <td class="text-right t-muted">${num(p.quantity, 4)}</td>
      <td class="text-right t-faint">${riskPerShare ? num(riskPerShare) : '—'}</td>
      <td class="text-right font-semibold ${isSell ? 't-neg' : 't-muted'}">${iyerExit !== null ? num(iyerExit) : '—'}</td>
      <td class="text-right">${num(p.cmp)}</td>
      <td class="text-right ${pnlCls}" style="font-size:11px">
        ${cushion !== null ? (cushion >= 0 ? `+${cushion.toFixed(1)}%` : `${cushion.toFixed(1)}%`) : '—'}
      </td>
      <td class="text-center" style="font-size:12px">${isSell ? '🔴 SELL' : '<span class="t-pos">✓ Hold</span>'}</td>
    </tr>`;
  }).join('');

  return `
  <div class="card mt-6">
    <div class="flex items-center justify-between cursor-pointer select-none"
         onclick="toggleIyer()" style="padding-bottom:4px">
      <div class="text-sm font-semibold t-strong">📐 Iyer Exit Price — Calculation Breakdown</div>
      <span id="iyer-toggle-icon" class="t-faint text-xs">▼ collapse</span>
    </div>
    <div id="iyer-body">
      <!-- Formula card -->
      <div class="mt-4 mb-4 p-4 rounded-lg" style="background:var(--surface2);border:1px solid var(--border)">
        <div class="text-xs font-semibold t-muted mb-3 uppercase tracking-wide">How it works</div>
        <div class="font-mono text-sm t-strong mb-2">
          Iyer Exit = <span class="t-yellow">Peak Price</span> − (<span class="t-blue">Portfolio Value</span> × <span class="t-pos">Risk%</span>) ÷ <span class="t-muted">Quantity</span>
        </div>
        <div class="text-xs t-faint mt-3 leading-relaxed">
          <b class="t-yellow">Peak Price</b> = highest price the stock has reached <em>since your buy date</em>.
          Tracked automatically — ratchets upward whenever a higher CMP is recorded; never goes down.
          Click <b>⟳ Signals</b> to pull the 52-week high from Yahoo Finance and update it.<br>
          <b class="t-blue">Portfolio Value</b> = total current value of all INR holdings.<br>
          <b class="t-pos">Risk%</b> = the % of your total portfolio you're willing to lose if a single stock hits stop-loss (Rajshekhar Iyer's 1% rule).<br>
          <b class="t-muted">Quantity</b> = consolidated qty across all INR accounts.<br><br>
          <b>Interpretation:</b> If CMP falls below Iyer Exit, the total loss on this position equals exactly
          <b>Risk% of your entire portfolio</b> — your pre-decided maximum pain per bet.
          The higher the peak has gone, the tighter the exit moves up with it (trailing stop behaviour).
        </div>
      </div>

      <!-- Current inputs -->
      <div class="flex gap-3 flex-wrap mb-4">
        <div class="card py-2 px-4" style="background:var(--surface2)">
          <div class="text-xs t-faint">Total INR Portfolio</div>
          <div class="text-base font-bold t-strong">₹${fmtNum(totalPortVal)}</div>
        </div>
        <div class="card py-2 px-4" style="background:var(--surface2)">
          <div class="text-xs t-faint">Risk % per position</div>
          <div class="text-base font-bold t-pos">${riskPct}%</div>
        </div>
        <div class="card py-2 px-4" style="background:var(--surface2)">
          <div class="text-xs t-faint">Max loss per stock (₹)</div>
          <div class="text-base font-bold t-neg">₹${fmtNum(riskAmount)}</div>
          <div class="text-xs t-faint mt-0.5">= ₹${fmtNum(totalPortVal)} × ${riskPct}%</div>
        </div>
        <div class="card py-2 px-4" style="background:var(--surface2)">
          <div class="text-xs t-faint">Example: 100 shares</div>
          <div class="text-base font-bold t-muted">₹${num(riskAmount / 100)} / share</div>
          <div class="text-xs t-faint mt-0.5">= ₹${fmtNum(riskAmount)} ÷ 100 qty</div>
        </div>
      </div>

      <!-- Per-position table -->
      <div style="overflow-x:auto">
        <table class="tbl">
          <thead><tr>
            <th class="text-left">Stock</th>
            <th class="text-right">Avg Buy ₹</th>
            <th class="text-right" title="Highest price since buy date">Peak Price ₹ ↑</th>
            <th class="text-right">Qty</th>
            <th class="text-right" title="Max loss ÷ Quantity = how much the stock can fall">Risk÷Qty ₹</th>
            <th class="text-right">= Iyer Exit ₹</th>
            <th class="text-right">CMP ₹</th>
            <th class="text-right">Cushion</th>
            <th class="text-center">Signal</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="text-xs t-faint mt-3">
        <b>Cushion</b> = (CMP − Iyer Exit) ÷ CMP × 100. Negative = CMP already below exit.
        Larger positive = more room before stop-loss triggers.
        Adjust Risk% in the header to change sensitivity.
      </div>
    </div>
  </div>`;
}

function toggleIyer() {
  const body = document.getElementById('iyer-body');
  const icon = document.getElementById('iyer-toggle-icon');
  if (!body) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? '' : 'none';
  icon.textContent   = hidden ? '▼ collapse' : '▶ expand';
}

// ─── Utils ────────────────────────────────────────────────────────────────────
const sum = (arr, fn) => arr.reduce((s, x) => s + (fn(x) || 0), 0);

function fmtNum(v) {
  if (v == null || isNaN(v)) return '—';
  const a = Math.abs(v);
  let s;
  if (a >= 1e7)      s = (v / 1e7).toFixed(2) + ' Cr';
  else if (a >= 1e5) s = (v / 1e5).toFixed(2) + ' L';
  else if (a >= 1e3) s = (v / 1e3).toFixed(1) + 'K';
  else               s = v.toFixed(0);
  return `<span class="pn">${s}</span>`;
}

// Currency-aware formatter: any non-INR currency uses $K/$M/$B-style scaling;
// INR uses ₹K/₹L/₹Cr. Pass `currency` (e.g. p.currency) for the correct symbol
// on EUR/GBP/SGD/AUD positions — falls back to the isUS boolean ($/₹) when omitted.
// withSign=true adds '+' prefix for positive values (P&L display)
function fmtCur(v, isUS, withSign, currency) {
  if (v == null || isNaN(v)) return '—';
  const a = Math.abs(v);
  const neg = v < 0;
  const isNonInr = currency ? currency !== 'INR' : isUS;
  const sym = currency ? curSym(currency) : (isUS ? '$' : '₹');
  let mag;
  if (isNonInr) {
    if (a >= 1e9)      mag = sym + (a / 1e9).toFixed(2) + 'B';
    else if (a >= 1e6) mag = sym + (a / 1e6).toFixed(2) + 'M';
    else if (a >= 1e3) mag = sym + (a / 1e3).toFixed(1) + 'K';
    else               mag = sym + a.toFixed(0);
  } else {
    if (a >= 1e7)      mag = sym + (a / 1e7).toFixed(2) + ' Cr';
    else if (a >= 1e5) mag = sym + (a / 1e5).toFixed(2) + ' L';
    else if (a >= 1e3) mag = sym + (a / 1e3).toFixed(1) + 'K';
    else               mag = sym + a.toFixed(0);
  }
  const sign = neg ? '-' : (withSign ? '+' : '');
  return `<span class="pn">${sign}${mag}</span>`;
}

function fmt(v) {
  if (v == null) return '—';
  const a = Math.abs(v), sign = v >= 0 ? '₹' : '-₹';
  let s;
  if (a >= 1e7)      s = sign + (a / 1e7).toFixed(2) + ' Cr';
  else if (a >= 1e5) s = sign + (a / 1e5).toFixed(2) + ' L';
  else               s = sign + a.toFixed(0);
  return `<span class="pn">${s}</span>`;
}

// Format a raw market-cap integer (from Yahoo Finance) → human-readable string
function fmtMktCap(v) {
  if (v == null || isNaN(v) || v <= 0) return null;
  if (v >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (v >= 1e9)  return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6)  return (v / 1e6).toFixed(1) + 'M';
  return v.toLocaleString();
}

function num(v, d = 2) {
  if (v == null) return '—';
  const maxD = d === 2 ? 10 : d;
  const s = Number(v).toLocaleString('en-IN', { maximumFractionDigits: maxD, minimumFractionDigits: Math.min(d, 2) });
  return `<span class="pn">${s}</span>`;
}

function _todayPassword() {
  const d = new Date();
  return String(d.getDate()).padStart(2,'0') + String(d.getMonth()+1).padStart(2,'0') + d.getFullYear();
}

const _SVG_EYE_OFF = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const _SVG_EYE_ON  = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

function showPrivacyModal() {
  if (NUMBERS_VISIBLE) {
    NUMBERS_VISIBLE = false;
    document.body.classList.add('numbers-hidden');
    document.getElementById('privacy-btn').innerHTML = _SVG_EYE_OFF;
    return;
  }
  document.getElementById('privacy-pwd').value = '';
  document.getElementById('privacy-error').classList.add('hidden');
  document.getElementById('privacy-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('privacy-pwd').focus(), 50);
}

function closePrivacyModal() {
  document.getElementById('privacy-modal').classList.add('hidden');
}

function checkPrivacyPassword() {
  const pwd = document.getElementById('privacy-pwd').value.trim();
  if (pwd === _todayPassword()) {
    NUMBERS_VISIBLE = true;
    document.body.classList.remove('numbers-hidden');
    document.getElementById('privacy-btn').innerHTML = _SVG_EYE_ON;
    closePrivacyModal();
  } else {
    document.getElementById('privacy-error').classList.remove('hidden');
    document.getElementById('privacy-pwd').value = '';
    document.getElementById('privacy-pwd').focus();
  }
}
// ──────────────────────────────────────────────────────────────────────────

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _isIndianTicker(ticker) {
  if (!ticker) return false;
  const t = ticker.toUpperCase();
  return t.startsWith('NSE:') || t.startsWith('BSE:');
}

function _stockLink(ticker, label) {
  const name = esc(label || ticker);
  if (_isIndianTicker(ticker)) {
    // stockscans.in expects the full ticker e.g. "NSE:EPACKPEB"
    return `<a href="https://www.stockscans.in/company/${ticker.replace(/\s+/g,'')}" target="_blank" rel="noopener"
       style="font-weight:500;color:var(--text-strong);text-decoration:none;border-bottom:1px dotted var(--border)"
       onmouseover="this.style.color='#3b82f6'" onmouseout="this.style.color='var(--text-strong)'"
    >${name}</a>`;
  }
  // Non-Indian: link to Perplexity Finance
  const ytick = ticker.replace(/^[A-Z]+:/i, '');
  return `<a href="https://www.perplexity.ai/finance/${encodeURIComponent(ytick)}" target="_blank" rel="noopener"
     style="font-weight:500;color:var(--text-strong);text-decoration:none;border-bottom:1px dotted var(--border)"
     onmouseover="this.style.color='#3b82f6'" onmouseout="this.style.color='var(--text-strong)'"
  >${name}</a>`;
}

function copyNotes(btn, text) {
  const raw = text || btn.dataset.notes || '';
  if (!raw) return;
  navigator.clipboard.writeText(raw).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = raw; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  });
  const orig = btn.textContent;
  btn.textContent = '✓';
  btn.style.color = '#34d399';
  setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1400);
}

// ─── Sector Datalist ──────────────────────────────────────────────────────────
const _SECTOR_SEED = [
  // Indian
  'CDMO','Pharma','Hospitals','Chemicals','Banking','SFB','NBFC','Fintech',
  'Capital Goods','Defence','Infrastructure','Building Materials','Hospitality',
  'Consumer','IT','Energy','Electrification Theme','Alternative Energy',
  'Space Tech','Aerospace','Automotive - Ancilliary','Automotive - CV',
  'Recycling','Metals','Precious Metals','Commodities','Gold Commodity ETF',
  'Silver Commodity ETF','Gold Miners','Silver Miners','Gold Financiers',
  'Gold/Silver ETF','US Equity',
  // US / international
  'Technology','AI / Semiconductors','Healthcare','Financials','Utilities',
  'Materials','Industrials','Defense / Aerospace','Gaming','Uranium',
  'Gold / Precious Metals','Silver','ETF – Broad Market','ETF – Sector','ETF – Thematic',
  'Other',
];

function buildSectorDatalist() {
  const fromPos = (state.positions || []).map(p => p.sector).filter(Boolean);
  const fromWl  = [...(state.watchlist||[]), ...(state.us_watchlist||[])]
                    .map(w => w.sector).filter(Boolean);
  const custom  = state.settings?.custom_sectors || [];
  const all = [...new Set([..._SECTOR_SEED, ...fromPos, ...fromWl, ...custom])].sort();
  const dl = document.getElementById('sector-datalist');
  if (dl) dl.innerHTML = all.map(s => `<option value="${esc(s)}">`).join('');
}

async function addCustomSector() {
  const input = document.getElementById('new-sector-input');
  const name = (input?.value || '').trim();
  if (!name) return;
  const current = state.settings?.custom_sectors || [];
  if (current.map(s=>s.toLowerCase()).includes(name.toLowerCase())) { input.value = ''; return; }
  const updated = [...current, name].sort();
  const r = await fetch('/api/settings', {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ custom_sectors: updated }),
  });
  if (r.ok) {
    state.settings.custom_sectors = updated;
    input.value = '';
    buildSectorDatalist();
    render();
  }
}

async function removeCustomSector(name) {
  const updated = (state.settings?.custom_sectors || []).filter(s => s !== name);
  const r = await fetch('/api/settings', {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ custom_sectors: updated }),
  });
  if (r.ok) {
    state.settings.custom_sectors = updated;
    buildSectorDatalist();
    render();
  }
}

// ─── Cash & HUF Tab ───────────────────────────────────────────────────────────

function renderCash() {
  const cb           = state.cash_balances || {};
  const pg           = state.settings?.portfolio_groups?.indian || [];
  const conAccts     = pg.filter(p => p.consolidated !== false);
  const nonConAccts  = pg.filter(p => p.consolidated === false);
  const totalCash    = conAccts.reduce((s, p) => s + (cb[p.id] || 0), 0);
  const aifVal       = aifLatestNav();
  const conIds       = new Set(conAccts.map(p => p.id));
  const conPositions = state.positions.filter(p => conIds.has(p.account));
  const portfolioVal = sum(conPositions, p => p.current_value_inr) + aifVal;
  const totalCapital = portfolioVal + totalCash;
  const cashPct      = totalCapital > 0 ? (totalCash / totalCapital * 100) : 0;
  const target       = state.settings.target_cash_pct || 10;
  const deployable   = Math.max(0, totalCash - (target / 100) * totalCapital);
  const cashColor    = cashPct < target ? 'var(--neg)' : 'var(--pos)';

  // ── Summary cards ──────────────────────────────────────────────────────────
  const summaryCards = `
    <div class="flex items-center gap-3 flex-wrap mb-5">
      <div class="card min-w-[130px] text-center" style="border-color:#f59e0b44">
        <div class="text-xl font-bold" style="color:#f59e0b">${fmt(totalCash)}</div>
        <div class="text-xs t-faint mt-0.5">Total Cash (Consolidated)</div>
      </div>
      <div class="card min-w-[130px] text-center">
        <div class="text-xl font-bold t-muted">${fmt(portfolioVal)}</div>
        <div class="text-xs t-faint mt-0.5">Portfolio Value</div>
      </div>
      <div class="card min-w-[130px] text-center">
        <div class="text-xl font-bold t-strong">${fmt(totalCapital)}</div>
        <div class="text-xs t-faint mt-0.5">Total Capital</div>
      </div>
      <div class="card min-w-[110px] text-center" style="border-color:${cashColor}44">
        <div class="text-xl font-bold" style="color:${cashColor}">${cashPct.toFixed(1)}%</div>
        <div class="text-xs t-faint mt-0.5">Cash % <span style="color:var(--text-faint)">(tgt ${target}%)</span></div>
      </div>
      ${deployable > 0 ? `<div class="card min-w-[130px] text-center" style="border-color:var(--pos)44">
        <div class="text-xl font-bold t-pos">${fmt(deployable)}</div>
        <div class="text-xs t-faint mt-0.5">Deployable Excess</div>
      </div>` : ''}
    </div>`;

  // ── Cash balance inputs per account ───────────────────────────────────────
  const _cashRow = (p) => `
    <div class="flex items-center gap-3">
      <div style="width:110px;font-size:12px;color:var(--text-muted);font-weight:500">${esc(p.name)}</div>
      <div style="flex:1">
        <input id="cash-${p.id}" type="text"
          value="${(cb[p.id]||0).toLocaleString('en-IN')}"
          placeholder="0"
          style="text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px"
          oninput="recalcCashPreview()">
      </div>
    </div>`;

  const consolidatedRows = conAccts.map(_cashRow).join('');
  const nonConRows = nonConAccts.length ? `
    <div style="font-size:10px;font-weight:600;color:var(--text-faint);letter-spacing:.06em;text-transform:uppercase;margin-top:10px;padding-top:10px;border-top:1px dashed var(--border)">Non-consolidated</div>
    ${nonConAccts.map(_cashRow).join('')}` : '';

  const cashBalancesCard = `
    <div class="card" style="max-width:380px">
      <div class="text-xs font-semibold t-muted mb-3 uppercase tracking-wide">Cash Balances</div>
      <div class="space-y-2.5 mb-4">${consolidatedRows}${nonConRows}</div>
      <div class="flex items-center gap-3 pt-3" style="border-top:1px solid var(--border)">
        <div style="width:110px;font-size:11px;color:var(--text-faint)">Target Cash %</div>
        <input id="cash-target-pct" type="number" step="0.5" min="0" max="100"
          value="${target}"
          style="width:80px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px"
          oninput="recalcCashPreview()">
        <span class="t-faint" style="font-size:11px">% of total capital</span>
      </div>
      <div id="cash-preview" class="mt-3 text-xs t-faint"></div>
      <button id="save-cash-btn" onclick="saveCashBalances()" class="btn btn-blue text-xs mt-4 w-full">Save Balances</button>
      <div id="cash-save-msg" style="font-size:11px;text-align:center;margin-top:6px;min-height:14px"></div>
    </div>`;

  // ── Allocation calculator ─────────────────────────────────────────────────
  const riskPct = parseFloat(state.settings.portfolio_risk_pct ?? 1.0);
  const maxPositionSize = totalCapital * (riskPct / 100);

  const allocCalcCard = `
    <div class="card" style="max-width:380px">
      <div class="text-xs font-semibold t-muted mb-3 uppercase tracking-wide">Allocation Calculator</div>
      <div class="text-xs t-faint mb-3">
        Base = Portfolio (<span class="t-strong">${fmt(portfolioVal)}</span>) + Cash (<span style="color:#f59e0b">${fmt(totalCash)}</span>)
        = <span class="t-strong">${fmt(totalCapital)}</span>
      </div>
      <div class="flex items-center gap-2 mb-4">
        <span class="t-faint" style="font-size:11px;white-space:nowrap">Invest (₹)</span>
        <input id="alloc-amount" type="text" placeholder="e.g. 1,00,000"
          style="font-family:'JetBrains Mono',monospace;font-size:12px;text-align:right"
          oninput="recalcAlloc()">
      </div>
      <div id="alloc-result" class="space-y-2"></div>
      <div class="mt-4 pt-3" style="border-top:1px solid var(--border)">
        <div class="text-xs t-faint mb-1">Max position size at <span class="t-pos">${riskPct}% risk</span></div>
        <div class="text-base font-bold t-muted">${fmt(maxPositionSize)}</div>
        <div class="text-xs t-faint mt-1">${riskPct}% × ${fmt(totalCapital)}</div>
      </div>
    </div>`;

  // ── HUF Transfers ─────────────────────────────────────────────────────────
  const transfers = (state.huf_transfers || []).slice().sort((a,b) => b.date.localeCompare(a.date));
  const fromVib = transfers.filter(t => t.from_account === 'vibhanshu').reduce((s,t) => s+t.amount, 0);
  const fromMan = transfers.filter(t => t.from_account === 'manjari').reduce((s,t) => s+t.amount, 0);
  const totalT  = fromVib + fromMan;

  const tRows = transfers.length ? transfers.map(t => `
    <tr>
      <td class="t-muted">${t.date}</td>
      <td><span class="badge">${t.from_account === 'vibhanshu' ? 'Vibhanshu' : 'Manjari'}</span></td>
      <td class="num t-strong text-right">₹${(t.amount||0).toLocaleString('en-IN')}</td>
      <td style="font-size:11px;max-width:240px">
        <div style="display:flex;align-items:flex-start;gap:4px">
          <div style="flex:1;min-width:0" id="ht-note-display-${t.id}">
            ${inlineCollapsibleNotes(t.notes)}
          </div>
          <button onclick="editHufNote('${t.id}', this)"
            style="flex-shrink:0;background:none;border:none;cursor:pointer;font-size:11px;color:var(--text-faint);padding:1px 3px;opacity:.4;line-height:1"
            onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.4'" title="Edit note">✎</button>
        </div>
      </td>
      <td class="text-right">
        <button onclick="deleteHufTransfer('${t.id}')" class="btn btn-ghost text-xs py-0 px-2" style="color:var(--neg)">✕</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="5" class="text-center t-faint py-5" style="font-size:12px">No transfers yet</td></tr>`;

  const today = new Date().toISOString().split('T')[0];
  const transfersCard = `
    <div class="card mt-6">
      <div class="text-xs font-semibold t-muted mb-4 uppercase tracking-wide">HUF Transfers</div>

      <!-- Summary pills -->
      <div class="flex gap-3 flex-wrap mb-5">
        <div class="card py-2 px-4" style="background:var(--surface2);border-color:var(--border)">
          <div class="text-xs t-faint">From Vibhanshu</div>
          <div class="text-base font-bold t-strong">₹${fromVib.toLocaleString('en-IN')}</div>
        </div>
        <div class="card py-2 px-4" style="background:var(--surface2);border-color:var(--border)">
          <div class="text-xs t-faint">From Manjari</div>
          <div class="text-base font-bold t-strong">₹${fromMan.toLocaleString('en-IN')}</div>
        </div>
        <div class="card py-2 px-4" style="background:var(--surface2);border-color:var(--accent)44">
          <div class="text-xs t-faint">Total Transferred to HUF</div>
          <div class="text-base font-bold t-blue">₹${totalT.toLocaleString('en-IN')}</div>
        </div>
      </div>

      <!-- Add form -->
      <div class="p-4 rounded-lg mb-5" style="background:var(--surface2);border:1px solid var(--border)">
        <div class="text-xs font-semibold t-faint mb-3">Add Transfer</div>
        <div class="flex gap-3 flex-wrap items-end">
          <div>
            <div class="text-xs t-faint mb-1">From Account</div>
            <select id="ht-from" style="width:130px;padding:6px 10px;font-size:12px;background:var(--input-bg);border:1px solid var(--border);border-radius:6px;color:var(--text)">
              <option value="vibhanshu">Vibhanshu</option>
              <option value="manjari">Manjari</option>
            </select>
          </div>
          <div>
            <div class="text-xs t-faint mb-1">Amount (₹)</div>
            <input id="ht-amount" type="text" placeholder="e.g. 5,00,000"
              style="width:130px;font-family:'JetBrains Mono',monospace;font-size:12px;text-align:right">
          </div>
          <div>
            <div class="text-xs t-faint mb-1">Date</div>
            <input id="ht-date" type="date" value="${today}" style="font-size:12px;width:140px">
          </div>
          <div style="flex:1;min-width:160px">
            <div class="text-xs t-faint mb-1">Notes</div>
            <input id="ht-notes" type="text" placeholder="e.g. Q1 capital contribution" style="font-size:12px">
          </div>
          <button onclick="addHufTransfer()" class="btn btn-blue text-xs" style="white-space:nowrap">Add Transfer</button>
        </div>
      </div>

      <!-- Table -->
      <div style="overflow-x:auto">
        <table class="tbl">
          <thead><tr>
            <th class="text-left">Date</th>
            <th class="text-left">From</th>
            <th class="text-right">Amount</th>
            <th class="text-left">Notes</th>
            <th></th>
          </tr></thead>
          <tbody>${tRows}</tbody>
        </table>
      </div>
    </div>`;

  return summaryCards
    + `<div class="flex gap-4 flex-wrap items-start">${cashBalancesCard}${allocCalcCard}</div>`
    + transfersCard;
}

function recalcCashPreview() {
  // Only consolidated accounts count toward portfolio cash %
  const conIds = (state.settings?.portfolio_groups?.indian || [])
    .filter(p => p.consolidated !== false).map(p => p.id);
  let total = 0;
  conIds.forEach(k => {
    const v = parseRupees(document.getElementById('cash-'+k)?.value || '0');
    total += v;
  });
  const target = parseFloat(document.getElementById('cash-target-pct')?.value || 10);
  const aifVal = aifLatestNav();
  const conIdSet = new Set(conIds);
  const portfolioVal = sum(state.positions.filter(p => conIdSet.has(p.account)), p => p.current_value_inr) + aifVal;
  const totalCapital = portfolioVal + total;
  const cashPct = totalCapital > 0 ? (total/totalCapital*100).toFixed(1) : '0.0';
  const deployable = Math.max(0, total - (target/100)*totalCapital);
  const el = document.getElementById('cash-preview');
  if (el) el.innerHTML = `Preview: ${cashPct}% cash of ₹${fmtNum(totalCapital)} total${deployable>0 ? ` · <span style="color:var(--pos)">₹${fmtNum(deployable)} deployable</span>` : ''}`;
  recalcAlloc();
}

function recalcAlloc() {
  const el = document.getElementById('alloc-result');
  if (!el) return;
  const raw = document.getElementById('alloc-amount')?.value || '';
  const amount = parseRupees(raw);
  if (!amount || amount <= 0) { el.innerHTML = ''; return; }

  const cb = state.cash_balances || {};
  const conIds = (state.settings?.portfolio_groups?.indian || [])
    .filter(p => p.consolidated !== false).map(p => p.id);
  let cashNow = 0;
  conIds.forEach(k => {
    const inp = document.getElementById('cash-'+k);
    cashNow += inp ? parseRupees(inp.value||'0') : (cb[k]||0);
  });

  const aifVal = aifLatestNav();
  const conIdSet2 = new Set(conIds);
  const portfolioVal = sum(state.positions.filter(p => conIdSet2.has(p.account)), p => p.current_value_inr) + aifVal;
  const totalCapital = portfolioVal + cashNow;
  const allocPct = totalCapital > 0 ? (amount/totalCapital*100) : 0;
  const cashAfter = cashNow - amount;
  const newCashPct = totalCapital > 0 ? (cashAfter/totalCapital*100) : 0;
  const riskPct = parseFloat(state.settings.portfolio_risk_pct ?? 1.0);
  const maxPos = totalCapital * (riskPct/100);
  const target = parseFloat(document.getElementById('cash-target-pct')?.value || state.settings.target_cash_pct || 10);
  const allocCls = allocPct > riskPct*3 ? 'color:var(--neg)' : 'color:var(--pos)';
  const cashAfterCls = newCashPct < target ? 'color:var(--neg)' : 'color:var(--pos)';

  el.innerHTML = `
    <div class="space-y-2 text-xs">
      <div class="flex justify-between">
        <span class="t-faint">Allocation %</span>
        <span class="num font-semibold" style="${allocCls}">${allocPct.toFixed(2)}% of total capital</span>
      </div>
      <div class="flex justify-between">
        <span class="t-faint">vs Max position (${riskPct}% risk)</span>
        <span class="num" style="${amount<=maxPos?'color:var(--pos)':'color:var(--neg)'}">
          ${fmt(amount)} / ${fmt(maxPos)}
          ${amount<=maxPos ? '✓ within limit' : '⚠ exceeds risk limit'}
        </span>
      </div>
      <div class="flex justify-between">
        <span class="t-faint">Cash after deployment</span>
        <span class="num font-semibold" style="${cashAfterCls}">
          ${fmt(Math.max(0,cashAfter))} (${Math.max(0,newCashPct).toFixed(1)}%)
          ${newCashPct < target ? ' ⚠ below target' : ' ✓'}
        </span>
      </div>
    </div>`;
}

async function saveCashBalances() {
  const btn  = document.getElementById('save-cash-btn');
  const msg  = document.getElementById('cash-save-msg');
  const allIds = (state.settings?.portfolio_groups?.indian || []).map(p => p.id);
  const balances = {};
  allIds.forEach(k => {
    const raw = document.getElementById('cash-'+k)?.value || '0';
    balances[k] = parseRupees(raw);
  });
  const targetPct = parseFloat(document.getElementById('cash-target-pct')?.value) || 10;

  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  if (msg) { msg.textContent = ''; msg.style.color = 'var(--text-faint)'; }

  try {
    // Sequential — parallel PUTs race on data.json (last writer wins, reverts the other)
    const r1 = await fetch('/api/cash_balances', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(balances) });
    if (!r1.ok) { const b = await r1.text().catch(()=>''); throw new Error('Cash save error ' + r1.status + (b ? ': ' + b.slice(0,120) : '')); }
    const r2 = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ target_cash_pct: targetPct }) });
    if (!r2.ok) { const b = await r2.text().catch(()=>''); throw new Error('Settings save error ' + r2.status + (b ? ': ' + b.slice(0,120) : '')); }

    // Re-fetch from server so what we show exactly matches what was saved
    await fetchData();

    // fetchData() re-renders the cash tab in place — re-grab the elements
    const btn2 = document.getElementById('save-cash-btn');
    const msg2 = document.getElementById('cash-save-msg');
    if (btn2) { btn2.textContent = '✓ Saved'; btn2.style.background = 'var(--pos)'; btn2.disabled = false; }
    if (msg2) { msg2.style.color = 'var(--pos)'; msg2.textContent = 'Balances saved'; }
    setTimeout(() => {
      const b = document.getElementById('save-cash-btn');
      const m = document.getElementById('cash-save-msg');
      if (b) { b.textContent = 'Save Balances'; b.style.background = ''; }
      if (m) { m.textContent = ''; }
    }, 2500);
  } catch(err) {
    console.error('saveCashBalances error:', err);
    if (btn) { btn.textContent = 'Save Balances'; btn.style.background = ''; btn.disabled = false; }
    if (msg) { msg.style.color = 'var(--neg)'; msg.textContent = '✕ Save failed — ' + err.message; }
  }
}

async function addHufTransfer() {
  const from   = document.getElementById('ht-from')?.value;
  const amount = parseRupees(document.getElementById('ht-amount')?.value || '0');
  const date   = document.getElementById('ht-date')?.value;
  const notes  = document.getElementById('ht-notes')?.value || '';
  if (!amount || amount <= 0) { alert('Enter a valid amount'); return; }
  if (!date) { alert('Enter a date'); return; }
  await fetch('/api/huf_transfers', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ from_account: from, amount, date, notes }),
  });
  await fetchData();
  if (currentTab === 'cash') renderTab();
}

async function deleteHufTransfer(id) {
  if (!confirm('Delete this transfer?')) return;
  await fetch(`/api/huf_transfers/${id}`, { method: 'DELETE' });
  await fetchData();
  if (currentTab === 'cash') renderTab();
}

function editHufNote(id, btn) {
  const display = document.getElementById(`ht-note-display-${id}`);
  if (!display) return;
  const t = (state.huf_transfers || []).find(x => x.id === id);
  const cur = t?.notes || '';
  display.innerHTML = `<input type="text" value="${esc(cur)}"
    style="width:100%;font-size:11px;background:var(--surface2);border:1px solid var(--accent);border-radius:4px;padding:3px 6px;color:var(--text)"
    onblur="saveHufNote('${id}', this.value)"
    onkeydown="if(event.key==='Enter'){this.blur()}if(event.key==='Escape'){renderTab()}">`;
  display.querySelector('input')?.focus();
}

async function saveHufNote(id, notes) {
  await fetch(`/api/huf_transfers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  });
  const t = (state.huf_transfers || []).find(x => x.id === id);
  if (t) t.notes = notes;
  renderTab();
}

// parse comma-formatted Indian rupee strings → number
function parseRupees(s) {
  if (!s) return 0;
  // Strip ₹ symbol, commas, and leading/trailing whitespace before parsing
  const cleaned = String(s).replace(/₹/g, '').replace(/,/g, '').trim();
  return parseFloat(cleaned) || 0;
}

// Close modals on backdrop click
['modal','wl-modal','us-wl-modal'].forEach(id => {
  document.getElementById(id).addEventListener('click', function(e) {
    if (e.target === this) this.classList.add('hidden');
  });
});

init();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/static/sw.js');
}
