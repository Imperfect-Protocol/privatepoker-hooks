# `src/poker/hand`

This directory contains hand-level derived data that is pure and reusable.

## Files

- `FinalHandSettlement.js`: calculates winner, pot split, and final chip balances from a finished hand and table seats.

## Boundary

Hand helpers can depend on poker core and config constants. Contract writes and React mutation state belong in `react/hooks/useFinalVerification.js`.
