// Direct messages (docs/10 C6): formats and crypto, no I/O.
//
// DM packet (type 10): recipient field = recipient's fingerprint (8 B), channel tag = the
// recipient's mailbox tag, payload = sealed box to the recipient containing
//   [senderKey 32][innerSig 64][padded MESSAGE payload]
//   innerSig = Ed25519(sender, "mesh-dm" ‖ recipientKey ‖ messageId ‖ padded)
// The outer packet signature proves who sent the packet; the inner one proves the sealed
// content was written by that sender for this recipient, so nobody can re-send someone else's
// sealed message under their own name.
//
// ACK packet (type 11): recipient = the DM's sender, tag = the sender's mailbox tag,
// payload = [dm messageId 8]. Signed by the DM's recipient.
//
// Mailbox tag = SHA-256("mesh-dm" ‖ publicKey)[0..16]. Carriers keep DMs by it, the recipient
// asks for it in SYNC, and the internet bridge routes it, without anyone reading the message.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, equalBytes, toHex, utf8 } from "../bytes";
import { pad, unpad } from "../crypto/padding";
import { openSealed, seal } from "../crypto/sealed";
import type { MeshIdentity } from "../identity";
import { decodeMessagePayload, encodeMessagePayload, type MessagePayload } from "../payloads";

const DM_CONTEXT = utf8("mesh-dm");

export function mailboxTag(publicKey: Uint8Array): Uint8Array {
  return sha256(concat(DM_CONTEXT, publicKey)).slice(0, 16);
}

export function mailboxTagHex(publicKey: Uint8Array): string {
  return toHex(mailboxTag(publicKey));
}

const innerMessage = (recipientKey: Uint8Array, messageId: Uint8Array, padded: Uint8Array) =>
  concat(DM_CONTEXT, recipientKey, messageId, padded);

export function sealDirect(
  sender: MeshIdentity,
  recipientKey: Uint8Array,
  messageId: Uint8Array,
  body: MessagePayload,
): Uint8Array {
  const padded = pad(encodeMessagePayload(body));
  const sig = ed25519.sign(innerMessage(recipientKey, messageId, padded), sender.secretKey);
  return seal(recipientKey, concat(sender.publicKey, sig, padded));
}

/** Opens a DM sealed to me. Null unless it was sealed for me by the packet's own sender. */
export function openDirect(
  me: MeshIdentity,
  outerSender: Uint8Array,
  messageId: Uint8Array,
  sealed: Uint8Array,
): MessagePayload | null {
  const inner = openSealed(me, sealed);
  if (!inner || inner.length < 32 + 64) return null;
  const senderKey = inner.subarray(0, 32);
  const sig = inner.subarray(32, 96);
  const padded = inner.subarray(96);
  if (!equalBytes(senderKey, outerSender)) return null;
  try {
    if (!ed25519.verify(sig, innerMessage(me.publicKey, messageId, padded), senderKey)) return null;
  } catch {
    return null;
  }
  const plain = unpad(padded);
  return plain && decodeMessagePayload(plain);
}
