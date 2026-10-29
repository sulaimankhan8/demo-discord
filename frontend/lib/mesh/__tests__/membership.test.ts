import { describe, expect, it } from "vitest";
import { randomBytes, toHex } from "../bytes";
import {
  changeHash,
  decodeEpochChange,
  decodeGrant,
  decodeMembers,
  encodeEpochChange,
  encodeGrant,
  encodeMembers,
  EpochReason,
  GENESIS_HASH,
  MembershipState,
  Role,
  type EpochChange,
  type MembersList,
} from "../channels/membership";
import { openSealed, seal } from "../crypto/sealed";
import { createIdentity } from "../identity";

const owner = createIdentity();
const ownerKey = toHex(owner.publicKey);
const channelId = randomBytes(16);
const cid = toHex(channelId);
const k = () => toHex(createIdentity().publicKey);

function list(version: number, members: [string, Role][]): MembersList {
  return { channelId, epoch: 0, version, members: members.map(([key, role]) => ({ key, role, joinedEpoch: 0 })) };
}

function bootstrapped(extra: [string, Role][] = []) {
  const st = new MembershipState(cid, ownerKey);
  const l = list(1, [[ownerKey, Role.Owner], ...extra]);
  expect(st.checkMembers(l, ownerKey)).toBe("ok");
  st.applyMembers(l);
  return st;
}

describe("membership payloads", () => {
  it("round-trip", () => {
    const l = list(7, [
      [ownerKey, Role.Owner],
      [k(), Role.Admin],
    ]);
    expect(decodeMembers(encodeMembers(l))).toEqual(l);

    const change = { channelId, newEpoch: 3, prevChangeHash: randomBytes(8), reason: EpochReason.Removed, removed: [k()] };
    expect(decodeEpochChange(encodeEpochChange(change))).toEqual(change);

    const grant = { channelId, entries: [{ epoch: 2, changeHash: randomBytes(8), sealedKey: randomBytes(80) }] };
    expect(decodeGrant(encodeGrant(grant))).toEqual(grant);
  });

  it("reject malformed bytes", () => {
    const bytes = encodeMembers(list(1, [[ownerKey, Role.Owner]]));
    expect(decodeMembers(bytes.slice(0, -1))).toBeNull();
    const badRole = bytes.slice();
    badRole[bytes.length - 5] = 9;
    expect(decodeMembers(badRole)).toBeNull();
    const dup = encodeMembers(list(1, [[ownerKey, Role.Owner]]));
    const twice = new Uint8Array([...dup.slice(0, 24), 2, ...dup.slice(25), ...dup.slice(25)]);
    expect(decodeMembers(twice)).toBeNull(); // same key twice
    expect(decodeGrant(new Uint8Array(17))).toBeNull(); // zero entries
  });
});

