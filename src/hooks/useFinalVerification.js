import { useCallback } from 'react';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { useConnection, useSendTransaction, useWriteContract } from 'wagmi';
import { PRIVATE_POKER_CONTRACT_ADDRESS } from '../lib/chain/index.js';
import { getBufferedGasOverrides } from '../lib/gas.js';
import { publicPokerClient } from '../lib/publicPokerClient.js';
import { logWriteTransactionError, waitForLoggedTransactionReceipt } from '../lib/tx_console.js';
import { useOperatorAddress } from './useOperatorAddress.js';
import {
  bytesToHex,
  hexToBytes,
  combine as combineLagrange,
  make_public_key_from_compressed_slice,
  make_signature_from_compressed_slice,
  recover as recoverLagrange,
  sign_digest as blsSignDigest,
  verify_digest as blsVerifyDigest,
} from '../lib/crum_bls/index.js';
import { holdemShowdown } from '../lib/crum_pkr/hand_evaluator.js';
import { POKER_HOLDEM_ROUNDS } from '../lib/crum_pkr/index.js';
import { toChipUnits } from '../lib/constants.js';

export const FINAL_VERIFICATION_SIGNATURE_SCHEME = 'BLS12-381-FINAL-HAND-DIGEST-SCALAR-V1';
export const TABLE_AGGREGATE_PUBLIC_KEY_SIGNATURE_SCHEME = 'BLS12-381-TABLE-AGGREGATE-PUBLIC-KEY-V1';

export const SETTLER_ABI = parseAbi([
  'function startHand(uint256 lobby_id, uint256 table_id)',
  'function setTableAggregatePublicKey(uint256 lobby_id, uint256 table_id, bytes aggregate_public_key)',
  'function settleHand(uint256 lobby_id, uint256 table_id, uint256 hand_id, uint256 pot_size, uint256[] pot_split, uint256[] chips_balances, bytes digest, bytes aggregate_public_key) returns (uint256)',
]);

const textEncoder = new TextEncoder();

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function ensureHexPrefix(value) {
  const normalized = String(value ?? '');
  return normalized.startsWith('0x') ? normalized : `0x${normalized}`;
}

function appendSignatureToCalldata(calldata, signature) {
  return `${ensureHexPrefix(calldata)}${ensureHexPrefix(signature).slice(2)}`;
}

function tableAggregatePublicKeyCalldata({
  lobbyId,
  tableId,
  aggregatePublicKey,
}) {
  return encodeFunctionData({
    abi: SETTLER_ABI,
    functionName: 'setTableAggregatePublicKey',
    args: [
      BigInt(lobbyId),
      BigInt(tableId),
      ensureHexPrefix(aggregatePublicKey),
    ],
  });
}

function settlementCalldata({
  lobbyId,
  tableId,
  handId,
  settlementMessage,
  settlementDigest,
  aggregatePublicKey,
}) {
  const potSplit = settlementMessage.pot_size_per_player ?? [];
  const chipsBalances = settlementMessage.chips_balances ?? [];
  const potSize = potSplit.reduce((sum, amount) => sum + BigInt(amount), 0n);

  return encodeFunctionData({
    abi: SETTLER_ABI,
    functionName: 'settleHand',
    args: [
      BigInt(lobbyId ?? settlementMessage.lobby_id),
      BigInt(tableId ?? settlementMessage.table_id),
      BigInt(handId ?? settlementMessage.hand_id),
      potSize,
      potSplit.map((amount) => BigInt(amount)),
      chipsBalances.map((amount) => BigInt(amount)),
      ensureHexPrefix(settlementDigest),
      ensureHexPrefix(aggregatePublicKey),
    ],
  });
}

function hexPoint(bytes) {
  return bytesToHex(new Uint8Array(bytes), { prefix: true });
}

function normalizeAddress(value) {
  return value?.toLowerCase?.() ?? null;
}

function pointHex(point) {
  return point?.toRawBytes ? hexPoint(point.toRawBytes(true)) : ensureHexPrefix(point);
}

function cardsToStrings(cards) {
  return cards
    .filter(Boolean)
    .map((card) => card.toString());
}

function chipStacks(hand, winner = null, payout = 0) {
  const stacks = [...(hand?.betting_state?.player_chips ?? [])];
  if (winner != null && stacks[winner] != null) {
    stacks[winner] += payout;
  }
  return stacks;
}

