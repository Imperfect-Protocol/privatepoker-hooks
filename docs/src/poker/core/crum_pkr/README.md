# `src/poker/core/crum_pkr`

`crum_pkr` is the reusable Texas Hold'em poker engine with cryptographic card handling.

## Files

- `poker_table.js`: table model.
- `poker_hand.js`: hand state machine.
- `poker_bets.js`: betting state.
- `poker_deck.js`: masked/unmasked deck operations.
- `hand_evaluator.js`: showdown evaluation.
- `crum_bls_bridge.js`: bridge to BLS crypto helpers.
- `poker_events.js`, `poker_state.js`, `poker_hand_proxy.js`, `poker_console.js`: supporting runtime helpers.

## Boundary

This package should remain poker-core. Browser networking, chain calls, React hooks, and UI state do not belong here.
