import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, main } from '../scripts/scheduler-admin.mjs';
import { manifestFor } from '../src/storage-format.js';
import { task } from './fakes.js';

test('independent export manifest validates identity, duplicates and exact task contents', async () => {
  const original = task('a', { headers: { Authorization: 'secret' }, unknown: { keep: true } });
  assert.deepEqual((await buildManifest([original])).expected, await manifestFor([original]));
  const withoutId = { ...original }; delete withoutId.id;
  assert.deepEqual(await buildManifest([{ key: 'task:a', value: JSON.stringify(withoutId) }]), await buildManifest([original]));
  await assert.rejects(buildManifest([original, original]));
  await assert.rejects(buildManifest([{ key: 'task:wrong', value: original }]));
});

test('manifest command is offline, requires explicit empty authorization and writes private files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scheduler-admin-'));
  const originalFetch = globalThis.fetch, originalLog = console.log;
  globalThis.fetch = () => { throw new Error('Network forbidden'); };
  console.log = () => {};
  try {
    const input = join(dir, 'input.json'), output = join(dir, 'manifest.json');
    await writeFile(input, '[]');
    await assert.rejects(main(['manifest', input, output]));
    await main(['manifest', input, output, '--allow-empty']);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { expected: [], allowEmpty: true });
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  } finally { globalThis.fetch = originalFetch; console.log = originalLog; await rm(dir, { recursive: true }); }
});

test('admin command uses authenticated mock fetch and saves exports without logging secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scheduler-export-'));
  const originalFetch = globalThis.fetch, originalLog = console.log;
  const previousURL = process.env.SCHEDULER_URL, previousKey = process.env.SCHEDULER_API_KEY;
  const logs = [];
  process.env.SCHEDULER_URL = 'https://scheduler.invalid'; process.env.SCHEDULER_API_KEY = 'admin-secret';
  console.log = value => logs.push(value);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://scheduler.invalid/api/admin/export');
    assert.equal(init.headers['X-API-Key'], 'admin-secret');
    assert.equal(init.redirect, 'error');
    return Response.json({ success: true, data: { tasks: [task('a', { body: 'task-secret' })] } });
  };
  try {
    const output = join(dir, 'export.json');
    await main(['export', output]);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).tasks[0].body, 'task-secret');
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.ok(!logs.join('').includes('secret'));
    await assert.rejects(main(['commit', 'id']), /Freeze ALL legacy writers/);
  } finally {
    globalThis.fetch = originalFetch; console.log = originalLog;
    if (previousURL === undefined) delete process.env.SCHEDULER_URL; else process.env.SCHEDULER_URL = previousURL;
    if (previousKey === undefined) delete process.env.SCHEDULER_API_KEY; else process.env.SCHEDULER_API_KEY = previousKey;
    await rm(dir, { recursive: true });
  }
});
