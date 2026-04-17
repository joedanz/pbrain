#!/usr/bin/env bash
# PBrain one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/joedanz/pbrain/master/scripts/install.sh | bash
#
# Detects/installs Bun, clones the repo, runs `bun install && bun link`,
# prompts for the brain folder, runs `pbrain init`, and (optionally) registers
# skills with Claude Code / Cursor / Windsurf.
#
# Re-running upgrades in place. See `docs/install.md` for flags and troubleshooting.
#
# Installer script version: bump when behavior changes.
INSTALL_SCRIPT_VERSION="1"

set -euo pipefail
IFS=$'\n\t'

# ---------- output helpers ----------
if [ -t 2 ]; then
  COLOR_RED=$'\033[31m'
  COLOR_YELLOW=$'\033[33m'
  COLOR_GREEN=$'\033[32m'
  COLOR_BOLD=$'\033[1m'
  COLOR_RESET=$'\033[0m'
else
  COLOR_RED=""
  COLOR_YELLOW=""
  COLOR_GREEN=""
  COLOR_BOLD=""
  COLOR_RESET=""
fi

info() { printf '%s==>%s %s\n' "$COLOR_BOLD" "$COLOR_RESET" "$*" >&2; }
ok()   { printf '%s✓%s %s\n'  "$COLOR_GREEN" "$COLOR_RESET" "$*" >&2; }
warn() { printf '%swarn:%s %s\n' "$COLOR_YELLOW" "$COLOR_RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$COLOR_RED" "$COLOR_RESET" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
PBrain one-line installer.

USAGE
  curl -fsSL https://raw.githubusercontent.com/joedanz/pbrain/master/scripts/install.sh | bash
  curl -fsSL ... | bash -s -- [FLAGS]
  bash scripts/install.sh [FLAGS]        # from a local clone

FLAGS
  --brain-path <path>   Absolute path to the brain folder (Obsidian vault or any
                        writable markdown folder). Also: PBRAIN_BRAIN_PATH.
  --install-dir <path>  Where to clone PBrain. Default: $HOME/.pbrain-repo.
                        Also: PBRAIN_INSTALL_DIR.
  --branch <name>       Branch to install from. Default: master.
                        Also: PBRAIN_INSTALL_BRANCH.
  -y, --yes             Accept all prompts (create brain dir, install skills,
                        proceed on dirty working tree).
                        Also: PBRAIN_INSTALL_YES=1.
  --skip-skills         Don't offer to run `pbrain install-skills`.
                        Also: PBRAIN_INSTALL_SKIP_SKILLS=1.
  --skip-init           Stop after `bun link`. You run `pbrain init` yourself.
                        Also: PBRAIN_INSTALL_SKIP_INIT=1.
  --dry-run             Print the steps that would run; touch nothing on disk.
  -h, --help            Show this help and exit.

SEE ALSO
  docs/install.md — flags, env vars, troubleshooting.
EOF
}

# ---------- flag parsing ----------
BRAIN_PATH="${PBRAIN_BRAIN_PATH:-}"
INSTALL_DIR="${PBRAIN_INSTALL_DIR:-$HOME/.pbrain-repo}"
BRANCH="${PBRAIN_INSTALL_BRANCH:-master}"
ASSUME_YES="${PBRAIN_INSTALL_YES:-0}"
SKIP_SKILLS="${PBRAIN_INSTALL_SKIP_SKILLS:-0}"
SKIP_INIT="${PBRAIN_INSTALL_SKIP_INIT:-0}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --brain-path)
      [ $# -ge 2 ] || die "--brain-path requires a value"
      BRAIN_PATH="$2"; shift 2 ;;
    --brain-path=*)
      BRAIN_PATH="${1#*=}"; shift ;;
    --install-dir)
      [ $# -ge 2 ] || die "--install-dir requires a value"
      INSTALL_DIR="$2"; shift 2 ;;
    --install-dir=*)
      INSTALL_DIR="${1#*=}"; shift ;;
    --branch)
      [ $# -ge 2 ] || die "--branch requires a value"
      BRANCH="$2"; shift 2 ;;
    --branch=*)
      BRANCH="${1#*=}"; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --skip-skills) SKIP_SKILLS=1; shift ;;
    --skip-init) SKIP_INIT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown flag: $1 (try --help)" ;;
  esac
