import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { Command } from 'commander';
import { createConfig, type AppConfig } from '../src/config.js';
import {
  clearDayPnlStateFile,
  getDayPnlState,
  resetDayPnlState,
  resetDayPnlStateCache,
} from '../src/day-pnl-state.js';
import {
  readRuntimeStatus,
  resetRuntimeStatus,
  resolveRuntimeMode,
  writeRuntimeStatus,
  type RuntimeMarketSnapshot,
  type RuntimeMode,
  type RuntimePositionSnapshot,
  type RuntimeStatusSnapshot,
} from '../src/runtime-status.js';
import { checkPolymarketStatus, writeStatusControlCommand } from '../src/status-monitor.js';
import { resetSlotReporterState } from '../src/slot-reporter.js';
import { roundTo, sleep } from '../src/utils.js';
import {
  applyEnvUpdatesToText,
  buildModeOverrides,
  collectTodayResetTargets,
  type CliMode,
} from './helpers.js';

interface EnvDocument {
  readonly envPath: string;
  readonly seedText: string;
  readonly runtimeConfig: AppConfig;
}

interface Pm2ProcessInfo {
  readonly exists: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly status: string | null;
}

interface BotInspection {
  readonly running: boolean;
  readonly pid: number | null;
  readonly manager: 'pm2' | 'nohup' | 'detached' | 'unknown' | null;
  readonly runtimeStatus: RuntimeStatusSnapshot | null;
  readonly mode: RuntimeMode;
}

const PROCESS_NAME = 'polymarket-scalper';
const PID_FILE_NAME = `${PROCESS_NAME}.pid`;
const RUNTIME_READY_TIMEOUT_MS = 12_000;
const DASHBOARD_REFRESH_MS = 2_000;

async function resetCommand(): Promise<void> {
  const document = loadEnvDocument();
  await stopBot(document.runtimeConfig, { quiet: true });

  const removed = deleteFiles(collectTodayResetTargets(document.runtimeConfig));
  resetSlotReporterState();
  resetDayPnlStateCache();
  clearDayPnlStateFile(document.runtimeConfig);
  const freshState = resetDayPnlState(new Date(), document.runtimeConfig);
  resetRuntimeStatus(document.runtimeConfig);
  writeRuntimeStatus(
    {
      running: false,
      pid: null,
      activeSlotsCount: 0,
      totalDayPnl: freshState.dayPnl,
      dayDrawdown: freshState.drawdown,
      averageLatencyMs: null,
      lastSignals: [],
      lastSlotReport: null,
    },
    document.runtimeConfig
  );

  console.log(
    `${color.green('Reset complete.')} Removed ${removed} file(s). Day PnL, drawdown, runtime status, and slot caches were reset to zero.`
  );
}

async function switchCommand(mode: CliMode): Promise<void> {
  const document = loadEnvDocument();
  const overrides = buildModeOverrides(mode);
  const nextText = applyEnvUpdatesToText(document.seedText, overrides);
  writeFileSync(document.envPath, nextText, 'utf8');

  const nextDocument = loadEnvDocument();
  console.log(
    `${color.cyan('Updated .env')} for mode ${color.bold(mode)} at ${nextDocument.envPath}`
  );
  await startBot(nextDocument.runtimeConfig, true);
}

async function startCommand(): Promise<void> {
  const document = loadEnvDocument();
  await startBot(document.runtimeConfig, false);
}

async function stopCommand(): Promise<void> {
  const document = loadEnvDocument();
  const result = await stopBot(document.runtimeConfig, { quiet: false });
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn(`${color.yellow('Warning:')} ${warning}`);
    }
  }
}

async function pauseCommand(): Promise<void> {
  const document = loadEnvDocument();
  const inspection = inspectBot(document.runtimeConfig);
  if (!inspection.running) {
    console.log(color.yellow('Bot is not running; nothing to pause.'));
    return;
  }

  writeStatusControlCommand('pause', document.runtimeConfig, 'Manual pause requested from CLI');
  await waitForPauseState(document.runtimeConfig, true, 6_000);
  console.log(color.yellow('Pause command sent to polymarket-scalper.'));
  printStatus(document.runtimeConfig);
}

