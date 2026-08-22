# Deployment

Packaging a release, installing it, and how updating works.

## What a release is

The app ships as a **source folder**. There is no compiled installer: the archive contains the source, and the installer on the target machine pulls the dependencies and builds. All it needs is Node.js 20+ and a network connection (npm registry, and GitHub for the first download).

A release is therefore the project minus everything the development machine produced (`node_modules/`, `out/`, `data/`).

## Packaging

```bash
./scripts/package.sh              # -> scripts/bored-manager-<version>.zip
./scripts/package.sh /tmp/release # somewhere else
```

What the script does, in order:

1. Reads the version from `package.json` and checks the manifest really is Bored Manager's.
2. Regenerates `modules/modules.lock.json`. This is not optional: a stale lock would make a fresh install report every module as "files modified", and would get the built-in/installed distinction wrong.
3. Warns about any file or folder at the project root it has no rule for. The file list is an **allowlist**, so a stray local file can never end up in a release — but a genuinely new one should not be forgotten either.
4. Copies exactly the release files into a temp staging folder. **Your working folder is never modified**, so `node_modules/` and `out/` stay put and you can keep developing.
5. Checks the staged copy against `REQUIRED_ENTRIES` (kept in step with the in-app updater — see [MAINTENANCE.md](MAINTENANCE.md#keeping-the-two-required-file-lists-in-step)).
6. Zips it with a single root folder `bored-manager-<version>/`, like GitHub's own source archives, so unpacking never litters the current directory.
7. Reads the archive back to confirm the file count and that `<folder>/package.json` is there.
8. Writes `bored-manager-<version>.zip.sha256` next to the zip (SHA-256 of the archive).

A zip created on Linux keeps the `+x` bit, so `./install.sh` runs straight away.

### What is in a release

| Included | |
|---|---|
| `assets/` | `icon.png` |
| `docs/` | this documentation |
| `server/` | Express + WebSocket RPC |
| `modules/` | the nine built-in modules and `modules.lock.json` |
| `registry/` | `modules.json` (community catalog) |
| `scripts/` | `package.sh`, `update.sh`, `bored-manager.service`, `seed-settings.ts`, module tooling, `licenses.mjs` |
| `shared/`, `src/` | shared code and the renderer |
| root files | `package.json`, `package-lock.json`, the Vite configs, the tsconfigs, `components.json`, `install.sh`, `uninstall.sh`, `run.sh`, `bored-manager`, `README.MD`, `LICENSE`, `.gitignore` |

| Excluded | Why |
|---|---|
| `node_modules/`, `out/` | binaries and build output; recreated by the installer |
| `data/` | the user's own settings, accounts, logs and metrics |
| `modules-disabled/` | modules quarantined by a previous update — runtime state |
| `modules/*.backup-*` | left behind by an interrupted module install |
| `scripts/*.zip`, `*.log` | earlier archives and logs |
| `.git`, `.github`, `.cursor`, `.cursorignore`, `Todos.MD`, `tests/`, `vitest.config.ts` | development only |

`tsconfig.test.json` ships even though `tests/` does not. The root `tsconfig.json` references it, and Vite 7 parses that reference during `vite build`; a zip without the file fails a fresh install.

## GitHub Actions

Pushing a tag matching `v*` runs `.github/workflows/release.yml`:

1. checkout, Node 20
2. `bash scripts/package.sh dist`
3. `gh release create "$GITHUB_REF_NAME" dist/*.zip dist/*.sha256 --generate-notes`

The asset name is `bored-manager-<version>.zip` (the version inside `package.json`), with a matching `.sha256` file. Users' one-liner verifies that checksum when it is present. Settings → Check for updates look for the zip on `releases/latest`; if the repo has no release yet they fall back to the source zip of `main`.

## Installing

On a new Linux machine the bootstrap is one command (see the README). `install.sh` then, in order:

1. Refuse to run as root unless `BM_ALLOW_ROOT=1` (data would live in `/root`).
2. Require Node.js 20+, and `curl` or `wget`, and `unzip`.
3. Resolve the source: in-place (the script already sits in an app folder), a local `--source` zip, a zip URL, the latest GitHub release asset `bored-manager-*.zip`, or `codeload.github.com/.../main` if there is no release. A sibling `.sha256` file is checked when one is available.
4. Unpack, find the unique folder that contains `package.json` named `bored-manager`.
5. Copy into `--dir` (default `~/bored-manager`), keeping an existing `data/`.
6. `npm install --include=dev`, drop ssh2's optional native bindings, probe `node-pty` (delete it if it is broken), write a stub `tsconfig.test.json` if an older zip omitted it, `npm run build`.
7. Seed `data/user-settings/settings.json` from `DEFAULT_SETTINGS` via `scripts/seed-settings.ts` (`--port` / `--host` on a new file or when those flags are passed). An existing file that is the v0.3.4 stub (no `auth` object) is repaired; a healthy file is left alone; corrupt JSON is left untouched and the install fails.
8. Unless `--no-service`: install `~/.config/systemd/user/bored-manager.service` from `scripts/bored-manager.service` (`WorkingDirectory` / `ExecStart` rewritten to the install folder), `systemctl --user enable --now`, `loginctl enable-linger`. Fail the “started” claim if `http://127.0.0.1:<port>/` does not answer.
9. Print `http://127.0.0.1:<port>` and, when there is a usable private IPv4, a LAN URL.

`--repair` is steps 6 and 7, in the current folder — what `run.sh` and the in-app updater call. That is how a v0.3.4 install is healed on update.

`--refresh` stops the app, deletes the install folder except accounts / settings / UI config / `data/module-data/` / the secret key / known hosts, then copies the new tree, restores those files, rebuilds and starts the service. Custom modules, metrics, sessions and logs are discarded.

`--renew` is a factory reset: after a `YES` prompt (or `--yes` when there is no TTY) it removes the user unit and the whole folder, then installs from scratch.

Running `./install.sh` (or the one-liner) against an existing install is an in-place update: the running process is stopped first, `data/` is kept, `--port` / `--host` are only written when you pass those flags, and the service is restarted.

```bash
./install.sh --repair
./install.sh --refresh
./install.sh --renew --yes
```

The unit is a systemd **user** unit:

```ini
[Service]
Type=simple
WorkingDirectory=%DIR%
ExecStart=%DIR%/run.sh
Restart=on-failure
RestartSec=3
```

`run.sh` builds if sources are newer than `out/server/index.mjs`, then `exec node out/server/index.mjs`.

## Updating the app

Because the app is a source folder, updating means *replace the whole folder, reinstall dependencies, rebuild*. That cannot be done from inside a running process, so it is split in two: **the app (or `./bored-manager update`) downloads and checks**, **`scripts/update.sh` replaces and installs**.

```bash
./bored-manager update                  # latest release of settings.update.repo
./bored-manager update --source ./bored-manager-0.3.7.zip
```

### 1. Download and check

Settings → **Software update**, three sources:

| Source | How |
|---|---|
| Check for updates | `https://api.github.com/repos/<settings.update.repo>/releases/latest` (header `User-Agent: bored-manager`), compare `tag_name` (strip a leading `v`) with the running version; asset `bored-manager-<version>.zip`, or the default-branch source zip if there is no release |
| A zip URL | `https` only, GitHub hosts only (`github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`), path must look like a zip |
| A file | `POST /api/update/check-file` |

The download goes to the OS temp folder, not into the app folder — that folder is about to be moved. Archives are capped at 300 MB; the download times out after 15 minutes. Dev mode (`BM_DEV=1`) refuses to apply.

The archive is then unpacked and graded, **PASS** or **ERROR with a reason per check**:

| Check | Blocks the install when |
|---|---|
| Archive contains an app folder | no `package.json` at the archive root or in its single subfolder |
| `package.json` is readable | the file is corrupt / not JSON |
| It really is Bored Manager | the `name` field is not `bored-manager` |
| Valid version | not in `x.y.z` form |
| All core files present | any path in `REQUIRED_ENTRIES` (`server/services/updater.ts`) is missing |
| Toolchain to build present | the `vite` devDependency or the `build` script is missing |

Non-blocking warnings: the new version is not newer than the installed one (reinstalling or downgrading on purpose is allowed), and the new version has no `scripts/update.sh` (you would not be able to update from inside the app afterwards).

### 2. Replace and install

**Confirm & install update** → the server copies `scripts/update.sh` to temp, spawns it detached, and exits 500 ms later so the RPC reply can leave. One transaction:

1. `systemctl --user stop bored-manager` (ignored if there is no unit).
2. Wait for the app process to disappear (up to 2 minutes).
3. Rename **the whole app folder** to `<folder-name>.update-backup-<yyyymmdd-hhmmss>` next to it.
4. Copy the new version into the original path.
5. Restore from the backup: `data/connections.json` if still present (legacy), `data/user-settings/`, `data/users/`, `data/secret.key`, `data/module-data/`, `data/known-hosts.json`. Metrics history and logs are not kept.
6. Restore **custom modules** — every folder in the backup's `modules/` the new version does not ship.
7. `install.sh --repair`. If that fails **and** modules were restored, move them to `modules-disabled/` and build once more.
8. Write `data/update-result.json` (`ok`, `version`, `error`, `finishedAt`, `logPath`) and copy the log to `data/update.log`.
9. On success delete the backup and `systemctl --user start bored-manager` (or print how to run `./bored-manager start`). On failure **roll back** — delete the new copy and put the backup back exactly as it was.

Because the backup exists before anything is deleted, a failed update always ends with the old version in place.

The next start reads and deletes `data/update-result.json` and shows a notice. The script that runs is always the one from the **version that is currently installed**, copied out before quit — a change to what an update keeps only takes effect from the *next* update onwards.

### What is kept and what is lost

| Data | After the update |
|---|---|
| `data/users/` (accounts + per-user saved connections) | **kept** |
| `data/secret.key` | **kept** — otherwise saved passwords and the session cookie secret would not decrypt |
| `data/module-data/` | **kept** |
| `data/known-hosts.json` | **kept** |
| `data/user-settings/settings.json` | **kept and migrated** |
| `data/user-settings/modules.json` | **kept** |
| Modules that ship with the app | replaced by the new version's |
| **Custom modules** | **kept**, or quarantined in `modules-disabled/` if they do not build against the new version |
| `data/metrics/` | **deleted** |
| `data/*.log` | **deleted** (the update log is written fresh) |
| `node_modules/`, `out/` | reinstalled and rebuilt from scratch |

SSH passwords from a 0.0.1 desktop install cannot be decrypted (they used the old OS keystore). Hosts are migrated onto `bored-admin`; passwords have to be entered once more.

If the app reports an error after an update, see [MAINTENANCE.md](MAINTENANCE.md#when-an-update-reported-an-error).

### Recovering by hand

If the machine was switched off mid-update and a `<folder>.update-backup-<timestamp>` is still next to the app folder: if the current app works, delete that backup; if it is broken, delete the app folder and rename the backup back.

Installing by hand is always a way out: unpack the new zip over the app folder (keeping `data/`) and run `./install.sh --repair`.

## Distributing a module

A module is distributed separately from the app:

```bash
npm run modules:pack -- my-module     # scripts/my-module-1.0.0.zip
npm run modules:pack -- docs/examples/hello
```

Attach the zip to a GitHub release and either hand out the asset URL or open a PR to `registry/modules.json` (see [MODULE-RULESET.md](MODULE-RULESET.md#getting-into-the-catalog)). Users paste the URL into Settings → Modules, pick the file, or press Install on a catalog row.

## Uninstalling

```bash
./uninstall.sh                 # stop the user unit and any pidfile process; leave the folder
./uninstall.sh --purge         # also delete the folder (type YES)
./uninstall.sh --purge --yes   # same, no prompt
./bored-manager uninstall --purge --yes
```

Without `--purge`, delete the folder yourself. The app and all of its data — settings, accounts, logs, metrics history, modules — live inside that folder.
