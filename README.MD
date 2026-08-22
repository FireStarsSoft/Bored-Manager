# Bored Manager

**Bored Manager** is a web UI for Linux — monitor and control **system processes**, **network**, **disk**, **sensors**, **packages**, **GPU** and **containers** on the local machine or on a remote machine over SSH.

The server runs on Linux. On the host open **`http://127.0.0.1:8686`**. From another device on the LAN use `http://<ip>:8686`. The app does not reimplement any tool: it visualises data from what is already on the target machine (`/proc`, `ps`, `ss`, `ip`, `lsblk`, `df`, `dpkg/apt`, `nvidia-smi`, `docker`, `sensors`) through a single executor layer (local shell or SSH).

**Everything except the Overview, Packages, Terminals and Settings pages is a module** that can be switched off, removed or replaced — and you can install your own. See *Modules* below, and [`docs/MODULE-RULESET.md`](docs/MODULE-RULESET.md) to write one.

## Documentation

The sections below are the user-facing overview. The detail lives in [`docs/`](docs/README.md):

| Document | For |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | how the app is put together |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | setting it up and where a change belongs |
| [MODULES.md](docs/MODULES.md) | how modules are managed |
| [MODULE-RULESET.md](docs/MODULE-RULESET.md) | writing a module |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | packaging, installing, updating |
| [MAINTENANCE.md](docs/MAINTENANCE.md) | releasing a version |
| [CHANGELOGS.MD](docs/CHANGELOGS.MD) | what changed per version |

## Features