async function resumeCommand(): Promise<void> {
  const document = loadEnvDocument();
  const inspection = inspectBot(document.runtimeConfig);
  if (!inspection.running) {
    console.log(color.yellow('Bot is not running; nothing to resume.'));
    return;
  }

  writeStatusControlCommand('resume', document.runtimeConfig, 'Manual resume requested from CLI');
  await waitForPauseState(document.runtimeConfig, false, 6_000);
  console.log(color.green('Resume command sent to polymarket-scalper.'));
  printStatus(document.runtimeConfig);
}

async function monitorCommand(options: { watch?: boolean; refresh?: string }): Promise<void> {
  if (options.watch) {
    await dashboardCommand(options.refresh);
    return;
  }

  const status = await checkPolymarketStatus();

  console.log('');
  console.log(color.bold(color.cyan('Polymarket Status Monitor')));
  console.log(`${label('Checked at')} ${status.checkedAt}`);
  console.log(`${label('Status')} ${status.ok ? color.green('OK') : color.red('INCIDENT')}`);

  if (status.incidents.length === 0) {
    console.log(color.green('No active Polymarket incidents matched the trading-impact keywords.'));
    return;
  }

  console.table(
    status.incidents.map((incident) => ({
      Incident: incident.title,
      Updated: incident.updatedAt ?? 'n/a',
      Keywords: incident.matchedKeywords.join(', '),
    }))
  );
}

function statusCommand(): void {
  const document = loadEnvDocument();
  printStatus(document.runtimeConfig);
}

async function dashboardCommand(refreshValue?: string): Promise<void> {
  const document = loadEnvDocument();
  const refreshMs = resolveDashboardRefreshMs(refreshValue);

  if (!process.stdout.isTTY) {
    console.log(renderDashboardFrame(document.runtimeConfig));
    return;
  }

  let stopping = false;
  const handleStop = () => {
    stopping = true;
  };

  process.once('SIGINT', handleStop);
  process.once('SIGTERM', handleStop);

  try {
    while (!stopping) {
      console.clear();
      console.log(renderDashboardFrame(document.runtimeConfig));
      console.log('');
      console.log(color.dim(`Refreshing every ${refreshMs}ms. Press Ctrl+C to exit.`));
      await sleep(refreshMs);
    }
  } finally {
    process.removeListener('SIGINT', handleStop);
    process.removeListener('SIGTERM', handleStop);
    console.log('');
    console.log(color.dim('Dashboard stopped.'));
  }
}

async function startBot(runtimeConfig: AppConfig, fromSwitch: boolean): Promise<void> {
  await stopBot(runtimeConfig, { quiet: true });
  mkdirSync(path.resolve(process.cwd(), runtimeConfig.REPORTS_DIR), { recursive: true });

  let manager: 'pm2' | 'nohup' | 'detached' = 'detached';
  const npmCommand = resolveNpmCommand();
  if (commandExists('pm2')) {
    const pm2Result = spawnSync(
      'pm2',
      ['start', npmCommand, '--name', PROCESS_NAME, '--cwd', process.cwd(), '--', 'run', 'start'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      }
    );
    if (pm2Result.status !== 0) {
      throw new Error(pm2Result.stderr?.trim() || pm2Result.stdout?.trim() || 'pm2 start failed');
    }
    manager = 'pm2';
  } else {
    const child =
      process.platform !== 'win32' && commandExists('nohup')
        ? spawn('nohup', [npmCommand, 'run', 'start'], {
            cwd: process.cwd(),
            detached: true,
            stdio: 'ignore',
          })
        : spawn(npmCommand, ['run', 'start'], {
            cwd: process.cwd(),
            detached: true,
            stdio: 'ignore',
          });

    child.unref();
    if (typeof child.pid === 'number' && Number.isFinite(child.pid)) {
      writePidFile(runtimeConfig, child.pid);
    }
    manager = process.platform !== 'win32' && commandExists('nohup') ? 'nohup' : 'detached';
  }

  const ready = await waitForRuntimeReady(runtimeConfig, RUNTIME_READY_TIMEOUT_MS);
  const managerLabel = manager === 'pm2' ? 'pm2' : manager === 'nohup' ? 'nohup' : 'detached';
  console.log(
    `${color.green(fromSwitch ? 'Switched and restarted bot.' : 'Started bot.')} Manager: ${managerLabel}.`
  );
  if (!ready) {
    console.warn(
      `${color.yellow('Warning:')} runtime status did not confirm readiness within ${RUNTIME_READY_TIMEOUT_MS}ms.`
    );
  }
  printStatus(runtimeConfig);
}

