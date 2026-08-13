import * as React from 'react'
import { useApp } from '@/state/store'
import { ConnectScreen } from '@/screens/ConnectScreen'
import { Dashboard } from '@/screens/Dashboard'
import { LoginScreen } from '@/screens/LoginScreen'
import { cn } from '@/lib/utils'

export default function App(): React.JSX.Element {
  const init = useApp((s) => s.init)
  const settings = useApp((s) => s.settings)
  const server = useApp((s) => s.server)
  const auth = useApp((s) => s.auth)
  const connected = useApp((s) => s.status.connected)
  const notice = useApp((s) => s.notice)

  React.useEffect(() => {
    void init()
  }, [init])

  const needsLogin = auth?.authEnabled === true && !auth.authenticated

  // Nothing can be rendered before the server answered, and the app is not
  // usable while the socket is down - so say which of the two is happening
  // rather than showing a dashboard that silently stopped updating.
  if (!settings && !needsLogin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <div>{server === 'open' ? 'Loading…' : 'Connecting to the server…'}</div>
        {server === 'closed' && (
          <div className="text-xs">
            {location.host} is not answering. Retrying automatically.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="relative h-full">
      <div className="pointer-events-none absolute left-1/2 top-3 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
        {server !== 'open' && !needsLogin && (
          <div className="rounded-md border border-warn/40 bg-warn/15 px-4 py-2 text-sm text-warn shadow-xl">
            Reconnecting to the server…
          </div>
        )}
        {notice && (
          <div
            className={cn(
              'rounded-md border px-4 py-2 text-sm shadow-xl',
              notice.kind === 'error'
                ? 'border-bad/40 bg-bad/15 text-bad'
                : 'border-accent/40 bg-accent/15 text-accent'
            )}
          >
            {notice.text}
          </div>
        )}
      </div>
      {needsLogin ? <LoginScreen /> : connected ? <Dashboard /> : <ConnectScreen />}
    </div>
  )
}
