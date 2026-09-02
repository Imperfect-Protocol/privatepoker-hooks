# Blockchain

The blockchain vertical wraps Arbitrum Sepolia or local devnode access. It owns contract interfaces, viem clients, polling aggregation, gas estimation, operator-address writes, transaction receipt logging, and user-facing chain error formatting.

## Responsibilities

- Define contract ABIs in one place.
- Create configured viem public and wallet clients.
- Aggregate repeated reads through `ChainPoller` and viem multicall batching.
- Estimate buffered gas for wallet/operator transactions.
- Serialize operator writes per operator address to avoid nonce collisions.
- Log transaction receipts and translate known chain failures into clearer messages.

## Component View

```mermaid
flowchart LR
  Hooks[React hooks] --> Poller[ChainPoller]
  Hooks --> Tx[Transaction helpers]
  Hooks --> Clients[Viem clients]
  Tx --> Gas[GasEstimator]
  Tx --> Operator[OperatorAddress]
  Operator --> Clients
  Gas --> Clients
  Poller --> Clients
  Clients --> ChainConfig[config/chain]
  Hooks --> ABI[blockchain/abi]
```

## Polling Activity

```mermaid
flowchart TD
  Subscribe[Hook subscribes to contract read] --> Key[Build stable polling key]
  Key --> Queue[Store subscriber under shared request]
  Queue --> Due{Request due within window?}
  Due -- No --> Sleep[Wait for next tick]
  Due -- Yes --> Multi{Chain exposes Multicall3?}
  Multi -- Yes --> Batch[Read via viem multicall]
  Multi -- No --> Direct[Read contracts individually]
  Batch --> Notify[Notify subscribers]
  Direct --> Notify
  Notify --> Schedule[Schedule next invoke time]
  Schedule --> Sleep
```

## Transaction Sequence

```mermaid
sequenceDiagram
  participant Hook as React hook
  participant Gas as GasEstimator
  participant Operator as OperatorAddress
  participant Client as Viem client
  participant Chain as Arbitrum/devnode

  Hook->>Gas: Estimate buffered gas
  Gas->>Client: estimateContractGas
  Client->>Chain: eth_estimateGas
  Chain-->>Client: gas estimate
  Gas-->>Hook: gas overrides
  alt operator write
    Hook->>Operator: enqueue write
    Operator->>Client: ensure balance and send tx
  else wallet write
    Hook->>Client: wallet send tx
  end
  Client->>Chain: transaction
  Chain-->>Client: receipt
  Client-->>Hook: logged receipt or formatted error
```

## Design Rules

- ABI files must not import React hooks.
- Chain environment selection belongs in `config/chain`, not in callers.
- Repeated reads should use `useChainPolling` or `ChainPoller`, not scattered intervals.
- Operator writes should go through `OperatorAddress` so nonce serialization remains central.
- Contract-specific decode helpers can stay near hooks while they are still UI-shaped, but mature decoders should move into blockchain or domain modules.
