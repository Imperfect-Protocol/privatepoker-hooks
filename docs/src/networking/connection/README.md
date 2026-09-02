# `src/networking/connection`

This directory groups connection-establishment strategies.

## Boundary

The connection layer decides how signalling should be attempted. Individual strategies should hide transport details behind a common coordinator-facing shape.
