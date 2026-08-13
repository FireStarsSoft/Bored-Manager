#!/usr/bin/env bash
# Bored Manager installer for Linux.
#
# One-liner (bootstrap — downloads the latest release, or a zip you pass):
#   curl -fsSL https://raw.githubusercontent.com/FireStarsSoft/Bored-Manager/main/install.sh | bash
#
# In a folder that already contains the app (skip the download):
#   ./install.sh
#   ./install.sh --repair
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --port <n>       WebUI port (default 8686)
  --host <s>       Bind address (default 0.0.0.0)
  --dir <path>     Install folder (default ~/bored-manager)
  --source <src>   Local .zip, or https URL of a .zip
  --no-service     Do not register the systemd user unit
  --repair         Reinstall dependencies and rebuild in the current app folder
  --help           Show this help

Environment:
  BM_ALLOW_ROOT=1  Allow running as root (data would live in /root)
EOF
}

PORT=8686
HOST=0.0.0.0
DIR="${HOME}/bored-manager"
SOURCE=""
NO_SERVICE=0
REPAIR=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || { echo "ERROR: --port needs a value" >&2; exit 2; }
      PORT="$2"
      shift 2
      ;;
    --host)
      [ $# -ge 2 ] || { echo "ERROR: --host needs a value" >&2; exit 2; }
      HOST="$2"
      shift 2
      ;;
    --dir)
      [ $# -ge 2 ] || { echo "ERROR: --dir needs a value" >&2; exit 2; }
      DIR="$2"
      shift 2
      ;;
    --source)
      [ $# -ge 2 ] || { echo "ERROR: --source needs a value" >&2; exit 2; }
      SOURCE="$2"
      shift 2
      ;;
    --no-service) NO_SERVICE=1; shift ;;
    --repair) REPAIR=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

DIR="${DIR/#\~/${HOME}}"

die() { echo "ERROR: $1" >&2; exit 1; }
step() { echo "==> $1"; }

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  die "invalid --port: $PORT"
fi

pkg_name() {
  local file="$1/package.json"
  [ -f "$file" ] || return 1
  if command -v node >/dev/null 2>&1; then
    node --input-type=commonjs -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).name||'')}catch(e){}" "$file" 2>/dev/null && return 0
  fi
  sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1
}

# --- repair: stay in the app folder, reinstall deps, rebuild -----------------
repair_app() {
  [ -f package.json ] || die "run --repair from the app folder (no package.json here)"
  [ "$(pkg_name .)" = 'bored-manager' ] || die "this folder is not a Bored Manager install"
  step 'Installing npm dependencies...'
  npm install --include=dev
  step "Removing ssh2's optional native bindings (pure-JS fallback is used)..."
  rm -rf node_modules/cpu-features \
         node_modules/ssh2/lib/protocol/crypto/build 2>/dev/null || true
  step 'Probing node-pty (optional, for local terminals)...'
  NODE_PTY_OK=0
  if npm install node-pty --no-save >/dev/null 2>&1; then
    if node --input-type=commonjs -e "require('node-pty')" >/dev/null 2>&1; then
      NODE_PTY_OK=1
    fi
  fi
  if [ "$NODE_PTY_OK" -eq 1 ]; then
    echo "  node-pty ready (native PTY for local terminals)"
  else
    rm -rf node_modules/node-pty
    echo "  node-pty unusable on this machine - removed it."
    echo "  Local terminals will use the 'script' fallback (still works)."
  fi
  step 'Building the app...'
  npm run build
}

if [ "$REPAIR" -eq 1 ]; then
  echo "==> Bored Manager repair"
  repair_app
  echo "==> Repair complete."
  exit 0
fi

# --- environment -------------------------------------------------------------
if [ "$(id -u)" -eq 0 ] && [ "${BM_ALLOW_ROOT:-}" != "1" ]; then
  die "refusing to run as root (data would live in /root). Re-run as a normal user, or set BM_ALLOW_ROOT=1"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js was not found."
  echo "On Ubuntu / Kali:"
  echo "  sudo apt update && sudo apt install -y nodejs npm"
  echo "If apt's nodejs is older than 20, use nvm instead: https://github.com/nvm-sh/nvm"
  exit 1
