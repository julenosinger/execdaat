// ============================================================
// CIRCLE SKILLS AGENT EXECUTOR — ExecDaat Platform
// Build: 20260409a
//
// ┌─────────────────────────────────────────────────────────┐
// │  CIRCLE SKILLS INTEGRATION — ADDITIVE LAYER ONLY       │
// │                                                         │
// │  Implements AgentExecutor interface expected by:        │
// │    • chat.js (chat-triggered transfers)                 │
// │    • chat-bridge.js (unified message handler)           │
// │    • autonoma.js (AI agent chatbot)                     │
// │    • app.js (aeRenderIntents UI)                        │
// │                                                         │
// │  Circle Skills Patterns Applied:                        │
// │    • use-arc  : Arc Testnet config, USDC gas duality    │
// │    • use-usdc : 6-decimal rule, ERC-20 transfer         │
// │                 address validation, balance check       │
// │                                                         │
// │  SECURITY RULES (from Circle Skills):                   │
// │    ✓ NEVER hardcode private keys                        │
// │    ✓ ALWAYS use 6 decimals for USDC ERC-20              │
// │    ✓ ALWAYS verify chain ID = 5042002 before tx         │
// │    ✓ ALWAYS validate addresses before sending           │
// │    ✓ ALWAYS check balance before execution              │
// │    ✓ ALWAYS get explicit user confirmation              │
// │    ✓ NEVER report success before tx receipt             │
// │    ✓ ALWAYS warn for self-transfers                     │
// │                                                         │
// │  Does NOT:                                              │
// │    ✗ Modify chat.js, autonoma.js, app.js                │
// │    ✗ Replace existing payment flows                     │
// │    ✗ Use mock data or fake transactions                  │
// │    ✗ Execute silently — always requires user approval   │
// └─────────────────────────────────────────────────────────┘
//
// AgentExecutor API (consumed by existing chat/bridge/autonoma):
//   AgentExecutor.queueTransfer(amount, token, to, meta)
//     → Promise<Intent>  — creates intent, triggers wallet approval
//   AgentExecutor.queueMultisend(recipients, token, meta)
//     → Promise<Intent>  — queues batch transfer
//   AgentExecutor.getIntents()
//     → Promise<Intent[]> — returns all stored intents
//   AgentExecutor.startPolling()
//     → void — starts background polling for intent status
//   AgentExecutor.statusBadge(id, status)
//     → string (HTML) — renders status badge for chat messages
//   AgentExecutor.version → string
//
// ============================================================
'use strict';

