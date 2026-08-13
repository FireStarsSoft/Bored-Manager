# Development

Getting the project running, and where to put a change.

## Setup

**Linux** (Ubuntu / Kali preferred) or **WSL2**, Node.js 20+. The target machine you connect to has to be Linux. The server is not supported outside Linux — use WSL2 if that is your desktop.

```bash
npm install --include=dev
```

`--include=dev` matters: with `NODE_ENV=production` in the environment npm skips devDependencies, and `tsx` / Vite / TypeScript are devDependencies.

Dev is **two terminals**:

```bash
npm run dev:server    # Express + ws on :8686 (tsx watch, BM_DEV=1)
npm run dev           # Vite renderer; proxies /ws and /api to :8686
```

Open the URL Vite prints (typically `http://localhost:5173`). The same `/api` and `/ws` paths work in production, where Express serves `out/renderer/` itself.

| Command | What |
|---|---|
| `npm run dev:server` | server with reload on `server/` / `shared/` changes |
| `npm run dev` | Vite renderer, hot reload |
| `npm run build` | production bundle: `out/renderer/` + `out/server/index.mjs` (runs `licenses.mjs` first) |
| `npm run start` | `node out/server/index.mjs` |
| `npm run typecheck` | `tsc --noEmit` for both halves; **includes module `main/`** |
| `npm run modules:lock` | regenerate `modules/modules.lock.json` |
| `npm run modules:verify` | fail if the lock is out of date |
| `npm run modules:pack -- <id-or-path>` | zip one module for distribution |
| `./run.sh` | production start: build if sources are newer, then exec the server |
| `./bored-manager start\|stop\|status\|unlock` | the installed-app launcher |

`BM_DEV=1` blocks installing an in-app **app** update (the folder is about to move). Putting a module folder in `modules/` and using Settings → Reload (or restarting `dev:server`) is how you iterate on one.

## Where things live

```
server/              Express + WebSocket RPC
  index.ts           listen, /ws, unlock, signals
  http.ts            static SPA, session, /api
  rpc.ts             the four frames, per-socket state
  ipc.ts             service instances, registerRpc, applyPollers
  connection.ts      the executor (local shell / SSH)
  auth.ts            login, lockout, session gate
  executors/         local.ts, ssh.ts, types.ts
  session-registry.ts
  services/          the app's own collectors and services
shared/              used by the server AND by modules
  types.ts           data types, settings schema, defaults
  modules.ts         module manifest + runtime contract
  module-ui.ts       UI spec: Block, DataSource, specProblems()
  shell.ts           splitSections, shQuote, PHYSICAL_DISK
  ss.ts              the ss command and its parser
src/                 renderer
  screens/           Login, Connect, Dashboard
  tabs/              Overview, Packages, Terminals, Settings
  modules/           BlockRenderer, binding, action-runner, blocks/*
  components/        StatCard, SectionCard, charts, ui/, ...
  lib/               api, ws-api, modules, module-bus, module-registry, history, utils
  state/store.ts     Zustand
modules/<id>/        one module (module.json, main/, ui/, README, CHANGELOG)
registry/            community catalog (modules.json)
docs/                this folder
scripts/             package.sh, update.sh, module tooling, licenses.mjs
```

## Which layer does a change belong to?

| You want to | Put it in |
|---|---|
| Add a whole feature with its own page | a **module** — see [MODULE-RULESET.md](MODULE-RULESET.md) |
| Add a metric to CPU/memory/network/disk totals | `server/services/metrics.ts` + `SystemSnapshot` |
| Add a card to the Overview from app data | `src/tabs/OverviewTab.tsx` + `CORE_WIDGETS` in `SettingsTab.tsx` |
| Add a card from module data | the module's `ui/widgets/<id>.json` and a `widgets` entry in `module.json` |
| Change how a chart looks | `src/components/charts.tsx` — both components, they share the constants |
| Add a setting | `AppSettings` + `DEFAULT_SETTINGS` in `shared/types.ts`, the merge in `server/services/store.ts`, and a control in `SettingsTab.tsx` |
| Add something a module's **main** half needs | `ModuleContext` in `shared/modules.ts` |
| Add a **block type** | see below |

## Adding a block type

The renderer only knows the types listed in `shared/module-ui.ts`. A new one is four stops, then the docs:

