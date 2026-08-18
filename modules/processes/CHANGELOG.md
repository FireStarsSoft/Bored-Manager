# Changelog

All notable changes to the Processes module. Versions are independent of the app's.

## 2.0.1

- Kill only accepts `TERM` or `KILL`. Any other signal is refused before a command is built.

## 2.0.0

- Moved to API v2: the UI is declared in `ui/pages/*.json` (Processes + Sub services). The app renders the pages; this module no longer ships React. Install, update and reload no longer rebuild or restart the app.
- Sub services lists every process and stream Bored Manager itself is running, with measured CPU/RAM where a pid exists and an estimated tick cost for pollers.

## 1.0.0

- First version as a Bored Manager module. The table, the detail strip, kill and renice are unchanged.
- The File systems and Sensors panels of the detail strip are now optional: they appear when the Disk and Sensors modules are enabled and are left out otherwise, instead of rendering empty.
- The whole module can be disabled or uninstalled in Settings → Modules. The Overview's Top processes card is unaffected - it belongs to the app.
