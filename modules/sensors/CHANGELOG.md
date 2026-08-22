# Changelog

All notable changes to the Sensors module. Versions are independent of the app's.

## 2.1.1

- Adds an opt-in “while page/card is visible” mode for sensor polling. The default remains Always so existing installs keep continuous charts.

## 2.1.0

- Overview widget and the Sensors page now share the same area charts as the Network traffic chart: one chart per unit (temperature, fans, voltage, power, current), up to 8 coloured series each. Kinds the machine does not expose stay hidden.
- Added live `temps` / `fans` / `voltages` / `power` / `current` series streams. `snapshots()` seeds the latest snapshot (not the whole history ring) plus those series.

## 2.0.0

- Moved to API v2: the UI is declared in `ui/pages/main.json` and `ui/widgets/summary.json`. The app renders the pages; this module no longer ships React. Install, update and reload no longer rebuild or restart the app.

## 1.0.0

- First version as a Bored Manager module. Behaviour is unchanged: the same probes, the same page, the same Overview widget.
- The widget is enabled through Settings → Overview instead of the old "extended cards" list, and the whole module can be disabled or uninstalled in Settings → Modules.
