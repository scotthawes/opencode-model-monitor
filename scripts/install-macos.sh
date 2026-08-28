#!/usr/bin/env bash
#
# Install the opencode-model-monitor LaunchAgent on macOS.
#
# - Resolves the real repo directory (parent of this script's directory).
# - Substitutes it into the plist template placeholder /PATH/TO/opencode-model-monitor.
# - Copies the result to ~/Library/LaunchAgents/com.opencode.model-monitor.plist.
# - Best-effort `launchctl load` (no force, no sudo).
#
# Safe to re-run. It will NOT overwrite unless you remove the existing agent
# first (launchctl unload ~/Library/LaunchAgents/com.opencode.model-monitor.plist).

set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_DIR/deploy/opencode-model-monitor.plist"
DEST_DIR="$HOME/Library/LaunchAgents"
DEST="$DEST_DIR/com.opencode.model-monitor.plist"

echo "Repo dir : $REPO_DIR"
echo "Source   : $SRC"
echo "Target   : $DEST"

if [ ! -f "$SRC" ]; then
  echo "ERROR: plist template not found at $SRC" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

if [ -f "$DEST" ]; then
  echo "NOTE: $DEST already exists — refusing to overwrite."
  echo "      Unload first if you want to reinstall:"
  echo "      launchctl unload \"$DEST\""
else
  # Substitute the real repo path for the placeholder.
  sed "s#/PATH/TO/opencode-model-monitor#$REPO_DIR#g" "$SRC" > "$DEST"

  # Ensure node resolves via the plist's EnvironmentVariables.PATH.
  # launchd does NOT inherit the user's login PATH, so if the installer can
  # locate `node` but its directory is missing from the plist PATH, prepend it.
  # This keeps the monitor robust against the exit-127 (npm-not-on-PATH) bug.
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [ -n "$NODE_BIN" ]; then
    NODE_DIR="$(dirname "$NODE_BIN")"
    if ! grep -qF "$NODE_DIR" "$DEST"; then
      echo "Prepending node dir to plist PATH: $NODE_DIR"
      sed -i '' -E "s#(/usr/bin:/bin:/usr/sbin:/sbin</string>)#$NODE_DIR:\1#" "$DEST"
    fi
  else
    echo "WARNING: 'node' not found on PATH — the agent may fail to start."
    echo "         Install Node.js, then re-run this script."
  fi

  echo "Installed plist to $DEST"

  echo "Loading agent (best-effort)..."
  if launchctl load "$DEST" 2>/dev/null; then
    echo "Loaded. Agent will start now and on login (RunAtLoad + KeepAlive)."
  else
    echo "launchctl load did not confirm success (may already be loaded, or not permitted)."
    echo "You can try manually: launchctl load \"$DEST\""
  fi
fi

echo "Done."