- **Web UI, many clients and many machines**: one Linux host runs the server; phones, laptops and desktops on the network open the same address. The server keeps a shared pool of local/SSH targets connected and collects each one independently. Every browser chooses which machine it is viewing, so two browsers can watch different machines at the same time. Adding or disconnecting a machine changes the shared pool for everyone; the active selection is private to that browser tab.
- **Optional login and a lockout**: login is off by default. Turn it on in Settings → *Server & users*. Too many wrong passwords lock that username and that client address; unlock only from a terminal on the host (`./bored-manager unlock`). See *Security*.
- **Sidebar groups**: a module with more than one page (Processes, Network, Disk, GPU, Container, Services, BMC, OpenWRT) is a dropdown in the sidebar. Overview, Packages, Terminals and Settings stay where they are.
- **Overview** (default page): a **drag-and-drop card grid** — grab the grip in the top-left corner of a card to move it; the other cards make room and every gap is filled from the top down. Card height **follows its content** (a Sensors card with 4 readings is short, a per-core CPU card with 32 cores is tall), width is adjustable by dragging the right edge. The layout is stored in settings (with a *Reset layout* button). Summary cards for CPU, Memory, GPU, Container, Network and Disk I/O with history charts from **30s to 24h**. Every card shows **which processes are consuming that resource** and how much (memory in GB, CPU in %) — and for the two-way resources **per direction**: `↓ download · ↑ upload` for network, `R read · W write` for disk, in the same colours the detail pages use. Each card carries a small marker with **its own update interval**. When nothing could be measured the card says why instead of showing an empty space. Extra cards (per-core CPU, file systems, sensors, load & uptime, top processes, GPU processes, Container resources, **App services**) are enabled in Settings. A card is only shown when its collector is running.
- **App services**: an Overview card for what Bored Manager itself is running (the server process, pollers, live streams and terminals) and what that costs in CPU and RAM. The Processes module’s **Sub services** page lists every entry, not just the busiest few.
- **Processes**: a glances-style system detail strip plus a sortable/filterable process table, kill (SIGTERM/SIGKILL) and renice. Full detail in [`modules/processes/README.md`](modules/processes/README.md).
- **Network** (Traffic, Connections, Host tuning): Download/Upload widgets, a per-interface traffic chart, and every socket down to its owning process, direction and rate — plus bandwidth per process, listening ports, TCP quality, gateway and DNS. **Host tuning** shows the kernel limits that decide how many containers a machine can hold (ARP table, file descriptors, inotify, conntrack), how close it is to each, and can raise them for a given number of container addresses — writing both the running kernel and `/etc/sysctl.d`. Full detail in [`modules/network/README.md`](modules/network/README.md).
- **Disk** (Devices + File systems): Read/Write widgets, IOPS and a throughput chart; every block device on the machine whether mounted or not, file systems with inodes, and I/O per process down to an **Unattributed** row for the bytes no process can be charged for. Full detail in [`modules/disk/README.md`](modules/disk/README.md).
- **Sensors**: every temperature, fan, voltage, power and current reading the machine exposes, grouped by chip, with a history chart. Full detail in [`modules/sensors/README.md`](modules/sensors/README.md).
- **Packages**: installed/upgradable counts, when the package list was last updated, total size; an upgradable table (upgrade one package or all), search and install, remove/purge, autoremove, an action history; apt/dnf/pacman output streams live into a log panel. Full support for **apt/dpkg**, basic support for **dnf** and **pacman**.
- **GPU** (Dashboard + Auto power cap): utilisation/VRAM/temperature/power charts; power limit, persistence mode and clock lock/reset controls. **Auto power cap** lists every GPU the machine reports with the range its driver allows, and switches each one between an idle and a running cap — busy meaning either a running container or a compute process on that card. What to watch is saved per machine, so it survives a reconnect or a restart. Full detail in [`modules/gpu/README.md`](modules/gpu/README.md).
- **Container** (Dashboard, Docker, Images & storage, Logs, Incus, Fleet operations, Module settings): Docker and Incus side by side. A containers table (status, healthcheck, CPU/memory, network and block I/O, ports, tags) whose rows open a full `docker inspect` panel plus logs, exec shell and pause/unpause; Incus instances and VMs with the same table and their images, profiles, networks and storage pools; **tags** you invent and apply across a selection; and **Fleet operations** — bulk create for either engine, bulk actions by tag/state/name/image, and creating an ipvlan network. Everything that changes more than one thing goes through a **Check** step that reads the machine and reports what would happen before it will apply — including **installing Docker or Incus** on a machine that has neither, from the module's own settings page. Full detail in [`modules/container/README.md`](modules/container/README.md).
- **Services** (Overview, Machines, Services, Bulk install, Jobs, Module settings): systemd across every machine in an IP range, driven from the one machine the app is connected to — it becomes a jump host and opens its own SSH sessions. A **status wall** with one card per machine coloured by whether the services you decided to watch are running, a table of every machine and unit, bulk start/stop/restart and bulk install of the units every machine must have, all behind the same **Check** step. Ships **disabled**. Full detail in [`modules/service-fleet/README.md`](modules/service-fleet/README.md).
- **BMC** (Management + Module settings): out-of-band IPMI power, boot-device, sensor and event-log management from a connected management station. Ships **disabled**. Full detail in [`modules/bmc/README.md`](modules/bmc/README.md).
- **OpenWRT** (Dashboard, Automation, Module settings): monitor an OpenWRT router directly over the app's SSH connection, create thousands of PPPoE WANs from a text list, and automatically bind each DHCP client on one LAN to one free WAN from a selected carrier. Aggregate state is pushed live over WebSocket while thousand-row detail tables are read only while visible. Ships **disabled**. Full detail in [`modules/openwrt/README.md`](modules/openwrt/README.md).
- **Terminals**: as many shells as you like on every connected machine, local or SSH, plus one-click presets (`watch nvidia-smi`, `glances`, `lazydocker`) or a custom command. Terminals stay attached to the machine where they were opened; switching machines changes the visible set without closing the others. Every terminal is a real PTY on the server and is cleaned up automatically when that machine disconnects or the server stops.
- **Two update speeds per category**: what changes every second (CPU, RAM, network, disk I/O, sensors, GPU, containers, per-process counters) runs on a **fast interval** of 1–5s; what changes on the scale of minutes (**mount usage and the block device list, Docker disk usage, interface addresses/MTU/gateway/DNS**) runs on a **separate slow interval** per category (30s → 30 min, or *Manual only*). Every slow section shows how long ago it was read plus a **refresh button** for an immediate reading. The result: each fast tick is a shorter command that costs the target machine less.
- **Modules (v2)**: Processes, Network, Disk, Sensors, GPU, Container, Services, BMC and OpenWRT are modules — each with its own version, README and changelog. A module is **data + JSON UI specs**; the app renders the pages. Settings → Modules can switch them off, **reload**, remove or install from a `.zip` / GitHub repo / the reviewed catalog. Install, update, uninstall and reload take effect **immediately** — no app rebuild, no server restart. See *Modules* below and [`docs/MODULES.md`](docs/MODULES.md).
- **Reviewed catalog**: Settings → Modules lists community modules from `registry/modules.json` on the configured GitHub repo. Installing from the catalog is the same pipeline as a zip you picked yourself, with a verified-source check.
- **Charts with labelled axes**: every chart, including the small ones on the Overview cards, labels its **time axis** (clock time, with seconds for ranges up to 10 minutes) and its **value axis** in the unit being measured (%, B/s, GiB, °C, W), so it is always clear what the height of a curve means. A **reference grid is drawn in both directions** — a line at every value label and at every time label — so a point on a curve can be read off against either axis, and the labels sit clear of the plot with the outer time labels never clipped at the edge of a card.
- **Long-term history**: metrics are collected in RAM and **written to disk in one batch every 5 minutes** (see *History and data storage*), which makes 24-hour charts possible without wearing out the disk.
- **Clean close**: every process and channel the app creates (terminals, watchers, log streams, pollers, SSH) is registered in a session registry and cleaned up when the server stops — nothing is left behind on the target machine. History still in memory is written out before exit.
- **In-app update**: three sources — **Check for updates** against the GitHub repo, a zip URL, or a zip uploaded from the browser. The update is a transaction with automatic rollback; settings, accounts, saved connections and modules you installed yourself are kept. See *Updating the app*.
- **About / no CDN**: Settings → About shows the app version, Apache-2.0, the GitHub repo, and every bundled library with its license. The UI does not load assets from a CDN or any other third-party host — everything is packed with the app.
- **Portable**: all code, data (`data/`) and icons (`assets/`) live in this one folder. Deleting the folder uninstalls the app completely.

