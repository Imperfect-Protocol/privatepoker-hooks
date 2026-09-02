export const TABLE_PROTOCOL_STATE_TABLE_AGGREGATE_PUBLIC_KEY = 'TableAggregatePublicKey';
export const TABLE_PROTOCOL_STATE_START_HAND = 'StartHand';
export const TABLE_PROTOCOL_STATE_HAND_IN_PROGRESS = 'HandInProgress';
export const TABLE_PROTOCOL_STATE_SETTLE_HAND = 'SettleHand';
export const TABLE_PROTOCOL_STATE_TABLE_COMPLETE = 'TableComplete';
export const TABLE_PROTOCOL_STATE_HAND_DISPUTED = 'HandDisputed';

function numericOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export const TableProtocolState = Object.freeze({
  tableAggregatePublicKey({
    publicKeyShares = [],
    signatureShares = [],
    aggregatePublicKey = null,
    digest = null,
  } = {}) {
    return {
      type: TABLE_PROTOCOL_STATE_TABLE_AGGREGATE_PUBLIC_KEY,
      publicKeyShares,
      signatureShares,
      aggregatePublicKey,
      digest,
    };
  },

  startHand({
    handId = null,
    confirmations = [],
  } = {}) {
    return {
      type: TABLE_PROTOCOL_STATE_START_HAND,
      handId: numericOrNull(handId),
      confirmations,
    };
  },

  handInProgress({
    handId = null,
    handSetup = null,
  } = {}) {
    return {
      type: TABLE_PROTOCOL_STATE_HAND_IN_PROGRESS,
      handId: numericOrNull(handId),
      handSetup,
    };
  },

  settleHand({
    handId = null,
    publicKeyShares = [],
    signatureShares = [],
    digest = null,
    settlement = null,
    tx = null,
    submittedBySeat = null,
  } = {}) {
    return {
      type: TABLE_PROTOCOL_STATE_SETTLE_HAND,
      handId: numericOrNull(handId),
      publicKeyShares,
      signatureShares,
      digest,
      settlement,
      tx,
      submittedBySeat: numericOrNull(submittedBySeat),
    };
  },

  tableComplete({
    handId = null,
    settlement = null,
    tx = null,
  } = {}) {
    return {
      type: TABLE_PROTOCOL_STATE_TABLE_COMPLETE,
      handId: numericOrNull(handId),
      settlement,
      tx,
    };
  },

  handDisputed({
    handId = null,
    reason = null,
  } = {}) {
    return {
      type: TABLE_PROTOCOL_STATE_HAND_DISPUTED,
      handId: numericOrNull(handId),
      reason,
    };
  },
});

export function tableProtocolStateType(state) {
  return typeof state === 'string' ? state : state?.type;
}

export function isTableProtocolState(state, type) {
  return tableProtocolStateType(state) === type;
}
