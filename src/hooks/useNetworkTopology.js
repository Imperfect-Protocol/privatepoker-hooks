import { useCallback } from 'react';

export function useNetworkTopology(seatCount = 0) {
  const getPreviousSeat = useCallback((seatNo) => {
    if (seatNo === null || seatNo === undefined || seatCount < 2) return null;
    return (seatNo - 1 + seatCount) % seatCount;
  }, [seatCount]);

  const getNextSeat = useCallback((seatNo) => {
    if (seatNo === null || seatNo === undefined || seatCount < 2) return null;
    return (seatNo + 1) % seatCount;
  }, [seatCount]);

  return [getPreviousSeat, getNextSeat];
}
