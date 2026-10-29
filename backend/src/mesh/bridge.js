// Offline-mesh internet bridge (docs/10_MESH_CHANNELS_IMPLEMENTATION_PLAN.md, step C5).
//
// A phone with internet ("gateway") connects here and subscribes to the tags of its bridged
// channels. Every mesh packet it uploads is forwarded to the other gateways subscribed to that
// packet's tag, so far-apart mesh groups can share channels.
//
// The bridge only ever sees signed packets, most of them encrypted. It checks the Ed25519
// signature, the size and rate limits, and routes by tag. It needs no channel keys, has no
// database tables, and doesn't touch Socket.IO or the chat/voice code.
//
// Protocol (one WebSocket at /mesh-bridge):
//   client → server, text:   {"type":"subscribe","tags":["<32 hex>", ...]}   (replaces the set)
//   client → server, binary: one encoded mesh packet
//   server → client, binary: one encoded mesh packet from another gateway
// Packets per tag are kept for 24 h (in memory), so a gateway that subscribes late catches up.

import crypto from "crypto";
import { WebSocketServer } from "ws";

export const BRIDGE_PATH = "/mesh-bridge";

const MAX_PACKET_BYTES = 4096 + 160; // payload limit + header and signature
const KEEP_MS = 24 * 60 * 60_000;
const MAX_PER_TAG = 500;
const MAX_STORED_BYTES = 32 * 1024 * 1024;
const MAX_TAGS_PER_CONNECTION = 256;
const MAX_CLOCK_SKEW_MS = 10 * 60_000;
const CONNECTION_RATE = { perSecond: 20, burst: 40 };
const SENDER_RATE = { perSecond: 10, burst: 20 };
const PING_MS = 30_000;

// Header layout, as in frontend/lib/mesh/packet.ts.
const FLAG_HAS_RECIPIENT = 0x01;
const FLAG_SIGNED = 0x02;
const FLAG_LINK_LOCAL = 0x04;
const FLAG_HAS_CHANNEL = 0x10;
const FIXED_HEADER = 52;
const SIGNATURE_BYTES = 64;

/** Reads what the bridge needs from a packet. Returns null if it isn't one it will carry. */
export function parsePacket(buf) {
  if (buf.length < FIXED_HEADER + 2 + SIGNATURE_BYTES || buf.length > MAX_PACKET_BYTES) return null;
  const version = buf[0];
  const flags = buf[3];
  if (version < 2) return null;
  if (!(flags & FLAG_SIGNED) || flags & FLAG_LINK_LOCAL || !(flags & FLAG_HAS_CHANNEL)) return null;
  const timestamp = buf.readUInt32BE(4) * 2 ** 32 + buf.readUInt32BE(8);
  const messageId = buf.subarray(12, 20).toString("hex");
  const senderKey = buf.subarray(20, 52);
  let o = FIXED_HEADER;
  const tag = buf.subarray(o, o + 16).toString("hex");
  o += 16;
  if (flags & FLAG_HAS_RECIPIENT) o += 8;
  if (buf.length < o + 2) return null;
  const length = buf.readUInt16BE(o);
  o += 2;
  if (buf.length !== o + length + SIGNATURE_BYTES) return null;
  // Signed bytes: everything but the signature, with the ttl (byte 2) set to 0.
  const signed = Buffer.from(buf.subarray(0, buf.length - SIGNATURE_BYTES));
  signed[2] = 0;
  return { timestamp, messageId, senderKey, tag, signed, signature: buf.subarray(buf.length - SIGNATURE_BYTES) };
}

const keyCache = new Map();
function publicKeyObject(raw) {
  const hex = raw.toString("hex");
  let key = keyCache.get(hex);
  if (!key) {
    key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    if (keyCache.size > 10_000) keyCache.clear();
    keyCache.set(hex, key);
  }
  return key;
}

export function verifyPacket(p) {
  try {
    return crypto.verify(null, p.signed, publicKeyObject(p.senderKey), p.signature);
  } catch {
    return false;
  }
}