export function buildFinalHandSettlement(hand, tableSeats = []) {
  if (!hand) {
    return {
      winner: null,
      winner_player_address: null,
      pot_size_per_player: [],
      chips_balances: [],
    };
  }

  const numPlayers = Number(hand.current_state?.num_players ?? tableSeats.length ?? 0);
  const activePlayers = hand.betting_state?.active_players ?? [];
  const payoutAmount = Number(hand.betting_state?.pot?.toString?.() ?? 0);
  const foldedWinner = activePlayers.filter(Boolean).length === 1
    ? activePlayers.findIndex(Boolean)
    : null;

  const payoutForWinner = (winner) => Array.from({ length: numPlayers }, (_, player) => (
    player === winner ? payoutAmount : 0
  ));

  let rawPotSplit = [];
  let rawBalances = [];
  let winner = null;

  if (foldedWinner != null) {
    winner = foldedWinner;
    rawPotSplit = payoutForWinner(foldedWinner);
    rawBalances = chipStacks(hand, foldedWinner, payoutAmount);
  } else {
    const deck = hand.get_poker_deck();
    const playerCards = hand.get_player_cards().map((cardSet) => {
      try {
        return cardsToStrings(deck.unmasked_cards(cardSet));
      } catch {
        return [];
      }
    });
    const communityCards = [];
    for (let round = 0; round < POKER_HOLDEM_ROUNDS; round += 1) {
      const cards = hand.get_community_cards(round);
      if (cards) {
        communityCards.push(...cardsToStrings(deck.unmasked_cards(cards)));
      }
    }

    const showdown = holdemShowdown(playerCards, communityCards, activePlayers);
    winner = showdown.winner;
    rawPotSplit = winner == null ? Array(numPlayers).fill(0) : payoutForWinner(winner);
    rawBalances = chipStacks(hand, winner, winner == null ? 0 : payoutAmount);
  }

  return {
    winner,
    winner_player_address: winner == null ? null : tableSeats[winner]?.playerAddress ?? null,
    pot_size_per_player: rawPotSplit.map((amt) => Number(toChipUnits(amt))),
    chips_balances: rawBalances.map((amt) => Number(toChipUnits(amt))),
  };
}

function finalTranscript({
  lobbyId,
  tableId,
  handId,
  hand,
  handSetup,
  handHistoryEntries,
  tableSeats,
}) {
  const handState = hand?.get_current_state?.();
  const bettingState = hand?.betting_state;
  const numPlayers = Number(hand?.current_state?.num_players ?? 0);

  return {
    type: 'PrivatePokerFinalHandTranscript',
    version: 1,
    lobby_id: lobbyId?.toString?.() ?? String(lobbyId ?? ''),
    table_id: tableId?.toString?.() ?? String(tableId ?? ''),
    hand_id: handId?.toString?.() ?? String(handId ?? ''),
    hand_setup: handSetup ?? null,
    state: {
      current_state: handState?.current_state ?? null,
      current_player: handState?.get_current_player?.() ?? null,
      current_round: hand?.current_state?.current_round ?? null,
      dealer_button: hand?.current_state?.dealer_button ?? null,
      num_players: numPlayers,
    },
    betting: {
      pot: bettingState?.pot?.toString?.() ?? '0',
      active_players: bettingState?.active_players ?? [],
      all_in_players: bettingState?.allin_players ?? [],
      player_chips: (bettingState?.player_chips ?? []).map((chips) => Number(chips)),
      player_bets: (bettingState?.player_bets ?? []).map((chips) => Number(chips)),
    },
    players: Array.from({ length: numPlayers }, (_, seat) => ({
      seat,
      address: normalizeAddress(tableSeats?.[seat]?.playerAddress),
      public_key: pointHex(hand?.player_keys?.[seat]),
    })),
    hand_history: (handHistoryEntries ?? []).map((entry) => ({
      sequence_number: Number(entry?.sequence_number ?? entry?.wire?.sequence_number ?? 0),
      from: Number(entry?.from ?? entry?.wire?.from ?? 0),
      wire: entry?.wire ?? null,
      action_signature: entry?.action_signature ?? null,
    })),
  };
}

