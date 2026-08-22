import * as React from 'react'
import { api } from '@/lib/api'

export const HIDDEN_TAB_GRACE_MS = 30_000

type TabGetter = () => string

let documentVisible = typeof document === 'undefined' || !document.hidden
let serverSuspended = false
let started = false
let hiddenTimer: ReturnType<typeof setTimeout> | null = null
let activeTab: TabGetter = () => 'overview'
const listeners = new Set<() => void>()

function publishVisibility(next: boolean): void {
  if (documentVisible === next) return
  documentVisible = next
  for (const listener of [...listeners]) listener()
}

function clearHiddenTimer(): void {
  if (!hiddenTimer) return
  clearTimeout(hiddenTimer)
  hiddenTimer = null
}

function suspendAfterGrace(): void {
  clearHiddenTimer()
  hiddenTimer = setTimeout(() => {
    hiddenTimer = null
    if (typeof document === 'undefined' || !document.hidden) return
    serverSuspended = true
    api.ui.setActiveTab(null)
  }, HIDDEN_TAB_GRACE_MS)
}

/**
 * Report a UI route without accidentally waking tab-gated server collectors
 * after the browser has already advertised that it is hidden.
 */
export function reportActiveTab(tab: string): void {
  api.ui.setActiveTab(serverSuspended ? null : tab)
}

/**
 * Start the one document-level watcher. Hidden renderer timers stop
 * immediately; the server gets a grace period so a quick app switch does not
 * churn remote collectors.
 */
export function startDocumentVisibilityTracking(getActiveTab: TabGetter): () => void {
  activeTab = getActiveTab
  if (started || typeof document === 'undefined') return () => {}
  started = true

  const onVisibilityChange = (): void => {
    const visible = !document.hidden
    publishVisibility(visible)
    if (!visible) {
      suspendAfterGrace()
      return
    }
    clearHiddenTimer()
    if (serverSuspended) {
      serverSuspended = false
      api.ui.setActiveTab(activeTab())
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  onVisibilityChange()

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    clearHiddenTimer()
    started = false
    serverSuspended = false
    publishVisibility(!document.hidden)
  }
}

export function useDocumentVisible(): boolean {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => documentVisible,
    () => true
  )
}
