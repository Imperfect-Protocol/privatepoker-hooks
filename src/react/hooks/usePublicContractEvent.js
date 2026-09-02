import { useEffect, useRef } from 'react';
import { CHAIN_POLLING_INTERVAL } from 'privatepoker-hooks/config/chain';
import { publicPokerClient } from 'privatepoker-hooks/blockchain/clients/PokerClients';

export function usePublicContractEvent({
  address,
  abi,
  eventName,
  enabled = true,
  onLogs,
}) {
  const onLogsRef = useRef(onLogs);
  const seenLogsRef = useRef(new Set());
  const lastBlockRef = useRef(null);

  useEffect(() => {
    onLogsRef.current = onLogs;
  }, [onLogs]);

  useEffect(() => {
    if (!enabled || !address) return undefined;

    let cancelled = false;
    let timer = null;
    let inFlight = false;

    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;

      try {
        const blockNumber = await publicPokerClient.getBlockNumber();
        const fromBlock = lastBlockRef.current === null
          ? blockNumber
          : lastBlockRef.current + 1n;
        lastBlockRef.current = blockNumber;

        if (fromBlock <= blockNumber) {
          const logs = await publicPokerClient.getContractEvents({
            address,
            abi,
            eventName,
            fromBlock,
            toBlock: blockNumber,
          });

          const freshLogs = logs.filter((log) => {
            const logId = `${log.transactionHash}:${log.logIndex}`;
            if (seenLogsRef.current.has(logId)) return false;
            seenLogsRef.current.add(logId);
            if (seenLogsRef.current.size > 500) {
              const [oldestLogId] = seenLogsRef.current;
              seenLogsRef.current.delete(oldestLogId);
            }
            return true;
          });

          if (freshLogs.length > 0) {
            onLogsRef.current?.(freshLogs);
          }
        }
      } catch (error) {
        console.debug(`[chain debug] ${eventName} watcher failed`, error);
      } finally {
        inFlight = false;
        if (!cancelled) {
          timer = setTimeout(poll, CHAIN_POLLING_INTERVAL);
        }
      }
    };

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [address, enabled, eventName]);
}
