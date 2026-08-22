# Maintenance

Releasing a version, the schema versions that need care, reviewing a community module, and reading the logs when something goes wrong.

## Release checklist

1. **Version** — raise `version` in `package.json`. That single field drives the archive name, what the updater reports as installed, and the version comparison the updater shows.
2. **Module versions** — for each module you changed: raise its `version` in `module.json` and add a `CHANGELOG.md` entry. A module's version is independent of the app's.
3. **Schema versions** — if a settings field changed shape, bump `SETTINGS_VERSION` and convert it (see below). If a module entry point changed shape, bump `MODULE_API_VERSION`. If the catalog file changed shape, bump `registryVersion`.
4. **Docs** — update `README.MD` and whichever file in `docs/` describes what changed. Add an entry to `docs/CHANGELOGS.MD`.
5. **Required files** — if you added a file the app cannot boot without, add it to **both** lists below.
6. **Checks**:
   ```bash
   npm run typecheck         # server, renderer, and tests (tsconfig.test.json)
   npm test                  # unit + integration + protocol contract
   npm run check             # typecheck then test
   npm run build
   npm run modules:lock      # the packager does this too, but check it in
   npm run modules:verify
   npm run modules:specs
   npm run modules:compile
   ```
7. **Run it** against a real Linux target and walk the checklist below.
8. **Commit**, tag `vX.Y.Z` (the same numbers as `package.json`), **push the tag**. GitHub Actions packages the zip and attaches it to the release.
9. **Verify the workflow** produced `bored-manager-X.Y.Z.zip`, then **test the one-liner** on a clean machine (`curl … | bash`) and an in-app update from the previous version (settings, accounts, and any custom module must come across).

## What to test before releasing

Not exhaustive — the things that break quietly:

