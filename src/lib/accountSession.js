import { keccak256, toBytes, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BLS_TABLE_SESSION_DOMAIN, BLS_TABLE_SESSION_TYPES } from 'privatepoker-hooks/lib/constants';
import { compressed_public_key_hex_from_seed } from 'privatepoker-hooks/lib/crum_bls';

export const ACCOUNT_SESSION_CHANNEL = 'private-poker:account-session';

export const ACCOUNT_SESSION_DOMAIN = {
  name: 'PrivatePoker',
  version: '1',
};

export const ACCOUNT_SESSION_TYPES = {
  PrivatePokerAccountSession: [
    { name: 'app', type: 'string' },
    { name: 'purpose', type: 'string' },
    { name: 'operatorRealm', type: 'string' },
    { name: 'blsRealm', type: 'string' },
    { name: 'network', type: 'string' },
    { name: 'version', type: 'uint256' },
  ],
};

export const ACCOUNT_SESSION_MESSAGE = {
  app: 'PrivatePoker',
  purpose: 'Create deterministic PrivatePoker session keys',
  operatorRealm: 'Lobby and table blockchain operations',
  blsRealm: 'Per-table peer-to-peer poker sessions',
  network: 'Arbitrum Sepolia',
  version: 1n,
};

export function buildAccountSessionTypedData() {
  return {
    domain: ACCOUNT_SESSION_DOMAIN,
    types: ACCOUNT_SESSION_TYPES,
    primaryType: 'PrivatePokerAccountSession',
    message: ACCOUNT_SESSION_MESSAGE,
  };
}

export function deriveAccountSession(signature, walletAddress) {
  const rootSeed = keccak256(signature);
  const blsSeed = keccak256(toBytes(`${rootSeed}:PrivatePoker:BLSRoot`));
  const operatorBlsPrivateKey = keccak256(toBytes(`${rootSeed}:PrivatePoker:OperatorBLSProfile`));
  const operatorBlsPublicKey = compressed_public_key_hex_from_seed(toBytes(operatorBlsPrivateKey), { prefix: true });
  const operatorPrivateKey = keccak256(toBytes(`${rootSeed}:PrivatePoker:Operator`));
  const operatorAccount = privateKeyToAccount(operatorPrivateKey);

  return {
    walletAddress,
    rootSeed,
    blsSeed,
    operatorBlsPrivateKey: operatorBlsPrivateKey.slice(2),
    operatorBlsPublicKey,
    operatorPrivateKey,
    operatorPublicKey: operatorAccount.publicKey,
    operator: operatorAccount.address,
    signedAt: new Date().toISOString(),
  };
}

function isCrumBlsPublicKeyHex(value) {
  try {
    return toBytes(value).length === 96;
  } catch {
    return false;
  }
}

export function parseAccountSession(rawSession) {
  if (!rawSession) return null;
  try {
    const session = typeof rawSession === 'string' ? JSON.parse(rawSession) : rawSession;
    if (!session?.walletAddress || !session?.rootSeed || !session?.operatorPrivateKey || !session?.operator) {
      return null;
    }
    if (!session.blsSeed) {
      session.blsSeed = keccak256(toBytes(`${session.rootSeed}:PrivatePoker:BLSRoot`));
    }
    if (session.operatorBlsPublicKey && !isCrumBlsPublicKeyHex(session.operatorBlsPublicKey)) {
      return null;
    }
    if (!session.operatorBlsPrivateKey || !session.operatorBlsPublicKey) {
      const operatorBlsPrivateKey = keccak256(toBytes(`${session.rootSeed}:PrivatePoker:OperatorBLSProfile`));
      session.operatorBlsPrivateKey = operatorBlsPrivateKey.slice(2);
      session.operatorBlsPublicKey = compressed_public_key_hex_from_seed(toBytes(operatorBlsPrivateKey), { prefix: true });
    }
    return session;
  } catch {
    return null;
  }
}

function buildTableSessionTypedData(tableDetails) {
  return {
    domain: BLS_TABLE_SESSION_DOMAIN,
    types: BLS_TABLE_SESSION_TYPES,
    primaryType: 'PrivatePokerTableSession',
    message: {
      tableId: BigInt(tableDetails.tableId),
      lobbyId: BigInt(tableDetails.lobbyId),
    },
  };
}

export async function deriveTableSessionKeys(accountSession, tableDetails, sessionKey) {
  if (!accountSession?.operatorPrivateKey) {
    throw new Error('PrivatePoker account session is required before deriving table keys.');
  }
  if (!tableDetails?.lobbyId || !tableDetails?.tableId) {
    throw new Error('Table details are required before deriving table keys.');
  }

  const operatorAccount = privateKeyToAccount(accountSession.operatorPrivateKey);
  const tableSignature = await operatorAccount.signTypedData(buildTableSessionTypedData(tableDetails));
  const privateKeySeed = keccak256(toBytes(`${accountSession.blsSeed}:${tableSignature}`));
  const privateKeyBytes = toBytes(privateKeySeed);

  return {
    privateKey: toHex(privateKeyBytes).slice(2),
    publicKey: compressed_public_key_hex_from_seed(privateKeyBytes),
    operatorPrivateKey: accountSession.operatorPrivateKey,
    operatorPublicKey: accountSession.operatorPublicKey,
    operator: accountSession.operator,
    playerAddress: accountSession.walletAddress,
    sessionKey,
  };
}

export function deriveHandSessionKeys(accountSession, tableDetails, handNumber) {
  if (!accountSession?.blsSeed) {
    throw new Error('PrivatePoker account session is required before deriving hand keys.');
  }
  if (!tableDetails?.lobbyId || !tableDetails?.tableId) {
    throw new Error('Table details are required before deriving hand keys.');
  }
  if (handNumber == null) {
    throw new Error('Hand number is required before deriving hand keys.');
  }

  const privateKeySeed = keccak256(toBytes([
    accountSession.blsSeed,
    'PrivatePoker:HandBLS',
    tableDetails.lobbyId,
    tableDetails.tableId,
    handNumber,
  ].join(':')));
  const privateKeyBytes = toBytes(privateKeySeed);

  return {
    privateKey: toHex(privateKeyBytes).slice(2),
    publicKey: compressed_public_key_hex_from_seed(privateKeyBytes),
    operatorPrivateKey: accountSession.operatorPrivateKey,
    operatorPublicKey: accountSession.operatorPublicKey,
    operator: accountSession.operator,
    playerAddress: accountSession.walletAddress,
    handNumber: Number(handNumber),
    sessionKey: [
      accountSession.walletAddress?.toLowerCase?.() ?? '',
      tableDetails.lobbyId,
      tableDetails.tableId,
      handNumber,
    ].join(':'),
  };
}
