import { bytesToHex, hexToBytes } from 'privatepoker-hooks/crypto/bls';
import {
  PokerActionEnvelopeWire,
  poker_action_wire_to_submit,
  poker_submit_to_action_wire,
} from 'privatepoker-hooks/poker/core/crum_net';

const textEncoder = new TextEncoder();

export function hexPoint(bytes) {
  return bytesToHex(bytes, { prefix: true });
}

export function encodeCardSetWire(cards) {
  return cards.map(hexPoint);
}

function bytesPoint(hex) {
  return hexToBytes(hex);
}

function decodeCardSetWire(cards) {
  return cards.map(bytesPoint);
}

export function encodePokerWire(wire) {
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
      encoded.action.deck_g1_compressed = encodeCardSetWire(action.deck_g1_compressed);
      break;
    case 'SubmitPlayerCards':
    case 'SubmitShowdownCards':
      encoded.action.player_cards_g1_compressed = action.player_cards_g1_compressed.map(encodeCardSetWire);
      break;
    case 'SubmitCommunityCards':
      encoded.action.round = action.round;
      encoded.action.cards_g1_compressed = encodeCardSetWire(action.cards_g1_compressed);
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

export function decodePokerWire(encoded) {
  if (encoded.nop) {
    return new PokerActionEnvelopeWire({
      table_id: encoded.table_id,
      hand_id: encoded.hand_id,
      from: encoded.from,
      sequence: encoded.sequence,
      sequence_number: encoded.sequence_number ?? null,
      expected_state: encoded.expected_state,
      nop: encoded.nop,
      log_lines: encoded.log_lines ?? [],
    });
  }

  const action = encoded.action
    ? { ...encoded.action }
    : (encoded.submit ? poker_submit_to_action_wire(encoded.submit) : null);

  if (action) {
    switch (action.type) {
      case 'SubmitShuffledDeck':
        action.deck_g1_compressed = decodeCardSetWire(action.deck_g1_compressed);
        break;
      case 'SubmitPlayerCards':
      case 'SubmitShowdownCards':
        action.player_cards_g1_compressed = action.player_cards_g1_compressed.map(decodeCardSetWire);
        break;
      case 'SubmitCommunityCards':
        action.cards_g1_compressed = decodeCardSetWire(action.cards_g1_compressed);
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
    submit: encoded.submit,
    log_lines: encoded.log_lines ?? [],
  });
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

export function historyEntryPayload(wire) {
  return textEncoder.encode(canonicalJson({
    type: 'PokerHandAction',
    wire,
  }));
}

export function wireHistoryKey(wire) {
  if (!wire) return '';
  return [
    wire.hand_id,
    wire.sequence_number ?? '',
    wire.from ?? '',
    wire.sequence ?? '',
    wire.nop ? 'nop' : wire.submit?.method ?? wire.action?.type ?? 'action',
  ].join(':');
}

export function handHistorySequenceNumber(historyEntries = []) {
  return Math.max(
    0,
    ...historyEntries.map((entry) => Number(entry?.sequence_number ?? entry?.wire?.sequence_number ?? 0)),
  );
}

export function handHistoryTipKey({ tableId, handId, historyEntries = [] } = {}) {
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