function finalDigestPayload({ transcript, settlement, lobbyId, tableId, handId }) {
  const payload = textEncoder.encode(canonicalJson(transcript));
  const handDigest = keccak256(payload);
  const settlementMessage = {
    type: 'PrivatePokerFinalHandSettlement',
    version: 1,
    lobby_id: lobbyId?.toString?.() ?? String(lobbyId ?? ''),
    table_id: tableId?.toString?.() ?? String(tableId ?? ''),
    hand_id: handId?.toString?.() ?? String(handId ?? ''),
    hand_digest: handDigest,
    winner_player_address: normalizeAddress(settlement?.winner_player_address),
    pot_size_per_player: (settlement?.pot_size_per_player ?? []).map((chips) => Number(chips)),
    chips_balances: (settlement?.chips_balances ?? []).map((chips) => Number(chips)),
  };
  const settlementDigest = keccak256(textEncoder.encode(canonicalJson(settlementMessage)));
  const settlementSignatureDigest = settlementArgsDigest({
    lobbyId,
    tableId,
    handId,
    potSplit: settlementMessage.pot_size_per_player,
    chipsBalances: settlementMessage.chips_balances,
    digest: settlementDigest,
  });

  return {
    transcript,
    settlementMessage,
    finalHandDigest: handDigest,
    settlementDigest,
    settlementSignatureDigest,
    signaturePayload: hexToBytes(settlementSignatureDigest),
  };
}

function assertFinishedHand(hand) {
  if (!hand?.get_current_state?.().is_finished?.()) {
    throw new Error('Final verification requires a finished hand.');
  }
  const cheater = hand.verify_unmasking?.();
  if (cheater != null) {
    throw new Error(`Player cheated during unmasking ${cheater}`);
  }
}

function tablePublicKeyForSeat(tableSeats, publicKeyShares, seat) {
  const publicKey = tableSeats?.[seat]?.signaturePublicKey
    ?? publicKeyShares?.find((share) => Number(share?.signer_seat) === Number(seat))?.public_key;
  if (!publicKey) throw new Error(`Missing final signature public key for Player ${seat + 1}.`);
  return publicKey;
}

function decodePublicKey(publicKey) {
  return make_public_key_from_compressed_slice(hexToBytes(ensureHexPrefix(publicKey)));
}

function decodeSignature(signature) {
  return make_signature_from_compressed_slice(hexToBytes(ensureHexPrefix(signature)));
}

function assertSignedTranscriptPresent(handHistoryEntries) {
  if (!handHistoryEntries?.length) {
    throw new Error('Final verification requires a signed hand transcript.');
  }
}

function normalizeSignatureShares(signatureShares = []) {
  return [...signatureShares].sort((left, right) => (
    Number(left.signer_seat ?? 0) - Number(right.signer_seat ?? 0)
  ));
}

function normalizePublicKeyShares(publicKeyShares = []) {
  return [...publicKeyShares].sort((left, right) => (
    Number(left.signer_seat ?? 0) - Number(right.signer_seat ?? 0)
  ));
}

function assertContiguousShares(shares, label) {
  shares.forEach((share, index) => {
    const seat = Number(share?.signer_seat);
    if (seat !== index) {
      throw new Error(`${label} expected Player ${index + 1}.`);
    }
  });
}

function collectPublicKeyShares({
  tableSeats = [],
  publicKeyShares = [],
  signatureShares = [],
  currentSeatNo = null,
  publicKey = null,
}) {
  const bySeat = new Map();

  tableSeats.forEach((seat, index) => {
    if (seat?.signaturePublicKey) {
      bySeat.set(index, {
        signer_seat: index,
        public_key: ensureHexPrefix(seat.signaturePublicKey),
      });
    }
  });

  for (const share of [...publicKeyShares, ...signatureShares]) {
    if (share?.public_key == null || share?.signer_seat == null) continue;
    bySeat.set(Number(share.signer_seat), {
      signer_seat: Number(share.signer_seat),
      public_key: ensureHexPrefix(share.public_key),
    });
  }

  if (currentSeatNo != null && publicKey) {
    bySeat.set(Number(currentSeatNo), {
      signer_seat: Number(currentSeatNo),
      public_key: pointHex(publicKey),
    });
  }

  const ordered = normalizePublicKeyShares([...bySeat.values()]);
  assertContiguousShares(ordered, 'Table signature public key collection');
  return ordered;
}

