import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from './config';
@Injectable()
export class Db implements OnApplicationShutdown {
  readonly pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.pool.query<T>(sql, values)).rows;
  }
  async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async audit(actor: string, action: string, target: string | null = null, details: unknown = {}) {
    await this.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
      actor,
      action,
      target,
      JSON.stringify(details),
    ]);
  }
  async onApplicationShutdown() {
    await this.pool.end();
  }
}
export function camel(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, s: string) => s.toUpperCase()),
      v instanceof Date ? v.toISOString() : v,
    ]),
  );
}
