# `src/networking/session`

This directory contains the visible WebRTC table session facade.

## Files

- `PokerRtcSession.js`: manages per-table peer subscriptions, data channels, signed transport messages, encrypted signalling, mesh/P2P connection establishment, and media/data-channel state.

## Sequence

```mermaid
sequenceDiagram
  participant Hook as useNetwork
  participant Session as PokerRtcSession
  participant Pool as RtcSessionPool
  participant Mesh as PrivateMeshClient
  participant Peer as Remote peer

  Hook->>Session: subscribe(peer)
  Session->>Pool: check route / announce intent
  alt route exists
    Session->>Pool: send offer via P2P route
  else route unknown
    Session->>Mesh: announce offer via mesh
  end
  Peer-->>Session: answer
  Session-->>Hook: connection state update
```

## Boundary

`PokerRtcSession` is intentionally documented as a facade today. Future collaborators should split signing, peer connection lifecycle, discovery, media, and signal codec responsibilities.
