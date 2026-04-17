import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer } from '../mcp/server.ts';

export async function runServe(engine: BrainEngine) {
  console.error('Starting PBrain MCP server (stdio)...');

  // Release the PGLite lock on graceful shutdown. Without this, Claude Code's
  // SIGTERM leaves a lock file behind that only gets cleaned on the next
  // acquire's stale-detection pass — and in the meantime, CLI commands fail
  // with a timeout that looks like a bug.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await engine.disconnect();
    } catch { /* best-effort */ }
    process.exit(signal === 'SIGTERM' ? 143 : 130);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await startMcpServer(engine);
}
