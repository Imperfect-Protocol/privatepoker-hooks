import assert from 'node:assert/strict';

import {
  PokerAction,
  PokerClientState,
} from '../lib/crum_net/index.js';
import {
  POKER_HOLDEM_ROUNDS,
  PokerTable,
} from '../lib/crum_pkr/index.js';
import {
  bytesToHex,
  make_public_key_from_signing_key,
} from '../lib/crum_bls/index.js';

export const TABLE_SIGNING_KEYS = [17n, 19n, 23n, 29n, 31n, 37n];
export const HAND_SIGNING_KEYS = [41n, 43n, 47n, 53n, 59n, 61n];
export const INITIAL_CHIPS = 1000;
export const SMALL_BLIND = 10;
export const HAND_ID = 1;

export function deterministicRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function hexPoint(bytes) {
  return bytesToHex(new Uint8Array(bytes), { prefix: true });
}

export function publicKeyHex(publicKey) {
  return hexPoint(publicKey.toRawBytes(true));
}

export function makePokerTable(numPlayers) {
  const table = PokerTable.new(numPlayers, POKER_HOLDEM_ROUNDS);
  for (let player = 1; player <= numPlayers; player += 1) {
    table.join(player);
  }
  table.start_hand(Array(numPlayers).fill(INITIAL_CHIPS), SMALL_BLIND, 0);
  return table;
}

function buildAction({ hand, pokerState, handSigningKeys, handPublicKeys, tracesByPlayer }) {
  const player = pokerState.player;
  const signingKey = handSigningKeys[player];

  switch (pokerState.type) {
    case 'Shuffle': {
      const cards = pokerState.is_dealer
        ? hand.get_poker_deck().masked_cards()
        : hand.get_shuffled_deck().clone();
      cards.mask(signingKey);
      const traces = cards.shuffle_traced(deterministicRng(0xC0FFEE + player));
      tracesByPlayer.set(player, traces);
      return PokerAction.SubmitShuffledDeck({ player, deck: cards });
    }
    case 'SmallBlind':
      return PokerAction.SubmitSmallBlind({ player });
    case 'BigBlind':
      return PokerAction.SubmitBigBlind({ player });
    case 'UnmaskHoleCards': {
      const cards = hand.get_player_cards().map((cardSet) => cardSet.clone());
      cards.forEach((cardSet, index) => {
        if (index !== player) cardSet.unmask(signingKey);
      });
      return PokerAction.SubmitPlayerCards({ player, cards });
    }
    case 'Bet':
      return PokerAction.SubmitBet({ player, amount: hand.get_call_amount_required(player) });
    case 'UnmaskCommunityCards': {
      const cards = hand.get_community_cards(pokerState.round)?.clone();
      assert.ok(cards, `missing community cards for round ${pokerState.round}`);
      cards.unmask(signingKey);
      return PokerAction.SubmitCommunityCards({ player, round: pokerState.round, cards });
    }
    case 'UnmaskShowdown': {
      const cards = hand.get_player_cards().map((cardSet) => cardSet.clone());
      cards[player].unmask(signingKey);
      return PokerAction.SubmitShowdownCards({ player, cards });
    }
    case 'SubmitPublicKey': {
      const traces = tracesByPlayer.get(player);
      assert.ok(traces, `missing shuffle traces for player ${player}`);
      return PokerAction.SubmitPublicKey({
        player,
        public_key: handPublicKeys[player],
        traces,
      });
    }
    default:
      throw new Error(`unhandled poker state: ${pokerState.type}`);
  }
}

export function playFinishedP2pHand(numPlayers, tableId = 777) {
  const tableSigningKeys = TABLE_SIGNING_KEYS.slice(0, numPlayers);
  const handSigningKeys = HAND_SIGNING_KEYS.slice(0, numPlayers);
  const tablePublicKeys = tableSigningKeys.map(make_public_key_from_signing_key);
  const tableSignaturePublicKeys = tableSigningKeys.map(make_public_key_from_signing_key);
  const handPublicKeys = handSigningKeys.map(make_public_key_from_signing_key);
  const clients = Array.from({ length: numPlayers }, (_, player) => (
    PokerClientState.new(player, tableId, HAND_ID, makePokerTable(numPlayers))
  ));
  const tracesByPlayer = new Map();
  const handHistoryEntries = [];
  let steps = 0;

  while (!clients[0].current_hand().get_current_state().is_finished()) {
    steps += 1;
    assert.ok(steps < 250, 'poker hand did not finish');

    const referenceHand = clients[0].current_hand();
    const pokerState = referenceHand.get_current_state().to_enum();
    const player = pokerState.player;
    const actingClient = clients[player];
    const action = buildAction({
      hand: actingClient.current_hand(),
      pokerState,
      handSigningKeys,
      handPublicKeys,
      tracesByPlayer,
    });
    const envelope = actingClient.submit_local_action(action);
    const wire = envelope.to_wire([`${pokerState.type} by Player ${player + 1}`]);

    clients.forEach((client) => {
      if (client === actingClient) return;
      const applied = client.apply_envelope_result(wire.to_envelope());
      assert.equal(
        applied.applied,
        true,
        applied.mismatch ? JSON.stringify(applied.mismatch) : `peer ${client.player_index} rejected action`,
      );
    });

    handHistoryEntries.push({
      sequence_number: Number(wire.sequence_number ?? steps),
      from: wire.from,
      wire,
      action_signature: {
        scheme: 'test-transcript-already-verified',
      },
    });
  }

  const hand = clients[0].current_hand();
  clients.forEach((client) => {
    assert.equal(client.current_hand().get_current_state().is_finished(), true);
    assert.equal(
      client.current_hand().betting_state.pot.toString(),
      hand.betting_state.pot.toString(),
    );
  });

  return {
    clients,
    hand,
    tableSigningKeys,
    tablePublicKeys,
    tableSignaturePublicKeys,
    handSigningKeys,
    handPublicKeys,
    handHistoryEntries,
    handSetup: {
      hand_id: HAND_ID,
      hand_number: HAND_ID,
      initial_chips: Array(numPlayers).fill(INITIAL_CHIPS),
      small_blind: SMALL_BLIND,
      dealer_button: 0,
    },
  };
}
