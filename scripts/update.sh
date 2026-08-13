#!/usr/bin/env bash
# Bored Manager updater for Linux - started by the app, runs after it quits.
#
# The app cannot replace its own folder while it is running, so it downloads
# and verifies the new version, then hands over to this script and exits.
#
# What happens here, as one transaction:
#   1. wait for the app process to disappear
#   2. rename the whole app folder to <name>.update-backup-<timestamp>
#   3. copy the verified new version into the original path
#   4. restore data/connections.json and data/user-settings/ from the backup
#      (the app migrates a settings file written by an older version)
#   5. restore the modules the user installed themselves - the ones in the
#      backup that the new version does not ship
#   6. install.sh --repair  (npm install + build + chmod run.sh)
#      a build that fails only because of a restored module is retried once with
#      those modules quarantined, so a module written for the old version cannot
#      block the update
#   7. success -> delete the backup;  failure -> put the backup back
#
# Nothing is deleted before the backup exists, so a failed update always ends
# with the previous installation running again.
#
# Arguments mirror the Windows script:
#   -AppDir <dir> -StagingDir <dir> -AppPid <pid> [-NewVersion <version>]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/update.log"
APP_DIR=""
STAGING_DIR=""
APP_PID=""
NEW_VERSION=""
BACKUP_DIR=""

while [ $# -gt 0 ]; do
    case "$1" in
        -AppDir)     APP_DIR="$2"; shift 2 ;;
        -StagingDir) STAGING_DIR="$2"; shift 2 ;;
        -AppPid)     APP_PID="$2"; shift 2 ;;
        -NewVersion) NEW_VERSION="$2"; shift 2 ;;
        *) echo "Unknown argument: $1"; exit 2 ;;
    esac
done

systemctl --user stop bored-manager 2>/dev/null || true

log() {
    local line
    line="[$(date '+%H:%M:%S')] $1"
    echo "$line"
    echo "$line" >> "$LOG_FILE" 2>/dev/null || true
}

notify() {
    # notify-send blocks for over a minute when no notification daemon answers
    # (headless session, no D-Bus), so fire it off without ever waiting.
    if command -v notify-send >/dev/null 2>&1; then
        (notify-send "Bored Manager update" "$1" >/dev/null 2>&1 &)
    fi
    return 0
}

# Handed to the app on its next start so it can show the outcome as a notice.
write_result() {
    local ok="$1" error_message="$2" data_dir="$APP_DIR/data" copied_log="$APP_DIR/data/update.log"
    [ -f "$APP_DIR/package.json" ] || return 0
    mkdir -p "$data_dir" 2>/dev/null || return 0
    cp -f "$LOG_FILE" "$copied_log" 2>/dev/null || true
    # Escape the few characters that would break the JSON string.
    local escaped
    escaped=$(printf '%s' "$error_message" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   ')
    cat > "$data_dir/update-result.json" <<EOF
{
  "ok": $ok,
  "version": "$NEW_VERSION",
  "error": "$escaped",
  "finishedAt": $(( $(date +%s) * 1000 )),
  "logPath": "$copied_log"
}
EOF
}

hold_window_open() {
    echo ""
    echo "Press Enter to close this window."
    read -r _ 2>/dev/null || true
}

fail() {
    local message="$1"
    log "UPDATE FAILED: $message"

    # Roll back: throw away the half-installed copy and put the backup back.
    if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
        log "Restoring the previous installation..."
        rm -rf "$APP_DIR" 2>/dev/null || true
        if mv "$BACKUP_DIR" "$APP_DIR"; then
            log "The previous version is back in place and can be started again."
        else
            log "ROLLBACK FAILED - your previous installation is still complete in:"
            log "    $BACKUP_DIR"
            log "Rename that folder back to '$APP_DIR' to recover it."
        fi
    fi

    write_result false "$message"
    log "Full log: $LOG_FILE"
    notify "Update failed - the previous version was restored. See $LOG_FILE"
    systemctl --user start bored-manager 2>/dev/null || true
    hold_window_open
    exit 1
}

log "================ Bored Manager update ================"
log "App folder:  $APP_DIR"
log "New version: ${NEW_VERSION:-unknown}"

# --- 1. Safety checks (nothing is touched yet) --------------------------------
[ -n "$APP_DIR" ] && [ -n "$STAGING_DIR" ] && [ -n "$APP_PID" ] || \
    fail "Missing arguments (-AppDir / -StagingDir / -AppPid)."
PARENT_DIR="$(dirname "$APP_DIR")"
LEAF_NAME="$(basename "$APP_DIR")"
[ "$PARENT_DIR" != "$APP_DIR" ] && [ "$APP_DIR" != "/" ] || \
    fail "The app folder '$APP_DIR' has no parent folder - refusing to touch it."
[ -f "$APP_DIR/package.json" ] || \
    fail "'$APP_DIR' does not look like the app folder (no package.json)."
[ -f "$STAGING_DIR/package.json" ] || \
    fail "The downloaded update is gone from '$STAGING_DIR'."
[ -w "$PARENT_DIR" ] || \
    fail "No permission to write in '$PARENT_DIR', so the app folder cannot be replaced."
for tool in node npm; do
    command -v "$tool" >/dev/null 2>&1 || \
        fail "$tool was not found on PATH. Install Node.js 20+ and run the update again."
done

# --- 2. Wait for the app to close ---------------------------------------------
log "Waiting for Bored Manager (pid $APP_PID) to close..."
WAITED=0
while kill -0 "$APP_PID" 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge 120 ]; then
        fail "Bored Manager (pid $APP_PID) is still running after 2 minutes. Nothing was changed."
    fi
