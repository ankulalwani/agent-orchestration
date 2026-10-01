#!/usr/bin/env bash
# Installs the Agent Orchestration worker for the current Linux user as a systemd *user* service.
# Runs as you: agent logins, Git credentials and repositories are per-user.
#   ./installers/linux/install-worker.sh [--source DIR] [--no-service] [--no-browser] [--linger] [--pair-server URL]
# --pair-server connects the worker to that control plane and opens its approval page (used by the one-click install).
# --linger keeps the worker running without an active login session (requires sudo for loginctl).
set -euo pipefail

UNIT="agent-orchestration-worker.service"
INSTALL_DIR="${AO_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-orchestration/worker-app}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR=""; NO_SERVICE=0; NO_BROWSER=0; LINGER=0; PAIR_SERVER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE_DIR="$2"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --no-browser) NO_BROWSER=1; shift ;;
    --linger) LINGER=1; shift ;;
    --pair-server) PAIR_SERVER="$2"; shift 2 ;;
    *) echo "Unknown option $1"; exit 2 ;;
  esac
done
step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31mERROR: %s\033[0m\n' "$1"; exit 1; }

step "Checking dependencies"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node.js 20+ is required (https://nodejs.org or your distribution's packages)."
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 20 ] || fail "Node.js 20+ is required (found $("$NODE" -v))."
command -v git >/dev/null || echo "WARNING: git not found; Git policies will be skipped until it is installed."
command -v systemctl >/dev/null || { [ "$NO_SERVICE" -eq 1 ] || fail "systemd not found; re-run with --no-service and start the worker yourself."; }

if [ -z "$SOURCE_DIR" ]; then
  SOURCE_DIR="$REPO_ROOT/.deploy/worker"
  if [ ! -f "$SOURCE_DIR/dist/main.js" ]; then
    step "Packaging the worker from this repository"
    "$NODE" "$REPO_ROOT/scripts/package-worker.mjs"
  fi
fi
[ -f "$SOURCE_DIR/dist/main.js" ] || fail "No packaged worker in $SOURCE_DIR"

VERSION="$(tr -d '[:space:]' < "$SOURCE_DIR/VERSION")"
[ -n "$VERSION" ] || fail "No VERSION file in $SOURCE_DIR"

# Layout (docs/DECISIONS.md D-017): launcher.js + state.json + app/<version>/ per installed version.
step "Installing version $VERSION to $INSTALL_DIR"
systemctl --user stop "$UNIT" 2>/dev/null || true
if [ -f "$INSTALL_DIR/dist/main.js" ] && [ ! -f "$INSTALL_DIR/state.json" ]; then
  rm -rf "$INSTALL_DIR" # older flat layout (configuration and credentials live in the data directory)
fi
APP_DIR="$INSTALL_DIR/app/$VERSION"
mkdir -p "$APP_DIR" "$HOME/.local/bin"
if command -v rsync >/dev/null; then rsync -a --delete "$SOURCE_DIR/" "$APP_DIR/"; else rm -rf "$APP_DIR" && cp -a "$SOURCE_DIR" "$APP_DIR"; fi
cp "$SOURCE_DIR/dist/launcher.js" "$INSTALL_DIR/launcher.js"
LAUNCHER="$INSTALL_DIR/launcher.js"
"$NODE" "$LAUNCHER" record-install "$VERSION" || fail "Could not record the installed version."
cat > "$HOME/.local/bin/agentctl" <<EOF
#!/usr/bin/env bash
exec "$NODE" "$LAUNCHER" agentctl "\$@"
EOF
chmod +x "$HOME/.local/bin/agentctl"

if [ "$NO_SERVICE" -eq 0 ]; then
  step "Registering systemd user service $UNIT"
  mkdir -p "$UNIT_DIR"
  # Capture the user's PATH so agent CLIs installed via npm/pipx/etc. are found by the service.
  cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=Agent Orchestration worker (local UI on 127.0.0.1:47821)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE $LAUNCHER
Environment=PATH=$PATH
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"
  if [ "$LINGER" -eq 1 ]; then sudo loginctl enable-linger "$USER"; fi
  step "Waiting for the worker"
  for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:47821/ >/dev/null 2>&1 && break; sleep 1; done
fi

URL="$("$NODE" "$LAUNCHER" --print-ui-url | tail -n 1)"
if [ "$NO_SERVICE" -eq 0 ] && [ "$NO_BROWSER" -eq 0 ] && [ -z "$PAIR_SERVER" ] && command -v xdg-open >/dev/null; then step "Opening the local UI"; xdg-open "$URL" >/dev/null 2>&1 || true; fi
[ "$NO_SERVICE" -eq 0 ] && { step "Diagnostics"; "$NODE" "$LAUNCHER" agentctl doctor || true; }
echo
echo "Installed. Local UI link: $URL"
echo "Logs: journalctl --user -u $UNIT -f    Uninstall: installers/linux/uninstall-worker.sh"
if [ "$NO_SERVICE" -eq 0 ] && [ -n "$PAIR_SERVER" ]; then
  step "Connecting this worker to $PAIR_SERVER"
  PAIR_ARGS=""; [ "$NO_BROWSER" -eq 1 ] && PAIR_ARGS="--no-open"
  "$NODE" "$(dirname "${BASH_SOURCE[0]}")/../pair-worker.mjs" "$LAUNCHER" "$PAIR_SERVER" $PAIR_ARGS || true
fi
