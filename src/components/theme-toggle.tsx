import * as React from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { Theme } from '@shared/types'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const OPTIONS: Array<{ value: Theme; label: string; icon: React.ReactNode }> = [
  { value: 'dark', label: 'Dark', icon: <Moon aria-hidden /> },
  { value: 'light', label: 'Light', icon: <Sun aria-hidden /> },
  { value: 'system', label: 'System', icon: <Monitor aria-hidden /> }
]

export function ThemeToggle(): React.JSX.Element {
  const theme = useApp((s) => s.settings?.theme) ?? 'dark'
  const dark = useApp((s) => s.dark)
  const updateSettings = useApp((s) => s.updateSettings)

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Colour scheme">
              {theme === 'system' ? <Monitor aria-hidden /> : dark ? <Moon aria-hidden /> : <Sun aria-hidden />}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Colour scheme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(v) => void updateSettings({ theme: v as Theme })}
        >
          {OPTIONS.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.icon}
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