done

# Expand ~ in paths that came from flags/env
expand_tilde() {
  # Literal tilde at the start → $HOME. Quoted to silence SC2088 (we do want
  # the raw character here, not expansion).
  local in="$1"
  if [ "$in" = "~" ] || [ "${in#\~/}" != "$in" ]; then
    printf '%s\n' "${HOME}${in#\~}"
  else
    printf '%s\n' "$in"
  fi
}
[ -n "$BRAIN_PATH" ] && BRAIN_PATH="$(expand_tilde "$BRAIN_PATH")"
INSTALL_DIR="$(expand_tilde "$INSTALL_DIR")"

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] %s\n' "$*" >&2
  else
    eval "$*"
  fi
}

# ---------- safety guards ----------
info "PBrain installer v$INSTALL_SCRIPT_VERSION"

if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  die "Don't run this installer as root. bun link and the brain folder should be owned by your user."
fi

UNAME="$(uname -s)"
case "$UNAME" in
  Darwin|Linux) ;;
  MINGW*|MSYS*|CYGWIN*)
    die "Windows native shells aren't supported. Install WSL (https://aka.ms/wsl) and re-run this inside Ubuntu/Debian." ;;
  *) die "Unsupported OS: $UNAME. Only macOS and Linux are supported." ;;
esac

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || return 1
}

if ! need_cmd git; then
  case "$UNAME" in
    Darwin) die "git not found. Install it with: xcode-select --install" ;;
    Linux)  die "git not found. Install it (e.g. 'sudo apt install git' or 'sudo dnf install git') and re-run." ;;
  esac
fi

if ! need_cmd curl; then
  die "curl not found. Install it and re-run."
fi

# ---------- stdin-for-prompts ----------
# When invoked via `curl ... | bash`, stdin is the curl pipe. Read interactive
# input from /dev/tty instead so prompts work.
if [ -r /dev/tty ]; then
  HAS_TTY=1
else
  HAS_TTY=0
fi

prompt() {
  # prompt "Question: " VAR_NAME
  local msg="$1" var="$2" answer=""
  if [ "$HAS_TTY" = "0" ]; then
    return 1
  fi
  printf '%s' "$msg" > /dev/tty
  IFS= read -r answer < /dev/tty || return 1
  printf -v "$var" '%s' "$answer"
  return 0
}

confirm() {
  # confirm "Question [Y/n]: " → returns 0 on yes, 1 on no
  local msg="$1" ans=""
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  if [ "$HAS_TTY" = "0" ]; then return 1; fi
  printf '%s' "$msg" > /dev/tty
  IFS= read -r ans < /dev/tty || return 1
  case "$ans" in
    ""|y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- step 1: ensure Bun ----------
ensure_bun() {
  if need_cmd bun; then
    local v
    v="$(bun --version 2>/dev/null || echo unknown)"
    ok "bun $v already installed"
    return 0
  fi

  info "Installing Bun (https://bun.sh/install)"
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] curl -fsSL https://bun.sh/install | bash\n' >&2
  else
    # Pipe curl into bash; do NOT redirect bash's stdin (that would make bash
    # read its script from /dev/null instead of the curl pipe).
    curl -fsSL https://bun.sh/install | bash >&2
  fi

  # The Bun installer drops a binary at $HOME/.bun/bin/bun and edits shell rc
  # files. Prepend to PATH so this script's remaining steps find it without
  # the user sourcing their profile.
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if [ "$DRY_RUN" = "1" ]; then
    ok "[dry-run] assume bun is now on PATH"
    return 0
  fi

  if ! need_cmd bun; then
    die "Bun installed but not on PATH. Try: export PATH=\"\$HOME/.bun/bin:\$PATH\" and re-run."
  fi
  ok "bun $(bun --version) installed"
}
ensure_bun

