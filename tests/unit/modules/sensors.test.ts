import { describe, expect, it } from 'vitest'
import { parseSensors } from '../../../modules/sensors/main/probe'
import { seriesFromHistory, toKindPoint } from '../../../modules/sensors/main/service'
import type { SensorReading, SensorsSnapshot } from '@shared/types'

const CORETEMP = [
  'coretemp-isa-0000',
  'Adapter: ISA adapter',
  'Package id 0:',
  '  temp1_input: 47.000',
  '  temp1_max: 80.000',
  '  temp1_crit: 100.000',
  'Core 0:',
  '  temp2_input: 44.000',
  '  temp2_crit: 100.000'
].join('\n')

function reading(partial: Partial<SensorReading> & Pick<SensorReading, 'label' | 'kind' | 'value'>): SensorReading {
  return {
    chip: partial.chip ?? 'chip',
    unit: partial.unit ?? '°C',
    ...partial
  }
}

describe('parseSensors', () => {
  it('reads a sensors -u coretemp block', () => {
    const rows = parseSensors(CORETEMP, '')
    expect(rows.map((r) => r.label)).toEqual(['Core 0', 'Package id 0'])
    const pkg = rows.find((r) => r.label === 'Package id 0')
    expect(pkg).toMatchObject({ kind: 'temp', value: 47, crit: 100, max: 80, chip: 'coretemp-isa-0000' })
  })

  it('keeps a negative voltage', () => {
    const rows = parseSensors(
      ['nct6775-isa-0290', 'Vcore:', '  in0_input: -12.000'].join('\n'),
      ''
    )
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'voltage', label: 'Vcore', value: -12, unit: 'V' })
    ])
  })

  it('drops a 0 °C and a 300 °C reading', () => {
    const rows = parseSensors(
      [
        'chip-isa-0000',
        'Zero:',
        '  temp1_input: 0.000',
        'Hot:',
        '  temp2_input: 300.000',
        'Ok:',
        '  temp3_input: 41.000'
      ].join('\n'),
      ''
    )
    expect(rows.map((r) => r.label)).toEqual(['Ok'])
  })

  it('prefixes a colliding Composite label with the short chip name', () => {
    const rows = parseSensors(
      [
        'nvme-pci-0100',
        'Composite:',
        '  temp1_input: 40.000',
        'nvme-pci-0200',
        'Composite:',
        '  temp1_input: 41.000'
      ].join('\n'),
      ''
    )
    expect(rows.map((r) => r.label).sort()).toEqual([
      'nvme-pci-0100 Composite',
      'nvme-pci-0200 Composite'
    ])
  })

  it('falls back to hwmon when lm-sensors produced nothing', () => {
    const rows = parseSensors('', 'coretemp|temp1|Package|47000|80000|100000')
    expect(rows).toEqual([
      expect.objectContaining({
        chip: 'coretemp',
        label: 'Package',
        kind: 'temp',
        value: 47,
        max: 80,
        crit: 100
      })
    ])
  })

  it('scales power from microwatts and leaves fan as RPM', () => {
    const rows = parseSensors('', 'hwmon0|power1|Package|2500000||\nhwmon0|fan1|Chassis|1200||')
    expect(rows.find((r) => r.kind === 'power')).toMatchObject({ value: 2.5, unit: 'W' })
    expect(rows.find((r) => r.kind === 'fan')).toMatchObject({ value: 1200, unit: 'RPM' })
  })

  it('ignores hwmon text once lm-sensors returned any row', () => {
    const rows = parseSensors(CORETEMP, 'other|temp1|Other|99000|||')
    expect(rows.some((r) => r.label === 'Other')).toBe(false)
  })

  it('sorts kinds temp, fan, voltage, power, current', () => {
    const rows = parseSensors(
      [
        'chip-isa-1',
        'Amp:',
        '  curr1_input: 1.000',
        'Watt:',
        '  power1_input: 2.000',
        'Volt:',
        '  in0_input: 3.000',
        'Spin:',
        '  fan1_input: 800',
        'Hot:',
        '  temp1_input: 40.000'
      ].join('\n'),
      ''
    )
    expect(rows.map((r) => r.kind)).toEqual(['temp', 'fan', 'voltage', 'power', 'current'])
  })
})

describe('toKindPoint / seriesFromHistory', () => {
  it('caps a kind at 8 keys and omits a label named t', () => {
    const sensors = Array.from({ length: 10 }, (_, i) =>
      reading({ label: i === 0 ? 't' : `T${i}`, kind: 'temp', value: i })
    )
    const point = toKindPoint({ t: 1, sensors }, 'temp')
    expect(point).not.toBeNull()
    expect(Object.keys(point!).filter((k) => k !== 't')).toHaveLength(7)
    expect(point).not.toHaveProperty('t', sensors[0].value)
    expect(toKindPoint({ t: 1, sensors: [] }, 'fan')).toBeNull()
  })

  it('rebuilds temp points from history and leaves empty kinds empty', () => {
    const snaps: SensorsSnapshot[] = [
      { t: 1, sensors: [reading({ label: 'CPU', kind: 'temp', value: 40 })] },
      { t: 2, sensors: [reading({ label: 'CPU', kind: 'temp', value: 41 })] }
    ]
    const series = seriesFromHistory(snaps)
    expect(series.temps).toEqual([
      { t: 1, CPU: 40 },
      { t: 2, CPU: 41 }
    ])
    expect(series.fans).toEqual([])
  })
})
