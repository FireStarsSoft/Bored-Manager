import * as React from 'react'
import { Loader2, Monitor, Server, Trash2 } from 'lucide-react'
import type { SavedConnection } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export function ConnectScreen(): React.JSX.Element {
  const connect = useApp((s) => s.connect)
  const connecting = useApp((s) => s.connecting)
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

  const loadSaved = React.useCallback(async () => {
    setSaved(await api.connection.listSaved())
  }, [])

  React.useEffect(() => {
    void loadSaved()
  }, [loadSaved])

  React.useEffect(() => {
    void api.app.info().then((info) => {
      setPlatform(info.platform)
      if (info.platform === 'win32') setMode('ssh')
    })
  }, [])

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

  const submit = async (): Promise<void> => {
    setError('')
    if (mode === 'ssh' && (!host.trim() || !username.trim())) {
      setError('Host and username are required for SSH')
      return
    }
    const ok = await connect({
      mode,
      host: host.trim(),
      port: parseInt(port, 10) || 22,
      username: username.trim(),
      password: password || undefined,
      privateKeyPath: keyPath.trim() || undefined,
      sudoPassword: sudoPassword || undefined,
      rememberPassword: remember
    })
    if (ok) void loadSaved()
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">
            Bored <span className="text-gpu">Manager</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Monitor Linux processes, network, disk, packages, NVIDIA GPU and Docker
          </p>
        </div>

        <Card className="p-4">
          <div className="mb-4 grid grid-cols-2 gap-2">
            <button
              onClick={() => !isWindows && setMode('local')}
              disabled={isWindows}
              className={cn(
                'flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors cursor-pointer',
                mode === 'local'
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-muted hover:text-fg',
                isWindows && 'cursor-not-allowed opacity-40'
              )}
              title={isWindows ? 'Local mode requires running on Linux' : undefined}
            >
              <Monitor className="h-4 w-4" /> Local machine
            </button>
            <button
              onClick={() => setMode('ssh')}
              className={cn(
                'flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors cursor-pointer',
                mode === 'ssh'
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-muted hover:text-fg'
              )}
            >
              <Server className="h-4 w-4" /> Remote (SSH)
            </button>
          </div>

          {mode === 'ssh' && (
            <div className="space-y-2.5">
              <div className="grid grid-cols-[1fr_5.5rem] gap-2">
                <Input placeholder="Host (e.g. 192.168.1.10)" value={host} onChange={(e) => setHost(e.target.value)} />
                <Input placeholder="Port" value={port} onChange={(e) => setPort(e.target.value)} />
              </div>
              <Input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
              <Input
                type="password"
                placeholder="Password (or key passphrase)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div>
                <Input
                  placeholder="Private key path (optional)"
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                />
                {/* The key is read by the server, so the path is one on the
                    host - not on the machine the browser runs on. */}
                <div className="mt-1 text-xs text-muted">
                  Path on the server, e.g. <span className="mono">~/.ssh/id_ed25519</span>
                </div>
              </div>
            </div>
          )}

          <div className="mt-2.5">
            <Input
              type="password"
              placeholder="Sudo password (optional - needed for GPU controls, kill as root)"
              value={sudoPassword}
              onChange={(e) => setSudoPassword(e.target.value)}
            />
          </div>

          {mode === 'ssh' && (
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              Remember passwords (encrypted on the server with data/secret.key)
            </label>
          )}

          {error && (
            <div className="mt-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
              {error}
            </div>
          )}

          <Button className="mt-4 w-full" size="lg" onClick={() => void submit()} disabled={connecting}>
            {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
        </Card>

        {saved.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Recent connections
            </div>
            <div className="space-y-1.5">
              {saved.map((c) => (
                <Card
                  key={c.id}
                  className="flex cursor-pointer items-center justify-between px-3 py-2 hover:bg-card-hover"
                  onClick={() => void fillFromSaved(c)}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm">{c.label}</div>
                    <div className="truncate text-xs text-muted">
                      {c.username}@{c.host}:{c.port}
                      {c.hasSavedPassword ? ' · saved password' : ''}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={async (e) => {
                      e.stopPropagation()
                      setSaved(await api.connection.deleteSaved(c.id))
                    }}
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
