import * as React from 'react'
import { Trash2 } from 'lucide-react'
import type { UserAccount } from '@shared/types'
import { DEFAULT_USERNAME } from '@shared/types'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import { type DataTableColumns } from '@/components/data-table'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/utils'

export function dateLabel(ms: number | null): string {
  if (!ms) return 'never'
  return new Date(ms).toLocaleString()
}

export function accountColumns(
  currentUsername: string | null | undefined,
  setPasswordFor: (username: string) => void,
  setDeleting: (username: string) => void
): DataTableColumns<UserAccount> {
  return [
    {
      accessorKey: 'username',
      header: 'User',
      cell: (c) => {
        const user = c.row.original
        return (
          <span>
            <span className="mono">{user.username}</span>
            {user.username === currentUsername && (
              <span className="ml-1.5 text-muted-foreground">(you)</span>
            )}
            {!user.hasPassword && <span className="ml-1.5 text-warning">no password yet</span>}
          </span>
        )
      }
    },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      cell: (c) => (
        <span className="text-muted-foreground">{dateLabel(c.getValue<number>())}</span>
      )
    },
    {
      accessorKey: 'lastLoginAt',
      header: 'Last sign-in',
      cell: (c) => (
        <span className="text-muted-foreground">{dateLabel(c.getValue<number | null>())}</span>
      )
    },
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      meta: { align: 'right' },
      cell: (c) => {
        const user = c.row.original
        const isDefault = user.username === DEFAULT_USERNAME
        return (
          <div className="flex justify-end gap-1.5">
            <Button variant="secondary" size="xs" onClick={() => setPasswordFor(user.username)}>
              Change password
            </Button>
            <Tooltip>
              {/* A disabled button emits no pointer events, so the trigger has
                  to be the wrapper for the explanation of *why* it is
                  disabled to be reachable at all. */}
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    variant="destructive"
                    size="icon-xs"
                    aria-label={`Delete ${user.username}`}
                    disabled={isDefault}
                    onClick={() => setDeleting(user.username)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {isDefault
                  ? 'The default account cannot be deleted'
                  : `Delete ${user.username}`}
              </TooltipContent>
            </Tooltip>
          </div>
        )
      }
    }
  ]
}

/** Two fields, so a password cannot be set to something mistyped. */
export function PasswordDialog({
  open,
  title,
  hint,
  onOpenChange,
  onSubmit
}: {
  open: boolean
  title: string
  hint?: string
  onOpenChange: (open: boolean) => void
  onSubmit: (password: string) => Promise<void>
}): React.JSX.Element {
  const showNotice = useApp((s) => s.showNotice)
  const [first, setFirst] = React.useState('')
  const [second, setSecond] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setFirst('')
      setSecond('')
    }
  }, [open])

  const submit = async (): Promise<void> => {
    if (first !== second) return
    setBusy(true)
    try {
      await onSubmit(first)
      onOpenChange(false)
    } catch (err) {
      showNotice('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const mismatch = Boolean(second) && first !== second

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        asChild
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <form>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {hint && <DialogDescription>{hint}</DialogDescription>}
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password-new">New password</Label>
              <Input
                id="password-new"
                type="password"
                autoComplete="new-password"
                autoFocus
                value={first}
                onChange={(e) => setFirst(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password-repeat">Repeat the password</Label>
              <Input
                id="password-repeat"
                type="password"
                autoComplete="new-password"
                aria-invalid={mismatch}
                aria-describedby={mismatch ? 'password-mismatch' : undefined}
                value={second}
                onChange={(e) => setSecond(e.target.value)}
              />
            </div>
            {mismatch && (
              <div id="password-mismatch" role="alert" className="text-xs text-destructive">
                The two passwords are not the same
              </div>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!first || mismatch || busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
