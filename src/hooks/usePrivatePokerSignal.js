import { useCallback, useState } from 'react';
import { useConnection } from 'wagmi';
import {
  getPrivateMeshUrls,
  publishPrivateMeshBye,
  publishPrivateMesh,
} from 'privatepoker-hooks/lib/privateMesh';

const formatPeer = (value) => {
  const text = value ? String(value) : '';
  if (!text) return 'unknown';
  return text.length <= 12 ? text : `${text.slice(0, 6)}...${text.slice(-4)}`;
};

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

export function usePrivatePokerSignal({ playerAddress } = {}) {
  const { address } = useConnection();
  const senderAddress = playerAddress ?? address;
  const [isSendingSignal, setIsSendingSignal] = useState(false);

  const sendSignal = useCallback(async (lobbyId, tableId, recipientAddresses, encryptedDataBytes, options = {}) => {
    if (!senderAddress) {
      throw new Error('Player address is required before publishing a Private Mesh signal.');
    }

    const kind = options.signalType ?? options.kind ?? 'offer';
    if (kind === 'bye') {
      return publishPrivateMeshBye({
        originAddress: senderAddress,
        enqueue: options.enqueue,
      });
    }

    const recipients = asArray(recipientAddresses);
    const encryptedData = asArray(encryptedDataBytes);

    if (recipients.length !== encryptedData.length) {
      throw new Error('Signal recipient and payload counts must match.');
    }

    const signals = recipients.map((recipient, index) => ({
      originAddress: senderAddress,
      targetAddress: recipient,
      recipient,
      encryptedData: encryptedData[index],
      kind,
      lobbyId: lobbyId?.toString?.() ?? String(lobbyId),
      tableId: tableId?.toString?.() ?? String(tableId),
      flowId: options.flowId ?? null,
    }));

    console.log('[RTC signal] Private Mesh publish', {
      signalServers: getPrivateMeshUrls().length,
      lobbyId: lobbyId?.toString?.() ?? String(lobbyId),
      tableId: tableId?.toString?.() ?? String(tableId),
      recipients: recipients.map(formatPeer),
      payloads: encryptedData.length,
      kind,
    });

    setIsSendingSignal(true);
    try {
      return publishPrivateMesh(signals, options.enqueue);
    } finally {
      setIsSendingSignal(false);
    }
  }, [senderAddress]);

  return { sendSignal, isSendingSignal };
}
