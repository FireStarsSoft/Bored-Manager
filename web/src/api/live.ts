import type { LiveEvent } from "../types";

export type LiveState = "connecting" | "live" | "reconnecting" | "offline";

export interface LiveEventsOptions {
  cursor: string;
  onEvent(event: LiveEvent): void;
  onState(state: LiveState): void;
  onResync(reason: string): Promise<string> | string;
}

export class LiveEventsClient {
  private socket?: WebSocket;
  private closed = false;
  private retry = 0;
  private reconnectTimer?: number;

  constructor(private readonly url?: string) {}

  connect(options: LiveEventsOptions): () => void {
    this.closed = false;
    let cursor = options.cursor;

    const open = () => {
      if (this.closed) return;
      options.onState(this.retry ? "reconnecting" : "connecting");
      const base = this.url || `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/v1/events`;
      const socket = new WebSocket(`${base}?cursor=${encodeURIComponent(cursor)}`);
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.retry = 0;
        options.onState("live");
      });
      socket.addEventListener("message", async (message) => {
        try {
          const event = JSON.parse(String(message.data)) as LiveEvent;
          if (event.type === "resync_required") {
            options.onEvent(event);
            cursor = await options.onResync(event.reason);
            socket.close(4000, "resync complete");
            return;
          }
          cursor = event.cursor;
          options.onEvent(event);
        } catch {
          cursor = await options.onResync("invalid_event");
          socket.close(4000, "invalid event");
        }
      });
      socket.addEventListener("close", () => {
        if (this.closed) return;
        options.onState("reconnecting");
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.retry++, 5));
        this.reconnectTimer = window.setTimeout(open, delay);
      });
      socket.addEventListener("error", () => socket.close());
    };

    open();
    return () => {
      this.closed = true;
      if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
      this.socket?.close(1000, "page closed");
      options.onState("offline");
    };
  }
}
