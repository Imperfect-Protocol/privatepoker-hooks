// lib/constants.js

export const GAME_TYPES = {
    1: "Texas Hold'em",
    2: "Omaha",
    3: "Draw Poker"
};

export const LOBBY_FLAGS = {
    0: "inactive",
    1: "active"
};

export const TABLE_FLAGS = {
    0: "seating",
    1: "playing",
    2: "finished"
};

export const CHIPS_DECIMALS = 6;
export const CHIPS_SCALE = 1_000_000n;
export const OPERATOR_GAS_TOPUP_FACTOR = 10n;
export const OPERATOR_GAS_MAX_TOPUP = 1_000_000_000_000_000_000n;
export const PRIVATE_POKER_DEMO_DISCLAIMER =
    "Disclaimer: This is a tech demo of the Private Poker running on a test network. No real money is involved, no real-money gambling is taking place, and the application is not being presented as a production gambling service. The demo is intended for technical discussion, testing, and project sharing within developer, founder, Web3, and Arbitrum ecosystem circles. It is not intended for paid advertising, gambling promotion, gambling user acquisition, or consumer-facing marketing. The purpose is to demonstrate underlying technology: peer-to-peer networking, WebRTC, cryptography, smart contracts, blockchain settlement, and protocol design.";

export const SUBSCRIPTION_TIERS = [
    {
        id: "starter",
        name: "Starter",
        monthlyPpdc: 10,
        chips: 1_000,
        accent: "teal",
        description: "Casual tables, quiet bankroll, easy entry.",
    },
    {
        id: "regular",
        name: "Regular",
        monthlyPpdc: 50,
        chips: 10_000,
        accent: "cyan",
        description: "Room for deeper games and regular sessions.",
    },
    {
        id: "professional",
        name: "Professional",
        monthlyPpdc: 200,
        chips: 100_000,
        accent: "amber",
        description: "Serious stacks for high-volume play.",
    },
];

export const BLS_TABLE_SESSION_DOMAIN = {
    name: "PrivatePoker",
    version: "1",
};

export const BLS_TABLE_SESSION_TYPES = {
    PrivatePokerTableSession: [
        { name: "tableId", type: "uint256" },
        { name: "lobbyId", type: "uint256" },
    ],
};

export function getGameTypeName(gameTypeInt) {
    return GAME_TYPES[gameTypeInt] || "Unknown Game";
}

export function getLobbyStatus(flagInt) {
    return LOBBY_FLAGS[flagInt] || "inactive";
}

export function getTableState(flagInt) {
    return TABLE_FLAGS[flagInt] || "seating";
}

export function toChipUnits(chipsAmount) {
    return BigInt(chipsAmount) * CHIPS_SCALE;
}

export function fromChipUnits(chipUnits) {
    return (BigInt(chipUnits) / CHIPS_SCALE).toString();
}
