// One mesh session per page, exposed as an external store for useSyncExternalStore.
// Only the /mesh page uses this. It never touches Socket.IO, mediasoup, or localStorage.user
// (it only reads the username to suggest a nickname).

import { isDesktopApp } from "../desktop";
import { loadIdentity } from "./identity";
import {
  IDLE_SNAPSHOT,
  MeshService,
  type CreateChannelOptions,
  type JoinResult,
  type MeshSnapshot,
} from "./MeshService";
import { cleanNickname } from "./payloads";
import { LINKS_FOR, PowerController, readWebBattery } from "./power";
import { IdbMeshStore, MemoryMeshStore, type MeshStore } from "./store";
import type { BleLinkTransport as BleTransport } from "./transports/BleLinkTransport";
import { KeyVault, SealedMeshStore } from "./vault";
import { BridgeLinkTransport, bridgeUrlFrom } from "./transports/BridgeLinkTransport";
import { CompositeTransport } from "./transports/CompositeTransport";
import { DevLinkTransport } from "./transports/DevLinkTransport";
import type { LinkTransport } from "./transports/LinkTransport";

export type MeshMode = "sim" | "ble";

export interface MeshSessionState extends MeshSnapshot {
  mode: MeshMode | null;
  /** Position in the simulated chain (sim mode only). null = linked to every tab. */
  simPosition: number | null;
  /** This build knows a bridge server address. */
  bridgeAvailable: boolean;
  /** The user hasn't turned the bridge off. */
  bridgeEnabled: boolean;
}

const IDLE: MeshSessionState = {
  ...IDLE_SNAPSHOT,
  mode: null,
  simPosition: null,
  bridgeAvailable: false,
  bridgeEnabled: false,
};

// Simulated phones keep their identity per tab (sessionStorage) so every tab is a different
// "phone". The real app keeps it in localStorage.
const KEYS = {
  sim: { identity: "mesh:sim:identity", nickname: "mesh:sim:nickname", seq: "mesh:sim:seq", bridge: "mesh:sim:bridge" },
  ble: { identity: "mesh:identity", nickname: "mesh:nickname", seq: "mesh:seq", bridge: "mesh:bridge" },
} as const;

/**
 * The internet bridge lives on the backend at /mesh-bridge (docs/10 C5). Override with
 * NEXT_PUBLIC_MESH_BRIDGE_URL; otherwise it's derived from the backend URL. Only the address is
 * read here: the mesh never uses the Socket.IO client.
 */
function bridgeUrl(): string | null {
  const explicit = process.env.NEXT_PUBLIC_MESH_BRIDGE_URL;
  if (explicit) return explicit;
  const backend = process.env.NEXT_PUBLIC_SOCKET_URL;
  return backend ? bridgeUrlFrom(backend) : null;
}

function bridgeEnabledFor(m: MeshMode): boolean {
  return safeGet(storageFor(m), KEYS[m].bridge) !== "off";
}
const SIM_ENABLED_KEY = "mesh:sim:enabled";
const SIM_POSITION_KEY = "mesh:sim:position";

let service: MeshService | null = null;
let store: MeshStore | null = null;
let bleTransport: BleTransport | null = null;
let power: PowerController | null = null;
let simTransport: DevLinkTransport | null = null;
let unsubscribe: (() => void) | null = null;
let mode: MeshMode | null = null;
let state: MeshSessionState = IDLE;
/** Bumped on every start/stop, so a start that is still loading can tell it was cancelled. */
let generation = 0;
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
  state = {
    ...snapshot,
    mode,
    simPosition: simTransport?.getPosition() ?? null,
    bridgeAvailable: !!bridgeUrl(),
    bridgeEnabled: mode ? bridgeEnabledFor(mode) : false,
  };
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

/** True inside the phone apps (Capacitor) or the desktop app (Wails): real Bluetooth is available. */
export function isNativeApp(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return cap?.isNativePlatform?.() === true || isDesktopApp();
}

export function isSimRemembered(): boolean {
  return safeGet(sessionStorage, SIM_ENABLED_KEY) === "1";
}

