import {
  SETTINGS_VERSION,
  USERNAME_PATTERN,
  type ConnectionConfig,
  type HistoryStream,
  type PkgAction,
  type TerminalPreset
} from '@shared/types'
import { HISTORY_STREAM_PATTERN, moduleIdProblem } from '@shared/modules'
import { isFiniteNumber, isRecord } from '@shared/validation'
import { ValidationError } from './errors'

const TERMINAL_PRESETS = new Set<TerminalPreset>([
  'shell',
  'nvidia-smi',
  'glances',
  'lazydocker',
  'custom'
])
const PACKAGE_ACTIONS = new Set<PkgAction>([
  'update',
  'upgradeAll',
  'upgrade',
  'install',
  'remove',
  'purge',
  'autoremove'
])
const PACKAGE_TARGET_ACTIONS = new Set<PkgAction>(['upgrade', 'install', 'remove', 'purge'])
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+._:@-]*$/
const TERMINAL_ID_PATTERN = /^term-[1-9]\d{0,15}$/
const MAX_DATE_MS = 8_640_000_000_000_000
const MAX_HISTORY_RANGE_MS = 366 * 24 * 60 * 60 * 1000

function invalid(message: string): never {
  throw new ValidationError(message)
}

export function boundedString(
  value: unknown,
  label: string,
  maxBytes: number,
  options: { allowEmpty?: boolean; trim?: boolean } = {}
): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`)
  const text = options.trim ? value.trim() : value
  if (options.allowEmpty === false && text.length === 0) invalid(`${label} cannot be empty`)
  if (text.includes('\0') || Buffer.byteLength(text, 'utf8') > maxBytes) {
    invalid(`${label} is too long or contains invalid data`)
  }
  return text
}

function finiteInteger(
  value: unknown,
  label: string,
  min: number,
  max: number
): number {
  if (!isFiniteNumber(value) || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${label} must be an integer from ${min} to ${max}`)
  }
  return value
}

export function validateConnectionConfig(value: unknown): ConnectionConfig {
  if (!isRecord(value)) invalid('connection settings must be an object')
  if (value['acceptHostKey'] !== undefined) {
    invalid('acceptHostKey is not supported; confirm the exact host-key challenge')
  }
  const mode = value['mode']
  if (mode !== 'local' && mode !== 'ssh') invalid('connection mode must be local or ssh')
  const optional = (key: string, maxBytes: number): string | undefined => {
    const candidate = value[key]
    return candidate === undefined ? undefined : boundedString(candidate, key, maxBytes)
  }
  const port =
    value['port'] === undefined ? undefined : finiteInteger(value['port'], 'port', 1, 65_535)
  const optionalBoolean = (key: string): boolean | undefined => {
    const candidate = value[key]
    if (candidate === undefined) return undefined
    if (typeof candidate !== 'boolean') invalid(`${key} must be boolean`)
    return candidate
  }
  let hostKeyConfirmation: ConnectionConfig['hostKeyConfirmation']
  if (value['hostKeyConfirmation'] !== undefined) {
    const raw = value['hostKeyConfirmation']
    if (!isRecord(raw)) invalid('hostKeyConfirmation must be an object')
    const fingerprint = boundedString(raw['fingerprint'], 'host key fingerprint', 64, {
      allowEmpty: false,
      trim: true
    }).toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) invalid('host key fingerprint is invalid')
    hostKeyConfirmation = {
      fingerprint,
      token: boundedString(raw['token'], 'host key confirmation token', 128, {
        allowEmpty: false,
        trim: true
      })
    }
  }
  const config: ConnectionConfig = {
    mode,
    label: optional('label', 256),
    host: optional('host', 253),
    port,
    username: optional('username', 256),
    password: optional('password', 4096),
    privateKeyPath: optional('privateKeyPath', 4096),
    sudoPassword: optional('sudoPassword', 4096),
    rememberPassword: optionalBoolean('rememberPassword'),
    hostKeyConfirmation
  }
  if (mode === 'ssh' && (!config.host?.trim() || !config.username?.trim())) {
    invalid('SSH host and username are required')
  }
  return config
}

export function validateOpaqueId(value: unknown, label: string, maxBytes = 512): string {
  return boundedString(value, label, maxBytes, { allowEmpty: false })
}

export function validateMachineId(value: unknown): string {
  const id = validateOpaqueId(value, 'machine id')
  if (!/^[A-Za-z0-9._@-]+$/.test(id)) invalid('machine id is invalid')
  return id
}

