import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'path'
import type { HostKeyChallenge, HostKeyConfirmation } from '@shared/types'
import { isRecord } from '@shared/validation'
import { dataDir } from './store'
import { readPrivateJson, writeAtomicPrivateJson } from './private-file'

/**
 * SSH host keys the user has already accepted, keyed by `host:port`.
 * Fingerprints are SHA-256 hex of the raw host key, matching ssh2's
 * `hostHash: 'sha256'` verifier.
 */

interface KnownHostsFile {
  version: 1
  hosts: Record<string, { fingerprint: string }>
}

interface PendingChallenge extends HostKeyChallenge {
  hostId: string
}

const CHALLENGE_TTL_MS = 60_000
const MAX_PENDING_CHALLENGES = 256
const pendingChallenges = new Map<string, PendingChallenge>()

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
  const normalizedHost = host.trim().toLowerCase()
  if (
    normalizedHost.length === 0 ||
    normalizedHost.length > 506 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('SSH host identifier is invalid')
  }
  const id = `${normalizedHost}:${port}`
  return id
}

function fingerprintValue(fingerprint: string): string {
  if (!/^[0-9a-f]{64}$/i.test(fingerprint)) throw new Error('SSH host fingerprint is invalid')
  return fingerprint.toLowerCase()
}

function knownHostsDocument(value: unknown): KnownHostsFile {
  if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['hosts'])) {
    throw new Error('known hosts must contain version 1 and a hosts object')
  }
  const hosts: KnownHostsFile['hosts'] = {}
  for (const [id, raw] of Object.entries(value['hosts'])) {
    if (
      id.length === 0 ||
      id.length > 512 ||
      !isRecord(raw) ||
      typeof raw['fingerprint'] !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(raw['fingerprint'])
    ) {
      throw new Error(`known host entry "${id}" is invalid`)
    }
    hosts[id] = { fingerprint: raw['fingerprint'].toLowerCase() }
  }
  return { version: 1, hosts }
}

function readHosts(): Record<string, { fingerprint: string }> {
  const result = readPrivateJson(knownHostsFile(), knownHostsDocument, 'known hosts')
  return result.kind === 'missing' ? {} : result.value.hosts
}

function writeHosts(hosts: Record<string, { fingerprint: string }>): void {
  writeAtomicPrivateJson(knownHostsFile(), { version: 1, hosts } satisfies KnownHostsFile)
}

/** Persist a fingerprint the user just confirmed. */
export function rememberHostKey(host: string, port: number, fingerprint: string): void {
  const hosts = readHosts()
  hosts[hostId(host, port)] = { fingerprint: fingerprintValue(fingerprint) }
  writeHosts(hosts)
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function pruneChallenges(now: number): void {
  for (const [token, challenge] of pendingChallenges) {
    if (challenge.expiresAt <= now) pendingChallenges.delete(token)
  }
  while (pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
    const oldest = pendingChallenges.keys().next().value as string | undefined
    if (!oldest) break
    pendingChallenges.delete(oldest)
  }
}

function issueChallenge(
  kind: HostKeyChallenge['kind'],
  host: string,
  port: number,
  fingerprint: string,
  now: number
): HostKeyChallenge {
  pruneChallenges(now)
  let token = ''
  do {
    token = randomBytes(32).toString('base64url')
  } while (pendingChallenges.has(token))
  const challenge: PendingChallenge = {
    kind,
    fingerprint,
    host: host.trim(),
    port,
    token,
    expiresAt: now + CHALLENGE_TTL_MS,
    hostId: hostId(host, port)
  }
  pendingChallenges.set(token, challenge)
  const { hostId: _hostId, ...publicChallenge } = challenge
  return publicChallenge
}

function confirmationMatches(
  id: string,
  fingerprint: string,
  confirmation: HostKeyConfirmation | undefined,
  now: number
): boolean {
  if (!confirmation) return false
  const challenge = pendingChallenges.get(confirmation.token)
  // A submitted token is one-use even when the rest of the binding is wrong.
  if (challenge) pendingChallenges.delete(confirmation.token)
  if (
    !challenge ||
    challenge.expiresAt <= now ||
    challenge.hostId !== id ||
    challenge.fingerprint !== fingerprint ||
    fingerprintValue(confirmation.fingerprint) !== fingerprint
  ) {
    return false
  }
  return sameToken(challenge.token, confirmation.token)
}

/**
 * Accept a known key, or require a short-lived proof that the exact host,
 * port, and fingerprint shown by the preceding challenge was confirmed.
 */
export function checkHostKey(
  host: string,
  port: number,
  fingerprint: string,
  confirmation?: HostKeyConfirmation,
  now = Date.now()
): void {
  const normalized = fingerprintValue(fingerprint)
  const id = hostId(host, port)
  const stored = readHosts()[id]?.fingerprint
  if (stored === normalized) {
    if (confirmation) pendingChallenges.delete(confirmation.token)
    return
  }
  if (confirmationMatches(id, normalized, confirmation, now)) {
    rememberHostKey(host, port, normalized)
    return
  }
  throw new HostKeyError(
    issueChallenge(stored ? 'changed' : 'unknown', host, port, normalized, now)
  )
}

/** Isolate test cases; pending confirmations are deliberately process-local. */
export function resetHostKeyChallengesForTests(): void {
  pendingChallenges.clear()
}
