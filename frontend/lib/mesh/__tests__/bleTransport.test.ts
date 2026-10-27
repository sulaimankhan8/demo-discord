// Tests for BleLinkTransport against a fake native plugin. Two fake "phones" are wired together
// so frames written on one arrive on the other, the way the real plugin delivers them.

import { describe, expect, it } from "vitest";
import { fromBase64, randomBytes, toBase64 } from "../bytes";
import { createIdentity } from "../identity";
import { MeshService } from "../MeshService";
import { BleLinkTransport, type BleMeshPlugin, type BleMeshState } from "../transports/BleLinkTransport";
import { TransportError } from "../transports/LinkTransport";

type Handler = (e: never) => void;

class FakePlugin {
  handlers = new Map<string, Set<Handler>>();
  granted = true;
  startError: { code: string; message: string } | null = null;
  started = false;
  peer: FakePlugin | null = null;
  sent: { linkId: string; data: string }[] = [];

  async ensurePermissions() {
    return { granted: this.granted };
  }
  async start() {
    if (this.startError) throw Object.assign(new Error(this.startError.message), { code: this.startError.code });
    this.started = true;
  }
  async stop() {
    this.started = false;
  }
  async send(o: { linkId: string; data: string }) {
    this.sent.push(o);
    // Deliver to the peer on its link back to us.
    queueMicrotask(() => this.peer?.emit("data", { linkId: "c:peer", data: o.data }));
    return { queued: true };
  }
  async getState(): Promise<BleMeshState> {
    return { running: this.started, bluetoothOn: true, advertising: true, scanning: true, links: [] };
  }
  async enableBluetooth() {}
  async addListener(event: string, cb: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(cb);
    return { remove: async () => void this.handlers.get(event)?.delete(cb) };
  }
  emit(event: string, payload: unknown) {
    for (const h of this.handlers.get(event) ?? []) (h as (e: unknown) => void)(payload);
  }
  listenerCount() {
    return [...this.handlers.values()].reduce((n, s) => n + s.size, 0);
  }
}

const asPlugin = (p: FakePlugin) => p as unknown as BleMeshPlugin;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("base64", () => {
  it("round-trips bytes, including large frames", () => {
    for (const n of [0, 1, 2, 3, 180, 512, 60_000]) {
      const b = randomBytes(n);
      expect(fromBase64(toBase64(b))).toEqual(b);
    }
  });

  it("returns null for invalid input", () => {
    expect(fromBase64("***")).toBeNull();
  });
});

describe("BleLinkTransport", () => {
  it("turns plugin events into link events and sends frames as base64", async () => {
    const fake = new FakePlugin();
    const transport = new BleLinkTransport(asPlugin(fake));
    const ups: string[] = [];
    const frames: Uint8Array[] = [];
    const notices: (string | null)[] = [];
    await transport.start({
      linkUp: (l) => ups.push(`${l.linkId}:${l.maxFrameBytes}`),
      linkDown: () => {},
      data: (_l, f) => frames.push(f),
      notice: (n) => notices.push(n?.code ?? null),
    });

    fake.emit("linkUp", { linkId: "c:AA", maxFrameBytes: 244, role: "central" });
    fake.emit("data", { linkId: "c:AA", data: toBase64(Uint8Array.of(0, 1, 2)) });
    fake.emit("state", { running: true, bluetoothOn: false, advertising: false, scanning: false, links: [] });
    fake.emit("state", { running: true, bluetoothOn: true, advertising: true, scanning: true, links: [] });
    transport.send("c:AA", Uint8Array.of(9, 8, 7));

    expect(ups).toEqual(["c:AA:244"]);
    expect(frames).toEqual([Uint8Array.of(0, 1, 2)]);
    expect(notices).toEqual(["bluetooth_off", null]);
    expect(fake.sent).toEqual([{ linkId: "c:AA", data: toBase64(Uint8Array.of(9, 8, 7)) }]);

    await transport.stop();
    expect(fake.listenerCount()).toBe(0);
  });

  it("fails with a clear error when permission is denied", async () => {
    const fake = new FakePlugin();
    fake.granted = false;
    const err = await new BleLinkTransport(asPlugin(fake))
      .start({ linkUp() {}, linkDown() {}, data() {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.code).toBe("permission");
  });

  it("reports Bluetooth being off and cleans up its listeners", async () => {
    const fake = new FakePlugin();
    fake.startError = { code: "BLUETOOTH_OFF", message: "Bluetooth is off." };
    const err = await new BleLinkTransport(asPlugin(fake))
      .start({ linkUp() {}, linkDown() {}, data() {} })
      .catch((e) => e);
    expect(err.code).toBe("bluetooth_off");
    expect(fake.listenerCount()).toBe(0);
  });

  it("puts the error into the mesh state so the page can offer a fix", async () => {
    const fake = new FakePlugin();
    fake.startError = { code: "BLUETOOTH_OFF", message: "Bluetooth is off." };
    const service = new MeshService({
      transport: new BleLinkTransport(asPlugin(fake)),
      identity: createIdentity(),
      nickname: "a",
      announceIntervalMs: 0,
    });
    await service.start();
    expect(service.getSnapshot().status).toBe("error");
    expect(service.getSnapshot().errorCode).toBe("bluetooth_off");
  });

  it("lets two phones chat over the plugin", async () => {
    const a = new FakePlugin();
    const b = new FakePlugin();
    a.peer = b;
    b.peer = a;
    const make = (p: FakePlugin, name: string) =>
      new MeshService({
        transport: new BleLinkTransport(asPlugin(p)),
        identity: createIdentity(),
        nickname: name,
        announceIntervalMs: 0,
        relayJitterMs: [0, 0],
      });
    const alice = make(a, "alice");
    const bob = make(b, "bob");
    await alice.start();
    await bob.start();

    // Both sides see one link; the fake routes every send to the other phone.
    a.emit("linkUp", { linkId: "c:peer", maxFrameBytes: 180, role: "central" });
    b.emit("linkUp", { linkId: "c:peer", maxFrameBytes: 180, role: "peripheral" });
    await flush();

    alice.sendText("hi bob, no internet here");
    await flush();
    await flush();

    const got = bob.getSnapshot().messages.find((m) => m.text === "hi bob, no internet here");
    expect(got?.nickname).toBe("alice");
    expect(got?.hops).toBe(1);
    expect(bob.getSnapshot().peers.map((p) => p.nickname)).toContain("alice");
  });
});
