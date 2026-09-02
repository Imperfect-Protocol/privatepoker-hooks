import { normalizePeerId } from './identity.js';

export const CONNECTION_ROUTE = {
  MESH_NODE: 'MeshNode',
  P2P: 'P2P',
};

function pairKey(left, right) {
  const peers = [normalizePeerId(left), normalizePeerId(right)].sort();
  return peers.join('<->');
}

function directedKey(from, to) {
  return `${normalizePeerId(from)}=>${normalizePeerId(to)}`;
}

function compareIntent(left, right) {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return String(left.flowId).localeCompare(String(right.flowId));
}

function compareUndirectedEdge(left, right) {
  if (left.weight !== right.weight) return left.weight - right.weight;
  return left.key.localeCompare(right.key);
}

function latestDirectedIntents(intents) {
  const byDirection = new Map();

  intents.forEach((intent, index) => {
    const normalized = {
      ...intent,
      from: normalizePeerId(intent.from),
      to: normalizePeerId(intent.to),
      createdAt: Number(intent.createdAt ?? 0),
      order: index,
    };
    const key = directedKey(normalized.from, normalized.to);
    const existing = byDirection.get(key);
    if (!existing || normalized.createdAt > existing.createdAt || (
      normalized.createdAt === existing.createdAt && normalized.order > existing.order
    )) {
      byDirection.set(key, normalized);
    }
  });

  return Array.from(byDirection.values());
}

function buildUndirectedEdges(intents) {
  const byPair = new Map();

  intents.forEach((intent) => {
    const key = pairKey(intent.from, intent.to);
    if (!byPair.has(key)) {
      byPair.set(key, {
        key,
        intents: [],
        nodes: key.split('<->'),
        weight: Number.POSITIVE_INFINITY,
      });
    }

    const edge = byPair.get(key);
    edge.intents.push(intent);
    edge.weight = Math.min(edge.weight, intent.weight ?? 1);
  });

  return Array.from(byPair.values()).map((edge) => ({
    ...edge,
    intents: edge.intents.sort(compareIntent),
  }));
}

function buildSelectedAdjacency(selectedEdges) {
  const adjacency = new Map();
  const add = (from, to) => {
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from).add(to);
  };

  selectedEdges.forEach((edge) => {
    const [left, right] = edge.nodes;
    add(left, right);
    add(right, left);
  });

  return adjacency;
}

function findPath(adjacency, from, to) {
  const start = normalizePeerId(from);
  const target = normalizePeerId(to);
  const queue = [[start]];
  const seen = new Set([start]);

  while (queue.length > 0) {
    const path = queue.shift();
    const current = path.at(-1);
    if (current === target) return path;

    const neighbors = Array.from(adjacency.get(current) ?? []).sort();
    neighbors.forEach((neighbor) => {
      if (seen.has(neighbor)) return;
      seen.add(neighbor);
      queue.push([...path, neighbor]);
    });
  }

  return null;
}

export class ConnectionMstPlanner {
  plan(input) {
    const {
      meshEstablished = [],
      intents = [],
    } = Array.isArray(input) ? { intents: input } : input;

    if (meshEstablished.length === 0) return this.planFromScratch(intents);
    return this.planFromEstablishedMesh({ meshEstablished, intents });
  }

  planFromEstablishedMesh({ meshEstablished, intents }) {
    const establishedIntents = latestDirectedIntents(meshEstablished);
    const pendingIntents = latestDirectedIntents(intents);
    const adjacency = buildSelectedAdjacency(buildUndirectedEdges(establishedIntents));
    const establishedRoutes = establishedIntents.map((intent) => ({
      intent,
      mode: CONNECTION_ROUTE.MESH_NODE,
      path: [intent.from, intent.to],
      reason: 'mesh-precondition',
    }));
    const p2pRoutes = pendingIntents.map((intent) => this.p2pRoute(
      intent,
      adjacency,
      'mesh-precondition-route',
    ));

    return [...establishedRoutes, ...p2pRoutes]
      .sort((left, right) => left.intent.order - right.intent.order);
  }

  planFromScratch(intents) {
    const activeIntents = latestDirectedIntents(intents);
    const undirectedEdges = buildUndirectedEdges(activeIntents);
    const selectedEdges = this.prim(undirectedEdges);
    const selectedPairs = new Set(selectedEdges.map((edge) => edge.key));
    const adjacency = buildSelectedAdjacency(selectedEdges);

    return undirectedEdges
      .flatMap((edge) => this.classifyEdge({
        edge,
        selected: selectedPairs.has(edge.key),
        selectedAdjacency: adjacency,
      }))
      .sort((left, right) => left.intent.order - right.intent.order);
  }

  prim(edges) {
    const nodes = Array.from(new Set(edges.flatMap((edge) => edge.nodes))).sort();
    const byNode = new Map();
    edges.forEach((edge) => {
      edge.nodes.forEach((node) => {
        if (!byNode.has(node)) byNode.set(node, []);
        byNode.get(node).push(edge);
      });
    });

    const selected = [];
    const visited = new Set();

    nodes.forEach((start) => {
      if (visited.has(start)) return;
      visited.add(start);

      while (true) {
        const nextEdge = Array.from(visited)
          .flatMap((node) => byNode.get(node) ?? [])
          .filter((edge) => edge.nodes.some((node) => !visited.has(node)))
          .sort(compareUndirectedEdge)[0];

        if (!nextEdge) break;
        selected.push(nextEdge);
        nextEdge.nodes.forEach((node) => visited.add(node));
      }
    });

    return selected;
  }

  classifyEdge({ edge, selected, selectedAdjacency }) {
    if (!selected) {
      return edge.intents.map((intent) => this.p2pRoute(intent, selectedAdjacency, 'cut'));
    }

    const [primary, ...reverseOrDuplicate] = edge.intents;
    return [
      {
        intent: primary,
        mode: CONNECTION_ROUTE.MESH_NODE,
        path: [primary.from, primary.to],
        reason: 'mst-edge',
      },
      ...reverseOrDuplicate.map((intent) => this.p2pRoute(intent, selectedAdjacency, 'opposite-direction')),
    ];
  }

  p2pRoute(intent, selectedAdjacency, reason) {
    return {
      intent,
      mode: CONNECTION_ROUTE.P2P,
      path: findPath(selectedAdjacency, intent.from, intent.to),
      reason,
    };
  }
}
