import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  G1,
  bytesToHex,
  hexToBytes,
  make_public_key_from_compressed_slice,
  make_public_key_from_signing_key,
  make_signature_from_compressed_slice,
  make_signing_key_from_seed,
  mask as blsMask,
  sign as blsSign,
  verify as blsVerify,
} from 'privatepoker-hooks/crypto/bls';
import {
  PokerAction,
  PokerActionEnvelopeWire,
  PokerClientState,
  poker_action_wire_to_submit,
} from 'privatepoker-hooks/poker/core/crum_net';
import {
  POKER_HAND_STATE_BET,
  POKER_HAND_STATE_BIG_BLIND,
  POKER_HAND_STATE_FINISHED,
  POKER_HAND_STATE_SMALL_BLIND,
  POKER_HOLDEM_ROUNDS,
  PokerTable,
  communityCardConsoleLines,
} from 'privatepoker-hooks/poker/core/crum_pkr';
import { holdemShowdown } from 'privatepoker-hooks/poker/core/crum_pkr/hand_evaluator';
import { useCountdown } from 'privatepoker-hooks/react/hooks/useCountdown';
import { buildFinalHandSettlement, useFinalVerification } from 'privatepoker-hooks/react/hooks/useFinalVerification';
import { VirtualTokenRing } from 'privatepoker-hooks/react/hooks/useTokenRing.js';
import { formatChainError } from 'privatepoker-hooks/blockchain/errors/ChainErrors.js';
import {
  TABLE_PROTOCOL_STATE_HAND_IN_PROGRESS,
  TABLE_PROTOCOL_STATE_HAND_DISPUTED,
  TABLE_PROTOCOL_STATE_START_HAND,
  TABLE_PROTOCOL_STATE_TABLE_AGGREGATE_PUBLIC_KEY,
  TABLE_PROTOCOL_STATE_TABLE_COMPLETE,
  TABLE_PROTOCOL_STATE_SETTLE_HAND,
  TableProtocolState,
  tableProtocolStateType,
} from 'privatepoker-hooks/poker/table/TableProtocolState.js';
import { getBlindsForBuyin } from 'privatepoker-hooks/poker/lobby/Stakes';
import { fromChipUnits } from 'privatepoker-hooks/config/constants';

const HISTORY_MESSAGE = 'History';
const CHAT_MESSAGE = 'ChatMessage';
const SETTLE_HAND_MESSAGE = 'SettleHand';
const START_HAND_MESSAGE = 'StartHand';
const TABLE_AGGREGATE_PUBLIC_KEY_MESSAGE = 'TableAggregatePublicKey';
const TABLE_COMPLETE_MESSAGE = TABLE_PROTOCOL_STATE_TABLE_COMPLETE;
const ACTION_SIGNATURE_SCHEME = 'BLS12-381-G2-PK-G1-SIG';
const BETTING_UI_STATES = new Set(['PreFlop', 'Flop', 'Turn', 'River']);
const BAD_UNMASK_G1 = G1.BASE.toRawBytes(true);
const HAND_ID = 1;
const textEncoder = new TextEncoder();

function shallowEqual(left, right) {
  const leftKeys = Object.keys(left ?? {});
  const rightKeys = Object.keys(right ?? {});
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue === rightValue) return true;
    if (typeof leftValue === 'object' && typeof rightValue === 'object') {
      return JSON.stringify(leftValue) === JSON.stringify(rightValue);
    }
    return false;
  });
}

function seatNumberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function uniqueSeatNumbers(seats, seatCount = 0) {
  const maxSeats = Number(seatCount || 0);
  return [...new Set((seats ?? [])
    .map(seatNumberOrNull)
    .filter((seat) => (
      seat != null
      && seat >= 0
      && (!maxSeats || seat < maxSeats)
    )))];
}

function createCryptoRng() {
  return () => {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    return bytes[0] / 0x100000000;
  };
}

function hexPoint(bytes) {
  return bytesToHex(bytes, { prefix: true });
}

function bytesPoint(hex) {
  return hexToBytes(hex);
}

function encodeCardSet(cards) {
  return cards.map(hexPoint);
}

function decodeCardSet(cards) {
  return cards.map(bytesPoint);
}

function refreshWireSubmit(wire) {
  if (!wire?.action) return wire;
  wire.submit = poker_action_wire_to_submit(wire.action);
  return wire;
}

function corruptShuffleTrace(wire) {
  const traces = wire?.action?.traces;
  if (!Array.isArray(traces) || traces.length === 0) return false;

  const firstTrace = traces[0];
  const beforeIndex = Array.isArray(firstTrace)
    ? firstTrace[1]
    : firstTrace.claimed_before_index;
  const nextBeforeIndex = (Number(beforeIndex ?? 0) + 1) % Math.max(traces.length, 1);

  if (Array.isArray(firstTrace)) {
    firstTrace[1] = nextBeforeIndex;
  } else {
    firstTrace.claimed_before_index = nextBeforeIndex;
  }
  refreshWireSubmit(wire);
  return true;
}

function corruptPublicKey(wire, game) {
  if (wire?.action?.type !== 'SubmitPublicKey') return false;
  const badPublicKey = game?.publicKey?.negate?.();
  if (!badPublicKey?.toRawBytes) return false;

  wire.action.public_key_g2_compressed = badPublicKey.toRawBytes(true);
  refreshWireSubmit(wire);
  return true;
}

function replaceFirstCard(cardSets) {
  if (!Array.isArray(cardSets)) return false;
  for (const cardSet of cardSets) {
    if (Array.isArray(cardSet) && cardSet.length > 0) {
      cardSet[0] = BAD_UNMASK_G1;
      return true;
    }
  }
  return false;
}

function corruptUnmaskWire(wire) {
  if (!wire?.action) return false;

  if (wire.action.type === 'SubmitCommunityCards') {
    if (!Array.isArray(wire.action.cards_g1_compressed) || wire.action.cards_g1_compressed.length === 0) {
      return false;
    }
    wire.action.cards_g1_compressed[0] = BAD_UNMASK_G1;
    refreshWireSubmit(wire);
    return true;
  }

  if (
    wire.action.type === 'SubmitPlayerCards'
    || wire.action.type === 'SubmitShowdownCards'
  ) {
    const changed = replaceFirstCard(wire.action.player_cards_g1_compressed);
    if (changed) refreshWireSubmit(wire);
    return changed;
  }

  return false;
}

function encodeWire(wire) {
  const encoded = {
    table_id: wire.table_id,
    hand_id: wire.hand_id,
    from: wire.from,
    sequence: wire.sequence,
    sequence_number: wire.sequence_number ?? null,
    expected_state: wire.expected_state,
    log_lines: wire.log_lines,
  };

  if (wire.nop) {
    return {
      ...encoded,
      nop: wire.nop,
    };
  }

  const action = wire.action;
  encoded.action = { type: action.type, player: action.player };

  switch (action.type) {
    case 'SubmitShuffledDeck':
      encoded.action.deck_g1_compressed = encodeCardSet(action.deck_g1_compressed);
      break;
    case 'SubmitPlayerCards':
    case 'SubmitShowdownCards':
      encoded.action.player_cards_g1_compressed = action.player_cards_g1_compressed.map(encodeCardSet);
      break;
    case 'SubmitCommunityCards':
      encoded.action.round = action.round;
      encoded.action.cards_g1_compressed = encodeCardSet(action.cards_g1_compressed);
      break;
    case 'SubmitBet':
      encoded.action.amount = action.amount;
      break;
    case 'SubmitPublicKey':
      encoded.action.public_key_g2_compressed = hexPoint(action.public_key_g2_compressed);
      encoded.action.traces = action.traces;
      break;
    default:
      break;
  }

  encoded.submit = poker_action_wire_to_submit(encoded.action);
  delete encoded.action;

  return encoded;
}

function decodeWire(encoded) {
  if (encoded.nop) {
    const wire = new PokerActionEnvelopeWire({
      table_id: encoded.table_id,
      hand_id: encoded.hand_id,
      from: encoded.from,
      sequence: encoded.sequence,
      sequence_number: encoded.sequence_number ?? null,
      expected_state: encoded.expected_state,
      nop: encoded.nop,
      log_lines: encoded.log_lines ?? [],
    });
    return wire;
  }

  const action = encoded.action ? { ...encoded.action } : null;

  if (action) {
    switch (action.type) {
      case 'SubmitShuffledDeck':
        action.deck_g1_compressed = decodeCardSet(action.deck_g1_compressed);
        break;
      case 'SubmitPlayerCards':
      case 'SubmitShowdownCards':
        action.player_cards_g1_compressed = action.player_cards_g1_compressed.map(decodeCardSet);
        break;
      case 'SubmitCommunityCards':
        action.cards_g1_compressed = decodeCardSet(action.cards_g1_compressed);
        break;
      case 'SubmitPublicKey':
        action.public_key_g2_compressed = bytesPoint(action.public_key_g2_compressed);
        break;
      default:
        break;
    }
  }

  return new PokerActionEnvelopeWire({
    table_id: encoded.table_id,
    hand_id: encoded.hand_id,
    from: encoded.from,
    sequence: encoded.sequence,
    sequence_number: encoded.sequence_number ?? null,
    expected_state: encoded.expected_state,
    action,
    submit: action ? encoded.submit : decodeSubmit(encoded.submit),
    log_lines: encoded.log_lines ?? [],
  });
}

function decodeSubmit(submit) {
  if (!submit) return null;
  const args = [...(submit.args ?? submit.data?.args ?? [])];

  switch (submit.method) {
    case 'submit_shuffled_deck':
      args[1] = decodeCardSet(args[1]);
      break;
    case 'submit_player_cards':
    case 'submit_player_cards_showdown':
      args[1] = args[1].map(decodeCardSet);
      break;
    case 'submit_community_cards':
      args[2] = decodeCardSet(args[2]);
      break;
    case 'submit_public_key':
      args[1] = bytesPoint(args[1]);
      break;
    default:
      break;
  }

  return {
    method: submit.method,
    args,
  };
}

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
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function ensureHexPrefix(value) {
  const normalized = String(value ?? '');
  return normalized.startsWith('0x') ? normalized : `0x${normalized}`;
}

function historyEntryPayload(wire) {
  return textEncoder.encode(canonicalJson({
    type: 'PokerHandAction',
    wire,
  }));
}

function wireHistoryKey(wire) {
  if (!wire) return '';
  return [
    wire.hand_id,
    wire.sequence_number ?? '',
    wire.from ?? '',
    wire.sequence ?? '',
    wire.nop ? 'nop' : wire.submit?.method ?? wire.action?.type ?? 'action',
  ].join(':');
}

function tableSequenceNumber(game) {
  return Number(game?.clientState?.table?.sequence_number ?? 0);
}

function handHistorySequenceNumber(historyEntries = []) {
  return Math.max(
    0,
    ...historyEntries.map((entry) => Number(entry?.sequence_number ?? entry?.wire?.sequence_number ?? 0)),
  );
}

function handHistoryTipKey({ tableId, handId, historyEntries = [] } = {}) {
  const orderedEntries = [...historyEntries]
    .sort((left, right) => Number(left.sequence_number ?? 0) - Number(right.sequence_number ?? 0));
  const lastEntry = orderedEntries.at(-1);
  return [
    tableId ?? '',
    handId ?? '',
    handHistorySequenceNumber(orderedEntries),
    orderedEntries.length,
    wireHistoryKey(lastEntry?.wire),
  ].join(':');
}

function makePokerTable(numPlayers, buyIn, smallBlind) {
  const numericBuyIn = Number(buyIn);
  const numericSmallBlind = Number(smallBlind);

  if (
    !numPlayers ||
    !Number.isSafeInteger(numericBuyIn) ||
    numericBuyIn < 0 ||
    !Number.isSafeInteger(numericSmallBlind) ||
    numericSmallBlind < 0
  ) {
    return null;
  }

  const table = PokerTable.new(numPlayers, POKER_HOLDEM_ROUNDS);
  for (let player = 1; player <= numPlayers; player += 1) {
    table.join(player);
  }

  // Strictly pass numeric primitive integers
  table.start_hand(Array(numPlayers).fill(numericBuyIn), numericSmallBlind, 0);
  return table;
}

function cardsToStrings(cards) {
  return cards
    .filter(Boolean)
    .map((card) => card.toString());
}

function safeCallAmount(hand, player) {
  try {
    return hand.get_call_amount_required(player);
  } catch {
    return 0;
  }
}

function safeChipsRemaining(hand, player) {
  try {
    return hand.get_chips_remaining(player);
  } catch {
    return 0;
  }
}

function chipStacks(hand, winner = null, payout = 0) {
  const stacks = [...(hand?.betting_state?.player_chips ?? [])];
  if (winner != null && stacks[winner] != null) {
    stacks[winner] += payout;
  }
  return stacks;
}

