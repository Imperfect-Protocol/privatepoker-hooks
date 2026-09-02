/* global process */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  isAddress,
  parseAbi,
  parseEther,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import {
  PRIVATE_POKER_CONTRACT_ADDRESS,
  PPDC_CONTRACT_ADDRESS,
  CHAIN_KEY,
  CHAIN_MAX_GAS,
  CHAIN_RPC_URL,
  liveDevnodeChain,
} from './live-devnode-chain.js';
import { toChipUnits } from 'privatepoker-hooks/config/constants/index.js';
import {
  buildFinalHandSettlement,
  buildNextFinalVerification,
  buildNextTableAggregatePublicKeyVerification,
  settlementContractArgs,
  tableAggregatePublicKey,
  tableAggregatePublicKeyContractArgs,
} from 'privatepoker-hooks/react/hooks/useFinalVerification.js';
import {
  POKER_HAND_STATE_SHUFFLE,
  POKER_HAND_STATE_FINISHED,
} from 'privatepoker-hooks/poker/core/crum_pkr/index.js';
import {
  HAND_ID,
  INITIAL_CHIPS,
  playFinishedP2pHand,
  publicKeyHex,
} from './final-settlement-helpers.js';

const PRIVATE_POKER_ABI = parseAbi([
  'function getLobbyById(uint256 lobbyId) view returns (bytes)',
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function subscribe(address player_address, address operator, string display_name, bytes annonce_public_key, bytes encrypted_profile, uint8 subscription_tier)',
  'function createAccount(address player_address, string display_name, bytes encrypted_profile)',
  'function setAccountStatus(address player_address, uint256 flags)',
  'function getAccountStatus(address player_address) view returns (uint256)',
  'function createTable(uint256 lobby_id, uint256 table_id, string calldata name, uint256 buy_in, uint256 num_players, address player_address, bytes calldata annonce_public_key)',
  'function joinTable(uint256 lobby_id, uint256 table_id, address player_address, bytes calldata annonce_public_key)',
  'function setTableAggregatePublicKey(uint256 lobby_id, uint256 table_id, bytes aggregate_public_key)',
  'function startHand(uint256 lobby_id, uint256 table_id)',
  'function settleHand(uint256 lobby_id, uint256 table_id, uint256 hand_id, uint256 pot_size, uint256[] pot_split, uint256[] chips_balances, bytes digest, bytes aggregate_public_key) returns (uint256)',
]);

