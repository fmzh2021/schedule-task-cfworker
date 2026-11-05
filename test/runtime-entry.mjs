// Local workerd test entry ONLY. These private inspection/seeding hooks are
// absent from src/index.js and the production dist/index.js bundle.
import worker, { SchedulerStore as ProductionStore } from '../dist/index.js';
export default worker;

export class SchedulerStore extends ProductionStore {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__test/seed') {
      const { record } = await request.json();
      await this.storage.put('scheduler:tasks:v1', record);
      return Response.json({ seeded: true });
    }
    if (path === '/__test/query') {
      const { query, bindings = [] } = await request.json();
      return Response.json(this.storage.sql.exec(query, ...bindings).toArray());
    }
    if (path === '/__test/keys') {
      const keys = ['scheduler:sql:v2:activated', 'scheduler:sql:v2:legacy-backup', 'scheduler:tasks:v1'];
      const values = await this.storage.get(keys);
      return Response.json(Object.fromEntries(values));
    }
    if (path === '/__test/atomicity') {
      try {
        await this.storage.transaction(async tx => {
          this.storage.sql.exec('CREATE TABLE atomicity_probe (id TEXT)');
          this.storage.sql.exec("INSERT INTO atomicity_probe VALUES ('must-rollback')");
          await tx.put('atomicity-probe', 'must-rollback');
          throw new Error('intentional-rollback');
        });
      } catch (error) {
        if (error.message !== 'intentional-rollback') throw error;
      }
      return Response.json({
        tables: this.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'atomicity_probe'").toArray(),
        kvExists: await this.storage.get('atomicity-probe') !== undefined,
      });
    }
    if (path === '/__test/failed-upgrade') {
      const original = this.records.sql;
      let inserts = 0;
      this.records.sql = { exec: (query, ...bindings) => {
        if (query.startsWith('INSERT INTO tasks') && ++inserts === 2) throw new Error('intentional-upgrade-failure');
        return original.exec(query, ...bindings);
      } };
      try { return await super.fetch(new Request('https://scheduler.internal/tasks')); }
      finally { this.records.sql = original; }
    }
    return super.fetch(request);
  }
}
