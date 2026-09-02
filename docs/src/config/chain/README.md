# `src/config/chain`

This directory selects the active blockchain environment and exposes derived chain constants.

## Files

- `index.js`: selects `devnode` or `sepolia` and exports contract addresses, polling interval, stale time, and max-gas config.
- `nitroDevNode.js`: viem chain definition for local Nitro devnode.
- `polling.js`: shared polling defaults for `ChainPoller`.
- `environments/*`: concrete environment config objects.

## Boundary

Chain selection belongs here. viem client construction belongs in `blockchain/clients`.