async function stopBot(
  runtimeConfig: AppConfig,
  options: { quiet: boolean }
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const pm2Info = getPm2ProcessInfo();

  if (pm2Info.running || pm2Info.status !== null) {
    spawnSync('pm2', ['stop', PROCESS_NAME], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'ignore',
    });
    await sleep(500);
    spawnSync('pm2', ['delete', PROCESS_NAME], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'ignore',
    });
  }

  const runtimeStatus = readRuntimeStatus(runtimeConfig);
  const candidatePid = pm2Info.pid ?? runtimeStatus?.pid ?? readPidFile(runtimeConfig);
  if (candidatePid !== null && isPidRunning(candidatePid)) {
    try {
      process.kill(candidatePid, 'SIGTERM');
      const exited = await waitForProcessExit(candidatePid, 10_000);
      if (!exited) {
        warnings.push(`Process ${candidatePid} ignored SIGTERM; forcing termination.`);
        process.kill(candidatePid, 'SIGKILL');
        await waitForProcessExit(candidatePid, 2_000);
      }
    } catch (error) {
      warnings.push(`Could not terminate PID ${candidatePid}: ${String(error)}`);
    }
  }

  removePidFile(runtimeConfig);
  writeRuntimeStatus(
    {
      running: false,
      pid: null,
      isPaused: false,
      systemStatus: 'OK',
      pauseReason: null,
      pauseSource: null,
      activeSlotsCount: 0,
      openPositionsCount: 0,
      activeMarkets: [],
      openPositions: [],
    },
    runtimeConfig
  );

  if (!options.quiet) {
    console.log(color.green('Stopped polymarket-scalper process(es).'));
  }

  return { warnings };
}

function printStatus(runtimeConfig: AppConfig): void {
  const inspection = inspectBot(runtimeConfig);
  const runtimeStatus = inspection.runtimeStatus;
  const dayState = getDayPnlState(new Date(), runtimeConfig);
  const totalDayPnl = runtimeStatus?.totalDayPnl ?? dayState.dayPnl;
  const drawdown = runtimeStatus?.dayDrawdown ?? dayState.drawdown;

  console.log('');
  console.log(color.bold(color.cyan('Polymarket Scalper Status')));
  console.log(`${label('Running')} ${inspection.running ? color.green('yes') : color.red('no')}`);
  console.log(
    `${label('PID')} ${inspection.pid !== null ? color.bold(String(inspection.pid)) : color.dim('n/a')}`
  );
  console.log(`${label('Mode')} ${formatModeLabel(inspection.mode)}`);
  console.log(
    `${label('Status')} ${
      runtimeStatus?.isPaused
        ? color.red(`PAUSED (${runtimeStatus.pauseReason ?? 'manual'})`)
        : color.green('OK')
    }`
  );
  console.log(`${label('Manager')} ${inspection.manager ?? 'n/a'}`);
  console.log(`${label('Day PnL')} ${formatSignedCurrency(totalDayPnl)}`);
  console.log(`${label('Drawdown')} ${formatSignedCurrency(drawdown)}`);
  console.log(`${label('Active slots')} ${String(runtimeStatus?.activeSlotsCount ?? 0)}`);
  console.log(
    `${label('Avg latency')} ${
      runtimeStatus?.averageLatencyMs !== null && runtimeStatus?.averageLatencyMs !== undefined
        ? `${runtimeStatus.averageLatencyMs.toFixed(0)}ms`
        : 'n/a'
    }`
  );
  console.log(
    `${label('Latency gate')} ${
      runtimeStatus?.latencyPaused
        ? color.yellow(
            `ON (${runtimeStatus.latencyPauseAverageMs?.toFixed(0) ?? 'n/a'}ms rolling avg)`
          )
        : color.green('OFF')
    }`
  );

  if (runtimeStatus?.lastSlotReport) {
    console.log('');
    console.log(color.bold('Last Slot Report'));
    console.table([
      {
        Slot: runtimeStatus.lastSlotReport.slotLabel,
        Market: `${runtimeStatus.lastSlotReport.marketId.slice(0, 12)}...`,
        Entries: runtimeStatus.lastSlotReport.entries,
        Fills: runtimeStatus.lastSlotReport.fills,
        'Up PnL': formatSignedCurrency(runtimeStatus.lastSlotReport.upPnl),
        'Down PnL': formatSignedCurrency(runtimeStatus.lastSlotReport.downPnl),
        'Net PnL': formatSignedCurrency(runtimeStatus.lastSlotReport.netPnl),
        Reported: runtimeStatus.lastSlotReport.reportedAt,
      },
    ]);
  }

  if (runtimeStatus?.lastSignals.length) {
    console.log(color.bold('Last 3 Signals'));
    console.table(
      [...runtimeStatus.lastSignals]
        .slice()
        .reverse()
        .map((signal) => ({
          Timestamp: signal.timestamp,
          Market: `${signal.marketId.slice(0, 12)}...`,
          Signal: signal.signalType,
          Side: signal.action,
          Outcome: signal.outcome,
          Latency: signal.latencyMs !== null ? `${signal.latencyMs.toFixed(0)}ms` : 'n/a',
        }))
    );
  } else {
    console.log('');
    console.log(color.dim('No recent signals recorded yet.'));
  }
}

