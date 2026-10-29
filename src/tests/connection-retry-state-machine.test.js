import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONNECTION_RETRY_STATE,
  P2PConnectionRetryStateMachine,
  POKE_CONNECTION_TIMEOUT_MS,
} from 'privatepoker-hooks/networking/connection/p2p_connection/index.js';

function createHarness({ p2pAvailable = true, connected = false } = {}) {
  const calls = [];
  const timers = [];
  const changes = [];
  let currentP2PAvailable = p2pAvailable;
  let currentConnected = connected;

  const machine = new P2PConnectionRetryStateMachine({
    peerAddress: '0xpeer',
    hasP2PAvailable: () => currentP2PAvailable,
    isConnected: () => currentConnected,
    tryP2P: () => calls.push('p2p'),
    tryMesh: () => calls.push('mesh'),
    onChange: (snapshot) => changes.push(snapshot.state),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.active = false;
    },
  });

  return {
    calls,
    changes,
    machine,
    setConnected(value) {
      currentConnected = value;
    },
    setP2PAvailable(value) {
      currentP2PAvailable = value;
    },
    fireNextTimer() {
      const timer = timers.find((candidate) => candidate.active);
      assert.ok(timer, 'expected an active retry timer');
      assert.equal(timer.delay, POKE_CONNECTION_TIMEOUT_MS);
      timer.active = false;
      timer.callback();
    },
  };
}

test('connection retry starts with P2P, then Poke retries P2P once before mesh fallback', () => {
  const harness = createHarness({ p2pAvailable: true });

  harness.machine.start();
  assert.equal(harness.machine.snapshot().state, CONNECTION_RETRY_STATE.TRYING_P2P_NETWORK);
  assert.deepEqual(harness.calls, ['p2p']);

  harness.fireNextTimer();
  assert.equal(harness.machine.snapshot().state, CONNECTION_RETRY_STATE.RETRY_VIA_P2P_NETWORK);
  assert.equal(harness.machine.snapshot().canPoke, true);

  harness.machine.poke();
  assert.equal(harness.machine.snapshot().state, CONNECTION_RETRY_STATE.TRYING_P2P_NETWORK);
  assert.deepEqual(harness.calls, ['p2p', 'p2p']);

  harness.fireNextTimer();
  assert.equal(harness.machine.snapshot().state, CONNECTION_RETRY_STATE.RETRY_VIA_MESH_FALLBACK);
  assert.equal(harness.machine.snapshot().canPoke, true);

  harness.machine.poke();
  assert.equal(harness.machine.snapshot().state, CONNECTION_RETRY_STATE.TRYING_MESH);
  assert.deepEqual(harness.calls, ['p2p', 'p2p', 'mesh']);
});

test('connection retry starts with mesh when P2P is unavailable and keeps mesh as the Poke path', () => {
  const harness = createHarness({ p2pAvailable: false });

  harness.machine.start();
  assert.equal(harness.machine.snapshot().state, CONNECTION_RETRY_STATE.TRYING_MESH);
  assert.deepEqual(harness.calls, ['mesh']);

  harness.fireNextTimer();
  assert.equal(harness.machine.snapshot().state, CONNECTION_RETRY_STATE.RETRY_VIA_MESH_FALLBACK);
  assert.equal(harness.machine.snapshot().canPoke, true);

  harness.machine.poke();
  assert.equal(harness.machine.snapshot().state, CONNECTION_RETRY_STATE.TRYING_MESH);
  assert.deepEqual(harness.calls, ['mesh', 'mesh']);
});

test('connection retry has named initial and final states', () => {
  const harness = createHarness({ connected: true });

  assert.equal(harness.machine.snapshot().state, CONNECTION_RETRY_STATE.INITIAL);
  harness.machine.start();
  assert.equal(harness.machine.snapshot().state, CONNECTION_RETRY_STATE.CONNECTED);
  assert.equal(harness.machine.snapshot().canPoke, false);
});

test('connection retry can enter a named failed final state', () => {
  const harness = createHarness();

  harness.machine.start();
  harness.machine.markFailed();
  assert.equal(harness.machine.snapshot().state, CONNECTION_RETRY_STATE.FAILED);
  assert.equal(harness.machine.snapshot().canPoke, false);
});
