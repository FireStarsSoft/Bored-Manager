import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'

export class FakeWebSocket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  terminated = false
  readonly sent: string[] = []
  readonly closes: Array<{ code: number; reason: string }> = []

  send(data: unknown): void {
    this.sent.push(String(data))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.closes.push({ code, reason })
    this.emit('close', code, Buffer.from(reason))
  }

  emitJson(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false)
  }

  emitRaw(value: string): void {
    this.emit('message', Buffer.from(value), false)
  }

  emitBinary(value: Buffer): void {
    this.emit('message', value, true)
  }

  terminate(): void {
    this.terminated = true
    this.close(1006, '')
  }

  frames(): unknown[] {
    return this.sent.map((text) => JSON.parse(text) as unknown)
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket
  }
}
