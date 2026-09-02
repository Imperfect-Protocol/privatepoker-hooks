"use client";

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { deriveHandSessionKeys, deriveTableSessionKeys } from 'privatepoker-hooks/account/accountSession';
import { useAccountSession } from 'privatepoker-hooks/react/contexts/AccountSessionContext.jsx';

const normalizeAddress = (value) => value?.toLowerCase() ?? '';

export function makeTableBlsSessionKey(tableDetails, walletAddress) {
    if (!tableDetails?.lobbyId || !tableDetails?.tableId || !walletAddress) return null;
    return [
        normalizeAddress(walletAddress),
        tableDetails.lobbyId,
        tableDetails.tableId,
    ].join(':');
}

const BLSContext = createContext(null);

export function BLSProvider({ children }) {
    const { accountSession, requireSession } = useAccountSession();

    const [tableKeys, setTableKeys] = useState({});
    const [isGenerating, setIsGenerating] = useState(false);
    const [activeAddress, setActiveAddress] = useState(accountSession?.walletAddress);

    useEffect(() => {
        const address = accountSession?.walletAddress;
        if (!address) {
            setTableKeys({});
            setActiveAddress(null);
        } else if (activeAddress && address !== activeAddress) {
            setTableKeys({});
            setActiveAddress(address);
        } else if (!activeAddress && address) {
            setActiveAddress(address);
        }
    }, [accountSession?.walletAddress, activeAddress]);

    const getKeys = useCallback((tableDetails) => {
        const sessionKey = makeTableBlsSessionKey(tableDetails, accountSession?.walletAddress);
        return sessionKey ? tableKeys[sessionKey] ?? null : null;
    }, [accountSession?.walletAddress, tableKeys]);

    const generateKeys = useCallback(async (tableDetails) => {
        const session = await requireSession();

        const sessionKey = makeTableBlsSessionKey(tableDetails, session.walletAddress);
        if (!sessionKey) {
            throw new Error('Table details are required before creating a table session key.');
        }
        if (tableKeys[sessionKey]) return tableKeys[sessionKey];

        setIsGenerating(true);

        try {
            const keys = await deriveTableSessionKeys(session, tableDetails, sessionKey);
            console.log('operator', {
                tableId: tableDetails.tableId?.toString(),
                lobbyId: tableDetails.lobbyId?.toString(),
                address: keys.operator,
            });

            setTableKeys((current) => ({
                ...current,
                [sessionKey]: keys,
            }));
            return keys;
        } catch (error) {
            console.error("User cancelled or signature failed:", error);
            throw error;
        } finally {
            setIsGenerating(false);
        }
    }, [requireSession, tableKeys]);

    const generateHandKeys = useCallback(async (tableDetails, handNumber) => {
        const session = await requireSession();
        return deriveHandSessionKeys(session, tableDetails, handNumber);
    }, [requireSession]);
    
    return (
        <BLSContext.Provider value={{
            getKeys,
            isGenerating,
            generateKeys,
            generateHandKeys,
            isConnected: Boolean(accountSession),
        }}>
            {children}
        </BLSContext.Provider>
    );
}

export const useBLS = () => useContext(BLSContext);
