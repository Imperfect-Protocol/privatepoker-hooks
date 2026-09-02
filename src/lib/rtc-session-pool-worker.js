const ports = new Map();
const sessions = new Map();
let nextPortId = 1;

const RTC_POOL_GOSSIP_ANNOUNCE = 'RTC_POOL_GOSSIP_ANNOUNCE';
const RTC_POOL_GOSSIP_TRIGGER_OFFER = 'RTC_POOL_GOSSIP_TRIGGER_OFFER';
const RTC_POOL_P2P_MST_FRAGMENT = 'p2p-mst-fragment';
const STALE_PORT_MS = 15000;
const PRUNE_INTERVAL_MS = 5000;

function formatPeer(value) {
  const text = value ? String(value) : '';
  if (!text) return 'unknown';
  return text.length <= 12 ? text : `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function logWorker(message, details = undefined) {
  if (details === undefined) {
    console.log(`[RTC pool worker] ${message}`);
    return;
  }
  console.log(`[RTC pool worker] ${message}`, details);
}

function sessionKey({ playerAddress, lobbyId, tableId, endpoint = 'table' }) {
  const scopedTableId = endpoint === 'lobby' ? 'lobby' : String(tableId ?? '');
  return [
    String(endpoint),
    String(playerAddress ?? '').toLowerCase(),
    String(lobbyId ?? ''),
    scopedTableId,
  ].join(':');
}

function addSession(key, portId) {
  const portIds = sessions.get(key) ?? new Set();
  portIds.add(portId);
  sessions.set(key, portIds);
}

function removeSession(key, portId = null) {
  if (portId == null) {
    sessions.delete(key);
    return;
  }

  const portIds = sessions.get(key);
  if (!portIds) return;
  portIds.delete(portId);
  if (portIds.size === 0) {
    sessions.delete(key);
  }
}

function unregisterPort(portId, reason = 'unknown') {
  if (!ports.has(portId)) return;

  ports.delete(portId);
  logWorker('port unregistered', { portId, reason });
  sessions.forEach((portIds, key) => {
    if (!portIds.has(portId)) return;
    portIds.delete(portId);
    logWorker('session removed for port', { key, portId });
    if (portIds.size === 0) {
      sessions.delete(key);
    }
  });
}

function touchPort(portId) {
  const entry = ports.get(portId);
  if (entry) {
    entry.lastSeen = Date.now();
  }
}

function post(portId, message) {
  const entry = ports.get(portId);
  if (!entry) return false;

  try {
    logWorker(`post ${message.type}`, {
      portId,
      signalId: message.signal?.id ?? message.id ?? null,
      target: formatPeer(message.signal?.targetAddress),
    });
    entry.port.postMessage(message);
    return true;
  } catch (error) {
    logWorker('post failed, unregistering port', { portId, error: error?.message });
    unregisterPort(portId, 'post failed');
    return false;
  }
}

function broadcast(message, exceptPortId = null) {
  pruneStalePorts();
  let sent = false;
  [...ports.keys()].forEach((portId) => {
    if (portId === exceptPortId) return;
    logWorker(`broadcast ${message.type}`, {
      portId,
      signalId: message.signal?.id ?? message.id ?? null,
      target: formatPeer(message.signal?.targetAddress),
    });
    sent = post(portId, message) || sent;
  });
  return sent;
}

function getTargetPortIds(key, exceptPortId) {
  pruneStalePorts();
  return [...(sessions.get(key) ?? [])]
    .filter((portId) => portId !== exceptPortId && ports.has(portId))
    .sort((a, b) => (ports.get(b)?.lastSeen ?? 0) - (ports.get(a)?.lastSeen ?? 0));
}

function postFirstLiveTarget(portIds, message) {
  for (const portId of portIds) {
    if (post(portId, message)) {
      return portId;
    }
  }
  return null;
}

function pruneStalePorts() {
  const now = Date.now();
  [...ports.entries()].forEach(([portId, entry]) => {
    if (now - entry.lastSeen > STALE_PORT_MS) {
      unregisterPort(portId, 'heartbeat stale');
    }
  });
}

self.onconnect = (event) => {
  const [port] = event.ports;
  const portId = nextPortId;
  nextPortId += 1;
  ports.set(portId, { port, lastSeen: Date.now() });
  logWorker('port connected', { portId });

  port.onmessage = (messageEvent) => {
    const message = messageEvent.data;
    touchPort(portId);

    if (!['HEARTBEAT', 'DISCONNECT'].includes(message?.type)) {
      logWorker(`message received ${message?.type ?? 'unknown'}`, { portId });
    }

    if (message?.type === 'HEARTBEAT') {
      return;
    }

    if (message?.type === 'DISCONNECT') {
      unregisterPort(portId, 'disconnect');
      return;
    }

    if (message?.type === 'REGISTER_SESSION') {
      const key = sessionKey(message.session);
      addSession(key, portId);
      logWorker('session registered', { portId, key });
      return;
    }

    if (message?.type === 'UNREGISTER_SESSION') {
      const key = sessionKey(message.session);
      removeSession(key, portId);
      logWorker('session unregistered', { portId, key });
      return;
    }

    if (message?.type === 'RTC_POOL_SIGNAL') {
      const targetKey = sessionKey({
        playerAddress: message.signal?.targetAddress,
        lobbyId: message.signal?.lobbyId,
        tableId: message.signal?.tableId,
        endpoint: message.signal?.targetEndpoint,
      });
      const targetPortIds = getTargetPortIds(targetKey, portId);
      const targetPortId = postFirstLiveTarget(targetPortIds, {
        type: 'RTC_POOL_SIGNAL',
        signal: message.signal,
        fromSharedWorker: true,
      });

      if (targetPortId != null) {
        logWorker('direct signal route', {
          signalId: message.signal?.id,
          fromPortId: portId,
          targetPortId,
          skippedDuplicatePorts: Math.max(targetPortIds.length - 1, 0),
        });
        return;
      }

      logWorker('direct route unavailable, scattering', {
        signalId: message.signal?.id,
        from: formatPeer(message.signal?.originAddress),
        to: formatPeer(message.signal?.targetAddress),
      });
      broadcast({
        type: 'SCATTER_RTC_POOL_SIGNAL',
        signal: message.signal,
        fromSharedWorker: true,
      }, portId);
      return;
    }

    if (message?.type === RTC_POOL_GOSSIP_ANNOUNCE || message?.type === RTC_POOL_GOSSIP_TRIGGER_OFFER) {
      const targetKey = sessionKey({
        playerAddress: message.targetAddress,
        lobbyId: message.lobbyId,
        tableId: message.tableId,
        endpoint: 'table',
      });
      const targetPortIds = getTargetPortIds(targetKey, portId);
      const targetPortId = postFirstLiveTarget(targetPortIds, {
        ...message,
        fromSharedWorker: true,
      });

      if (targetPortId != null) {
        logWorker('direct gossip control route', {
          messageId: message.id,
          type: message.type,
          fromPortId: portId,
          targetPortId,
          skippedDuplicatePorts: Math.max(targetPortIds.length - 1, 0),
        });
        return;
      }

      logWorker('direct gossip route unavailable, scattering', {
        messageId: message.id,
        type: message.type,
        from: formatPeer(message.originAddress),
        to: formatPeer(message.targetAddress),
      });
      broadcast({
        ...message,
        fromSharedWorker: true,
      }, portId);
      return;
    }

    if (message?.type === RTC_POOL_P2P_MST_FRAGMENT) {
      logWorker('p2p mst fragment scattering', {
        messageId: message.id,
        fromNode: formatPeer(message.fromNode),
        toNode: formatPeer(message.toNode),
        edgeCount: message.edges?.length ?? 0,
      });
      broadcast({
        ...message,
        fromSharedWorker: true,
      }, portId);
      return;
    }

    if (message?.type === 'RTC_POOL_ROUTE_REQUEST') {
      broadcast({
        type: 'RTC_POOL_ROUTE_REQUEST',
        requestId: message.requestId,
        requesterTabId: message.requesterTabId,
        signal: message.signal,
        fromSharedWorker: true,
      }, portId);
      return;
    }

    if (message?.type === 'RTC_POOL_ROUTE_RESULT') {
      broadcast({
        type: 'RTC_POOL_ROUTE_RESULT',
        requestId: message.requestId,
        requesterTabId: message.requesterTabId,
        targetTabId: message.targetTabId,
        signalId: message.signalId,
        found: message.found,
        reason: message.reason,
        fromSharedWorker: true,
      }, portId);
      return;
    }

    if (message?.type === 'RTC_POOL_LOCAL_NOTICE') {
      broadcast({
        type: 'RTC_POOL_LOCAL_NOTICE',
        noticeType: message.noticeType,
        detail: message.detail,
        fromSharedWorker: true,
      }, portId);
      return;
    }

    if (message?.type === 'RTC_POOL_SIGNAL_DELIVERED') {
      broadcast({
        type: 'RTC_POOL_SIGNAL_DELIVERED',
        id: message.id,
        fromSharedWorker: true,
      }, portId);
    }
  };

  port.onmessageerror = () => unregisterPort(portId, 'message error');
  port.start();
  port.postMessage({ type: 'READY', portId });
  logWorker('ready sent', { portId });
};

setInterval(pruneStalePorts, PRUNE_INTERVAL_MS);
