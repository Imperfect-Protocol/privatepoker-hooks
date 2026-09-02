import { bytesToHex, hexToBytes } from 'viem';
import {
    decrypt_signal_from_peer_hex,
    encrypt_signal_for_peer,
} from 'privatepoker-hooks/lib/crum_bls/signal_crypto.js';
import { PUBLIC_KEY_COMPRESSED_LEN } from 'privatepoker-hooks/lib/crum_bls/util.js';

const ensureHexPrefix = (value) => {
    const normalized = value ?? '';
    return normalized.startsWith('0x') ? normalized : `0x${normalized}`;
};

const CRUM_BLS_SIGNAL_SCHEME = 'CRUM_BLS_G2_XOR_KECCAK_V1';

function hexByteLength(value) {
    return hexToBytes(ensureHexPrefix(value)).length;
}

export const normalizePeerPublicKey = (value) => {
    const normalized = ensureHexPrefix(value);
    if (hexByteLength(normalized) !== PUBLIC_KEY_COMPRESSED_LEN) {
        throw new Error(`Expected ${PUBLIC_KEY_COMPRESSED_LEN}-byte G2 public key`);
    }
    return normalized;
};

function requireCrumBlsSignalPayload(encryptedPayload) {
    if (encryptedPayload?.scheme !== CRUM_BLS_SIGNAL_SCHEME || !encryptedPayload?.payload) {
        throw new Error('Expected CRUM BLS G2 signal payload');
    }
    return encryptedPayload.payload;
}

export async function encryptForPeer(recipientPubKeyHex, message) {
    const recipientPublicKey = normalizePeerPublicKey(recipientPubKeyHex);
    return {
        scheme: CRUM_BLS_SIGNAL_SCHEME,
        payload: bytesToHex(encrypt_signal_for_peer(
            recipientPublicKey,
            new TextEncoder().encode(message)
        )),
    };
}

export async function decryptFromPeer(myPrivKeyHex, encryptedPayload) {
    return new TextDecoder().decode(
        decrypt_signal_from_peer_hex(myPrivKeyHex, requireCrumBlsSignalPayload(encryptedPayload))
    );
}
