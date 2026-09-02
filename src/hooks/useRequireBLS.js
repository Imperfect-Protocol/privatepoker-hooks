import { useBLS } from 'privatepoker-hooks/contexts/BLSContext.jsx';

export function useRequireBLS(tableDetails = null) {
  const { getKeys, isGenerating, generateKeys, generateHandKeys } = useBLS();
  const blsKeys = tableDetails ? getKeys(tableDetails) : null;

  const requireKeys = async (details = tableDetails) => {
    if (!details) {
      throw new Error('Table details are required before authorizing this table session.');
    }
    return generateKeys(details);
  };

  const requireHandKeys = async (handNumber, details = tableDetails) => {
    if (!details) {
      throw new Error('Table details are required before authorizing this hand session.');
    }
    return generateHandKeys(details, handNumber);
  };

  return {
    blsKeys,
    isGenerating,
    generateKeys: requireKeys,
    generateHandKeys: requireHandKeys,
  };
}
