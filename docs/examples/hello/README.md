# Hello (example module)

A complete, working v2 module, small enough to read in one sitting. Copy it as the starting point for your own; [../../MODULE-RULESET.md](../../MODULE-RULESET.md) is the reference for everything it does.

## What it adds

| Where | What |
|---|---|
| Sidebar | **Hello** page — uptime chart |
| Sidebar | **Details** page — hostname/kernel/uptime/logged-in users, and a confirm-gated **Reboot target machine** button |
| Overview | **Hello** widget (on by default) — uptime, kernel and logged-in users |
| History | writes the `hello` metrics stream (uptime in seconds) |

## What it runs on the target

One command per tick, four probes in one roundtrip:

```sh
cat /proc/uptime
uname -r
hostname
who | wc -l
```

Plus `systemctl reboot` (elevated) when you confirm **Reboot target machine** on the Details page. No sudo needed for anything else, nothing installed.

## What it demonstrates

| Feature | Where to look |
|---|---|
| Batching probes into one command with `===NAME===` markers | `main/index.ts` → `PROBE` |
| A poller whose interval follows a settings key | `main/index.ts` → `applyPollers` |
| Pushing a snapshot, and a slimmer point for charts, to the declarative UI | `ctx.emit('snapshot', ...)` / `ctx.emit('series', ...)` |
| Formatting a value the block system's `format` enum cannot (a duration) before it ever reaches the UI | `main/index.ts` → `uptimeLabel` |
| Writing a metrics history stream | `ctx.addHistory(...)` |
| A confirm-gated action | `ctx.handle('reboot', ...)` and `ui/pages/details.json` → `actions` |
| Filling a freshly connected renderer (`latest` + `series`) | `snapshots()` |
| Releasing everything on disable / close | `dispose()` |
| Declaring two pages and a widget | `module.json` → `pages` / `widgets` |
| A page built from blocks instead of React: stat + spark + chart | `ui/pages/main.json` |
| A page mixing a read-only summary with a destructive action | `ui/pages/details.json` |
| An Overview card built from blocks | `ui/widgets/summary.json` |

## Trying it

Two ways.

**In dev mode** — copy the folder into `modules/` and `npm run dev` picks it up (compiled at runtime, no rebuild):

```bash
cp -r docs/examples/hello modules/hello
```

**As a real install** — pack it and install it the way a user would:

```bash
npm run modules:pack -- docs/examples/hello
# -> scripts/hello-2.0.0.zip
```

Then Settings → Modules → **From file**, pick the zip, read the checks, install. It runs immediately - no rebuild, no restart.

To remove it again: Settings → Modules → Uninstall, or delete `modules/hello/`.

## Renaming it for your own module

1. Pick an id: lowercase, dashes allowed, not one of the names the app reserves.
2. Rename the folder to that id and set `id` in `module.json` to match — the two have to be equal.
3. Replace the `'hello'` string literals that show up in comments/log lines of `main/index.ts` (the module id itself comes from the folder/`module.json`, nothing in the code hardcodes it).
4. Update `name`, `description`, `author`, and the `pages`/`widgets`/`streams`/`methods` entries in `module.json` to match what your module actually declares.
5. Reset `version` to `1.0.0` and start your own `CHANGELOG.md`.
6. `npm run typecheck` — module code is typechecked with the app, so a mistake shows up before you install anything.
