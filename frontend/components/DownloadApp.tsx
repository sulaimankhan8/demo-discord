"use client";

import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";

/** Written by `npm run apk` next to the APK in public/downloads. */
interface ApkInfo {
  file: string;
  versionName: string;
  sizeBytes: number;
}

type Device = "android" | "ios" | "other";

function detectDevice(): Device {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "android";
  // iPadOS reports itself as a Mac with touch.
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  return "other";
}

const DownloadIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg className={`${className} fill-none stroke-current`} strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" />
  </svg>
);

/**
 * "Get the Android app" link for the website. Hidden inside the installed app,
 * and hidden when no APK has been published (no /downloads/apk.json).
 */
export default function DownloadApp({ variant = "card" }: { variant?: "card" | "icon" }) {
  const [info, setInfo] = useState<ApkInfo | null>(null);
  const [device, setDevice] = useState<Device>("other");

  useEffect(() => {
    if (Capacitor.getPlatform() !== "web") return;
    let cancelled = false;
    fetch("/downloads/apk.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ApkInfo | null) => {
        if (cancelled || !data?.file) return;
        setDevice(detectDevice());
        setInfo(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info) return null;
  const size = `${(info.sizeBytes / 1048576).toFixed(1)} MB`;

  if (variant === "icon") {
    if (device === "ios") return null;
    return (
      <a
        href={info.file}
        download
        aria-label={`Download the Android app, version ${info.versionName}, ${size}`}
        title={`Android app · v${info.versionName} · ${size}`}
        className="w-10 h-10 flex items-center justify-center rounded-md text-dim hover:text-accent"
      >
        <DownloadIcon className="w-[18px] h-[18px]" />
      </a>
    );
  }

  return (
    <div className="flex items-center gap-3 p-3 bg-surface-0 border border-white/[0.08] rounded-lg">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-ink">Android app</div>
        <div className="text-[11px] text-dim font-mono">
          {device === "ios"
            ? "Not available for iPhone yet"
            : device === "android"
              ? `v${info.versionName} · ${size} · works offline over Bluetooth`
              : `v${info.versionName} · ${size} · open this page on your phone`}
        </div>
      </div>
      {device !== "ios" && (
        <a
          href={info.file}
          download
          className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-accent hover:bg-accent-hover brut text-on-accent text-xs font-semibold rounded-md"
        >
          <DownloadIcon />
          Download APK
        </a>
      )}
    </div>
  );
}
