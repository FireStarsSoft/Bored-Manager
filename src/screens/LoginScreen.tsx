import * as React from 'react'
import { Loader2, Lock, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * The login form, shown when the server requires one and this browser has no
 * session.
 *
 * The browser is never asked to remember the password: the field is emptied on
 * every attempt and marked as a new password so no manager offers to fill it.
 * Only the username is kept, and only as a convenience for typing.
 */

const LAST_USERNAME_KEY = 'bm.lastUsername'

export function LoginScreen(): React.JSX.Element {
  const boot = useApp((s) => s.boot)
  const locked = useApp((s) => s.auth?.locked === true)

  const [username, setUsername] = React.useState(
    () => localStorage.getItem(LAST_USERNAME_KEY) ?? ''
  )
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [isLocked, setIsLocked] = React.useState(locked)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    try {
      const result = await api.auth.login(username.trim(), password)
      setPassword('')
      if (result.locked) {
        setIsLocked(true)
        return
      }
      if (!result.ok) {
        const left = result.remaining
        setError(
          left === undefined
            ? (result.error ?? 'Wrong username or password')
            : `Wrong username or password (${left} ${left === 1 ? 'attempt' : 'attempts'} left)`
        )
        return
      }
      localStorage.setItem(LAST_USERNAME_KEY, username.trim())
      await boot()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">
            Bored <span className="text-metric-gpu">Manager</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to continue</p>
        </div>

        {isLocked ? (
          <Card className="p-4">
            <Alert variant="destructive">
              <ShieldAlert aria-hidden />
              <AlertTitle>The WebUI is locked</AlertTitle>
              <AlertDescription>
                <p>
                  Too many wrong passwords. Run this in a terminal on the machine that runs Bored
                  Manager to unlock it:
                </p>
                <div className="mono mt-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs">
                  ./bored-manager unlock
                </div>
              </AlertDescription>
            </Alert>
            <Button
              className="mt-4 w-full"
              variant="secondary"
              onClick={() => {
                setIsLocked(false)
                setError('')
              }}
            >
              Try again
            </Button>
          </Card>
        ) : (
          <Card className="p-4">
            <form onSubmit={(e) => void submit(e)} autoComplete="off" className="flex flex-col gap-2.5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-username">Username</Label>
                <Input
                  id="login-username"
                  name="bm-username"
                  autoComplete="off"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-password">Password</Label>
                <Input
                  id="login-password"
                  name="bm-password"
                  type="password"
                  // Not "current-password": no manager should keep this one.
                  autoComplete="new-password"
                  aria-invalid={Boolean(error)}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={busy || !username.trim() || !password}
              >
                {busy ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Lock aria-hidden />
                )}
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
            <p className="mt-3 text-xs text-muted-foreground">
              The password is never stored in this browser - it has to be typed every time.
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}
