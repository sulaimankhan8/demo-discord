import { describe, expect, it } from "vitest";
import { randomBytes } from "../bytes";
import { Reassembler, toFrames } from "../fragment";
import { SeenCache } from "../seenCache";

describe("fragmentation", () => {
  it("sends small packets as one frame", () => {
    const packet = randomBytes(100);
    const frames = toFrames(packet, 180, 1);
    expect(frames).toHaveLength(1);
    expect(new Reassembler().push(frames[0])).toEqual(packet);
  });

  it("splits and rebuilds large packets, in any order", () => {
    const packet = randomBytes(2500);
    const frames = toFrames(packet, 50, 7);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(50);

    const r = new Reassembler();
    const shuffled = [...frames].reverse();
    let out: Uint8Array | null = null;
    for (const f of shuffled) out = r.push(f) ?? out;
    expect(out).toEqual(packet);
    expect(r.pendingGroups).toBe(0);
  });

  it("ignores duplicate fragments", () => {
    const packet = randomBytes(400);
    const frames = toFrames(packet, 60, 3);
    const r = new Reassembler();
    expect(r.push(frames[0])).toBeNull();
    expect(r.push(frames[0])).toBeNull();
    let out: Uint8Array | null = null;
    for (const f of frames.slice(1)) out = r.push(f) ?? out;
    expect(out).toEqual(packet);
  });

  it("drops unfinished packets after the timeout", () => {
    let t = 0;
    const r = new Reassembler(1000, 32, () => t);
    const frames = toFrames(randomBytes(400), 60, 9);
    r.push(frames[0]);
    expect(r.pendingGroups).toBe(1);
    t = 2000;
    r.push(toFrames(randomBytes(10), 60, 10)[0]); // any frame triggers cleanup
    expect(r.pendingGroups).toBe(0);
  });

  it("refuses packets that would need more than 255 fragments", () => {
    expect(() => toFrames(randomBytes(20_000), 20, 1)).toThrow();
  });
});

describe("seen cache", () => {
  it("reports new ids once", () => {
    const c = new SeenCache();
    expect(c.checkAndAdd("a")).toBe(true);
    expect(c.checkAndAdd("a")).toBe(false);
  });

  it("forgets ids after they expire", () => {
    let t = 0;
    const c = new SeenCache(10, 100, () => t);
    c.add("a");
    t = 50;
    expect(c.has("a")).toBe(true);
    t = 200;
    expect(c.has("a")).toBe(false);
  });

  it("evicts the oldest ids when full", () => {
    const c = new SeenCache(2);
    c.add("a");
    c.add("b");
    c.add("c");
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
    expect(c.has("c")).toBe(true);
  });
});
