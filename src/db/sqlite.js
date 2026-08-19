const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class SqliteDatabase {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.client = new DatabaseSync(file);
    this.client.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.kind = 'sqlite';
  }

  async all(sql, params = []) {
    return this.client.prepare(sql).all(...params);
  }

  async get(sql, params = []) {
    return this.client.prepare(sql).get(...params) || null;
  }

  async run(sql, params = []) {
    const result = this.client.prepare(sql).run(...params);
    return { rowCount: Number(result.changes || 0) };
  }

  async exec(sql) {
    this.client.exec(sql);
  }

  async transaction(task) {
    this.client.exec('BEGIN');
    try {
      const result = await task(this);
      this.client.exec('COMMIT');
      return result;
    } catch (error) {
      this.client.exec('ROLLBACK');
      throw error;
    }
  }

  async close() {
    this.client.close();
  }
}

module.exports = { SqliteDatabase };
