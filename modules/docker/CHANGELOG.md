# Changelog

All notable changes to the Docker module. Versions are independent of the app's.

## 2.0.0

- Moved to API v2: the UI is declared in `ui/pages/*.json` (Containers, Images & storage, Logs) and `ui/widgets/*.json`. The app renders the pages; this module no longer ships React. Install, update and reload no longer rebuild or restart the app.

## 1.0.0

- First version as a Bored Manager module. The page, the detail panel, the actions and the log streaming are unchanged.
- Log streams are now released by the module's own dispose step, which the app calls when the module is disabled as well as on a clean close - so switching the module off also stops any `docker logs -f` still running on the target.
- The two Overview widgets are enabled through Settings → Overview, and the whole module can be disabled or uninstalled in Settings → Modules.
