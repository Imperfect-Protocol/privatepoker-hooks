# `src/react`

The React directory contains the app-facing adapter layer.

## Children

- `contexts`: providers for account session and BLS key derivation.
- `hooks`: reusable hooks for accounts, lobbies, tables, chain polling, networking, and settlement.

## Boundary

React modules may compose every lower layer. Lower layers should not import from `react`.
