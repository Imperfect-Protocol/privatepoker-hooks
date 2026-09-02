import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildFinalHandSettlement,
  buildNextFinalVerification,
  buildNextTableAggregatePublicKeyVerification,
  settlementArgsDigest,
  settlementContractArgs,
  tableAggregatePublicKey,
  tableAggregatePublicKeyContractArgs,
  tableAggregatePublicKeyDigest,
} from 'privatepoker-hooks/react/hooks/useFinalVerification.js';
import { toChipUnits } from 'privatepoker-hooks/config/constants/index.js';
import {
  POKER_HAND_STATE_FINISHED,
  POKER_HAND_STATE_SHUFFLE,
} from 'privatepoker-hooks/poker/core/crum_pkr/index.js';
import {
  HAND_ID,
  playFinishedP2pHand,
  publicKeyHex,
} from './final-settlement-helpers.js';

test('final settlement round follows P2P gameplay and Lagrange-aggregates table-key signatures', () => {
  const numPlayers = 3;
  const {
    hand,
    tableSigningKeys,
    tablePublicKeys,
    tableSignaturePublicKeys,
    handHistoryEntries,
    handSetup,
  } = playFinishedP2pHand(numPlayers);
  const tableSeats = Array.from({ length: numPlayers }, (_, seat) => ({
    playerAddress: `0x${String(seat + 1).padStart(40, '0')}`,
    announcePublicKey: publicKeyHex(tablePublicKeys[seat]),
  }));
  const tableSignatureSeats = tableSeats.map((seat, index) => ({
    ...seat,
    signaturePublicKey: publicKeyHex(tableSignaturePublicKeys[index]),
  }));

  let signatureShares = [];
  let previousSettlementDigest = null;
  let finalVerification = null;
  const aggregateTablePublicKey = tableAggregatePublicKey(tableSignatureSeats);
  let tableAggregatePublicKeyShares = [];
  let tableAggregateSignatureShares = [];
  let tableAggregateVerification = null;

  assert.equal(POKER_HAND_STATE_SHUFFLE, 0);

  for (let player = 0; player < numPlayers; player += 1) {
    tableAggregateVerification = buildNextTableAggregatePublicKeyVerification({
      lobbyId: 1n,
      tableId: 777n,
      tableSeats,
      publicKeyShares: tableAggregatePublicKeyShares,
      signatureShares: [],
      currentSeatNo: player,
      signingKey: tableSigningKeys[player],
      publicKey: tableSignaturePublicKeys[player],
    });

    assert.equal(tableAggregateVerification.signed, false);
    assert.equal(tableAggregateVerification.publicKeyAdded, true);
    assert.equal(tableAggregateVerification.publicKeyShares.length, player + 1);
    tableAggregatePublicKeyShares = tableAggregateVerification.publicKeyShares;
  }

  for (let player = 0; player < numPlayers; player += 1) {
    tableAggregateVerification = buildNextTableAggregatePublicKeyVerification({
      lobbyId: 1n,
      tableId: 777n,
      tableSeats,
      publicKeyShares: tableAggregatePublicKeyShares,
      signatureShares: tableAggregateSignatureShares,
      currentSeatNo: player,
      signingKey: tableSigningKeys[player],
      publicKey: tableSignaturePublicKeys[player],
    });

    assert.equal(tableAggregateVerification.signed, true);
    assert.equal(tableAggregateVerification.signerSeats.at(-1), player);
    assert.equal(tableAggregateVerification.signatureShares.length, player + 1);
    assert.equal(tableAggregateVerification.aggregatePublicKey, aggregateTablePublicKey);
    assert.equal(
      tableAggregateVerification.tableAggregatePublicKeyDigest,
      tableAggregatePublicKeyDigest({
        lobbyId: 1n,
        tableId: 777n,
        aggregatePublicKey: aggregateTablePublicKey,
      }),
    );
    tableAggregateSignatureShares = tableAggregateVerification.signatureShares;
  }

  assert.equal(tableAggregateVerification.complete, true);
  assert.equal(tableAggregateVerification.aggregatePublicKey, aggregateTablePublicKey);
  const tableAggregateArgs = tableAggregatePublicKeyContractArgs({
    lobbyId: 1n,
    tableId: 777n,
    tableAggregateVerification,
  });
  assert.deepEqual(tableAggregateArgs, [
    1n,
    777n,
    aggregateTablePublicKey,
  ]);

  for (let player = 0; player < numPlayers; player += 1) {
    const settlement = buildFinalHandSettlement(hand, tableSeats);
    finalVerification = buildNextFinalVerification({
      lobbyId: 1n,
      tableId: 777n,
      handId: BigInt(HAND_ID),
      hand,
      handSetup,
      handHistoryEntries,
      tableSeats,
      publicKeyShares: tableAggregateVerification.publicKeyShares,
      settlement,
      signatureShares,
      currentSeatNo: player,
      signingKey: tableSigningKeys[player],
      publicKey: tableSignaturePublicKeys[player],
    });

    assert.equal(finalVerification.signed, true);
    assert.equal(finalVerification.signerSeats.at(-1), player);
    assert.equal(finalVerification.signatureShares.length, player + 1);
    assert.ok(finalVerification.finalHandDigest.startsWith('0x'));
    assert.ok(finalVerification.settlementDigest.startsWith('0x'));
    assert.ok(finalVerification.settlementSignatureDigest.startsWith('0x'));
    assert.ok(finalVerification.aggregateSignature?.startsWith('0x'));
    assert.ok(finalVerification.aggregatePublicKey?.startsWith('0x'));
    assert.deepEqual(
      finalVerification.settlementMessage.pot_size_per_player,
      settlement.pot_size_per_player,
    );
    assert.deepEqual(
      finalVerification.settlementMessage.chips_balances,
      settlement.chips_balances,
    );

    previousSettlementDigest ??= finalVerification.settlementDigest;
    assert.equal(finalVerification.settlementDigest, previousSettlementDigest);
    signatureShares = finalVerification.signatureShares;
  }

  assert.equal(finalVerification.complete, true);
  assert.equal(finalVerification.aggregatePublicKey, aggregateTablePublicKey);
  assert.equal(POKER_HAND_STATE_FINISHED, 8);
  assert.equal(finalVerification.signatureShares.length, numPlayers);
  assert.equal(finalVerification.signerSeats.join(','), '0,1,2');
  assert.ok(tableSeats.some((seat) => (
    seat.playerAddress.toLowerCase()
      === finalVerification.settlementMessage.winner_player_address?.toLowerCase()
  )));
  assert.equal(
    finalVerification.settlementMessage.pot_size_per_player.reduce((sum, amount) => sum + amount, 0),
    Number(toChipUnits(hand.betting_state.pot.toString())),
  );
  assert.equal(
    finalVerification.settlementSignatureDigest,
    settlementArgsDigest({
      lobbyId: 1n,
      tableId: 777n,
      handId: BigInt(HAND_ID),
      potSplit: finalVerification.settlementMessage.pot_size_per_player,
      chipsBalances: finalVerification.settlementMessage.chips_balances,
      digest: finalVerification.settlementDigest,
    }),
  );
  const tamperedPotSplit = [...finalVerification.settlementMessage.pot_size_per_player];
  tamperedPotSplit[0] += 1;
  assert.notEqual(
    finalVerification.settlementSignatureDigest,
    settlementArgsDigest({
      lobbyId: 1n,
      tableId: 777n,
      handId: BigInt(HAND_ID),
      potSplit: tamperedPotSplit,
      chipsBalances: finalVerification.settlementMessage.chips_balances,
      digest: finalVerification.settlementDigest,
    }),
  );

  const contractArgs = settlementContractArgs({
    lobbyId: 1n,
    tableId: 777n,
    handId: BigInt(HAND_ID),
    finalVerification,
  });
  assert.equal(contractArgs[0], 1n);
  assert.equal(contractArgs[1], 777n);
  assert.equal(contractArgs[2], BigInt(HAND_ID));
  assert.equal(
    contractArgs[3],
    BigInt(finalVerification.settlementMessage.pot_size_per_player
      .reduce((sum, amount) => sum + amount, 0)),
  );
  assert.deepEqual(
    contractArgs[4],
    finalVerification.settlementMessage.pot_size_per_player.map(BigInt),
  );
  assert.deepEqual(
    contractArgs[5],
    finalVerification.settlementMessage.chips_balances.map(BigInt),
  );
  assert.equal(contractArgs[6], finalVerification.settlementDigest);
  assert.equal(contractArgs[7], finalVerification.aggregatePublicKey);
});
