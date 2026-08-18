import * as React from 'react'
import type { Block, PageSpec, WidgetSpec } from '@shared/module-ui'
import { useApp } from '@/state/store'
import { DragHandle } from '@/components/SectionCard'
import { useHistoryWindow } from '@/components/WindowPicker'
import { SectionBlockView } from './blocks/SectionBlock'
import { StatBlockView } from './blocks/StatBlock'
import { MeterBlockView } from './blocks/MeterBlock'
import { ChartBlockView } from './blocks/ChartBlock'
import { KeyValueBlockView } from './blocks/KeyValueBlock'
import { ListBlockView } from './blocks/ListBlock'
import { ConditionalBlockView } from './blocks/ConditionalBlock'
import { TableBlockView } from './blocks/TableBlock'
import { StatusCardsBlockView } from './blocks/StatusCardsBlock'
import { LogBlockView } from './blocks/LogBlock'
import { TerminalBlockView } from './blocks/TerminalBlock'
import { ActionsBlockView } from './blocks/ActionsBlock'
import { FormBlockView } from './blocks/FormBlock'
import { CheckFormBlockView } from './blocks/CheckFormBlock'

/**
 * What every block needs to resolve its own data and render at the right
 * size, threaded down through `BlockList` so a nested block (inside a
 * `section` or `conditional`) sees the same page/widget it is part of.
 */
export interface BlockCtx {
  moduleId: string
  /** False while the page/widget is not the one on screen - gates `invoke` polling. */
  visible: boolean
  /** Chart window in seconds a `chart` block falls back to when it has none of its own. */
  windowSec: number
  /** Widget-sized (Sparkline, tighter spacing) vs page-sized (DetailChart). */
  compact: boolean
  /** The open row, for blocks rendered inside a table's `rowDetail` drawer - a `path`/arg of `"$row.<key>"` reads from it. */
  scope?: unknown
}

function BlockView({ block, ctx }: { block: Block; ctx: BlockCtx }): React.JSX.Element | null {
  switch (block.type) {
    case 'section':
      return <SectionBlockView block={block} ctx={ctx} />
    case 'stat':
      return <StatBlockView block={block} ctx={ctx} />
    case 'meter':
      return <MeterBlockView block={block} ctx={ctx} />
    case 'chart':
      return <ChartBlockView block={block} ctx={ctx} />
    case 'keyValue':
      return <KeyValueBlockView block={block} ctx={ctx} />
    case 'list':
      return <ListBlockView block={block} ctx={ctx} />
    case 'conditional':
      return <ConditionalBlockView block={block} ctx={ctx} />
    case 'table':
      return <TableBlockView block={block} ctx={ctx} />
    case 'statusCards':
      return <StatusCardsBlockView block={block} ctx={ctx} />
    case 'log':
      return <LogBlockView block={block} ctx={ctx} />
    case 'terminal':
      return <TerminalBlockView block={block} ctx={ctx} />
    case 'actions':
      return <ActionsBlockView block={block} ctx={ctx} />
    case 'form':
      return <FormBlockView block={block} ctx={ctx} />
    case 'checkForm':
      return <CheckFormBlockView block={block} ctx={ctx} />
    default:
      return null
  }
}

interface BoundaryState {
  error: Error | null
}

interface BoundaryProps {
  children: React.ReactNode
  /** Names what failed, so the message says which module the user should look at. */
  what: string
}

/**
 * Keeps a throw inside whatever it wraps. Used at two depths: around every
 * block, so one broken card does not blank its page, and around a module's
 * whole page and widget, so a spec the block switch cannot even get into
 * (a bad `blocks` array, a throw while resolving the window) takes down that
 * module's surface rather than the app around it.
 */
class ModuleErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error(`[BlockRenderer] ${this.props.what} failed to render:`, error)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
          {this.props.what} failed to render: {this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}

/** Renders a block array, each one isolated so a broken block cannot blank the rest. */
function blockKey(block: Block, index: number): string {
  const t = typeof block === 'object' && block !== null && 'type' in block ? String(block.type) : 'block'
  return `${t}-${index}`
}

export function BlockList({ blocks, ctx }: { blocks: Block[]; ctx: BlockCtx }): React.JSX.Element {
  return (
    <>
      {blocks.map((block, i) => (
        <ModuleErrorBoundary key={blockKey(block, i)} what="This block">
          <BlockView block={block} ctx={ctx} />
        </ModuleErrorBoundary>
      ))}
    </>
  )
}

/** A module's sidebar page, built entirely from its `ui/pages/<id>.json`. */
export function ModulePage({
  moduleId,
  pageId,
  spec,
  visible
}: {
  moduleId: string
  pageId: string
  spec: PageSpec
  visible: boolean
}): React.JSX.Element {
  const [windowSec] = useHistoryWindow()
  const ctx: BlockCtx = { moduleId, visible, windowSec, compact: false }
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="grid grid-cols-1 gap-3">
        <ModuleErrorBoundary what={`Page "${moduleId}/${pageId}"`}>
          <BlockList blocks={spec.blocks} ctx={ctx} />
        </ModuleErrorBoundary>
      </div>
    </div>
  )
}

/** A module's Overview card, built entirely from its `ui/widgets/<id>.json`. */
export function ModuleWidget({
  moduleId,
  widgetId,
  spec,
  visible = true
}: {
  moduleId: string
  widgetId: string
  spec: WidgetSpec
  visible?: boolean
}): React.JSX.Element {
  const overviewWindow = useApp((s) => s.overviewWindow)
  const ctx: BlockCtx = {
    moduleId,
    visible,
    windowSec: spec.window ?? overviewWindow,
    compact: true
  }
  return (
    <div className="relative">
      {/*
       * The Overview grid can only drag a card by an element matching
       * `.tm-drag-handle` (OverviewGrid's `dragConfig.handle`); no block knows
       * it might end up as a widget's root, so none of them render one. Added
       * once here instead, floated over whatever the spec's own blocks draw.
       * It stays outside the boundary below so a card that failed can still be
       * dragged out of the way.
       */}
      <div className="absolute left-2 top-2 z-10">
        <DragHandle />
      </div>
      <ModuleErrorBoundary what={`Card "${moduleId}.${widgetId}"`}>
        <BlockList blocks={spec.blocks} ctx={ctx} />
      </ModuleErrorBoundary>
    </div>
  )
}
