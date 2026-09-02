import { useEffect, useMemo, useState } from 'react';
import { CHAIN_POLLING_INTERVAL } from 'privatepoker-hooks/config/chain';
import { chainPoller, makeChainPollingKey } from 'privatepoker-hooks/blockchain/polling/ChainPoller';

const emptyState = {
  data: undefined,
  error: null,
  hasResolved: false,
  isLoading: false,
  lastUpdatedAt: null,
};

export function useChainPolling(request, {
  enabled = true,
  immediate = true,
  intervalMs = CHAIN_POLLING_INTERVAL,
} = {}) {
  const requestKey = useMemo(() => (
    request ? makeChainPollingKey(request) : null
  ), [request]);
  const [state, setState] = useState(emptyState);

  useEffect(() => {
    let cancelled = false;
    const safelySetState = (nextState) => {
      queueMicrotask(() => {
        if (!cancelled) setState(nextState);
      });
    };

    if (!enabled || !request || !requestKey) {
      safelySetState(emptyState);
      return () => {
        cancelled = true;
      };
    }

    safelySetState((current) => ({
      ...current,
      error: null,
      isLoading: !current.hasResolved,
    }));

    const unsubscribe = chainPoller.subscribe(request, {
      immediate,
      intervalMs,
      onError: (error) => {
        safelySetState((current) => ({
          ...current,
          error,
          hasResolved: true,
          isLoading: false,
          lastUpdatedAt: Date.now(),
        }));
      },
      onResult: (data) => {
        safelySetState({
          data,
          error: null,
          hasResolved: true,
          isLoading: false,
          lastUpdatedAt: Date.now(),
        });
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled, immediate, intervalMs, request, requestKey]);

  return state;
}
