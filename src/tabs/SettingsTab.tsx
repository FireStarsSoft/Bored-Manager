import * as React from 'react'
import {
  Boxes,
  Database,
  Download,
  Info,
  LayoutGrid,
  Server,
  SlidersHorizontal,
  type LucideIcon
} from 'lucide-react'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AboutCard } from './settings/AboutCard'
import { BackupCard } from './settings/BackupCard'
import { CollectionCard } from './settings/CollectionCard'
import { DataStorageCard } from './settings/DataStorageCard'
import { DisplayCard } from './settings/DisplayCard'
import { IntervalsCard } from './settings/IntervalsCard'
import { ModulesCard } from './settings/ModulesCard'
import { OverviewCardsCard } from './settings/OverviewCardsCard'
import { ServerUsersCard } from './settings/ServerUsersCard'
import { SoftwareUpdateCard } from './settings/SoftwareUpdateCard'

/**
 * The Settings page shell: a list of sections on the left and one section at a
 * time on the right.
 *
 * The cards used to sit in a two-column grid, which left holes wherever a tall
 * card (Modules, Server & users) stood next to a short one, and gave no clue
 * where anything was. One section at a time means every card can be full width
 * and read top to bottom.
 */

interface Section {
  id: string
  label: string
  icon: LucideIcon
  render(): React.JSX.Element
}

const SECTIONS: Section[] = [
  {
    id: 'general',
    label: 'General',
    icon: SlidersHorizontal,
    render: () => (
      <>
        <DisplayCard />
        <IntervalsCard />
        <CollectionCard />
      </>
    )
  },
  {
    id: 'overview',
    label: 'Overview cards',
    icon: LayoutGrid,
    render: () => <OverviewCardsCard />
  },
  { id: 'modules', label: 'Modules', icon: Boxes, render: () => <ModulesCard /> },
  {
    id: 'data',
    label: 'Data & storage',
    icon: Database,
    render: () => (
      <>
        <DataStorageCard />
        <BackupCard />
      </>
    )
  },
  { id: 'server', label: 'Server & users', icon: Server, render: () => <ServerUsersCard /> },
  { id: 'update', label: 'Software update', icon: Download, render: () => <SoftwareUpdateCard /> },
  { id: 'about', label: 'About', icon: Info, render: () => <AboutCard /> }
]

export function SettingsTab(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const [sectionId, setSectionId] = React.useState(SECTIONS[0].id)

  if (!settings) return <div className="p-4 text-muted-foreground">Loading…</div>

  const section = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0]

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Below md the sections scroll sideways above the content instead. */}
      <nav
        aria-label="Settings sections"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 md:w-44 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r"
      >
        {SECTIONS.map((s) => {
          const Icon = s.icon
          const current = s.id === section.id
          return (
            <Button
              key={s.id}
              variant={current ? 'secondary' : 'ghost'}
              size="sm"
              aria-current={current ? 'page' : undefined}
              className={cn('shrink-0 md:w-full md:justify-start', !current && 'text-muted-foreground')}
              onClick={() => setSectionId(s.id)}
            >
              <Icon aria-hidden />
              {s.label}
            </Button>
          )
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex max-w-3xl flex-col gap-3">{section.render()}</div>
      </div>
    </div>
  )
}
