// ============================================================
// ExecDaat — Arc Transaction Memo Engine (optional plug-in layer)
// ------------------------------------------------------------
// Wraps a target contract call through the predeployed Arc Memo
// contract so application metadata (invoice/order reference) is
// emitted on-chain as `Memo` events, while the original EOA is
// preserved as msg.sender in the target call (CallFrom precompile).
//
//   Memo contract : 0x5294E9927c3306DcBaDb03fe70b92e01cCede505
//   Entry point   : memo(address target, bytes data, bytes32 memoId, bytes memoData)
//   Network       : Arc Testnet (chainId 5042002) only
//   Docs          : https://docs.arc.io/arc/concepts/transaction-memos
//
// DESIGN CONTRACT (plug-in layer — zero impact when unused):
//   • Every public function is non-throwing: failures return null/false.
//   • Nothing here runs automatically; callers opt in explicitly.
//   • If the memo cannot be built for ANY reason, callers must proceed
//     with their original, unmodified transaction.
//   • No dependency on ethers/viem — pure manual ABI encoding — but it
//     produces {to, data, value} objects compatible with ethers v6,
//     viem/wagmi and raw eth_sendTransaction alike.
// ============================================================
;(function (root) {
  'use strict';
  if (root.MemoEngine) return; // idempotent

  // ─── Constants ──────────────────────────────────────────────────────────
  var MEMO_ADDRESS     = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
  var ARC_CHAIN_ID     = 5042002;
  var ARC_CHAIN_HEX    = '0x4cef52';
  var MEMO_SELECTOR    = '0xc3b2c4f8'; // memo(address,bytes,bytes32,bytes)
  var MEMO_EVENT_TOPIC = '0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4'; // Memo(address,address,bytes32,bytes32,bytes,uint256)
  var RPC_PROXY        = '/api/rpc';

  function maxChars() {
    try {
      var v = root.ExecDaat && root.ExecDaat.CONFIG && root.ExecDaat.CONFIG.LIMITS && root.ExecDaat.CONFIG.LIMITS.MAX_MEMO_LENGTH;
      if (typeof v === 'number' && v > 0) return v;
    } catch (_) {}
    return 200;
  }
  var MAX_MEMO_BYTES = 256; // hard cap on encoded UTF-8 payload

  // ─── Hex / bytes helpers (dependency-free) ──────────────────────────────
  function isHex(s)  { return typeof s === 'string' && /^0x[0-9a-fA-F]*$/.test(s) && s.length % 2 === 0; }
  function isAddr(s) { return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s); }
  function isB32(s)  { return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s); }
  function strip0x(s) { return s.slice(0, 2) === '0x' ? s.slice(2) : s; }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // Minimal fallback (environments without TextEncoder)
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.codePointAt(i);
      if (c > 0xFFFF) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function bytesToHex(bytes) {
    var hex = '', i, b;
    for (i = 0; i < bytes.length; i++) { b = bytes[i]; hex += (b < 16 ? '0' : '') + b.toString(16); }
    return '0x' + hex;
  }
  function padWordRight(hexNo0x) {
    var rem = hexNo0x.length % 64;
    return rem === 0 ? hexNo0x : hexNo0x + '0'.repeat(64 - rem);
  }
  function uintWord(n) { return n.toString(16).padStart(64, '0'); }

  // ─── Validation ──────────────────────────────────────────────────────────
  // Returns { ok, reason, chars, bytes }. Never throws.
  function validate(text) {
    if (typeof text !== 'string') return { ok: false, reason: 'not_string', chars: 0, bytes: 0 };
    var trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: 'empty', chars: 0, bytes: 0 };
    var limit = maxChars();
    var bytes;
    try { bytes = utf8Bytes(trimmed).length; } catch (_) { return { ok: false, reason: 'encoding_failed', chars: trimmed.length, bytes: 0 }; }
    if (trimmed.length > limit) return { ok: false, reason: 'too_long', chars: trimmed.length, bytes: bytes };
    if (bytes > MAX_MEMO_BYTES) return { ok: false, reason: 'too_many_bytes', chars: trimmed.length, bytes: bytes };
    return { ok: true, reason: null, chars: trimmed.length, bytes: bytes };
  }

  // ─── Encoding ─────────────────────────────────────────────────────────────
  // UTF-8 memo text → 0x hex bytes. Null on failure.
  function encodeMemoData(text) {
    try {
      var v = validate(text);
      if (!v.ok) return null;
      return bytesToHex(utf8Bytes(text.trim()));
    } catch (_) { return null; }
  }

  // bytes32 memo identifier. Uses keccak256(seed) via ethers when available,
  // otherwise a cryptographically-random 32-byte id. Null on failure.
  function buildMemoId(seed) {
    try {
      var s = (typeof seed === 'string' && seed) ? seed : ('execdaat:' + Date.now() + ':' + Math.random().toString(16).slice(2));
      var e = root.ethers;
      if (e && typeof e.id === 'function') return e.id(s);
      var cr = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : (root.crypto && root.crypto.getRandomValues ? root.crypto : null);
      if (cr) {
        var arr = new Uint8Array(32);
        cr.getRandomValues(arr);
        return bytesToHex(arr);
      }
      return null;
    } catch (_) { return null; }
  }

  // Manual ABI encoding of memo(address target, bytes data, bytes32 memoId, bytes memoData).
  // Returns full calldata (selector + args) or null.
  function encodeMemoCall(target, data, memoId, memoData) {
    try {
      if (!isAddr(target) || !isHex(data) || !isB32(memoId) || !isHex(memoData) || memoData === '0x') return null;
      var dataHex   = strip0x(data);
      var memoHex   = strip0x(memoData);
      var dataLen   = dataHex.length / 2;
      var memoLen   = memoHex.length / 2;
      var dataPadded = padWordRight(dataHex);
      var memoPadded = padWordRight(memoHex);
      var head =
        uintWord(0) .slice(0, 24) + strip0x(target).toLowerCase() + // address word (12 zero bytes + 20 addr bytes)
        uintWord(0x80) +                                            // offset of `data`   (4 head words × 32)
        strip0x(memoId).toLowerCase() +                             // bytes32 memoId
        uintWord(0x80 + 32 + dataPadded.length / 2);                // offset of `memoData`
      var tail = uintWord(dataLen) + dataPadded + uintWord(memoLen) + memoPadded;
      return MEMO_SELECTOR + head + tail;
    } catch (_) { return null; }
  }

  // ─── Network / contract support detection ────────────────────────────────
  var _codeCache = null; // null = unknown, true/false once probed

  function isSupportedSync(chainId) {
    try {
      if (chainId == null) return false;
      if (typeof chainId === 'string') chainId = chainId.slice(0, 2) === '0x' ? parseInt(chainId, 16) : parseInt(chainId, 10);
      return chainId === ARC_CHAIN_ID;
    } catch (_) { return false; }
  }

  async function _getChainId(provider) {
    try {
      var ws = root.walletState;
      var p = provider || (ws && ws.provider) || null;
      if (p && typeof p.request === 'function') {
        var hex = await p.request({ method: 'eth_chainId' });
        return parseInt(hex, 16);
      }
      if (ws && ws.chainId != null) return typeof ws.chainId === 'string' ? parseInt(ws.chainId, 16) : ws.chainId;
      return null;
    } catch (_) { return null; }
  }

  async function _memoCodeDeployed(provider) {
    if (_codeCache !== null) return _codeCache;
    var code = null;
    // 1) wallet provider (read-only call, no popup — same network as the chainId check)
    try {
      var ws = root.walletState;
      var p = provider || (ws && ws.provider) || null;
      if (p && typeof p.request === 'function') code = await p.request({ method: 'eth_getCode', params: [MEMO_ADDRESS, 'latest'] });
    } catch (_) {}
    // 2) same-origin RPC proxy fallback
    if (code === null || typeof code !== 'string') {
      try {
        if (typeof fetch === 'function') {
          var r = await fetch(RPC_PROXY, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [MEMO_ADDRESS, 'latest'] }),
          });
          var j = await r.json().catch(function () { return null; });
          if (j && typeof j.result === 'string') code = j.result;
        }
      } catch (_) {}
    }
    if (code === null || typeof code !== 'string') return false; // could not verify → treat as unavailable (do NOT cache)
    _codeCache = !!(code && code !== '0x');
    return _codeCache;
  }

  // True only when connected to Arc Testnet AND the Memo contract has bytecode.
  async function isSupported(opts) {
    try {
      var provider = opts && opts.provider;
      var chainId = await _getChainId(provider);
      if (!isSupportedSync(chainId)) return false;
      return await _memoCodeDeployed(provider);
    } catch (_) { return false; }
  }

  // ─── Transaction builders ────────────────────────────────────────────────
  // Sync builder (no network checks) — returns { to, data, value, memoId } or null.
  function buildTxSync(opts) {
    try {
      if (!opts || !isAddr(opts.target) || !isHex(opts.data)) return null;
      var memoData = encodeMemoData(opts.memoText);
      if (!memoData) return null;
      var memoId = isB32(opts.memoId) ? opts.memoId : buildMemoId(opts.memoIdSeed);
      if (!memoId) return null;
      var calldata = encodeMemoCall(opts.target, opts.data, memoId, memoData);
      if (!calldata) return null;
      return { to: MEMO_ADDRESS, data: calldata, value: '0x0', memoId: memoId };
    } catch (_) { return null; }
  }

  // Async builder — additionally verifies network + contract support.
  // Returns { to, data, value, memoId } or null. NEVER throws.
  async function buildTx(opts) {
    try {
      var ok = await isSupported(opts);
      if (!ok) return null;
      return buildTxSync(opts);
    } catch (_) { return null; }
  }

  // Wraps a ready eth_sendTransaction params object ({from,to,data,value?,gas?,gasPrice?}).
  // Returns fresh wrapped params or null. Value-carrying calls are NOT wrappable
  // (Memo.memo is nonpayable). Gas is dropped so the wallet re-estimates.
  async function wrapEthSendParams(txParams, memoText, opts) {
    try {
      if (!txParams || !isAddr(txParams.to) || !isHex(txParams.data || '')) return null;
      var v = txParams.value;
      if (v && v !== '0x0' && v !== '0x00' && v !== 0 && v !== '0') return null;
      var built = await buildTx({ target: txParams.to, data: txParams.data, memoText: memoText, provider: opts && opts.provider });
      if (!built) return null;
      var out = { to: built.to, data: built.data, value: '0x0' };
      if (txParams.from) out.from = txParams.from;
      if (txParams.gasPrice) out.gasPrice = txParams.gasPrice;
      return out;
    } catch (_) { return null; }
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  var MemoEngine = {
    MEMO_ADDRESS: MEMO_ADDRESS,
    ARC_CHAIN_ID: ARC_CHAIN_ID,
    ARC_CHAIN_HEX: ARC_CHAIN_HEX,
    MEMO_SELECTOR: MEMO_SELECTOR,
    MEMO_EVENT_TOPIC: MEMO_EVENT_TOPIC,
    MAX_MEMO_BYTES: MAX_MEMO_BYTES,
    maxChars: maxChars,
    validate: validate,
    encodeMemoData: encodeMemoData,
    buildMemoId: buildMemoId,
    encodeMemoCall: encodeMemoCall,
    isSupportedSync: isSupportedSync,
    isSupported: isSupported,
    buildTxSync: buildTxSync,
    buildTx: buildTx,
    wrapEthSendParams: wrapEthSendParams,
    _resetSupportCache: function () { _codeCache = null; },
  };

  root.MemoEngine = MemoEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = MemoEngine;
})(typeof window !== 'undefined' ? window : globalThis);
