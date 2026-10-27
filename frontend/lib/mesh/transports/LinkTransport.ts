// A link transport finds nearby devices and moves raw frames between them. It knows nothing
// about the mesh. The BLE plugin (Phase 2) and the browser-tab simulator both implement this.

export interface LinkInfo {
  linkId: string;
  /** Largest frame this link can carry in one write. */
  maxFrameBytes: number;
  rssi?: number;
}

export interface LinkTransportEvents {
  linkUp(info: LinkInfo): void;
  linkDown(linkId: string): void;
  data(linkId: string, frame: Uint8Array): void;
}

export interface LinkTransport {
  readonly kind: "ble" | "sim" | "memory";
  start(events: LinkTransportEvents): Promise<void>;
  stop(): Promise<void>;
  send(linkId: string, frame: Uint8Array): void;
}
