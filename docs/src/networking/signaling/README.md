# `src/networking/signaling`

This directory owns signalling transport adapters and encryption helpers.

## Files

- `PrivateMeshClient.js`: talks to configured private mesh endpoints through announce/poll/publish flows.
- `SignalEncryption.js`: normalizes public keys and wraps encrypted message operations.

## Boundary

Signalling code may know about mesh endpoints and encrypted payloads. It should not know poker hand rules or UI component state.
