# React Adapters

The React vertical is the package's app-facing adapter layer. It exposes providers and hooks that combine account sessions, BLS key derivation, contract access, network sessions, and poker runtime state.

## Responsibilities

- Provide account session and BLS context state.
- Expose feature hooks for lobbies, tables, accounts, Chips, network, and final verification.
- Convert low-level domain events into ergonomic view state and actions.
- Keep UI components in the consuming app, not in the package.

## Component View

```mermaid
flowchart LR
  Components[App components] --> Contexts[react/contexts]
  Components --> Hooks[react/hooks]
  Contexts --> Account[account]
  Contexts --> Crypto[crypto]
  Hooks --> Blockchain[blockchain]
  Hooks --> Networking[networking]
  Hooks --> Poker[poker]
  Hooks --> Lobby[lobby]
```

## Hook Collaboration

```mermaid
classDiagram
  class AccountSessionProvider {
    +restore session
    +sign in with wallet
    +broadcast session across tabs
  }
  class BLSProvider {
    +derive table keys
    +derive hand keys
  }
  class useTable {
    +load table data
    +derive seating state
  }
  class useNetwork {
    +connect table peers
  }
  class usePokerTable {
    +run hand protocol
    +surface actions and view state
  }
  class useFinalVerification {
    +aggregate signatures
    +submit settlement writes
  }

  BLSProvider --> AccountSessionProvider
  usePokerTable --> useTable
  usePokerTable --> useNetwork
  usePokerTable --> useFinalVerification
```

## Design Rules

- Hooks are allowed to import React, wagmi, browser APIs, and package services.
- Domain code must not import hooks.
- Prefer hooks returning stable state/actions over hooks exposing lower-level mutable objects.
- Keep view-model formatting close to hooks until it becomes reusable across multiple apps.
- Move pure helpers out of hooks as soon as they are tested and independently meaningful.
