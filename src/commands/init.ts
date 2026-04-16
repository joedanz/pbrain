import { execSync } from 'child_process';
import { readdirSync, lstatSync, existsSync, copyFileSync, mkdirSync, readFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { saveConfig, type PBrainConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';

export async function runInit(args: string[]) {
  const isSupabase = args.includes('--supabase');
  const isPGLite = args.includes('--pglite');
  const isNonInteractive = args.includes('--non-interactive');
  const jsonOutput = args.includes('--json');
  const urlIndex = args.indexOf('--url');
  const manualUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;
  const keyIndex = args.indexOf('--key');
  const apiKey = keyIndex !== -1 ? args[keyIndex + 1] : null;
  const pathIndex = args.indexOf('--path');
  const customPath = pathIndex !== -1 ? args[pathIndex + 1] : null;

  await maybeMigrateGBrainConfigDir({ isNonInteractive, jsonOutput });

  // Explicit PGLite mode
  if (isPGLite || (!isSupabase && !manualUrl && !isNonInteractive)) {
    // Smart detection: scan for .md files unless --pglite flag forces it
    if (!isPGLite && !isSupabase) {
      const fileCount = countMarkdownFiles(process.cwd());
      if (fileCount >= 1000) {
        console.log(`Found ~${fileCount} .md files. For a brain this size, Supabase gives faster`);
        console.log('search and remote access ($25/mo). PGLite works too but search will be slower at scale.');
        console.log('');
        console.log('  pbrain init --supabase   Set up with Supabase (recommended for large brains)');
        console.log('  pbrain init --pglite     Use local PGLite anyway');
        console.log('');
        // Default to PGLite, let the user choose Supabase if they want
      }
    }

    return initPGLite({ jsonOutput, apiKey, customPath });
  }

  // Supabase/Postgres mode
  let databaseUrl: string;
  if (manualUrl) {
    databaseUrl = manualUrl;
  } else if (isNonInteractive) {
    const envUrl = process.env.PBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (envUrl) {
      databaseUrl = envUrl;
    } else {
      console.error('--non-interactive requires --url <connection_string> or PBRAIN_DATABASE_URL env var');
      process.exit(1);
    }
  } else {
    databaseUrl = await supabaseWizard();
  }

  return initPostgres({ databaseUrl, jsonOutput, apiKey });
}

async function initPGLite(opts: { jsonOutput: boolean; apiKey: string | null; customPath: string | null }) {
  const dbPath = opts.customPath || join(homedir(), '.pbrain', 'brain.pglite');
  console.log(`Setting up local brain with PGLite (no server needed)...`);

  const engine = await createEngine({ engine: 'pglite' });
  await engine.connect({ database_path: dbPath, engine: 'pglite' });
  await engine.initSchema();

  const config: PBrainConfig = {
    engine: 'pglite',
    database_path: dbPath,
    ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
  };
  saveConfig(config);

  const stats = await engine.getStats();
  await engine.disconnect();

  if (opts.jsonOutput) {
    console.log(JSON.stringify({ status: 'success', engine: 'pglite', path: dbPath, pages: stats.page_count }));
  } else {
    console.log(`\nBrain ready at ${dbPath}`);
    console.log(`${stats.page_count} pages. Engine: PGLite (local Postgres).`);
    console.log('Next: pbrain import <dir>');
    console.log('');
    console.log('When you outgrow local: pbrain migrate --to supabase');
    reportModStatus();
  }
}

async function initPostgres(opts: { databaseUrl: string; jsonOutput: boolean; apiKey: string | null }) {
  const { databaseUrl } = opts;

  // Detect Supabase direct connection URLs and warn about IPv6
  if (databaseUrl.match(/db\.[a-z]+\.supabase\.co/) || databaseUrl.includes('.supabase.co:5432')) {
    console.warn('');
    console.warn('WARNING: You provided a Supabase direct connection URL (db.*.supabase.co:5432).');
    console.warn('  Direct connections are IPv6 only and fail in many environments.');
    console.warn('  Use the Session pooler connection string instead (port 6543):');
    console.warn('  Supabase Dashboard > gear icon (Project Settings) > Database >');
    console.warn('  Connection string > URI tab > change dropdown to "Session pooler"');
    console.warn('');
  }

  console.log('Connecting to database...');
  const engine = await createEngine({ engine: 'postgres' });
  try {
    await engine.connect({ database_url: databaseUrl });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (databaseUrl.includes('supabase.co') && (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT'))) {
      console.error('Connection failed. Supabase direct connections (db.*.supabase.co:5432) are IPv6 only.');
      console.error('Use the Session pooler connection string instead (port 6543).');
    }
    throw e;
  }

  // Check and auto-create pgvector extension
  try {
    const conn = (engine as any).sql || (await import('../core/db.ts')).getConnection();
    const ext = await conn`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    if (ext.length === 0) {
      console.log('pgvector extension not found. Attempting to create...');
      try {
        await conn`CREATE EXTENSION IF NOT EXISTS vector`;
        console.log('pgvector extension created successfully.');
      } catch {
        console.error('Could not auto-create pgvector extension. Run manually in SQL Editor:');
        console.error('  CREATE EXTENSION vector;');
        await engine.disconnect();
        process.exit(1);
      }
    }
  } catch {
    // Non-fatal
  }

  console.log('Running schema migration...');
  await engine.initSchema();

  const config: PBrainConfig = {
    engine: 'postgres',
    database_url: databaseUrl,
    ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
  };
  saveConfig(config);
  console.log('Config saved to ~/.pbrain/config.json');

  const stats = await engine.getStats();
  await engine.disconnect();

  if (opts.jsonOutput) {
    console.log(JSON.stringify({ status: 'success', engine: 'postgres', pages: stats.page_count }));
  } else {
    console.log(`\nBrain ready. ${stats.page_count} pages. Engine: Postgres (Supabase).`);
    console.log('Next: pbrain import <dir>');
    reportModStatus();
  }
}

/**
 * Quick count of .md files in a directory (stops early at 1000).
 */
function countMarkdownFiles(dir: string, maxScan = 1500): number {
  let count = 0;
  try {
    const scan = (d: string) => {
      if (count >= maxScan) return;
      for (const entry of readdirSync(d)) {
        if (count >= maxScan) return;
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const full = join(d, entry);
        try {
          let stat;
          try {
            stat = lstatSync(full);
          } catch { continue; }
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) scan(full);
          else if (entry.endsWith('.md')) count++;
        } catch { /* skip unreadable */ }
      }
    };
    scan(dir);
  } catch { /* skip unreadable root */ }
  return count;
}

async function supabaseWizard(): Promise<string> {
  try {
    execSync('bunx supabase --version', { stdio: 'pipe' });
    console.log('Supabase CLI detected.');
    console.log('To auto-provision, run: bunx supabase login && bunx supabase projects create');
    console.log('Then use: pbrain init --url <your-connection-string>');
  } catch {
    console.log('Supabase CLI not found.');
  }

  console.log('\nEnter your Supabase/Postgres connection URL:');
  console.log('  Format: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres');
  console.log('  Find it: Supabase Dashboard > Connect (top bar) > Connection String > Session Pooler\n');

  const url = await readLine('Connection URL: ');
  if (!url) {
    console.error('No URL provided.');
    process.exit(1);
  }
  return url;
}

/**
 * One-time migration: if ~/.gbrain/ exists from a previous GBrain install and
 * ~/.pbrain/ doesn't yet, offer to rename it. Non-destructive — requires consent
 * in interactive mode; skipped silently in --non-interactive or --json mode.
 */
async function maybeMigrateGBrainConfigDir(
  opts: { isNonInteractive: boolean; jsonOutput: boolean }
): Promise<void> {
  const legacyDir = join(homedir(), '.gbrain');
  const newDir = join(homedir(), '.pbrain');
  if (!existsSync(legacyDir) || existsSync(newDir)) return;

  if (opts.isNonInteractive || opts.jsonOutput) {
    console.error(`Found legacy ~/.gbrain/ — rerun \`pbrain init\` interactively to migrate, or rename manually.`);
    return;
  }

  console.log('');
  console.log('Found a legacy ~/.gbrain/ directory from a previous GBrain install.');
  console.log('PBrain uses ~/.pbrain/ instead.');
  const answer = await readLine('Rename ~/.gbrain/ → ~/.pbrain/ now? [Y/n]: ');
  const normalized = (answer || '').trim().toLowerCase();
  if (normalized === '' || normalized === 'y' || normalized === 'yes') {
    renameSync(legacyDir, newDir);
    console.log(`Renamed ~/.gbrain → ~/.pbrain`);
  } else {
    console.log(`Skipped. PBrain will use a fresh ~/.pbrain/. Your old ~/.gbrain/ is untouched.`);
  }
  console.log('');
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (chunk) => {
      data = chunk.toString().trim();
      process.stdin.pause();
      resolve(data);
    });
    process.stdin.resume();
  });
}

