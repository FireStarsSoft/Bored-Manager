import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  wide
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  children: React.ReactNode
  wide?: boolean
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-card shadow-2xl focus:outline-none',
            wide ? 'max-w-3xl' : 'max-w-md'
          )}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <DialogPrimitive.Title className="text-sm font-semibold text-fg">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button className="text-muted hover:text-fg cursor-pointer" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </DialogPrimitive.Close>
          </div>
          <div className="overflow-y-auto p-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** Full-height panel on the right - a table row's detail, rather than a centered dialog. */
export function Drawer({
  open,
  onOpenChange,
  title,
  children
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card shadow-2xl focus:outline-none">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <DialogPrimitive.Title className="text-sm font-semibold text-fg">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button className="text-muted hover:text-fg cursor-pointer" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = 'Confirm',
  destructive = true,
  onConfirm
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  message: React.ReactNode
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <div className="text-sm text-muted">{message}</div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant={destructive ? 'destructive' : 'default'}
          onClick={() => {
            onOpenChange(false)
            onConfirm()
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}
