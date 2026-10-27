// Device identity: an Ed25519 key pair made on the device. No account or server needed.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromHex, toHex } from "./bytes";

export interface MeshIdentity {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  /** First 8 bytes of SHA-256(publicKey), as 16 hex characters. */
  fingerprint: string;
}

export function fingerprintOf(publicKey: Uint8Array): string {
  return toHex(sha256(publicKey).slice(0, 8));
}

/** "a1b2c3d4e5f60718" → "a1b2 c3d4 e5f6 0718" */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(" ") ?? fingerprint;
}

export function identityFromSecret(secretKey: Uint8Array): MeshIdentity {
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, fingerprint: fingerprintOf(publicKey) };
}

export function createIdentity(): MeshIdentity {
  return identityFromSecret(ed25519.utils.randomSecretKey());
}

/** Loads the identity saved under `key`, or makes and saves a new one. */
export function loadIdentity(storage: Storage, key: string): MeshIdentity {
  try {
    const saved = storage.getItem(key);
    const secret = saved ? fromHex(saved) : null;
    if (secret && secret.length === 32) return identityFromSecret(secret);
  } catch {
    // Storage unavailable or corrupt: fall through and make a new identity.
  }
  const identity = createIdentity();
  try {
    storage.setItem(key, toHex(identity.secretKey));
  } catch {
    // Keep working with an in-memory identity.
  }
  return identity;
}