function aggregateSignatureShares({
  tableSeats,
  publicKeyShares = [],
  signatureShares,
  signaturePayload,
  scheme = FINAL_VERIFICATION_SIGNATURE_SCHEME,
  expectedSignatureLabel = 'final verification',
}) {
  const ordered = normalizeSignatureShares(signatureShares);
  const orderedPublicKeyShares = normalizePublicKeyShares(publicKeyShares);
  const signatureSharePoints = [];
  const publicKeySharePoints = [];

  ordered.forEach((share, index) => {
    const seat = Number(share?.signer_seat);
    if (seat !== index) {
      throw new Error(`Final verification expected Player ${index + 1} signature.`);
    }
    if (share.scheme !== scheme) {
      throw new Error(`Unsupported ${expectedSignatureLabel} signature from Player ${seat + 1}.`);
    }

    const expectedPublicKey = ensureHexPrefix(
      tablePublicKeyForSeat(tableSeats, orderedPublicKeyShares, seat),
    ).toLowerCase();
    if (ensureHexPrefix(share.public_key).toLowerCase() !== expectedPublicKey) {
      throw new Error(`${expectedSignatureLabel} public key mismatch for Player ${seat + 1}.`);
    }

    const publicKey = decodePublicKey(share.public_key);
    const signature = decodeSignature(share.signature);
    if (!blsVerifyDigest(signaturePayload, publicKey, signature)) {
      throw new Error(`Invalid ${expectedSignatureLabel} signature from Player ${seat + 1}.`);
    }

    const label = BigInt(seat + 1);
    signatureSharePoints.push([label, signature]);
    publicKeySharePoints.push([label, publicKey]);
  });

  const aggregateSignature = ordered.length > 0 ? combineLagrange(signatureSharePoints) : null;
  const aggregatePublicKey = ordered.length > 0 ? recoverLagrange(publicKeySharePoints) : null;

  if (
    aggregateSignature
    && aggregatePublicKey
    && !blsVerifyDigest(signaturePayload, aggregatePublicKey, aggregateSignature)
  ) {
    throw new Error(`Invalid Lagrange aggregate ${expectedSignatureLabel} signature.`);
  }

  return {
    signatureShares: ordered,
    signerSeats: ordered.map((share) => Number(share.signer_seat)),
    aggregateSignature: aggregateSignature ? hexPoint(aggregateSignature.toRawBytes(true)) : null,
    aggregatePublicKey: aggregatePublicKey ? hexPoint(aggregatePublicKey.toRawBytes(true)) : null,
  };
}

export function settlementContractArgs({
  lobbyId,
  tableId,
  handId,
  finalVerification,
}) {
  const settlement = finalVerification?.settlementMessage;
  if (!settlement) throw new Error('Missing final hand settlement.');
  if (!finalVerification?.complete) throw new Error('Final hand settlement is not complete.');
  if (!finalVerification?.settlementDigest) throw new Error('Missing final settlement digest.');
  if (!finalVerification?.aggregateSignature) throw new Error('Missing aggregate final settlement signature.');
  if (!finalVerification?.aggregatePublicKey) throw new Error('Missing aggregate final settlement public key.');

  const potSplit = settlement.pot_size_per_player ?? [];
  const chipsBalances = settlement.chips_balances ?? [];
  const potSize = potSplit.reduce((sum, amount) => sum + BigInt(amount), 0n);

  return [
    BigInt(lobbyId ?? settlement.lobby_id),
    BigInt(tableId ?? settlement.table_id),
    BigInt(handId ?? settlement.hand_id),
    potSize,
    potSplit.map((amount) => BigInt(amount)),
    chipsBalances.map((amount) => BigInt(amount)),
    ensureHexPrefix(finalVerification.settlementDigest),
    ensureHexPrefix(finalVerification.aggregatePublicKey),
  ];
}

export function settlementArgsDigest({
  lobbyId,
  tableId,
  handId,
  potSplit = [],
  chipsBalances = [],
  digest,
}) {
  const normalizedPotSplit = potSplit.map((amount) => BigInt(amount));
  const normalizedChipsBalances = chipsBalances.map((amount) => BigInt(amount));
  const potSize = normalizedPotSplit.reduce((sum, amount) => sum + amount, 0n);
  return keccak256(encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256[]' },
          { type: 'uint256[]' },
          { type: 'bytes' },
        ],
      },
    ],
    [
      [
        BigInt(lobbyId),
        BigInt(tableId),
        BigInt(handId),
        potSize,
        normalizedPotSplit,
        normalizedChipsBalances,
        ensureHexPrefix(digest),
      ],
    ],
  ));
}

export function tableAggregatePublicKeyDigest({
  lobbyId,
  tableId,
  aggregatePublicKey,
}) {
  return keccak256(encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'bytes' },
        ],
      },
    ],
    [
      [
        BigInt(lobbyId),
        BigInt(tableId),
        ensureHexPrefix(aggregatePublicKey),
      ],
    ],
  ));
}

