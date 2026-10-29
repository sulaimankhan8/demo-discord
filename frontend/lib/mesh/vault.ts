// Key vault (docs/10 C7). In the app, the native plugin hands out a 32-byte storage key kept in
// the Android Keystore / iOS Keychain. Everything secret the mesh stores (its identity, channel
// keys, the text of my own DMs) is sealed with it before it reaches localStorage or IndexedDB,
// so a copy of the app's files isn't enough to read them, and deleting the storage key (panic
// wipe) makes them unreadable at once. In the browser there is no secure store, so no vault.
//
// Sealed form: [version 1][nonce 24][XChaCha20-Poly1305 ciphertext + tag]

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concat, fromHex, randomBytes, toHex, utf8 } from "./bytes";
import type {
  MeshStore,
  RetentionFor,
  StoredCarrier,
  StoredChannel,
  StoredContact,
  StoredControl,
  StoredEpochKey,
  StoredMessage,
  StoredOutbox,
} from "./store";

const VERSION = 1;
const NONCE_BYTES = 24;
const SEALED_PREFIX = "sealed:";

export class KeyVault {
  constructor(private readonly key: Uint8Array) {
    if (key.length !== 32) throw new Error("storage key must be 32 bytes");
  }

  seal(data: Uint8Array): Uint8Array {
    const nonce = randomBytes(NONCE_BYTES);
    return concat(Uint8Array.of(VERSION), nonce, xchacha20poly1305(this.key, nonce).encrypt(data));
  }

  /** Null if it wasn't sealed with this key (or was changed). */
  open(sealed: Uint8Array): Uint8Array | null {
    if (sealed.length < 1 + NONCE_BYTES + 16 || sealed[0] !== VERSION) return null;
    try {
      return xchacha20poly1305(this.key, sealed.subarray(1, 1 + NONCE_BYTES)).decrypt(sealed.subarray(1 + NONCE_BYTES));
    } catch {
      return null;
    }
  }

  /** For localStorage: "sealed:<hex>". */
  sealText(hex: string): string {
    return SEALED_PREFIX + toHex(this.seal(fromHex(hex) ?? utf8(hex)));
  }

  openText(stored: string): string | null {
    if (!stored.startsWith(SEALED_PREFIX)) return null;
    const bytes = fromHex(stored.slice(SEALED_PREFIX.length));
    const opened = bytes && this.open(bytes);
    return opened ? toHex(opened) : null;
  }
}

export function isSealedText(stored: string | null): boolean {
  return !!stored?.startsWith(SEALED_PREFIX);
}

/**
 * Wraps a store so channel keys and my own DM text are sealed at rest. Rows that can't be opened
 * (the storage key is gone) are dropped on load, as if they'd been wiped.
 */
export class SealedMeshStore implements MeshStore {
  constructor(
    private readonly inner: MeshStore,
    private readonly vault: KeyVault,
  ) {}

  async save(m: StoredMessage): Promise<void> {
    if (!m.plain) return this.inner.save(m);
    const { plain, ...rest } = m;
    await this.inner.save({ ...rest, plainSealed: this.vault.seal(utf8(JSON.stringify(plain))) });
  }

  async load(): Promise<StoredMessage[]> {
    const rows = await this.inner.load();
    return rows.map((r) => {
      if (!r.plainSealed) return r;
      const { plainSealed, ...rest } = r;
      const opened = this.vault.open(plainSealed);
      if (!opened) return rest;
      try {
        return { ...rest, plain: JSON.parse(new TextDecoder().decode(opened)) };
      } catch {
        return rest;
      }
    });
  }

  async saveEpochKey(k: StoredEpochKey): Promise<void> {
    await this.inner.saveEpochKey({
      ...k,
      key: this.vault.seal(k.key),
      alternates: k.alternates?.map((a) => ({ ...a, key: this.vault.seal(a.key) })),
      sealed: true,
    });
  }

  async loadEpochKeys(): Promise<StoredEpochKey[]> {
    const out: StoredEpochKey[] = [];
    for (const k of await this.inner.loadEpochKeys()) {
      if (!k.sealed) {
        out.push(k); // from before the vault existed
        continue;
      }
      const key = this.vault.open(k.key);
      if (!key) continue;
      const alternates = (k.alternates ?? [])
        .map((a) => ({ ...a, key: this.vault.open(a.key) }))
        .filter((a): a is { changeHash: string; key: Uint8Array } => !!a.key);
      const { sealed: _sealed, ...rest } = k;
      void _sealed;
      out.push({ ...rest, key, alternates });
    }
    return out;
  }

  /* everything else passes straight through */
  prune(limits: RetentionFor) {
    return this.inner.prune(limits);
  }
  clear() {
    return this.inner.clear();
  }
  loadChannels() {
    return this.inner.loadChannels();
  }
  saveChannel(c: StoredChannel) {
    return this.inner.saveChannel(c);
  }
  deleteEpochKeys(id: string) {
    return this.inner.deleteEpochKeys(id);
  }
  loadControl() {
    return this.inner.loadControl();
  }
  saveControl(r: StoredControl) {
    return this.inner.saveControl(r);
  }
  deleteControl(ids: string[]) {
    return this.inner.deleteControl(ids);
  }
  loadOutbox() {
    return this.inner.loadOutbox();
  }
  saveOutbox(r: StoredOutbox) {
    return this.inner.saveOutbox(r);
  }
  deleteOutbox(ids: string[]) {
    return this.inner.deleteOutbox(ids);
  }
  loadCarrier() {
    return this.inner.loadCarrier();
  }
  saveCarrier(r: StoredCarrier) {
    return this.inner.saveCarrier(r);
  }
  deleteCarrier(ids: string[]) {
    return this.inner.deleteCarrier(ids);
  }
  loadContacts() {
    return this.inner.loadContacts();
  }
  saveContact(r: StoredContact) {
    return this.inner.saveContact(r);
  }
  destroy() {
    return this.inner.destroy();
  }
}
