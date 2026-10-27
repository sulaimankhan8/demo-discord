"use client";

import { useSyncExternalStore } from "react";
import {
  getMeshState,
  getServerMeshState,
  isNativeApp,
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
    send: sendMeshText,
    setNickname: setMeshNickname,
    setSimPosition,
  };
}
