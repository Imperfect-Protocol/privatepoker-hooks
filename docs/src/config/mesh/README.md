# `src/config/mesh`

This directory selects the active private-mesh environment and exposes endpoint and ICE server configuration.

## Files

- `index.js`: selected mesh config, endpoint list, ICE servers, and `makeMeshRtcConfig`.
- `environments/*`: concrete mesh environment definitions.

## Boundary

Mesh config should not open WebRTC connections or issue HTTP requests. Runtime networking belongs in `networking`.