function isAlreadySubmittedError(error) {
  const message = [
    error?.shortMessage,
    error?.message,
    error?.details,
  ].filter(Boolean).join('\n');

  return /TABLE_ALREADY_STARTED|ALREADY_READY/i.test(message);
}

export function tableAggregatePublicKey(tableSeats = []) {
  const publicKeyShares = tableSeats.map((seat, index) => {
    if (!seat?.playerAddress) {
      throw new Error(`Missing player for seat ${index + 1}.`);
    }
    if (!seat?.signaturePublicKey) {
      throw new Error(`Missing signature public key for Player ${index + 1}.`);
    }
    return [
      BigInt(index + 1),
      decodePublicKey(seat.signaturePublicKey),
    ];
  });

  return hexPoint(recoverLagrange(publicKeyShares).toRawBytes(true));
}

function tableAggregatePublicKeyFromShares(publicKeyShares = []) {
  const publicKeySharePoints = normalizePublicKeyShares(publicKeyShares).map((share, index) => {
    if (Number(share.signer_seat) !== index) {
      throw new Error(`Table aggregate public key expected Player ${index + 1} signature key.`);
    }
    return [
      BigInt(index + 1),
      decodePublicKey(share.public_key),
    ];
  });

  return hexPoint(recoverLagrange(publicKeySharePoints).toRawBytes(true));
}

export function tableAggregatePublicKeyContractArgs({
  lobbyId,
  tableId,
  tableAggregateVerification,
}) {
  if (!tableAggregateVerification?.complete) {
    throw new Error('Table aggregate public key signature is not complete.');
  }
  if (!tableAggregateVerification?.aggregatePublicKey) {
    throw new Error('Missing table aggregate public key.');
  }
  if (!tableAggregateVerification?.aggregateSignature) {
    throw new Error('Missing aggregate table public key signature.');
  }

  return [
    BigInt(lobbyId),
    BigInt(tableId),
    ensureHexPrefix(tableAggregateVerification.aggregatePublicKey),
  ];
}

export function assertValidTableAggregatePublicKeyVerification({
  lobbyId,
  tableId,
  tableSeats,
  tableAggregateVerification,
}) {
  tableAggregatePublicKeyContractArgs({
    lobbyId,
    tableId,
    tableAggregateVerification,
  });

  const publicKeyShares = collectPublicKeyShares({
    tableSeats,
    publicKeyShares: tableAggregateVerification.publicKeyShares,
    signatureShares: tableAggregateVerification.signatureShares,
  });
  const expectedAggregatePublicKey = tableAggregatePublicKeyFromShares(publicKeyShares);
  const actualAggregatePublicKey = ensureHexPrefix(tableAggregateVerification.aggregatePublicKey);
  if (actualAggregatePublicKey.toLowerCase() !== expectedAggregatePublicKey.toLowerCase()) {
    throw new Error('Table aggregate public key preflight failed: aggregate public key mismatch.');
  }

  const expectedDigest = tableAggregatePublicKeyDigest({
    lobbyId,
    tableId,
    aggregatePublicKey: expectedAggregatePublicKey,
  });
  const actualDigest = ensureHexPrefix(tableAggregateVerification.tableAggregatePublicKeyDigest);
  if (actualDigest.toLowerCase() !== expectedDigest.toLowerCase()) {
    throw new Error('Table aggregate public key preflight failed: digest mismatch.');
  }

  const signaturePayload = hexToBytes(tableAggregatePublicKeyCalldata({
    lobbyId,
    tableId,
    aggregatePublicKey: expectedAggregatePublicKey,
  }));
  const verified = aggregateSignatureShares({
    tableSeats,
    publicKeyShares,
    signatureShares: tableAggregateVerification.signatureShares,
    signaturePayload,
    scheme: TABLE_AGGREGATE_PUBLIC_KEY_SIGNATURE_SCHEME,
    expectedSignatureLabel: 'table aggregate public key',
  });

  const expectedSignerCount = tableSeats.length;
  if (verified.signatureShares.length !== expectedSignerCount) {
    throw new Error(`Table aggregate public key preflight failed: expected ${expectedSignerCount} signatures.`);
  }

  const expectedAggregateSignature = ensureHexPrefix(tableAggregateVerification.aggregateSignature);
  if (ensureHexPrefix(verified.aggregateSignature).toLowerCase() !== expectedAggregateSignature.toLowerCase()) {
    throw new Error('Table aggregate public key preflight failed: aggregate signature mismatch.');
  }

  if (ensureHexPrefix(verified.aggregatePublicKey).toLowerCase() !== expectedAggregatePublicKey.toLowerCase()) {
    throw new Error('Table aggregate public key preflight failed: recovered aggregate public key mismatch.');
  }

  const aggregatePublicKey = decodePublicKey(expectedAggregatePublicKey);
  const aggregateSignature = decodeSignature(expectedAggregateSignature);
  if (!blsVerifyDigest(signaturePayload, aggregatePublicKey, aggregateSignature)) {
    throw new Error('Table aggregate public key preflight failed: invalid aggregate signature.');
  }

  return {
    aggregatePublicKey: expectedAggregatePublicKey,
    aggregateSignature: expectedAggregateSignature,
    digest: expectedDigest,
    publicKeyShares,
    signerSeats: verified.signerSeats,
  };
}

