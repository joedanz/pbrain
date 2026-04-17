# Install — one-line bootstrap reference

The one-line installer (`scripts/install.sh`) is the recommended way to install PBrain. This doc is the long-form reference: flags, env vars, what it does step by step, and what to do when something breaks. If you just want to install, the three-line README section is enough.

```bash
curl -fsSL https://raw.githubusercontent.com/joedanz/pbrain/master/scripts/install.sh | bash
```

macOS and Linux only. Windows users run this inside WSL (Ubuntu/Debian).

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--brain-path <path>` | prompt | Absolute path to the brain folder. Can be a tilde path (`~/vault`). Created if missing (prompted unless `--yes`). |
| `--install-dir <path>` | `$HOME/.pbrain-repo` | Where to clone the repo. Pick `~/code/pbrain` if you want it in your normal workspace. |
| `--branch <name>` | `master` | Branch to install from. Useful for testing. |
| `-y`, `--yes` | off | Accept all prompts (create brain folder, run `install-skills`, proceed on dirty tree). Required for non-TTY runs. |
| `--skip-skills` | off | Don't offer to run `pbrain install-skills` even when Claude Code / Cursor / Windsurf are detected. |
| `--skip-init` | off | Stop after `bun link`. You run `pbrain init` yourself. Useful for CI smoke tests. |
| `--dry-run` | off | Print every step without touching disk or running commands. Combine with `--yes --brain-path X` to exercise the full flow. |
| `-h`, `--help` | — | Print usage. |

## Environment variables

Every flag has an env-var equivalent. Flags win when both are set.

| Env var | Flag |
|---|---|
| `PBRAIN_BRAIN_PATH` | `--brain-path` |
| `PBRAIN_INSTALL_DIR` | `--install-dir` |
| `PBRAIN_INSTALL_BRANCH` | `--branch` |
| `PBRAIN_INSTALL_YES=1` | `--yes` |
| `PBRAIN_INSTALL_SKIP_SKILLS=1` | `--skip-skills` |
| `PBRAIN_INSTALL_SKIP_INIT=1` | `--skip-init` |

## What it does, step by step

1. **Safety checks.** Refuses to run as root; refuses Windows native shells (MINGW/MSYS/Cygwin) with a WSL pointer; verifies `git` and `curl` are present.
2. **Ensures Bun.** If `bun --version` works, moves on. Otherwise runs the official Bun installer (`curl -fsSL https://bun.sh/install | bash`) and prepends `$HOME/.bun/bin` to `PATH` for the rest of the script. Verifies `bun` resolves afterwards.
3. **Clones or upgrades the repo.** If `$INSTALL_DIR` doesn't exist: `git clone --depth=1`. If it exists and has `joedanz/pbrain` as its origin: fetch, checkout the target branch, fast-forward pull. If it exists but isn't a pbrain clone: bail out rather than clobber. If the working tree is dirty: refuse unless `--yes`.
4. **Installs and links.** `bun install` inside the clone, then `bun link` to create the global `pbrain` symlink in `$HOME/.bun/bin`. Verifies `pbrain --version` resolves.
5. **Resolves the brain path.** Flag/env wins. Else, if `~/.pbrain/config.json` already has a `brain_path`, reuses it silently (re-init upgrade flow). Else, prompts from `/dev/tty` (so `curl | bash` works). If not a TTY and no flag was given, dies with a clear message.
6. **Runs `pbrain init`.** Passes `--brain-path "$BRAIN_PATH"` through. Default engine is PGLite; no API keys needed at this step.
7. **Offers `pbrain install-skills`.** Detects `~/.claude`, `~/.cursor`, `~/.windsurf`. If any exist and `--skip-skills` isn't set, prompts (auto-yes under `--yes`).
8. **Prints next steps.** Paths to the repo, config, and upgrade command.

## Troubleshooting

### `pbrain: command not found` in a new terminal

`bun link` creates a symlink in `$HOME/.bun/bin`. Bun's own installer adds that to your shell rc (`.zshrc` / `.bashrc`) automatically, but if your shell doesn't source it, add this line yourself:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

Then `exec $SHELL -l` or open a new terminal.

### "Working tree is dirty" on re-run

The installer refuses to clobber local changes. Options:

- Commit or stash in the install dir: `cd ~/.pbrain-repo && git stash`.
- Re-run with `--yes` to force-pull (your uncommitted changes stay, but the branch is reset to match remote).
- Point `--install-dir` elsewhere: `--install-dir ~/code/pbrain`.

### `<dir> is a git checkout of <other-url>`

Something at `$INSTALL_DIR` is a clone of a different repo. Move it aside or pass `--install-dir ~/somewhere-else`.

### Permission denied under `~/.bun`

Usually means a previous `sudo curl … | sudo bash` left root-owned files. Fix:

```bash
sudo chown -R "$USER" "$HOME/.bun"
```

Then re-run the installer as a normal user. Do not run the installer with `sudo`.

### Non-TTY hang or exit 1 with "No brain path"

You piped the installer without a TTY (CI, nested shells, `ssh -T`) and didn't pass `--brain-path`. Add the flag or set `PBRAIN_BRAIN_PATH`:

```bash
curl -fsSL …/install.sh | bash -s -- --brain-path ~/ObsidianVault/MyBrain --yes
```

### Bun install fails

Surfaced verbatim from Bun. Common causes: glibc too old on the Linux host, missing `unzip`, corporate proxy blocking `bun.sh`. Install Bun manually (`curl -fsSL https://bun.sh/install | bash`) and re-run the PBrain installer — it'll detect Bun and skip that step.

## Security

`curl | bash` installers always carry the "arbitrary code from the internet" risk. To audit before running:

```bash
curl -fsSL https://raw.githubusercontent.com/joedanz/pbrain/master/scripts/install.sh -o install.sh
less install.sh
bash install.sh
```

The script is ~300 lines of bash with no network calls beyond `git clone` (which you'd be running manually anyway) and the Bun installer (pinned to `bun.sh/install`, which is what you'd be running manually anyway).

## Upgrading

Re-run the one-line installer. It detects the existing clone, refuses clobbers, and runs `git pull && bun install` on top. Or do it by hand:

```bash
cd ~/.pbrain-repo && git pull && bun install
```

## Uninstalling

```bash
bun unlink pbrain                  # remove the global symlink
rm -rf ~/.pbrain-repo              # remove the clone
rm -rf ~/.pbrain                   # remove config + state (careful — this deletes brain_path mapping)
```

Your brain folder (wherever `--brain-path` pointed) is **not** touched.