function finalHandStacks(hand) {
  if (!hand) return [];
  const activePlayers = hand.betting_state?.active_players ?? [];
  const payoutAmount = Number(hand.betting_state?.pot?.toString?.() ?? 0);
  const foldedWinner = activePlayers.filter(Boolean).length === 1
    ? activePlayers.findIndex(Boolean)
    : null;

  if (foldedWinner != null) {
    return chipStacks(hand, foldedWinner, payoutAmount);
  }

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
  return chipStacks(hand, showdown.winner, showdown.winner == null ? 0 : payoutAmount);
}

function nextDealerSeatNumber(pokerTable) {
  const maxPlayers = pokerTable?.get_max_players?.() ?? 0;
  if (!maxPlayers) return 0;
  return ((pokerTable.dealer_button ?? 0) + 1) % maxPlayers;
}

function chipStackSize(chips, buyIn) {
  if (!buyIn) return 'Medium';
  if (chips <= buyIn * 0.5) return 'Small';
  if (chips <= buyIn) return 'Medium';
  if (chips <= buyIn * 1.5) return 'Big';
  return 'ExtraLarge';
}

function chipStackSizes(stacks, buyIn) {
  return stacks.map((chips) => chipStackSize(chips, buyIn));
}

function tableViewPatch(clientState, signingKey, viewerSeatNo = null) {
  const hand = clientState?.current_hand();
  if (!hand) return {};
  const patch = clientState.table.to_display_data(viewerSeatNo, signingKey).current_hand;
  const activePlayers = patch.active_players ?? [];
  const isShowdownState = ['UnmaskShowdown', 'SubmitPublicKey', 'Finished'].includes(patch.state_type);
  const isPokerRulesShowdown = activePlayers.filter(Boolean).length > 1;
  const playerCardsBySeat = Object.fromEntries(
    Object.entries(patch.player_cards_by_seat ?? {}).map(([seat, cards]) => (
      activePlayers[Number(seat)] === false || (isShowdownState && !isPokerRulesShowdown)
        ? [seat, []]
        : [seat, cards]
    )),
  );

  return {
    ...patch,
    own_player_cards: activePlayers[viewerSeatNo] === false ? [] : patch.own_player_cards,
    player_cards_by_seat: playerCardsBySeat,
  };
}

function streetName(round) {
  switch (round) {
    case 0:
      return 'PreFlop';
    case 1:
      return 'Flop';
    case 2:
      return 'Turn';
    case 3:
      return 'River';
    default:
      return 'UnknownStreet';
  }
}

function eventRoundName(round) {
  switch (round) {
    case 0:
      return 'Blinds';
    case 1:
      return 'PreFlop';
    case 2:
      return 'Flop';
    case 3:
      return 'Turn';
    case 4:
      return 'River';
    default:
      return 'UnknownStreet';
  }
}

function eventDisplayLine(event) {
  if (!event?.type) return null;
  const seat = event.seat_number == null ? null : Number(event.seat_number) + 1;
  switch (event.type) {
    case 'hand_started':
      return `Hand ${event.hand_number ?? ''} started`.trim();
    case 'deck_shuffled':
      return `Deck Shuffled on Player ${seat}`;
    case 'round_started':
      return `Round Started: ${eventRoundName(Number(event.round_number ?? 0))} on Player ${seat}`;
    case 'small_blind_posted':
      return `Small Blind Posted by Player ${seat}: $${event.small_blind}`;
    case 'big_blind_posted':
      return `Big Blind Posted by Player ${seat}: $${event.big_blind}`;
    case 'bet':
      return `Player ${seat} Bet: $${event.amount}`;
    case 'fold':
      return `Player ${seat} Folded`;
    case 'hand_ended':
      return `Hand Ended; Player ${seat} submits public key first`;
    case 'hand_result':
      return 'Hand result pending final settlement';
    default:
      return null;
  }
}

function eventDisplayLines(events, fallbackLines = []) {
  const lines = (events ?? []).map(eventDisplayLine).filter(Boolean);
  return lines.length > 0 ? lines : fallbackLines;
}

function botTraceLines(game, action, result, fallbackLines = []) {
  const hand = game?.clientState.current_hand();
  if (!hand) return fallbackLines;

  if (action.type === 'SubmitBet') {
    const didFold = result?.events?.some((event) => event.type === 'fold');
    const verb = didFold ? 'Folded' : `Bet: $${action.amount}`;
    return [
      `Player ${action.player + 1} ${verb}`,
    ];
  }

  const events = result?.events ?? [];
  const startedRound = events.find((event) => event.type === 'round_started');
  if (startedRound?.round_number === 1) {
    return fallbackLines;
  }
  if (startedRound?.round_number > 1) {
    return [...fallbackLines, ...communityCardConsoleLines(hand)];
  }
  if (events.some((event) => event.type === 'hand_ended')) {
    return fallbackLines;
  }
  if (events.some((event) => event.type === 'hand_result')) {
    return [...fallbackLines, ...communityCardConsoleLines(hand)];
  }

  return fallbackLines;
}

function gameStateName(pokerState) {
  if (!pokerState) return 'Waiting';
  if (pokerState.type === 'Shuffle') return 'Shuffling';
  if (pokerState.type === 'Bet') return streetName(pokerState.round);
  if (pokerState.type === 'UnmaskCommunityCards') return `Unmask${streetName(pokerState.round)}`;
  return pokerState.type;
}

function playerCompletedFinalSettlement(game, playerIndex) {
  return (game?.finalVerificationSignatureShares ?? []).some((share) => (
    Number(share?.signer_seat) === Number(playerIndex)
  ));
}

function settlementWinnerIndex(settlement, tableSeats = []) {
  const payouts = settlement?.pot_size_per_player ?? [];
  const payoutWinner = payouts.findIndex((amount) => Number(amount) > 0);
  if (payoutWinner >= 0) return payoutWinner;

  const winnerAddress = settlement?.winner_player_address?.toLowerCase?.();
  if (!winnerAddress) return null;
  const addressWinner = tableSeats.findIndex((seat) => (
    seat?.playerAddress?.toLowerCase?.() === winnerAddress
  ));
  return addressWinner >= 0 ? addressWinner : null;
}

function terminalResultFromSettlement(settlement, tableSeats, playerIndex, circulationComplete = false) {
  const winnerIndex = settlementWinnerIndex(settlement, tableSeats);
  const viewerChips = Number(fromChipUnits(
    settlement?.chips_balances?.[playerIndex] ?? 0
  ));

  return {
    type: winnerIndex === playerIndex ? 'win' : 'loss',
    chips: viewerChips,
    tableComplete: true,
    circulationComplete,
  };
}

function protocolType(gameOrState) {
  return tableProtocolStateType(gameOrState?.tableProtocolState ?? gameOrState);
}

function transitionTableProtocol(game, nextState) {
  if (!game || !nextState?.type) return nextState;
  game.tableProtocolState = nextState;
  return nextState;
}

function protocolStateOr(game, fallbackState) {
  return game?.tableProtocolState ?? fallbackState;
}

function startHandState(game, fallbackHandId = null) {
  const state = game?.tableProtocolState;
  if (protocolType(state) === TABLE_PROTOCOL_STATE_START_HAND) {
    return state;
  }
  return TableProtocolState.startHand({ handId: fallbackHandId });
}

function settleHandState(game, fallbackHandId = null) {
  const state = game?.tableProtocolState;
  if (protocolType(state) === TABLE_PROTOCOL_STATE_SETTLE_HAND) {
    return state;
  }
  return TableProtocolState.settleHand({ handId: fallbackHandId });
}

function currentGameStateFrom(game, viewerSeatNo = null, cheatReport = null, tableSeats = []) {
  const hand = game?.clientState.current_hand();
  const tableBuyIn = game?.currentHandSetup?.initial_chips?.[0] ?? tableSeats[0]?.chips;
  const viewerPlayerIndex = viewerSeatNo ?? game?.clientState.player_index ?? 0;
  if (!game || !hand) {
    return {
      state: 'Waiting',
      tableProtocolState: protocolType(protocolStateOr(
        game,
        TableProtocolState.tableAggregatePublicKey(),
      )),
      seat: null,
      pot: 0,
      minBet: 0,
      maxBet: 0,
      step: 0,
      chipStacks: [],
      chipStackSizes: [],
      payout: null,
      activePlayers: [],
      allInPlayers: [],
    };
  }

  const handState = hand.get_current_state();
  const pokerState = handState.to_enum();
  const seat = 'player' in pokerState ? pokerState.player : handState.get_current_player();
  if (cheatReport) {
    const stacks = chipStacks(hand);
    const activePlayers = hand.betting_state?.active_players ?? [];
    const allInPlayers = hand.betting_state?.allin_players ?? [];
    return {
      state: 'Cheated',
      tableProtocolState: protocolType(protocolStateOr(
        game,
        TableProtocolState.handDisputed(),
      )),
      seat,
      pot: Number(hand.betting_state?.pot?.toString?.() ?? 0),
      minBet: safeCallAmount(hand, viewerPlayerIndex),
      maxBet: safeChipsRemaining(hand, viewerPlayerIndex),
      step: hand.get_small_blind(),
      chipStacks: stacks,
      chipStackSizes: chipStackSizes(stacks, tableBuyIn),
      hands: hand.get_player_cards().map(() => ({ cards: [], rank: null, isWinner: false })),
      winner: null,
      resultText: cheatReport.player === viewerPlayerIndex ? 'Cheater' : 'Game Cheated',
      resultRank: null,
      resultWinner: null,
      payout: null,
      cheat: {
        ...cheatReport,
        isViewerCheater: cheatReport.player === viewerPlayerIndex,
      },
      activePlayers,
      allInPlayers,
    };
  }
  const deck = hand.get_poker_deck();
  const isShowdownState = pokerState.type === 'UnmaskShowdown'
    || pokerState.type === 'SubmitPublicKey'
    || pokerState.type === 'Finished';

  if (isShowdownState) {
    const activePlayers = hand.betting_state?.active_players ?? [];
    const finalSettlementComplete = playerCompletedFinalSettlement(game, viewerPlayerIndex);
    const playerCards = hand.get_player_cards().map((cardSet, player) => {
      if (activePlayers[player] === false) return [];
      try {
        return cardsToStrings(deck.unmasked_cards(cardSet));
      } catch {
        return [];
      }
    });
    const allInPlayers = hand.betting_state?.allin_players ?? [];
    const payoutAmount = Number(hand.betting_state?.pot?.toString?.() ?? 0);
    const settlement = finalSettlementComplete ? game.finalHandSettlement : null;
    const settlementWinner = settlementWinnerIndex(settlement, tableSeats);

    const settlementPayout = settlementWinner == null
      ? 0
      : Number(fromChipUnits(settlement?.pot_size_per_player?.[settlementWinner] ?? 0));

    const hands = playerCards.map((cards, index) => ({
      cards,
      rank: null,
      isWinner: finalSettlementComplete && settlementWinner === index,
    }));

    const playerWon = settlementWinner != null && settlementWinner === viewerPlayerIndex;

    const stacks = finalSettlementComplete
      ? (settlement?.chips_balances ?? []).map((chips) => Number(fromChipUnits(chips)))
      : chipStacks(hand);

    const revealedWinner = finalSettlementComplete ? settlementWinner : null;

    return {
      state: pokerState.type === 'Finished' && !finalSettlementComplete ? 'FinalSettlement' : 'Showdown',
      tableProtocolState: protocolType(protocolStateOr(game, (
        pokerState.type === 'Finished'
          ? TableProtocolState.settleHand({ handId: game?.clientState?.hand_id })
          : TableProtocolState.handInProgress({ handId: game?.clientState?.hand_id })
      ))),
      seat,
      pot: payoutAmount,
      minBet: safeCallAmount(hand, viewerPlayerIndex),
      maxBet: safeChipsRemaining(hand, viewerPlayerIndex),
      step: hand.get_small_blind(),
      chipStacks: stacks,
      chipStackSizes: chipStackSizes(stacks, tableBuyIn),
      hands,
      winner: revealedWinner,
      resultText: revealedWinner == null ? null : playerWon ? 'You Win' : 'You Lose',
      resultRank: null,
      resultWinner: revealedWinner,
      payout: revealedWinner == null
        ? null
        : {
          amount: settlementPayout,
          winner: revealedWinner,
          icon: 'coins',
        },
      activePlayers,
      allInPlayers,
    };
  }

  const activePlayers = hand.betting_state?.active_players ?? [];
  const allInPlayers = hand.betting_state?.allin_players ?? [];

  return {
    state: gameStateName(pokerState),
    tableProtocolState: protocolType(protocolStateOr(
      game,
      TableProtocolState.handInProgress({ handId: game?.clientState?.hand_id }),
    )),
    seat,
    pot: Number(hand.betting_state?.pot?.toString?.() ?? 0),
    minBet: safeCallAmount(hand, viewerPlayerIndex),
    maxBet: safeChipsRemaining(hand, viewerPlayerIndex),
    step: hand.get_small_blind(),
    chipStacks: chipStacks(hand),
    chipStackSizes: chipStackSizes(chipStacks(hand), tableBuyIn),
    payout: null,
    activePlayers,
    allInPlayers,
  };
}

