import { useCallback } from 'react';
import { usePokerChips } from 'privatepoker-hooks/react/hooks/usePokerChips';
import { usePrivatePokerLobby } from 'privatepoker-hooks/react/hooks/usePrivatePokerLobby';
import { useRequireBLS } from 'privatepoker-hooks/react/hooks/useRequireBLS';

export function useJoinTable({ onOperatorTopUp } = {}) {
  const { joinTable, getTableDetail } = usePrivatePokerLobby({ onOperatorTopUp });
  const { ensureOperatorBuyInAllowance } = usePokerChips({ onOperatorTopUp });
  const { generateKeys } = useRequireBLS();

  const joinTableWithBuyIn = useCallback(async ({
    lobbyId,
    tableId,
    tableName,
    blinds,
    stakesLabel,
    onStep,
  }) => {
    // 1. READ BUY-IN FROM CONTRACT STATE
    const tableDetail = await getTableDetail(lobbyId, tableId);
    const buyIn = tableDetail.info.buyIn; // Already formatted as display units (e.g. 100)

    // 2. GENERATE KEYS
    onStep?.('signature', 'active');
    const keys = await generateKeys({
      lobbyId,
      tableId,
      tableName: tableName || tableDetail.info.name,
      buyIn,
      blinds,
      stakesLabel,
    });
    onStep?.('signature', 'complete');

    const publicKeyBytes = `0x${keys.publicKey}`;

    // 3. APPROVE EXACT ALLOWANCE (USES DERIVED BUYIN)
    onStep?.('operatorApproval', 'active');
    await ensureOperatorBuyInAllowance({
      buyIn,
      playerAddress: keys.playerAddress,
      operatorPrivateKey: keys.operatorPrivateKey,
    });
    onStep?.('operatorApproval', 'complete');

    // 4. JOIN TABLE (NO BUY-IN PARAMETER PASSED TO CONTRACT)
    onStep?.('transfer', 'active');
    await joinTable(
      lobbyId,
      tableId,
      keys.playerAddress,
      keys.operator,
      publicKeyBytes,
      keys.operatorPrivateKey
    );
    onStep?.('transfer', 'complete');

    return { publicKeyBytes, keys };
  }, [ensureOperatorBuyInAllowance, generateKeys, getTableDetail, joinTable]);

  return { joinTableWithBuyIn };
}