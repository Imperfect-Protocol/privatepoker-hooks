# `src/blockchain/transactions`

This directory contains reusable transaction support.

## Files

- `GasEstimator.js`: buffered gas estimation and configured max-gas lookup.
- `OperatorAddress.js`: private-key-backed operator writes, gas top-up, and nonce serialization.
- `TransactionReceiptLogger.js`: receipt waiting and write-error logging.

## Boundary

Transaction helpers may use viem clients and chain config. Hook state, dialogs, and app-specific recovery flows belong in React or the consuming app.
