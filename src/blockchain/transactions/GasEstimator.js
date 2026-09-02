import {
  CHAIN_MAX_GAS,
  PRIVATE_POKER_CONTRACT_ADDRESS,
} from 'privatepoker-hooks/config/chain/index.js';

const normalizeAddress = (address) => address?.toLowerCase?.() ?? '';

const contractGasConfigByAddress = () => new Map([
  [normalizeAddress(PRIVATE_POKER_CONTRACT_ADDRESS), CHAIN_MAX_GAS.privatePoker],
].filter(([, config]) => config));

export async function getBufferedGasOverrides(publicClient, gasRequest) {
  const maxGas = configuredMaxGas(gasRequest);
  const gas = maxGas ?? await publicClient.estimateContractGas(gasRequest);
  const gasLimit = maxGas ?? gas + (gas / 5n);

  try {
    const fees = await publicClient.estimateFeesPerGas();
    if (fees?.maxFeePerGas && fees?.maxPriorityFeePerGas) {
      return {
        gas: gasLimit,
        maxFeePerGas: fees.maxFeePerGas + (fees.maxFeePerGas / 2n),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas + (fees.maxPriorityFeePerGas / 2n),
      };
    }
  } catch {
    // Fall through to block/base-fee fallback.
  }

  try {
    const block = await publicClient.getBlock();
    if (block?.baseFeePerGas) {
      const maxPriorityFeePerGas = 1_000_000n;
      return {
        gas: gasLimit,
        maxFeePerGas: (block.baseFeePerGas * 2n) + maxPriorityFeePerGas,
        maxPriorityFeePerGas,
      };
    }
  } catch {
    // Fall through to legacy gasPrice fallback.
  }

  const gasPrice = await publicClient.getGasPrice();
  return {
    gas: gasLimit,
    gasPrice: gasPrice + (gasPrice / 2n),
  };
}

export function configuredMaxGas({ address, functionName, args } = {}) {
  const config = contractGasConfigByAddress().get(normalizeAddress(address));
  const configured = config?.functions?.[functionName] ?? config?.[functionName] ?? config?.default;
  return gasLimitFromConfig(configured, { functionName, args }) ?? null;
}

function gasLimitFromConfig(configured, context) {
  if (configured == null) return null;
  if (typeof configured === 'bigint' || typeof configured === 'number' || typeof configured === 'string') {
    return BigInt(configured);
  }

  const constant = BigInt(configured.constant ?? configured.base ?? 0n);
  const perPlayer = BigInt(configured.perPlayer ?? 0n);
  const numPlayers = inferNumPlayers(context);
  if (perPlayer === 0n || numPlayers == null) return constant || null;

  return constant + (perPlayer * BigInt(numPlayers));
}

function inferNumPlayers({ args } = {}) {
  if (!Array.isArray(args)) return null;

  return null;
}
