type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface IndicatorLogger {
  debug(event: string, context?: Record<string, unknown>): void;
  info(event: string, context?: Record<string, unknown>): void;
  warn(event: string, context?: Record<string, unknown>): void;
  error(event: string, context?: Record<string, unknown>): void;
}

export function createLogger(threshold: Level = 'info', name = 'range-indicator'): IndicatorLogger {
  const min = LEVEL_ORDER[threshold];
  const emit = (level: Level, event: string, context?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < min) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      name,
      event,
      ...(context ?? {}),
    });
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (event, ctx) => emit('debug', event, ctx),
    info: (event, ctx) => emit('info', event, ctx),
    warn: (event, ctx) => emit('warn', event, ctx),
    error: (event, ctx) => emit('error', event, ctx),
  };
}
