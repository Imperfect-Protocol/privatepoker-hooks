# Poker

The poker vertical contains domain and protocol code: cryptographic card state, betting state, table and hand transitions, network protocol envelopes, final hand settlement helpers, lobby stake helpers, and table protocol state.

## Responsibilities

- Model Texas Hold'em table and hand state.
- Represent masked/unmasked cards and shuffle/unmask verification bridges.
- Serialize poker network messages.
- Decide table protocol phase transitions.
- Compute final hand settlement payloads.
- Keep domain logic independent of React, browser APIs, wallets, and WebRTC.

## Component View

```mermaid
flowchart TD
  subgraph Core["poker/core"]
    Pkr[crum_pkr: poker engine]
    Net[crum_net: protocol messages]
  end
  Hand[poker/hand] --> Pkr
  Hand --> Config[config/constants]
  Table[poker/table] --> Pkr
  Lobby[poker/lobby] --> Config
  React[react/hooks/usePokerTable] --> Pkr
  React --> Net
  React --> Hand
  React --> Table
```

## Hand Settlement Sequence

```mermaid
sequenceDiagram
  participant Table as usePokerTable
  participant Core as PokerHand
  participant Settle as FinalHandSettlement
  participant Verify as useFinalVerification
  participant Chain as Settlement contract

  Table->>Core: Observe finished hand
  Table->>Settle: buildFinalHandSettlement(hand, seats)
  Settle-->>Table: winner, pot split, chip balances
  Table->>Verify: Build final verification state
  Verify->>Verify: Validate transcript and BLS signatures
  Verify->>Chain: settleHand(...)
  Chain-->>Verify: Receipt
  Verify-->>Table: Settlement complete
```

## Protocol State Activity

```mermaid
flowchart TD
  Aggregate[TableAggregatePublicKey] --> Start[StartHand]
  Start --> InProgress[HandInProgress]
  InProgress --> Settle[SettleHand]
  Settle --> Complete[TableComplete]
  InProgress --> Dispute[HandDisputed]
  Settle --> Dispute
```

## Design Rules

- `crum_pkr` is the poker engine. It should remain reusable outside the browser.
- `crum_net` is protocol-only. It can define envelopes and serialization, but should not own transports.
- Settlement calculation belongs in `poker/hand`.
- Table protocol state belongs in `poker/table`.
- React hooks may orchestrate poker, but should not become the long-term home for pure poker algorithms.
