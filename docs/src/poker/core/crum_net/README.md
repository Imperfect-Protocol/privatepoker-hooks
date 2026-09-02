# `src/poker/core/crum_net`

`crum_net` contains poker network protocol primitives.

## Files

- `design.js`: command/event vocabulary and runtime design types.
- `messages.js`: peer announcements, endpoint descriptors, handshake signals, poker action envelopes, and client state.
- `network_model.js`: conceptual network/lobby/game model classes.
- `poker_deck_serialization.js`: card/deck wire serialization.
- `poker_sync.js`: sync client.
- `sync_stream.js`: ordered frame stream helpers.
- `topology.js`: topology policies and expected peer selection.
- `transport.js`: memory transport.

## Boundary

`crum_net` defines protocol messages and topology. It should not own concrete WebRTC or private mesh transport code.
