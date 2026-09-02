export function normalizePeerId(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function makeP2PMstEdgeId({ flowId, from, to }) {
  return [
    String(flowId ?? ''),
    normalizePeerId(from),
    normalizePeerId(to),
  ].join(':');
}

export function stableRouteCandidateKey(candidate) {
  return [
    candidate.edgeId,
    candidate.routeState,
    candidate.viaNeighbor ?? '',
    candidate.selectedVia ?? '',
    candidate.distance,
  ].join('|');
}