function takeToken(bucket, rate, now) {
  bucket.tokens = Math.min(rate.burst, bucket.tokens + ((now - bucket.last) * rate.perSecond) / 1000);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

export function createMeshBridge({ now = Date.now, log = console } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PACKET_BYTES });
  /** tag -> sockets subscribed to it */
  const subscribers = new Map();
  /** tag -> [{ id, data, at }] oldest first */
  const stored = new Map();
  /** messageId -> time first seen */
  const seen = new Map();
  const senderBuckets = new Map();
  let storedBytes = 0;
  const stats = { connections: 0, received: 0, forwarded: 0, rejected: 0, duplicates: 0, rateLimited: 0 };

  function prune() {
    const cutoff = now() - KEEP_MS;
    for (const [tag, list] of stored) {
      while (list.length && (list[0].at < cutoff || storedBytes > MAX_STORED_BYTES)) {
        storedBytes -= list.shift().data.length;
      }
      if (!list.length) stored.delete(tag);
    }
    for (const [id, at] of seen) {
      if (at >= cutoff) break;
      seen.delete(id);
    }
  }

  function store(tag, id, data) {
    let list = stored.get(tag);
    if (!list) stored.set(tag, (list = []));
    list.push({ id, data, at: now() });
    storedBytes += data.length;
    while (list.length > MAX_PER_TAG) storedBytes -= list.shift().data.length;
    if (storedBytes > MAX_STORED_BYTES) prune();
  }

  function subscribe(ws, tags) {
    const next = new Set(tags.filter((t) => typeof t === "string" && /^[0-9a-f]{32}$/.test(t)).slice(0, MAX_TAGS_PER_CONNECTION));
    for (const t of ws.meshTags) {
      if (next.has(t)) continue;
      subscribers.get(t)?.delete(ws);
      if (subscribers.get(t)?.size === 0) subscribers.delete(t);
    }
    const added = [...next].filter((t) => !ws.meshTags.has(t));
    ws.meshTags = next;
    for (const t of next) {
      if (!subscribers.has(t)) subscribers.set(t, new Set());
      subscribers.get(t).add(ws);
    }
    // Catch up: send what was kept for the newly subscribed tags.
    prune();
    for (const t of added) for (const e of stored.get(t) ?? []) ws.send(e.data, { binary: true });
  }

  function onPacket(ws, data) {
    stats.received++;
    const t = now();
    if (!takeToken(ws.meshBucket, CONNECTION_RATE, t)) {
      stats.rateLimited++;
      return;
    }
    const p = parsePacket(data);
    if (!p || Math.abs(t - p.timestamp) > KEEP_MS + MAX_CLOCK_SKEW_MS || p.timestamp > t + MAX_CLOCK_SKEW_MS) {
      stats.rejected++;
      return;
    }
    if (seen.has(p.messageId)) {
      stats.duplicates++; // another gateway already brought it
      return;
    }
    if (!verifyPacket(p)) {
      stats.rejected++;
      return;
    }
    const senderHex = p.senderKey.toString("hex");
    let bucket = senderBuckets.get(senderHex);
    if (!bucket) {
      if (senderBuckets.size > 10_000) senderBuckets.clear();
      senderBuckets.set(senderHex, (bucket = { tokens: SENDER_RATE.burst, last: t }));
    }
    if (!takeToken(bucket, SENDER_RATE, t)) {
      stats.rateLimited++;
      return;
    }
    seen.set(p.messageId, t);
    store(p.tag, p.messageId, data);
    for (const other of subscribers.get(p.tag) ?? []) {
      if (other === ws || other.readyState !== other.OPEN) continue;
      other.send(data, { binary: true });
      stats.forwarded++;
    }
  }

  wss.on("connection", (ws) => {
    stats.connections++;
    ws.meshTags = new Set();
    ws.meshBucket = { tokens: CONNECTION_RATE.burst, last: now() };
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return onPacket(ws, Buffer.isBuffer(data) ? data : Buffer.concat(data));
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.type === "subscribe" && Array.isArray(msg.tags)) subscribe(ws, msg.tags);
      } catch {
        stats.rejected++;
      }
    });
    ws.on("close", () => {
      stats.connections--;
      subscribe(ws, []);
    });
    ws.on("error", () => {});
  });

  // Drop connections that stopped answering pings (phones that lost signal without closing).
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_MS);
  pinger.unref?.();

  return {
    stats,
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
    close() {
      clearInterval(pinger);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
    log,
  };
}

/**
 * Adds the bridge to an HTTP(S) server. Only upgrades for /mesh-bridge are taken; everything
 * else (Socket.IO's own upgrades) is left alone.
 */
export function attachMeshBridge(server, options) {
  const bridge = createMeshBridge(options);
  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      return;
    }
    if (pathname === BRIDGE_PATH) bridge.handleUpgrade(req, socket, head);
  });
  return bridge;
}
