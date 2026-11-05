import { SchedulerError, canonical, makeSnapshot, sha256, validateRecord } from './storage-format.js';
import { SQLTaskStorage as LegacySQLTaskStorage } from './sql-task-storage.js';

export const EDITABLE_MARKER_KEY = 'scheduler:sql:v3:activated';
export const EDITABLE_BACKUP_KEY = 'scheduler:sql:v3:backup';
const generation = Symbol('task-generation');
const corrupt = () => { throw new SchedulerError('DATA_CORRUPT', 500); };
class SQLConflict extends Error {}

// Physical columns are editable in Data Studio. config_json remains a complete,
// lossless representation. Triggers sync both directions in the same statement,
// including when SQL bypasses Worker fetch handlers.
const fields = [
  ['name', 'name'], ['url', 'url'], ['method', 'method'], ['cron', 'cron'],
  ['enabled', 'enabled', 'boolean'], ['created_at', 'createdAt'], ['updated_at', 'updatedAt'],
  ['headers_json', 'headers', 'json'], ['params_json', 'params', 'json'], ['body_json', 'body', 'json'],
];
const projected = (column, key, type, source = 'NEW.config_json') => type === 'json'
  ? `CASE json_type(${source}, '$.${key}') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
      ELSE CASE WHEN json_type(${source}, '$.${key}') IS NULL THEN NULL ELSE json_quote(json_extract(${source}, '$.${key}')) END END`
  : `json_extract(${source}, '$.${key}')`;
const mismatch = fields.map(([column, key, type]) => `NEW.${column} IS NOT (${projected(column, key, type)})`).join(' OR ');
const triggerNames = [...fields.map(([column]) => `tasks_column_${column}`), 'tasks_json', 'tasks_insert', 'tasks_changed', 'tasks_removed',
  'tasks_added', 'tasks_identity', 'tasks_conflicting_edit', 'tasks_freeze_insert', 'tasks_freeze_update', 'tasks_freeze_delete'];

function createTriggers(sql) {
  // Each trigger patches the current document, preserving edits from other
  // column triggers in a multi-column UPDATE. NEW retains the user's intended
  // value even if a sibling trigger has refreshed the physical projections.
  fields.forEach(([column, key, type]) => {
    const value = type === 'json' ? `json(NEW.${column})`
      : type === 'boolean' ? `json(CASE NEW.${column} WHEN 1 THEN 'true' ELSE 'false' END)` : `NEW.${column}`;
    sql.exec(`CREATE TRIGGER tasks_column_${column} AFTER UPDATE OF ${column} ON tasks
      WHEN NEW.${column} IS NOT OLD.${column} AND NEW.${column} IS NOT (${projected(column, key, type)}) BEGIN
      UPDATE tasks SET config_json = CASE WHEN NEW.${column} IS NULL THEN json_remove(config_json, '$.${key}')
        ELSE json_set(config_json, '$.${key}', ${value}) END WHERE id = NEW.id;
    END`);
  });
  const sync = fields.map(([column, key, type]) => `${column} = ${projected(column, key, type)}`).join(', ');
  sql.exec(`CREATE TRIGGER tasks_json AFTER UPDATE OF config_json ON tasks WHEN ${mismatch} BEGIN
    UPDATE tasks SET ${sync} WHERE id = NEW.id;
  END`);
  sql.exec(`CREATE TRIGGER tasks_insert AFTER INSERT ON tasks BEGIN UPDATE tasks SET ${sync} WHERE id = NEW.id; END`);
  sql.exec(`CREATE TRIGGER tasks_identity BEFORE UPDATE OF id ON tasks WHEN NEW.id IS NOT OLD.id BEGIN
    SELECT RAISE(ABORT, 'TASK_ID_IMMUTABLE'); END`);
  // A statement changing both representations must agree; trigger ordering must
  // never silently choose which conflicting edit survives.
  const conflict = fields.map(([c, k, t]) => `(NEW.${c} IS NOT OLD.${c} AND NEW.${c} IS NOT (${projected(c, k, t)}))`).join(' OR ');
  sql.exec(`CREATE TRIGGER tasks_conflicting_edit BEFORE UPDATE ON tasks
    WHEN NEW.config_json IS NOT OLD.config_json AND (${conflict}) BEGIN SELECT RAISE(ABORT, 'CONFLICTING_TASK_EDIT'); END`);
  for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
    sql.exec(`CREATE TRIGGER tasks_freeze_${action.toLowerCase()} BEFORE ${action} ON tasks
      WHEN (SELECT mode FROM scheduler_state WHERE singleton = 1) IN ('rollback-frozen', 'rollback-ready')
      BEGIN SELECT RAISE(ABORT, 'WRITES_FROZEN'); END`);
  }
  const dirty = 'UPDATE scheduler_schema SET task_generation = task_generation + 1 WHERE singleton = 1;';
  const remember = `UPDATE scheduler_state SET known_task_ids_json = json_insert(known_task_ids_json, '$[#]', NEW.id)
    WHERE singleton = 1 AND NOT EXISTS (SELECT 1 FROM json_each(known_task_ids_json) WHERE value = NEW.id);`;
  sql.exec(`CREATE TRIGGER tasks_changed AFTER UPDATE OF config_json, position ON tasks
    WHEN NEW.config_json IS NOT OLD.config_json OR NEW.position IS NOT OLD.position BEGIN ${dirty} END`);
  sql.exec(`CREATE TRIGGER tasks_removed AFTER DELETE ON tasks BEGIN ${dirty} END`);
  sql.exec(`CREATE TRIGGER tasks_added AFTER INSERT ON tasks BEGIN ${dirty} ${remember} END`);
}

