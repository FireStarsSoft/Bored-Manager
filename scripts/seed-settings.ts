#!/usr/bin/env node
// Write or repair data/user-settings/settings.json from DEFAULT_SETTINGS so a
// first-run file can never drift away from the schema the server loads.
//
// Usage (from the app folder, after npm install):
//   npx tsx scripts/seed-settings.ts --file data/user-settings/settings.json
//   npx tsx scripts/seed-settings.ts --file … --port 9090 --host 127.0.0.1 --port-set
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeAppSettings } from '../shared/app-settings'
import { DEFAULT_SETTINGS, SETTINGS_VERSION, type AppSettings } from '../shared/types'
import { isFiniteNumber, isRecord } from '../shared/validation'

/** Exact document install.sh wrote on v0.3.4. The server rejected it. */
export const V034_INSTALLER_STUB = {
  settingsVersion: 6,
  server: { port: 8686, host: '0.0.0.0' }
}

export type SeedAction = 'created' | 'repaired' | 'updated' | 'kept'

export interface SeedOptions {
  port?: number
  host?: string
  portSet?: boolean
  hostSet?: boolean
}

export interface SeedResult {
  action: SeedAction
  settings: AppSettings | Record<string, unknown>
}

export function isValidPort(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 1 && value <= 65_535
}

export function isValidHost(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 255
}

/**
 * A file the installer may leave alone: valid bind fields and an auth object.
 * Omitted auth is bootable after 0.3.5, but still incomplete — --repair heals it.
 */
export function isCompleteSettings(value: unknown): boolean {
  if (!isRecord(value)) return false
  const server = value['server']
  if (!isRecord(server) || !isValidPort(server['port']) || !isValidHost(server['host'])) {
    return false
  }
  return isRecord(value['auth'])
}

function resolvedPort(rawServer: Record<string, unknown> | null, options: SeedOptions): number {
  if (options.portSet && isValidPort(options.port)) return options.port
  if (rawServer && isValidPort(rawServer['port'])) return rawServer['port']
  if (isValidPort(options.port)) return options.port
  return DEFAULT_SETTINGS.server.port
}

function resolvedHost(rawServer: Record<string, unknown> | null, options: SeedOptions): string {
  if (options.hostSet && isValidHost(options.host)) return options.host
  if (rawServer && isValidHost(rawServer['host'])) return rawServer['host']
  if (isValidHost(options.host)) return options.host
  return DEFAULT_SETTINGS.server.host
}

/**
 * Build the document to write. `raw` is null when the file is missing.
 * Throws on a present value that is not a JSON object (corrupt, not "empty").
 */
export function seedSettingsDocument(raw: unknown, options: SeedOptions = {}): SeedResult {
  if (raw == null) {
    const settings = normalizeAppSettings({
      settingsVersion: SETTINGS_VERSION,
      server: {
        ...DEFAULT_SETTINGS.server,
        port: resolvedPort(null, options),
        host: resolvedHost(null, options)
      }
    })
    return { action: 'created', settings }
  }
  if (!isRecord(raw)) {
    throw new Error('settings must be a JSON object')
  }

  if (!isCompleteSettings(raw)) {
    const server = isRecord(raw['server']) ? raw['server'] : {}
    const settings = normalizeAppSettings({
      ...raw,
      server: {
        ...server,
        port: resolvedPort(server, options),
        host: resolvedHost(server, options)
      }
    })
    return { action: 'repaired', settings }
  }

  if (options.portSet || options.hostSet) {
    const server = isRecord(raw['server']) ? { ...raw['server'] } : {}
    if (options.portSet) server['port'] = resolvedPort(server, options)
    if (options.hostSet) server['host'] = resolvedHost(server, options)
    return { action: 'updated', settings: { ...raw, server } }
  }

  return { action: 'kept', settings: raw }
}

function chmodQuiet(file: string, mode: number): void {
  try {
    chmodSync(file, mode)
  } catch {
    // Windows and some mounts do not implement POSIX modes.
  }
}

export function seedSettingsFile(file: string, options: SeedOptions = {}): SeedResult {
  if (!existsSync(file)) {
    const { action, settings } = seedSettingsDocument(null, options)
    writeSettingsFile(file, settings)
    return { action, settings }
  }

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot read settings "${file}": unreadable (${detail})`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot load settings "${file}": invalid (${detail})`)
  }

  const { action, settings } = seedSettingsDocument(raw, options)
  if (action !== 'kept') writeSettingsFile(file, settings)
  return { action, settings }
}

function writeSettingsFile(file: string, settings: AppSettings | Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true })
  chmodQuiet(dirname(file), 0o700)
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  chmodQuiet(file, 0o600)
}

interface CliOptions extends SeedOptions {
  file: string
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    file: '',
    port: undefined,
    host: undefined,
    portSet: false,
    hostSet: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--file' && next) {
      options.file = next
      i += 1
    } else if (arg === '--port' && next) {
      options.port = Number.parseInt(next, 10)
      i += 1
    } else if (arg === '--host' && next) {
      options.host = next
      i += 1
    } else if (arg === '--port-set') {
      options.portSet = true
    } else if (arg === '--host-set') {
      options.hostSet = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!options.file) throw new Error('--file is required')
  return options
}

function isMain(): boolean {
  const invoked = process.argv[1] ?? ''
  return invoked.includes('seed-settings.ts') && process.argv.includes('--file')
}

if (isMain()) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const { action } = seedSettingsFile(options.file, options)
    process.stdout.write(`${action}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`ERROR: ${detail}\n`)
    process.exit(1)
  }
}
