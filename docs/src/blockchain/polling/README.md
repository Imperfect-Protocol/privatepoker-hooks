# `src/blockchain/polling`

This directory owns shared contract-read polling and batching.

## Files

- `ChainPoller.js`: subscription registry, stable request keys, due-window batching, viem multicall fallback, and subscriber notification.

```mermaid
sequenceDiagram
  participant Hook as useChainPolling
  participant Poller as ChainPoller
  participant Viem as publicPokerClient

  Hook->>Poller: subscribe(read request)
  Poller->>Poller: merge subscribers by stable key
  Poller->>Viem: multicall/readContract
  Viem-->>Poller: result or error
  Poller-->>Hook: notify subscriber
```

## Boundary

Polling should not know about specific UI screens. Timing defaults live in `config/chain/polling.js`.
