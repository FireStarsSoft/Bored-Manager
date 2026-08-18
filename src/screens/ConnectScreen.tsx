import * as React from 'react'
import { Loader2, Monitor, Server, Trash2 } from 'lucide-react'
import type { ConnectionConfig, HostKeyChallenge, SavedConnection } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { errorMessage } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function ConnectScreen(): React.JSX.Element {
  const connect = useApp((s) => s.connect)
  const connecting = useApp((s) => s.connecting)
  const showNotice = useApp((s) => s.showNotice)
  // "Local" means the machine the server runs on, which the browser cannot
  // know by itself - and which is not a Linux box in a dev setup on Windows.
  const [platform, setPlatform] = React.useState<string | null>(null)
  const isWindows = platform === 'win32'

  const [mode, setMode] = React.useState<'local' | 'ssh'>('local')
  const [host, setHost] = React.useState('')
  const [port, setPort] = React.useState('22')
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [keyPath, setKeyPath] = React.useState('')
  const [sudoPassword, setSudoPassword] = React.useState('')
  const [remember, setRemember] = React.useState(true)
  const [error, setError] = React.useState('')
  const [saved, setSaved] = React.useState<SavedConnection[]>([])
  const [hostKey, setHostKey] = React.useState<HostKeyChallenge | null>(null)

  const loadSaved = React.useCallback(async () => {
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
    void api.app.info()
      .then((info) => {
        setPlatform(info.platform)
        if (info.platform === 'win32') setMode('ssh')
      })
      .catch((err) => showNotice('error', errorMessage(err)))
  }, [showNotice])

  const fillFromSaved = async (c: SavedConnection): Promise<void> => {
    setMode('ssh')
    setHost(c.host)
    setPort(String(c.port))
    setUsername(c.username)
    setPassword('')
    setSudoPassword('')
    if (c.hasSavedPassword) {
      const creds = await api.connection.getCredentials(c.id)
      if (creds?.password) setPassword(creds.password)
      if (creds?.sudoPassword) setSudoPassword(creds.sudoPassword)
    }
  }

  const submit = async (acceptHostKey = false): Promise<void> => {
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
      acceptHostKey: acceptHostKey || undefined
    }
    const res = await connect(cfg)
    if (res.hostKey) {
      setHostKey(res.hostKey)
      return
    }
    if (res.ok) void loadSaved()
  }

  const localOption = (
    <ToggleGroupItem value="local" disabled={isWindows} size="lg" className="flex-1">
      <Monitor aria-hidden /> Local machine
    </ToggleGroupItem>
  )

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-background p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">
            Bored <span className="text-metric-gpu">Manager</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Monitor Linux processes, network, disk, packages, NVIDIA GPU and containers
          </p>
        </div>

        <Card className="p-4">
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(e) => {
              e.preventDefault()
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
                    <Label htmlFor="connect-host">Host</Label>
                    <Input
                      id="connect-host"
                      placeholder="e.g. 192.168.1.10"
                      autoComplete="off"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="connect-port">Port</Label>
                    <Input
                      id="connect-port"
                      inputMode="numeric"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="connect-username">Username</Label>
                  <Input
                    id="connect-username"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="connect-password">Password or key passphrase</Label>
                  <Input
                    id="connect-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="connect-key">Private key path (optional)</Label>
                  <Input
                    id="connect-key"
                    aria-describedby="connect-key-hint"
                    value={keyPath}
                    onChange={(e) => setKeyPath(e.target.value)}
                  />
                  {/* The key is read by the server, so the path is one on the
                      host - not on the machine the browser runs on. */}
                  <div id="connect-key-hint" className="text-xs text-muted-foreground">
                    Path on the server, e.g. <span className="mono">~/.ssh/id_ed25519</span>
                  </div>
                </div>
              </>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="connect-sudo">Sudo password (optional)</Label>
              <Input
                id="connect-sudo"
                type="password"
                aria-describedby="connect-sudo-hint"
                autoComplete="off"
                value={sudoPassword}
                onChange={(e) => setSudoPassword(e.target.value)}
              />
              <div id="connect-sudo-hint" className="text-xs text-muted-foreground">
                Needed for GPU controls and killing another user's process.
              </div>
            </div>

            {mode === 'ssh' && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="connect-remember"
                  checked={remember}
                  onCheckedChange={(v) => setRemember(v === true)}
                />
                <Label htmlFor="connect-remember" className="text-xs text-muted-foreground">
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
        </Card>

        {saved.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recent connections
            </div>
            <div className="flex flex-col gap-1.5">
              {saved.map((c) => (
                <Card key={c.id} className="flex flex-row items-center gap-1 p-1 pl-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded-md py-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    onClick={() => void fillFromSaved(c)}
                  >
                    <div className="truncate text-sm">{c.label}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.username}@{c.host}:{c.port}
                      {c.hasSavedPassword ? ' · saved password' : ''}
                    </div>
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${c.label}`}
                        onClick={async () => {
                          setSaved(await api.connection.deleteSaved(c.id))
                        }}
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
          open={hostKey != null}
          onOpenChange={(open) => !open && setHostKey(null)}
          title={hostKey?.kind === 'changed' ? 'SSH host key changed' : 'Unknown SSH host key'}
          confirmLabel="Trust this host"
          destructive={hostKey?.kind === 'changed'}
          message={
            hostKey && (
              <>
                {hostKey.kind === 'changed'
                  ? 'The key this machine presented is not the one stored from last time. Someone may be intercepting the connection.'
                  : 'This is the first time this app has seen this host. Compare the fingerprint with the machine before trusting it.'}
                <div className="mt-2 font-medium">
                  {hostKey.host}:{hostKey.port}
                </div>
                <div className="mt-1 break-all font-mono text-xs">SHA256:{hostKey.fingerprint}</div>
              </>
            )
          }
          onConfirm={() => {
            setHostKey(null)
            void submit(true)
          }}
        />
      </div>
    </div>
  )
}
