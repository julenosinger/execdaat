// ============================================================
// OTCEscrow v3 ABI + Contract Address
// ExecDaat — OTC Contracts Tab ONLY
//
// Contract: OTCEscrow.sol v3
// Network:  ARC Testnet (Chain ID: 5042002)
//
// Changes from v1/v2:
//   - State machine (enum State: Pending, Funded, Completed, Cancelled, Disputed)
//   - release() RESTRICTED: only seller or isAuthorized[msg.sender]
//   - raiseDispute() / resolveDispute() — arbitration mechanism
//   - fundDealWithPermit() — EIP-2612 / gasless approve
//   - setAuthorized() — governance by arbitrator
//   - getDealStatus() now also returns State enum
//   - State cleanup: deal.amount zeroed after release/cancel/resolveDispute
//   - New events: DisputeRaised, DisputeResolved, AuthorizationUpdated
//   - New errors: NotSeller, NotAuthorized, NotArbitrator, DealDisputed,
//                 NoDispute, PermitExpired, InvalidPermitSignature,
//                 InvalidNonce, InvalidState
//
// ⚠️  NOTE: Deploy v3 via:
//   node contracts/script/deployOTCEscrow.cjs <PRIVATE_KEY>
// ============================================================

// Deployed contract address on ARC Testnet
// v1 (original):  0x1B58895D02856598d29C8D4f7EFD98D9d5d9332d  — deployed 2026-03-29
// v2 (NotBuyer/NotSigned/InsufficientAllowance/TransferFailed/getDealStatus): same address
// v3 (dispute, authorized releasers, Permit2, state machine): pending redeployment
//   Run: node contracts/script/deployOTCEscrow.cjs <PRIVATE_KEY>
const OTC_ESCROW_ADDRESS = '0x1B58895D02856598d29C8D4f7EFD98D9d5d9332d'; // ARC Testnet — v1 (live)
// const OTC_ESCROW_ADDRESS = '0x0000000000000000000000000000000000000000'; // set after v3 deploy

// Whether the escrow contract is available (non-zero address)
const OTC_ESCROW_DEPLOYED = OTC_ESCROW_ADDRESS !== '0x0000000000000000000000000000000000000000';

