import type { TerminalInfo, TerminalPreset } from '@shared/types'
import { api } from './api'
import { useApp } from '@/state/store'

/**
 * Open a PTY on the connected target. The server returns either the new
 * session or `{ ok: false }` - this collapses both shapes into one result.
 */
export async function createTargetTerminal(
  preset: TerminalPreset,
  cols: number,
  rows: number,
  customCommand?: string
): Promise<{ ok: true; info: TerminalInfo } | { ok: false; error: string }> {
  const machineId = useApp.getState().activeMachineId
  if (!machineId) return { ok: false, error: 'No active machine' }
  const res = await api.terminals.create(machineId, preset, cols, rows, customCommand)
  if ('ok' in res && !res.ok) return { ok: false, error: res.error || 'Failed to open the terminal' }
  if (!('id' in res)) return { ok: false, error: 'Failed to open the terminal' }
  return { ok: true, info: res }
}
