const DEFAULT_BACKGROUND_FALLBACK_MS = 1200;
const normalizeAddress = (value) => value?.toLowerCase() ?? '';

export class P2PConnectionCoordinator {
  constructor({
    backgroundP2P,
    meshRelay,
    fallbackTimers,
    fallbackMs = DEFAULT_BACKGROUND_FALLBACK_MS,
  }) {
    this.backgroundP2P = backgroundP2P;
    this.meshRelay = meshRelay;
    this.fallbackTimers = fallbackTimers;
    this.fallbackMs = fallbackMs;
  }

  announce(lookingFor) {
    const announcedViaP2P = this.backgroundP2P.announce(lookingFor);
    const meshNow = lookingFor.filter((peerAddress) => (
      !announcedViaP2P.has(normalizeAddress(peerAddress))
    ));

    if (meshNow.length > 0) {
      this.meshRelay.announce(meshNow);
    }

    this.scheduleMeshFallback(lookingFor.filter((peerAddress) => (
      announcedViaP2P.has(normalizeAddress(peerAddress))
    )));
    return announcedViaP2P;
  }

  scheduleMeshFallback(lookingFor) {
    lookingFor.forEach((peerAddress) => {
      const peerKey = normalizeAddress(peerAddress);
      if (!peerKey) return;

      const existingTimer = this.fallbackTimers.get(peerKey);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        this.fallbackTimers.delete(peerKey);
        if (!this.backgroundP2P.session.lookingForPeers.has(peerKey)) return;
        if (this.backgroundP2P.session.isInboundConnected(peerAddress)) return;
        if (this.backgroundP2P.hasKnownRoute(peerAddress)) return;
        this.meshRelay.announce([peerAddress]);
      }, this.fallbackMs);
      this.fallbackTimers.set(peerKey, timer);
    });
  }

  cancel(peerAddress) {
    const peerKey = normalizeAddress(peerAddress);
    const timer = this.fallbackTimers.get(peerKey);
    if (timer) clearTimeout(timer);
    this.fallbackTimers.delete(peerKey);
  }
}

