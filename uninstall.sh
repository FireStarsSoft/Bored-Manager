#!/usr/bin/env bash
# Stop the user service, drop leftover desktop entries, and optionally delete
# the install folder. Without --purge the folder is left in place.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"

systemctl --user disable --now bored-manager 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/bored-manager.service"
systemctl --user daemon-reload 2>/dev/null || true

remove_if_exists() {
  if [ -f "$1" ]; then
    rm -f "$1"
    echo "Removed shortcut: $1"
    REMOVED=1
  fi
}

REMOVED=0

remove_if_exists "$HOME/.local/share/applications/bored-manager.desktop"
remove_if_exists "$HOME/.local/share/applications/task-manager.desktop"
remove_if_exists "$HOME/.local/share/applications/nvidia-controller.desktop"

USER_DESKTOP=""
if command -v xdg-user-dir >/dev/null 2>&1; then
  USER_DESKTOP="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
fi
if [ -z "$USER_DESKTOP" ] || [ "$USER_DESKTOP" = "$HOME" ]; then
  USER_DESKTOP="$HOME/Desktop"
fi
remove_if_exists "$USER_DESKTOP/bored-manager.desktop"
remove_if_exists "$USER_DESKTOP/task-manager.desktop"
remove_if_exists "$USER_DESKTOP/nvidia-controller.desktop"

[ "$REMOVED" -eq 0 ] && echo "No shortcuts found."

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

if [ "${1:-}" = "--purge" ]; then
  echo "This will permanently delete $APP_DIR (the app and all of its data)."
  read -r -p "Type YES to confirm: " ans
  if [ "${ans:-}" != "YES" ]; then
    echo "Aborted."
    exit 1
  fi
  cd /
  rm -rf "$APP_DIR"
  echo "Removed $APP_DIR"
  exit 0
fi

echo "Delete $APP_DIR yourself to uninstall completely."