function renderDashboardFrame(runtimeConfig: AppConfig): string {
  const inspection = inspectBot(runtimeConfig);
  const runtimeStatus = inspection.runtimeStatus;
  const now = formatDashboardTimestamp(new Date());
  const statusLabel = runtimeStatus?.isPaused
    ? color.red(`PAUSED - ${runtimeStatus.pauseReason ?? 'manual'}`)
    : color.green('OK');

  const lines = [
    renderBanner(
      'POLYMARKET SCALPER  |  LIVE RUNTIME DASHBOARD',
      color.dim('5-minute slots  •  dual-sided market-maker  •  real-time monitor')
    ),
    renderInfoBar([
      ['time', now],
      ['mode', stripAnsi(formatModeLabel(inspection.mode))],
      ['status', stripAnsi(statusLabel)],
      ['process', inspection.runtimeStatus?.pid ? `pid ${inspection.runtimeStatus.pid}` : 'n/a'],
      ['manager', inspection.manager ?? 'n/a'],
    ]),
  ];

  if (runtimeStatus?.isPaused) {
    lines.push('');
    lines.push(color.red(color.bold('BOT PAUSED - Polymarket status issue or manual pause')));
  }

  if (runtimeStatus?.latencyPaused) {
    lines.push('');
    lines.push(
      color.yellow(
        color.bold(
          `ENTRY GATE ACTIVE - latency rolling avg ${runtimeStatus.latencyPauseAverageMs?.toFixed(0) ?? 'n/a'}ms`
        )
      )
    );
  }

  lines.push('');
  lines.push(
    renderSection(
      'ACTIVE MARKETS  -  SCANNING LIVE SIGNALS',
      renderActiveMarkets(runtimeStatus?.activeMarkets ?? [])
    )
  );
  lines.push('');
  lines.push(
    renderSection(
      'LIVE POSITIONS  -  OPEN INVENTORY NOW',
      renderOpenPositions(runtimeStatus?.openPositions ?? [])
    )
  );
  lines.push('');
  lines.push(
    renderSection(
      'BOT PERFORMANCE STATS',
      renderPerformance(inspection, runtimeStatus, runtimeConfig)
    )
  );
  lines.push('');
  lines.push(
    renderSection(
      'RECENT SIGNALS',
      renderRecentSignals(runtimeStatus?.lastSignals ?? [])
    )
  );

  return lines.join('\n');
}

function renderBanner(title: string, subtitle: string): string {
  const width = 92;
  const normalizedSubtitle = stripAnsi(subtitle)
    .replaceAll('вЂў', '|')
    .replaceAll('•', '|');
  const top = `+${'-'.repeat(width - 2)}+`;
  const middle = `| ${color.cyan(color.bold(title.padEnd(width - 4, ' ')))} |`;
  const subtitleLine = `| ${normalizedSubtitle.padEnd(width - 4, ' ')} |`;
  const bottom = `+${'-'.repeat(width - 2)}+`;
  return [top, middle, subtitleLine, bottom].join('\n');
}

function renderInfoBar(entries: Array<readonly [string, string]>): string {
  const rendered = entries
    .map(([key, value]) => `${color.dim(`${key}`)} ${color.bold(value)}`)
    .join('   ');
  return rendered;
}

