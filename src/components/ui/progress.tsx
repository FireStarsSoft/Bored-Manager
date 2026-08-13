import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      {/* Project addition: Radix reports value={null} as indeterminate, which
          upstream renders as a permanently empty bar. A download with no
          content-length has to look like it is doing something. */}
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full flex-1 bg-primary transition-all data-[state=indeterminate]:w-1/3 data-[state=indeterminate]:animate-pulse"
        style={value == null ? undefined : { transform: `translateX(-${100 - value}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
