import { SchedulerError, canonical, manifestFor, object, validateTask } from './storage-format.js';

// Used ONLY by explicit migration / rollback administration.
export function countedKV(kv, counts) {
  return Object.fromEntries(['get', 'list', 'put', 'delete'].map(operation => [operation, async (...args) => {
    counts[operation]++;
    try { return await kv[operation](...args); } catch { throw new SchedulerError('KV_UNAVAILABLE'); }
  }]));
}
export async function listLegacyKeys(kv) {
  const names = new Set(), cursors = new Set();
  let cursor;
  do {
    const page = await kv.list({ prefix: 'task:', ...(cursor ? { cursor } : {}) });
    if (!object(page) || !Array.isArray(page.keys) || typeof page.list_complete !== 'boolean') {
      throw new SchedulerError('DATA_CORRUPT', 500);
    }
    for (const key of page.keys) {
      if (!object(key) || typeof key.name !== 'string' || !key.name.startsWith('task:') || names.has(key.name)) {
        throw new SchedulerError('DATA_CORRUPT', 500);
      }
      names.add(key.name);
    }
    if (page.list_complete) break;
    if (typeof page.cursor !== 'string' || !page.cursor || cursors.has(page.cursor)) {
      throw new SchedulerError('DATA_CORRUPT', 500);
    }
    cursor = page.cursor;
    cursors.add(cursor);
  } while (true);
  return [...names].sort();
}
export async function scanLegacy(kv) {
  const entries = [], tasks = [];
  for (const key of await listLegacyKeys(kv)) {
    const raw = await kv.get(key);
    if (typeof raw !== 'string') throw new SchedulerError('MIGRATION_MISMATCH', 409);
    let value;
    try { value = JSON.parse(raw); } catch { throw new SchedulerError('DATA_CORRUPT', 500); }
    const id = key.slice('task:'.length);
    if (!object(value) || (value.id !== undefined && value.id !== id)) throw new SchedulerError('DATA_CORRUPT', 500);
    const task = { ...value, id };
    validateTask(task, 'DATA_CORRUPT');
    tasks.push(task);
    entries.push({ key, value: raw }); // Keep exact original JSON, including unknown fields.
  }
  return { tasks, entries, manifest: await manifestFor(tasks) };
}
export function validateExpected(expected, allowEmpty) {
  if (!Array.isArray(expected) || (!expected.length && allowEmpty !== true) ||
      expected.some(item => !object(item) || typeof item.id !== 'string' || !item.id ||
        typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) ||
      new Set(expected.map(item => item.id)).size !== expected.length) throw new SchedulerError('INVALID_REQUEST', 400);
  return [...expected].map(({ id, sha256 }) => ({ id, sha256 }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function assertManifest(actual, expected, code = 'MIGRATION_MISMATCH') {
  if (canonical(actual) !== canonical(expected)) throw new SchedulerError(code, 409);
}
