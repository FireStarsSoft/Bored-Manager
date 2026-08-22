# Module rule set

Everything a module has to satisfy to be installable, and everything it is allowed to use. This is the reference for writing one; [MODULES.md](MODULES.md) describes how the app manages them once installed. Copy [examples/hello/](examples/hello/) as a starting point.

## The short version

A module is a folder of **data + JSON**. It does not ship React. The app compiles `main/index.ts` with esbuild the first time it activates, and renders `ui/*.json` itself.

```
my-module/
  module.json              required — the manifest (apiVersion 2)
  README.md                what it does (a warning if missing)
  CHANGELOG.md             what changed per version (a warning if missing)
  main/index.ts            collectors and actions (required)
  ui/pages/<pageId>.json   one file per entry in manifest.pages
  ui/widgets/<id>.json     one file per entry in manifest.widgets
```

`.dist/main.mjs` is created by the app. Do not ship it; integrity hashing skips it.

Zip it so the folder itself is the single top-level entry, then install it from Settings → Modules. `npm run modules:pack -- my-module` does that for you.

## `module.json`

Checked by `manifestProblems()` in `shared/modules.ts`. `apiVersion` must be **2**.

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiVersion` | number | yes | Must be `2`. Anything else is refused. |
| `id` | string | yes | `/^[a-z][a-z0-9-]{1,31}$/` (2–32 characters). **Must equal the folder name** when you pack. Doubles as the RPC prefix, the default history stream, and the prefix of every card id (`<id>.<widgetId>`). |
| `name` | string | yes | Shown in the sidebar and in Settings. |
| `version` | string | yes | Exactly `x.y.z`. Independent of the app's version. |
| `description` | string | yes | One sentence, shown in Settings → Modules. |
| `author` | string | yes | Free text. |
| `minAppVersion` | string | no | `x.y.z`. Installing on an older app is an **error**, not a warning. |
| `defaultEnabled` | boolean | no | Whether the module is enabled on first install. Defaults to `true`. Set `false` for optional modules (Docker). |
| `entries.main` | path | yes | Relative path to the main half, e.g. `main/index.ts`. Must exist. Must stay inside the module folder (no `..`, no absolute, no `\`). |
| `entries.renderer` | — | **forbidden** | API v1. Presence is an error: put the UI in `ui/pages/*.json` and `ui/widgets/*.json`. |
| `pages` | array | no | Sidebar pages. Omit for a widgets-only module. ≥2 pages become a dropdown. |
| `pages[].id` | string | yes | `/^[a-z][a-z0-9-]{0,31}$/` (1–32). Unique within the module. Route is `<moduleId>/<id>`. File must exist at `ui/pages/<id>.json`. |
| `pages[].label` | string | yes | Sidebar label. |
| `pages[].icon` | string | no | A lucide-react name from the whitelist below. Unknown names render as `Puzzle`. |
| `pages[].order` | number | no | Sort key among this module's pages, and among sidebar entries when there is only one page. The app's own pages sit at 0 (Overview), 70 (Packages), 80 (Terminals), 90 (Settings); the default modules use 10–66 (Services holds 33–38). |
| `widgets` | array | no | Overview cards. |
| `widgets[].id` | string | yes | Same id rules as a page. Settings/layout key is `<moduleId>.<id>`. File must exist at `ui/widgets/<id>.json`. |
| `widgets[].label` | string | yes | Name in Settings → Overview cards. |
| `widgets[].defaultEnabled` | boolean | no | Shown unless the user turns it off. Default `false`. |
| `widgets[].order` | number | no | Position among the cards before the user drags anything. Core cards use 1–7 and 10–50. |
| `streams` | array | no | Snapshot channels `ctx.emit`s. A `{ kind: "stream" }` source may only name one of these. |
| `streams[].event` | string | yes | Event name. |
| `streams[].kind` | `"series"` \| `"latest"` | yes | `series` keeps a 5-minute ring keyed by `t`; `latest` keeps one value. Use `latest` for a big table snapshot and a slim `series` for charts — a block cannot pick `.at(-1)` off a series itself. |
| `methods` | string[] | no | Names registered with `ctx.handle`, callable from a spec. |
| `fastInterval` | string | no | Key in `settings.refresh` this module reads (`ctx.fastIntervalMs`). |
| `slowInterval` | string | no | Key in `settings.slowRefresh` this module reads (`ctx.slowIntervalSec`). |

Ids the app uses for itself and will not accept: `overview`, `packages`, `terminals`, `settings`, `core`, `app`, `module`, `modules`, `system`, `top`, `services`, `metrics`. The last three are there because the id is also a history stream name — a module called `top` would append to the Overview's own history just by doing what every module does.

### Icon whitelist

`src/lib/module-registry.ts` maps these lucide-react names (anything else becomes `Puzzle`):

`Activity`, `Boxes`, `Cable`, `Container`, `Cpu`, `FileText`, `FolderTree`, `Gauge`, `HardDrive`, `Info`, `Layers`, `ListTree`, `Network`, `Server`, `Settings2`, `Sparkles`, `Tag`, `Thermometer`, `Zap`.

Adding a new name means adding it to that map in the **app**, then bumping `minAppVersion` if you rely on it.

## `main/index.ts`

Default-export an `activate` function. It is called when the module is switched on, and everything it returns is optional except `dispose`.

```ts
import type { ModuleActivate } from '@shared/modules'
import { splitSections } from '@shared/shell'

const activate: ModuleActivate = (ctx) => {
  const poller = ctx.createPoller('sample', async () => {
    if (!ctx.connected) return
    const res = await ctx.exec(`echo '===UP==='; cat /proc/uptime`, { timeoutMs: 10000 })
    if (res.code !== 0 && !res.stdout) return
    const sections = splitSections(res.stdout)
    const seconds = parseFloat((sections.get('UP') ?? '0').trim().split(/\s+/)[0]) || 0
    ctx.emit('snapshot', { t: Date.now(), seconds, uptimeLabel: `${Math.floor(seconds / 3600)}h` })
    ctx.emit('series', { t: Date.now(), uptime: seconds / 3600 })
    ctx.addHistory({ t: Date.now(), uptime: Math.round(seconds) })
  })

  ctx.handle('reboot', () => ctx.execSudo('systemctl reboot'))

  return {
    applyPollers() {
      const interval = ctx.fastIntervalMs('system')
      if (ctx.connected && interval > 0) poller.start(interval)
      else poller.stop()
    },
    reset() {
      /* drop per-session state: rate baselines, session totals, caches */
    },
    snapshots() {
      return { snapshot: latest, series: history }
    },
    dispose() {
      poller.stop()
    }
  }
}

