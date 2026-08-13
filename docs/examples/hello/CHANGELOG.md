# Changelog

All notable changes to the Hello example module. Versions are independent of the app's.

## 2.0.0

- Rewritten for the v2 module contract (API v2): the renderer half is now `ui/pages/*.json` and `ui/widgets/*.json` instead of `renderer/*.tsx` - nothing here is compiled into the app any more, and installing/reloading it never rebuilds or restarts the app.
- Two pages instead of one: **Hello** (uptime chart) and **Details** (hostname/kernel/logged-in users, plus a confirm-gated action).
- The on-demand `uname -a` reader is replaced by a `reboot` action (`systemctl reboot`, elevated), a more representative example of the confirm-before-destructive-action pattern every module eventually needs.
- `snapshot` changed from a `series` stream to `latest` (the current reading), with a new slim `series` stream carrying just the chart's point - a block reading "now" cannot pick the last element off a `series` stream itself. See `main/index.ts`.

## 1.0.0

- First version, shipped with Bored Manager 0.0.1 as the worked example for `docs/MODULE-RULESET.md`.
- Uptime, kernel and logged-in user count from one shell roundtrip; an uptime chart; an on-demand `uname -a`.
