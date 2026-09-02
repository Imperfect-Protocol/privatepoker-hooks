import { hexToBytes, toHex } from 'viem';
import { decryptFromPeer, encryptForPeer, normalizePeerPublicKey } from 'privatepoker-hooks/networking/signaling/SignalEncryption';
import {
  make_public_key_from_compressed_slice,
  make_signature_from_compressed_slice,
  sign as blsSign,
  verify as blsVerify,
} from 'privatepoker-hooks/crypto/bls';
import {
  RTC_POOL_GOSSIP_ANNOUNCE,
  RTC_POOL_GOSSIP_TRIGGER_OFFER,
  RTC_POOL_P2P_MST_FRAGMENT,
  RTC_POOL_SIGNAL,
  rtcSessionPool,
} from 'privatepoker-hooks/networking/pool/RtcSessionPool';
import {
  BackgroundP2PConnectionEstablisher,
  MeshRelayConnectionEstablisher,
  P2PConnectionCoordinator,
} from 'privatepoker-hooks/networking/connection/p2p_connection';
import { makeMeshRtcConfig } from 'privatepoker-hooks/config/mesh';

function randomRtcConfig() {
  return makeMeshRtcConfig({ randomizeIceServer: true });
}

function formatIceServer(iceServer) {
  const urls = iceServer?.urls;
  return Array.isArray(urls) ? urls.join(', ') : urls;
}

const MAX_PROCESSED_SIGNALS = 300;

const RTC_LINK = {
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
};

const oppositeLink = (direction) => (
  direction === RTC_LINK.OUTBOUND ? RTC_LINK.INBOUND : RTC_LINK.OUTBOUND
);

const SUBSCRIPTION_STATE = {
  CREATED: 'Created',
  OFFER_SENT: 'OfferSent',
  OFFER_TIMEOUT: 'OfferTimeout',
  ACCEPT_RECEIVED: 'AcceptReceived',
  ACCEPT_SENT: 'AcceptSent',
  CONNECTED: 'Connected',
  DISCONNECTED: 'Disconnected',
};

const RTC_CONTROL_MESSAGE = 'RTC_CONTROL';
const TRANSPORT_SIGNATURE_SCHEME = 'BLS12-381-G2-PK-G1-SIG';
const MAX_PUBLISHED_MESSAGE_CACHE = 200;
const GOSSIP_DISCOVERY_FALLBACK_MS = 1200;

const normalizeAddress = (value) => value?.toLowerCase() ?? '';
const linkKey = (peerAddress, direction) => `${direction}:${normalizeAddress(peerAddress)}`;
const formatPeer = (value) => (value ? `${value.slice(0, 6)}...${value.slice(-4)}` : 'unknown');
const formatKey = (value) => {
  if (!value) return 'missing';
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
};
const formatSeat = (value) => (value ? value.slice(2, 4).toUpperCase() : '??');
const normalizePublicKey = (value) => (value ? normalizePeerPublicKey(value) : undefined);
const ensureHexPrefix = (value) => {
  const normalized = String(value ?? '');
  return normalized.startsWith('0x') ? normalized : `0x${normalized}`;
};
const isDeadPeerConnection = (pc) => {
  return !pc || ['closed', 'failed', 'disconnected'].includes(pc.connectionState);
};
const linkStatusSymbol = (direction) => (direction === RTC_LINK.OUTBOUND ? '!<' : '!>');
const connectionFailureLabel = (reason) => {
  if (/\bfailed\b/i.test(reason ?? '')) return 'Connection Failed';
  if (/\bdisconnected\b/i.test(reason ?? '')) return 'Connection Disconnected';
  if (/\bclosed\b/i.test(reason ?? '')) return 'Connection Closed';
  return null;
};

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function stripTransportFields(message) {
  if (!message || typeof message !== 'object') return message;
  const unsignedMessage = { ...message };
  delete unsignedMessage.rtcSignature;
  delete unsignedMessage.rtcDisagreement;
  return unsignedMessage;
}

function transportSignaturePayload(message, signerAddress) {
  return new TextEncoder().encode(canonicalJson({
    signerAddress: normalizeAddress(signerAddress),
    message: stripTransportFields(message),
  }));
}

function transportMessageKey(message) {
  const unsignedMessage = stripTransportFields(message);
  const wire = unsignedMessage?.wire;
  if (wire) {
    return [
      'wire',
      unsignedMessage.type ?? '',
      wire.table_id ?? '',
      wire.hand_id ?? '',
      wire.from ?? '',
      wire.sequence ?? '',
    ].join(':');
  }
  return canonicalJson(unsignedMessage);
}

function disagreementMessageKey(message) {
  return [
    transportMessageKey(message),
    normalizeAddress(message?.rtcDisagreement?.signer ?? message?.rtcSignature?.signer),
    normalizeAddress(message?.rtcDisagreement?.rejectedBy),
    message?.rtcDisagreement?.reason ?? '',
  ].join(':');
}

function badSignaturePayload(payload) {
  const badPayload = new Uint8Array(payload.length + 1);
  badPayload.set(payload);
  badPayload[payload.length] = 1;
  return badPayload;
}

function waitForIceGatheringComplete(pc, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', checkState);
      resolve(); // Proceed with whatever candidates we managed to gather if it times out
    }, timeoutMs);

    function checkState() {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
    }

    pc.addEventListener('icegatheringstatechange', checkState);
  });
}

export class PokerRtcSession {
  constructor({
    sendSignal,
    sendPooledSignal = null,
    onActivity,
    onStateChange,
    sessionPool = rtcSessionPool,
  }) {
    this.sendSignal = sendSignal;
    this.sendPooledSignal = sendPooledSignal;
    this.enqueueControlAction = async (type, task) => task();
    this.blsActionKey = null;
    this.onActivity = onActivity;
    this.onStateChange = onStateChange;
    this.sessionPool = sessionPool;

    this.connectedLinks = new Set();
    this.connectedPeers = new Set();
    this.inboundSubscriptions = new Map();
    this.outboundSubscriptions = new Map();
    this.processedSignals = new Set();
    this.joinLog = new Set();
    this.resetLinks = new Set();
    this.offerTimeouts = new Map();
    this.offerRetryTimers = new Map();
    this.bootstrapByeSent = new Set();
    this.publishedMessages = new Map();
    this.seenDisagreements = new Set();
    this.publishQueue = Promise.resolve();
    this.badSignatureOnce = false;
    this.dropNextMessage = false;
    this.duplicateNextMessage = false;
    this.localMediaStream = null;
    this.remoteMediaStreams = new Map();
    this.mediaSnapshotVersion = 0;
    this.ready = false;
    this.hasConnectionError = false;
    this.pendingRelayEnvelopes = [];
    this.drainingRelayEnvelopes = false;
    this.configKey = '';
    this.snapshotKey = '';
    this.lookingForPeers = new Set();
    this.announceTimer = null;
    this.gossipFallbackTimers = new Map();
    this.backgroundP2PEstablisher = new BackgroundP2PConnectionEstablisher({
      session: this,
      sessionPool: this.sessionPool,
    });
    this.meshRelayEstablisher = new MeshRelayConnectionEstablisher({
      session: this,
    });
    this.connectionCoordinator = new P2PConnectionCoordinator({
      backgroundP2P: this.backgroundP2PEstablisher,
      meshRelay: this.meshRelayEstablisher,
      fallbackTimers: this.gossipFallbackTimers,
      fallbackMs: GOSSIP_DISCOVERY_FALLBACK_MS,
    });
    this.config = {
      playerAddress: undefined,
      operator: undefined,
      tableId: undefined,
      lobbyId: undefined,
      publicKey: undefined,
      privateKey: undefined,
      operatorPrivateKey: undefined,
      players: [],
      isTableFull: false,
      tableCapacity: 0,
    };
  }

  setCallbacks({
    sendSignal,
    sendPooledSignal,
    enqueueControlAction,
    blsActionKey,
    onActivity,
    onStateChange,
  }) {
    this.sendSignal = sendSignal;
    if (sendPooledSignal !== undefined) {
      this.sendPooledSignal = sendPooledSignal;
    }
    if (enqueueControlAction !== undefined) {
      this.enqueueControlAction = enqueueControlAction;
    }
    if (blsActionKey !== undefined) {
      this.blsActionKey = blsActionKey;
    }
    this.onActivity = onActivity;
    this.onStateChange = onStateChange;
  }

