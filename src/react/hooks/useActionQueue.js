import { useCallback, useMemo, useRef } from 'react';

export function useActionQueue(name = 'action') {
  const queueRef = useRef(Promise.resolve());
  const actionFactoriesRef = useRef(new Map());
  const actionRecordsRef = useRef(new Map());

  const enqueueAction = useCallback((type, task, options = {}) => {
    const label = type || 'action';
    const { key = null, dependsOn = [], cacheable = false } = options;
    const actionKey = key ?? null;
    const shouldCache = Boolean(actionKey && cacheable);

    if (shouldCache && actionRecordsRef.current.has(actionKey)) {
      return actionRecordsRef.current.get(actionKey).promise;
    }

    const dependencyPromises = dependsOn.map((dependencyKey) => {
      const cached = actionRecordsRef.current.get(dependencyKey);
      if (cached) return cached.promise;

      const factory = actionFactoriesRef.current.get(dependencyKey);
      if (!factory) {
        throw new Error(`Missing action factory for dependency ${dependencyKey}`);
      }
      return enqueueAction(dependencyKey, factory, { key: dependencyKey, cacheable: true });
    });

    const record = shouldCache
      ? {
        key: actionKey,
        label,
        status: 'queued',
        result: undefined,
        error: undefined,
        promise: null,
      }
      : null;

    const run = queueRef.current
      .catch(() => {})
      .then(async () => {
        console.log(`[ActionQueue:${name}] ${label} start`);
        if (record) {
          record.status = 'running';
        }
        try {
          if (dependencyPromises.length > 0) {
            await Promise.all(dependencyPromises);
          }
          const result = await task();
          if (record) {
            record.status = 'completed';
            record.result = result;
          }
          return result;
        } catch (error) {
          if (record) {
            record.status = 'failed';
            record.error = error;
          }
          throw error;
        } finally {
          if (record) {
            actionRecordsRef.current.delete(actionKey);
          }
          console.log(`[ActionQueue:${name}] ${label} done`);
        }
      });

    if (record) {
      record.promise = run;
      actionRecordsRef.current.set(actionKey, record);
    }

    queueRef.current = run.catch((error) => {
      console.log(`[ActionQueue:${name}] ${label} failed`, error);
    });
    return run;
  }, [name]);

  const registerAction = useCallback((key, task) => {
    if (!key || typeof task !== 'function') return;
    actionFactoriesRef.current.set(key, task);
  }, []);

  const clearAction = useCallback((key) => {
    actionRecordsRef.current.delete(key);
  }, []);

  const getAction = useCallback((key) => (
    actionRecordsRef.current.get(key) ?? null
  ), []);

  return useMemo(() => ({
    clearAction,
    enqueueAction,
    getAction,
    registerAction,
  }), [clearAction, enqueueAction, getAction, registerAction]);
}