export function buildNextTableAggregatePublicKeyVerification({
  lobbyId,
  tableId,
  tableSeats,
  publicKeyShares = [],
  signatureShares = [],
  currentSeatNo,
  signingKey,
  publicKey,
}) {
  const numPlayers = tableSeats.length;
  const previousPublicKeyShares = collectPublicKeyShares({
    tableSeats,
    publicKeyShares,
    signatureShares,
  });
  const shouldAddPublicKey = publicKey != null
    && Number(currentSeatNo) === previousPublicKeyShares.length
    && !previousPublicKeyShares.some((share) => (
      Number(share.signer_seat) === Number(currentSeatNo)
    ));
  const nextPublicKeyShares = collectPublicKeyShares({
    tableSeats,
    publicKeyShares,
    signatureShares,
    currentSeatNo: shouldAddPublicKey ? currentSeatNo : null,
    publicKey: shouldAddPublicKey ? publicKey : null,
  });
  const addedPublicKey = shouldAddPublicKey;
  const nextPublicKeySeat = nextPublicKeyShares.length;
  if (nextPublicKeySeat < numPlayers) {
    return {
      publicKeyShares: nextPublicKeyShares,
      signatureShares: normalizeSignatureShares(signatureShares),
      signerSeats: [],
      aggregateSignature: null,
      aggregatePublicKey: null,
      tableAggregatePublicKeyDigest: null,
      signaturePayload: null,
      nextSeat: nextPublicKeySeat,
      complete: false,
      signed: false,
      publicKeyAdded: addedPublicKey,
    };
  }

  const aggregatePublicKey = tableAggregatePublicKeyFromShares(nextPublicKeyShares);
  const digest = tableAggregatePublicKeyDigest({
    lobbyId,
    tableId,
    aggregatePublicKey,
  });
  const signaturePayload = hexToBytes(tableAggregatePublicKeyCalldata({
    lobbyId,
    tableId,
    aggregatePublicKey,
  }));
  const verified = aggregateSignatureShares({
    tableSeats,
    publicKeyShares: nextPublicKeyShares,
    signatureShares,
    signaturePayload,
    scheme: TABLE_AGGREGATE_PUBLIC_KEY_SIGNATURE_SCHEME,
    expectedSignatureLabel: 'table aggregate public key',
  });

  const nextSeat = verified.signatureShares.length;
  if (nextSeat >= numPlayers) {
    return {
      ...verified,
      publicKeyShares: nextPublicKeyShares,
      aggregatePublicKey,
      tableAggregatePublicKeyDigest: digest,
      signaturePayload,
      nextSeat,
      complete: true,
      signed: false,
    };
  }
  if (Number(currentSeatNo) !== nextSeat) {
    return {
      ...verified,
      publicKeyShares: nextPublicKeyShares,
      aggregatePublicKey,
      tableAggregatePublicKeyDigest: digest,
      signaturePayload,
      nextSeat,
      complete: false,
      signed: false,
      publicKeyAdded: addedPublicKey,
    };
  }

  const finalPublicKey = publicKey ?? decodePublicKey(
    tablePublicKeyForSeat(tableSeats, nextPublicKeyShares, currentSeatNo),
  );
  const signature = blsSignDigest(signaturePayload, signingKey);
  const nextSignatureShares = [
    ...verified.signatureShares,
    {
      scheme: TABLE_AGGREGATE_PUBLIC_KEY_SIGNATURE_SCHEME,
      signer_seat: Number(currentSeatNo),
      public_key: pointHex(finalPublicKey),
      signature: hexPoint(signature.toRawBytes(true)),
    },
  ];
  const nextVerified = aggregateSignatureShares({
    tableSeats,
    publicKeyShares: nextPublicKeyShares,
    signatureShares: nextSignatureShares,
    signaturePayload,
    scheme: TABLE_AGGREGATE_PUBLIC_KEY_SIGNATURE_SCHEME,
    expectedSignatureLabel: 'table aggregate public key',
  });

  return {
    ...nextVerified,
    publicKeyShares: nextPublicKeyShares,
    aggregatePublicKey,
    tableAggregatePublicKeyDigest: digest,
    signaturePayload,
    nextSeat: nextVerified.signatureShares.length,
    complete: nextVerified.signatureShares.length === numPlayers,
    signed: true,
  };
}

