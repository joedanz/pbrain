import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { EngineConfig } from './types.ts';

// Lazy-evaluated to avoid calling homedir() at module scope (breaks in serverless/bundled environments)
function getConfigDir() { return join(homedir(), '.pbrain'); }
function getConfigPath() { return join(getConfigDir(), 'config.json'); }

export interface PBrainConfig {
  engine: 'postgres' | 'pglite';
  database_url?: string;
  database_path?: string;
  /**
   * Absolute path to the markdown brain folder (files are authoritative,
   * DB is the rebuildable index). Any filesystem path works: local, cloud-
   * synced mounts (GDrive Desktop, iCloud), or an Obsidian vault.
   * Kept OUTSIDE the brain folder so binary index files don't corrupt under
   * cloud sync — the index lives at `~/.pbrain/indexes/<name>.pglite`.
   */
  brain_path?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
}

/**
 * Load config with credential precedence: env vars > config file.
 * Plugin config is handled by the plugin runtime injecting env vars.
 */
export function loadConfig(): PBrainConfig | null {
  let fileConfig: PBrainConfig | null = null;
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    fileConfig = JSON.parse(raw) as PBrainConfig;
  } catch { /* no config file */ }

  const dbUrl = process.env.PBRAIN_DATABASE_URL || process.env.DATABASE_URL;

  if (!fileConfig && !dbUrl) return null;

  const inferredEngine: 'postgres' | 'pglite' = fileConfig?.engine
    || (fileConfig?.database_path ? 'pglite' : 'postgres');

  const merged = {
    ...fileConfig,
    engine: inferredEngine,
    ...(dbUrl ? { database_url: dbUrl } : {}),
    ...(process.env.OPENAI_API_KEY ? { openai_api_key: process.env.OPENAI_API_KEY } : {}),
  };
  return merged as PBrainConfig;
}

export function saveConfig(config: PBrainConfig): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(getConfigPath(), 0o600);
  } catch {
    // chmod may fail on some platforms
  }
}

export function toEngineConfig(config: PBrainConfig): EngineConfig {
  return {
    engine: config.engine,
    database_url: config.database_url,
    database_path: config.database_path,
  };
}

export function configDir(): string {
  return join(homedir(), '.pbrain');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}
