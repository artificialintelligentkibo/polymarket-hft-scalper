import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { IndicatorClient, serializeRb } from '../src/indicator-client.js';

interface MockState {
  levels: Record<string, unknown>;
  events: Record<string, unknown[]>;
  failNext: boolean;
  timeoutNext: boolean;
  requestCount: number;
}

function startMockServer(state: MockState): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      state.requestCount += 1;
      if (state.timeoutNext) {
        state.timeoutNext = false;
        // hang until client aborts
        await new Promise((r) => setTimeout(r, 3000));
        res.end();
        return;
      }
      if (state.failNext) {
        state.failNext = false;
        res.statusCode = 500;
        res.end('err');
        return;
      }
      const url = req.url ?? '';
      const m = url.match(/^\/levels\/([A-Z]+)$/);
      if (m) {
        const sym = m[1]!;
        const body = state.levels[sym];
        if (body === undefined) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'unknown' }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
        return;
      }
      const m2 = url.match(/^\/events\/([A-Z]+)/);
      if (m2) {
        const sym = m2[1]!;
        const list = state.events[sym] ?? [];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(list));
        return;
      }
      res.statusCode = 404;
      res.end('nope');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      const url = `http://127.0.0.1:${port}`;
      const close = () =>
        new Promise<void>((r) => {
          server.close(() => r());
        });
      resolve({ url, close });
    });
  });
}

function sampleLevels(sym: string, overrides: Record<string, unknown> = {}) {
  return {
    symbol: sym,
    ts: Date.now(),
    lastBarCloseTs: Date.now() - 5000,
    fresh: true,
    barsProcessed: 600,
    value: 100,
    valueUpper: 102,
    valueLower: 98,
    valueUpperMid: 101,
    valueLowerMid: 99,
    trend: true,
    count: 0,
    lastCrossUpper: null,
    lastCrossLower: null,
    ...overrides,
  };
}

test('IndicatorClient populates cache and computes channelPos', async () => {
  const state: MockState = {
    levels: { BTCUSDT: sampleLevels('BTCUSDT') },
    events: { BTCUSDT: [] },
    failNext: false,
    timeoutNext: false,
    requestCount: 0,
  };
  const srv = await startMockServer(state);
  const client = new IndicatorClient({
    baseUrl: srv.url,
    symbols: ['BTCUSDT'],
    pollIntervalMs: 100,
    httpTimeoutMs: 500,
  });
  client.start();
  await new Promise((r) => setTimeout(r, 250));
  const snap = client.getSnapshot('BTC', 100);
  assert.equal(snap.available, true);
  assert.equal(snap.trend, 'UP');
  assert.equal(snap.value, 100);
  // price == value, width = 4, pos = (100 - 98)/4 = 0.5
  assert.equal(snap.channelPos, 0.5);
  assert.equal(snap.channelWidthPct, 4);
  client.stop();
  await srv.close();
});

test('channelPos is clamped [0,1] but channelPosRaw exposes overshoot', async () => {
  const state: MockState = {
    levels: { BTCUSDT: sampleLevels('BTCUSDT') },
    events: { BTCUSDT: [] },
    failNext: false,
    timeoutNext: false,
    requestCount: 0,
  };
  const srv = await startMockServer(state);
  const client = new IndicatorClient({
    baseUrl: srv.url,
    symbols: ['BTCUSDT'],
    pollIntervalMs: 100,
  });
  client.start();
  await new Promise((r) => setTimeout(r, 250));
  // price = 110 → above upper 102, pos raw = (110-98)/4 = 3
  const snap = client.getSnapshot('BTC', 110);
  assert.equal(snap.channelPos, 1);
  assert.ok(snap.channelPosRaw > 1);
  client.stop();
  await srv.close();
});

test('events are captured and lastEvent attached to snapshot', async () => {
  const now = Date.now();
  const state: MockState = {
    levels: { BTCUSDT: sampleLevels('BTCUSDT') },
    events: {
      BTCUSDT: [
        { ts: now - 5000, symbol: 'BTCUSDT', eventType: 'bull_break', price: 101, levelRef: 102 },
        { ts: now - 1000, symbol: 'BTCUSDT', eventType: 'fakeout_up', price: 102.5, levelRef: 102 },
      ],
    },
    failNext: false,
    timeoutNext: false,
    requestCount: 0,
  };
  const srv = await startMockServer(state);
  const client = new IndicatorClient({
    baseUrl: srv.url,
    symbols: ['BTCUSDT'],
    pollIntervalMs: 100,
  });
  client.start();
  await new Promise((r) => setTimeout(r, 250));
  const snap = client.getSnapshot('BTC', 100);
  assert.equal(snap.lastEvent?.type, 'fakeout_up');
  assert.ok(snap.lastEvent !== null && snap.lastEvent.ageMs > 0);
  client.stop();
  await srv.close();
});

test('getSnapshot returns available=false when service unreachable', async () => {
  // never start server
  const client = new IndicatorClient({
    baseUrl: 'http://127.0.0.1:1', // will ECONNREFUSED
    symbols: ['BTCUSDT'],
    pollIntervalMs: 100,
    httpTimeoutMs: 200,
  });
  client.start();
  await new Promise((r) => setTimeout(r, 250));
  const snap = client.getSnapshot('BTC', 100);
  assert.equal(snap.available, false);
  assert.equal(snap.trend, null);
  client.stop();
});

test('getSnapshot never throws on unknown coin', () => {
  const client = new IndicatorClient({
    baseUrl: 'http://127.0.0.1:1',
    symbols: ['BTCUSDT'],
  });
  const snap = client.getSnapshot('UNKNOWNCOIN', 100);
  assert.equal(snap.available, false);
});

test('server 500 is tolerated, next successful poll repopulates', async () => {
  const state: MockState = {
    levels: { BTCUSDT: sampleLevels('BTCUSDT') },
    events: { BTCUSDT: [] },
    failNext: true,
    timeoutNext: false,
    requestCount: 0,
  };
  const srv = await startMockServer(state);
  const client = new IndicatorClient({
    baseUrl: srv.url,
    symbols: ['BTCUSDT'],
    pollIntervalMs: 100,
    httpTimeoutMs: 500,
  });
  client.start();
  await new Promise((r) => setTimeout(r, 400));
  const snap = client.getSnapshot('BTC', 100);
  assert.equal(snap.available, true, 'should recover after 500');
  client.stop();
  await srv.close();
});

test('serializeRb rounds floats and strips heavy fields', () => {
  const client = new IndicatorClient({ baseUrl: 'http://1', symbols: [] });
  const snap = client.getSnapshot('BTC', 100);
  const s = serializeRb(snap);
  assert.equal(s.available, false);
  assert.equal(s.trend, null);
  assert.equal(s.lastEventType, null);
});