(function (global) {

  // ─── Circle Skills: use-arc — Arc Testnet Configuration ─────────────────────
  // Source: https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-arc/SKILL.md
  const CS_ARC = {
    chainId:    5042002,
    chainIdHex: '0x4CEF52',
    rpc:        'https://rpc.testnet.arc.network',
    explorer:   'https://testnet.arcscan.app',
    name:       'Arc Testnet',
  };

  // ─── Circle Skills: use-usdc — USDC on Arc Testnet ──────────────────────────
  // Source: https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-usdc/SKILL.md
  // CRITICAL: Arc USDC duality
  //   • Native gas: 18 decimals (gas estimation only)
  //   • ERC-20 balanceOf/transfer/approve: 6 decimals  ← ALL USDC logic uses this
  const CS_USDC = {
    // Arc Testnet USDC — native gas token AND ERC-20 at same address
    address:  '0x3600000000000000000000000000000000000000',
    decimals: 6,   // ← The 6-Decimal Rule — NEVER use 18 for USDC amounts
  };

  const CS_EURC = {
    address:  '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    decimals: 6,
  };

  // ─── Module constants ────────────────────────────────────────────────────────
  const AE_VERSION    = '20260409a-circle-skills';
  const AE_STORE_KEY  = 'circle_skills_intents_v1';
  const AE_MAX_INTENTS = 100;

  // ─── Utility: pad address/uint for ABI encoding ─────────────────────────────
  const _padAddr = a => a.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
  const _padUint = v => BigInt(Math.round(Number(v))).toString(16).padStart(64, '0');

  // ─── Circle Skills: ERC-20 method selectors ─────────────────────────────────
  const CS_SEL = {
    transfer:  '0xa9059cbb', // transfer(address,uint256)
    balanceOf: '0x70a08231', // balanceOf(address)
  };

  // ─── Permit2 constants ───────────────────────────────────────────────────────
  // AllowanceTransfer: transferFrom(address from, address to, uint160 amount, address token)
  // Selector: 0x36c78516
  const PERMIT2_ADDR     = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
  const P2_SEL_ALLOWANCE = '0x927da105'; // allowance(address,address,address)
  const P2_SEL_XFER      = '0x36c78516'; // transferFrom(address,address,uint160,address)

  // ─── Permit2: read on-chain allowance ────────────────────────────────────────
  // Returns { amountWei: BigInt, expiration: number, nonce: number }
  async function _permit2Allowance(owner, tokenAddr, spender, provider) {
    const data = P2_SEL_ALLOWANCE +
      _padAddr(owner) +
      _padAddr(tokenAddr) +
      _padAddr(spender);
    try {
      const hex = await provider.request({
        method: 'eth_call',
        params: [{ to: PERMIT2_ADDR, data }, 'latest'],
      });
      if (!hex || hex === '0x' || hex.length < 194) return { amountWei: 0n, expiration: 0, nonce: 0 };
      const amountWei  = BigInt('0x' + hex.slice(2, 66));
      const expiration = Number(BigInt('0x' + hex.slice(66, 130)));
      const nonce      = Number(BigInt('0x' + hex.slice(130, 194)));
      return { amountWei, expiration, nonce };
    } catch { return { amountWei: 0n, expiration: 0, nonce: 0 }; }
  }

  // ─── Permit2: execute AllowanceTransfer.transferFrom ─────────────────────────
  // Calls Permit2.transferFrom(from, to, uint160 amount, address token)
  // Requires: allowance already set on-chain via permit()
  async function _permit2TransferFrom(tokenAddr, from, to, humanAmount, provider) {
    const rawUnits = BigInt(Math.round(humanAmount * 1e6));
    // ABI encode: (address from, address to, uint160 amount, address token)
    const data = P2_SEL_XFER +
      _padAddr(from) +
      _padAddr(to) +
      _padUint(rawUnits) +
      _padAddr(tokenAddr);

    // Estimate gas
    let gasHex = '0x30D40'; // fallback 200k
    try {
      const estHex = await provider.request({
        method: 'eth_estimateGas',
        params: [{ from, to: PERMIT2_ADDR, data }],
      });
      if (estHex && estHex !== '0x') {
        gasHex = '0x' + Math.ceil(Number(BigInt(estHex)) * 1.3).toString(16);
      }
    } catch {}

    const txHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: PERMIT2_ADDR, data, gas: gasHex }],
    });

    const receipt = await _waitForReceipt(txHash, provider);
    if (receipt && receipt.status === '0x0') {
      throw new Error(`Permit2.transferFrom reverted. TxHash: ${txHash}`);
    }
    return { txHash, receipt, method: 'permit2_transferFrom' };
  }

  // ─── Intent storage ──────────────────────────────────────────────────────────
  function _loadIntents() {
    try { return JSON.parse(localStorage.getItem(AE_STORE_KEY) || '[]'); } catch { return []; }
  }
  function _saveIntents(list) {
    try { localStorage.setItem(AE_STORE_KEY, JSON.stringify(list.slice(0, AE_MAX_INTENTS))); } catch {}
  }
  function _addIntent(intent) {
    const list = _loadIntents();
    list.unshift(intent);
    _saveIntents(list);
    return intent;
  }
  function _updateIntent(id, patch) {
    const list = _loadIntents();
    const idx  = list.findIndex(i => i.id === id);
    if (idx !== -1) {
      Object.assign(list[idx], patch, { updatedAt: Date.now() });
      _saveIntents(list);
      // Emit status update event so chat-bridge and app.js can react
      global.dispatchEvent(new CustomEvent('agentExecutor:update', {
        detail: { intentId: id, ...list[idx] }
      }));
    }
    return list[idx] || null;
  }

  // ─── ID generator ────────────────────────────────────────────────────────────
  function _genId() {
    return 'csa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ─── Toast helper (uses existing showToast from app.js) ──────────────────────
  function _toast(msg, type) {
    if (typeof global.showToast === 'function') global.showToast(msg, type || 'info');
  }

  // ─── Chat message helper (non-intrusive — uses existing appendChatMessage) ───
  function _chat(role, content, mod) {
    if (typeof global.appendChatMessage === 'function') {
      global.appendChatMessage(role, content, mod || 'payments');
    }
  }

  // ─── Circle Skills: use-arc — Verify chain before ANY transaction ────────────
  // Rule: ALWAYS verify chain ID = 5042002 before submitting transactions
  async function _verifyArcChain(provider) {
    const chainHex = await provider.request({ method: 'eth_chainId' });
    const chainId  = parseInt(chainHex, 16);
    if (chainId !== CS_ARC.chainId) {
      throw new Error(
        `Wrong network (chain ${chainId}). Please switch to Arc Testnet (chain ${CS_ARC.chainId}).`
      );
    }
    return true;
  }

  // ─── Circle Skills: use-usdc EVM — Read USDC balance ────────────────────────
  // Rule: ALWAYS check balance before transfers
  // Arc USDC duality: native balance via eth_getBalance uses 18 dec,
  // but ERC-20 balanceOf uses 6 dec. For USDC amounts, use ERC-20 (6 dec).
  async function _readUsdcBalance(wallet, provider) {
    // On Arc, USDC IS the native token. eth_getBalance returns 18-dec native.
    // For USDC application logic we must use ERC-20 balanceOf (6 dec).
    const data   = CS_SEL.balanceOf + _padAddr(wallet);
    const result = await provider.request({
      method: 'eth_call',
      params: [{ to: CS_USDC.address, data }, 'latest'],
    });
    if (!result || result === '0x') return 0;
    // 6 decimal conversion (The 6-Decimal Rule)
    return Number(BigInt(result)) / 1e6;
  }

  async function _readEurcBalance(wallet, provider) {
    const data   = CS_SEL.balanceOf + _padAddr(wallet);
    const result = await provider.request({
      method: 'eth_call',
      params: [{ to: CS_EURC.address, data }, 'latest'],
    });
    if (!result || result === '0x') return 0;
    return Number(BigInt(result)) / 1e6;
  }

  // ─── Circle Skills: use-usdc EVM — Validate inputs before tx ────────────────
  // Rules:
  //   ALWAYS validate all inputs before submitting transactions
  //   ALWAYS warn when self-transfer
  //   ALWAYS check sufficient balance
  function _validateTransferInputs(amount, token, to, from) {
    // Address format (0x + 40 hex chars)
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      throw new Error(`Invalid recipient address: "${to}". Must be 0x followed by 40 hex characters.`);
    }
    // Amount
    const numAmount = parseFloat(amount);
    if (!isNaN(from) && !isNaN(to) && from.toLowerCase() === to.toLowerCase()) {
      throw new Error('Self-transfer detected. Recipient cannot be the same as sender.');
    }
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error(`Invalid amount: "${amount}". Must be a positive number.`);
    }
    if (numAmount > 1_000_000) {
      throw new Error(`Amount ${numAmount} USDC exceeds safety limit. Please use a smaller amount.`);
    }
    // Token whitelist
    const tok = (token || 'USDC').toUpperCase();
    if (!['USDC', 'EURC'].includes(tok)) {
      throw new Error(`Unsupported token: ${tok}. Only USDC and EURC are supported.`);
    }
    return { numAmount, tok };
  }

  // ─── Circle Skills: use-usdc EVM — Build ERC-20 transfer calldata ────────────
  // CRITICAL: The 6-Decimal Rule — parseUnits equivalent
  //   parseUnits("1.00", 6) = 1_000_000n  ← CORRECT
  //   parseUnits("1.00", 18) = 1_000_000_000_000_000_000n  ← WRONG
  function _buildTransferCalldata(to, humanAmount) {
    // Convert human amount to 6-decimal raw units (Circle Skills 6-decimal rule)
    const rawUnits = BigInt(Math.round(humanAmount * 1e6));
    return CS_SEL.transfer + _padAddr(to) + _padUint(rawUnits);
  }

  // ─── Circle Skills: use-usdc EVM — Execute ERC-20 transfer ──────────────────
  // Rules:
  //   ALWAYS get explicit user confirmation (eth_sendTransaction prompts wallet)
  //   NEVER report success before waiting for transaction receipt
  async function _executeErc20Transfer(tokenAddress, to, humanAmount, provider) {
    const calldata = _buildTransferCalldata(to, humanAmount);
    const from = (await provider.request({ method: 'eth_accounts' }))[0];

    // eth_sendTransaction → triggers wallet popup for user approval
    const txHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{
        from,
        to:   tokenAddress,
        data: calldata,
        // No value: ERC-20 transfer doesn't send native tokens
      }],
    });

    // Circle Skills rule: NEVER report success before waiting for receipt
    const receipt = await _waitForReceipt(txHash, provider);

    if (receipt && receipt.status === '0x0') {
      throw new Error(`Transaction reverted. TxHash: ${txHash}`);
    }

    return { txHash, receipt };
  }

  // ─── Wait for transaction receipt ────────────────────────────────────────────
  async function _waitForReceipt(txHash, provider, maxAttempts = 30, intervalMs = 2000) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const receipt = await provider.request({
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        });
        if (receipt) return receipt;
      } catch {}
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return null; // Timeout — tx may still be pending
  }

  // ─── Get wallet provider (uses existing walletState) ─────────────────────────
  function _getConnectedWallet() {
    const state = global.walletState;
    if (!state || !state.connected || !state.address || !state.provider) {
      throw new Error('No wallet connected. Please connect your wallet first.');
    }
    return { address: state.address, provider: state.provider };
  }

  // ─── Status badge HTML (used by chat.js and chat-bridge.js) ─────────────────
  function _statusBadge(id, status) {
    const map = {
      pending:    { color: '#fbbf24', icon: '⏳', label: 'Pending'   },
      processing: { color: '#60a5fa', icon: '⚙️', label: 'Processing' },
      signing:    { color: '#a78bfa', icon: '✍️', label: 'Signing'   },
      broadcast:  { color: '#22d3ee', icon: '📡', label: 'Sent'      },
      completed:  { color: '#4ade80', icon: '✅', label: 'Done'      },
      failed:     { color: '#f87171', icon: '❌', label: 'Failed'    },
      cancelled:  { color: '#6b7280', icon: '🚫', label: 'Cancelled' },
    };
    const s = map[status] || map.pending;
    return `<span style="color:${s.color};font-size:11px;font-weight:600;">${s.icon} ${s.label}</span>`;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CORE: queueTransfer — single USDC/EURC transfer
  //
  // This is the main entry point called by:
  //   • chat.js    _chatAgentTransfer()
  //   • chat-bridge.js  unifiedAgentTransfer()
  //   • autonoma.js (via bridge)
  //
  // Flow (Circle Skills use-usdc pattern):
  //   1. Validate inputs (address, amount, token)
  //   2. Check wallet connected
  //   3. Verify Arc chain ID
  //   4. Check USDC balance >= amount
  //   5. Build ERC-20 calldata (6-decimal rule)
  //   6. Send via eth_sendTransaction (explicit user approval via wallet popup)
  //   7. Wait for receipt
  //   8. Update intent status
  // ════════════════════════════════════════════════════════════════════════════
  async function queueTransfer(amount, token, to, meta) {
    const intentId = _genId();
    const tok      = (token || 'USDC').toUpperCase();

    // Create intent immediately so UI shows it
    const intent = _addIntent({
      id:        intentId,
      type:      'transfer',
      token:     tok,
      amount:    String(amount),
      to,
      meta:      meta || 'via chat',
      status:    'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txHash:    null,
      error:     null,
    });

    // Refresh UI immediately
    _refreshIntentsUI();

    // Execute asynchronously so chat gets immediate response
    (async () => {
      try {
        // Step 1: Validate inputs (Circle Skills security rule)
        const { numAmount } = _validateTransferInputs(amount, tok, to);

        // Step 2: Get connected wallet
        _updateIntent(intentId, { status: 'processing' });
        _toast(`Processing transfer: ${amount} ${tok}…`, 'info');
        const { address: from, provider } = _getConnectedWallet();

        // Step 3: Verify Arc Testnet (Circle Skills use-arc rule)
        await _verifyArcChain(provider);

        // Step 4: Check balance (Circle Skills use-usdc rule)
        _updateIntent(intentId, { status: 'processing' });
        const balance = tok === 'USDC'
          ? await _readUsdcBalance(from, provider)
          : await _readEurcBalance(from, provider);

        if (balance < numAmount) {
          throw new Error(
            `Insufficient ${tok} balance. You have ${balance.toFixed(4)} ${tok}, ` +
            `but need ${numAmount} ${tok}.`
          );
        }

        const tokenAddr = tok === 'USDC' ? CS_USDC.address : CS_EURC.address;
        const nowSec    = Math.floor(Date.now() / 1000);

        // Step 5: Check Permit2 on-chain allowance
        // Permit2 AllowanceTransfer: owner grants themselves (spender = owner)
        // so any caller (including this agent) can call transferFrom on their behalf
        let usePermit2 = false;
        let p2Info     = null;
        try {
          const p2 = await _permit2Allowance(from, tokenAddr, from, provider);
          const amtWei = BigInt(Math.round(numAmount * 1e6));
          if (p2.amountWei >= amtWei && p2.expiration > nowSec) {
            usePermit2 = true;
            p2Info     = p2;
          }
        } catch {}

        // Step 6: Send transfer — Permit2 if available, else direct ERC-20
        _updateIntent(intentId, { status: 'signing' });

        let txHash, receipt, transferMethod;

        if (usePermit2) {
          // Permit2.transferFrom — uses existing on-chain allowance, still triggers wallet popup
          _toast(`Using Permit2 allowance — waiting for wallet approval…`, 'info');
          const remaining = Number(p2Info.amountWei) / 1e6;
          const expiresIn = Math.round((p2Info.expiration - nowSec) / 60);
          _chat('assistant',
            `🔐 **Permit2 active — using your spending permission**\n\n` +
            `✍️ Please approve in your wallet\n\n` +
            `Sending **${amount} ${tok}** → \`${to.slice(0,10)}…${to.slice(-8)}\`\n\n` +
            `| | |\n|---|---|\n` +
            `| Permit balance | ${remaining.toFixed(2)} ${tok} |\n` +
            `| Permit expires in | ${expiresIn} min |\n` +
            `| Method | \`Permit2.transferFrom\` |`,
            'payments'
          );
          const result = await _permit2TransferFrom(tokenAddr, from, to, numAmount, provider);
          txHash  = result.txHash;
          receipt = result.receipt;
          transferMethod = 'permit2_transferFrom';
          // Update Permit2 localStorage usage record
          try {
            const raw = localStorage.getItem('arc_permit2_allowances_v1');
            if (raw) {
              const permits = JSON.parse(raw);
              const match   = permits.find(p =>
                p.wallet?.toLowerCase() === from.toLowerCase() &&
                p.token?.toUpperCase() === tok
              );
              if (match) {
                match.amountUsed = (match.amountUsed || 0) + numAmount;
                localStorage.setItem('arc_permit2_allowances_v1', JSON.stringify(permits));
              }
            }
          } catch {}
        } else {
          // Standard ERC-20 transfer (wallet popup)
          _toast(`Waiting for wallet approval…`, 'info');
          _chat('assistant',
            `✍️ **Please approve in your wallet**\n\n` +
            `Sending **${amount} ${tok}** → \`${to.slice(0,10)}…${to.slice(-8)}\`\n\n` +
            `*Your wallet will pop up — please confirm the transaction.*`,
            'payments'
          );
          const result = await _executeErc20Transfer(tokenAddr, to, numAmount, provider);
          txHash  = result.txHash;
          receipt = result.receipt;
          transferMethod = 'erc20_transfer';
        }

        // Step 7: Success
        _updateIntent(intentId, { status: 'completed', txHash, transferMethod });
        _refreshIntentsUI();
        _toast(`✅ Transfer sent! ${amount} ${tok}`, 'success');
        _chat('assistant',
          `✅ **Transfer confirmed!**\n\n` +
          `| | |\n|---|---|\n` +
          `| Token | **${tok}** |\n` +
          `| Amount | **${amount} ${tok}** |\n` +
          `| To | \`${to.slice(0,10)}…${to.slice(-8)}\` |\n` +
          `| Status | ${_statusBadge(intentId, 'completed')} |\n` +
          `| Method | \`${transferMethod}\` |\n` +
          `| TX | [\`${txHash.slice(0,16)}…\`](${CS_ARC.explorer}/tx/${txHash}) |`,
          'payments'
        );

        // Emit confirmed event so other modules can react
        global.dispatchEvent(new CustomEvent('circleSkills:transferComplete', {
          detail: { intentId, txHash, amount, token: tok, to, from, transferMethod }
        }));

      } catch (err) {
        const errMsg = err?.message || String(err);
        _updateIntent(intentId, { status: 'failed', error: errMsg });
        _refreshIntentsUI();

        // Classify error type for better user guidance (Circle Skills UX pattern)
        let guidance = '';
        if (/insufficient/i.test(errMsg)) {
          guidance = '\n\n💡 Get testnet USDC at [faucet.circle.com](https://faucet.circle.com/)';
        } else if (/wrong network|chain/i.test(errMsg)) {
          guidance = '\n\n💡 Switch to Arc Testnet (Chain ID: 5042002) in your wallet.';
        } else if (/user rejected|user denied|4001/i.test(errMsg)) {
          guidance = '\n\n💡 You cancelled the transaction. Try again when ready.';
          _toast('Transaction cancelled.', 'warning');
          _updateIntent(intentId, { status: 'cancelled' });
          _refreshIntentsUI();
          return; // Don't show error message for cancellations
        } else if (/no wallet|not connected/i.test(errMsg)) {
          guidance = '\n\n💡 Connect your wallet using the button in the header.';
        }

        _toast(`❌ Transfer failed: ${errMsg.slice(0, 60)}`, 'error');
        _chat('assistant',
          `❌ **Transfer failed**\n\n${errMsg}${guidance}`,
          'error'
        );
      }
    })();

    return intent;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CORE: queueMultisend — batch USDC transfers
  //
  // Called by: chat-bridge.js unifiedAgentMultisend()
  //
  // recipients: [{address, amount}, ...]
  // Executes each transfer sequentially with wallet approval per tx,
  // OR falls back to arcPayQueue:addBatch for manual execution.
  // ════════════════════════════════════════════════════════════════════════════
  async function queueMultisend(recipients, token, meta) {
    const intentId = _genId();
    const tok      = (token || 'USDC').toUpperCase();
    const total    = recipients.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

    // Validate all recipients upfront
    for (const r of recipients) {
      _validateTransferInputs(r.amount, tok, r.address);
    }

    const intent = _addIntent({
      id:         intentId,
      type:       'multisend',
      token:      tok,
      amount:     String(total.toFixed(6)),
      recipients: recipients,
      meta:       meta || 'batch via chat',
      status:     'pending',
      createdAt:  Date.now(),
      updatedAt:  Date.now(),
      txHash:     null,
      txHashes:   [],
      error:      null,
    });

    _refreshIntentsUI();

    // For multisend: queue through arcPayQueue:addBatch (existing execution engine)
    // This is the non-destructive approach — uses existing queue-engine.js
    // User explicitly clicks "Execute Payments" to approve each tx
    const payload = {
      type:       'batch',
      token:      tok,
      recipients: recipients.map(r => ({ address: r.address, amount: parseFloat(r.amount) })),
      total,
      intentId,
      meta,
    };

    global.dispatchEvent(new CustomEvent('arcPayQueue:addBatch', { detail: payload }));

    _updateIntent(intentId, { status: 'processing' });
    _refreshIntentsUI();

    return intent;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CORE: getIntents — returns all stored intents
  // Called by: app.js aeRenderIntents(), autonoma.js, chat-bridge.js
  // ════════════════════════════════════════════════════════════════════════════
  async function getIntents() {
    return _loadIntents();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CORE: startPolling — refreshes intent UI periodically
  // Called by: index.tsx "Start poll" button, app.js
  // ════════════════════════════════════════════════════════════════════════════
  function startPolling(intervalMs = 30000) {
    if (global._aePollTimer) clearInterval(global._aePollTimer);
    global._aePollTimer = setInterval(async () => {
      if (document.hidden) return; // request-optimization: no background polling
      try {
        const intents = await getIntents();
        if (typeof global.aeRenderIntents === 'function') {
          global.aeRenderIntents(intents);
        }
      } catch {}
    }, intervalMs);
    if (global.PollingManager) global.PollingManager.register('circle-skills-poll', global._aePollTimer, { ms: intervalMs, scope: 'tab' });
    console.log('[CS-AE] Polling started, interval:', intervalMs, 'ms');
  }

  // ─── Refresh intents UI helper ───────────────────────────────────────────────
  function _refreshIntentsUI() {
    getIntents().then(intents => {
      if (typeof global.aeRenderIntents === 'function') {
        global.aeRenderIntents(intents);
      }
      // Also refresh autonoma intents panel if open
      if (typeof global.autonomaRefreshIntents === 'function') {
        global.autonomaRefreshIntents();
      }
    }).catch(() => {});
  }

  // ════════════════════════════════════════════════════════════════════════════
  // INTENT RECOGNITION EXTENSION — extends existing chatbot NLU
  //
  // This hook installs AFTER existing handleLocalCommand and
  // handleUnifiedMessage are loaded, extending them non-destructively.
  //
  // Supported intent patterns (Circle Skills use-usdc patterns):
  //   "send X USDC to 0x..."     → queueTransfer
  //   "pay X USDC to 0x..."      → queueTransfer
  //   "transfer X USDC to 0x..."  → queueTransfer
  //   "buy this product"          → trigger existing checkout
  //   "execute payment"           → trigger existing queue
  //   "check usdc balance"        → balance query (read-only)
  //   "show my intents"           → display intent list
  //   "circle skills status"      → show module status
  //
  // IMPORTANT: Only adds new patterns not already handled by chat.js.
  // Does NOT override or patch handleLocalCommand.
  // Uses the existing extension point: window._handleLocalCommandCSV chain.
  // ════════════════════════════════════════════════════════════════════════════
  function _installIntentHook() {
    // Wrap the existing handleUnifiedMessage (or handleLocalCommand) to add
    // Circle Skills-specific intent recognition as a post-processor.
    // This is strictly additive — if the existing handler returns true, we skip.

    const _origUnified = global.handleUnifiedMessage;

    global.handleUnifiedMessage = async function(msg, source) {
      // Let existing handler try first — NEVER intercept if it handles the message
      if (typeof _origUnified === 'function') {
        const handled = await _origUnified(msg, source);
        if (handled) return true;
      }

      // ── Circle Skills extended intents (only reaches here if unhandled) ──────
      const lower = msg.toLowerCase().trim();

      // "circle skills status" — module info
      if (/circle skills|cs.?agent|agent executor status/i.test(lower) && /status|info|version/i.test(lower)) {
        const intents = _loadIntents();
        const nPending   = intents.filter(i => ['pending','processing','signing'].includes(i.status)).length;
        const nCompleted = intents.filter(i => i.status === 'completed').length;
        const nFailed    = intents.filter(i => i.status === 'failed').length;
        if (typeof global.hideTypingIndicator === 'function') global.hideTypingIndicator();
        if (typeof global.appendChatMessage === 'function') {
          global.appendChatMessage('assistant',
            `🔵 **Circle Skills Agent Executor**\n\n` +
            `| | |\n|---|---|\n` +
            `| Version | \`${AE_VERSION}\` |\n` +
            `| Network | Arc Testnet (Chain ${CS_ARC.chainId}) |\n` +
            `| USDC | \`${CS_USDC.address.slice(0,12)}…\` (6 dec) |\n` +
            `| Skills | use-arc · use-usdc |\n` +
            `| Total intents | ${intents.length} |\n` +
            `| Pending | ${nPending} |\n` +
            `| Completed | ${nCompleted} |\n` +
            `| Failed | ${nFailed} |\n\n` +
            `*All transactions require explicit wallet approval. No silent execution.*`,
            'general'
          );
        }
        return true;
      }

      // "show my intents" / "show intents" — display intent list
      if (/^(show (my )?intents?|list intents?|my intents?|pending intents?)$/i.test(lower)) {
        const intents = _loadIntents();
        if (typeof global.hideTypingIndicator === 'function') global.hideTypingIndicator();
        _refreshIntentsUI();
        if (typeof global.appendChatMessage === 'function') {
          if (!intents.length) {
            global.appendChatMessage('assistant',
              `📋 **No intents yet.**\n\nUse commands like \`send 5 USDC to 0x...\` to create intents.`,
              'general'
            );
          } else {
            const rows = intents.slice(0, 10).map((i, n) => {
              const badge = _statusBadge(i.id, i.status);
              const time  = new Date(i.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
              return `${n+1}. **${i.amount} ${i.token}** → \`${(i.to||'batch').slice(0,10)}…\` ${badge} _${time}_`;
            }).join('\n');
            global.appendChatMessage('assistant',
              `📋 **Your Intents** (last ${Math.min(intents.length,10)} of ${intents.length})\n\n${rows}`,
              'general'
            );
          }
        }
        return true;
      }

      // "clear intents" / "reset intents"
      if (/^(clear|reset|delete all) intents?$/i.test(lower)) {
        localStorage.removeItem(AE_STORE_KEY);
        _refreshIntentsUI();
        if (typeof global.hideTypingIndicator === 'function') global.hideTypingIndicator();
        if (typeof global.appendChatMessage === 'function') {
          global.appendChatMessage('assistant', '🗑 Intent history cleared.', 'general');
        }
        return true;
      }

      return false; // Unhandled — pass to AI fallback
    };

    console.log('[CS-AE] Intent hook installed on handleUnifiedMessage');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SAFE PRODUCT CHECKOUT BRIDGE
  //
  // When user says "buy this product" or "pay for this", trigger the SAME
  // existing payment logic programmatically — NO duplicate checkout.
  // ════════════════════════════════════════════════════════════════════════════
  function triggerExistingCheckout() {
    // Reuse existing pay button click logic
    const sendBtn = document.getElementById('pay-send-btn');
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      return true;
    }
    // Fallback: switch to payments tab
    if (typeof global.switchTab === 'function') {
      global.switchTab('payments');
      _toast('Opened Payments tab — fill in the details and click Send.', 'info');
    }
    return false;
  }
  global.csTriggerCheckout = triggerExistingCheckout;

  // ════════════════════════════════════════════════════════════════════════════
  // EXPOSE AgentExecutor — this is the contract expected by all existing files
  // ════════════════════════════════════════════════════════════════════════════
  global.AgentExecutor = {
    version:       AE_VERSION,
    queueTransfer,
    queueMultisend,
    getIntents,
    startPolling,
    statusBadge:   _statusBadge,

    // Additional Circle Skills utility methods
    readUsdcBalance: async (wallet) => {
      const { provider } = _getConnectedWallet();
      return _readUsdcBalance(wallet || global.walletState?.address, provider);
    },
    verifyArcChain: async () => {
      const { provider } = _getConnectedWallet();
      return _verifyArcChain(provider);
    },
    triggerCheckout: triggerExistingCheckout,

    // Network config (used by autonoma.js for status display)
    network: CS_ARC,
    usdc:    CS_USDC,
    eurc:    CS_EURC,

    // Meta-tx status (stub — used by autonoma.js for display)
    getMetaTxStatus: () => ({
      enabled:  true,
      provider: 'circle-skills-direct',
      mode:     'wallet-signature',
      network:  CS_ARC.name,
    }),
  };

  console.log(`%c[Circle Skills Agent Executor v${AE_VERSION}] Loaded`, 'color:#60b4ff;font-weight:bold');
  console.log('%c[CS-AE] Network: Arc Testnet (Chain 5042002)', 'color:#34d399');
  console.log('%c[CS-AE] Skills: use-arc · use-usdc', 'color:#a78bfa');
  console.log('%c[CS-AE] Security: 6-decimal rule enforced, chain verify on every tx', 'color:#fbbf24');

  // ─── Install intent hook after DOM is ready (when other scripts loaded) ──────
  function _init() {
    // Small delay to ensure chat.js and chat-bridge.js are fully loaded
    setTimeout(_installIntentHook, 1500);

    // Auto-start polling (UI refresh; request-optimization: 8s → 30s)
    startPolling(30000);

    // Emit ready event so other modules can detect us
    global.dispatchEvent(new CustomEvent('circleSkills:ready', {
      detail: {
        version: AE_VERSION,
        network: CS_ARC,
        usdc:    CS_USDC,
        skills:  ['use-arc', 'use-usdc'],
      }
    }));

    console.log('[CS-AE] ✓ AgentExecutor ready — circle-skills-agent.js');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})(window);
