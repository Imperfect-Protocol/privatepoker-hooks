# `src/account`

The account directory owns wallet-derived account identity, account session serialization, and encrypted profile blob handling.

## Files

- `accountProfile.js`: profile versioning, required-field checks, profile blob encoding/decoding.
- `accountSession.js`: typed-data message, signature-derived session seeds, table/hand key derivation.

## Boundary

Account code may depend on config constants and BLS helpers. It should not depend on React, wagmi, viem contract clients, WebRTC, or app components.
