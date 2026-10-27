"use client";

import { useEffect } from "react";
import AppShell from "@/components/AppShell";
import { useMesh } from "@/hooks/useMesh";
import { isSimRemembered } from "@/lib/mesh/meshSession";
import MeshComposer from "./MeshComposer";
import MeshIcon from "@/components/icons/MeshIcon";
import MeshMessageList from "./MeshMessageList";
import MeshSidebar from "./MeshSidebar";
import { MESH_ACCENT } from "./meshUi";

export default function MeshRoom() {
  const { state, native, start, stop, restart, enableBluetooth, send, setNickname, setSimPosition } = useMesh();

  // The mesh only runs while this page is open (see docs/08 §12).
  useEffect(() => {
    if (native) void start("ble");
    else if (isSimRemembered()) void start("sim");
    return () => {
      void stop();
    };
  }, [native, start, stop]);

  const running = state.status === "running";

  return (
    <AppShell activeChannel="nearby" allowOffline>
      <div className="flex h-full w-full overflow-hidden bg-[#171922] font-sans">
        <div className="flex-1 flex flex-col h-full min-w-0 bg-[#171922]">
          <header className="h-12 px-4 border-b border-white/[0.05] bg-[#171922] flex items-center justify-between shrink-0 z-10">
            <div className="flex items-center gap-2 truncate">
              <span style={{ color: MESH_ACCENT }}>
                <MeshIcon className="w-4 h-4" />
              </span>
              <h2 className="font-semibold text-sm text-white tracking-tight">nearby</h2>
              <div className="h-4 w-[1px] bg-white/[0.08] mx-2 hidden sm:block" />
              <span className="text-xs text-[#949BA4] truncate hidden sm:block font-mono">
                {state.mode === "sim"
                  ? "Offline mesh · browser-tab simulation"
                  : state.mode === "ble"
                    ? "Offline mesh · Bluetooth"
                    : "Offline mesh · no internet needed"}
              </span>
            </div>
            {state.mode && <StatusPill links={state.links} running={running} />}
          </header>

          {state.status === "idle" && !native ? (
            <Intro onStart={() => void start("sim")} />
          ) : state.status === "error" ? (
            <Notice title="Mesh couldn't start" body={state.error ?? "Unknown error."}>
              {state.errorCode === "bluetooth_off" && (
                <button
                  onClick={() => void enableBluetooth()}
                  className="px-4 py-2 bg-[#F0B232] hover:bg-[#D99E22] text-[#08090C] text-xs font-semibold rounded-md transition cursor-pointer"
                >
                  Turn on Bluetooth
                </button>
              )}
              {state.errorCode !== "unsupported" && (
                <button
                  onClick={() => void restart()}
                  className="px-4 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-[#F2F3F5] text-xs font-semibold rounded-md transition cursor-pointer"
                >
                  Try again
                </button>
              )}
            </Notice>
          ) : (
            <>
              {state.notice && (
                <div className="mx-4 mt-3 flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-[#F0B232]/30 bg-[#F0B232]/10 text-[12px] text-[#F0B232]">
                  <span>{state.notice.message}</span>
                  {state.notice.code === "bluetooth_off" && (
                    <button
                      onClick={() => void enableBluetooth()}
                      className="shrink-0 px-2.5 py-1 rounded bg-[#F0B232] hover:bg-[#D99E22] text-[#08090C] text-[11px] font-semibold transition cursor-pointer"
                    >
                      Turn on
                    </button>
                  )}
                </div>
              )}
              <MeshMessageList messages={state.messages} />
              <MeshComposer disabled={!running} onSend={send} />
            </>
          )}
        </div>

        {state.mode && state.status !== "error" && (
          <MeshSidebar
            state={state}
            onNickname={setNickname}
            onSimPosition={setSimPosition}
            onStopSim={() => void stop({ forget: true })}
          />
        )}
      </div>
    </AppShell>
  );
}

function StatusPill({ links, running }: { links: number; running: boolean }) {
  const connected = running && links > 0;
  return (
    <span
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border ${
        connected
          ? "bg-[#23A55A]/15 text-[#23A55A] border-[#23A55A]/30"
          : "bg-[#F0B232]/10 text-[#F0B232] border-[#F0B232]/30"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-[#23A55A]" : "bg-[#F0B232] animate-pulse"}`} />
      {!running ? "Starting…" : connected ? `${links} ${links === 1 ? "link" : "links"}` : "Searching…"}
    </span>
  );
}

function Intro({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-[#12141A] border border-white/[0.06] rounded-xl p-6">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center mb-4 bg-[#F0B232]/10 border border-[#F0B232]/30"
          style={{ color: MESH_ACCENT }}
        >
          <MeshIcon className="w-6 h-6" />
        </div>
        <h3 className="text-base font-bold text-white tracking-tight">Chat with no internet</h3>
        <p className="text-[13px] text-[#949BA4] mt-2 leading-relaxed">
          The offline mesh sends messages phone to phone over Bluetooth. Phones in range pass messages on, so it
          keeps working when mobile networks are down. It runs in the mobile app.
        </p>
        <p className="text-[13px] text-[#949BA4] mt-2 leading-relaxed">
          In the browser you can try it as a simulation: each tab acts as one phone. Open this page in two or three
          tabs.
        </p>
        <button
          onClick={onStart}
          className="mt-5 px-4 py-2 bg-[#F0B232] hover:bg-[#D99E22] text-[#08090C] text-xs font-semibold rounded-md transition cursor-pointer"
        >
          Start simulation
        </button>
      </div>
    </div>
  );
}

function Notice({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-[#12141A] border border-white/[0.06] rounded-xl p-6">
        <h3 className="text-base font-bold text-white tracking-tight">{title}</h3>
        <p className="text-[13px] text-[#949BA4] mt-2 leading-relaxed">{body}</p>
        {children && <div className="mt-5 flex flex-wrap gap-2">{children}</div>}
      </div>
    </div>
  );
}