// ─── OTCEscrow v3 ABI ────────────────────────────────────────────────────────
const OTC_ESCROW_ABI = [
  // ══════════════════════════════════════════════════════
  // STATE-CHANGING FUNCTIONS
  // ══════════════════════════════════════════════════════

  // ── createDeal ──────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "createDeal",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "seller",        "type": "address" },
      { "name": "token",         "type": "address" },
      { "name": "amount",        "type": "uint256" },
      { "name": "tgeTimestamp",  "type": "uint256" },
      { "name": "contractHash",  "type": "bytes32" }
    ],
    "outputs": [
      { "name": "dealId", "type": "bytes32" }
    ]
  },

  // ── signDeal ─────────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "signDeal",
    "stateMutability": "nonpayable",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": []
  },

  // ── fundDeal ─────────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "fundDeal",
    "stateMutability": "nonpayable",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": []
  },

  // ── fundDealWithPermit (EIP-2612) ─────────────────────────────────────────────
  {
    "type": "function",
    "name": "fundDealWithPermit",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "dealId",   "type": "bytes32" },
      { "name": "deadline", "type": "uint256" },
      { "name": "v",        "type": "uint8"   },
      { "name": "r",        "type": "bytes32" },
      { "name": "s",        "type": "bytes32" }
    ],
    "outputs": []
  },

  // ── release (RESTRICTED: seller or authorized only) ───────────────────────────
  {
    "type": "function",
    "name": "release",
    "stateMutability": "nonpayable",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": []
  },

  // ── cancel ───────────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "cancel",
    "stateMutability": "nonpayable",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": []
  },

  // ── openDispute (v4 — with reason string) ────────────────────────────────────
  {
    "type": "function",
    "name": "openDispute",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "tradeId", "type": "bytes32" },
      { "name": "reason",  "type": "string"  }
    ],
    "outputs": []
  },

  // ── raiseDispute (v3 backward-compat — no reason) ──────────────────────────────
  {
    "type": "function",
    "name": "raiseDispute",
    "stateMutability": "nonpayable",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": []
  },

  // ── resolveDispute (arbiter only) ──────────────────────────────────────────────
  {
    "type": "function",
    "name": "resolveDispute",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "tradeId",         "type": "bytes32" },
      { "name": "releaseToSeller", "type": "bool"    }
    ],
    "outputs": []
  },

  // ── depositSeller (TRUSTLESS mode) ─────────────────────────────────────────────
  {
    "type": "function",
    "name": "depositSeller",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "dealId",  "type": "bytes32" },
      { "name": "amount",  "type": "uint256" }
    ],
    "outputs": []
  },

  // ── submitProof ────────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "submitProof",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "dealId",    "type": "bytes32" },
      { "name": "proofHash", "type": "bytes32" }
    ],
    "outputs": []
  },

  // ── setAuthorized (arbiter governance) ─────────────────────────────────────────
  {
    "type": "function",
    "name": "setAuthorized",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "account",    "type": "address" },
      { "name": "authorized", "type": "bool"    }
    ],
    "outputs": []
  },

  // ══════════════════════════════════════════════════════
  // VIEW FUNCTIONS
  // ══════════════════════════════════════════════════════

  // ── getDeal ──────────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "getDeal",
    "stateMutability": "view",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          { "name": "buyer",                 "type": "address" },
          { "name": "seller",                "type": "address" },
          { "name": "token",                 "type": "address" },
          { "name": "amount",                "type": "uint256" },
          { "name": "tgeTimestamp",          "type": "uint256" },
          { "name": "buyerSigned",           "type": "bool"    },
          { "name": "sellerSigned",          "type": "bool"    },
          { "name": "state",                 "type": "uint8"   },
          { "name": "buyerCancelRequested",  "type": "bool"    },
          { "name": "sellerCancelRequested", "type": "bool"    },
          { "name": "disputeRaisedBy",       "type": "address" },
          { "name": "contractHash",          "type": "bytes32" },
          { "name": "createdAt",             "type": "uint256" }
        ]
      }
    ]
  },

  // ── getDealStatus (v3: also returns State enum as uint8) ─────────────────────
  {
    "type": "function",
    "name": "getDealStatus",
    "stateMutability": "view",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": [
      { "name": "buyerSigned",   "type": "bool"  },
      { "name": "sellerSigned",  "type": "bool"  },
      { "name": "funded",        "type": "bool"  },
      { "name": "currentState",  "type": "uint8" }
    ]
  },

  // ── getDealsByParty ──────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "getDealsByParty",
    "stateMutability": "view",
    "inputs":  [{ "name": "party", "type": "address" }],
    "outputs": [{ "name": "", "type": "bytes32[]" }]
  },

  // ── canRelease ───────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "canRelease",
    "stateMutability": "view",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": [{ "name": "", "type": "bool" }]
  },

  // ── dealStatus ───────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "dealStatus",
    "stateMutability": "view",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": [{ "name": "", "type": "string" }]
  },

  // ── arbiter / arbitrator (both immutables) ──────────────────────────────────────
  {
    "type": "function",
    "name": "arbiter",
    "stateMutability": "view",
    "inputs":  [],
    "outputs": [{ "name": "", "type": "address" }]
  },
  {
    "type": "function",
    "name": "arbitrator",
    "stateMutability": "view",
    "inputs":  [],
    "outputs": [{ "name": "", "type": "address" }]
  },

  // ── getDisputeData ──────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "getDisputeData",
    "stateMutability": "view",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": [
      { "name": "opener",           "type": "address" },
      { "name": "openedAt",         "type": "uint256" },
      { "name": "reason",           "type": "string"  },
      { "name": "resolved",         "type": "bool"    },
      { "name": "releasedToSeller", "type": "bool"    }
    ]
  },

  // ── getTradeMode ────────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "getTradeMode",
    "stateMutability": "view",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": [{ "name": "", "type": "uint8" }]
  },

  // ── canOpenDispute ──────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "canOpenDispute",
    "stateMutability": "view",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": [
      { "name": "",       "type": "bool"   },
      { "name": "reason", "type": "string" }
    ]
  },

  // ── isAuthorized ───────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "isAuthorized",
    "stateMutability": "view",
    "inputs":  [{ "name": "account", "type": "address" }],
    "outputs": [{ "name": "", "type": "bool" }]
  },

  // ── DOMAIN_SEPARATOR ─────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "DOMAIN_SEPARATOR",
    "stateMutability": "view",
    "inputs":  [],
    "outputs": [{ "name": "", "type": "bytes32" }]
  },

  // ── getNonce ─────────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "getNonce",
    "stateMutability": "view",
    "inputs":  [{ "name": "buyer", "type": "address" }],
    "outputs": [{ "name": "", "type": "uint256" }]
  },

  // ── deals (public mapping) ────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "deals",
    "stateMutability": "view",
    "inputs":  [{ "name": "dealId", "type": "bytes32" }],
    "outputs": [
      { "name": "buyer",                 "type": "address" },
      { "name": "seller",                "type": "address" },
      { "name": "token",                 "type": "address" },
      { "name": "amount",                "type": "uint256" },
      { "name": "tgeTimestamp",          "type": "uint256" },
      { "name": "buyerSigned",           "type": "bool"    },
      { "name": "sellerSigned",          "type": "bool"    },
      { "name": "state",                 "type": "uint8"   },
      { "name": "buyerCancelRequested",  "type": "bool"    },
      { "name": "sellerCancelRequested", "type": "bool"    },
      { "name": "disputeRaisedBy",       "type": "address" },
      { "name": "contractHash",          "type": "bytes32" },
      { "name": "createdAt",             "type": "uint256" }
    ]
  },

  // ══════════════════════════════════════════════════════
  // EVENTS
  // ══════════════════════════════════════════════════════

  {
    "type": "event",
    "name": "DealCreated",
    "inputs": [
      { "name": "dealId",       "type": "bytes32", "indexed": true  },
      { "name": "buyer",        "type": "address", "indexed": true  },
      { "name": "seller",       "type": "address", "indexed": true  },
      { "name": "token",        "type": "address", "indexed": false },
      { "name": "amount",       "type": "uint256", "indexed": false },
      { "name": "tgeTimestamp", "type": "uint256", "indexed": false },
      { "name": "contractHash", "type": "bytes32", "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "DealSigned",
    "inputs": [
      { "name": "dealId", "type": "bytes32", "indexed": true  },
      { "name": "signer", "type": "address", "indexed": true  },
      { "name": "role",   "type": "string",  "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "DealFunded",
    "inputs": [
      { "name": "dealId", "type": "bytes32", "indexed": true  },
      { "name": "amount", "type": "uint256", "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "DealReleased",
    "inputs": [
      { "name": "dealId", "type": "bytes32", "indexed": true  },
      { "name": "seller", "type": "address", "indexed": true  },
      { "name": "amount", "type": "uint256", "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "DealCancelled",
    "inputs": [
      { "name": "dealId",      "type": "bytes32", "indexed": true  },
      { "name": "cancelledBy", "type": "address", "indexed": true  },
      { "name": "refunded",    "type": "bool",    "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "CancelRequested",
    "inputs": [
      { "name": "dealId",    "type": "bytes32", "indexed": true },
      { "name": "requester", "type": "address", "indexed": true }
    ]
  },
  // ── DisputeOpened (v4 primary) ────────────────────────────────────────────────
  {
    "type": "event",
    "name": "DisputeOpened",
    "inputs": [
      { "name": "tradeId",  "type": "bytes32", "indexed": true },
      { "name": "openedBy", "type": "address", "indexed": true }
    ]
  },
  // ── DisputeRaised (v3 compat alias) ──────────────────────────────────────────
  {
    "type": "event",
    "name": "DisputeRaised",
    "inputs": [
      { "name": "dealId",   "type": "bytes32", "indexed": true },
      { "name": "raisedBy", "type": "address", "indexed": true }
    ]
  },
  // ── DisputeResolved (v4: tradeId + bool only) ─────────────────────────────────
  {
    "type": "event",
    "name": "DisputeResolved",
    "inputs": [
      { "name": "tradeId",         "type": "bytes32", "indexed": true  },
      { "name": "releaseToSeller", "type": "bool",    "indexed": false }
    ]
  },
  // ── ProofSubmitted ────────────────────────────────────────────────────────────
  {
    "type": "event",
    "name": "ProofSubmitted",
    "inputs": [
      { "name": "dealId",    "type": "bytes32", "indexed": true },
      { "name": "submitter", "type": "address", "indexed": true },
      { "name": "proofHash", "type": "bytes32", "indexed": false}
    ]
  },
  {
    "type": "event",
    "name": "AuthorizationUpdated",
    "inputs": [
      { "name": "account",    "type": "address", "indexed": true  },
      { "name": "authorized", "type": "bool",    "indexed": false }
    ]
  },

  // ══════════════════════════════════════════════════════
  // ERRORS (with 4-byte selectors in comments for debugging)
  // ══════════════════════════════════════════════════════

  { "type": "error", "name": "NotParty",               "inputs": [] }, // 0xc8ee2d1d
  { "type": "error", "name": "NotBuyer",               "inputs": [] }, // 0x472e017e
  { "type": "error", "name": "NotSeller",              "inputs": [] }, // 0x5ec82351
  { "type": "error", "name": "NotAuthorized",          "inputs": [] }, // 0xea8e4eb5
  { "type": "error", "name": "NotArbitrator",          "inputs": [] }, // 0x667f86ef
  { "type": "error", "name": "AlreadySigned",          "inputs": [] }, // 0xb0bd6aca
  { "type": "error", "name": "NotSigned",              "inputs": [] }, // 0xa72952d8
  { "type": "error", "name": "NotBothSigned",          "inputs": [] }, // 0x7dd2022e (legacy alias)
  { "type": "error", "name": "AlreadyFunded",          "inputs": [] }, // 0x5adf6387
  { "type": "error", "name": "NotFunded",              "inputs": [] }, // 0xd5ef09ba
  { "type": "error", "name": "AlreadyReleased",        "inputs": [] }, // 0x63b4904e
  { "type": "error", "name": "AlreadyCancelled",       "inputs": [] }, // 0x54e37625
  { "type": "error", "name": "DealDisputed",           "inputs": [] }, // 0x912a47b7
  { "type": "error", "name": "NoDispute",              "inputs": [] }, // 0x93754748
  { "type": "error", "name": "TGENotReached",          "inputs": [] }, // 0x2ebd3179
  { "type": "error", "name": "DealNotFound",           "inputs": [] }, // 0x88f691cc
  { "type": "error", "name": "InvalidAddress",         "inputs": [] }, // 0xe6c4247b
  { "type": "error", "name": "InvalidAmount",          "inputs": [] }, // 0x2c5211c6
  { "type": "error", "name": "InvalidTimestamp",       "inputs": [] }, // 0xb7d09497
  { "type": "error", "name": "SameAddress",            "inputs": [] }, // 0x367558c3
  { "type": "error", "name": "AlreadyCancelRequested", "inputs": [] }, // 0x7c704211
  { "type": "error", "name": "InsufficientAllowance",  "inputs": [] }, // 0x13be252b
  { "type": "error", "name": "TransferFailed",         "inputs": [] }, // 0x90b8ec18
  { "type": "error", "name": "PermitExpired",          "inputs": [] }, // 0x1a15a3cc
  { "type": "error", "name": "InvalidPermitSignature", "inputs": [] }, // 0xa4654144
  { "type": "error", "name": "InvalidNonce",           "inputs": [] }, // 0x756688fe
  { "type": "error", "name": "InvalidState",              "inputs": [] }, // 0xbaf3f0f7
  { "type": "error", "name": "NotArbiter",               "inputs": [] }, // v4
  { "type": "error", "name": "DisputeAlreadyResolved",   "inputs": [] }, // v4
  { "type": "error", "name": "DisputeTimeoutNotReached", "inputs": [] }  // v4
];

// ─── Status enum mapping (mirrors Solidity Status enum v4) ─────────────────
// v3 numeric aliases kept for backward compat
const OTC_DEAL_STATE = {
  // v4 Status values (0–7)
  0: 'CREATED',
  1: 'AWAITING_BUYER_DEPOSIT',
  2: 'AWAITING_SELLER_DEPOSIT',
  3: 'AWAITING_PROOF',
  4: 'READY_TO_SETTLE',
  5: 'IN_DISPUTE',
  6: 'COMPLETED',
  7: 'CANCELLED',
  // Reverse lookup
  CREATED:                 0,
  AWAITING_BUYER_DEPOSIT:  1,
  AWAITING_SELLER_DEPOSIT: 2,
  AWAITING_PROOF:          3,
  READY_TO_SETTLE:         4,
  IN_DISPUTE:              5,
  COMPLETED:               6,
  CANCELLED:               7,
  // v3 backward compat aliases
  Pending:   0,
  Funded:    3,
  Completed: 6,
  Cancelled: 7,
  Disputed:  5,
};

// TradeMode enum
const OTC_TRADE_MODE = {
  0: 'TRUSTLESS',
  1: 'FLEXIBLE',
  TRUSTLESS: 0,
  FLEXIBLE:  1,
};

// ERC-20 minimal ABI for approvals + permit
const OTC_ERC20_APPROVE_ABI = [
  {
    "type": "function",
    "name": "approve",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "spender", "type": "address" },
      { "name": "amount",  "type": "uint256" }
    ],
    "outputs": [{ "name": "", "type": "bool" }]
  },
  {
    "type": "function",
    "name": "allowance",
    "stateMutability": "view",
    "inputs": [
      { "name": "owner",   "type": "address" },
      { "name": "spender", "type": "address" }
    ],
    "outputs": [{ "name": "", "type": "uint256" }]
  },
  {
    "type": "function",
    "name": "decimals",
    "stateMutability": "view",
    "inputs":  [],
    "outputs": [{ "name": "", "type": "uint8" }]
  },
  {
    "type": "function",
    "name": "symbol",
    "stateMutability": "view",
    "inputs":  [],
    "outputs": [{ "name": "", "type": "string" }]
  },
  {
    "type": "function",
    "name": "balanceOf",
    "stateMutability": "view",
    "inputs":  [{ "name": "account", "type": "address" }],
    "outputs": [{ "name": "", "type": "uint256" }]
  },
  // EIP-2612 permit (tokens that support it)
  {
    "type": "function",
    "name": "nonces",
    "stateMutability": "view",
    "inputs":  [{ "name": "owner", "type": "address" }],
    "outputs": [{ "name": "", "type": "uint256" }]
  },
  {
    "type": "function",
    "name": "DOMAIN_SEPARATOR",
    "stateMutability": "view",
    "inputs":  [],
    "outputs": [{ "name": "", "type": "bytes32" }]
  }
];

// Known token addresses on ARC Testnet
const OTC_KNOWN_TOKENS = {
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
};

// Helper: get token address from symbol or use as-is if valid address
function otcResolveToken(assetOrAddr) {
  if (/^0x[0-9a-fA-F]{40}$/.test(assetOrAddr)) return assetOrAddr;
  const upper = (assetOrAddr || '').toUpperCase();
  return OTC_KNOWN_TOKENS[upper] || null;
}

// Helper: get escrow contract instance (requires ethers.js + wallet connected)
function otcGetEscrowContract(signerOrProvider) {
  if (!OTC_ESCROW_DEPLOYED) return null;
  const ethers = window.ethers;
  if (!ethers) return null;
  return new ethers.Contract(OTC_ESCROW_ADDRESS, OTC_ESCROW_ABI, signerOrProvider);
}

// Helper: get ERC20 contract instance
function otcGetERC20Contract(tokenAddr, signerOrProvider) {
  const ethers = window.ethers;
  if (!ethers) return null;
  return new ethers.Contract(tokenAddr, OTC_ERC20_APPROVE_ABI, signerOrProvider);
}

// Helper: parse amount to token raw units (default 6 decimals like USDC)
async function otcParseTokenAmount(amount, tokenAddr, provider) {
  const ethers = window.ethers;
  if (!ethers) return BigInt(Math.round(amount * 1e6));
  try {
    const erc20    = otcGetERC20Contract(tokenAddr, provider);
    const decimals = await erc20.decimals();
    return ethers.parseUnits(String(amount), decimals);
  } catch(e) {
    return ethers.parseUnits(String(amount), 6);
  }
}

// Helper: format token raw amount to human readable
async function otcFormatTokenAmount(raw, tokenAddr, provider) {
  const ethers = window.ethers;
  if (!ethers) return (Number(raw) / 1e6).toFixed(2);
  try {
    const erc20    = otcGetERC20Contract(tokenAddr, provider);
    const decimals = await erc20.decimals();
    return ethers.formatUnits(raw, decimals);
  } catch(e) {
    return ethers.formatUnits(raw, 6);
  }
}

// Helper: decode on-chain deal state (uint8) to human string
function otcDecodeDealState(stateNum) {
  return OTC_DEAL_STATE[Number(stateNum)] || 'Unknown';
}

// Backward-compat alias (v1/v2 code may reference this)
const OTC_ESCROW_ABI_GETDEALSTATUS = OTC_ESCROW_ABI.find(e => e.name === 'getDealStatus');

// ─── Explicit window exports ──────────────────────────────────────────────────
// In browsers, top-level `const` declarations are NOT added to window.*
// (unlike `var`). Scripts loaded after this one that check
// `typeof window.OTC_ESCROW_ADDRESS` would get `undefined`.
// We explicitly assign here so cross-script guards work correctly.
window.OTC_ESCROW_ADDRESS      = OTC_ESCROW_ADDRESS;
window.OTC_ESCROW_DEPLOYED     = OTC_ESCROW_DEPLOYED;
window.OTC_ESCROW_ABI          = OTC_ESCROW_ABI;
window.OTC_DEAL_STATE          = OTC_DEAL_STATE;
window.OTC_TRADE_MODE          = OTC_TRADE_MODE;
window.OTC_KNOWN_TOKENS        = OTC_KNOWN_TOKENS;
window.OTC_ERC20_APPROVE_ABI   = OTC_ERC20_APPROVE_ABI;
window.OTC_ESCROW_ABI_GETDEALSTATUS = OTC_ESCROW_ABI_GETDEALSTATUS;
window.otcResolveToken         = otcResolveToken;
window.otcGetEscrowContract    = otcGetEscrowContract;
window.otcGetERC20Contract     = otcGetERC20Contract;
window.otcParseTokenAmount     = otcParseTokenAmount;
window.otcFormatTokenAmount    = otcFormatTokenAmount;
window.otcDecodeDealState      = otcDecodeDealState;