function renderSection(title: string, body: string): string {
  const heading = color.yellow(color.bold(`== ${title} ==`));
  return [heading, body].join('\n');
}

function renderActiveMarkets(markets: readonly RuntimeMarketSnapshot[]): string {
  if (markets.length === 0) {
    return color.dim('No active markets in the current runtime snapshot.');
  }

  return renderTable(
    ['MARKET', 'PM UP', 'PM DOWN', 'BINANCE', 'DISC', 'ACTION'],
    [28, 8, 8, 14, 8, 14],
    markets.map((market) => [
      truncateDashboardLabel(buildMarketLabel(market), 28),
      formatMidPrice(market.pmUpMid),
      formatMidPrice(market.pmDownMid),
      formatBinanceMove(market.binanceMovePct, market.binanceDirection),
      formatDiscount(market.combinedDiscount),
      colorizeAction(market.action, market.signalCount),
    ])
  );
}

function renderOpenPositions(positions: readonly RuntimePositionSnapshot[]): string {
  if (positions.length === 0) {
    return color.dim('No live inventory open right now.');
  }

  return renderTable(
    ['POSITION', 'YES', 'NO', 'VALUE', 'UNRL P&L', 'TOTAL', 'ROI'],
    [28, 8, 8, 11, 11, 11, 8],
    positions.map((position) => [
      truncateDashboardLabel(buildPositionLabel(position), 28),
      formatShares(position.yesShares),
      formatShares(position.noShares),
      formatPlainCurrency(position.markValueUsd),
      formatSignedCurrency(position.unrealizedPnl),
      formatSignedCurrency(position.totalPnl),
      position.roiPct !== null ? colorizeSignedPercent(position.roiPct) : color.dim('n/a'),
    ])
  );
}

function renderPerformance(
  inspection: BotInspection,
  runtimeStatus: RuntimeStatusSnapshot | null,
  runtimeConfig: AppConfig
): string {
  const dayState = getDayPnlState(new Date(), runtimeConfig);
  const totalDayPnl = runtimeStatus?.totalDayPnl ?? dayState.dayPnl;
  const drawdown = runtimeStatus?.dayDrawdown ?? dayState.drawdown;
  const activeSlots = runtimeStatus?.activeSlotsCount ?? 0;
  const openPositions = runtimeStatus?.openPositionsCount ?? 0;
  const averageLatency =
    runtimeStatus?.averageLatencyMs !== null && runtimeStatus?.averageLatencyMs !== undefined
      ? `${runtimeStatus.averageLatencyMs.toFixed(0)}ms`
      : 'n/a';
  const latencyGate = runtimeStatus?.latencyPaused
    ? color.yellow(
        `ON (${runtimeStatus.latencyPauseAverageMs?.toFixed(0) ?? 'n/a'}ms)`
      )
    : color.green('OFF');
  const lastSlotNet = runtimeStatus?.lastSlotReport
    ? formatSignedCurrency(runtimeStatus.lastSlotReport.netPnl)
    : color.dim('n/a');
  const lastSlotLabel = runtimeStatus?.lastSlotReport?.slotLabel
    ? truncateDashboardLabel(runtimeStatus.lastSlotReport.slotLabel, 32)
    : 'n/a';

  return renderTable(
    ['METRIC', 'VALUE', 'METRIC', 'VALUE'],
    [20, 18, 20, 28],
    [
      ['Running', inspection.running ? color.green('YES') : color.red('NO'), 'Mode', formatModeLabel(inspection.mode)],
      ['Day PnL', formatSignedCurrency(totalDayPnl), 'Drawdown', formatSignedCurrency(drawdown)],
      ['Active slots', color.bold(String(activeSlots)), 'Open positions', color.bold(String(openPositions))],
      ['Avg latency', color.bold(averageLatency), 'Latency gate', latencyGate],
      ['Manager', color.bold(inspection.manager ?? 'n/a'), 'Status', runtimeStatus?.isPaused ? color.red('PAUSED') : color.green('OK')],
      ['Last slot', lastSlotNet, 'Slot label', lastSlotLabel],
    ]
  );
}