/**
 * Detect GStack installation across known host paths.
 * Uses gstack-global-discover if available, falls back to path checking.
 */
export function detectGStack(): { found: boolean; path: string | null; host: string | null } {
  // Try gstack's own discovery tool first (DRY: don't reimplement host detection)
  try {
    const result = execSync(
      `${join(homedir(), '.claude', 'skills', 'gstack', 'bin', 'gstack-global-discover')} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (result) {
      return { found: true, path: result.split('\n')[0], host: 'auto-detected' };
    }
  } catch { /* binary not available */ }

  // Fallback: check known host paths
  const hostPaths = [
    { path: join(homedir(), '.claude', 'skills', 'gstack'), host: 'claude' },
    { path: join(homedir(), '.openclaw', 'skills', 'gstack'), host: 'openclaw' },
    { path: join(homedir(), '.codex', 'skills', 'gstack'), host: 'codex' },
    { path: join(homedir(), '.factory', 'skills', 'gstack'), host: 'factory' },
    { path: join(homedir(), '.kiro', 'skills', 'gstack'), host: 'kiro' },
  ];

  for (const { path, host } of hostPaths) {
    if (existsSync(join(path, 'SKILL.md')) || existsSync(join(path, 'setup'))) {
      return { found: true, path, host };
    }
  }

  return { found: false, path: null, host: null };
}

/**
 * Install default identity templates (SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md)
 * into the agent workspace. Uses minimal defaults, not the soul-audit interview.
 */
export function installDefaultTemplates(workspaceDir: string): string[] {
  const pbrainRoot = dirname(dirname(__dirname)); // up from src/commands/ to repo root
  const templatesDir = join(pbrainRoot, 'templates');
  const installed: string[] = [];

  const templates = [
    { src: 'SOUL.md.template', dest: 'SOUL.md' },
    { src: 'USER.md.template', dest: 'USER.md' },
    { src: 'ACCESS_POLICY.md.template', dest: 'ACCESS_POLICY.md' },
    { src: 'HEARTBEAT.md.template', dest: 'HEARTBEAT.md' },
  ];

  for (const { src, dest } of templates) {
    const srcPath = join(templatesDir, src);
    const destPath = join(workspaceDir, dest);
    if (existsSync(srcPath) && !existsSync(destPath)) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      installed.push(dest);
    }
  }

  return installed;
}

/**
 * Report post-init status including GStack detection and skill count.
 */
export function reportModStatus(): void {
  const gstack = detectGStack();
  const pbrainRoot = dirname(dirname(__dirname));
  const skillsDir = join(pbrainRoot, 'skills');

  let skillCount = 0;
  try {
    const manifest = JSON.parse(
      readFileSync(join(skillsDir, 'manifest.json'), 'utf-8')
    );
    skillCount = manifest.skills?.length || 0;
  } catch { /* manifest not found */ }

  console.log('');
  console.log('--- PBrain Mod Status ---');
  console.log(`Skills: ${skillCount} loaded`);
  console.log(`GStack: ${gstack.found ? `found (${gstack.host})` : 'not found'}`);
  if (!gstack.found) {
    console.log('  Install GStack for coding skills:');
    console.log('  git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack');
    console.log('  cd ~/.claude/skills/gstack && ./setup');
  }
  console.log('Resolver: skills/RESOLVER.md');
  console.log('Soul audit: run `pbrain soul-audit` to customize agent identity');
  console.log('');
}
