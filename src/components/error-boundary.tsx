import * as React from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * The last line of defence: a render that throws unmounts the whole tree, and
 * without this the browser is left showing nothing at all - the failure looks
 * like the server died rather than like a bug on one screen.
 *
 * A class is the only way React offers to catch a render error.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The app log lives on the server; the console is all a browser has.
    console.error('the UI crashed', error, info.componentStack)
  }

  render(): React.ReactNode {
    const error = this.state.error
    if (!error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <TriangleAlert className="size-6 text-destructive" aria-hidden />
        <div className="text-sm font-medium">This screen ran into an error</div>
        <div className="mono max-w-lg overflow-x-auto text-xs text-muted-foreground">
          {error.message || String(error)}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => location.reload()}>
            <RefreshCw aria-hidden /> Reload
          </Button>
          <Button variant="outline" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      </div>
    )
  }
}
