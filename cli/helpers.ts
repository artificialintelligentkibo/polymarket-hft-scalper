import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { type AppConfig } from '../src/config.js';
import { formatDayKey } from '../src/utils.js';

export type CliMode = 'simulation' | 'product_test' | 'production';

const MODE_PRESETS: Record<CliMode, Record<string, string>> = {
  simulation: {
    SIMULATION_MODE: 'true',
    PRODUCT_TEST_MODE: 'false',
    DRY_RUN: 'true',
    TEST_MODE: 'false',
    MIN_SHARES: '8',
    MAX_SHARES: '12',
    BASE_ORDER_SHARES: '8',
    MAX_NET_YES: '30',
    MAX_NET_NO: '40',
  },
  product_test: {
    SIMULATION_MODE: 'false',
    PRODUCT_TEST_MODE: 'true',
    DRY_RUN: 'false',
    TEST_MODE: 'false',
    TEST_MIN_TRADE_USDC: '1',
    TEST_MAX_SLOTS: '1',
    MIN_SHARES: '1',
    MAX_SHARES: '5',
    BASE_ORDER_SHARES: '1',
    MAX_NET_YES: '30',
    MAX_NET_NO: '40',
  },
  production: {
    SIMULATION_MODE: 'false',
    PRODUCT_TEST_MODE: 'false',
    DRY_RUN: 'false',
    TEST_MODE: 'false',
    MIN_SHARES: '8',
    MAX_SHARES: '35',
    BASE_ORDER_SHARES: '12',
    MAX_NET_YES: '200',
    MAX_NET_NO: '250',
  },
};

export function buildModeOverrides(mode: CliMode): Record<string, string> {
  return { ...MODE_PRESETS[mode] };
}

export function applyEnvUpdatesToText(
  rawText: string,
  updates: Record<string, string>
): string {
  const lines = rawText ? rawText.replace(/\r\n/g, '\n').split('\n') : [];
  const indexByKey = new Map<string, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match?.[1]) {
      indexByKey.set(match[1], index);
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${formatEnvValue(value)}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      lines[existingIndex] = line;
    } else {
      lines.push(line);
      indexByKey.set(key, lines.length - 1);
    }
  }

  const normalized = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return normalized ? `${normalized}\n` : '';
}

export function collectTodayResetTargets(
  runtimeConfig: AppConfig,
  dayKey = formatDayKey(new Date())
): string[] {
  const directories = [
    path.resolve(process.cwd(), runtimeConfig.logging.directory),
    path.resolve(process.cwd(), runtimeConfig.REPORTS_DIR),
  ];
  const targets = new Set<string>();

  for (const directory of directories) {
    if (!existsSync(directory)) {
      continue;
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      if (entry.name.includes(dayKey)) {
        targets.add(path.join(directory, entry.name));
      }
    }
  }

  const alwaysReset = [
    path.resolve(process.cwd(), runtimeConfig.STATE_FILE),
    path.resolve(process.cwd(), runtimeConfig.REPORTS_DIR, 'runtime-status.json'),
    path.resolve(process.cwd(), runtimeConfig.REPORTS_DIR, 'polymarket-scalper.pid'),
  ];

  for (const filePath of alwaysReset) {
    if (existsSync(filePath)) {
      targets.add(filePath);
    }
  }

  return [...targets];
}

function formatEnvValue(value: string): string {
  return /[\s#]/.test(value) ? JSON.stringify(value) : value;
}