export default activate
```

The worked original of this is [examples/hello/main/index.ts](examples/hello/main/index.ts).

### What `ctx` offers

`ModuleContext` in `shared/modules.ts` — this table is that interface.

| Member | Purpose |
|---|---|
| `id` | The module's own id. |
| `exec(cmd, opts?)` | Run a command on the target machine (local shell or SSH). `opts`: `stdin`, `timeoutMs`. |
| `execSudo(cmd, opts?)` | Same, elevated when a sudo password was given; plain `sudo -n` otherwise. |
| `stream(cmd)` / `streamSudo(cmd)` | A command that keeps running, with output arriving as it comes. |
| `connected` | Whether a target machine is connected. Check it at the top of every tick. |
| `hasSudo` | Whether commands can be elevated. |
| `createPoller(name, tick)` | A repeating job. Ticks never overlap; the app stops it on a clean close. Name it `'<id>:something'` so the services tracker attributes it to this module. |
| `fastIntervalMs(key)` | Interval in ms for a `settings.refresh` key; `0` means the user paused it. |
| `slowIntervalSec(key)` | Interval in seconds for a `settings.slowRefresh` key; `0` means manual only. |
| `detailMode(key)` | `'tab' \| 'always' \| 'off'` for a `settings.detailPolling` key. |
| `tabActive` | Whether **any client** is looking at one of this module's pages (`<id>` or `<id>/<page>`). |
| `emit(event, payload)` | Push data to the renderer under this event name (must match a declared stream if a block will `kind: "stream"` it; a `log` block's event does not have to be declared). |
| `handle(method, fn)` | Answer a call from a block. `method` **must** be in `manifest.methods` — registering anything else throws and the module fails to activate. |
| `addHistory(point, stream?)` | Append a reduced sample `{ t, ...numbers }` to this module's metrics stream on disk. Default stream name = the module id; an explicit one must be `<id>` or `<id>-<name>`, and anything else throws. |
| `configGet()` / `configSet(value)` | This module's own settings, one JSON document, shared by every target machine. `configGet()` is `null` until something is written. Stored in `data/user-settings/module-config/<id>.json`, which an app update carries over — so a rule the user changed survives reinstalling the module. Over 512 KB throws. |
| `hostDataGet()` / `hostDataSet(value)` | What this module remembers about the machine **currently connected** — tags it invented, job history, saved forms. `hostDataGet()` is `null` while disconnected and `hostDataSet` does nothing then, so both callers have to cope with "no host". Stored in `data/module-data/<id>/<hostKey>.json`, keyed the same way the metrics history is. Same 512 KB cap. |
| `hostKey` | Which machine those two are pointed at, or `null` while disconnected. |
| `isModuleEnabled(id)` | Whether another module is running, for an optional probe. Do **not** import that module's files. |
| `log(message)` | Write to the app log. |

`ctx` is **revoked** when the module stops — switched off, reloaded, uninstalled, or on a clean close. From that moment every member above throws `module "<id>" is no longer running`. A stray `setTimeout` or an unresolved promise holding a reference to it therefore cannot keep running commands, and cannot write back the config file that uninstalling just deleted. `dispose()` runs *before* the revocation, so it is the one place you can still use `ctx` to shut something down politely.

Neither store is a cache. Read them into memory once and write when something changes; a `hostDataSet` per poll tick will write a file per second.

Anything a module remembers about a machine belongs in `hostData`, not on the machine. Writing on the target needs somewhere writable there plus, half the time, sudo — and the data is the app's bookkeeping, not the machine's.

### What the returned instance means

`ModuleMainInstance` — only `dispose` is required.

| Member | Called when |
|---|---|
| `applyPollers()` | On connect, on disconnect, on every settings change and when the visible tab changes. **Must be idempotent** — derive the intervals from `ctx` again and start/stop accordingly. |
| `reset()` | On connect and disconnect. Drop rate baselines and session totals; a counter from another machine is worse than no counter. |
| `snapshots()` | Right after a connection is established, to fill a freshly opened renderer. Keys must match the event names in `streams`. |
| `slowTargets()` / `refreshSlow(target)` | When the user presses a refresh button on a slow section this module owns (`section.slowTarget`). Targets are a flat namespace shared with the app's own sections: if two running modules claim the same one, the first still answers and the clash is logged. Name yours after the module unless you mean the app's. |
| `dispose()` | When the module is switched off, reloaded, and on a clean close. Stop every poller, kill every stream. |

Anything `dispose()` misses, the app takes back: it stops every poller `createPoller` handed out and kills every command `stream` started, and logs how many it had to. Write `dispose()` as if that backstop were not there — it exists so a module that throws on the way out cannot leave a timer polling a machine the user disconnected from, not to save you the line.

## What a module may import

The main half is bundled with a resolver that **denies** anything else. The installer trial-compiles before writing to `modules/`, so a bad import is an error in the check panel, not a surprise after install.

| Allowed | What for |
|---|---|
| `@shared/modules` | The manifest and runtime contract types. |
| `@shared/types` | The app's data types (`SystemSnapshot`, `OkResult`, …). |
| `@shared/shell` | `splitSections`, `shQuote`, `PHYSICAL_DISK`. |
| `@shared/ss` | The `ss` command and its parser. |
| `@shared/check` | `ModuleCheckReport`, `ModuleCheckFinding` and `createCheckSession()` — what a `checkForm` block talks to. |
| `@shared/cache` | `createTtlCache()` for coalescing duplicate read-only RPC probes and briefly reusing successful results. Never cache an action. |
| `@shared/module-ui` | The Block types, `FormFieldOption`, and `FORM_COLOR_SWATCHES` when a method picks a colour on the user's behalf. The main half does not render. |
| Relative imports inside **this** module | Split `main/` into files. |
| Relative imports inside `shared/` | Only from a file that already lives in `shared/` (you will not write those). |

**Not allowed**, and the compile fails:

| Forbidden | Why |
|---|---|
| `fs`, `child_process`, any Node builtin | Talk to the target through `ctx`. |
| `express`, `react`, any npm package | The archive is only source; nothing installs packages for it. |
| `server/…`, `src/…`, `@/…` | A module never reaches into the app. |
| Another module's files | A module has to work when the other one is uninstalled. Read its data off the bus by stream name and use `ctx.isModuleEnabled(id)` for a soft dependency. |

The renderer half **has no imports**. It is JSON.

## The boundary around a module

The import rules above are the compile-time half. This is the runtime half: what a module can reach while it is running, and what the app takes back when it stops. Everything in the first table is checked by the app, not left to the module — a module that crosses one of these lines gets an exception or fails to activate, rather than quietly affecting somebody else.

| Boundary | How it is enforced |
|---|---|
| Its own RPC channels | `ctx.handle` can only register `module:<id>:invoke:<method>`, and only for a `method` the manifest declares. |
| Its own events | `ctx.emit` can only push `module:<id>:event:<event>`. The renderer stores an event only if it is a declared stream. |
| Its own history | `ctx.addHistory` accepts `<id>` and `<id>-<name>`; `system`, `top`, `services` and another module's id all throw. A `{ "kind": "history" }` source may read its own streams or the app's three, never a third module's. |
| Its own config and per-host data | `configGet/Set` and `hostDataGet/Set` are bound to `<id>`; there is no call that names another module's file. Both are capped at 512 KB. |
| Its own folder | The installer compiles with a resolver that refuses anything outside the module folder and `shared/`. Nothing writes outside `modules/<id>/`, and a path that tries to escape it is refused rather than normalised. |
| Its pollers and streams | Handed out by `ctx`, tracked by the app, force-stopped when the module deactivates. |
| Its lifetime | `ctx` is revoked on deactivate; every member throws afterwards. |
| Its rendering | Every block, every page and every Overview card is wrapped in an error boundary, so a throw shows an inline message where that block was instead of blanking the app. |

Three things are **shared on purpose**, and a module has to behave rather than be stopped:

- **The connection.** `exec`, `execSudo` and the streams all run through the one session the user opened. A tight poller or a command with no `timeoutMs` costs everybody — including the app's own collectors. Check `ctx.connected` at the top of every tick and always pass a timeout.
- **The interval keys.** `fastInterval` / `slowInterval` name keys in the app's `settings.refresh` and `settings.slowRefresh`, which is a flat namespace. Use your module's id as the key unless you deliberately mean to follow an existing one.
- **The terminal pool.** A `terminal` block opens a PTY on the server, the same kind the Terminals page opens, and it **outlives the module**: disabling or uninstalling does not close a shell the user opened from your page. That is deliberate (nobody wants their session killed because a card was toggled), but it means a `commandTemplate` should be something a user would recognise on the Terminals page.

What lives outside the module and survives uninstalling it: its keys in the app's `settings.json` (`refresh.<id>`, `overviewWidgets`, `overviewLayout`) and its metrics history under `data/metrics/`. That is so reinstalling puts the cards back where they were; see [MODULES.md](MODULES.md#what-uninstalling-removes) for the full list.

## UI specs

`ui/pages/<pageId>.json` and `ui/widgets/<widgetId>.json` share a shape: `{ "blocks": Block[] }`. A widget may also set `window` (seconds of history its charts show).

Checked by `specProblems()` in `shared/module-ui.ts`: every `type` is known, every `source` / method points at something the manifest declares, and **no string anywhere contains `http://` or `https://`**.

