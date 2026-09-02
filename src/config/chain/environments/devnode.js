export const chainConfig = {
  key: 'devnode',
  chainId: 412_346,
  rpcUrl: '/local-rpc',
  ppdcContractAddress: '0xab8e440727a38bbb180f7032ca4a8009e7b52b80',
  privatePokerContractAddress: '0x0aab0d98f2a0da6f2002da8d3ddb314208341725',
  settlerFacetAddress: '0xc2c0c3398915a2d2e9c33c186abfef3192ee25e8',
  aggregatePubKeyFacetAddress: '0xce5303b8e8bfca9d1857976f300fb29928522c6f',
  signatoryAddress: '0xc464c03bfe7efa388457b8b392454b99fa18b124',
  hashToCurveAddress: '0xa39ffa43eba037d67a0f4fe91956038aba0ca386',
  verifySignatureAddress: '0x1b9cbdc65a7bebb0be7f18d93a1896ea1fd46d7a',
  maxGas: {
    privatePoker: {
      default: 5_000_000n,
      functions: {
        setTableAggregatePublicKey: 10_000_000n,
        settleHand: 50_000_000n,
      },
    },
  },
  pollingInterval: 3000,
  staleTime: 5000,
  lastModified: '20260522T161800Z',
};
