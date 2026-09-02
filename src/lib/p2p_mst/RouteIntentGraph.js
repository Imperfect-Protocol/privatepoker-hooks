import {
  DEFAULT_MST_EDGE_TTL_MS,
  P2P_MST_MESSAGE,
  P2P_MST_ROUTE_STATE,
} from './constants.js';
import {
  makeP2PMstEdgeId,
  normalizePeerId,
  stableRouteCandidateKey,
} from './identity.js';

function compareRouteCandidates(left, right) {
  if (left.distance !== right.distance) return left.distance - right.distance;
  if (left.observedAt !== right.observedAt) return left.observedAt - right.observedAt;
  return String(left.viaNeighbor ?? '').localeCompare(String(right.viaNeighbor ?? ''));
}

function isTerminalRouteState(routeState) {
  return routeState === P2P_MST_ROUTE_STATE.SELECTED || routeState === P2P_MST_ROUTE_STATE.CUT;
}

export class RouteIntentGraph {
  constructor({ nodeId, edgeTtlMs = DEFAULT_MST_EDGE_TTL_MS } = {}) {
    this.nodeId = normalizePeerId(nodeId);
    this.edgeTtlMs = edgeTtlMs;
    this.edges = new Map();
    this.neighborKnowledge = new Map();
  }

  addLocalIntent({ flowId, from, to, createdAt = Date.now(), ttlMs = this.edgeTtlMs }) {
    const edge = this.ensureEdge({
      flowId,
      from,
      to,
      createdAt,
      ttlMs,
    });

    this.upsertCandidate(edge, {
      distance: 0,
      observedAt: createdAt,
      routeState: P2P_MST_ROUTE_STATE.SELECTED,
      viaNeighbor: this.nodeId,
    });
    this.selectRoutes(createdAt);
    return edge;
  }

  mergeFragment({ fragment, fromNeighbor, receivedAt = Date.now() }) {
    const neighborId = normalizePeerId(fromNeighbor);
    let changed = false;

    for (const route of fragment?.edges ?? []) {
      if (!route || route.expiresAt <= receivedAt) continue;
      if (!isTerminalRouteState(route.routeState)) continue;
      if (normalizePeerId(route.from) === this.nodeId) continue;

      this.markNeighborSaw(neighborId, route);

      const edge = this.ensureEdge({
        edgeId: route.edgeId,
        flowId: route.flowId,
        from: route.from,
        to: route.to,
        createdAt: route.createdAt,
        expiresAt: route.expiresAt,
      });

      const before = this.edgeSignature(edge);
      this.upsertCandidate(edge, {
        distance: Number(route.distance),
        observedAt: receivedAt,
        routeState: route.routeState,
        selectedVia: normalizePeerId(route.selectedVia),
        viaNeighbor: neighborId,
      });
      this.selectRoutes(receivedAt);
      changed = changed || before !== this.edgeSignature(edge);
    }

    return changed;
  }

  buildFragmentForNeighbor(neighborId, { now = Date.now() } = {}) {
    const targetNeighbor = normalizePeerId(neighborId);
    const routes = [];

    for (const edge of this.edges.values()) {
      if (edge.expiresAt <= now) continue;

      const selected = this.selectedCandidate(edge);
      if (!selected) continue;

      const cutForNeighbor = edge.candidates.get(targetNeighbor);
      if (cutForNeighbor?.routeState === P2P_MST_ROUTE_STATE.CUT) {
        routes.push(this.outboundRoute(edge, cutForNeighbor, {
          routeState: P2P_MST_ROUTE_STATE.CUT,
          selectedVia: selected.viaNeighbor,
          targetNeighbor,
        }));
      }

      if (selected.viaNeighbor === targetNeighbor) continue;
      routes.push(this.outboundRoute(edge, selected, {
        routeState: P2P_MST_ROUTE_STATE.SELECTED,
        selectedVia: selected.viaNeighbor,
        targetNeighbor,
      }));
    }

    const unseenRoutes = routes.filter((route) => this.markSentIfNew(targetNeighbor, route));
    if (unseenRoutes.length === 0) return null;

    return {
      type: P2P_MST_MESSAGE.FRAGMENT,
      fromNode: this.nodeId,
      toNode: targetNeighbor,
      createdAt: now,
      edges: unseenRoutes,
    };
  }

  selectedCandidate(edge) {
    return Array.from(edge.candidates.values())
      .filter((candidate) => candidate.routeState === P2P_MST_ROUTE_STATE.SELECTED)
      .sort(compareRouteCandidates)[0] ?? null;
  }

