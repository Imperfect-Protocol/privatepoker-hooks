# PrivatePoker Hooks Architecture

`privatepoker-hooks` is the publishable backbone of Private Poker. It contains the reusable peer-to-peer networking, mesh signalling, blockchain access, cryptographic helpers, poker protocol code, and React orchestration hooks that a frontend can compose into an application.

The package deliberately does not contain the Private Poker product UI. A consuming app can create lobbies, join tables, establish WebRTC connections, exchange poker protocol messages, verify final hand state, and write settlement transactions, but the app owns visual presentation and user flow.

## Architectural Goals

- Keep reusable protocol machinery outside the frontend app.
- Make networking, blockchain, poker, account, config, and React adapter responsibilities visible in the folder structure.
- Keep pure domain logic independent from browser APIs, wallet APIs, and React.
- Keep React hooks thin enough that they orchestrate services rather than owning every detail.
- Publish stable public imports through `package.json` exports while retaining legacy compatibility paths.

## Top-Level Source Map

```text
src/
  account/       Wallet-derived account sessions and encrypted profile blobs.
  blockchain/    ABIs, viem clients, gas helpers, transaction logging, chain polling.
  config/        Dev/main environment selection, chain config, mesh endpoints, constants.
  crypto/        BLS12-381 primitives and signal encryption support.
  lobby/         Local browser lobby events shared by app components.
  networking/    WebRTC sessions, session pool, mesh relay, P2P route discovery.
  poker/         Poker domain logic, protocol state, settlement helpers.
  react/         Context providers and hooks for consuming frontends.
  shared/        Reserved home for general utilities that do not belong to a domain.
  shims/         Compatibility shims used outside Next.js.
  tests/         Node test coverage for settlement and P2P MST gossip/routing.
```

## Dependency Direction

The clean direction is from outer layers to inner layers:

```mermaid
flowchart TD
  App[Consuming frontend app] --> React[react hooks and contexts]
  React --> Account[account]
  React --> Blockchain[blockchain]
  React --> Networking[networking]
  React --> Poker[poker]
  Networking --> Crypto[crypto]
  Networking --> Config[config]
  Networking --> PokerProtocol[poker/core/crum_net]
  Blockchain --> Config
  Poker --> Crypto
  Poker --> Config
  Account --> Crypto
  Account --> Config
```

Inner layers should not import React. Poker core should not import wallet clients, WebRTC, mesh servers, or browser storage. Blockchain modules should not know about UI components. This keeps the package useful as a library and makes future extraction into worker/runtime packages easier.

## Runtime Component View

```mermaid
flowchart LR
  subgraph UI["Consuming app"]
    Components[App components]
  end

  subgraph ReactLayer["react"]
    Contexts[Account and BLS contexts]
    Hooks[Feature hooks]
  end

  subgraph Networking["networking"]
    Session[PokerRtcSession]
    Pool[RtcSessionPool]
    Mesh[PrivateMeshClient]
    Routes[P2P MST routing]
    Worker[SharedWorker pool]
  end

  subgraph Chain["blockchain"]
    Abi[ABIs]
    Clients[Viem clients]
    Poller[ChainPoller]
    Tx[Gas and tx helpers]
  end

  subgraph Domain["poker and account"]
    PokerCore[Crum poker core]
    PokerNet[Crum net protocol]
    Settlement[FinalHandSettlement]
    Account[Account session/profile]
    BLS[BLS crypto]
  end

  Components --> Hooks
  Components --> Contexts
  Hooks --> Session
  Hooks --> Pool
  Hooks --> Clients
  Hooks --> Poller
  Hooks --> PokerCore
  Hooks --> PokerNet
  Hooks --> Settlement
  Contexts --> Account
  Session --> Mesh
  Session --> Pool
  Pool --> Routes
  Pool --> Worker
  Mesh --> BLS
  Account --> BLS
  PokerCore --> BLS
  Tx --> Clients
  Clients --> Abi
```

## P2P Connection Sequence

```mermaid
sequenceDiagram
  participant A as Peer A UI
  participant HA as React hooks A
  participant SA as PokerRtcSession A
  participant Pool as RtcSessionPool / SharedWorker
  participant Mesh as Private Mesh relay
  participant SB as PokerRtcSession B
  participant HB as React hooks B
  participant B as Peer B UI

  A->>HA: Join table / subscribe to peer
  HA->>SA: Ensure peer connection
  SA->>Pool: Announce route intent A=>B
  Pool-->>SA: P2P route available if known
  alt Destination reachable over background P2P
    SA->>Pool: Forward offer over P2P route
    Pool->>SB: Routed encrypted offer
  else Destination not reachable over P2P
    SA->>Mesh: Announce via configured mesh endpoints
    Mesh->>SB: Deliver encrypted offer
  end
  SB->>HB: Request answer from local peer
  HB->>B: Create answer
  B-->>HB: Encrypted SDP answer
  HB-->>SB: Answer
  SB-->>SA: Return answer through selected transport
  SA-->>HA: Connected
```

## Table And Hand Activity

```mermaid
flowchart TD
  Start([Player opens table]) --> Load[Load table details from chain]
  Load --> Keys[Derive table BLS session keys]
  Keys --> Network[Establish required WebRTC topology]
  Network --> Aggregate[Collect table aggregate public key shares]
  Aggregate --> Ready{All required table setup complete?}
  Ready -- No --> Network
  Ready -- Yes --> StartHand[Submit startHand readiness]
  StartHand --> Deal[Run cryptographic poker hand]
  Deal --> History[Exchange signed hand history]
  History --> Verify[Verify transcript, shuffle, unmasking]
  Verify --> Settle[Build final settlement]
  Settle --> Sign[Collect BLS final settlement signatures]
  Sign --> Chain[Submit settlement transaction]
  Chain --> Done([Hand settled])
```

## Collaboration Diagram

```mermaid
classDiagram
  class usePokerTable {
    +orchestrates table runtime
    +returns view state and actions
  }
  class useNetwork {
    +creates PokerRtcSession
    +connects table peers
  }
  class PokerRtcSession {
    +owns WebRTC peer session
    +chooses mesh or P2P route
  }
  class RtcSessionPool {
    +shares silent background links
    +routes MST fragments
  }
  class ConnectionMstPlanner {
    +selects route edges
    +marks cut/P2P paths
  }
  class usePrivatePokerLobby {
    +reads/writes lobby contract
  }
  class useFinalVerification {
    +builds verification state
    +submits settlement tx
  }
  class FinalHandSettlement {
    +pure winner and payout calculation
  }

  usePokerTable --> useNetwork
  usePokerTable --> usePrivatePokerLobby
  usePokerTable --> useFinalVerification
  usePokerTable --> FinalHandSettlement
  useNetwork --> PokerRtcSession
  PokerRtcSession --> RtcSessionPool
  RtcSessionPool --> ConnectionMstPlanner
```

## Documentation Index

- [Networking](./verticals/networking.md)
- [Blockchain](./verticals/blockchain.md)
- [Poker](./verticals/poker.md)
- [React Adapters](./verticals/react.md)
- [Configuration](./verticals/configuration.md)
- [Source Directory Map](./src/README.md)

## Current Refactor Boundary

The package is now organized by responsibility, but two runtime classes remain intentionally large:

- `src/networking/session/PokerRtcSession.js`
- `src/networking/pool/RtcSessionPool.js`

They are documented as facades for now. Future refactors should split them into smaller collaborators without changing their public contracts first.
