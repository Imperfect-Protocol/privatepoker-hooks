export const chainConfig = {
  key: 'sepolia',
  chainId: 421_614,
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  ppdcContractAddress: '0x59109780bbec4b2c96fa1f7990f777ad6ec78eea',
  privatePokerContractAddress: '0xa0f09d2976833ded3148f1e72f276cc6c49338cc',
  settlerFacetAddress: '0x8e03aad155752377e704ceff6bc3a522e2895772',
  aggregatePubKeyFacetAddress: '0x8fbc3105aad1a14e5711498cf107522e7c3d6942',
  signatoryAddress: '0xee61d8df7053c3b47c2dab337ab2be05a1033dee',
  hashToCurveAddress: '0x3cfe28ab0ddce7734ee38a299052478f64731874',
  verifySignatureAddress: '0xd98334a3515ed2db5b8e506731090261ee1a62b3',
  maxGas: {
    privatePoker: {
      default: 5_000_000n,
      functions: {
        setTableAggregatePublicKey: 10_000_000n,
        settleHand: 50_000_000n,
      },
    },
  },
  pollingInterval: 6000,
  staleTime: 10000,
  lastModified: '20260522T161800Z',
};