### Widget fallbacks

- **`window` omitted** — the widget uses the Overview's history window (`overviewWindow` in settings), not a page's window picker.
- **Chart `window` omitted** — the chart uses the page/widget window above. Default live buffer is 60s if nothing else applies.
- **How often the numbers move** — the module's own poller, driven by `fastInterval` / `slowInterval` in the manifest. An `invoke` source with `intervalKey` re-calls the method at that `settings.refresh` speed **while the block is visible**; omit `intervalKey` to call once when it appears.
- **Drag handle** — the app draws it on every Overview widget. Do not add one in the spec.

### `path`

A dot-path into the resolved value (`"mem.used"`, `"gpus.0.temp"`). Arrays are indexable. Applied by the binding resolver. Omit it when the source already *is* the value (a chart series, a table array).

Inside `rowDetail` (and anywhere a table has opened a row), a path or arg starting with `$row.` reads from **that row**, not from the source:

```json
{ "kind": "invoke", "method": "inspect", "args": ["$row.id"] }
```

### `DataSource`

Every block that shows data has a `source`. Four kinds:

```jsonc
{ "kind": "stream", "event": "snapshot", "path": "cpu.total" }
{ "kind": "invoke", "method": "list", "args": [], "intervalKey": "processes", "path": "items" }
{ "kind": "history", "stream": "hello", "keys": ["uptime"] }
{ "kind": "core", "stream": "system", "path": "mem.used" }
```

| `kind` | Reads | Notes |
|---|---|---|
| `stream` | A declared `manifest.streams` event | `series` vs `latest` as declared. Unknown `event` → installer error. |
| `invoke` | A declared `manifest.methods` name | Re-polls while visible if `intervalKey` is set. `args` may contain `$row.…`. |
| `history` | Downsampled points from `data/metrics/` | `stream` is one of **your own** (`<id>`, `<id>-<name>`) or one of the app's (`system`, `top`, `services`). Another module's is an installer error — it can be uninstalled, and a chart of something the user removed is not a dependency worth having. `keys` names the numeric fields. For ranges longer than the live buffer. |
| `core` | The app's own snapshot | `stream` must be `"system"`, `"top"`, or `"services"`. |

### `ValueFormat`

How a raw value is printed. Maps 1–1 to the helpers in `src/lib/utils.ts`.

| Format | Input | Output |
|---|---|---|
| `bytes` | number of bytes | `1.2 GiB` |
| `rate` | bytes per second | `12.3 MiB/s` |
| `pct` | 0–100 (or 0–1 is **not** auto-scaled — send percent) | `37%` |
| `temp` | °C | `64°C` |
| `number` | a count | grouped digits |
| `text` | anything | `String(value)` |
| `duration` | an absolute `startedAt`-style **ms timestamp** | elapsed `"3h 4m"` — the block cannot compute `Date.now() - value` itself |
| `badges` | `Array<{ label: string, color?: string }>` | coloured chips. Only useful in `table`, `list` and `keyValue`, which render cells rather than one string. `color` is any CSS colour, and it is the one place literal hex belongs — a colour the user picked is data and has to survive a theme switch. Filtering and sorting use the labels joined. |
| omit | — | `text` |

If you need a duration from **elapsed seconds** (uptime), format it in `main/` and send a string with `"format": "text"`. That is what hello does (`uptimeLabel`).

### `ActionSpec`

A button that calls one of `manifest.methods`. Used by `actions`, `table.rowActions`, and `form.submit`.

| Field | Meaning |
|---|---|
| `label` | Button text. |
| `method` | Must be in `manifest.methods`. |
| `argsFromRow` | Row/scope keys, **first** in the call (`kill(pid, …)`, `containerAction(id, …)`). |
| `args` | Literal args, after `argsFromRow` and before prompt/form values. May contain `$row.…`. |
| `confirm` | Question shown before the call. |
| `kind` | `"default"` \| `"danger"` — styles the button and the confirm dialog. |
| `prompt` | `{ label, input: "number" \| "text", initialKey? }` — one extra value, appended last. If both `prompt` and `confirm` are set, the prompt **is** the confirmation (no second dialog). |