function renderRecentSignals(signals: RuntimeStatusSnapshot['lastSignals']): string {
  if (signals.length === 0) {
    return color.dim('No recent signals recorded yet.');
  }

  return renderTable(
    ['TIME', 'MARKET', 'SIGNAL', 'SIDE', 'OUT', 'LAT'],
    [20, 18, 20, 8, 6, 8],
    [...signals]
      .slice()
      .reverse()
      .map((signal) => [
        formatSignalTimestamp(signal.timestamp),
        truncateDashboardLabel(signal.marketId, 18),
        truncateDashboardLabel(signal.signalType, 20),
        signal.action,
        signal.outcome,
        signal.latencyMs !== null ? `${signal.latencyMs.toFixed(0)}ms` : 'n/a',
      ])
  );
}

function renderTable(headers: string[], widths: number[], rows: string[][]): string {
  const headerLine = headers
    .map((header, index) => padTableCell(color.bold(header), widths[index] ?? header.length))
    .join('  ');
  const separator = widths.map((width) => color.dim('-'.repeat(width))).join('  ');
  const body = rows.map((row) =>
    row.map((cell, index) => padTableCell(cell, widths[index] ?? String(cell).length)).join('  ')
  );

  return [headerLine, separator, ...body].join('\n');
}

function padTableCell(value: string, width: number): string {
  const visible = stripAnsi(value);
  if (visible.length >= width) {
    return `${value}${' '.repeat(Math.max(0, width - visible.length))}`;
  }
  return `${value}${' '.repeat(width - visible.length)}`;
}

function buildMarketLabel(market: RuntimeMarketSnapshot): string {
  const coin = market.coin ?? 'Market';
  const slot = formatSlotWindow(market.slotStart, market.slotEnd);
  return slot ? `${coin} ${slot}` : market.title;
}

function buildPositionLabel(position: RuntimePositionSnapshot): string {
  const slot = formatSlotWindow(position.slotStart, position.slotEnd);
  return slot ? `${truncateDashboardLabel(position.title, 18)} ${slot}` : position.title;
}

function formatSlotWindow(start: string | null, end: string | null): string {
  const startDate = parseFiniteDate(start);
  const endDate = parseFiniteDate(end);
  if (!startDate || !endDate) {
    return '';
  }
  return `${formatClock(startDate)}-${formatClock(endDate)}`;
}

function parseFiniteDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatClock(value: Date): string {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

function formatMidPrice(value: number | null): string {
  if (value === null) {
    return color.dim('n/a');
  }
  return `${roundTo(value * 100, 1).toFixed(1)}c`;
}

function formatDiscount(value: number | null): string {
  if (value === null) {
    return color.dim('n/a');
  }
  return colorizeSignedCents(roundTo(value * 100, 2));
}

function formatBinanceMove(
  value: number | null,
  direction: RuntimeMarketSnapshot['binanceDirection']
): string {
  if (value === null || !direction) {
    return color.dim('n/a');
  }
  const rendered = `${value >= 0 ? '+' : ''}${value.toFixed(2)}% ${direction}`;
  if (direction === 'UP') {
    return color.green(rendered);
  }
  if (direction === 'DOWN') {
    return color.red(rendered);
  }
  return color.dim(rendered);
}

function colorizeAction(action: string, signalCount: number): string {
  const rendered = signalCount > 0 ? `${action} [${signalCount}]` : action;
  if (action.startsWith('ENTER')) {
    return color.green(rendered);
  }
  if (action.startsWith('EXIT')) {
    return color.yellow(rendered);
  }
  if (action === 'PAUSED') {
    return color.red(rendered);
  }
  if (action === 'MONITOR') {
    return color.cyan(rendered);
  }
  return color.dim(rendered);
}

function formatShares(value: number): string {
  return value > 0 ? color.bold(roundTo(value, 2).toFixed(2)) : color.dim('0.00');
}

function formatPlainCurrency(value: number): string {
  return color.bold(`$${roundTo(value, 2).toFixed(2)}`);
}

function colorizeSignedPercent(value: number): string {
  const rendered = `${value >= 0 ? '+' : ''}${roundTo(value, 2).toFixed(2)}%`;
  if (value > 0) {
    return color.green(rendered);
  }
  if (value < 0) {
    return color.red(rendered);
  }
  return color.dim(rendered);
}

function colorizeSignedCents(value: number): string {
  const rendered = `${value >= 0 ? '+' : ''}${roundTo(value, 2).toFixed(2)}c`;
  if (value > 0) {
    return color.green(rendered);
  }
  if (value < 0) {
    return color.red(rendered);
  }
  return color.dim(rendered);
}

function formatSignalTimestamp(value: string): string {
  const parsed = parseFiniteDate(value);
  if (!parsed) {
    return value;
  }
  return formatDashboardTimestamp(parsed);
}

function formatDashboardTimestamp(value: Date): string {
  const date = [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
  const time = [
    String(value.getHours()).padStart(2, '0'),
    String(value.getMinutes()).padStart(2, '0'),
    String(value.getSeconds()).padStart(2, '0'),
  ].join(':');
  return `${date} ${time}`;
}

function resolveDashboardRefreshMs(value: string | undefined): number {
  if (!value) {
    return DASHBOARD_REFRESH_MS;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 500) {
    return DASHBOARD_REFRESH_MS;
  }

  return parsed;
}

function truncateDashboardLabel(value: string, maxLength: number): string {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 3))}...`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function inspectBot(runtimeConfig: AppConfig): BotInspection {
  const runtimeStatus = readRuntimeStatus(runtimeConfig);
  const pm2Info = getPm2ProcessInfo();
  const fallbackPid = readPidFile(runtimeConfig);
  const pid = pm2Info.running ? pm2Info.pid : runtimeStatus?.pid ?? fallbackPid;
  const running = pm2Info.running || isPidRunning(pid);
  let manager: BotInspection['manager'] = null;

  if (pm2Info.running || pm2Info.status !== null) {
    manager = 'pm2';
  } else if (fallbackPid !== null && isPidRunning(fallbackPid)) {
    manager = process.platform !== 'win32' && commandExists('nohup') ? 'nohup' : 'detached';
  } else if (pid !== null && isPidRunning(pid)) {
    manager = 'unknown';
  }

  return {
    running,
    pid: running ? pid : null,
    manager,
    runtimeStatus,
    mode: resolveRuntimeMode(runtimeConfig),
  };
}

function loadEnvDocument(): EnvDocument {
  const envPath = path.resolve(process.cwd(), '.env');
  const examplePath = path.resolve(process.cwd(), '.env.example');
  const sourcePath = existsSync(envPath) ? envPath : examplePath;
  const seedText = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '';
  const parsed = seedText ? dotenv.parse(seedText) : {};
  const runtimeConfig = createConfig({
    ...process.env,
    ...parsed,
  } as NodeJS.ProcessEnv);

  return {
    envPath,
    seedText,
    runtimeConfig,
  };
}

function deleteFiles(filePaths: readonly string[]): number {
  let removed = 0;
  for (const filePath of filePaths) {
    try {
      rmSync(filePath, { force: true });
      removed += 1;
    } catch {
      // best-effort cleanup
    }
  }
  return removed;
}

function resolvePidFilePath(runtimeConfig: AppConfig): string {
  return path.resolve(process.cwd(), runtimeConfig.REPORTS_DIR, PID_FILE_NAME);
}

function writePidFile(runtimeConfig: AppConfig, pid: number): void {
  const filePath = resolvePidFilePath(runtimeConfig);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${pid}\n`, 'utf8');
}

