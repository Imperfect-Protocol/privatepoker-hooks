import {
  CONNECTION_RETRY_STATE,
  P2PConnectionRetryStateMachine,
  POKE_CONNECTION_TIMEOUT_MS,
} from './P2PConnectionRetryStateMachine.js';

const normalizeAddress = (value) => value?.toLowerCase() ?? '';

export class P2PConnectionCoordinator {
  constructor({
    backgroundP2P,
    meshRelay,
    retryMachines,
    timeoutMs = POKE_CONNECTION_TIMEOUT_MS,
    onChange,
  }) {
    this.backgroundP2P = backgroundP2P;
    this.meshRelay = meshRelay;
    this.retryMachines = retryMachines;
    this.timeoutMs = Math.max(POKE_CONNECTION_TIMEOUT_MS, Number(timeoutMs || 0));
    this.onChange = onChange;
  }

  announce(lookingFor) {
    return this.runForPeers(lookingFor, (machine) => machine.start());
  }

  poke(lookingFor) {
    return this.runForPeers(lookingFor, (machine) => machine.poke());
  }

  cancel(peerAddress) {
    const peerKey = normalizeAddress(peerAddress);
    const machine = this.retryMachines.get(peerKey);
    machine?.markConnected();
  }

  clear() {
    this.retryMachines.forEach((machine) => machine.stop());
    this.retryMachines.clear();
  }

  snapshotFor(peerAddress) {
    const peerKey = normalizeAddress(peerAddress);
    return this.retryMachines.get(peerKey)?.snapshot() ?? {
      peerAddress,
      state: CONNECTION_RETRY_STATE.INITIAL,
      canPoke: false,
      isTrying: false,
      timeoutMs: this.timeoutMs,
    };
  }

  snapshots() {
    const states = {};
    this.retryMachines.forEach((machine, peerKey) => {
      states[peerKey] = machine.snapshot();
    });
    return states;
  }

  runForPeers(lookingFor, run) {
    const attempted = new Set();
    lookingFor.forEach((peerAddress) => {
      const machine = this.machineFor(peerAddress);
      if (!machine) return;

      run(machine);
      attempted.add(normalizeAddress(peerAddress));
    });
    return attempted;
  }

  machineFor(peerAddress) {
    const peerKey = normalizeAddress(peerAddress);
    if (!peerKey) return null;

    const existing = this.retryMachines.get(peerKey);
    if (existing) return existing;

    const machine = new P2PConnectionRetryStateMachine({
      peerAddress,
      timeoutMs: this.timeoutMs,
      hasP2PAvailable: (target) => this.backgroundP2P.isAvailable(target),
      isConnected: (target) => this.backgroundP2P.session.isInboundConnected(target),
      tryP2P: (target) => this.backgroundP2P.announce([target]),
      tryMesh: (target) => this.meshRelay.announce([target]),
      onChange: () => this.onChange?.(),
    });
    this.retryMachines.set(peerKey, machine);
    return machine;
  }
}