# ---------- step 2: clone or upgrade ----------
sync_repo() {
  if [ -d "$INSTALL_DIR" ]; then
    # Existing directory — must be a pbrain clone or we bail.
    if [ ! -d "$INSTALL_DIR/.git" ]; then
      die "$INSTALL_DIR exists but is not a git checkout. Remove it or pass --install-dir."
    fi
    local remote
    remote="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
    case "$remote" in
      *joedanz/pbrain*) ;;
      *) die "$INSTALL_DIR is a git checkout of '$remote', not joedanz/pbrain. Remove it or pass --install-dir." ;;
    esac

    # Dirty working tree?
    local dirty
    dirty="$(git -C "$INSTALL_DIR" status --porcelain)"
    if [ -n "$dirty" ] && [ "$ASSUME_YES" != "1" ]; then
      warn "Working tree in $INSTALL_DIR is dirty:"
      printf '%s\n' "$dirty" >&2
      die "Commit/stash changes, or re-run with --yes to ignore and force-update."
    fi

    info "Upgrading existing checkout in $INSTALL_DIR"
    run "git -C \"$INSTALL_DIR\" fetch --quiet origin \"$BRANCH\""
    run "git -C \"$INSTALL_DIR\" checkout --quiet \"$BRANCH\""
    run "git -C \"$INSTALL_DIR\" pull --ff-only --quiet origin \"$BRANCH\""
    ok "Repo up to date ($BRANCH)"
  else
    info "Cloning joedanz/pbrain ($BRANCH) into $INSTALL_DIR"
    run "git clone --quiet --depth=1 --branch \"$BRANCH\" https://github.com/joedanz/pbrain.git \"$INSTALL_DIR\""
    ok "Cloned to $INSTALL_DIR"
  fi
}
sync_repo

# ---------- step 3: install deps and link ----------
install_and_link() {
  info "Installing dependencies (first run can take a minute)…"
  run "cd \"$INSTALL_DIR\" && bun install"
  info "Linking 'pbrain' globally via bun link"
  run "cd \"$INSTALL_DIR\" && bun link"

  if [ "$DRY_RUN" = "1" ]; then
    ok "[dry-run] would verify pbrain on PATH"
    return 0
  fi

  if ! need_cmd pbrain; then
    warn "pbrain not on PATH yet. Bun links to: $BUN_INSTALL/bin"
    warn "Add this to your shell rc (~/.zshrc or ~/.bashrc):"
    warn "  export PATH=\"\$HOME/.bun/bin:\$PATH\""
    die "Then open a new terminal (or 'exec \$SHELL -l') and re-run this installer."
  fi
  ok "$(pbrain --version 2>/dev/null || echo 'pbrain ?') is on PATH"
}
install_and_link

# ---------- step 4: brain path ----------
if [ "$SKIP_INIT" = "1" ]; then
  ok "Skipping pbrain init (--skip-init)"
