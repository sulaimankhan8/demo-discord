// Packet signing. Every packet is signed so nobody can send messages under someone else's key.

import { ed25519 } from "@noble/curves/ed25519.js";
import { signingBytes, type MeshPacket } from "./packet";

export function signPacket(packet: MeshPacket, secretKey: Uint8Array): MeshPacket {
  const unsigned = { ...packet, signature: undefined };
  return { ...unsigned, signature: ed25519.sign(signingBytes(unsigned), secretKey) };
}

export function verifyPacket(packet: MeshPacket): boolean {
  if (!packet.signature) return false;
  try {
    return ed25519.verify(packet.signature, signingBytes(packet), packet.senderKey);
  } catch {
    return false;
  }
}
