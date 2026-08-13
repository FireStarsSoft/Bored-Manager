#!/usr/bin/env bash
# Start the Bored Manager web UI from this folder.
#
#   ./run.sh                 build if needed, then exec the server (args go to it)
#   ./run.sh --build-only    build if needed and stop
set -euo pipefail
cd "$(dirname "$0")"
APP_DIR="$(pwd)"

if [ ! -d node_modules ]; then
  echo "==> Dependencies are not installed yet - installing them now..."
  bash "$APP_DIR/install.sh" --repair
fi

need_build=0
if [ ! -f out/server/index.mjs ]; then
  need_build=1
else
  newer=$(find server shared src modules package.json vite.config.ts vite.config.server.ts \
    -type f -newer out/server/index.mjs -print -quit 2>/dev/null || true)
  if [ -n "$newer" ]; then
    echo "==> Sources changed since the last build ($newer) - rebuilding..."
    need_build=1
  fi
fi

if [ "$need_build" -eq 1 ]; then
  echo "==> Building the app..."
  npm run build
fi

if [ "${1:-}" = "--build-only" ]; then
  exit 0
fi

exec node out/server/index.mjs "$@"
