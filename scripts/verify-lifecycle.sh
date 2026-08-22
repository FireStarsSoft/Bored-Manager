#!/usr/bin/env bash
# Lifecycle checks for install/update/uninstall. Used by the maintainer on Linux/WSL.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

lf() {
  local f="$1"
  local tmp
  tmp="$(mktemp)"
  tr -d '\r' < "$f" > "$tmp"
  cat "$tmp" > "$f"
  rm -f "$tmp"
}

for f in install.sh uninstall.sh run.sh bored-manager scripts/update.sh scripts/package.sh scripts/verify-lifecycle.sh; do
  lf "$f"
done
chmod +x install.sh uninstall.sh run.sh bored-manager scripts/*.sh

bash -n install.sh
bash -n uninstall.sh
bash -n bored-manager
bash -n run.sh
bash -n scripts/update.sh
echo "SYNTAX_OK"

if systemctl --user status >/dev/null 2>&1; then
  echo "SYSTEMD_USER=yes"
else
  echo "SYSTEMD_USER=no"
fi
echo "node=$(command -v node >/dev/null && node -v || echo missing)"
echo "npm=$(command -v npm >/dev/null && npm -v || echo missing)"

# --- dummy app tree so we do not need a full npm build ---
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bm-lifecycle.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

DUMMY="$WORK/dummy"
mkdir -p "$DUMMY/scripts" "$DUMMY/data" "$DUMMY/modules/hello" "$DUMMY/src"
cat > "$DUMMY/package.json" <<'EOF'
{
  "name": "bored-manager",
  "version": "0.3.1-test",
  "scripts": { "build": "node -e \"require('fs').mkdirSync('out/server',{recursive:true});require('fs').writeFileSync('out/server/index.mjs','ok\\n')\"" }
}
EOF
cat > "$DUMMY/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--repair" ]; then
  mkdir -p out/server
  printf 'ok\n' > out/server/index.mjs
  echo "dummy repair ok"
  exit 0
fi
echo "dummy install has no bootstrap" >&2
exit 2
EOF
cat > "$DUMMY/run.sh" <<'EOF'
#!/usr/bin/env bash
exec true
EOF
cat > "$DUMMY/bored-manager" <<'EOF'
#!/usr/bin/env bash
echo "dummy $*"
exit 0
EOF
cat > "$DUMMY/uninstall.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$DUMMY/scripts/update.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$DUMMY/scripts/bored-manager.service" <<'EOF'
[Service]
WorkingDirectory=%DIR%
ExecStart=%DIR%/run.sh
Environment=PATH=%PATH%
EOF
printf '%s\n' '{"id":"hello"}' > "$DUMMY/modules/hello/module.json"
printf '%s\n' 'ok' > "$DUMMY/src/index.html"
mkdir -p "$DUMMY/shared"
cp "$ROOT/scripts/seed-settings.ts" "$DUMMY/scripts/seed-settings.ts"
cp "$ROOT/shared/types.ts" "$ROOT/shared/app-settings.ts" "$ROOT/shared/validation.ts" "$DUMMY/shared/"
chmod +x "$DUMMY"/*.sh "$DUMMY/bored-manager" "$DUMMY/scripts"/*.sh
if ! grep -q 'settingsVersion.:6' "$ROOT/install.sh"; then
  :
else
  echo "ERROR: install.sh still contains a settingsVersion 6 stub" >&2
  exit 1
fi

make_zip() {
  local dest="$1"
  if command -v zip >/dev/null 2>&1; then
    (cd "$WORK" && zip -qr "$dest" dummy)
  else
    python3 - "$WORK" "$dest" <<'PY'
import sys, zipfile, os
root, dest = sys.argv[1], sys.argv[2]
base = os.path.join(root, "dummy")
with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _, files in os.walk(base):
        for name in files:
            full = os.path.join(dirpath, name)
            z.write(full, os.path.relpath(full, root).replace("\\", "/"))
PY
  fi
}

ZIP="$WORK/dummy.zip"
make_zip "$ZIP"

INSTALLER="$ROOT/install.sh"
DIR1="$WORK/install-a"
DIR2="$WORK/install-b"

echo "==> fresh install"
bash "$INSTALLER" --source "$ZIP" --dir "$DIR1" --port 8790 --no-service
test -f "$DIR1/package.json"
test -f "$DIR1/data/user-settings/settings.json"
grep -q '"port":8790\|"port": 8790' "$DIR1/data/user-settings/settings.json"
grep -q '"auth"' "$DIR1/data/user-settings/settings.json"
test -f "$DIR1/out/server/index.mjs"

mkdir -p "$DIR1/data/users/alice" "$DIR1/data/module-data/hello" "$DIR1/modules/custom"
printf '%s\n' '{"ok":1}' > "$DIR1/data/users/users.json"
printf '%s\n' 'secret' > "$DIR1/data/secret.key"
printf '%s\n' 'hosts' > "$DIR1/data/known-hosts.json"
printf '%s\n' '{"id":"custom"}' > "$DIR1/modules/custom/module.json"
printf '%s\n' 'metric' > "$DIR1/data/metrics.log"
mkdir -p "$DIR1/data/metrics"
printf '%s\n' 'old' > "$DIR1/data/metrics/x.jsonl"

echo "==> --repair heals the v0.3.4 installer stub"
printf '%s\n' '{"settingsVersion":6,"server":{"port":8790,"host":"0.0.0.0"}}' \
  > "$DIR1/data/user-settings/settings.json"
(cd "$DIR1" && bash "$INSTALLER" --repair)
grep -q '"port":8790\|"port": 8790' "$DIR1/data/user-settings/settings.json"
grep -q '"auth"' "$DIR1/data/user-settings/settings.json"

echo "==> update in place keeps port and users"
# bump dummy version so we can see the copy
sed -i 's/0.3.1-test/0.3.2-test/' "$DUMMY/package.json"
make_zip "$ZIP"
bash "$INSTALLER" --source "$ZIP" --dir "$DIR1" --no-service
grep -q '"port":8790\|"port": 8790' "$DIR1/data/user-settings/settings.json"
test -f "$DIR1/data/users/users.json"
test -f "$DIR1/data/secret.key"
grep -q '0.3.2-test' "$DIR1/package.json"

echo "==> --refresh drops custom modules, keeps users/settings"
bash "$INSTALLER" --refresh --source "$ZIP" --dir "$DIR1" --no-service
test -f "$DIR1/data/users/users.json"
test -f "$DIR1/data/secret.key"
grep -q '"port":8790\|"port": 8790' "$DIR1/data/user-settings/settings.json"
test ! -e "$DIR1/modules/custom"
test ! -e "$DIR1/data/metrics/x.jsonl"

echo "==> --renew --yes wipes everything"
bash "$INSTALLER" --renew --yes --source "$ZIP" --dir "$DIR1" --port 8687 --no-service
test ! -e "$DIR1/data/users/users.json"
test ! -e "$DIR1/data/secret.key"
grep -q '"port":8687\|"port": 8687' "$DIR1/data/user-settings/settings.json"

echo "==> update.sh rollback"
APP="$WORK/live"
STAGE="$WORK/stage"
mkdir -p "$APP/data/users" "$APP/scripts" "$STAGE/scripts"
printf '%s\n' '{"name":"bored-manager","version":"1.0.0"}' > "$APP/package.json"
printf '%s\n' '{"name":"bored-manager","version":"9.9.9"}' > "$STAGE/package.json"
printf '%s\n' 'keep-me' > "$APP/data/users/users.json"
printf '%s\n' 'old' > "$APP/keep.txt"
cat > "$APP/install.sh" <<'EOF'
#!/usr/bin/env bash
echo "old repair"
exit 0
EOF
cat > "$STAGE/install.sh" <<'EOF'
#!/usr/bin/env bash
echo "new repair should fail"
exit 7
EOF
cat > "$APP/bored-manager" <<'EOF'
#!/usr/bin/env bash
echo "start-stub"
exit 0
EOF
cp "$APP/bored-manager" "$STAGE/bored-manager"
cp "$ROOT/scripts/update.sh" "$WORK/update.sh"
chmod +x "$APP/install.sh" "$STAGE/install.sh" "$APP/bored-manager" "$WORK/update.sh"
if bash "$WORK/update.sh" -AppDir "$APP" -StagingDir "$STAGE" -AppPid 0 -NewVersion 9.9.9; then
  echo "ERROR: update.sh should have failed" >&2
  exit 1
fi
test -f "$APP/keep.txt"
test -f "$APP/data/users/users.json"
grep -q '1.0.0' "$APP/package.json"
test -f "$APP/data/update-result.json"
grep -q '"ok": false' "$APP/data/update-result.json"

echo "==> update.sh success + quarantine field"
printf '%s\n' '{"name":"bored-manager","version":"2.0.0"}' > "$STAGE/package.json"
cat > "$STAGE/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p out/server
printf 'ok\n' > out/server/index.mjs
echo "new repair ok"
exit 0
EOF
chmod +x "$STAGE/install.sh"
bash "$WORK/update.sh" -AppDir "$APP" -StagingDir "$STAGE" -AppPid 0 -NewVersion 2.0.0
grep -q '2.0.0' "$APP/package.json"
test -f "$APP/out/server/index.mjs"
test -f "$APP/data/users/users.json"
grep -q '"ok": true' "$APP/data/update-result.json"
grep -q '"quarantined"' "$APP/data/update-result.json"

echo "==> uninstall --purge --yes"
mkdir -p "$DIR2"
printf '%s\n' '{"name":"bored-manager"}' > "$DIR2/package.json"
cp "$ROOT/uninstall.sh" "$DIR2/uninstall.sh"
chmod +x "$DIR2/uninstall.sh"
bash "$DIR2/uninstall.sh" --purge --yes
test ! -e "$DIR2"

echo "LIFECYCLE_OK"
