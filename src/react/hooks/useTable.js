import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccountSession } from 'privatepoker-hooks/react/contexts/AccountSessionContext.jsx';
import {
  decodePlayerTables,
  decodeTableDetailBlob,
  LOBBY_ABI,
} from 'privatepoker-hooks/react/hooks/usePrivatePokerLobby';
import { useTokenRing } from 'privatepoker-hooks/react/hooks/useTokenRing.js';
import { useChainPolling } from 'privatepoker-hooks/react/hooks/useChainPolling';
import { CHAIN_POLLING_INTERVAL, LOBBY_CONTRACT_ADDRESS } from 'privatepoker-hooks/config/chain';
import { getBlindsForBuyin, getStakesLabel } from 'privatepoker-hooks/poker/lobby/Stakes';

const mapTableDetail = (detail) => ({
  id: detail.info.id,
  name: detail.info.name,
  gameType: detail.info.gameType ?? 1,
  buyin: detail.info.buyIn,
  blinds: getBlindsForBuyin(detail.info.buyIn),
  stakes: getStakesLabel(detail.info.buyIn),
  maxSeats: detail.info.flags,
  currentHand: Number(detail.info.currentHand ?? 0),
  players: detail.players,
  current_hand: {
    min_bet: undefined,
    max_bet: undefined,
    bet_step: undefined,
    community_cards: '',
  },
});

const buildSeats = (tableData) => {
  const seatCount = Number(tableData?.maxSeats || tableData?.max_players || 0);
  return Array.from({ length: seatCount }, (_, index) => {
    const player = tableData?.players?.[index];
    return {
      seatNo: index,
      playerAddress: player?.playerAddress ?? null,
      operator: player?.operator ?? null,
      announcePublicKey: player?.annoncePublicKey ?? null,
      signaturePublicKey: player?.annoncePublicKey ?? null,
    };
  });
};

const normalizeAddress = (value) => value?.toLowerCase() ?? '';

const makeSeatsKey = (seats) => seats
  .map((seat) => [
    seat.seatNo,
    normalizeAddress(seat.playerAddress),
    normalizeAddress(seat.operator),
    seat.announcePublicKey ?? '',
    seat.signaturePublicKey ?? '',
  ].join('/'))
  .join('|');

