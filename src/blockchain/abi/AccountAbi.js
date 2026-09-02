import { parseAbi } from 'viem';

export const ACCOUNT_ABI = parseAbi([
  "function createAccount(address player_address, string display_name, bytes encrypted_profile)",
  "function subscribe(address player_address, address operator, string display_name, bytes annonce_public_key, bytes encrypted_profile, uint8 subscription_tier)",
  "function updateAccount(address player_address, string display_name, bytes annonce_public_key, bytes encrypted_profile)",
  "function getAccountStatus(address player_address) view returns (uint256)",
  "function accountStatusChangedAt(address player_address) view returns (uint256)",
  "function isSubscriptionActive(address player_address) view returns (bool)",
  "function getAccount(address player_address) view returns (bytes)",
]);
