import * as React from 'react'
import { Button } from '@/components/ui/button'

/** Shared helpers for the Settings cards in this folder. */

/**
 * A Button that opens the browser's file picker. Files now travel from the
 * device the UI runs on to the server, so there is no host file dialog to open
 * any more - only a hidden <input type="file">, which has to stay in the DOM
 * for the click to count as a user gesture.
 */
function FilePickerButton({
  accept,
  label,
  icon,
  disabled,
  onPick
}: {
  accept: string
  label: string
  icon: React.ReactNode
  disabled?: boolean
  onPick: (file: File) => void
}): React.JSX.Element {
  const input = React.useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Reset first: picking the same file twice must fire again.
          e.target.value = ''
          if (file) onPick(file)
        }}
      />
      <Button variant="secondary" disabled={disabled} onClick={() => input.current?.click()}>
        {icon} {label}
      </Button>
    </>
  )
}
/** An absolute timestamp for a "last written / fetched at" line. */
function timeLabel(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : '—'
}

export { FilePickerButton, timeLabel }
