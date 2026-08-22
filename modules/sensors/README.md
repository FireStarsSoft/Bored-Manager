# Sensors

Every hardware reading the target machine exposes: temperatures, fan speeds, voltages, power and current, each kind on its own history chart (up to 8 series) plus a table of every reading.

## What it adds

| Where | What |
|---|---|
| Sidebar | **Sensors** page — one area chart per unit (°C, RPM, V, W, A), then a table of every reading |
| Overview | **Sensors** widget (off by default) — the same charts, stacked, hidden when that kind has no readings |

## What it runs on the target

One command per tick, both halves in the same shell so `sensors` only runs once:

```sh
sensors -u                 # lm-sensors, when installed
/sys/class/hwmon/hwmon*    # read directly, only when the above printed nothing
```

The sysfs fallback reads `temp*_input`, `fan*_input`, `in*_input`, `power*_input` and `curr*_input` together with their `_label`, `_max` and `_crit` files. No sudo needed, nothing is installed on the target.

## Settings it reads

| Setting | Effect |
|---|---|
| Update intervals → **Sensors** (fast) | how often the readings are taken; `paused` stops the poller |
| Overview → **Sensors** | whether the Overview widget is shown |

## When it shows nothing

Virtual machines and containers usually expose no sensors at all — the page says so rather than showing an empty grid. Physical machines without lm-sensors normally still report temperatures through the sysfs fallback.

## Files

```
main/index.ts          activate(): one fast poller
main/service.ts        the poller, the snapshot, and the per-kind series points
main/probe.ts          the shell commands and their parsers
ui/pages/main.json     charts + table
ui/widgets/summary.json  Overview charts
```
