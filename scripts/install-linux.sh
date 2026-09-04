#!/usr/bin/env bash
#
# Install the opencode-model-monitor systemd *user* service on Linux.
#
# - Resolves the real repo directory (parent of this script's directory).
# - Substitutes it into the service template placeholder
#   /PATH/TO/opencode-model-monitor.
# - Ensures `node`/`npm` are on the service PATH (launchd-less: systemd user
#   services do NOT inherit a login shell PATH).
# - Copies the result to ~/.config/systemd/user/opencode-model-monitor.service.
# - Best-effort `systemctl --user enable --now`.
#
# Safe to re-run. It will NOT overwrite an existing unit — edit/remove it first.

set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_DIR/deploy/opencode-model-monitor.service"
DEST_DIR="$HOME/.config/systemd/user"
DEST="$DEST_DIR/opencode-model-monitor.service"

echo "Repo dir : $REPO_DIR"
echo "Source   : $SRC"
echo "Target   : $DEST"

if [ ! -f "$SRC" ]; then
  echo "ERROR: service template not found at $SRC" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

if [ -f "$DEST" ]; then
  echo "NOTE: $DEST already exists — refusing to overwrite."
  echo "      Remove it first if you want to reinstall:"
  echo "      rm \"$DEST\""
else
  # Substitute the real repo path for the placeholder.
  sed "s#/PATH/TO/opencode-model-monitor#$REPO_DIR#g" "$SRC" > "$DEST"

  # Ensure node/npm resolve for the service. systemd user services get a minimal
  # PATH, so if we can locate `node` but its directory is missing from the unit,
  # inject it via Environment=PATH (keeps the monitor robust against exit-127).
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [ -n "$NODE_BIN" ]; then
    NODE_DIR="$(dirname "$NODE_BIN")"
    if ! grep -qF "$NODE_DIR" "$DEST"; then
      echo "Injecting node dir into service PATH: $NODE_DIR"
      awk -v d="$NODE_DIR" '/^\[Service\]/{print; print "Environment=PATH="d":/usr/local/bin:/usr/bin:/bin"; next} {print}' "$DEST" > "$DEST.tmp" && mv "$DEST.tmp" "$DEST"
    fi
  else
    echo "WARNING: 'node' not found on PATH — the service may fail to start."
    echo "         Install Node.js (>=18), then re-run this script."
  fi

  echo "Installed service to $DEST"

  echo "Enabling + starting (best-effort)..."
  if systemctl --user daemon-reload 2>/dev/null && \
     systemctl --user enable --now opencode-model-monitor.service 2>/dev/null; then
    echo "Enabled and started. The monitor runs in the background and on login."
  else
    echo "Could not auto-start (no active user session, or systemctl --user unavailable)."
    echo "Enable manually once logged in:"
    echo "  systemctl --user daemon-reload"
    echo "  systemctl --user enable --now opencode-model-monitor.service"
  fi
fi

echo "Done."