const TEST_USDC_ABI = parseAbi([
  'function faucet(address to, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

const DEV_MNEMONIC = process.env.PRIVATE_POKER_LIVE_MNEMONIC;
const DEV_OWNER_PRIVATE_KEY = process.env.PRIVATE_POKER_LIVE_OWNER_PRIVATE_KEY;
const LOBBY_ID = 1n;
const NUM_PLAYERS = Number(process.env.PRIVATE_POKER_LIVE_PLAYERS ?? 3);
const BUY_IN = toChipUnits(INITIAL_CHIPS);
const ACCOUNT_STATUS_VERIFIED = 2n;
const STARTER_SUBSCRIPTION_USDC = 10_000_000n;
const PLAYER_GAS_TOP_UP = parseEther('0.1');
const ETH_USD = 2000;

function standardAccount(index) {
  return mnemonicToAccount(DEV_MNEMONIC, { addressIndex: index });
}

function liveTableId() {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  return 9_000_000n + (timestamp % 1_000_000n);
}

function gasLimit(functionName) {
  return BigInt(
    CHAIN_MAX_GAS.privatePoker?.functions?.[functionName]
      ?? CHAIN_MAX_GAS.privatePoker?.default
      ?? 5_000_000n,
  );
}

function gasUsd(receipt) {
  const gasCostWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
  const eth = Number(gasCostWei) / 1e18;
  return eth * ETH_USD;
}

function receiptLine(label, receipt) {
  return [
    label,
    `hash=${receipt.transactionHash}`,
    `status=${receipt.status}`,
    `gasUsed=${receipt.gasUsed}`,
    `~$${gasUsd(receipt).toFixed(4)}`,
  ].join(' ');
}

function appendSignatureToCalldata(calldata, signature) {
  const normalizedSignature = String(signature).startsWith('0x') ? String(signature) : `0x${signature}`;
  return `${calldata}${normalizedSignature.slice(2)}`;
}

function expectedTableWinnerSeat(chipsBalances) {
  let winnerSeat = null;
  for (let seat = 0; seat < chipsBalances.length; seat += 1) {
    if (BigInt(chipsBalances[seat]) === 0n) continue;
    if (winnerSeat != null) return BigInt(chipsBalances.length);
    winnerSeat = seat;
  }
  return winnerSeat == null ? BigInt(chipsBalances.length) : BigInt(winnerSeat);
}

async function writeAndWait({
  publicClient,
  walletClient,
  account,
  address = PRIVATE_POKER_CONTRACT_ADDRESS,
  abi = PRIVATE_POKER_ABI,
  functionName,
  args,
  signature,
  gas = gasLimit(functionName),
}) {
  const data = signature
    ? appendSignatureToCalldata(encodeFunctionData({ abi, functionName, args }), signature)
    : null;
  const hash = data
    ? await walletClient.sendTransaction({
      account,
      to: address,
      data,
      gas,
    })
    : await walletClient.writeContract({
      account,
      address,
      abi,
      functionName,
      args,
      gas,
    });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(receiptLine(`${functionName}(${account.address})`, receipt));
  assert.equal(receipt.status, 'success', `${functionName} reverted in tx ${hash}`);
  return receipt;
}

async function ensureLobby(publicClient) {
  await publicClient.readContract({
    address: PRIVATE_POKER_CONTRACT_ADDRESS,
    abi: PRIVATE_POKER_ABI,
    functionName: 'getLobbyById',
    args: [LOBBY_ID],
  });
}

async function ensurePlayerGas({ publicClient, walletClient, owner, player }) {
  const balance = await publicClient.getBalance({ address: player.address });
  if (balance >= PLAYER_GAS_TOP_UP / 2n) return null;

  const hash = await walletClient.sendTransaction({
    account: owner,
    to: player.address,
    value: PLAYER_GAS_TOP_UP,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(receiptLine(`fundGas(${player.address})`, receipt));
  assert.equal(receipt.status, 'success', `gas top-up reverted in tx ${hash}`);
  return receipt;
}

async function preparePlayer({ publicClient, walletClient, owner, account, announcePublicKey }) {
  const displayName = `Player ${account.address.slice(2, 6)}`;
  const accountStatus = await publicClient.readContract({
    address: PRIVATE_POKER_CONTRACT_ADDRESS,
    abi: PRIVATE_POKER_ABI,
    functionName: 'getAccountStatus',
    args: [account.address],
  });
  if (accountStatus === 0n) {
    await writeAndWait({
      publicClient,
      walletClient,
      account: owner,
      functionName: 'createAccount',
      args: [account.address, displayName, '0x'],
    });
  }
  if (accountStatus !== ACCOUNT_STATUS_VERIFIED) {
    await writeAndWait({
      publicClient,
      walletClient,
      account: owner,
      functionName: 'setAccountStatus',
      args: [account.address, ACCOUNT_STATUS_VERIFIED],
    });
  }
  await writeAndWait({
    publicClient,
    walletClient,
    account,
    address: PPDC_CONTRACT_ADDRESS,
    abi: TEST_USDC_ABI,
    functionName: 'faucet',
    args: [account.address, STARTER_SUBSCRIPTION_USDC],
    gas: 1_000_000n,
  });
  await writeAndWait({
    publicClient,
    walletClient,
    account,
    address: PPDC_CONTRACT_ADDRESS,
    abi: TEST_USDC_ABI,
    functionName: 'transfer',
    args: [PRIVATE_POKER_CONTRACT_ADDRESS, STARTER_SUBSCRIPTION_USDC],
    gas: 1_000_000n,
  });
  await writeAndWait({
    publicClient,
    walletClient,
    account,
    functionName: 'subscribe',
    args: [account.address, account.address, displayName, announcePublicKey, '0x', 1],
  });
  await writeAndWait({
    publicClient,
    walletClient,
    account,
    functionName: 'approve',
    args: [PRIVATE_POKER_CONTRACT_ADDRESS, BUY_IN],
  });

  const chips = await publicClient.readContract({
    address: PRIVATE_POKER_CONTRACT_ADDRESS,
    abi: PRIVATE_POKER_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  assert.ok(chips >= BUY_IN, `Player ${account.address} has insufficient chips`);
}

test('live final settlement creates table, joins players, starts hand, and settles on-chain', async (t) => {
  if (!DEV_MNEMONIC || !DEV_OWNER_PRIVATE_KEY) {
    t.skip('Set PRIVATE_POKER_LIVE_MNEMONIC and PRIVATE_POKER_LIVE_OWNER_PRIVATE_KEY to run this live test.');
    return;
  }

  assert.equal(CHAIN_KEY, 'devnode', 'live final settlement test expects devnode chain config');
  assert.ok(isAddress(PRIVATE_POKER_CONTRACT_ADDRESS), 'PrivatePoker diamond address is not configured');
  assert.ok(isAddress(PPDC_CONTRACT_ADDRESS), 'TEST_USDC/PPDC address is not configured');
  assert.ok(NUM_PLAYERS >= 2, 'live final settlement requires at least two players');

  const chain = liveDevnodeChain();
  const publicClient = createPublicClient({ chain, transport: http(CHAIN_RPC_URL) });
  const walletClient = createWalletClient({ chain, transport: http(CHAIN_RPC_URL) });
  const owner = privateKeyToAccount(DEV_OWNER_PRIVATE_KEY);
  const tableId = liveTableId();
  const {
    hand,
    tableSigningKeys,
    tablePublicKeys,
    tableSignaturePublicKeys,
    handHistoryEntries,
    handSetup,
  } = playFinishedP2pHand(NUM_PLAYERS, Number(tableId));
  const accounts = Array.from({ length: NUM_PLAYERS }, (_, index) => standardAccount(index));
  const tableSeats = accounts.map((account, seat) => ({
    playerAddress: account.address,
    announcePublicKey: publicKeyHex(tablePublicKeys[seat]),
  }));
  const tableSignatureSeats = tableSeats.map((seat, index) => ({
    ...seat,
    signaturePublicKey: publicKeyHex(tableSignaturePublicKeys[index]),
  }));
  assert.deepEqual([
    POKER_HAND_STATE_SHUFFLE,
    POKER_HAND_STATE_FINISHED,
  ], [0, 8]);

  await ensureLobby(publicClient);

  for (const account of accounts) {
    await ensurePlayerGas({ publicClient, walletClient, owner, player: account });
  }

  for (let player = 0; player < NUM_PLAYERS; player += 1) {
    await preparePlayer({
      publicClient,
      walletClient,
      owner,
      account: accounts[player],
      announcePublicKey: tableSeats[player].announcePublicKey,
    });
  }

  await writeAndWait({
    publicClient,
    walletClient,
    account: accounts[0],
    functionName: 'createTable',
    args: [
      LOBBY_ID,
      tableId,
      `Live Final Settlement ${tableId}`,
      BUY_IN,
      BigInt(NUM_PLAYERS),
      accounts[0].address,
      tableSeats[0].announcePublicKey,
    ],
  });

  for (let player = 1; player < NUM_PLAYERS; player += 1) {
    await writeAndWait({
      publicClient,
      walletClient,
      account: accounts[player],
      functionName: 'joinTable',
      args: [
        LOBBY_ID,
        tableId,
        accounts[player].address,
        tableSeats[player].announcePublicKey,
      ],
    });
  }

  const aggregatePublicKey = tableAggregatePublicKey(tableSignatureSeats);
  let tableAggregatePublicKeyShares = [];
  let tableAggregateSignatureShares = [];
  let tableAggregateVerification = null;
  for (let player = 0; player < NUM_PLAYERS; player += 1) {
    tableAggregateVerification = buildNextTableAggregatePublicKeyVerification({
      lobbyId: LOBBY_ID,
      tableId,
      tableSeats,
      publicKeyShares: tableAggregatePublicKeyShares,
      signatureShares: [],
      currentSeatNo: player,
      signingKey: tableSigningKeys[player],
      publicKey: tableSignaturePublicKeys[player],
    });
    tableAggregatePublicKeyShares = tableAggregateVerification.publicKeyShares;
  }

  for (let player = 0; player < NUM_PLAYERS; player += 1) {
    tableAggregateVerification = buildNextTableAggregatePublicKeyVerification({
      lobbyId: LOBBY_ID,
      tableId,
      tableSeats,
      publicKeyShares: tableAggregatePublicKeyShares,
      signatureShares: tableAggregateSignatureShares,
      currentSeatNo: player,
      signingKey: tableSigningKeys[player],
      publicKey: tableSignaturePublicKeys[player],
    });
    tableAggregateSignatureShares = tableAggregateVerification.signatureShares;
  }
  assert.equal(tableAggregateVerification.complete, true);
  assert.equal(tableAggregateVerification.aggregatePublicKey, aggregatePublicKey);

  await writeAndWait({
    publicClient,
    walletClient,
    account: accounts[NUM_PLAYERS - 1],
    functionName: 'setTableAggregatePublicKey',
    args: tableAggregatePublicKeyContractArgs({
      lobbyId: LOBBY_ID,
      tableId,
      tableAggregateVerification,
    }),
    signature: tableAggregateVerification.aggregateSignature,
  });

  for (let player = 0; player < NUM_PLAYERS; player += 1) {
    await writeAndWait({
      publicClient,
      walletClient,
      account: accounts[player],
      functionName: 'startHand',
      args: [LOBBY_ID, tableId],
    });
  }

  let signatureShares = [];
  let finalVerification = null;
  for (let player = 0; player < NUM_PLAYERS; player += 1) {
    finalVerification = buildNextFinalVerification({
      lobbyId: LOBBY_ID,
      tableId,
      handId: BigInt(HAND_ID),
      hand,
      handSetup,
      handHistoryEntries,
      tableSeats,
      publicKeyShares: tableAggregateVerification.publicKeyShares,
      settlement: buildFinalHandSettlement(hand, tableSeats),
      signatureShares,
      currentSeatNo: player,
      signingKey: tableSigningKeys[player],
      publicKey: tableSignaturePublicKeys[player],
    });
    signatureShares = finalVerification.signatureShares;
  }
  assert.equal(finalVerification.complete, true);
  assert.equal(finalVerification.aggregatePublicKey, aggregatePublicKey);

  const settleArgs = settlementContractArgs({
    lobbyId: LOBBY_ID,
    tableId,
    handId: BigInt(HAND_ID),
    finalVerification,
  });
  const settleCalldata = appendSignatureToCalldata(
    encodeFunctionData({
      abi: PRIVATE_POKER_ABI,
      functionName: 'settleHand',
      args: settleArgs,
    }),
    finalVerification.aggregateSignature,
  );
  const settleCall = await publicClient.call({
    account: accounts[NUM_PLAYERS - 1].address,
    to: PRIVATE_POKER_CONTRACT_ADDRESS,
    data: settleCalldata,
    gas: gasLimit('settleHand'),
  });
  const winningSeat = decodeFunctionResult({
    abi: PRIVATE_POKER_ABI,
    functionName: 'settleHand',
    data: settleCall.data,
  });
  assert.equal(
    winningSeat,
    expectedTableWinnerSeat(finalVerification.settlementMessage.chips_balances),
    'settleHand returned unexpected winning seat',
  );

  const settleReceipt = await writeAndWait({
    publicClient,
    walletClient,
    account: accounts[NUM_PLAYERS - 1],
    functionName: 'settleHand',
    args: settleArgs,
    signature: finalVerification.aggregateSignature,
  });

  const totalGasUsed = settleReceipt.gasUsed;
  console.log(`final settlement live tableId=${tableId} players=${NUM_PLAYERS} settleGas=${totalGasUsed}`);
});
