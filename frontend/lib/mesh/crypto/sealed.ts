// Sealed box: encrypts bytes to one person's identity key, so only they can open it.
// Used to hand out channel keys in KEY_GRANT packets.
//
//   sealed = [ephemeral X25519 public 32][XChaCha20-Poly1305 ciphertext + 16]
//   key    = HKDF(X25519(ephemeral, recipient), salt = ephemeralPub ‖ recipientPub, "mesh-seal")
//
// A fresh ephemeral key per box means each derived key is used once, so the nonce can be zero.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, utf8 } from "../bytes";
import { x25519Public, x25519Secret, type MeshIdentity } from "../identity";

const INFO = utf8("mesh-seal");
const NONCE = new Uint8Array(24);
export const SEAL_OVERHEAD = 32 + 16;

function boxKey(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concat(ephPub, recipientPub), INFO, 32);
}

/** Seals `data` to the owner of an Ed25519 public key. */
export function seal(recipientEdPublicKey: Uint8Array, data: Uint8Array): Uint8Array {
  const recipientPub = x25519Public(recipientEdPublicKey);
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const key = boxKey(x25519.getSharedSecret(eph, recipientPub), ephPub, recipientPub);
  return concat(ephPub, xchacha20poly1305(key, NONCE).encrypt(data));
}

/** Opens a box sealed to me. Returns null if it wasn't for me or was changed. */
export function openSealed(me: MeshIdentity, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < SEAL_OVERHEAD) return null;
  try {
    const ephPub = sealed.subarray(0, 32);
    const myPub = x25519Public(me.publicKey);
    const key = boxKey(x25519.getSharedSecret(x25519Secret(me), ephPub), ephPub, myPub);
    return xchacha20poly1305(key, NONCE).decrypt(sealed.subarray(32));
  } catch {
    return null;
  }
}
