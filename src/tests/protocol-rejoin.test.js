import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PokerAction,
  PokerClientState,
} from 'privatepoker-hooks/poker/core/crum_net/index.js';
import { PokerProtocolActionBuilder } from 'privatepoker-hooks/poker/hand/PokerProtocolActionBuilder.js';
import {
  decodePokerWire,
  encodePokerWire,
} from 'privatepoker-hooks/poker/hand/PokerHandHistoryCodec.js';
import {
  make_public_key_from_signing_key,
} from 'privatepoker-hooks/crypto/bls/index.js';
import {
  HAND_ID,
  HAND_SIGNING_KEYS,
  deterministicRng,
  makePokerTable,
} from './final-settlement-helpers.js';

const TABLE_ID = 9901;

function makeClient(player, numPlayers) {
  return PokerClientState.new(player, TABLE_ID, HAND_ID, makePokerTable(numPlayers));
}

function makeGame(player, numPlayers, signingKey) {
  return {
    clientState: makeClient(player, numPlayers),
    signingKey,
    publicKey: make_public_key_from_signing_key(signingKey),
    shuffleTrace: null,
  };
}

function buildNextAction(game, builder) {
  const hand = game.clientState.current_hand();
  const pokerState = hand.get_current_state().to_enum();
  const player = pokerState.player;

  switch (pokerState.type) {
    case 'SmallBlind':
      return {
        action: PokerAction.SubmitSmallBlind({ player }),
        logLines: [`Small Blind on Player ${player + 1}`],
      };
    case 'BigBlind':
      return {
        action: PokerAction.SubmitBigBlind({ player }),
        logLines: [`Big Blind on Player ${player + 1}`],
      };
    case 'Bet':
      return {
        action: PokerAction.SubmitBet({
          player,
          amount: hand.get_call_amount_required(player),
        }),
        logLines: [`Player ${player + 1} Bet`],
      };
    default:
      return builder.build(game);
  }
}

function replayHistory(clientState, history) {
  for (const entry of history) {
    const wire = decodePokerWire(entry.wire);
    const result = clientState.apply_envelope_result(wire.to_envelope());
    assert.equal(
      result.applied,
      true,
      result.mismatch ? JSON.stringify(result.mismatch) : `failed to replay ${entry.sequence_number}`,
    );
  }
}

test('encoded poker hand transcript replays into a fresh rejoined client', () => {
  const numPlayers = 3;
  const signingKeys = HAND_SIGNING_KEYS.slice(0, numPlayers);
  const games = signingKeys.map((signingKey, player) => makeGame(player, numPlayers, signingKey));
  const builders = signingKeys.map((_, player) => new PokerProtocolActionBuilder({
    rng: deterministicRng(0xC0FFEE + player),
  }));
  const history = [];
  let sawUnmaskAction = false;

  while (!games[0].clientState.current_hand().get_current_state().is_finished()) {
    assert.ok(history.length < 250, 'poker hand did not finish');

    const referenceState = games[0].clientState.current_hand().get_current_state().to_enum();
    const player = referenceState.player;
    const built = buildNextAction(games[player], builders[player]);

    assert.ok(built?.action, `missing action for ${referenceState.type}`);
    if (referenceState.type.startsWith('Unmask')) sawUnmaskAction = true;

    const envelope = games[player].clientState.submit_local_action(built.action);
    const encodedWire = encodePokerWire(envelope.to_wire(built.logLines));
    history.push({
      sequence_number: Number(encodedWire.sequence_number),
      wire: encodedWire,
    });

    games.forEach((game, index) => {
      if (index === player) return;
      replayHistory(game.clientState, [history.at(-1)]);
    });
  }

  assert.equal(sawUnmaskAction, true);

  const rejoinedClient = makeClient(1, numPlayers);
  replayHistory(rejoinedClient, history);

  assert.equal(rejoinedClient.current_hand().get_current_state().is_finished(), true);
  assert.equal(
    rejoinedClient.table.sequence_number,
    games[0].clientState.table.sequence_number,
  );
});
