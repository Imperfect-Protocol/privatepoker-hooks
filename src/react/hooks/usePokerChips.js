import { isAddress } from 'viem';
import { CHIPS_ABI } from 'privatepoker-hooks/blockchain/abi';
import { CHIPS_CONTRACT_ADDRESS, LOBBY_CONTRACT_ADDRESS } from 'privatepoker-hooks/config/chain';
import { toChipUnits } from 'privatepoker-hooks/config/constants';
import { useOperatorAddress } from 'privatepoker-hooks/react/hooks/useOperatorAddress';
import { publicPokerClient } from 'privatepoker-hooks/blockchain/clients/PokerClients';
import { logWriteTransactionError, waitForLoggedTransactionReceipt } from 'privatepoker-hooks/blockchain/transactions/TransactionReceiptLogger';

export function usePokerChips({ onOperatorTopUp } = {}) {
  const { writeContractFromOperator } = useOperatorAddress({ onOperatorTopUp });

  const ensureOperatorBuyInAllowance = async ({ buyIn, playerAddress, operatorPrivateKey }) => {
    if (!isAddress(CHIPS_CONTRACT_ADDRESS)) {
      throw new Error("Poker Chips contract address is not configured.");
    }
    if (!isAddress(LOBBY_CONTRACT_ADDRESS)) {
      throw new Error("PrivatePokerLobby contract address is not configured.");
    }
    if (!playerAddress) {
      throw new Error("Player address is required before buying in.");
    }

    const amount = toChipUnits(buyIn);
    if (amount === 0n) return;

    const [balance, allowance] = await Promise.all([
      publicPokerClient.readContract({
        address: CHIPS_CONTRACT_ADDRESS,
        abi: CHIPS_ABI,
        functionName: 'balanceOf',
        args: [playerAddress],
      }),
      publicPokerClient.readContract({
        address: CHIPS_CONTRACT_ADDRESS,
        abi: CHIPS_ABI,
        functionName: 'allowance',
        args: [playerAddress, LOBBY_CONTRACT_ADDRESS],
      }),
    ]);

    if (balance < amount) {
      throw new Error("Insufficient Chips balance for this buy-in.");
    }
    if (allowance >= amount) return;

    const args = [LOBBY_CONTRACT_ADDRESS, amount];
    let hash;
    try {
      hash = await writeContractFromOperator({
        operatorPrivateKey,
        contract: CHIPS_CONTRACT_ADDRESS,
        abi: CHIPS_ABI,
        functionName: 'approve',
        args,
      });
      await waitForLoggedTransactionReceipt({
        hash,
        functionName: 'approve',
        contract: CHIPS_CONTRACT_ADDRESS,
        args,
      });
    } catch (error) {
      if (!hash) {
        logWriteTransactionError({
          functionName: 'approve',
          contract: CHIPS_CONTRACT_ADDRESS,
          args,
          error,
        });
      }
      throw error;
    }
  };

  return { ensureOperatorBuyInAllowance };
}
