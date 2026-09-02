import { hexToBytes, toHex } from 'viem';
import { decryptFromPeer, encryptForPeer, normalizePeerPublicKey } from 'privatepoker-hooks/networking/signaling/SignalEncryption';
import {
  P2P_MST_MESSAGE,
  RouteIntentGraph,
} from 'privatepoker-hooks/networking/routing/p2p_mst';
import { makeMeshRtcConfig } from 'privatepoker-hooks/config/mesh';

const RTC_POOL_SIGNAL = 'RTC_POOL_SIGNAL';
const RTC_POOL_ROUTE_REQUEST = 'RTC_POOL_ROUTE_REQUEST';
const RTC_POOL_ROUTE_RESULT = 'RTC_POOL_ROUTE_RESULT';
const RTC_POOL_LOCAL_NOTICE = 'RTC_POOL_LOCAL_NOTICE';
const RTC_POOL_GOSSIP_ANNOUNCE = 'RTC_POOL_GOSSIP_ANNOUNCE';
const RTC_POOL_GOSSIP_TRIGGER_OFFER = 'RTC_POOL_GOSSIP_TRIGGER_OFFER';
const RTC_POOL_P2P_MST_FRAGMENT = P2P_MST_MESSAGE.FRAGMENT;
const RTC_POOL_BROADCAST_CHANNEL = 'private-poker:rtc-session-pool';
const DEFAULT_TTL = 6;
const DEFAULT_P2P_MST_EDGE_TTL_MS = 120_000;
const MAX_SEEN_MESSAGES = 500;
const DELIVERY_TIMEOUT_MS = 800;
const SILENT_DELIVERY_TIMEOUT_MS = 8000;
const LOBBY_ROUTE_TIMEOUT_MS = 10000;
const WORKER_HEARTBEAT_MS = 5000;
const DEFAULT_MAX_CONNECTION_REQUESTS = 1;
const DEFAULT_MAX_SILENT_CONNECTIONS = 12;
const DEFAULT_SILENT_CONNECTION_MAX_AGE_MS = 30 * 60 * 1000;
const SILENT_CONNECTION_PRUNE_MS = 60 * 1000;
const ENDPOINT = {
  TABLE: 'table',
  LOBBY: 'lobby',
};

const normalizeAddress = (value) => value?.toLowerCase() ?? '';
const formatPeer = (value) => {
  const text = value ? String(value) : '';
  if (!text) return 'unknown';
  return text.length <= 12 ? text : `${text.slice(0, 6)}...${text.slice(-4)}`;
};

function logPool(message, details = undefined) {
  if (details === undefined) {
    console.log(`[RTC pool] ${message}`);
    return;
  }
  console.log(`[RTC pool] ${message}`, details);
}

function sessionKey({ playerAddress, lobbyId, tableId, endpoint = ENDPOINT.TABLE }) {
  const scopedTableId = endpoint === ENDPOINT.LOBBY ? 'lobby' : String(tableId ?? '');
  return [
    endpoint,
    normalizeAddress(playerAddress),
    String(lobbyId ?? ''),
    scopedTableId,
  ].join(':');
}

function lobbyPresenceKey(playerAddress, lobbyId) {
  return [
    normalizeAddress(playerAddress),
    String(lobbyId ?? ''),
  ].join(':');
}

const waitForIceGatheringComplete = (pc) => {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve) => {
    let timeout;

    const finish = () => {
      clearTimeout(timeout);
      pc.removeEventListener('icegatheringstatechange', handleStateChange);
      resolve();
    };

    const handleStateChange = () => {
      if (pc.iceGatheringState === 'complete') {
        finish();
      }
    };

    timeout = setTimeout(finish, 8000);
    pc.addEventListener('icegatheringstatechange', handleStateChange);
  });
};

class LobbySilentRtcEndpoint {
  constructor({ pool, localSession, peer }) {
    this.pool = pool;
    this.localSession = localSession;
    this.peer = peer;
    this.config = {
      playerAddress: localSession.playerAddress,
      lobbyId: localSession.lobbyId,
      tableId: localSession.tableId,
      publicKey: localSession.publicKey,
      privateKey: localSession.privateKey,
      players: [peer],
    };
    this.endpoint = ENDPOINT.LOBBY;
    this.peerConnection = null;
    this.dataChannel = null;
    this.started = false;
    this.createdAt = Date.now();
    this.lastUsedAt = this.createdAt;
    this.lastAnswerAt = 0;
    logPool('silent endpoint created', {
      local: formatPeer(localSession.playerAddress),
      peer: formatPeer(peer.playerAddress),
      lobbyId: localSession.lobbyId,
      tableId: localSession.tableId,
    });
  }

  get id() {
    return [
      normalizeAddress(this.localSession.playerAddress),
      normalizeAddress(this.peer.playerAddress),
      this.localSession.lobbyId,
    ].join(':');
  }

  isConnected() {
    return this.peerConnection?.connectionState === 'connected'
      || this.dataChannel?.readyState === 'open';
  }

  async encryptSignal(signal) {
    const encryptionPublicKey = normalizePeerPublicKey(this.peer.announcePublicKey);
    const payload = JSON.stringify({
      ...signal,
      app: 'private-poker',
      version: 1,
      endpoint: ENDPOINT.LOBBY,
      senderPlayerAddress: this.localSession.playerAddress,
      senderPubKey: this.localSession.publicKey,
    });
    const encryptedPayload = await encryptForPeer(encryptionPublicKey, payload);
    return toHex(new TextEncoder().encode(JSON.stringify(encryptedPayload)));
  }

  async sendSignal(signal) {
    this.pool.touchSilentEndpoint(this);
    logPool(`silent ${signal.type} signal send`, {
      from: formatPeer(this.localSession.playerAddress),
      to: formatPeer(this.peer.playerAddress),
      endpoint: ENDPOINT.LOBBY,
    });
    const encryptedData = await this.encryptSignal(signal);
    const delivered = await this.pool.sendEncryptedSignal({
      originAddress: this.localSession.playerAddress,
      originEndpoint: ENDPOINT.LOBBY,
      targetAddress: this.peer.playerAddress,
      targetEndpoint: ENDPOINT.LOBBY,
      lobbyId: this.localSession.lobbyId,
      tableId: this.localSession.tableId,
      encryptedData,
      deliveryTimeoutMs: SILENT_DELIVERY_TIMEOUT_MS,
    });
    logPool(`silent ${signal.type} signal ${delivered ? 'delivered' : 'not delivered'}`, {
      from: formatPeer(this.localSession.playerAddress),
      to: formatPeer(this.peer.playerAddress),
    });
    return delivered;
  }

  createPeerConnection({ createChannel }) {
    if (this.peerConnection && this.peerConnection.connectionState !== 'closed') {
      return this.peerConnection;
    }

    logPool('silent peer connection create', {
      local: formatPeer(this.localSession.playerAddress),
      peer: formatPeer(this.peer.playerAddress),
      createChannel,
    });
    const pc = new RTCPeerConnection(makeMeshRtcConfig({ randomizeIceServer: true }));
    pc.ondatachannel = (event) => {
      logPool('silent data channel received', {
        local: formatPeer(this.localSession.playerAddress),
        peer: formatPeer(this.peer.playerAddress),
      });
      this.attachDataChannel(event.channel);
    };
    pc.onconnectionstatechange = () => {
      logPool(`silent peer connection state ${pc.connectionState}`, {
        local: formatPeer(this.localSession.playerAddress),
        peer: formatPeer(this.peer.playerAddress),
      });
      if (['closed', 'failed', 'disconnected'].includes(pc.connectionState)) {
        this.pool.unregisterLink({
          session: this,
          peerAddress: this.peer.playerAddress,
          direction: ENDPOINT.LOBBY,
        });
      }
    };

    if (createChannel) {
      this.attachDataChannel(pc.createDataChannel('private-poker-lobby-pool'));
    }

    this.peerConnection = pc;
    return pc;
  }

