// ============================================================
// ARC ERC-8004 Contract ABIs — Single Source of Truth
// Build: 20260722a
//
// Contracts deployed on Arc Testnet (Chain 5042002):
//   IdentityRegistry  0x8004A818BFB912233c491871b3d84c89A494BD9e
//   ReputationRegistry 0x8004B663056A597Dffe9eCcC1965A193B7388713
//   ValidationRegistry 0x8004Cb1BF31DAf7788923b405b754f57acEB4272
//
// Based on Arc documentation:
//   https://docs.arc.io/arc/tutorials/register-your-first-ai-agent
//   https://eips.ethereum.org/EIPS/eip-8004
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  D.ERC8004 = {
    CHAIN_ID: 5042002,
    RPC: 'https://rpc.testnet.arc.network',

    CONTRACTS: {
      IDENTITY_REGISTRY:   '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      REPUTATION_REGISTRY: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      VALIDATION_REGISTRY: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
    },

    EXPLORER: 'https://testnet.arcscan.app',

    // ─── ABI: IdentityRegistry (ERC-721 with metadata) ──────────────────────
    // Only functions verified to exist on the deployed contract.
    // Arc docs: https://docs.arc.io/arc/tutorials/register-your-first-ai-agent
    IDENTITY_ABI: [
      {
        name: 'register',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'metadataURI', type: 'string' }],
        outputs: [],
      },
      {
        name: 'ownerOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'tokenId', type: 'uint256' }],
        outputs: [{ name: '', type: 'address' }],
      },
      {
        name: 'tokenURI',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'tokenId', type: 'uint256' }],
        outputs: [{ name: '', type: 'string' }],
      },
      {
        anonymous: false,
        inputs: [
          { indexed: true, name: 'from', type: 'address' },
          { indexed: true, name: 'to', type: 'address' },
          { indexed: true, name: 'tokenId', type: 'uint256' },
        ],
        name: 'Transfer',
        type: 'event',
      },
    ],

    // ─── ABI: ReputationRegistry ────────────────────────────────────────────
    REPUTATION_ABI: [
      {
        name: 'giveFeedback',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'agentId', type: 'uint256' },
          { name: 'score', type: 'int128' },
          { name: 'confidence', type: 'uint8' },
          { name: 'tag', type: 'string' },
          { name: 'metadataURI', type: 'string' },
          { name: 'proofURI', type: 'string' },
          { name: 'context', type: 'string' },
          { name: 'feedbackHash', type: 'bytes32' },
        ],
        outputs: [],
      },
      {
        name: 'getFeedback',
        type: 'function',
        stateMutability: 'view',
        inputs: [
          { name: 'agentId', type: 'uint256' },
          { name: 'validatorAddress', type: 'address' },
        ],
        outputs: [
          { name: 'score', type: 'int128' },
          { name: 'confidence', type: 'uint8' },
          { name: 'tag', type: 'string' },
          { name: 'timestamp', type: 'uint256' },
        ],
      },
      {
        name: 'getAverageScore',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'agentId', type: 'uint256' }],
        outputs: [{ name: '', type: 'int128' }],
      },
      {
        name: 'getFeedbackCount',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'agentId', type: 'uint256' }],
        outputs: [{ name: '', type: 'uint256' }],
      },
      {
        anonymous: false,
        inputs: [
          { indexed: true, name: 'validator', type: 'address' },
          { indexed: true, name: 'agentId', type: 'uint256' },
          { indexed: false, name: 'score', type: 'int128' },
          { indexed: false, name: 'tag', type: 'string' },
        ],
        name: 'FeedbackRecorded',
        type: 'event',
      },
    ],

    // ─── ABI: ValidationRegistry ────────────────────────────────────────────
    VALIDATION_ABI: [
      {
        name: 'validationRequest',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'validator', type: 'address' },
          { name: 'agentId', type: 'uint256' },
          { name: 'metadataURI', type: 'string' },
          { name: 'requestHash', type: 'bytes32' },
        ],
        outputs: [],
      },
      {
        name: 'validationResponse',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'requestHash', type: 'bytes32' },
          { name: 'response', type: 'uint8' },
          { name: 'metadataURI', type: 'string' },
          { name: 'proofHash', type: 'bytes32' },
          { name: 'tag', type: 'string' },
        ],
        outputs: [],
      },
      {
        name: 'getValidationStatus',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'requestHash', type: 'bytes32' }],
        outputs: [
          { name: 'validatorAddress', type: 'address' },
          { name: 'agentId', type: 'uint256' },
          { name: 'response', type: 'uint8' },
          { name: 'responseHash', type: 'bytes32' },
          { name: 'tag', type: 'string' },
          { name: 'lastUpdate', type: 'uint256' },
        ],
      },
      {
        name: 'getPendingRequests',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'agentId', type: 'uint256' }],
        outputs: [{ name: '', type: 'bytes32[]' }],
      },
      {
        anonymous: false,
        inputs: [
          { indexed: true, name: 'requestor', type: 'address' },
          { indexed: true, name: 'validator', type: 'address' },
          { indexed: true, name: 'agentId', type: 'uint256' },
          { indexed: false, name: 'requestHash', type: 'bytes32' },
        ],
        name: 'ValidationRequested',
        type: 'event',
      },
      {
        anonymous: false,
        inputs: [
          { indexed: true, name: 'validator', type: 'address' },
          { indexed: true, name: 'requestHash', type: 'bytes32' },
          { indexed: false, name: 'response', type: 'uint8' },
        ],
        name: 'ValidationResponded',
        type: 'event',
      },
    ],
  };

  console.log('[ERC-8004] Contract ABIs loaded');
})();
