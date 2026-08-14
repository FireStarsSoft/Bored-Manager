import * as React from 'react'
import type { ModuleValidation } from '@shared/modules'
import { CHECK_ICON, CheckList } from '@/components/check-list'

function ModuleChecks({ validation }: { validation: ModuleValidation }): React.JSX.Element {
  const label =
    validation.status === 'pass' ? 'PASS' : validation.status === 'warning' ? 'WARNING' : 'ERROR'
  const tone =
    validation.status === 'pass' ? 'text-success' : validation.status === 'warning' ? 'text-warning' : 'text-destructive'
  return (
    <div className="rounded-md border border-border bg-muted/50 p-2.5">
      <div className="mb-2 flex items-center gap-2 border-b border-border pb-2">
        {CHECK_ICON[validation.status === 'pass' ? 'pass' : validation.status]}
        <span className={`text-sm ${tone}`}>{label}</span>
        <span className="ml-auto min-w-0 truncate mono text-xs text-muted-foreground">
          {validation.moduleName ?? '?'}{' '}
          {validation.installedVersion
            ? `${validation.installedVersion} -> ${validation.newVersion ?? '?'}`
            : (validation.newVersion ?? '')}
        </span>
      </div>
      <CheckList items={validation.checks} />
    </div>
  )
}

export { ModuleChecks }