1. **Type + validator** — add the interface to the `Block` union, add it to `BLOCK_TYPES`, and handle it in `checkBlock()` / `specProblems()` in `shared/module-ui.ts`.
2. **Component** — `src/modules/blocks/<Name>Block.tsx`, same props shape as the others (`block` + `ctx: BlockCtx`).
3. **Register** — a `case` in `BlockView` inside `src/modules/BlockRenderer.tsx`.
4. **Document** — a section in [MODULE-RULESET.md](MODULE-RULESET.md) (props, a minimal JSON example, a full one).

Do not execute anything from the spec. Blocks only *declare* data sources and methods; `binding.ts` and `action-runner.tsx` are the only places that call them.

## Adding a setting

1. Add the field to `AppSettings` and to `DEFAULT_SETTINGS` in `shared/types.ts`.
2. Add it to `mergeSettings()` in `server/services/store.ts`. **Every field has to be listed there** — the merge builds a fresh object, which is what drops fields the current version does not know.
3. If it is a nested object, add it to the deep merge in `updateSettings()` in `src/state/store.ts`, or a patch will replace it wholesale instead of merging.
4. If the shape of an existing field changed, bump `SETTINGS_VERSION` and convert it in `mergeSettings()`.
5. Add the control to `src/tabs/SettingsTab.tsx`.
6. If it can influence a poller, make sure `applyPollers()` reacts — it already runs on every settings change.
7. Changing `server.port` / `server.host` only takes effect after a restart. Changing `auth.sessionIdle` only applies to **new** sessions.

## Adding a collector to the app

Only for something that belongs in the core (a metric that feeds the Overview from the `system` or `services` stream). Anything else should be a module.

1. Write the service in `server/services/`, taking an emit callback, exposing a `Poller` and a `reset()`.
2. Instantiate it in `ipc.ts` and wire the emit to a `push:*` channel.
3. Start and stop it in `applyPollers()`.
4. Reset it in `teardownSession()` and in `conn:connect`.
5. Add the channel to `Api` in `src/lib/api.ts` and to `src/lib/ws-api.ts`.
6. Subscribe in `src/state/store.ts` `init()`.

## Conventions

- **Comments explain why, not what.** A constraint, a trade-off, a reason a line looks odd — not a restatement of the code.
- **Degrade honestly.** When a probe finds nothing, say what is missing and why, rather than showing an empty table. `df` without `-T` support, no `lsblk`, no `nvidia-smi`, no sudo: each has a stated fallback and a message.
- **Never trust the target's output.** Every parser tolerates a missing column, a localised header and a truncated last line.
- **Quote and validate anything that reaches a command line.** `shQuote()` for strings, a strict pattern for ids.
- **One roundtrip per tick.** Add a section to the composite command instead of a second `exec`.
- **Clean up.** A poller, a stream or a terminal that is not released on close is a bug: it keeps running on someone else's machine.
- **No CDN.** Specs may not contain `http://` or `https://`. The UI loads nothing from a third-party host.

## Debugging

| Where | What |
|---|---|
| `data/app.log` | App lifecycle, written synchronously so it survives a crash. The last line tells you how far startup got. |
| `data/update.log` / `data/update-result.json` | The last in-app app update |
| `data/server.pid` | The running server, used by `./bored-manager status` |
| Browser DevTools | Renderer errors; `[BlockRenderer] ...` from a spec that threw |
| `journalctl --user -u bored-manager -e` | When running as the systemd user unit |

`./run.sh` rebuilds if `server/`, `shared/`, `src/`, `modules/` or the Vite configs are newer than `out/server/index.mjs`.

## Native addons

Two optional native pieces, neither required to start:

- **node-pty** is installed by `install.sh --repair` if it compiles, and deleted if it does not. Local terminals then use the `script` fallback. It is not loaded at startup.
- **ssh2's optional bindings** (`sshcrypto.node`, `cpu-features`) are deleted by `install.sh`, because any `npm install` can rebuild them for the wrong ABI. ssh2 falls back to pure JS.

Keep this in mind before adding a dependency with a native component.

## Before opening a change

```bash
npm run typecheck
npm run build
```

If you touched `modules/`, also `npm run modules:lock` and commit the lock file with the change. Then run it against a real target and check the specific thing you changed. [MAINTENANCE.md](MAINTENANCE.md) has the full release checklist.
