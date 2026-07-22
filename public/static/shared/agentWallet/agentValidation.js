// ============================================================
// ARC ERC-8004 Validation Registry Client
// Real on-chain calls via ethers.js
//
// Contract: 0x8004Cb1BF31DAf7788923b405b754f57acEB4272
// Network: Arc Testnet (Chain 5042002)
//
// Two-step flow:
//   1. Owner requests validation: validationRequest(validator, agentId, uri, hash)
//   2. Validator responds: validationResponse(hash, response, ...)
//      response: 100 = passed, 0 = failed
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};
  var E8 = D.ERC8004 || {};
  D.ERC8004 = E8;

  function _getProvider() {
    if (window.ethers && window.walletState && window.walletState.provider) {
      return new ethers.BrowserProvider(window.walletState.provider);
    }
    return new ethers.JsonRpcProvider(E8.RPC, E8.CHAIN_ID);
  }

  function _getSigner() {
    if (!window.ethers) throw new Error('ethers.js not loaded');
    if (!window.walletState || !window.walletState.provider) throw new Error('Wallet not connected');
    return new ethers.BrowserProvider(window.walletState.provider).getSigner();
  }

  function _getContract(providerOrSigner) {
    if (!window.ethers) throw new Error('ethers.js not loaded');
    return new ethers.Contract(
      E8.CONTRACTS.VALIDATION_REGISTRY,
      E8.VALIDATION_ABI,
      providerOrSigner
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  VALIDATION CLIENT
  // ═══════════════════════════════════════════════════════════════

  E8.ValidationClient = {
    /**
     * Generate a unique request hash for a validation request.
     * @param {string} agentId
     * @param {string} tag - validation type (e.g. "kyc", "capability_audit")
     * @returns {string} bytes32 hex hash
     */
    generateRequestHash: function(agentId, tag) {
      return ethers.keccak256(
        ethers.toUtf8Bytes(tag + '_validation_request_agent_' + agentId + '_' + Date.now())
      );
    },

    /**
     * STEP 1 — Owner requests validation from a validator.
     * Requires MetaMask to sign.
     *
     * @param {string} validatorAddress - address of the validator wallet
     * @param {string|bigint} agentId
     * @param {string} metadataURI - IPFS URI with validation criteria
     * @param {string} requestHash - generated via generateRequestHash()
     * @returns {Promise<{success: boolean, txHash: string, error?: string}>}
     */
    requestValidation: async function(validatorAddress, agentId, metadataURI, requestHash) {
      try {
        var signer = await _getSigner();
        var contract = _getContract(signer);
        var tx = await contract.validationRequest(
          validatorAddress,
          agentId,
          metadataURI || '',
          requestHash
        );
        var receipt = await tx.wait();
        return { success: true, txHash: receipt.hash, requestHash: requestHash };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },

    /**
     * STEP 2 — Validator responds to a validation request.
     * Requires MetaMask to sign from the validator wallet.
     *
     * @param {string} requestHash
     * @param {number} response - 100 = passed, 0 = failed
     * @param {string} metadataURI - IPFS URI with validation results
     * @param {string} tag - short label (e.g. "kyc_verified")
     * @returns {Promise<{success: boolean, txHash: string, error?: string}>}
     */
    respondToValidation: async function(requestHash, response, metadataURI, tag) {
      try {
        var signer = await _getSigner();
        var contract = _getContract(signer);
        var tx = await contract.validationResponse(
          requestHash,
          response,
          metadataURI || '',
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          tag || ''
        );
        var receipt = await tx.wait();
        return { success: true, txHash: receipt.hash };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },

    /**
     * Check the status of a validation request.
     * @param {string} requestHash
     * @returns {Promise<{success: boolean, status: {validator: string, agentId: string, response: number, tag: string, lastUpdate: number}, error?: string}>}
     */
    getStatus: async function(requestHash) {
      try {
        var provider = _getProvider();
        var contract = _getContract(provider);
        var result = await contract.getValidationStatus(requestHash);
        return {
          success: true,
          status: {
            validatorAddress: result[0],
            agentId: result[1].toString(),
            response: Number(result[2]),
            responseHash: result[3],
            tag: result[4],
            lastUpdate: Number(result[5]),
          },
        };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },

    /**
     * Get all pending validation requests for an agent.
     * @param {string|bigint} agentId
     * @returns {Promise<{success: boolean, pendingHashes: string[], error?: string}>}
     */
    getPendingRequests: async function(agentId) {
      try {
        var provider = _getProvider();
        var contract = _getContract(provider);
        var hashes = await contract.getPendingRequests(agentId);
        return { success: true, pendingHashes: hashes.map(function(h) { return h; }) };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },
  };

  console.log('[ERC-8004 ValidationClient] Loaded');
})();