  attachDataChannel(channel) {
    this.dataChannel = channel;
    channel.onopen = () => {
      logPool('silent data channel open', {
        local: formatPeer(this.localSession.playerAddress),
        peer: formatPeer(this.peer.playerAddress),
      });
      this.pool.registerLink({
        session: this,
        peerAddress: this.peer.playerAddress,
        direction: ENDPOINT.LOBBY,
        channel,
        silent: true,
      });
    };
    channel.onclose = () => {
      logPool('silent data channel closed', {
        local: formatPeer(this.localSession.playerAddress),
        peer: formatPeer(this.peer.playerAddress),
      });
      this.pool.unregisterLink({
        session: this,
        peerAddress: this.peer.playerAddress,
        direction: ENDPOINT.LOBBY,
      });
    };
    channel.onmessage = (event) => {
      this.pool.touchSilentEndpoint(this);
      logPool('silent data channel message received', {
        local: formatPeer(this.localSession.playerAddress),
        peer: formatPeer(this.peer.playerAddress),
      });
      void this.pool.handleSilentDataMessage(this, this.peer.playerAddress, event.data);
    };
  }

  async start() {
    if (this.started) {
      logPool('silent endpoint start skipped, already started', {
        local: formatPeer(this.localSession.playerAddress),
        peer: formatPeer(this.peer.playerAddress),
      });
      return;
    }
    this.started = true;
    const offerStartedAt = Date.now();
    logPool('silent endpoint start', {
      local: formatPeer(this.localSession.playerAddress),
      peer: formatPeer(this.peer.playerAddress),
    });

    const pc = this.createPeerConnection({ createChannel: true });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);
    const delivered = await this.sendSignal({
      type: 'offer',
      endpoint: ENDPOINT.LOBBY,
      poolEndpointId: this.id,
      sdp: pc.localDescription.sdp,
    });
    if (!delivered && !this.isConnected() && this.lastAnswerAt < offerStartedAt) {
      logPool('silent endpoint offer not delivered, start reset', {
        local: formatPeer(this.localSession.playerAddress),
        peer: formatPeer(this.peer.playerAddress),
      });
      this.started = false;
    } else if (!delivered) {
      logPool('silent endpoint offer ack timed out after answer/connection', {
        local: formatPeer(this.localSession.playerAddress),
        peer: formatPeer(this.peer.playerAddress),
      });
    }
  }

  async handleRelayEncryptedSignal(envelope) {
    this.pool.touchSilentEndpoint(this);
    const payloadString = new TextDecoder().decode(hexToBytes(envelope.encryptedData));
    const encryptedPayload = JSON.parse(payloadString);
    const decryptedString = await decryptFromPeer(this.localSession.privateKey, encryptedPayload);
    const signal = JSON.parse(decryptedString);
    logPool(`silent relay signal received ${signal.type}`, {
      from: formatPeer(envelope.originAddress),
      to: formatPeer(envelope.targetAddress),
    });

    if (signal.type === 'offer') {
      const pc = this.createPeerConnection({ createChannel: false });
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc);
      await this.sendSignal({
        type: 'accept',
        endpoint: ENDPOINT.LOBBY,
        poolEndpointId: signal.poolEndpointId,
        sdp: pc.localDescription.sdp,
      });
      logPool('silent offer accepted', {
        local: formatPeer(this.localSession.playerAddress),
        peer: formatPeer(this.peer.playerAddress),
      });
      return;
    }

    if (signal.type === 'accept' || signal.type === 'answer') {
      this.lastAnswerAt = Date.now();
      const pc = this.peerConnection;
      if (pc && pc.signalingState !== 'stable') {
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        logPool('silent answer applied', {
          local: formatPeer(this.localSession.playerAddress),
          peer: formatPeer(this.peer.playerAddress),
        });
      }
    }
  }
}

function makeMessageId(originAddress, targetAddress, lobbyId, tableId) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return [
    normalizeAddress(originAddress),
    normalizeAddress(targetAddress),
    lobbyId,
    tableId,
    random,
  ].join(':');
}

class RtcSessionPool {
  constructor() {
    this.tabId = makeMessageId('tab', 'pool', '0', '0');
    this.role = 'table';
    this.sessions = new Map();
    this.lobbyPresences = new Map();
    this.links = new Map();
    this.knownPeers = new Map();
    this.silentEndpoints = new Map();
    this.seenMessages = new Set();
    this.seenGossipMessages = new Map();
    this.p2pMstGraphs = new Map();
    this.notifiedP2PMstRoutes = new Set();
    this.pendingDeliveries = new Map();
    this.pendingRoutes = new Map();
    this.seenRouteRequests = new Set();
    this.connectionRequestQueue = [];
    this.activeConnectionRequests = 0;
    this.maxConcurrentConnectionRequests = DEFAULT_MAX_CONNECTION_REQUESTS;
    this.maxSilentConnections = DEFAULT_MAX_SILENT_CONNECTIONS;
    this.silentConnectionMaxAgeMs = DEFAULT_SILENT_CONNECTION_MAX_AGE_MS;
    this.silentConnectionPruneTimer = null;
    this.broadcastChannel = null;
    this.worker = null;
    this.workerReady = false;
    this.workerHeartbeat = null;
    this.workerDisconnectHandler = null;
    this.connectBroadcastChannel();
    this.connectSharedWorker();
    this.startSilentConnectionPruning();
    logPool('pool initialized', {
      tabId: this.tabId,
      role: this.role,
      broadcast: Boolean(this.broadcastChannel),
      sharedWorker: Boolean(this.worker),
    });
  }

  setRole(role) {
    this.role = role;
    logPool(`role set ${role}`);
    this.postBroadcast({
      type: 'RTC_POOL_ROLE',
      role,
    });
  }

  setMaxConcurrentConnectionRequests(count) {
    const nextCount = Math.max(1, Number(count) || DEFAULT_MAX_CONNECTION_REQUESTS);
    this.maxConcurrentConnectionRequests = nextCount;
    logPool('connection request concurrency set', { count: nextCount });
    this.drainConnectionRequestQueue();
  }

  setMaxSilentConnections(count) {
    const nextCount = Math.max(1, Number(count) || DEFAULT_MAX_SILENT_CONNECTIONS);
    this.maxSilentConnections = nextCount;
    logPool('silent connection max set', { count: nextCount });
    this.enforceSilentConnectionLimit();
  }

  setSilentConnectionMaxAge(milliseconds) {
    const nextAge = Math.max(1000, Number(milliseconds) || DEFAULT_SILENT_CONNECTION_MAX_AGE_MS);
    this.silentConnectionMaxAgeMs = nextAge;
    logPool('silent connection max age set', { milliseconds: nextAge });
    this.pruneExpiredSilentConnections();
  }

  startSilentConnectionPruning() {
    if (typeof window === 'undefined' || this.silentConnectionPruneTimer) return;
    this.silentConnectionPruneTimer = setInterval(() => {
      this.pruneExpiredSilentConnections();
    }, SILENT_CONNECTION_PRUNE_MS);
  }

  touchSilentEndpoint(endpoint, timestamp = Date.now()) {
    if (!endpoint) return;
    endpoint.lastUsedAt = timestamp;
  }

  closeSilentEndpoint(endpoint, reason) {
    if (!endpoint) return;
    logPool('silent endpoint evicted', {
      reason,
      local: formatPeer(endpoint.localSession?.playerAddress),
      peer: formatPeer(endpoint.peer?.playerAddress),
      ageMs: endpoint.createdAt ? Date.now() - endpoint.createdAt : null,
    });
    this.unregisterLink({
      session: endpoint,
      peerAddress: endpoint.peer?.playerAddress,
      direction: ENDPOINT.LOBBY,
    });
    const hasAnotherLobbyEndpoint = [...this.silentEndpoints.values()].some((candidate) => (
      candidate !== endpoint
      && normalizeAddress(candidate.localSession?.playerAddress) === normalizeAddress(endpoint.localSession?.playerAddress)
      && String(candidate.localSession?.lobbyId) === String(endpoint.localSession?.lobbyId)
    ));
    if (!hasAnotherLobbyEndpoint) {
      this.postUnregisterSession(endpoint);
    }
    const key = sessionKey({
      playerAddress: endpoint.localSession?.playerAddress,
      lobbyId: endpoint.localSession?.lobbyId,
      tableId: endpoint.localSession?.tableId,
      endpoint: ENDPOINT.LOBBY,
    });
    if (this.sessions.get(key) === endpoint) {
      this.sessions.delete(key);
    }
    this.silentEndpoints.delete(endpoint.id);
    try {
      endpoint.dataChannel?.close();
    } catch {
      // Best-effort cleanup only.
    }
    try {
      endpoint.peerConnection?.close();
    } catch {
      // Best-effort cleanup only.
    }
  }

