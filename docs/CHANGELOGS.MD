# Changelog

All notable changes to Bored Manager. Each module keeps its own changelog in `modules/<id>/CHANGELOG.md`, because module versions are independent of the app's.

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
