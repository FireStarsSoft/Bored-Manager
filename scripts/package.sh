#!/usr/bin/env bash
# Build a distributable zip of Bored Manager (Linux/macOS).
#
# The app ships as a source folder, so a release is simply the project without
# anything the development machine produced: node_modules, out and data are
# rebuilt or recreated by the installer on the target machine.
#
# Nothing in the working copy is touched - the files that belong in a release
# are copied to a temp staging folder, checked, and zipped from there.
#
# Usage:
#   ./package.sh                 write bored-manager-<version>.zip next to this script
#   ./package.sh /path/to/dir    write it somewhere else
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${1:-$SCRIPT_DIR}"

# What a release consists of. An allowlist rather than "copy everything except
# ..." so a stray local file can never end up in a published archive.
INCLUDE_DIRS=(assets docs modules registry scripts server shared src)
INCLUDE_FILES=(
    .gitignore
    LICENSE
    README.MD
    bored-manager
    install.sh
    package-lock.json
    package.json
    run.sh
    tsconfig.json
    tsconfig.node.json
    tsconfig.web.json
    uninstall.sh
    vite.config.ts
    vite.config.server.ts
)
# Development leftovers, deliberately left out (listed so the script can tell
# "known to be excluded" apart from "new file nobody classified yet").
KNOWN_EXCLUDED=(.git .cursor .github data modules-disabled node_modules out start-app.cmd start-app.vbs Todos.MD)

# Same list the in-app updater validates a downloaded archive against, so a
# package built here can never fail that check - plus the module folders, whose
# absence would produce an app with no features at all.
REQUIRED_ENTRIES=(
    package.json package-lock.json
    vite.config.ts vite.config.server.ts
    server/index.ts server/rpc.ts server/ipc.ts
    shared/types.ts shared/modules.ts src src/index.html
    modules modules/modules.lock.json
    modules/processes/module.json modules/network/module.json
    modules/disk/module.json modules/sensors/module.json
    modules/gpu/module.json modules/docker/module.json
    docs/MODULE-RULESET.md
    assets/icon.png
    run.sh install.sh bored-manager
    scripts/update.sh scripts/bored-manager.service
    registry/modules.json
)

step() { echo "==> $1"; }
warn() { echo "    WARNING: $1"; }
die()  { echo "ERROR: $1" >&2; exit 1; }
contains() {
    local needle="$1"; shift
    local item
    for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
    return 1
}

step 'Bored Manager release packager (Linux)'
echo "    Project: $REPO_ROOT"

# --- 1. Version ---------------------------------------------------------------
MANIFEST="$REPO_ROOT/package.json"
[ -f "$MANIFEST" ] || die "$MANIFEST not found - run this from the project's scripts folder."

# Read a top-level string from package.json with whatever the machine has.
# Packaging should not need a working toolchain, only the files themselves.
manifest_field() {
    local key="$1"
    if command -v node >/dev/null 2>&1; then
        node -p "require('$MANIFEST')['$key'] || ''" 2>/dev/null && return 0
    fi
    if command -v python3 >/dev/null 2>&1; then
        python3 -c "import json;print(json.load(open('$MANIFEST')).get('$key',''))" 2>/dev/null && return 0
    fi
    sed -n "s/^[[:space:]]*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$MANIFEST" | head -n 1
}

VERSION=$(manifest_field version)
NAME=$(manifest_field name)
[ "$NAME" = 'bored-manager' ] || die 'package.json is not a Bored Manager manifest.'
[ -n "$VERSION" ] || die 'package.json has no version.'
PACKAGE_NAME="bored-manager-$VERSION"
echo "    Version: $VERSION"

# --- 1b. Module lock -----------------------------------------------------------
# The lock records which modules ship with the app and what their files hashed
# to. A stale lock would make a fresh install report every module as modified,
# so it is regenerated (not just checked) before anything is copied.
if command -v node >/dev/null 2>&1; then
    step 'Refreshing modules/modules.lock.json...'
    node "$SCRIPT_DIR/modules-lock.mjs" || die 'could not write the module lock.'
else
    warn 'node is not available - modules/modules.lock.json was not refreshed.'
fi

