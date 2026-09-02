import { toChipUnits } from 'privatepoker-hooks/config/constants/index.js';
import { holdemShowdown } from 'privatepoker-hooks/poker/core/crum_pkr/hand_evaluator.js';
import { POKER_HOLDEM_ROUNDS } from 'privatepoker-hooks/poker/core/crum_pkr/index.js';

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