done
log "The app has closed."
sleep 1

# --- 3. Move the current installation aside -----------------------------------
BACKUP_DIR="$PARENT_DIR/$LEAF_NAME.update-backup-$(date '+%Y%m%d-%H%M%S')"
log "Moving the current installation to $BACKUP_DIR"
if ! mv "$APP_DIR" "$BACKUP_DIR"; then
    BACKUP_DIR=""   # nothing was moved - no rollback to do
    fail "Could not move '$APP_DIR' aside. Nothing was changed."
fi

# --- 4. Install the new version -----------------------------------------------
log "Copying the new version into place..."
mkdir -p "$APP_DIR" || fail "Could not recreate '$APP_DIR'."
cp -a "$STAGING_DIR/." "$APP_DIR/" || fail "Copying the new version failed."

# --- 5. Keep the connections and the settings, drop everything else -----------
mkdir -p "$APP_DIR/data" || fail "Could not create '$APP_DIR/data'."
if [ -f "$BACKUP_DIR/data/connections.json" ]; then
    cp -f "$BACKUP_DIR/data/connections.json" "$APP_DIR/data/connections.json" || \
        fail "Could not restore the saved connections."
    log "Saved connections carried over."
else
    log "No saved connections to carry over."
fi
# The new version reads an older settings file, fills in what it does not know
# yet and rewrites it in its own format, so carrying the file over is safe.
if [ -d "$BACKUP_DIR/data/user-settings" ]; then
    if mkdir -p "$APP_DIR/data/user-settings" && \
       cp -a "$BACKUP_DIR/data/user-settings/." "$APP_DIR/data/user-settings/"; then
        log "User settings carried over (they are migrated on the first start)."
    else
        # Not worth rolling back a working update - the app falls back to its
        # defaults and the old file is still in the backup folder.
        log "WARNING: could not carry the user settings over; defaults will be used."
    fi
else
    log "No user settings to carry over."
fi
if [ -d "$BACKUP_DIR/data/users" ]; then
    if mkdir -p "$APP_DIR/data/users" && \
       cp -a "$BACKUP_DIR/data/users/." "$APP_DIR/data/users/"; then
        log "User accounts carried over."
    else
        log "WARNING: could not carry the user accounts over."
    fi
fi
if [ -f "$BACKUP_DIR/data/secret.key" ]; then
    cp -f "$BACKUP_DIR/data/secret.key" "$APP_DIR/data/secret.key" || \
        log "WARNING: could not carry the secret key over."
