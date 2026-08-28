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
