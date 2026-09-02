import { isAddress, parseAbi } from 'viem';
import { CHIPS_CONTRACT_ADDRESS, LOBBY_CONTRACT_ADDRESS } from 'privatepoker-hooks/lib/chain';
import { toChipUnits } from 'privatepoker-hooks/lib/constants';
import { useOperatorAddress } from 'privatepoker-hooks/hooks/useOperatorAddress';
import { publicPokerClient } from 'privatepoker-hooks/lib/publicPokerClient';
import { logWriteTransactionError, waitForLoggedTransactionReceipt } from 'privatepoker-hooks/lib/tx_console';

const CHIPS_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

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
