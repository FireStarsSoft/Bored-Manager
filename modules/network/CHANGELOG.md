# Changelog

All notable changes to the Network module. Versions are independent of the app's.

## 2.0.0

- Moved to API v2: the UI is declared in `ui/pages/*.json` (Traffic + Connections). The app renders the pages; this module no longer ships React. Install, update and reload no longer rebuild or restart the app.

## 1.0.0

- First version as a Bored Manager module. The probes, the tables and the charts are unchanged.
- Killing the process behind a connection now runs `kill -TERM` from this module instead of going through the Processes feature, so the page keeps working when the Processes module is disabled or uninstalled.
- The whole module can be disabled or uninstalled in Settings → Modules. The Overview's Network card is unaffected - it belongs to the app and is fed by the core system stream.