describe("member list rules", () => {
  it("accepts the owner's first list and nobody else's", () => {
    const st = new MembershipState(cid, ownerKey);
    const stranger = k();
    expect(st.checkMembers(list(1, [[ownerKey, Role.Owner], [stranger, Role.Admin]]), stranger)).toBe("unauthorized");
    expect(st.checkMembers(list(1, [[ownerKey, Role.Owner]]), ownerKey)).toBe("ok");
  });

  it("needs the owner, as Owner, and only one Owner", () => {
    const st = bootstrapped();
    const x = k();
    expect(st.checkMembers(list(2, [[x, Role.Member]]), ownerKey)).toBe("invalid");
    expect(st.checkMembers(list(2, [[ownerKey, Role.Admin]]), ownerKey)).toBe("invalid");
    expect(st.checkMembers(list(2, [[ownerKey, Role.Owner], [x, Role.Owner]]), ownerKey)).toBe("invalid");
  });

  it("ignores replayed older lists", () => {
    const st = bootstrapped();
    const v2 = list(2, [[ownerKey, Role.Owner], [k(), Role.Member]]);
    st.applyMembers(v2);
    expect(st.checkMembers(list(1, [[ownerKey, Role.Owner]]), ownerKey)).toBe("stale");
    expect(st.checkMembers(v2, ownerKey)).toBe("stale");
  });

  it("ignores lists signed by plain members", () => {
    const member = k();
    const st = bootstrapped([[member, Role.Member]]);
    expect(st.checkMembers(list(2, [[ownerKey, Role.Owner], [member, Role.Member], [k(), Role.Member]]), member)).toBe(
      "unauthorized",
    );
  });

  it("lets admins manage members only", () => {
    const admin = k();
    const otherAdmin = k();
    const member = k();
    const st = bootstrapped([
      [admin, Role.Admin],
      [otherAdmin, Role.Admin],
      [member, Role.Member],
    ]);
    const base: [string, Role][] = [
      [ownerKey, Role.Owner],
      [admin, Role.Admin],
      [otherAdmin, Role.Admin],
    ];
    expect(st.checkMembers(list(2, [...base, [member, Role.Member], [k(), Role.Member]]), admin)).toBe("ok"); // add
    expect(st.checkMembers(list(2, base), admin)).toBe("ok"); // remove a member
    expect(st.checkMembers(list(2, [...base, [member, Role.Admin]]), admin)).toBe("unauthorized"); // promote
    expect(
      st.checkMembers(list(2, [[ownerKey, Role.Owner], [admin, Role.Admin], [member, Role.Member]]), admin),
    ).toBe("unauthorized"); // remove an admin
    expect(st.checkMembers(list(2, [...base, [member, Role.Member], [k(), Role.CoOwner]]), admin)).toBe("unauthorized");
  });

  it("lets co-owners manage admins but only the owner manage co-owners", () => {
    const co = k();
    const admin = k();
    const member = k();
    const st = bootstrapped([
      [co, Role.CoOwner],
      [admin, Role.Admin],
      [member, Role.Member],
    ]);
    const promote = list(2, [
      [ownerKey, Role.Owner],
      [co, Role.CoOwner],
      [admin, Role.Member],
      [member, Role.Admin],
    ]);
    expect(st.checkMembers(promote, co)).toBe("ok");
    const makeCo = list(2, [
      [ownerKey, Role.Owner],
      [co, Role.CoOwner],
      [admin, Role.Admin],
      [member, Role.CoOwner],
    ]);
    expect(st.checkMembers(makeCo, co)).toBe("unauthorized");
    expect(st.checkMembers(makeCo, ownerKey)).toBe("ok");
    // A co-owner keeps running the channel without the owner: removing members works.
    expect(st.checkMembers(list(2, [[ownerKey, Role.Owner], [co, Role.CoOwner], [admin, Role.Admin]]), co)).toBe("ok");
  });

  it("drafts a change without applying it", () => {
    const st = bootstrapped();
    const x = k();
    const draft = st.draftWith(x, Role.Member);
    expect(draft.version).toBe(2);
    expect(draft.members.map((m) => m.key).sort()).toEqual([ownerKey, x].sort());
    expect(st.has(x)).toBe(false);
  });
});

describe("epoch changes", () => {
  const admin = createIdentity();
  const adminKey = toHex(admin.publicKey);

  function change(epoch: number): EpochChange {
    return { channelId, newEpoch: epoch, prevChangeHash: GENESIS_HASH, reason: EpochReason.Rotate, removed: [] };
  }

  it("takes the higher epoch, and the lower hash for the same epoch, in any order", () => {
    const a = change(1);
    const b = { ...change(1), reason: EpochReason.Periodic };
    const ha = changeHash(owner.publicKey, encodeEpochChange(a));
    const hb = changeHash(admin.publicKey, encodeEpochChange(b));

    const final = (first: [EpochChange, Uint8Array, string], second: [EpochChange, Uint8Array, string]) => {
      const st = bootstrapped([[adminKey, Role.Admin]]);
      for (const [c, h, signer] of [first, second]) {
        const v = st.checkEpochChange(c, signer, h);
        if (v === "newer" || v === "tie_win") st.applyEpochChange(c, h);
      }
      return toHex(st.changeHash);
    };
    const x = final([a, ha, ownerKey], [b, hb, adminKey]);
    const y = final([b, hb, adminKey], [a, ha, ownerKey]);
    expect(x).toBe(y);

    const st = bootstrapped([[adminKey, Role.Admin]]);
    st.applyEpochChange(change(2), randomBytes(8));
    expect(st.checkEpochChange(change(1), ownerKey, new Uint8Array(8))).toBe("stale");
    expect(st.checkEpochChange(change(3), adminKey, randomBytes(8))).toBe("newer");
  });

  it("ignores changes from non-admins", () => {
    const member = k();
    const st = bootstrapped([[member, Role.Member]]);
    expect(st.checkEpochChange(change(1), member, randomBytes(8))).toBe("unauthorized");
  });
});

describe("sealed box", () => {
  it("opens only for the recipient, and not if changed", () => {
    const bob = createIdentity();
    const key = randomBytes(32);
    const box = seal(bob.publicKey, key);
    expect(box.length).toBe(80);
    expect(openSealed(bob, box)).toEqual(key);
    expect(openSealed(createIdentity(), box)).toBeNull();
    box[40] ^= 1;
    expect(openSealed(bob, box)).toBeNull();
  });
});
