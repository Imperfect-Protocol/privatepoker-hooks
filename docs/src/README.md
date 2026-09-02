# `src`

`src` is the package boundary for all publishable Private Poker backbone code. It is organized by responsibility rather than by framework: account, blockchain, config, crypto, lobby events, networking, poker, React adapters, shims, and tests.

See the top-level [Architecture](../README.md) guide for the full dependency diagram.

## Directory Contract

- Domain and protocol code should stay independent of React and browser UI.
- React hooks compose lower layers for app consumption.
- Config selection stays under `config`.
- Public import paths are declared in `package.json`.
