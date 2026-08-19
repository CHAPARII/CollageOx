const { Pool } = require('pg');

function postgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function queryMethods(query) {
  return {
    async all(sql, params = []) {
      return (await query(postgresSql(sql), params)).rows;
    },
    async get(sql, params = []) {
      return (await query(postgresSql(sql), params)).rows[0] || null;
    },
    async run(sql, params = []) {
      const result = await query(postgresSql(sql), params);
      return { rowCount: result.rowCount || 0 };
    },
    async exec(sql) {
      await query(sql);
    }
  };
}

class PostgresDatabase {
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_SIZE || 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    this.kind = 'postgres';
    Object.assign(this, queryMethods((sql, params) => this.pool.query(sql, params)));
  }

  async transaction(task) {
    const client = await this.pool.connect();
    const scoped = queryMethods((sql, params) => client.query(sql, params));
    try {
      await client.query('BEGIN');
      const result = await task(scoped);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { PostgresDatabase, postgresSql };