function readPidFile(runtimeConfig: AppConfig): number | null {
  try {
    const payload = readFileSync(resolvePidFilePath(runtimeConfig), 'utf8').trim();
    const parsed = Number.parseInt(payload, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function removePidFile(runtimeConfig: AppConfig): void {
  try {
    rmSync(resolvePidFilePath(runtimeConfig), { force: true });
  } catch {
    // ignore pid cleanup failures
  }
}

function isPidRunning(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await sleep(250);
  }
  return !isPidRunning(pid);
}

async function waitForRuntimeReady(
  runtimeConfig: AppConfig,
  timeoutMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const inspection = inspectBot(runtimeConfig);
    if (inspection.running && inspection.runtimeStatus?.running) {
      return true;
    }
    await sleep(300);
  }
  return false;
}

async function waitForPauseState(
  runtimeConfig: AppConfig,
  paused: boolean,
  timeoutMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = readRuntimeStatus(runtimeConfig);
    if (snapshot?.isPaused === paused) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

function getPm2ProcessInfo(): Pm2ProcessInfo {
  if (!commandExists('pm2')) {
    return {
      exists: false,
      running: false,
      pid: null,
      status: null,
    };
  }

  const result = spawnSync('pm2', ['jlist'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    return {
      exists: true,
      running: false,
      pid: null,
      status: null,
    };
  }

  try {
    const processes = JSON.parse(result.stdout || '[]') as Array<Record<string, unknown>>;
    const matched = processes.find((entry) => entry.name === PROCESS_NAME);
    if (!matched) {
      return {
        exists: true,
        running: false,
        pid: null,
        status: null,
      };
    }

    const pid =
      typeof matched.pid === 'number' && Number.isFinite(matched.pid)
        ? matched.pid
        : null;
    const pm2Env =
      matched.pm2_env && typeof matched.pm2_env === 'object'
        ? (matched.pm2_env as Record<string, unknown>)
        : null;
    const status =
      pm2Env && typeof pm2Env.status === 'string' ? pm2Env.status : null;

    return {
      exists: true,
      running: status === 'online' || status === 'launching',
      pid,
      status,
    };
  } catch {
    return {
      exists: true,
      running: false,
      pid: null,
      status: null,
    };
  }
}

function commandExists(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [command], {
    cwd: process.cwd(),
    stdio: 'ignore',
  }).status === 0;
}

function resolveNpmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function formatModeLabel(mode: RuntimeMode): string {
  if (mode === 'simulation') {
    return color.yellow('simulation');
  }
  if (mode === 'product_test') {
    return color.cyan('product_test');
  }
  return color.green('production');
}

function formatSignedCurrency(value: number): string {
  const normalized = roundTo(value, 2);
  const rendered = `${normalized >= 0 ? '+' : '-'}$${Math.abs(normalized).toFixed(2)}`;
  if (normalized > 0) {
    return color.green(rendered);
  }
  if (normalized < 0) {
    return color.red(rendered);
  }
  return color.dim(rendered);
}

function label(value: string): string {
  return `${color.bold(value.padEnd(14, ' '))}`;
}

const color = {
  bold: (value: string) => `\u001b[1m${value}\u001b[0m`,
  dim: (value: string) => `\u001b[2m${value}\u001b[0m`,
  red: (value: string) => `\u001b[31m${value}\u001b[0m`,
  green: (value: string) => `\u001b[32m${value}\u001b[0m`,
  yellow: (value: string) => `\u001b[33m${value}\u001b[0m`,
  cyan: (value: string) => `\u001b[36m${value}\u001b[0m`,
};

export const program = new Command()
  .name('scalper')
  .description('Polymarket HFT scalper CLI')
  .showHelpAfterError();

program
  .command('reset')
  .description('Delete today logs/reports and reset persisted runtime state')
  .action(() => resetCommand());

program
  .command('switch')
  .description('Switch runtime mode and restart the bot')
  .requiredOption('--mode <mode>', 'simulation | product_test | production')
  .action((options: { mode: string }) => {
    const mode = options.mode as CliMode;
    if (mode !== 'simulation' && mode !== 'product_test' && mode !== 'production') {
      throw new Error(`Unsupported mode: ${options.mode}`);
    }
    return switchCommand(mode);
  });

program
  .command('start')
  .description('Start polymarket-scalper in the background')
  .action(() => startCommand());

program
  .command('stop')
  .description('Gracefully stop polymarket-scalper')
  .action(() => stopCommand());

program
  .command('pause')
  .description('Pause new entries while keeping safety exits active')
  .action(() => pauseCommand());

program
  .command('resume')
  .description('Resume entries after a manual pause')
  .action(() => resumeCommand());

program
  .command('monitor')
  .description('Run a one-shot Polymarket status check or launch the live dashboard')
  .option('--watch', 'Keep refreshing a live terminal dashboard')
  .option('--refresh <ms>', 'Dashboard refresh interval in milliseconds')
  .action((options: { watch?: boolean; refresh?: string }) => monitorCommand(options));

program
  .command('dashboard')
  .description('Render a live terminal dashboard for markets, positions, and performance')
  .option('--refresh <ms>', 'Dashboard refresh interval in milliseconds')
  .action((options: { refresh?: string }) => dashboardCommand(options.refresh));

program
  .command('status')
  .description('Show current runtime status, pause state, PnL, latency, and recent signals')
  .action(() => {
    statusCommand();
  });

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void program.parseAsync(process.argv);
}
