/**
 * pbrain install-skills — symlink PBrain's skill files into Claude Code,
 * Cursor, and Windsurf skill-discovery directories so the skills auto-fire
 * in those clients.
 *
 * Auto-invoked by `pbrain init` (prompted) and `pbrain upgrade` (silent).
 * Manual use: `pbrain install-skills`, `pbrain install-skills status`,
 * `pbrain install-skills uninstall`.
 *
 * Exit codes:
 *   0 — everything installed (including idempotent re-runs and dry runs)
 *   1 — hard error (repo not found, target dir unwritable, etc.)
 *   2 — some skills skipped due to name collisions (run with --force to replace)
 */

import {
  ALL_CLIENTS,
  applyPlan,
  applyUninstall,
  detectClients,
  enumerateSkills,
  findRepoRoot,
  planInstall,
  planUninstall,
  resolveTargetDirs,
  scanTargets,
  type Action,
  type Client,
  type Scope,
  type StatusEntry,
  type Target,
} from '../core/skill-installer.ts';

interface ParsedArgs {
  sub: 'install' | 'status' | 'uninstall';
  scope: Scope;
  clients: Client[] | null; // null means "auto-detect"
  force: boolean;
  dryRun: boolean;
  json: boolean;
  fromUpgrade: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {
    sub: 'install',
    scope: 'user',
    clients: null,
    force: false,
    dryRun: false,
    json: false,
    fromUpgrade: false,
    help: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--force') { out.force = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--from-upgrade') { out.fromUpgrade = true; continue; }
    if (a === '--project') { out.scope = 'project'; continue; }
    if (a === '--scope') {
      const v = args[++i];
      if (v !== 'user' && v !== 'project') throw new Error(`--scope must be 'user' or 'project' (got ${v})`);
      out.scope = v;
      continue;
    }
    if (a === '--client') {
      const v = args[++i];
      if (v === 'all') { out.clients = [...ALL_CLIENTS]; continue; }
      if (!ALL_CLIENTS.includes(v as Client)) {
        throw new Error(`--client must be one of: ${ALL_CLIENTS.join(', ')}, all (got ${v})`);
      }
      out.clients = [v as Client];
      continue;
    }
    if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    positional.push(a);
  }

  if (positional.length > 0) {
    const sub = positional[0];
    if (sub !== 'install' && sub !== 'status' && sub !== 'uninstall') {
      throw new Error(`Unknown subcommand: ${sub}`);
    }
    out.sub = sub;
  }
  return out;
}

function printHelp() {
  console.log(`Usage: pbrain install-skills [subcommand] [options]

Symlink PBrain's 26 skills into Claude Code / Cursor / Windsurf so they
auto-fire in those clients. Idempotent: re-running updates symlinks for any
new skills and leaves existing ones alone.

Subcommands:
  install (default)     Create symlinks for every PBrain skill
  status                Show what's installed where (and any collisions)
  uninstall             Remove only the symlinks pointing into this repo

Options:
  --scope user|project  user: ~/.<client>/skills (default)
                        project: ./.<client>/skills for per-repo skill sets
  --project             Shortcut for --scope project
  --client <name>       claude, cursor, windsurf, or all (default: auto-detect)
  --force               Overwrite existing entries that aren't ours
                        (refuses to remove real directories — only files/symlinks)
  --dry-run             Print actions without touching the filesystem
  --json                Machine-readable output
  -h, --help            Show this help

Examples:
  pbrain install-skills                      # auto-detect installed clients
  pbrain install-skills --client claude      # only Claude Code
  pbrain install-skills --project            # install into ./.claude/skills etc.
  pbrain install-skills status               # see what's installed
  pbrain install-skills uninstall            # remove pbrain symlinks`);
}

export async function runInstallSkills(args: string[]): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  if (parsed.help) {
    printHelp();
    return;
  }

  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    if (parsed.json) console.log(JSON.stringify({ ok: false, error: 'pbrain repo not found' }));
    else console.error('Error: could not locate the PBrain repo. Run this command from a clone of pbrain.');
    process.exit(1);
  }

  const clients = parsed.clients ?? detectClients();
  if (clients.length === 0) {
    if (parsed.fromUpgrade) {
      // Silent no-op during upgrades on machines that aren't using any
      // supported client — don't make upgrade noisy.
      if (parsed.json) console.log(JSON.stringify({ ok: true, skipped: 'no-clients-detected' }));
      return;
    }
    if (parsed.json) console.log(JSON.stringify({ ok: true, skipped: 'no-clients-detected' }));
    else console.log('No Claude Code, Cursor, or Windsurf config dir detected under your home.\nNothing to do. Use --client <name> to force a target.');
    return;
  }

  const targets = resolveTargetDirs({ scope: parsed.scope, clients });

  if (parsed.sub === 'status') {
    runStatus(targets, repoRoot, parsed);
    return;
  }
  if (parsed.sub === 'uninstall') {
    runUninstall(targets, repoRoot, parsed);
    return;
  }

  runInstall(repoRoot, targets, parsed);
}

