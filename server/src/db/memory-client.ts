import { createClient } from '@libsql/client';
import { is, sql, SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { memorySchema } from './memory-schema.js';

/**
 * Bootstrap newly provisioned per-user databases from their Drizzle entities.
 * This intentionally supports only this schema's columns and indexes, not migrations.
 * PostgreSQL schema changes continue to use db:push.
 */
export function memoryTableDDL(table: SQLiteTable): SQL[] {
  const config = getTableConfig(table);
  if (config.foreignKeys.length || config.checks.length || config.primaryKeys.length || config.uniqueConstraints.length) {
    throw new Error('Unsupported memory schema constraint');
  }
  const columns = config.columns.map(column => {
    if (column.isUnique || column.generated || column.defaultFn || column.onUpdateFn) throw new Error('Unsupported memory column configuration');
    const definition = sql`${sql.identifier(column.name)} ${sql.raw(column.getSQLType())}`;
    if (column.primary) definition.append(sql` PRIMARY KEY`);
    if (column.notNull) definition.append(sql` NOT NULL`);
    if (column.default !== undefined) {
      const value = is(column.default, SQL) ? column.default : sql`${sql.param(column.default, column)}`.inlineParams();
      definition.append(sql` DEFAULT ${value}`);
    }
    return definition;
  });
  return [sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(config.name)} (${sql.join(columns, sql`, `)})`,
    ...config.indexes.map(({ config: index }) => sql`CREATE ${index.unique ? sql`UNIQUE ` : sql``}INDEX IF NOT EXISTS ${sql.identifier(index.name)}
      ON ${sql.identifier(config.name)} (${sql.join(index.columns.map(column => is(column, SQL) ? column : sql.identifier(column.name)), sql`, `)})${index.where ? sql` WHERE ${index.where}` : sql``}`)];
}

export function createMemoryDatabase(url: string, dimensions: number, authToken?: string) {
  const schema = memorySchema(dimensions);
  const client = createClient({ url, ...(authToken ? { authToken } : {}) });
  const db = drizzle({ client });
  return {
    db, schema, close: () => client.close(),
    async initialize(model: string) {
      await db.transaction(async tx => {
        for (const table of Object.values(schema)) for (const statement of memoryTableDDL(table)) await tx.run(statement);
        await tx.insert(schema.memoryMeta).values([
          { key: 'embedding_model', value: model }, { key: 'embedding_dimensions', value: String(dimensions) },
        ]).onConflictDoNothing();
      });
    },
  };
}

export type MemoryDatabase = ReturnType<typeof createMemoryDatabase>;
