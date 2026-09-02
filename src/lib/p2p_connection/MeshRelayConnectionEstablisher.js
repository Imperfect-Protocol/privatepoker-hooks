import { announcePrivateMesh } from 'privatepoker-hooks/lib/privateMesh';

const normalizeAddress = (value) => value?.toLowerCase() ?? '';

export class MeshRelayConnectionEstablisher {
  constructor({
    session,
    enabled = true,
  }) {
    this.session = session;
    this.enabled = enabled;
  }

  announce(lookingFor) {
    const { playerAddress, lobbyId, tableId } = this.session.config;
    const unresolved = lookingFor.filter((peerAddress) => (
      this.session.lookingForPeers.has(normalizeAddress(peerAddress))
      && !this.session.isInboundConnected(peerAddress)
    ));
    if (!this.enabled || !playerAddress || !lobbyId || !tableId || unresolved.length === 0) {
      return false;
    }

    this.session.logActivity(`mesh discovery fallback for ${unresolved.map(this.session.formatPeer).join(', ')}`);
    unresolved.forEach((peerAddress) => {
      this.session.emitActivity(`${this.session.formatSeat(peerAddress)} << Searching...`);
    });
    void announcePrivateMesh({
      originAddress: playerAddress,
      lobbyId,
      tableId,
      lookingFor: unresolved,
      callback: async (inboundMessage, enqueueFn) => {
        await this.session.handleSignal(inboundMessage, enqueueFn);
      },
    });
    return true;
  }
}

