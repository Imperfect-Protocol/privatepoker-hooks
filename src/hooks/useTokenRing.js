import { useMemo } from 'react';
import { useNetwork } from 'privatepoker-hooks/hooks/useNetwork.js';

function numericOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export class VirtualTokenRing {
  constructor({ currentSeatNo = null, seatCount = 0 } = {}) {
    this.currentSeatNo = numericOrNull(currentSeatNo);
    this.seatCount = Number(seatCount || 0);
  }

  currentPlayerFromGame(game) {
    const hand = game?.clientState?.current_hand?.();
    const handState = hand?.get_current_state?.();
    const currentPlayer = handState?.is_finished?.()
      ? null
      : handState?.get_current_player?.();
    return numericOrNull(currentPlayer);
  }

  sequenceNumberFromGame(game) {
    return Number(game?.clientState?.table?.sequence_number ?? 0);
  }

  cursorFromGame(game) {
    if (!game?.clientState) {
      return {
        current_hand: null,
        current_player: null,
        sequence_number: null,
      };
    }

    return {
      current_hand: Number(game.clientState.hand_id ?? 0),
      current_player: this.currentPlayerFromGame(game),
      sequence_number: this.sequenceNumberFromGame(game),
    };
  }

  messageFields(game, overrides = {}) {
    const cursor = this.cursorFromGame(game);
    return {
      current_hand: overrides.currentHand ?? cursor.current_hand,
      current_player: overrides.currentPlayer ?? cursor.current_player,
    };
  }

  applyCursor(game, message) {
    if (!game?.clientState || !message) return null;

    const cursor = {
      currentHand: numericOrNull(message.current_hand ?? message.recovery?.current_hand),
      currentPlayer: numericOrNull(message.current_player ?? message.recovery?.current_player),
    };
    game.recoveryCursor = cursor;

    if (
      cursor.currentHand != null
      && cursor.currentHand > Number(game.clientState.hand_id ?? 0)
    ) {
      game.clientState.hand_id = cursor.currentHand;
      game.clientState.table.hand_number = cursor.currentHand;
      game.currentHandSetup ??= {};
      game.currentHandSetup.hand_id = cursor.currentHand;
      game.currentHandSetup.hand_number = cursor.currentHand;
      game.handKeyHandId = null;
    }

    return cursor;
  }

  targetsCurrentSeat(message) {
    if (message?.current_player == null || this.currentSeatNo == null) return true;
    return Number(message.current_player) === Number(this.currentSeatNo);
  }

  nextSeatAfter(seatNo, seatCount = this.seatCount) {
    const seat = numericOrNull(seatNo);
    const seats = Number(seatCount || 0);
    if (seat == null || !Number.isFinite(seats) || seats <= 0) return null;
    return (seat + 1) % seats;
  }
}

export function useTokenRing({
  currentSeatNo = null,
  seatCount = 0,
  network: networkConfig = {},
} = {}) {
  const network = useNetwork(networkConfig);
  const [
    publishMessage,
    subscribeTo,
    networkSnapshot,
    prepareNetworkSession,
    armBadSignatureOnce,
    armDropNextMessage,
    armDuplicateNextMessage,
    prepareHandSession,
    pokeInboundConnection,
  ] = network;
  const ring = useMemo(() => new VirtualTokenRing({ currentSeatNo, seatCount }), [
    currentSeatNo,
    seatCount,
  ]);

  return useMemo(() => Object.assign(network, {
    ring,
    publishMessage,
    subscribeTo,
    networkSnapshot,
    prepareNetworkSession,
    armBadSignatureOnce,
    armDropNextMessage,
    armDuplicateNextMessage,
    prepareHandSession,
    pokeInboundConnection,
  }), [
    armBadSignatureOnce,
    armDropNextMessage,
    armDuplicateNextMessage,
    network,
    networkSnapshot,
    pokeInboundConnection,
    prepareHandSession,
    prepareNetworkSession,
    publishMessage,
    ring,
    subscribeTo,
  ]);
}
