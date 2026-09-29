#!/usr/bin/env bash
# Removes the worker LaunchAgent and files. --remove-data also deletes configuration and Keychain entries.
set -euo pipefail
LABEL="com.agent-orchestration.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALL_DIR="${AO_INSTALL_DIR:-$HOME/Library/Application Support/AgentOrchestration/worker-app}"
[ -f "$PLIST" ] && { launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; echo "Removed LaunchAgent"; }
rm -rf "$INSTALL_DIR" "$HOME/.local/bin/agentctl"
if [ "${1:-}" = "--remove-data" ]; then
  rm -rf "$HOME/Library/Application Support/AgentOrchestration/worker"
  while security delete-generic-password -s agent-orchestration-worker >/dev/null 2>&1; do :; done
  echo "Removed worker data and Keychain entries"
else
  echo "Worker data and credentials kept (use --remove-data to delete)."
fi
