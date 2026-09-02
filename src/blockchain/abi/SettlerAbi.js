import { parseAbi } from 'viem';

export const SETTLER_ABI = parseAbi([
  'function startHand(uint256 lobby_id, uint256 table_id)',
  'function setTableAggregatePublicKey(uint256 lobby_id, uint256 table_id, bytes aggregate_public_key)',
  'function settleHand(uint256 lobby_id, uint256 table_id, uint256 hand_id, uint256 pot_size, uint256[] pot_split, uint256[] chips_balances, bytes digest, bytes aggregate_public_key) returns (uint256)',
]);
