import * as React from 'react'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'

export interface PaletteEntry {
  route: string
  label: string
  /** Module name for a module page, or the app section for a built-in one. */
  group: string
  icon: React.ReactNode
}

/** What to print on the button that opens it, on this device. */
export const PALETTE_SHORTCUT = /Mac|iPhone|iPad|iPod/.test(
  navigator.platform || navigator.userAgent
)
  ? '⌘ K'
  : 'Ctrl K'

/** Set while the palette is mounted; see openCommandPalette below. */
let openFromOutside: (() => void) | null = null

/**
 * Ctrl/Cmd+K jump list over every page the sidebar can reach. With a dozen
 * module pages nested behind dropdowns, typing the name is faster than finding
 * it - and it is the only way to reach a page on a narrow screen without
 * opening the drawer first.
 */
export function CommandPalette({
  entries,
  onSelect
}: {
  entries: PaletteEntry[]
  onSelect: (route: string) => void
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    openFromOutside = () => setOpen(true)
    return () => {
      window.removeEventListener('keydown', onKey)
      openFromOutside = null
    }
  }, [])

  const groups = React.useMemo(() => {
    const byGroup = new Map<string, PaletteEntry[]>()
    for (const entry of entries) {
      const list = byGroup.get(entry.group)
      if (list) list.push(entry)
      else byGroup.set(entry.group, [entry])
    }
    return [...byGroup.entries()]
  }, [entries])

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Go to page">
      <Command>
        <CommandInput placeholder="Go to page…" />
        <CommandList>
          <CommandEmpty>No page matches.</CommandEmpty>
          {groups.map(([group, items]) => (
            <CommandGroup key={group} heading={group}>
              {items.map((item) => (
                <CommandItem
                  key={item.route}
                  value={`${group} ${item.label}`}
                  onSelect={() => {
                    onSelect(item.route)
                    setOpen(false)
                  }}
                >
                  {item.icon}
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

/** Opens the palette from a click, for people who do not know the shortcut. */
export function openCommandPalette(): void {
  openFromOutside?.()
}
