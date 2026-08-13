import type { SensorKind, SensorReading } from '@shared/types'

/**
 * Reading hardware sensors off a Linux target. Two sources, in order of
 * preference: `sensors -u` from lm-sensors, and /sys/class/hwmon read directly
 * when lm-sensors is not installed (very common on servers and containers).
 * Every command is plain POSIX sh so it works on any target shell.
 */

/**
 * Read every hwmon reading straight from sysfs. Emits
 * `chip|key|label|value|max|crit`, where key (temp1, fan2, in0, ...) carries
 * the kind and the raw value keeps the sysfs unit.
 */
const HWMON_FALLBACK = [
  'for h in /sys/class/hwmon/hwmon*; do',
  '[ -r "$h/name" ] || continue;',
  'n=$(cat "$h/name" 2>/dev/null);',
  'for f in "$h"/temp*_input "$h"/fan*_input "$h"/in*_input "$h"/power*_input "$h"/curr*_input; do',
  '[ -r "$f" ] || continue;',
  'b=${f%_input};',
  'l=""; mx=""; cr="";',
  '[ -r "${b}_label" ] && l=$(cat "${b}_label" 2>/dev/null);',
  '[ -r "${b}_max" ] && mx=$(cat "${b}_max" 2>/dev/null);',
  '[ -r "${b}_crit" ] && cr=$(cat "${b}_crit" 2>/dev/null);',
  'v=$(cat "$f" 2>/dev/null);',
  'echo "$n|${b##*/}|$l|$v|$mx|$cr";',
  'done;',
  'done'
].join(' ')

/**
 * Emits the SENSORS section and, only when lm-sensors produced nothing, the
 * HWMON section. The two commands share one shell so `sensors` runs once.
 */
export const SENSORS_CMD = `__tm_sensors=$(sensors -u 2>/dev/null); echo "$__tm_sensors"`
export const HWMON_CMD = `if [ -z "$__tm_sensors" ]; then ${HWMON_FALLBACK}; fi`

/** coretemp-isa-0000 -> coretemp, nvme-pci-0100 -> nvme */
function shortChip(chip: string): string {
  return chip.replace(/-(?:isa|pci|virtual|acpi|i2c|spi|mdio|scsi|usb|platform|hid|thermal)-\w+$/, '')
}

interface KindSpec {
  kind: SensorKind
  unit: string
  /** sysfs reports these scaled up (millidegrees, microwatts, ...) */
  sysfsDivisor: number
}

/** hwmon feature prefixes, as used by both `sensors -u` and sysfs. */
const KINDS: Record<string, KindSpec> = {
  temp: { kind: 'temp', unit: '°C', sysfsDivisor: 1000 },
  fan: { kind: 'fan', unit: 'RPM', sysfsDivisor: 1 },
  in: { kind: 'voltage', unit: 'V', sysfsDivisor: 1000 },
  power: { kind: 'power', unit: 'W', sysfsDivisor: 1_000_000 },
  curr: { kind: 'current', unit: 'A', sysfsDivisor: 1000 }
}

/** Drop readings a chip cannot plausibly have measured. */
function plausible(kind: SensorKind, value: number): boolean {
  if (!Number.isFinite(value)) return false
  if (kind === 'temp') return value > 0 && value <= 250
  if (kind === 'fan') return value >= 0 && value < 100_000
  return true // voltages can be negative (-12V rail), fans/power can read 0
}

interface RawSensor extends SensorReading {}

/**
 * Same label from two chips is ambiguous ("Composite" on three NVMe drives),
 * so those get their chip prefixed - the unique ones stay short. When even
 * the shortened chip name repeats (two NVMe drives are both "nvme"), the full
 * chip name is used, since that is what tells the two devices apart.
 */
function finalize(raw: RawSensor[]): SensorReading[] {
  const count = (list: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const k of list) m.set(k, (m.get(k) ?? 0) + 1)
    return m
  }
  const plain = count(raw.map((r) => `${r.kind}|${r.label}`))
  const short = count(raw.map((r) => `${r.kind}|${shortChip(r.chip)} ${r.label}`))
  return raw.map((r) => {
    if (!r.chip || (plain.get(`${r.kind}|${r.label}`) ?? 0) < 2) return { ...r }
    const shortLabel = `${shortChip(r.chip)} ${r.label}`
    const label =
      (short.get(`${r.kind}|${shortLabel}`) ?? 0) < 2 ? shortLabel : `${r.chip} ${r.label}`
    return { ...r, label }
  })
}

/**
 * `sensors -u` prints the chip name at column 0, each feature as `label:` at
 * column 0 and its raw values indented below it:
 *
 *     coretemp-isa-0000
 *     Package id 0:
 *       temp1_input: 47.000
 *       temp1_crit: 100.000
 */
function parseLmSensors(text: string): RawSensor[] {
  const raw: RawSensor[] = []
  let chip = ''
  let label = ''
  /** readings of the feature block being parsed, keyed by hwmon key */
  let pending: Map<string, { spec: KindSpec; input?: number; max?: number; crit?: number }> =
    new Map()

  const flush = (): void => {
    for (const [key, r] of pending) {
      if (r.input == null || !plausible(r.spec.kind, r.input)) continue
      raw.push({
        chip,
        label: label || key,
        kind: r.spec.kind,
        value: r.input,
        unit: r.spec.unit,
        max: r.max,
        crit: r.crit
      })
    }
    pending = new Map()
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (/^\S/.test(line)) {
      const feature = line.match(/^(\S[^:]*):\s*$/)
      if (feature) {
        flush()
        label = feature[1].trim()
      } else if (!line.includes(':')) {
        flush()
        chip = line.trim()
        label = ''
      }
      continue
    }
    const m = line.match(/^\s+([a-z]+)(\d+)_(\w+):\s*(-?[\d.]+)/)
    if (!m) continue
    const spec = KINDS[m[1]]
    if (!spec) continue
    const value = parseFloat(m[4])
    if (!Number.isFinite(value)) continue
    const key = `${m[1]}${m[2]}`
    const entry = pending.get(key) ?? { spec }
    if (m[3] === 'input') entry.input = value
    else if (m[3] === 'max') entry.max = value
    else if (m[3] === 'crit') entry.crit = value
    pending.set(key, entry)
  }
  flush()
  return raw
}

/** hwmon fallback lines: `chip|key|label|value|max|crit` in sysfs units. */
function parseHwmon(text: string): RawSensor[] {
  const raw: RawSensor[] = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split('|')
    if (parts.length < 4) continue
    const spec = KINDS[parts[1].replace(/\d+$/, '')]
    if (!spec) continue
    const scaled = (s: string | undefined): number | undefined => {
      if (!s) return undefined
      const n = parseFloat(s)
      return Number.isFinite(n) ? n / spec.sysfsDivisor : undefined
    }
    const value = scaled(parts[3])
    if (value == null || !plausible(spec.kind, value)) continue
    raw.push({
      chip: parts[0],
      label: parts[2] || parts[1],
      kind: spec.kind,
      value,
      unit: spec.unit,
      max: scaled(parts[4]),
      crit: scaled(parts[5])
    })
  }
  return raw
}

const KIND_ORDER: SensorKind[] = ['temp', 'fan', 'voltage', 'power', 'current']

export function parseSensors(sensorsText: string, hwmonText: string): SensorReading[] {
  const lm = parseLmSensors(sensorsText)
  const all = finalize(lm.length ? lm : parseHwmon(hwmonText))
  return all.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.chip.localeCompare(b.chip) ||
      a.label.localeCompare(b.label)
  )
}
