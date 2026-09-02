/* global process */

import { chainConfig as devnodeChainConfig } from './environments/devnode.js';
import { chainConfig as sepoliaChainConfig } from './environments/sepolia.js';

const chainConfigs = {
  devnode: devnodeChainConfig,
  sepolia: sepoliaChainConfig,
};

const selectedChain = process.env.NEXT_PUBLIC_PRIVATE_POKER_CHAIN ?? 'sepolia';
const selectedChainKey = selectedChain.toLowerCase();

export const CHAIN_CONFIG = chainConfigs[selectedChainKey] ?? sepoliaChainConfig;

export const CHAIN_KEY = CHAIN_CONFIG.key;
export const CHAIN_ID = CHAIN_CONFIG.chainId;
export const CHAIN_RPC_URL = CHAIN_CONFIG.rpcUrl;
export const PPDC_CONTRACT_ADDRESS = CHAIN_CONFIG.ppdcContractAddress;
export const PRIVATE_POKER_CONTRACT_ADDRESS = CHAIN_CONFIG.privatePokerContractAddress;
export const LOBBY_CONTRACT_ADDRESS = CHAIN_CONFIG.privatePokerContractAddress;
export const ACCOUNT_CONTRACT_ADDRESS = CHAIN_CONFIG.privatePokerContractAddress;
export const CHIPS_CONTRACT_ADDRESS = CHAIN_CONFIG.privatePokerContractAddress;
export const CASHIER_CONTRACT_ADDRESS = CHAIN_CONFIG.privatePokerContractAddress;
export const SETTLER_FACET_ADDRESS = CHAIN_CONFIG.settlerFacetAddress;
export const SIGNATORY_CONTRACT_ADDRESS = CHAIN_CONFIG.signatoryAddress;
export const HASH_TO_CURVE_CONTRACT_ADDRESS = CHAIN_CONFIG.hashToCurveAddress;
export const VERIFY_SIGNATURE_CONTRACT_ADDRESS = CHAIN_CONFIG.verifySignatureAddress;
export const CHAIN_MAX_GAS = CHAIN_CONFIG.maxGas ?? {};
export const CHAIN_POLLING_INTERVAL = CHAIN_CONFIG.pollingInterval;
export const CHAIN_STALE_TIME = CHAIN_CONFIG.staleTime;
