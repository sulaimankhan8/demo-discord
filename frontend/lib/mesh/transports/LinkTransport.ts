// A link transport finds nearby devices and moves raw frames between them. It knows nothing
// about the mesh. The BLE plugin (Phase 2) and the browser-tab simulator both implement this.

export interface LinkInfo {
  linkId: string;
  /** Largest frame this link can carry in one write. */
  maxFrameBytes: number;
  rssi?: number;
}

/** A problem the user may need to fix (e.g. Bluetooth turned off). */
export interface TransportNotice {
  code: "bluetooth_off" | "radio_error";
  message: string;
}

export interface LinkTransportEvents {
  linkUp(info: LinkInfo): void;
  linkDown(linkId: string): void;
  data(linkId: string, frame: Uint8Array): void;
  /** Called with a notice when something needs attention, and with null once it's fine again. */
  notice?(notice: TransportNotice | null): void;
}

/** Error thrown by start() when the transport can't run; `code` lets the UI offer a fix. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly code: "permission" | "bluetooth_off" | "unsupported" | "unknown",
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface LinkTransport {
  readonly kind: "ble" | "sim" | "memory";
  start(events: LinkTransportEvents): Promise<void>;
  stop(): Promise<void>;
  send(linkId: string, frame: Uint8Array): void;
}
