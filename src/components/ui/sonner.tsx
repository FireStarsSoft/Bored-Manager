import { Toaster as Sonner, type ToasterProps } from 'sonner'
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon
} from 'lucide-react'
import { useApp } from '@/state/store'

/**
 * Upstream reads the theme from next-themes; this app is not Next.js and keeps
 * the colour scheme in its own settings, so it is read from there instead.
 */
const Toaster = ({ ...props }: ToasterProps): React.JSX.Element => {
  const dark = useApp((s) => s.dark)

  return (
    <Sonner
      theme={dark ? 'dark' : 'light'}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" aria-hidden />,
        info: <InfoIcon className="size-4" aria-hidden />,
        warning: <TriangleAlertIcon className="size-4" aria-hidden />,
        error: <OctagonXIcon className="size-4" aria-hidden />,
        loading: <Loader2Icon className="size-4 animate-spin" aria-hidden />
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)'
        } as React.CSSProperties
      }
      toastOptions={{ classNames: { toast: 'cn-toast' } }}
      {...props}
    />
  )
}

export { Toaster }
