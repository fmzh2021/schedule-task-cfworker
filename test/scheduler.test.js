import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { executeTask } from '../src/index.js';
import { canonical, manifestFor } from '../src/storage-format.js';
import { harness, context, task } from './fakes.js';

const originalFetch = globalThis.fetch;
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
let calls, logs;
beforeEach(() => {
  calls = []; logs = [];
  for (const method of ['log', 'warn', 'error']) console[method] = (...args) => logs.push(args.join(' '));
  globalThis.fetch = async (url, options) => {
    // Every external task request is mocked; never delegate to real fetch.
    calls.push({ url, options });
    return new Response('response-secret', { status: 200 });
  };
});
after(() => { globalThis.fetch = originalFetch; Object.assign(console, originalConsole); });

async function api(h, path, method = 'GET', body, auth = { 'X-API-Key': 'test-api-key' }) {
  const ctx = context();
  const response = await worker.fetch(new Request(`https://scheduler.invalid${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), h.env, ctx);
  return { status: response.status, value: await response.json(), ctx, headers: response.headers };
}
async function prepare(h, tasks) {
  return api(h, '/api/admin/migration/prepare', 'POST', {
    sourceFrozen: true, expected: await manifestFor(tasks), ...(tasks.length ? {} : { allowEmpty: true }),
  });
}
async function migrated(tasks = []) {
  const h = harness(tasks);
  const prepared = await prepare(h, tasks);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
  const result = await api(h, '/api/admin/migration/commit', 'POST', { sourceFrozen: true, id: prepared.value.data.id });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  h.kv.resetCounts();
  return h;
}
async function tick(h, scheduledTime, module = worker) {
  const ctx = context();
  await module.scheduled({ scheduledTime }, h.env, ctx);
  await ctx.drain();
}

test('1440 fresh Worker modules and DO restarts: zero KV operations', async t => {
  const h = await migrated([
    task('a', { cron: '0 * * * *' }), task('b', { cron: '10 * * * *' }), task('c', { cron: '30 * * * *' }),
  ]);
  const baseRequests = h.requests;
  const start = Date.parse('2026-11-04T00:00:00Z');
  for (let minute = 0; minute < 1440; minute++) {
    const fresh = await import(`../src/index.js?fresh=${minute}`);
    h.reboot(); // Even the DO actor is reconstructed from durable storage each minute.
    await tick(h, start + minute * 60000, fresh.default);
  }
  assert.deepEqual(h.kv.calls, { get: 0, list: 0, put: 0, delete: 0 });
  assert.equal(h.requests - baseRequests, 1440);
  assert.equal(calls.length, 72);
  t.diagnostic(JSON.stringify({ freshInstances: 1440, durableObjectRequests: 1440, kv: h.kv.calls, mockedTaskFetches: calls.length }));
});

test('CRUD fields, IDs, response shapes, immediate schedule visibility and empty collection', async () => {
  const h = await migrated();
  const created = await api(h, '/api/tasks', 'POST', task('new', { method: 'POST', headers: { Authorization: 'task-secret' },
    params: { x: 1 }, body: { hello: 'world' } }));
  assert.equal(created.status, 201);
  assert.equal(created.value.data.id, 'new');
  assert.deepEqual(created.value.data.body, { hello: 'world' });
  assert.equal((await api(h, '/api/tasks/new')).value.data.id, 'new');
  await tick(h, Date.parse('2026-11-04T00:00:00Z'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.body, '{"hello":"world"}');
  assert.equal((await api(h, '/api/tasks/new', 'PUT', { id: 'ignored', enabled: false })).value.data.id, 'new');
  await tick(h, Date.parse('2026-11-04T00:01:00Z'));
  assert.equal(calls.length, 1);
  const trigger = await api(h, '/api/tasks/new/trigger', 'POST');
  assert.equal(trigger.value.message, '任务已触发');
  await trigger.ctx.drain();
  assert.equal(calls.length, 2); // Disabled task remains manually triggerable.
  assert.equal((await api(h, '/api/tasks/new', 'DELETE')).value.message, '任务已删除');
  assert.equal((await api(h, '/api/tasks/new')).status, 404);
  assert.equal((await api(h, '/api/tasks/new', 'PUT', { name: 'no' })).status, 404);
  assert.equal((await api(h, '/api/tasks/new/trigger', 'POST')).status, 404);
  assert.equal((await api(h, '/api/tasks/new', 'DELETE')).status, 200);
  assert.deepEqual((await api(h, '/api/tasks')).value.data, []);
  await tick(h, Date.parse('2026-11-04T00:02:00Z'));
  assert.equal(calls.length, 2);
  assert.equal(h.kv.calls.list, 0);
});

test('concurrent creates, partial updates and deletes do not overwrite other changes', async () => {
  const h = await migrated([task('shared')]);
  const creates = await Promise.all(Array.from({ length: 30 }, (_, i) => api(h, '/api/tasks', 'POST', task(`c${i}`))));
  assert.ok(creates.every(result => result.status === 201));
  const updates = await Promise.all(Array.from({ length: 30 }, (_, i) => api(h, '/api/tasks/shared', 'PUT', { [`field${i}`]: i })));
  assert.ok(updates.every(result => result.status === 200));
  await Promise.all(Array.from({ length: 15 }, (_, i) => api(h, `/api/tasks/c${i}`, 'DELETE')));
  h.reboot();
  const all = (await api(h, '/api/tasks')).value.data;
  assert.equal(all.length, 16);
  const shared = all.find(value => value.id === 'shared');
  for (let i = 0; i < 30; i++) assert.equal(shared[`field${i}`], i);
  assert.equal(h.kv.calls.put, 0);
});

test('POST retains upsert behavior; generated IDs retain format', async () => {
  const h = await migrated([task('same')]);
  assert.equal((await api(h, '/api/tasks', 'POST', task('same', { name: 'replacement' }))).status, 201);
  assert.equal((await api(h, '/api/tasks')).value.data.length, 1);
  const body = task('unused'); delete body.id;
  const generated = await api(h, '/api/tasks', 'POST', body);
  assert.match(generated.value.data.id, /^task_\d+_[a-z0-9]+$/);
});

test('auth methods, public tools, OPTIONS and admin key requirement remain explicit', async () => {
  const h = await migrated();
  assert.equal((await api(h, '/api/tasks', 'GET', undefined, {})).status, 401);
  assert.equal((await api(h, '/api/tasks', 'GET', undefined, { Authorization: 'Bearer test-api-key' })).status, 200);
  assert.equal((await api(h, '/api/tasks?api_key=test-api-key', 'GET', undefined, {})).status, 200);
  assert.equal((await api(h, '/api/test-cron', 'POST', { cron: '0 8 * * *', startDate: '2026-11-04T23:59:00Z' }, {})).status, 200);
  const options = await worker.fetch(new Request('https://scheduler.invalid/api/tasks', { method: 'OPTIONS' }), h.env, context());
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), '*');
  delete h.env.API_KEY;
  assert.equal((await api(h, '/api/tasks', 'GET', undefined, {})).status, 200);
  assert.equal((await api(h, '/api/admin/status', 'GET', undefined, {})).status, 503);
});

test('delayed invocation uses scheduled minute, including UTC+8 date boundary', async () => {
  const h = await migrated([task('delay', { cron: '0 0 5 11 *' })]);
  await tick(h, Date.parse('2026-11-04T16:00:00Z'));
  assert.equal(calls.length, 1);
  assert.ok(logs.some(line => line.includes('scheduledTime')));
  const preview = await api(h, '/api/test-cron', 'POST', { cron: '0 0 * * *', startDate: '2026-11-04T15:59:00Z' });
  assert.equal(preview.value.data.nextTriggerTimes[0].iso, '2026-11-04T16:00:00.000Z');
  assert.equal(preview.value.data.nextTriggerTimes[0].timeParts.hour, 0);
});

test('pagination, exact backup and missing legacy id are preserved', async () => {
  const tasks = Array.from({ length: 5 }, (_, i) => task(`p${i}`, { extra: { nested: i } }));
  const h = harness(tasks);
  const legacy = { ...tasks[0] }; delete legacy.id;
  const raw = JSON.stringify(legacy, null, 3);
  h.kv.data.set('task:p0', raw);
  h.kv.data.set('unrelated', 'not-json');
  const prepared = await prepare(h, tasks);
  assert.equal(prepared.status, 200);
  assert.equal(h.kv.calls.list, 6); // Two scans, three pages each.
  assert.equal((await api(h, '/api/tasks')).value.code, 'NOT_MIGRATED');
  const backup = (await api(h, `/api/admin/backup?id=${prepared.value.data.id}`)).value.data;
  assert.equal(backup.entries[0].value, raw);
  assert.equal((await api(h, '/api/admin/migration/commit', 'POST', { sourceFrozen: true, id: prepared.value.data.id })).status, 200);
  assert.deepEqual((await api(h, '/api/tasks')).value.data, tasks);
  assert.equal(h.kv.data.get('task:p0'), raw);
  assert.ok(h.kv.data.has(prepared.value.data.backupKey));
});

test('migration replay after edits never overwrites latest state or lists KV', async () => {
  const h = await migrated([task('a')]);
  await api(h, '/api/tasks/a', 'PUT', { name: 'latest' });
  await api(h, '/api/tasks', 'POST', task('b'));
  h.kv.fail = '*';
  assert.equal((await prepare(h, [task('a')])).value.data.alreadyMigrated, true);
  assert.equal((await api(h, '/api/admin/migration/commit', 'POST', { id: 'old' })).value.data.alreadyMigrated, true);
  assert.equal((await api(h, '/api/tasks/a')).value.data.name, 'latest');
  assert.equal((await api(h, '/api/tasks')).value.data.length, 2);
  assert.deepEqual(h.kv.calls, { get: 0, list: 0, put: 0, delete: 0 });
});

test('unmigrated, corrupted and legitimate empty state are distinct; scheduled failures reject', async () => {
  const h = harness();
  assert.equal((await api(h, '/api/tasks')).value.code, 'NOT_MIGRATED');
  await assert.rejects(tick(h, Date.now()), { code: 'NOT_MIGRATED' });
  h.storage.sql.exec('UPDATE scheduler_schema SET initialized = 1');
  assert.equal((await api(h, '/api/tasks')).value.code, 'DATA_CORRUPT');
  await assert.rejects(tick(h, Date.now()), { code: 'DATA_CORRUPT' });
  assert.equal(calls.length, 0);
  assert.deepEqual(h.kv.calls, { get: 0, list: 0, put: 0, delete: 0 });
  const empty = await migrated();
  assert.deepEqual((await api(empty, '/api/tasks')).value, { success: true, data: [] });
});

test('snapshot checksum detects content corruption', async () => {
  const h = await migrated([task('a')]);
  h.storage.sql.exec(`UPDATE tasks SET config_json = json_set(config_json, '$.enabled', json('false'))`);
  assert.equal((await api(h, '/api/tasks')).value.code, 'DATA_CORRUPT');
});

test('simultaneous prepares and commits select one migration and preserve concurrent new tasks', async () => {
  const tasks = [task('a')], h = harness(tasks);
  const prepared = await Promise.all([prepare(h, tasks), prepare(h, tasks)]);
  assert.equal(prepared[0].value.data.id, prepared[1].value.data.id);
  const id = prepared[0].value.data.id;
  const results = await Promise.all([
    api(h, '/api/admin/migration/commit', 'POST', { sourceFrozen: true, id }),
    api(h, '/api/tasks', 'POST', task('new')),
    api(h, '/api/admin/migration/commit', 'POST', { sourceFrozen: true, id }),
  ]);
  assert.ok(results.every(result => result.status < 400));
  assert.equal((await api(h, '/api/tasks')).value.data.length, 2);
});

test('failed DO commit never activates a partial collection and can be retried', async () => {
  const tasks = [task('a')], h = harness(tasks), prepared = await prepare(h, tasks);
  const transaction = h.storage.transaction.bind(h.storage);
  h.storage.transaction = () => Promise.reject(new Error('provider-secret'));
  const body = { sourceFrozen: true, id: prepared.value.data.id };
  assert.equal((await api(h, '/api/admin/migration/commit', 'POST', body)).value.code, 'STORAGE_UNAVAILABLE');
  assert.deepEqual(h.storage.sql.exec('SELECT * FROM scheduler_state').toArray(), []);
  h.storage.transaction = transaction;
  assert.equal((await api(h, '/api/admin/migration/commit', 'POST', body)).status, 200);
});

test('storage failures fail visibly; active scheduling is independent of KV outage', async () => {
  const h = await migrated([task('a')]);
  h.kv.fail = '*';
  await tick(h, Date.now());
  assert.equal(calls.length, 1);
  h.storage.fail = true;
  assert.equal((await api(h, '/api/tasks')).value.code, 'STORAGE_UNAVAILABLE');
  await assert.rejects(tick(h, Date.now()), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(calls.length, 1);
  h.storage.fail = false;
  const ns = h.env.SCHEDULER_STORE;
  h.env.SCHEDULER_STORE = { idFromName: ns.idFromName, get() { throw new Error('provider-secret'); } };
  assert.equal((await api(h, '/api/tasks')).value.code, 'STORAGE_UNAVAILABLE');
});

test('invalid tasks are rejected without corrupting active state', async () => {
  const h = await migrated([task('a')]);
  assert.equal((await api(h, '/api/tasks/a', 'PUT', { url: 'bad', headers: 'wrong' })).status, 400);
  assert.equal((await api(h, '/api/tasks/a')).value.data.url, 'https://task.invalid/run');
  assert.equal((await api(h, '/api/tasks', 'POST', { name: 'missing' })).status, 400);
});

for (const kind of ['missing', 'extra', 'changed', 'wrong-id', 'invalid-json', 'disappeared']) {
  test(`migration rejects ${kind} data without cutover`, async () => {
    const tasks = [task('a'), task('b')], h = harness(tasks);
    if (kind === 'missing') h.kv.data.delete('task:b');
    if (kind === 'extra') h.kv.data.set('task:c', JSON.stringify(task('c')));
    if (kind === 'changed') h.kv.data.set('task:b', JSON.stringify(task('b', { enabled: false })));
    if (kind === 'wrong-id') h.kv.data.set('task:b', JSON.stringify(task('other')));
    if (kind === 'invalid-json') h.kv.data.set('task:b', '{broken');
    if (kind === 'disappeared') h.kv.hook = async (op, key) => { if (op === 'get' && key === 'task:b') h.kv.data.delete(key); };
    assert.ok((await prepare(h, tasks)).status >= 400);
    assert.deepEqual(h.storage.sql.exec('SELECT * FROM scheduler_state').toArray(), []);
    assert.equal(h.kv.calls.put, 0);
    assert.equal(calls.length, 0);
  });
}

test('mutation between scans is detected', async () => {
  const tasks = [task('a')], h = harness(tasks);
  h.kv.hook = async op => { if (op === 'list' && h.kv.calls.list === 2) h.kv.data.set('task:a', JSON.stringify(task('a', { enabled: false }))); };
  assert.equal((await prepare(h, tasks)).value.code, 'MIGRATION_MISMATCH');
  assert.deepEqual(h.storage.sql.exec('SELECT * FROM scheduler_state').toArray(), []);
});

test('empty manifest requires explicit allowEmpty; source freeze is mandatory', async () => {
  const h = harness();
  assert.equal((await api(h, '/api/admin/migration/prepare', 'POST', { expected: [] })).value.code, 'SOURCE_NOT_FROZEN');
  assert.equal((await api(h, '/api/admin/migration/prepare', 'POST', { sourceFrozen: true, expected: [] })).status, 400);
  assert.equal((await prepare(h, [])).status, 200);
});

for (const operation of ['list', 'get', 'put']) {
  test(`KV ${operation} failure during migration is explicit and retryable`, async () => {
    const tasks = [task('a')], h = harness(tasks);
    h.kv.fail = operation;
    assert.equal((await prepare(h, tasks)).value.code, 'KV_UNAVAILABLE');
    assert.deepEqual(h.storage.sql.exec('SELECT * FROM scheduler_state').toArray(), []);
    h.kv.fail = null;
    h.reboot();
    const prepared = await prepare(h, tasks);
    assert.equal(prepared.status, 200);
    assert.equal((await api(h, '/api/admin/migration/commit', 'POST', { sourceFrozen: true, id: prepared.value.data.id })).status, 200);
  });
}

test('stale KV backup blocks commit; source drift blocks commit; discard keeps backup', async () => {
  const tasks = [task('a')], h = harness(tasks), prepared = await prepare(h, tasks);
  const { id, backupKey } = prepared.value.data;
  const raw = h.kv.data.get(backupKey);
  h.kv.data.delete(backupKey);
  assert.equal((await api(h, '/api/admin/migration/commit', 'POST', { sourceFrozen: true, id })).value.code, 'BACKUP_NOT_VISIBLE');
  h.kv.data.set(backupKey, raw);
  h.kv.data.set('task:a', JSON.stringify(task('a', { enabled: false })));
  assert.equal((await api(h, '/api/admin/migration/commit', 'POST', { sourceFrozen: true, id })).value.code, 'MIGRATION_MISMATCH');
  assert.deepEqual(h.storage.sql.exec('SELECT * FROM scheduler_state').toArray(), []);
  assert.equal((await api(h, '/api/admin/migration/discard', 'POST', {})).status, 200);
  assert.ok(await h.storage.get(backupKey));
  assert.ok(h.kv.data.has(backupKey));
});

test('bad pagination cursor and empty intermediate pages are handled safely', async () => {
  const tasks = [task('a')], h = harness(tasks);
  const normalList = h.kv.list.bind(h.kv);
  let once = true;
  h.kv.list = async options => {
    if (once) { once = false; return { keys: [], list_complete: false, cursor: 'next' }; }
    return normalList({ prefix: options.prefix });
  };
  assert.equal((await prepare(h, tasks)).status, 200);
  const bad = harness(tasks);
  bad.kv.list = async () => ({ keys: [], list_complete: false, cursor: 'loop' });
  assert.equal((await prepare(bad, tasks)).value.code, 'DATA_CORRUPT');
});

test('rollback exports latest state, removes deleted tasks, freezes writes and survives restart', async () => {
  const h = await migrated([task('keep'), task('deleted')]);
  await api(h, '/api/tasks/keep', 'PUT', { name: 'latest', headers: { Authorization: 'new-secret' } });
  await api(h, '/api/tasks/deleted', 'DELETE');
  await api(h, '/api/tasks', 'POST', task('added'));
  const expected = (await api(h, '/api/tasks')).value.data;
  const frozen = (await api(h, '/api/admin/rollback/prepare', 'POST', {})).value.data;
  assert.equal((await api(h, '/api/tasks/keep', 'PUT', { name: 'forbidden' })).value.code, 'WRITES_FROZEN');
  h.reboot();
  const restored = await api(h, '/api/admin/rollback/restore', 'POST', { id: frozen.id });
  assert.equal(restored.status, 200);
  assert.equal(restored.value.data.ready, true);
  assert.ok(!h.kv.data.has('task:deleted'));
  const actual = [...h.kv.data].filter(([key]) => key.startsWith('task:')).map(([, raw]) => JSON.parse(raw));
  assert.equal(canonical(await manifestFor(actual)), canonical(await manifestFor(expected)));
  assert.equal((await api(h, '/api/admin/export')).value.data.taskCount, 2);
  assert.equal((await api(h, '/api/admin/rollback/restore', 'POST', { id: frozen.id })).status, 200);
  assert.equal((await api(h, '/api/admin/rollback/resume', 'POST', {})).value.data.mode, 'active');
  assert.equal((await api(h, '/api/tasks/keep', 'PUT', { enabled: false })).status, 200);
});

for (const operation of ['get', 'put', 'delete', 'list']) {
  test(`rollback KV ${operation} failure keeps latest state frozen and can retry`, async () => {
    const h = await migrated([task('keep'), task('deleted')]);
    await api(h, '/api/tasks/deleted', 'DELETE');
    const frozen = (await api(h, '/api/admin/rollback/prepare', 'POST', {})).value.data;
    h.kv.fail = operation;
    const failed = await api(h, '/api/admin/rollback/restore', 'POST', { id: frozen.id });
    assert.equal(failed.value.code, 'KV_UNAVAILABLE');
    assert.equal((await api(h, '/api/admin/status')).value.data.mode, 'rollback-frozen');
    assert.equal((await api(h, '/api/tasks')).value.data.length, 1);
    h.kv.fail = null;
    h.reboot();
    assert.equal((await api(h, '/api/admin/rollback/restore', 'POST', { id: frozen.id })).status, 200);
  });
}

test('stale legacy data cannot make rollback ready', async () => {
  const h = await migrated([task('a')]);
  await api(h, '/api/tasks/a', 'PUT', { enabled: false });
  const frozen = (await api(h, '/api/admin/rollback/prepare', 'POST', {})).value.data;
  h.kv.put = async (key, raw) => { if (!key.startsWith('task:')) h.kv.data.set(key, raw); }; // Simulate propagation lag.
  assert.equal((await api(h, '/api/admin/rollback/restore', 'POST', { id: frozen.id })).value.code, 'ROLLBACK_MISMATCH');
  assert.equal((await api(h, '/api/admin/status')).value.data.mode, 'rollback-frozen');
});

test('rollback explicitly deletes known retired IDs even when KV List omits them', async () => {
  const h = await migrated([task('keep'), task('retired')]);
  await api(h, '/api/tasks/retired', 'DELETE');
  const frozen = (await api(h, '/api/admin/rollback/prepare', 'POST', {})).value.data;
  const normalList = h.kv.list.bind(h.kv);
  h.kv.list = async options => {
    const page = await normalList(options);
    return { ...page, keys: page.keys.filter(key => key.name !== 'task:retired') };
  };
  const result = await api(h, '/api/admin/rollback/restore', 'POST', { id: frozen.id });
  assert.equal(result.status, 200);
  assert.equal(h.kv.data.has('task:retired'), false);
});

test('logs never contain task name, URL, credentials, body, response or provider error text', async () => {
  const h = await migrated([task('a', { name: 'private-name', url: 'https://private-url.invalid/?key=url-secret',
    headers: { Authorization: 'header-secret' }, params: { token: 'param-secret' }, body: 'body-secret' })]);
  await tick(h, Date.now());
  globalThis.fetch = async () => { throw new Error('provider-secret'); };
  await assert.rejects(tick(h, Date.now()), { code: 'TASK_EXECUTION_FAILED' });
  h.storage.fail = true;
  await api(h, '/api/tasks');
  for (const secret of ['test-api-key', 'private-name', 'private-url', 'url-secret', 'header-secret',
    'param-secret', 'body-secret', 'response-secret', 'provider-secret']) assert.ok(!logs.join('\n').includes(secret), secret);
});

test('GET params, POST/PUT/PATCH bodies and request headers retain execution behavior', async () => {
  await executeTask(task('get', { params: { a: 'b c' }, headers: { 'X-Test': 'yes' } }));
  assert.equal(new URL(calls[0].url).searchParams.get('a'), 'b c');
  assert.equal(calls[0].options.headers['X-Test'], 'yes');
  for (const method of ['POST', 'PUT', 'PATCH']) {
    await executeTask(task('body', { method, body: { a: 1 } }));
    assert.equal(calls.at(-1).options.body, '{"a":1}');
    assert.equal(calls.at(-1).options.headers['Content-Type'], 'application/json');
  }
  globalThis.fetch = async () => new Response('secret', { status: 500 });
  await assert.rejects(executeTask(task('bad')), { code: 'TASK_EXECUTION_FAILED' });
});