  update(config) {
    const nextConfigKey = this.makeConfigKey(config);
    if (nextConfigKey === this.configKey) return;
    this.configKey = nextConfigKey;

    const previousTableId = this.config.tableId;
    const previousLobbyId = this.config.lobbyId;
    this.config = {
      ...this.config,
      ...config,
      players: config.players ?? [],
    };

    if (
      previousTableId !== undefined
      && (previousTableId !== this.config.tableId || previousLobbyId !== this.config.lobbyId)
    ) {
      this.resetForTable();
    }

    this.logEntry();
    this.logJoins();
    this.sessionPool.registerSession(this);
    this.updateConnectedPeers();
    this.schedulePeerDiscovery();
    void this.drainPendingRelayEnvelopes();
  }

  makeConfigKey(config) {
    const players = config.players ?? [];
    const playersKey = players
      .map((player) => [
        normalizeAddress(player?.playerAddress),
        player?.annoncePublicKey ?? player?.announcePublicKey ?? '',
        player?.chips ?? '',
      ].join('/'))
      .join('|');

    return [
      normalizeAddress(config.playerAddress),
      config.tableId ?? '',
      config.lobbyId ?? '',
      config.currentHand ?? '',
      config.publicKey ?? '',
      config.privateKey ? 'private-key-ready' : '',
      config.playerAddress ?? '',
      config.isTableFull ? 'full' : 'waiting',
      config.tableCapacity ?? 0,
      playersKey,
    ].join('::');
  }

