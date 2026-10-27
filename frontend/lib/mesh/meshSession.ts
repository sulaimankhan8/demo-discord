// One mesh session per page, exposed as an external store for useSyncExternalStore.
// Only the /mesh page uses this. It never touches Socket.IO, mediasoup, or localStorage.user
// (it only reads the username to suggest a nickname).

import { loadIdentity } from "./identity";
import { IDLE_SNAPSHOT, MeshService, type MeshSnapshot } from "./MeshService";
import { cleanNickname } from "./payloads";
import { IdbMeshStore, MemoryMeshStore } from "./store";
import { DevLinkTransport } from "./transports/DevLinkTransport";

export type MeshMode = "sim" | "ble";

export interface MeshSessionState extends MeshSnapshot {
  mode: MeshMode | null;
  /** Position in the simulated chain (sim mode only). null = linked to every tab. */
  simPosition: number | null;
}

const IDLE: MeshSessionState = { ...IDLE_SNAPSHOT, mode: null, simPosition: null };

// Simulated phones keep their identity per tab (sessionStorage) so every tab is a different
// "phone". The real app keeps it in localStorage.
const KEYS = {
  sim: { identity: "mesh:sim:identity", nickname: "mesh:sim:nickname" },
  ble: { identity: "mesh:identity", nickname: "mesh:nickname" },
} as const;
const SIM_ENABLED_KEY = "mesh:sim:enabled";
const SIM_POSITION_KEY = "mesh:sim:position";

let service: MeshService | null = null;
let transport: DevLinkTransport | null = null;
let unsubscribe: (() => void) | null = null;
let mode: MeshMode | null = null;
let state: MeshSessionState = IDLE;
const listeners = new Set<() => void>();

function storageFor(m: MeshMode): Storage {
  return m === "sim" ? sessionStorage : localStorage;
}

function safeGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Storage blocked: the setting just won't be remembered.
  }
}

function update(snapshot: MeshSnapshot): void {
  state = { ...snapshot, mode, simPosition: transport?.getPosition() ?? null };
  for (const l of listeners) l();
}

/* ---------------- store API ---------------- */

export function subscribeMesh(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMeshState(): MeshSessionState {
  return state;
}

export function getServerMeshState(): MeshSessionState {
  return IDLE;
}

/* ---------------- environment ---------------- */

/** True inside the Capacitor app (Phase 0+). */
export function isNativeApp(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

export function isSimRemembered(): boolean {
  return safeGet(sessionStorage, SIM_ENABLED_KEY) === "1";
}

/* ---------------- actions ---------------- */

export async function startMesh(nextMode: MeshMode): Promise<void> {
  if (service) return;

  if (nextMode === "ble") {
    // The Bluetooth plugin arrives in Phase 2.
    mode = "ble";
    update({ ...IDLE_SNAPSHOT, status: "error", error: "Bluetooth mesh isn't available in this build yet." });
    return;
  }

  mode = nextMode;
  safeSet(sessionStorage, SIM_ENABLED_KEY, "1");
  const storage = storageFor(nextMode);
  const keys = KEYS[nextMode];
  const identity = loadIdentity(storage, keys.identity);

  const savedPos = safeGet(sessionStorage, SIM_POSITION_KEY);
  const position = savedPos !== null && savedPos !== "" && !Number.isNaN(Number(savedPos)) ? Number(savedPos) : null;
  transport = new DevLinkTransport(position);

  service = new MeshService({
    transport,
    identity,
    nickname: safeGet(storage, keys.nickname) ?? defaultNickname(identity.fingerprint, nextMode),
    // Simulated phones keep history in memory, so reloading a tab shows catch-up sync working.
    store: nextMode === "sim" ? new MemoryMeshStore() : new IdbMeshStore(),
  });
  unsubscribe = service.subscribe(update);
  update(service.getSnapshot());
  await service.start();
}

export async function stopMesh(options: { forget?: boolean } = {}): Promise<void> {
  const current = service;
  service = null;
  unsubscribe?.();
  unsubscribe = null;
  transport = null;
  if (options.forget) safeSet(sessionStorage, SIM_ENABLED_KEY, null);
  mode = null;
  state = IDLE;
  for (const l of listeners) l();
  await current?.stop();
}

export function sendMeshText(text: string): void {
  service?.sendText(text);
}

export function setMeshNickname(nickname: string): void {
  const clean = cleanNickname(nickname);
  if (!clean || !service || !mode) return;
  safeSet(storageFor(mode), KEYS[mode].nickname, clean);
  service.setNickname(clean);
}

export function setSimPosition(position: number | null): void {
  if (!transport || !service) return;
  safeSet(sessionStorage, SIM_POSITION_KEY, position === null ? null : String(position));
  transport.setPosition(position);
  update(service.getSnapshot());
}

function defaultNickname(fingerprint: string, m: MeshMode): string {
  let username = "";
  try {
    const raw = localStorage.getItem("user");
    username = raw ? String(JSON.parse(raw)?.username ?? "") : "";
  } catch {
    username = "";
  }
  const tag = fingerprint.slice(0, 4);
  if (!username) return `anon-${tag}`;
  // In the simulator every tab shares one login, so add a tag to tell the tabs apart.
  return m === "sim" ? `${username}-${tag}` : username;
}
