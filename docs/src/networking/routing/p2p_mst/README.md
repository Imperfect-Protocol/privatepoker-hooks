# `src/networking/routing/p2p_mst`

This directory implements P2P route-intent gossip and MST-style route planning.

## Files

- `ConnectionMstPlanner.js`: builds a plan that marks selected direct edges and cut/P2P routes.
- `RouteIntentGraph.js`: stores directional route intents, TTL distance, seen-neighbor metadata, and merge logic.
- `identity.js`: stable peer and edge ids.
- `constants.js`: message and route-state constants.
- `index.js`: public barrel.

## Route Collaboration

```mermaid
sequenceDiagram
  participant A as Node A
  participant C as Node C
  participant D as Node D
  participant Graph as RouteIntentGraph
  participant Planner as ConnectionMstPlanner

  A->>C: MST fragment A=>B ttl=1
  D->>C: MST fragment D=>E ttl=3
  C->>Graph: Merge route intents
  Graph->>Graph: Keep shortest TTL candidates
  C->>Planner: Build plan
  Planner-->>C: selected edges and cuts
  C->>A: Forward only unseen useful fragment
```

## Boundary

This package should remain independent from WebRTC and HTTP. Tests should cover complex graph convergence and stale intent expiry.
