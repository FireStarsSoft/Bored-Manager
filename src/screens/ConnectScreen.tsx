import * as React from 'react'
import { ConnectForm } from '@/components/connect-form'
import { useApp } from '@/state/store'

export function ConnectScreen(): React.JSX.Element | null {
  const hasConnectedActiveMachine = useApp(
    (state) =>
      state.activeMachineId != null &&
      state.machines.some(
        (machine) => machine.machineId === state.activeMachineId && machine.connected
      )
  )

  if (hasConnectedActiveMachine) return null

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-background p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">
            Bored <span className="text-metric-gpu">Manager</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Monitor Linux processes, network, disk, packages, GPU and containers
          </p>
        </div>

        <ConnectForm />
      </div>
    </div>
  )
}
