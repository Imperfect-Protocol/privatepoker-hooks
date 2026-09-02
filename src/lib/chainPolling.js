import { CHAIN_POLLING_INTERVAL } from './chain/index.js';
import { publicPokerClient } from './publicPokerClient.js';

const DEFAULT_TICK_MS = 3000;
const DEFAULT_DUE_WINDOW_MS = 3000;
const DEFAULT_MAX_BATCH_SIZE = 50;
const MIN_INTERVAL_MS = 500;

const hasMulticall3 = () => Boolean(publicPokerClient.chain?.contracts?.multicall3?.address);

function toStableValue(value) {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (Array.isArray(value)) return value.map(toStableValue);
  if (!value || typeof value !== 'object') return value;

  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = toStableValue(value[key]);
      return acc;
    }, {});
}

function clampInterval(intervalMs) {
  return Math.max(MIN_INTERVAL_MS, Number(intervalMs || CHAIN_POLLING_INTERVAL || DEFAULT_TICK_MS));
}

function stripPollingFields(request) {
  const contract = { ...request };
  delete contract.key;
  delete contract.intervalMs;
  delete contract.enabled;
  return contract;
}

export function makeChainPollingKey(request) {
  if (request?.key) return request.key;
  return JSON.stringify(toStableValue(stripPollingFields(request ?? {})));
}

class ChainPoller {
  constructor({
    tickMs = DEFAULT_TICK_MS,
    dueWindowMs = DEFAULT_DUE_WINDOW_MS,
    maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
  } = {}) {
    this.tickMs = tickMs;
    this.dueWindowMs = dueWindowMs;
    this.maxBatchSize = maxBatchSize;
    this.entries = new Map();
    this.nextSubscriberId = 1;
    this.timer = null;
  }

  subscribe(request, subscriber) {
    const key = makeChainPollingKey(request);
    const entry = this.ensureEntry(key, request);
    const subscriberId = this.nextSubscriberId;
    this.nextSubscriberId += 1;

    entry.subscribers.set(subscriberId, {
      intervalMs: clampInterval(subscriber.intervalMs),
      onError: subscriber.onError,
      onResult: subscriber.onResult,
    });
    entry.intervalMs = this.getEntryInterval(entry);

    if (subscriber.immediate !== false) {
      entry.nextInvokeAt = Math.min(entry.nextInvokeAt, Date.now());
    }

    if (entry.hasResult) {
      queueMicrotask(() => subscriber.onResult?.(entry.lastResult));
    }

    this.start();
    this.flush();

    return () => {
      this.unsubscribe(key, subscriberId);
    };
  }

  ensureEntry(key, request) {
    const existing = this.entries.get(key);
    if (existing) {
      existing.request = stripPollingFields(request);
      return existing;
    }

    const entry = {
      hasResult: false,
      inFlight: false,
      intervalMs: CHAIN_POLLING_INTERVAL,
      lastResult: undefined,
      nextInvokeAt: Date.now(),
      request: stripPollingFields(request),
      subscribers: new Map(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  unsubscribe(key, subscriberId) {
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.subscribers.delete(subscriberId);
    if (entry.subscribers.size === 0) {
      this.entries.delete(key);
    } else {
      entry.intervalMs = this.getEntryInterval(entry);
    }

    if (this.entries.size === 0) this.stop();
  }

  getEntryInterval(entry) {
    return Math.min(...Array.from(entry.subscribers.values(), ({ intervalMs }) => intervalMs));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush();
    }, this.tickMs);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  dueEntries(now) {
    return Array.from(this.entries.entries())
      .filter(([, entry]) => (
        !entry.inFlight
        && entry.subscribers.size > 0
        && entry.nextInvokeAt <= now + this.dueWindowMs
      ))
      .sort(([, a], [, b]) => a.nextInvokeAt - b.nextInvokeAt)
      .slice(0, this.maxBatchSize);
  }

  async flush() {
    const due = this.dueEntries(Date.now());
    if (due.length === 0) return;

    due.forEach(([, entry]) => {
      entry.inFlight = true;
    });

    let settled;
    try {
      settled = hasMulticall3()
        ? await this.readWithMulticall(due)
        : await this.readIndividually(due);
    } catch (error) {
      settled = due.map(([key]) => ({ key, error }));
    }

    const now = Date.now();
    settled.forEach(({ key, result, error }) => {
      const entry = this.entries.get(key);
      if (!entry) return;

      entry.inFlight = false;
      entry.nextInvokeAt = now + entry.intervalMs;

      if (error) {
        entry.subscribers.forEach((subscriber) => subscriber.onError?.(error));
        return;
      }

      entry.hasResult = true;
      entry.lastResult = result;
      entry.subscribers.forEach((subscriber) => subscriber.onResult?.(result));
    });
  }

  async readWithMulticall(due) {
    const results = await publicPokerClient.multicall({
      allowFailure: true,
      contracts: due.map(([, entry]) => entry.request),
    });

    return results.map((result, index) => {
      const [key] = due[index];
      if (result.status === 'failure') {
        return { key, error: result.error ?? new Error('Multicall read failed') };
      }

      return { key, result: result.result };
    });
  }

  async readIndividually(due) {
    const results = await Promise.allSettled(
      due.map(([, entry]) => publicPokerClient.readContract(entry.request)),
    );

    return results.map((result, index) => {
      const [key] = due[index];
      if (result.status === 'rejected') return { key, error: result.reason };
      return { key, result: result.value };
    });
  }
}

export const chainPoller = new ChainPoller();
