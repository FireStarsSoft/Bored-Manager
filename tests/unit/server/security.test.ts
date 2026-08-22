import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import {
  deriveAllowedHostnames,
  requestHostAllowed,
  requestOriginAllowed
} from '../../../server/security'

function request(host: string, origin?: string, fetchSite?: string) {
  return {
    headers: {
      host,
      ...(origin === undefined ? {} : { origin }),
      ...(fetchSite === undefined ? {} : { 'sec-fetch-site': fetchSite })
    }
  }
}

describe('trusted Host and Origin policy', () => {
  it('derives loopback, bind, interface, and configured hostnames', () => {
    const settings = {
      ...DEFAULT_SETTINGS.server,
      host: 'manager.lan',
      allowedHosts: ['dashboard.example.test']
    }
    const allowed = deriveAllowedHostnames(settings, {
      eth0: [
        {
          address: '192.168.50.4',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.168.50.4/24'
        }
      ]
    })

    expect(allowed).toEqual(
      new Set([
        'localhost',
        '127.0.0.1',
        '::1',
        'manager.lan',
        '192.168.50.4',
        'dashboard.example.test'
      ])
    )
  })

  it('never treats an attacker-controlled matching Host and Origin as trusted', () => {
    const security = {
      allowedHosts: new Set(['localhost', '127.0.0.1', 'manager.example.test'])
    }
    expect(requestHostAllowed(request('manager.example.test:8686'), security.allowedHosts)).toBe(
      true
    )
    expect(
      requestOriginAllowed(
        request('manager.example.test:8686', 'https://manager.example.test:8686'),
        security
      )
    ).toBe(true)
    expect(
      requestOriginAllowed(request('evil.example:8686', 'http://evil.example:8686'), security)
    ).toBe(false)
    expect(
      requestOriginAllowed(
        request('manager.example.test:8686', 'javascript://manager.example.test:8686'),
        security
      )
    ).toBe(false)
    expect(
      requestOriginAllowed(
        request('manager.example.test:8686', undefined, 'cross-site'),
        security
      )
    ).toBe(false)
  })

  it('allows only loopback port changes for the Vite development proxy', () => {
    const allowedHosts = new Set(['localhost', '127.0.0.1', '::1'])
    expect(
      requestOriginAllowed(request('127.0.0.1:8686', 'http://localhost:5173'), {
        allowedHosts,
        devMode: true
      })
    ).toBe(true)
    expect(
      requestOriginAllowed(request('127.0.0.1:8686', 'http://workstation.lan:5173'), {
        allowedHosts,
        devMode: true
      })
    ).toBe(false)
  })
})
