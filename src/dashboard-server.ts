/**
 * Phase 30C: Lightweight HTTP dashboard for multi-strategy bot monitoring.
 *
 * Reads runtime-status.json and serves a self-contained single-page dashboard.
 * No external dependencies — uses Node's built-in http module.
 *
 * Enable via: DASHBOARD_ENABLED=true, DASHBOARD_PORT=3847
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { logger } from './logger.js';
import { getRuntimeStatusPath, type RuntimeStatusSnapshot } from './runtime-status.js';
import type { AppConfig } from './config.js';

export interface DashboardConfig {
  readonly enabled: boolean;
  readonly port: number;
  readonly host: string;
}

let server: ReturnType<typeof createServer> | null = null;
let runtimeConfig: AppConfig | null = null;

export function startDashboard(config: AppConfig, dashboardConfig: DashboardConfig): void {
  if (!dashboardConfig.enabled) return;
  runtimeConfig = config;

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.url === '/api/status') {
        serveApiStatus(res);
      } else {
        serveDashboardHtml(res);
      }
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  });

  server.listen(dashboardConfig.port, dashboardConfig.host, () => {
    logger.info(`Dashboard started at http://${dashboardConfig.host}:${dashboardConfig.port}`, {
      port: dashboardConfig.port,
    });
  });

  server.on('error', (error: Error) => {
    logger.warn('Dashboard server error', { message: error.message });
  });
}

export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
    logger.info('Dashboard stopped');
  }
}

function serveApiStatus(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });

  try {
    const statusPath = getRuntimeStatusPath(runtimeConfig ?? undefined);
    const raw = readFileSync(statusPath, 'utf8');
    res.end(raw);
  } catch {
    res.end(JSON.stringify({ error: 'Status file not available' }));
  }
}

function serveDashboardHtml(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(DASHBOARD_HTML);
}

// ─── Embedded HTML Dashboard ─────────────────────────────────────
const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Polymarket HFT Scalper — Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --green: #3fb950;
    --red: #f85149; --yellow: #d29922; --blue: #58a6ff;
    --purple: #bc8cff; --cyan: #39d2c0;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    background: var(--bg); color: var(--text); font-size: 13px;
    line-height: 1.5; padding: 16px; max-width: 1400px; margin: 0 auto;
  }
  h1 { font-size: 18px; color: var(--blue); margin-bottom: 4px; }
  h2 { font-size: 14px; color: var(--muted); margin: 16px 0 8px; text-transform: uppercase; letter-spacing: 1px; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .header-right { color: var(--muted); font-size: 11px; }
  .status-badge {
    display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px;
  }
  .badge-ok { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-paused { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .badge-off { background: rgba(139,148,158,0.15); color: var(--muted); }

  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .kpi {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px; text-align: center;
  }
  .kpi-value { font-size: 22px; font-weight: 700; }
  .kpi-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
  .positive { color: var(--green); }
  .negative { color: var(--red); }
  .neutral { color: var(--muted); }

  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px; margin-bottom: 12px; overflow-x: auto;
  }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 6px 8px; border-bottom: 1px solid rgba(48,54,61,0.5); font-size: 12px; white-space: nowrap; }
  tr:hover { background: rgba(88,166,255,0.04); }

  .layers-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; }
  .layer-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px; display: flex; flex-direction: column; gap: 4px;
  }
  .layer-header { display: flex; justify-content: space-between; align-items: center; }
  .layer-name { font-weight: 700; font-size: 13px; }
  .layer-stat { display: flex; justify-content: space-between; font-size: 11px; }
  .layer-stat-label { color: var(--muted); }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } }

  .signal-list { max-height: 280px; overflow-y: auto; }
  .signal-item { padding: 4px 0; border-bottom: 1px solid rgba(48,54,61,0.3); font-size: 11px; display: flex; gap: 8px; align-items: center; }
  .signal-time { color: var(--muted); min-width: 70px; }
  .signal-type { font-weight: 600; min-width: 160px; }
  .signal-action-BUY { color: var(--green); }
  .signal-action-SELL { color: var(--red); }

  .obi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; }
  .obi-stat { text-align: center; }
  .obi-stat-value { font-size: 18px; font-weight: 700; }
  .obi-stat-label { font-size: 10px; color: var(--muted); }

  .sniper-rejections { display: flex; flex-wrap: wrap; gap: 4px; }
  .rejection-tag { padding: 2px 6px; border-radius: 4px; font-size: 10px; background: rgba(139,148,158,0.1); color: var(--muted); }

  .pulse { animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

  .no-data { color: var(--muted); font-style: italic; padding: 20px; text-align: center; }

  .exposure-bar { height: 6px; border-radius: 3px; background: var(--border); margin-top: 4px; overflow: hidden; }
  .exposure-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>🤖 Polymarket HFT Scalper</h1>
    <span id="mode" class="status-badge badge-ok">—</span>
    <span id="system-status" class="status-badge badge-ok">—</span>
  </div>
  <div class="header-right">
    <span id="updated-at" class="pulse">Loading…</span>
    <br>Auto-refresh: 3s
  </div>
</div>

<!-- KPI Row -->
<div class="kpi-grid" id="kpi-grid"></div>

<!-- Strategy Layers -->
<h2>Strategy Layers</h2>
<div class="layers-grid" id="layers-grid"></div>

<!-- Two-column: Positions + Signals -->
<div class="two-col">
  <div>
    <h2>Open Positions</h2>
    <div class="card" id="positions-card">
      <div class="no-data">No positions</div>
    </div>
  </div>
  <div>
    <h2>Recent Signals</h2>
    <div class="card">
      <div class="signal-list" id="signals-list">
        <div class="no-data">No signals</div>
      </div>
    </div>
  </div>
</div>

<!-- Two-column: OBI Stats + Sniper Stats -->
<div class="two-col">
  <div>
    <h2>OBI Engine</h2>
    <div class="card" id="obi-card">
      <div class="no-data">OBI disabled</div>
    </div>
  </div>
  <div>
    <h2>Sniper Engine</h2>
    <div class="card" id="sniper-card">
      <div class="no-data">Sniper disabled</div>
    </div>
  </div>
</div>

<!-- Global Exposure -->
<h2>Global Exposure</h2>
<div class="card" id="exposure-card"></div>

<!-- Skipped Signals -->
<h2>Recent Skipped Signals</h2>
<div class="card">
  <div class="signal-list" id="skipped-list">
    <div class="no-data">None</div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
const pnlClass = v => v > 0.005 ? 'positive' : v < -0.005 ? 'negative' : 'neutral';
const fmt = (v, d=2) => v != null ? Number(v).toFixed(d) : '—';
const fmtUsd = v => v != null ? '$' + Number(v).toFixed(2) : '—';
const fmtPct = v => v != null ? (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(2) + '%' : '—';
const fmtTime = iso => { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleTimeString(); };
const fmtShort = iso => { if (!iso) return '—'; return new Date(iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}); };

function renderKPIs(s) {
  const winRate = s.obiStats
    ? (s.obiStats.entries > 0 ? ((s.obiStats.wins / Math.max(1, s.obiStats.wins + s.obiStats.losses)) * 100).toFixed(0) + '%' : '—')
    : '—';
  const kpis = [
    { label: 'Portfolio', value: fmtUsd(s.portfolioValueUsd), cls: '' },
    { label: 'Wallet Cash', value: fmtUsd(s.walletCashUsd), cls: '' },
    { label: 'Day PnL', value: fmtUsd(s.totalDayPnl), cls: pnlClass(s.totalDayPnl) },
    { label: 'Drawdown', value: fmtUsd(s.dayDrawdown), cls: s.dayDrawdown < -0.5 ? 'negative' : 'neutral' },
    { label: 'Redeem PnL', value: fmtUsd(s.redeemPnlToday), cls: pnlClass(s.redeemPnlToday) },
    { label: 'Positions', value: s.openPositionsCount ?? 0, cls: '' },
    { label: 'Active Slots', value: s.activeSlotsCount ?? 0, cls: '' },
    { label: 'OBI Win Rate', value: winRate, cls: '' },
    { label: 'Avg Latency', value: s.averageLatencyMs != null ? fmt(s.averageLatencyMs, 0) + 'ms' : '—', cls: '' },
  ];

  $('kpi-grid').innerHTML = kpis.map(k =>
    '<div class="kpi"><div class="kpi-value ' + k.cls + '">' + k.value + '</div><div class="kpi-label">' + k.label + '</div></div>'
  ).join('');
}

function renderLayers(s) {
  const layers = s.strategyLayers || [];
  if (!layers.length) { $('layers-grid').innerHTML = '<div class="no-data">No layers</div>'; return; }

  $('layers-grid').innerHTML = layers.map(l => {
    const badgeCls = l.status === 'ACTIVE' ? 'badge-ok' : l.status === 'WATCHING' ? 'badge-paused' : 'badge-off';
    const layerColors = { SNIPER: 'var(--blue)', MM_QUOTE: 'var(--purple)', OBI: 'var(--cyan)', LOTTERY: 'var(--yellow)', PAIRED_ARB: 'var(--green)' };
    const color = layerColors[l.layer] || 'var(--muted)';
    return '<div class="layer-card">' +
      '<div class="layer-header"><span class="layer-name" style="color:' + color + '">' + l.layer + '</span>' +
      '<span class="status-badge ' + badgeCls + '">' + l.status + '</span></div>' +
      '<div class="layer-stat"><span class="layer-stat-label">Positions</span><span>' + l.positionCount + '</span></div>' +
      '<div class="layer-stat"><span class="layer-stat-label">Markets</span><span>' + l.marketCount + '</span></div>' +
      '<div class="layer-stat"><span class="layer-stat-label">Exposure</span><span>' + fmtUsd(l.exposureUsd) + '</span></div>' +
      '<div class="layer-stat"><span class="layer-stat-label">PnL</span><span class="' + pnlClass(l.pnlUsd) + '">' + fmtUsd(l.pnlUsd) + '</span></div>' +
    '</div>';
  }).join('');
}

function renderPositions(s) {
  const pos = s.openPositions || [];
  if (!pos.length) { $('positions-card').innerHTML = '<div class="no-data">No open positions</div>'; return; }

  let html = '<table><thead><tr><th>Market</th><th>YES</th><th>NO</th><th>Value</th><th>uPnL</th><th>ROI</th></tr></thead><tbody>';
  for (const p of pos) {
    const title = (p.title || '').substring(0, 30);
    html += '<tr>' +
      '<td title="' + (p.title||'') + '">' + title + '</td>' +
      '<td>' + fmt(p.yesShares, 1) + '</td>' +
      '<td>' + fmt(p.noShares, 1) + '</td>' +
      '<td>' + fmtUsd(p.markValueUsd) + '</td>' +
      '<td class="' + pnlClass(p.unrealizedPnl) + '">' + fmtUsd(p.unrealizedPnl) + '</td>' +
      '<td class="' + pnlClass(p.roiPct) + '">' + fmtPct(p.roiPct) + '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  $('positions-card').innerHTML = html;
}

function renderSignals(s) {
  const signals = s.lastSignals || [];
  if (!signals.length) { $('signals-list').innerHTML = '<div class="no-data">No recent signals</div>'; return; }

  $('signals-list').innerHTML = signals.slice(0, 20).map(sig =>
    '<div class="signal-item">' +
      '<span class="signal-time">' + fmtShort(sig.timestamp) + '</span>' +
      '<span class="signal-type">' + sig.signalType + '</span>' +
      '<span class="signal-action-' + sig.action + '">' + sig.action + ' ' + sig.outcome + '</span>' +
      '<span class="neutral">' + sig.strategyLayer + '</span>' +
      (sig.latencyMs != null ? '<span class="neutral">' + sig.latencyMs + 'ms</span>' : '') +
    '</div>'
  ).join('');
}

function renderObi(s) {
  const obi = s.obiStats;
  if (!obi || !obi.enabled) { $('obi-card').innerHTML = '<div class="no-data">OBI disabled</div>'; return; }

  const wr = obi.wins + obi.losses > 0
    ? ((obi.wins / (obi.wins + obi.losses)) * 100).toFixed(1) + '%'
    : '—';

  let html = '<div class="obi-grid">' +
    stat(obi.entries, 'Entries') + stat(obi.exits, 'Exits') +
    stat(obi.wins, 'Wins', 'positive') + stat(obi.losses, 'Losses', 'negative') +
    stat(wr, 'Win Rate') +
    stat(fmtUsd(obi.realizedPnl), 'PnL', pnlClass(obi.realizedPnl)) +
    stat(obi.redeems, 'Redeems') +
    stat(fmt(obi.passRate * 100, 0) + '%', 'Pass Rate') +
  '</div>';

  // Coin stats
  const coins = Object.values(obi.coinStats || {});
  if (coins.length) {
    html += '<h2 style="margin-top:10px">Coins</h2><table><thead><tr><th>Coin</th><th>Entries</th><th>Exits</th><th>PnL</th><th>Last</th></tr></thead><tbody>';
    for (const c of coins) {
      html += '<tr><td>' + c.coin + '</td><td>' + c.entries + '</td><td>' + c.exits + '</td>' +
        '<td class="' + pnlClass(c.realizedPnl) + '">' + fmtUsd(c.realizedPnl) + '</td>' +
        '<td>' + (c.lastAction || '—') + '</td></tr>';
    }
    html += '</tbody></table>';
  }

  $('obi-card').innerHTML = html;
}

function stat(value, label, cls) {
  return '<div class="obi-stat"><div class="obi-stat-value ' + (cls||'') + '">' + value + '</div><div class="obi-stat-label">' + label + '</div></div>';
}

function renderSniper(s) {
  const sn = s.sniperStats;
  if (!sn || !sn.enabled) { $('sniper-card').innerHTML = '<div class="no-data">Sniper disabled</div>'; return; }

  let html = '<div class="obi-grid">' +
    stat(sn.signalsGenerated, 'Generated') + stat(sn.signalsExecuted, 'Executed') +
    stat(sn.totalRejections, 'Rejections') + stat(sn.nearMissCount, 'Near Miss') +
    stat(fmt(sn.bestEdgeSeen * 100, 1) + '%', 'Best Edge') +
    stat(sn.avgBinanceMove != null ? fmt(sn.avgBinanceMove * 100, 2) + '%' : '—', 'Avg Move') +
  '</div>';

  // Rejection breakdown
  const rej = sn.rejections || {};
  const rejEntries = Object.entries(rej).filter(([,v]) => v > 0).sort((a,b) => b[1] - a[1]);
  if (rejEntries.length) {
    html += '<div style="margin-top:8px"><span style="color:var(--muted);font-size:10px">REJECTIONS:</span><div class="sniper-rejections" style="margin-top:4px">';
    for (const [reason, count] of rejEntries) {
      html += '<span class="rejection-tag">' + reason + ': ' + count + '</span>';
    }
    html += '</div></div>';
  }

  // Direction window
  if (sn.currentDirectionWindow) {
    const dw = sn.currentDirectionWindow;
    html += '<div style="margin-top:8px;font-size:11px;color:var(--muted)">' +
      'Direction: <strong style="color:var(--text)">' + (dw.direction || 'NONE') + '</strong> | ' +
      'Coins: ' + (dw.activeCoins.length ? dw.activeCoins.join(', ') : '—') + ' | ' +
      'Capacity: ' + dw.capacity + '</div>';
  }

  $('sniper-card').innerHTML = html;
}

function renderExposure(s) {
  const ge = s.globalExposure;
  if (!ge) { $('exposure-card').innerHTML = '<div class="no-data">—</div>'; return; }

  const layers = [
    { name: 'Sniper', usd: ge.sniperUsd, color: 'var(--blue)' },
    { name: 'MM Quote', usd: ge.mmUsd, color: 'var(--purple)' },
    { name: 'OBI', usd: ge.obiUsd, color: 'var(--cyan)' },
    { name: 'Lottery', usd: ge.lotteryUsd, color: 'var(--yellow)' },
    { name: 'Paired Arb', usd: ge.pairedArbUsd, color: 'var(--green)' },
  ];
  const maxUsd = ge.maxUsd || 1;

  let html = '<div style="display:flex;justify-content:space-between;margin-bottom:8px">' +
    '<span>Total: <strong class="' + (ge.totalUsd > ge.maxUsd * 0.9 ? 'negative' : '') + '">' + fmtUsd(ge.totalUsd) + '</strong></span>' +
    '<span class="neutral">Max: ' + fmtUsd(ge.maxUsd) + '</span></div>';

  for (const l of layers) {
    const pct = Math.min(100, (l.usd / maxUsd) * 100);
    html += '<div style="margin-bottom:6px">' +
      '<div style="display:flex;justify-content:space-between;font-size:11px"><span style="color:' + l.color + '">' + l.name + '</span><span>' + fmtUsd(l.usd) + '</span></div>' +
      '<div class="exposure-bar"><div class="exposure-fill" style="width:' + pct + '%;background:' + l.color + '"></div></div>' +
    '</div>';
  }

  $('exposure-card').innerHTML = html;
}

function renderSkipped(s) {
  const skipped = s.recentSkippedSignals || [];
  if (!skipped.length) { $('skipped-list').innerHTML = '<div class="no-data">None recently</div>'; return; }

  $('skipped-list').innerHTML = skipped.slice(0, 15).map(sk =>
    '<div class="signal-item">' +
      '<span class="signal-time">' + fmtShort(sk.timestamp) + '</span>' +
      '<span class="signal-type">' + sk.signalType + '</span>' +
      '<span class="neutral">' + sk.outcome + '</span>' +
      '<span style="color:var(--yellow)">' + sk.filterReason + '</span>' +
      '<span class="neutral" style="font-size:10px">' + (sk.details||'').substring(0,60) + '</span>' +
    '</div>'
  ).join('');
}

function renderAll(s) {
  // Mode badge
  const modeEl = $('mode');
  modeEl.textContent = s.mode || 'unknown';
  modeEl.className = 'status-badge ' + (s.mode === 'production' ? 'badge-ok' : 'badge-paused');

  // System status
  const statusEl = $('system-status');
  statusEl.textContent = s.systemStatus || '—';
  statusEl.className = 'status-badge ' + (s.isPaused ? 'badge-paused' : 'badge-ok');

  $('updated-at').textContent = 'Updated: ' + fmtTime(s.updatedAt);
  $('updated-at').className = '';

  renderKPIs(s);
  renderLayers(s);
  renderPositions(s);
  renderSignals(s);
  renderObi(s);
  renderSniper(s);
  renderExposure(s);
  renderSkipped(s);
}

async function fetchStatus() {
  try {
    const resp = await fetch('/api/status');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (data.error) { $('updated-at').textContent = data.error; return; }
    renderAll(data);
  } catch (e) {
    $('updated-at').textContent = 'Fetch error: ' + e.message;
    $('updated-at').className = 'pulse';
  }
}

// Initial fetch + auto-refresh
fetchStatus();
setInterval(fetchStatus, 3000);
</script>
</body>
</html>`;
