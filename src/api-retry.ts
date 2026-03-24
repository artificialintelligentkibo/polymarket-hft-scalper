import { sleep } from './utils.js';

export interface RetryWithBackoffOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryOn?: (error: unknown) => boolean;
  readonly breaker?: CircuitBreaker;
  readonly respectOpenState?: boolean;
}

export interface CircuitBreakerOptions {
  readonly name?: string;
  readonly failureThreshold?: number;
  readonly resetTimeoutMs?: number;
  readonly now?: () => number;
}

export interface CircuitBreakerSnapshot {
  readonly name: string;
  readonly isOpen: boolean;
  readonly consecutiveFailures: number;
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly openedAtMs: number | null;
  readonly nextAttemptAtMs: number | null;
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private openedAtMs: number | null = null;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? 'api';
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
    this.resetTimeoutMs = Math.max(1_000, options.resetTimeoutMs ?? 30_000);
    this.now = options.now ?? (() => Date.now());
  }

  isOpen(): boolean {
    if (this.openedAtMs === null) {
      return false;
    }

    if (this.now() - this.openedAtMs >= this.resetTimeoutMs) {
      this.openedAtMs = null;
      this.consecutiveFailures = 0;
      return false;
    }

    return true;
  }

  throwIfOpen(): void {
    if (!this.isOpen()) {
      return;
    }

    throw new CircuitBreakerOpenError(
      `Circuit breaker "${this.name}" is open`
    );
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openedAtMs = this.now();
    }
  }

  getSnapshot(): CircuitBreakerSnapshot {
    const open = this.isOpen();
    return {
      name: this.name,
      isOpen: open,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      openedAtMs: open ? this.openedAtMs : null,
      nextAttemptAtMs:
        open && this.openedAtMs !== null
          ? this.openedAtMs + this.resetTimeoutMs
          : null,
    };
  }
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryWithBackoffOptions
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts);
  const baseDelayMs = Math.max(0, options.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs);
  const retryOn = options.retryOn ?? isRetryableApiError;

  if (options.respectOpenState ?? true) {
    options.breaker?.throwIfOpen();
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await fn(attempt);
      options.breaker?.recordSuccess();
      return result;
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < maxAttempts && retryOn(error);
      if (!shouldRetry) {
        options.breaker?.recordFailure();
        throw error;
      }

      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  options.breaker?.recordFailure();
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function isRetryableApiError(error: unknown): boolean {
  const status = extractStatusCode(error);
  if (status !== null) {
    if ([400, 401, 403].includes(status)) {
      return false;
    }
    if ([429, 502, 503, 504].includes(status)) {
      return true;
    }
  }

  const code = extractErrorCode(error);
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) {
    return true;
  }

  const message = extractErrorMessage(error).toLowerCase();
  if (!message) {
    return false;
  }
  if (
    message.includes('insufficient balance') ||
    message.includes('not enough balance') ||
    message.includes('allowance') ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  ) {
    return false;
  }

  return (
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('bad gateway') ||
    message.includes('gateway timeout') ||
    message.includes('service unavailable') ||
    message.includes('timeout') ||
    message.includes('temporarily unavailable') ||
    message.includes('socket hang up')
  );
}

function extractStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const record = error as Record<string, unknown>;
  const directStatus = normalizeFiniteInteger(record.status ?? record.statusCode);
  if (directStatus !== null) {
    return directStatus;
  }

  if (record.response && typeof record.response === 'object') {
    return normalizeFiniteInteger(
      (record.response as Record<string, unknown>).status ??
        (record.response as Record<string, unknown>).statusCode
    );
  }

  return null;
}

function extractErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : null;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return String(error ?? '');
}

function normalizeFiniteInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
