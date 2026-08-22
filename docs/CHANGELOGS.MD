# Changelog

All notable changes to Bored Manager. Each module keeps its own changelog in `modules/<id>/CHANGELOG.md`, because module versions are independent of the app's.

## 0.3.6

- **Fixed: connecting a machine left module pages and Overview cards empty until a refresh.** Module specs are gated on a live instance, but the UI still used the empty list fetched at boot. After connect/reconnect the renderer now reloads specs before seeding history; a newly live host (including one another browser connected) also triggers a refresh; and the server pushes the updated module list as soon as that host activates. Settings → Overview cards lists widget toggles from the installed-module manifests, so the switches no longer wait for a live spec.

## 0.3.5

- **Fixed: a fresh install crash-looped and never listened on port 8686.** `install.sh` wrote a `settingsVersion` 6 file with only `server.port` / `server.host`. The server requires an `auth` object on v4+ files, so Node exited before `listen` and systemd restarted it every 3 seconds. Settings are now seeded from `DEFAULT_SETTINGS` (`scripts/seed-settings.ts`). `--repair` (what `bored-manager update` runs) heals the v0.3.4 stub. An omitted `auth` field is treated as first-run defaults; a present but malformed `auth` object still refuses to start.
- **Install prints a URL that works on the box.** The summary always shows `http://127.0.0.1:<port>`. The LAN line is the first private IPv4 that is not docker0 / libvirt's default bridge — not whatever `hostname -I` listed first. If the user service does not answer on loopback, the installer says so and prints the journal instead of "enabled and started".

## 0.3.4

- **Fixed: a fresh install from the v0.3.3 zip failed at `vite build`.** The packager left `tsconfig.test.json` out of the archive, but the root `tsconfig.json` still references it and Vite 7 parses that reference. The file now ships in the zip; `install.sh` writes a stub when an older archive is missing it.

## 0.3.3

- **Many machines.** The server keeps a shared pool of local and SSH targets. Adding or disconnecting a machine changes the pool for every browser; each tab still picks which machine it is viewing.
- **Module renderer extensions.** Module pages can use a responsive `subnav` block that preserves hidden item state while pausing their invoke polling, static info/warning `note` blocks, a `pie` block, and client-side `file` form fields that send text content with configurable picker filters and size limits. A `checkForm` field can set `omitOnApply` so a large or sensitive value is frozen into the one-use check token and is not sent again on apply.
- **WebSocket payload budget.** Inbound RPC frames accept up to 2 MiB so a 1 MiB uploaded text list fits the envelope; outbound results and the per-socket queue accept up to 8 MiB so a visibility-gated thousand-row table can return in one reply.
- **BMC module.** Out-of-band IPMI power, boot-device, sensor and event-log management from a connected management station. Ships disabled.
- **OpenWRT module.** Monitor one directly connected OpenWRT router, create large PPPoE batches from uploaded or pasted account lists, and automatically bind DHCP clients on one LAN to free WANs on one carrier, one-to-one. Small summaries are pushed live while large tables stay visibility-gated and are answered from memory. Ships disabled.
- **CI runs the test suite.** Pushes and pull requests run `npm test` after typecheck. `SETTINGS_VERSION` is 7 (`server.allowedHosts`, `server.trustProxy`).

## 0.3.2

- **Install / update / uninstall.** `./bored-manager update` and `./bored-manager uninstall` are first-class commands. The in-app updater escapes the systemd cgroup so Confirm & install can finish, restarts without a unit via `bored-manager start`, and reports quarantined modules in `update-result.json`. `install.sh` can update an existing folder without wiping the chosen port; `--refresh` reinstalls the app while keeping accounts and settings; `--renew --yes` is a factory reset. `uninstall.sh` stops a pidfile process and accepts `--yes`.
- **Docs and scripts match the current settings schema.** `SETTINGS_VERSION` was 6 at this release (`docker` → `container`); the installer template, uninstall leftovers and the updater's "Task Manager" comment are gone. 0.3.3 raised it to 7 (`server.allowedHosts`, `server.trustProxy`).
- **Hardening.** WebSocket upgrades require a same-origin `Origin`; sensitive files under `data/` are `0600` / `0700`; uploads have size limits; history stream names are validated; module and app downloads stay on GitHub hosts; password hashing is async scrypt; lockout is per username and per address. A bind of `0.0.0.0` with login off is warned in the UI and at startup. Releases attach a SHA-256 file; `install.sh` verifies it; `update.sh` keeps `data/module-data/`. Container, GPU and Processes refuse unknown actions, signals and pids before they reach the shell.
- **CI.** Pushes to `main` run typecheck, build, and the module lock / spec / compile checks. Unused Radix packages and unused shadcn primitives (`accordion`, `popover`, `scroll-area`, `slider`) are gone.

