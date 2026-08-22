import * as React from 'react'
import { Loader2, WifiOff } from 'lucide-react'
import { useApp } from '@/state/store'
import { ConnectScreen } from '@/screens/ConnectScreen'
import { Dashboard } from '@/screens/Dashboard'
import { LoginScreen } from '@/screens/LoginScreen'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

export default function App(): React.JSX.Element {
  const init = useApp((s) => s.init)
  const retryInit = useApp((s) => s.retryInit)
  const initError = useApp((s) => s.initError)
  const settings = useApp((s) => s.settings)
  const server = useApp((s) => s.server)
  const auth = useApp((s) => s.auth)
  const connected = useApp(
    (s) => s.activeMachineId != null && s.status.connected
  )

  React.useEffect(() => {
    void init()
  }, [init])

  const needsLogin = auth?.authEnabled === true && !auth.authenticated

  // Nothing can be rendered before the server answered, and the app is not
  // usable while the socket is down - so say which of the two is happening
  // rather than showing a dashboard that silently stopped updating.
  if (!settings && !needsLogin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        {initError ? (
          <>
            <div>Could not start the app.</div>
            <div className="max-w-md text-center text-xs">{initError}</div>
            <Button variant="secondary" size="sm" onClick={() => void retryInit()}>
              Retry
            </Button>
          </>
        ) : (
          <>
            <Loader2 className="size-5 animate-spin" aria-hidden />
            <div>{server === 'open' ? 'Loading…' : 'Connecting to the server…'}</div>
            {server === 'closed' && (
              <div className="text-xs">{location.host} is not answering. Retrying automatically.</div>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="relative h-full">
        {server !== 'open' && !needsLogin && (
          <div className="absolute left-1/2 top-3 z-100 w-max max-w-[90vw] -translate-x-1/2">
            <Alert className="shadow-xl">
              <WifiOff className="text-warning" aria-hidden />
              <AlertTitle>Reconnecting to the server…</AlertTitle>
              <AlertDescription>Live readings are paused until it answers.</AlertDescription>
            </Alert>
          </div>
        )}
        {needsLogin ? <LoginScreen /> : connected ? <Dashboard /> : <ConnectScreen />}
      </div>
      <Toaster position="top-center" />
    </TooltipProvider>
  )
}
