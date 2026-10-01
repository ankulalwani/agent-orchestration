#!/usr/bin/env bash
# Installs the Agent Orchestration worker for the current macOS user as a launchd LaunchAgent
# (starts at login, restarts on failure). Runs as you: agent logins, Git credentials and repositories are per-user.
#   ./installers/macos/install-worker.sh [--source DIR] [--no-service] [--no-browser] [--pair-server URL]
# --pair-server connects the worker to that control plane and opens its approval page (used by the one-click install).
set -euo pipefail

LABEL="com.agent-orchestration.worker"
INSTALL_DIR="${AO_INSTALL_DIR:-$HOME/Library/Application Support/AgentOrchestration/worker-app}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/AgentOrchestration"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR=""; NO_SERVICE=0; NO_BROWSER=0; PAIR_SERVER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE_DIR="$2"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --no-browser) NO_BROWSER=1; shift ;;
    --pair-server) PAIR_SERVER="$2"; shift 2 ;;
    *) echo "Unknown option $1"; exit 2 ;;
  esac
done
step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31mERROR: %s\033[0m\n' "$1"; exit 1; }

step "Checking dependencies"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node.js 20+ is required (brew install node, or https://nodejs.org)."
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 20 ] || fail "Node.js 20+ is required (found $("$NODE" -v))."
command -v git >/dev/null || echo "WARNING: git not found; Git policies will be skipped until it is installed."

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
[ -f "$PLIST" ] && launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
if [ -f "$INSTALL_DIR/dist/main.js" ] && [ ! -f "$INSTALL_DIR/state.json" ]; then
  rm -rf "$INSTALL_DIR" # older flat layout (configuration and credentials live in the data directory)
fi
APP_DIR="$INSTALL_DIR/app/$VERSION"
mkdir -p "$APP_DIR" "$LOG_DIR" "$HOME/.local/bin"
rsync -a --delete "$SOURCE_DIR/" "$APP_DIR/"
cp "$SOURCE_DIR/dist/launcher.js" "$INSTALL_DIR/launcher.js"
LAUNCHER="$INSTALL_DIR/launcher.js"
"$NODE" "$LAUNCHER" record-install "$VERSION" || fail "Could not record the installed version."
cat > "$HOME/.local/bin/agentctl" <<EOF
#!/usr/bin/env bash
exec "$NODE" "$LAUNCHER" agentctl "\$@"
EOF
chmod +x "$HOME/.local/bin/agentctl"

if [ "$NO_SERVICE" -eq 0 ]; then
  step "Registering LaunchAgent $LABEL"
  mkdir -p "$(dirname "$PLIST")"
  # launchd starts with a minimal PATH; capture the user's PATH so agent CLIs (claude, codex, …) are found.
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$LAUNCHER</string></array>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/worker.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/worker.err.log</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  step "Waiting for the worker"
  for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:47821/ >/dev/null 2>&1 && break; sleep 1; done
fi

URL="$("$NODE" "$LAUNCHER" --print-ui-url | tail -n 1)"
if [ "$NO_SERVICE" -eq 0 ] && [ "$NO_BROWSER" -eq 0 ] && [ -z "$PAIR_SERVER" ]; then step "Opening the local UI"; open "$URL"; fi
[ "$NO_SERVICE" -eq 0 ] && { step "Diagnostics"; "$NODE" "$LAUNCHER" agentctl doctor || true; }
echo
echo "Installed. Local UI: http://127.0.0.1:47821 — logs in $LOG_DIR. Ensure ~/.local/bin is on your PATH for agentctl."
echo "Uninstall with: installers/macos/uninstall-worker.sh"
if [ "$NO_SERVICE" -eq 0 ] && [ -n "$PAIR_SERVER" ]; then
  step "Connecting this worker to $PAIR_SERVER"
  PAIR_ARGS=""; [ "$NO_BROWSER" -eq 1 ] && PAIR_ARGS="--no-open"
  "$NODE" "$(dirname "${BASH_SOURCE[0]}")/../pair-worker.mjs" "$LAUNCHER" "$PAIR_SERVER" $PAIR_ARGS || true
fi