else
  # If config already has a brain_path and no override was provided, reuse it.
  CONFIG_FILE="$HOME/.pbrain/config.json"
  if [ -z "$BRAIN_PATH" ] && [ -f "$CONFIG_FILE" ]; then
    # Lightweight JSON probe; avoid requiring jq.
    EXISTING_BRAIN="$(grep -E '"brain_path"[[:space:]]*:' "$CONFIG_FILE" 2>/dev/null \
      | head -1 | sed -E 's/.*"brain_path"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')"
    if [ -n "$EXISTING_BRAIN" ]; then
      ok "Reusing brain_path from $CONFIG_FILE: $EXISTING_BRAIN"
      BRAIN_PATH="$EXISTING_BRAIN"
    fi
  fi

  if [ -z "$BRAIN_PATH" ]; then
    if [ "$HAS_TTY" != "1" ]; then
      die "No brain path. Pass --brain-path <path> or set PBRAIN_BRAIN_PATH. Example: --brain-path ~/ObsidianVault/MyBrain"
    fi
    info "Pick your brain folder."
    info "This is where PBrain reads and writes markdown. An Obsidian vault is ideal;"
    info "any writable folder works. Example: ~/ObsidianVault/MyBrain"
    while [ -z "$BRAIN_PATH" ]; do
      if ! prompt "Brain path (absolute): " BRAIN_PATH; then
        die "Could not read brain path. Pass --brain-path on the command line."
      fi
      BRAIN_PATH="$(expand_tilde "${BRAIN_PATH:-}")"
      if [ -z "$BRAIN_PATH" ]; then
        warn "A brain folder is required. Example: ~/ObsidianVault/MyBrain"
      fi
    done
  fi

  # Resolve relative paths to absolute
  case "$BRAIN_PATH" in
    /*) ;;
    *) BRAIN_PATH="$(cd "$(dirname "$BRAIN_PATH")" 2>/dev/null && pwd)/$(basename "$BRAIN_PATH")" || true ;;
  esac

  if [ ! -d "$BRAIN_PATH" ]; then
    if confirm "Folder $BRAIN_PATH doesn't exist. Create it? [Y/n]: "; then
      run "mkdir -p \"$BRAIN_PATH\""
      ok "Created $BRAIN_PATH"
    else
      die "Brain folder $BRAIN_PATH does not exist. Create it and re-run."
    fi
  fi

  # ---------- step 5: pbrain init ----------
  info "Running: pbrain init --brain-path \"$BRAIN_PATH\""
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] pbrain init --brain-path "%s"\n' "$BRAIN_PATH" >&2
  else
    if ! pbrain init --brain-path "$BRAIN_PATH"; then
      die "pbrain init failed. Fix the error above and re-run: pbrain init --brain-path \"$BRAIN_PATH\""
    fi
  fi
  ok "Brain initialized at $BRAIN_PATH"

  # ---------- step 6: install-skills (optional) ----------
  if [ "$SKIP_SKILLS" = "1" ]; then
    ok "Skipping install-skills (--skip-skills)"
  else
    DETECTED=()
    [ -d "$HOME/.claude" ] && DETECTED+=("Claude Code")
    [ -d "$HOME/.cursor" ] && DETECTED+=("Cursor")
    [ -d "$HOME/.windsurf" ] && DETECTED+=("Windsurf")

    if [ "${#DETECTED[@]}" -eq 0 ]; then
      ok "No Claude Code / Cursor / Windsurf config detected; skipping skill install"
    else
      JOINED="$(IFS=', '; echo "${DETECTED[*]}")"
      if confirm "Register PBrain skills with $JOINED? [Y/n]: "; then
        if [ "$DRY_RUN" = "1" ]; then
          printf '[dry-run] pbrain install-skills\n' >&2
        else
          if ! pbrain install-skills; then
            warn "pbrain install-skills returned an error (continuing)."
            warn "You can re-run it manually: pbrain install-skills"
          fi
        fi
        ok "Skills registered"
      else
        ok "Skipped. Run 'pbrain install-skills' later if you change your mind."
      fi
    fi
  fi
fi

# ---------- step 7: next steps ----------
cat >&2 <<EOF

${COLOR_GREEN}${COLOR_BOLD}PBrain is installed.${COLOR_RESET}

  pbrain --version                    → confirm
  pbrain import "${BRAIN_PATH:-<brain-path>}"   → index existing notes (one-time)
  pbrain query "..."                  → ask your brain

  Config:  ~/.pbrain/config.json
  Repo:    $INSTALL_DIR
  Upgrade: re-run this installer, or: (cd "$INSTALL_DIR" && git pull && bun install)

If 'pbrain' isn't found in a new terminal, add this to your shell rc:
  export PATH="\$HOME/.bun/bin:\$PATH"
EOF