## Requirements

- **Machine running the server**: **Linux** (Ubuntu / Kali preferred; other Debian-family distros; dnf/pacman best-effort) with **Node.js 20+**.
- **Target machine (local or over SSH)**: Linux with `ps`, `/proc`, `ss`, `ip`; optionally `nvidia-smi` (GPU), `docker`, `lm-sensors`, `lsblk`, `glances`, `lazydocker`. It works without sudo, but per-process network and disk figures then only cover that user's own processes.
- **Client**: any current browser. No extra client install.
- **Dev from another OS**: use **WSL2**.

## Installation

On a new Linux machine (Ubuntu / Kali / other Debian-family distros) one command is enough. Default install folder `~/bored-manager`, port **8686**:

```bash
# Ubuntu / Kali / other Debian-family distros (default: install into ~/bored-manager, port 8686)
curl -fsSL https://raw.githubusercontent.com/FireStarsSoft/Bored-Manager/main/install.sh | bash

# wget, change port + do not register the service
wget -qO- https://raw.githubusercontent.com/FireStarsSoft/Bored-Manager/main/install.sh | bash -s -- --port 9090 --no-service

# install from a zip already downloaded
curl -fsSL https://raw.githubusercontent.com/FireStarsSoft/Bored-Manager/main/install.sh | bash -s -- --source ./bored-manager-0.3.7.zip
```

Needs Node.js 20+, `curl` or `wget`, and `unzip`. The installer registers a systemd user unit (`bored-manager.service`) unless you pass `--no-service`, then starts it. Open `http://127.0.0.1:8686` on the host, or `http://<ip>:8686` from another machine.

`./install.sh --repair` reinstalls dependencies, rebuilds, and heals an unbootable first-run settings file (what `run.sh` and the in-app updater call).

Running the same one-liner (or `./install.sh`) against an existing install **updates** it: the running process is stopped first, `data/` is kept, `--port` / `--host` are only written when you pass those flags, and the service is restarted.

`--refresh` reinstalls the app and every module but keeps accounts, settings and UI config. `--renew` deletes the folder (including all data) and installs from scratch — type `YES`, or pass `--yes` when piping through `curl | bash`.

### Installer flags

