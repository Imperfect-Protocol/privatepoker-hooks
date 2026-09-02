import { useEffect, useMemo } from 'react';
import { rtcSessionPool } from 'privatepoker-hooks/networking/pool/RtcSessionPool';

export function useRtcSessionPool({ role = null } = {}) {
  const pool = useMemo(() => rtcSessionPool, []);
  useEffect(() => {
    if (role) {
      pool.setRole(role);
    }
  }, [pool, role]);
  return pool;
}
