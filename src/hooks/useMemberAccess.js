import { useEffect, useMemo, useState } from 'react';
import { useConnection } from 'wagmi';
import { isAddress, parseAbi } from 'viem';
import { useAccountSession } from 'privatepoker-hooks/contexts/AccountSessionContext.jsx';
import { ACCOUNT_CONTRACT_ADDRESS } from 'privatepoker-hooks/lib/chain';
import { useChainPolling } from 'privatepoker-hooks/hooks/useChainPolling';

const ACCOUNT_STATUS = {
  VERIFIED: 2n,
  SUSPENDED: 4n,
  BANNED: 8n,
  DELETED: 16n,
};

const ACCOUNT_ABI = parseAbi([
  "function getAccountStatus(address player_address) view returns (uint256)",
  "function isSubscriptionActive(address player_address) view returns (bool)",
]);

const normalizeAddress = (value) => value?.toLowerCase() ?? '';

export function useMemberAccess() {
  const { address, isConnected } = useConnection();
  const { accountSession, isRestoringSession } = useAccountSession();
  const [isAccessDelaying, setIsAccessDelaying] = useState(true);
  const canCheckAccount = Boolean(isConnected && address && isAddress(ACCOUNT_CONTRACT_ADDRESS));

  const accountStatusRequest = useMemo(() => (
    canCheckAccount
      ? {
        address: ACCOUNT_CONTRACT_ADDRESS,
        abi: ACCOUNT_ABI,
        functionName: 'getAccountStatus',
        args: [address],
      }
      : null
  ), [address, canCheckAccount]);

  const accountStatusPoll = useChainPolling(accountStatusRequest, {
    enabled: canCheckAccount,
    intervalMs: 10000,
  });

  const accountStatus = canCheckAccount ? (accountStatusPoll.data ?? 0n) : 0n;
  const isVerified = accountStatus === ACCOUNT_STATUS.VERIFIED;

  const subscriptionRequest = useMemo(() => (
    canCheckAccount && isVerified
      ? {
        address: ACCOUNT_CONTRACT_ADDRESS,
        abi: ACCOUNT_ABI,
        functionName: 'isSubscriptionActive',
        args: [address],
      }
      : null
  ), [address, canCheckAccount, isVerified]);

  const subscriptionPoll = useChainPolling(subscriptionRequest, {
    enabled: canCheckAccount && isVerified,
    intervalMs: 10000,
  });

  const isSubscriptionActive = canCheckAccount && isVerified
    ? Boolean(subscriptionPoll.data)
    : false;
  const isChecking = Boolean(
    canCheckAccount
    && (accountStatusPoll.isLoading || (isVerified && subscriptionPoll.isLoading))
  );
  const hasCheckedAccount = !canCheckAccount
    || (accountStatusPoll.hasResolved && (!isVerified || subscriptionPoll.hasResolved));

  useEffect(() => {
    const timeout = setTimeout(() => {
      setIsAccessDelaying(false);
    }, 1000);

    return () => clearTimeout(timeout);
  }, []);

  const isWalletConnected = Boolean(isConnected && address);
  const hasCurrentWalletKeypair = Boolean(
    accountSession?.rootSeed
    && accountSession?.blsSeed
    && accountSession?.operatorPrivateKey
    && accountSession?.operatorBlsPrivateKey
    && accountSession?.operatorBlsPublicKey
    && normalizeAddress(accountSession.walletAddress) === normalizeAddress(address),
  );
  const isAccessPending = Boolean(
    isRestoringSession || isAccessDelaying
    || (isWalletConnected && !hasCheckedAccount)
  );

  return {
    accountStatus,
    hasCurrentWalletKeypair,
    isAccountBanned: accountStatus === ACCOUNT_STATUS.BANNED,
    isAccountDeleted: accountStatus === ACCOUNT_STATUS.DELETED,
    isAccountSuspended: accountStatus === ACCOUNT_STATUS.SUSPENDED,
    isAccountVerified: isVerified,
    isAccessPending,
    isChecking,
    isMember: isWalletConnected && hasCurrentWalletKeypair && isVerified && isSubscriptionActive,
    isSubscriptionActive,
    isWalletConnected,
  };
}
