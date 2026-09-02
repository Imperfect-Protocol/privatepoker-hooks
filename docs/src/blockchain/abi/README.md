# `src/blockchain/abi`

This directory is the single home for contract ABI definitions used by the package.

## Files

- `AccountAbi.js`: account lifecycle and subscription contract functions.
- `ChipsAbi.js`: Chips balance, allowance, and approve functions.
- `LobbyAbi.js`: lobby and table read/write functions plus lobby/table events.
- `PpdcAbi.js`: PPDC allowance/approval helpers.
- `SettlerAbi.js`: start hand, aggregate public key, and settle hand functions.
- `index.js`: ABI barrel export.

## Boundary

ABI modules should export parsed ABI constants only. Decoding and transaction behavior belongs elsewhere.
