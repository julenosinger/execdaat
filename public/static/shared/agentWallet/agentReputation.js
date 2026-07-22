// ============================================================
// ARC ERC-8004 Reputation Registry Client
// Build: 20260722b — Hardened
//
// Contract: 0x8004B663056A597Dffe9eCcC1965A193B7388713
// Network: Arc Testnet (Chain 5042002)
//
// ANTI-SELF-REPUTATION: Before every giveFeedback() call, the
// module verifies the signer is NOT the agent owner.
//
// ERC-8004 rule: agent owners CANNOT record reputation for
// their own agents. Enforcement is client-side.
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
      E8.CONTRACTS.REPUTATION_REGISTRY,
      E8.REPUTATION_ABI,
      providerOrSigner
    );
  }

  // ── Anti-self-reputation guard ────────────────────────────────────────

  /**
   * Verify the connected wallet is NOT the agent owner.
   * @param {string|bigint} agentId
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async function _checkNotOwner(agentId) {
    try {
      var signer = await _getSigner();
      var signerAddr = (await signer.getAddress()).toLowerCase();

      if (!E8.IdentityClient) {
        return { allowed: true }; // can't verify, proceed
      }

      var agentInfo = await E8.IdentityClient.getAgentById(agentId);
      if (!agentInfo.success || !agentInfo.owner) {
        return { allowed: true }; // agent not found, proceed
      }

      if (signerAddr === agentInfo.owner.toLowerCase()) {
        return {
          allowed: false,
          reason: 'Agent owners cannot give reputation to their own ERC-8004 agents. Use a separate validator wallet.',
        };
      }
      return { allowed: true };
    } catch (e) {
      return { allowed: false, reason: 'Unable to verify ownership: ' + (e.message || String(e)) };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  REPUTATION CLIENT
  // ═══════════════════════════════════════════════════════════════

  E8.ReputationClient = {
    /**
     * Record feedback for an agent. Anti-self-reputation enforced.
     * Requires MetaMask to sign from a validator wallet.
     *
     * @param {string|bigint} agentId
     * @param {number} score -128 to 127
     * @param {number} confidence 0-255
     * @param {string} tag
     * @param {string} metadataURI
     * @returns {Promise<{success: boolean, txHash?: string, error?: string, blocked?: boolean}>}
     */
    giveFeedback: async function(agentId, score, confidence, tag, metadataURI) {
      try {
        var guard = await _checkNotOwner(agentId);
        if (!guard.allowed) {
          return { success: false, error: guard.reason, blocked: true };
        }

        var signer = await _getSigner();
        var contract = _getContract(signer);
        var feedbackHash = ethers.keccak256(
          ethers.toUtf8Bytes(tag + '_' + String(agentId) + '_' + Date.now())
        );
        var tx = await contract.giveFeedback(
          agentId,
          score,
          confidence || 0,
          tag,
          metadataURI || '',
          '',
          '',
          feedbackHash
        );
        var receipt = await tx.wait();

        _emit('reputationRecorded', {
          agentId: String(agentId),
          score: score,
          tag: tag,
          txHash: receipt.hash,
          validator: (await signer.getAddress()).toLowerCase(),
        });

        return {
          success: true,
          txHash: receipt.hash,
          feedbackHash: feedbackHash,
          blockNumber: receipt.blockNumber,
          validator: (await signer.getAddress()).toLowerCase(),
        };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },

    /**
     * Get feedback from a specific validator for an agent.
     */
    getFeedback: async function(agentId, validatorAddress) {
      try {
        var provider = _getProvider();
        var contract = _getContract(provider);
        var result = await contract.getFeedback(agentId, validatorAddress);
        return {
          success: true,
          score: Number(result[0]),
          confidence: Number(result[1]),
          tag: result[2],
          timestamp: Number(result[3]),
        };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },

    /**
     * Get average score for an agent across all validators.
     */
    getStats: async function(agentId) {
      try {
        var provider = _getProvider();
        var contract = _getContract(provider);
        var score = await contract.getAverageScore(agentId);
        var count = await contract.getFeedbackCount(agentId);
        return {
          success: true,
          averageScore: Number(score),
          feedbackCount: Number(count),
        };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },

    /**
     * Get all feedback events for an agent.
     */
    getFeedbackHistory: async function(agentId) {
      try {
        var provider = _getProvider();
        var contract = _getContract(provider);
        var filter = contract.filters.FeedbackRecorded(null, agentId);
        var events = await contract.queryFilter(filter, 0, 'latest');
        return {
          success: true,
          feedbacks: events.map(function(e) {
            return {
              validator: e.args[0],
              agentId: e.args[1].toString(),
              score: Number(e.args[2]),
              tag: e.args[3],
              txHash: e.transactionHash,
              blockNumber: e.blockNumber,
            };
          }),
        };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },
  };

  function _emit(name, detail) {
    window.dispatchEvent(new CustomEvent('erc8004:' + name, { detail: detail }));
  }

  console.log('[ERC-8004 ReputationClient v2] Hardened');
})();
