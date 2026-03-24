import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CircuitBreaker,
  retryWithBackoff,
  type CircuitBreakerOpenError,
} from '../src/api-retry.js';

test('retryWithBackoff succeeds on the third attempt for transient 503 errors', async () => {
  let attempts = 0;

  const result = await retryWithBackoff(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('service unavailable') as Error & { status?: number };
        error.status = 503;
        throw error;
      }

      return 'ok';
    },
    {
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
    }
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('circuit breaker opens after five consecutive terminal failures', async () => {
  const breaker = new CircuitBreaker({
    name: 'test',
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    now: () => 10_000,
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      retryWithBackoff(
        async () => {
          const error = new Error('bad gateway') as Error & { status?: number };
          error.status = 503;
          throw error;
        },
        {
          maxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          breaker,
          respectOpenState: false,
        }
      )
    );
  }

  const snapshot = breaker.getSnapshot();
  assert.equal(snapshot.isOpen, true);
  assert.equal(snapshot.consecutiveFailures, 5);

  await assert.rejects(
    retryWithBackoff(
      async () => 'never',
      {
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        breaker,
      }
    ),
    (error: unknown) =>
      error instanceof Error &&
      (error as CircuitBreakerOpenError).name === 'CircuitBreakerOpenError'
  );
});
