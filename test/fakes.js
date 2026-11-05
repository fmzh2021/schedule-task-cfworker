import assert from 'node:assert/strict';
import { SchedulerStore } from '../src/scheduler-store.js';
import { STORE_NAME } from '../src/storage-format.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
export class FakeStorage {
  constructor() { this.data = new Map(); this.tail = Promise.resolve(); this.fail = false; }
  async get(key) { if (this.fail) throw new Error('provider-secret'); return clone(this.data.get(key)); }
  async put(key, value) { if (this.fail) throw new Error('provider-secret'); this.data.set(key, clone(value)); }
  async delete(key) { if (this.fail) throw new Error('provider-secret'); return this.data.delete(key); }
  transaction(callback) {
    const run = this.tail.then(async () => {
      if (this.fail) throw new Error('provider-secret');
      const working = new FakeStorage();
      working.data = clone(this.data);
      const result = await callback(working);
      this.data = working.data;
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
export class FakeKV {
  constructor(tasks = [], pageSize = 2) {
    this.data = new Map(tasks.map(task => [`task:${task.id}`, JSON.stringify(task)]));
    this.pageSize = pageSize;
    this.calls = { get: 0, list: 0, put: 0, delete: 0 };
    this.fail = null;
    this.hook = null;
  }
  async before(operation, key) {
    this.calls[operation]++;
    if (this.hook) await this.hook(operation, key);
    if (this.fail === operation || this.fail === '*') throw new Error('provider-secret');
  }
  async get(key) { await this.before('get', key); return this.data.get(key) ?? null; }
  async put(key, value) { await this.before('put', key); this.data.set(key, value); }
  async delete(key) { await this.before('delete', key); this.data.delete(key); }
  async list({ prefix = '', cursor } = {}) {
    await this.before('list', cursor);
    const keys = [...this.data.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0, end = start + this.pageSize;
    return { keys: keys.slice(start, end).map(name => ({ name })), list_complete: end >= keys.length,
      cursor: end >= keys.length ? '' : String(end) };
  }
  resetCounts() { Object.keys(this.calls).forEach(key => { this.calls[key] = 0; }); }
}
export const task = (id, patch = {}) => ({ id, name: id, url: 'https://task.invalid/run', method: 'GET',
  cron: '* * * * *', headers: {}, params: {}, body: null, enabled: true,
  createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', ...patch });
export function harness(tasks = []) {
  const storage = new FakeStorage(), kv = new FakeKV(tasks), state = { storage };
  const env = { API_KEY: 'test-api-key', TASKS_KV: kv };
  let store = new SchedulerStore(state, env), requests = 0;
  env.SCHEDULER_STORE = {
    idFromName(name) { assert.equal(name, STORE_NAME); return name; },
    get(id) {
      assert.equal(id, STORE_NAME);
      return { fetch(input, init) { requests++; return store.fetch(new Request(input, init)); } };
    },
  };
  return { env, kv, storage, get requests() { return requests; }, reboot() { store = new SchedulerStore(state, env); } };
}
export function context() {
  const promises = [];
  return { waitUntil(promise) { promises.push(promise); }, drain() { return Promise.all(promises); } };
}
