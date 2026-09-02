# `src/blockchain/clients`

This directory creates configured viem clients for reads and wallet writes.

## Files

- `PokerClients.js`: selected chain mapping, public client, wallet client factory, and sepolia multicall batching.

## Boundary

Client construction depends on `config/chain`. Transaction policies, polling subscribers, and domain decoding should remain outside this directory.
