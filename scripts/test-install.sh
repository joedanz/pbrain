#!/usr/bin/env bash
# Integration test helper for scripts/install.sh.
#
# Runs the installer inside a throwaway Docker container with a clean
# filesystem and no Bun pre-installed. Verifies:
#   1. Fresh install succeeds end-to-end (Bun bootstrap, clone, bun link).
#   2. `pbrain --version` resolves in a new shell.
#   3. Re-running is idempotent (second run = upgrade path).
#
# Not wired into CI yet — run this manually before/after material changes
# to scripts/install.sh.
#
# USAGE
#   ./scripts/test-install.sh                     # default: ubuntu:24.04
#   ./scripts/test-install.sh debian:bookworm-slim
#   ./scripts/test-install.sh ubuntu:24.04 debian:bookworm-slim
#
# Requires: docker. Mounts this repo into the container as /pbrain so the
# installer can run against the local branch (not master).

set -euo pipefail
IFS=$'\n\t'

IMAGES=("${@:-ubuntu:24.04}")
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for IMAGE in "${IMAGES[@]}"; do
  echo ""
  echo "=============================================="
  echo "  Testing install.sh on $IMAGE"
  echo "=============================================="

  # Use a unique container name so parallel runs don't collide.
  CONTAINER="pbrain-install-test-$(echo "$IMAGE" | tr ':/' '--')-$$"

  docker run --rm --name "$CONTAINER" \
    -v "$REPO_ROOT:/pbrain:ro" \
    "$IMAGE" \
    bash -c '
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive

      # Bare-bones deps. Bun itself is installed by the installer.
      if command -v apt-get >/dev/null; then
        apt-get update -qq
        apt-get install -y -qq curl git unzip ca-certificates sudo >/dev/null
      elif command -v dnf >/dev/null; then
        dnf install -y -q curl git unzip ca-certificates sudo >/dev/null
      fi

      # Non-root user — installer refuses to run as root.
      id tester >/dev/null 2>&1 || useradd -m -s /bin/bash tester
      chown -R tester:tester /home/tester

      su - tester -c "
        set -euo pipefail
        echo \"--- fresh install ---\"
        bash /pbrain/scripts/install.sh \
          --install-dir \$HOME/.pbrain-repo \
          --brain-path \$HOME/vault \
          --yes \
          --skip-skills

        # pbrain should be on PATH via \$HOME/.bun/bin, which the installer
        # prepends to PATH for its own session. In a fresh shell we need to
        # source the Bun rc hook.
        export PATH=\"\$HOME/.bun/bin:\$PATH\"
        pbrain --version
        test -f \$HOME/.pbrain/config.json
        grep -q brain_path \$HOME/.pbrain/config.json

        echo \"--- idempotent re-run ---\"
        bash /pbrain/scripts/install.sh \
          --install-dir \$HOME/.pbrain-repo \
          --brain-path \$HOME/vault \
          --yes \
          --skip-skills
        pbrain --version
      "
    '

  echo ""
  echo "✓ $IMAGE passed"
done

echo ""
echo "All images passed."