function protocolActionStateFrom(game) {
  const hand = game?.clientState.current_hand();
  if (!game || !hand) return null;
  const pokerState = hand.get_current_state().to_enum();
  const seat = 'player' in pokerState ? pokerState.player : hand.get_current_state().get_current_player();
  return {
    state: gameStateName(pokerState),
    seat,
  };
}

function currentActingPlayer(game) {
  const hand = game?.clientState.current_hand();
  return hand?.get_current_state().get_current_player() ?? null;
}

function pointKey(point) {
  return bytesToHex(point.toRawBytes(true), { prefix: true });
}

function reconstructShuffleTrace(hand, playerIndex, signingKey) {
  const numPlayers = Number(hand?.current_state?.num_players ?? 0);
  const dealerButton = Number(hand?.current_state?.dealer_button ?? 0);
  if (!hand || playerIndex == null || !signingKey || numPlayers <= 0) return null;

  const stepIndex = (Number(playerIndex) + numPlayers - dealerButton) % numPlayers;
  const nextDeck = hand.shuffle_history?.[stepIndex]?.cards?.();
  if (!Array.isArray(nextDeck)) return null;
  const prevDeck = stepIndex === 0
    ? hand.get_poker_deck().cards()
    : hand.shuffle_history?.[stepIndex - 1]?.cards?.();
  if (!Array.isArray(prevDeck)) return null;

  const beforeIndexByMaskedCard = new Map();
  prevDeck.forEach((card, beforeIndex) => {
    beforeIndexByMaskedCard.set(pointKey(blsMask(card, signingKey)), beforeIndex);
  });

  const traces = [];
  const usedBeforeIndices = new Set();
  for (let afterIndex = 0; afterIndex < nextDeck.length; afterIndex += 1) {
    const beforeIndex = beforeIndexByMaskedCard.get(pointKey(nextDeck[afterIndex]));
    if (beforeIndex == null || usedBeforeIndices.has(beforeIndex)) return null;
    usedBeforeIndices.add(beforeIndex);
    traces.push({
      after_index: afterIndex,
      claimed_before_index: beforeIndex,
    });
  }
  return traces;
}

function isHumanActionState(handState) {
  return [
    POKER_HAND_STATE_BET,
    POKER_HAND_STATE_SMALL_BLIND,
    POKER_HAND_STATE_BIG_BLIND,
  ].includes(handState?.current_state);
}

function isOnlyCheckBetState(hand, player) {
  if (!hand || player == null) return false;
  const bettingState = hand.betting_state;
  const activePlayers = bettingState?.active_players ?? [];
  const allInPlayers = bettingState?.allin_players ?? [];
  const bettingPlayers = activePlayers.filter((active, seat) => active && !allInPlayers[seat]);
  const activeAllInCount = activePlayers.filter((active, seat) => active && allInPlayers[seat]).length;

  return activePlayers[player] === true
    && allInPlayers[player] !== true
    && bettingPlayers.length === 1
    && activeAllInCount > 0
    && safeCallAmount(hand, player) === 0;
}

function actionSnapshotFromState({
  currentGameState,
  protocolActionState,
  viewPatch,
  previousSnapshot,
  playerIndex,
}) {
  const stateName = protocolActionState?.state;
  const isMyTurn = protocolActionState?.seat === playerIndex;
  const activePlayers = currentGameState?.activePlayers ?? [];
  const allInPlayers = currentGameState?.allInPlayers ?? [];
  const bettingPlayers = activePlayers
    .map((active, player) => active && !allInPlayers[player])
    .filter(Boolean);
  const activeAllInCount = activePlayers.filter((active, player) => active && allInPlayers[player]).length;
  const isFolded = activePlayers[playerIndex] === false;
  const isAllIn = allInPlayers[playerIndex] === true;
  const waitingForBet = BETTING_UI_STATES.has(stateName) && isMyTurn && !isFolded && !isAllIn;
  const waitingForSmallBlind = stateName === 'SmallBlind' && isMyTurn && !isAllIn;
  const waitingForBigBlind = stateName === 'BigBlind' && isMyTurn && !isAllIn;
  const waitingForBlind = waitingForSmallBlind || waitingForBigBlind;

  // Derive small & big blinds strictly from passed-in state/view patch
  const smallBlind = viewPatch?.small_blind ?? currentGameState?.step;
  const bigBlind = viewPatch?.big_blind ?? (smallBlind !== undefined ? smallBlind * 2 : undefined);

  // Available chips (strictly from on-chain state, undefined if uninitialized)
  const availableChips = currentGameState?.maxBet ?? viewPatch?.max_bet;

  // Compute required blind amount
  const requiredBlindAmount = waitingForSmallBlind
    ? smallBlind
    : waitingForBigBlind
      ? bigBlind
      : Number(currentGameState?.minBet ?? viewPatch?.min_bet);

  // Clamp blind to available chips
  const blindAmount = waitingForBlind && requiredBlindAmount !== undefined && availableChips !== undefined
    ? Math.max(0, Math.min(requiredBlindAmount, Number(availableChips)))
    : requiredBlindAmount;

  // Single declaration of actionMinBet
  const actionMinBet = waitingForBlind
    ? blindAmount
    : Number(currentGameState?.minBet ?? viewPatch?.min_bet ?? smallBlind);

  const onlyCallMode = waitingForBet
    && bettingPlayers.length === 1
    && activePlayers[playerIndex] === true
    && allInPlayers[playerIndex] !== true
    && activeAllInCount > 0;
  const onlyCheckMode = onlyCallMode && actionMinBet === 0;

  const step = Number(currentGameState?.step ?? viewPatch?.bet_step ?? smallBlind);

  return {
    ...previousSnapshot,
    started: true,
    showActionBar: (waitingForBet && !onlyCheckMode) || waitingForBlind,
    waitingForBet,
    waitingForBlind,
    canAct: isMyTurn && !isFolded && !isAllIn,
    stateLabel: viewPatch?.state_label ?? previousSnapshot?.stateLabel,
    minBet: actionMinBet,
    maxBet: availableChips !== undefined ? Number(availableChips) : undefined,
    step,
    actionAmount: waitingForBlind ? blindAmount : actionMinBet,
    primaryLabel: waitingForSmallBlind
      ? 'Small Blind'
      : waitingForBigBlind
        ? 'Big Blind'
        : 'Raise',
    sliderDisabled: waitingForBlind,
    hideCall: waitingForBlind,
    hideFold: waitingForBlind,
    onlyCallMode,
    onlyCheckMode,
    currentGameState,
    protocolActionState,
    viewPatch,
  };
}

const formatSeatSender = (address, seatNo) => (
  address ? address.slice(2, 4).toUpperCase() : `P${seatNo + 1}`
);

function formatPokerProtocolError(error, fallbackPlayer = null) {
  const cheat = cheatReportFromError(error, fallbackPlayer);
  if (cheat) {
    return `Cheat detected: Player ${cheat.player + 1} cheated ${cheat.kind.toLowerCase()}`;
  }

  return error?.message ?? String(error);
}

function cheatReportFromError(error, fallbackPlayer = null) {
  const message = error?.message ?? String(error);
  const unmaskMatch = message.match(/^Player cheated during unmasking\s+(\d+)$/);
  if (unmaskMatch) {
    return {
      player: Number(unmaskMatch[1]),
      kind: 'UNMASKING',
    };
  }

  if (message === 'Player cheated during shuffle') {
    return {
      player: fallbackPlayer == null ? 0 : Number(fallbackPlayer),
      kind: 'SHUFFLE',
    };
  }

  return null;
}

