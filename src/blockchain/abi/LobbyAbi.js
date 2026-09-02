import { parseAbi } from 'viem';

export const LOBBY_ABI = parseAbi([
  "function getLobbyCount() view returns (uint256)",
  "function getLobbyAt(uint256 index) view returns (bytes)",
  "function getLobbyById(uint256 lobbyId) view returns (bytes)",
  "function getTableCount(uint256 lobbyId) view returns (uint256)",
  "function getTablesRange(uint256 lobbyId, uint256 offset, uint256 count) view returns (bytes[])",
  "function getTableDetail(uint256 lobbyId, uint256 tableId) view returns (bytes)",
  "function getPlayerTables(address player) view returns (uint256[])",
  "function addLobby(uint256 id, uint256 gameType, uint256 flags, string name)",
  "function createTable(uint256 lobby_id, uint256 table_id, string calldata name, uint256 buy_in, uint256 num_players, address player_address, bytes calldata annonce_public_key)",
  "function joinTable(uint256 lobby_id, uint256 table_id, address player_address, bytes calldata annonce_public_key)",
  "function removeLobby(uint256 id)",
  "function removeTable(uint256 lobbyId, uint256 tableId)",
  "event LobbyCreated(uint256 id, string name)",
  "event TableCreated(uint256 id, uint256 lobby_id, string name, uint256 buy_in)",
]);