export function useTable({
  tableId,
  lobbyId,
  initialTableData = null,
  initialIsSeated = null,
  onActivity,
  onSeat: onSeatEvent,
  networkEnabled = false,
  onOperatorTopUp,
  localMediaStream = null,
} = {}) {
  const { accountSession } = useAccountSession();
  const playerAddress = accountSession?.walletAddress;
  const [liveTableData, setLiveTableData] = useState(initialTableData);
  const [isLoading, setIsLoading] = useState(!initialTableData);
  const [isSeated, setIsSeated] = useState(initialIsSeated);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const onSeatEventRef = useRef(onSeatEvent);
  onSeatEventRef.current = onSeatEvent;

  const activeTableId = liveTableData?.id ?? tableId;
  const tableName = liveTableData?.name ?? '';
  const tableCapacity = Number(liveTableData?.maxSeats || liveTableData?.max_players || 0);
  const seatedPlayerCount = liveTableData?.players?.length ?? 0;
  const isTableFull = tableCapacity > 0 && seatedPlayerCount >= tableCapacity;
  const seats = useMemo(() => buildSeats(liveTableData), [liveTableData]);
  const seatsKey = makeSeatsKey(seats);

  const tableSessionDetails = useMemo(() => ({
    lobbyId,
    tableId: activeTableId,
    tableName,
    buyIn: liveTableData?.buyin,
    currentHand: liveTableData?.currentHand,
    blinds: liveTableData?.blinds,
    stakesLabel: liveTableData?.stakes,
  }), [activeTableId, lobbyId, liveTableData?.blinds, liveTableData?.buyin, liveTableData?.currentHand, liveTableData?.stakes, tableName]);
  const subscribedPrecedingPeerKeyRef = useRef(null);
  const mySeatNo = useMemo(() => (
    seats.find((seat) => normalizeAddress(seat.playerAddress) === normalizeAddress(playerAddress))?.seatNo ?? null
  ), [playerAddress, seats]);

  const onSeat = useCallback((seatNo, seatEvent) => {
    onSeatEventRef.current?.(seatNo, seatEvent);
  }, []);

  const tokenRing = useTokenRing({
    currentSeatNo: mySeatNo,
    seatCount: tableCapacity,
    network: {
      tableId: activeTableId,
      lobbyId,
      tableDetails: tableSessionDetails,
      seats,
      onActivity,
      onOperatorTopUp,
      isTableFull,
      tableCapacity,
      localMediaStream,
    },
  });

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
  ] = tokenRing;

  const previousSeat = useMemo(() => {
    if (mySeatNo === null) return null;

    const occupiedSeats = seats.filter((seat) => seat.playerAddress);
    if (occupiedSeats.length < 2) return null;

    const myOccupiedSeatIndex = occupiedSeats.findIndex((seat) => seat.seatNo === mySeatNo);
    if (myOccupiedSeatIndex < 0) return null;

    return occupiedSeats[(myOccupiedSeatIndex - 1 + occupiedSeats.length) % occupiedSeats.length];
  }, [mySeatNo, seats]);

  const previousSeatNo = previousSeat?.seatNo ?? null;
  const subscriptionKey = [
    normalizeAddress(playerAddress),
    lobbyId ?? '',
    activeTableId ?? '',
    previousSeatNo ?? '',
    normalizeAddress(previousSeat?.playerAddress),
    previousSeat?.announcePublicKey ?? '',
  ].join('::');

  const subscribeToPreviousSeat = useCallback(async ({ immediateOffer = false } = {}) => {
    if (!previousSeat?.playerAddress) return;

    const { playerAddress: peerPlayerAddress, announcePublicKey } = previousSeat;
    await subscribeTo(peerPlayerAddress, announcePublicKey, (seatNo, event) => {
      onSeat(seatNo, {
        kind: 'network',
        playerAddress: peerPlayerAddress,
        event,
      });
    }, { immediateOffer });
  }, [onSeat, previousSeat, subscribeTo]);

  const retryInboundConnection = useCallback(async () => {
    if (!previousSeat?.playerAddress) {
      throw new Error('No previous peer seat is available to poke.');
    }

    const { playerAddress: peerPlayerAddress, announcePublicKey } = previousSeat;
    if (!announcePublicKey) {
      throw new Error('Previous peer is missing an announce key.');
    }

    await pokeInboundConnection(peerPlayerAddress, announcePublicKey, (seatNo, event) => {
      onSeat(seatNo, {
        kind: 'network',
        playerAddress: peerPlayerAddress,
        event,
      });
    });
  }, [onSeat, pokeInboundConnection, previousSeat]);

  useEffect(() => {
    if (!networkEnabled) return;
    if (!previousSeat?.playerAddress) return;
    if (subscribedPrecedingPeerKeyRef.current === subscriptionKey) return;

    subscribedPrecedingPeerKeyRef.current = subscriptionKey;
    subscribeToPreviousSeat();
  }, [networkEnabled, previousSeat?.playerAddress, subscribeToPreviousSeat, subscriptionKey]);

  useEffect(() => {
    if (!lobbyId || !tableId) setIsLoading(false);
  }, [lobbyId, tableId]);

  const tableDetailRequest = useMemo(() => (
    lobbyId && tableId
      ? {
        key: `table-detail:${lobbyId}:${tableId}:${refreshTrigger}`,
        address: LOBBY_CONTRACT_ADDRESS,
        abi: LOBBY_ABI,
        functionName: 'getTableDetail',
        args: [BigInt(lobbyId), BigInt(tableId)],
      }
      : null
  ), [lobbyId, refreshTrigger, tableId]);

  const playerTablesRequest = useMemo(() => (
    playerAddress && tableId
      ? {
        key: `player-tables:${normalizeAddress(playerAddress)}:${refreshTrigger}`,
        address: LOBBY_CONTRACT_ADDRESS,
        abi: LOBBY_ABI,
        functionName: 'getPlayerTables',
        args: [playerAddress],
      }
      : null
  ), [playerAddress, refreshTrigger, tableId]);

  const tableDetailPoll = useChainPolling(tableDetailRequest, {
    enabled: Boolean(tableDetailRequest),
    intervalMs: CHAIN_POLLING_INTERVAL,
  });
  const playerTablesPoll = useChainPolling(playerTablesRequest, {
    enabled: Boolean(playerTablesRequest),
    intervalMs: CHAIN_POLLING_INTERVAL,
  });

  useEffect(() => {
    if (tableDetailPoll.error) {
      console.error('Failed to load table:', tableDetailPoll.error);
      setIsLoading(false);
      return;
    }

    if (!tableDetailPoll.hasResolved) return;

    const detail = decodeTableDetailBlob(tableDetailPoll.data);
    const mappedDetail = mapTableDetail(detail);
    setLiveTableData((current) => ({
      ...mappedDetail,
      current_hand: {
        ...mappedDetail.current_hand,
        ...current?.current_hand,
      },
    }));
    setIsLoading(false);
  }, [tableDetailPoll.data, tableDetailPoll.error, tableDetailPoll.hasResolved]);

  useEffect(() => {
    if (!playerAddress || !tableId) {
      setIsSeated(null);
      return;
    }

    if (playerTablesPoll.error) {
      console.error('Failed to load player tables:', playerTablesPoll.error);
      return;
    }

    if (!playerTablesPoll.hasResolved) return;

    const userTables = decodePlayerTables(playerTablesPoll.data);
    setIsSeated(userTables.includes(tableId.toString()));
  }, [playerAddress, playerTablesPoll.data, playerTablesPoll.error, playerTablesPoll.hasResolved, tableId]);

  useEffect(() => {
    seats.forEach((seat) => {
      if (!seat.playerAddress) return;
      onSeat(seat.seatNo, {
        kind: 'blockchain',
        playerAddress: seat.playerAddress,
        operator: seat.operator,
        announcePublicKey: seat.announcePublicKey,
      });
    });
  }, [seatsKey]);

  const currentSeat = useMemo(() => ({
    playerAddress,
    seatNo: mySeatNo,
    isSeated: isSeated === true,
  }), [playerAddress, isSeated, mySeatNo]);

  return useMemo(() => {
    const result = [activeTableId, tableName, lobbyId, liveTableData?.gameType ?? 1, seats, onSeat];
    return Object.assign(result, {
      onSeat,
      currentSeat,
      tableData: liveTableData,
      setTableData: setLiveTableData,
      isLoading,
      isSeated,
      setIsSeated,
      refresh: () => setRefreshTrigger((current) => current + 1),
      hasJoinedTable: isSeated === true,
      network: tokenRing,
      tokenRing,
      networkSnapshot,
      lobbyId,
      playerNetworkStates: networkSnapshot?.peerStates ?? {},
      prepareNetworkSession,
      prepareHandSession,
      publishMessage,
      armBadSignatureOnce,
      armDropNextMessage,
      armDuplicateNextMessage,
      retryInboundConnection,
      seats,
      subscribeTo,
    });
  }, [
    activeTableId,
    tableName,
    lobbyId,
    liveTableData,
    seats,
    onSeat,
    currentSeat,
    isLoading,
    isSeated,
    tokenRing,
    networkSnapshot,
    prepareNetworkSession,
    prepareHandSession,
    publishMessage,
    armBadSignatureOnce,
    armDropNextMessage,
    armDuplicateNextMessage,
    retryInboundConnection,
    subscribeTo,
  ]);
}
