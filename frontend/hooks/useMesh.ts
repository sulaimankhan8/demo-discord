"use client";

import { useSyncExternalStore } from "react";
import {
  createMeshChannel,
  enableBluetooth,
  getMeshState,
  getServerMeshState,
  isNativeApp,
  joinMeshChannel,
  joinMeshChannelWithInvite,
  meshChannelAdmin,
  leaveMeshChannel,
  openMeshDirect,
  panicWipeMesh,
  setMeshContactVerified,
  restartMesh,
  sendMeshText,
  setMeshActiveChannel,
  setMeshBridgeEnabled,
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
    createChannel: createMeshChannel,
    joinChannel: joinMeshChannel,
    joinWithInvite: joinMeshChannelWithInvite,
    channelAdmin: meshChannelAdmin,
    leaveChannel: leaveMeshChannel,
    setActiveChannel: setMeshActiveChannel,
    setBridgeEnabled: setMeshBridgeEnabled,
    openDirect: openMeshDirect,
    setContactVerified: setMeshContactVerified,
    panicWipe: panicWipeMesh,
  };
}
