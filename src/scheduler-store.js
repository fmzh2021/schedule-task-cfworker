import { SchedulerError, canonical, makeSnapshot, manifestFor, object, safeError, sha256,
  validateSnapshot, validateTask } from './storage-format.js';
import { SQLTaskStorage } from './sql-task-storage.js';
import { assertManifest, countedKV, listLegacyKeys, scanLegacy, validateExpected } from './legacy-kv.js';

const CANDIDATE_KEY = 'migration-candidate:v1';
const backupKey = id => `scheduler:backup:v1:${id}`;
const reply = (data, status = 200) => Response.json(data, { status });

async function json(request) {
  try {
    const value = await request.json();
    if (object(value)) return value;
  } catch { /* sanitized below */ }
  throw new SchedulerError('INVALID_REQUEST', 400);
}
async function sealBackup(value) { return { ...value, digest: await sha256(value) }; }
async function checkBackup(backup) {
  if (!object(backup)) throw new SchedulerError('DATA_CORRUPT', 500);
  const { digest, ...value } = backup;
  if (!['migration', 'rollback'].includes(value.kind) || typeof value.id !== 'string' ||
      digest !== await sha256(value)) throw new SchedulerError('DATA_CORRUPT', 500);
  await validateSnapshot(value.snapshot);
  return backup;
}
const summary = record => ({ migrated: true, mode: record.mode, revision: record.snapshot.revision,
  taskCount: record.snapshot.taskCount, sha256: record.snapshot.sha256, migrationId: record.migrationId });
const backupSummary = backup => ({ id: backup.id, backupKey: backupKey(backup.id),
  taskCount: backup.snapshot.taskCount, revision: backup.snapshot.revision, digest: backup.digest });

export class SchedulerStore {
  constructor(state, env) {
    this.storage = state.storage;
    this.records = new SQLTaskStorage(state.storage);
    this.env = env;
    // This queue is inside the ONE named Durable Object, not an edge Worker/module
    // lock. It also prevents administrative KV exports interleaving with resume.
    // Authoritative state and every mutation are additionally persisted atomically.
    this.queue = Promise.resolve();
  }

  fetch(request) {
    const result = this.queue.then(() => this.handle(request));
    this.queue = result.catch(() => {});
    return result;
  }

  async record(required = true) {
    // SQL statements participate in the active state.storage transaction.
    const value = await this.records.read();
    if (value === null) {
      if (required) throw new SchedulerError('NOT_MIGRATED');
      return null;
    }
    return value;
  }

  async mutate(operation) {
    return this.storage.transaction(async () => {
      const record = await this.record();
      if (record.mode !== 'active') throw new SchedulerError('WRITES_FROZEN', 409);
      const result = await operation(record.snapshot.tasks);
      record.knownTaskIds = [...new Set([...record.knownTaskIds, ...record.snapshot.tasks.map(task => task.id)])];
      record.snapshot = await makeSnapshot(record.snapshot.tasks, record.snapshot.revision + 1);
      this.records.write(record);
      return result;
    });
  }