export function usePokerTable({
  table,
  networkSnapshot: injectedNetworkSnapshot,
  publishMessage: injectedPublishMessage,
  prepareNetworkSession: injectedPrepareNetworkSession,
  prepareHandSession: injectedPrepareHandSession,
  onOperatorTopUp,
} = {}) {
  const [snapshot, setSnapshot] = useState({
    started: false,
    showActionBar: false,
    waitingForBet: false,
    waitingForBlind: false,
    canAct: false,
    stateLabel: 'Waiting',
    minBet: undefined,
    maxBet: undefined,
    step: undefined,
    actionAmount: undefined,
    primaryLabel: 'Raise',
    sliderDisabled: false,
    hideCall: false,
    hideFold: false,
    onlyCallMode: false,
    onlyCheckMode: false,
    currentGameState: {
      state: 'Waiting',
      seat: null,
      pot: 0,
      minBet: 0,
      maxBet: 0,
      step: 0,
      activePlayers: [],
      allInPlayers: [],
    },
    protocolActionState: null,
    viewPatch: {},
  });
  const { startCountdown } = useCountdown();
  const [gameMessages, setGameMessages] = useState([]);
  const [cheatReport, setCheatReport] = useState(null);
  const [terminalResult, setTerminalResult] = useState(null);
  const gameRef = useRef(null);
  const cheatReportRef = useRef(null);
  const lastPatchRef = useRef(null);
  const lastSnapshotRef = useRef(snapshot);
  const handHistoryRef = useRef([]);
  const seenHistoryTipsRef = useRef(new Set());
  const previousConnectedRef = useRef(false);
  const pendingHistorySyncRef = useRef(false);
  const protocolActionInFlightRef = useRef(null);
  const finalVerificationInFlightRef = useRef(false);
  const debugCheatsRef = useRef({
    badPk: false,
    badShuffle: false,
    badUnmask: false,
  });
  const tableSeats = useMemo(() => table?.seats ?? [], [table?.seats]);
  const tableId = table?.tableData?.id;
  const lobbyId = table?.lobbyId;
  const tableMaxSeats = table?.tableData?.maxSeats;
  const tableCurrentHand = Number(table?.tableData?.currentHand ?? 0);
  const tableCurrentHandRef = useRef(tableCurrentHand);
  tableCurrentHandRef.current = tableCurrentHand;
  const currentSeatNo = table?.currentSeat?.seatNo;
  const fallbackTokenRing = useMemo(() => new VirtualTokenRing({
    currentSeatNo,
    seatCount: Number(tableMaxSeats || tableSeats.length || 0),
  }), [currentSeatNo, tableMaxSeats, tableSeats.length]);
  const tokenRing = table?.tokenRing?.ring ?? fallbackTokenRing;
  const tokenRingTransport = table?.tokenRing;
  const publishTokenMessage = injectedPublishMessage ?? tokenRingTransport?.publishMessage;
  const tokenRingSnapshot = injectedNetworkSnapshot ?? tokenRingTransport?.networkSnapshot;
  const prepareTokenNetworkSession = injectedPrepareNetworkSession
    ?? tokenRingTransport?.prepareNetworkSession;
  const prepareTokenHandSession = injectedPrepareHandSession
    ?? tokenRingTransport?.prepareHandSession;
  const {
    buildNextFinalVerification,
    buildNextTableAggregatePublicKeyVerification,
    setTableAggregatePublicKeyOnChain,
    startHandOnChain,
    submitFinalHandOnChain,
  } = useFinalVerification({ onOperatorTopUp });

  const senderForSeat = useCallback((seatNo) => {
    const seat = tableSeats[seatNo];
    return formatSeatSender(seat?.playerAddress, seatNo);
  }, [tableSeats]);

  const senderForAddress = useCallback((address) => {
    const normalizedAddress = address?.toLowerCase();
    const seatNo = tableSeats.findIndex((seat) => (
      seat.playerAddress?.toLowerCase() === normalizedAddress
    ));
    return seatNo >= 0 ? senderForSeat(seatNo) : formatSeatSender(address, 0);
  }, [senderForSeat, tableSeats]);

  const senderForLine = useCallback((line, fallbackSeatNo = null) => {
    const playerLine = line.match(/^Player\s+(\d+)\b/);
    if (playerLine) return senderForSeat(Number(playerLine[1]) - 1);

    const actionLine = line.match(/\bon Player\s+(\d+)\b/);
    if (actionLine) return senderForSeat(Number(actionLine[1]) - 1);

    if (fallbackSeatNo != null) return senderForSeat(fallbackSeatNo);
    return 'Game';
  }, [senderForSeat]);

  const appendGameLog = useCallback((line, sender = 'Game', level = 'info') => {
    setGameMessages((prev) => [...prev, { text: line, sender, level }].slice(-160));
  }, []);

  const appendTraceLines = useCallback((lines, fallbackSeatNo = null) => {
    lines.forEach((line) => appendGameLog(line, senderForLine(line, fallbackSeatNo)));
  }, [appendGameLog, senderForLine]);

  const resetGame = useCallback(() => {
    const numPlayers = Number(tableMaxSeats || 0);
    const buyIn = table?.tableData?.buyin;
    const smallBlind = table?.tableData?.blinds?.smallBlind ?? getBlindsForBuyin(buyIn)?.smallBlind;

    // STRICT: If on-chain details aren't loaded yet, do not instantiate with fake defaults
    if (!numPlayers || tableId == null || buyIn === undefined || smallBlind === undefined) {
      return null;
    }

    const chainCurrentHand = Number.isFinite(tableCurrentHandRef.current)
      ? tableCurrentHandRef.current
      : 0;
    const previousGame = gameRef.current;
    const previousHand = previousGame?.clientState?.current_hand?.();
    const recoveredHandState = chainCurrentHand > 0
      && Number(previousGame?.clientState?.hand_id ?? 0) === chainCurrentHand
      && previousHand
      && !previousHand.get_current_state?.().is_finished?.();
    const initialProtocolState = chainCurrentHand === 0
      ? TableProtocolState.tableAggregatePublicKey()
      : recoveredHandState
        ? TableProtocolState.handInProgress({
          handId: chainCurrentHand,
          handSetup: previousGame?.currentHandSetup ?? null,
        })
        : TableProtocolState.startHand({ handId: chainCurrentHand + 1 });

    const pokerTable = makePokerTable(numPlayers, buyIn, smallBlind);
    if (!pokerTable) return null;

    pokerTable.hand_number = chainCurrentHand;
    const clientState = PokerClientState.new(
      currentSeatNo ?? 0,
      Number(tableId),
      chainCurrentHand,
      pokerTable,
    );
    gameRef.current = {
      clientState,
      signingKey: null,
      publicKey: null,
      tableSigningKey: null,
      tablePublicKey: null,
      tableSignaturePublicKey: null,
      tableKeys: null,
      handKeyHandId: null,
      handKeys: new Map(),
      publicKeySubmissions: new Map(),
      tableProtocolState: initialProtocolState,
      tableAggregatePublicKeyPromise: null,
      tableAggregatePublicKey: null,
      tableAggregatePublicKeyPublicKeyShares: [],
      tableAggregatePublicKeySignatureShares: [],
      tableAggregatePublicKeyDigest: null,
      startHandPromise: null,
      finalVerificationSignatureShares: [],
      finalVerificationDigest: null,
      finalHandSettlement: null,
      finalVerificationSettlementTx: null,
      currentHandSetup: {
        hand_id: chainCurrentHand,
        hand_number: chainCurrentHand,
        initial_chips: Array(numPlayers).fill(buyIn),
        small_blind: smallBlind,
        dealer_button: 0,
      },
      shuffleTrace: null,
      seenFinished: false,
    };
    return gameRef.current;
  }, [currentSeatNo, tableId, tableMaxSeats]);

  useEffect(() => {
    resetGame();
    handHistoryRef.current = [];
    seenHistoryTipsRef.current = new Set();
    previousConnectedRef.current = false;
    pendingHistorySyncRef.current = false;
    finalVerificationInFlightRef.current = false;
    cheatReportRef.current = null;
    setCheatReport(null);
    setTerminalResult(null);
  }, [resetGame, tableMaxSeats]);

  const updateView = useCallback(({ force = false } = {}) => {
    const game = gameRef.current;
    const hand = game?.clientState.current_hand();
    if (!game || !hand) return null;

    const viewerSeatNo = currentSeatNo ?? null;
    const patch = tableViewPatch(game.clientState, game.signingKey, viewerSeatNo);
    const currentGameState = currentGameStateFrom(game, viewerSeatNo, cheatReportRef.current, tableSeats);
    const protocolActionState = protocolActionStateFrom(game);
    const nextCurrentGameState = !force && shallowEqual(
      lastSnapshotRef.current.currentGameState,
      currentGameState,
    )
      ? lastSnapshotRef.current.currentGameState
      : currentGameState;

    const nextPatch = !force && shallowEqual(lastPatchRef.current, patch) ? lastPatchRef.current : patch;
    lastPatchRef.current = nextPatch;

    const nextSnapshot = actionSnapshotFromState({
      currentGameState: nextCurrentGameState,
      protocolActionState,
      viewPatch: nextPatch,
      previousSnapshot: lastSnapshotRef.current,
      playerIndex: viewerSeatNo,
    });

    if (force || !shallowEqual(lastSnapshotRef.current, nextSnapshot)) {
      lastSnapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
    }
    return nextSnapshot;
  }, [currentSeatNo, tableSeats]);

  const ensureKeys = useCallback(async (handNumber = null) => {
    const game = gameRef.current ?? resetGame();
    if (!game) return null;
    const targetHandNumber = Number(handNumber ?? game.clientState.hand_id ?? HAND_ID);
    if (
      game.signingKey
      && game.publicKey
      && game.tableSigningKey
      && game.tablePublicKey
      && game.tableSignaturePublicKey
      && Number(game.handKeyHandId) === targetHandNumber
    ) return game;
    if (currentSeatNo == null || (!prepareTokenHandSession && !prepareTokenNetworkSession)) return null;

    const tableKeys = game.tableKeys
      ?? (prepareTokenNetworkSession ? await prepareTokenNetworkSession() : null);
    const cachedKeys = game.handKeys?.get(targetHandNumber);
    const keys = cachedKeys
      ?? (prepareTokenHandSession
        ? await prepareTokenHandSession(targetHandNumber)
        : tableKeys);
    if (!cachedKeys) {
      const handKeys = game.handKeys ?? new Map();
      handKeys.set(targetHandNumber, keys);
      game.handKeys = handKeys;
    }
    const signingKey = make_signing_key_from_seed(hexToBytes(keys.privateKey));
    const tableSigningKey = tableKeys
      ? make_signing_key_from_seed(hexToBytes(tableKeys.privateKey))
      : null;
    const nextGame = {
      ...game,
      signingKey,
      publicKey: make_public_key_from_signing_key(signingKey),
      tableSigningKey,
      tablePublicKey: tableSigningKey ? make_public_key_from_signing_key(tableSigningKey) : null,
      tableSignaturePublicKey: tableSigningKey ? make_public_key_from_signing_key(tableSigningKey) : null,
      tableKeys,
      operatorPrivateKey: keys.operatorPrivateKey ?? tableKeys?.operatorPrivateKey,
      handKeyHandId: targetHandNumber,
    };
    gameRef.current = nextGame;
    return nextGame;
  }, [currentSeatNo, prepareTokenHandSession, prepareTokenNetworkSession, resetGame]);

  const requiredTableAggregateSeats = useCallback(() => {
    const requiredSeats = Number(tableMaxSeats || tableSeats.length || 0);
    const announcedSeats = tableSeats.slice(0, requiredSeats);
    if (
      requiredSeats <= 0
      || announcedSeats.length !== requiredSeats
      || announcedSeats.some((seat) => !seat?.playerAddress || !seat?.announcePublicKey)
    ) {
      throw new Error('Table aggregate public key requires every player announce key.');
    }
    return announcedSeats;
  }, [tableMaxSeats, tableSeats]);

  const publishTableAggregatePublicKeyMessage = useCallback((game, tableAggregateVerification) => {
    const nextPlayer = Number.isFinite(Number(tableAggregateVerification.nextSeat))
      ? Number(tableAggregateVerification.nextSeat)
      : null;
    publishTokenMessage({
      type: TABLE_AGGREGATE_PUBLIC_KEY_MESSAGE,
      ...tokenRing.messageFields(game, { currentPlayer: nextPlayer }),
      lobby_id: lobbyId?.toString?.() ?? String(lobbyId ?? ''),
      table_id: tableId?.toString?.() ?? String(tableId ?? ''),
      aggregate_public_key: tableAggregateVerification.aggregatePublicKey,
      aggregate_public_key_digest: tableAggregateVerification.tableAggregatePublicKeyDigest,
      public_key_shares: tableAggregateVerification.publicKeyShares,
      signature_shares: tableAggregateVerification.signatureShares,
      signer_seats: tableAggregateVerification.signerSeats,
      aggregate_signature: tableAggregateVerification.aggregateSignature,
    });
  }, [lobbyId, publishTokenMessage, tableId, tokenRing]);

  const requiredStartHandSeats = useCallback(() => (
    Number(tableMaxSeats || tableSeats.length || 0)
  ), [tableMaxSeats, tableSeats.length]);

  const nextOnChainHandId = useCallback((game) => (
    Number(startHandState(game, Number(game?.clientState?.hand_id ?? 0) + 1).handId
      ?? Number(game?.clientState?.hand_id ?? 0) + 1)
  ), []);

  const recordStartHandConfirmation = useCallback((game, seatNo, handId, hash = null) => {
    if (!game || seatNo == null) return false;
    const targetHandId = Number(handId ?? nextOnChainHandId(game));
    const state = startHandState(game, targetHandId);
    const confirmations = (state.confirmations ?? [])
      .filter((entry) => Number(entry.hand_id) === targetHandId);
    if (confirmations.some((entry) => Number(entry.seat_no) === Number(seatNo))) {
      transitionTableProtocol(game, TableProtocolState.startHand({
        handId: targetHandId,
        confirmations,
      }));
      return false;
    }
    confirmations.push({
      seat_no: Number(seatNo),
      hand_id: targetHandId,
      tx: hash,
    });
    transitionTableProtocol(game, TableProtocolState.startHand({
      handId: targetHandId,
      confirmations,
    }));
    return true;
  }, [nextOnChainHandId]);

  const startHandRoundComplete = useCallback((game, handId = null) => {
    const requiredSeats = requiredStartHandSeats();
    const targetHandId = Number(handId ?? nextOnChainHandId(game));
    if (!game || requiredSeats <= 0) return false;
    const confirmedSeats = new Set(
      (startHandState(game, targetHandId).confirmations ?? [])
        .filter((entry) => Number(entry.hand_id) === targetHandId)
        .map((entry) => Number(entry.seat_no)),
    );
    return confirmedSeats.size >= requiredSeats;
  }, [nextOnChainHandId, requiredStartHandSeats]);

  const markOnChainHandStarted = useCallback((game, handId) => {
    const targetHandId = Number(handId);
    if (!game || !targetHandId) return;

    const buyIn = table?.tableData?.buyin;
    const smallBlind = table?.tableData?.blinds?.smallBlind ?? getBlindsForBuyin(buyIn)?.smallBlind;

    if (buyIn === undefined || smallBlind === undefined) return;

    const currentHand = game.clientState.current_hand?.();
    const currentHandId = Number(game.clientState.hand_id ?? 0);
    const needsLocalNextHand = currentHand?.get_current_state?.().is_finished?.()
      && targetHandId >= currentHandId;

    if (needsLocalNextHand) {
      const nextStacks = finalHandStacks(currentHand);
      const initialChips = nextStacks.length > 0
        ? nextStacks
        : Array(game.clientState.table.get_current_player_count()).fill(buyIn);

      const smallBlind = currentHand.get_small_blind();
      const dealerSeatNumber = nextDealerSeatNumber(game.clientState.table);
      game.clientState.table.start_hand(initialChips, smallBlind, dealerSeatNumber);
      game.currentHandSetup = {
        hand_id: targetHandId,
        hand_number: targetHandId,
        initial_chips: initialChips.map((chips) => Number(chips)),
        small_blind: smallBlind,
        dealer_button: dealerSeatNumber,
      };
    }
    if (Number(game.clientState.hand_id ?? 0) < targetHandId) {
      game.clientState.hand_id = targetHandId;
      game.clientState.sequence = 0;
      game.clientState.seen.clear();
      game.clientState.table.hand_number = targetHandId;
    }
    game.currentHandSetup ??= {
      hand_id: targetHandId,
      hand_number: targetHandId,
      initial_chips: Array(requiredStartHandSeats()).fill(buyIn),
      small_blind: smallBlind,
      dealer_button: 0,
    };
    game.currentHandSetup.hand_id = targetHandId;
    game.currentHandSetup.hand_number = targetHandId;
    game.signingKey = null;
    game.publicKey = null;
    game.handKeyHandId = null;
    game.shuffleTrace = null;
    game.publicKeySubmissions = new Map();
    game.finalVerificationSignatureShares = [];
    game.finalVerificationDigest = null;
    game.finalHandSettlement = null;
    game.finalVerificationSettlementTx = null;
    game.seenFinished = false;
    handHistoryRef.current = [];
    seenHistoryTipsRef.current = new Set();
    protocolActionInFlightRef.current = null;
    finalVerificationInFlightRef.current = false;
    transitionTableProtocol(game, TableProtocolState.handInProgress({
      handId: targetHandId,
      handSetup: game.currentHandSetup,
    }));
  }, [requiredStartHandSeats]);

  const publishStartHandMessage = useCallback((game, hash = null, handId = null) => {
    const targetHandId = Number(handId ?? nextOnChainHandId(game));
    const currentPlayer = hash
      ? tokenRing.nextSeatAfter(game?.clientState?.player_index, requiredStartHandSeats())
      : 0;
    publishTokenMessage({
      type: START_HAND_MESSAGE,
      ...tokenRing.messageFields(game, {
        currentHand: targetHandId,
        currentPlayer,
      }),
      lobby_id: lobbyId?.toString?.() ?? String(lobbyId ?? ''),
      table_id: tableId?.toString?.() ?? String(tableId ?? ''),
      hand_id: targetHandId,
      hand_number: targetHandId,
      seat_no: hash ? game?.clientState?.player_index : null,
      tx: hash,
      confirmations: startHandState(game, targetHandId).confirmations ?? [],
    });
  }, [lobbyId, nextOnChainHandId, publishTokenMessage, requiredStartHandSeats, tableId, tokenRing]);

  const ensureOnChainStartHand = useCallback(async (game) => {
    if (!game) return false;
    const targetHandId = nextOnChainHandId(game);
    if (protocolType(game) === TABLE_PROTOCOL_STATE_HAND_IN_PROGRESS) {
      return true;
    }
    if (startHandRoundComplete(game, targetHandId)) {
      markOnChainHandStarted(game, targetHandId);
      return true;
    }
    if (game.startHandPromise) return game.startHandPromise;
    if (startHandState(game, targetHandId).confirmations?.some((entry) => (
      Number(entry.seat_no) === Number(game.clientState.player_index)
      && Number(entry.hand_id) === targetHandId
    ))) {
      transitionTableProtocol(game, startHandState(game, targetHandId));
      return false;
    }
    if (!lobbyId || !tableId) return false;
    if (!game.operatorPrivateKey) {
      throw new Error('Missing operator key for start hand submit.');
    }

    transitionTableProtocol(game, startHandState(game, targetHandId));
    const startPromise = (async () => {
      const hash = await startHandOnChain({
        lobbyId,
        tableId,
        operatorPrivateKey: game.operatorPrivateKey,
      });
      recordStartHandConfirmation(game, game.clientState.player_index, targetHandId, hash);
      appendGameLog(`Start hand submitted on-chain: ${hash}`, 'Game');
      publishStartHandMessage(game, hash, targetHandId);
      if (startHandRoundComplete(game, targetHandId)) {
        markOnChainHandStarted(game, targetHandId);
        return true;
      }
      return false;
    })();

    game.startHandPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      game.startHandPromise = null;
    }
  }, [
    appendGameLog,
    lobbyId,
    markOnChainHandStarted,
    nextOnChainHandId,
    publishStartHandMessage,
    recordStartHandConfirmation,
    startHandOnChain,
    startHandRoundComplete,
    tableId,
  ]);

  const submitTableAggregatePublicKeyRound = useCallback(async (game, incoming = null) => {
    if (!game) return false;
    if (protocolType(game) !== TABLE_PROTOCOL_STATE_TABLE_AGGREGATE_PUBLIC_KEY) {
      return protocolType(game) === TABLE_PROTOCOL_STATE_START_HAND
        || protocolType(game) === TABLE_PROTOCOL_STATE_HAND_IN_PROGRESS
        || protocolType(game) === TABLE_PROTOCOL_STATE_TABLE_COMPLETE;
    }
    if (!lobbyId || !tableId) return false;
    if (!game.operatorPrivateKey) {
      throw new Error('Missing operator key for table aggregate public key submit.');
    }

    const announcedSeats = requiredTableAggregateSeats();
    const incomingPublicKeyShares = Array.isArray(incoming) ? null : incoming?.publicKeyShares;
    const incomingSignatureShares = Array.isArray(incoming) ? incoming : incoming?.signatureShares;
    const publicKeyShares = incomingPublicKeyShares
      ?? game.tableAggregatePublicKeyPublicKeyShares
      ?? [];
    const signatureShares = incomingSignatureShares
      ?? game.tableAggregatePublicKeySignatureShares
      ?? [];
    const tableAggregateVerification = buildNextTableAggregatePublicKeyVerification({
      lobbyId,
      tableId,
      tableSeats: announcedSeats,
      publicKeyShares,
      signatureShares,
      currentSeatNo: game.clientState.player_index,
      signingKey: game.tableSigningKey,
      publicKey: game.tableSignaturePublicKey,
    });

    game.tableAggregatePublicKeyPublicKeyShares = tableAggregateVerification.publicKeyShares;
    game.tableAggregatePublicKeySignatureShares = tableAggregateVerification.signatureShares;
    game.tableAggregatePublicKeyDigest = tableAggregateVerification.tableAggregatePublicKeyDigest;
    game.tableAggregatePublicKey = tableAggregateVerification.aggregatePublicKey;
    transitionTableProtocol(game, TableProtocolState.tableAggregatePublicKey({
      publicKeyShares: tableAggregateVerification.publicKeyShares,
      signatureShares: tableAggregateVerification.signatureShares,
      aggregatePublicKey: tableAggregateVerification.aggregatePublicKey,
      digest: tableAggregateVerification.tableAggregatePublicKeyDigest,
    }));

    if (tableAggregateVerification.complete && !tableAggregateVerification.signed) {
      return true;
    }

    if (!tableAggregateVerification.signed) {
      if (tableAggregateVerification.publicKeyAdded) {
        publishTableAggregatePublicKeyMessage(game, tableAggregateVerification);
      }
      return false;
    }

    appendGameLog(
      `Table aggregate public key signed by Player ${game.clientState.player_index + 1}`,
      senderForSeat(game.clientState.player_index),
    );

    if (tableAggregateVerification.complete) {
      const { hash, aggregatePublicKey } = await setTableAggregatePublicKeyOnChain({
        lobbyId,
        tableId,
        tableSeats: announcedSeats,
        tableAggregateVerification,
        operatorPrivateKey: game.operatorPrivateKey,
      });
      game.tableAggregatePublicKey = aggregatePublicKey;
      const nextHandId = Number(game.clientState.hand_id ?? 0) + 1;
      transitionTableProtocol(game, TableProtocolState.startHand({
        handId: nextHandId,
        confirmations: [],
      }));
      appendGameLog(hash
        ? `Table aggregate public key submitted on-chain: ${hash}`
        : 'Table aggregate public key already set on-chain');
      publishStartHandMessage(game, null, nextHandId);
      return true;
    }

    publishTableAggregatePublicKeyMessage(game, tableAggregateVerification);
    return false;
  }, [
    appendGameLog,
    buildNextTableAggregatePublicKeyVerification,
    lobbyId,
    publishTableAggregatePublicKeyMessage,
    requiredTableAggregateSeats,
    senderForSeat,
    setTableAggregatePublicKeyOnChain,
    publishStartHandMessage,
    tableId,
  ]);

  const ensureTableAggregatePublicKey = useCallback(async (game) => {
    if (!game) return false;
    if (protocolType(game) !== TABLE_PROTOCOL_STATE_TABLE_AGGREGATE_PUBLIC_KEY) return true;
    if (game.tableAggregatePublicKeyPromise) return game.tableAggregatePublicKeyPromise;
    if (Number(game.clientState?.hand_id ?? 0) > 0) {
      transitionTableProtocol(game, TableProtocolState.handInProgress({
        handId: Number(game.clientState.hand_id),
        handSetup: game.currentHandSetup,
      }));
      return true;
    }

    const submitPromise = submitTableAggregatePublicKeyRound(game);

    game.tableAggregatePublicKeyPromise = submitPromise;
    try {
      return await submitPromise;
    } finally {
      game.tableAggregatePublicKeyPromise = null;
    }
  }, [submitTableAggregatePublicKeyRound]);

  const signWireHistoryEntry = useCallback((wire, game = gameRef.current) => {
    if (wire?.nop || !wire?.sequence_number || !game?.tableSigningKey || !game?.tablePublicKey) return null;
    const encodedWire = encodeWire(wire);
    const signature = blsSign(historyEntryPayload(encodedWire), game.tableSigningKey);
    return {
      sequence_number: Number(encodedWire.sequence_number ?? 0),
      from: encodedWire.from,
      wire: encodedWire,
      action_signature: {
        scheme: ACTION_SIGNATURE_SCHEME,
        signer_seat: encodedWire.from,
        public_key: hexPoint(game.tablePublicKey.toRawBytes(true)),
        signature: hexPoint(signature.toRawBytes(true)),
      },
    };
  }, []);

  const verifyHistoryEntrySignature = useCallback((entry) => {
    const wire = entry?.wire;
    const signature = entry?.action_signature;
    const signerSeat = Number(entry?.from ?? wire?.from);
    if (!wire || !signature?.signature || !Number.isInteger(signerSeat)) return false;
    if (Number(wire.from) !== signerSeat) return false;
    if (signature.scheme !== ACTION_SIGNATURE_SCHEME) return false;
    if (signature.signer_seat != null && Number(signature.signer_seat) !== signerSeat) return false;

    const expectedPublicKey = tableSeats[signerSeat]?.announcePublicKey;
    if (!expectedPublicKey) return false;
    if (
      signature.public_key
      && signature.public_key.toLowerCase() !== expectedPublicKey.toLowerCase()
    ) return false;

    try {
      const publicKey = make_public_key_from_compressed_slice(hexToBytes(ensureHexPrefix(expectedPublicKey)));
      const signed = make_signature_from_compressed_slice(hexToBytes(ensureHexPrefix(signature.signature)));
      return blsVerify(historyEntryPayload(wire), publicKey, signed);
    } catch {
      return false;
    }
  }, [tableSeats]);

  const rememberHistoryEntry = useCallback((entry) => {
    if (!entry?.wire?.sequence_number) return;
    const key = wireHistoryKey(entry.wire);
    const currentHistory = handHistoryRef.current ?? [];
    if (currentHistory.some((entry) => wireHistoryKey(entry.wire) === key)) return;
    handHistoryRef.current = [
      ...currentHistory,
      entry,
    ].sort((left, right) => Number(left.sequence_number ?? 0) - Number(right.sequence_number ?? 0));
  }, []);

  const rememberWire = useCallback((wire, entry = null) => {
    const historyEntry = entry ?? signWireHistoryEntry(wire);
    if (historyEntry) rememberHistoryEntry(historyEntry);
  }, [rememberHistoryEntry, signWireHistoryEntry]);

  const publishWire = useCallback((wire, { sync = false } = {}) => {
    const game = gameRef.current;
    const entry = signWireHistoryEntry(wire, game);
    if (entry) rememberHistoryEntry(entry);
    const handHistory = [...(handHistoryRef.current ?? [])];
    const latestHandHistorySequence = Math.max(
      tableSequenceNumber(game),
      handHistorySequenceNumber(handHistory),
      Number(wire.sequence_number ?? 0),
    );
    if (wire.nop) {
      wire.sequence_number = latestHandHistorySequence;
    }
    const handFinished = game?.clientState?.current_hand?.()?.get_current_state?.()?.is_finished?.() === true;
    const message = {
      type: HISTORY_MESSAGE,
      ...tokenRing.messageFields(game, {
        currentPlayer: handFinished ? 0 : undefined,
      }),
      table_id: wire.table_id,
      hand_id: wire.hand_id,
      hand_number: wire.hand_id,
      hand_setup: game?.currentHandSetup ?? null,
      timestamp: Date.now(),
      sync,
      sequence_number: latestHandHistorySequence,
      hand_history: handHistory,
      wire: encodeWire(wire),
    };
    publishTokenMessage(message);
  }, [
    publishTokenMessage,
    rememberHistoryEntry,
    signWireHistoryEntry,
    tokenRing,
  ]);

  const applyDebugCheatsToWire = useCallback((wire, game) => {
    const cheats = debugCheatsRef.current;
    if (cheats.badUnmask && corruptUnmaskWire(wire)) {
      cheats.badUnmask = false;
      const report = { player: game.clientState.player_index, kind: 'UNMASKING' };
      cheatReportRef.current = report;
      setCheatReport(report);
    }

    if (wire?.action?.type === 'SubmitPublicKey') {
      if (cheats.badShuffle && corruptShuffleTrace(wire)) {
        cheats.badShuffle = false;
        const report = { player: wire.action.player, kind: 'SHUFFLE' };
        cheatReportRef.current = report;
        setCheatReport(report);
      }

      if (cheats.badPk && corruptPublicKey(wire, game)) {
        cheats.badPk = false;
        const report = { player: wire.action.player, kind: 'PUBLIC KEY' };
        cheatReportRef.current = report;
        setCheatReport(report);
      }
    }

    return wire;
  }, []);

  const submitChat = useCallback((text) => {
    const chatText = text?.trim();
    if (!chatText) return false;

    publishTokenMessage({
      type: CHAT_MESSAGE,
      ...tokenRing.messageFields(gameRef.current),
      text: chatText,
    });
    appendGameLog(chatText, 'Me');
    return true;
  }, [appendGameLog, publishTokenMessage, tokenRing]);

  const armPokerDebugCheat = useCallback((name) => {
    switch (name) {
      case 'badpk':
        debugCheatsRef.current.badPk = true;
        return true;
      case 'badshuffle':
        debugCheatsRef.current.badShuffle = true;
        return true;
      case 'badunmask':
        debugCheatsRef.current.badUnmask = true;
        return true;
      default:
        return false;
    }
  }, []);

  const submitNop = useCallback((game, currentPlayer = currentActingPlayer(game), { sync = false } = {}) => {
    if (!game || currentPlayer == null) return null;
    const wire = game.clientState.submit_nop({
      current_player: currentPlayer,
      reason: 'hand history forwarded',
    });
    publishWire(wire, { sync });
    return wire;
  }, [publishWire]);

  const submitAction = useCallback((action, logLines) => {
    const game = gameRef.current;
    if (!game) return null;

    let envelope;
    try {
      envelope = game.clientState.submit_local_action(action);
    } catch (error) {
      const report = cheatReportFromError(error, action.player);
      if (report) {
        cheatReportRef.current = report;
        setCheatReport(report);
      }
      appendGameLog(formatPokerProtocolError(error, action.player), 'Game', 'error');
      updateView({ force: true });
      return null;
    }

    const displayLines = botTraceLines(game, action, envelope.result, logLines);
    const wire = envelope.to_wire(displayLines);
    applyDebugCheatsToWire(wire, game);
    publishWire(wire);
    appendTraceLines(displayLines, action.player);
    updateView();
    return wire;
  }, [appendGameLog, appendTraceLines, applyDebugCheatsToWire, publishWire, updateView]);

  const buildAutomaticAction = useCallback((game) => {
    const hand = game.clientState.current_hand();
    const pokerState = hand.get_current_state().to_enum();
    const playerIndex = game.clientState.player_index;

    if ('player' in pokerState && pokerState.player !== playerIndex) return null;

    switch (pokerState.type) {
      case 'Shuffle': {
        const cards = pokerState.is_dealer
          ? hand.get_poker_deck().masked_cards()
          : hand.get_shuffled_deck().clone();
        cards.mask(game.signingKey);
        game.shuffleTrace = cards.shuffle_traced(createCryptoRng());
        return {
          action: PokerAction.SubmitShuffledDeck({ player: playerIndex, deck: cards }),
          logLines: [`Shuffle on Player ${playerIndex + 1} (is_dealer=${pokerState.is_dealer})`],
        };
      }
      case 'UnmaskHoleCards': {
        const cards = hand.get_player_cards().map((cardSet) => cardSet.clone());
        cards.forEach((cardSet, index) => {
          if (index !== playerIndex) cardSet.unmask(game.signingKey);
        });
        return {
          action: PokerAction.SubmitPlayerCards({ player: playerIndex, cards }),
          logLines: [`Unmask Hole Cards on Player ${playerIndex + 1}`],
        };
      }
      case 'UnmaskCommunityCards': {
        const cards = hand.get_community_cards(pokerState.round)?.clone();
        if (!cards) throw new Error('No community cards for round');
        cards.unmask(game.signingKey);
        return {
          action: PokerAction.SubmitCommunityCards({
            player: playerIndex,
            round: pokerState.round,
            cards,
          }),
          logLines: [`Round ${pokerState.round + 1} Unmask Community Cards on Player ${playerIndex + 1}`],
        };
      }
      case 'UnmaskShowdown': {
        const cards = hand.get_player_cards().map((cardSet) => cardSet.clone());
        cards[playerIndex].unmask(game.signingKey);
        return {
          action: PokerAction.SubmitShowdownCards({ player: playerIndex, cards }),
          logLines: [`Unmask Showdown on Player ${playerIndex + 1}`],
        };
      }
      case 'SubmitPublicKey': {
        const traces = game.shuffleTrace
          ?? reconstructShuffleTrace(hand, playerIndex, game.signingKey);
        if (!traces) return null;
        game.shuffleTrace = traces;
        return {
          action: PokerAction.SubmitPublicKey({
            player: playerIndex,
            public_key: game.publicKey,
            traces,
          }),
          logLines: [`Submit Public Key on Player ${playerIndex + 1}`],
        };
      }
      case 'Bet':
      case 'Finished':
        return null;
      default:
        return null;
    }
  }, []);

  const publishSettleHandMessage = useCallback((game, finalVerification, handId = null) => {
    const messageHandId = handId ?? game?.clientState?.hand_id;
    const nextPlayer = Number.isFinite(Number(finalVerification.nextSeat))
      ? Number(finalVerification.nextSeat)
      : null;
    publishTokenMessage({
      type: SETTLE_HAND_MESSAGE,
      ...tokenRing.messageFields(game, {
        currentHand: Number(messageHandId),
        currentPlayer: nextPlayer,
      }),
      lobby_id: lobbyId?.toString?.() ?? String(lobbyId ?? ''),
      table_id: tableId?.toString?.() ?? String(tableId ?? ''),
      hand_id: messageHandId,
      hand_number: messageHandId,
      hand_setup: game?.currentHandSetup ?? null,
      hand_history: [...(handHistoryRef.current ?? [])],
      final_hand_digest: finalVerification.finalHandDigest,
      settlement_digest: finalVerification.settlementDigest,
      public_key_shares: finalVerification.publicKeyShares,
      signature_shares: finalVerification.signatureShares,
      signer_seats: finalVerification.signerSeats,
      aggregate_signature: finalVerification.aggregateSignature,
      aggregate_public_key: finalVerification.aggregatePublicKey,
      settlement: finalVerification.settlementMessage ?? null,
    });
  }, [lobbyId, publishTokenMessage, tableId, tokenRing]);

  const publishTableCompleteMessage = useCallback((
    game,
    {
      handId = null,
      settlement = null,
      tx = null,
      currentPlayer = 0,
      originSeat = 0,
      visitedSeats = [],
      circulationComplete = false,
    } = {},
  ) => {
    const messageHandId = handId ?? game?.clientState?.hand_id;
    publishTokenMessage({
      type: TABLE_COMPLETE_MESSAGE,
      ...tokenRing.messageFields(game, {
        currentHand: Number(messageHandId),
        currentPlayer,
      }),
      lobby_id: lobbyId?.toString?.() ?? String(lobbyId ?? ''),
      table_id: tableId?.toString?.() ?? String(tableId ?? ''),
      hand_id: messageHandId,
      hand_number: messageHandId,
      settlement,
      tx,
      origin_seat: originSeat,
      visited_seats: visitedSeats,
      circulation_complete: circulationComplete,
    });
  }, [lobbyId, publishTokenMessage, tableId, tokenRing]);

  const submitFinalVerificationRound = useCallback(async (game, incoming = null) => {
    const hand = game?.clientState?.current_hand?.();
    if (!game || !hand?.get_current_state?.().is_finished?.()) return false;
    if (finalVerificationInFlightRef.current) return false;

    const handId = game.clientState.hand_id ?? HAND_ID;
    if (protocolType(game) !== TABLE_PROTOCOL_STATE_SETTLE_HAND) {
      transitionTableProtocol(game, TableProtocolState.settleHand({ handId }));
    }
    const state = settleHandState(game, handId);
    if (state.tx && Number(state.handId) === Number(handId)) {
      return true;
    }
    finalVerificationInFlightRef.current = true;
    try {
      const incomingSignatureShares = Array.isArray(incoming) ? incoming : incoming?.signatureShares;
      const incomingPublicKeyShares = Array.isArray(incoming) ? null : incoming?.publicKeyShares;
      const publicKeyShares = incomingPublicKeyShares
        ?? game.tableAggregatePublicKeyPublicKeyShares
        ?? [];
      const signatureShares = incomingSignatureShares
        ?? state.signatureShares
        ?? game.finalVerificationSignatureShares
        ?? [];
      const finalVerification = buildNextFinalVerification({
        lobbyId,
        tableId,
        handId,
        hand,
        handSetup: game.currentHandSetup,
        handHistoryEntries: handHistoryRef.current,
        tableSeats,
        publicKeyShares,
        settlement: buildFinalHandSettlement(hand, tableSeats),
        signatureShares,
        currentSeatNo: game.clientState.player_index,
        signingKey: game.tableSigningKey,
        publicKey: game.tableSignaturePublicKey,
      });

      game.finalVerificationSignatureShares = finalVerification.signatureShares;
      game.finalVerificationDigest = finalVerification.finalHandDigest;
      game.finalHandSettlement = finalVerification.settlementMessage;
      transitionTableProtocol(game, TableProtocolState.settleHand({
        handId,
        publicKeyShares: finalVerification.publicKeyShares,
        signatureShares: finalVerification.signatureShares,
        digest: finalVerification.finalHandDigest,
        settlement: finalVerification.settlementMessage,
      }));
      if (playerCompletedFinalSettlement(game, game.clientState.player_index)) {
        game.finalHandSettlement = finalVerification.settlementMessage;
      }

      if (!finalVerification.signed) return false;

      appendGameLog(
        `Final verification signed by Player ${game.clientState.player_index + 1}`,
        senderForSeat(game.clientState.player_index),
      );

      if (finalVerification.complete) {
        const hash = await submitFinalHandOnChain({
          lobbyId,
          tableId,
          handId,
          finalVerification,
          operatorPrivateKey: game.operatorPrivateKey,
        });
        game.finalVerificationSettlementTx = hash;
        appendGameLog(`Final hand settlement submitted on-chain: ${hash}`);
        const nextStacks = finalHandStacks(hand);
        const playersWithChips = nextStacks.filter((chips) => Number(chips) > 0).length;
        const isLastHand = playersWithChips <= 1;

        startCountdown(5, () => {
          if (isLastHand) {
            transitionTableProtocol(game, TableProtocolState.tableComplete({
              handId,
              settlement: finalVerification.settlementMessage,
              tx: hash,
            }));
            const seatCount = requiredStartHandSeats();
            if (seatCount <= 1 && game.clientState.player_index === 0) {
              setTerminalResult(terminalResultFromSettlement(
                finalVerification.settlementMessage,
                tableSeats,
                game.clientState.player_index,
                true,
              ));
            } else {
              publishTableCompleteMessage(game, {
                handId,
                settlement: finalVerification.settlementMessage,
                tx: hash,
                currentPlayer: 0,
                originSeat: 0,
                visitedSeats: [],
                circulationComplete: false,
              });
            }
          } else {
            const nextHandId = Number(handId) + 1;
            transitionTableProtocol(game, TableProtocolState.startHand({
              handId: nextHandId,
              confirmations: [],
            }));
            publishStartHandMessage(game, null, nextHandId);
          }
          updateView({ force: true });
        });
        transitionTableProtocol(game, {
          ...game.tableProtocolState,
          tx: hash,
        });
        return true;
      }
      publishSettleHandMessage(game, finalVerification, handId);
      return true;
    } catch (error) {
      transitionTableProtocol(game, TableProtocolState.handDisputed({
        handId,
        reason: formatChainError(error),
      }));
      appendGameLog(
        `Final verification failed: ${formatChainError(error)}`,
        'Game',
        'error',
      );
      return false;
    } finally {
      finalVerificationInFlightRef.current = false;
    }
  }, [
    appendGameLog,
    buildNextFinalVerification,
    lobbyId,
    publishTableCompleteMessage,
    publishSettleHandMessage,
    publishStartHandMessage,
    requiredStartHandSeats,
    senderForSeat,
    startCountdown,
    submitFinalHandOnChain,
    tableId,
    tableSeats,
    updateView,
  ]);

  const submitProtocolAction = useCallback(async () => {
    let game = await ensureKeys();
    if (!game) return null;
    if (!await ensureTableAggregatePublicKey(game)) return null;
    const stateType = protocolType(game);
    if (stateType === TABLE_PROTOCOL_STATE_HAND_DISPUTED || stateType === TABLE_PROTOCOL_STATE_TABLE_COMPLETE) {
      updateView({ force: true });
      return null;
    }
    if (stateType === TABLE_PROTOCOL_STATE_SETTLE_HAND) {
      await submitFinalVerificationRound(game);
      updateView({ force: true });
      return null;
    }
    if (stateType === TABLE_PROTOCOL_STATE_START_HAND && !await ensureOnChainStartHand(game)) {
      updateView({ force: true });
      return null;
    }
    game = await ensureKeys(gameRef.current?.clientState?.hand_id ?? game.clientState.hand_id);
    if (!game) return null;
    const hand = game.clientState.current_hand();
    if (!hand) return null;

    const handState = hand.get_current_state();
    if (handState.current_state === POKER_HAND_STATE_FINISHED) {
      if (!game.seenFinished) {
        game.seenFinished = true;
      }
      await submitFinalVerificationRound(game);
      updateView();
      return null;
    }

    if (
      handState.current_state === POKER_HAND_STATE_SMALL_BLIND
      || handState.current_state === POKER_HAND_STATE_BIG_BLIND
    ) {
      return null;
    }

    if (handState.current_state === POKER_HAND_STATE_BET) {
      const player = game.clientState.player_index;
      if (
        handState.get_current_player() === player
        && isOnlyCheckBetState(hand, player)
      ) {
        return submitAction(
          PokerAction.SubmitBet({ player, amount: 0 }),
          [`Player ${player + 1} Bet: $0`],
        );
      }
      return null;
    }

    if (handState.get_current_player() !== game.clientState.player_index) {
      return submitNop(game, handState.get_current_player());
    }

    const actionKey = `${game.clientState.hand_id}:${handState.to_tuple().join(':')}`;
    if (protocolActionInFlightRef.current === actionKey) return null;

    protocolActionInFlightRef.current = actionKey;
    try {
      const built = buildAutomaticAction(game);
      if (!built) return null;
      const wire = submitAction(built.action, built.logLines);
      if (wire && built.action.type === 'SubmitPublicKey') {
        game.publicKeySubmissions ??= new Map();
        game.publicKeySubmissions.set(built.action.player, {
          publicKey: built.action.public_key,
          traces: built.action.traces,
        });
        if (hand.get_current_state().current_state === POKER_HAND_STATE_FINISHED) {
          transitionTableProtocol(game, TableProtocolState.settleHand({
            handId: game.clientState.hand_id,
          }));
          if (game.clientState.player_index === 0) {
            await submitFinalVerificationRound(game);
          }
        }
        game.shuffleTrace = null;
      }
      return wire;
    } finally {
      if (protocolActionInFlightRef.current === actionKey) {
        protocolActionInFlightRef.current = null;
      }
    }
  }, [
    buildAutomaticAction,
    ensureKeys,
    ensureTableAggregatePublicKey,
    ensureOnChainStartHand,
    submitAction,
    submitNop,
    submitFinalVerificationRound,
    updateView,
  ]);

  // TODO: Do we need this?
  // useEffect(() => {
  //   if (snapshot.currentGameState?.tableProtocolState !== TABLE_PROTOCOL_STATE_SETTLE_HAND) return;
  //   submitFinalVerificationRound(gameRef.current);
  // }, [snapshot.currentGameState?.tableProtocolState, submitFinalVerificationRound]);

  const startNextHand = useCallback(() => {
    const game = gameRef.current;
    if (!game || protocolType(game) !== TABLE_PROTOCOL_STATE_START_HAND) return false;
    const handId = Number(startHandState(game).handId ?? nextOnChainHandId(game));
    if (!startHandRoundComplete(game, handId)) return false;
    markOnChainHandStarted(game, handId);
    const events = game.clientState.table.drain_events?.() ?? [];
    appendTraceLines(eventDisplayLines(events), game.clientState.player_index);
    updateView({ force: true });
    return true;
  }, [
    appendTraceLines,
    markOnChainHandStarted,
    nextOnChainHandId,
    startHandRoundComplete,
    updateView,
  ]);

  const advanceToHistoryHand = useCallback(async (game, targetHandId) => {
    while (targetHandId > game.clientState.hand_id) {
      if (startNextHand()) continue;
      return false;
    }
    return true;
  }, [startNextHand]);

  const applyHistoryEntries = useCallback(async (historyEntries = [], playerAddress = null, tokenMessage = null) => {
    const game = gameRef.current ?? resetGame();
    if (!game || !Array.isArray(historyEntries)) return true;

    const orderedEntries = [...historyEntries]
      .sort((left, right) => Number(left.sequence_number ?? 0) - Number(right.sequence_number ?? 0));
    let latestAppliedAction = null;

    for (const entry of orderedEntries) {
      if (!verifyHistoryEntrySignature(entry)) {
        appendGameLog('Invalid signed hand history entry', senderForAddress(playerAddress), 'error');
        updateView({ force: true });
        return false;
      }

      const wire = decodeWire(entry.wire);

      const entrySequence = Number(entry.sequence_number ?? entry.wire?.sequence_number ?? 0);
      if (entrySequence <= tableSequenceNumber(game)) {
        rememberWire(wire, entry);
        continue;
      }

      if (!await advanceToHistoryHand(game, Number(wire.hand_id))) return true;
      if (wire.hand_id !== game.clientState.hand_id) continue;
      await ensureKeys(wire.hand_id);

      if (wire.nop) {
        if (game.clientState.apply_nop_wire(wire)) {
          rememberWire(wire, entry);
        }
        continue;
      }

      let envelope;
      let appliedResult;
      try {
        envelope = wire.to_envelope();
        appliedResult = game.clientState.apply_envelope_result(envelope);
      } catch (error) {
        appendGameLog(
          formatPokerProtocolError(error, wire?.action?.player),
          senderForAddress(playerAddress),
          'error',
        );
        updateView({ force: true });
        return true;
      }

      const { applied, result } = appliedResult;
      if (applied) {
        rememberWire(wire, entry);
        if (wire?.action?.type === 'SubmitPublicKey') {
          game.publicKeySubmissions ??= new Map();
          game.publicKeySubmissions.set(wire.action.player, {
            publicKey: wire.action.public_key,
            traces: wire.action.traces,
          });
        }
        const displayLines = wire.log_lines?.length > 0
          ? wire.log_lines
          : eventDisplayLines(result?.events);
        latestAppliedAction = { displayLines, from: envelope.from };
      } else {
        console.warn('[Poker history] newer entry not applied', {
          entrySequence,
          tableSequence: tableSequenceNumber(game),
          from: wire.from,
          sequence: wire.sequence,
          expectedState: wire.expected_state,
          result: appliedResult,
          wire: entry.wire,
        });
        const reason = appliedResult?.mismatch
          ? `state mismatch local=${JSON.stringify(appliedResult.mismatch.local)} expected=${JSON.stringify(appliedResult.mismatch.remote_expected)}`
          : 'duplicate or rejected';
        appendGameLog(`History action ${entrySequence} not applied: ${reason}`, senderForAddress(playerAddress), 'error');
        updateView({ force: true });
        return false;
      }
    }

    if (latestAppliedAction) {
      appendTraceLines(latestAppliedAction.displayLines, latestAppliedAction.from);
    }
    if (game.clientState.current_hand()?.get_current_state?.().is_finished?.()) {
      transitionTableProtocol(game, TableProtocolState.settleHand({
        handId: game.clientState.hand_id,
      }));
      if (tokenRing.targetsCurrentSeat(tokenMessage)) {
        await submitFinalVerificationRound(game);
      }
    }
    updateView({ force: true });
    return true;
  }, [
    appendGameLog,
    appendTraceLines,
    rememberWire,
    resetGame,
    ensureKeys,
    advanceToHistoryHand,
    senderForAddress,
    submitFinalVerificationRound,
    tokenRing,
    updateView,
    verifyHistoryEntrySignature,
  ]);

  const continueAfterPokerMessage = useCallback(async ({ sync = false } = {}) => {
    const game = gameRef.current;
    const hand = game?.clientState.current_hand();
    const handState = hand?.get_current_state();
    if (!game || !handState || handState?.is_finished()) {
      updateView({ force: true });
      return true;
    }

    if (handState.get_current_player() !== game.clientState.player_index) {
      submitNop(game, handState.get_current_player(), { sync });
      updateView({ force: true });
      return true;
    }

    const tipKey = handHistoryTipKey({
      tableId: game.clientState.table_id,
      handId: game.clientState.hand_id,
      historyEntries: handHistoryRef.current,
    });
    if (sync && !seenHistoryTipsRef.current.has(tipKey)) {
      seenHistoryTipsRef.current.add(tipKey);
      submitNop(game, handState.get_current_player(), { sync: true });
      updateView({ force: true });
      return true;
    }
    if (sync) {
      seenHistoryTipsRef.current.delete(tipKey);
    }

    if (!isHumanActionState(handState)) {
      await submitProtocolAction();
      return true;
    }

    updateView({ force: true });
    return true;
  }, [submitNop, submitProtocolAction, updateView]);

  const sendHistorySync = useCallback(() => {
    const game = gameRef.current ?? resetGame();
    if (!game) return false;
    submitNop(game, currentActingPlayer(game), { sync: true });
    appendGameLog('History sync sent', 'Game');
    return true;
  }, [appendGameLog, resetGame, submitNop]);

  const handleNetworkMessage = useCallback(async (message, playerAddress = null) => {
    if (
      message?.type !== HISTORY_MESSAGE
      && message?.type !== CHAT_MESSAGE
      && message?.type !== START_HAND_MESSAGE
      && message?.type !== TABLE_AGGREGATE_PUBLIC_KEY_MESSAGE
      && message?.type !== TABLE_COMPLETE_MESSAGE
      && message?.type !== SETTLE_HAND_MESSAGE
    ) return false;

    const game = gameRef.current ?? resetGame();
    if (game) tokenRing.applyCursor(game, message);

    if (message.type === CHAT_MESSAGE) {
      appendGameLog(message.text ?? '', senderForAddress(playerAddress));
      return true;
    }

    if (!game) return true;

    if (message.type === TABLE_COMPLETE_MESSAGE) {
      if (!tokenRing.targetsCurrentSeat(message)) {
        updateView({ force: true });
        return true;
      }

      const seatCount = requiredStartHandSeats();
      const playerIndex = seatNumberOrNull(currentSeatNo ?? game.clientState.player_index);
      const originSeat = seatNumberOrNull(message.origin_seat) ?? 0;
      const visitedSeats = uniqueSeatNumbers([
        ...(message.visited_seats ?? []),
        playerIndex,
      ], seatCount);
      const hasVisitedEverySeat = seatCount > 0 && visitedSeats.length >= seatCount;
      const circulationComplete = message.circulation_complete === true
        || (playerIndex === originSeat && hasVisitedEverySeat);
      const targetGame = await ensureKeys(Number(message.hand_number ?? message.hand_id ?? game.clientState.hand_id ?? HAND_ID))
        ?? game;
      tokenRing.applyCursor(targetGame, message);
      transitionTableProtocol(targetGame, TableProtocolState.tableComplete({
        handId: Number(message.hand_number ?? message.hand_id ?? targetGame.clientState.hand_id),
        settlement: message.settlement ?? null,
        tx: message.tx ?? null,
      }));
      targetGame.finalHandSettlement = message.settlement ?? targetGame.finalHandSettlement;
      targetGame.finalVerificationSettlementTx = message.tx ?? targetGame.finalVerificationSettlementTx;
      setTerminalResult(terminalResultFromSettlement(
        message.settlement,
        tableSeats,
        playerIndex,
        circulationComplete,
      ));

      const nextPlayer = tokenRing.nextSeatAfter(playerIndex, seatCount);
      const shouldForward = nextPlayer != null && (
        message.circulation_complete === true
          ? playerIndex !== originSeat
          : true
      );
      if (shouldForward) {
        publishTableCompleteMessage(targetGame, {
          handId: Number(message.hand_number ?? message.hand_id ?? targetGame.clientState.hand_id),
          settlement: message.settlement ?? null,
          tx: message.tx ?? null,
          currentPlayer: nextPlayer,
          originSeat,
          visitedSeats,
          circulationComplete,
        });
      }

      updateView({ force: true });
      return true;
    }

    if (message.type === TABLE_AGGREGATE_PUBLIC_KEY_MESSAGE) {
      try {
        if (!tokenRing.targetsCurrentSeat(message)) {
          updateView({ force: true });
          return true;
        }
        const keyedGame = await ensureKeys();
        tokenRing.applyCursor(keyedGame ?? game, message);
        const submitted = await submitTableAggregatePublicKeyRound(
          keyedGame ?? game,
          {
            publicKeyShares: message.public_key_shares ?? [],
            signatureShares: message.signature_shares ?? [],
          },
        );
        updateView({ force: true });
        if (submitted && currentSeatNo === 0 && protocolType(keyedGame ?? game) === TABLE_PROTOCOL_STATE_START_HAND) {
          await continueAfterPokerMessage();
        }
      } catch (error) {
        appendGameLog(
          `Table aggregate public key failed: ${formatChainError(error)}`,
          'Game',
          'error',
        );
        updateView({ force: true });
      }
      return true;
    }

    if (message.type === START_HAND_MESSAGE) {
      try {
        if (!tokenRing.targetsCurrentSeat(message)) {
          updateView({ force: true });
          return true;
        }
        const keyedGame = await ensureKeys(Number(message.hand_number ?? message.hand_id ?? HAND_ID));
        const targetGame = keyedGame ?? game;
        tokenRing.applyCursor(targetGame, message);
        transitionTableProtocol(targetGame, TableProtocolState.startHand({
          handId: Number(message.hand_number ?? message.hand_id ?? HAND_ID),
          confirmations: message.confirmations ?? startHandState(targetGame).confirmations ?? [],
        }));
        if (message.seat_no != null && message.tx) {
          recordStartHandConfirmation(
            targetGame,
            Number(message.seat_no),
            Number(message.hand_number ?? message.hand_id ?? HAND_ID),
            message.tx,
          );
        }
        const complete = await ensureOnChainStartHand(targetGame);
        if (complete && currentSeatNo === 0) {
          await continueAfterPokerMessage();
        }
        updateView({ force: true });
      } catch (error) {
        appendGameLog(
          `Start hand failed: ${formatChainError(error)}`,
          'Game',
          'error',
        );
        updateView({ force: true });
      }
      return true;
    }

    const messageHandNumber = Number(
      message.current_hand
      ?? message.hand_number
      ?? message.hand_id
      ?? game.clientState.hand_id,
    );
    const keyedGame = await ensureKeys(messageHandNumber);
    const targetGame = keyedGame ?? game;
    tokenRing.applyCursor(targetGame, message);

    const handHistory = Array.isArray(message.hand_history)
      ? message.hand_history
      : [];
    if (handHistory.length > 0) {
      const appliedHistory = await applyHistoryEntries(handHistory, playerAddress, message);
      if (!appliedHistory) return true;
    }

    if (message.type === SETTLE_HAND_MESSAGE) {
      if (!tokenRing.targetsCurrentSeat(message)) {
        updateView({ force: true });
        return true;
      }
      transitionTableProtocol(targetGame, TableProtocolState.settleHand({
        handId: messageHandNumber,
        publicKeyShares: message.public_key_shares ?? [],
        signatureShares: message.signature_shares ?? [],
        digest: message.final_hand_digest ?? null,
        settlement: message.settlement ?? null,
      }));
      await submitFinalVerificationRound(targetGame, {
        publicKeyShares: message.public_key_shares ?? [],
        signatureShares: message.signature_shares ?? [],
      });
      updateView({ force: true });
      return true;
    }

    const wire = decodeWire(message.wire);
    if (!await advanceToHistoryHand(targetGame, Number(wire.hand_id))) return true;
    await ensureKeys(wire.hand_id);

    if (wire.nop) {
      targetGame.clientState.apply_nop_wire(wire);
      if (!tokenRing.targetsCurrentSeat(message)) {
        updateView({ force: true });
        return true;
      }
      return continueAfterPokerMessage({ sync: message.sync === true });
    }

    const wireAlreadyInHistory = handHistory.some((entry) => (
      wireHistoryKey(entry?.wire) === wireHistoryKey(encodeWire(wire))
    ));
    if (wireAlreadyInHistory) {
      if (!tokenRing.targetsCurrentSeat(message)) {
        updateView({ force: true });
        return true;
      }
      return continueAfterPokerMessage({ sync: message.sync === true });
    }

    let envelope;
    let appliedResult;
    try {
      envelope = wire.to_envelope();
      appliedResult = targetGame.clientState.apply_envelope_result(envelope);
    } catch (error) {
      const report = cheatReportFromError(error, wire?.action?.player);
      if (report) {
        cheatReportRef.current = report;
        setCheatReport(report);
      }
      appendGameLog(
        formatPokerProtocolError(error, wire?.action?.player),
        senderForAddress(playerAddress),
        'error',
      );
      updateView({ force: true });
      return true;
    }

    const { applied, result } = appliedResult;
    if (applied) {
      const displayLines = wire.log_lines?.length > 0
        ? wire.log_lines
        : eventDisplayLines(result?.events);
      appendTraceLines(displayLines, envelope.from);
      const hand = targetGame.clientState.current_hand();
      const handState = hand?.get_current_state();
      if (handState?.is_finished()) {
        transitionTableProtocol(targetGame, TableProtocolState.settleHand({
          handId: targetGame.clientState.hand_id,
        }));
        if (tokenRing.targetsCurrentSeat(message)) {
          await submitFinalVerificationRound(targetGame);
        }
        updateView({ force: true });
        return true;
      }

      if (!tokenRing.targetsCurrentSeat(message)) {
        updateView({ force: true });
        return true;
      }
      return continueAfterPokerMessage({ sync: message.sync === true });
    }
    return true;
  }, [
    appendGameLog,
    appendTraceLines,
    advanceToHistoryHand,
    applyHistoryEntries,
    continueAfterPokerMessage,
    currentSeatNo,
    ensureOnChainStartHand,
    ensureKeys,
    publishTableCompleteMessage,
    recordStartHandConfirmation,
    resetGame,
    requiredStartHandSeats,
    senderForAddress,
    submitFinalVerificationRound,
    submitTableAggregatePublicKeyRound,
    tableSeats,
    tokenRing,
    updateView,
  ]);

  const submitBet = useCallback(async (amount) => {
    let game = await ensureKeys();
    if (!game) return;
    if (!await ensureTableAggregatePublicKey(game)) return;
    if (!await ensureOnChainStartHand(game)) {
      updateView({ force: true });
      return;
    }
    game = await ensureKeys(gameRef.current?.clientState?.hand_id ?? game.clientState.hand_id);
    if (!game) return;
    const hand = game.clientState.current_hand();
    const state = hand?.get_current_state();
    if (!state || state.current_state !== POKER_HAND_STATE_BET) return;
    if (state.get_current_player() !== game.clientState.player_index) return;

    const player = game.clientState.player_index;
    const remainingChips = safeChipsRemaining(hand, player);
    const cappedAmount = Math.max(0, Math.min(Number(amount), remainingChips));
    submitAction(
      PokerAction.SubmitBet({ player, amount: cappedAmount }),
      [`Player ${player + 1} Bet: $${cappedAmount}`],
    );
  }, [ensureKeys, ensureOnChainStartHand, ensureTableAggregatePublicKey, submitAction, updateView]);

  const submitBlind = useCallback(async () => {
    let game = await ensureKeys();
    if (!game) return;
    if (!await ensureTableAggregatePublicKey(game)) return;
    if (!await ensureOnChainStartHand(game)) {
      updateView({ force: true });
      return;
    }
    game = await ensureKeys(gameRef.current?.clientState?.hand_id ?? game.clientState.hand_id);
    if (!game) return;
    const hand = game.clientState.current_hand();
    const state = hand?.get_current_state();
    if (!state) return;
    if (state.get_current_player() !== game.clientState.player_index) return;

    const player = game.clientState.player_index;
    if (state.current_state === POKER_HAND_STATE_SMALL_BLIND) {
      submitAction(
        PokerAction.SubmitSmallBlind({ player }),
        [`Small Blind on Player ${player + 1}`],
      );
      return;
    }

    if (state.current_state === POKER_HAND_STATE_BIG_BLIND) {
      submitAction(
        PokerAction.SubmitBigBlind({ player }),
        [`Big Blind on Player ${player + 1}`],
      );
    }
  }, [ensureKeys, ensureOnChainStartHand, ensureTableAggregatePublicKey, submitAction, updateView]);

  const completeCheatCountdown = useCallback(() => {
    const report = cheatReportRef.current;
    if (!report) return false;
    const playerIndex = gameRef.current?.clientState?.player_index;
    setTerminalResult({
      type: 'cheated',
      cheat: {
        ...report,
        isViewerCheater: report.player === playerIndex,
      },
    });
    updateView({ force: true });
    return true;
  }, [updateView]);

  useEffect(() => {
    if (tokenRingSnapshot?.status !== 'connected') return;
    if (table?.currentSeat?.seatNo == null) return;
    ensureKeys().then(() => {
      updateView();
    });
  }, [ensureKeys, tokenRingSnapshot?.status, table?.currentSeat?.seatNo, updateView]);

  // useEffect(() => {
  //   const connected = tokenRingSnapshot?.inboundState === 'Connected'
  //     && tokenRingSnapshot?.outboundState === 'Connected';
  //   const wasConnected = previousConnectedRef.current;
  //   previousConnectedRef.current = connected;

  //   if (!connected) {
  //     if (wasConnected) pendingHistorySyncRef.current = true;
  //     return;
  //   }

  //   if (
  //     wasConnected
  //     && protocolType(gameRef.current) !== TABLE_PROTOCOL_STATE_TABLE_AGGREGATE_PUBLIC_KEY
  //   ) return;

  //   ensureKeys().then(async (game) => {
  //     if (!game) return;
  //     if (
  //       protocolType(game) === TABLE_PROTOCOL_STATE_TABLE_AGGREGATE_PUBLIC_KEY
  //       && currentSeatNo !== 0
  //     ) {
  //       updateView({ force: true });
  //       return;
  //     }
  //     if (!await ensureTableAggregatePublicKey(game)) return;
  //     if (pendingHistorySyncRef.current) {
  //       pendingHistorySyncRef.current = false;
  //       sendHistorySync();
  //       return;
  //     }
  //     if (currentSeatNo === 0) {
  //       continueAfterPokerMessage();
  //     }
  //   }).catch((error) => {
  //     appendGameLog(
  //       `Table setup failed: ${formatChainError(error)}`,
  //       'Game',
  //       'error',
  //     );
  //     updateView({ force: true });
  //   });
  // }, [
  //   appendGameLog,
  //   continueAfterPokerMessage,
  //   currentSeatNo,
  //   ensureKeys,
  //   ensureTableAggregatePublicKey,
  //   tokenRingSnapshot?.inboundState,
  //   tokenRingSnapshot?.outboundState,
  //   sendHistorySync,
  //   updateView,
  // ]);

  const effectInitializedRef = useRef(false);

  useEffect(() => {
    const connected = tokenRingSnapshot?.inboundState === 'Connected'
      && tokenRingSnapshot?.outboundState === 'Connected';
    const wasConnected = previousConnectedRef.current;
    previousConnectedRef.current = connected;

    if (!connected) {
      if (wasConnected) pendingHistorySyncRef.current = true;
      effectInitializedRef.current = false; // Reset lock if disconnected
      return;
    }

    // Prevent running repeatedly on every render if already initialized for this connection
    if (effectInitializedRef.current) return;
    effectInitializedRef.current = true;

    if (
      wasConnected
      && protocolType(gameRef.current) !== TABLE_PROTOCOL_STATE_TABLE_AGGREGATE_PUBLIC_KEY
    ) return;

    ensureKeys().then(async (game) => {
      if (!game) return;
      if (
        protocolType(game) === TABLE_PROTOCOL_STATE_TABLE_AGGREGATE_PUBLIC_KEY
        && currentSeatNo !== 0
      ) {
        updateView({ force: true });
        return;
      }
      if (!await ensureTableAggregatePublicKey(game)) return;
      if (pendingHistorySyncRef.current) {
        pendingHistorySyncRef.current = false;
        sendHistorySync();
        return;
      }
      if (currentSeatNo === 0) {
        continueAfterPokerMessage();
      }
    }).catch((error) => {
      appendGameLog(
        `Table setup failed: ${formatChainError(error)}`,
        'Game',
        'error',
      );
      updateView({ force: true });
    });
  }, [
    currentSeatNo,
    tokenRingSnapshot?.inboundState,
    tokenRingSnapshot?.outboundState,
  ]);

  const actionBarProps = useMemo(() => {
    const remainingChips = Math.max(Number(snapshot.maxBet ?? 0), 0);
    const callAmount = Math.max(Math.min(Number(snapshot.minBet ?? 0), remainingChips), 0);
    const allInMode = !snapshot.onlyCallMode && !snapshot.waitingForBlind && remainingChips < callAmount * 2;
    const maxBet = remainingChips;
    const minimumSliderBet = Math.ceil(maxBet / 12);
    const minBet = snapshot.waitingForBlind
      ? callAmount
      : allInMode
        ? remainingChips
        : Math.max(Math.min(Math.max(callAmount * 2, minimumSliderBet), remainingChips), 0);
    const actionAmount = allInMode
      ? remainingChips
      : Math.max(Math.min(Number(snapshot.actionAmount ?? minBet), remainingChips), 0);

    return {
      minBet,
      maxBet,
      step: Math.max(1, Math.round((maxBet - minBet) / 12)),
      visible: snapshot.showActionBar,
      disabled: !snapshot.showActionBar,
      sliderDisabled: snapshot.sliderDisabled || allInMode || snapshot.onlyCallMode,
      hideCall: snapshot.hideCall || allInMode,
      hideFold: snapshot.hideFold || callAmount === 0,
      hideRaise: snapshot.onlyCallMode,
      callAmount,
      remainingChips,
      primaryLabel: allInMode ? 'All In' : snapshot.primaryLabel,
      primaryAmount: snapshot.waitingForBlind || allInMode ? actionAmount : null,
      onFold: () => submitBet(0),
      onCall: () => submitBet(callAmount),
      onRaise: (amount) => (snapshot.waitingForBlind ? submitBlind() : submitBet(amount)),
    };
  }, [
    snapshot.actionAmount,
    snapshot.hideCall,
    snapshot.hideFold,
    snapshot.maxBet,
    snapshot.minBet,
    snapshot.onlyCallMode,
    snapshot.primaryLabel,
    snapshot.showActionBar,
    snapshot.sliderDisabled,
    snapshot.waitingForBlind,
    submitBet,
    submitBlind,
  ]);

  const pokerTableState = useMemo(() => ({
    ...snapshot,
    gameMessages,
    actionBarProps,
    cheatReport,
    terminalResult,
  }), [actionBarProps, cheatReport, gameMessages, snapshot, terminalResult]);

  const pokerTableActions = useMemo(() => ({
    handleNetworkMessage,
    armPokerDebugCheat,
    completeCheatCountdown,
    submitProtocolAction,
    submitBet,
    submitChat,
    startNextHand,
  }), [
    armPokerDebugCheat,
    completeCheatCountdown,
    handleNetworkMessage,
    startNextHand,
    submitBet,
    submitChat,
    submitProtocolAction,
  ]);

  return [pokerTableState, pokerTableActions];
}