## 0.3.1

- **Fixed: changing a password crashed the page.** The password dialog (and the one for setting `bored-admin`'s first password, which is what "Require login" opens) rendered nothing but a white screen. Radix refuses to slot a dialog onto a `<form>` when a close button sits next to it, and the crash took the whole app down; two other dialogs - the terminal's custom command and a module action's prompt - were broken the same way. A render error is now caught and shown with a Reload button instead of unmounting the app.
- **Fixed: switches showed no state.** Every on/off switch in Settings was styled for `data-checked`, which the installed Radix does not emit - so the track had no colour in either state and the knob never moved. Off is now an outlined track with a grey knob, on a filled one with a white knob, legible in both themes. Ticked checkboxes were unfilled for the same reason.
- **Require login behaves as designed.** Switching it on closes the sockets of clients that never logged in, instead of leaving them live until their next call; turning it on from Settings signs this browser in on the way (or shows the login form straight away) rather than dropping it with "your session expired". A settings write or an imported file can no longer switch it on while `bored-admin` has no password, which was a way to lock everyone out for good. Accounts without a password now say so at the top of the card, with a button to set one.
- **Settings is one section at a time.** A list on the left - General, Overview cards, Modules, Data & storage, Server & users, Software update, About - instead of ten cards in a two-column grid that left holes wherever a tall card met a short one. Update intervals only lists categories whose module is switched on.
- **Breadcrumb says something.** "Sensors › Sensors" and "Processes › Processes" are now just the page, the module crumb is a link to it, and the duplicate page headings under it are gone. The connection dot goes amber while the server is reconnecting, and the palette hint reads ⌘ K on a Mac.
- Auto power cap and installing a container runtime: see the GPU and Container module changelogs.
- `form` blocks accept a `title`, so a row drawer with several forms says what each one is for.
- A `checkForm` apply that refuses (a spent token, something already running) now reports the refusal instead of "applied".

## 0.3.0

- **New block type `statusCards`.** One tinted card per item in a resolved array, for a status wall whose card count comes from the data: a title row coloured by that item's health, a collapsible note, status chips clamped to a couple of rows with an expand control, and a column count the reader can change. `table` could not stand in for it — one row per item, no data-driven colour — and `section.columns` only grids blocks a spec listed by hand. A module using it needs `minAppVersion: "0.3.0"`.
- **Services module.** A seventh default module (`service-fleet`), shipped **disabled**: watch and control systemd services across every machine in an IP range, from the machine you are connected to. Enable it in Settings → Modules.
- **Update intervals → Services (fleet).** A fast key for how often the fleet pages re-read the last sweep, and a slow key for how often the machines are actually swept over SSH. Slow intervals gained a **2 minutes** option.

## 0.1.0

Web UI on Linux. The desktop Electron app is gone.

- **Server, not a window.** Express 5 + WebSocket RPC on port **8686** (`0.0.0.0`). Open `http://<ip>:8686` from any browser. One Linux host, many clients, one connected machine and the same terminals.
- **Install in one line** (`curl … \| bash`) into `~/bored-manager`, with a systemd user unit `bored-manager.service`. `./bored-manager start|stop|status|unlock`. Linux only (Ubuntu/Kali preferred).
- **Accounts, optional login, global lockout.** Auth is off by default. Turn it on in Settings → Server & users. Too many wrong passwords lock every client; unlock only from a terminal on the host. Per-user saved connections; `bored-admin` cannot be deleted.
- **Module framework v2.** A module is data (`main/index.ts`) plus JSON UI specs (`ui/pages/*.json`, `ui/widgets/*.json`). The app renders every page. Install, update, uninstall and **reload** take effect immediately — no app rebuild, no server restart. Six built-in modules ship at **2.0.0**.
- **Sidebar.** A module with more than one page is a dropdown. Overview, Packages, Terminals and Settings stay in the app.
- **App services.** An Overview card for what Bored Manager itself is running, plus the Processes module's **Sub services** page.
- **Community catalog.** Settings → Modules lists reviewed modules from `registry/modules.json` on the configured GitHub repo. Unverified archives need an extra confirmation.
- **About / no CDN.** Settings → About lists the app version, Apache-2.0 and every bundled library. The UI does not load assets from a third-party host.

## 0.0.1

First release of **Bored Manager** (`bored-manager`).

- GUI for Linux processes, network, disk, sensors, packages, NVIDIA GPU and Docker — local or over SSH.
- Everything except Overview, Packages, Terminals and Settings ships as a module (version `1.0.0`), managed in Settings → Modules.
- Docker ships with the app but starts **disabled**; enable it in Settings → Modules.
