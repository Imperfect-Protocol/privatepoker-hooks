import {
  P2P_MST_MESSAGE,
  RouteIntentGraph,
  normalizePeerId,
} from '../lib/p2p_mst/index.js';

export class TestP2PMstNode {
  constructor(nodeId, options = {}) {
    this.nodeId = normalizePeerId(nodeId);
    this.graph = new RouteIntentGraph({ nodeId: this.nodeId, ...options });
    this.neighbors = new Map();
    this.inbox = [];
    this.outbox = [];
  }

  connect(otherNode) {
    this.neighbors.set(otherNode.nodeId, otherNode);
    otherNode.neighbors.set(this.nodeId, this);
  }

  announceIntent(intent) {
    this.graph.addLocalIntent(intent);
    this.flushGossip();
  }

  receive(fragment, fromNeighbor) {
    if (fragment?.type !== P2P_MST_MESSAGE.FRAGMENT) return;

    this.inbox.push({ fromNeighbor: normalizePeerId(fromNeighbor), fragment });
    const changed = this.graph.mergeFragment({
      fragment,
      fromNeighbor,
    });
    if (changed) this.flushGossip();
  }

  flushGossip() {
    for (const neighborId of this.neighbors.keys()) {
      const fragment = this.graph.buildFragmentForNeighbor(neighborId);
      if (!fragment) continue;

      this.outbox.push(fragment);
      this.neighbors.get(neighborId).receive(fragment, this.nodeId);
    }
  }

  receivedEdgesFrom(neighborId) {
    return this.inbox
      .filter((entry) => entry.fromNeighbor === normalizePeerId(neighborId))
      .flatMap((entry) => entry.fragment.edges);
  }
}

