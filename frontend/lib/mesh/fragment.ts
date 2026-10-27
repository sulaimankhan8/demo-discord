// Link-level framing. BLE writes are small, so a packet that doesn't fit one write is split
// into fragments and rebuilt on the other end of that link. Fragmentation is per hop: each
// phone rebuilds the full packet, then re-splits it to fit each outgoing link.
//
//   whole packet: [0][packet bytes]
//   fragment:     [1][groupId u32][index u8][total u8][chunk]

export const FRAME_WHOLE = 0;
export const FRAME_FRAGMENT = 1;
const FRAGMENT_HEADER_BYTES = 7;
const MAX_FRAGMENTS = 255;

/** Smallest usable write size: BLE's default ATT MTU of 23 leaves 20 bytes per write. */
export const MIN_FRAME_BYTES = 20;

export function toFrames(packet: Uint8Array, maxFrameBytes: number, groupId: number): Uint8Array[] {
  const limit = Math.max(MIN_FRAME_BYTES, maxFrameBytes);
  if (packet.length + 1 <= limit) {
    const frame = new Uint8Array(packet.length + 1);
    frame[0] = FRAME_WHOLE;
    frame.set(packet, 1);
    return [frame];
  }

  const chunkSize = limit - FRAGMENT_HEADER_BYTES;
  const total = Math.ceil(packet.length / chunkSize);
  if (total > MAX_FRAGMENTS) throw new Error("packet too large for this link");

  const frames: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const chunk = packet.subarray(i * chunkSize, (i + 1) * chunkSize);
    const frame = new Uint8Array(FRAGMENT_HEADER_BYTES + chunk.length);
    const view = new DataView(frame.buffer);
    frame[0] = FRAME_FRAGMENT;
    view.setUint32(1, groupId >>> 0);
    frame[5] = i;
    frame[6] = total;
    frame.set(chunk, FRAGMENT_HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

interface PendingGroup {
  total: number;
  chunks: (Uint8Array | undefined)[];
  received: number;
  expiresAt: number;
}

/** Rebuilds packets from the frames of one link. Use one Reassembler per link. */
export class Reassembler {
  private groups = new Map<number, PendingGroup>();

  constructor(
    private readonly timeoutMs = 30_000,
    private readonly maxGroups = 32,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns a complete packet, or null if the frame was a fragment of an unfinished packet. */
  push(frame: Uint8Array): Uint8Array | null {
    this.dropExpired();
    if (frame.length < 1) return null;
    if (frame[0] === FRAME_WHOLE) return frame.slice(1);
    if (frame[0] !== FRAME_FRAGMENT || frame.length <= FRAGMENT_HEADER_BYTES) return null;

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const groupId = view.getUint32(1);
    const index = frame[5];
    const total = frame[6];
    if (total < 2 || index >= total) return null;

    let group = this.groups.get(groupId);
    if (group && group.total !== total) {
      this.groups.delete(groupId);
      group = undefined;
    }
    if (!group) {
      if (this.groups.size >= this.maxGroups) {
        const oldest = this.groups.keys().next().value;
        if (oldest !== undefined) this.groups.delete(oldest);
      }
      group = { total, chunks: new Array(total), received: 0, expiresAt: this.now() + this.timeoutMs };
      this.groups.set(groupId, group);
    }

    if (!group.chunks[index]) {
      group.chunks[index] = frame.slice(FRAGMENT_HEADER_BYTES);
      group.received++;
    }
    if (group.received < group.total) return null;

    this.groups.delete(groupId);
    const chunks = group.chunks as Uint8Array[];
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  private dropExpired(): void {
    const t = this.now();
    for (const [id, g] of this.groups) if (g.expiresAt <= t) this.groups.delete(id);
  }

  get pendingGroups(): number {
    return this.groups.size;
  }
}
