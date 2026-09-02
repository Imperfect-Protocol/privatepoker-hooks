# `src/react/contexts`

This directory contains React context providers used by consuming apps.

## Files

- `AccountSessionContext.jsx`: wallet sign-in, session restoration, and cross-tab session sharing.
- `BLSContext.jsx`: table and hand BLS key derivation/cache.

## Boundary

Contexts should provide state and actions. Heavy domain algorithms should move to account, crypto, poker, or networking modules.
