import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Project override, two of them:
 *
 * 1. The state variants are `data-[state=…]`, not `data-checked` /
 *    `data-unchecked`. The installed Radix (react-switch 1.3.7) only writes
 *    `data-state="checked|unchecked"`, so the shorthand the CLI generates
 *    matched nothing: the track had no colour in either state and the knob
 *    never moved. Check what the primitive emits before changing these back.
 * 2. On and off differ by more than the track fill. Upstream paints the off
 *    track with `--input`, which in the dark theme is the same value as
 *    `--border` - a dark pill on a dark card. Off is an outlined track with a
 *    grey knob, on a filled primary track with a white one, so the two are
 *    legible in either theme.
 */
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=unchecked]:border-muted-foreground/50 data-[state=unchecked]:bg-muted data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        // A percentage translate resolves against the knob's own width, so one
        // distance is right for both sizes: 16px knob + 14px = the 30px inside
        // a 32px track, 12px + 10px = the 22px inside a 24px one.
        className="pointer-events-none block rounded-full shadow-sm ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-muted-foreground"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
