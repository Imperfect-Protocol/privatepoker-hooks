# `src/tests`

This directory contains Node test coverage for package behavior.

## Coverage

- Final settlement flow and Lagrange aggregation.
- P2P MST route planning.
- P2P MST gossip convergence, TTL filtering, stale intent handling, and complex graph routing.
- Live devnode/signature tests for manual or environment-backed verification.

## Boundary

Tests should exercise package APIs and pure logic directly. Live tests should remain opt-in and environment-aware.