# --- 2. Point out anything nobody classified ----------------------------------
for path in "$REPO_ROOT"/* "$REPO_ROOT"/.*; do
    entry="$(basename "$path")"
    [ "$entry" = '.' ] || [ "$entry" = '..' ] && continue
    [ -e "$path" ] || continue
    contains "$entry" "${INCLUDE_DIRS[@]}" && continue
    contains "$entry" "${INCLUDE_FILES[@]}" && continue
    contains "$entry" "${KNOWN_EXCLUDED[@]}" && continue
    case "$entry" in *.log) continue ;; esac
    warn "'$entry' is not in the release list and will NOT be packaged."
done

# --- 3. Stage a clean copy ------------------------------------------------------
STAGING_ROOT="${TMPDIR:-/tmp}/bored-manager-package"
STAGE_DIR="$STAGING_ROOT/$PACKAGE_NAME"
step 'Collecting the files a release needs...'
rm -rf "$STAGING_ROOT"
mkdir -p "$STAGE_DIR"

for name in "${INCLUDE_DIRS[@]}"; do
    [ -d "$REPO_ROOT/$name" ] || die "required folder '$name' is missing."
    cp -a "$REPO_ROOT/$name" "$STAGE_DIR/"
done
for name in "${INCLUDE_FILES[@]}"; do
    if [ -f "$REPO_ROOT/$name" ]; then
        cp -a "$REPO_ROOT/$name" "$STAGE_DIR/"
    else
        warn "'$name' does not exist and was skipped."
    fi
done

# Earlier release archives live in scripts/ - they must not ship inside the
# next one, and neither must a leftover update log.
find "$STAGE_DIR/scripts" \( -name '*.zip' -o -name '*.log' \) -delete 2>/dev/null || true
# A backup folder left behind by an interrupted module install is runtime state.
find "$STAGE_DIR/modules" -maxdepth 1 -type d -name '*.backup-*' -exec rm -rf {} + 2>/dev/null || true
# Compiled module bundles are rebuilt on the target.
rm -rf "$STAGE_DIR"/modules/*/.dist 2>/dev/null || true
# A checkout on a Windows filesystem loses the executable bit; the installer
# and launcher have to stay runnable on the target machine.
chmod +x "$STAGE_DIR"/bored-manager "$STAGE_DIR"/*.sh "$STAGE_DIR"/scripts/*.sh 2>/dev/null || true

# --- 4. Verify the staged tree ---------------------------------------------------
step 'Checking the package is complete...'
MISSING=""
for entry in "${REQUIRED_ENTRIES[@]}"; do
    [ -e "$STAGE_DIR/$entry" ] || MISSING="$MISSING $entry"
done
[ -z "$MISSING" ] || die "the package would be missing:$MISSING"
FILE_COUNT=$(find "$STAGE_DIR" -type f | wc -l | tr -d ' ')
echo "    $FILE_COUNT files, every required entry present."

# --- 5. Zip it ------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
ZIP_PATH="$OUTPUT_DIR/$PACKAGE_NAME.zip"
step "Writing $ZIP_PATH"
rm -f "$ZIP_PATH"
if command -v zip >/dev/null 2>&1; then
    (cd "$STAGING_ROOT" && zip -r -q "$ZIP_PATH" "$PACKAGE_NAME")
elif command -v python3 >/dev/null 2>&1; then
    (cd "$STAGING_ROOT" && python3 -m zipfile -c "$ZIP_PATH" "$PACKAGE_NAME")
else
    die "neither 'zip' nor 'python3' is available (install one, e.g. sudo apt install zip)."
fi

# --- 6. Read the archive back ----------------------------------------------------
if command -v python3 >/dev/null 2>&1; then
    ENTRY_COUNT=$(python3 -c "
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    names = [n for n in z.namelist() if not n.endswith('/')]
    print(len(names) if sys.argv[2] + '/package.json' in names else -1)
" "$ZIP_PATH" "$PACKAGE_NAME")
elif command -v unzip >/dev/null 2>&1; then
    ENTRY_COUNT=$(unzip -Z1 "$ZIP_PATH" | grep -vc '/$')
else
    ENTRY_COUNT="$FILE_COUNT"
    warn 'no tool available to read the archive back - skipping that check.'
fi
[ "$ENTRY_COUNT" = "$FILE_COUNT" ] || \
    die "the archive is incomplete ($ENTRY_COUNT of $FILE_COUNT files)."
rm -rf "$STAGING_ROOT"

SIZE_MB=$(awk "BEGIN { printf \"%.2f\", $(wc -c < "$ZIP_PATH") / 1048576 }")
echo ""
echo "==> Release ready: $ZIP_PATH"
echo "    $ENTRY_COUNT files, $SIZE_MB MB"
if command -v sha256sum >/dev/null 2>&1; then
    echo "    sha256: $(sha256sum "$ZIP_PATH" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
    echo "    sha256: $(shasum -a 256 "$ZIP_PATH" | cut -d' ' -f1)"
fi
echo ""
echo "    On a fresh Linux machine:"
echo "      curl -fsSL https://raw.githubusercontent.com/FireStarsSoft/Bored-Manager/main/install.sh | bash -s -- --source $ZIP_PATH"
