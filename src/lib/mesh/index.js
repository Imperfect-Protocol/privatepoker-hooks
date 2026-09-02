/* global process */
import { mesh as devMesh } from './dev.js';
import { mesh as mainMesh } from './main.js';

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
];

const meshes = {
  dev: devMesh,
  main: mainMesh,
};

const selectedMesh = process.env.NEXT_PUBLIC_PRIVATE_POKER_MESH ?? 'main';
const selectedMeshKey = selectedMesh.toLowerCase();

export const MESH = meshes[selectedMeshKey] ?? mainMesh;
export const MESH_KEY = MESH.key;
export const MESH_ENDPOINTS = MESH.endpoints;
export const MESH_ICE_SERVERS = (
  Array.isArray(MESH.iceServers) && MESH.iceServers.length > 0
    ? MESH.iceServers
    : DEFAULT_ICE_SERVERS
);

export function makeMeshRtcConfig({ randomizeIceServer = false } = {}) {
  if (!randomizeIceServer || MESH_ICE_SERVERS.length <= 1) {
    return { iceServers: MESH_ICE_SERVERS };
  }

  const index = Math.floor(Math.random() * MESH_ICE_SERVERS.length);
  return { iceServers: [MESH_ICE_SERVERS[index]] };
}
