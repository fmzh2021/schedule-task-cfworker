import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { SQLTaskStorage } from '../src/sql-task-storage.js';
import { EDITABLE_BACKUP_KEY, EDITABLE_MARKER_KEY } from '../src/editable-task-storage.js';
import { STORE_NAME, TASKS_KEY, makeSnapshot, sha256 } from '../src/storage-format.js';
import { harness, task, context } from './fakes.js';

const saved = { log: console.log, error: console.error, fetch: globalThis.fetch };
let calls, logs;
beforeEach(() => {
  calls = []; logs = [];
  console.log = console.error = (...args) => logs.push(args.join(' '));
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response('mock-only'); };
});
after(() => { console.log = saved.log; console.error = saved.error; globalThis.fetch = saved.fetch; });

async function request(h, path = '/tasks', method = 'GET', body) {
  const ns = h.env.SCHEDULER_STORE;
  const response = await ns.get(ns.idFromName(STORE_NAME)).fetch(`https://scheduler.internal${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, ...await response.json() };
}
async function seed(tasks = [task('edit')]) {
  const h = harness();
  const record = { mode: 'active', migrationId: 'original', knownTaskIds: [...tasks.map(t => t.id), 'retired'],
    snapshot: await makeSnapshot(tasks, 5) };
  await h.storage.put(TASKS_KEY, record);
  return { h, record };
}
const sql = (h, statement, ...bindings) => h.storage.sql.exec(statement, ...bindings).toArray();
const tick = async h => {
  const ctx = context();
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-05T00:10:00Z') }, h.env, ctx);
  await ctx.drain();
};
const noKV = h => assert.deepEqual(h.kv.calls, { get: 0, list: 0, put: 0, delete: 0 });

test('v2 upgrades its latest SQL state to editable v3 with complete backup and no revision change', async () => {
  const { h } = await seed([task('edit', { unknown: { nested: [true, null] }, body: false })]);
  const legacy = new SQLTaskStorage(h.storage);
  await legacy.ensure();
  let latest;
  await h.storage.transaction(async () => {
    latest = await legacy.read();
    latest.snapshot.tasks[0].name = 'latest-v2';
    latest.snapshot = await makeSnapshot(latest.snapshot.tasks, 8);
    legacy.write(latest);
  });
  assert.deepEqual((await request(h)).data, latest.snapshot);
  const backup = await h.storage.get(EDITABLE_BACKUP_KEY);
  assert.deepEqual(backup.record, latest);
  assert.equal(backup.sha256, await sha256(latest));
  assert.equal(sql(h, 'SELECT body_json FROM tasks')[0].body_json, 'false');
  assert.equal((await request(h, '/admin/status')).data.dataStudioEditing, true);
  noKV(h);
});

test('editable migration failure restores v2 tables and backup state; retry is complete and idempotent', async () => {
  const { h, record } = await seed();
  const legacy = new SQLTaskStorage(h.storage);
  await legacy.ensure();
  h.storage.beforeSQL = query => { if (query.startsWith('CREATE TRIGGER tasks_json')) throw new Error('provider-secret'); };
  assert.equal((await request(h)).code, 'STORAGE_UNAVAILABLE');
  h.storage.beforeSQL = undefined;
  assert.equal(legacy.schema().version, 2);
  assert.deepEqual((await legacy.read()).snapshot, record.snapshot);
  assert.equal(await h.storage.get(EDITABLE_BACKUP_KEY), undefined);
  assert.equal(await h.storage.get(EDITABLE_MARKER_KEY), undefined);
  assert.deepEqual((await request(h)).data, record.snapshot);
  h.reboot();
  assert.deepEqual((await request(h)).data, record.snapshot);
  noKV(h);
});

for (const recursive of [false, true]) {
  test(`Data Studio multi-column edit syncs JSON/API/scheduled time with recursive_triggers=${recursive}`, async () => {
    const original = task('edit', { cron: '30 * * * *', unknown: { nested: 'preserved' } });
    const { h } = await seed([original]);
    await request(h);
    sql(h, `PRAGMA recursive_triggers = ${recursive ? 'ON' : 'OFF'}`);
    sql(h, 'UPDATE tasks SET name = ?, cron = ?, enabled = ?, method = ?, headers_json = ?, body_json = ? WHERE id = ?',
      'edited name', '10 8 * * *', 1, 'POST', '{"Authorization":"credential-sentinel"}', '{"value":[true,null,3]}', 'edit');
    const row = sql(h, 'SELECT * FROM tasks')[0];
    const config = JSON.parse(row.config_json);
    assert.equal(config.name, 'edited name');
    assert.equal(config.cron, '10 8 * * *');
    assert.equal(config.enabled, true);
    assert.equal(config.method, 'POST');
    assert.deepEqual(config.headers, { Authorization: 'credential-sentinel' });
    assert.deepEqual(config.body, { value: [true, null, 3] });
    assert.deepEqual(config.unknown, original.unknown);
    const first = (await request(h)).data;
    assert.deepEqual(first.tasks[0], config);
    assert.equal(first.revision, 6);
    assert.deepEqual((await request(h)).data, first); // Reading again must not bump revision.
    await tick(h);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.Authorization, 'credential-sentinel');
    sql(h, 'UPDATE tasks SET enabled = 0 WHERE id = ?', 'edit');
    h.reboot();
    await tick(h);
    assert.equal(calls.length, 1);
    assert.equal((await request(h)).data.tasks[0].enabled, false);
    assert.ok(!logs.join('\n').includes('credential-sentinel'));
    noKV(h);
  });
}

test('full JSON editing also refreshes physical columns; next API patch preserves independent SQL changes', async () => {
  const { h } = await seed();
  await request(h);
  sql(h, "UPDATE tasks SET config_json = json_set(config_json, '$.cron', '10 8 * * *', '$.enabled', json('false'), '$.extra', 123)");
  assert.equal(sql(h, 'SELECT cron, enabled FROM tasks')[0].cron, '10 8 * * *');
  assert.equal(sql(h, 'SELECT cron, enabled FROM tasks')[0].enabled, 0);
  await request(h, '/task?id=edit', 'PUT', { name: 'api-edit' });
  const current = (await request(h)).data;
  assert.equal(current.tasks[0].extra, 123);
  assert.equal(current.tasks[0].cron, '10 8 * * *');
  assert.equal(current.tasks[0].enabled, false);
  assert.equal(current.tasks[0].name, 'api-edit');
  assert.equal(current.revision, 7); // One observed SQL revision, then one API revision.
  noKV(h);
});

test('JSON null, booleans, numbers, strings and absent optional fields retain their meanings', async () => {
  const minimal = { id: 'edit', url: 'https://task.invalid', cron: '* * * * *', unknown: null, name: { legacy: true } };
  const { h } = await seed([minimal]);
  await request(h);
  for (const body of [null, false, true, 0, 'text', [1, false], { x: null }]) {
    sql(h, 'UPDATE tasks SET body_json = ?, method = ? WHERE id = ?', JSON.stringify(body), 'POST', 'edit');
    const current = (await request(h)).data.tasks[0];
    assert.deepEqual(current.body, body);
    assert.deepEqual(current.name, minimal.name);
    assert.equal(current.unknown, null);
    assert.equal(current.enabled, undefined);
    assert.equal(sql(h, 'SELECT body_json FROM tasks')[0].body_json, JSON.stringify(body));
  }
  sql(h, 'UPDATE tasks SET body_json = NULL, method = NULL');
  const current = (await request(h)).data.tasks[0];
  assert.equal(Object.hasOwn(current, 'body'), false);
  assert.equal(Object.hasOwn(current, 'method'), false);
  noKV(h);
});

test('conflicting JSON/column updates, malformed JSON and identity changes fail atomically', async () => {
  const { h } = await seed();
  await request(h);
  assert.throws(() => sql(h, "UPDATE tasks SET cron = '10 * * * *', config_json = json_set(config_json, '$.cron', '30 * * * *')"));
  assert.throws(() => sql(h, "UPDATE tasks SET headers_json = '[]'"));
  assert.throws(() => sql(h, "UPDATE tasks SET body_json = 'bad-json'"));
  assert.throws(() => sql(h, "UPDATE tasks SET config_json = '{bad'"));
  assert.throws(() => sql(h, "UPDATE tasks SET enabled = 7"));
  assert.throws(() => sql(h, "UPDATE tasks SET id = 'another'"));
  assert.throws(() => sql(h, 'UPDATE tasks SET cron = NULL'));
  const before = (await request(h)).data;
  assert.equal(before.revision, 5);
  sql(h, "UPDATE tasks SET cron = '10 * * * *', config_json = json_set(config_json, '$.cron', '10 * * * *')");
  assert.equal((await request(h)).data.tasks[0].cron, '10 * * * *');
  noKV(h);
});

test('direct insert/delete tracks historical IDs, gaps, legitimate empty collection and latest rollback', async () => {
  const { h } = await seed([task('a'), task('b')]);
  await request(h);
  const added = task('new', { headers: { Authorization: 'latest-secret' } });
  sql(h, 'INSERT INTO tasks (id, position, config_json) VALUES (?, ?, ?)', 'new', 5, JSON.stringify(added));
  sql(h, 'DELETE FROM tasks WHERE id = ?', 'b');
  const current = (await request(h)).data;
  assert.deepEqual(current.tasks.map(t => t.id), ['a', 'new']);
  assert.ok(JSON.parse(sql(h, 'SELECT known_task_ids_json FROM scheduler_state')[0].known_task_ids_json).includes('new'));
  const frozen = await request(h, '/admin/rollback/prepare', 'POST', {});
  assert.equal(frozen.status, 200);
  const backup = (await request(h, `/admin/backup?id=${frozen.data.id}`)).data;
  assert.deepEqual(backup.snapshot, current);
  assert.throws(() => sql(h, 'UPDATE tasks SET enabled = 0'), /WRITES_FROZEN/);
  assert.throws(() => sql(h, 'DELETE FROM tasks'), /WRITES_FROZEN/);
  assert.throws(() => sql(h, 'INSERT INTO tasks (id, position, config_json) VALUES (?, ?, ?)', 'blocked', 6, JSON.stringify(task('blocked'))), /WRITES_FROZEN/);
  await request(h, '/admin/rollback/resume', 'POST', {});
  sql(h, 'DELETE FROM tasks');
  assert.deepEqual((await request(h)).data.tasks, []);
  await tick(h);
  assert.equal(calls.length, 0);
  noKV(h);
});

test('dirty metadata reconciliation failure is visible and retryable; invalid configuration is never an empty collection', async () => {
  const { h } = await seed();
  await request(h);
  sql(h, "UPDATE tasks SET cron = '10 8 * * *'");
  h.storage.beforeSQL = query => { if (query.startsWith('UPDATE scheduler_state SET revision')) throw new Error('provider-secret'); };
  assert.equal((await request(h)).code, 'STORAGE_UNAVAILABLE');
  h.storage.beforeSQL = undefined;
  assert.equal((await request(h)).data.tasks[0].cron, '10 8 * * *');
  sql(h, "UPDATE tasks SET url = 'invalid-url'");
  assert.equal((await request(h)).code, 'DATA_CORRUPT');
  await assert.rejects(tick(h), { code: 'DATA_CORRUPT' });
  assert.equal(calls.length, 0);
  sql(h, "UPDATE tasks SET url = 'https://task.invalid/fixed'");
  assert.equal((await request(h)).data.tasks.length, 1);
  noKV(h);
});
