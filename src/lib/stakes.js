// lib/stakes.js

export const STAKES_OPTIONS = [
    { label: "Micro Stakes: $1 ($0.01/0.02)", buyin: 1, blinds: "0.01/0.02" },
    { label: "Low Stakes: $10 ($0.1/0.2)", buyin: 10, blinds: "0.1/0.2" },
    { label: "Mid Stakes: $100 ($1/2)", buyin: 100, blinds: "1/2" },
    { label: "High Stakes: $1000 ($10/$20)", buyin: 1000, blinds: "10/20" },
    { label: "Large Stakes: $10000 ($100/$200)", buyin: 10000, blinds: "100/200" },
];

export function getBlindsForBuyin(buyinAmount) {
    const numBuyin = Number(buyinAmount);
    if (!Number.isFinite(numBuyin) || numBuyin <= 0) return null;

    const option = STAKES_OPTIONS.find(opt => opt.buyin === numBuyin);
    const smallBlind = numBuyin / 100;
    const bigBlind = numBuyin / 50;

    return {
        smallBlind,
        bigBlind,
        label: option ? option.blinds : `${smallBlind}/${bigBlind}`,
        toString() {
            return this.label;
        },
    };
}

export function getStakesLabel(buyinAmount) {
    const numBuyin = Number(buyinAmount);
    const option = STAKES_OPTIONS.find(opt => opt.buyin === numBuyin);
    return option ? option.label : `Stakes: $${buyinAmount}`;
}