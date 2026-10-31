// The desktop app (frontend/desktop, built with Wails) runs this same static build in a
// native window. It exposes the Go Bluetooth layer as window.go.main.App and events through
// window.runtime. This file turns that into the BleMeshPlugin interface the phone apps use,
// so the mesh code doesn't need to know which one it's talking to.

import type { PluginListenerHandle } from "@capacitor/core";
import type { BleMeshPlugin } from "./mesh/transports/BleLinkTransport";

interface WailsApp {
  EnsurePermissions(): Promise<{ granted: boolean }>;
  Start(opts: { serviceUuid?: string; characteristicUuid?: string; maxLinks?: number }): Promise<void>;
  Stop(): Promise<void>;
  Send(linkId: string, data: string): Promise<{ queued: boolean }>;
  GetState(): ReturnType<BleMeshPlugin["getState"]>;
  EnableBluetooth(): Promise<void>;
  GetCapabilities(): ReturnType<BleMeshPlugin["getCapabilities"]>;
  SetPowerMode(opts: { mode: string; maxLinks: number }): Promise<void>;
  GetStorageKey(): Promise<{ key: string }>;
  DeleteStorageKey(): Promise<void>;
}

interface WailsWindow {
  go?: { main?: { App?: WailsApp } };
  runtime?: { EventsOn(name: string, cb: (data: unknown) => void): () => void };
}

function wails(): WailsWindow {
  return typeof window === "undefined" ? {} : (window as unknown as WailsWindow);
}

/** True inside the desktop app. */
export function isDesktopApp(): boolean {
  return !!wails().go?.main?.App;
}

/** Go returns error codes as plain strings; give them the `code` field the transport reads. */
function withCode(err: unknown): never {
  const message = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  const e = new Error(message) as Error & { code?: string };
  if (/^[A-Z_]+$/.test(message)) e.code = message;
  throw e;
}

export function createDesktopBleMeshPlugin(): BleMeshPlugin {
  const app = wails().go!.main!.App!;
  const on = (event: string, cb: (data: never) => void): Promise<PluginListenerHandle> => {
    const off = wails().runtime!.EventsOn(`blemesh:${event}`, cb as (data: unknown) => void);
    return Promise.resolve({ remove: async () => off() });
  };

  return {
    ensurePermissions: () => app.EnsurePermissions().catch(withCode),
    start: (opts = {}) => app.Start(opts).catch(withCode),
    stop: () => app.Stop().catch(withCode),
    send: ({ linkId, data }) => app.Send(linkId, data).catch(withCode),
    getState: () => app.GetState(),
    enableBluetooth: () => app.EnableBluetooth(),
    addListener: on as BleMeshPlugin["addListener"],
    getCapabilities: () => app.GetCapabilities(),
    setPowerMode: (opts) => app.SetPowerMode(opts),
    // Desktops report battery through the web Battery API (the mesh falls back to it).
    getBattery: () => Promise.reject(new Error("UNSUPPORTED")),
    getStorageKey: () => app.GetStorageKey().catch(withCode),
    deleteStorageKey: () => app.DeleteStorageKey().catch(withCode),
  };
}
