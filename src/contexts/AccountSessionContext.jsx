"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAppKit } from '@reown/appkit/react';
import { useConnection, useSignTypedData } from 'wagmi';
import {
  ACCOUNT_SESSION_CHANNEL,
  buildAccountSessionTypedData,
  deriveAccountSession,
  parseAccountSession,
} from 'privatepoker-hooks/lib/accountSession';

const AccountSessionContext = createContext(null);

const normalizeAddress = (value) => value?.toLowerCase() ?? '';

export function AccountSessionProvider({ children }) {
  const { address, isConnected } = useConnection();
  const { open } = useAppKit();
  const { mutateAsync: signTypedDataAsync, isPending } = useSignTypedData();
  const [accountSession, setAccountSession] = useState(null);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const accountSessionRef = useRef(null);
  const channelRef = useRef(null);
  const pendingRequestsRef = useRef(new Map());

  const saveSession = useCallback((session) => {
    accountSessionRef.current = session;
    setAccountSession(session);
    channelRef.current?.postMessage({ type: 'ACCOUNT_SESSION_READY', session });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const channel = new BroadcastChannel(ACCOUNT_SESSION_CHANNEL);
    channelRef.current = channel;

    channel.onmessage = (event) => {
      const message = event.data;
      if (!message?.type) return;

      if (message.type === 'REQUEST_ACCOUNT_SESSION') {
        const currentSession = parseAccountSession(accountSessionRef.current);
        if (currentSession) {
          channel.postMessage({
            type: 'ACCOUNT_SESSION',
            requestId: message.requestId,
            session: currentSession,
          });
        }
        return;
      }

      if (message.type === 'ACCOUNT_SESSION' || message.type === 'ACCOUNT_SESSION_READY') {
        const session = parseAccountSession(message.session);
        if (!session) return;

        if (message.requestId && pendingRequestsRef.current.has(message.requestId)) {
          pendingRequestsRef.current.get(message.requestId)(session);
          pendingRequestsRef.current.delete(message.requestId);
        }

        accountSessionRef.current = session;
        setAccountSession(session);
        setIsRestoringSession(false);
      }
    };

    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!address || !accountSession?.walletAddress) return;
    if (normalizeAddress(address) === normalizeAddress(accountSession.walletAddress)) return;

    accountSessionRef.current = null;
    queueMicrotask(() => {
      setAccountSession(null);
    });
  }, [accountSession?.walletAddress, address]);

  const requestSessionFromTabs = useCallback(() => {
    if (typeof window === 'undefined') return Promise.resolve(null);
    const currentSession = parseAccountSession(accountSessionRef.current);
    if (currentSession) {
      setAccountSession(currentSession);
      return Promise.resolve(currentSession);
    }

    const requestId = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingRequestsRef.current.delete(requestId);
        resolve(null);
      }, 800);
      pendingRequestsRef.current.set(requestId, (session) => {
        clearTimeout(timeout);
        resolve(session);
      });
      channelRef.current?.postMessage({ type: 'REQUEST_ACCOUNT_SESSION', requestId });
    });
  }, []);

  useEffect(() => {
    if (accountSession) {
      setIsRestoringSession(false);
      return undefined;
    }

    let cancelled = false;
    setIsRestoringSession(true);
    requestSessionFromTabs().finally(() => {
      if (!cancelled) setIsRestoringSession(false);
    });

    return () => {
      cancelled = true;
    };
  }, [accountSession, requestSessionFromTabs]);

  const signIn = useCallback(async () => {
    if (!isConnected || !address) {
      open();
      return null;
    }

    const signature = await signTypedDataAsync(buildAccountSessionTypedData());
    const session = deriveAccountSession(signature, address);
    saveSession(session);
    console.log('account session', {
      wallet: session.walletAddress,
      operator: session.operator,
    });
    return session;
  }, [address, isConnected, open, saveSession, signTypedDataAsync]);

  const requireSession = useCallback(async () => {
    if (accountSession) return accountSession;
    const session = await requestSessionFromTabs();
    if (session) return session;
    throw new Error('Sign in to PrivatePoker before entering a table.');
  }, [accountSession, requestSessionFromTabs]);

  return (
    <AccountSessionContext.Provider value={{
      accountSession,
      isSigningIn: isPending,
      isRestoringSession,
      isWalletConnected: isConnected,
      requestSessionFromTabs,
      requireSession,
      signIn,
    }}>
      {children}
    </AccountSessionContext.Provider>
  );
}

export const useAccountSession = () => useContext(AccountSessionContext);