  enforceSilentConnectionLimit() {
    while (this.silentEndpoints.size > this.maxSilentConnections) {
      const oldest = [...this.silentEndpoints.values()]
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
      this.closeSilentEndpoint(oldest, 'max_silent_connections');
    }
  }

  pruneExpiredSilentConnections() {
    const now = Date.now();
    [...this.silentEndpoints.values()].forEach((endpoint) => {
      if (now - (endpoint.createdAt ?? now) >= this.silentConnectionMaxAgeMs) {
        this.closeSilentEndpoint(endpoint, 'silent_connection_max_age');
      }
    });
  }

  enqueueConnectionRequest(task) {
    return new Promise((resolve, reject) => {
      this.connectionRequestQueue.push({ task, resolve, reject });
      logPool('connection request queued', {
        queueLength: this.connectionRequestQueue.length,
        active: this.activeConnectionRequests,
        max: this.maxConcurrentConnectionRequests,
      });
      this.drainConnectionRequestQueue();
    });
  }

  drainConnectionRequestQueue() {
    while (
      this.activeConnectionRequests < this.maxConcurrentConnectionRequests
      && this.connectionRequestQueue.length > 0
    ) {
      const item = this.connectionRequestQueue.shift();
      this.activeConnectionRequests += 1;
      logPool('connection request started', {
        queueLength: this.connectionRequestQueue.length,
        active: this.activeConnectionRequests,
        max: this.maxConcurrentConnectionRequests,
      });
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeConnectionRequests = Math.max(0, this.activeConnectionRequests - 1);
          logPool('connection request finished', {
            queueLength: this.connectionRequestQueue.length,
            active: this.activeConnectionRequests,
            max: this.maxConcurrentConnectionRequests,
          });
          this.drainConnectionRequestQueue();
        });
    }
  }

  connectBroadcastChannel() {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;

    try {
      this.broadcastChannel = new BroadcastChannel(RTC_POOL_BROADCAST_CHANNEL);
      this.broadcastChannel.onmessage = (event) => {
        void this.handleBroadcastMessage(event.data);
      };
      logPool('BroadcastChannel connected');
    } catch (error) {
      logPool('BroadcastChannel unavailable', error);
      this.broadcastChannel = null;
    }
  }

  postBroadcast(message) {
    if (!this.broadcastChannel) return false;
    logPool(`broadcast post ${message.type}`, {
      signalId: message.signal?.id ?? message.id ?? null,
      target: formatPeer(message.signal?.targetAddress),
    });
    this.broadcastChannel.postMessage({
      ...message,
      tabId: this.tabId,
    });
    return true;
  }

  connectSharedWorker() {
    if (typeof window === 'undefined' || typeof SharedWorker === 'undefined') return;

    try {
      this.worker = new SharedWorker(
        new URL('../workers/rtc-session-pool-worker.js', import.meta.url),
        { type: 'module' },
      );
      this.worker.port.onmessage = (event) => {
        void this.handleWorkerMessage(event.data);
      };
      this.worker.port.start();
      logPool('SharedWorker connected');
    } catch (error) {
      logPool('SharedWorker unavailable', error);
      this.worker = null;
    }
  }

  postWorker(message) {
    if (!this.worker) return false;
    if (!['HEARTBEAT', 'DISCONNECT'].includes(message.type)) {
      logPool(`worker post ${message.type}`, {
        signalId: message.signal?.id ?? message.id ?? null,
        target: formatPeer(message.signal?.targetAddress),
      });
    }
    this.worker.port.postMessage(message);
    return true;
  }

  startWorkerHeartbeat() {
    if (typeof window === 'undefined' || !this.worker || this.workerHeartbeat) return;

    const beat = () => this.postWorker({ type: 'HEARTBEAT' });
    beat();
    this.workerHeartbeat = setInterval(beat, WORKER_HEARTBEAT_MS);

    this.workerDisconnectHandler = () => {
      this.postWorker({ type: 'DISCONNECT' });
    };
    window.addEventListener('pagehide', this.workerDisconnectHandler);
  }

  async handleWorkerMessage(message) {
    if (message?.type === 'READY') {
      this.workerReady = true;
      logPool('SharedWorker ready', { portId: message.portId });
      this.startWorkerHeartbeat();
      this.sessions.forEach((session) => this.postRegisterSession(session));
      return;
    }

    if (message?.type === RTC_POOL_SIGNAL) {
      const signal = message.signal;
      logPool('worker signal received', {
        signalId: signal?.id,
        from: formatPeer(signal?.originAddress),
        to: formatPeer(signal?.targetAddress),
        endpoint: signal?.targetEndpoint,
      });
      if (!this.remember(signal?.id)) {
        logPool('worker signal ignored, already seen', { signalId: signal?.id });
        return;
      }
      await this.deliverOrScatter(signal);
      return;
    }

    if (message?.type === RTC_POOL_GOSSIP_ANNOUNCE || message?.type === RTC_POOL_GOSSIP_TRIGGER_OFFER) {
      await this.handleGossipControlMessage(message);
      return;
    }

    if (message?.type === RTC_POOL_P2P_MST_FRAGMENT) {
      if (!this.rememberGossip(message)) return;
      await this.handleP2PMstFragment(message);
      return;
    }

    if (message?.type === RTC_POOL_ROUTE_REQUEST) {
      await this.handleRouteRequest(message);
      return;
    }

    if (message?.type === RTC_POOL_ROUTE_RESULT) {
      this.resolveRoute(message);
      return;
    }

    if (message?.type === RTC_POOL_LOCAL_NOTICE) {
      this.dispatchLocalLobbyNotice(message.noticeType, message.detail);
      return;
    }

    if (message?.type === 'RTC_POOL_SIGNAL_DELIVERED') {
      logPool('worker delivery ack received', { signalId: message.id });
      this.resolveDelivery(message.id);
    }

    if (message?.type === 'SCATTER_RTC_POOL_SIGNAL') {
      const signal = message.signal;
      logPool('worker scatter received', {
        signalId: signal?.id,
        from: formatPeer(signal?.originAddress),
        to: formatPeer(signal?.targetAddress),
      });
      if (!this.remember(signal?.id)) {
        logPool('worker scatter ignored, already seen', { signalId: signal?.id });
        return;
      }
      this.scatter(signal);
    }
  }

  async handleBroadcastMessage(message) {
    if (!message || message.tabId === this.tabId) return;
    logPool(`broadcast received ${message.type}`, {
      signalId: message.signal?.id ?? message.id ?? null,
      fromTab: message.tabId,
    });

    if (message.type === 'RTC_POOL_PEER_CONNECTED') {
      const peerKey = normalizeAddress(message.peer?.playerAddress);
      if (!peerKey) return;
      logPool('peer discovered from table tab', {
        peer: formatPeer(message.peer?.playerAddress),
        ownerTabId: message.tabId,
        role: this.role,
      });
      this.knownPeers.set(peerKey, {
        ...message.peer,
        ownerTabId: message.tabId,
        seenAt: Date.now(),
      });
      if (this.role === 'lobby') {
        void this.ensureSilentConnection(message.peer);
      }
      return;
    }

    if (message.type === RTC_POOL_SIGNAL) {
      const signal = message.signal;
      if (!this.remember(signal?.id)) {
        logPool('broadcast signal ignored, already seen', { signalId: signal?.id });
        return;
      }
      await this.deliverOrScatter(signal);
      return;
    }

    if (message.type === RTC_POOL_GOSSIP_ANNOUNCE || message.type === RTC_POOL_GOSSIP_TRIGGER_OFFER) {
      await this.handleGossipControlMessage(message);
      return;
    }

    if (message.type === RTC_POOL_P2P_MST_FRAGMENT) {
      if (!this.rememberGossip(message)) return;
      await this.handleP2PMstFragment(message);
      return;
    }

    if (message.type === RTC_POOL_ROUTE_REQUEST) {
      await this.handleRouteRequest(message);
      return;
    }

    if (message.type === RTC_POOL_ROUTE_RESULT) {
      this.resolveRoute(message);
      return;
    }

    if (message.type === RTC_POOL_LOCAL_NOTICE) {
      this.dispatchLocalLobbyNotice(message.noticeType, message.detail);
      return;
    }

    if (message.type === 'RTC_POOL_SIGNAL_DELIVERED') {
      logPool('broadcast delivery ack received', { signalId: message.id });
      this.resolveDelivery(message.id);
      return;
    }

    if (message.type === 'SCATTER_RTC_POOL_SIGNAL') {
      const signal = message.signal;
      if (!this.remember(signal?.id)) {
        logPool('broadcast scatter ignored, already seen', { signalId: signal?.id });
        return;
      }
      this.scatter(signal);
    }
  }

  postRegisterSession(session) {
    const { playerAddress, lobbyId, tableId } = session.config ?? {};
    logPool('register session with worker', {
      player: formatPeer(playerAddress),
      lobbyId,
      tableId,
      endpoint: session.endpoint ?? ENDPOINT.TABLE,
    });
    this.postWorker({
      type: 'REGISTER_SESSION',
      session: { playerAddress, lobbyId, tableId, endpoint: session.endpoint ?? ENDPOINT.TABLE },
    });
  }

  postUnregisterSession(session) {
    const { playerAddress, lobbyId, tableId } = session.config ?? {};
    logPool('unregister session with worker', {
      player: formatPeer(playerAddress),
      lobbyId,
      tableId,
      endpoint: session.endpoint ?? ENDPOINT.TABLE,
    });
    this.postWorker({
      type: 'UNREGISTER_SESSION',
      session: { playerAddress, lobbyId, tableId, endpoint: session.endpoint ?? ENDPOINT.TABLE },
    });
  }

  registerSession(session) {
    const { playerAddress, lobbyId, tableId } = session.config ?? {};
    if (!playerAddress || !lobbyId || !tableId) return;
    const key = sessionKey({
      playerAddress,
      lobbyId,
      tableId,
      endpoint: session.endpoint ?? ENDPOINT.TABLE,
    });
    this.sessions.set(key, session);
    logPool('session registered', {
      key,
      player: formatPeer(playerAddress),
      lobbyId,
      tableId,
      endpoint: session.endpoint ?? ENDPOINT.TABLE,
    });
    this.postRegisterSession(session);
  }

  unregisterSession(session) {
    [...this.sessions.entries()].forEach(([key, value]) => {
      if (value === session) {
        this.sessions.delete(key);
        logPool('session unregistered', { key });
      }
    });
    this.postUnregisterSession(session);
  }

  registerLobbyPresence({ playerAddress, lobbyId }) {
    const key = lobbyPresenceKey(playerAddress, lobbyId);
    if (!normalizeAddress(playerAddress) || !lobbyId) return null;

    this.lobbyPresences.set(key, {
      playerAddress,
      lobbyId: String(lobbyId),
      seenAt: Date.now(),
    });
    logPool('lobby presence registered', {
      player: formatPeer(playerAddress),
      lobbyId,
    });
    return key;
  }

  unregisterLobbyPresence(keyOrPresence) {
    const key = typeof keyOrPresence === 'string'
      ? keyOrPresence
      : lobbyPresenceKey(keyOrPresence?.playerAddress, keyOrPresence?.lobbyId);
    if (!key || !this.lobbyPresences.has(key)) return;

    const presence = this.lobbyPresences.get(key);
    this.lobbyPresences.delete(key);
    logPool('lobby presence unregistered', {
      player: formatPeer(presence?.playerAddress),
      lobbyId: presence?.lobbyId,
    });
  }

  registerLink({ session, peerAddress, direction, channel, silent = false }) {
    const peerKey = normalizeAddress(peerAddress);
    if (!peerKey || !channel) return;

    const links = this.links.get(peerKey) ?? [];
    const replaceByDirection = silent || direction === ENDPOINT.LOBBY;
    const removedLinks = links.filter((link) => (
      replaceByDirection
        ? link.direction === direction
        : link.session === session && link.direction === direction
    ));
    removedLinks.forEach((link) => {
      if (link.channel === channel || link.channel?.readyState === 'closed') return;
      try {
        link.channel.close();
      } catch {
        // Best-effort cleanup only.
      }
    });
    const nextLinks = links.filter((link) => (
      replaceByDirection
        ? link.direction !== direction
        : link.session !== session || link.direction !== direction
    ));
    nextLinks.push({ session, peerAddress, direction, channel });
    this.links.set(peerKey, nextLinks);
    logPool('link registered', {
      peer: formatPeer(peerAddress),
      direction,
      silent,
      readyState: channel.readyState,
      linkCount: nextLinks.length,
    });

    const peer = session.config?.players?.find((candidate) => (
      normalizeAddress(candidate.playerAddress) === peerKey
    ));
    if (!silent) {
      this.postBroadcast({
        type: 'RTC_POOL_PEER_CONNECTED',
        peer: {
          playerAddress: peerAddress,
          announcePublicKey: peer?.annoncePublicKey ?? null,
          seatNo: peer?.seatNo ?? null,
          lobbyId: session.config?.lobbyId,
          tableId: session.config?.tableId,
          localSession: {
            playerAddress: session.config?.playerAddress,
            lobbyId: session.config?.lobbyId,
            tableId: session.config?.tableId,
            publicKey: session.config?.publicKey,
            privateKey: session.config?.privateKey,
          },
        },
      });
    }
  }

  async ensureSilentConnection(peer) {
    const localSession = peer?.localSession;
    if (
      !localSession?.playerAddress
      || !localSession?.publicKey
      || !localSession?.privateKey
      || !peer?.playerAddress
      || !peer?.announcePublicKey
    ) {
      logPool('silent connection skipped, missing peer/session details', {
        peer: formatPeer(peer?.playerAddress),
        hasLocalSession: Boolean(localSession),
        hasLocalPublicKey: Boolean(localSession?.publicKey),
        hasLocalPrivateKey: Boolean(localSession?.privateKey),
        hasPeerAnnounceKey: Boolean(peer?.announcePublicKey),
      });
      return null;
    }

    const endpointId = [
      normalizeAddress(localSession.playerAddress),
      normalizeAddress(peer.playerAddress),
      localSession.lobbyId,
    ].join(':');
    if (this.silentEndpoints.has(endpointId)) {
      logPool('silent connection already exists', {
        local: formatPeer(localSession.playerAddress),
        peer: formatPeer(peer.playerAddress),
      });
      return this.silentEndpoints.get(endpointId);
    }

    const endpoint = new LobbySilentRtcEndpoint({
      pool: this,
      localSession,
      peer,
    });
    this.silentEndpoints.set(endpoint.id, endpoint);
    this.enforceSilentConnectionLimit();
    this.sessions.set(sessionKey({
      playerAddress: localSession.playerAddress,
      lobbyId: localSession.lobbyId,
      tableId: localSession.tableId,
      endpoint: ENDPOINT.LOBBY,
    }), endpoint);
    this.postRegisterSession(endpoint);
    if (normalizeAddress(localSession.playerAddress) < normalizeAddress(peer.playerAddress)) {
      logPool('silent connection initiator selected', {
        local: formatPeer(localSession.playerAddress),
        peer: formatPeer(peer.playerAddress),
      });
      await endpoint.start();
    } else {
      logPool('silent connection waiting for peer offer', {
        local: formatPeer(localSession.playerAddress),
        peer: formatPeer(peer.playerAddress),
      });
    }
    return endpoint;
  }

  unregisterLink({ session, peerAddress, direction }) {
    const peerKey = normalizeAddress(peerAddress);
    if (!peerKey) return;

    const links = this.links.get(peerKey) ?? [];
    const nextLinks = links.filter((link) => (
      link.session !== session || link.direction !== direction
    ));
    if (nextLinks.length > 0) {
      this.links.set(peerKey, nextLinks);
    } else {
      this.links.delete(peerKey);
    }
    logPool('link unregistered', {
      peer: formatPeer(peerAddress),
      direction,
      remaining: nextLinks.length,
    });
  }

  hasOpenLobbyMeshLink() {
    return [...this.links.values()].some((links) => (
      links.some((link) => (
        link.direction === ENDPOINT.LOBBY
        && link.channel?.readyState === 'open'
      ))
    ));
  }

  remember(messageId) {
    if (!messageId) return false;
    if (this.seenMessages.has(messageId)) return false;

    this.seenMessages.add(messageId);
    if (this.seenMessages.size > MAX_SEEN_MESSAGES) {
      const [oldest] = this.seenMessages;
      this.seenMessages.delete(oldest);
    }
    return true;
  }

  rememberGossip(message) {
    const id = message?.id;
    if (!id) return false;

    const ttl = Number(message.ttl ?? 0);
    const previousTtl = this.seenGossipMessages.get(id);
    if (previousTtl !== undefined && previousTtl >= ttl) return false;

    this.seenGossipMessages.set(id, ttl);
    if (this.seenGossipMessages.size > MAX_SEEN_MESSAGES) {
      const [oldest] = this.seenGossipMessages.keys();
      this.seenGossipMessages.delete(oldest);
    }
    return true;
  }

  p2pMstGraphKey({ playerAddress, lobbyId, tableId }) {
    return [
      normalizeAddress(playerAddress),
      String(lobbyId ?? ''),
      String(tableId ?? ''),
    ].join(':');
  }

  p2pMstGraphFor({ playerAddress, lobbyId, tableId }) {
    const key = this.p2pMstGraphKey({ playerAddress, lobbyId, tableId });
    if (!this.p2pMstGraphs.has(key)) {
      this.p2pMstGraphs.set(key, new RouteIntentGraph({
        nodeId: playerAddress,
        edgeTtlMs: DEFAULT_P2P_MST_EDGE_TTL_MS,
      }));
    }
    return this.p2pMstGraphs.get(key);
  }

  localTableSessionsFor(lobbyId, tableId) {
    return [...this.sessions.values()].filter((session) => (
      (session.endpoint ?? ENDPOINT.TABLE) === ENDPOINT.TABLE
      && String(session.config?.lobbyId) === String(lobbyId)
      && String(session.config?.tableId) === String(tableId)
    ));
  }

  waitForDelivery(messageId, timeoutMs = DELIVERY_TIMEOUT_MS) {
    if (!messageId) return Promise.resolve(false);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingDeliveries.delete(messageId);
        logPool('delivery timeout', { signalId: messageId, timeoutMs });
        resolve(false);
      }, timeoutMs);
      this.pendingDeliveries.set(messageId, (delivered) => {
        clearTimeout(timeout);
        logPool('delivery resolved', { signalId: messageId, delivered });
        resolve(delivered);
      });
    });
  }

  waitForRoute(requestId, timeoutMs = LOBBY_ROUTE_TIMEOUT_MS) {
    if (!requestId) return Promise.resolve({ found: false, reason: 'missing_request_id' });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRoutes.delete(requestId);
        logPool('lobby route timeout', { requestId, timeoutMs });
        resolve({ found: false, reason: 'timeout' });
      }, timeoutMs);
      this.pendingRoutes.set(requestId, (result) => {
        clearTimeout(timeout);
        logPool('lobby route resolved', { requestId, ...result });
        resolve(result);
      });
    });
  }

  resolveDelivery(messageId) {
    const resolve = this.pendingDeliveries.get(messageId);
    if (resolve) {
      this.pendingDeliveries.delete(messageId);
      resolve(true);
    }
  }

  resolveRoute(message) {
    if (message.targetTabId !== this.tabId) return;
    const resolve = this.pendingRoutes.get(message.requestId);
    if (!resolve) return;

    this.pendingRoutes.delete(message.requestId);
    resolve({
      found: message.found === true,
      reason: message.reason ?? null,
      signalId: message.signalId ?? null,
    });
  }

  createRouteResultMessage(signal, found, reason) {
    if (!signal?.routeRequestId || !signal?.routeRequesterTabId) return null;

    return {
      type: RTC_POOL_ROUTE_RESULT,
      id: makeMessageId('route-result', signal.originAddress, signal.lobbyId, signal.tableId),
      requestId: signal.routeRequestId,
      requesterTabId: signal.routeRequesterTabId,
      targetTabId: signal.routeRequesterTabId,
      signalId: signal.id,
      found,
      reason,
      originAddress: signal.targetAddress,
      targetAddress: signal.originAddress,
      lobbyId: signal.lobbyId,
      tableId: signal.tableId,
      ttl: DEFAULT_TTL,
      visited: [normalizeAddress(signal.targetAddress)],
    };
  }

  sendRouteResultForSignal(signal, found, reason) {
    const result = this.createRouteResultMessage(signal, found, reason);
    if (!result) return false;

    logPool(`route result relay ${found ? 'found' : 'not found'}`, {
      requestId: result.requestId,
      signalId: result.signalId,
      reason,
      to: formatPeer(result.targetAddress),
    });
    const sentToLinks = this.scatter(result);
    const sentToBroadcast = this.postBroadcast(result);
    const sentToWorker = this.postWorker(result);
    return sentToLinks || sentToBroadcast || sentToWorker;
  }

  announceDelivery(messageId) {
    logPool('announce delivery', { signalId: messageId });
    this.resolveDelivery(messageId);
    this.postBroadcast({
      type: 'RTC_POOL_SIGNAL_DELIVERED',
      id: messageId,
    });
    this.postWorker({
      type: 'RTC_POOL_SIGNAL_DELIVERED',
      id: messageId,
    });
  }

  hasLocalAddress(playerAddress, lobbyId, tableId) {
    const playerKey = normalizeAddress(playerAddress);
    if (this.lobbyPresences.has(lobbyPresenceKey(playerAddress, lobbyId))) {
      return true;
    }
    return [...this.sessions.values()].some((session) => (
      normalizeAddress(session.config?.playerAddress ?? session.localSession?.playerAddress) === playerKey
      && String(session.config?.lobbyId ?? session.localSession?.lobbyId) === String(lobbyId)
      && (
        String(session.config?.tableId ?? session.localSession?.tableId) === String(tableId)
        || (session.endpoint ?? ENDPOINT.TABLE) === ENDPOINT.LOBBY
      )
    ));
  }

  fanoutLocalEndpoint(message) {
    logPool('fanout to local tabs', {
      signalId: message.id,
      target: formatPeer(message.targetAddress),
      endpoint: message.targetEndpoint,
    });
    const sentToBroadcast = this.postBroadcast({
      type: RTC_POOL_SIGNAL,
      signal: message,
    });
    const sentToWorker = this.postWorker({
      type: RTC_POOL_SIGNAL,
      signal: message,
    });
    return sentToBroadcast || sentToWorker;
  }

  emitLocalLobbyNotice(type, detail) {
    this.dispatchLocalLobbyNotice(type, detail);
    this.postBroadcast({
      type: RTC_POOL_LOCAL_NOTICE,
      noticeType: type,
      detail,
    });
    this.postWorker({
      type: RTC_POOL_LOCAL_NOTICE,
      noticeType: type,
      detail,
    });
  }

  dispatchLocalLobbyNotice(type, detail) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }

  createGossipControlMessage({
    type,
    originAddress,
    targetAddress,
    lobbyId,
    tableId,
    triggerTargetAddress = null,
  }) {
    return {
      type,
      id: makeMessageId(type, targetAddress, lobbyId, tableId),
      originAddress,
      targetAddress,
      triggerTargetAddress,
      lobbyId: String(lobbyId),
      tableId: String(tableId),
      ttl: DEFAULT_TTL,
      visited: [normalizeAddress(originAddress)],
    };
  }

  sendGossipAnnounce({
    originAddress,
    targetAddress,
    lobbyId,
    tableId,
  }) {
    return this.sendP2PMstAnnounce({
      originAddress,
      targetAddress,
      lobbyId,
      tableId,
    });
  }

  sendP2PMstAnnounce({
    originAddress,
    targetAddress,
    lobbyId,
    tableId,
  }) {
    const flowId = makeMessageId('p2p-mst', targetAddress, lobbyId, tableId);
    const graph = this.p2pMstGraphFor({
      playerAddress: originAddress,
      lobbyId,
      tableId,
    });
    graph.addLocalIntent({
      flowId,
      from: originAddress,
      to: targetAddress,
      createdAt: Date.now(),
    });

    logPool('p2p mst announce start', {
      flowId,
      from: formatPeer(originAddress),
      to: formatPeer(targetAddress),
      lobbyId,
      tableId,
    });

    this.notifyLocalP2PMstRoutes({ graph, lobbyId, tableId });
    return this.forwardP2PMstFragments({
      graph,
      lobbyId,
      tableId,
    });
  }

  sendGossipTriggerOffer({
    originAddress,
    targetAddress,
    triggerTargetAddress,
    lobbyId,
    tableId,
  }) {
    const message = this.createGossipControlMessage({
      type: RTC_POOL_GOSSIP_TRIGGER_OFFER,
      originAddress,
      targetAddress,
      triggerTargetAddress,
      lobbyId,
      tableId,
    });

    logPool('gossip trigger-offer start', {
      messageId: message.id,
      from: formatPeer(originAddress),
      to: formatPeer(targetAddress),
      triggerTarget: formatPeer(triggerTargetAddress),
      lobbyId,
      tableId,
    });

    return this.forwardGossipControl(message);
  }

  forwardP2PMstFragments({
    graph,
    lobbyId,
    tableId,
    fromPeerAddress = null,
  }) {
    let sent = false;
    const sendFragment = (fragment) => {
      const message = {
        ...fragment,
        id: makeMessageId('p2p-mst-fragment', fragment.toNode, lobbyId, tableId),
        lobbyId: String(lobbyId),
        tableId: String(tableId),
        ttl: DEFAULT_TTL,
        visited: [graph.nodeId],
      };

      sent = this.scatterP2PMstFragment(message, { excludePeerAddress: fromPeerAddress }) || sent;
      sent = this.postBroadcast(message) || sent;
      sent = this.postWorker(message) || sent;
    };

    this.links.forEach((links, peerKey) => {
      if (peerKey === normalizeAddress(fromPeerAddress)) return;
      if (!links.some((link) => link.channel?.readyState === 'open')) return;

      const fragment = graph.buildFragmentForNeighbor(peerKey);
      if (fragment) sendFragment(fragment);
    });

    return sent;
  }

  scatterP2PMstFragment(message, { excludePeerAddress = null } = {}) {
    const excludePeerKey = normalizeAddress(excludePeerAddress);
    const visited = new Set((message.visited ?? []).map(normalizeAddress));
    let sent = false;

    this.links.forEach((links, peerKey) => {
      if (peerKey === excludePeerKey || visited.has(peerKey)) return;
      links.forEach((link) => {
        if (link.direction === ENDPOINT.LOBBY) {
          this.touchSilentEndpoint(link.session);
        }
        sent = this.sendToLink(link, message) || sent;
      });
    });

    logPool(`p2p mst scatter ${sent ? 'sent' : 'not sent'}`, {
      fragmentId: message.id,
      fromNode: formatPeer(message.fromNode),
      toNode: formatPeer(message.toNode),
      exclude: formatPeer(excludePeerAddress),
      ttl: message.ttl,
      edges: message.edges?.length ?? 0,
      linkPeers: [...this.links.keys()].map(formatPeer),
    });
    return sent;
  }

  async handleP2PMstFragment(message, { receiverSession = null, fromPeerAddress = null } = {}) {
    const sessions = receiverSession
      ? [receiverSession]
      : this.localTableSessionsFor(message.lobbyId, message.tableId);
    if (sessions.length === 0) return false;

    let changed = false;
    for (const session of sessions) {
      const playerAddress = session.config?.playerAddress;
      if (!playerAddress) continue;
      if (message.toNode && normalizeAddress(message.toNode) !== normalizeAddress(playerAddress)) {
        continue;
      }

      const graph = this.p2pMstGraphFor({
        playerAddress,
        lobbyId: message.lobbyId,
        tableId: message.tableId,
      });
      const graphChanged = graph.mergeFragment({
        fragment: message,
        fromNeighbor: fromPeerAddress ?? message.fromNode,
      });
      if (!graphChanged) continue;

      changed = true;
      this.notifyLocalP2PMstRoutes({ graph, lobbyId: message.lobbyId, tableId: message.tableId });
      this.forwardP2PMstFragments({
        graph,
        lobbyId: message.lobbyId,
        tableId: message.tableId,
        fromPeerAddress: fromPeerAddress ?? message.fromNode,
      });
    }

    return changed;
  }

  notifyLocalP2PMstRoutes({ graph, lobbyId, tableId }) {
    for (const route of graph.selectedRoutes()) {
      const session = this.getLocalTableSession(route.to, lobbyId, tableId);
      if (!session?.hasPendingP2PIntent?.(route.from)) continue;

      const notificationKey = [
        String(lobbyId),
        String(tableId),
        route.to,
        route.from,
        route.flowId,
      ].join(':');
      if (this.notifiedP2PMstRoutes.has(notificationKey)) continue;

      this.notifiedP2PMstRoutes.add(notificationKey);
      if (this.notifiedP2PMstRoutes.size > MAX_SEEN_MESSAGES) {
        const [oldest] = this.notifiedP2PMstRoutes;
        this.notifiedP2PMstRoutes.delete(oldest);
      }

      logPool('p2p mst route available', {
        flowId: route.flowId,
        local: formatPeer(route.to),
        peer: formatPeer(route.from),
        distance: route.distance,
        via: formatPeer(route.viaNeighbor),
      });
      void Promise.resolve(session.handleP2PMstRouteIntent?.(route)).catch((error) => {
        logPool('p2p mst route handler failed', error);
      });
    }
  }

  hasP2PMstRouteBetween({ leftAddress, rightAddress, lobbyId, tableId }) {
    const left = normalizeAddress(leftAddress);
    const right = normalizeAddress(rightAddress);
    return this.localTableSessionsFor(lobbyId, tableId).some((session) => {
      const graph = this.p2pMstGraphFor({
        playerAddress: session.config?.playerAddress,
        lobbyId,
        tableId,
      });
      return graph.selectedRoutes().some((route) => (
        route.distance > 0
        && (
          (route.from === left && route.to === right)
          || (route.from === right && route.to === left)
        )
      ));
    });
  }

  getLocalTableSession(playerAddress, lobbyId, tableId) {
    return this.sessions.get(sessionKey({
      playerAddress,
      lobbyId,
      tableId,
      endpoint: ENDPOINT.TABLE,
    }));
  }

  async deliverGossipControl(message) {
    const targetSession = this.getLocalTableSession(
      message.targetAddress,
      message.lobbyId,
      message.tableId,
    );
    if (!targetSession) return false;

    logPool('gossip control reached target', {
      messageId: message.id,
      type: message.type,
      target: formatPeer(message.targetAddress),
      origin: formatPeer(message.originAddress),
    });

    if (message.type === RTC_POOL_GOSSIP_ANNOUNCE) {
      await targetSession.handleGossipAnnounce?.(message);
      return true;
    }

    if (message.type === RTC_POOL_GOSSIP_TRIGGER_OFFER) {
      await targetSession.handleGossipTriggerOffer?.(message);
      return true;
    }

    return false;
  }

  forwardGossipControl(message, { fromPeerAddress = null } = {}) {
    if (!this.rememberGossip(message)) {
      logPool('gossip control ignored, already seen with equal/better ttl', {
        messageId: message?.id,
        type: message?.type,
        ttl: message?.ttl,
      });
      return false;
    }

    const localKeys = [...this.sessions.values()]
      .map((session) => normalizeAddress(session.config?.playerAddress ?? session.localSession?.playerAddress))
      .filter(Boolean);
    const visited = [...new Set([...(message.visited ?? []), ...localKeys].filter(Boolean))];

    if (this.getLocalTableSession(message.targetAddress, message.lobbyId, message.tableId)) {
      void Promise.resolve(this.deliverGossipControl(message)).catch((error) => {
        logPool('gossip local delivery failed', error);
      });
      return true;
    }

    const ttl = Number(message.ttl ?? 0);
    if (ttl <= 0) return true;

    const nextMessage = {
      ...message,
      ttl: ttl - 1,
      visited,
    };

    const sentToLinks = this.scatter(nextMessage, { excludePeerAddress: fromPeerAddress });
    const sentToBroadcast = this.postBroadcast(nextMessage);
    const sentToWorker = this.postWorker(nextMessage);

    logPool('gossip control forwarded', {
      messageId: message.id,
      type: message.type,
      target: formatPeer(message.targetAddress),
      sentToLinks,
      sentToBroadcast,
      sentToWorker,
      ttl: nextMessage.ttl,
    });

    return sentToLinks || sentToBroadcast || sentToWorker;
  }

  async handleGossipControlMessage(message, { fromPeerAddress = null } = {}) {
    this.forwardGossipControl(message, { fromPeerAddress });
  }

  async handleRouteRequest(message) {
    if (this.role !== 'lobby') return;
    if (!message?.requestId || !message?.signal || !message?.requesterTabId) return;
    if (this.seenRouteRequests.has(message.requestId)) {
      logPool('lobby route request ignored, already seen', { requestId: message.requestId });
      return;
    }
    this.seenRouteRequests.add(message.requestId);
    if (this.seenRouteRequests.size > MAX_SEEN_MESSAGES) {
      const [oldest] = this.seenRouteRequests;
      this.seenRouteRequests.delete(oldest);
    }

    const signal = message.signal;
    logPool('lobby route handling', {
      requestId: message.requestId,
      signalId: signal.id,
      to: formatPeer(signal.targetAddress),
      linkPeers: [...this.links.keys()].map(formatPeer),
    });

    this.remember(signal.id);
    if (this.hasLocalAddress(signal.targetAddress, signal.lobbyId, signal.tableId)) {
      logPool('lobby route target is local', {
        requestId: message.requestId,
        signalId: signal.id,
        target: formatPeer(signal.targetAddress),
      });
      await this.deliverOrScatter(signal);
      return;
    }

    const sent = this.scatter(signal);
    if (sent) {
      logPool('lobby route sent, waiting for remote endpoint result', {
        requestId: message.requestId,
        signalId: signal.id,
      });
      return;
    }

    const result = {
      type: RTC_POOL_ROUTE_RESULT,
      requestId: message.requestId,
      requesterTabId: message.requesterTabId,
      targetTabId: message.requesterTabId,
      signalId: signal.id,
      found: false,
      reason: 'no_silent_route',
    };
    logPool('lobby route not found', {
      requestId: message.requestId,
      signalId: signal.id,
      reason: result.reason,
    });
    this.postBroadcast(result);
    this.postWorker(result);
  }

  sendToLink(link, message) {
    if (link.channel?.readyState !== 'open') {
      logPool('link send skipped, channel not open', {
        peer: formatPeer(link.peerAddress),
        direction: link.direction,
        readyState: link.channel?.readyState,
        signalId: message.id,
      });
      return false;
    }
    logPool('link send', {
      peer: formatPeer(link.peerAddress),
      direction: link.direction,
      signalId: message.id,
      target: formatPeer(message.targetAddress),
    });
    link.channel.send(JSON.stringify(message));
    return true;
  }

  scatter(message, { excludePeerAddress = null } = {}) {
    const visited = new Set((message.visited ?? []).map(normalizeAddress));
    const excludePeerKey = normalizeAddress(excludePeerAddress);
    let sent = false;

    this.links.forEach((links, peerKey) => {
      if (peerKey === excludePeerKey || visited.has(peerKey)) return;
      links.forEach((link) => {
        if (link.direction === ENDPOINT.LOBBY) {
          this.touchSilentEndpoint(link.session);
        }
        sent = this.sendToLink(link, message) || sent;
      });
    });

    logPool(`scatter ${sent ? 'sent' : 'not sent'}`, {
      signalId: message.id,
      from: formatPeer(message.originAddress),
      to: formatPeer(message.targetAddress),
      exclude: formatPeer(excludePeerAddress),
      visited: message.visited,
      ttl: message.ttl,
      linkPeers: [...this.links.keys()].map(formatPeer),
    });
    return sent;
  }

  createSignalMessage({
    originAddress,
    originEndpoint = ENDPOINT.TABLE,
    targetAddress,
    targetEndpoint = ENDPOINT.TABLE,
    lobbyId,
    tableId,
    encryptedData,
  }) {
    return {
      type: RTC_POOL_SIGNAL,
      id: makeMessageId(originAddress, targetAddress, lobbyId, tableId),
      originAddress,
      originEndpoint,
      targetAddress,
      targetEndpoint,
      lobbyId: String(lobbyId),
      tableId: String(tableId),
      encryptedData,
      routeRequestId: null,
      routeRequesterTabId: null,
      ttl: DEFAULT_TTL,
      visited: [normalizeAddress(originAddress)],
    };
  }

  requestLobbyRoute(args) {
    return this.enqueueConnectionRequest(() => this.requestLobbyRouteNow(args));
  }

  async requestLobbyRouteNow({
    originAddress,
    originEndpoint = ENDPOINT.TABLE,
    targetAddress,
    targetEndpoint = ENDPOINT.TABLE,
    lobbyId,
    tableId,
    encryptedData,
    routeTimeoutMs = LOBBY_ROUTE_TIMEOUT_MS,
  }) {
    const signal = this.createSignalMessage({
      originAddress,
      originEndpoint,
      targetAddress,
      targetEndpoint,
      lobbyId,
      tableId,
      encryptedData,
    });
    const requestId = makeMessageId('route', targetAddress, lobbyId, tableId);
    signal.routeRequestId = requestId;
    signal.routeRequesterTabId = this.tabId;

    logPool('lobby route request', {
      requestId,
      signalId: signal.id,
      from: formatPeer(originAddress),
      to: formatPeer(targetAddress),
      endpoint: targetEndpoint,
    });

    const routePromise = this.waitForRoute(requestId, routeTimeoutMs);
    const sentToBroadcast = this.postBroadcast({
      type: RTC_POOL_ROUTE_REQUEST,
      requestId,
      requesterTabId: this.tabId,
      signal,
    });
    const sentToWorker = this.postWorker({
      type: RTC_POOL_ROUTE_REQUEST,
      requestId,
      requesterTabId: this.tabId,
      signal,
    });
    if (!sentToBroadcast && !sentToWorker) {
      this.pendingRoutes.delete(requestId);
      return { found: false, reason: 'no_local_lobby_channel', signalId: signal.id };
    }

    return routePromise;
  }

  async sendEncryptedSignal({
    originAddress,
    originEndpoint = ENDPOINT.TABLE,
    targetAddress,
    targetEndpoint = ENDPOINT.TABLE,
    lobbyId,
    tableId,
    encryptedData,
    deliveryTimeoutMs = DELIVERY_TIMEOUT_MS,
  }) {
    const message = this.createSignalMessage({
      originAddress,
      originEndpoint,
      targetAddress,
      targetEndpoint,
      lobbyId,
      tableId,
      encryptedData,
    });

    this.remember(message.id);
    logPool('send encrypted signal', {
      signalId: message.id,
      from: formatPeer(originAddress),
      fromEndpoint: originEndpoint,
      to: formatPeer(targetAddress),
      toEndpoint: targetEndpoint,
      lobbyId,
      tableId,
    });
    const sentLocally = this.scatter(message);
    const sentToBroadcast = this.postBroadcast({
      type: RTC_POOL_SIGNAL,
      signal: message,
    });
    const sentToWorker = this.postWorker({
      type: RTC_POOL_SIGNAL,
      signal: message,
    });
    logPool('send encrypted signal routed', {
      signalId: message.id,
      sentLocally,
      sentToBroadcast,
      sentToWorker,
    });
    if (!sentLocally && !sentToBroadcast && !sentToWorker) return false;
    const delivered = await this.waitForDelivery(message.id, deliveryTimeoutMs);
    logPool(`send encrypted signal ${delivered ? 'delivered' : 'undelivered'}`, {
      signalId: message.id,
      to: formatPeer(targetAddress),
    });
    return delivered;
  }

  async deliverOrScatter(message, { fromPeerAddress = null } = {}) {
    const localAddress = message.targetAddress;
    const endpoint = message.targetEndpoint ?? ENDPOINT.TABLE;
    const targetSession = endpoint === ENDPOINT.LOBBY
      ? [...this.silentEndpoints.values()].find((candidate) => (
        normalizeAddress(candidate.localSession.playerAddress) === normalizeAddress(localAddress)
        && normalizeAddress(candidate.peer.playerAddress) === normalizeAddress(message.originAddress)
        && String(candidate.localSession.lobbyId) === String(message.lobbyId)
      ))
      : this.sessions.get(sessionKey({
        playerAddress: localAddress,
        lobbyId: message.lobbyId,
        tableId: message.tableId,
        endpoint,
    }));

    if (targetSession) {
      if (endpoint === ENDPOINT.LOBBY) {
        this.touchSilentEndpoint(targetSession);
      }
      logPool('deliver to local session', {
        signalId: message.id,
        endpoint,
        target: formatPeer(localAddress),
        from: formatPeer(message.originAddress),
      });
      if (endpoint === ENDPOINT.TABLE) {
        this.sendRouteResultForSignal(message, true, 'table_endpoint_ready');
      }
      this.announceDelivery(message.id);
      Promise.resolve(targetSession.handleRelayEncryptedSignal(message)).catch((error) => {
        logPool('delivered signal handling failed', error);
      });
      return true;
    }

    if (Number(message.ttl ?? 0) <= 0) {
      logPool('delivery skipped, ttl exhausted', {
        signalId: message.id,
        target: formatPeer(localAddress),
      });
      return true;
    }
    if (this.hasLocalAddress(localAddress, message.lobbyId, message.tableId)) {
      logPool('target player is local but endpoint is in another tab', {
        signalId: message.id,
        target: formatPeer(localAddress),
        endpoint,
      });
      if (endpoint === ENDPOINT.TABLE) {
        const delivery = this.waitForDelivery(message.id, DELIVERY_TIMEOUT_MS);
        this.fanoutLocalEndpoint(message);
        void delivery.then((delivered) => {
          if (delivered) {
            this.sendRouteResultForSignal(message, true, 'table_endpoint_ready');
            return;
          }

          this.emitLocalLobbyNotice('private-poker:peer-waiting-for-table', {
            from: message.originAddress,
            to: message.targetAddress,
            lobbyId: message.lobbyId,
            tableId: message.tableId,
          });
          this.sendRouteResultForSignal(message, false, 'peer_table_not_open');
        });
        return true;
      }
      this.fanoutLocalEndpoint(message);
      return true;
    }
    logPool('no local target, scattering', {
      signalId: message.id,
      target: formatPeer(localAddress),
      endpoint,
      fromPeer: formatPeer(fromPeerAddress),
    });
    this.scatter(message, { excludePeerAddress: fromPeerAddress });
    return true;
  }

  async handleMessage(receiverSession, fromPeerAddress, message) {
    if (message?.type === RTC_POOL_P2P_MST_FRAGMENT) {
      logPool('data-channel p2p mst fragment received', {
        fragmentId: message.id,
        receiver: formatPeer(receiverSession.config?.playerAddress),
        fromPeer: formatPeer(fromPeerAddress),
        fromNode: formatPeer(message.fromNode),
        toNode: formatPeer(message.toNode),
        edges: message.edges?.length ?? 0,
        ttl: message.ttl,
      });
      if (!this.rememberGossip(message)) return true;
      await this.handleP2PMstFragment(message, { receiverSession, fromPeerAddress });
      return true;
    }

    if (message?.type === RTC_POOL_GOSSIP_ANNOUNCE || message?.type === RTC_POOL_GOSSIP_TRIGGER_OFFER) {
      logPool('data-channel gossip control received', {
        messageId: message.id,
        type: message.type,
        receiver: formatPeer(receiverSession.config?.playerAddress),
        fromPeer: formatPeer(fromPeerAddress),
        target: formatPeer(message.targetAddress),
        ttl: message.ttl,
      });
      await this.handleGossipControlMessage(message, { fromPeerAddress });
      return true;
    }

    if (message?.type === RTC_POOL_ROUTE_RESULT) {
      logPool('data-channel route result received', {
        requestId: message.requestId,
        signalId: message.signalId,
        reason: message.reason,
        target: formatPeer(message.targetAddress),
      });
      if (!this.remember(message.id)) {
        logPool('data-channel route result ignored, already seen', { signalId: message.id });
        return true;
      }

      const localAddress = receiverSession.config?.playerAddress;
      const localKey = normalizeAddress(localAddress);
      const targetKey = normalizeAddress(message.targetAddress);
      if (targetKey === localKey) {
        this.postBroadcast(message);
        this.postWorker(message);
        this.resolveRoute(message);
        return true;
      }

      if (Number(message.ttl ?? 0) <= 0) return true;
      this.scatter({
        ...message,
        ttl: Number(message.ttl ?? 0) - 1,
        visited: [...new Set([...(message.visited ?? []), localKey].filter(Boolean))],
      }, { excludePeerAddress: fromPeerAddress });
      return true;
    }

    if (message?.type !== RTC_POOL_SIGNAL) return true;
    logPool('data-channel pool message received', {
      signalId: message.id,
      receiver: formatPeer(receiverSession.config?.playerAddress),
      fromPeer: formatPeer(fromPeerAddress),
      target: formatPeer(message.targetAddress),
      ttl: message.ttl,
    });
    if (!this.remember(message.id)) {
      logPool('data-channel pool message ignored, already seen', { signalId: message.id });
      return true;
    }

    const localAddress = receiverSession.config?.playerAddress;
    const localKey = normalizeAddress(localAddress);
    const targetKey = normalizeAddress(message.targetAddress);
    const nextMessage = {
      ...message,
      ttl: Number(message.ttl ?? 0) - 1,
      visited: [...new Set([...(message.visited ?? []), localKey].filter(Boolean))],
    };

    if (targetKey === localKey) {
      logPool('data-channel pool message reached target', {
        signalId: message.id,
        target: formatPeer(message.targetAddress),
      });
      return this.deliverOrScatter(message);
    }

    if (nextMessage.ttl <= 0) {
      logPool('data-channel pool message ttl exhausted', { signalId: message.id });
      return true;
    }
    logPool('data-channel pool message forwarding', {
      signalId: nextMessage.id,
      receiver: formatPeer(localAddress),
      target: formatPeer(nextMessage.targetAddress),
      ttl: nextMessage.ttl,
    });
    this.scatter(nextMessage, { excludePeerAddress: fromPeerAddress });
    this.postBroadcast({
      type: RTC_POOL_SIGNAL,
      signal: nextMessage,
    });
    this.postWorker({
      type: RTC_POOL_SIGNAL,
      signal: nextMessage,
    });
    return true;
  }

  async handleSilentDataMessage(receiverSession, fromPeerAddress, rawData) {
    try {
      const message = JSON.parse(rawData);
      if (
        message?.type === RTC_POOL_SIGNAL
        || message?.type === RTC_POOL_P2P_MST_FRAGMENT
        || message?.type === RTC_POOL_GOSSIP_ANNOUNCE
        || message?.type === RTC_POOL_GOSSIP_TRIGGER_OFFER
      ) {
        logPool('silent data message parsed', {
          signalId: message.id,
          type: message.type,
          fromPeer: formatPeer(fromPeerAddress),
          target: formatPeer(message.targetAddress),
        });
        await this.handleMessage(receiverSession, fromPeerAddress, message);
      } else if (message?.type === RTC_POOL_ROUTE_RESULT) {
        logPool('silent route result parsed', {
          requestId: message.requestId,
          signalId: message.signalId,
          fromPeer: formatPeer(fromPeerAddress),
          target: formatPeer(message.targetAddress),
          reason: message.reason,
        });
        await this.handleMessage(receiverSession, fromPeerAddress, message);
      }
    } catch (error) {
      logPool('silent data message ignored', error);
    }
  }
}

export const rtcSessionPool = new RtcSessionPool();
export {
  RTC_POOL_SIGNAL,
  RTC_POOL_GOSSIP_ANNOUNCE,
  RTC_POOL_GOSSIP_TRIGGER_OFFER,
  RTC_POOL_P2P_MST_FRAGMENT,
  ENDPOINT,
};