| Flag | Default | Meaning |
|---|---|---|
| `--port` | `8686` | WebUI port (only written when passed, or on a new install) |
| `--host` | `0.0.0.0` | Bind address (same rule as `--port`) |
| `--dir` | `~/bored-manager` | Install folder |
| `--source` | latest GitHub release | Local `.zip` or zip URL |
| `--no-service` | off | Do not register the systemd user unit |
| `--repair` | — | Reinstall dependencies and rebuild in the current app folder |
| `--refresh` | — | Reinstall the app and every module; keep accounts, settings and UI config |
| `--renew` | — | Delete the install folder (including all data) and install from scratch |
| `--yes` | off | Skip the `--renew` confirmation |

CLI flags (`--port`, `--host`) beat `data/user-settings/settings.json`, which beats the built-in defaults.

### Defaults

| Item | Value |
|---|---|
| Port | `8686` |
| Bind host | `0.0.0.0` |
| URL | `http://127.0.0.1:8686` on the host; `http://<ip>:8686` on the LAN |
| Install folder | `~/bored-manager` |
| systemd unit | user unit `bored-manager.service` (`~/.config/systemd/user/`) |
| Login | **off** (every client acts as `bored-admin`) |
| Default account | `bored-admin` (created on first boot, cannot be deleted) |
| Lockout | 5 wrong passwords, all clients |
| Session idle | `0` hours = never expires |
| Update repo | `FireStarsSoft/Bored-Manager` |

## Running & managing

From the install folder:

```bash
./bored-manager start     # systemd user unit if registered, otherwise background
./bored-manager stop
./bored-manager status
./bored-manager update    # latest GitHub release, or --source <zip|url>
./bored-manager unlock    # clear the login lockout
./bored-manager uninstall [--purge] [--yes]
```

With the systemd user unit:

```bash
systemctl --user status bored-manager
systemctl --user start bored-manager
systemctl --user stop bored-manager
systemctl --user restart bored-manager
journalctl --user -u bored-manager -e
```

Change **port** or **bind address** in Settings → *Server & users* (Save, then restart the server — those two are only read at start). Everything else in Settings applies immediately. A new *Sign out when idle* value applies to sessions created after the change.