/* ---------------- actions ---------------- */

export async function startMesh(nextMode: MeshMode): Promise<void> {
  if (service) return;
  const gen = ++generation;
  mode = nextMode;

  let transport: LinkTransport;
  if (nextMode === "ble") {
    update({ ...IDLE_SNAPSHOT, status: "starting" });
    // Loaded only in the app, and only when the mesh starts.
    const { BleLinkTransport } = await import("./transports/BleLinkTransport");
    if (gen !== generation) return; // stopped while loading
    bleTransport = new BleLinkTransport();
    transport = bleTransport;
  } else {
    safeSet(sessionStorage, SIM_ENABLED_KEY, "1");
    const savedPos = safeGet(sessionStorage, SIM_POSITION_KEY);
    const position = savedPos !== null && savedPos !== "" && !Number.isNaN(Number(savedPos)) ? Number(savedPos) : null;
    simTransport = new DevLinkTransport(position);
    transport = simTransport;
  }

  const storage = storageFor(nextMode);
  const keys = KEYS[nextMode];
  // In the app, seal secrets with the Keystore/Keychain storage key (C7). Builds whose plugin
  // doesn't have it yet keep working unsealed, as before.
  const storageKey = bleTransport ? await bleTransport.storageKey() : null;
  if (gen !== generation) return;
  const vault = storageKey ? new KeyVault(storageKey) : null;
  const identity = loadIdentity(storage, keys.identity, vault);
  const url = bridgeUrl();
  const bridge =
    url && bridgeEnabledFor(nextMode) ? new BridgeLinkTransport({ url, onStatus: () => service?.refresh() }) : undefined;
  service = new MeshService({
    transport: bridge ? new CompositeTransport(transport, [bridge]) : transport,
    bridge,
    identity,
    nickname: safeGet(storage, keys.nickname) ?? defaultNickname(identity.fingerprint, nextMode),
    // Simulated phones keep history in memory, so reloading a tab shows catch-up sync working.
    store: (store = nextMode === "sim" ? new MemoryMeshStore() : vault ? new SealedMeshStore(new IdbMeshStore(), vault) : new IdbMeshStore()),
    keysProtected: !!vault,
    seqStorage: {
      // Older builds stored one number; newer ones a JSON map of per-channel counters.
      load: () => {
        const raw = safeGet(storage, keys.seq) ?? "";
        try {
          const v: unknown = JSON.parse(raw);
          if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
          if (v && typeof v === "object") {
            const out: Record<string, number> = {};
            for (const [k, n] of Object.entries(v)) if (Number.isInteger(n) && (n as number) >= 0) out[k] = n as number;
            return out;
          }
        } catch {
          // Missing or corrupt: start again.
        }
        return {};
      },
      save: (seqs) => safeSet(storage, keys.seq, JSON.stringify(seqs)),
    },
  });
  unsubscribe = service.subscribe(update);
  update(service.getSnapshot());
  await service.start();
  if (gen !== generation) return;
  // Power modes (C7): visibility and battery decide how hard the radio works.
  const ble = bleTransport;
  power = new PowerController({
    apply: (m) => {
      service?.setPowerMode(m);
      void ble?.setPowerMode(m, LINKS_FOR[m]);
    },
    readBattery: async () => (ble ? ((await ble.readBattery()) ?? (await readWebBattery())) : readWebBattery()),
  });
  await power.start();
}

export async function stopMesh(options: { forget?: boolean } = {}): Promise<void> {
  generation++;
  const current = service;
  service = null;
  power?.stop();
  power = null;
  bleTransport = null;
  unsubscribe?.();
  unsubscribe = null;
  simTransport = null;
  if (options.forget) safeSet(sessionStorage, SIM_ENABLED_KEY, null);
  mode = null;
  state = IDLE;
  for (const l of listeners) l();
  await current?.stop();
}

/** Stops and starts again in the same mode (e.g. after turning Bluetooth on). */
export async function restartMesh(): Promise<void> {
  const m = mode;
  if (!m) return;
  await stopMesh();
  await startMesh(m);
}

