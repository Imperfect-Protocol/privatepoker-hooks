# `src/poker`

The poker directory owns reusable poker domain and protocol behavior.

## Children

- `core`: low-level poker and protocol packages.
- `hand`: hand-level derived data and settlement helpers.
- `lobby`: stake helpers.
- `table`: table protocol state helpers.

## Boundary

Poker code may use crypto primitives and config constants. It should not import React hooks, wallet clients, mesh endpoints, or WebRTC classes.
