import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Response, Log, LogLevel } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORE_NAME, makeSnapshot, manifestFor } from '../src/storage-format.js';
import { SQL_LEGACY_GUARD } from '../src/sql-task-storage.js';
import { task } from './fakes.js';

test('workerd SQLite Durable Object: migration, concurrent updates, scheduling, rollback', async () => {
  const taskRequests = [];
  const mf = new Miniflare({
    modules: true, scriptPath: 'test/runtime-entry.mjs', compatibilityDate: '2024-01-01',
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
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
    const ns = await mf.getDurableObjectNamespace('SCHEDULER_STORE');
    const object = ns.get(ns.idFromName(STORE_NAME));
    const inspection = await object.fetch('https://local.invalid/__test/query', { method: 'POST',
      body: JSON.stringify({ query: 'SELECT id, cron, enabled, config_json FROM tasks' }) });
    const rows = await inspection.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'runtime');
    assert.equal(rows[0].cron, initial.cron);
    assert.equal(rows[0].enabled, 1);
    assert.deepEqual(JSON.parse(rows[0].config_json), current);
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

test('workerd atomically upgrades current DO KV to explicit SQL and keeps latest rows after process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scheduler-sql-test-'));
  let outboundCalls = 0;
  const options = {
    modules: true, scriptPath: 'test/runtime-entry.mjs', compatibilityDate: '2024-01-01',
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    durableObjects: { SCHEDULER_STORE: { className: 'SchedulerStore', useSQLite: true } },
    durableObjectsPersist: join(directory, 'do'), kvPersist: join(directory, 'kv'),
    kvNamespaces: ['TASKS_KV'], bindings: { API_KEY: 'local-test-key' }, log: new Log(LogLevel.ERROR),
    outboundService: () => { outboundCalls++; return new Response('mock-only'); },
  };
  let mf = new Miniflare(options);
  const internal = async (path, body) => {
    const ns = await mf.getDurableObjectNamespace('SCHEDULER_STORE');
    const response = await ns.get(ns.idFromName(STORE_NAME)).fetch(`https://local.invalid${path}`, {
      method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    // Real workerd, not just the fake: SQL DDL/rows and storage KV roll back together.
    assert.deepEqual((await internal('/__test/atomicity')).value, { tables: [], kvExists: false });
    const tasks = [task('newest', { extra: { unknown: [1, null, false] } }), task('second', { enabled: false })];
    const record = { mode: 'active', migrationId: 'existing', knownTaskIds: ['newest', 'second', 'retired'],
      snapshot: await makeSnapshot(tasks, 23) };
    await internal('/__test/seed', { record });
    const failed = await internal('/__test/failed-upgrade');
    assert.equal(failed.status, 503);
    assert.equal(failed.value.code, 'STORAGE_UNAVAILABLE');
    const keys = (await internal('/__test/keys')).value;
    assert.deepEqual(Object.keys(keys), ['scheduler:tasks:v1']);
    assert.deepEqual(keys['scheduler:tasks:v1'], record);
    assert.deepEqual((await internal('/__test/query', {
      query: "SELECT name FROM sqlite_master WHERE name IN ('tasks', 'scheduler_state', 'scheduler_schema')",
    })).value, []);
    assert.deepEqual((await internal('/tasks')).value.data, record.snapshot);
    const rows = (await internal('/__test/query', { query: 'SELECT id, enabled, config_json FROM tasks ORDER BY position' })).value;
    assert.deepEqual(rows.map(row => JSON.parse(row.config_json)), tasks);
    assert.equal(rows[1].enabled, 0);
    const response = await mf.dispatchFetch('https://local.invalid/api/tasks/newest', {
      method: 'PUT', headers: { 'X-API-Key': 'local-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'latest SQL name', enabled: false }),
    });
    assert.equal(response.status, 200);
    const latest = (await internal('/tasks')).value.data;
    assert.equal(latest.revision, 24);
    await mf.dispose();
    mf = new Miniflare(options); // Actual fresh workerd using persisted SQLite.
    assert.deepEqual((await internal('/tasks')).value.data, latest);
    assert.deepEqual((await internal('/__test/keys')).value['scheduler:tasks:v1'], SQL_LEGACY_GUARD);
    assert.deepEqual((await internal('/__test/keys')).value['scheduler:sql:v2:legacy-backup'].record, record);
    assert.equal(outboundCalls, 0);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
