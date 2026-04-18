// settings-loader must come FIRST so config/bot-config.jsonc → process.env
// is populated before any downstream module reads config.
import '../src/settings-loader.js';
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
  type RuntimeMmQuoteSnapshot,
  type RuntimeMode,
  type RuntimePositionSnapshot,
  type SniperStatsSnapshot,
  type RuntimeStatusSnapshot,
  type ObiSessionStats,
  type VsSessionStats,
  type PaperTradingStatsSnapshot,
} from '../src/runtime-status.js';
import { checkPolymarketStatus, writeStatusControlCommand } from '../src/status-monitor.js';
import { resetSlotReporterState } from '../src/slot-reporter.js';
import { roundTo, sleep } from '../src/utils.js';
import {
  applyEnvUpdatesToText,
  buildModeOverrides,
  collectResetTargets,
  resolveDisplayedDayPnl,
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

  const removed = deleteFiles(
    collectResetTargets(document.runtimeConfig, {
      includeHistory: true,
    })
  );
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
    `${color.green('Reset complete.')} Removed ${removed} file(s). Reports, logs, runtime status, and day PnL state were fully cleared.`
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
  const { totalDayPnl, drawdown } = resolveDisplayedDayPnl({
    runtimeConfig,
    runtimeStatus,
  });

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
  console.log(`${label('Dust exits')} ${String(runtimeStatus?.dustPositionsCount ?? 0)}`);
  console.log(`${label('Dust wait')} ${String(runtimeStatus?.dustAbandonedCount ?? 0)}`);
  console.log(
    `${label('Blocked rem')} ${(runtimeStatus?.blockedExitRemainderShares ?? 0).toFixed(4)} sh`
  );
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
  console.log(
    `${label('API gate')} ${
      runtimeStatus
        ? formatCircuitBreakerGate(runtimeStatus)
        : color.dim('n/a')
    }`
  );
  console.log(
    `${label('FV smoothing')} ${
      runtimeStatus?.bayesianFvEnabled
        ? color.green(`ON (alpha=${runtimeStatus.bayesianFvAlpha.toFixed(2)})`)
        : color.dim('OFF')
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

// ─── OBI Dashboard Sections ─────────────────────────────────────────

function renderObiSessionStats(stats: ObiSessionStats): string {
  const winRate = (stats.wins + stats.losses) > 0
    ? `${((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(0)}%`
    : 'n/a';
  const passRate = `${(stats.passRate * 100).toFixed(0)}%`;
  return renderTable(
    ['METRIC', 'VALUE', 'METRIC', 'VALUE'],
    [20, 12, 20, 12],
    [
      ['Entries', color.bold(String(stats.entries)), 'Exits', color.bold(String(stats.exits))],
      ['Wins', color.green(String(stats.wins)), 'Losses', color.red(String(stats.losses))],
      ['Win Rate', color.bold(winRate), 'Redeems (P17)', color.cyan(String(stats.redeems))],
      ['Realized PnL', formatSignedCurrency(stats.realizedPnl), 'Gate Pass Rate', color.bold(passRate)],
      ['Max Cap (sh)', color.bold(String(stats.maxPositionShares)), 'Max Price', color.bold(stats.maxEntryPrice.toFixed(2))],
      ['Compound ×', stats.obiSizeMultiplier > 1.0 ? color.cyan(`${stats.obiSizeMultiplier.toFixed(1)}×`) : color.dim('1.0× (static)'), 'Cooldown', color.dim(`${stats.cooldownMs}ms`)],
      ['Stop Before End', color.dim(`${stats.stopEntryBeforeEndMs}ms`), 'Guard Triggers', color.bold(String(stats.drawdownGuardTriggers))],
      ['Drawdown Guard', stats.drawdownGuardActive ? color.yellow('ACTIVE (0.5x)') : color.green('OFF'), '', ''],
    ]
  );
}

function renderObiBinanceGate(stats: ObiSessionStats): string {
  const gateOrder = ['misaligned_strict', 'flat_direction', 'runaway_abs', 'contra_direction', 'unavailable_required'];
  const totalDecisions = stats.totalGatePassed + stats.totalGateBlocks;
  const rows: string[][] = [
    [
      color.green('passed'),
      color.green(String(stats.totalGatePassed)),
      totalDecisions > 0 ? `${((stats.totalGatePassed / totalDecisions) * 100).toFixed(0)}%` : '-',
      color.dim('—'),
    ],
  ];
  for (const reason of gateOrder) {
    const g = stats.gateReasons[reason];
    if (!g) continue;
    const cnt = g.count;
    const pct = totalDecisions > 0 ? `${((cnt / totalDecisions) * 100).toFixed(0)}%` : '-';
    const lastSeen = g.lastSeenAt
      ? g.lastSeenAt.slice(11, 19) + ' UTC'
      : color.dim('never');
    const label = reason.replace(/_/g, ' ');
    rows.push([
      cnt > 0 ? color.red(label) : color.dim(label),
      cnt > 0 ? color.red(String(cnt)) : color.dim('0'),
      pct,
      lastSeen,
    ]);
  }
  return renderTable(
    ['DECISION', 'COUNT', '%', 'LAST SEEN'],
    [22, 7, 6, 16],
    rows
  );
}

function renderObiDustSafety(stats: ObiSessionStats): string {
  const lines: string[] = [];
  const total = stats.phase15Accepted + stats.phase15Refused;
  lines.push(
    `Cap: ${color.bold(String(stats.maxPositionShares))} shares` +
    (stats.obiSizeMultiplier > 1.0 ? ` (${stats.obiSizeMultiplier.toFixed(1)}×)` : '') +
    `   ` +
    `Accepted: ${color.green(String(stats.phase15Accepted))}   ` +
    `Refused: ${color.red(String(stats.phase15Refused))}` +
    (total > 0 ? `   (${((stats.phase15Accepted / total) * 100).toFixed(0)}% pass)` : '')
  );
  if (stats.phase15LastRefusal) {
    lines.push(color.dim(`Last refusal: ${stats.phase15LastRefusal}`));
  }
  return lines.join('\n');
}

function renderObiCoinBreakdown(stats: ObiSessionStats): string {
  const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE'];
  const rows: string[][] = [];
  for (const coin of coins) {
    const c = stats.coinStats[coin];
    if (!c && !coins.includes(coin)) continue;
    const entries = c?.entries ?? 0;
    const exits = c?.exits ?? 0;
    const blocks = c?.blocks ?? 0;
    const refusals = c?.refusals ?? 0;
    const pnl = c?.realizedPnl ?? 0;
    const lastAction = c?.lastAction ?? color.dim('—');
    rows.push([
      color.bold(coin),
      entries > 0 ? color.green(String(entries)) : color.dim('0'),
      exits > 0 ? color.cyan(String(exits)) : color.dim('0'),
      blocks > 0 ? color.red(String(blocks)) : color.dim('0'),
      refusals > 0 ? color.yellow(String(refusals)) : color.dim('0'),
      pnl !== 0 ? formatSignedCurrency(pnl) : color.dim('$0.00'),
      lastAction,
    ]);
  }
  return renderTable(
    ['COIN', 'ENTRIES', 'EXITS', 'BLOCKS', 'REFUSED', 'PNL', 'LAST'],
    [6, 8, 7, 8, 8, 10, 10],
    rows
  );
}

function renderObiRecentDecisions(stats: ObiSessionStats): string {
  if (stats.recentDecisions.length === 0) {
    return color.dim('No OBI decisions recorded yet.');
  }
  const rows: string[][] = [];
  // Show newest first, limit to 3 (compact dashboard)
  const decisions = [...stats.recentDecisions].reverse().slice(0, 3);
  for (const d of decisions) {
    const time = d.timestamp.slice(11, 19);
    const coin = d.coin ?? '?';
    let actionStr: string;
    if (d.action.includes('ENTRY') || d.action.includes('REDEEM')) {
      actionStr = color.green(d.action);
    } else if (d.action === 'BLOCKED') {
      actionStr = color.red(d.action);
    } else if (d.action === 'REFUSED') {
      actionStr = color.yellow(d.action);
    } else {
      actionStr = color.cyan(d.action);
    }
    const reasonDetail = d.detail ? `${d.reason} ${color.dim(d.detail)}` : d.reason;
    rows.push([color.dim(time), color.bold(coin), actionStr, reasonDetail]);
  }
  return renderTable(
    ['TIME', 'COIN', 'ACTION', 'REASON'],
    [10, 6, 16, 40],
    rows
  );
}

function renderVsSessionStats(stats: VsSessionStats): string {
  const winRate = (stats.wins + stats.losses) > 0
    ? `${((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(0)}%`
    : 'n/a';
  const modeStr = stats.shadowMode ? color.yellow('SHADOW') : color.green('LIVE');
  return renderTable(
    ['METRIC', 'VALUE', 'METRIC', 'VALUE'],
    [20, 12, 20, 12],
    [
      ['Mode', modeStr, 'MM Phase', stats.mmPhaseEnabled === false ? color.red('OFF') : color.green('ON')],
      ['Entries', color.bold(String(stats.entries)), 'Exits', color.bold(String(stats.exits))],
      ['Wins', color.green(String(stats.wins)), 'Losses', color.red(String(stats.losses))],
      ['Win Rate', color.bold(winRate), 'Realized PnL', formatSignedCurrency(stats.realizedPnl)],
      ['Phase 1 (MM)', color.cyan(String(stats.phase1Entries)), 'Phase 1 PnL', formatSignedCurrency(stats.phase1Pnl)],
      ['Phase 2 (AGG)', color.yellow(String(stats.phase2Entries)), 'Phase 2 PnL', formatSignedCurrency(stats.phase2Pnl)],
      ['MM Spread', color.bold(`${(stats.mmSpreadCents ?? 0.02).toFixed(2)}¢`), 'Price Stop', color.bold(`${((stats.priceStopCents ?? 0.05) * 100).toFixed(0)}¢`)],
      ['Agg Vol Floor', color.bold((stats.aggressorVolFloor ?? 0.02).toFixed(3)), 'Agg Min Edge', color.bold((stats.aggressorMinEdge ?? 0.03).toFixed(3))],
      ['Exit Target', color.bold(stats.targetExitPrice.toFixed(2)), 'Agg Max Buy', color.bold(stats.momentumMaxBuyPrice.toFixed(2))],
      ['Stale Cancel', color.bold(`${(stats.staleCancelThresholdPct ?? 0.02).toFixed(2)}%`), 'Stale Cancels', color.yellow(String(stats.staleCancels ?? 0))],
      ['Dyn Exit', color.bold(`${(stats.dynamicExitThresholdPct ?? 0.02).toFixed(2)}%`), 'Dyn Exits', color.yellow(String(stats.dynamicExits ?? 0))],
      ['Dyn Floor', color.bold(`${((stats.dynExitMinPriceFloorPct ?? 0) * 100).toFixed(0)}% (${stats.dynExitFallbackMode ?? 'cross'})`), 'Dyn Cross/Fb/Skip', color.yellow(`${stats.dynExitCrossFilled ?? 0}/${stats.dynExitFallbackLimit ?? 0}/${stats.dynExitFallbackSkipped ?? 0}`)],
      ['PM Guard', color.bold(`${(stats.pmExitThresholdCents ?? 0.05).toFixed(2)}¢`), 'PM Exits', color.yellow(String(stats.pmExits ?? 0))],
      ['Signals Gen', color.dim(String(stats.totalSignalsGenerated ?? 0)), 'Active Pos', color.bold(String((stats.activePositions ?? []).length))],
      // Phase 58 rows
      [
        'P58 Routing',
        stats.phase58Enabled
          ? color.cyan(stats.phaseCTakerEnabled ? 'A+B+C' : 'A+B (no taker)')
          : color.dim('off (legacy)'),
        'Hold Winners',
        stats.holdWinnersToResolution ? color.green('ON') : color.red('OFF'),
      ],
      [
        'Winner Holds',
        color.green(String(stats.winnerHolds ?? 0)),
        'Phase C Cap',
        color.bold((stats.phaseCMaxBuyPrice ?? 0.85).toFixed(2)),
      ],
      [
        'Accum Size',
        color.bold(`${stats.accumulateShares ?? 6}×${stats.accumulateMaxFills ?? 4}`),
        '',
        '',
      ],
    ]
  );
}

function renderVsActivePositions(stats: VsSessionStats): string {
  const positions = stats.activePositions ?? [];
  if (positions.length === 0) {
    return color.dim('No active VS positions.');
  }
  const rows: string[][] = [];
  for (const p of positions) {
    const ageSec = Math.round(p.ageMs / 1000);
    const phaseStr = p.phase === 'MOMENTUM' ? color.yellow('AGG') : color.cyan('MM');
    rows.push([
      color.bold(p.coin),
      p.outcome === 'YES' ? color.green('YES') : color.red('NO'),
      color.bold(String(p.shares)),
      color.dim(p.entryVwap.toFixed(3)),
      phaseStr,
      color.dim(`${ageSec}s`),
    ]);
  }
  return renderTable(
    ['COIN', 'SIDE', 'SHARES', 'VWAP', 'PHASE', 'AGE'],
    [6, 6, 8, 8, 7, 8],
    rows
  );
}

function renderVsCoinBreakdown(stats: VsSessionStats): string {
  const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE'];
  const rows: string[][] = [];
  for (const coin of coins) {
    const c = stats.coinStats[coin];
    const entries = c?.entries ?? 0;
    const exits = c?.exits ?? 0;
    const p1 = c?.phase1Entries ?? 0;
    const p2 = c?.phase2Entries ?? 0;
    const pnl = c?.realizedPnl ?? 0;
    const lastAction = c?.lastAction ?? color.dim('—');
    rows.push([
      color.bold(coin),
      entries > 0 ? color.green(String(entries)) : color.dim('0'),
      exits > 0 ? color.cyan(String(exits)) : color.dim('0'),
      p1 > 0 ? color.dim(String(p1)) : color.dim('0'),
      p2 > 0 ? color.dim(String(p2)) : color.dim('0'),
      pnl !== 0 ? formatSignedCurrency(pnl) : color.dim('$0.00'),
      lastAction,
    ]);
  }
  return renderTable(
    ['COIN', 'ENTRIES', 'EXITS', 'PH1', 'PH2', 'PNL', 'LAST'],
    [6, 8, 7, 5, 5, 10, 16],
    rows
  );
}

function renderVsRecentDecisions(stats: VsSessionStats): string {
  if (stats.recentDecisions.length === 0) {
    return color.dim('No VS decisions recorded yet.');
  }
  const rows: string[][] = [];
  const decisions = [...stats.recentDecisions].reverse().slice(0, 5);
  for (const d of decisions) {
    const time = d.timestamp.slice(11, 19);
    const coin = d.coin ?? '?';
    const phase = d.phase === 'MOMENTUM' ? color.yellow('AGG') : color.cyan('MM');
    let actionStr: string;
    if (d.action.includes('ENTRY') || d.action.includes('BUY')) {
      actionStr = color.green(d.action);
    } else if (d.action.includes('EXIT') || d.action.includes('SELL')) {
      actionStr = color.cyan(d.action);
    } else if (d.action === 'SKIP') {
      actionStr = color.yellow(d.action);
    } else {
      actionStr = color.dim(d.action);
    }
    const fvStr = d.fairValue !== null ? `fv=${d.fairValue.toFixed(3)}` : '';
    rows.push([color.dim(time), color.bold(coin), phase, actionStr, `${d.reason} ${color.dim(fvStr)}`]);
  }
  return renderTable(
    ['TIME', 'COIN', 'PHASE', 'ACTION', 'REASON'],
    [10, 6, 5, 16, 35],
    rows
  );
}

function renderPaperTradingStats(stats: PaperTradingStatsSnapshot): string {
  const pnlColor = stats.totalPnl >= 0 ? color.green : color.red;
  const pnlStr = `${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)} (${stats.totalPnlPct >= 0 ? '+' : ''}${stats.totalPnlPct.toFixed(1)}%)`;
  const winRateStr = stats.slotsResolved > 0
    ? `${stats.winRate.toFixed(0)}%`
    : 'n/a';
  const fillRate = stats.totalTrades > 0
    ? `${((stats.totalFills / stats.totalTrades) * 100).toFixed(0)}%`
    : 'n/a';

  const lines: string[] = [
    `  ${color.dim('Balance:')} $${stats.initialBalance.toFixed(2)} ${color.dim('->')} ${color.bold(`$${stats.currentBalance.toFixed(2)}`)}  ${color.dim('PnL:')} ${pnlColor(pnlStr)}`,
    `  ${color.dim('Trades:')} ${stats.totalTrades}  ${color.dim('Fills:')} ${stats.totalFills}  ${color.dim('Expired:')} ${stats.totalExpired}  ${color.dim('Fill rate:')} ${fillRate}`,
    `  ${color.dim('Maker fills:')} ${stats.makerFills}  ${color.dim('Taker fills:')} ${stats.takerFills}  ${color.dim('Fees:')} $${stats.totalFees.toFixed(4)}`,
    `  ${color.dim('Slots:')} ${stats.slotsResolved}  ${color.dim('Win rate:')} ${winRateStr}  ${color.dim('Avg win:')} ${formatPaperUsd(stats.avgWinUsd)}  ${color.dim('Avg loss:')} ${formatPaperUsd(stats.avgLossUsd)}`,
    `  ${color.dim('Max drawdown:')} $${stats.maxDrawdownUsd.toFixed(2)}  ${color.dim('Sharpe:')} ${stats.sharpeRatio !== null ? stats.sharpeRatio.toFixed(2) : 'n/a'}`,
    `  ${color.dim('Pending orders:')} ${stats.pendingOrders}  ${color.dim('Open positions:')} ${stats.openPositions}`,
  ];
  return lines.join('\n');
}

function formatPaperUsd(value: number): string {
  if (value === 0) return '$0.00';
  const sign = value >= 0 ? '+' : '';
  const colorFn = value >= 0 ? color.green : color.red;
  return colorFn(`${sign}$${value.toFixed(2)}`);
}

function renderDashboardFrame(runtimeConfig: AppConfig): string {
  const inspection = inspectBot(runtimeConfig);
  const runtimeStatus = inspection.runtimeStatus;
  const now = formatDashboardTimestamp(new Date());
  const statusLabel = runtimeStatus?.isPaused
    ? color.red(`PAUSED - ${runtimeStatus.pauseReason ?? 'manual'}`)
    : color.green('OK');

  const headerSupplementalEntries: Array<readonly [string, string]> =
    inspection.mode === 'production'
      ? buildProductionHeaderBalanceEntries(runtimeStatus)
      : [
          ['process', inspection.runtimeStatus?.pid ? `pid ${inspection.runtimeStatus.pid}` : 'n/a'],
          ['manager', inspection.manager ?? 'n/a'],
        ];

  const obiStats = runtimeStatus?.obiStats;
  const isObiMode = obiStats?.enabled === true;

  const lines = [
    renderBanner(
      isObiMode
        ? 'OBI SCALPER  |  LIVE DASHBOARD'
        : 'POLYMARKET SCALPER  |  LIVE RUNTIME DASHBOARD',
      isObiMode
        ? color.dim('order book imbalance  |  thin-side entry  |  rebalance exit')
        : color.dim('5-minute slots  |  dual-sided market-maker  |  real-time monitor')
    ),
    renderInfoBar([
      ['time', now],
      ['mode', stripAnsi(formatModeLabel(inspection.mode))],
      ['status', stripAnsi(statusLabel)],
      ...headerSupplementalEntries,
      ...(isObiMode
        ? [['day PnL', formatSignedCurrency(runtimeStatus?.totalDayPnl ?? 0)] as const]
        : []),
    ]),
  ];

  if (runtimeStatus?.isPaused) {
    lines.push(color.red(color.bold('BOT PAUSED - Polymarket status issue or manual pause')));
  }

  if (runtimeStatus?.latencyPaused) {
    lines.push(
      color.yellow(
        color.bold(
          `ENTRY GATE ACTIVE - latency rolling avg ${runtimeStatus.latencyPauseAverageMs?.toFixed(0) ?? 'n/a'}ms`
        )
      )
    );
  }

  lines.push(
    renderSection(
      'ACTIVE MARKETS  -  SCANNING LIVE SIGNALS',
      renderActiveMarkets(filterCurrentSlotMarkets(runtimeStatus?.activeMarkets ?? []), runtimeStatus?.sniperStats)
    )
  );
  lines.push(
    renderSection(
      isObiMode ? 'OBI POSITIONS' : 'LIVE POSITIONS  -  OPEN INVENTORY NOW',
      renderOpenPositions(runtimeStatus?.openPositions ?? [])
    )
  );

  if (isObiMode && obiStats) {
    // OBI-focused sections (compact: hide empty sub-sections)
    lines.push(
      renderSection(
        'OBI SESSION  -  TODAY\'S PERFORMANCE',
        renderObiSessionStats(obiStats)
      )
    );
    // Only show Binance Gate & Dust Safety when there's actual activity
    const hasGateActivity = obiStats.totalGatePassed > 0 || obiStats.totalGateBlocks > 0;
    if (hasGateActivity) {
      lines.push(
        renderSection(
          'BINANCE GATE  -  ENTRY FILTER BREAKDOWN',
          renderObiBinanceGate(obiStats)
        )
      );
    }
    const hasDustActivity = obiStats.phase15Accepted > 0 || obiStats.phase15Refused > 0;
    if (hasDustActivity) {
      lines.push(
        renderSection(
          'DUST SAFETY  -  PHASE 15 CAP CHECK',
          renderObiDustSafety(obiStats)
        )
      );
    }
    // Only show coin breakdown when there are entries
    if (obiStats.entries > 0) {
      lines.push(
        renderSection(
          'PER-COIN BREAKDOWN',
          renderObiCoinBreakdown(obiStats)
        )
      );
    }
    lines.push(
      renderSection(
        'RECENT OBI DECISIONS',
        renderObiRecentDecisions(obiStats)
      )
    );
  } else {
    // Legacy sniper/MM sections — only show active components
    const hasMmQuotes = (runtimeStatus?.mmQuotes ?? []).length > 0;
    if (hasMmQuotes) {
      lines.push(
        renderSection(
          'MM QUOTES  -  ACTIVE QUOTING AND INVENTORY',
          renderMmQuotes(runtimeStatus)
        )
      );
    }
    lines.push(
      renderSection(
        'BOT PERFORMANCE STATS',
        renderPerformance(inspection, runtimeStatus, runtimeConfig)
      )
    );
    lines.push(
      renderSection(
        'STRATEGY LAYERS',
        renderStrategyLayers(runtimeStatus)
      )
    );
    // Only show engine sections when they're actually enabled
    if (runtimeStatus?.sniperStats?.enabled) {
      lines.push(
        renderSection(
          'SNIPER ENGINE  -  BINANCE-LED SIGNAL STATUS',
          renderSniperStats(runtimeStatus.sniperStats)
        )
      );
    }
    if (runtimeStatus?.lotteryStats?.enabled) {
      lines.push(
        renderSection(
          'LOTTERY LAYER',
          renderLotteryStats(runtimeStatus)
        )
      );
    }
    const recentSignals = runtimeStatus?.lastSignals ?? [];
    if (recentSignals.length > 0) {
      lines.push(
        renderSection(
          'RECENT SIGNALS',
          renderRecentSignals(recentSignals)
        )
      );
    }
  }

  // VS Engine section — shown when vsStats is present (parallel to OBI)
  const vsStats = runtimeStatus?.vsStats;
  if (vsStats?.enabled) {
    const p58Suffix = vsStats.phase58Enabled
      ? color.cyan(vsStats.phaseCTakerEnabled ? ' [P58: A+B+C]' : ' [P58: A+B]')
      : color.dim(' [P58: off]');
    const holdSuffix = vsStats.holdWinnersToResolution
      ? color.green(' [HOLD-WINNERS]')
      : '';
    lines.push(
      renderSection(
        `VS ENGINE  -  SINGLE-SIDE MM + AGGRESSOR${p58Suffix}${holdSuffix} ${vsStats.shadowMode ? color.yellow('[SHADOW]') : ''}`,
        renderVsSessionStats(vsStats)
      )
    );
    // Active positions — always show (helpful to see empty = no open risk)
    lines.push(
      renderSection(
        'VS ACTIVE POSITIONS',
        renderVsActivePositions(vsStats)
      )
    );
    if (vsStats.entries > 0) {
      lines.push(
        renderSection(
          'VS PER-COIN BREAKDOWN',
          renderVsCoinBreakdown(vsStats)
        )
      );
    }
    lines.push(
      renderSection(
        'RECENT VS DECISIONS',
        renderVsRecentDecisions(vsStats)
      )
    );
  }

  // Paper Trading section — shown when paper trading is active
  const paperStats = runtimeStatus?.paperStats;
  if (paperStats?.enabled) {
    lines.push(
      renderSection(
        'PAPER TRADING  -  VIRTUAL PERFORMANCE',
        renderPaperTradingStats(paperStats)
      )
    );
  }

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

function buildProductionHeaderBalanceEntries(
  runtimeStatus: RuntimeStatusSnapshot | null
): Array<readonly [string, string]> {
  return [
    ['portfolio', formatHeaderCurrency(runtimeStatus?.portfolioValueUsd ?? null)],
    ['cash', formatHeaderCurrency(runtimeStatus?.walletCashUsd ?? null)],
    ['available', formatHeaderCurrency(runtimeStatus?.availableToTradeUsd ?? null)],
  ];
}

function renderSection(title: string, body: string): string {
  const heading = color.yellow(color.bold(`== ${title} ==`));
  return [heading, body].join('\n');
}

function filterCurrentSlotMarkets(
  markets: readonly RuntimeMarketSnapshot[]
): RuntimeMarketSnapshot[] {
  const now = new Date().toISOString();
  return markets.filter((m) => {
    // Keep markets whose slot hasn't ended yet (or has no slotEnd)
    if (!m.slotEnd) return true;
    return m.slotEnd > now;
  });
}

function renderActiveMarkets(
  markets: readonly RuntimeMarketSnapshot[],
  sniperStats?: SniperStatsSnapshot
): string {
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
      resolveActiveMarketAction(market, sniperStats),
    ])
  );
}

function renderOpenPositions(positions: readonly RuntimePositionSnapshot[]): string {
  // Filter dust-abandoned positions (sub-1-share residuals redeemed on wallet but
  // lingering in bot state with nonsensical ROI%). Preserved in runtime-status.json
  // for history; only hidden from terminal dashboard.
  const displayPositions = positions.filter((p) => !p.dustAbandoned);

  if (displayPositions.length === 0) {
    return color.dim('No live inventory open right now.');
  }

  return renderTable(
    ['POSITION', 'YES', 'NO', 'VALUE', 'UNRL P&L', 'TOTAL', 'ROI'],
    [28, 8, 8, 11, 11, 11, 8],
    displayPositions.map((position) => [
      truncateDashboardLabel(buildPositionLabel(position), 28),
      formatShares(position.yesShares),
      formatShares(position.noShares),
      formatPlainCurrency(position.markValueUsd),
      position.dustAbandoned
        ? color.dim(formatSignedCurrency(position.unrealizedPnl))
        : formatSignedCurrency(position.unrealizedPnl),
      position.dustAbandoned
        ? color.dim(formatSignedCurrency(position.totalPnl))
        : formatSignedCurrency(position.totalPnl),
      position.roiPct !== null
        ? position.dustAbandoned
          ? color.dim(colorizeSignedPercent(position.roiPct))
          : colorizeSignedPercent(position.roiPct)
        : color.dim('n/a'),
    ])
  );
}

function renderMmQuotes(runtimeStatus: RuntimeStatusSnapshot | null): string {
  if (!runtimeStatus?.mmEnabled) {
    return color.dim('Market-making quotes are disabled in the current runtime.');
  }

  const summary = [
    `Exposure ${runtimeStatus.mmCurrentExposure.toFixed(2)}/${runtimeStatus.mmMaxGrossExposure.toFixed(2)} USDC`,
    `Pending ${runtimeStatus.mmPendingExposure.toFixed(2)} USDC`,
    `Pend Y/N ${runtimeStatus.mmPendingYesShares.toFixed(2)}/${runtimeStatus.mmPendingNoShares.toFixed(2)}`,
    `Markets ${runtimeStatus.mmActiveMarkets}/${runtimeStatus.mmMaxConcurrentMarkets}`,
    `Skew ${runtimeStatus.mmInventorySkew.toFixed(2)}`,
    `Net limit ${runtimeStatus.mmMaxNetDirectional.toFixed(0)} sh`,
    `Auto ${runtimeStatus.mmAutonomousQuotes ? 'ON' : 'OFF'}`,
  ].join('   ');

  if (runtimeStatus.mmQuotes.length === 0) {
    return `${color.dim(summary)}\n${color.dim('No active MM quotes or inventory are tracked right now.')}`;
  }

  return [
    color.dim(summary),
    renderTable(
      ['MARKET', 'BID', 'ASK', 'SPR', 'YES', 'NO', 'NET', 'GROSS'],
      [24, 8, 8, 8, 8, 8, 8, 10],
      runtimeStatus.mmQuotes.map((quote) => [
        truncateDashboardLabel(buildMmQuoteLabel(quote), 24),
        formatMidPrice(quote.bidPrice),
        formatMidPrice(quote.askPrice),
        formatMidPrice(quote.spread),
        formatShares(quote.yesShares),
        formatShares(quote.noShares),
        formatSignedShares(quote.netDirectionalShares),
        formatPlainCurrency(quote.grossExposureUsd),
      ])
    ),
  ].join('\n');
}

function renderPerformance(
  inspection: BotInspection,
  runtimeStatus: RuntimeStatusSnapshot | null,
  runtimeConfig: AppConfig
): string {
  const { totalDayPnl, drawdown } = resolveDisplayedDayPnl({
    runtimeConfig,
    runtimeStatus,
  });
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
  const apiGate =
    runtimeStatus && isAnyCircuitBreakerOpen(runtimeStatus)
      ? color.yellow(formatCircuitBreakerGate(runtimeStatus, false))
      : color.green('OFF');
  const bayesianFv =
    runtimeStatus?.bayesianFvEnabled
      ? color.green(`ON (alpha=${runtimeStatus.bayesianFvAlpha.toFixed(2)})`)
      : color.dim('OFF');
  const lastSlotNet = runtimeStatus?.lastSlotReport
    ? formatSignedCurrency(runtimeStatus.lastSlotReport.netPnl)
    : color.dim('n/a');
  const lastSlotLabel = runtimeStatus?.lastSlotReport?.slotLabel
    ? truncateDashboardLabel(runtimeStatus.lastSlotReport.slotLabel, 32)
    : 'n/a';
  const mmExposure = runtimeStatus
    ? `${runtimeStatus.mmCurrentExposure.toFixed(2)}/${runtimeStatus.mmMaxGrossExposure.toFixed(2)}`
    : 'n/a';
  const mmPending = runtimeStatus
    ? `${runtimeStatus.mmPendingExposure.toFixed(2)} USDC`
    : 'n/a';
  const mmMarkets = runtimeStatus
    ? `${runtimeStatus.mmActiveMarkets}/${runtimeStatus.mmMaxConcurrentMarkets}`
    : 'n/a';
  const dustPositions = runtimeStatus?.dustPositionsCount ?? 0;
  const blockedExitRemainder = runtimeStatus?.blockedExitRemainderShares ?? 0;

  return renderTable(
    ['METRIC', 'VALUE', 'METRIC', 'VALUE'],
    [20, 18, 20, 28],
    [
      ['Running', inspection.running ? color.green('YES') : color.red('NO'), 'Mode', formatModeLabel(inspection.mode)],
      ['Day PnL', formatSignedCurrency(totalDayPnl), 'Drawdown', formatSignedCurrency(drawdown)],
      ['Active slots', color.bold(String(activeSlots)), 'Open positions', color.bold(String(openPositions))],
      ['MM exposure', color.bold(mmExposure), 'MM markets', color.bold(mmMarkets)],
      ['MM pending', color.bold(mmPending), 'Pending Y/N', color.bold(runtimeStatus ? `${runtimeStatus.mmPendingYesShares.toFixed(2)}/${runtimeStatus.mmPendingNoShares.toFixed(2)}` : 'n/a')],
      ['Dust exits', color.bold(String(dustPositions)), 'Dust wait', color.bold(String(runtimeStatus?.dustAbandonedCount ?? 0))],
      ['Blocked remainder', color.bold(`${blockedExitRemainder.toFixed(4)} sh`), 'Avg latency', color.bold(averageLatency)],
      ['Latency gate', latencyGate, 'API gate', apiGate],
      ['FV smoothing', bayesianFv, 'Manager', color.bold(inspection.manager ?? 'n/a')],
      ['Status', runtimeStatus?.isPaused ? color.red('PAUSED') : color.green('OK'), 'Circuit details', runtimeStatus ? color.dim(formatCircuitBreakerGate(runtimeStatus, false)) : color.dim('n/a')],
      ['Slot label', lastSlotLabel, 'Last slot', lastSlotNet],
      ['Updated', runtimeStatus?.updatedAt ? truncateDashboardLabel(runtimeStatus.updatedAt, 28) : color.dim('n/a'), '', ''],
    ]
  );
}

function renderStrategyLayers(runtimeStatus: RuntimeStatusSnapshot | null): string {
  if (!runtimeStatus) {
    return color.dim('No runtime status snapshot available yet.');
  }

  const allLayers = runtimeStatus.strategyLayers;
  const activeLayers = allLayers.filter((l) => l.status !== 'OFF');
  const hiddenCount = allLayers.length - activeLayers.length;

  if (activeLayers.length === 0) {
    return color.dim('No active strategy layers.');
  }

  const rows = activeLayers.map((layer) => {
    const status =
      layer.status === 'ACTIVE'
        ? color.green(layer.status)
        : layer.status === 'WATCHING'
          ? color.yellow(layer.status)
          : color.dim(layer.status);
    const positions =
      layer.layer === 'MM_QUOTE'
        ? `${layer.marketCount}/${runtimeStatus.mmMaxConcurrentMarkets} mkts`
        : layer.positionCount > 0
          ? String(layer.positionCount)
          : '0';

    return [
      layer.layer,
      status,
      positions,
      formatPlainCurrency(layer.exposureUsd),
      formatSignedCurrency(layer.pnlUsd),
    ];
  });

  return [
    renderTable(
      ['LAYER', 'STATUS', 'POSITIONS', 'EXPOSURE', 'PNL'],
      [12, 10, 12, 12, 12],
      rows
    ),
    `${color.dim('GLOBAL EXPOSURE:')} ${color.bold(formatPlainCurrency(runtimeStatus.globalExposure.totalUsd))} / ${color.bold(formatPlainCurrency(runtimeStatus.globalExposure.maxUsd))} max${hiddenCount > 0 ? `
${color.dim(`(${hiddenCount} inactive layers hidden)`)}` : ''}`,
  ].join('\n');
}

function renderSniperStats(stats: SniperStatsSnapshot | undefined): string {
  if (!stats || !stats.enabled) {
    return color.dim('Sniper mode is disabled.');
  }

  const lines: string[] = [];
  const signalRate =
    stats.signalsGenerated > 0
      ? color.bold(`${stats.signalsGenerated} signals`)
      : color.yellow('0 signals');
  const hitRate =
    stats.signalsGenerated > 0
      ? `${Math.round((stats.signalsExecuted / stats.signalsGenerated) * 100)}% hit`
      : 'n/a';
  const bestEdge =
    stats.bestEdgeSeen > 0
      ? color.green(`${(stats.bestEdgeSeen * 100).toFixed(2)}%`)
      : color.dim('none');
  const nearMiss =
    stats.nearMissCount > 0
      ? color.yellow(`${stats.nearMissCount} near-misses`)
      : color.dim('0');

  lines.push(
    `Signals ${signalRate}  ` +
      `Hit rate ${color.bold(hitRate)}  ` +
      `Best edge ${bestEdge}  ` +
      `Near-miss ${nearMiss}  ` +
      `Last signal ${
        stats.lastSignalAt ? timeAgo(stats.lastSignalAt) : color.dim('never')
      }`
  );

  const entries = Object.entries(stats.coinStats);
  if (entries.length > 0) {
    lines.push('');
    lines.push(
      renderTable(
        ['COIN', 'EVALS', 'SIGNALS', 'AVG MOVE', 'MAX MOVE', 'STATUS'],
        [8, 8, 8, 10, 10, 20],
        ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE'].flatMap((coin) => {
          const data = stats.coinStats[coin];
          if (!data) {
            return [];
          }

          const status =
            data.signals > 0
              ? color.green('ACTIVE')
              : data.maxMovePct >= 0.05
                ? color.yellow('WATCHING')
                : color.dim('QUIET');
          return [[
            coin,
            String(data.evaluations),
            data.signals > 0 ? color.green(String(data.signals)) : '0',
            `${data.avgMovePct.toFixed(3)}%`,
            data.maxMovePct >= 0.1
              ? color.yellow(`${data.maxMovePct.toFixed(3)}%`)
              : `${data.maxMovePct.toFixed(3)}%`,
            status,
          ]];
        })
      )
    );
  }

  if (stats.totalRejections > 0) {
    lines.push('');
    const totalEvaluations = stats.totalRejections + stats.signalsGenerated;
    const rejectionLine = Object.entries(stats.rejections)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => {
        const pct =
          totalEvaluations > 0 ? Math.round((count / totalEvaluations) * 100) : 0;
        return `${formatRejectionLabel(reason)} ${color.dim(`${pct}%`)}`;
      })
      .join('  ');
    lines.push(`${color.dim('Rejections:')} ${rejectionLine}`);
  }

  if (stats.lastRejection) {
    lines.push(`${color.dim('Last rejection:')} ${formatRejectionLabel(stats.lastRejection)}`);
  }

  if (stats.avgBinanceMove !== null) {
    lines.push(
      `${color.dim('Average move:')} ${color.bold(`${stats.avgBinanceMove.toFixed(3)}%`)}`
    );
  }

  if (stats.currentDirectionWindow) {
    const activeCoins =
      stats.currentDirectionWindow.activeCoins.length > 0
        ? stats.currentDirectionWindow.activeCoins.join(', ')
        : 'none';
    lines.push(
      `${color.dim('Direction window:')} ` +
        `${color.bold(stats.currentDirectionWindow.direction ?? 'n/a')} ` +
        `[${activeCoins}] ` +
        `${color.bold(stats.currentDirectionWindow.capacity)} capacity`
    );
  }

  return lines.join('\n');
}

function renderLotteryStats(runtimeStatus: RuntimeStatusSnapshot | null): string {
  const stats = runtimeStatus?.lotteryStats;
  if (!stats || !stats.enabled) {
    return color.dim('Lottery layer is disabled.');
  }

  const roiPct =
    stats.totalRiskUsdc > 0
      ? roundTo(((stats.totalPayoutUsdc - stats.totalRiskUsdc) / stats.totalRiskUsdc) * 100, 1)
      : null;
  const activeLabel =
    stats.activeEntries === 1
      ? '1 entry'
      : `${stats.activeEntries} entries`;

  return [
    `Status: ${color.green('ENABLED')} | Tickets: ${color.bold(String(stats.totalTickets))} | Hits: ${color.bold(String(stats.totalHits))} | Hit rate: ${color.bold(stats.hitRate)}`,
    `Active: ${activeLabel} | Total risk: ${color.bold(formatPlainCurrency(stats.totalRiskUsdc))} | Total payout: ${color.bold(formatPlainCurrency(stats.totalPayoutUsdc))}`,
    `ROI: ${roiPct !== null ? colorizeSignedPercent(roiPct) : color.dim('n/a')}`,
  ].join('\n');
}

function resolveActiveMarketAction(
  market: RuntimeMarketSnapshot,
  sniperStats?: SniperStatsSnapshot
): string {
  if (
    sniperStats?.enabled &&
    !market.action.startsWith('ENTER') &&
    !market.action.startsWith('EXIT') &&
    !market.action.startsWith('PAUSED')
  ) {
    const action = getSniperAction(market);
    if (action === 'SNIPER READY') {
      return color.green(action);
    }
    if (action === 'NEAR') {
      return color.yellow(action);
    }
    return color.dim(action);
  }

  return colorizeAction(market.action, market.signalCount);
}

function getSniperAction(market: RuntimeMarketSnapshot): string {
  const movePct = Math.abs(market.binanceMovePct ?? 0);
  if (movePct >= 0.1) {
    return 'SNIPER READY';
  }
  if (movePct >= 0.05) {
    return 'NEAR';
  }
  return 'SCAN';
}

function formatRejectionLabel(reason: string): string {
  const labels: Record<string, string> = {
    move_too_small: 'small move',
    edge_too_low: 'low edge',
    ask_price_too_high: 'price high',
    ask_price_too_low: 'price low',
    pm_already_repriced: 'PM caught up',
    direction_flat: 'flat',
    slot_too_early: 'too early',
    slot_too_late: 'too late',
    cooldown_active: 'cooldown',
    no_ask_available: 'no book',
    outcome_blocked: 'blocked',
    max_position_reached: 'max pos',
    no_binance_data: 'no data',
    velocity_too_low: 'slow move',
    correlated_risk_limit: 'correlated',
  };
  return labels[reason] ?? reason.replaceAll('_', ' ');
}

function timeAgo(isoTimestamp: string): string {
  const timestampMs = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(timestampMs)) {
    return color.dim('unknown');
  }

  const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (seconds < 60) {
    return color.green(`${seconds}s ago`);
  }
  if (seconds < 3600) {
    return color.yellow(`${Math.floor(seconds / 60)}m ago`);
  }
  return color.red(`${Math.floor(seconds / 3600)}h ago`);
}

function isAnyCircuitBreakerOpen(runtimeStatus: RuntimeStatusSnapshot): boolean {
  return (
    runtimeStatus.apiCircuitBreakers.clob.isOpen ||
    runtimeStatus.apiCircuitBreakers.gamma.isOpen
  );
}

function formatCircuitBreakerGate(
  runtimeStatus: RuntimeStatusSnapshot,
  colorize = true
): string {
  const clob = runtimeStatus.apiCircuitBreakers.clob;
  const gamma = runtimeStatus.apiCircuitBreakers.gamma;
  const raw = isAnyCircuitBreakerOpen(runtimeStatus)
    ? `ON (CLOB=${clob.isOpen ? 'OPEN' : 'OK'}, GAMMA=${gamma.isOpen ? 'OPEN' : 'OK'})`
    : 'OFF';

  if (!colorize) {
    return raw;
  }

  return isAnyCircuitBreakerOpen(runtimeStatus) ? color.yellow(raw) : color.green(raw);
}

function renderRecentSignals(signals: RuntimeStatusSnapshot['lastSignals']): string {
  if (signals.length === 0) {
    return color.dim('No recent signals recorded yet.');
  }

  return renderTable(
    ['TIME', 'MARKET', 'LAYER', 'SIGNAL', 'SIDE', 'OUT', 'LAT'],
    [20, 18, 10, 18, 8, 6, 8],
    [...signals]
      .slice()
      .reverse()
      .map((signal) => [
        formatSignalTimestamp(signal.timestamp),
        truncateDashboardLabel(signal.marketId, 18),
        signal.strategyLayer,
        truncateDashboardLabel(signal.signalType, 18),
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
  const base = slot ? `${truncateDashboardLabel(position.title, 18)} ${slot}` : position.title;
  return position.dustAbandoned ? `${base} [DUST WAIT]` : base;
}

function buildMmQuoteLabel(quote: RuntimeMmQuoteSnapshot): string {
  return quote.coin ? `${quote.coin} ${quote.marketId}` : quote.marketId;
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

function formatSignedShares(value: number): string {
  const rendered = `${value >= 0 ? '+' : ''}${roundTo(value, 2).toFixed(2)}`;
  if (value > 0) {
    return color.green(rendered);
  }
  if (value < 0) {
    return color.red(rendered);
  }
  return color.dim(rendered);
}

function formatPlainCurrency(value: number): string {
  return color.bold(`$${roundTo(value, 2).toFixed(2)}`);
}

function formatHeaderCurrency(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `$${roundTo(value, 2).toFixed(2)}`
    : 'n/a';
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