| Area | Check |
|---|---|
| First run | Delete `data/`, start: density is auto-detected, five built-in modules appear enabled, Container, Services, BMC and OpenWRT are disabled, no "files modified" badge |
| Auth off / on | With auth off, the UI is usable with no login. Enable it (after setting `bored-admin`'s password): `/api/*` is 401 until login; lockout after 5 failures; `./bored-manager unlock` clears it |
| Enable / disable | Toggle each module: its page and cards appear and disappear at once, and `data/app.log` shows no poller left behind |
| Reload | Edit a module file, press Reload: the new spec/main runs, no server restart |
| Install | Pack a module, install it from file, from a URL, and from the catalog: its widget appears, can be dragged, and its position survives a restart |
| Update a module | Install a higher, an equal and a lower version: info / warning / warning, and the confirmation dialog names the right one |
| Unverified module | A zip whose sha256 is not in the catalog: the "Unverified module" dialog; the same bytes as a catalog entry: `catalog-verified`, no extra dialog |
| Broken module | Install one that does not compile, or that imports `fs`: the compile check errors, the previous folder is restored |
| Integrity | Edit a file in a module folder, press Verify: "files modified" |
| App update with modules | Update over an install that has a custom module: the module is still there afterwards |
| Charts | 30s and 24h, on an Overview card and a detail page: axis labels are clear of the plot, the grid is visible in both directions |
| Sudo and no sudo | Connect without a sudo password: per-process network and disk figures degrade with a stated reason instead of showing nothing |
| Missing tools | A target with no `nvidia-smi`, no `docker`, no `lm-sensors`: each page says what is missing |
| Clean close | Stop the server while a container log stream and a terminal are open: nothing is left running on the target |
| Many clients | Two browsers: connect from A, B follows; a `tab` collector runs while either has the page open |

## Schema versions

Four numbers version an interface, and each has its own rule.

### `SETTINGS_VERSION` (`shared/types.ts`) — **7**

Bump when an existing field **changes shape**, not when one is added — a new field is filled from the defaults automatically.

The conversion goes in `normalizeAppSettings()` in `shared/app-settings.ts`:

- read the old field from the raw object (typed through a `LegacySettings` interface, not `any`);
- write the new shape;
- keep the old branch guarded by the version, so a file two versions old still converts.

`loadSettings()` rewrites the file immediately when the version on disk differs.

- v3 → v4 moved `lastUpdateUrl` to `update.lastUrl` and filled `server` / `auth` / `update`.
- v4 → v5 carried a pre-theme file over as dark (the only theme that build had).
- v5 → v6 renamed the Docker module's interval keys and Overview widget ids to `container`.
- v6 → v7 added `server.allowedHosts` (extra Host/Origin names) and `server.trustProxy` (trust forwarding headers from a loopback reverse proxy).

### `MODULE_API_VERSION` (`shared/modules.ts`) — **2**

Bump when the contract in `ModuleContext` or `ModuleMainInstance` changes in a way that breaks an existing module, **or** when the renderer half's shape changes (v2 replaced `entries.renderer` with `ui/*.json`). The app refuses any module whose `apiVersion` is not exactly this number, so a bump means **every module has to be updated and repackaged**, including the nine default ones.

Adding an optional member to `ModuleContext` is not a breaking change and does not need a bump.

### `registryVersion` (`shared/modules.ts`) — **1**

Version of `registry/modules.json`. A file the app does not speak is treated as an empty catalog, not as an error.

### `users.json` `version` — **1**

`data/users/users.json`. `read()` ignores a missing/invalid file and `write()` always emits `version: 1`. Bump only if that file's shape changes.

The module registry file (`data/user-settings/modules.json`) is normalised field-by-field with a fallback, so a missing or unexpected value degrades instead of throwing.

## Keeping the two required-file lists in step

The list of files a release cannot be missing appears twice on purpose — once where an archive is produced and once where one is accepted. Both constants are named `REQUIRED_ENTRIES`:

| Place | Role |
|---|---|
| `REQUIRED_ENTRIES` in `scripts/package.sh` | what the packager refuses to publish without (a **superset**: every built-in `module.json`, `registry/modules.json`, `docs/MODULE-RULESET.md`, `scripts/update.sh`, …) |
| `REQUIRED_ENTRIES` in `server/services/updater.ts` | what the in-app updater refuses to install without (the files needed to boot and rebuild) |

The packager's list must include everything the updater checks, or a zip built here can fail the in-app check. When you add a core file, add it to **both**.

## Reviewing a community module

Someone opens a pull request that adds one object to `registry/modules.json`. Before merge:

- [ ] `id` matches the module's `module.json`; `version` / `minAppVersion` / `download` / `sha256` / `verifiedAt` (`YYYY-MM-DD`) are filled.
- [ ] `sha256` is of **that exact zip** (`sha256sum` / `Get-FileHash`), not of the unpacked folder.
- [ ] `download` is a GitHub release asset, reachable without a login.
- [ ] The module installs on a current app: every installer check is `pass` or an accepted `warning` (missing docs is a warning — ask for README/CHANGELOG).
- [ ] `main/index.ts` only talks to the target through `ctx`; no `fs` / `child_process` / other modules / npm packages.
- [ ] Specs have no `http://` or `https://`. A URL in compiled main is a warning — read it, do not rubber-stamp.
- [ ] Destructive methods (`reboot`, `kill`, `rm`) are behind `confirm` (or `kind: "danger"`) in the spec.
- [ ] `dispose()` stops every poller and stream. `applyPollers()` is idempotent. `reset()` drops counters.
- [ ] The page degrades with a stated reason when the tool it needs is missing.

Then merge. The app picks the new catalog up within 24 hours, or immediately after Catalog → Refresh. Updating an entry (new reviewed version) is the same checklist with a new `sha256` and `verifiedAt`.

## Logs

| File | Contents |
|---|---|
| `data/app.log` | App lifecycle, written synchronously so it survives a crash. Keeps the history of every run, one separator with the pid per run. The first line prints the build timestamp — compare it to be sure which bundle is running. |
| `data/update.log` | The log of the last app update, copied in by `update.sh` |
| `data/update-result.json` | `{ ok, version, error, finishedAt, logPath }` — consumed once on the next start |
| `data/server.pid` | The running server |
| `journalctl --user -u bored-manager -e` | When the systemd user unit is registered |

Startup diagnosis: the last line of `app.log` tells you how far it got. `listening on http://…` means it is up. Look for `client N connected` and poller start/stop lines.

## Data the app writes

| Path | Kept across an app update |
|---|---|
| `data/users/` | yes |
| `data/secret.key` | yes |
| `data/user-settings/settings.json` | yes, migrated |
| `data/user-settings/modules.json` | yes |
| `data/module-data/` | yes |
| `data/known-hosts.json` | yes |
| `data/sessions/` | no (new sessions after restart) |
| `data/metrics/` | no |
| `data/*.log` | no |

The metrics folder is self-limiting: at every write, files older than the retention are deleted, and if the total exceeds the cap (200 MB by default) the oldest hours are dropped. Settings → Data & storage shows the exact figures and has *Write now* and *Clear history*.

## Recurring chores

| When | What |
|---|---|
| Every release | the checklist above |
| After touching `modules/` | `npm run modules:lock` |
| After changing a chart | check both `Sparkline` and `DetailChart` — they share the layout constants |
| After adding a dependency | check it has no native component (see the note in [DEVELOPMENT.md](DEVELOPMENT.md)); `licenses.mjs` picks it up for Settings → About on the next `build`/`dev` |
| After changing an RPC channel | update `Api` in `src/lib/api.ts` **and** `src/lib/ws-api.ts`; the first is the only type the renderer sees |
| After adding a core file | both `REQUIRED_ENTRIES` lists |

## When an update reported an error

The next start shows an error notice; the detail is in `data/update.log` and `data/update-result.json`. The common cases:

1. **"Could not move ... aside"** — a process still holds a file in the app folder. Close terminals pointing at it and try again. **Nothing has been changed** at this point.
2. **"install.sh --repair exited with code ..."** — installing dependencies or building failed (no network to npm, missing system libraries, out of disk space). The script already rolled back, so the old version is back; the end of `update.log` has what npm said.
3. **A `<folder-name>.update-backup-<timestamp>` folder is still next to the app folder** — that is the backup of the old version. Normally it is deleted on success or restored on rollback; if it is still there the machine was switched off mid-update. If the current app works, delete that folder; if it is broken or incomplete, delete the app folder and rename the backup back.
4. **Modules listed as quarantined** — they are in `modules-disabled/`. Update each for the new app version and install its zip from Settings → Modules.

Installing by hand is always a way out: unpack the new zip over the app folder (keeping `data/`) and run `./install.sh --repair`.

## Unlock and forgotten passwords

**Lockout** (HTTP 423 after too many wrong passwords): on the host,

```bash
./bored-manager unlock
# same thing:
node out/server/index.mjs unlock
```

That clears `data/auth-lock.json`. Failures are counted per username and per client address; unlock wipes every counter. The server reads the file on every login attempt, so this takes effect immediately.

**Forgotten `bored-admin` password:** there is no reset in the UI on purpose. On the host, set `auth.enabled` to `false` in `data/user-settings/settings.json`, restart, open Settings → Server & users, set a new password, then turn auth back on. (With auth off you are `bored-admin` without logging in.)
