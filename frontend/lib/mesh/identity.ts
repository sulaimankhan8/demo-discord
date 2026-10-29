// Device identity: an Ed25519 key pair made on the device. No account or server needed.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromHex, toHex } from "./bytes";
import { isSealedText, type KeyVault } from "./vault";

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

/**
 * Loads the identity saved under `key`, or makes and saves a new one. With a vault (the app's
 * Keystore/Keychain key), the secret is stored sealed, and an older unsealed one is sealed on
 * the way. A sealed secret that no longer opens (its key was wiped) means a new identity.
 */
export function loadIdentity(storage: Storage, key: string, vault?: KeyVault | null): MeshIdentity {
  try {
    const saved = storage.getItem(key);
    const hex = saved && isSealedText(saved) ? (vault?.openText(saved) ?? null) : saved;
    const secret = hex ? fromHex(hex) : null;
    if (secret && secret.length === 32) {
      if (vault && saved && !isSealedText(saved)) storage.setItem(key, vault.sealText(saved));
      return identityFromSecret(secret);
    }
  } catch {
    // Storage unavailable or corrupt: fall through and make a new identity.
  }
  const identity = createIdentity();
  try {
    const hex = toHex(identity.secretKey);
    storage.setItem(key, vault ? vault.sealText(hex) : hex);
  } catch {
    // Keep working with an in-memory identity.
  }
  return identity;
}

/* X25519 for sealing keys to a member (docs/10 C3a). No extra stored key: both halves are
 * converted from the Ed25519 identity, so anyone's X25519 key comes from their sender key. */

export function x25519Secret(identity: MeshIdentity): Uint8Array {
  return ed25519.utils.toMontgomerySecret(identity.secretKey);
}

export function x25519Public(edPublicKey: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomery(edPublicKey);
}
