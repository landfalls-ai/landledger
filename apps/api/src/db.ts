import postgres from 'postgres';

export type Sql = postgres.Sql;
/** A connection or a transaction: what a function that writes needs. */
export type Tx = postgres.Sql | postgres.TransactionSql;

export function createSql(url: string): Sql {
  return postgres(url, { max: 10, onnotice: () => {} });
}

/** Runs `fn` in a transaction, or inside the caller's when it already is one. */
export async function inTransaction<T>(sql: Tx, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  if ('savepoint' in sql) return fn(sql);
  return (await (sql as Sql).begin(fn)) as T;
}

/** A Postgres date column (`Date` at UTC midnight) as `YYYY-MM-DD`. */
export const day = (d: Date | string): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
