import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Response, Log, LogLevel } from 'miniflare';
import { manifestFor } from '../src/storage-format.js';
import { task } from './fakes.js';

test('workerd SQLite Durable Object: migration, concurrent updates, scheduling, rollback', async () => {
  const taskRequests = [];
  const mf = new Miniflare({
    modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2024-01-01',
    durableObjects: { SCHEDULER_STORE: { className: 'SchedulerStore', useSQLite: true } },
    kvNamespaces: ['TASKS_KV'], bindings: { API_KEY: 'local-test-key' },
    log: new Log(LogLevel.ERROR),
    // All outgoing fetches terminate here, including unanticipated destinations.
    outboundService: request => { taskRequests.push(request.url); return new Response('mock-only'); },
  });
  try {
    const api = async (path, method = 'GET', body) => {
      const response = await mf.dispatchFetch(`https://local.invalid${path}`, {
        method, headers: { 'X-API-Key': 'local-test-key', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200);
      return (await response.json()).data;
    };
    const kv = await mf.getKVNamespace('TASKS_KV');
    const initial = task('runtime', { cron: '0 0 5 11 *', headers: { Authorization: 'mock-credential' } });
    await kv.put('task:runtime', JSON.stringify(initial));
    const candidate = await api('/api/admin/migration/prepare', 'POST', {
      sourceFrozen: true, expected: await manifestFor([initial]),
    });
    await api('/api/admin/migration/commit', 'POST', { sourceFrozen: true, id: candidate.id });
    await Promise.all(Array.from({ length: 12 }, (_, i) => api('/api/tasks/runtime', 'PUT', { [`field${i}`]: i })));
    const current = await api('/api/tasks/runtime');
    for (let i = 0; i < 12; i++) assert.equal(current[`field${i}`], i);
    const boundWorker = await mf.getWorker();
    const result = await boundWorker.scheduled({ scheduledTime: Date.parse('2026-11-04T16:00:00Z'), cron: '* * * * *' });
    assert.equal(result.outcome, 'ok');
    assert.equal(taskRequests.length, 1);
    const frozen = await api('/api/admin/rollback/prepare', 'POST', {});
    await api('/api/admin/rollback/restore', 'POST', { id: frozen.id });
    const restored = JSON.parse(await kv.get('task:runtime'));
    for (let i = 0; i < 12; i++) assert.equal(restored[`field${i}`], i);
  } finally { await mf.dispose(); }
});
