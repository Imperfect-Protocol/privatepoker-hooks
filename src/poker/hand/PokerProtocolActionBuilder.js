import { PokerAction } from 'privatepoker-hooks/poker/core/crum_net';

export class PokerProtocolActionBuilder {
  constructor({ rng, resolveShuffleTrace } = {}) {
    this.rng = rng;
    this.resolveShuffleTrace = resolveShuffleTrace;
  }

  build(game) {
    const hand = game?.clientState?.current_hand?.();
    const pokerState = hand?.get_current_state?.()?.to_enum?.();
    const playerIndex = game?.clientState?.player_index;

    if (!hand || !pokerState || playerIndex == null) return null;
    if ('player' in pokerState && pokerState.player !== playerIndex) return null;

    switch (pokerState.type) {
      case 'Shuffle':
        return this.buildShuffle(game, hand, pokerState, playerIndex);
      case 'UnmaskHoleCards':
        return this.buildUnmaskHoleCards(game, hand, playerIndex);
      case 'UnmaskCommunityCards':
        return this.buildUnmaskCommunityCards(game, hand, pokerState, playerIndex);
      case 'UnmaskShowdown':
        return this.buildUnmaskShowdown(game, hand, playerIndex);
      case 'SubmitPublicKey':
        return this.buildSubmitPublicKey(game, hand, playerIndex);
      case 'Bet':
      case 'Finished':
        return null;
      default:
        return null;
    }
  }

  buildShuffle(game, hand, pokerState, playerIndex) {
    const cards = pokerState.is_dealer
      ? hand.get_poker_deck().masked_cards()
      : hand.get_shuffled_deck().clone();

    cards.mask(game.signingKey);
    game.shuffleTrace = cards.shuffle_traced(this.rng);

    return {
      action: PokerAction.SubmitShuffledDeck({ player: playerIndex, deck: cards }),
      logLines: [`Shuffle on Player ${playerIndex + 1} (is_dealer=${pokerState.is_dealer})`],
    };
  }

  buildUnmaskHoleCards(game, hand, playerIndex) {
    const cards = hand.get_player_cards().map((cardSet) => cardSet.clone());
    cards.forEach((cardSet, index) => {
      if (index !== playerIndex) cardSet.unmask(game.signingKey);
    });

    return {
      action: PokerAction.SubmitPlayerCards({ player: playerIndex, cards }),
      logLines: [`Unmask Hole Cards on Player ${playerIndex + 1}`],
    };
  }

  buildUnmaskCommunityCards(game, hand, pokerState, playerIndex) {
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

  buildUnmaskShowdown(game, hand, playerIndex) {
    const cards = hand.get_player_cards().map((cardSet) => cardSet.clone());
    cards[playerIndex].unmask(game.signingKey);

    return {
      action: PokerAction.SubmitShowdownCards({ player: playerIndex, cards }),
      logLines: [`Unmask Showdown on Player ${playerIndex + 1}`],
    };
  }

  buildSubmitPublicKey(game, hand, playerIndex) {
    const traces = game.shuffleTrace
      ?? this.resolveShuffleTrace?.({
        game,
        hand,
        playerIndex,
        signingKey: game.signingKey,
      });

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
}

export function buildAutomaticPokerAction(game, options = {}) {
  return new PokerProtocolActionBuilder(options).build(game);
}