export function buildNextFinalVerification({
  lobbyId,
  tableId,
  handId,
  hand,
  handSetup,
  handHistoryEntries,
  tableSeats,
  publicKeyShares = [],
  settlement = buildFinalHandSettlement(hand, tableSeats),
  signatureShares = [],
  currentSeatNo,
  signingKey,
  publicKey,
}) {
  assertFinishedHand(hand);
  assertSignedTranscriptPresent(handHistoryEntries);

  const transcript = finalTranscript({
    lobbyId,
    tableId,
    handId,
    hand,
    handSetup,
    handHistoryEntries,
    tableSeats,
  });
  const digestPayload = finalDigestPayload({
    transcript,
    settlement,
    lobbyId,
    tableId,
    handId,
  });
  const nextPublicKeyShares = collectPublicKeyShares({
    tableSeats,
    publicKeyShares,
    signatureShares,
    currentSeatNo,
    publicKey,
  });
  const aggregatePublicKey = tableAggregatePublicKeyFromShares(nextPublicKeyShares);
  const signaturePayload = hexToBytes(settlementCalldata({
    lobbyId,
    tableId,
    handId,
    settlementMessage: digestPayload.settlementMessage,
    settlementDigest: digestPayload.settlementDigest,
    aggregatePublicKey,
  }));
  const signedDigestPayload = {
    ...digestPayload,
    signaturePayload,
  };
  const verified = aggregateSignatureShares({
    tableSeats,
    publicKeyShares: nextPublicKeyShares,
    signatureShares,
    signaturePayload,
  });

  const nextSeat = verified.signatureShares.length;
  const numPlayers = Number(hand?.current_state?.num_players ?? 0);
  if (nextSeat >= numPlayers) {
    return {
      ...signedDigestPayload,
      ...verified,
      publicKeyShares: nextPublicKeyShares,
      nextSeat,
      complete: true,
      signed: false,
    };
  }
  if (Number(currentSeatNo) !== nextSeat) {
    return {
      ...signedDigestPayload,
      ...verified,
      publicKeyShares: nextPublicKeyShares,
      nextSeat,
      complete: false,
      signed: false,
    };
  }

  const finalPublicKey = publicKey ?? decodePublicKey(
    tablePublicKeyForSeat(tableSeats, nextPublicKeyShares, currentSeatNo),
  );
  const signature = blsSignDigest(signaturePayload, signingKey);
  const nextSignatureShares = [
    ...verified.signatureShares,
    {
      scheme: FINAL_VERIFICATION_SIGNATURE_SCHEME,
      signer_seat: Number(currentSeatNo),
      public_key: pointHex(finalPublicKey),
      signature: hexPoint(signature.toRawBytes(true)),
    },
  ];
  const nextVerified = aggregateSignatureShares({
    tableSeats,
    publicKeyShares: nextPublicKeyShares,
    signatureShares: nextSignatureShares,
    signaturePayload,
  });

  return {
    ...signedDigestPayload,
    ...nextVerified,
    publicKeyShares: nextPublicKeyShares,
    nextSeat: nextVerified.signatureShares.length,
    complete: nextVerified.signatureShares.length === numPlayers,
    signed: true,
  };
}

