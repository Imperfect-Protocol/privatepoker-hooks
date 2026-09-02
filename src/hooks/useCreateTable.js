import { useCallback } from 'react';
import { usePokerChips } from 'privatepoker-hooks/hooks/usePokerChips';
import { usePrivatePokerLobby } from 'privatepoker-hooks/hooks/usePrivatePokerLobby';
import { useRequireBLS } from 'privatepoker-hooks/hooks/useRequireBLS';
import { toChipUnits } from 'privatepoker-hooks/lib/constants';

const inFlightCreateTableRequests = new Map();

function errorText(error) {
  const parts = [
    error?.shortMessage,
    error?.details,
    error?.message,
    error?.data,
    error?.cause?.shortMessage,
    error?.cause?.details,
    error?.cause?.message,
    error?.cause?.data,
  ];
  return parts.filter(Boolean).join('\n');
}

function isTableAlreadyExistsError(error) {
  const text = errorText(error);
  return /TABLE_ALREADY_EXISTS|0x5441424c/i.test(text);
}

function hasSeatedPlayer(tableDetail, playerAddress) {
  const playerKey = playerAddress?.toLowerCase();
  return tableDetail?.players?.some((player) => (
    player.playerAddress?.toLowerCase() === playerKey
  ));
}

export function useCreateTable({ onOperatorTopUp } = {}) {
  const {
    createTable,
    getLobbyById,
    getTableDetail,
    getTableCount,
    getTablesRange,
  } = usePrivatePokerLobby({ onOperatorTopUp });
  const { ensureOperatorBuyInAllowance } = usePokerChips({ onOperatorTopUp });
  const { generateKeys } = useRequireBLS();

  const createTableWithBuyIn = useCallback(async ({
    lobbyId,
    lobbyName,
    tableId,
    tableName,
    buyIn,
    blinds,
    stakesLabel,
    numPlayers,
    onStep,
  }) => {
    const requestKey = [
      String(lobbyId),
      String(tableId),
      String(tableName ?? ''),
      String(buyIn ?? ''),
      String(numPlayers ?? ''),
    ].join(':');
    const existingRequest = inFlightCreateTableRequests.get(requestKey);
    if (existingRequest) return existingRequest;

    const request = (async () => {
      onStep?.('signature', 'active');
      const keys = await generateKeys({
        lobbyId,
        lobbyName,
        tableId,
        tableName,
        buyIn,
        blinds,
        stakesLabel,
      });
      onStep?.('signature', 'complete');
      const publicKeyBytes = `0x${keys.publicKey}`;
      onStep?.('operatorApproval', 'active');
      await ensureOperatorBuyInAllowance({
        buyIn,
        playerAddress: keys.playerAddress,
        operatorPrivateKey: keys.operatorPrivateKey,
      });
      onStep?.('operatorApproval', 'complete');
      onStep?.('transfer', 'active');
      try {
        await createTable(lobbyId, tableId, tableName, toChipUnits(buyIn), numPlayers, keys.playerAddress, keys.operator, publicKeyBytes, keys.operatorPrivateKey);
      } catch (error) {
        if (!isTableAlreadyExistsError(error)) throw error;

        const tableDetail = await getTableDetail(lobbyId, tableId);
        if (!hasSeatedPlayer(tableDetail, keys.playerAddress)) throw error;
      }
      onStep?.('transfer', 'complete');
      return { publicKeyBytes, keys };
    })();

    inFlightCreateTableRequests.set(requestKey, request);
    request.finally(() => {
      if (inFlightCreateTableRequests.get(requestKey) === request) {
        inFlightCreateTableRequests.delete(requestKey);
      }
    }).catch(() => {});
    return request;
  }, [createTable, ensureOperatorBuyInAllowance, generateKeys, getTableDetail]);

  return {
    createTableWithBuyIn,
    getLobbyById,
    getTableCount,
    getTablesRange,
  };
}
