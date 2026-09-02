# `src/react/hooks`

This directory contains reusable React hooks that compose the package into app-level behavior.

## Main Groups

- Account and access: `useAccounts`, `useMemberAccess`, `useOperatorAddress`.
- Chain reads/events: `useChainPolling`, `usePublicContractEvent`.
- Lobby/table contracts: `useLobby`, `usePrivatePokerLobby`, `useTable`, `useCreateTable`, `useJoinTable`, `usePokerChips`.
- Networking: `useNetwork`, `useNetworkTopology`, `usePrivatePokerSignal`, `useRtcSessionPool`, `useTokenRing`.
- Poker runtime: `usePokerTable`, `useFinalVerification`.
- Browser utilities: `useCountdown`, `useRequireBLS`, `useWebcam`.

## Boundary

Hooks are orchestration surfaces. As helper code becomes pure, move it down into the relevant domain folder and re-export for compatibility if needed.
