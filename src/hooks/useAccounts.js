import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useConnection, useWriteContract } from 'wagmi';
import { decodeAbiParameters, isAddress, parseAbi } from 'viem';
import { useAccountSession } from 'privatepoker-hooks/contexts/AccountSessionContext.jsx';
import {
  ACCOUNT_PROFILE_VERSION,
  EMPTY_ACCOUNT_PROFILE,
  buildAccountProfileBlob,
  profileHasRequiredFields,
  profileNeedsEdit,
  readAccountProfilePublicBlob,
  readAccountProfileBlob,
} from 'privatepoker-hooks/lib/accountProfile';
import { buildAccountSessionTypedData } from 'privatepoker-hooks/lib/accountSession';
import { PRIVATE_POKER_CONTRACT_ADDRESS, PPDC_CONTRACT_ADDRESS } from 'privatepoker-hooks/lib/chain';
import { formatChainError } from 'privatepoker-hooks/lib/chain/errors';
import { SUBSCRIPTION_TIERS } from 'privatepoker-hooks/lib/constants';
import { getBufferedGasOverrides } from 'privatepoker-hooks/lib/gas';
import { publicPokerClient } from 'privatepoker-hooks/lib/publicPokerClient';
import { logWriteTransactionError, waitForLoggedTransactionReceipt } from 'privatepoker-hooks/lib/tx_console';
import { useOperatorAddress } from 'privatepoker-hooks/hooks/useOperatorAddress';

const PPDC_SCALE = 1_000_000n;

const PPDC_ABI = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
]);

const PPDC = 'PPDC';
export const ACCOUNT_STATUS = {
  NONE: 0n,
  UNVERIFIED: 1n,
  VERIFIED: 2n,
  SUSPENDED: 4n,
  BANNED: 8n,
  DELETED: 16n,
};

const ACCOUNT_ABI = parseAbi([
  "function createAccount(address player_address, string display_name, bytes encrypted_profile)",
  "function subscribe(address player_address, address operator, string display_name, bytes annonce_public_key, bytes encrypted_profile, uint8 subscription_tier)",
  "function updateAccount(address player_address, string display_name, bytes annonce_public_key, bytes encrypted_profile)",
  "function getAccountStatus(address player_address) view returns (uint256)",
  "function accountStatusChangedAt(address player_address) view returns (uint256)",
  "function isSubscriptionActive(address player_address) view returns (bool)",
  "function getAccount(address player_address) view returns (bytes)",
]);

const normalizeAddress = (value) => value?.toLowerCase() ?? '';

function profileRecordFromDisplayName(displayName, blobHex = '') {
  const normalized = displayName?.trim?.() ?? '';
  if (!normalized) return null;
  return {
    blobHex,
    version: ACCOUNT_PROFILE_VERSION,
    profile: {
      ...EMPTY_ACCOUNT_PROFILE,
      displayName: normalized,
    },
  };
}

const waitForUiPaint = () => new Promise((resolve) => {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    resolve();
    return;
  }
  window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
});

function tierToContractId(tier) {
  const index = SUBSCRIPTION_TIERS.findIndex((entry) => entry.id === tier.id);
  return index + 1;
}

function tierPpdcAmount(tier) {
  return BigInt(tier.monthlyPpdc) * PPDC_SCALE;
}

function decodeAccountBlob(blob) {
  const [account] = decodeAbiParameters(
    [{
      type: 'tuple',
      components: [
        { name: 'playerAddress', type: 'address' },
        { name: 'operator', type: 'address' },
        { name: 'flags', type: 'uint256' },
        { name: 'statusChangedAt', type: 'uint256' },
        { name: 'displayName', type: 'string' },
        { name: 'annoncePublicKey', type: 'bytes' },
        { name: 'encryptedProfile', type: 'bytes' },
        { name: 'subscriptionTier', type: 'uint8' },
        { name: 'subscriptionPaidAt', type: 'uint256' },
        { name: 'subscriptionExpiresAt', type: 'uint256' },
      ],
    }],
    blob,
  );

  return account;
}

