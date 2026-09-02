import { chainConfig } from 'privatepoker-hooks/config/chain/environments/devnode.js';
import { rewriteDevProxyUrl } from 'privatepoker-hooks/config/proxy/devServer/dev.js';

export const CHAIN_CONFIG = chainConfig;
export const CHAIN_KEY = chainConfig.key;
export const CHAIN_ID = chainConfig.chainId;
export const CHAIN_RPC_URL = rewriteDevProxyUrl(chainConfig.rpcUrl);
export const PPDC_CONTRACT_ADDRESS = chainConfig.ppdcContractAddress;
export const PRIVATE_POKER_CONTRACT_ADDRESS = chainConfig.privatePokerContractAddress;
export const HASH_TO_CURVE_CONTRACT_ADDRESS = chainConfig.hashToCurveAddress;
export const VERIFY_SIGNATURE_CONTRACT_ADDRESS = chainConfig.verifySignatureAddress;
export const CHAIN_MAX_GAS = chainConfig.maxGas ?? {};

export function liveDevnodeChain() {
  return {
    id: CHAIN_ID,
    name: CHAIN_KEY,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [CHAIN_RPC_URL] } },
  };
}
