# `src/networking/routing`

This directory owns pure routing algorithms for peer discovery and route selection.

## Children

- `p2p_mst`: route-intent graph, MST planner, route identity helpers, and constants.

## Boundary

Routing code should stay pure and testable. It should not open WebRTC connections, touch browser storage, or call mesh servers.
