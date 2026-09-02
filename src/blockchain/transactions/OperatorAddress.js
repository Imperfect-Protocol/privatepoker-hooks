import { privateKeyToAccount } from 'viem/accounts';
import { getBufferedGasOverrides } from './GasEstimator.js';
import { createPokerWalletClient, publicPokerClient } from '../clients/PokerClients.js';

const operatorWriteQueues = new Map();
const NONCE_RETRY_DELAY_MS = 350;

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

function isNonceTooLowError(error) {
  const message = [
    error?.shortMessage,
    error?.message,
    error?.details,
  ].filter(Boolean).join('\n');

  return /nonce (provided .* lower|too low|has already been used)/i.test(message);
}

function enqueueOperatorWrite(address, task) {
  const queueKey = address.toLowerCase();
  const previous = operatorWriteQueues.get(queueKey) ?? Promise.resolve();
  const queued = previous.catch(() => {}).then(task);

  operatorWriteQueues.set(queueKey, queued);
  queued.finally(() => {
    if (operatorWriteQueues.get(queueKey) === queued) {
      operatorWriteQueues.delete(queueKey);
    }
  }).catch(() => {});

  return queued;
}

export class OperatorAddress {
  constructor({ privateKey, topUp }) {
    if (!privateKey) {
      throw new Error('OperatorAddress requires a private key.');
    }

    this.privateKey = privateKey;
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
    this.topUp = topUp;
  }

  async ensureGas(amount) {
    if (amount <= 0n) return;

    const balance = await publicPokerClient.getBalance({ address: this.address });
    if (balance >= amount) return;

    console.log('operator top-up requested', {
      operator: this.address,
      estimatedGasWei: amount.toString(),
    });
    await this.topUp(this.address, amount);
  }

  async estimateContractGasFee({ contract, abi, functionName, args }) {
    const gasOverrides = await getBufferedGasOverrides(publicPokerClient, {
      address: contract,
      abi,
      functionName,
      args,
      account: this.address,
    });
    const gasFee = gasOverrides.gas * (gasOverrides.maxFeePerGas ?? gasOverrides.gasPrice ?? 0n);

    return { gasFee, gasOverrides };
  }

  async ensureGasForContract({ contract, abi, functionName, args }) {
    const { gasFee } = await this.estimateContractGasFee({
      contract,
      abi,
      functionName,
      args,
    });
    await this.ensureGas(gasFee);
  }

  async sendContractWrite({ walletClient, contract, abi, functionName, args, gasOverrides }) {
    const nonce = await publicPokerClient.getTransactionCount({
      address: this.address,
      blockTag: 'pending',
    });

    return walletClient.writeContract({
      address: contract,
      abi,
      functionName,
      args,
      nonce,
      ...gasOverrides,
    });
  }

  async sendTransaction({ walletClient, to, data, gasOverrides }) {
    const nonce = await publicPokerClient.getTransactionCount({
      address: this.address,
      blockTag: 'pending',
    });

    return walletClient.sendTransaction({
      to,
      data,
      nonce,
      ...gasOverrides,
    });
  }

  async writeContractNow({ contract, abi, functionName, args }) {
    const walletClient = createPokerWalletClient(this.account);
    const { gasFee, gasOverrides } = await this.estimateContractGasFee({
      contract,
      abi,
      functionName,
      args,
    });
    const balance = await publicPokerClient.getBalance({ address: this.address });

    console.log('operator transaction prepared', {
      operator: this.address,
      contract,
      functionName,
      balanceWei: balance.toString(),
      requiredGasWei: gasFee.toString(),
      args,
    });

    if (balance < gasFee) {
      await this.ensureGas(gasFee);
    }

    let hash;
    try {
      hash = await this.sendContractWrite({
        walletClient,
        contract,
        abi,
        functionName,
        args,
        gasOverrides,
      });
    } catch (error) {
      if (!isNonceTooLowError(error)) throw error;

      await wait(NONCE_RETRY_DELAY_MS);
      hash = await this.sendContractWrite({
        walletClient,
        contract,
        abi,
        functionName,
        args,
        gasOverrides,
      });
    }

    console.log('operator transaction sent', {
      operator: this.address,
      contract,
      functionName,
      hash,
    });
    return hash;
  }

  async writeTransactionNow({ to, data, functionName, args }) {
    const walletClient = createPokerWalletClient(this.account);
    const gasOverrides = await getBufferedGasOverrides(publicPokerClient, {
      address: to,
      functionName,
      args,
      account: this.address,
    });
    const gasFee = gasOverrides.gas * (gasOverrides.maxFeePerGas ?? gasOverrides.gasPrice ?? 0n);
    const balance = await publicPokerClient.getBalance({ address: this.address });

    console.log('operator transaction prepared', {
      operator: this.address,
      contract: to,
      functionName,
      balanceWei: balance.toString(),
      requiredGasWei: gasFee.toString(),
      args,
    });

    if (balance < gasFee) {
      await this.ensureGas(gasFee);
    }

    let hash;
    try {
      hash = await this.sendTransaction({
        walletClient,
        to,
        data,
        gasOverrides,
      });
    } catch (error) {
      if (!isNonceTooLowError(error)) throw error;

      await wait(NONCE_RETRY_DELAY_MS);
      hash = await this.sendTransaction({
        walletClient,
        to,
        data,
        gasOverrides,
      });
    }

    console.log('operator transaction sent', {
      operator: this.address,
      contract: to,
      functionName,
      hash,
    });
    return hash;
  }

  async writeContract({ contract, abi, functionName, args }) {
    return enqueueOperatorWrite(this.address, () => this.writeContractNow({
      contract,
      abi,
      functionName,
      args,
    }));
  }

  async writeTransaction({ to, data, functionName, args }) {
    return enqueueOperatorWrite(this.address, () => this.writeTransactionNow({
      to,
      data,
      functionName,
      args,
    }));
  }
}