Call order: `[...argsFromRow, ...args, promptOrFormValues]`.

Methods should return `{ ok: true }` or `{ ok: false, error: string }` (or throw). The UI treats `ok: false` as a failure and shows `error`.

## Block types

Every block is `{ "type": "…", … }`. Unknown `type` → installer error. A block that throws at runtime is isolated (the rest of the page still draws).

### `section`

A card with an optional title, an optional slow-refresh control, and nested blocks.

| Prop | Type | Required |
|---|---|---|
| `title` | string | no |
| `columns` | 1–4 | no — default 1. 2/3/4 become a responsive grid. |
| `slowTarget` | string | no — shows a refresh button wired to `metrics:refreshSlow` for this name; the module must implement `slowTargets` / `refreshSlow`. |
| `blocks` | Block[] | yes |

Minimal:

```json
{ "type": "section", "title": "Hello", "blocks": [] }
```

Full (hello's details page wraps a keyValue; disk filesystems adds a slow target):

```json
{
  "type": "section",
  "title": "File systems",
  "slowTarget": "storage",
  "columns": 1,
  "blocks": [
    {
      "type": "table",
      "source": { "kind": "stream", "event": "storage", "path": "filesystems" },
      "columns": [{ "key": "mount", "label": "Mount" }]
    }
  ]
}
```

### `subnav`

An in-page sidebar with one block list per item. All items stay mounted so their local UI state is preserved, but invoke polling is disabled for every hidden item. Below the `md` breakpoint, the sidebar becomes a horizontally scrolling row above the content.

| Prop | Type | Required |
|---|---|---|
| `items` | `{ id, label, icon?, blocks }[]` | yes — 1–32 items |
| `items[].id` | string | yes — `/^[a-z][a-z0-9-]{0,31}$/`, unique within this subnav |
| `items[].label` | string | yes |
| `items[].icon` | string | no — a name from the module icon whitelist |
| `items[].blocks` | Block[] | yes |
| `initial` | string | no — item id selected on first render; defaults to the first item |

Minimal:

```json
{
  "type": "subnav",
  "items": [
    {
      "id": "overview",
      "label": "Overview",
      "blocks": [{ "type": "note", "lines": ["Choose an operation from this page."] }]
    }
  ]
}
```

Full:

```json
{
  "type": "subnav",
  "initial": "jobs",
  "items": [
    {
      "id": "automation",
      "label": "Automation",
      "icon": "Zap",
      "blocks": [
        { "type": "note", "title": "Before you start", "lines": ["Check the target first."] }
      ]
    },
    {
      "id": "jobs",
      "label": "Jobs",
      "icon": "ListTree",
      "blocks": [{ "type": "section", "title": "Recent jobs", "blocks": [] }]
    }
  ]
}
```

### `note`

Static guidance or an operational warning. It has no data source.

| Prop | Type | Required |
|---|---|---|
| `title` | string | no |
| `lines` | string[] | yes — 1–32 non-empty short paragraphs |
| `tone` | `"info"` \| `"warning"` | no — default `"info"` |

Minimal:

```json
{ "type": "note", "lines": ["Values are checked before they are applied."] }
```

Full:

```json
{
  "type": "note",
  "title": "Connectivity warning",
  "tone": "warning",
  "lines": [
    "Stopping this rule can interrupt connected clients.",
    "Run a fresh check before applying it again."
  ]
}
```

### `stat`

A labelled value, optionally with a sparkline.

| Prop | Type | Required |
|---|---|---|
| `label` | string | yes |
| `source` | DataSource | yes |
| `format` | ValueFormat | yes (validator only errors if the value is *present and unknown*; still set it) |
| `spark` | `{ source, key }` | no — `key` is the field inside each spark point |

Minimal:

```json
{
  "type": "stat",
  "label": "Uptime",
  "source": { "kind": "stream", "event": "snapshot", "path": "uptimeLabel" },
  "format": "text"
}
```

Full:

```json
{
  "type": "stat",
  "label": "Uptime",
  "source": { "kind": "stream", "event": "snapshot", "path": "uptimeLabel" },
  "format": "text",
  "spark": { "source": { "kind": "stream", "event": "series" }, "key": "uptime" }
}
```

### `meter`

A labelled bar. `max` defaults to **100**. The bar is `value / max`.

| Prop | Type | Required |
|---|---|---|
| `label` | string | yes |
| `source` | DataSource | yes |
| `format` | ValueFormat | no |
| `max` | number | no |

Minimal:

```json
{
  "type": "meter",
  "label": "CPU",
  "source": { "kind": "core", "stream": "system", "path": "cpu.total" },
  "format": "pct"
}
```

Full:

```json
{
  "type": "meter",
  "label": "Memory",
  "source": { "kind": "core", "stream": "system", "path": "mem.used" },
  "format": "bytes",
  "max": 17179869184
}
```

### `chart`

A line, area or bar chart.

| Prop | Type | Required |
|---|---|---|
| `title` | string | no |
| `kind` | `"line"` \| `"area"` \| `"bar"` | yes |
| `source` | DataSource | yes — should resolve to an array of `{ t, … }` |
| `series` | `{ key, label, unit?, axis?, format?, color? }[]` | no — omit to take every numeric key on the last point except `t` (for a set of series the machine decides, e.g. sensors). If present it must be non-empty. `unit` on a series is a literal suffix when there is no `format` (e.g. `"RPM"`). `axis` is `"left"` (default) or `"right"` — a right series adds a second Y-axis. `format` on a series overrides the chart-level `format` for that series' axis and tooltip. `color` is a chart token (`gpu`, `warning`, …); omit to take the next palette swatch. `stacked: true` cannot be used with a right axis. |
| `maxSeries` | number | no — cap when inferring series from keys. Ignored when `series` is declared. |
| `unit` | string | no — chart-level suffix when series are inferred (there is then no per-series `unit`). Ignored when `format` is set. |
| `decimals` | number | no — decimal places for the unit suffix or a raw number. Ignored when `format` is set. Default `0`. |
| `format` | ValueFormat | no |
| `stacked` | boolean | no |
| `window` | number (seconds) | no — see widget fallbacks |

Minimal (declared series):

```json
{
  "type": "chart",
  "kind": "area",
  "source": { "kind": "stream", "event": "series" },
  "series": [{ "key": "uptime", "label": "Uptime", "unit": "h" }]
}
```

Inferred series (keys come from the data):

```json
{
  "type": "chart",
  "title": "Temperature",
  "kind": "area",
  "source": { "kind": "stream", "event": "temps" },
  "format": "temp",
  "maxSeries": 8
}
```

Full:

```json
{
  "type": "chart",
  "title": "Uptime (hours, last 5 minutes)",
  "kind": "area",
  "source": { "kind": "stream", "event": "series" },
  "series": [{ "key": "uptime", "label": "Uptime", "unit": "h" }],
  "window": 300
}
```

Dual-axis (two units on one plot):

```json
{
  "type": "chart",
  "title": "Utilisation & temperature",
  "kind": "area",
  "source": { "kind": "stream", "event": "series" },
  "series": [
    { "key": "util", "label": "Utilisation", "format": "pct", "axis": "left", "color": "gpu" },
    { "key": "temp", "label": "Temperature", "format": "temp", "axis": "right", "color": "warning" }
  ]
}
```

A window longer than the live buffer should use `"kind": "history"` so old points come off disk.

### `pie`

A donut (part-of-whole snapshot). Not a `chart` kind: those are time series of `{ t, … }`. The source must resolve to one object; each slice names a numeric key on it. Colours come from `status` (`ok` / `warn` / `bad` / `unknown`) — the same tokens as `statusCards` — so a spec cannot pick a paint colour.

| Prop | Type | Required |
|---|---|---|
| `source` | DataSource | yes — an object of numeric fields |
| `slices` | `{ key, label, status }[]` | yes, non-empty. `status` is `"ok"` \| `"warn"` \| `"bad"` \| `"unknown"`. |
| `center` | `{ key, label? }` | no — number in the hole. Omit to sum the slices. `label` is the caption under that number. |
| `emptyText` | string | no — shown when the object is missing or the centre is 0 |
| `format` | ValueFormat | no — defaults to `number` |

Zero slices still appear in the legend (so a missing colour means "none of these"). A widget draws a compact donut; a page draws a larger one.

Minimal:

```json
{
  "type": "pie",
  "source": { "kind": "stream", "event": "hosts", "path": "counts" },
  "slices": [
    { "key": "online", "label": "Normal", "status": "ok" },
    { "key": "offline", "label": "Error", "status": "bad" }
  ]
}
```

Full (the Services module's Overview card):

```json
{
  "type": "pie",
  "source": { "kind": "stream", "event": "hosts", "path": "counts" },
  "center": { "key": "total", "label": "Machines" },
  "emptyText": "No machines watched yet",
  "slices": [
    { "key": "online", "label": "Normal", "status": "ok" },
    { "key": "degraded", "label": "Warning", "status": "warn" },
    { "key": "offline", "label": "Error", "status": "bad" },
    { "key": "unknown", "label": "Unknown", "status": "unknown" }
  ]
}
```

### `keyValue`

A fixed label/value list from one resolved object.

| Prop | Type | Required |
|---|---|---|
| `source` | DataSource | yes |
| `rows` | `{ key, label, format? }[]` | yes. `key` is a path into the object (`"health.status"` is fine). |

Minimal:

```json
{
  "type": "keyValue",
  "source": { "kind": "stream", "event": "snapshot" },
  "rows": [{ "key": "hostname", "label": "Hostname" }]
}
```

Full (hello details):

```json
{
  "type": "keyValue",
  "source": { "kind": "stream", "event": "snapshot" },
  "rows": [
    { "key": "hostname", "label": "Hostname" },
    { "key": "kernel", "label": "Kernel" },
    { "key": "uptimeLabel", "label": "Uptime" },
    { "key": "loggedIn", "label": "Logged in users", "format": "number" }
  ]
}
```

### `list`

A short, unsorted, unfiltered list — lighter than `table`, for an Overview-sized widget.

| Prop | Type | Required |
|---|---|---|
| `source` | DataSource | yes — an array |
| `columns` | `{ key, label?, format?, align? }[]` | yes |
| `limit` | number | no — truncates the **display**, not the data on disk |
| `emptyText` | string | no |

Minimal:

```json
{
  "type": "list",
  "source": { "kind": "stream", "event": "snapshot", "path": "processes" },
  "columns": [{ "key": "name" }]
}
```

Full:

```json
{
  "type": "list",
  "source": { "kind": "stream", "event": "snapshot", "path": "processes" },
  "columns": [
    { "key": "name" },
    { "key": "memMiB", "label": "MiB", "align": "right" }
  ],
  "limit": 3,
  "emptyText": "No compute processes on the GPU"
}
```

### `table`

Sort, filter, optional group/tree, row actions, a detail drawer.

| Prop | Type | Required |
|---|---|---|
| `source` | DataSource | yes — an array of row objects |
| `columns` | `{ key, label, format?, align?, sortable?, aggregate? }[]` | yes, non-empty. `sortable` defaults to true. `aggregate: true` shows a group total. |
| `rowKey` | string | no — field used as React key and to match the open drawer after a refresh. Defaults to the first column's key. Set it when that column is not unique. |
| `sortDefault` | `{ key, dir: "asc" \| "desc" }` | no |
| `filterKeys` | string[] | no — defaults to every text column |
| `groupModes` | `{ id, label, key, parentIdKey? }[]` | no. With `parentIdKey`, `key` is the parent id on the child (e.g. `ppid`) and `parentIdKey` is the row's own id (`pid`) — a tree. A parent id that is not in the current page of rows is treated as a root. |
| `rowActions` | ActionSpec[] | no |
| `selectable` | boolean | no — adds a tick column and a toolbar. **Requires an explicit `rowKey`**: a selection is a list of those values, and the default rowKey is whatever the first column happens to be. |
| `bulkActions` | ActionSpec[] | no — buttons over the selection. Needs `selectable: true` or the installer errors, since nothing could reach them. |
| `rowDetail` | Block[] | no — rendered in a drawer, **scoped to that row** (`$row.`). |
| `emptyText` | string | no |

A bulk action is called `method(selectedRowKeys[], ...args, promptValue?)` — **the array of keys comes first**, before the spec's own `args`. `argsFromRow` means nothing on a bulk action, because there is no single row. The header tick selects everything the current filter shows; a selection survives filtering and re-sorting but drops rows that have since gone away, so a bulk action can never name a container that no longer exists.

Minimal:

```json
{
  "type": "table",
  "source": { "kind": "invoke", "method": "list", "intervalKey": "processes" },
  "columns": [
    { "key": "pid", "label": "PID" },
    { "key": "args", "label": "Command" }
  ]
}
```

Full (processes table, trimmed):

```json
{
  "type": "table",
  "source": { "kind": "invoke", "method": "list", "intervalKey": "processes" },
  "columns": [
    { "key": "pid", "label": "PID", "align": "right" },
    { "key": "user", "label": "User" },
    { "key": "cpu", "label": "CPU%", "format": "pct", "align": "right", "aggregate": true },
    { "key": "rssBytes", "label": "RSS", "format": "bytes", "align": "right", "aggregate": true },
    { "key": "args", "label": "Command" }
  ],
  "rowKey": "pid",
  "sortDefault": { "key": "cpu", "dir": "desc" },
  "filterKeys": ["user", "args"],
  "groupModes": [
    { "id": "user", "label": "By user", "key": "user" },
    { "id": "parent", "label": "By parent process", "key": "ppid", "parentIdKey": "pid" }
  ],
  "rowActions": [
    {
      "label": "Kill",
      "method": "kill",
      "argsFromRow": ["pid"],
      "args": ["KILL", false],
      "confirm": "Force kill this process (SIGKILL)?",
      "kind": "danger"
    },
    {
      "label": "Renice",
      "method": "renice",
      "argsFromRow": ["pid"],
      "prompt": { "label": "Nice value (-20 to 19)", "input": "number" }
    }
  ],
  "emptyText": "No processes match the filter"
}
```

Inside `rowDetail`, use `$row.` for invoke args and `argsFromRow` for actions. Example from Docker:

```json
{
  "type": "keyValue",
  "source": { "kind": "invoke", "method": "inspect", "args": ["$row.id"] },
  "rows": [{ "key": "image", "label": "Image" }]
}
```

### `statusCards`

One card per item in the resolved array, tinted by that item's own status. For a status wall over many machines, disks or nodes, where the number of cards is data rather than spec — `table` gives one row per item and cannot colour it, and `section.columns` only grids blocks the spec listed by hand.

| Prop | Type | Required |
|---|---|---|
| `source` | DataSource | yes — an array of item objects |
| `rowKey` | string | yes — React key, and what the drawer follows across refreshes |
| `titleKey` | string | yes — printed in the title row |
| `statusKey` | string | yes — `"ok"` \| `"warn"` \| `"bad"`; anything else is `unknown` (grey) |
| `subtitleKey` | string | no — a short right-aligned summary in the title row (`"5/6 running"`) |
| `note` | `{ key, label?, startOpen? }` | no — a collapsible line under the title. No chevron is drawn when that item's note is empty. |
| `items` | see below | yes — the chips inside the card |
| `columns` | `{ default?, min?, max? }` | no — default 4, 1, 8. The reader picks a count in the toolbar; a widget is clamped to 2. |
| `rowActions` | ActionSpec[] | no — buttons in the title row |
| `rowDetail` | Block[] | no — a drawer when the card is clicked, **scoped to that item** (`$row.`) |
| `emptyText` | string | no |

`items` describes one array on each item: `key` names it, `labelKey` / `statusKey` / `pinnedKey` name the fields on each entry (default `label` / `status` / `pinned`), `visibleRows` is how many chip rows are shown before the expand control (default 2), `pinnedFilterLabel` adds a switch that hides everything not pinned, and `emptyText` is what a card with no entries says. A plain array of strings works too — every chip is then `unknown`.

Cards sort worst-first (`bad`, `warn`, `unknown`, `ok`) and then by title, numerically when the title is an IPv4 address. Chips sort pinned-first, then by the same status order. Colours come from the theme tokens, so a `statusCards` block cannot pick its own — send a status, not a colour.

Minimal:

```json
{
  "type": "statusCards",
  "source": { "kind": "stream", "event": "hosts", "path": "hosts" },
  "rowKey": "id",
  "titleKey": "ip",
  "statusKey": "status",
  "items": { "key": "services" }
}
```

Full (the Services module's wall):

```json
{
  "type": "statusCards",
  "source": { "kind": "stream", "event": "hosts", "path": "hosts" },
  "rowKey": "id",
  "titleKey": "ip",
  "statusKey": "status",
  "subtitleKey": "summary",
  "note": { "key": "note", "label": "Notes" },
  "items": {
    "key": "services",
    "visibleRows": 2,
    "pinnedFilterLabel": "Watched services only",
    "emptyText": "No services reported"
  },
  "columns": { "default": 4, "min": 1, "max": 8 },
  "rowActions": [{ "label": "Probe", "method": "hostProbe", "argsFromRow": ["ip"] }],
  "rowDetail": [
    {
      "type": "keyValue",
      "source": { "kind": "invoke", "method": "hostInspect", "args": ["$row.ip"] },
      "rows": [{ "key": "hostname", "label": "Hostname" }]
    }
  ],
  "emptyText": "No machines yet"
}
```

### `log`

A live-tailed event. **Not** a declared stream — it does not have to be in `manifest.streams`. `startMethod` / `stopMethod` must be in `manifest.methods` when present.

| Prop | Type | Required |
|---|---|---|
| `event` | string | yes — `ctx.emit(event, payload)` from main. A string payload is a line; `{ id, data }` is filtered to the current scope's id. |
| `startMethod` | string | no — called on mount (and when scope changes) |
| `stopMethod` | string | no — called on unmount |
| `argsFromScope` | string[] | no — field names off the current scope, passed to start/stop in order |

Keeps the last 2000 lines. Pause/resume is built in.

Minimal:

```json
{ "type": "log", "event": "log" }
```

Full (Docker container drawer):

```json
{
  "type": "log",
  "event": "log",
  "startMethod": "logsStart",
  "stopMethod": "logsStop",
  "argsFromScope": ["id"]
}
```

### `terminal`

Opens an embedded PTY running a command built from the current scope. Placeholders `{{key}}` are filled from the row (dot-paths allowed: `{{id}}`).

| Prop | Type | Required |
|---|---|---|
| `label` | string | yes |
| `commandTemplate` | string | yes |

The terminal is a **shared** server PTY (every browser watching it sees the same thing), same as the Terminals page.

Minimal / full:

```json
{
  "type": "terminal",
  "label": "Exec shell",
  "commandTemplate": "docker exec -it {{id}} sh -c 'command -v bash >/dev/null && exec bash || exec sh'"
}
```

A `http://` in the template is an installer **error** (no URLs in specs). Do not put a remote script URL here.

### `actions`

A row of buttons.

| Prop | Type | Required |
|---|---|---|
| `actions` | ActionSpec[] | yes |

Minimal:

```json
{
  "type": "actions",
  "actions": [{ "label": "Refresh", "method": "list" }]
}
```

Full (hello details):

```json
{
  "type": "actions",
  "actions": [
    {
      "label": "Reboot target machine",
      "method": "reboot",
      "confirm": "Reboot the target machine now? Every open session and unsaved work on it will be interrupted.",
      "kind": "danger"
    }
  ]
}
```

### `form`

Fields plus one submit action. Field values are appended after `argsFromRow` / `args`, in field order. `number` fields are sent as numbers.

| Prop | Type | Required |
|---|---|---|
| `fields` | FormField[] | yes — see below |
| `submit` | ActionSpec | yes |
| `title` | string | no — a heading above the fields, worth having when a `rowDetail` stacks several forms |

#### `FormField`

Shared by `form` and `checkForm`. Every `key` is required and must be unique within the field list.

| Prop | Meaning |
|---|---|
| `input` | `"number"` \| `"text"` \| `"select"` \| `"checkbox"` \| `"password"` \| `"textarea"` \| `"file"` \| `"color"` |
| `options` | `{ value, label }[]`, `select` only |
| `optionsFrom` | A DataSource, `select` only — choices asked of the module instead of listed, so a form can offer what actually exists on the target. Must resolve to `{ value, label }[]`. Read **once**, when the block first becomes visible. |
| `accept` | Browser file-picker filter, `file` only. Defaults to `.txt`. |
| `maxKb` | Maximum file size in KiB, `file` only. Defaults to `1024`. |
| `omitOnApply` | `checkForm` only. The full value is sent to the check, then an empty string is sent with the apply token. Use when the check freezes a large or sensitive value in its one-use token payload. |
| `placeholder` | Placeholder text. |
| `help` | One line under the field saying what it is for. |
| `initial` | What the field starts as. |
| `initialFromScope` | A scope key to start from (a table row's field), which wins over `initial`. |

`number` is sent as a number, `checkbox` as a boolean, everything else as a string. A `file` field reads the selected file as text in the browser and sends that text as the field value; it does not upload the file or send its filename. The picker shows the filename and size locally and rejects files over `maxKb`. A module using `omitOnApply` must issue its check token against the correspondingly blanked apply values, while retaining the checked content only in the token payload. `color` is a hex string with a swatch picker; **empty is meaningful** — a module is free to read that as "pick one for me", which is what the Container module's tags do. `password` only hides the typing; it travels on the same channel as everything else, so do not put one in something you then save to disk.

File field, minimal:

```json
{ "key": "contents", "label": "Text file", "input": "file" }
```

File field, full:

```json
{
  "key": "accounts",
  "label": "Account list",
  "input": "file",
  "accept": ".txt,text/plain",
  "maxKb": 1024,
  "help": "One account per line; the form sends the file's text content."
}
```

Minimal:

```json
{
  "type": "form",
  "fields": [{ "key": "watts", "label": "Power limit (W)", "input": "number" }],
  "submit": { "label": "Set", "method": "setPowerLimit", "argsFromRow": ["index"] }
}
```

Full (GPU auto cap, in the drawer of the GPU table — so the card is the row, not a number the user has to know, and the two caps start at the range that GPU reports):

```json
{
  "type": "form",
  "title": "Auto power cap for this GPU",
  "fields": [
    {
      "key": "idleCap",
      "label": "Idle cap (W)",
      "input": "number",
      "initialFromScope": "powerMin",
      "help": "Applied while the machine is not busy."
    },
    {
      "key": "runningCap",
      "label": "Running cap (W)",
      "input": "number",
      "initialFromScope": "powerMax",
      "help": "Applied while it is busy."
    }
  ],
  "submit": {
    "label": "Watch this GPU",
    "method": "autoCapSet",
    "argsFromRow": ["index"],
    "confirm": "Switch this GPU's power cap between the two values automatically?"
  }
}
```

### `checkForm`

Fields the user cannot apply until the module has looked at them and said what would happen. Use it for anything that changes more than one thing, cannot be undone, or depends on the state of the machine — creating containers, bulk actions, writing kernel limits.

| Prop | Type | Required |
|---|---|---|
| `fields` | FormField[] | yes — same shape as `form` |
| `checkMethod` | string | yes, in `manifest.methods` |
| `applyMethod` | string | yes, in `manifest.methods` |
| `title` | string | no |
| `argsFromScope` | string[] | no — scope keys passed to **both** methods, before the values |
| `checkLabel` / `applyLabel` | string | no — default `"Check"` and `"Confirm and apply"` |
| `kind` | `"default"` \| `"danger"` | no — `danger` makes apply destructive and puts a confirm dialog in front of it |

Call convention:

```
check: method(...argsFromScope, values)                    -> ModuleCheckReport
apply: method(...argsFromScope, { token, values })         -> { ok, error? }
```

`values` is **one object**, `Record<key, string | number | boolean>` — not positional args like `form`. A `ModuleCheckReport` (`@shared/check`) is `{ ok, token?, findings: { level, label, detail? }[] }`, where `level` is `pass` / `info` / `warning` / `error`.

The app only offers apply when the report says `ok` **and** carries a `token`. Editing any field throws the report away, so what runs is always what the report was read for. On the module side, `createCheckSession()` hands out tokens that last ten minutes, are good for one use, and are bound to the exact values that were checked — `session.take(token, values)` returns `null` for a token that is unknown, expired, already spent, or whose values have changed since.

Give the session a payload and the apply gets back whatever the check resolved:

```ts
// check
return { ok: true, token: session.issue(values, { targets }), findings }

// apply
const taken = session.take(token, values)
if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
runOn(taken.payload.targets)
```

Freezing a resolved list into the payload is the point, not an optimisation: the user read a report naming twelve containers, and acting on a thirteenth that appeared in the meantime is not what they agreed to. Re-verify only what another process can take from under you between check and apply (a host port, a name), and fail with a message that says to check again.

What the levels are for:

| Level | Use it for |
|---|---|
| `pass` | the resolved plan — "will create 12 containers `web-001…012` on `lan0`, ports 8080-8091". This is the thing the user is confirming. |
| `info` | something that will happen anyway: an image that has to be pulled, a colour chosen automatically. |
| `warning` | worth reading twice, does not block: an irreversible action, a memory total near the limit, an L2 network the host cannot reach. |
| `error` | blocks apply. |

Minimal:

```json
{
  "type": "checkForm",
  "title": "Create tag",
  "checkMethod": "tagCheck",
  "applyMethod": "tagApply",
  "fields": [{ "key": "name", "label": "Name", "input": "text" }]
}
```

Inside a `rowDetail`, `argsFromScope` is how the same pair serves both create and edit — the drawer passes the row's id, and the module tells the two apart by whether it got a leading argument:

```json
{
  "type": "checkForm",
  "title": "Edit tag",
  "checkMethod": "tagCheck",
  "applyMethod": "tagApply",
  "argsFromScope": ["id"],
  "fields": [{ "key": "name", "label": "Name", "input": "text", "initialFromScope": "name" }]
}
```

### `conditional`

Shows one of two block lists depending on resolved data — the usual "tool missing" pattern.

| Prop | Type | Required |
|---|---|---|
| `when` | `{ source, path?, op, value? }` | yes. `op`: `"exists"` \| `"eq"` \| `"gt"`. `path` is applied **after** `source` (in addition to `source.path`). |
| `blocks` | Block[] | yes — when the condition holds |
| `else` | Block[] | no — when it does not; omit to show nothing |

`exists` — value is not `null`/`undefined`. `eq` — `===` against `value`. `gt` — numeric `>` against `value`.

Minimal:

```json
{
  "type": "conditional",
  "when": { "source": { "kind": "stream", "event": "snapshot", "path": "available" }, "op": "eq", "value": true },
  "blocks": [{ "type": "section", "title": "Ready", "blocks": [] }]
}
```

Full (GPU widget):

```json
{
  "type": "conditional",
  "when": { "source": { "kind": "stream", "event": "snapshot", "path": "available" }, "op": "eq", "value": true },
  "blocks": [
    {
      "type": "section",
      "title": "GPU",
      "blocks": [
        {
          "type": "stat",
          "label": "Utilization",
          "source": { "kind": "stream", "event": "snapshot", "path": "gpus.0.utilization" },
          "format": "pct"
        }
      ]
    }
  ],
  "else": [{ "type": "section", "title": "No GPU detected", "blocks": [] }]
}
```

## No URLs

Modules ship data, not remote scripts or images.

- **Spec** — any `http://` or `https://` anywhere in the JSON is an installer **error** (`spec contains a URL`).
- **Compiled main** — a URL that only appears in `.dist/main.mjs` is a **warning** (`external-url-in-code`). The user can still install a module they trust after reading the list.

Do not work around this with protocol-relative URLs or concatenating `"https:" + "//…"`. Put assets in the module folder if you truly need a file; the renderer will not fetch them either (CSP `'self'`).

## The checks the installer runs

Each row is one line in the result panel. **Error** blocks the install; **warning** requires confirming; **info** and **pass** are informational.

| Check id | Level when it fails | What it looks at |
|---|---|---|
| `archive` | error | `module.json` at the archive root or in its single top-level folder |
| `manifest` | error | valid JSON |
| `schema` | error | `manifestProblems()`: `apiVersion` 2, id, name, version, `entries.main`, no `entries.renderer`, pages/widgets/streams/methods |
| `entries` | error | the file `entries.main` names exists |
| `appVersion` | error | `minAppVersion` against the running app |
| `ui-specs` | error | every declared page/widget has `ui/pages/<id>.json` / `ui/widgets/<id>.json` |
| `ui-spec-schema` | error | those files parse and `specProblems()` is empty (including the no-URL rule and the history-stream namespace) |
| `compile` | error | esbuild bundle of the main half; only own files + `@shared/*` |
| `external-url-in-code` | warning | compiled `.dist/main.mjs` contains `http(s)://` |
| `source` | warning | a URL that is not a GitHub host (a local file you picked is trusted) |
| `version` | info or **warning** | new = info; same version = warning (reinstall); older = warning (downgrade) |
| `default` | warning | overwrites a module that shipped with the app (`modules.lock.json`) |
| `docs` | warning | missing `README.md` and/or `CHANGELOG.md` |
| `catalog-verified` | pass | zip sha256 matches `registry/modules.json` for this `id` |
| `unverified-source` | warning | not in the catalog, or the hash does not match |

After the checks pass, installing writes the folder and compiles in place. If that compile fails, the previous folder is restored — nothing the user was looking at changed, and the server is not restarted.

Archive size cap: **50 MB**. Download timeout: **5 minutes**.

## Versioning

- Use semantic versioning, independent of the app's version.
- Raise `minAppVersion` when you start using something a newer app added (a new `ctx` member, a new block type, a new icon). It is the only thing that stops your module being installed somewhere it cannot work.
- Keep `CHANGELOG.md` current: it is what the user reads in Settings → Modules → Details before overwriting a working module.

## Packaging

```bash
npm run modules:pack -- my-module            # writes scripts/my-module-1.0.0.zip
npm run modules:pack -- my-module /tmp/out   # somewhere else
npm run modules:pack -- ../elsewhere/my-module
npm run modules:pack -- docs/examples/hello  # -> scripts/hello-2.0.0.zip
```

The script applies the rules it can check locally before writing the archive (including `id` === folder name, `apiVersion` 2, every `ui/` spec exists, no `entries.renderer`), so a zip it produces will not be rejected for something it could have told you about first. The result has one top-level folder named after the module id, with forward slashes throughout. `.dist/` is not packed.

## Checklist before you publish

- [ ] `npm run typecheck` is clean (module `main/` is typechecked with the app).
- [ ] `npm run modules:pack -- <id>` reports no warnings.
- [ ] Every poller stops and every stream is killed in `dispose()`; the log says nothing about pollers the app had to stop for you.
- [ ] Nothing keeps using `ctx` after `dispose()` — no timer, no `.then()` on a command still in flight.
- [ ] Every method the module registers is in `manifest.methods`, and every name in `methods` is actually registered.
- [ ] `applyPollers()` can be called repeatedly with no side effects.
- [ ] `reset()` clears every counter that came from the previous machine.
- [ ] Disable it, then uninstall it, with the target connected: the app log shows the pollers stopping, the page and cards go, and nothing new is written under `data/`.
- [ ] The page says something useful when the tool it needs is missing, instead of showing an empty table (`conditional`).
- [ ] Destructive methods are behind `confirm` and/or `kind: "danger"`.
- [ ] Every destructive `checkForm` sets `kind: "danger"`, and its check reports what would happen as a `pass` finding, not just an absence of errors.
- [ ] An apply method refuses a token it cannot spend, and says to check again rather than doing something approximate.
- [ ] Nothing is written on the target that belongs in `hostDataSet`, and neither store is written on a poller tick.
- [ ] Specs contain no URLs.
- [ ] `README.md` and `CHANGELOG.md` are current, and `version` was raised.

## Getting into the catalog

The in-app catalog is `registry/modules.json` on the configured update repo's `main` branch (default `FireStarsSoft/Bored-Manager`).

1. Attach the zip to a GitHub release.
2. Hash **that exact file**: `sha256sum my-module-1.0.0.zip`.
3. Open a pull request adding one object to `registry/modules.json`:

```json
{
  "id": "my-module",
  "name": "My module",
  "description": "One sentence.",
  "author": "Your name",
  "homepage": "https://github.com/you/my-module",
  "version": "1.0.0",
  "minAppVersion": "0.1.0",
  "download": "https://github.com/you/my-module/releases/download/v1.0.0/my-module-1.0.0.zip",
  "sha256": "<hex of that zip>",
  "verifiedAt": "2026-08-14"
}
```

A maintainer reviews the module's **code** (not just the zip hash) before merge. See [MAINTENANCE.md](MAINTENANCE.md#reviewing-a-community-module). Until it is merged, installing the zip still works: the user gets the `unverified-source` warning and has to confirm.