function runInstall(repoRoot: string, targets: Target[], parsed: ParsedArgs) {
  const skills = enumerateSkills(repoRoot);
  const actions = planInstall(skills, targets, { force: parsed.force });
  const result = applyPlan(actions, { dryRun: parsed.dryRun });

  if (parsed.json) {
    console.log(JSON.stringify({
      ok: result.errors.length === 0,
      scope: parsed.scope,
      dry_run: parsed.dryRun,
      targets: targets.map(t => ({ client: t.client, dir: t.dir })),
      skills_total: skills.length,
      linked: result.linked,
      overwritten: result.overwritten,
      skipped: result.skipped,
      conflicts: result.conflicts,
      errors: result.errors.map(e => ({ skill: e.action.skill.name, target: e.action.target.client, error: e.error })),
      conflict_detail: actions.filter(a => a.op === 'conflict').map(a => ({ skill: a.skill.name, target: a.target.client, reason: a.reason })),
    }, null, 2));
  } else if (parsed.fromUpgrade) {
    // Terse one-liner for the upgrade pipeline — we only speak up when
    // something interesting happened.
    if (result.linked > 0 || result.overwritten > 0 || result.conflicts > 0) {
      const clientList = targets.map(t => t.client).join(', ');
      const parts: string[] = [];
      if (result.linked) parts.push(`${result.linked} new`);
      if (result.overwritten) parts.push(`${result.overwritten} replaced`);
      if (result.conflicts) parts.push(`${result.conflicts} conflicts`);
      console.log(`Skills refreshed (${clientList}): ${parts.join(', ')}`);
    }
  } else {
    const actionWord = parsed.dryRun ? 'Would install' : 'Installed';
    console.log(`${actionWord} ${skills.length} PBrain skills across ${targets.length} client(s):`);
    for (const t of targets) console.log(`  ${t.client}: ${t.dir}`);
    console.log('');
    console.log(`  linked:      ${result.linked}`);
    if (result.overwritten) console.log(`  overwritten: ${result.overwritten}`);
    console.log(`  already ok:  ${result.skipped}`);
    if (result.conflicts > 0) {
      console.log(`  conflicts:   ${result.conflicts}`);
      console.log('');
      console.log('Conflicts (use --force to replace):');
      for (const a of actions.filter(a => a.op === 'conflict')) {
        console.log(`  [${a.target.client}] ${a.skill.name} — ${a.reason}`);
      }
    }
    if (result.errors.length) {
      console.log('');
      console.log(`${result.errors.length} error(s):`);
      for (const e of result.errors) {
        console.log(`  [${e.action.target.client}] ${e.action.skill.name}: ${e.error}`);
      }
    }
  }

  if (result.errors.length > 0) process.exit(1);
  if (result.conflicts > 0) process.exit(2);
}

function runStatus(targets: Target[], repoRoot: string, parsed: ParsedArgs) {
  const entries = scanTargets(targets, repoRoot);
  const skills = enumerateSkills(repoRoot);
  const skillNames = new Set(skills.map(s => s.name));

  // For each target, which of our skills are present / missing.
  const perTarget = targets.map(t => {
    const present = new Set(entries.filter(e => e.target.dir === t.dir && e.state === 'ours-ok').map(e => e.name));
    const missing = skills.filter(s => !present.has(s.name)).map(s => s.name);
    const broken = entries.filter(e => e.target.dir === t.dir && e.state === 'ours-broken').map(e => e.name);
    const foreignShadowing = entries.filter(e => e.target.dir === t.dir && e.state !== 'ours-ok' && e.state !== 'ours-broken' && skillNames.has(e.name));
    return { target: t, installed: present.size, missing, broken, foreignShadowing };
  });

  if (parsed.json) {
    console.log(JSON.stringify({
      repo_root: repoRoot,
      skills_total: skills.length,
      targets: perTarget.map(pt => ({
        client: pt.target.client,
        dir: pt.target.dir,
        installed: pt.installed,
        missing: pt.missing,
        broken: pt.broken,
        foreign_shadowing: pt.foreignShadowing.map(e => ({ name: e.name, state: e.state, resolved_to: e.resolvedTo })),
      })),
    }, null, 2));
    return;
  }

  console.log(`PBrain skills: ${skills.length} total in ${repoRoot}/skills`);
  console.log('');
  for (const pt of perTarget) {
    console.log(`${pt.target.client} (${pt.target.dir})`);
    console.log(`  installed:  ${pt.installed}/${skills.length}`);
    if (pt.missing.length) console.log(`  missing:    ${pt.missing.join(', ')}`);
    if (pt.broken.length) console.log(`  broken:     ${pt.broken.join(', ')} (run pbrain install-skills to fix)`);
    if (pt.foreignShadowing.length) {
      console.log('  shadowed by other plugins (install-skills --force to replace):');
      for (const e of pt.foreignShadowing) {
        console.log(`    ${e.name} — ${e.state}${e.resolvedTo ? ` → ${e.resolvedTo}` : ''}`);
      }
    }
    console.log('');
  }
}

function runUninstall(targets: Target[], repoRoot: string, parsed: ParsedArgs) {
  const toRemove: StatusEntry[] = planUninstall(targets, repoRoot);
  const result = applyUninstall(toRemove, { dryRun: parsed.dryRun });

  if (parsed.json) {
    console.log(JSON.stringify({
      ok: result.errors.length === 0,
      dry_run: parsed.dryRun,
      removed: result.removed,
      errors: result.errors.map(e => ({ target: e.entry.target.client, name: e.entry.name, error: e.error })),
    }, null, 2));
  } else {
    const word = parsed.dryRun ? 'Would remove' : 'Removed';
    console.log(`${word} ${result.removed} PBrain skill symlink(s).`);
    if (result.errors.length) {
      console.log(`${result.errors.length} error(s):`);
      for (const e of result.errors) console.log(`  [${e.entry.target.client}] ${e.entry.name}: ${e.error}`);
    }
  }
  if (result.errors.length > 0) process.exit(1);
}
