import { publicPokerClient } from './publicPokerClient.js';

class TransactionFailedError extends Error {
  constructor(message, receipt) {
    super(message);
    this.name = "TransactionFailedError";
    this.receipt = receipt;
  }
}

function isReceiptSuccess(receipt) {
  return receipt?.status === 'success';
}

function receiptStatus(receipt) {
  return isReceiptSuccess(receipt) ? 'Ok' : 'Err';
}

function receiptLogPayload({ receipt = null, hash = null, functionName, contract, args, error = null }) {
  return {
    status: receipt ? receiptStatus(receipt) : 'Err',
    functionName,
    tx: hash ?? receipt?.transactionHash ?? null,
    gasUsed: receipt?.gasUsed?.toString?.() ?? null,
    contract,
    args,
    blockNumber: receipt?.blockNumber?.toString?.() ?? null,
    error,
  };
}

export async function waitForLoggedTransactionReceipt({
  client = publicPokerClient,
  hash,
  functionName,
  contract = null,
  args = null,
}) {
  try {
    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log('[PrivatePoker tx receipt]', receiptLogPayload({
      receipt,
      hash,
      functionName,
      contract,
      args,
    }));
    if (receipt.status === 'reverted') {
      throw new TransactionFailedError(
        `Transaction ${hash} reverted on block ${receipt.blockNumber}`,
        receipt
      );
    }
    return receipt;
  } catch (error) {
    console.error('[PrivatePoker tx receipt]', receiptLogPayload({
      hash,
      functionName,
      contract,
      args,
      error,
    }));
    throw error;
  }
}

export function logWriteTransactionError({
  functionName,
  contract = null,
  args = null,
  error,
}) {
  console.error('[PrivatePoker tx receipt]', receiptLogPayload({
    functionName,
    contract,
    args,
    error,
  }));
}
