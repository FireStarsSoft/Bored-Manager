import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { HostKeyChallenge } from '@shared/types'
import { dataDir } from './store'

/**
 * SSH host keys the user has already accepted, keyed by `host:port`.
 * Fingerprints are SHA-256 hex of the raw host key, matching ssh2's
 * `hostHash: 'sha256'` verifier.
 */

interface KnownHostsFile {
  version: 1
  hosts: Record<string, { fingerprint: string }>
}

export class HostKeyError extends Error {
  readonly hostKey: HostKeyChallenge

  constructor(challenge: HostKeyChallenge) {
    const where = `${challenge.host}:${challenge.port}`
    super(
      challenge.kind === 'changed'
        ? `SSH host key for ${where} has changed (${challenge.fingerprint})`
        : `Unknown SSH host key for ${where} (${challenge.fingerprint})`
    )
    this.name = 'HostKeyError'
    this.hostKey = challenge
  }
}

function knownHostsFile(): string {
  return join(dataDir(), 'known-hosts.json')
}

function hostId(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`
}

function readHosts(): Record<string, { fingerprint: string }> {
  try {
    if (!existsSync(knownHostsFile())) return {}
    const raw = JSON.parse(readFileSync(knownHostsFile(), 'utf8')) as Partial<KnownHostsFile>
    if (!raw.hosts || typeof raw.hosts !== 'object') return {}
    return raw.hosts
  } catch {
    return {}
  }
}

function writeHosts(hosts: Record<string, { fingerprint: string }>): void {
  const file = knownHostsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, hosts } satisfies KnownHostsFile, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  })
}

/** Persist a fingerprint the user just confirmed. */
export function rememberHostKey(host: string, port: number, fingerprint: string): void {
  const hosts = readHosts()
  hosts[hostId(host, port)] = { fingerprint }
  writeHosts(hosts)
}

/**
 * Accept a known key, reject a mismatch or first sighting, or record the key
 * when `accept` is set (the UI already showed the fingerprint).
 */
export function checkHostKey(
  host: string,
  port: number,
  fingerprint: string,
  accept: boolean
): void {
  const stored = readHosts()[hostId(host, port)]?.fingerprint
  if (stored === fingerprint) return
  if (accept) {
    rememberHostKey(host, port, fingerprint)
    return
  }
  throw new HostKeyError({
    kind: stored ? 'changed' : 'unknown',
    fingerprint,
    host,
    port
  })
}