fi
NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  echo "ERROR: Node.js 20+ is required (found $(node -v))."
  echo "On Ubuntu / Kali:"
  echo "  sudo apt update && sudo apt install -y nodejs npm"
  echo "If apt's nodejs is older than 20, use nvm: https://github.com/nvm-sh/nvm"
  exit 1
fi
echo "  Node.js $(node -v) OK"

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  die "need curl or wget (sudo apt install -y curl)"
fi
if ! command -v unzip >/dev/null 2>&1; then
  die "need unzip (sudo apt install -y unzip)"
fi

download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$dest" "$url"
  else
    wget -qO "$dest" "$url"
  fi
}

# --- in-place vs bootstrap ---------------------------------------------------
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
INPLACE=0
SCRIPT_DIR=""
if [ -z "$SOURCE" ] && [ -n "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  if [ "$(pkg_name "$SCRIPT_DIR")" = 'bored-manager' ]; then
    INPLACE=1
  fi
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/bm-install.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

SRC=""
if [ "$INPLACE" -eq 1 ]; then
  step "In-place install from $SCRIPT_DIR"
  SRC="$SCRIPT_DIR"
else
  ZIP=""
  if [ -n "$SOURCE" ] && [ -f "$SOURCE" ]; then
    case "$SOURCE" in
      *.zip|*.ZIP) ZIP="$(cd "$(dirname "$SOURCE")" && pwd)/$(basename "$SOURCE")" ;;
      *) die "--source file must be a .zip (got $SOURCE)" ;;
    esac
    [ -f "$ZIP" ] || die "zip not found: $SOURCE"
    step "Using local zip $ZIP"
  elif [ -n "$SOURCE" ]; then
    case "$SOURCE" in
      http://*|https://*)
        ZIP="$TMP/source.zip"
        step "Downloading $SOURCE"
        download "$SOURCE" "$ZIP"
        ;;
      *) die "--source is neither an existing .zip nor a URL: $SOURCE" ;;
    esac
  else
    step 'Resolving the latest GitHub release...'
    JSON=""
    if command -v curl >/dev/null 2>&1; then
      JSON="$(curl -fsSL -H 'User-Agent: bored-manager-installer' \
        https://api.github.com/repos/FireStarsSoft/Bored-Manager/releases/latest || true)"
    else
      JSON="$(wget -qO- --header='User-Agent: bored-manager-installer' \
        https://api.github.com/repos/FireStarsSoft/Bored-Manager/releases/latest || true)"
    fi
    ASSET="$(printf '%s' "$JSON" | grep -oE 'https://[^"]*bored-manager-[^"]+\.zip' | head -n 1 || true)"
    if [ -n "$ASSET" ]; then
      ZIP="$TMP/source.zip"
      step "Downloading $ASSET"
      download "$ASSET" "$ZIP"
    else
      FALLBACK='https://codeload.github.com/FireStarsSoft/Bored-Manager/zip/refs/heads/main'
      ZIP="$TMP/source.zip"
      step "No release asset found - downloading $FALLBACK"
      download "$FALLBACK" "$ZIP"
    fi
  fi

  EXTRACT="$TMP/extract"
  mkdir -p "$EXTRACT"
  step 'Unpacking...'
  unzip -q "$ZIP" -d "$EXTRACT"
  if [ -f "$EXTRACT/package.json" ]; then
    SRC="$EXTRACT"
  else
    FOUND=""
    COUNT=0
    for d in "$EXTRACT"/*; do
      [ -f "$d/package.json" ] || continue
      FOUND="$d"
      COUNT=$((COUNT + 1))
    done
    [ "$COUNT" -eq 1 ] || die "could not find a unique app folder (package.json) in the archive"
    SRC="$FOUND"
  fi
  [ "$(pkg_name "$SRC")" = 'bored-manager' ] || die "the archive is not a Bored Manager source tree"
fi

# --- write into --dir --------------------------------------------------------
DIR="$(cd "$(dirname "$DIR")" 2>/dev/null && pwd)/$(basename "$DIR")" || DIR="$DIR"
mkdir -p "$(dirname "$DIR")"

copy_into() {
  local from="$1" to="$2"
  local item name
  shopt -s dotglob nullglob
  for item in "$from"/*; do
    [ -e "$item" ] || continue
    name="$(basename "$item")"
    # data/ is created/kept on the target. node_modules and out are rebuilt
    # by --repair; .git is the developer's checkout, not part of an install.
    case "$name" in
      data|node_modules|out|.git) continue ;;
    esac
    rm -rf "$to/$name"
    cp -a "$item" "$to/"
  done
  shopt -u dotglob nullglob
}

if [ ! -e "$DIR" ]; then
  step "Installing into $DIR"
  mkdir -p "$DIR"
  copy_into "$SRC" "$DIR"
elif [ -f "$DIR/package.json" ] && [ "$(pkg_name "$DIR")" = 'bored-manager' ]; then
  step "Updating existing install at $DIR (keeping data/)"
  copy_into "$SRC" "$DIR"
elif [ -z "$(ls -A "$DIR" 2>/dev/null || true)" ]; then
  step "Installing into empty $DIR"
  copy_into "$SRC" "$DIR"
else
  die "$DIR already exists and is not a Bored Manager install. Choose another --dir."
fi

cd "$DIR"
repair_app
chmod +x run.sh bored-manager install.sh uninstall.sh scripts/*.sh 2>/dev/null || true

# --- settings: port / host ---------------------------------------------------
mkdir -p data/user-settings
SETTINGS="data/user-settings/settings.json"
if [ ! -f "$SETTINGS" ]; then
  cat > "$SETTINGS" <<EOF
{"settingsVersion":4,"server":{"port":${PORT},"host":"${HOST}"}}
EOF
  step "Wrote $SETTINGS"
else
  node --input-type=commonjs -e '
    const fs = require("fs");
    const file = process.argv[1];
    const port = Number(process.argv[2]);
    const host = process.argv[3];
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    s.server = Object.assign({}, s.server, {
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8686,
      host: host || "0.0.0.0"
    });
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  ' "$SETTINGS" "$PORT" "$HOST"
  step "Updated server.port/host in $SETTINGS"
fi

# --- systemd user unit -------------------------------------------------------
SERVICE_OK=0
if [ "$NO_SERVICE" -eq 1 ]; then
  echo "  Skipping systemd (--no-service)."
elif ! command -v systemctl >/dev/null 2>&1; then
  echo "WARNING: systemctl not found (common on some WSL setups)."
  echo "         Start the app with:  $DIR/bored-manager start"
else
  UNIT_DIR="${HOME}/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  # systemd user services get a minimal PATH of their own (no ~/.nvm, no
  # user-local Node install) - it does not inherit this login shell's PATH.
  # Bake in the PATH node/npm were actually found on so run.sh's bare `node`
  # and `npm` calls resolve the same way here as they just did above.
  awk -v dir="$DIR" -v path="$PATH" '{ gsub(/%DIR%/, dir); gsub(/%PATH%/, path); print }' \
    "$DIR/scripts/bored-manager.service" > "$UNIT_DIR/bored-manager.service"
  if systemctl --user daemon-reload \
     && systemctl --user enable --now bored-manager; then
    SERVICE_OK=1
    loginctl enable-linger "$USER" 2>/dev/null \
      || echo "WARNING: could not enable linger — the service will stop on logout"
  else
    echo "WARNING: could not enable the user service."
    echo "         Start the app with:  $DIR/bored-manager start"
  fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
[ -n "${IP:-}" ] || IP="$(hostname -i 2>/dev/null | awk '{print $1}')" || true
[ -n "${IP:-}" ] || IP=127.0.0.1

echo ""
echo "==> Bored Manager is installed"
echo "    Folder:  $DIR"
if [ "$SERVICE_OK" -eq 1 ]; then
  echo "    Service: bored-manager.service (user) — enabled and started"
else
  echo "    Service: not registered"
fi
echo "    URL:     http://${IP}:${PORT}"
echo ""
echo "    $DIR/bored-manager start"
echo "    $DIR/bored-manager stop"
echo "    $DIR/bored-manager status"
echo "    $DIR/bored-manager unlock"
echo ""
echo "    Login is off by default. Turn it on in Settings → Server & users."
