# Sensors

Every hardware reading the target machine exposes, grouped by chip: temperatures with a bar against the chip's own critical point, fan speeds, voltages, power and current, plus a temperature history chart.

## What it adds

| Where | What |
|---|---|
| Sidebar | **Sensors** page — chart of up to 8 temperature sensors, then one card per reading kind |
| Overview | **Sensors** widget (off by default) — a badge per temperature, colour-coded against the critical point |

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
main/index.ts     activate(): one fast poller
main/service.ts   the poller and the snapshot it emits
main/probe.ts     the shell commands and their parsers
renderer/index.tsx     tab + widget + stream declaration
renderer/SensorsTab.tsx
renderer/SensorsCard.tsx
```
