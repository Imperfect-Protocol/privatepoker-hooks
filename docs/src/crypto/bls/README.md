# `src/crypto/bls`

This directory wraps BLS12-381 operations used by Private Poker.

## Files

- `bytes.js`: byte conversion helpers.
- `curves.js`: curve exports.
- `frontend_compat.js`: browser compatibility helpers.
- `hash_to_curve.js`: hash-to-curve operations.
- `identity.js`: identity/key derivation helpers.
- `lagrange.js`: threshold/Lagrange combination and recovery.
- `sign.js`: signing/masking operations.
- `signal_crypto.js`: encryption primitives used by signalling adapters.
- `types.js`, `unsupported.js`, `util.js`, `verify.js`: supporting helpers and verification.

## Boundary

This directory is crypto-only. Poker, networking, and account code can depend on it; it should not depend on them.
