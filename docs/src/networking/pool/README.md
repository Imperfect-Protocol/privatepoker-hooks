# `src/networking/pool`

This directory contains the shared browser-wide RTC session pool.

## Files

- `RtcSessionPool.js`: facade for silent lobby connections, local session lookup, BroadcastChannel/SharedWorker routing, route intent gossip, and background P2P forwarding.

## Activity

```mermaid
flowchart TD
  Visible[Visible table session] --> Register[Register session in pool]
  Register --> Worker[Connect SharedWorker]
  Register --> Silent[Maintain silent lobby endpoints]
  Visible --> Intent[Publish route intent]
  Intent --> Gossip[Forward MST fragment]
  Gossip --> Route{Route available?}
  Route -- Yes --> Forward[Forward signalling over P2P]
  Route -- No --> Wait[Wait for mesh/session fallback]
```

## Boundary

`RtcSessionPool` is currently a large facade. Future refactors should split worker bridge, route gossip, session registry, and silent connection lifecycle into collaborators without changing exported behavior.
