# `src/networking/workers`

This directory contains browser worker code used by the networking pool.

## Files

- `rtc-session-pool-worker.js`: SharedWorker message hub for cross-tab RTC pool coordination.

## Boundary

Worker code should stay message-oriented and serializable. Keep DOM and React assumptions out of this directory.
