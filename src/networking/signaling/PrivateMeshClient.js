import { MESH_ENDPOINTS } from 'privatepoker-hooks/config/mesh';

const cleanUrl = (value) => String(value ?? '').trim().replace(/\/+$/, '');
const stripHexPrefix = (value) => String(value ?? '').replace(/^0x/i, '');
const activePollSessions = new Map();

const normalizeAddress = (value) => {
  const hex = stripHexPrefix(value).toLowerCase();
  return /^[0-9a-f]{40}$/.test(hex) ? `0x${hex}` : '';
};

function meshEndpoints() {
  const seen = new Set();
  return MESH_ENDPOINTS
    .map((endpoint) => ({ url: cleanUrl(endpoint?.url) }))
    .filter(({ url }) => {
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function shuffledMeshEndpoints() {
  const endpoints = meshEndpoints();
  for (let index = endpoints.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [endpoints[index], endpoints[swapIndex]] = [endpoints[swapIndex], endpoints[index]];
  }
  return endpoints.map((endpoint) => endpoint.url);
}

function pollSessionKey(lobbyId, tableId, peer) {
  return `${String(lobbyId)}:${String(tableId)}:${normalizeAddress(peer)}`;
}

function createPollSession({ urls, lobbyId, tableId, peer, callback }) {
  const session = {
    urls,
    endpointIndex: 0,
    url: urls[0],
    lobbyId: String(lobbyId),
    tableId: String(tableId),
    peer: normalizeAddress(peer),
    callback,
    queue: [],
    sagaId: '',
    currentAbort: null,
    stopped: false,
  };

  session.enqueue = (message) => {
    if (!message || session.stopped) return;
    session.queue.push(message);
    session.currentAbort?.abort();
  };
  session.rotateEndpoint = () => {
    if (session.urls.length < 2) return false;
    session.endpointIndex = (session.endpointIndex + 1) % session.urls.length;
    session.url = session.urls[session.endpointIndex];
    return true;
  };

  return session;
}

async function sendAndPoll(session) {
  const { url, lobbyId, tableId, peer } = session;

  const attachSagaId = (message) => {
    if (!session.sagaId || !message || typeof message !== 'object') return message;
    if (Array.isArray(message)) return message.map(attachSagaId);
    return {
      ...message,
      saga_id: message.saga_id ?? message.sagaId ?? session.sagaId,
    };
  };

  const enqueueFn = (m) => {
    if (m) {
      session.enqueue(async () => attachSagaId(typeof m === 'function' ? await m() : await m));
    }
  };

  try {
    while (!session.stopped) {
      const rawOutbound = session.queue.splice(0);
      const outbound = [];

      for (const item of rawOutbound) {
        const resolved = typeof item === 'function' ? await item() : await item;
        const withSagaId = attachSagaId(resolved);
        if (withSagaId) {
          if (Array.isArray(withSagaId)) {
            outbound.push(...withSagaId);
          } else {
            outbound.push(withSagaId);
          }
        }
      }

      const abort = new AbortController();
      session.currentAbort = abort;
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: abort.signal,
          body: JSON.stringify({
            lobbyId,
            tableId,
            peer,
            saga_id: session.sagaId,
            messages: outbound,
          }),
        });
      } catch (error) {
        if (error.name === 'AbortError') continue;
        session.queue.unshift(...rawOutbound);
        if (session.rotateEndpoint()) {
          console.warn('[privateMesh] endpoint failed, trying next:', error.message);
          continue;
        }
        throw error;
      } finally {
        if (session.currentAbort === abort) {
          session.currentAbort = null;
        }
      }

      if (!response.ok) {
        session.queue.unshift(...rawOutbound);
        if (session.rotateEndpoint()) {
          console.warn('[privateMesh] endpoint returned HTTP status, trying next:', response.status);
          continue;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.json().catch(() => null);
      const responseSagaId = body?.saga_id ?? body?.sagaId;
      if (typeof responseSagaId === 'string' && responseSagaId) {
        session.sagaId = responseSagaId;
      }
      const inboundMessages = Array.isArray(body?.messages) ? body.messages : [];

      for (const msg of inboundMessages) {
        let inboundMessage = msg;

        if (msg.type === 'keep-alive') {
          continue;
        }

        if (msg.type === 'trigger-offer') {
          inboundMessage = {
            type: 'trigger-offer',
            target: normalizeAddress(msg.target),
            flowId: msg.flowId,
            lobbyId: msg.lobbyId,
            tableId: msg.tableId,
            recipient: normalizeAddress(peer),
            saga_id: msg.saga_id ?? msg.sagaId ?? session.sagaId,
          };
        } else if (msg.type === 'p2p-route-available') {
          inboundMessage = {
            type: 'p2p-route-available',
            target: normalizeAddress(msg.target),
            flowId: msg.flowId,
            status: msg.status,
            lobbyId: msg.lobbyId,
            tableId: msg.tableId,
            recipient: normalizeAddress(peer),
            saga_id: msg.saga_id ?? msg.sagaId ?? session.sagaId,
          };
        } else if (msg.signal) {
          inboundMessage = msg.signal;
        }

        if (typeof session.callback === 'function') {
          await session.callback(inboundMessage, enqueueFn);
        }
      }
    }
  } catch (error) {
    console.warn('[privateMesh] poll thread error:', error.message);
  } finally {
    session.stopped = true;
    console.debug(`[privateMesh] poll thread exited for: ${lobbyId}:${tableId}`);
  }
}

export async function announcePrivateMesh({ originAddress, lobbyId, tableId, lookingFor = [], callback }) {
  const peer = normalizeAddress(originAddress);
  if (!peer || !lobbyId || !tableId || typeof callback !== 'function') return;

  const urls = shuffledMeshEndpoints();
  if (urls.length === 0) return;

  const targets = lookingFor.map(normalizeAddress).filter(Boolean);
  const message = {
    type: 'bootstrap-announce',
    peer,
    lookingFor: targets,
  };
  const key = pollSessionKey(lobbyId, tableId, peer);
  const existing = activePollSessions.get(key);
  if (existing && !existing.stopped) {
    existing.callback = callback;
    existing.enqueue(message);
    return;
  }

  const session = createPollSession({
    urls,
    lobbyId,
    tableId,
    peer,
    callback,
  });
  activePollSessions.set(key, session);
  session.enqueue(message);
  void sendAndPoll(session).finally(() => {
    if (activePollSessions.get(key) === session) {
      activePollSessions.delete(key);
    }
  });
}

export function publishPrivateMesh(signals, enqueue) {
  const messages = signals.map((signal) => ({
    type: signal.kind === 'accept' || signal.kind === 'answer' ? 'bootstrap-answer' : 'bootstrap-interest',
    signal,
  }));

  if (typeof enqueue === 'function') {
    messages.forEach((msg) => enqueue(msg));
  }
  return { accepted: true, messages };
}

export function publishPrivateMeshBye({ enqueue } = {}) {
  const message = { type: 'bootstrap-bye' };
  if (typeof enqueue === 'function') {
    enqueue(message);
  }
  return message;
}

export function getPrivateMeshUrls() {
  return meshEndpoints();
}
