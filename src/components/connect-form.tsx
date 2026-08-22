import * as React from 'react'
import { Loader2, Monitor, RotateCw, Server, Trash2 } from 'lucide-react'
import type {
  ConnectionConfig,
  ConnectionResult,
  HostKeyChallenge,
  SavedConnection
} from '@shared/types'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/utils'
import { useApp, type SessionMachine } from '@/state/store'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type PendingHostKey =
  | { action: 'connect'; challenge: HostKeyChallenge }
  | { action: 'reconnect'; challenge: HostKeyChallenge; saved: SavedConnection }

export interface ConnectFormProps {
  onConnected?: (machineId: string) => void
  initial?: SessionMachine
  /** Removes the outer card so the form can sit naturally in a dialog. */
  compact?: boolean
}

export function ConnectForm({
  onConnected,
  initial,
  compact = false
}: ConnectFormProps): React.JSX.Element {
  const connect = useApp((s) => s.connect)
  const reconnect = useApp((s) => s.reconnect)
  const connecting = useApp((s) => s.connecting)
  const showNotice = useApp((s) => s.showNotice)
  const fieldPrefix = React.useId()

  // "Local" means the machine the server runs on, which the browser cannot
  // know by itself - and which is not a Linux box in a dev setup on Windows.
  const [platform, setPlatform] = React.useState<string | null>(null)
  const isWindows = platform === 'win32'

  const [mode, setMode] = React.useState<'local' | 'ssh'>(initial?.mode ?? 'local')
  const [host, setHost] = React.useState(initial?.host ?? '')
  const [port, setPort] = React.useState(String(initial?.port ?? 22))
  const [username, setUsername] = React.useState(initial?.username ?? '')
  const [password, setPassword] = React.useState('')
  const [keyPath, setKeyPath] = React.useState('')
  const [sudoPassword, setSudoPassword] = React.useState('')
  const [remember, setRemember] = React.useState(true)
  const [error, setError] = React.useState('')
  const [saved, setSaved] = React.useState<SavedConnection[]>([])
  const [pendingHostKey, setPendingHostKey] = React.useState<PendingHostKey | null>(null)
  const [reconnectingId, setReconnectingId] = React.useState<string | null>(null)

  const fieldId = (name: string): string => `${fieldPrefix}-${name}`

  const loadSaved = React.useCallback(async (): Promise<void> => {
    try {
      setSaved(await api.connection.listSaved())
    } catch (err) {
      showNotice('error', errorMessage(err))
    }
  }, [showNotice])

  React.useEffect(() => {
    void loadSaved()
  }, [loadSaved])

  React.useEffect(() => {
    void api.app
      .info()
      .then((info) => {
        setPlatform(info.platform)
        if (info.platform === 'win32') setMode('ssh')
      })
      .catch((err) => showNotice('error', errorMessage(err)))
  }, [showNotice])

  React.useEffect(() => {
    if (!initial) return

    let cancelled = false
    setMode(initial.mode)
    setHost(initial.host ?? '')
    setPort(String(initial.port ?? 22))
    setUsername(initial.username ?? '')
    setPassword('')
    setKeyPath('')
    setSudoPassword('')
    setRemember(true)
    setError('')

    if (initial.savedId) {
      void api.connection
        .getCredentials(initial.savedId)
        .then((credentials) => {
          if (cancelled || !credentials) return
          setPassword(credentials.password ?? '')
          setSudoPassword(credentials.sudoPassword ?? '')
        })
        .catch((err) => {
          if (!cancelled) showNotice('error', errorMessage(err))
        })
    }

    return () => {
      cancelled = true
    }
  }, [initial, showNotice])

  const fillFromSaved = async (connection: SavedConnection): Promise<void> => {
    setMode('ssh')
    setHost(connection.host)
    setPort(String(connection.port))
    setUsername(connection.username)
    setPassword('')
    setKeyPath('')
    setSudoPassword('')
    setRemember(true)
    setError('')

    if (!connection.hasSavedPassword) return
    try {
      const credentials = await api.connection.getCredentials(connection.id)
      if (credentials?.password) setPassword(credentials.password)
      if (credentials?.sudoPassword) setSudoPassword(credentials.sudoPassword)
    } catch (err) {
      showNotice('error', errorMessage(err))
    }
  }

  const reportConnected = React.useCallback(
    (result: ConnectionResult): void => {
      if (!result.ok) return
      const machineId = result.machineId ?? useApp.getState().activeMachineId
      if (machineId) onConnected?.(machineId)
    },
    [onConnected]
  )

  const submit = async (confirmedHostKey?: HostKeyChallenge): Promise<void> => {
    setError('')
    if (mode === 'ssh' && (!host.trim() || !username.trim())) {
      setError('Host and username are required for SSH')
      return
    }

    const cfg: ConnectionConfig = {
      mode,
      host: host.trim(),
      port: parseInt(port, 10) || 22,
      username: username.trim(),
      password: password || undefined,
      privateKeyPath: keyPath.trim() || undefined,
      sudoPassword: sudoPassword || undefined,
      rememberPassword: remember,
      hostKeyConfirmation: confirmedHostKey
        ? {
            fingerprint: confirmedHostKey.fingerprint,
            token: confirmedHostKey.token
          }
        : undefined
    }

    try {
      const result = await connect(cfg)
      if (result.hostKey) {
        setPendingHostKey({ action: 'connect', challenge: result.hostKey })
        return
      }
      if (result.needsCredentials) {
        setError('Enter credentials to connect to this machine.')
        return
      }
      if (result.ok) {
        await loadSaved()
        reportConnected(result)
      }
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const reconnectSaved = async (
    connection: SavedConnection,
    confirmedHostKey?: HostKeyChallenge
  ): Promise<void> => {
    setError('')
    setReconnectingId(connection.id)
    try {
      const result = await reconnect(
        connection.id,
        confirmedHostKey
          ? {
              fingerprint: confirmedHostKey.fingerprint,
              token: confirmedHostKey.token
            }
          : undefined
      )
      if (result.hostKey) {
        setPendingHostKey({
          action: 'reconnect',
          challenge: result.hostKey,
          saved: connection
        })
        return
      }
      if (result.needsCredentials) {
        await fillFromSaved(connection)
        setError('Enter credentials to reconnect to this machine.')
        return
      }
      if (result.ok) {
        await loadSaved()
        reportConnected(result)
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setReconnectingId(null)
    }
  }

  const removeSaved = async (connection: SavedConnection): Promise<void> => {
    try {
      setSaved(await api.connection.deleteSaved(connection.id))
    } catch (err) {
      showNotice('error', errorMessage(err))
    }
  }

  const localOption = (
    <ToggleGroupItem value="local" disabled={isWindows} size="lg" className="flex-1">
      <Monitor aria-hidden /> Local machine
    </ToggleGroupItem>
  )

  const form = (
    <form
      className={compact ? 'flex flex-col gap-2' : 'flex flex-col gap-2.5'}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <ToggleGroup
        type="single"
        variant="outline"
        value={mode}
        onValueChange={(next) => next && setMode(next as 'local' | 'ssh')}
        aria-label="Where to monitor"
        className="w-full"
      >
        {isWindows ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex flex-1">{localOption}</span>
            </TooltipTrigger>
            <TooltipContent>Local mode requires running on Linux</TooltipContent>
          </Tooltip>
        ) : (
          localOption
        )}
        <ToggleGroupItem value="ssh" size="lg" className="flex-1">
          <Server aria-hidden /> Remote (SSH)
        </ToggleGroupItem>
      </ToggleGroup>

      {mode === 'ssh' && (
        <>
          <div className="grid grid-cols-[1fr_5.5rem] gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={fieldId('host')}>Host</Label>
              <Input
                id={fieldId('host')}
                placeholder="e.g. 192.168.1.10"
                autoComplete="off"
                value={host}
                onChange={(event) => setHost(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={fieldId('port')}>Port</Label>
              <Input
                id={fieldId('port')}
                inputMode="numeric"
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId('username')}>Username</Label>
            <Input
              id={fieldId('username')}
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId('password')}>Password or key passphrase</Label>
            <Input
              id={fieldId('password')}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId('key')}>Private key path (optional)</Label>
            <Input
              id={fieldId('key')}
              aria-describedby={fieldId('key-hint')}
              value={keyPath}
              onChange={(event) => setKeyPath(event.target.value)}
            />
            {/* The key is read by the server, so the path is one on the
                host - not on the machine the browser runs on. */}
            <div id={fieldId('key-hint')} className="text-xs text-muted-foreground">
              Path on the server, e.g. <span className="mono">~/.ssh/id_ed25519</span>
            </div>
          </div>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId('sudo')}>Sudo password (optional)</Label>
        <Input
          id={fieldId('sudo')}
          type="password"
          aria-describedby={fieldId('sudo-hint')}
          autoComplete="off"
          value={sudoPassword}
          onChange={(event) => setSudoPassword(event.target.value)}
        />
        <div id={fieldId('sudo-hint')} className="text-xs text-muted-foreground">
          Needed for GPU controls and killing another user's process.
        </div>
      </div>

      {mode === 'ssh' && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={fieldId('remember')}
            checked={remember}
            onCheckedChange={(value) => setRemember(value === true)}
          />
          <Label htmlFor={fieldId('remember')} className="text-xs text-muted-foreground">
            Remember passwords (encrypted on the server with data/secret.key)
          </Label>
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="mt-1 w-full" size="lg" disabled={connecting}>
        {connecting && <Loader2 className="animate-spin" aria-hidden />}
        {connecting ? 'Connecting…' : 'Connect'}
      </Button>
    </form>
  )

  const challenge = pendingHostKey?.challenge

  return (
    <div className="w-full">
      {compact ? form : <Card className="p-4">{form}</Card>}

      {saved.length > 0 && (
        <div className={compact ? 'mt-3' : 'mt-4'}>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent connections
          </div>
          <div className="flex flex-col gap-1.5">
            {saved.map((connection) => (
              <Card
                key={connection.id}
                className="flex flex-row items-center gap-1 p-1 pl-3"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-md py-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() => void fillFromSaved(connection)}
                >
                  <div className="truncate text-sm">{connection.label}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {connection.username}@{connection.host}:{connection.port}
                    {connection.hasSavedPassword ? ' · saved password' : ''}
                  </div>
                </button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Connect to ${connection.label}`}
                      disabled={connecting}
                      onClick={() => void reconnectSaved(connection)}
                    >
                      {reconnectingId === connection.id ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <RotateCw aria-hidden />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Connect</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${connection.label}`}
                      disabled={connecting}
                      onClick={() => void removeSaved(connection)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove</TooltipContent>
                </Tooltip>
              </Card>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={challenge != null}
        onOpenChange={(open) => !open && setPendingHostKey(null)}
        title={challenge?.kind === 'changed' ? 'SSH host key changed' : 'Unknown SSH host key'}
        confirmLabel="Trust this host"
        destructive={challenge?.kind === 'changed'}
        message={
          challenge && (
            <>
              {challenge.kind === 'changed'
                ? 'The key this machine presented is not the one stored from last time. Someone may be intercepting the connection.'
                : 'This is the first time this app has seen this host. Compare the fingerprint with the machine before trusting it.'}
              <div className="mt-2 font-medium">
                {challenge.host}:{challenge.port}
              </div>
              <div className="mt-1 break-all font-mono text-xs">
                SHA256:{challenge.fingerprint}
              </div>
            </>
          )
        }
        onConfirm={() => {
          const pending = pendingHostKey
          setPendingHostKey(null)
          if (!pending) return
          if (pending.action === 'reconnect') {
            void reconnectSaved(pending.saved, pending.challenge)
          } else {
            void submit(pending.challenge)
          }
        }}
      />
    </div>
  )
}
