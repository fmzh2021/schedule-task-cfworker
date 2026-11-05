import { SchedulerError, TASKS_KEY, canonical, sha256, validateRecord } from './storage-format.js';

// These are Durable Object storage keys, NOT Workers KV keys. Keep the marker
// outside user SQL tables so dropping tables cannot re-import a stale snapshot.
export const SQL_MARKER_KEY = 'scheduler:sql:v2:activated';
export const SQL_BACKUP_KEY = 'scheduler:sql:v2:legacy-backup';
// Previous releases reject this as DATA_CORRUPT instead of silently loading an
// out-of-date snapshot after an accidental code downgrade. Original data is in
// the sealed backup above; no continuous dual writes or stale fallback.
export const SQL_LEGACY_GUARD = { storageBackend: 'sqlite', schemaVersion: 2 };
const TABLES = ['scheduler_schema', 'scheduler_state', 'tasks'];
const corrupt = () => { throw new SchedulerError('DATA_CORRUPT', 500); };

export class SQLTaskStorage {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.ready = false;
  }

  tables() {
    return this.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('scheduler_schema', 'scheduler_state', 'tasks') ORDER BY name`).toArray().map(row => row.name);
  }

  schema() {
    if (canonical(this.tables()) !== canonical(TABLES)) corrupt();
    const rows = this.sql.exec('SELECT * FROM scheduler_schema').toArray();
    if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].version !== 2 ||
        ![0, 1].includes(rows[0].initialized)) corrupt();
    return rows[0];
  }

  async ensure() {
    if (this.ready) return;
    await this.storage.transaction(async tx => {
      const marker = await tx.get(SQL_MARKER_KEY), tables = this.tables();
      if (marker !== undefined) {
        if (canonical(marker) !== canonical({ version: 2 })) corrupt();
        this.schema(); // Missing tables never trigger re-import from the old key.
        return;
      }
      if (tables.length || await tx.get(SQL_BACKUP_KEY) !== undefined) corrupt();
      const previous = await tx.get(TASKS_KEY);
      if (previous !== undefined) await validateRecord(previous);
      // DDL, rows, backup, and activation marker share this DO transaction.
      // Never execute BEGIN/SAVEPOINT via the production SQL API.
      this.sql.exec(`CREATE TABLE scheduler_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL CHECK (version = 2),
        initialized INTEGER NOT NULL CHECK (initialized IN (0, 1)),
        created_at TEXT NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE scheduler_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        mode TEXT NOT NULL CHECK (mode IN ('active', 'rollback-frozen', 'rollback-ready')),
        migration_id TEXT NOT NULL, rollback_id TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1), updated_at TEXT NOT NULL,
        task_count INTEGER NOT NULL CHECK (task_count >= 0), sha256 TEXT NOT NULL,
        known_task_ids_json TEXT NOT NULL CHECK (json_valid(known_task_ids_json) AND json_type(known_task_ids_json) = 'array')
      )`);
      this.sql.exec(`CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
        config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'
          AND json_type(config_json, '$.id') = 'text' AND json_extract(config_json, '$.id') = id),
        name TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.name')) VIRTUAL,
        url TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.url')) VIRTUAL,
        method TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.method')) VIRTUAL,
        cron TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.cron')) VIRTUAL,
        enabled INTEGER GENERATED ALWAYS AS (json_extract(config_json, '$.enabled')) VIRTUAL,
        created_at TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.createdAt')) VIRTUAL,
        updated_at TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.updatedAt')) VIRTUAL
      )`);
      this.sql.exec('INSERT INTO scheduler_schema VALUES (1, 2, 0, ?)', new Date().toISOString());
      if (previous !== undefined) {
        await tx.put(SQL_BACKUP_KEY, { kind: 'do-sql-upgrade', record: previous,
          sha256: await sha256(previous), createdAt: new Date().toISOString() });
        this.write(previous);
        if (canonical(await this.read()) !== canonical(previous)) corrupt();
      }
      await tx.put(TASKS_KEY, SQL_LEGACY_GUARD);
      await tx.put(SQL_MARKER_KEY, { version: 2 });
    });
    this.ready = true;
  }

  async read() {
    const schema = this.schema();
    const states = this.sql.exec('SELECT * FROM scheduler_state').toArray();
    const rows = this.sql.exec('SELECT id, position, config_json FROM tasks ORDER BY position').toArray();
    if (schema.initialized === 0) {
      if (states.length || rows.length) corrupt();
      return null;
    }
    if (states.length !== 1 || states[0].singleton !== 1) corrupt();
    const state = states[0];
    let tasks, knownTaskIds;
    try {
      tasks = rows.map((row, index) => {
        const task = JSON.parse(row.config_json);
        if (row.position !== index || task.id !== row.id) corrupt();
        return task;
      });
      knownTaskIds = JSON.parse(state.known_task_ids_json);
    } catch { corrupt(); }
    return validateRecord({ mode: state.mode, migrationId: state.migration_id, knownTaskIds,
      ...(state.rollback_id === null ? {} : { rollbackId: state.rollback_id }),
      snapshot: { version: 1, revision: state.revision, updatedAt: state.updated_at,
        taskCount: state.task_count, sha256: state.sha256, tasks } });
  }

  // Caller MUST hold a storage.transaction. The fixed named DO serializes all
  // writers; replacing a small collection is atomic, including its metadata.
  write(record) {
    const snapshot = record.snapshot;
    this.sql.exec('DELETE FROM tasks');
    for (let position = 0; position < snapshot.tasks.length; position++) {
      const task = snapshot.tasks[position];
      this.sql.exec('INSERT INTO tasks (id, position, config_json) VALUES (?, ?, ?)', task.id, position, JSON.stringify(task));
    }
    this.sql.exec(`INSERT OR REPLACE INTO scheduler_state
      (singleton, mode, migration_id, rollback_id, revision, updated_at, task_count, sha256, known_task_ids_json)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`, record.mode, record.migrationId, record.rollbackId ?? null,
      snapshot.revision, snapshot.updatedAt, snapshot.taskCount, snapshot.sha256, JSON.stringify(record.knownTaskIds));
    this.sql.exec('UPDATE scheduler_schema SET initialized = 1 WHERE singleton = 1');
  }
}
