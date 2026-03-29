// ============================================================
// OTCEscrow ABI + Contract Address
// ExecDaat — OTC Contracts Tab ONLY
//
// Contract: OTCEscrow.sol
// Network:  ARC Testnet (Chain ID: 5042002)
//
// ⚠️  NOTE: OTC_ESCROW_ADDRESS is set to address(0) as a placeholder.
//     After deploying OTCEscrow.sol to ARC Testnet, paste the deployed
//     address below to activate full on-chain escrow functionality.
//     Until deployed, the system falls back to localStorage-only mode.
// ============================================================

// Deployed contract address on ARC Testnet
// Replace with actual address after deployment:
//   npx hardhat run scripts/deploy_otc.js --network arc_testnet
const OTC_ESCROW_ADDRESS = '0x1B58895D02856598d29C8D4f7EFD98D9d5d9332d'; // ARC Testnet — deployed 2026-03-29

// Whether the escrow contract is available (non-zero address)
const OTC_ESCROW_DEPLOYED = OTC_ESCROW_ADDRESS !== '0x0000000000000000000000000000000000000000';

// ─── OTCEscrow ABI ───────────────────────────────────────────────────────────
const OTC_ESCROW_ABI = [
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
    "inputs": [
      { "name": "dealId", "type": "bytes32" }
    ],
    "outputs": []
  },

  // ── fundDeal ─────────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "fundDeal",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "dealId", "type": "bytes32" }
    ],
    "outputs": []
  },

  // ── release ──────────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "release",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "dealId", "type": "bytes32" }
    ],
    "outputs": []
  },

  // ── cancel ───────────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "cancel",
    "stateMutability": "nonpayable",
    "inputs": [
      { "name": "dealId", "type": "bytes32" }
    ],
    "outputs": []
  },

  // ── getDeal ──────────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "getDeal",
    "stateMutability": "view",
    "inputs": [
      { "name": "dealId", "type": "bytes32" }
    ],
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
          { "name": "funded",                "type": "bool"    },
          { "name": "released",              "type": "bool"    },
          { "name": "cancelled",             "type": "bool"    },
          { "name": "buyerCancelRequested",  "type": "bool"    },
          { "name": "sellerCancelRequested", "type": "bool"    },
          { "name": "contractHash",          "type": "bytes32" },
          { "name": "createdAt",             "type": "uint256" }
        ]
      }
    ]
  },

  // ── getDealsByParty ──────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "getDealsByParty",
    "stateMutability": "view",
    "inputs": [
      { "name": "party", "type": "address" }
    ],
    "outputs": [
      { "name": "", "type": "bytes32[]" }
    ]
  },

  // ── canRelease ───────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "canRelease",
    "stateMutability": "view",
    "inputs": [
      { "name": "dealId", "type": "bytes32" }
    ],
    "outputs": [
      { "name": "", "type": "bool" }
    ]
  },

  // ── dealStatus ───────────────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "dealStatus",
    "stateMutability": "view",
    "inputs": [
      { "name": "dealId", "type": "bytes32" }
    ],
    "outputs": [
      { "name": "", "type": "string" }
    ]
  },

  // ── deals (public mapping) ────────────────────────────────────────────────────
  {
    "type": "function",
    "name": "deals",
    "stateMutability": "view",
    "inputs": [
      { "name": "dealId", "type": "bytes32" }
    ],
    "outputs": [
      { "name": "buyer",                 "type": "address" },
      { "name": "seller",                "type": "address" },
      { "name": "token",                 "type": "address" },
      { "name": "amount",                "type": "uint256" },
      { "name": "tgeTimestamp",          "type": "uint256" },
      { "name": "buyerSigned",           "type": "bool"    },
      { "name": "sellerSigned",          "type": "bool"    },
      { "name": "funded",                "type": "bool"    },
      { "name": "released",              "type": "bool"    },
      { "name": "cancelled",             "type": "bool"    },
      { "name": "buyerCancelRequested",  "type": "bool"    },
      { "name": "sellerCancelRequested", "type": "bool"    },
      { "name": "contractHash",          "type": "bytes32" },
      { "name": "createdAt",             "type": "uint256" }
    ]
  },

  // ─── EVENTS ──────────────────────────────────────────────────────────────────
  {
    "type": "event",
    "name": "DealCreated",
    "inputs": [
      { "name": "dealId",       "type": "bytes32", "indexed": true },
      { "name": "buyer",        "type": "address", "indexed": true },
      { "name": "seller",       "type": "address", "indexed": true },
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
      { "name": "dealId", "type": "bytes32", "indexed": true },
      { "name": "signer", "type": "address", "indexed": true },
      { "name": "role",   "type": "string",  "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "DealFunded",
    "inputs": [
      { "name": "dealId", "type": "bytes32", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "DealReleased",
    "inputs": [
      { "name": "dealId", "type": "bytes32", "indexed": true },
      { "name": "seller", "type": "address", "indexed": true },
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

  // ─── ERRORS ──────────────────────────────────────────────────────────────────
  { "type": "error", "name": "NotParty",             "inputs": [] },
  { "type": "error", "name": "AlreadySigned",        "inputs": [] },
  { "type": "error", "name": "NotBothSigned",        "inputs": [] },
  { "type": "error", "name": "AlreadyFunded",        "inputs": [] },
  { "type": "error", "name": "NotFunded",            "inputs": [] },
  { "type": "error", "name": "AlreadyReleased",      "inputs": [] },
  { "type": "error", "name": "AlreadyCancelled",     "inputs": [] },
  { "type": "error", "name": "TGENotReached",        "inputs": [] },
  { "type": "error", "name": "DealNotFound",         "inputs": [] },
  { "type": "error", "name": "InvalidAddress",       "inputs": [] },
  { "type": "error", "name": "InvalidAmount",        "inputs": [] },
  { "type": "error", "name": "InvalidTimestamp",     "inputs": [] },
  { "type": "error", "name": "SameAddress",          "inputs": [] },
  { "type": "error", "name": "AlreadyCancelRequested", "inputs": [] }
];

// ERC-20 minimal ABI for approvals
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
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint8" }]
  },
  {
    "type": "function",
    "name": "symbol",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [{ "name": "", "type": "string" }]
  },
  {
    "type": "function",
    "name": "balanceOf",
    "stateMutability": "view",
    "inputs": [{ "name": "account", "type": "address" }],
    "outputs": [{ "name": "", "type": "uint256" }]
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
    const erc20 = otcGetERC20Contract(tokenAddr, provider);
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
    const erc20 = otcGetERC20Contract(tokenAddr, provider);
    const decimals = await erc20.decimals();
    return ethers.formatUnits(raw, decimals);
  } catch(e) {
    return ethers.formatUnits(raw, 6);
  }
}
