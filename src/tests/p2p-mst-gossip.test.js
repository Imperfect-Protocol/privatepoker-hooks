import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONNECTION_ROUTE,
  ConnectionMstPlanner,
  makeP2PMstEdgeId,
  P2P_MST_ROUTE_STATE,
} from 'privatepoker-hooks/networking/routing/p2p_mst/index.js';
import { TestP2PMstNode } from './p2p-mst-test-node.js';

const intent = (from, to) => ({
  flowId: `${from}-${to}-flow`,
  from,
  to,
  createdAt: Date.now(),
});

const edgeId = (from, to) => makeP2PMstEdgeId({
  flowId: `${from}-${to}-flow`,
  from,
  to,
});

const byDirection = (plan, from, to) => plan.find((route) => (
  route.intent.from === from.toLowerCase() && route.intent.to === to.toLowerCase()
));

function assertRoute(plan, from, to, mode, path) {
  const route = byDirection(plan, from, to);
  assert.equal(route.mode, mode);
  assert.deepEqual(route.path, path);
}

test('P2P MST planner classifies selected edges through mesh and cuts through P2P paths', () => {
  const planner = new ConnectionMstPlanner();
  const plan = planner.plan({
    meshEstablished: [
      { ...intent('A', 'B'), createdAt: 1 },
      { ...intent('C', 'D'), createdAt: 3 },
      { ...intent('C', 'B'), createdAt: 4 },
    ],
    intents: [
      { ...intent('B', 'A'), createdAt: 2 },
      { ...intent('D', 'A'), createdAt: 5 },
    ],
  });

  assertRoute(plan, 'A', 'B', CONNECTION_ROUTE.MESH_NODE, ['a', 'b']);
  assertRoute(plan, 'B', 'A', CONNECTION_ROUTE.P2P, ['b', 'a']);
  assertRoute(plan, 'C', 'D', CONNECTION_ROUTE.MESH_NODE, ['c', 'd']);
  assertRoute(plan, 'C', 'B', CONNECTION_ROUTE.MESH_NODE, ['c', 'b']);
  assertRoute(plan, 'D', 'A', CONNECTION_ROUTE.P2P, ['d', 'c', 'b', 'a']);
});

test('P2P MST planner handles a larger graph with multiple cuts over the selected tree', () => {
  const planner = new ConnectionMstPlanner();
  const plan = planner.plan({
    meshEstablished: [
      { ...intent('A', 'B'), createdAt: 1 },
      { ...intent('B', 'C'), createdAt: 2 },
      { ...intent('C', 'D'), createdAt: 3 },
      { ...intent('D', 'E'), createdAt: 4 },
      { ...intent('E', 'F'), createdAt: 5 },
    ],
    intents: [
      { ...intent('A', 'F'), createdAt: 6 },
      { ...intent('B', 'E'), createdAt: 7 },
      { ...intent('F', 'C'), createdAt: 8 },
    ],
  });

  assertRoute(plan, 'A', 'B', CONNECTION_ROUTE.MESH_NODE, ['a', 'b']);
  assertRoute(plan, 'B', 'C', CONNECTION_ROUTE.MESH_NODE, ['b', 'c']);
  assertRoute(plan, 'C', 'D', CONNECTION_ROUTE.MESH_NODE, ['c', 'd']);
  assertRoute(plan, 'D', 'E', CONNECTION_ROUTE.MESH_NODE, ['d', 'e']);
  assertRoute(plan, 'E', 'F', CONNECTION_ROUTE.MESH_NODE, ['e', 'f']);
  assertRoute(plan, 'A', 'F', CONNECTION_ROUTE.P2P, ['a', 'b', 'c', 'd', 'e', 'f']);
  assertRoute(plan, 'B', 'E', CONNECTION_ROUTE.P2P, ['b', 'c', 'd', 'e']);
  assertRoute(plan, 'F', 'C', CONNECTION_ROUTE.P2P, ['f', 'e', 'd', 'c']);
});

