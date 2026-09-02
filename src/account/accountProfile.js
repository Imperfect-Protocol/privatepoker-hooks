import { bytesToHex, hexToBytes } from 'viem';

export const ACCOUNT_PROFILE_VERSION = 2;

export const EMPTY_ACCOUNT_PROFILE = {
  displayName: '',
  email: '',
  phone: '',
  legalName: '',
};

export function profileHasRequiredFields(profile) {
  return Boolean(profile?.displayName?.trim());
}

export function profileNeedsEdit(profileRecord) {
  return !profileRecord
    || profileRecord.version !== ACCOUNT_PROFILE_VERSION
    || !profileHasRequiredFields(profileRecord.profile);
}

export function encodeProfileBlob(profileRecord) {
  return bytesToHex(new TextEncoder().encode(JSON.stringify(profileRecord)));
}

export function decodeProfileBlob(blobHex) {
  if (!blobHex) return null;
  return JSON.parse(new TextDecoder().decode(hexToBytes(blobHex)));
}

export async function buildAccountProfileBlob(profile) {
  const publicProfile = {
    displayName: profile.displayName.trim(),
  };

  return encodeProfileBlob({
    type: 'PrivatePokerAccountProfile',
    version: ACCOUNT_PROFILE_VERSION,
    publicProfile,
  });
}

export async function readAccountProfileBlob(blobHex) {
  if (!blobHex) return null;

  const blob = decodeProfileBlob(blobHex);

  return {
    blobHex,
    version: blob.version,
    profile: {
      ...EMPTY_ACCOUNT_PROFILE,
      displayName: blob.publicProfile?.displayName ?? '',
    },
  };
}

export function readAccountProfilePublicBlob(blobHex) {
  const blob = decodeProfileBlob(blobHex);
  return {
    version: blob?.version ?? null,
    displayName: blob?.publicProfile?.displayName ?? '',
  };
}
