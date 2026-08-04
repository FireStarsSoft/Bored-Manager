import { LiveEventsClient, type LiveState } from "./live";

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  constructor(url: string) { super(); this.url = url; FakeWebSocket.instances.push(this); }
  close() { this.dispatchEvent(new CloseEvent("close")); }
  open() { this.dispatchEvent(new Event("open")); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

describe("LiveEventsClient", () => {
  test("requests a REST resync when the server reports an expired cursor", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const states: LiveState[] = [];
    const resync = vi.fn().mockResolvedValue("42");
    const stop = new LiveEventsClient("ws://manager.test/api/v1/events").connect({ cursor: "12", onEvent: vi.fn(), onState: (state) => states.push(state), onResync: resync });
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toContain("cursor=12");
    socket.open();
    socket.message({ type: "resync_required", reason: "cursor_expired" });
    await vi.runAllTimersAsync();
    expect(resync).toHaveBeenCalledWith("cursor_expired");
    expect(states).toContain("live");
    stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
