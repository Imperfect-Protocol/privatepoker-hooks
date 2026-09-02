# `src/blockchain`

The blockchain directory contains all reusable chain-facing primitives: ABIs, viem clients, polling, gas estimation, operator transactions, receipt logging, and error formatting.

```mermaid
flowchart LR
  Hooks[react/hooks] --> Abi[abi]
  Hooks --> Polling[polling]
  Hooks --> Transactions[transactions]
  Polling --> Clients[clients]
  Transactions --> Clients
  Transactions --> Errors[errors]
  Clients --> Config[config/chain]
```

## Boundary

Blockchain modules may depend on viem and chain config. They should not depend on React components or poker UI state.