test('P2P MST planner routes over a branched established mesh tree', () => {
  const planner = new ConnectionMstPlanner();
  const plan = planner.plan({
    meshEstablished: [
      { ...intent('A', 'B'), createdAt: 1 },
      { ...intent('B', 'C'), createdAt: 2 },
      { ...intent('C', 'D'), createdAt: 3 },
      { ...intent('C', 'E'), createdAt: 4 },
      { ...intent('E', 'F'), createdAt: 5 },
      { ...intent('F', 'G'), createdAt: 6 },
      { ...intent('B', 'H'), createdAt: 7 },
    ],
    intents: [
      { ...intent('G', 'A'), createdAt: 8 },
      { ...intent('H', 'D'), createdAt: 9 },
      { ...intent('F', 'B'), createdAt: 10 },
      { ...intent('E', 'A'), createdAt: 11 },
      { ...intent('C', 'B'), createdAt: 12 },
    ],
  });

  assertRoute(plan, 'G', 'A', CONNECTION_ROUTE.P2P, ['g', 'f', 'e', 'c', 'b', 'a']);
  assertRoute(plan, 'H', 'D', CONNECTION_ROUTE.P2P, ['h', 'b', 'c', 'd']);
  assertRoute(plan, 'F', 'B', CONNECTION_ROUTE.P2P, ['f', 'e', 'c', 'b']);
  assertRoute(plan, 'E', 'A', CONNECTION_ROUTE.P2P, ['e', 'c', 'b', 'a']);
  assertRoute(plan, 'C', 'B', CONNECTION_ROUTE.P2P, ['c', 'b']);
});

test('P2P MST planner leaves P2P path unresolved across disconnected mesh components', () => {
  const planner = new ConnectionMstPlanner();
  const plan = planner.plan({
    meshEstablished: [
      { ...intent('A', 'B'), createdAt: 1 },
      { ...intent('C', 'D'), createdAt: 2 },
      { ...intent('E', 'F'), createdAt: 3 },
    ],
    intents: [
      { ...intent('A', 'D'), createdAt: 4 },
      { ...intent('F', 'E'), createdAt: 5 },
    ],
  });

  assertRoute(plan, 'A', 'D', CONNECTION_ROUTE.P2P, null);
  assertRoute(plan, 'F', 'E', CONNECTION_ROUTE.P2P, ['f', 'e']);
});

test('P2P MST planner keeps only the latest directed intent before routing', () => {
  const planner = new ConnectionMstPlanner();
  const plan = planner.plan({
    meshEstablished: [
      { ...intent('A', 'B'), createdAt: 1 },
      { ...intent('B', 'C'), createdAt: 2 },
    ],
    intents: [
      { ...intent('C', 'A'), flowId: 'old-flow', createdAt: 3 },
      { ...intent('C', 'A'), flowId: 'new-flow', createdAt: 4 },
    ],
  });
  const route = byDirection(plan, 'C', 'A');

  assert.equal(route.intent.flowId, 'new-flow');
  assert.equal(route.mode, CONNECTION_ROUTE.P2P);
  assert.deepEqual(route.path, ['c', 'b', 'a']);
});

test('P2P MST gossip expands fragments and filters routes already seen by each neighbor', () => {
  const a = new TestP2PMstNode('A');
  const b = new TestP2PMstNode('B');
  const c = new TestP2PMstNode('C');
  const d = new TestP2PMstNode('D');

  a.connect(c);
  b.connect(c);
  d.connect(c);

  a.announceIntent(intent('A', 'B'));
  b.announceIntent(intent('B', 'A'));
  d.announceIntent(intent('D', 'A'));

  const edgesSentToA = a.receivedEdgesFrom('C').map((edge) => edge.edgeId);
  const edgesSentToB = b.receivedEdgesFrom('C').map((edge) => edge.edgeId);

  assert.ok(edgesSentToA.includes(edgeId('B', 'A')));
  assert.ok(edgesSentToA.includes(edgeId('D', 'A')));
  assert.ok(!edgesSentToA.includes(edgeId('A', 'B')));

  assert.ok(edgesSentToB.includes(edgeId('A', 'B')));
  assert.ok(edgesSentToB.includes(edgeId('D', 'A')));
  assert.ok(!edgesSentToB.includes(edgeId('B', 'A')));
});

