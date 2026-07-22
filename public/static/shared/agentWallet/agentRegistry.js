// ============================================================
// ARC ERC-8004 Identity Registry Client
// Real on-chain calls via ethers.js (already loaded in ExecDaat)
//
// Contract: 0x8004A818BFB912233c491871b3d84c89A494BD9e
// Network: Arc Testnet (Chain 5042002)
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

  function _getIdentityContract(providerOrSigner) {
    if (!window.ethers) throw new Error('ethers.js not loaded');
    return new ethers.Contract(
      E8.CONTRACTS.IDENTITY_REGISTRY,
      E8.IDENTITY_ABI,
      providerOrSigner
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  IDENTITY CLIENT
  // ═══════════════════════════════════════════════════════════════

  E8.IdentityClient = {
    /**
     * Register a new agent identity on-chain.
     * Requires MetaMask to sign the transaction.
     * @param {string} metadataURI - IPFS URI pointing to agent metadata JSON
     * @returns {Promise<{success: boolean, txHash: string, error?: string}>}
     */
    register: async function(metadataURI) {
      try {
        var signer = await _getSigner();
        var contract = _getIdentityContract(signer);
        var tx = await contract.register(metadataURI);
        var receipt = await tx.wait();
        return {
          success: true,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
        };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },

    /**
     * Retrieve a confirmed transaction receipt.
     * @param {string} txHash
     * @returns {Promise<{blockNumber: number}|null>}
     */
    getReceipt: async function(txHash) {
      try {
        var provider = _getProvider();
        return await provider.getTransactionReceipt(txHash);
      } catch (e) {
        return null;
      }
    },

    /**
     * Fetch the latest agent ID (tokenId) registered by an address.
     * Reads Transfer events from block 0 to latest.
     * @param {string} ownerAddress
     * @returns {Promise<{success: boolean, agentId: string, owner: string, tokenURI: string, error?: string}>}
     */
    getAgentByOwner: async function(ownerAddress) {
      try {
        var provider = _getProvider();
        var contract = _getIdentityContract(provider);
        var filter = contract.filters.Transfer(null, ownerAddress);
        var events = await contract.queryFilter(filter, 0, 'latest');
        if (events.length === 0) {
          return { success: true, agentId: null, owner: null, tokenURI: null };
        }
        var lastEvent = events[events.length - 1];
        var agentId = lastEvent.args[2].toString();
        var owner = await contract.ownerOf(agentId);
        var tokenURI = await contract.tokenURI(agentId);
        return {
          success: true,
          agentId: agentId,
          owner: owner,
          tokenURI: tokenURI,
          registrationBlock: lastEvent.blockNumber,
        };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },

    /**
     * Get agent identity by token ID.
     * @param {string|bigint} agentId
     * @returns {Promise<{success: boolean, owner: string, tokenURI: string, error?: string}>}
     */
    getAgentById: async function(agentId) {
      try {
        var provider = _getProvider();
        var contract = _getIdentityContract(provider);
        var owner = await contract.ownerOf(agentId);
        var tokenURI = await contract.tokenURI(agentId);
        return { success: true, owner: owner, tokenURI: tokenURI };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },

    /**
     * Get the registration transaction URL on ArcScan explorer.
     * @param {string} txHash
     * @returns {string}
     */
    getExplorerUrl: function(txHash) {
      return E8.EXPLORER + '/tx/' + txHash;
    },

    /**
     * Build explorer URL for an agent by ID.
     * @param {string} agentId
     * @returns {string}
     */
    getAgentExplorerUrl: function(agentId) {
      return E8.EXPLORER + '/nft/' + E8.CONTRACTS.IDENTITY_REGISTRY + '/instance/' + agentId;
    },
  };

  console.log('[ERC-8004 IdentityClient] Loaded');
})();
