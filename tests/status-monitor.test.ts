import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { extractRelevantIncidents, StatusMonitor } from '../src/status-monitor.js';
import { sleep } from '../src/utils.js';

test('extractRelevantIncidents keeps only Polymarket-impacting incidents', () => {
  const incidents = extractRelevantIncidents({
    activeIncidents: [
      {
        id: 'incident-1',
        title: 'CLOB order confirmation delays',
        updated_at: '2026-03-21T10:00:00.000Z',
      },
      {
        id: 'incident-2',
        title: 'Marketing banner issue',
      },
    ],
  });

  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.id, 'incident-1');
  assert.equal(incidents[0]?.matchedKeywords.includes('clob'), true);
});

test('StatusMonitor pauses on incident and resumes after grace period', async () => {
  let incidentActive = true;
  const runtimeConfig = createConfig({
    ...process.env,
    STATUS_CHECK_INTERVAL_MS: '300000',
    AUTO_PAUSE_ON_INCIDENT: 'true',
    PAUSE_GRACE_PERIOD_MS: '10',
  });
  const monitor = new StatusMonitor(
    runtimeConfig,
    async () =>
      new Response(
        JSON.stringify({
          activeIncidents: incidentActive
            ? [{ id: 'incident-1', title: 'API latency outage' }]
            : [],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
  );

  const events: string[] = [];
  monitor.on('pause', () => events.push('pause'));
  monitor.on('resume', () => events.push('resume'));

  await monitor.checkNow();
  assert.equal(monitor.isPaused(), true);

  incidentActive = false;
  await monitor.checkNow();
  await sleep(20);

  assert.equal(monitor.isPaused(), false);
  assert.deepEqual(events, ['pause', 'resume']);
});
