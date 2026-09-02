import { useEffect, useRef, useState } from 'react';
import { useAppKitAccount } from '@reown/appkit/react';
import { useConnection } from 'wagmi';
import {
  useListenForNewLobbies,
  useListenForNewTables,
  usePrivatePokerLobby,
} from 'privatepoker-hooks/react/hooks/usePrivatePokerLobby';
import { fromChipUnits, getGameTypeName, getLobbyStatus } from 'privatepoker-hooks/config/constants';
import { subscribeLobbyTablesChanged } from 'privatepoker-hooks/lobby/LobbyEvents';
import { getBlindsForBuyin } from 'privatepoker-hooks/poker/lobby/Stakes';

export function useLobby(lobbyId = undefined) {
  const { address } = useConnection();
  const { isConnected } = useAppKitAccount();
  const wasConnectedRef = useRef(isConnected);
  const [lobbies, setLobbies] = useState([]);
  const [tables, setTables] = useState([]);
  const [lobbyInfo, setLobbyInfo] = useState({ name: 'Loading...', gameType: 1 });
  const [userTables, setUserTables] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const {
    getLobbyCount,
    getLobbyAt,
    getLobbyById,
    getTableCount,
    getTablesRange,
    getPlayerTables,
  } = usePrivatePokerLobby();

  useListenForNewLobbies(() => {
    if (lobbyId === undefined) {
      setRefreshTrigger((current) => current + 1);
    }
  });

  useListenForNewTables((newTableArgs) => {
    if (lobbyId !== undefined && newTableArgs.lobby_id?.toString() === lobbyId.toString()) {
      setRefreshTrigger((current) => current + 1);
    }
  });

  useEffect(() => (
    subscribeLobbyTablesChanged((event) => {
      if (lobbyId === undefined || event.lobbyId === lobbyId.toString()) {
        setRefreshTrigger((current) => current + 1);
      }
    })
  ), [lobbyId]);

  useEffect(() => {
    if (wasConnectedRef.current && !isConnected) {
      setRefreshTrigger((current) => current + 1);
    }

    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  useEffect(() => {
    let cancelled = false;

    const fetchLobbies = async () => {
      try {
        if (refreshTrigger === 0) setIsLoading(true);

        if (lobbyId === undefined) {
          const count = await getLobbyCount();
          const fetchedLobbies = [];

          for (let i = 0; i < count; i += 1) {
            const lobbyData = await getLobbyAt(i);
            fetchedLobbies.push({
              id: lobbyData.id,
              active: getLobbyStatus(lobbyData.flags) === 'active' ? 'true' : 'false',
              name: lobbyData.name,
              table_count: lobbyData.tableCount.toString(),
              total_players: lobbyData.playerCount.toString(),
              total_buyin: `$${fromChipUnits(lobbyData.totalVolume)}`,
            });
          }

          if (!cancelled) {
            fetchedLobbies.sort((a, b) => a.id - b.id);
            setLobbies(fetchedLobbies);
          }
          return;
        }

        const lobbyData = await getLobbyById(lobbyId);
        if (cancelled) return;

        setLobbyInfo({
          name: lobbyData.name,
          gameType: lobbyData.gameType,
        });

        const count = await getTableCount(lobbyId);
        if (cancelled) return;

        if (count > 0) {
          const rawTables = await getTablesRange(lobbyId, 0, count);
          const mappedTables = rawTables.map((tableData) => {
            const blinds = getBlindsForBuyin(tableData.buyIn);
            return {
              id: tableData.id,
              name: tableData.name,
              buyin: tableData.buyIn,
              game: getGameTypeName(lobbyData.gameType),
              blinds: blinds?.label ?? '0/0',
              max_players: tableData.flags,
              current_players: tableData.playerCount,
              state: 'seating',
            };
          });
          setTables(mappedTables);
        } else {
          setTables([]);
        }

        if (address) {
          const myTables = await getPlayerTables(address);
          setUserTables(myTables);
        } else {
          setUserTables([]);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to fetch lobby data:', error);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchLobbies();

    return () => {
      cancelled = true;
    };
  }, [address, lobbyId, refreshTrigger]);

  return {
    lobbies,
    tables,
    lobbyInfo,
    userTables,
    isLoading,
    refresh: () => setRefreshTrigger((current) => current + 1),
  };
}