When the UI opens, pick **Local machine** or enter **SSH** details (host, user, password/private key). Afterward, use the machine switcher at the bottom of the sidebar to add another target, switch the machine this browser is viewing, disconnect one from the shared pool, or reconnect one remembered by this browser session. Add a **sudo password** if you want the operations that need root (GPU power limit, killing another user's process, seeing network/disk figures for every process, installing/removing packages, ...).

To run in the foreground instead of as a service: `./run.sh`.

## Security

Login is **off by default**, and the server binds **`0.0.0.0`** — anyone who can reach `http://<ip>:8686` has full access. Settings → *Server & users* warns when both of those are true. Turn login on (*Require login*), or bind `127.0.0.1` if only this machine should open the UI. The first time you enable login you must set a password for `bored-admin` — the switch asks for one, and signs this browser in with it. Any other browser that was connected while the login was off is signed out on the spot.

- Passwords are changed from the account table in the same card (*Change password*). An account that has none says so, with a button to set one.
- Username + password are required on **every** sign-in. The browser is never asked to store the password (only the last username is kept locally as a typing convenience).
- Each account has its own data on the host under `data/users/<username>/` (saved SSH connections). Deleting an account deletes that folder with it; other accounts are untouched. `bored-admin` cannot be deleted.
- Wrong passwords are counted **per username and per client address**. After `auth.maxFailures` (default **5**) that account and that address lock (HTTP 423); other people on other addresses can still sign in. A successful login resets those two counters. Unlock **every** lockout from a terminal on the host: `./bored-manager unlock`. That takes effect immediately; you do not need to restart.
- Session cookies are HttpOnly / SameSite=Lax, stored as files under `data/sessions/`. Idle timeout is rolling (`0` = no expiry). Idle only applies when login is on.

The app serves **plain HTTP**. Use it on a trusted LAN, or put it behind a TLS reverse proxy if it must be reachable more widely.

## Settings

Sections are listed down the left and shown one at a time — *General*, *Overview cards*, *Modules*, *Data & storage*, *Server & users*, *Software update*, *About*.

- **Update intervals**, per category, in *General*. A category whose module is switched off is not listed. Each one is split into what has to be sampled often and what does not:

  | Category | Fast interval (1s / 2s / 5s / paused) | Slow interval (30s → 30m / manual) |
  |---|---|---|
  | System | CPU, memory, load average, total network and disk rates | — |
  | Sensors | temperatures, fans, voltages, power, current | — |
  | Processes | process table, Overview top consumers | — |
  | GPU | utilisation, VRAM, temperature, power | — |
  | Container | containers and their CPU/memory stats | image, volume and build cache disk usage (`docker system df`) |
  | Network | interface rates, connections, per-process bandwidth | addresses, MTU, link speed, gateway, DNS |
  | Disk & storage | throughput, IOPS, utilisation, per-process I/O | mount usage and inodes (`df`), block device list (`lsblk`) |
  | Services (fleet) | how often the fleet pages re-read the last sweep | how often every machine is swept over SSH |
  | BMC | visible management tables | BMC power sweep |
  | OpenWRT | router status and the WAN-binding reconciliation engine | PPPoE log scan, table-map self-heal and history |

  So disk read/write is measured every second while `df` is not — the detail page no longer inherits one single speed for everything on it.

- **Data collection**: switch the app's own collectors on or off (CPU, Memory, machine-wide network and disk rates, Packages). Turning one off **stops it completely** — nothing is collected. Everything a module collects is switched with the module, in *Modules*.
- **Detail collectors** (network connections / per-process disk I/O / Overview top consumers — the heaviest ones): choose `While tab is open` (default, costs nothing when you are not looking), `Always` (keeps running in the background so per-process session totals stay accurate), or `Off`.
- **Density** Low / Medium / High for HD / Full HD / 2K screens (auto-detected on first run).
- **Default history window**: the default time range of the charts (30s → 24h; ranges longer than 10 minutes only appear when the history retention actually covers them).
- **Overview cards**: which optional cards are shown, grouped by where they come from — the app's own first (including **App services**), then a block per module — plus a **Reset layout** button to put the cards back in their default order.
- **Modules**: a table of what is installed (version, built-in or installed, enabled, integrity) with enable/disable, Uninstall, Reload, Verify and Details (the module's own README and changelog). Below it: install or update from a GitHub `owner/repo`, a zip URL, a file, or the **reviewed catalog**. Details in [`docs/MODULES.md`](docs/MODULES.md).
- **Data & storage**: manage the metrics history — the folder being written to, the current file, total size and file count, oldest/newest sample, last write and how many samples are still buffered in RAM; adjust **retention** (1–48 hours) and the **size limit** (MB); *Refresh*, *Write now*, *Copy path* and *Clear history*.
- **Backup & portability**: settings live in `data/user-settings/settings.json`; export/import them from the Settings tab to move your setup to another machine (the Overview layout comes along). The file carries a `settingsVersion`: it is read by any newer version, unknown fields are dropped, missing ones come from the defaults, and it is rewritten in the current format.
- **Server & users**: listen address (port / bind host), *Require login*, lockout threshold, session idle, and the account list (add, change password, delete — deleting an account wipes that user's saved connections).
- **Software update**: the installed version, the GitHub repo (default `FireStarsSoft/Bored-Manager`) with *Check for updates*, a zip URL (pre-filled with the last one you used), and a zip file from this device. *Download & test* then *Confirm & install*. The server restarts itself. Details in *Updating the app* below.
- **About**: app name, version, Apache-2.0, link to the GitHub repo, the bundled libraries (name / version / license), and a reminder that nothing is loaded from a CDN.

## Modules

Nine modules ship with the app (Container, Services, BMC and OpenWRT are **off by default** — enable them in Settings → Modules), each versioned independently and documented on its own:

| Module | Pages | README |
|---|---|---|
| `processes` | Processes, Sub services | [modules/processes/README.md](modules/processes/README.md) |
| `network` | Traffic, Connections | [modules/network/README.md](modules/network/README.md) |
| `disk` | Devices, File systems | [modules/disk/README.md](modules/disk/README.md) |
| `sensors` | Sensors | [modules/sensors/README.md](modules/sensors/README.md) |
| `gpu` | Dashboard, Auto power cap | [modules/gpu/README.md](modules/gpu/README.md) |
| `container` | Dashboard, Docker, Images & storage, Logs, Incus, Fleet operations, Module settings | [modules/container/README.md](modules/container/README.md) |
| `service-fleet` | Overview, Machines, Services, Bulk install, Jobs, Module settings | [modules/service-fleet/README.md](modules/service-fleet/README.md) |
| `bmc` | Management, Module settings | [modules/bmc/README.md](modules/bmc/README.md) |
| `openwrt` | Dashboard, Automation, Module settings | [modules/openwrt/README.md](modules/openwrt/README.md) |

The CPU, Memory, Network, Disk I/O, App services and Top processes cards on the Overview belong to the app, not to a module: they are fed by the machine-wide metrics (and the services tracker), so a summary of the machine does not depend on which detail pages are installed.

A v2 module is `module.json` + `main/` (data) + `ui/pages/*.json` and `ui/widgets/*.json` (declarative UI). The app compiles `main` to `modules/<id>/.dist/main.mjs` and renders every block itself. **Settings → Modules** enables, disables, installs, updates, reloads and uninstalls them without rebuilding or restarting the app. A module that fails its checks is refused or rolled back, so it cannot leave the UI unable to start. See [`docs/MODULES.md`](docs/MODULES.md) for the full lifecycle and integrity checks, and [`docs/MODULE-RULESET.md`](docs/MODULE-RULESET.md) — with a working example in [`docs/examples/hello/`](docs/examples/hello/) — to write your own.

## History and data storage

Charts longer than 10 minutes are served from a metrics log inside the app folder:

```
data/metrics/<local | user@host>/<stream>-<YYYYMMDDHH>.jsonl
data/metrics/_app/services-<YYYYMMDDHH>.jsonl
```

One NDJSON file per stream per hour. Each connected machine writes its own `system` stream (CPU, memory, totals) and module streams (`gpu`, `container`, `network`, `disk`, …). The global `services` stream (what the Bored Manager process itself is running) lives under `_app`. It is **self-cleaning**: files past the retention window or the total size limit are deleted automatically, both adjustable in **Settings → Data & storage**, which also shows the current size and offers *Write now*, *Copy path* and *Clear history*. Turn history off entirely with the *Keep a metrics history* switch there.

The `network` and `disk` streams only contain data while their module is enabled **and** its detail collector is running (`While tab is open` by default) — set it to `Always` for a continuous history of those two. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the batching and in-memory buffering that keep this cheap.

Accounts and per-user data live next to that, not inside the metrics log:

```
data/users/users.json              # accounts (password hashes, never the password)
data/users/<username>/             # that account's files (saved SSH connections today)
data/sessions/                     # login sessions (when login is on)
data/secret.key                    # encrypts saved SSH passwords; session cookie secret
data/auth-lock.json                # global wrong-password counter
```

## Updating the app

From the install folder, `./bored-manager update` (or `./bored-manager update --source <zip|url>`) uses the same pipeline as the WebUI. Three sources are also available in **Settings → Software update**, all through the same validate → backup → swap → rebuild → start pipeline:

1. **GitHub repo** (default `FireStarsSoft/Bored-Manager`, editable on that card) → *Check for updates* → *Download & test* the release zip (or the `main` branch if that repo has no release yet).
2. **Zip URL** — paste a GitHub release asset or source archive; the field is **remembered** for next time.
3. **File** — upload a `.zip` from the browser.

*Download & test* reports **PASS** or **ERROR with a reason** per check (right repository, all core files present, a toolchain to build with). **Confirm & install** stops the service, backs up the folder, installs the new tree, restores what should be kept, runs `install.sh --repair`, and starts the service again. Any failed step **rolls back** to the previous version.

Kept across an update: `data/user-settings/`, `data/users/`, saved connections, `data/secret.key`, and any **module you installed yourself**. Not kept: `data/metrics/` (chart history) and the log files.

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the exact checks and transaction steps, and *Troubleshooting* below (or [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md)) if an update reports an error.

## Uninstalling

```bash
./uninstall.sh                 # stop the user service and any pidfile process
./uninstall.sh --purge         # also delete the install folder (type YES to confirm)
./uninstall.sh --purge --yes   # same, no prompt
./bored-manager uninstall --purge --yes
```

Without `--purge` the folder stays; delete it yourself to remove settings, accounts, logs and metrics history. Everything the app owns lives inside that folder.

## Troubleshooting

**The service does not stay up** — on the host:

```bash
journalctl --user -u bored-manager -e
```

`data/app.log` in the install folder is the same lifecycle log (also used when you start without systemd).

**Port already in use** — reinstall with another `--port`, or change Port in Settings → *Server & users* and restart. `./bored-manager status` prints the URL it thinks it is on.

**Forgot the `bored-admin` password** — on the host, edit `data/user-settings/settings.json`, set `"auth": { "enabled": false }` (keep any other `auth` fields that are already there), then `./bored-manager stop` and `./bored-manager start`. Open the UI, go to Settings → *Server & users*, set a new password, and turn *Require login* back on.

**Locked out** (too many wrong passwords):

```bash
./bored-manager unlock
```

**Node.js older than 20** — the installer refuses to continue. On Ubuntu / Kali, `apt`'s `nodejs` is often too old. Install [nvm](https://github.com/nvm-sh/nvm), then:

```bash
nvm install 20
nvm use 20
```

**`node_modules` is broken** (partial install, copied from another machine, permission errors):

```bash
./install.sh --repair
```

Do not run the installer as root unless you set `BM_ALLOW_ROOT=1` (data would live in `/root`).

**A module's page shows less than expected, or says a tool is missing**: each module degrades on its own and documents exactly what it needs and how it falls back when that is missing — see that module's README (Settings → Modules → Details, or `modules/<id>/README.md`). For example, the Network page needs sudo to name the process behind every socket, and the Disk page falls back to `/proc/diskstats` when `lsblk` is unavailable.

**A long chart (1h+) is empty even though the app has been running for a while**: the history only starts when you connect to that machine, and the network/disk streams need their detail collector to be running. Check Settings → Data & storage for the actual oldest/newest sample and size.

**An update reported an error** — the next start shows an error notice; the full detail is in `data/update.log`. See [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md#when-an-update-reported-an-error) for what each message means and how to recover; installing by hand is always a fallback: unpack the new zip into the app folder (keeping `data/`) and run `./install.sh --repair`.

## Structure

```
server/          # Express + WebSocket RPC: executors (local/SSH), the connection,
                 # the app's own services (system metrics, top consumers, packages,
                 # terminals, history, updater, users, catalog), the modules host
                 # and module installer, the session registry
shared/          # Used by the server AND by modules: types.ts (data + settings),
                 # modules.ts (manifest + runtime contract), module-ui.ts (UI spec),
                 # shell.ts, ss.ts
src/             # Renderer: React + Tailwind + Radix + recharts + react-grid-layout
                 # + xterm.js. Core pages: Overview, Packages, Terminals, Settings.
                 # src/modules/ renders every module page from JSON specs.
modules/         # One folder per module: module.json, main/, ui/pages/, ui/widgets/,
                 # README, CHANGELOG. .dist/ is compiled at runtime (not shipped).
                 # modules.lock.json records what shipped.
registry/        # Community catalog (modules.json) consumed by Settings → Modules
docs/            # Architecture, development, deployment, maintenance, the module
                 # rule set, and a complete example module
scripts/         # package.sh          - build a release .zip
                 # update.sh           - replace the app folder on update
                 #                       (backup + rollback; stops/starts the service)
                 # modules-lock.mjs    - record the shipped modules
                 # package-module.mjs  - zip one module for distribution
                 # licenses.mjs        - bundled-library list for Settings → About
                 # bored-manager.service
assets/          # icon.png
data/            # App data - created at runtime:
                 #   user-settings/   - settings.json + modules.json
                 #   users/           - users.json + <username>/
                 #   sessions/        - login sessions
                 #   secret.key, auth-lock.json, registry-cache.json
                 #   metrics/<host>/  - metrics history (NDJSON, written every 5 min)
                 #   app.log, update.log, update-result.json, server.pid
```