test('P2P MST keeps the shortest TTL-distance route and cuts longer candidates', () => {
  const c = new TestP2PMstNode('C');
  const d = new TestP2PMstNode('D');
  const h = new TestP2PMstNode('H');
  const j = new TestP2PMstNode('J');
  const x = new TestP2PMstNode('X');

  d.connect(x);
  x.connect(h);
  h.connect(c);
  d.connect(j);
  j.connect(c);

  d.announceIntent(intent('D', 'E'));

  const routeViaH = c.graph.candidate(edgeId('D', 'E'), 'H');
  const routeViaJ = c.graph.candidate(edgeId('D', 'E'), 'J');
  const selected = c.graph.selectedRoute(edgeId('D', 'E'));

  assert.equal(routeViaH.distance, 3);
  assert.equal(routeViaJ.distance, 2);
  assert.equal(routeViaH.routeState, P2P_MST_ROUTE_STATE.CUT);
  assert.equal(routeViaJ.routeState, P2P_MST_ROUTE_STATE.SELECTED);
  assert.equal(selected.viaNeighbor, 'j');

  const cutsSentToH = h.receivedEdgesFrom('C')
    .filter((edge) => edge.edgeId === edgeId('D', 'E'))
    .filter((edge) => edge.routeState === P2P_MST_ROUTE_STATE.CUT);

  assert.equal(cutsSentToH.length, 1);
  assert.equal(cutsSentToH[0].selectedVia, 'j');
});

test('P2P MST graph reports selected routes by direction', () => {
  const a = new TestP2PMstNode('A');
  const b = new TestP2PMstNode('B');
  a.connect(b);

  a.announceIntent(intent('A', 'B'));

  assert.equal(a.graph.hasSelectedRoute({ from: 'A', to: 'B' }), true);
  assert.equal(b.graph.hasSelectedRoute({ from: 'A', to: 'B' }), true);
  assert.equal(b.graph.hasSelectedRoute({ from: 'B', to: 'A' }), false);
});

test('P2P MST gossip does not forward expired route intents', () => {
  const a = new TestP2PMstNode('A');
  const b = new TestP2PMstNode('B');
  a.connect(b);

  a.announceIntent({
    ...intent('A', 'B'),
    createdAt: Date.now() - 10_000,
    ttlMs: 1,
  });

  assert.equal(b.inbox.length, 0);
});

test('P2P MST gossip converges on shortest routes in a diamond graph', () => {
  const a = new TestP2PMstNode('A');
  const b = new TestP2PMstNode('B');
  const c = new TestP2PMstNode('C');
  const d = new TestP2PMstNode('D');
  const e = new TestP2PMstNode('E');
  const f = new TestP2PMstNode('F');

  a.connect(b);
  b.connect(c);
  c.connect(f);
  a.connect(d);
  d.connect(e);
  e.connect(f);
  a.connect(e);
  b.connect(e);

  a.announceIntent(intent('A', 'Z'));

  const routeViaC = f.graph.candidate(edgeId('A', 'Z'), 'C');
  const routeViaE = f.graph.candidate(edgeId('A', 'Z'), 'E');
  const selected = f.graph.selectedRoute(edgeId('A', 'Z'));

  assert.equal(routeViaC.routeState, P2P_MST_ROUTE_STATE.CUT);
  assert.equal(routeViaE.routeState, P2P_MST_ROUTE_STATE.SELECTED);
  assert.equal(routeViaC.distance, 3);
  assert.equal(routeViaE.distance, 2);
  assert.equal(selected.viaNeighbor, 'e');
});
