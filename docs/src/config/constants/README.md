# `src/config/constants`

This directory contains shared constants that are used across domains.

## Current Contents

- game type, lobby, and table flag maps
- Chips decimals and unit conversion helpers
- operator gas top-up defaults
- demo disclaimer text
- subscription tiers
- BLS table-session typed-data constants

## Boundary

Constants should not import runtime services. If a value becomes environment-specific, move it to `config/chain` or `config/mesh`.
