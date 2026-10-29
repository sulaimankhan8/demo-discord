// Relay benchmark (docs/10 C4). Not part of `npm run test:mesh`; run with `npm run bench:mesh`.
//
// N phones at random positions in a square, linked when close (about 8 neighbours each), 5 public
// channels, every phone in one of them. Each phone posts 1–2 messages at random times over a
// minute. Compares duplicate suppression off and on. Delivery counts members within 7 hops of
// the sender (farther ones can't be reached by design).

import { describe, expect, it } from "vitest";
import { randomBytes, toHex } from "../bytes";
import { createIdentity } from "../identity";
import { LOBBY_TAG, MAX_TTL } from "../packet";
import { MeshRouter } from "../router";
import { prng, SimNetwork } from "./sim";

type Mode = "C3 baseline" | "+ hop top-up" | "+ skip neighbours who have it";

interface Result {
  n: number;
  mode: Mode;
  delivery: number;
  framesPerNodePerMinute: number;
  medianHops: number;
  suppressed: number;
  dropped: number;
}

function scenario(n: number, mode: Mode, seed: number, messagesPerNode: number): Result {
  const suppress = mode === "+ skip neighbours who have it";
  const topUp = mode !== "C3 baseline";
  const rand = prng(seed);
  const sched = new SimNetwork({}, { timed: true, startTime: 1_000_000_000_000 });
  const pos = Array.from({ length: n }, () => [rand(), rand()] as const);
  const r = Math.sqrt(8 / (Math.PI * n));
  const adj: string[][] = Array.from({ length: n }, () => []);
  const link = (i: number, j: number) => {
    if (i === j || adj[i].includes(String(j))) return;
    adj[i].push(String(j));
    adj[j].push(String(i));
  };
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if (Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]) < r) link(i, j);
  // Nobody is completely alone: link isolated phones to their nearest neighbour.
  for (let i = 0; i < n; i++) {
    if (adj[i].length) continue;
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      const d = Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]);
      if (j !== i && d < bestD) [best, bestD] = [j, d];
    }
    link(i, best);
  }

  const channels = Array.from({ length: 5 }, () => randomBytes(16));
  const channelOf = Array.from({ length: n }, () => Math.floor(rand() * 5));
  const delivered = new Map<string, Map<number, number>>(); // text -> node -> hops
  let frames = 0;

  const routers: MeshRouter[] = [];
  for (let i = 0; i < n; i++) {
    const mine = toHex(channels[channelOf[i]]);
    routers.push(
      new MeshRouter({
        identity: createIdentity(),
        nickname: `n${i}`,
        links: () => adj[i],
        send: (to, packet) => {
          frames++;
          sched.enqueue(() => routers[Number(to)].handleIncoming(String(i), packet), 5);
        },
        onMessage: (m) => {
          if (m.mine) return;
          let row = delivered.get(m.text);
          if (!row) delivered.set(m.text, (row = new Map()));
          row.set(i, m.hops);
        },
        now: () => sched.clock,
        random: prng(seed * 1000 + i),
        schedule: (fn, ms) => sched.enqueue(fn, ms),
        relayJitterMs: [10, 80],
        maxRelaysPerSecond: 20,
        suppressDuplicates: suppress,
        relayFresherCopies: topUp,
        channelLimits: (tag) =>
          tag === mine ? { maxMessages: 500, maxAgeMs: 3_600_000, ttl: MAX_TTL } : tag === LOBBY_TAG ? null : null,
      }),
    );
  }

  // Hop distance from every phone (BFS), to know who can be reached at all.
  const dist = (src: number) => {
    const d = new Array(n).fill(Infinity);
    d[src] = 0;
    const q = [src];
    while (q.length) {
      const u = q.shift()!;
      for (const v of adj[u].map(Number)) {
        if (d[v] !== Infinity) continue;
        d[v] = d[u] + 1;
        q.push(v);
      }
    }
    return d;
  };

  const sent: { text: string; from: number }[] = [];
  const windowMs = 60_000;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < messagesPerNode; k++) {
      const text = `m${i}.${k}`;
      sent.push({ text, from: i });
      sched.enqueue(() => routers[i].sendMessage(text, channels[channelOf[i]]), rand() * windowMs);
    }
  }
  sched.run();

  let expected = 0;
  let got = 0;
  const hops: number[] = [];
  for (const s of sent) {
    const d = dist(s.from);
    const row = delivered.get(s.text) ?? new Map();
    for (let j = 0; j < n; j++) {
      if (j === s.from || channelOf[j] !== channelOf[s.from] || d[j] > MAX_TTL) continue;
      expected++;
      if (row.has(j)) {
        got++;
        hops.push(row.get(j)!);
      }
    }
  }
  hops.sort((a, b) => a - b);
  return {
    n,
    mode,
    delivery: expected ? got / expected : 1,
    framesPerNodePerMinute: frames / n / (windowMs / 60_000),
    medianHops: hops.length ? hops[Math.floor(hops.length / 2)] : 0,
    suppressed: routers.reduce((s, x) => s + (x.stats.suppressed ?? 0), 0),
    dropped: routers.reduce((s, x) => s + x.stats.dropped, 0),
  };
}

function report(rows: Result[]): void {
  const lines = rows.map(
    (r) =>
      `| ${r.n} | ${r.mode} | ${(r.delivery * 100).toFixed(1)} % | ${r.framesPerNodePerMinute.toFixed(0)} | ${r.medianHops} | ${r.suppressed} | ${r.dropped} |`,
  );
  console.log(
    ["| Phones | Relaying | Delivery | Packets sent per phone per min | Median hops | Relays skipped | Dropped |", "| --: | :-- | --: | --: | --: | --: | --: |", ...lines].join("\n"),
  );
}

describe("relay benchmark", () => {
  const modes: Mode[] = ["C3 baseline", "+ hop top-up", "+ skip neighbours who have it"];

  it("50 phones: ≥ 99 % delivery, with less relay traffic than C3", () => {
    const rows = modes.map((m) => scenario(50, m, 7, 2));
    report(rows);
    const [base, , final] = rows;
    expect(final.delivery).toBeGreaterThanOrEqual(0.99);
    expect(final.framesPerNodePerMinute).toBeLessThan(base.framesPerNodePerMinute);
  }, 600_000);

  it("200 phones", () => {
    const rows = modes.map((m) => scenario(200, m, 11, 1));
    report(rows);
    expect(rows[2].delivery).toBeGreaterThanOrEqual(rows[0].delivery);
  }, 900_000);
});