  async handle(request) {
    const counts = { get: 0, list: 0, put: 0, delete: 0 };
    const kv = countedKV(this.env.TASKS_KV, counts);
    const url = new URL(request.url), path = url.pathname, method = request.method;
    try {
      await this.records.ensure();
      let data;
      if (path === '/tasks' && method === 'GET') {
        data = (await this.record()).snapshot;
      } else if (path === '/task' && method === 'GET') {
        data = (await this.record()).snapshot.tasks.find(task => task.id === url.searchParams.get('id')) || null;
      } else if (path === '/task' && method === 'POST') {
        const task = validateTask(await json(request));
        data = await this.mutate(tasks => {
          const index = tasks.findIndex(item => item.id === task.id);
          if (index < 0) tasks.push(task); else tasks[index] = task; // Legacy POST upsert semantics.
          return task;
        });
      } else if (path === '/task' && method === 'PUT') {
        const patch = await json(request), id = url.searchParams.get('id');
        data = await this.mutate(tasks => {
          const index = tasks.findIndex(task => task.id === id);
          if (index < 0) return null;
          tasks[index] = validateTask({ ...tasks[index], ...patch, id, updatedAt: new Date().toISOString() });
          return tasks[index];
        });
      } else if (path === '/task' && method === 'DELETE') {
        data = await this.mutate(tasks => {
          const index = tasks.findIndex(task => task.id === url.searchParams.get('id'));
          if (index >= 0) tasks.splice(index, 1);
          return true;
        });
      } else if (path === '/admin/status' && method === 'GET') {
        const record = await this.record(false);
        const candidateId = await this.storage.get(CANDIDATE_KEY);
        data = { ...(record ? summary(record) : { migrated: false, mode: 'uninitialized', candidateId: candidateId || null }),
          storageBackend: 'sqlite', schemaVersion: 2 };
      } else if (path === '/admin/export' && method === 'GET') {
        data = (await this.record()).snapshot;
      } else if (path === '/admin/backup' && method === 'GET') {
        data = await checkBackup(await this.storage.get(backupKey(url.searchParams.get('id'))));
      } else if (path === '/admin/migration/prepare' && method === 'POST') {
        data = await this.prepareMigration(await json(request), kv);
      } else if (path === '/admin/migration/commit' && method === 'POST') {
        data = await this.commitMigration(await json(request), kv);
      } else if (path === '/admin/migration/discard' && method === 'POST') {
        data = await this.storage.transaction(async tx => {
          if (await this.record(false)) throw new SchedulerError('MIGRATION_CONFLICT', 409);
          await tx.delete(CANDIDATE_KEY); // Immutable DO/KV backups deliberately retained.
          return { discarded: true };
        });
      } else if (path === '/admin/rollback/prepare' && method === 'POST') {
        data = await this.prepareRollback();
      } else if (path === '/admin/rollback/restore' && method === 'POST') {
        data = await this.restoreLegacy(await json(request), kv);
      } else if (path === '/admin/rollback/resume' && method === 'POST') {
        data = await this.storage.transaction(async () => {
          const record = await this.record();
          record.mode = 'active';
          delete record.rollbackId;
          this.records.write(record);
          return summary(record);
        });
      } else {
        return reply({ code: 'INVALID_REQUEST', error: '请求参数无效' }, 404);
      }
      return reply({ data });
    } catch (error) {
      const safe = safeError(error);
      console.error(JSON.stringify({ event: 'store_failed', code: safe.code }));
      return reply({ code: safe.code, error: safe.message }, safe.status);
    } finally {
      console.log(JSON.stringify({ event: 'store_operation', operation: path, kv: counts }));
    }
  }

  async publishBackup(kv, backup) {
    const key = backupKey(backup.id), serialized = canonical(backup);
    const existing = await kv.get(key);
    if (existing !== null && existing !== serialized) throw new SchedulerError('DATA_CORRUPT', 500);
    if (existing === null) await kv.put(key, serialized);
  }
  async verifyPublishedBackup(kv, backup) {
    if (await kv.get(backupKey(backup.id)) !== canonical(backup)) throw new SchedulerError('BACKUP_NOT_VISIBLE');
  }

  async prepareMigration(input, kv) {
    const record = await this.record(false);
    if (record) return { alreadyMigrated: true, ...summary(record) };
    if (input.sourceFrozen !== true) throw new SchedulerError('SOURCE_NOT_FROZEN', 409);
    const expected = validateExpected(input.expected, input.allowEmpty);
    let candidateId = await this.storage.get(CANDIDATE_KEY), backup;
    if (candidateId) {
      backup = await checkBackup(await this.storage.get(backupKey(candidateId)));
      assertManifest(backup.expected, expected, 'MIGRATION_CONFLICT');
    } else {
      const first = await scanLegacy(kv), second = await scanLegacy(kv);
      assertManifest(first.manifest, expected);
      assertManifest(second.manifest, expected);
      backup = await sealBackup({ kind: 'migration', id: crypto.randomUUID(), createdAt: new Date().toISOString(),
        snapshot: await makeSnapshot(second.tasks), expected, entries: second.entries });
      await this.storage.transaction(async tx => {
        if (await this.record(false) || await tx.get(CANDIDATE_KEY)) throw new SchedulerError('MIGRATION_CONFLICT', 409);
        await tx.put(backupKey(backup.id), backup);
        await tx.put(CANDIDATE_KEY, backup.id);
      });
    }
    await this.publishBackup(kv, backup);
    return { prepared: true, ...backupSummary(backup) };
  }

