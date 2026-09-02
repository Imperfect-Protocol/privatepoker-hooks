import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccountSession } from 'privatepoker-hooks/react/contexts/AccountSessionContext.jsx';
import { useActionQueue } from 'privatepoker-hooks/react/hooks/useActionQueue';
import { usePrivatePokerSignal } from 'privatepoker-hooks/react/hooks/usePrivatePokerSignal';
import { useRequireBLS } from 'privatepoker-hooks/react/hooks/useRequireBLS';
import { useRtcSessionPool } from 'privatepoker-hooks/react/hooks/useRtcSessionPool';
import { PokerRtcSession } from 'privatepoker-hooks/networking/session/PokerRtcSession';

const normalizeAddress = (value) => value?.toLowerCase() ?? '';

function makePlayersKey(players = []) {
  return players
    .map((player) => [
      normalizeAddress(player?.playerAddress),
      normalizeAddress(player?.operator),
      player?.annoncePublicKey ?? '',
    ].join('/'))
    .join('|');
}

function makeSessionConfigKey({
  playerAddress,
  operator,
  tableId,
  lobbyId,
  publicKey,
  privateKey,
  playersKey,
  isTableFull,
  tableCapacity,
}) {
  return [
    normalizeAddress(playerAddress),
    normalizeAddress(operator),
    tableId ?? '',
    lobbyId ?? '',
    publicKey ?? '',
    privateKey ? 'private-key-ready' : '',
    isTableFull ? 'full' : 'waiting',
    tableCapacity ?? 0,
    playersKey,
  ].join('::');
}

const makeBlsActionKey = ({ playerAddress, lobbyId, tableId }) => [
  'bls-key-generation',
  normalizeAddress(playerAddress),
  lobbyId ?? '',
  tableId ?? '',
].join(':');