  candidate(edgeId, viaNeighbor) {
    return this.edges.get(edgeId)?.candidates.get(normalizePeerId(viaNeighbor)) ?? null;
  }

  selectedRoute(edgeId) {
    const edge = this.edges.get(edgeId);
    if (!edge) return null;
    return this.selectedCandidate(edge);
  }

  selectedRoutes({ now = Date.now() } = {}) {
    return Array.from(this.edges.values())
      .filter((edge) => edge.expiresAt > now)
      .map((edge) => {
        const candidate = this.selectedCandidate(edge);
        if (!candidate) return null;
        return {
          edgeId: edge.edgeId,
          flowId: edge.flowId,
          from: edge.from,
          to: edge.to,
          createdAt: edge.createdAt,
          expiresAt: edge.expiresAt,
          distance: candidate.distance,
          viaNeighbor: candidate.viaNeighbor,
        };
      })
      .filter(Boolean);
  }

  hasSelectedRoute({ from, to, now = Date.now() }) {
    const origin = normalizePeerId(from);
    const target = normalizePeerId(to);
    return this.selectedRoutes({ now }).some((route) => (
      route.from === origin && route.to === target
    ));
  }

  ensureEdge({
    edgeId,
    flowId,
    from,
    to,
    createdAt = Date.now(),
    expiresAt = null,
    ttlMs = this.edgeTtlMs,
  }) {
    const id = edgeId ?? makeP2PMstEdgeId({ flowId, from, to });
    const existing = this.edges.get(id);
    if (existing) return existing;

    const edge = {
      edgeId: id,
      flowId,
      from: normalizePeerId(from),
      to: normalizePeerId(to),
      createdAt,
      expiresAt: expiresAt ?? createdAt + ttlMs,
      candidates: new Map(),
    };
    this.edges.set(id, edge);
    return edge;
  }

  upsertCandidate(edge, {
    distance,
    observedAt,
    routeState,
    selectedVia = null,
    viaNeighbor,
  }) {
    const neighborId = normalizePeerId(viaNeighbor);
    const existing = edge.candidates.get(neighborId);
    if (existing && compareRouteCandidates(existing, { distance, observedAt, viaNeighbor: neighborId }) <= 0) {
      return existing;
    }

    const candidate = {
      edgeId: edge.edgeId,
      distance,
      observedAt,
      routeState,
      selectedVia,
      viaNeighbor: neighborId,
    };
    edge.candidates.set(neighborId, candidate);
    return candidate;
  }

  selectRoutes(now) {
    for (const edge of this.edges.values()) {
      if (edge.expiresAt <= now) continue;

      const best = Array.from(edge.candidates.values())
        .sort(compareRouteCandidates)[0];
      if (!best) continue;

      for (const candidate of edge.candidates.values()) {
        candidate.routeState = candidate.viaNeighbor === best.viaNeighbor
          ? P2P_MST_ROUTE_STATE.SELECTED
          : P2P_MST_ROUTE_STATE.CUT;
        candidate.selectedVia = best.viaNeighbor;
      }
    }
  }

  outboundRoute(edge, candidate, {
    routeState,
    selectedVia,
    targetNeighbor,
  }) {
    const selected = routeState === P2P_MST_ROUTE_STATE.SELECTED;
    return {
      edgeId: edge.edgeId,
      flowId: edge.flowId,
      from: edge.from,
      to: edge.to,
      createdAt: edge.createdAt,
      expiresAt: edge.expiresAt,
      distance: selected ? candidate.distance + 1 : candidate.distance,
      routeState,
      selectedVia,
      sentVia: this.nodeId,
      targetNeighbor,
    };
  }

  edgeSignature(edge) {
    return JSON.stringify(Array.from(edge.candidates.values())
      .map(stableRouteCandidateKey)
      .sort());
  }

  markNeighborSaw(neighborId, route) {
    this.knowledgeFor(neighborId).add(stableRouteCandidateKey(route));
  }

  markSentIfNew(neighborId, route) {
    const knowledge = this.knowledgeFor(neighborId);
    const key = stableRouteCandidateKey(route);
    if (knowledge.has(key)) return false;
    knowledge.add(key);
    return true;
  }

  knowledgeFor(neighborId) {
    const normalized = normalizePeerId(neighborId);
    if (!this.neighborKnowledge.has(normalized)) {
      this.neighborKnowledge.set(normalized, new Set());
    }
    return this.neighborKnowledge.get(normalized);
  }
}
