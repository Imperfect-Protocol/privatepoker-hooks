import { useState, useRef, useCallback, useEffect } from 'react';

export function useCountdown() {
    const [countdown, setCountdown] = useState(null);
    const timerRef = useRef(null);

    const clearTimer = useCallback(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const startCountdown = useCallback((seconds, onComplete) => {
        clearTimer();
        setCountdown(seconds);

        timerRef.current = setInterval(() => {
            setCountdown((prev) => {
                if (prev === null || prev <= 1) {
                    clearTimer();
                    setCountdown(null);
                    onComplete?.();
                    return null;
                }
                return prev - 1;
            });
        }, 1000);
    }, [clearTimer]);

    useEffect(() => {
        return () => clearTimer();
    }, [clearTimer]);

    return {
        countdown,
        startCountdown,
        clearTimer,
    };
}