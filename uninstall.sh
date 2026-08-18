#!/usr/bin/env bash
# Stop the user service (and any pidfile process), drop leftover desktop
# entries, and optionally delete the install folder.
#
#   ./uninstall.sh
#   ./uninstall.sh --purge
#   ./uninstall.sh --purge --yes
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"

PURGE=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --yes|-y) YES=1 ;;
    --help|-h)
      cat <<'EOF'
Usage: uninstall.sh [--purge] [--yes]

  --purge   Also delete the install folder (the app and all of its data)
  --yes     Skip the --purge confirmation (needed when there is no TTY)
EOF
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      echo "Usage: uninstall.sh [--purge] [--yes]" >&2
      exit 2
      ;;
  esac
done

systemctl --user disable --now bored-manager 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/bored-manager.service"
systemctl --user daemon-reload 2>/dev/null || true

PID_FILE="$APP_DIR/data/server.pid"
if [ -f "$PID_FILE" ]; then
  pid="$(tr -d ' \n' < "$PID_FILE" || true)"
  if [ -n "$pid" ] && [ "$pid" != "0" ] && kill -0 "$pid" 2>/dev/null; then
    echo "Stopping process $pid"
    kill "$pid" 2>/dev/null || true
    n=0
    while kill -0 "$pid" 2>/dev/null; do
      n=$((n + 1))
      if [ "$n" -ge 40 ]; then
        kill -9 "$pid" 2>/dev/null || true
        break
      fi
      sleep 0.25
    done
  fi
  rm -f "$PID_FILE"
fi

remove_if_exists() {
  if [ -f "$1" ]; then
    rm -f "$1"
    echo "Removed shortcut: $1"
    REMOVED=1
  fi
}

REMOVED=0

remove_if_exists "$HOME/.local/share/applications/bored-manager.desktop"

USER_DESKTOP=""
if command -v xdg-user-dir >/dev/null 2>&1; then
  USER_DESKTOP="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
fi
if [ -z "$USER_DESKTOP" ] || [ "$USER_DESKTOP" = "$HOME" ]; then
  USER_DESKTOP="$HOME/Desktop"
fi
remove_if_exists "$USER_DESKTOP/bored-manager.desktop"

[ "$REMOVED" -eq 0 ] && echo "No shortcuts found."

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

if [ "$PURGE" -eq 1 ]; then
  echo "This will permanently delete $APP_DIR (the app and all of its data)."
  if [ "$YES" -ne 1 ]; then
    if [ ! -t 0 ]; then
      echo "ERROR: pass --yes to purge without a prompt." >&2
      exit 1
    fi
    read -r -p "Type YES to confirm: " ans
    if [ "${ans:-}" != "YES" ]; then
      echo "Aborted."
      exit 1
    fi
  fi
  cd /
  rm -rf "$APP_DIR"
  echo "Removed $APP_DIR"
  exit 0
fi

echo "Delete $APP_DIR yourself to uninstall completely, or run: $0 --purge --yes"
