"use client";

import { useSyncExternalStore } from "react";
import {
  enableBluetooth,
  getMeshState,
  getServerMeshState,
  isNativeApp,
  restartMesh,
  sendMeshText,
  setMeshNickname,
  setSimPosition,
  startMesh,
  stopMesh,
  subscribeMesh,
} from "@/lib/mesh/meshSession";

const noopSubscribe = () => () => {};

export function useMesh() {
  const state = useSyncExternalStore(subscribeMesh, getMeshState, getServerMeshState);
  const native = useSyncExternalStore(noopSubscribe, isNativeApp, () => false);

  return {
    state,
    native,
    start: startMesh,
    stop: stopMesh,
    restart: restartMesh,
    enableBluetooth,
    send: sendMeshText,
    setNickname: setMeshNickname,
    setSimPosition,
  };
}