export function accountStatusLabel(flags) {
  const status = BigInt(flags ?? 0n);
  if (status === ACCOUNT_STATUS.VERIFIED) return 'Verified';
  if (status === ACCOUNT_STATUS.SUSPENDED) return 'Suspended';
  if (status === ACCOUNT_STATUS.BANNED) return 'Banned';
  if (status === ACCOUNT_STATUS.DELETED) return 'Deleted';
  if (status === ACCOUNT_STATUS.UNVERIFIED) return 'Unverified';
  return 'Unverified';
}

export function useAccounts({ playerAddresses = [] } = {}) {
  const router = useRouter();
  const { accountSession, isSigningIn, isWalletConnected, signIn } = useAccountSession();
  const { address } = useConnection();
  const { mutateAsync: writeWalletContract } = useWriteContract();
  const { createOperatorAddress } = useOperatorAddress();
  const [step, setStep] = useState('signin');
  const [profileMode, setProfileMode] = useState('edit');
  const [profile, setProfile] = useState(EMPTY_ACCOUNT_PROFILE);
  const [profileBlob, setProfileBlob] = useState('');
  const [hasOnchainAccount, setHasOnchainAccount] = useState(false);
  const [accountStatus, setAccountStatus] = useState(ACCOUNT_STATUS.NONE);
  const [accountStatusChangedAt, setAccountStatusChangedAt] = useState(0n);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isSubscriptionActive, setIsSubscriptionActive] = useState(false);
  const [playerDisplaynames, setPlayerDisplaynames] = useState({});
  const [selectedTier, setSelectedTier] = useState(SUBSCRIPTION_TIERS[1]);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [isCheckingAccount, setIsCheckingAccount] = useState(false);
  const [subscriptionStep, setSubscriptionStep] = useState('');
  const [operationDialog, setOperationDialog] = useState(null);
  const [error, setError] = useState('');

  const signinData = useMemo(() => buildAccountSessionTypedData(), []);
  const signinFields = useMemo(() => (
    Object.entries(signinData.message).map(([field, value]) => ({
      field,
      value: typeof value === 'bigint' ? value.toString() : value,
    }))
  ), [signinData]);

  const playerAddressesKey = useMemo(() => (
    [...new Set(playerAddresses.map(normalizeAddress).filter(Boolean))].sort().join('|')
  ), [playerAddresses]);

  const syncProfileBlobToAccount = useCallback(async (blobHex) => {
    if (!accountSession || !blobHex || !isAddress(PRIVATE_POKER_CONTRACT_ADDRESS)) return;

    const operator = createOperatorAddress(accountSession.operatorPrivateKey);
    const args = [
      accountSession.walletAddress,
      profile.displayName?.trim() ?? '',
      accountSession.operatorBlsPublicKey ?? '0x',
      blobHex,
    ];
    let updateHash;
    try {
      updateHash = await operator.writeContract({
        contract: PRIVATE_POKER_CONTRACT_ADDRESS,
        abi: ACCOUNT_ABI,
        functionName: 'updateAccount',
        args,
      });
      await waitForLoggedTransactionReceipt({
        hash: updateHash,
        functionName: 'updateAccount',
        contract: PRIVATE_POKER_CONTRACT_ADDRESS,
        args,
      });
    } catch (error) {
      if (!updateHash) {
        logWriteTransactionError({
          functionName: 'updateAccount',
          contract: PRIVATE_POKER_CONTRACT_ADDRESS,
          args,
          error,
        });
      }
      throw error;
    }
  }, [accountSession, createOperatorAddress, profile.displayName]);

  const loadAccountFromChain = useCallback(async (walletAddress, session) => {
    if (!isAddress(PRIVATE_POKER_CONTRACT_ADDRESS)) {
      return { exists: false, profileRecord: null, account: null, status: ACCOUNT_STATUS.NONE, statusChangedAt: 0n };
    }

    const status = await publicPokerClient.readContract({
      address: PRIVATE_POKER_CONTRACT_ADDRESS,
      abi: ACCOUNT_ABI,
      functionName: 'getAccountStatus',
      args: [walletAddress],
    });
    const statusChangedAt = status === ACCOUNT_STATUS.NONE
      ? 0n
      : await publicPokerClient.readContract({
        address: PRIVATE_POKER_CONTRACT_ADDRESS,
        abi: ACCOUNT_ABI,
        functionName: 'accountStatusChangedAt',
        args: [walletAddress],
      });
    if (status === ACCOUNT_STATUS.NONE) {
      return { exists: false, profileRecord: null, account: null, status, statusChangedAt };
    }

    const blob = await publicPokerClient.readContract({
      address: PRIVATE_POKER_CONTRACT_ADDRESS,
      abi: ACCOUNT_ABI,
      functionName: 'getAccount',
      args: [walletAddress],
    });
    const account = decodeAccountBlob(blob);
    const profileRecord = account.encryptedProfile && account.encryptedProfile !== '0x'
      ? await readAccountProfileBlob(account.encryptedProfile, session)
      : profileRecordFromDisplayName(account.displayName);
    return { exists: true, profileRecord, account, status, statusChangedAt };
  }, []);

  useEffect(() => {
    if (!accountSession?.walletAddress) return undefined;

    let isMounted = true;
    const loadAccount = async () => {
      setIsCheckingAccount(true);
      if (!isAddress(PRIVATE_POKER_CONTRACT_ADDRESS)) {
        if (isMounted) {
          setHasOnchainAccount(false);
          setAccountStatus(ACCOUNT_STATUS.NONE);
          setAccountStatusChangedAt(0n);
          setProfile(EMPTY_ACCOUNT_PROFILE);
          setProfileBlob('');
          setProfileMode('edit');
          setIsSubscriptionActive(false);
          setStep('profile');
          setIsCheckingAccount(false);
        }
        return;
      }

      try {
        const { exists, profileRecord, status, statusChangedAt } = await loadAccountFromChain(
          accountSession.walletAddress,
          accountSession,
        );
        const isVerified = status === ACCOUNT_STATUS.VERIFIED;
        const isActive = isVerified
          ? await publicPokerClient.readContract({
            address: PRIVATE_POKER_CONTRACT_ADDRESS,
            abi: ACCOUNT_ABI,
            functionName: 'isSubscriptionActive',
            args: [accountSession.walletAddress],
          })
          : false;
        if (!isMounted) return;

        setHasOnchainAccount(exists);
        setAccountStatus(status);
        setAccountStatusChangedAt(statusChangedAt);
        setProfile(profileRecord?.profile ?? EMPTY_ACCOUNT_PROFILE);
        setProfileBlob(profileRecord?.blobHex ?? '');
        setProfileMode(profileNeedsEdit(profileRecord) ? 'edit' : 'view');
        setIsSubscriptionActive(Boolean(isActive));
        setStep(!exists ? 'profile' : isVerified ? 'profile' : 'status');
      } catch (err) {
        console.debug('Account chain load failed:', err);
        if (isMounted) {
          setHasOnchainAccount(false);
          setAccountStatus(ACCOUNT_STATUS.NONE);
          setAccountStatusChangedAt(0n);
          setProfile(EMPTY_ACCOUNT_PROFILE);
          setProfileBlob('');
          setProfileMode('edit');
          setIsSubscriptionActive(false);
          setStep('status');
        }
      } finally {
        if (isMounted) setIsCheckingAccount(false);
      }
    };

    loadAccount();
    return () => {
      isMounted = false;
    };
  }, [accountSession, loadAccountFromChain]);

  useEffect(() => {
    if (!playerAddressesKey) return undefined;

    let isMounted = true;
    const addresses = playerAddressesKey.split('|').filter(Boolean);

    const loadDisplaynames = async () => {
      const entries = await Promise.all(addresses.map(async (playerAddress) => {
        try {
          const blob = await publicPokerClient.readContract({
            address: PRIVATE_POKER_CONTRACT_ADDRESS,
            abi: ACCOUNT_ABI,
            functionName: 'getAccount',
            args: [playerAddress],
          });
          const account = decodeAccountBlob(blob);
          const publicProfile = account.encryptedProfile && account.encryptedProfile !== '0x'
            ? readAccountProfilePublicBlob(account.encryptedProfile)
            : null;
          const displayName = publicProfile?.displayName?.trim() || account.displayName?.trim();
          return displayName ? [playerAddress, displayName] : null;
        } catch (err) {
          console.debug('Player display name lookup failed:', playerAddress, err);
          return null;
        }
      }));

      if (!isMounted) return;
      setPlayerDisplaynames((current) => ({
        ...current,
        ...Object.fromEntries(entries.filter(Boolean)),
      }));
    };

    loadDisplaynames();
    return () => {
      isMounted = false;
    };
  }, [playerAddressesKey]);

  const handleSignin = useCallback(async () => {
    setError('');

    try {
      const session = await signIn();
      if (session) setIsCheckingAccount(true);
    } catch (err) {
      console.error('Account sign-in failed:', err);
      setError('Signature cancelled. Sign in when you are ready.');
    }
  }, [signIn]);

  const handleProfileChange = useCallback((field, value) => {
    if (field === 'email' || field === 'phone' || field === 'legalName') return;
    setProfile((current) => ({
      ...current,
      [field]: value,
    }));
  }, []);

  const updateOperationStep = useCallback((stepId, status) => {
    setOperationDialog((current) => current
      ? {
        ...current,
        steps: current.steps.map((step) => (
          step.id === stepId ? { ...step, status } : step
        )),
      }
      : current);
  }, []);

  const failOperation = useCallback((stepId, err, fallbackMessage) => {
    const message = formatChainError(err, fallbackMessage);
    setOperationDialog((current) => current
      ? {
        ...current,
        error: message,
        steps: current.steps.map((step) => (
          step.id === stepId ? { ...step, status: 'error' } : step
        )),
      }
      : current);
  }, []);

  const handleOperationDialogOk = useCallback(() => {
    const nextAction = operationDialog?.nextAction;
    setOperationDialog(null);
    if (nextAction === 'mainLobby') {
      router.push('/main-lobby');
    }
  }, [operationDialog, router]);

  const continueAfterProfile = useCallback((status = accountStatus, subscriptionActive = isSubscriptionActive) => {
    if (status !== ACCOUNT_STATUS.VERIFIED) {
      setStep('status');
      return;
    }
    if (subscriptionActive) {
      router.push('/main-lobby');
      return;
    }
    setStep('subscription');
  }, [accountStatus, isSubscriptionActive, router]);

  const createPlayerAccount = useCallback(async (session, blobHex = profileBlob) => {
    if (hasOnchainAccount || accountStatus !== ACCOUNT_STATUS.NONE) return false;
    if (!isAddress(PRIVATE_POKER_CONTRACT_ADDRESS)) {
      throw new Error('PrivatePoker contract address is not configured.');
    }
    if (!address || address.toLowerCase() !== session.walletAddress.toLowerCase()) {
      throw new Error('Connected wallet does not match the signed-in account.');
    }

    setOperationDialog({
      title: 'Create Account',
      description: 'Your wallet will create an unverified account. After that, verification has to be completed before subscriptions and lobby access unlock.',
      error: '',
      isComplete: false,
      nextAction: null,
      steps: [
        { id: 'profile', label: 'Prepare profile', status: 'complete' },
        { id: 'account', label: 'Create unverified account', status: 'active' },
      ],
    });
    await waitForUiPaint();

    const args = [
      session.walletAddress,
      profile.displayName?.trim() ?? '',
      blobHex,
    ];
    const overrides = await getBufferedGasOverrides(publicPokerClient, {
      address: PRIVATE_POKER_CONTRACT_ADDRESS,
      abi: ACCOUNT_ABI,
      functionName: 'createAccount',
      args,
      account: session.walletAddress,
    });

    let hash;
    try {
      hash = await writeWalletContract({
        address: PRIVATE_POKER_CONTRACT_ADDRESS,
        abi: ACCOUNT_ABI,
        functionName: 'createAccount',
        args,
        ...overrides,
      });
      await waitForLoggedTransactionReceipt({
        hash,
        functionName: 'createAccount',
        contract: PRIVATE_POKER_CONTRACT_ADDRESS,
        args,
      });
      const statusChangedAt = await publicPokerClient.readContract({
        address: PRIVATE_POKER_CONTRACT_ADDRESS,
        abi: ACCOUNT_ABI,
        functionName: 'accountStatusChangedAt',
        args: [session.walletAddress],
      });
      updateOperationStep('account', 'complete');
      setHasOnchainAccount(true);
      setAccountStatus(ACCOUNT_STATUS.UNVERIFIED);
      setAccountStatusChangedAt(statusChangedAt);
      setStep('status');
      setOperationDialog((current) => current
        ? {
          ...current,
          title: 'Account Created',
          description: 'Your account is unverified. Send an email to imperfect-protocol@protonmail.com to complete verification.',
          isComplete: true,
        }
        : current);
      return true;
    } catch (err) {
      if (!hash) {
        logWriteTransactionError({
          functionName: 'createAccount',
          contract: PRIVATE_POKER_CONTRACT_ADDRESS,
          args,
          error: err,
        });
      }
      failOperation('account', err, 'Account creation failed.');
      throw err;
    }
  }, [
    accountStatus,
    address,
    failOperation,
    hasOnchainAccount,
    profile.displayName,
    profileBlob,
    updateOperationStep,
    writeWalletContract,
  ]);

  const handleProfileEdit = useCallback(() => {
    setProfileMode('edit');
    setError('');
  }, []);

  const handleProfileContinue = useCallback(async () => {
    if (!profileHasRequiredFields(profile)) {
      setProfileMode('edit');
      setError('Complete your profile before continuing.');
      return;
    }
    setError('');
    setIsSavingProfile(true);
    try {
      let blobHex = profileBlob;
      if (!blobHex) {
        blobHex = await buildAccountProfileBlob(profile, accountSession);
        setProfileBlob(blobHex);
      }
      if (accountSession) {
        const created = await createPlayerAccount(accountSession, blobHex);
        if (created) return;
      }
      continueAfterProfile();
    } catch (err) {
      console.error('Account profile sync failed:', err);
      setError(formatChainError(err, 'Profile sync failed.'));
    } finally {
      setIsSavingProfile(false);
    }
  }, [accountSession, continueAfterProfile, createPlayerAccount, profile, profileBlob]);

  const handleProfileSave = useCallback(async () => {
    setError('');
    if (!accountSession) return;
    if (!profileHasRequiredFields(profile)) {
      setError('Display name is required.');
      return;
    }

    setIsSavingProfile(true);
    try {
      const blobHex = await buildAccountProfileBlob(profile, accountSession);
      if (hasOnchainAccount && isSubscriptionActive && isAddress(PRIVATE_POKER_CONTRACT_ADDRESS)) {
        await syncProfileBlobToAccount(blobHex);
      }
      setProfileBlob(blobHex);
      setProfileMode('view');
      const created = await createPlayerAccount(accountSession, blobHex);
      if (created) return;
      continueAfterProfile();
    } catch (err) {
      console.error('Account profile save failed:', err);
      setError(formatChainError(err, 'Profile save failed.'));
    } finally {
      setIsSavingProfile(false);
    }
  }, [
    accountSession,
    continueAfterProfile,
    createPlayerAccount,
    hasOnchainAccount,
    isSubscriptionActive,
    profile,
    syncProfileBlobToAccount,
  ]);

  const getPlayerDisplayname = useCallback((playerAddress) => {
    const normalized = normalizeAddress(playerAddress);
    if (!normalized) return '';
    return playerDisplaynames[normalized] || '';
  }, [playerDisplaynames]);

  const approveOperatorPpdc = useCallback(async (session, amount) => {
    const allowance = await publicPokerClient.readContract({
      address: PPDC_CONTRACT_ADDRESS,
      abi: PPDC_ABI,
      functionName: 'allowance',
      args: [session.walletAddress, session.operator],
    });
    if (allowance >= amount) return;

    const args = [session.operator, amount];
    const overrides = await getBufferedGasOverrides(publicPokerClient, {
      address: PPDC_CONTRACT_ADDRESS,
      abi: PPDC_ABI,
      functionName: 'approve',
      args,
      account: session.walletAddress,
    });
    let hash;
    try {
      hash = await writeWalletContract({
        address: PPDC_CONTRACT_ADDRESS,
        abi: PPDC_ABI,
        functionName: 'approve',
        args,
        ...overrides,
      });
      await waitForLoggedTransactionReceipt({
        hash,
        functionName: 'approve',
        contract: PPDC_CONTRACT_ADDRESS,
        args,
      });
    } catch (error) {
      if (!hash) {
        logWriteTransactionError({
          functionName: 'approve',
          contract: PPDC_CONTRACT_ADDRESS,
          args,
          error,
        });
      }
      throw error;
    }
  }, [writeWalletContract]);

  const handleContinue = useCallback(async () => {
    setError('');
    let currentOperation = 'subscribe';

    try {
      if (!isAddress(PPDC_CONTRACT_ADDRESS)) {
        throw new Error(`${PPDC} contract address is not configured.`);
      }
      if (!isAddress(PRIVATE_POKER_CONTRACT_ADDRESS)) {
        throw new Error('PrivatePoker contract address is not configured.');
      }

      const session = accountSession ?? await signIn();
      if (!session) return;
      if (accountStatus !== ACCOUNT_STATUS.VERIFIED) {
        setStep('status');
        return;
      }
      let currentProfileBlob = profileBlob;
      if (!currentProfileBlob && profileHasRequiredFields(profile)) {
        currentProfileBlob = await buildAccountProfileBlob(profile, session);
        setProfileBlob(currentProfileBlob);
      }
      if (!currentProfileBlob) {
        setStep('profile');
        setError('Complete your profile before subscribing.');
        return;
      }
      if (!address || address.toLowerCase() !== session.walletAddress.toLowerCase()) {
        throw new Error('Connected wallet does not match the signed-in account.');
      }

      setIsSubscribing(true);
      const amount = tierPpdcAmount(selectedTier);
      const operator = createOperatorAddress(session.operatorPrivateKey);

      setOperationDialog({
        title: 'Activate Subscription',
        description: 'Approve the operator, transfer subscription funds, and activate your Private Poker account. Keep this dialog open until every step is complete.',
        error: '',
        isComplete: false,
        nextAction: null,
        steps: [
          { id: 'approve', label: `Approve ${PPDC} for operator`, status: 'active' },
          { id: 'transfer', label: `Transfer ${PPDC} to Private Poker`, status: 'pending' },
          { id: 'subscribe', label: 'Activate subscription', status: 'pending' },
        ],
      });
      await waitForUiPaint();

      currentOperation = 'approve';
      setSubscriptionStep(`Approve ${PPDC} for Operator...`);
      await approveOperatorPpdc(session, amount);
      updateOperationStep('approve', 'complete');

      currentOperation = 'transfer';
      updateOperationStep('transfer', 'active');
      setSubscriptionStep(`Operator transfers ${PPDC} into PrivatePoker...`);
      const transferArgs = [session.walletAddress, PRIVATE_POKER_CONTRACT_ADDRESS, amount];
      let transferHash;
      try {
        transferHash = await operator.writeContract({
          contract: PPDC_CONTRACT_ADDRESS,
          abi: PPDC_ABI,
          functionName: 'transferFrom',
          args: transferArgs,
        });
        await waitForLoggedTransactionReceipt({
          hash: transferHash,
          functionName: 'transferFrom',
          contract: PPDC_CONTRACT_ADDRESS,
          args: transferArgs,
        });
      } catch (error) {
        if (!transferHash) {
          logWriteTransactionError({
            functionName: 'transferFrom',
            contract: PPDC_CONTRACT_ADDRESS,
            args: transferArgs,
            error,
          });
        }
        throw error;
      }
      updateOperationStep('transfer', 'complete');

      currentOperation = 'subscribe';
      updateOperationStep('subscribe', 'active');
      setSubscriptionStep('Operator creates account...');
      const subscribeArgs = [
        session.walletAddress,
        session.operator,
        profile.displayName?.trim() ?? '',
        session.operatorBlsPublicKey ?? '0x',
        currentProfileBlob,
        tierToContractId(selectedTier),
      ];
      let subscribeHash;
      try {
        subscribeHash = await operator.writeContract({
          contract: PRIVATE_POKER_CONTRACT_ADDRESS,
          abi: ACCOUNT_ABI,
          functionName: 'subscribe',
          args: subscribeArgs,
        });
        await waitForLoggedTransactionReceipt({
          hash: subscribeHash,
          functionName: 'subscribe',
          contract: PRIVATE_POKER_CONTRACT_ADDRESS,
          args: subscribeArgs,
        });
      } catch (error) {
        if (!subscribeHash) {
          logWriteTransactionError({
            functionName: 'subscribe',
            contract: PRIVATE_POKER_CONTRACT_ADDRESS,
            args: subscribeArgs,
            error,
          });
        }
        throw error;
      }
      updateOperationStep('subscribe', 'complete');

      setHasOnchainAccount(true);
      setAccountStatus(ACCOUNT_STATUS.VERIFIED);
      setIsSubscriptionActive(true);
      setOperationDialog((current) => current
        ? {
          ...current,
          title: 'Subscription Active',
          description: 'Your account is verified and subscribed. Continue to the main lobby.',
          isComplete: true,
          nextAction: 'mainLobby',
        }
        : current);
    } catch (err) {
      console.error('Subscription failed:', err);
      failOperation(currentOperation ?? 'subscribe', err, 'Subscription failed.');
      setError(formatChainError(err, 'Subscription failed.'));
    } finally {
      setIsSubscribing(false);
      setSubscriptionStep('');
    }
  }, [
    accountSession,
    accountStatus,
    address,
    approveOperatorPpdc,
    createOperatorAddress,
    failOperation,
    profile.displayName,
    profile,
    profileBlob,
    selectedTier,
    signIn,
    updateOperationStep,
  ]);

  return {
    accountSession,
    accountStatus,
    accountStatusChangedAt,
    accountStatusLabel: accountStatusLabel(accountStatus),
    error,
    handleProfileChange,
    handleProfileContinue,
    handleProfileEdit,
    handleProfileSave,
    handleContinue,
    handleSignin,
    getPlayerDisplayname,
    isCheckingAccount,
    isSavingProfile,
    isSigningIn,
    isSubscribing,
    isSubscriptionActive,
    isWalletConnected,
    operationDialog,
    profile,
    profileBlob,
    profileMode,
    selectedTier,
    handleOperationDialogOk,
    setSelectedTier,
    signinData,
    signinFields,
    step,
    subscriptionStep,
    subscriptionTiers: SUBSCRIPTION_TIERS,
  };
}
