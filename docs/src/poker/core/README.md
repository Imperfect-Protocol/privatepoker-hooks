# `src/poker/core`

This directory contains low-level reusable poker packages.

## Children

- `crum_pkr`: Texas Hold'em engine and cryptographic card model.
- `crum_net`: protocol messages, topology, sync stream, and in-memory transport model.

## Boundary

Core code should be portable. It is the lowest poker layer and should not depend on app framework code.
