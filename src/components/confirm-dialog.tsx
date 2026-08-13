import * as React from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

/**
 * Most destructive actions here need the same shape - a title, a sentence about
 * what is about to happen and one button that does it - so they share this
 * rather than each assembling an AlertDialog.
 */
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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{message}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