export class EditableTaskStorage {
  constructor(storage) { this.storage = storage; this.sql = storage.sql; this.ready = false; }

  schema() {
    const tables = this.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('scheduler_schema', 'scheduler_state', 'tasks') ORDER BY name`).toArray().map(row => row.name);
    if (canonical(tables) !== canonical(['scheduler_schema', 'scheduler_state', 'tasks'])) corrupt();
    const rows = this.sql.exec('SELECT * FROM scheduler_schema').toArray();
    if (rows.length !== 1 || rows[0].version !== 3 || rows[0].singleton !== 1 ||
        ![0, 1].includes(rows[0].initialized) || !Number.isSafeInteger(rows[0].task_generation)) corrupt();
    return rows[0];
  }

  async ensure() {
    if (this.ready) return;
    if (await this.storage.get(EDITABLE_MARKER_KEY) !== undefined) {
      if (canonical(await this.storage.get(EDITABLE_MARKER_KEY)) !== canonical({ version: 3 })) corrupt();
      this.schema();
      const existing = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tasks'").toArray().map(row => row.name).sort();
      if (canonical(existing) !== canonical([...triggerNames].sort())) corrupt();
    } else {
      const legacy = new LegacySQLTaskStorage(this.storage);
      legacy.sql = this.sql;
      await legacy.ensure();
      await this.storage.transaction(async tx => {
        if (await tx.get(EDITABLE_BACKUP_KEY) !== undefined) corrupt();
        const record = await legacy.read(), oldSchema = legacy.schema();
        await tx.put(EDITABLE_BACKUP_KEY, { kind: 'editable-sql-upgrade', record, sha256: await sha256(record), createdAt: new Date().toISOString() });
        this.sql.exec(`CREATE TABLE tasks_v3 (
          id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
          position INTEGER NOT NULL UNIQUE CHECK (typeof(position) = 'integer' AND position >= 0),
          config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'
            AND json_type(config_json, '$.id') IS 'text' AND json_extract(config_json, '$.id') = id
            AND json_type(config_json, '$.url') IS 'text' AND json_type(config_json, '$.cron') IS 'text'),
          name, url TEXT, method TEXT, cron TEXT,
          enabled INTEGER CHECK (enabled IS NULL OR enabled IN (0, 1)), created_at, updated_at,
          headers_json TEXT CHECK (headers_json IS NULL OR (json_valid(headers_json) AND json_type(headers_json) = 'object')),
          params_json TEXT CHECK (params_json IS NULL OR (json_valid(params_json) AND json_type(params_json) = 'object')),
          body_json TEXT CHECK (body_json IS NULL OR json_valid(body_json))
        )`);
        this.sql.exec('INSERT INTO tasks_v3 (id, position, config_json) SELECT id, position, config_json FROM tasks');
        this.sql.exec('DROP TABLE tasks');
        this.sql.exec('ALTER TABLE tasks_v3 RENAME TO tasks');
        this.sql.exec('ALTER TABLE scheduler_state ADD COLUMN synced_generation INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('DROP TABLE scheduler_schema');
        this.sql.exec(`CREATE TABLE scheduler_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL CHECK (version = 3), initialized INTEGER NOT NULL CHECK (initialized IN (0, 1)),
          created_at TEXT NOT NULL, task_generation INTEGER NOT NULL DEFAULT 0 CHECK (task_generation >= 0))`);
        this.sql.exec('INSERT INTO scheduler_schema (singleton, version, initialized, created_at) VALUES (1, 3, ?, ?)', oldSchema.initialized, oldSchema.created_at);
        const projection = fields.map(([c, k, t]) => `${c} = ${projected(c, k, t, 'config_json')}`).join(', ');
        this.sql.exec(`UPDATE tasks SET ${projection}`);
        createTriggers(this.sql);
        if (canonical(await this.read()) !== canonical(record)) corrupt();
        await tx.put(EDITABLE_MARKER_KEY, { version: 3 });
      });
    }
    this.ready = true;
  }

  async transaction(callback) {
    for (let attempt = 0; attempt < 8; attempt++) {
      try { return await this.storage.transaction(callback); }
      catch (error) { if (!(error instanceof SQLConflict) || attempt === 7) throw error; }
    }
  }

  // Caller holds a transaction. Generation checks also protect against Data
  // Studio SQL interleaving while WebCrypto hashes yield the actor.
  async read() {
    const schema = this.schema();
    const states = this.sql.exec('SELECT * FROM scheduler_state').toArray();
    const rows = this.sql.exec('SELECT id, position, config_json FROM tasks ORDER BY position').toArray();
    if (!schema.initialized) { if (states.length || rows.length) corrupt(); return null; }
    if (states.length !== 1 || states[0].singleton !== 1) corrupt();
    const state = states[0];
    let tasks, knownTaskIds;
    try {
      tasks = rows.map(row => { const task = JSON.parse(row.config_json); if (task.id !== row.id) corrupt(); return task; });
      knownTaskIds = JSON.parse(state.known_task_ids_json);
    } catch { corrupt(); }
    const dirty = state.synced_generation !== schema.task_generation;
    const snapshot = dirty ? await makeSnapshot(tasks, state.revision + 1)
      : { version: 1, revision: state.revision, updatedAt: state.updated_at, taskCount: state.task_count, sha256: state.sha256, tasks };
    const record = await validateRecord({ mode: state.mode, migrationId: state.migration_id, knownTaskIds,
      ...(state.rollback_id === null ? {} : { rollbackId: state.rollback_id }), snapshot });
    if (this.schema().task_generation !== schema.task_generation) throw new SQLConflict();
    if (dirty) {
      this.sql.exec(`UPDATE scheduler_state SET revision = ?, updated_at = ?, task_count = ?, sha256 = ?, synced_generation = ?
        WHERE singleton = 1`, snapshot.revision, snapshot.updatedAt, snapshot.taskCount, snapshot.sha256, schema.task_generation);
    }
    Object.defineProperty(record, generation, { value: schema.task_generation });
    return record;
  }

  write(record) {
    const current = this.schema().task_generation;
    if (record[generation] !== undefined && record[generation] !== current) throw new SQLConflict();
    const snapshot = record.snapshot;
    const previous = this.sql.exec('SELECT id, config_json FROM tasks ORDER BY position').toArray();
    const same = canonical(previous.map(row => JSON.parse(row.config_json))) === canonical(snapshot.tasks);
    if (!same) {
      this.sql.exec('DELETE FROM tasks');
      for (let position = 0; position < snapshot.tasks.length; position++) {
        const task = snapshot.tasks[position];
        this.sql.exec('INSERT INTO tasks (id, position, config_json) VALUES (?, ?, ?)', task.id, position, JSON.stringify(task));
      }
    }
    this.sql.exec(`INSERT OR REPLACE INTO scheduler_state
      (singleton, mode, migration_id, rollback_id, revision, updated_at, task_count, sha256, known_task_ids_json, synced_generation)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.mode, record.migrationId, record.rollbackId ?? null,
      snapshot.revision, snapshot.updatedAt, snapshot.taskCount, snapshot.sha256, JSON.stringify(record.knownTaskIds), this.schema().task_generation);
    this.sql.exec('UPDATE scheduler_schema SET initialized = 1 WHERE singleton = 1');
  }
}