  schedulePeerDiscovery() {
    const { playerAddress, lobbyId, tableId } = this.config;
    if (!playerAddress || !lobbyId || !tableId) return;

    if (this.lookingForPeers.size === 0) return;

    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => {
      const lookingFor = Array.from(this.lookingForPeers)
        .filter((peerAddress) => !this.connectedLinks.has(linkKey(peerAddress, RTC_LINK.INBOUND)));
      if (lookingFor.length === 0) return;

      this.connectionCoordinator.announce(lookingFor);
    }, 150);
  }

  announceGossipRoutes(lookingFor) {
    return this.backgroundP2PEstablisher.announce(lookingFor);
  }

  announceMeshRoutes(lookingFor) {
    this.meshRelayEstablisher.announce(lookingFor);
  }

  scheduleMeshFallbackForGossip(lookingFor) {
    lookingFor.forEach((peerAddress) => {
      const peerKey = normalizeAddress(peerAddress);
      if (!peerKey) return;

      const existingTimer = this.gossipFallbackTimers.get(peerKey);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        this.gossipFallbackTimers.delete(peerKey);
        if (!this.lookingForPeers.has(peerKey)) return;
        if (this.connectedLinks.has(linkKey(peerAddress, RTC_LINK.INBOUND))) return;
        if (this.backgroundP2PEstablisher.hasKnownRoute(peerAddress)) return;
        this.announceMeshRoutes([peerAddress]);
      }, GOSSIP_DISCOVERY_FALLBACK_MS);
      this.gossipFallbackTimers.set(peerKey, timer);
    });
  }

  markGossipRouteFound(peerAddress) {
    const peerKey = normalizeAddress(peerAddress);
    if (!peerKey) return;

    const timer = this.gossipFallbackTimers.get(peerKey);
    if (timer) clearTimeout(timer);
    this.gossipFallbackTimers.delete(peerKey);
    this.lookingForPeers.delete(peerKey);
  }

  hasPendingP2PIntent(peerAddress) {
    const peerKey = normalizeAddress(peerAddress);
    return Boolean(
      peerKey
      && this.lookingForPeers.has(peerKey)
      && !this.connectedLinks.has(linkKey(peerAddress, RTC_LINK.INBOUND))
    );
  }

  isInboundConnected(peerAddress) {
    return this.connectedLinks.has(linkKey(peerAddress, RTC_LINK.INBOUND));
  }

  formatPeer(peerAddress) {
    return formatPeer(peerAddress);
  }

  formatSeat(peerAddress) {
    return formatSeat(peerAddress);
  }

  getSnapshot() {
    const firstInbound = Array.from(this.inboundSubscriptions.values())[0] ?? null;
    const firstOutbound = Array.from(this.outboundSubscriptions.values())[0] ?? null;
    const firstInboundConnected = firstInbound
      ? this.connectedLinks.has(linkKey(firstInbound.playerAddress, RTC_LINK.INBOUND))
      : false;
    const firstOutboundConnected = firstOutbound
      ? this.connectedLinks.has(linkKey(firstOutbound.playerAddress, RTC_LINK.OUTBOUND))
      : false;
    const peerStates = {};

    this.config.players.forEach((player) => {
      if (!player?.playerAddress) return;
      const peerAddress = player.playerAddress;
      const peerKey = normalizeAddress(peerAddress);
      const isMe = peerKey === normalizeAddress(this.config.playerAddress);
      if (isMe) {
        peerStates[peerKey] = this.getStatus() === 'connected'
          ? 'connected'
          : this.getStatus() === 'connecting'
            ? 'connecting'
            : 'sitting-out';
        return;
      }

      const inbound = this.getSubscription(peerAddress, RTC_LINK.INBOUND);
      const outbound = this.getSubscription(peerAddress, RTC_LINK.OUTBOUND);
      const inboundConnected = this.connectedLinks.has(linkKey(peerAddress, RTC_LINK.INBOUND));
      const outboundConnected = this.connectedLinks.has(linkKey(peerAddress, RTC_LINK.OUTBOUND));
      const hasDisconnectedLink = [inbound?.state, outbound?.state].some((state) => (
        state === SUBSCRIPTION_STATE.DISCONNECTED || state === SUBSCRIPTION_STATE.OFFER_TIMEOUT
      ));
      const hasConnectedLink = (inbound || outbound)
        && (!inbound || inboundConnected)
        && (!outbound || outboundConnected)
        && (inboundConnected || outboundConnected);
      const hasActiveLink = inbound || outbound;

      peerStates[peerKey] = hasDisconnectedLink
        ? 'disconnected'
        : hasConnectedLink
          ? 'connected'
          : hasActiveLink
            ? 'connecting'
            : 'sitting-out';
    });

    const remoteMediaStreams = {};
    this.remoteMediaStreams.forEach((stream, key) => {
      const [, peerAddress] = key.split(':');
      if (!peerAddress) return;

      const mergedStream = remoteMediaStreams[peerAddress] ?? new MediaStream();
      stream.getTracks().forEach((track) => {
        if (mergedStream.getTracks().some((existingTrack) => existingTrack.id === track.id)) return;
        mergedStream.addTrack(track);
      });
      remoteMediaStreams[peerAddress] = mergedStream;
    });

    return {
      connectedPeerAddresses: Array.from(this.connectedPeers),
      connectedPeerCount: this.connectedPeers.size,
      expectedPeerCount: this.inboundSubscriptions.size,
      inboundState: firstInboundConnected ? SUBSCRIPTION_STATE.CONNECTED : firstInbound?.state ?? 'None',
      outboundState: firstOutboundConnected ? SUBSCRIPTION_STATE.CONNECTED : firstOutbound?.state ?? 'None',
      inboundPeerAddress: firstInbound?.playerAddress ?? null,
      outboundPeerAddress: firstOutbound?.playerAddress ?? null,
      peerStates,
      remoteMediaStreams,
      mediaSnapshotVersion: this.mediaSnapshotVersion,
      status: this.getStatus(),
    };
  }

  getStatus() {
    const { playerAddress, operatorPrivateKey, privateKey, publicKey, isTableFull } = this.config;
    if (this.hasConnectionError) return 'error';
    if (!playerAddress || !operatorPrivateKey || !privateKey || !publicKey) return 'waiting';
    if (!isTableFull) return 'waiting';
    if (this.inboundSubscriptions.size === 0) return 'waiting';

    const inboundConnected = Array.from(this.inboundSubscriptions.values()).every(
      (subscription) => this.connectedLinks.has(linkKey(subscription.playerAddress, RTC_LINK.INBOUND)),
    );
    const outboundConnected = this.outboundSubscriptions.size > 0
      && Array.from(this.outboundSubscriptions.values()).every(
        (subscription) => this.connectedLinks.has(linkKey(subscription.playerAddress, RTC_LINK.OUTBOUND)),
      );

    if (inboundConnected && outboundConnected) return 'connected';
    return 'connecting';
  }

  emitState() {
    const snapshot = this.getSnapshot();
    const snapshotKey = [
      snapshot.status,
      snapshot.connectedPeerCount,
      snapshot.expectedPeerCount,
      snapshot.inboundState,
      snapshot.outboundState,
      snapshot.connectedPeerAddresses.join('|'),
      JSON.stringify(snapshot.peerStates),
      snapshot.mediaSnapshotVersion,
    ].join('::');

    if (snapshotKey === this.snapshotKey) return;
    this.snapshotKey = snapshotKey;
    this.onStateChange?.(snapshot);
  }

  logActivity(text, details = undefined) {
    if (details === undefined) {
      console.log(`[RTC debug] ${text}`);
    } else {
      console.log(`[RTC debug] ${text}`, details);
    }
  }

  emitActivity(text, details = undefined) {
    if (details === undefined) {
      console.log(text);
    } else {
      console.log(text, details);
    }
    this.onActivity?.({ text, details, at: new Date(), display: true });
  }

  getSubscription(peerPlayerAddress, direction) {
    const subscriptions = direction === RTC_LINK.OUTBOUND
      ? this.outboundSubscriptions
      : this.inboundSubscriptions;
    return subscriptions.get(normalizeAddress(peerPlayerAddress));
  }

  createSubscription(peerPlayerAddress, peerAnnouncePubKey, direction, callback) {
    const peerKey = normalizeAddress(peerPlayerAddress);
    const subscription = {
      playerAddress: peerPlayerAddress,
      publicAnnounceKey: peerAnnouncePubKey,
      direction,
      webRtcChannel: null,
      state: SUBSCRIPTION_STATE.CREATED,
      callback,
      peerConnection: null,
      mediaSenders: new Map(),
    };
    if (direction === RTC_LINK.OUTBOUND) {
      this.outboundSubscriptions.set(peerKey, subscription);
    } else {
      this.inboundSubscriptions.set(peerKey, subscription);
    }
    return subscription;
  }

  bumpMediaSnapshot() {
    this.mediaSnapshotVersion += 1;
    this.snapshotKey = '';
    this.emitState();
  }

  setLocalMediaStream(stream) {
    if (this.localMediaStream === stream) return;
    this.localMediaStream = stream;
    this.syncAllLocalMediaTracks({ renegotiate: true });
  }

  getLocalMediaTracks() {
    return this.localMediaStream?.getTracks?.().filter((track) => (
      track.readyState !== 'ended'
    )) ?? [];
  }

  syncAllLocalMediaTracks({ renegotiate = false } = {}) {
    this.inboundSubscriptions.forEach((subscription) => {
      this.clearSubscriptionMedia(subscription);
    });
    this.outboundSubscriptions.forEach((subscription) => {
      const changed = this.syncSubscriptionMedia(subscription);
      if (changed && renegotiate) {
        void this.renegotiate(subscription.playerAddress, subscription.direction);
      }
    });
  }

  clearSubscriptionMedia(subscription) {
    const pc = subscription?.peerConnection;
    if (!pc || !subscription?.mediaSenders) return;

    subscription.mediaSenders.forEach((sender) => {
      if (pc.getSenders().includes(sender)) {
        pc.removeTrack(sender);
      }
    });
    subscription.mediaSenders.clear();
  }

  syncSubscriptionMedia(subscription) {
    const pc = subscription?.peerConnection;
    if (!pc || pc.signalingState === 'closed') return false;

    if (!subscription.mediaSenders) {
      subscription.mediaSenders = new Map();
    }

    let changed = false;
    const tracks = this.getLocalMediaTracks();
    const trackIds = new Set(tracks.map((track) => track.id));

    subscription.mediaSenders.forEach((sender, trackId) => {
      if (trackIds.has(trackId)) return;
      if (pc.getSenders().includes(sender)) {
        pc.removeTrack(sender);
        this.logActivity(`local media track removed ${subscription.direction} ${formatPeer(subscription.playerAddress)} ${sender.track?.kind ?? 'unknown'}`);
      }
      subscription.mediaSenders.delete(trackId);
      changed = true;
    });

    tracks.forEach((track) => {
      if (subscription.mediaSenders.has(track.id)) return;
      const sender = pc.addTrack(track, this.localMediaStream);
      subscription.mediaSenders.set(track.id, sender);
      this.logActivity(`local media track added ${subscription.direction} ${formatPeer(subscription.playerAddress)} ${track.kind}`);
      changed = true;
    });

    return changed;
  }

  sendControlMessage(peerAddress, direction, payload) {
    const subscription = this.getSubscription(peerAddress, direction);
    const channel = subscription?.webRtcChannel;
    if (channel?.readyState !== 'open') {
      this.logActivity(`control message skipped ${formatPeer(peerAddress)} ${direction}: channel ${channel?.readyState ?? 'missing'}`);
      return false;
    }

    channel.send(JSON.stringify({
      type: RTC_CONTROL_MESSAGE,
      payload,
    }));
    this.logActivity(`control message sent ${formatPeer(peerAddress)} ${direction}`);
    return true;
  }

  emitMediaDataChannelRequired(peerAddress) {
    this.emitActivity(`Media needs open data channel ${formatPeer(peerAddress)}`, {
      kind: 'media-data-channel-required',
      peerAddress,
    });
  }

  async renegotiate(peerAddress, direction) {
    const subscription = this.getSubscription(peerAddress, direction);
    const pc = subscription?.peerConnection;
    if (!pc || pc.signalingState !== 'stable' || isDeadPeerConnection(pc)) return;

    try {
      if (subscription.webRtcChannel?.readyState !== 'open') {
        this.emitMediaDataChannelRequired(peerAddress);
        return;
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      const signal = {
        type: 'offer',
        direction,
        sdp: pc.localDescription.sdp,
      };

      if (!this.sendControlMessage(peerAddress, direction, { signal })) {
        this.emitMediaDataChannelRequired(peerAddress);
        return;
      }
      this.logActivity(`media offer sent over data channel ${formatPeer(peerAddress)}`);
    } catch (error) {
      this.logActivity(`renegotiation failed ${formatPeer(peerAddress)}: ${error.message}`);
      console.error('Failed to renegotiate RTC media:', error);
    }
  }

  setSubscriptionState(peerPlayerAddress, direction, state, webRtcChannel = undefined) {
    const peerKey = normalizeAddress(peerPlayerAddress);
    const subscription = direction === RTC_LINK.OUTBOUND
      ? this.outboundSubscriptions.get(peerKey)
      : this.inboundSubscriptions.get(peerKey);
    if (!subscription) return;

    if (
      direction === RTC_LINK.INBOUND
      && [
        SUBSCRIPTION_STATE.ACCEPT_RECEIVED,
        SUBSCRIPTION_STATE.CONNECTED,
        SUBSCRIPTION_STATE.DISCONNECTED,
      ].includes(state)
    ) {
      this.clearOfferTimeout(peerPlayerAddress);
      this.clearOfferRetry(peerPlayerAddress);
    }

    subscription.state = state;
    if (webRtcChannel !== undefined) {
      subscription.webRtcChannel = webRtcChannel;
    }
    subscription.callback?.(this.getPlayerSeatNo(subscription.playerAddress), {
      kind: 'network',
      state,
      playerAddress: subscription.playerAddress,
    });
    this.emitState();
  }

  clearOfferTimeout(peerPlayerAddress) {
    const peerKey = normalizeAddress(peerPlayerAddress);
    this.offerTimeouts.delete(peerKey);
  }

  clearOfferRetry(peerPlayerAddress) {
    const peerKey = normalizeAddress(peerPlayerAddress);
    this.offerRetryTimers.delete(peerKey);
  }

  startOfferTimeout(peerPlayerAddress) {
    const peerKey = normalizeAddress(peerPlayerAddress);
    if (!peerKey) return;
    this.offerTimeouts.delete(peerKey);
  }

  getPlayerPublicKey(peerPlayerAddress) {
    const peerKey = normalizeAddress(peerPlayerAddress);
    const player = this.config.players.find(
      (p) => normalizeAddress(p.playerAddress) === peerKey,
    );
    return player?.annoncePublicKey ?? player?.announcePublicKey ?? undefined;
  }

  cachePublishedMessage(message) {
    const key = transportMessageKey(message);
    this.publishedMessages.set(key, stripTransportFields(message));
    if (this.publishedMessages.size <= MAX_PUBLISHED_MESSAGE_CACHE) return;

    const [oldestKey] = this.publishedMessages.keys();
    this.publishedMessages.delete(oldestKey);
  }

  armBadSignatureOnce() {
    this.badSignatureOnce = true;
  }

  armDropNextMessage() {
    this.dropNextMessage = true;
  }

  armDuplicateNextMessage() {
    this.duplicateNextMessage = true;
  }

  consumeBadSignatureOnce() {
    if (!this.badSignatureOnce) return false;
    this.badSignatureOnce = false;
    return true;
  }

  async signTransportMessage(message, { injectBadSignature = false } = {}) {
    const { playerAddress, privateKey, publicKey } = this.config;
    if (!playerAddress || !privateKey || !publicKey) {
      throw new Error('Cannot sign RTC message without table BLS keys.');
    }

    const unsignedMessage = stripTransportFields(message);
    const payload = transportSignaturePayload(unsignedMessage, playerAddress);
    const signaturePayload = injectBadSignature ? badSignaturePayload(payload) : payload;
    const signature = blsSign(signaturePayload, hexToBytes(ensureHexPrefix(privateKey)));

    return {
      ...unsignedMessage,
      rtcSignature: {
        scheme: TRANSPORT_SIGNATURE_SCHEME,
        signer: playerAddress,
        publicKey: ensureHexPrefix(publicKey),
        signature: toHex(signature.toRawBytes(true)),
      },
    };
  }

  async verifyTransportMessage(message, fallbackSenderAddress) {
    const signature = message?.rtcSignature;
    const signer = signature?.signer ?? fallbackSenderAddress;
    const signerPublicKey = this.getPlayerPublicKey(signer);

    if (!signature?.signature || !signer || !signerPublicKey) {
      return { ok: false, signer, reason: 'missing signature or announce public key' };
    }

    if (signature.scheme !== TRANSPORT_SIGNATURE_SCHEME) {
      return { ok: false, signer, reason: 'unsupported signature scheme' };
    }

    const payload = transportSignaturePayload(message, signer);
    try {
      const signed = make_signature_from_compressed_slice(hexToBytes(ensureHexPrefix(signature.signature)));
      const publicKey = make_public_key_from_compressed_slice(hexToBytes(ensureHexPrefix(signerPublicKey)));
      const ok = blsVerify(payload, publicKey, signed);
      return { ok, signer, reason: ok ? undefined : 'signature mismatch' };
    } catch (error) {
      return { ok: false, signer, reason: error.message };
    }
  }

  sendTransportMessage(message) {
    if (this.dropNextMessage) {
      this.dropNextMessage = false;
      this.logActivity(`dropped message type=${message?.type ?? 'unknown'}`);
      return 0;
    }

    const payload = JSON.stringify(message);
    let sentCount = 0;
    const sendCount = this.duplicateNextMessage ? 2 : 1;
    this.duplicateNextMessage = false;

    this.outboundSubscriptions.forEach((subscription) => {
      if (subscription.webRtcChannel?.readyState === 'open') {
        for (let sendIndex = 0; sendIndex < sendCount; sendIndex += 1) {
          subscription.webRtcChannel.send(payload);
          sentCount += 1;
        }
      }
    });
    this.logActivity(`broadcast message type=${message?.type ?? 'unknown'} open_channels=${sentCount}`);
    return sentCount;
  }

  async publishSignedMessage(message) {
    const outgoingMessage = await this.signTransportMessage(message, {
      injectBadSignature: this.consumeBadSignatureOnce(),
    });
    this.cachePublishedMessage(outgoingMessage);
    this.sendTransportMessage(outgoingMessage);
  }

  async republishDisagreedMessage(message) {
    const cachedMessage = this.publishedMessages.get(transportMessageKey(message));
    const unsignedMessage = cachedMessage ?? stripTransportFields(message);
    const signedMessage = await this.signTransportMessage(unsignedMessage);
    this.cachePublishedMessage(signedMessage);
    this.sendTransportMessage(signedMessage);
  }

  forwardDisagreement(message) {
    this.sendTransportMessage(message);
  }

  async rejectTransportMessage(message, fallbackSenderAddress, reason) {
    const signer = message?.rtcSignature?.signer ?? fallbackSenderAddress;
    const rejectedMessage = {
      ...message,
      rtcDisagreement: {
        type: 'Disagreement',
        reason: 'SignatureMismatch',
        detail: reason,
        signer,
        rejectedBy: this.config.playerAddress,
      },
    };
    this.emitActivity(
      `[${formatSeat(this.config.playerAddress)}] Invalid Signature from [${formatSeat(signer)}]`,
    );
    this.forwardDisagreement(rejectedMessage);
  }

  async handleIncomingDataMessage(peerAddress, direction, rawData) {
    try {
      const message = JSON.parse(rawData);
      console.log('[RTC debug] received message', {
        peer: formatPeer(peerAddress),
        direction,
        type: message?.type ?? 'unknown',
        message,
      });

      if (
        message?.type === RTC_POOL_SIGNAL
        || message?.type === RTC_POOL_P2P_MST_FRAGMENT
        || message?.type === RTC_POOL_GOSSIP_ANNOUNCE
        || message?.type === RTC_POOL_GOSSIP_TRIGGER_OFFER
      ) {
        await this.sessionPool.handleMessage(this, peerAddress, message);
        return;
      }

      if (message?.type === RTC_CONTROL_MESSAGE) {
        await this.handleRtcControlMessage(peerAddress, direction, message.payload);
        return;
      }

      if (direction !== RTC_LINK.INBOUND) return;

      if (message?.rtcDisagreement) {
        const signer = message.rtcDisagreement.signer ?? message?.rtcSignature?.signer;
        const disagreementKey = disagreementMessageKey(message);
        if (this.seenDisagreements.has(disagreementKey)) return;
        this.seenDisagreements.add(disagreementKey);

        const rejectedBy = message.rtcDisagreement.rejectedBy;
        if (normalizeAddress(rejectedBy) === normalizeAddress(this.config.playerAddress)) {
          return;
        }

        this.emitActivity(
          `[${formatSeat(this.config.playerAddress)}] Seen Invalid Signature from [${formatSeat(signer)}]`,
        );
        if (normalizeAddress(signer) === normalizeAddress(this.config.playerAddress)) {
          await this.republishDisagreedMessage(message);
          return;
        }
        this.forwardDisagreement(message);
        return;
      }

      const verification = await this.verifyTransportMessage(message, peerAddress);
      if (!verification.ok) {
        await this.rejectTransportMessage(message, peerAddress, verification.reason);
        return;
      }

      const subscription = this.getSubscription(peerAddress, RTC_LINK.INBOUND);
      subscription?.callback?.(this.getPlayerSeatNo(subscription.playerAddress), {
        kind: 'message',
        message,
        playerAddress: subscription.playerAddress,
      });
    } catch (error) {
      this.logActivity(`data message parse failed ${formatPeer(peerAddress)}: ${error.message}`);
      console.error('Failed to parse RTC message:', error);
    }
  }

  async handleRtcControlMessage(peerAddress, direction, payload) {
    if (payload?.type === 'peer-disconnect') {
      this.resetPeerLink(peerAddress, direction, 'peer closed table');
      return;
    }

    const signal = payload?.signal;
    if (!signal) return;

    await this.handleIncomingSignal(peerAddress, signal, {
      viaDataChannel: true,
      receivedDirection: direction,
    });
  }

  sendDisconnectNotice(subscription) {
    const channel = subscription?.webRtcChannel;
    if (channel?.readyState !== 'open') return;

    try {
      channel.send(JSON.stringify({
        type: RTC_CONTROL_MESSAGE,
        payload: { type: 'peer-disconnect' },
      }));
    } catch {
      // Best effort before local tab closes.
    }
  }

  getPlayerSeatNo(peerPlayerAddress) {
    const peerKey = normalizeAddress(peerPlayerAddress);
    return this.config.players.find(
      (player) => normalizeAddress(player.playerAddress) === peerKey,
    )?.seatNo ?? null;
  }

  logEntry() {
    const { playerAddress, publicKey, tableId } = this.config;
    if (!publicKey || !playerAddress || !tableId) return;
    const key = `enter:${tableId}:${normalizeAddress(playerAddress)}:${publicKey}`;
    if (this.joinLog.has(key)) return;
    this.joinLog.add(key);
  }

  logJoins() {
    const { playerAddress, tableId } = this.config;
    this.config.players.forEach((player) => {
      const pubKey = player?.annoncePublicKey ?? player?.announcePublicKey;
      if (!player?.playerAddress || !pubKey) return;

      const isMe = normalizeAddress(player.playerAddress) === normalizeAddress(playerAddress);
      const activity = Number(this.config.currentHand ?? 0) > 0 ? 'Re-Joined' : 'Join';
      const key = `join:${activity}:${tableId}:${normalizeAddress(player.playerAddress)}:${pubKey}`;
      if (this.joinLog.has(key)) return;
      this.joinLog.add(key);

      if (isMe) {
        this.emitActivity(activity === 'Re-Joined'
          ? '[Me] :: Re-Joined'
          : `[Me] :: Join ${formatKey(pubKey)}`);
      } else {
        this.emitActivity(activity === 'Re-Joined'
          ? `${formatSeat(player.playerAddress)} :: Re-Joined`
          : `${formatSeat(player.playerAddress)} :: Join ${formatKey(pubKey)}`);
      }
    });
  }

  updateConnectedPeers() {
    const nextConnectedPeers = new Set();

    this.inboundSubscriptions.forEach((_, peerAddress) => {
      if (this.connectedLinks.has(linkKey(peerAddress, RTC_LINK.INBOUND))) {
        nextConnectedPeers.add(peerAddress);
      }
    });

    this.connectedPeers = nextConnectedPeers;
    const isReady = this.getStatus() === 'connected';
    if (isReady && !this.ready) {
      this.emitActivity('[Me]: Ready');
    }
    if (!isReady && this.ready) {
      this.emitActivity('Me :: Paused');
    }
    this.ready = isReady;
    this.emitState();
    return nextConnectedPeers;
  }

  sendLinkConnected(peer) {
    const peerKey = normalizeAddress(peer?.playerAddress ?? peer);
    if (!peerKey) return;

    if (!this.pendingStatuses) this.pendingStatuses = new Map();
    this.pendingStatuses.set(peerKey, {
      type: 'link-connected',
      from: this.config.playerAddress,
      to: peerKey,
      target: peerKey,
      lobbyId: this.config.lobbyId,
      tableId: this.config.tableId,
    });
    this.scheduleMeshStatus();
  }

  sendLinkFailed(peer, reason = 'peer_reported') {
    const peerKey = normalizeAddress(peer?.playerAddress ?? peer);
    if (!peerKey) return;

    if (!this.pendingStatuses) this.pendingStatuses = new Map();
    this.pendingStatuses.set(peerKey, {
      type: 'link-failed',
      from: this.config.playerAddress,
      to: peerKey,
      target: peerKey,
      lobbyId: this.config.lobbyId,
      tableId: this.config.tableId,
      reason,
    });
    this.scheduleMeshStatus();
  }

  markLinkConnected(peerAddress, direction, resolveConnection) {
    const key = linkKey(peerAddress, direction);
    if (this.connectedLinks.has(key)) return;

    this.connectedLinks.add(key);
    this.lookingForPeers.delete(normalizeAddress(peerAddress));
    this.hasConnectionError = false;
    if (direction === RTC_LINK.INBOUND) {
      this.clearOfferTimeout(peerAddress);
    }

    resolveConnection?.({
      type: 'link-connected',
      from: this.config.playerAddress,
      to: peerAddress,
      target: peerAddress,
      lobbyId: String(this.config.lobbyId),
      tableId: String(this.config.tableId),
    });

    this.emitActivity(`${formatSeat(peerAddress)} ${direction === RTC_LINK.OUTBOUND ? '<=' : '=>'} Connected ${formatKey(this.getPlayerPublicKey(peerAddress))}`);
    this.updateConnectedPeers();
  }

  resetPeerLink(peerAddress, direction, reason) {
    const peerKey = normalizeAddress(peerAddress);
    const key = linkKey(peerAddress, direction);
    if (!peerKey || this.resetLinks.has(key)) return;

    this.resetLinks.add(key);
    this.logActivity(`reset ${direction} ${formatPeer(peerAddress)}: ${reason}`);

    const wasLinkConnected = this.connectedLinks.has(key);
    const wasFullyConnected = this.connectedPeers.has(peerKey);
    const failedBeforeConnect = !wasLinkConnected ? connectionFailureLabel(reason) : null;
    const subscription = direction === RTC_LINK.INBOUND
      ? this.getSubscription(peerAddress, RTC_LINK.INBOUND)
      : this.getSubscription(peerAddress, RTC_LINK.OUTBOUND);
    const channel = subscription?.webRtcChannel;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onmessage = null;
      if (channel.readyState !== 'closed') channel.close();
    }

    const peerConnection = subscription?.peerConnection;
    if (peerConnection) {
      peerConnection.onconnectionstatechange = null;
      peerConnection.oniceconnectionstatechange = null;
      peerConnection.onicegatheringstatechange = null;
      peerConnection.onsignalingstatechange = null;
      peerConnection.ondatachannel = null;
      peerConnection.ontrack = null;
      peerConnection.close();
    }

    if (subscription) {
      subscription.webRtcChannel = null;
      subscription.peerConnection = null;
      subscription.mediaSenders = new Map();
    }
    this.remoteMediaStreams.delete(key);
    this.bumpMediaSnapshot();
    this.clearOfferTimeout(peerAddress);
    this.connectedLinks.delete(key);
    const connectedPeers = this.updateConnectedPeers();

    if (wasLinkConnected) {
      this.emitActivity(`${formatSeat(peerAddress)} ${linkStatusSymbol(direction)} Disconnected ${formatKey(this.getPlayerPublicKey(peerAddress))}`);
    } else if (failedBeforeConnect) {
      this.emitActivity(`${formatSeat(peerAddress)} ${linkStatusSymbol(direction)} ${failedBeforeConnect} ${formatKey(this.getPlayerPublicKey(peerAddress))}`);
    }

    this.setSubscriptionState(peerAddress, direction, SUBSCRIPTION_STATE.DISCONNECTED, null);

    if (wasFullyConnected && !connectedPeers.has(peerKey)) {
      this.emitActivity(`${formatSeat(peerAddress)} !! Disconnected ${formatKey(this.getPlayerPublicKey(peerAddress))}`);
    }

    if (direction === RTC_LINK.INBOUND && subscription && this.config.isTableFull) {
      this.lookingForPeers.add(peerKey);
      this.schedulePeerDiscovery();
    }

    queueMicrotask(() => {
      this.resetLinks.delete(key);
    });
  }

  setupDataChannel(peerAddress, direction, dataChannel, resolveConnection) {
    this.logActivity(`${direction} channel attached ${formatPeer(peerAddress)} (${dataChannel.label})`);

    dataChannel.onopen = () => {
      this.logActivity(`${direction} channel open ${formatPeer(peerAddress)} (${dataChannel.label})`);
      this.setSubscriptionState(peerAddress, direction, SUBSCRIPTION_STATE.CONNECTED, dataChannel);
      this.sessionPool.registerLink({
        session: this,
        peerAddress,
        direction,
        channel: dataChannel,
      });
      this.markLinkConnected(peerAddress, direction, resolveConnection);
    };

    dataChannel.onclose = () => {
      this.logActivity(`${direction} channel closed ${formatPeer(peerAddress)} (${dataChannel.label})`);
      this.sessionPool.unregisterLink({
        session: this,
        peerAddress,
        direction,
      });
      this.resetPeerLink(peerAddress, direction, 'data channel closed');
    };

    dataChannel.onmessage = (event) => {
      this.logActivity(`${direction} channel message ${formatPeer(peerAddress)} (${dataChannel.label})`);
      void this.handleIncomingDataMessage(peerAddress, direction, event.data);
    };
  }

  createPeerConnection(peerAddress, direction, createChannel) {
    const subscription = this.getSubscription(peerAddress, direction);
    const existing = subscription?.peerConnection;
    if (existing && !isDeadPeerConnection(existing)) {
      this.logActivity(`reuse peer connection ${formatPeer(peerAddress)} ${direction} ${existing.connectionState}`);
      return existing;
    }
    if (existing) {
      this.resetPeerLink(peerAddress, direction, `stale peer connection ${existing.connectionState}`);
    }

    let resolveConnection;
    const connectionPromise = new Promise((resolve) => {
      resolveConnection = resolve;
    });

    if (!this.connectionPromises) this.connectionPromises = new Map();
    this.connectionPromises.set(normalizeAddress(peerAddress), connectionPromise);

    const rtcConfig = randomRtcConfig();
    this.logActivity(`selected STUN ${formatIceServer(rtcConfig.iceServers[0])}`, {
      peer: formatPeer(peerAddress),
      direction,
    });
    const pc = new RTCPeerConnection(rtcConfig);
    this.logActivity(`peer connection created ${formatPeer(peerAddress)} ${direction} create_channel=${createChannel}`);
    pc.ontrack = (event) => {
      this.logActivity(`remote track received ${formatPeer(peerAddress)} ${direction} kind=${event.track?.kind ?? 'unknown'}`);
      const key = linkKey(peerAddress, direction);
      const stream = this.remoteMediaStreams.get(key) ?? new MediaStream();
      const incomingTracks = event.streams.flatMap((eventStream) => eventStream.getTracks());
      if (event.track) incomingTracks.push(event.track);

      incomingTracks.forEach((track) => {
        if (stream.getTracks().some((existingTrack) => existingTrack.id === track.id)) return;
        stream.addTrack(track);
        track.addEventListener('ended', () => {
          stream.removeTrack(track);
          this.bumpMediaSnapshot();
        }, { once: true });
      });

      this.remoteMediaStreams.set(key, stream);
      this.bumpMediaSnapshot();
    };
    pc.onconnectionstatechange = () => {
      this.logActivity(`peer connection state ${formatPeer(peerAddress)} ${direction} ${pc.connectionState}`);
      if (['closed', 'failed', 'disconnected'].includes(pc.connectionState)) {
        const reason = `peer connection ${pc.connectionState}`;
        this.resetPeerLink(peerAddress, direction, reason);
      }
    };
    pc.oniceconnectionstatechange = () => {
      this.logActivity(`ice connection state ${formatPeer(peerAddress)} ${direction} ${pc.iceConnectionState}`);
      if (['closed', 'failed', 'disconnected'].includes(pc.iceConnectionState)) {
        const reason = `ice connection ${pc.iceConnectionState}`;
        this.resetPeerLink(peerAddress, direction, reason);
      }
    };
    pc.ondatachannel = (event) => {
      this.logActivity(`data channel received ${formatPeer(peerAddress)} ${direction} (${event.channel.label})`);
      this.setupDataChannel(peerAddress, direction, event.channel, resolveConnection);
    };

    if (createChannel) {
      this.setupDataChannel(
        peerAddress,
        direction,
        pc.createDataChannel(`mesh-${direction}`),
        resolveConnection,
      );
    }

    if (subscription) {
      subscription.peerConnection = pc;
      this.syncSubscriptionMedia(subscription);
    }
    return pc;
  }

  async encryptSignalForPeer(recipientPubKey, signal) {
    const { playerAddress, publicKey } = this.config;
    const encryptionPublicKey = normalizePublicKey(recipientPubKey);
    if (!publicKey || !encryptionPublicKey) {
      this.logActivity(`encryption failed: missing key (local=${Boolean(publicKey)}, remote=${Boolean(encryptionPublicKey)})`);
      return undefined;
    }

    const payload = JSON.stringify({
      ...signal,
      app: 'private-poker',
      version: 1,
      senderPlayerAddress: playerAddress,
      senderPubKey: publicKey,
    });
    const encryptedPayload = await encryptForPeer(encryptionPublicKey, payload);
    return {
      encryptedData: toHex(new TextEncoder().encode(JSON.stringify(encryptedPayload))),
      encryptionPublicKey,
    };
  }

  async sendEncryptedSignal(recipientAddress, recipientPubKey, signal, enqueue = null) {
    const { playerAddress, lobbyId, tableId } = this.config;
    const encryptedSignal = await this.encryptSignalForPeer(recipientPubKey, signal);
    if (!encryptedSignal) {
      throw new Error(`Failed to encrypt signal for peer ${recipientAddress}: missing public key.`);
    }

    await this.sendSignal(lobbyId, tableId, recipientAddress, encryptedSignal.encryptedData, {
      playerAddress,
      operatorPrivateKey: this.config.operatorPrivateKey,
      signalType: signal.type,
      flowId: signal.flowId,
      enqueue,
    });

    this.emitActivity(`${formatSeat(recipientAddress)} << ${signal.type === 'accept' ? 'Accept' : 'Offer'} ${formatKey(encryptedSignal.encryptionPublicKey)}`);
  }

  async sendPooledEncryptedSignal(recipientAddress, recipientPubKey, signal) {
    const { playerAddress, lobbyId, tableId } = this.config;
    const encryptedSignal = await this.encryptSignalForPeer(recipientPubKey, signal);
    if (!encryptedSignal) return false;

    const delivered = await this.sessionPool.sendEncryptedSignal({
      originAddress: playerAddress,
      targetAddress: recipientAddress,
      lobbyId,
      tableId,
      encryptedData: encryptedSignal.encryptedData,
    });

    if (delivered) {
      this.logActivity(`gossip ${signal.type} delivered ${formatPeer(recipientAddress)}`);
      this.emitActivity(`${formatSeat(recipientAddress)} <~ ${signal.type === 'accept' ? 'Accept' : 'Offer'} ${formatKey(encryptedSignal.encryptionPublicKey)}`);
    } else {
      this.logActivity(`gossip ${signal.type} undelivered ${formatPeer(recipientAddress)}`);
    }
    return delivered;
  }

  async triggerOfferForPeer(peerAddress, enqueue = null, { transport = 'mesh', flowId = null } = {}) {
    const peerKey = normalizeAddress(peerAddress);
    const subscription = this.getSubscription(peerAddress, RTC_LINK.INBOUND);
    const pubKey = subscription?.publicAnnounceKey ?? this.getPlayerPublicKey(peerAddress);

    this.logActivity(`triggerOfferForPeer for ${formatPeer(peerKey)} (transport=${transport}, pubKey found: ${Boolean(pubKey)})`);

    if (!pubKey) {
      this.logActivity(`triggerOfferForPeer aborted: missing announce public key for ${formatPeer(peerKey)}`);
      return;
    }

    await this.executeSendOffer({
      playerAddress: peerAddress,
      annoncePublicKey: pubKey,
    }, { enqueue, transport, flowId });
  }

  async executeSendOffer(peer, { enqueue = null, transport = 'mesh', flowId = null } = {}) {
    const { playerAddress, publicKey, tableId, lobbyId } = this.config;
    const peerPubKey = peer?.annoncePublicKey ?? peer?.announcePublicKey;

    if (!playerAddress || !publicKey || !tableId || !lobbyId || !peer?.playerAddress || !peerPubKey) {
      this.logActivity(`executeSendOffer aborted: incomplete config`);
      return;
    }

    try {
      this.hasConnectionError = false;
      if (this.connectedLinks.has(linkKey(peer.playerAddress, RTC_LINK.INBOUND))) {
        this.setSubscriptionState(peer.playerAddress, RTC_LINK.INBOUND, SUBSCRIPTION_STATE.CONNECTED);
        return;
      }

      const existing = this.getSubscription(peer.playerAddress, RTC_LINK.INBOUND);
      if (
        existing?.state === SUBSCRIPTION_STATE.OFFER_SENT
        && existing.peerConnection
        && !isDeadPeerConnection(existing.peerConnection)
      ) {
        this.logActivity(`executeSendOffer skipped ${formatPeer(peer.playerAddress)}: offer already in flight`);
        return;
      }
      if (!existing) {
        this.createSubscription(peer.playerAddress, peerPubKey, RTC_LINK.INBOUND);
      }

      this.logActivity(`executeSendOffer creating SDP offer for ${formatPeer(peer.playerAddress)} via ${transport}`);
      const pc = this.createPeerConnection(peer.playerAddress, RTC_LINK.INBOUND, true);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);

      const signal = {
        type: 'offer',
        direction: RTC_LINK.INBOUND,
        sdp: pc.localDescription.sdp,
        flowId,
      };

      if (transport === 'gossip') {
        const delivered = await this.sendPooledEncryptedSignal(peer.playerAddress, peerPubKey, signal);
        if (!delivered) {
          this.setSubscriptionState(peer.playerAddress, RTC_LINK.INBOUND, SUBSCRIPTION_STATE.CREATED);
          return;
        }
      } else {
        await this.sendEncryptedSignal(peer.playerAddress, peerPubKey, signal, enqueue);
      }
      this.setSubscriptionState(peer.playerAddress, RTC_LINK.INBOUND, SUBSCRIPTION_STATE.OFFER_SENT);
      this.startOfferTimeout(peer.playerAddress);
      this.emitState();
    } catch (error) {
      this.hasConnectionError = true;
      this.emitState();
      this.logActivity(`executeSendOffer failed ${formatPeer(peer.playerAddress)}: ${error.message}`);
    }
  }

  async sendOffer(peer) {
    const peerKey = normalizeAddress(peer?.playerAddress);
    if (!peerKey) return;

    this.lookingForPeers.add(peerKey);
    this.schedulePeerDiscovery();
  }

  async subscribeTo(peerPlayerAddress, peerAnnouncePubKey, callback) {
    const peerKey = normalizeAddress(peerPlayerAddress);
    if (!peerKey) return;

    this.lookingForPeers.add(peerKey);
    this.resetPeerLink(peerPlayerAddress, RTC_LINK.INBOUND, 'new subscribeTo call');
    this.inboundSubscriptions.delete(peerKey);
    this.createSubscription(peerPlayerAddress, peerAnnouncePubKey, RTC_LINK.INBOUND, callback);
    callback?.(this.getPlayerSeatNo(peerPlayerAddress), {
      kind: 'network',
      state: SUBSCRIPTION_STATE.CREATED,
      playerAddress: peerPlayerAddress,
    });
    this.emitState();
    this.schedulePeerDiscovery();
  }

  async pokeInboundConnection(peerPlayerAddress, peerAnnouncePubKey, callback) {
    const peerKey = normalizeAddress(peerPlayerAddress);
    if (!peerKey) return;

    if (this.connectedLinks.has(linkKey(peerPlayerAddress, RTC_LINK.INBOUND))) {
      this.setSubscriptionState(peerPlayerAddress, RTC_LINK.INBOUND, SUBSCRIPTION_STATE.CONNECTED);
      return;
    }

    const existing = this.getSubscription(peerPlayerAddress, RTC_LINK.INBOUND);
    const publicAnnounceKey = peerAnnouncePubKey ?? existing?.publicAnnounceKey;
    if (!publicAnnounceKey) return;

    if (!existing) {
      this.createSubscription(peerPlayerAddress, publicAnnounceKey, RTC_LINK.INBOUND, callback);
    } else {
      existing.publicAnnounceKey = publicAnnounceKey;
      if (callback) existing.callback = callback;
    }

    this.lookingForPeers.add(peerKey);
    this.resetPeerLink(peerPlayerAddress, RTC_LINK.INBOUND, 'poke');

    this.logActivity(`Poke action: re-announcing peer discovery for ${formatPeer(peerKey)}`);
    this.schedulePeerDiscovery();
  }

  async sendAccept(peerAddress, peerPubKey, offerSdp, direction = RTC_LINK.OUTBOUND, { viaDataChannel = false, viaPool = false, enqueue = null, flowId = null } = {}) {
    const peerKey = normalizeAddress(peerAddress);
    const existing = this.getSubscription(peerAddress, direction);
    const publicAnnounceKey = peerPubKey ?? existing?.publicAnnounceKey ?? this.getPlayerPublicKey(peerAddress);
    if (!existing || isDeadPeerConnection(existing.peerConnection)) {
      this.resetPeerLink(peerAddress, direction, 'incoming offer');
      if (direction === RTC_LINK.OUTBOUND) {
        this.outboundSubscriptions.delete(peerKey);
      } else {
        this.inboundSubscriptions.delete(peerKey);
      }
      this.createSubscription(peerAddress, publicAnnounceKey, direction);
    } else if (publicAnnounceKey) {
      existing.publicAnnounceKey = publicAnnounceKey;
    }

    const pc = this.createPeerConnection(peerAddress, direction, false);
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const accept = await pc.createAnswer();
    await pc.setLocalDescription(accept);
    await waitForIceGatheringComplete(pc);
    const signal = {
      type: 'accept',
      direction,
      sdp: pc.localDescription.sdp,
      flowId,
    };

    if (viaDataChannel) {
      if (!this.sendControlMessage(peerAddress, direction, { signal })) {
        this.emitMediaDataChannelRequired(peerAddress);
        return;
      }
    } else if (viaPool) {
      const delivered = await this.sendPooledEncryptedSignal(peerAddress, publicAnnounceKey, signal);
      if (!delivered) {
        this.logActivity(`gossip accept undelivered ${formatPeer(peerAddress)}`);
        return;
      }
    } else {
      await this.sendEncryptedSignal(peerAddress, publicAnnounceKey, signal, enqueue);
    }

    this.setSubscriptionState(peerAddress, direction, SUBSCRIPTION_STATE.ACCEPT_SENT);
  }

  async handleIncomingSignal(senderAddress, signal, { viaDataChannel = false, viaPool = false, receivedDirection = null, enqueue = null } = {}) {
    if (signal?.type === 'trigger-offer') {
      const target = normalizeAddress(signal.target);
      const transport = signal.transport === 'gossip' ? 'gossip' : 'mesh';
      this.logActivity(`received trigger-offer for target ${formatPeer(target)} via ${transport}`);
      await this.triggerOfferForPeer(target, enqueue, { transport, flowId: signal.flowId });
      return;
    }

    if (signal?.type === 'p2p-route-available') {
      const target = normalizeAddress(signal.target);
      const status = signal.status;
      this.logActivity(`received p2p-route-available for ${formatPeer(target)} [status: ${status}]`);

      if (status === 'connect_through_peers') {
        this.emitActivity(`${formatSeat(target)} :: Reachable via P2P Gossip`);
        await this.triggerOfferForPeer(target, null, { transport: 'gossip', flowId: signal.flowId });

      } else if (status === 'cut') {
        this.emitActivity(`${formatSeat(target)} !! P2P Route Cut`);
      }
      return;
    }

    const peerPubKey = signal.senderPubKey;

    if (signal.type === 'offer') {
      if (!viaDataChannel && !peerPubKey) throw new Error('Incoming offer did not include senderPubKey.');

      this.emitActivity(`${formatSeat(senderAddress)} ${viaPool ? '~>' : '>>'} Offer ${formatKey(peerPubKey)}`);
      await this.sendAccept(
        senderAddress,
        peerPubKey,
        signal.sdp,
        viaDataChannel ? receivedDirection : oppositeLink(signal.direction ?? RTC_LINK.INBOUND),
        { viaDataChannel, viaPool, enqueue, flowId: signal.flowId },
      );
      return;
    }

    if (signal.type === 'accept' || signal.type === 'answer') {
      this.emitActivity(`${formatSeat(senderAddress)} ${viaPool ? '~>' : '>>'} Accept ${formatKey(peerPubKey)}`);
      const direction = viaDataChannel ? receivedDirection : oppositeLink(signal.direction ?? RTC_LINK.OUTBOUND);
      const subscription = this.getSubscription(senderAddress, direction);
      const pc = subscription?.peerConnection;

      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      this.setSubscriptionState(senderAddress, direction, SUBSCRIPTION_STATE.ACCEPT_RECEIVED);

      const peerKey = normalizeAddress(senderAddress);
      const connectionPromise = this.connectionPromises?.get(peerKey);
      if (connectionPromise && typeof enqueue === 'function') {
        enqueue(connectionPromise);
        this.connectionPromises.delete(peerKey);
      }
    }
  }

  async handleSignal(signalData, enqueue = null) {
    if (
      signalData?.type === 'trigger-offer'
      || signalData?.type === 'p2p-route-available'
    ) {
      await this.handleIncomingSignal(
        signalData.recipient ?? this.config.playerAddress,
        signalData,
        { enqueue },
      );
      return;
    }

    const { playerAddress, operator, privateKey, tableId, lobbyId } = this.config;
    if (!tableId || !lobbyId) return;
    if (signalData.tableId !== tableId.toString() || signalData.lobbyId !== lobbyId.toString()) return;
    if (normalizeAddress(signalData.sender) === normalizeAddress(playerAddress)) return;
    if (normalizeAddress(signalData.sender) === normalizeAddress(operator)) return;
    if (signalData.logId && this.processedSignals.has(signalData.logId)) return;
    if (signalData.logId) {
      this.processedSignals.add(signalData.logId);
      if (this.processedSignals.size > MAX_PROCESSED_SIGNALS) {
        const [oldestSignalId] = this.processedSignals;
        this.processedSignals.delete(oldestSignalId);
      }
    }

    if (signalData.isRecipient === false) return;
    if (!privateKey) return;

    try {
      const payloadString = new TextDecoder().decode(hexToBytes(signalData.encryptedData));
      const encryptedPayload = JSON.parse(payloadString);
      const decryptedString = await decryptFromPeer(privateKey, encryptedPayload);
      const signal = JSON.parse(decryptedString);
      await this.handleIncomingSignal(
        signal.senderPlayerAddress ?? signalData.sender,
        signal,
        { enqueue },
      );
    } catch (error) {
      this.logActivity(`signal ignored: ${error.message}`);
    }
  }

  async handleGossipAnnounce(message) {
    const { playerAddress, lobbyId, tableId } = this.config;
    const origin = normalizeAddress(message?.originAddress);
    const target = normalizeAddress(message?.targetAddress);
    const me = normalizeAddress(playerAddress);
    if (!origin || !target || target !== me || origin === me) return;
    if (String(message.lobbyId) !== String(lobbyId) || String(message.tableId) !== String(tableId)) return;

    this.logActivity(`gossip announce reached me from ${formatPeer(origin)}`);
    this.sessionPool.sendGossipTriggerOffer?.({
      originAddress: playerAddress,
      targetAddress: origin,
      triggerTargetAddress: playerAddress,
      lobbyId,
      tableId,
    });
  }

  async handleGossipTriggerOffer(message) {
    const { playerAddress, lobbyId, tableId } = this.config;
    const target = normalizeAddress(message?.targetAddress);
    const triggerTarget = normalizeAddress(message?.triggerTargetAddress ?? message?.originAddress);
    if (target !== normalizeAddress(playerAddress) || !triggerTarget) return;
    if (String(message.lobbyId) !== String(lobbyId) || String(message.tableId) !== String(tableId)) return;

    this.markGossipRouteFound(triggerTarget);
    this.emitActivity(`${formatSeat(triggerTarget)} :: Reachable via P2P Gossip`);
    await this.triggerOfferForPeer(triggerTarget, null, { transport: 'gossip' });
  }

  async handleP2PMstRouteIntent(route) {
    const peerAddress = normalizeAddress(route?.from);
    if (!this.hasPendingP2PIntent(peerAddress)) return;

    this.markGossipRouteFound(peerAddress);
    this.emitActivity(`${formatSeat(peerAddress)} :: Reachable via P2P MST`);
    this.logActivity(`p2p mst route found ${formatPeer(peerAddress)} via ${formatPeer(route.viaNeighbor)} distance=${route.distance}`);
    await this.triggerOfferForPeer(peerAddress, null, {
      transport: 'gossip',
      flowId: route.flowId,
    });
  }

  async handleRelayEncryptedSignal(envelope) {
    return this.enqueueControlAction(
      'RTC pooled signal',
      () => this.handleRelayEncryptedSignalNow(envelope),
      { dependsOn: this.blsActionKey ? [this.blsActionKey] : [] },
    );
  }

  async handleRelayEncryptedSignalNow(envelope) {
    const { privateKey } = this.config;
    if (!envelope?.encryptedData) return;
    if (!privateKey) {
      if (!this.pendingRelayEnvelopes.some((pending) => pending.id === envelope.id)) {
        this.pendingRelayEnvelopes.push(envelope);
        if (this.pendingRelayEnvelopes.length > MAX_PROCESSED_SIGNALS) {
          this.pendingRelayEnvelopes.shift();
        }
      }
      return;
    }

    try {
      const payloadString = new TextDecoder().decode(hexToBytes(envelope.encryptedData));
      const encryptedPayload = JSON.parse(payloadString);
      const decryptedString = await decryptFromPeer(privateKey, encryptedPayload);
      const signal = JSON.parse(decryptedString);
      await this.handleIncomingSignal(signal.senderPlayerAddress ?? envelope.originAddress, signal, {
        viaPool: true,
      });
    } catch (error) {
      this.logActivity(`pooled signal ignored: ${error.message}`);
    }
  }

  async drainPendingRelayEnvelopes() {
    if (this.drainingRelayEnvelopes || !this.config.privateKey || this.pendingRelayEnvelopes.length === 0) {
      return;
    }

    this.drainingRelayEnvelopes = true;
    const pending = this.pendingRelayEnvelopes.splice(0);
    try {
      for (const envelope of pending) {
        await this.handleRelayEncryptedSignal(envelope);
      }
    } finally {
      this.drainingRelayEnvelopes = false;
    }
  }

  publishMessage(message) {
    this.publishQueue = this.publishQueue
      .then(() => this.publishSignedMessage(message))
      .catch((error) => {
        this.emitActivity(`[Me]: RTC message signing failed`);
        console.error('Failed to sign RTC message:', error);
      });
  }

  resetForTable() {
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.gossipFallbackTimers.forEach((timer) => clearTimeout(timer));
    this.sessionPool.unregisterSession(this);
    this.inboundSubscriptions.forEach((subscription) => {
      if (subscription.webRtcChannel) {
        this.sendDisconnectNotice(subscription);
        this.sessionPool.unregisterLink({
          session: this,
          peerAddress: subscription.playerAddress,
          direction: subscription.direction,
        });
        subscription.webRtcChannel.onopen = null;
        subscription.webRtcChannel.onclose = null;
        subscription.webRtcChannel.onmessage = null;
        subscription.webRtcChannel.close();
      }
      if (subscription.peerConnection) {
        subscription.peerConnection.onconnectionstatechange = null;
        subscription.peerConnection.oniceconnectionstatechange = null;
        subscription.peerConnection.ondatachannel = null;
        subscription.peerConnection.ontrack = null;
        subscription.peerConnection.close();
      }
    });
    this.outboundSubscriptions.forEach((subscription) => {
      if (subscription.webRtcChannel) {
        this.sendDisconnectNotice(subscription);
        this.sessionPool.unregisterLink({
          session: this,
          peerAddress: subscription.playerAddress,
          direction: subscription.direction,
        });
        subscription.webRtcChannel.onopen = null;
        subscription.webRtcChannel.onclose = null;
        subscription.webRtcChannel.onmessage = null;
        subscription.webRtcChannel.close();
      }
      if (subscription.peerConnection) {
        subscription.peerConnection.onconnectionstatechange = null;
        subscription.peerConnection.oniceconnectionstatechange = null;
        subscription.peerConnection.ondatachannel = null;
        subscription.peerConnection.ontrack = null;
        subscription.peerConnection.close();
      }
    });
    this.connectedLinks.clear();
    this.connectedPeers.clear();
    this.inboundSubscriptions.clear();
    this.outboundSubscriptions.clear();
    this.processedSignals.clear();
    this.joinLog.clear();
    this.resetLinks.clear();
    this.offerTimeouts.clear();
    this.offerRetryTimers.clear();
    this.bootstrapByeSent.clear();
    this.publishedMessages.clear();
    this.seenDisagreements.clear();
    this.lookingForPeers.clear();
    this.gossipFallbackTimers.clear();
    this.localMediaStream = null;
    this.remoteMediaStreams.clear();
    this.mediaSnapshotVersion += 1;
    this.publishQueue = Promise.resolve();
    this.badSignatureOnce = false;
    this.dropNextMessage = false;
    this.duplicateNextMessage = false;
    this.ready = false;
    this.configKey = '';
    this.snapshotKey = '';
    this.emitState();
  }

  destroy() {
    this.resetForTable();
  }
}
