import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPublicClient, http, isAddress, parseAbi } from 'viem';

import {
  CHAIN_RPC_URL,
  HASH_TO_CURVE_CONTRACT_ADDRESS,
  liveDevnodeChain,
  VERIFY_SIGNATURE_CONTRACT_ADDRESS,
} from './live-devnode-chain.js';
import {
  bytesToHex,
  hexToBytes,
  hash_to_curve,
  make_public_key_from_compressed_slice,
  make_public_key_from_signing_key,
  make_signature_from_compressed_slice,
  sign,
  verify,
} from '../lib/crum_bls/index.js';

const HASH_TO_CURVE_ABI = parseAbi([
  'function toCurve(bytes digest) returns (bytes)',
]);

const VERIFY_SIGNATURE_ABI = parseAbi([
  'function verifySignature(bytes hashed_message, bytes aggregate_public_key, bytes aggregate_signature) returns (bool)',
]);

const TEST_MESSAGES = [
  '0x12345678',
  bytesToHex(new TextEncoder().encode('private-poker/crumble/hash-to-curve/live-test'), { prefix: true }),
];

function pointHex(point) {
  return bytesToHex(point.toRawBytes(true), { prefix: true });
}

function assertLiveContractsConfigured() {
  assert.ok(
    isAddress(HASH_TO_CURVE_CONTRACT_ADDRESS),
    'hashToCurveAddress is not configured on the selected chain config',
  );
  assert.ok(
    isAddress(VERIFY_SIGNATURE_CONTRACT_ADDRESS),
    'verifySignatureAddress is not configured on the selected chain config',
  );
}

function publicClient() {
  assertLiveContractsConfigured();
  return createPublicClient({ chain: liveDevnodeChain(), transport: http(CHAIN_RPC_URL) });
}

test('live hash_to_curve::toCurve matches crum_bls hash_to_curve', async () => {
  const client = publicClient();

  for (const message of TEST_MESSAGES) {
    const onChain = await client.readContract({
      address: HASH_TO_CURVE_CONTRACT_ADDRESS,
      abi: HASH_TO_CURVE_ABI,
      functionName: 'toCurve',
      args: [message],
    });
    const local = pointHex(hash_to_curve(message));

    assert.equal(onChain.toLowerCase(), local.toLowerCase(), `hash_to_curve mismatch for ${message}`);
  }
});

test('live verify_signature::verifySignature matches crum_bls verify for known pass and fail data', async () => {
  const client = publicClient();
  const signingKey = 17n;
  const publicKey = pointHex(make_public_key_from_signing_key(signingKey));
  const message = TEST_MESSAGES[1];
  const signature = pointHex(sign(message, signingKey));
  const wrongMessage = '0x12345678';

  const cases = [
    {
      label: 'valid signature',
      message,
      publicKey,
      signature,
    },
    {
      label: 'wrong message',
      message: wrongMessage,
      publicKey,
      signature,
    },
    {
      label: 'wrong public key',
      message,
      publicKey: pointHex(make_public_key_from_signing_key(19n)),
      signature,
    },
  ];

  for (const testCase of cases) {
    const local = verify(
      testCase.message,
      make_public_key_from_compressed_slice(hexToBytes(testCase.publicKey)),
      make_signature_from_compressed_slice(hexToBytes(testCase.signature)),
    );
    const hashedMessage = pointHex(hash_to_curve(testCase.message));
    const onChain = await client.readContract({
      address: VERIFY_SIGNATURE_CONTRACT_ADDRESS,
      abi: VERIFY_SIGNATURE_ABI,
      functionName: 'verifySignature',
      args: [hashedMessage, testCase.publicKey, testCase.signature],
    });

    assert.equal(onChain, local, `verify_signature mismatch for ${testCase.label}`);
  }
});
