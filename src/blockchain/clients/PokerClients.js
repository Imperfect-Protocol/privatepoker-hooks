import { createPublicClient, createWalletClient, http } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { CHAIN_KEY, CHAIN_RPC_URL } from 'privatepoker-hooks/config/chain/index.js';
import { nitroDevNode } from 'privatepoker-hooks/config/chain/nitroDevNode.js';

const chain = CHAIN_KEY === 'devnode' ? nitroDevNode : arbitrumSepolia;
const multicallBatch = CHAIN_KEY === 'sepolia'
  ? {
    multicall: {
      batchSize: 4096,
      wait: 50,
    },
  }
  : undefined;

export const publicPokerClient = createPublicClient({
  chain,
  ...(multicallBatch ? { batch: multicallBatch } : {}),
  transport: http(CHAIN_RPC_URL),
});

export function createPokerWalletClient(account) {
  return createWalletClient({
    account,
    chain,
    transport: http(CHAIN_RPC_URL),
  });
}
