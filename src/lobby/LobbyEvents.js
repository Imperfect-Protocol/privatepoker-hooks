export const LOBBY_TABLES_CHANGED = 'LOBBY_TABLES_CHANGED';

const CHANNEL_NAME = 'private-poker:lobby-events';

function eventPayload(event) {
  return {
    ...event,
    sentAt: Date.now(),
  };
}

export function emitLobbyTablesChanged({ lobbyId, tableId, reason = 'table-changed' } = {}) {
  if (typeof window === 'undefined') return;

  const payload = eventPayload({
    type: LOBBY_TABLES_CHANGED,
    lobbyId: lobbyId?.toString?.() ?? String(lobbyId ?? ''),
    tableId: tableId?.toString?.() ?? String(tableId ?? ''),
    reason,
  });

  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(payload);
    channel.close();
  }

  try {
    window.localStorage.setItem(CHANNEL_NAME, JSON.stringify(payload));
  } catch {
    // Best-effort cross-tab hint.
  }
}

export function subscribeLobbyTablesChanged(callback) {
  if (typeof window === 'undefined' || typeof callback !== 'function') return () => {};

  const handleMessage = (payload) => {
    if (payload?.type === LOBBY_TABLES_CHANGED) callback(payload);
  };
  const channel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;
  const handleBroadcast = (event) => handleMessage(event.data);
  const handleStorage = (event) => {
    if (event.key !== CHANNEL_NAME || !event.newValue) return;
    try {
      handleMessage(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed messages from older tabs.
    }
  };

  channel?.addEventListener('message', handleBroadcast);
  window.addEventListener('storage', handleStorage);

  return () => {
    channel?.removeEventListener('message', handleBroadcast);
    channel?.close();
    window.removeEventListener('storage', handleStorage);
  };
}
