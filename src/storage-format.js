// Error text never includes user data or provider error messages.
const MESSAGES = {
  NOT_MIGRATED: '任务尚未迁移', DATA_CORRUPT: '任务存储数据损坏',
  STORAGE_UNAVAILABLE: '任务存储暂时不可用', KV_UNAVAILABLE: 'KV 操作失败',
  INVALID_TASK: '任务配置无效', INVALID_REQUEST: '请求参数无效',
  MIGRATION_MISMATCH: '旧任务与独立清单不一致', SOURCE_NOT_FROZEN: '迁移需要先冻结旧格式写入',
  MIGRATION_CONFLICT: '迁移准备状态冲突', BACKUP_NOT_VISIBLE: 'KV 备份尚不可见或校验失败，请稍后重试',
  WRITES_FROZEN: '任务写入已为回滚冻结', ROLLBACK_MISMATCH: '回滚数据校验失败，保持写入冻结',
  TASK_EXECUTION_FAILED: '任务请求执行失败',
};
export class SchedulerError extends Error {
  constructor(code, status = 503) {
    super(MESSAGES[code] || MESSAGES.STORAGE_UNAVAILABLE);
    this.code = code;
    this.status = status;
  }
}
export const safeError = (error, fallback = 'STORAGE_UNAVAILABLE') =>
  error instanceof SchedulerError ? error : new SchedulerError(fallback);
export const TASKS_KEY = 'scheduler:tasks:v1';
export const STORE_NAME = 'scheduler-tasks-v1';
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function validateTask(task, code = 'INVALID_TASK') {
  const fail = () => { throw new SchedulerError(code, code === 'INVALID_TASK' ? 400 : 500); };
  if (!object(task) || typeof task.id !== 'string' || !task.id || typeof task.url !== 'string' ||
      typeof task.cron !== 'string' || task.cron.trim().split(/\s+/).length !== 5) fail();
  try { if (!['http:', 'https:'].includes(new URL(task.url).protocol)) fail(); } catch { fail(); }
  if (task.method !== undefined && (typeof task.method !== 'string' || !/^[A-Za-z]+$/.test(task.method))) fail();
  if (task.headers !== undefined && !object(task.headers)) fail();
  if (task.params !== undefined && !object(task.params)) fail();
  if (task.enabled !== undefined && typeof task.enabled !== 'boolean') fail();
  return task;
}
export async function manifestFor(tasks) {
  const manifest = [];
  const ids = new Set();
  for (const task of tasks) {
    validateTask(task, 'DATA_CORRUPT');
    if (ids.has(task.id)) throw new SchedulerError('DATA_CORRUPT', 500);
    ids.add(task.id);
    manifest.push({ id: task.id, sha256: await sha256(task) });
  }
  return manifest.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export async function makeSnapshot(tasks, revision = 1) {
  const manifest = await manifestFor(tasks);
  return { version: 1, revision, updatedAt: new Date().toISOString(), tasks,
    taskCount: tasks.length, sha256: await sha256(manifest) };
}
export async function validateSnapshot(snapshot) {
  if (!object(snapshot) || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 1 || !Array.isArray(snapshot.tasks) || snapshot.taskCount !== snapshot.tasks.length ||
      typeof snapshot.updatedAt !== 'string' ||
      snapshot.sha256 !== await sha256(await manifestFor(snapshot.tasks))) {
    throw new SchedulerError('DATA_CORRUPT', 500);
  }
  return snapshot;
}
export async function validateRecord(value) {
  if (!object(value) || !['active', 'rollback-frozen', 'rollback-ready'].includes(value.mode) ||
      typeof value.migrationId !== 'string' || !Array.isArray(value.knownTaskIds) ||
      value.knownTaskIds.some(id => typeof id !== 'string' || !id) ||
      new Set(value.knownTaskIds).size !== value.knownTaskIds.length ||
      (value.rollbackId !== undefined && typeof value.rollbackId !== 'string')) {
    throw new SchedulerError('DATA_CORRUPT', 500);
  }
  await validateSnapshot(value.snapshot);
  if (value.snapshot.tasks.some(task => !value.knownTaskIds.includes(task.id))) throw new SchedulerError('DATA_CORRUPT', 500);
  return value;
}
