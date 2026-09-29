#!/usr/bin/env bash
# Removes the worker user service and files. --remove-data also deletes configuration and stored credentials.
set -euo pipefail
UNIT="agent-orchestrator-worker.service"
INSTALL_DIR="${AO_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-orchestrator/worker-app}"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
if [ -f "$UNIT_FILE" ]; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "Removed $UNIT"
fi
rm -rf "$INSTALL_DIR" "$HOME/.local/bin/agentctl"
if [ "${1:-}" = "--remove-data" ]; then
  rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/agent-orchestrator/worker"
  command -v secret-tool >/dev/null && secret-tool clear service agent-orchestrator-worker 2>/dev/null || true
  echo "Removed worker data and stored credentials"
else
  echo "Worker data and credentials kept (use --remove-data to delete)."
fi
