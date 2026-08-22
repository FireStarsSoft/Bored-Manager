import * as React from 'react'
import { AlertTriangle, RefreshCw, Save, UserPlus } from 'lucide-react'
import type { SessionIdleUnit, UserAccount } from '@shared/types'
import { DEFAULT_USERNAME, isOpenBind } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { DataTable } from '@/components/data-table'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SelectField } from '@/components/select-field'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/lib/utils'
import { IDLE_UNITS } from './options'
import { PasswordDialog, accountColumns } from './server-users-dialogs'

/**
 * Where the WebUI listens, whether it asks for a login, and who may log in.
 *
 * Everything here is about the server itself rather than the machine it
 * watches, which is why it is one card: turning the login on is only safe once
 * an account has a password, so the two live next to each other.
 */
function ServerUsersCard(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const setSettingsFull = useApp((s) => s.setSettingsFull)
  const showNotice = useApp((s) => s.showNotice)
  const auth = useApp((s) => s.auth)
  const adoptSession = useApp((s) => s.adoptSession)
  const requireLogin = useApp((s) => s.requireLogin)

  const [portDraft, setPortDraft] = React.useState('')
  const [hostDraft, setHostDraft] = React.useState('')
  const [allowedHostsDraft, setAllowedHostsDraft] = React.useState('')
  const [trustProxyDraft, setTrustProxyDraft] = React.useState(false)
  const [restartNeeded, setRestartNeeded] = React.useState(false)
  const [users, setUsers] = React.useState<UserAccount[] | null>(null)
  const [newUser, setNewUser] = React.useState({ username: '', password: '' })
  const [passwordFor, setPasswordFor] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<string | null>(null)
  /** Set when enabling the login is waiting for the admin password. */
  const [adminPasswordPrompt, setAdminPasswordPrompt] = React.useState(false)

  const server = settings?.server
  React.useEffect(() => {
    if (!server) return
    setPortDraft(String(server.port))
    setHostDraft(server.host)
    setAllowedHostsDraft(server.allowedHosts.join(', '))
    setTrustProxyDraft(server.trustProxy)
  }, [server?.port, server?.host, server?.allowedHosts, server?.trustProxy]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadUsers = React.useCallback(async () => {
    try {
      setUsers(await api.auth.users())
    } catch (err) {
      showNotice('error', `Could not read the accounts: ${errorMessage(err)}`)
    }
  }, [showNotice])

  React.useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  const columns = React.useMemo(
    () => accountColumns(auth?.username, setPasswordFor, setDeleting),
    [auth?.username]
  )

  if (!settings || !server) return <></>

  const listening = settings.auth
  const idle = listening.sessionIdle
  // The default account ships without one, so this is the normal first-run
  // state - and the reason "Require login" cannot be switched on yet.
  const passwordless = (users ?? []).filter((u) => !u.hasPassword).map((u) => u.username)

  const saveServer = async (): Promise<void> => {
    const port = parseInt(portDraft, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      showNotice('error', 'The port has to be a number between 1 and 65535')
      setPortDraft(String(server.port))
      return
    }
    const allowedHosts = allowedHostsDraft
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean)
    const saved = await updateSettings({
      server: {
        port,
        host: hostDraft.trim(),
        allowedHosts,
        trustProxy: trustProxyDraft
      }
    })
    setPortDraft(String(saved.server.port))
    setHostDraft(saved.server.host)
    setAllowedHostsDraft(saved.server.allowedHosts.join(', '))
    setTrustProxyDraft(saved.server.trustProxy)
    if (saved.restartRequired) {
      setRestartNeeded(true)
      showNotice('info', 'Restart the server for the new address to take effect')
    } else {
      showNotice('info', 'Saved')
    }
  }

  /**
   * Switching the login on ends this browser's free ride too: the socket it is
   * holding was opened without a session, so it is either replaced by one that
   * has (see enableLoginWithPassword below) or the login form is shown straight
   * away - rather than leaving the page up until the next call is refused and
   * reporting that as an expired session.
   */
  const setLoginRequired = async (enabled: boolean): Promise<void> => {
    try {
      const saved = await api.auth.setEnabled(enabled)
      setSettingsFull(saved)
      if (!enabled) {
        showNotice('info', 'A login is no longer required')
        return
      }
      // An earlier session may still be valid, in which case nothing to do.
      const status = await api.auth.status()
      if (status.authenticated) {
        await adoptSession()
        showNotice('info', `A login is now required - you are signed in as ${status.username}`)
        return
      }
      showNotice('info', 'A login is now required')
      requireLogin()
    } catch (err) {
      // The server refuses to lock everyone out of an account with no password.
      if (errorMessage(err).includes('set-admin-password-first')) {
        setAdminPasswordPrompt(true)
        return
      }
      showNotice('error', errorMessage(err))
    }
  }

  /** Set the default account's password, require a login, and use it here. */
  const enableLoginWithPassword = async (password: string): Promise<void> => {
    setUsers(await api.auth.setPassword(DEFAULT_USERNAME, password))
    const saved = await api.auth.setEnabled(true)
    setSettingsFull(saved)
    const login = await api.auth.login(DEFAULT_USERNAME, password)
    if (!login.ok) {
      showNotice('info', 'A login is now required')
      requireLogin()
      return
    }
    await adoptSession()
    showNotice('info', `A login is now required - you are signed in as ${DEFAULT_USERNAME}`)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Server & users</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-xs text-muted-foreground">
          These settings are about the WebUI itself - where it listens and who may open it - not
          about the machine being monitored.
        </div>

        <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="server-port" className="text-xs text-muted-foreground">
              Port
            </Label>
            <Input
              id="server-port"
              value={portDraft}
              inputMode="numeric"
              onChange={(e) => setPortDraft(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="server-host" className="text-xs text-muted-foreground">
              Bind address
            </Label>
            <Input
              id="server-host"
              value={hostDraft}
              onChange={(e) => setHostDraft(e.target.value)}
            />
          </div>
          <Button
            onClick={() => void saveServer()}
            disabled={
              portDraft === String(server.port) &&
              hostDraft === server.host &&
              allowedHostsDraft === server.allowedHosts.join(', ') &&
              trustProxyDraft === server.trustProxy
            }
          >
            <Save className="size-3.5" /> Save
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="mono">0.0.0.0</span> answers on every network interface;{' '}
          <span className="mono">127.0.0.1</span> only on the machine itself.
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="server-allowed-hosts" className="text-xs text-muted-foreground">
            Additional allowed hostnames
          </Label>
          <Input
            id="server-allowed-hosts"
            value={allowedHostsDraft}
            placeholder="manager.example.com, 192.168.1.20"
            onChange={(e) => setAllowedHostsDraft(e.target.value)}
          />
          <div className="text-xs text-muted-foreground">
            Localhost and this machine&apos;s interface addresses are allowed automatically.
            Separate extra DNS names or addresses with commas.
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm">Trust a local reverse proxy</div>
            <div className="text-xs text-muted-foreground">
              Accept forwarded client IP and HTTPS headers only from a proxy on this machine
            </div>
          </div>
          <Switch checked={trustProxyDraft} onCheckedChange={setTrustProxyDraft} />
        </div>

        {!listening.enabled && isOpenBind(server.host) && (
          <Alert variant="destructive">
            <AlertTriangle className="text-destructive" aria-hidden />
            <AlertTitle>Open to the network, no login</AlertTitle>
            <AlertDescription>
              The server answers on every interface and anyone who can reach{' '}
              <span className="mono">http://&lt;ip&gt;:{server.port}</span> has full access.
              Turn on Require login, or bind <span className="mono">127.0.0.1</span> if you only
              need this machine.
            </AlertDescription>
          </Alert>
        )}

        {restartNeeded && (
          <Alert>
            <AlertTriangle className="text-warning" aria-hidden />
            <AlertTitle>The new address is not live yet</AlertTitle>
            <AlertDescription>
              It is only read when the server starts, so the WebUI is still on{' '}
              <span className="mono">{location.host}</span>.
            </AlertDescription>
            <div className="mt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void api.app.restart()
                  showNotice('info', 'Restarting - reopen the WebUI on the new address')
                  setRestartNeeded(false)
                }}
              >
                <RefreshCw aria-hidden /> Restart server
              </Button>
            </div>
          </Alert>
        )}

        <Separator />

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm">Require login</div>
            <div className="text-xs text-muted-foreground">
              Off means anyone who can reach this address has full access
            </div>
          </div>
          <Switch
            checked={listening.enabled}
            onCheckedChange={(v) => void setLoginRequired(v)}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm">Wrong passwords before locking</div>
            <div className="text-xs text-muted-foreground">
              Counted per username and per client address; unlock with{' '}
              <span className="mono">./bored-manager unlock</span> on the host
            </div>
          </div>
          <Input
            value={String(listening.maxFailures)}
            inputMode="numeric"
            className="w-20 shrink-0 text-right"
            onChange={(e) => {
              const value = Math.max(1, parseInt(e.target.value, 10) || 1)
              void updateSettings({ auth: { maxFailures: value } })
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm">Sign out when idle</div>
            <div className="text-xs text-muted-foreground">
              0 = the session never expires. Applies at the next sign-in.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Input
              value={String(idle.value)}
              inputMode="numeric"
              className="w-16 text-right"
              onChange={(e) => {
                const value = Math.max(0, parseInt(e.target.value, 10) || 0)
                void updateSettings({ auth: { sessionIdle: { ...idle, value } } })
              }}
            />
            <SelectField
              value={idle.unit}
              onChange={(v) => void updateSettings({ auth: { sessionIdle: { ...idle, unit: v as SessionIdleUnit } } })}
              options={IDLE_UNITS}
              className="w-28"
            />
          </div>
        </div>

        {/* Accounts */}
        <div className="border-t border-border pt-3">
          <div className="mb-1.5 text-sm font-medium">Accounts</div>
          {passwordless.length > 0 && (
            <Alert className="mb-2">
              <AlertTriangle className="text-warning" aria-hidden />
              <AlertTitle>
                {passwordless.length === 1
                  ? `${passwordless[0]} has no password yet`
                  : `${passwordless.length} accounts have no password yet`}
              </AlertTitle>
              <AlertDescription>
                An account without a password cannot sign in, and a login can only be required once{' '}
                <span className="mono">{DEFAULT_USERNAME}</span> has one.
              </AlertDescription>
              <div className="mt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPasswordFor(passwordless[0])}
                >
                  Set a password for {passwordless[0]}
                </Button>
              </div>
            </Alert>
          )}
          <div className="mb-2 text-xs text-muted-foreground">
            Accounts of the WebUI, not of the host. Each one has its own saved connections;
            deleting an account deletes those with it. Everyone who can sign in can manage
            accounts.
          </div>
          <div className="rounded-md border border-border">
            <DataTable
              data={users ?? []}
              columns={columns}
              getRowId={(u) => u.username}
              initialSorting={[{ id: 'username', desc: false }]}
              emptyText="No accounts yet."
            />
          </div>

          <div className="mt-2 grid grid-cols-[1fr_1fr_auto] gap-2">
            <Input
              placeholder="New username"
              autoComplete="off"
              value={newUser.username}
              onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
            />
            <Input
              type="password"
              placeholder="Password"
              autoComplete="new-password"
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
            />
            <Button
              disabled={!newUser.username.trim() || !newUser.password}
              onClick={() => {
                void api.auth
                  .createUser(newUser.username.trim(), newUser.password)
                  .then((list) => {
                    setUsers(list)
                    setNewUser({ username: '', password: '' })
                    showNotice('info', 'Account created')
                  })
                  .catch((err: unknown) => showNotice('error', errorMessage(err)))
              }}
            >
              <UserPlus className="size-3.5" /> Add
            </Button>
          </div>
        </div>
      </CardContent>

      <PasswordDialog
        open={adminPasswordPrompt}
        title={`Set a password for ${DEFAULT_USERNAME}`}
        hint={`A login can only be required once ${DEFAULT_USERNAME} has a password - otherwise nobody could sign in.`}
        onOpenChange={setAdminPasswordPrompt}
        onSubmit={enableLoginWithPassword}
      />

      <PasswordDialog
        open={passwordFor !== null}
        title={`Change the password of ${passwordFor ?? ''}`}
        onOpenChange={(open) => !open && setPasswordFor(null)}
        onSubmit={async (password) => {
          if (!passwordFor) return
          setUsers(await api.auth.setPassword(passwordFor, password))
          setPasswordFor(null)
          showNotice('info', 'Password changed')
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete account"
        message={
          <>
            Delete <span className="mono">{deleting}</span> and everything it saved, including its
            connections? Anyone signed in as that account is signed out immediately.
          </>
        }
        confirmLabel="Delete"
        onConfirm={() => {
          const username = deleting
          setDeleting(null)
          if (!username) return
          void api.auth
            .deleteUser(username)
            .then((list) => {
              setUsers(list)
              showNotice('info', `${username} deleted`)
            })
            .catch((err: unknown) => showNotice('error', errorMessage(err)))
        }}
      />
    </Card>
  )
}

export { ServerUsersCard }