export function useNetwork({
  tableId,
  lobbyId,
  tableDetails,
  seats = [],
  onActivity,
  isTableFull = false,
  tableCapacity = 0,
  localMediaStream = null,
} = {}) {
  const { accountSession } = useAccountSession();
  const playerAddress = accountSession?.walletAddress;
  const { sendSignal } = usePrivatePokerSignal({ playerAddress });
  const rtcSessionPool = useRtcSessionPool();
  const controlActions = useActionQueue('network-control');
  const { blsKeys, generateKeys, generateHandKeys } = useRequireBLS(tableDetails);
  const blsKeysRef = useRef(null);
  const publicKey = blsKeys?.publicKey;
  const privateKey = blsKeys?.privateKey;
  const operatorPrivateKey = blsKeys?.operatorPrivateKey;
  const operator = blsKeys?.operator;
  const loggedUpdateKeysRef = useRef(new Set());
  const blsActionKey = useMemo(() => makeBlsActionKey({
    playerAddress,
    lobbyId,
    tableId,
  }), [lobbyId, playerAddress, tableId]);

  const players = useMemo(
    () => seats
      .filter((seat) => seat?.playerAddress)
      .map((seat) => ({
        seatNo: seat.seatNo,
        playerAddress: seat.playerAddress,
        operator: seat.operator,
        annoncePublicKey: seat.announcePublicKey,
      })),
    [seats],
  );
  const playersKey = makePlayersKey(players);
  const mySeatAnnouncePublicKey = players.find(
    (player) => normalizeAddress(player.playerAddress) === normalizeAddress(playerAddress),
  )?.annoncePublicKey;

  useEffect(() => {
    if (blsKeys) {
      blsKeysRef.current = blsKeys;
    }
  }, [blsKeys]);

  const [session] = useState(
    () => new PokerRtcSession({
      sendSignal: () => {},
      onActivity: () => {},
      onStateChange: () => {},
      sessionPool: rtcSessionPool,
    }),
  );
  const [networkSnapshot, setNetworkSnapshot] = useState(() => session.getSnapshot());

  const sendPooledSignal = useCallback(async (payload) => {
    const route = await rtcSessionPool.requestLobbyRoute(payload);
    return route;
  }, [rtcSessionPool]);

  const prepareNetworkSessionNow = useCallback(async () => {
    const keys = blsKeysRef.current ?? blsKeys ?? await generateKeys(tableDetails);
    blsKeysRef.current = keys;
    const generatedPublicKey = `0x${keys.publicKey}`;
    if (
      mySeatAnnouncePublicKey
      && normalizeAddress(generatedPublicKey) !== normalizeAddress(mySeatAnnouncePublicKey)
    ) {
      throw new Error(
        'Generated BLS key does not match the announce public key stored on-chain for this table. Rejoin this table so the table stores the current deterministic announce key.',
      );
    }
    session.update({
      playerAddress,
      operator: keys.operator,
      tableId,
      lobbyId,
      currentHand: tableDetails?.currentHand,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      operatorPrivateKey: keys.operatorPrivateKey,
      players,
      isTableFull,
      tableCapacity,
    });
    session.setLocalMediaStream(localMediaStream);
    return keys;
  }, [
    blsKeys,
    generateKeys,
    isTableFull,
    localMediaStream,
    lobbyId,
    mySeatAnnouncePublicKey,
    playerAddress,
    players,
    session,
    tableCapacity,
    tableDetails,
    tableId,
  ]);

  useEffect(() => {
    controlActions.registerAction(blsActionKey, prepareNetworkSessionNow);
  }, [blsActionKey, controlActions, prepareNetworkSessionNow]);

  useEffect(() => {
    const sessionConfigKey = makeSessionConfigKey({
      playerAddress,
      operator,
      tableId,
      lobbyId,
      publicKey,
      privateKey,
      playersKey,
      isTableFull,
      tableCapacity,
    });

    if (!loggedUpdateKeysRef.current.has(sessionConfigKey)) {
      loggedUpdateKeysRef.current.add(sessionConfigKey);
    }

    session.setCallbacks({
      sendSignal,
      sendPooledSignal,
      enqueueControlAction: controlActions.enqueueAction,
      blsActionKey,
      onActivity,
      onStateChange: setNetworkSnapshot,
    });
    session.update({
      playerAddress,
      operator,
      tableId,
      lobbyId,
      currentHand: tableDetails?.currentHand,
      publicKey,
      privateKey,
      operatorPrivateKey,
      players,
      isTableFull,
      tableCapacity,
    });
    session.setLocalMediaStream(localMediaStream);
  }, [
    isTableFull,
    localMediaStream,
    lobbyId,
    onActivity,
    playerAddress,
    players,
    playersKey,
    privateKey,
    publicKey,
    operatorPrivateKey,
    operator,
    blsActionKey,
    controlActions,
    sendPooledSignal,
    sendSignal,
    session,
    tableCapacity,
    tableDetails?.currentHand,
    tableId,
  ]);

  useEffect(() => () => {
    session.destroy();
  }, [session]);

  const publishMessage = useCallback((message) => {
    session.publishMessage(message);
  }, [session]);

  const armBadSignatureOnce = useCallback(() => {
    session.armBadSignatureOnce();
  }, [session]);

  const armDropNextMessage = useCallback(() => {
    session.armDropNextMessage();
  }, [session]);

  const armDuplicateNextMessage = useCallback(() => {
    session.armDuplicateNextMessage();
  }, [session]);

  const subscribeTo = useCallback(async (peerPlayerAddress, peerAnnouncePubKey, callback, options = {}) => {
    await controlActions.enqueueAction('RTC offer', async () => {
      await session.subscribeTo(peerPlayerAddress, peerAnnouncePubKey, callback, options);
    }, { dependsOn: [blsActionKey] });
  }, [blsActionKey, controlActions, session]);

  const pokeInboundConnection = useCallback(async (peerPlayerAddress, peerAnnouncePubKey, callback) => {
    await session.pokeInboundConnection(peerPlayerAddress, peerAnnouncePubKey, callback);
  }, [session]);

  const prepareNetworkSession = useCallback(async () => {
    return controlActions.enqueueAction(
      'BLS key generation',
      prepareNetworkSessionNow,
      { key: blsActionKey, cacheable: true },
    );
  }, [blsActionKey, controlActions, prepareNetworkSessionNow]);

  const prepareHandSession = useCallback(async (handNumber) => {
    return generateHandKeys(handNumber, tableDetails);
  }, [generateHandKeys, tableDetails]);

  return [
    publishMessage,
    subscribeTo,
    networkSnapshot,
    prepareNetworkSession,
    armBadSignatureOnce,
    armDropNextMessage,
    armDuplicateNextMessage,
    prepareHandSession,
    pokeInboundConnection,
  ];
}
