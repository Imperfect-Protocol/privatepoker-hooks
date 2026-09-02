# `src/blockchain/errors`

This directory translates raw chain and contract errors into messages the application can show or log.

## Files

- `ChainErrors.js`: known revert/error matching and `formatChainError`.

## Boundary

Keep error formatting deterministic and side-effect free. Do not put transaction submission or UI toast behavior here.
