// Power modes (docs/10 C7). Picks how hard the radio works:
//   foreground: the app is open and on screen → scan all the time, up to 7 links
//   background: the app is in the background → scan 5 s in every 15 s
//   low:        battery under 20 % and not charging → duty cycle, at most 3 links, and stop
//               carrying or relaying other people's channels
// The native plugin applies the radio part when it supports it (older builds just ignore it);
// the router applies the "don't carry for others" part.

export type PowerMode = "foreground" | "background" | "low";

export interface BatteryReading {
  level: number; // 0–1
  charging: boolean;
}

export const LOW_BATTERY = 0.2;
export const LINKS_FOR: Record<PowerMode, number> = { foreground: 7, background: 7, low: 3 };
const BATTERY_POLL_MS = 60_000;

export function pickPowerMode(visible: boolean, battery: BatteryReading | null): PowerMode {
  if (battery && !battery.charging && battery.level < LOW_BATTERY) return "low";
  return visible ? "foreground" : "background";
}

export interface PowerOptions {
  /** Applies a mode (radio + router). */
  apply: (mode: PowerMode) => void;
  readBattery?: () => Promise<BatteryReading | null>;
  isVisible?: () => boolean;
  watchVisibility?: (cb: () => void) => () => void;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

/** Watches visibility and battery and applies the right mode whenever it changes. */
export class PowerController {
  private mode: PowerMode | null = null;
  private battery: BatteryReading | null = null;
  private stops: (() => void)[] = [];

  constructor(private readonly opts: PowerOptions) {}

  getMode(): PowerMode | null {
    return this.mode;
  }

  async start(): Promise<void> {
    const watch = this.opts.watchVisibility ?? watchDocumentVisibility;
    this.stops.push(watch(() => this.update()));
    const timer = this.opts.setTimer ?? ((fn, ms) => {
      const h = setInterval(fn, ms);
      return () => clearInterval(h);
    });
    this.stops.push(timer(() => void this.refreshBattery(), BATTERY_POLL_MS));
    await this.refreshBattery();
  }

  stop(): void {
    for (const s of this.stops) s();
    this.stops = [];
  }

  async refreshBattery(): Promise<void> {
    try {
      this.battery = (await (this.opts.readBattery ?? readWebBattery)()) ?? null;
    } catch {
      this.battery = null;
    }
    this.update();
  }

  private update(): void {
    const visible = (this.opts.isVisible ?? documentVisible)();
    const next = pickPowerMode(visible, this.battery);
    if (next === this.mode) return;
    this.mode = next;
    this.opts.apply(next);
  }
}

function documentVisible(): boolean {
  return typeof document === "undefined" ? true : document.visibilityState !== "hidden";
}

function watchDocumentVisibility(cb: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

/** The web Battery Status API (Chrome and Android WebView; not Safari/iOS). */
export async function readWebBattery(): Promise<BatteryReading | null> {
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> });
  if (!nav?.getBattery) return null;
  const b = await nav.getBattery();
  return { level: b.level, charging: b.charging };
}