/** Shows Android's "Turn on Bluetooth?" dialog (app only). */
export async function enableBluetooth(): Promise<void> {
  if (!isNativeApp()) return;
  const { getBleMeshPlugin } = await import("./transports/BleLinkTransport");
  await getBleMeshPlugin()
    .enableBluetooth()
    .catch(() => {});
}

export function sendMeshText(text: string): void {
  service?.sendText(text);
}

/** Creates a channel and opens it. Returns its ID, or null if the mesh isn't running. */
export async function createMeshChannel(opts: CreateChannelOptions): Promise<string | null> {
  return service ? service.createChannel(opts) : null;
}

export async function joinMeshChannel(id: string, password?: string, note?: string): Promise<JoinResult> {
  return service ? service.joinChannel(id, password, note) : "unknown";
}

export async function joinMeshChannelWithInvite(text: string, note?: string): Promise<JoinResult> {
  return service ? service.joinWithInvite(text, note) : "unknown";
}

/** Admin actions on a private channel. Throw if not allowed. */
export const meshChannelAdmin = {
  approve: (id: string, key: string) => service?.approveJoin(id, key),
  decline: (id: string, key: string) => service?.declineJoin(id, key),
  remove: (id: string, key: string) => service?.removeMember(id, key),
  setRole: (id: string, key: string, role: number) => service?.setMemberRole(id, key, role as 0 | 1 | 2 | 3),
  rotate: (id: string) => service?.rotateChannelKey(id),
  invite: (id: string) => service?.createInvite(id) ?? null,
};

/** Opens a direct conversation with someone (hex public key). */
export function openMeshDirect(peerKey: string): void {
  service?.openDirect(peerKey);
}

export function setMeshContactVerified(peerKey: string, verified: boolean): void {
  service?.setContactVerified(peerKey, verified);
}

/**
 * Panic wipe (docs/10 C6): deletes everything the mesh keeps on this device (mesh-db and every
 * "mesh:" key, including the identity), then starts again as a new identity. Text Chat and
 * Voice data aren't touched.
 */
export async function panicWipeMesh(): Promise<void> {
  const m = mode;
  const s = store;
  const ble = bleTransport;
  await stopMesh();
  // Destroys the Keystore/Keychain key first: anything sealed with it is unreadable from here on.
  await ble?.deleteStorageKey().catch(() => {});
  store = null;
  await s?.destroy().catch(() => {});
  if (!s && (!m || m === "ble")) {
    // Also covers a wipe before the mesh ever started on this device.
    await new IdbMeshStore().destroy().catch(() => {});
  }
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        // Keep only the simulator's own switches, so a simulated tab comes back as a new phone.
        if (k?.startsWith("mesh:") && k !== SIM_ENABLED_KEY && k !== SIM_POSITION_KEY) keys.push(k);
      }
      for (const k of keys) storage.removeItem(k);
    } catch {
      // Storage blocked: nothing saved there to wipe.
    }
  }
  if (m) await startMesh(m);
}

export function leaveMeshChannel(id: string): void {
  service?.leaveChannel(id);
}

/** Opens a channel, or the Lobby with "". */
export function setMeshActiveChannel(id: string): void {
  service?.setActiveChannel(id);
}

/** Turns the internet bridge on or off (restarts the mesh). */
export async function setMeshBridgeEnabled(enabled: boolean): Promise<void> {
  if (!mode) return;
  safeSet(storageFor(mode), KEYS[mode].bridge, enabled ? null : "off");
  await restartMesh();
}

export function setMeshNickname(nickname: string): void {
  const clean = cleanNickname(nickname);
  if (!clean || !service || !mode) return;
  safeSet(storageFor(mode), KEYS[mode].nickname, clean);
  service.setNickname(clean);
}

export function setSimPosition(position: number | null): void {
  if (!simTransport || !service) return;
  safeSet(sessionStorage, SIM_POSITION_KEY, position === null ? null : String(position));
  simTransport.setPosition(position);
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
