# `src/crypto`

The crypto directory owns reusable cryptographic primitives and adapters.

## Children

- `bls`: BLS12-381 helpers, identity derivation, signing, verification, Lagrange aggregation, and signal encryption primitives.

## Boundary

Crypto code must stay deterministic and framework-free. Do not import React, viem clients, WebRTC sessions, or app state here.
