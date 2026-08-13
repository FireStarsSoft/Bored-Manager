# Changelog

All notable changes to the Sensors module. Versions are independent of the app's.

## 2.0.0

- Moved to API v2: the UI is declared in `ui/pages/main.json` and `ui/widgets/summary.json`. The app renders the pages; this module no longer ships React. Install, update and reload no longer rebuild or restart the app.

## 1.0.0

- First version as a Bored Manager module. Behaviour is unchanged: the same probes, the same page, the same Overview widget.
- The widget is enabled through Settings → Overview instead of the old "extended cards" list, and the whole module can be disabled or uninstalled in Settings → Modules.
