// Bluetooth link transport: the web side of the native BleMesh plugin
// (frontend/android/app/src/main/java/com/demodiscord/app/mesh). The plugin finds nearby phones
// and moves raw frames; this class turns its events into LinkTransport events.

import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { fromBase64, toBase64 } from "../bytes";
import type { BatteryReading, PowerMode } from "../power";
import { TransportError, type LinkTransport, type LinkTransportEvents } from "./LinkTransport";

export interface BleMeshState {
  running: boolean;
  bluetoothOn: boolean;
  advertising: boolean;
  scanning: boolean;
  error?: string;
  links: { linkId: string; role: "central" | "peripheral"; maxFrameBytes: number }[];
  powerMode?: PowerMode;
}

/** What this native build supports beyond links (docs/10 C7). Older builds have none of it. */
export interface BleCapabilities {
  power: boolean;
  battery: boolean;
  storageKey: boolean;
}

const NO_CAPABILITIES: BleCapabilities = { power: false, battery: false, storageKey: false };

export interface BleMeshPlugin {
  ensurePermissions(): Promise<{ granted: boolean }>;
  start(options?: { serviceUuid?: string; characteristicUuid?: string; maxLinks?: number }): Promise<void>;
  stop(): Promise<void>;
  send(options: { linkId: string; data: string }): Promise<{ queued: boolean }>;
  getState(): Promise<BleMeshState>;
  enableBluetooth(): Promise<void>;
  addListener(
    event: "linkUp",
    cb: (e: { linkId: string; maxFrameBytes: number; role: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: "linkDown", cb: (e: { linkId: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "data", cb: (e: { linkId: string; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "state", cb: (e: BleMeshState) => void): Promise<PluginListenerHandle>;
  // Added in C7. Only called after getCapabilities says they exist.
  getCapabilities(): Promise<Partial<BleCapabilities>>;
  setPowerMode(options: { mode: PowerMode; maxLinks: number }): Promise<void>;
  getBattery(): Promise<BatteryReading>;
  getStorageKey(): Promise<{ key: string }>;
  deleteStorageKey(): Promise<void>;
}

let plugin: BleMeshPlugin | null = null;

export function getBleMeshPlugin(): BleMeshPlugin {
  plugin ??= registerPlugin<BleMeshPlugin>("BleMesh");
  return plugin;
}

const ERROR_MESSAGES: Record<string, [string, TransportError["code"]]> = {
  PERMISSION: ["Bluetooth permission is needed to find phones nearby. Allow it in the prompt, or in Settings.", "permission"],
  BLUETOOTH_OFF: ["Bluetooth is off. Turn it on to reach phones nearby.", "bluetooth_off"],
  UNSUPPORTED: ["This phone doesn't support Bluetooth Low Energy, so it can't join the mesh.", "unsupported"],
};

export class BleLinkTransport implements LinkTransport {
  readonly kind = "ble" as const;
  private handles: PluginListenerHandle[] = [];
  private caps: Promise<BleCapabilities> | null = null;

  constructor(private readonly ble: BleMeshPlugin = getBleMeshPlugin()) {}

  /** Asks the native side what it supports. A build without getCapabilities supports nothing extra. */
  capabilities(): Promise<BleCapabilities> {
    this.caps ??= this.ble
      .getCapabilities()
      .then((c) => ({ power: !!c?.power, battery: !!c?.battery, storageKey: !!c?.storageKey }))
      .catch(() => NO_CAPABILITIES);
    return this.caps;
  }

  async setPowerMode(mode: PowerMode, maxLinks: number): Promise<void> {
    if (!(await this.capabilities()).power) return;
    await this.ble.setPowerMode({ mode, maxLinks }).catch(() => {});
  }

  async readBattery(): Promise<BatteryReading | null> {
    if (!(await this.capabilities()).battery) return null;
    return this.ble.getBattery().catch(() => null);
  }

  /** The device storage key from the Keystore/Keychain, or null if this build has none. */
  async storageKey(): Promise<Uint8Array | null> {
    if (!(await this.capabilities()).storageKey) return null;
    try {
      const { key } = await this.ble.getStorageKey();
      const bytes = fromBase64(key);
      return bytes && bytes.length === 32 ? bytes : null;
    } catch {
      return null;
    }
  }

  async deleteStorageKey(): Promise<void> {
    if ((await this.capabilities()).storageKey) await this.ble.deleteStorageKey().catch(() => {});
  }

  async start(events: LinkTransportEvents): Promise<void> {
    const { granted } = await this.ble.ensurePermissions();
    if (!granted) throw new TransportError(ERROR_MESSAGES.PERMISSION[0], "permission");

    this.handles = await Promise.all([
      this.ble.addListener("linkUp", (e) => events.linkUp({ linkId: e.linkId, maxFrameBytes: e.maxFrameBytes })),
      this.ble.addListener("linkDown", (e) => events.linkDown(e.linkId)),
      this.ble.addListener("data", (e) => {
        const frame = fromBase64(e.data);
        if (frame) events.data(e.linkId, frame);
      }),
      this.ble.addListener("state", (s) => events.notice?.(noticeFor(s))),
    ]);

    try {
      await this.ble.start({ maxLinks: 7 });
    } catch (err) {
      await this.removeListeners();
      const code = (err as { code?: string })?.code ?? "";
      const known = ERROR_MESSAGES[code];
      if (known) throw new TransportError(known[0], known[1]);
      throw new TransportError(err instanceof Error ? err.message : String(err), "unknown");
    }
  }

  async stop(): Promise<void> {
    try {
      await this.ble.stop();
    } finally {
      await this.removeListeners();
    }
  }

  send(linkId: string, frame: Uint8Array): void {
    void this.ble.send({ linkId, data: toBase64(frame) }).catch(() => {});
  }

  private async removeListeners(): Promise<void> {
    const handles = this.handles;
    this.handles = [];
    await Promise.all(handles.map((h) => h.remove().catch(() => {})));
  }
}

function noticeFor(s: BleMeshState) {
  if (!s.bluetoothOn) return { code: "bluetooth_off" as const, message: ERROR_MESSAGES.BLUETOOTH_OFF[0] };
  if (s.error) return { code: "radio_error" as const, message: s.error };
  return null;
}
