# `src/config/chain/environments`

This directory contains concrete chain configuration objects.

## Files

- `devnode.js`: local devnode addresses and RPC config.
- `sepolia.js`: Arbitrum Sepolia addresses and RPC config.

## Boundary

Environment files should be declarative. They should not create clients, run network calls, or read browser state.
