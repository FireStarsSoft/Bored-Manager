# Changelog

All notable changes to the NVIDIA GPU module. Versions are independent of the app's.

## 2.0.0

- Moved to API v2: the UI is declared in `ui/pages/*.json` (Dashboard + Auto power cap) and `ui/widgets/*.json`. The app renders the pages; this module no longer ships React. Install, update and reload no longer rebuild or restart the app.

## 1.0.0

- First version as a Bored Manager module. The page, the charts, the controls and the auto power cap behave as before.
- Killing a compute process now runs `kill -KILL` from this module instead of going through the Processes feature, so the GPU page keeps working when the Processes module is disabled or uninstalled.
- The two Overview widgets are enabled through Settings → Overview, and the whole module can be disabled or uninstalled in Settings → Modules.