  async commitMigration(input, kv) {
    const record = await this.record(false);
    if (record) return { alreadyMigrated: true, ...summary(record) };
    if (input.sourceFrozen !== true) throw new SchedulerError('SOURCE_NOT_FROZEN', 409);
    const id = await this.storage.get(CANDIDATE_KEY);
    if (!id || input.id !== id) throw new SchedulerError('MIGRATION_CONFLICT', 409);
    const backup = await checkBackup(await this.storage.get(backupKey(id)));
    await this.verifyPublishedBackup(kv, backup);
    assertManifest((await scanLegacy(kv)).manifest, backup.expected);
    return this.storage.transaction(async () => {
      const existing = await this.record(false);
      if (existing) return { alreadyMigrated: true, ...summary(existing) };
      const next = { mode: 'active', migrationId: id, snapshot: backup.snapshot,
        knownTaskIds: backup.snapshot.tasks.map(task => task.id) };
      this.records.write(next); // Atomic cutover; old task:* keys are never deleted here.
      return summary(next);
    });
  }

  async prepareRollback() {
    const backup = await this.storage.transaction(async tx => {
      const record = await this.record();
      if (record.mode !== 'active') return checkBackup(await tx.get(backupKey(record.rollbackId)));
      const backup = await sealBackup({ kind: 'rollback', id: crypto.randomUUID(),
        createdAt: new Date().toISOString(), snapshot: record.snapshot });
      await tx.put(backupKey(backup.id), backup);
      record.mode = 'rollback-frozen';
      record.rollbackId = backup.id;
      this.records.write(record);
      return backup;
    });
    return { frozen: true, ...backupSummary(backup) };
  }

  async restoreLegacy(input, kv) {
    const record = await this.record();
    if (record.mode === 'active' || input.id !== record.rollbackId) throw new SchedulerError('MIGRATION_CONFLICT', 409);
    const backup = await checkBackup(await this.storage.get(backupKey(record.rollbackId)));
    if (record.mode === 'rollback-ready') return { ready: true, ...backupSummary(backup) };
    await this.publishBackup(kv, backup);
    await this.verifyPublishedBackup(kv, backup);
    const desired = new Set(backup.snapshot.tasks.map(task => `task:${task.id}`));
    // Per-key writes are restartable. A failed export never changes the DO snapshot
    // and never permits legacy deployment; retry stays on the frozen revision.
    for (const task of backup.snapshot.tasks) {
      const key = `task:${task.id}`, serialized = canonical(task);
      if (await kv.get(key) !== serialized) await kv.put(key, serialized);
    }
    // List may temporarily omit an old key. Keep every ID ever managed in durable
    // storage so deleted tasks still receive an explicit KV tombstone.
    const known = new Set([...record.knownTaskIds.map(id => `task:${id}`), ...await listLegacyKeys(kv)]);
    for (const key of known) if (!desired.has(key)) await kv.delete(key);
    const expected = await manifestFor(backup.snapshot.tasks);
    assertManifest((await scanLegacy(kv)).manifest, expected, 'ROLLBACK_MISMATCH');
    assertManifest((await scanLegacy(kv)).manifest, expected, 'ROLLBACK_MISMATCH');
    for (const key of known) {
      if (!desired.has(key) && await kv.get(key) !== null) throw new SchedulerError('ROLLBACK_MISMATCH', 409);
    }
    record.mode = 'rollback-ready';
    await this.storage.transaction(() => { this.records.write(record); });
    return { ready: true, ...backupSummary(backup) };
  }
}