fi
log "The metrics history and the logs of the old version were not carried over."

# --- 5b. Carry over the modules the user installed themselves -----------------
# A module is source code inside the app folder, so replacing the folder would
# take custom modules with it. Anything in the backup that the new version does
# not ship is restored; a module that ships with both is left at the new
# version, which is what the user gets by updating.
RESTORED_MODULES=""
if [ -d "$BACKUP_DIR/modules" ]; then
    mkdir -p "$APP_DIR/modules" 2>/dev/null || true
    for old in "$BACKUP_DIR"/modules/*; do
        [ -d "$old" ] || continue
        name="$(basename "$old")"
        [ -f "$old/module.json" ] || continue
        if [ -d "$APP_DIR/modules/$name" ]; then
            log "Module '$name' ships with the new version - keeping the new one."
            continue
        fi
        if cp -a "$old" "$APP_DIR/modules/"; then
            RESTORED_MODULES="$RESTORED_MODULES $name"
            log "Custom module '$name' carried over."
        else
            log "WARNING: could not carry the module '$name' over."
        fi
    done
fi
[ -n "$RESTORED_MODULES" ] || log "No custom modules to carry over."

# --- 6. Dependencies, build and launcher --------------------------------------
run_repair() {
    (
        cd "$APP_DIR" || exit 1
        bash ./install.sh --repair 2>&1 | tee -a "$LOG_FILE"
        exit "${PIPESTATUS[0]}"
    )
}

log "Installing dependencies and building the new version (this takes a few minutes)..."
echo ""
chmod +x "$APP_DIR/install.sh" "$APP_DIR/run.sh" "$APP_DIR/bored-manager" 2>/dev/null || true
run_repair
INSTALL_EXIT=$?
QUARANTINED=""
if [ "$INSTALL_EXIT" -ne 0 ] && [ -n "$RESTORED_MODULES" ]; then
    # The only new code in this build is the modules that were just restored, so
    # they are the first suspect. Move them aside and try once more rather than
    # rolling the whole update back over a third-party module.
    log "The build failed. Quarantining the carried-over modules and trying once more..."
    mkdir -p "$APP_DIR/modules-disabled" 2>/dev/null || true
    for name in $RESTORED_MODULES; do
        if mv "$APP_DIR/modules/$name" "$APP_DIR/modules-disabled/$name" 2>/dev/null; then
            QUARANTINED="$QUARANTINED $name"
        fi
    done
    if [ -n "$QUARANTINED" ]; then
        run_repair
        INSTALL_EXIT=$?
    fi
fi
if [ "$INSTALL_EXIT" -ne 0 ]; then
    fail "install.sh --repair exited with code $INSTALL_EXIT - the new version could not be built."
fi
[ -f "$APP_DIR/out/server/index.mjs" ] || \
    fail "The build finished but out/server/index.mjs is missing."
if [ -n "$QUARANTINED" ]; then
    log "These modules could not be built against the new version and were moved to"
    log "    $APP_DIR/modules-disabled/"
    log "   ${QUARANTINED# }"
    log "Update each of them and install the new zip from Settings -> Modules."
fi

# --- 7. Done ------------------------------------------------------------------
log "Removing the backup of the previous version..."
rm -rf "$BACKUP_DIR" || log "Could not delete $BACKUP_DIR - you can remove it by hand."
BACKUP_DIR=""
write_result true ""
rm -rf "$STAGING_DIR" 2>/dev/null || true

VERSION_LABEL="${NEW_VERSION:+version $NEW_VERSION}"
echo ""
log "Bored Manager was updated to ${VERSION_LABEL:-the new version}."
if systemctl --user start bored-manager 2>/dev/null; then
    log "bored-manager.service started."
else
    echo "Chạy $APP_DIR/bored-manager start để mở lại"
fi
if [ -n "$QUARANTINED" ]; then
    notify "Update complete${NEW_VERSION:+ ($NEW_VERSION)}, but these modules were disabled:${QUARANTINED}"
else
    notify "Update complete${NEW_VERSION:+ ($NEW_VERSION)}."
fi
hold_window_open
