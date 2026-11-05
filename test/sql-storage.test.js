import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE_NAME, TASKS_KEY, makeSnapshot, sha256, validateRecord } from '../src/storage-format.js';
import { SQL_BACKUP_KEY, SQL_LEGACY_GUARD, SQL_MARKER_KEY } from '../src/sql-task-storage.js';
import { harness, task } from './fakes.js';

const originalConsole = { log: console.log, error: console.error };
let logs;
beforeEach(() => {
  logs = [];
  for (const method of ['log', 'error']) console[method] = (...args) => logs.push(args.join(' '));
});
after(() => Object.assign(console, originalConsole));

async function request(h, path = '/tasks', method = 'GET', body) {
  const ns = h.env.SCHEDULER_STORE;
  const response = await ns.get(ns.idFromName(STORE_NAME)).fetch(`https://scheduler.internal${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, ...await response.json() };
}
async function seed(tasks = [task('current')], overrides = {}) {
  // Simulates the CURRENT authoritative DO, not the stale original TASKS_KV.
  const h = harness([task('stale')]);
  const record = { mode: 'active', migrationId: 'original-migration',
    knownTaskIds: [...tasks.map(task => task.id), 'retired'], snapshot: await makeSnapshot(tasks, 17), ...overrides };
  await h.storage.put(TASKS_KEY, record);
  return { h, record };
}
const noKV = h => assert.deepEqual(h.kv.calls, { get: 0, list: 0, put: 0, delete: 0 });
const tables = h => h.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray();

test('existing DO snapshot upgrades to one SQL row per task without changing complete fields or metadata', async () => {
  const minimal = { id: 'minimal', url: 'https://task.invalid', cron: '* * * * *' };
  const tasks = [task('current', { headers: { Authorization: 'credential-sentinel' },
    body: 'body-sentinel', extra: { nested: [1, null, false], arbitrary: '保留' } }), minimal];
  const { h, record } = await seed(tasks);
  h.kv.fail = '*';
  const result = await request(h);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, record.snapshot);
  const rows = h.storage.sql.exec('SELECT * FROM tasks ORDER BY position').toArray();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => JSON.parse(row.config_json)), tasks);
  assert.equal(rows[0].name, 'current');
  assert.equal(rows[0].cron, '* * * * *');
  assert.equal(rows[0].enabled, 1);
  assert.equal(rows[1].enabled, null); // Missing remains missing in config_json.
  assert.equal(rows[1].method, null);
  assert.deepEqual(await h.storage.get(TASKS_KEY), SQL_LEGACY_GUARD);
  await assert.rejects(validateRecord(await h.storage.get(TASKS_KEY)), { code: 'DATA_CORRUPT' });
  const backup = await h.storage.get(SQL_BACKUP_KEY);
  assert.deepEqual(backup.record, record);
  assert.equal(backup.sha256, await sha256(record));
  assert.deepEqual(await h.storage.get(SQL_MARKER_KEY), { version: 2 });
  const state = h.storage.sql.exec('SELECT * FROM scheduler_state').toArray()[0];
  assert.equal(state.revision, 17);
  assert.deepEqual(JSON.parse(state.known_task_ids_json), record.knownTaskIds);
  assert.equal((await request(h, '/admin/status')).data.schemaVersion, 2);
  assert.ok(!logs.join('\n').includes('credential-sentinel'));
  assert.ok(!logs.join('\n').includes('body-sentinel'));
  noKV(h);
});

test('SQL CRUD survives actor restart and never reimports the retained stale DO backup', async () => {
  const { h, record } = await seed();
  await request(h);
  await request(h, '/task?id=current', 'PUT', { enabled: false, extra: 'latest' });
  await request(h, '/task', 'POST', task('new'));
  await request(h, '/task?id=current', 'DELETE');
  h.reboot();
  const current = await request(h);
  assert.deepEqual(current.data.tasks.map(task => task.id), ['new']);
  assert.equal(current.data.revision, record.snapshot.revision + 3);
  assert.deepEqual(await h.storage.get(TASKS_KEY), SQL_LEGACY_GUARD);
  assert.deepEqual((await h.storage.get(SQL_BACKUP_KEY)).record, record);
  noKV(h);
});

test('auto-upgrade preserves legitimate empty collection and revision', async () => {
  const { h, record } = await seed([]);
  assert.deepEqual((await request(h)).data, record.snapshot);
  assert.equal(h.storage.sql.exec('SELECT count(*) AS n FROM tasks').toArray()[0].n, 0);
  assert.equal((await request(h, '/admin/status')).data.migrated, true);
  noKV(h);
});

for (const mode of ['rollback-frozen', 'rollback-ready']) {
  test(`auto-upgrade preserves ${mode} and blocks writes until explicit resume`, async () => {
    const { h } = await seed(undefined, { mode, rollbackId: 'frozen-backup' });
    assert.equal((await request(h, '/admin/status')).data.mode, mode);
    assert.equal(h.storage.sql.exec('SELECT rollback_id FROM scheduler_state').toArray()[0].rollback_id, 'frozen-backup');
    assert.equal((await request(h, '/task', 'POST', task('blocked'))).code, 'WRITES_FROZEN');
    assert.equal((await request(h, '/admin/rollback/resume', 'POST', {})).data.mode, 'active');
    assert.equal((await request(h, '/task', 'POST', task('allowed'))).status, 200);
    noKV(h);
  });
}

test('fresh DO remains explicitly NOT_MIGRATED with empty SQL schema', async () => {
  const h = harness();
  assert.equal((await request(h)).code, 'NOT_MIGRATED');
  assert.deepEqual(h.storage.sql.exec('SELECT * FROM tasks').toArray(), []);
  assert.equal(h.storage.sql.exec('SELECT initialized FROM scheduler_schema').toArray()[0].initialized, 0);
  assert.equal(await h.storage.get(SQL_BACKUP_KEY), undefined);
  noKV(h);
});

test('corrupt current DO data fails before creating or activating SQL tables', async () => {
  const { h, record } = await seed();
  record.snapshot.tasks[0].headers = { Authorization: 'corrupt-sentinel' };
  await h.storage.put(TASKS_KEY, record);
  assert.equal((await request(h)).code, 'DATA_CORRUPT');
  assert.deepEqual(tables(h), []);
  assert.equal(await h.storage.get(SQL_BACKUP_KEY), undefined);
  assert.equal(await h.storage.get(SQL_MARKER_KEY), undefined);
  assert.ok(!logs.join('\n').includes('corrupt-sentinel'));
  noKV(h);
});

test('mid-upgrade failure rolls back SQL DDL, partial rows, DO backup and marker; retry uses intact source', async () => {
  const { h, record } = await seed([task('a'), task('b')]);
  let inserts = 0;
  h.storage.beforeSQL = query => {
    if (query.startsWith('INSERT INTO tasks') && ++inserts === 2) throw new Error('provider-secret');
  };
  assert.equal((await request(h)).code, 'STORAGE_UNAVAILABLE');
  assert.deepEqual(tables(h), []);
  assert.deepEqual(await h.storage.get(TASKS_KEY), record);
  assert.equal(await h.storage.get(SQL_BACKUP_KEY), undefined);
  assert.equal(await h.storage.get(SQL_MARKER_KEY), undefined);
  h.storage.beforeSQL = undefined;
  assert.deepEqual((await request(h)).data, record.snapshot);
  noKV(h);
});

test('SQL mutation failure restores every old row and metadata atomically', async () => {
  const { h, record } = await seed([task('a'), task('b')]);
  await request(h);
  h.storage.beforeSQL = query => {
    if (query.startsWith('INSERT OR REPLACE INTO scheduler_state')) throw new Error('provider-secret');
  };
  assert.equal((await request(h, '/task?id=a', 'DELETE')).code, 'STORAGE_UNAVAILABLE');
  h.storage.beforeSQL = undefined;
  h.reboot();
  assert.deepEqual((await request(h)).data, record.snapshot);
  noKV(h);
});

test('activation-marker write failure also restores the original legacy key, backup and complete SQL schema', async () => {
  const { h, record } = await seed();
  const transaction = h.storage.transaction.bind(h.storage);
  h.storage.transaction = callback => transaction(async tx => {
    const put = tx.put.bind(tx);
    tx.put = (key, value) => {
      if (key === SQL_MARKER_KEY) throw new Error('provider-secret');
      return put(key, value);
    };
    return callback(tx);
  });
  assert.equal((await request(h)).code, 'STORAGE_UNAVAILABLE');
  assert.deepEqual(tables(h), []);
  assert.deepEqual(await h.storage.get(TASKS_KEY), record);
  assert.equal(await h.storage.get(SQL_BACKUP_KEY), undefined);
  assert.equal(await h.storage.get(SQL_MARKER_KEY), undefined);
  h.storage.transaction = transaction;
  assert.deepEqual((await request(h)).data, record.snapshot);
  noKV(h);
});

for (const damage of ['deleted-row', 'deleted-state', 'dropped-tasks', 'dropped-all', 'changed-json', 'bad-marker']) {
  test(`SQL ${damage} is DATA_CORRUPT without fallback to old DO or Workers KV`, async () => {
    const { h } = await seed();
    await request(h);
    if (damage === 'deleted-row') h.storage.sql.exec('DELETE FROM tasks');
    if (damage === 'deleted-state') h.storage.sql.exec('DELETE FROM scheduler_state');
    if (damage === 'dropped-tasks') h.storage.sql.exec('DROP TABLE tasks');
    if (damage === 'dropped-all') {
      for (const table of ['tasks', 'scheduler_state', 'scheduler_schema']) h.storage.sql.exec(`DROP TABLE ${table}`);
    }
    if (damage === 'changed-json') h.storage.sql.exec("UPDATE tasks SET config_json = json_set(config_json, '$.name', 'edited')");
    if (damage === 'bad-marker') await h.storage.put(SQL_MARKER_KEY, { version: 999 });
    h.reboot();
    assert.equal((await request(h)).code, 'DATA_CORRUPT');
    noKV(h);
  });
}

test('SQL tables without durable activation marker do not trigger stale reimport', async () => {
  const { h } = await seed();
  await request(h);
  await h.storage.delete(SQL_MARKER_KEY);
  h.reboot();
  assert.equal((await request(h)).code, 'DATA_CORRUPT');
  noKV(h);
});
