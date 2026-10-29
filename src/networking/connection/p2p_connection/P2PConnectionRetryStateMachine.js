export const POKE_CONNECTION_TIMEOUT_MS = 10_000;

export const CONNECTION_RETRY_STATE = Object.freeze({
  INITIAL: 'Initial',
  TRYING_P2P_NETWORK: 'TryingP2PNetwork',
  RETRY_VIA_P2P_NETWORK: 'RetryViaP2PNetwork',
  TRYING_MESH: 'TryingMesh',
  RETRY_VIA_MESH_FALLBACK: 'RetryViaMeshFallback',
  CONNECTED: 'Connected',
  FAILED: 'Failed',
});

const RETRY_STATES = new Set([
  CONNECTION_RETRY_STATE.RETRY_VIA_P2P_NETWORK,
  CONNECTION_RETRY_STATE.RETRY_VIA_MESH_FALLBACK,
]);

const TRYING_STATES = new Set([
  CONNECTION_RETRY_STATE.TRYING_P2P_NETWORK,
  CONNECTION_RETRY_STATE.TRYING_MESH,
]);

export class P2PConnectionRetryStateMachine {
  constructor({
    peerAddress,
    timeoutMs = POKE_CONNECTION_TIMEOUT_MS,
    hasP2PAvailable,
    isConnected,
    tryMesh,
    tryP2P,
    onChange,
    setTimer = window.setTimeout,
    clearTimer = window.clearTimeout,
  }) {
    this.peerAddress = peerAddress;
    this.timeoutMs = Math.max(POKE_CONNECTION_TIMEOUT_MS, Number(timeoutMs || 0));
    this.hasP2PAvailable = hasP2PAvailable;
    this.isConnected = isConnected;
    this.tryMesh = tryMesh;
    this.tryP2P = tryP2P;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = CONNECTION_RETRY_STATE.INITIAL;
    this.timer = null;
  }

  start() {
    if (this.isConnected?.(this.peerAddress)) {
      this.markConnected();
      return this.snapshot();
    }
    if (TRYING_STATES.has(this.state) || RETRY_STATES.has(this.state)) {
      return this.snapshot();
    }
    return this.tryInitialPath();
  }

  poke() {
    if (this.isConnected?.(this.peerAddress)) {
      this.markConnected();
      return this.snapshot();
    }
    if (this.state === CONNECTION_RETRY_STATE.RETRY_VIA_P2P_NETWORK && this.hasP2PAvailable?.(this.peerAddress)) {
      return this.enterTryingP2P(CONNECTION_RETRY_STATE.RETRY_VIA_MESH_FALLBACK);
    }
    return this.enterTryingMesh();
  }

  markConnected() {
    this.clearActiveTimer();
    this.transition(CONNECTION_RETRY_STATE.CONNECTED);
  }

  markFailed() {
    this.clearActiveTimer();
    this.transition(CONNECTION_RETRY_STATE.FAILED);
  }

  stop() {
    this.clearActiveTimer();
  }

  snapshot() {
    return {
      peerAddress: this.peerAddress,
      state: this.state,
      canPoke: RETRY_STATES.has(this.state),
      isTrying: TRYING_STATES.has(this.state),
      timeoutMs: this.timeoutMs,
    };
  }

  tryInitialPath() {
    if (this.hasP2PAvailable?.(this.peerAddress)) {
      return this.enterTryingP2P(CONNECTION_RETRY_STATE.RETRY_VIA_P2P_NETWORK);
    }
    return this.enterTryingMesh();
  }

  enterTryingP2P(timeoutState) {
    this.transition(CONNECTION_RETRY_STATE.TRYING_P2P_NETWORK);
    this.tryP2P?.(this.peerAddress);
    this.armTimeout(timeoutState);
    return this.snapshot();
  }

  enterTryingMesh() {
    this.transition(CONNECTION_RETRY_STATE.TRYING_MESH);
    this.tryMesh?.(this.peerAddress);
    this.armTimeout(CONNECTION_RETRY_STATE.RETRY_VIA_MESH_FALLBACK);
    return this.snapshot();
  }

  armTimeout(nextState) {
    this.clearActiveTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.isConnected?.(this.peerAddress)) {
        this.markConnected();
        return;
      }
      this.transition(nextState);
    }, this.timeoutMs);
  }

  clearActiveTimer() {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  transition(state) {
    if (this.state === state) return;
    this.state = state;
    this.onChange?.(this.snapshot());
  }
}
