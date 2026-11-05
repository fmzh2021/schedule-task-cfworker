import { SchedulerError, STORE_NAME } from './storage-format.js';

// One stable actor name for ALL Worker instances; no isolate-local write lock.
export async function storeRequest(env, path, method = 'GET', body) {
  let response;
  try {
    const id = env.SCHEDULER_STORE.idFromName(STORE_NAME);
    response = await env.SCHEDULER_STORE.get(id).fetch(`https://scheduler.internal${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    });
  } catch { throw new SchedulerError('STORAGE_UNAVAILABLE'); }
  let result;
  try { result = await response.json(); } catch { throw new SchedulerError('STORAGE_UNAVAILABLE'); }
  if (!response.ok) throw new SchedulerError(result.code || 'STORAGE_UNAVAILABLE', response.status);
  return result.data;
}
export async function getAllTasks(env) {
  const snapshot = await storeRequest(env, '/tasks');
  console.log(JSON.stringify({ event: 'tasks_loaded', source: 'durable_object', cacheHit: false,
    revision: snapshot.revision, taskCount: snapshot.taskCount, kv: { get: 0, list: 0, put: 0, delete: 0 } }));
  return snapshot.tasks;
}
export const getTask = (env, id) => storeRequest(env, `/task?id=${encodeURIComponent(id)}`);
export const saveTask = (env, id, task) => storeRequest(env, '/task', 'POST', { ...task, id });
export const updateTask = (env, id, patch) => storeRequest(env, `/task?id=${encodeURIComponent(id)}`, 'PUT', patch);
export const deleteTask = (env, id) => storeRequest(env, `/task?id=${encodeURIComponent(id)}`, 'DELETE');
export const getTasksByCron = async (env, cron) => (await getAllTasks(env)).filter(task => task.cron === cron);
