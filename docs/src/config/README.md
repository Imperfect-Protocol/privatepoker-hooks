# `src/config`

The config directory centralizes runtime selection and shared constants.

## Children

- `chain`: chain environments, contract addresses, RPC URLs, gas and polling values.
- `mesh`: mesh endpoint and ICE server environments.
- `constants`: cross-domain constants such as game types, Chips decimals, and subscription tiers.
- `proxy`: local dev proxy helpers.

## Boundary

Config exports should be plain data or small derivation helpers. Secrets do not belong here.