export function useFinalVerification({ onOperatorTopUp } = {}) {
  const { address } = useConnection();
  const { mutateAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractFromOperator, writeTransactionFromOperator } = useOperatorAddress({ onOperatorTopUp });

  const buildNextFinalVerificationCallback = useCallback((args) => (
    buildNextFinalVerification(args)
  ), []);
  const buildNextTableAggregatePublicKeyVerificationCallback = useCallback((args) => (
    buildNextTableAggregatePublicKeyVerification(args)
  ), []);

  const writePrivatePokerContract = useCallback(async ({
    functionName,
    args,
    signature,
    operatorPrivateKey,
  }) => {
    let hash;
    try {
      const data = signature
        ? appendSignatureToCalldata(encodeFunctionData({
          abi: SETTLER_ABI,
          functionName,
          args,
        }), signature)
        : null;

      if (operatorPrivateKey) {
        console.info(`writeContract [from Operator] ${PRIVATE_POKER_CONTRACT_ADDRESS} ${functionName}:`, args);
        hash = data
          ? await writeTransactionFromOperator({
            operatorPrivateKey,
            to: PRIVATE_POKER_CONTRACT_ADDRESS,
            data,
            functionName,
            args,
          })
          : await writeContractFromOperator({
            operatorPrivateKey,
            contract: PRIVATE_POKER_CONTRACT_ADDRESS,
            abi: SETTLER_ABI,
            functionName,
            args,
          });
        await waitForLoggedTransactionReceipt({
          hash,
          functionName,
          contract: PRIVATE_POKER_CONTRACT_ADDRESS,
          args,
        });
        return hash;
      }

      console.info(`writeContract [from Wallet] ${PRIVATE_POKER_CONTRACT_ADDRESS} ${functionName}:`, args);
      const overrides = address
        ? await getBufferedGasOverrides(publicPokerClient, {
          address: PRIVATE_POKER_CONTRACT_ADDRESS,
          abi: SETTLER_ABI,
          functionName,
          args,
          account: address,
        })
        : {};

      hash = data
        ? await sendTransactionAsync({
          to: PRIVATE_POKER_CONTRACT_ADDRESS,
          data,
          ...overrides,
        })
        : await mutateAsync({
          address: PRIVATE_POKER_CONTRACT_ADDRESS,
          abi: SETTLER_ABI,
          functionName,
          args,
          ...overrides,
        });
      await waitForLoggedTransactionReceipt({
        hash,
        functionName,
        contract: PRIVATE_POKER_CONTRACT_ADDRESS,
        args,
      });
      return hash;
    } catch (error) {
      if (!hash) {
        logWriteTransactionError({
          functionName,
          contract: PRIVATE_POKER_CONTRACT_ADDRESS,
          args,
          error,
        });
      }
      throw error;
    }
  }, [address, mutateAsync, sendTransactionAsync, writeContractFromOperator, writeTransactionFromOperator]);

  const submitFinalHandOnChain = useCallback(async ({
    lobbyId,
    tableId,
    handId,
    finalVerification,
    operatorPrivateKey,
  }) => {
    const args = settlementContractArgs({
      lobbyId,
      tableId,
      handId,
      finalVerification,
    });

    return writePrivatePokerContract({
      functionName: 'settleHand',
      args,
      signature: finalVerification.aggregateSignature,
      operatorPrivateKey,
    });
  }, [writePrivatePokerContract]);

  const setTableAggregatePublicKeyOnChain = useCallback(async ({
    lobbyId,
    tableId,
    tableSeats,
    tableAggregateVerification,
    operatorPrivateKey,
  }) => {
    const preflight = assertValidTableAggregatePublicKeyVerification({
      lobbyId,
      tableId,
      tableSeats,
      tableAggregateVerification,
    });
    const args = tableAggregatePublicKeyContractArgs({
      lobbyId,
      tableId,
      tableAggregateVerification,
    });
    console.log('[FinalVerification] setTableAggregatePublicKey preflight passed', preflight);
    try {
      const hash = await writePrivatePokerContract({
        functionName: 'setTableAggregatePublicKey',
        args,
        signature: tableAggregateVerification.aggregateSignature,
        operatorPrivateKey,
      });
      return { hash, aggregatePublicKey: tableAggregateVerification.aggregatePublicKey };
    } catch (error) {
      if (isAlreadySubmittedError(error)) {
        return { hash: null, aggregatePublicKey: tableAggregateVerification.aggregatePublicKey };
      }
      throw error;
    }
  }, [writePrivatePokerContract]);

  const startHandOnChain = useCallback(async ({
    lobbyId,
    tableId,
    operatorPrivateKey,
  }) => (
    writePrivatePokerContract({
      functionName: 'startHand',
      args: [BigInt(lobbyId), BigInt(tableId)],
      operatorPrivateKey,
    })
  ), [writePrivatePokerContract]);

  return {
    buildNextFinalVerification: buildNextFinalVerificationCallback,
    buildNextTableAggregatePublicKeyVerification: buildNextTableAggregatePublicKeyVerificationCallback,
    setTableAggregatePublicKeyOnChain,
    startHandOnChain,
    submitFinalHandOnChain,
  };
}
