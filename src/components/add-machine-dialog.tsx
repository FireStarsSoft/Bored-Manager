import * as React from 'react'
import type { SessionMachine } from '@/state/store'
import { ConnectForm } from '@/components/connect-form'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

export interface AddMachineDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial?: SessionMachine
}

export function AddMachineDialog({
  open,
  onOpenChange,
  initial
}: AddMachineDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add machine</DialogTitle>
          <DialogDescription>
            Connect another local or remote Linux machine to this dashboard.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ConnectForm
            compact
            initial={initial}
            onConnected={() => onOpenChange(false)}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
