import type { BrainEngine } from './engine.ts';

/**
 * Schema migrations — run automatically on initSchema().
 *
 * Each migration is a version number + idempotent SQL. Migrations are embedded
 * as string constants (Bun's --compile strips the filesystem).
 *
 * Each migration runs in a transaction: if the SQL fails, the version stays
 * where it was and the next run retries cleanly.
 */

interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Migrations are embedded here, not loaded from files.
// Add new migrations at the end. Never modify existing ones.
const MIGRATIONS: Migration[] = [
  // Version 1 is the baseline (schema.sql creates everything with IF NOT EXISTS).
  // Future migrations go here:
  // { version: 2, name: 'add_aliases', sql: `ALTER TABLE pages ADD COLUMN IF NOT EXISTS aliases TEXT[];` },
];

export const LATEST_VERSION = MIGRATIONS.length > 0
  ? MIGRATIONS[MIGRATIONS.length - 1].version
  : 1;

export async function runMigrations(engine: BrainEngine): Promise<{ applied: number; current: number }> {
  const currentStr = await engine.getConfig('version');
  const current = parseInt(currentStr || '1', 10);

  let applied = 0;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      // Each migration is transactional
      await engine.transaction(async (tx) => {
        // Execute the migration SQL via raw connection
        // We need to access the underlying sql connection
        const eng = tx as any;
        const sql = eng.sql || eng._sql;
        if (sql) {
          await sql.unsafe(m.sql);
          await sql`UPDATE config SET value = ${String(m.version)} WHERE key = 'version'`;
        }
      });
      console.log(`  Migration ${m.version} applied: ${m.name}`);
      applied++;
    }
  }

  return { applied, current: applied > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : current };
}
