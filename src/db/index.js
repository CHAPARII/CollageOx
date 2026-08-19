const path = require('node:path');
const { SqliteDatabase } = require('./sqlite');
const { PostgresDatabase } = require('./postgres');
const { applyMigrations } = require('./migrations');

function createDatabase() {
  const production = process.env.NODE_ENV === 'production';
  if (production && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when NODE_ENV=production. Render Free cannot persist a local SQLite database.');
  }
  if (process.env.DATABASE_URL) return new PostgresDatabase(process.env.DATABASE_URL);
  const file = process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'collegeox.db');
  return new SqliteDatabase(file);
}

async function initializeDatabase(db) {
  await applyMigrations(db);
  return db;
}

module.exports = { createDatabase, initializeDatabase };
