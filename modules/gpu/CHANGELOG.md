# Changelog

All notable changes to the GPU module. Versions are independent of the app's.

## 2.3.1

- Persistence, clock lock and clock reset refuse an index that has no GPU reading, the same way a power-limit change already did — they no longer call `nvidia-smi` with a made-up card number.

## 2.3.0

- Keeps the main GPU metrics query alive with `nvidia-smi -lms` instead of starting it on every tick. Compute-process data remains current through one bounded query per streamed sample.
- A stream that fails uses 1s/2s retry backoff, then falls back to the previous per-tick query for the rest of that connection after three consecutive failures. Changing interval, hiding a tab-gated collector, disconnecting, or disabling the module always kills the stream.
- Auto power cap now treats a failed Docker/NVIDIA busy probe as unknown and leaves caps untouched. Stopping or reconfiguring the watcher invalidates an in-flight probe before it can apply stale results.

## 2.2.2

- Adds an opt-in “while page/card is visible” mode for the metrics poller. The default remains Always, preserving continuous history; the automatic power-cap watcher is never visibility-gated.

## 2.2.1

- Caches the stable GPU UUID-to-index map, removing one `nvidia-smi` process from normal metric ticks. A previously unseen process UUID automatically schedules a map refresh on the next tick.

## 2.2.0

- Display name is **GPU** (was NVIDIA GPU). Sidebar, Settings and Overview group labels follow `manifest.name`.
- Overview **GPU** card is now **GPU utilisation**: a dual-axis chart of utilisation (%) and temperature (°C). The short process list moved off this card — use **GPU processes**.
- New Overview widget **GPU power** (on by default): draw and the current cap, the same series as the Dashboard Power chart. Each GPU card can be switched off in Settings → Overview.

## 2.1.1

- Killing a compute process refuses a non-integer or pid ≤ 1 before `kill` is run.

## 2.1.0

- The auto power cap works per GPU instead of on one index typed into a box. The **Auto power cap** page lists every GPU the machine reports; opening a row offers its two caps, prefilled with the minimum and maximum that GPU allows.
- Watts are checked against the range the driver reports before anything is run. An empty number field used to arrive as `0` and be sent to `nvidia-smi` as `-pl 0`; it is now refused with the allowed range in the message. The same check guards setting a limit by hand.
- What to watch is saved per machine, so it survives a reconnect, an app restart and a reboot. It used to live only in memory, which meant a watcher that had already changed a cap forgot it was supposed to change it back.
- Busy can now mean "a compute process is on that GPU" (`nvidia-smi`) instead of only "a container is running somewhere on the machine" (`docker ps`).
- The GPU table gained the minimum, maximum and default power limits (`power.min_limit`, `power.max_limit`, `power.default_limit`) and the current draw; the watcher's log is shown on the page instead of being collected and thrown away.
- Methods: `autoCapStart` no longer takes arguments (it resumes what is saved). New `autoCapSet`, `autoCapClear`, `autoCapConfigure` and `autoCapLogTail`.
- Pages with no GPU say what to check instead of showing a card with nothing in it.

## 2.0.0

- Moved to API v2: the UI is declared in `ui/pages/*.json` (Dashboard + Auto power cap) and `ui/widgets/*.json`. The app renders the pages; this module no longer ships React. Install, update and reload no longer rebuild or restart the app.

## 1.0.0

- First version as a Bored Manager module. The page, the charts, the controls and the auto power cap behave as before.
- Killing a compute process now runs `kill -KILL` from this module instead of going through the Processes feature, so the GPU page keeps working when the Processes module is disabled or uninstalled.
- The two Overview widgets are enabled through Settings → Overview, and the whole module can be disabled or uninstalled in Settings → Modules.
