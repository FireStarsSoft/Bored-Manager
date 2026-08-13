# Changelog

All notable changes to Bored Manager. Each module keeps its own changelog in `modules/<id>/CHANGELOG.md`, because module versions are independent of the app's.

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
