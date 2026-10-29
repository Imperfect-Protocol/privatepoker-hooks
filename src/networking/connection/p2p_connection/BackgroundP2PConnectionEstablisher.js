const normalizeAddress = (value) => value?.toLowerCase() ?? '';

export class BackgroundP2PConnectionEstablisher {
  constructor({
    session,
    sessionPool,
    enabled = true,
  }) {
    this.session = session;
    this.sessionPool = sessionPool;
    this.enabled = enabled;
  }

  announce(lookingFor) {
    const { playerAddress, lobbyId, tableId } = this.session.config;
    const announced = new Set();
    if (!this.canAnnounce()) return announced;

    lookingFor.forEach((targetAddress) => {
      const targetKey = normalizeAddress(targetAddress);
      announced.add(targetKey);
      const sent = this.sessionPool.sendP2PMstAnnounce?.({
        originAddress: playerAddress,
        targetAddress,
        lobbyId,
        tableId,
      });
      if (sent) {
        this.session.logActivity(`p2p mst announce ${this.session.formatPeer(targetAddress)}`);
      } else {
        this.session.logActivity(`p2p mst announce queued ${this.session.formatPeer(targetAddress)}`);
      }
      this.session.emitActivity(`${this.session.formatSeat(targetAddress)} <~ Searching P2P...`);
    });

    return announced;
  }

  canAnnounce() {
    const { playerAddress, lobbyId, tableId } = this.session.config;
    return Boolean(this.enabled && playerAddress && lobbyId && tableId);
  }

  isAvailable(peerAddress) {
    return this.canAnnounce() && (
      this.hasKnownRoute(peerAddress)
      || this.sessionPool.hasOpenP2PGossipLink?.() === true
    );
  }

  hasKnownRoute(peerAddress) {
    const { playerAddress, lobbyId, tableId } = this.session.config;
    return this.sessionPool.hasP2PMstRouteBetween?.({
      leftAddress: playerAddress,
      rightAddress: peerAddress,
      lobbyId,
      tableId,
    }) === true;
  }
}