export function validateHistoryQuery(
  stream: unknown,
  fromMs: unknown,
  toMs: unknown,
  maxPoints: unknown
): [HistoryStream, number, number, number] {
  if (typeof stream !== 'string' || !HISTORY_STREAM_PATTERN.test(stream)) {
    invalid('history stream is invalid')
  }
  if (
    !isFiniteNumber(fromMs) ||
    !isFiniteNumber(toMs) ||
    fromMs < 0 ||
    toMs < 0 ||
    fromMs > MAX_DATE_MS ||
    toMs > MAX_DATE_MS
  ) {
    invalid('history range must contain finite timestamps')
  }
  if (toMs < fromMs || toMs - fromMs > MAX_HISTORY_RANGE_MS) {
    invalid('history range is invalid or too large')
  }
  let points = 600
  if (maxPoints !== undefined) {
    if (!isFiniteNumber(maxPoints)) invalid('maxPoints must be finite')
    points = Math.min(2_000, Math.max(1, Math.trunc(maxPoints)))
  }
  return [stream, fromMs, toMs, points]
}

export function validateTerminalCreate(
  preset: unknown,
  cols: unknown,
  rows: unknown,
  customCommand: unknown
): [TerminalPreset, number, number, string | undefined] {
  if (typeof preset !== 'string' || !TERMINAL_PRESETS.has(preset as TerminalPreset)) {
    invalid('terminal preset is invalid')
  }
  const command =
    customCommand === undefined
      ? undefined
      : boundedString(customCommand, 'custom command', 4096, { allowEmpty: true })
  return [
    preset as TerminalPreset,
    finiteInteger(cols, 'terminal columns', 20, 500),
    finiteInteger(rows, 'terminal rows', 5, 200),
    command
  ]
}

export function validateTerminalId(value: unknown): string {
  if (typeof value !== 'string' || !TERMINAL_ID_PATTERN.test(value)) {
    invalid('terminal id is invalid')
  }
  return value
}

export function validateTerminalData(value: unknown): string {
  return boundedString(value, 'terminal data', 64 * 1024)
}

export function validateTerminalSize(cols: unknown, rows: unknown): [number, number] {
  return [
    finiteInteger(cols, 'terminal columns', 20, 500),
    finiteInteger(rows, 'terminal rows', 5, 200)
  ]
}

export function validatePackageQuery(value: unknown): string {
  return boundedString(value, 'package query', 100, { trim: true })
}

export function validatePackageAction(
  action: unknown,
  pkg: unknown
): [PkgAction, string | undefined] {
  if (typeof action !== 'string' || !PACKAGE_ACTIONS.has(action as PkgAction)) {
    invalid('package action is invalid')
  }
  const typed = action as PkgAction
  if (pkg === undefined) {
    if (PACKAGE_TARGET_ACTIONS.has(typed)) invalid('this package action requires a package name')
    return [typed, undefined]
  }
  const name = boundedString(pkg, 'package name', 256, { allowEmpty: false, trim: true })
  if (!PACKAGE_NAME_PATTERN.test(name)) invalid('package name is invalid')
  if (!PACKAGE_TARGET_ACTIONS.has(typed)) invalid('this package action does not accept a package name')
  return [typed, name]
}

export function validateModuleId(value: unknown): string {
  const problem = moduleIdProblem(value)
  if (problem) invalid(`module id is invalid: ${problem}`)
  return value as string
}

export function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`)
  return value
}

export function validateModuleSource(value: unknown): string {
  const source = boundedString(value, 'module source', 8192, {
    allowEmpty: false,
    trim: true
  })
  if (source.includes('://')) validateHttpsUrl(source, 'module URL')
  return source
}

export function validateHttpsUrl(value: unknown, label = 'update URL'): string {
  const text = boundedString(value, label, 8192, { allowEmpty: false, trim: true })
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    invalid(`${label} is not a valid URL`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    invalid(`${label} must be an HTTPS URL without credentials`)
  }
  return text
}

export function validateActiveTab(value: unknown): string | null {
  if (value === null) return null
  return boundedString(value, 'active tab', 256, { allowEmpty: false })
}

export function validateSlowTarget(value: unknown): string {
  const target = boundedString(value, 'refresh target', 128, {
    allowEmpty: false,
    trim: true
  })
  if (!/^[a-z][a-z0-9-]*$/.test(target)) invalid('refresh target is invalid')
  return target
}

export function validateUserPasswordInput(
  value: unknown,
  options: { password?: boolean } = { password: true }
): { username: string; password?: string } {
  if (!isRecord(value)) invalid('user input must be an object')
  const username = boundedString(value['username'], 'username', 32, {
    allowEmpty: false,
    trim: true
  })
  if (!USERNAME_PATTERN.test(username)) invalid('username is invalid')
  if (options.password === false) return { username }
  const password = boundedString(value['password'], 'password', 4096, { allowEmpty: false })
  return { username, password }
}

export function validateEnabledInput(value: unknown): boolean {
  if (!isRecord(value)) invalid('enabled input must be an object')
  return validateBoolean(value['enabled'], 'enabled')
}

export function validateCurrentSettingsEnvelope(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value['settingsVersion'] !== SETTINGS_VERSION) {
    invalid(`settings payload must use version ${SETTINGS_VERSION}`)
  }
  return value
}
