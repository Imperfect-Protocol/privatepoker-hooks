# `src/lobby`

The lobby directory contains browser-local lobby event helpers.

## Files

- `LobbyEvents.js`: emits and subscribes to local table/lobby change events.

## Boundary

This is not the on-chain lobby repository. Contract reads and writes live in `react/hooks/usePrivatePokerLobby.js` and `blockchain`.
