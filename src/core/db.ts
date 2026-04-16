import postgres from 'postgres';
import { PBrainError, type EngineConfig } from './types.ts';
import { SCHEMA_SQL } from './schema-embedded.ts';

let sql: ReturnType<typeof postgres> | null = null;
let connectedUrl: string | null = null;

export function getConnection(): ReturnType<typeof postgres> {
  if (!sql) {
    throw new PBrainError(
      'No database connection',
      'connect() has not been called',
      'Run pbrain init --supabase or pbrain init --url <connection_string>',
    );
  }
  return sql;
}

export async function connect(config: EngineConfig): Promise<void> {
  if (sql) {
    // Warn if a different URL is passed — the old connection is still in use
    if (config.database_url && connectedUrl && config.database_url !== connectedUrl) {
      console.warn('[pbrain] connect() called with a different database_url but a connection already exists. Using existing connection.');
    }
    return;
  }

  const url = config.database_url;
  if (!url) {
    throw new PBrainError(
      'No database URL',
      'database_url is missing from config',
      'Run pbrain init --supabase or pbrain init --url <connection_string>',
    );
  }

  try {
    sql = postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      types: {
        // Register pgvector type
        bigint: postgres.BigInt,
      },
    });

    // Test connection
    await sql`SELECT 1`;
    connectedUrl = url;
  } catch (e: unknown) {
    sql = null;
    connectedUrl = null;
    const msg = e instanceof Error ? e.message : String(e);
    throw new PBrainError(
      'Cannot connect to database',
      msg,
      'Check your connection URL in ~/.pbrain/config.json',
    );
  }
}

export async function disconnect(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
    connectedUrl = null;
  }
}

export async function initSchema(): Promise<void> {
  const conn = getConnection();
  // Advisory lock prevents concurrent initSchema() calls from deadlocking
  await conn`SELECT pg_advisory_lock(42)`;
  try {
    await conn.unsafe(SCHEMA_SQL);
  } finally {
    await conn`SELECT pg_advisory_unlock(42)`;
  }
}

export async function withTransaction<T>(fn: (tx: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const conn = getConnection();
  return conn.begin(async (tx) => {
    return fn(tx as unknown as ReturnType<typeof postgres>);
  });
}
