import * as React from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import type { ModuleCheckLevel, ModuleValidation } from '@shared/modules'

const CHECK_ICON: Record<ModuleCheckLevel, React.ReactNode> = {
  pass: <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />,
  info: <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />,
  warning: <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />,
  error: <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
}


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
      <div className="flex flex-col gap-1.5">
        {validation.checks.map((c) => (
          <div key={c.id} className="flex items-start gap-2">
            {CHECK_ICON[c.level]}
            <div className="min-w-0">
              <div className="text-xs">{c.label}</div>
              {c.detail && <div className="break-words text-xs text-muted-foreground">{c.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** README / CHANGELOG of an installed module, as plain text. */
export { CHECK_ICON, ModuleChecks }
