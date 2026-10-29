// Tests for the offline-mesh internet bridge (src/mesh/bridge.js). Run: npm run test:mesh-bridge
// Needs nothing else running: it starts its own HTTP server on a free port.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { attachMeshBridge } from "../src/mesh/bridge.js";

/** Builds a signed v2 mesh packet (same layout as frontend/lib/mesh/packet.ts). */
function makePacket({ tag = crypto.randomBytes(16), keys = crypto.generateKeyPairSync("ed25519"), linkLocal = false, timestamp = Date.now(), payload = crypto.randomBytes(40), ttl = 6 } = {}) {
  const pub = Buffer.from(keys.publicKey.export({ format: "jwk" }).x, "base64url");
  const flags = 0x02 | 0x08 | (tag ? 0x10 : 0) | (linkLocal ? 0x04 : 0);
  const head = Buffer.alloc(52);
  head[0] = 2;
  head[1] = 3; // MESSAGE
  head[2] = ttl;
  head[3] = flags;
  head.writeUInt32BE(Math.floor(timestamp / 2 ** 32), 4);
  head.writeUInt32BE(timestamp >>> 0, 8);
  crypto.randomBytes(8).copy(head, 12);
  pub.copy(head, 20);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length);
  const body = Buffer.concat([head, tag ?? Buffer.alloc(0), len, payload]);
  const signed = Buffer.from(body);
  signed[2] = 0;
  const sig = crypto.sign(null, signed, keys.privateKey);
  return { raw: Buffer.concat([body, sig]), tag: tag?.toString("hex"), keys };
}

let server;
let bridge;
let url;

before(async () => {
  server = http.createServer((_req, res) => res.end("ok"));
  bridge = attachMeshBridge(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `ws://127.0.0.1:${server.address().port}/mesh-bridge`;
});

after(() => {
  bridge.close();
  server.close();
});

async function client(tags = []) {
  const ws = new WebSocket(url);
  ws.received = [];
  ws.on("message", (data, isBinary) => isBinary && ws.received.push(Buffer.from(data)));
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  if (tags.length) await subscribe(ws, tags);
  return ws;
}

async function subscribe(ws, tags) {
  ws.send(JSON.stringify({ type: "subscribe", tags }));
  await settle();
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe("mesh bridge", () => {
  it("forwards a packet to subscribers of its tag, not back to the sender, not to others", async () => {
    const p = makePacket();
    const sender = await client([p.tag]);
    const listener = await client([p.tag]);
    const other = await client([crypto.randomBytes(16).toString("hex")]);
    sender.send(p.raw);
    await settle();
    assert.equal(listener.received.length, 1);
    assert.deepEqual(listener.received[0], p.raw);
    assert.equal(sender.received.length, 0);
    assert.equal(other.received.length, 0);
    for (const ws of [sender, listener, other]) ws.close();
  });

  it("rejects bad signatures, the Lobby (no tag) and link-local packets", async () => {
    const tag = crypto.randomBytes(16);
    const listener = await client([tag.toString("hex")]);
    const sender = await client();
    const forged = makePacket({ tag }).raw;
    forged[forged.length - 70] ^= 1; // inside the payload
    sender.send(forged);
    sender.send(makePacket({ tag: null }).raw);
    sender.send(makePacket({ tag, linkLocal: true }).raw);
    sender.send(Buffer.from("not a packet"));
    await settle();
    assert.equal(listener.received.length, 0);
    sender.close();
    listener.close();
  });

  it("gives a late subscriber what it missed, once, even if two gateways upload it", async () => {
    const p = makePacket();
    const g1 = await client();
    const g2 = await client();
    g1.send(p.raw);
    g2.send(p.raw); // the same packet from a second gateway
    await settle();
    const late = await client([p.tag]);
    assert.equal(late.received.length, 1);
    for (const ws of [g1, g2, late]) ws.close();
  });

  it("limits how fast one sender key can push packets", async () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    const tag = crypto.randomBytes(16);
    const listener = await client([tag.toString("hex")]);
    const sender = await client();
    for (let i = 0; i < 60; i++) sender.send(makePacket({ tag, keys }).raw);
    await settle();
    assert.ok(listener.received.length <= 25, `got ${listener.received.length}`);
    assert.ok(listener.received.length >= 15);
    sender.close();
    listener.close();
  });

  it("leaves other WebSocket upgrades alone", async () => {
    const ws = new WebSocket(url.replace("/mesh-bridge", "/somewhere-else"));
    const outcome = await new Promise((r) => {
      ws.once("open", () => r("open"));
      ws.once("error", () => r("error"));
      setTimeout(() => r("pending"), 300);
    });
    assert.notEqual(outcome, "open");
    ws.terminate();
  });
});
