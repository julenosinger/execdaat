// ============================================================
// AGENT EXECUTOR v4 — ExecDaat — Meta-Transaction System
// Build: 20260405b
//
// ┌─────────────────────────────────────────────────────────┐
// │           GASLESS META-TRANSACTION ARCHITECTURE          │
// │                                                          │
// │  User → signTypedData(EIP-712) → Backend Relayer        │
// │       → AgentExecutor.execute(request, sig)             │
// │       → NO wallet popup after initial setup             │
// └─────────────────────────────────────────────────────────┘
//
// Flow (gasless path):
//   1. User opens Autonoma tab, Daat Agent is authorized
//   2. User types "send 10 USDC to 0x…"
//   3. Executor checks if AgentExecutor contract is approved as spender
//      a. If NOT approved → show ONE wallet popup for approve (one-time setup)
//      b. If approved     → proceed directly
//   4. Get current nonce from /api/agent/relay/nonce/:wallet
//   5. Build EIP-712 typed data (TransferIntent or BatchIntent)
//   6. Call signer.signTypedData() → ONE wallet popup (just sign, no gas!)
//   7. POST /api/agent/relay with { type, from, token, to, amountRaw, nonce, deadline, signature }
//   8. UI shows: "✍️ Signature received" → "🤖 Executing via agent" → "📤 TX sent" → "✅ Completed"
//   9. Poll /api/agent/relay/:jobId every 2s for status
//  10. No wallet popup after signing — relayer pays all gas
//
// Execution priority:
//   1. AgentExecutor meta-tx path (gasless — relayer pays gas)       ← PRIMARY
//   2. Permit2 SignatureTransfer (user signs per-tx, user pays gas)   ← fallback
//   3. Direct ERC-20 transfer (user signs + pays gas)                ← last resort
//
// Security:
//   • Per-user nonce prevents replay attacks
//   • Deadline (1 hour) prevents stale signatures
//   • Server validates signature before broadcasting
//   • Contract re-validates signature on-chain (double verification)
//   • Replay guard in sessionStorage
//   • Wallet ownership verified before signing
//
// UX Messages (in Autonoma chat):
//   "✍️ Signature received — submitting to agent relayer…"
//   "🤖 Executing via agent — TX sent to network…"
//   "📤 Transaction broadcast — waiting for confirmation…"
//   "✅ Completed! [View on Explorer ↗]"
// ============================================================
'use strict';

(function (global) {

// ─── Constants ────────────────────────────────────────────────────────────────
const AE_VERSION = '20260405b';
const AE_API_BASE        = '/api/agent';
const AE_POLL_MS         = 3000;
const AE_MAX_RETRIES     = 3;
const AE_CONFIRM_THRESH  = 50;
const AE_STORAGE_KEY     = 'ae_executed';
const AE_PERMIT_STORE    = 'arc_permit2_allowances_v1';
const AE_SESSION_KEY     = 'arc-pay-session-v3';
const AE_RELAY_NONCE_KEY = 'ae_relay_nonce_';    // sessionStorage key prefix

const AE_RPC        = 'https://rpc.testnet.arc.network';
const AE_CHAIN_ID   = 5042002;
const AE_CHAIN_HEX  = '0x4cef52';
const AE_EXPLORER   = 'https://testnet.arcscan.app';
const AE_USDC_ADDR  = '0x3600000000000000000000000000000000000000';
const AE_EURC_ADDR  = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

// Permit2 (for fallback path)
const AE_PERMIT2_ADDR = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const AE_MULTICALL3   = '0xcA11bde05977b3631167028862bE2a173976CA11';

// AgentExecutor contract on Arc Testnet
// Update this address after deploying AgentExecutor.sol
// Current: placeholder — set after deployment via Remix/Hardhat
const AE_CONTRACT_ADDR = (function() {
  try {
    // Allow override via localStorage for testing
    return localStorage.getItem('ae_contract_addr') ||
      '0x0000000000000000000000000000000000000000';
  } catch { return '0x0000000000000000000000000000000000000000'; }
})();

// EIP-712 Domain for AgentExecutor (must match deployed contract)
const AE_EIP712_DOMAIN = {
  name:              'AgentExecutor',
  version:           '1',
  chainId:           AE_CHAIN_ID,
  verifyingContract: AE_CONTRACT_ADDR,
};

// EIP-712 Types
const AE_TRANSFER_TYPES = {
  TransferIntent: [
    { name: 'from',     type: 'address' },
    { name: 'token',    type: 'address' },
    { name: 'to',       type: 'address' },
    { name: 'amount',   type: 'uint256' },
    { name: 'nonce',    type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

const AE_BATCH_TYPES = {
  BatchIntent: [
    { name: 'from',       type: 'address'   },
    { name: 'token',      type: 'address'   },
    { name: 'recipients', type: 'address[]' },
    { name: 'amounts',    type: 'uint256[]' },
    { name: 'nonce',      type: 'uint256'   },
    { name: 'deadline',   type: 'uint256'   },
  ],
};

// Permit2 EIP-712 (for fallback)
const AE_PERMIT2_DOMAIN = {
  name:              'Permit2',
  chainId:           AE_CHAIN_ID,
  verifyingContract: AE_PERMIT2_ADDR,
};
const AE_PERMIT_TRANSFER_TYPES = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender',   type: 'address'          },
    { name: 'nonce',     type: 'uint256'           },
    { name: 'deadline',  type: 'uint256'           },
  ],
  TokenPermissions: [
    { name: 'token',  type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
};

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const AE_ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function transferFrom(address,address,uint256) returns (bool)',
];
const AE_PERMIT2_ABI = [
  'function permitTransferFrom(tuple(tuple(address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,tuple(address to,uint256 requestedAmount) transferDetails,address owner,bytes signature)',
  'function nonceBitmap(address,uint256) view returns (uint256)',
];
const AE_MULTICALL3_ABI = [
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)',
];

// ─── AgentExecutor Contract Bytecode (solc 0.8.34 viaIR, optimization 200) ──
// For deploy via deployAgentContract() or /static/deploy-agent.html
const AE_BYTECODE = '0x' + '60a080604052346102615761157d803803809161001c8285610265565b83398101906040818303126102615780516001600160401b038111610261578261004791830161029c565b60208201519092906001600160401b03811161026157610067920161029c565b6402540be4006006555f80546001600160a01b0319163317905560408051906100909082610265565b600d81526c20b3b2b73a22bc32b1baba37b960991b602090910152604080517f6823328dbe0dd69959b19f2f51344f07fdfd98016d31b834b855e7e451a70899916100db9082610265565b600181526020810190603160f81b82525190206040519060208201927f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f8452604083015260608201524660808201523060a082015260a0815261013f60c082610265565b5190206080525f5b82518110156101c3576001906001600160a01b036101658286610312565b51165f52600260205260405f208260ff198254161790557f4b36b2e66f38ed349bec532105790177f1283bcbc094e6cd48565195d3033c436040838060a01b036101af8488610312565b51168151908152846020820152a101610147565b505f5b8151811015610242576001906001600160a01b036101e48285610312565b51165f52600360205260405f208260ff198254161790557fdcb2804db02b95bdd568fd11a31c5577ffdf36538c0f670e92930d9c1e8518ab6040838060a01b0361022e8487610312565b51168151908152846020820152a1016101c6565b604051611242908161033b8239608051818181610c9b0152610fd00152f35b5f80fd5b601f909101601f19168101906001600160401b0382119082101761028857604052565b634e487b7160e01b5f52604160045260245ffd5b81601f82011215610261578051916001600160401b038311610288578260051b91604051936102ce6020850186610265565b845260208085019382010191821161026157602001915b8183106102f25750505090565b82516001600160a01b0381168103610261578152602092830192016102e5565b80518210156103265760209160051b010190565b634e487b7160e01b5f52603260045260245ffdfe608080604052600436101561001c575b50361561001a575f80fd5b005b5f3560e01c908162bf26f414610dc0575080630d2a95ef14610da557806316c38b3c14610d325780631a912f3e14610cf857806320606b7014610cbe5780633644e51514610c845780633816a29214610c0557806339e5d90b14610b8a578063402372f4146109135780634782f779146108b85780634fe47f701461088e5780635300f841146108515780635c975abb1461082d5780635ec4501a146107f55780635f48f393146107d85780637ecebe00146107a05780638da5cb5b14610779578063952ca92c1461074157806398a2e5e2146106f9578063ab6f75cc146102c4578063b7848f321461028a578063e744092e1461024d578063ecd8dc3a146101b55763f2fde38b1461012f575f61000f565b346101b15760203660031901126101b157610148610e07565b5f54906001600160a01b03821633036101a3576001600160a01b03166001600160a01b03199190911681175f556040519081527f4ffd725fc4a22075e9ec71c59edf9c38cdeb588a91b24fc5b61388c5be41282b90602090a1005b6282b42960e81b5f5260045ffd5b5f80fd5b346101b15760403660031901126101b1576101ce610e07565b6101d6610df8565b5f546001600160a01b031633036101a3576001600160a01b0382165f908152600260205260409020805460ff191660ff831515161790557f4b36b2e66f38ed349bec532105790177f1283bcbc094e6cd48565195d3033c43915b604080516001600160a01b039290921682529115156020820152a1005b346101b15760203660031901126101b1576001600160a01b0361026e610e07565b165f526003602052602060ff60405f2054166040519015158152f35b346101b1575f3660031901126101b15760206040517fa6855bd7ff37d4f4e5358b3d8e9f117419db3ea26a0ef57f6ec20b4d20ea5ba88152f35b346101b15760e03660031901126101b1576102dd610e07565b6102e5610e1d565b9060443567ffffffffffffffff81116101b157610306903690600401610e49565b9060643567ffffffffffffffff81116101b157610327903690600401610e49565b90936084359260a4359560c43567ffffffffffffffff81116101b157610351903690600401610e7a565b9490335f52600260205260ff60405f205416156101a35760ff5f5460a01c166106ea578842116106db5760018060a01b038516998a5f5260016020528760405f2054036106cc576001600160a01b0381165f81815260036020526040902054909a9060ff16156106bd5789156106ae57838a0361069f575f975f5b8581106106605750600654600a810290808204600a149015171561064c57891161063d578c9361041861041d938c888f8b908d8f9a61040a8c611100565b6001600160a01b039b610ede565b611177565b160361062e57885f52600160205260405f20610439815461103f565b9055604051636eb1769f60e11b81526001600160a01b03851660048201523060248201526020816044818c5afa80156105df5786915f916105f9575b50106105ea575f5b87811061051757897fcd8854f8b94bf40c619c2b4883f8c072d82f3b33c0fe2c94cf2c2ef40cc6f5d660a08b8b8b8b8b6040516104f6816104e860208201948742918791605493916bffffffffffffffffffffffff199060601b168352601483015260348201520190565b03601f198101835282610ea8565b519020926040519485526020850152604084015260608301526080820152a2005b6105228189866110dc565b356001600160a01b03811681036101b1576020610582918b6105458587896110dc565b6040516323b872dd60e01b81526001600160a01b03808c1660048301529093166024840152356044830152909283919082905f9082906064820190565b03925af19081156105df575f916105b1575b50156105a25760010161047d565b6312171d8360e31b5f5260045ffd5b6105d2915060203d81116105d8575b6105ca8183610ea8565b81019061104d565b8b610594565b503d6105c0565b6040513d5f823e3d90fd5b6313be252b60e01b5f5260045ffd5b9150506020813d602011610626575b8161061560209383610ea8565b810103126101b1578590518b610475565b3d9150610608565b638baa579f60e01b5f5260045ffd5b63070b5a6f60e21b5f5260045ffd5b634e487b7160e01b5f52601160045260245ffd5b9861066c8a87896110dc565b35156106905761067d8a87896110dc565b35810180911161064c57986001016103cc565b631f2a200560e01b5f5260045ffd5b63512509d360e11b5f5260045ffd5b632a67cf2360e01b5f5260045ffd5b63514e24c360e11b5f5260045ffd5b633ab3447f60e11b5f5260045ffd5b63f87d927160e01b5f5260045ffd5b63ab35696f60e01b5f5260045ffd5b346101b15760c03660031901126101b1576020610739610717610e07565b61071f610e1d565b610727610e33565b9160a435926084359260643592611065565b604051908152f35b346101b15760203660031901126101b1576001600160a01b03610762610e07565b165f526004602052602060405f2054604051908152f35b346101b1575f3660031901126101b1575f546040516001600160a01b039091168152602090f35b346101b15760203660031901126101b1576001600160a01b036107c1610e07565b165f526001602052602060405f2054604051908152f35b346101b1575f3660031901126101b1576020600654604051908152f35b346101b15760203660031901126101b1576001600160a01b03610816610e07565b165f526005602052602060405f2054604051908152f35b346101b1575f3660031901126101b157602060ff5f5460a01c166040519015158152f35b346101b15760203660031901126101b1576001600160a01b03610872610e07565b165f526002602052602060ff60405f2054166040519015158152f35b346101b15760203660031901126101b1575f546001600160a01b031633036101a357600435600655005b346101b15760403660031901126101b1576004356001600160a01b038116908190036101b1575f5460243591906001600160a01b031633036101a3575f808093819382821561090a575bf1156105df57005b506108fc610902565b346101b15760e03660031901126101b15761092c610e07565b610934610e1d565b9061093d610e33565b60a435916084359160643560c43567ffffffffffffffff81116101b157610968903690600401610e7a565b96335f52600260205260ff60405f205416156101a35760ff5f5460a01c166106ea578642116106db5760018060a01b03851696875f5260016020528660405f2054036106cc576001600160a01b0382165f8181526003602052604090205490999060ff16156106bd57841561069057600654851161063d578893610418610a07936109f28a611100565b6001600160a01b03958b9089908b908d611065565b160361062e57845f52600160205260405f20610a23815461103f565b9055604051636eb1769f60e11b81526001600160a01b03841660048201523060248201526020816044818a5afa80156105df5782915f91610b55575b50106105ea576040516323b872dd60e01b81526001600160a01b03848116600483015283166024820152604481018290526020816064815f8b5af19081156105df575f91610b36575b50156105a2577f78e38483f3b0eada4705c70fa5cb855244fc294f9fc64f7321ecbf910f7c08b693608093604051610b0e816104e860208201948642918791605493916bffffffffffffffffffffffff199060601b168352601483015260348201520190565b5190206040805198895260208901939093529187015260608601526001600160a01b031693a3005b610b4f915060203d6020116105d8576105ca8183610ea8565b87610aa8565b9150506020813d602011610b82575b81610b7160209383610ea8565b810103126101b15781905188610a5f565b3d9150610b64565b346101b15760c03660031901126101b157610ba3610e07565b610bab610e1d565b60443567ffffffffffffffff81116101b157610bcb903690600401610e49565b9190926064359267ffffffffffffffff84116101b157602094610bf5610739953690600401610e49565b92909160a4359560843595610ede565b346101b15760403660031901126101b157610c1e610e07565b610c26610df8565b5f546001600160a01b031633036101a3576001600160a01b0382165f908152600360205260409020805460ff191660ff831515161790557fdcb2804db02b95bdd568fd11a31c5577ffdf36538c0f670e92930d9c1e8518ab91610230565b346101b1575f3660031901126101b15760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b346101b1575f3660031901126101b15760206040517f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f8152f35b346101b1575f3660031901126101b15760206040517ff1142badb16df46802a945f78040f11cbe2a54512d9db28f5536766b6313d8a38152f35b346101b15760203660031901126101b1576004358015158091036101b1575f546001600160a01b03811633036101a35760ff60a01b191660a082901b60ff60a01b16175f556040519081527f0e2fb031ee032dc02d8011dc50b816eb450cf856abd8261680dac74f72165bd290602090a1005b346101b1575f3660031901126101b157602060405160058152f35b346101b1575f3660031901126101b157807f3f6ee851781dc69de2dab37bfb1cf38d1b0df22162ffba71fef477086f239b2360209252f35b6024359081151582036101b157565b600435906001600160a01b03821682036101b157565b602435906001600160a01b03821682036101b157565b604435906001600160a01b03821682036101b157565b9181601f840112156101b15782359167ffffffffffffffff83116101b1576020808501948460051b0101116101b157565b9181601f840112156101b15782359167ffffffffffffffff83116101b157602083818601950101116101b157565b90601f8019910116810190811067ffffffffffffffff821117610eca57604052565b634e487b7160e01b5f52604160045260245ffd5b9694929593919095604051908160208101938490925f905b80821061100f575050610f12925003601f198101835282610ea8565b519020604051909260208201926001600160fb1b0382116101b15782602091610f4d9360051b8091873781010301601f198101835282610ea8565b519020906040519460208601967fa6855bd7ff37d4f4e5358b3d8e9f117419db3ea26a0ef57f6ec20b4d20ea5ba8885260018060a01b0316604087015260018060a01b03166060860152608085015260a084015260c083015260e082015260e08152610fbb61010082610ea8565b51902060405161190160f01b602082019081527f00000000000000000000000000000000000000000000000000000000000000006022830152604282019290925261100981606281016104e8565b51902090565b9092509083356001600160a01b03811691908290036101b157602081600193829352019401920184929391610ef6565b5f19811461064c5760010190565b908160209103126101b1575180151581036101b15790565b94929093916040519460208601967f3f6ee851781dc69de2dab37bfb1cf38d1b0df22162ffba71fef477086f239b23885260018060a01b0316604087015260018060a01b0316606086015260018060a01b0316608085015260a084015260c083015260e082015260e08152610fbb61010082610ea8565b91908110156110ec5760051b0190565b634e487b7160e01b5f52603260045260245ffd5b6001600160a01b03165f81815260046020526040902054430361115957805f52600560205260405f20611133815461103f565b90555f526005602052600560405f20541161114a57565b63a74c1c5f60e01b5f5260045ffd5b805f5260046020524360405f20555f526005602052600160405f2055565b916041036111d65760408101355f1a601b81106111c4575b602092835f9360ff6080946040519485521682840152803560408401520135606082015282805260015afa156105df575f5190565b601b019060ff821161064c579061118f565b60405162461bcd60e51b815260206004820152600e60248201526d084c2c840e6d2ce40d8cadccee8d60931b6044820152606490fdfea264697066735822122021d307e2d14e1bc751054ad114ba9d6f4a77405a97002698e658c5112fd301c564736f6c63430008220033';

// ─── State ────────────────────────────────────────────────────────────────────
let _aeRunning   = false;
let _aePollTimer = null;
let _aeLastPoll  = null;

// ─── Logging ──────────────────────────────────────────────────────────────────
function _log(...a)  { console.log('%c[AGENT-EXEC v4]', 'color:#a78bfa;font-weight:bold', ...a); }
function _warn(...a) { console.warn('[AGENT-EXEC v4]', ...a); }
function _err(...a)  { console.error('[AGENT-EXEC v4]', ...a); }

// ─── Toast ────────────────────────────────────────────────────────────────────
function _toast(msg, type = 'info') {
  if (typeof showToast === 'function') showToast(msg, type);
}

// ─── Chat notification ────────────────────────────────────────────────────────
function _notify(intentId, status, data = {}) {
  window.dispatchEvent(new CustomEvent('agentExecutor:update', {
    detail: { intentId, status, ...data }
  }));
}

// ─── Meta-tx notification (for Autonoma chat specific messages) ───────────────
function _notifyMetaTx(msg, type = 'info') {
  window.dispatchEvent(new CustomEvent('agentMetaTx:message', {
    detail: { msg, type }
  }));
}

// ─── Session ──────────────────────────────────────────────────────────────────
function _getSession() {
  try {
    const raw = localStorage.getItem(AE_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.authorized || !s?.wallet || !s?.expiry) return null;
    if (Date.now() > s.expiry) return null;
    return s;
  } catch { return null; }
}

// ─── Permit2 Spending Permissions ─────────────────────────────────────────────
function _getActivePermits(wallet) {
  try {
    const raw = localStorage.getItem(AE_PERMIT_STORE);
    if (!raw) return [];
    const now = Date.now();
    return JSON.parse(raw).filter(p =>
      p.wallet && p.wallet.toLowerCase() === wallet.toLowerCase() &&
      p.expiry > now && (p.amount - (p.amountUsed || 0)) > 0
    );
  } catch { return []; }
}

function _findPermit(wallet, token, amount) {
  const permits = _getActivePermits(wallet);
  const tokenUpper = (token || 'USDC').toUpperCase();
  return permits.find(p => {
    const tokenMatch = p.token.toUpperCase() === tokenUpper;
    const scopeOk   = p.scope === 'all' || p.scope === 'payments';
    const remaining = (p.amount || 0) - (p.amountUsed || 0);
    const amountOk  = remaining >= Number(amount);
    return tokenMatch && scopeOk && amountOk;
  }) || null;
}

function _recordPermitUsage(permitId, amountUsed) {
  try {
    const raw = localStorage.getItem(AE_PERMIT_STORE);
    if (!raw) return;
    const all = JSON.parse(raw);
    const idx = all.findIndex(p => p.id === permitId);
    if (idx >= 0) {
      all[idx].amountUsed = (all[idx].amountUsed || 0) + Number(amountUsed);
      localStorage.setItem(AE_PERMIT_STORE, JSON.stringify(all));
    }
  } catch (e) { _warn('permit usage record failed:', e.message); }
}

// ─── Replay guard ─────────────────────────────────────────────────────────────
function _markExecuted(id) {
  try {
    const ids = JSON.parse(sessionStorage.getItem(AE_STORAGE_KEY) || '[]');
    if (!ids.includes(id)) { ids.push(id); sessionStorage.setItem(AE_STORAGE_KEY, JSON.stringify(ids)); }
  } catch {}
}
function _wasExecuted(id) {
  try { return JSON.parse(sessionStorage.getItem(AE_STORAGE_KEY) || '[]').includes(id); } catch { return false; }
}
function _unmarkExecuted(id) {
  try {
    const ids = JSON.parse(sessionStorage.getItem(AE_STORAGE_KEY) || '[]').filter(x => x !== id);
    sessionStorage.setItem(AE_STORAGE_KEY, JSON.stringify(ids));
  } catch {}
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function _post(path, body) {
  const r = await fetch(AE_API_BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}
async function _get(path) {
  const r = await fetch(AE_API_BASE + path);
  return r.json();
}
async function _patch(id, body) {
  const r = await fetch(`${AE_API_BASE}/intents/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}

// ─── Network helpers ──────────────────────────────────────────────────────────
async function _ensureNetwork() {
  const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== AE_CHAIN_ID) {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: AE_CHAIN_HEX }],
    });
    await new Promise(r => setTimeout(r, 800));
  }
}

// ─── AgentExecutor contract availability check ────────────────────────────────
async function _agentContractAvailable() {
  try {
    if (AE_CONTRACT_ADDR === '0x0000000000000000000000000000000000000000') return false;
    const r = await fetch(AE_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', method:'eth_getCode', params:[AE_CONTRACT_ADDR,'latest'], id:1 }),
    });
    const d = await r.json();
    return d.result && d.result.length > 4;
  } catch { return false; }
}

// ─── Fetch relayer address from relay status endpoint ────────────────────────
let _cachedRelayerAddr = null;
async function _getRelayerAddress() {
  if (_cachedRelayerAddr) return _cachedRelayerAddr;
  try {
    const r = await fetch(`${AE_API_BASE}/relay/status`);
    const d = await r.json();
    if (d.success && d.relayerAddress) {
      _cachedRelayerAddr = d.relayerAddress;
      _log('Relayer address fetched:', _cachedRelayerAddr);
      return _cachedRelayerAddr;
    }
  } catch (e) { _warn('Could not fetch relayer address:', e); }
  return null;
}

// ─── Check if relayer has enough allowance OR check direct-relay feasibility ──
async function _relayerDirectAvailable(signerAddr, tokenAddr, amountRaw) {
  const relayerAddr = await _getRelayerAddress();
  if (!relayerAddr) return false;
  try {
    // Check user's allowance for relayer
    const encAllowance = '0xdd62ed3e' +
      signerAddr.replace('0x','').toLowerCase().padStart(64,'0') +
      relayerAddr.replace('0x','').toLowerCase().padStart(64,'0');
    const r = await fetch(AE_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', method:'eth_call',
        params:[{ to: tokenAddr, data: encAllowance }, 'latest'], id:1 }),
    });
    const d = await r.json();
    const allowance = d.result && d.result !== '0x' ? BigInt(d.result) : 0n;
    return allowance >= amountRaw;
  } catch { return false; }
}

// ─── Get on-chain nonce from relay API ────────────────────────────────────────
async function _getRelayNonce(wallet) {
  try {
    const r = await fetch(`${AE_API_BASE}/relay/nonce/${wallet}`);
    const d = await r.json();
    if (d.success) return BigInt(d.nonce);
    return 0n;
  } catch {
    // Fall back to 0 if relay endpoint not available
    return 0n;
  }
}

// ─── Check & ensure AgentExecutor approval (ONE-TIME setup) ──────────────────
// This is the only wallet popup in the gasless flow (one-time, per token)
// In Mode B (no contract): approves the RELAYER address instead of AgentExecutor
async function _ensureAgentContractApproval(signer, signerAddr, tokenAddr, amountRaw, ethers, intentId) {
  const token = new ethers.Contract(tokenAddr, AE_ERC20_ABI, signer);
  const contractDeployed = AE_CONTRACT_ADDR !== '0x0000000000000000000000000000000000000000';

  // Determine the spender to approve
  let spenderAddr = AE_CONTRACT_ADDR;
  let spenderLabel = 'AgentExecutor contract';

  if (!contractDeployed) {
    // Mode B: approve the relayer address directly
    const relayerAddr = await _getRelayerAddress();
    if (!relayerAddr) {
      _warn('No relayer address available — RELAYER_PRIVATE_KEY may not be set');
      return; // proceed anyway, relay will fail with descriptive error
    }
    spenderAddr = relayerAddr;
    spenderLabel = `Relayer (${relayerAddr.slice(0,10)}…)`;
    _log('Mode B: approving relayer as spender:', relayerAddr);
  }

  const allowance = BigInt(await token.allowance(signerAddr, spenderAddr));
  if (allowance >= amountRaw) return; // Already approved ✓

  _log(`${spenderLabel} not approved — requesting one-time setup approval…`);
  if (intentId) {
    await _patch(intentId, { status: 'signing' });
    _notify(intentId, 'signing', { step: 'approve_agent_contract' });
  }
  _toast(`⚙️ One-time setup: Approve ${spenderLabel} — wallet popup (this is the last popup!)…`, 'info');
  _notifyMetaTx('⚙️ **One-time setup required** — approving AgentExecutor as spender…\n\n*This is the only wallet popup you will see. All future transactions will be gasless.*', 'info');

  const maxUint256 = 2n ** 256n - 1n;
  const approveTx  = await token.approve(spenderAddr, maxUint256);
  const approveRcpt = await approveTx.wait(1);
  if (approveRcpt.status !== 1) throw new Error('Approval reverted');
  _log(`${spenderLabel} approved (max allowance) — all future transfers will be gasless!`);
  _toast(`✅ ${spenderLabel} approved! Future transfers will be gasless.`, 'success');
  _notifyMetaTx(`✅ **${spenderLabel} approved!** All future transfers will be gasless — no more wallet popups.`, 'success');
}

// ─── GASLESS META-TX: Sign + Submit intent ────────────────────────────────────
// PRIMARY execution path.
//
// POPUP FLOW:
//   Popup 1 (one-time, per token): token.approve(AgentExecutor, MaxUint256)
//   Popup 2 (per intent): signer.signTypedData() — sign only, NO gas
//   After that: relayer automatically broadcasts — NO MORE POPUPS
//
async function _executeViaMetaTx(signer, signerAddr, intent, tokenAddr, amountRaw, ethers) {
  // Mode A: AgentExecutor deployed — use EIP-712 + AgentExecutor.execute()
  // Mode B: No contract yet — relay uses transferFrom(user→to) with user's allowance
  // Both modes use the same relay API — the backend decides which path to use.
  const contractDeployed = AE_CONTRACT_ADDR !== '0x0000000000000000000000000000000000000000';

  if (!contractDeployed) {
    _log('Mode B active — AgentExecutor not deployed, using direct ERC-20 relay');
    _notifyMetaTx(
      '🔄 **Direct relay mode** — AgentExecutor not deployed yet.\n\n' +
      'Your transfer will be executed by the relayer directly.\n' +
      '*One-time approval popup to authorize the relayer as spender.*',
      'info'
    );
  }

  await _ensureNetwork();

  // ── POPUP 1: One-time approve (only if allowance < amountRaw) ────────────────
  // Mode A: approves AgentExecutor contract
  // Mode B: approves relayer address
  await _ensureAgentContractApproval(signer, signerAddr, tokenAddr, amountRaw, ethers, intent.id);

  // ── Fetch nonce from relay API (no popup) ────────────────────────────────────
  const nonce    = await _getRelayNonce(signerAddr);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

  // ── Build EIP-712 typed data ─────────────────────────────────────────────────
  let typedData, relayBody;

  if (intent.type === 'transfer') {
    const domain  = { ...AE_EIP712_DOMAIN };
    const message = {
      from:     signerAddr,
      token:    tokenAddr,
      to:       intent.to,
      amount:   amountRaw,
      nonce:    nonce,
      deadline: deadline,
    };
    typedData = { domain, types: AE_TRANSFER_TYPES, message };
    relayBody = {
      type:      'transfer',
      from:      signerAddr,
      token:     tokenAddr,
      to:        intent.to,
      amount:    intent.amount,
      amountRaw: amountRaw.toString(),
      nonce:     nonce.toString(),
      deadline:  deadline.toString(),
      intentId:  intent.id,
    };

  } else if (intent.type === 'multisend') {
    if (!intent.receivers || intent.receivers.length === 0) throw new Error('No receivers for multisend');
    const recipients = intent.receivers.map(r => r.address);
    const amounts    = intent.receivers.map(r => BigInt(Math.round(Number(r.amount) * 1_000_000)));
    const domain  = { ...AE_EIP712_DOMAIN };
    const message = {
      from:       signerAddr,
      token:      tokenAddr,
      recipients: recipients,
      amounts:    amounts,
      nonce:      nonce,
      deadline:   deadline,
    };
    typedData = { domain, types: AE_BATCH_TYPES, message };
    relayBody = {
      type:       'batch',
      from:       signerAddr,
      token:      tokenAddr,
      recipients: intent.receivers.map((r, i) => ({
        address:   r.address,
        amount:    r.amount,
        amountRaw: amounts[i].toString(),
      })),
      nonce:      nonce.toString(),
      deadline:   deadline.toString(),
      intentId:   intent.id,
    };
  } else {
    throw new Error(`Meta-tx not supported for type "${intent.type}"`);
  }

  // ── POPUP 2: Sign EIP-712 typed data (sign only — NO gas!) ───────────────────
  await _patch(intent.id, { status: 'signing' });
  _notify(intent.id, 'signing', { intent, step: 'sign_meta_tx' });
  _toast('✍️ Sign intent (no gas) — wallet popup…', 'info');
  _notifyMetaTx(
    '✍️ **Sign intent** — confirm the signature in your wallet.\n\n' +
    '*No gas required — just a cryptographic signature.*',
    'info'
  );

  const signature = await signer.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message
  );

  _log('EIP-712 signature obtained:', signature.slice(0, 20) + '…');
  _notifyMetaTx(
    '✅ **Signature received** — submitting to agent relayer…\n\n' +
    '*No more wallet popups — relayer will broadcast automatically.*',
    'success'
  );
  _toast('✍️ Signed! Relayer is executing…', 'info');

  // ── Submit to relay API (no popup — backend signs + broadcasts) ──────────────
  const resp = await fetch(`${AE_API_BASE}/relay`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ...relayBody, signature }),
  });
  const relayResult = await resp.json();

  if (!relayResult.success) {
    throw new Error(relayResult.error || 'Relay submission failed');
  }

  const jobId = relayResult.jobId;
  _log('Relay job created:', jobId);

  // Warn if relay is not fully configured
  if (!relayResult.relayerConfigured) {
    _notifyMetaTx(
      '⚠️ **Relayer not configured** — intent queued but RELAYER_PRIVATE_KEY not set.\n\n' +
      'Ask the dApp admin to run: `wrangler secret put RELAYER_PRIVATE_KEY`',
      'error'
    );
  } else if (!relayResult.agentContractDeployed) {
    // Mode B is active — this is NORMAL operation, not an error
    _notifyMetaTx(
      `🤖 **Relayer executing** (Mode B — direct relay) — job \`${jobId}\`\n\n` +
      '*Relayer is broadcasting your transaction via transferFrom. No more wallet popups.*',
      'agents'
    );
  } else {
    _notifyMetaTx(
      `🤖 **Relayer executing** — job \`${jobId}\`\n\n` +
      '*Relayer is broadcasting your transaction. You pay no gas.*',
      'agents'
    );
  }

  _toast('🤖 Agent executing — no wallet popup!', 'info');

  await _patch(intent.id, { status: 'processing' });
  _notify(intent.id, 'processing', { intent, relayJobId: jobId });

  // ── Poll relay job status (no popup) ─────────────────────────────────────────
  await _pollRelayJob(intent, jobId);
}

// ─── Poll relay job until completion ─────────────────────────────────────────
async function _pollRelayJob(intent, jobId) {
  const MAX_POLLS = 60; // 2 minutes at 2s interval
  let polls = 0;

  while (polls < MAX_POLLS) {
    await new Promise(r => setTimeout(r, 2000));
    polls++;

    try {
      const r = await fetch(`${AE_API_BASE}/relay/${jobId}`);
      const d = await r.json();
      if (!d.success) continue;

      const job = d.job;
      _log(`Relay poll ${polls}: status=${job.status}`);

      if (job.status === 'broadcast') {
        await _patch(intent.id, { status: 'broadcast', txHash: job.txHash });
        _notify(intent.id, 'broadcast', { intent, txHash: job.txHash });
        _notifyMetaTx(
          `📤 **Transaction broadcast!** Waiting for block confirmation…\n\n` +
          `[Track TX ↗](${AE_EXPLORER}/tx/${job.txHash})`,
          'info'
        );
        _toast(`📤 TX sent (gasless!): ${job.txHash?.slice(0,14)}…`, 'info');
        continue;
      }

      if (job.status === 'completed') {
        await _patch(intent.id, {
          status: 'completed', txHash: job.txHash, blockNumber: job.blockNumber
        });
        _notify(intent.id, 'completed', {
          intent, txHash: job.txHash, blockNumber: job.blockNumber
        });
        _notifyMetaTx(
          `✅ **Completed!** Transaction confirmed on-chain.\n\n` +
          `[View on Explorer ↗](${AE_EXPLORER}/tx/${job.txHash})\n` +
          `Block #${job.blockNumber}`,
          'success'
        );
        _toast(`✅ Gasless transfer complete! Block #${job.blockNumber}`, 'success');
        return;
      }

      if (job.status === 'failed') {
        const errMsg = job.error || 'Relay execution failed';
        await _patch(intent.id, { status: 'failed', error: errMsg });
        _notify(intent.id, 'failed', { intent, error: errMsg });
        _notifyMetaTx(`❌ **Agent failed:** ${errMsg}`, 'error');
        throw new Error(errMsg);
      }

      if (job.status === 'rejected') {
        const errMsg = job.error || 'Relay rejected the intent';
        await _patch(intent.id, { status: 'failed', error: errMsg });
        _notify(intent.id, 'failed', { intent, error: errMsg });
        _notifyMetaTx(`❌ **Relay rejected:** ${errMsg}`, 'error');
        throw new Error(errMsg);
      }

    } catch (e) {
      if (e.message.includes('failed') || e.message.includes('rejected')) throw e;
      _warn('Relay poll error:', e.message);
    }
  }

  // Timeout — leave as broadcast (will be confirmed eventually)
  _notifyMetaTx('⏳ **Transaction broadcast** — awaiting confirmation (may take a few minutes)…', 'info');
  _warn('Relay poll timeout — TX likely pending:', jobId);
}

// ─── Create Intent ────────────────────────────────────────────────────────────
async function aeCreateIntent(params) {
  const session = _getSession();
  const wallet  = window.walletState?.address;
  if (!wallet)  throw new Error('Wallet not connected');
  if (!session) throw new Error('Daat Agent not authorized. Click "Authorize Daat Agent" first.');

  if (params.type === 'transfer') {
    if (!params.amount || Number(params.amount) <= 0) throw new Error('Amount must be > 0');
    if (!params.to || !/^0x[0-9a-fA-F]{40}$/.test(params.to)) throw new Error('Invalid recipient address');
  }

  const payload = {
    type:        params.type || 'transfer',
    wallet,
    token:       (params.token || 'USDC').toUpperCase(),
    amount:      params.amount != null ? String(params.amount) : undefined,
    to:          params.to,
    receivers:   params.receivers,
    memo:        params.memo,
    sessionHash: session.sessionHash,
    signature:   session.signature,
  };

  const result = await _post('/intents', payload);
  if (!result.success) throw new Error(result.error || 'Failed to create intent');

  _log('Intent created:', result.intent.id, payload.type, payload.amount, payload.token);
  _notify(result.intent.id, 'pending', { intent: result.intent });

  if (!_aePollTimer) aeStartPolling();
  return result.intent;
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function aeStartPolling() {
  if (_aePollTimer) return;
  _aeRunning = true;
  _aePollTimer = setInterval(_poll, AE_POLL_MS);
  setTimeout(_poll, 100);
}
function aeStopPolling() {
  if (_aePollTimer) { clearInterval(_aePollTimer); _aePollTimer = null; }
  _aeRunning = false;
}

async function _poll() {
  const wallet  = window.walletState?.address;
  const session = _getSession();
  if (!wallet || !session) {
    if (_aePollTimer) { aeStopPolling(); }
    return;
  }
  try {
    const since = _aeLastPoll ? `&since=${encodeURIComponent(_aeLastPoll)}` : '';
    const data  = await _get(`/poll?wallet=${encodeURIComponent(wallet)}${since}`);
    if (!data.success) return;
    _aeLastPoll = data.timestamp;
    if (!data.intents || data.intents.length === 0) return;
    for (const intent of data.intents) await _handleIntent(intent);
  } catch (e) {
    _warn('Poll error:', e.message);
  }
}

async function _handleIntent(intent) {
  _notify(intent.id, intent.status, { intent });
  if (intent.status !== 'pending') return;
  if (_wasExecuted(intent.id)) return;
  const wallet = window.walletState?.address;
  if (!wallet || wallet.toLowerCase() !== intent.wallet.toLowerCase()) return;
  _markExecuted(intent.id);
  try {
    await _executeIntent(intent);
  } catch (e) {
    _err('executeIntent error:', e);
  }
}

// ─── Execute Intent (dispatcher) ─────────────────────────────────────────────
async function _executeIntent(intent) {
  _log('Executing:', intent.id, intent.type, intent.amount, intent.token);
  await _patch(intent.id, { status: 'processing' });
  _notify(intent.id, 'processing', { intent });
  _toast(`🤖 Agent: processing ${intent.type}…`, 'info');

  // Confirmation for high-value transfers
  if (intent.type === 'transfer' && Number(intent.amount) >= AE_CONFIRM_THRESH) {
    const ok = confirm(`Agent wants to send ${intent.amount} ${intent.token} to:\n${intent.to}\n\nConfirm?`);
    if (!ok) {
      await _patch(intent.id, { status: 'cancelled' });
      _notify(intent.id, 'cancelled', { intent });
      return;
    }
  }

  try {
    if (intent.type === 'transfer' || intent.type === 'multisend') {
      await _executeTransfer(intent);
    } else {
      await _patch(intent.id, { status: 'failed', error: `Type "${intent.type}" requires manual execution.` });
      _notify(intent.id, 'failed', { intent, error: `Manual execution required for: ${intent.type}` });
    }
  } catch (err) {
    const msg      = err?.message || String(err);
    const retries  = (intent.retries || 0) + 1;
    const isCancel = msg.includes('ACTION_REJECTED') || msg.includes('4001') || msg.includes('rejected');

    if (!isCancel && retries < AE_MAX_RETRIES) {
      _unmarkExecuted(intent.id);
      await _patch(intent.id, { status: 'pending', retries, error: msg });
      _notify(intent.id, 'pending', { intent, retry: retries });
    } else {
      const finalMsg = isCancel ? 'Rejected by user in wallet.' : msg;
      await _patch(intent.id, { status: 'failed', error: finalMsg });
      _notify(intent.id, 'failed', { intent, error: finalMsg });
      _toast(`❌ Agent failed: ${finalMsg.slice(0, 80)}`, 'error');
    }
  }
}

// ─── Execute: Transfer (with execution priority) ──────────────────────────────
//
// Priority:
//   1. AgentExecutor meta-tx (gasless)     ← if contract deployed + approved
//   2. Permit2 SignatureTransfer (user pays gas, but no approve popup)
//   3. Direct ERC-20 transfer (user pays gas + signs tx)
//
async function _executeTransfer(intent) {
  const ethers = window.ethers;
  if (!ethers) throw new Error('ethers.js not loaded');

  const amount = Number(intent.amount);
  if (!amount || amount <= 0) throw new Error('Amount must be > 0');

  const provider   = new ethers.BrowserProvider(window.ethereum, 'any');
  const signer     = await provider.getSigner();
  const signerAddr = await signer.getAddress();

  if (signerAddr.toLowerCase() !== intent.wallet.toLowerCase()) {
    throw new Error('Connected wallet does not match intent wallet.');
  }

  await _ensureNetwork();

  const tokenAddr = intent.token === 'EURC' ? AE_EURC_ADDR : AE_USDC_ADDR;
  const token     = new ethers.Contract(tokenAddr, AE_ERC20_ABI, signer);
  const amountRaw = BigInt(Math.round(amount * 1_000_000));
  if (amountRaw === 0n) throw new Error('Computed amount is zero');

  const balance = BigInt(await token.balanceOf(signerAddr));
  if (balance < amountRaw) {
    throw new Error(`Insufficient ${intent.token}: have ${Number(balance)/1e6} need ${amount}`);
  }

  // ── PATH 1A: AgentExecutor Meta-Tx (GASLESS — contract deployed) ──────────
  const contractReady = await _agentContractAvailable();
  if (contractReady) {
    _log('Using AgentExecutor meta-tx path (gasless, contract deployed)');
    _notifyMetaTx('🤖 **Gasless execution** — using Agent Executor meta-transaction system…', 'agents');
    try {
      await _executeViaMetaTx(signer, signerAddr, intent, tokenAddr, amountRaw, ethers);
      return;
    } catch (metaTxErr) {
      const msg = metaTxErr?.message || String(metaTxErr);
      _warn('Meta-tx failed, trying Permit2 fallback:', msg);
      _notifyMetaTx(`⚠️ Meta-tx failed: ${msg}\n\nFalling back to Permit2…`, 'error');
    }
  }

  // ── PATH 1B: Direct Relay Mode B (no AgentExecutor contract needed) ────────
  // The relay uses transferFrom(user→to) with the user's allowance for the relayer.
  if (!contractReady) {
    // Try up to 2 times to get the relayer address (handles cold-start cache miss)
    let relayerAddr = await _getRelayerAddress();
    if (!relayerAddr) {
      _log('Relayer address not cached yet — retrying fetch…');
      await new Promise(r => setTimeout(r, 800));
      relayerAddr = await _getRelayerAddress();
    }
    if (relayerAddr) {
      _log('Using Mode B direct relay path (no AgentExecutor contract)');
      _notifyMetaTx(
        `🔄 **Direct relay mode active** — relayer \`${relayerAddr.slice(0,10)}…\` will execute via \`transferFrom\`.\n\n` +
        '*One-time approval required if you haven\'t approved the relayer yet.*',
        'info'
      );
      try {
        await _executeViaMetaTx(signer, signerAddr, intent, tokenAddr, amountRaw, ethers);
        return;
      } catch (relayErr) {
        const msg = relayErr?.message || String(relayErr);
        _warn('Direct relay Mode B failed:', msg);
        // If user rejected the wallet popup, don't fall through to PATH 3 silently
        if (msg.includes('ACTION_REJECTED') || msg.includes('4001') || msg.includes('rejected') || msg.includes('denied')) {
          _notifyMetaTx(`🚫 **Wallet signature rejected.** Transaction cancelled.`, 'error');
          await _patch(intent.id, { status: 'cancelled', error: 'User rejected wallet signature' });
          _notify(intent.id, 'cancelled', { intent, error: 'User rejected wallet signature' });
          return;
        }
        _notifyMetaTx(`⚠️ Relay failed: ${msg}\n\nFalling back to Permit2…`, 'error');
      }
    } else {
      _warn('Relayer address unavailable — RELAYER_PRIVATE_KEY may not be set on server');
      _notifyMetaTx(
        '⚠️ **Relay not reachable** — could not fetch relayer address from server.\n\n' +
        'Falling back to Permit2 signing…',
        'error'
      );
    }
  }

  // ── PATH 2: Permit2 SignatureTransfer ──────────────────────────────────────
  const spendingPermit = _findPermit(signerAddr, intent.token, amount);
  const permit2Available = await _permit2Available();

  if (spendingPermit && permit2Available) {
    _log('Using Permit2 path (spending permit found)');
    try {
      await _executeViaPermit2Single(signer, signerAddr, intent, tokenAddr, amountRaw, ethers, spendingPermit);
      return;
    } catch (p2err) {
      _warn('Permit2 path failed:', p2err.message);
    }
  }

  // ── PATH 3: All gasless paths failed ──────────────────────────────────────
  _log('All relay paths failed — no available execution route');

  // Try to get relayer address for a helpful message (use cache or re-fetch)
  const relayerForMsg = _cachedRelayerAddr || await _getRelayerAddress().catch(() => null);

  let failMsg;
  if (relayerForMsg) {
    failMsg =
      `⚠️ **Execution failed** — all relay paths unavailable.\n\n` +
      `**Relayer:** \`${relayerForMsg.slice(0,10)}…\`\n\n` +
      `**Most likely cause:** The relayer does not have enough token balance, ` +
      `OR your wallet has not approved the relayer as a token spender.\n\n` +
      `**Fix options:**\n` +
      `1. Type \`allow agent to spend 100 USDC\` to create a Permit2 spending permission\n` +
      `2. Or contact the dApp admin to fund the relayer wallet`;
  } else {
    // Fetch status directly from API for a definitive answer
    let statusData = null;
    try {
      const sr = await fetch(`${AE_API_BASE}/relay/status`);
      statusData = await sr.json();
    } catch (_) {}

    if (statusData?.relayerConfigured) {
      failMsg =
        `⚠️ **Relay execution failed** — relayer is configured but execution failed.\n\n` +
        `**Relayer:** \`${statusData.relayerAddress?.slice(0,10) || 'unknown'}…\`\n\n` +
        `Try: type \`allow agent to spend 100 USDC\` to create a Permit2, then retry.`;
    } else {
      failMsg =
        `⚠️ **Relay not configured** — RELAYER_PRIVATE_KEY not set on server.\n\n` +
        `Contact the dApp admin to configure the relayer.\n\n` +
        `*Alternative: type \`allow agent to spend 100 USDC\` to use Permit2 signing.*`;
    }
  }

  _notifyMetaTx(failMsg, 'error');

  await _patch(intent.id, {
    status: 'failed',
    error:  'All relay execution paths unavailable. Check relayer configuration.',
  });
  _notify(intent.id, 'failed', {
    intent,
    error: 'Relay execution failed. Try creating a Permit2 allowance or contact admin.',
  });
  _toast('⚠️ Relay failed. See chat for details.', 'error');
}

// ─── Permit2 availability ─────────────────────────────────────────────────────
async function _permit2Available() {
  try {
    const r = await fetch(AE_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', method:'eth_getCode', params:[AE_PERMIT2_ADDR,'latest'], id:1 }),
    });
    const d = await r.json();
    return d.result && d.result.length > 4;
  } catch { return false; }
}

// ─── Permit2 Single Transfer (fallback path) ──────────────────────────────────
async function _executeViaPermit2Single(signer, signerAddr, intent, tokenAddr, amountRaw, ethers, spendingPermit) {
  const token   = new ethers.Contract(tokenAddr, AE_ERC20_ABI, signer);
  const permit2 = new ethers.Contract(AE_PERMIT2_ADDR, AE_PERMIT2_ABI, signer);

  const currentAllowance = BigInt(await token.allowance(signerAddr, AE_PERMIT2_ADDR));
  if (currentAllowance < amountRaw) {
    await _patch(intent.id, { status: 'signing' });
    _notify(intent.id, 'signing', { intent, step: 'approve_permit2' });
    _toast('⏳ Approve Permit2 contract — wallet popup…', 'info');
    const approveTx  = await token.approve(AE_PERMIT2_ADDR, 2n ** 256n - 1n);
    const approveRcpt = await approveTx.wait(1);
    if (approveRcpt.status !== 1) throw new Error('Permit2 approval reverted');
  }

  function _randomNonce() {
    const arr = new Uint8Array(31);
    crypto.getRandomValues(arr);
    return BigInt('0x' + Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join(''));
  }

  const nonce    = _randomNonce();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const permitMessage = {
    permitted: { token: tokenAddr, amount: amountRaw },
    spender:   AE_PERMIT2_ADDR,
    nonce:     nonce,
    deadline:  deadline,
  };

  await _patch(intent.id, { status: 'signing' });
  _notify(intent.id, 'signing', { intent, step: 'sign_permit2' });
  _toast('⏳ Sign Permit2 transfer — wallet popup…', 'info');

  const signature = await signer.signTypedData(AE_PERMIT2_DOMAIN, AE_PERMIT_TRANSFER_TYPES, permitMessage);
  const transferDetails = { to: intent.to, requestedAmount: amountRaw };

  let gasLimit = 150_000n;
  try {
    const est = await permit2['permitTransferFrom(tuple(tuple(address,uint256),uint256,uint256),tuple(address,uint256),address,bytes)']
      .estimateGas([{ token: tokenAddr, amount: amountRaw }, nonce, deadline], transferDetails, signerAddr, signature);
    gasLimit = BigInt(Math.ceil(Number(est) * 1.3));
  } catch (_) {}

  const tx = await permit2['permitTransferFrom(tuple(tuple(address,uint256),uint256,uint256),tuple(address,uint256),address,bytes)'](
    [{ token: tokenAddr, amount: amountRaw }, nonce, deadline],
    transferDetails, signerAddr, signature, { gasLimit }
  );

  await _patch(intent.id, { status: 'broadcast', txHash: tx.hash });
  _notify(intent.id, 'broadcast', { intent, txHash: tx.hash });
  _toast(`📤 TX sent (Permit2): ${tx.hash.slice(0,14)}…`, 'info');

  const receipt = await tx.wait(1);
  if (receipt.status !== 1) throw new Error(`Permit2 tx reverted at block #${receipt.blockNumber}`);

  if (spendingPermit) _recordPermitUsage(spendingPermit.id, intent.amount);

  await _patch(intent.id, { status: 'completed', txHash: tx.hash, blockNumber: receipt.blockNumber });
  _notify(intent.id, 'completed', { intent, txHash: tx.hash, blockNumber: receipt.blockNumber });
  _toast(`✅ Permit2 transfer done! Block #${receipt.blockNumber}`, 'success');
}

// ─── Execute Multisend ────────────────────────────────────────────────────────
// (Handled by _executeTransfer which delegates to _executeViaMetaTx for batch)

// ─── Status Badge ─────────────────────────────────────────────────────────────
const AE_STATUS_CFG = {
  pending:    { icon: 'fa-clock',         color: 'text-yellow-400', bg: 'bg-yellow-900/20', label: 'Queued'     },
  processing: { icon: 'fa-cog fa-spin',   color: 'text-blue-400',   bg: 'bg-blue-900/20',   label: 'Executing…' },
  signing:    { icon: 'fa-pen-nib',       color: 'text-purple-400', bg: 'bg-purple-900/20', label: 'Signing…'   },
  broadcast:  { icon: 'fa-paper-plane',   color: 'text-cyan-400',   bg: 'bg-cyan-900/20',   label: 'Sent'       },
  completed:  { icon: 'fa-check-circle',  color: 'text-green-400',  bg: 'bg-green-900/20',  label: 'Completed'  },
  failed:     { icon: 'fa-times-circle',  color: 'text-red-400',    bg: 'bg-red-900/20',    label: 'Failed'     },
  cancelled:  { icon: 'fa-ban',           color: 'text-gray-400',   bg: 'bg-gray-800/30',   label: 'Cancelled'  },
};

function _renderBadge(intentId, status, data = {}) {
  const cfg    = AE_STATUS_CFG[status] || AE_STATUS_CFG.pending;
  const txLink = data.txHash
    ? ` · <a href="${AE_EXPLORER}/tx/${data.txHash}" target="_blank" class="underline font-mono text-[10px] text-cyan-400">${data.txHash.slice(0,14)}…</a>`
    : '';
  const block  = data.blockNumber ? `<span class="text-gray-500 text-[10px] ml-1">Block #${data.blockNumber}</span>` : '';
  return `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg ${cfg.bg} border border-white/5 text-[11px] ${cfg.color}">
    <i class="fas ${cfg.icon} text-[10px]"></i>${cfg.label}${txLink}${block}
  </span>`;
}

// ─── Chat Integration: agentExecutor:update events ────────────────────────────
window.addEventListener('agentExecutor:update', function (e) {
  const { intentId, status, intent, txHash, blockNumber, error } = e.detail || {};
  if (!intentId) return;

  document.querySelectorAll(`[data-intent-id="${intentId}"] .ae-status-badge`).forEach(el => {
    el.outerHTML = _renderBadge(intentId, status, { txHash, blockNumber });
  });

  if (['completed', 'failed', 'broadcast'].includes(status)) {
    // Use window._autonomaActive (set by autonoma.js) — NOT window.autonomaActive (local var)
    const isAutonoma = !!window._autonomaActive;
    const notifyFn = isAutonoma && typeof window.appendChatMessage === 'function'
      ? window.appendChatMessage   // patched by autonoma context
      : (typeof appendChatMessage === 'function' ? appendChatMessage : null);

    if (!notifyFn) return;
    let msg = '';
    const exp = AE_EXPLORER;

    if (status === 'completed') {
      const amt  = intent?.amount  ? `${intent.amount} ${intent.token}` : '';
      const to   = intent?.to      ? `\`${intent.to.slice(0,10)}…${intent.to.slice(-8)}\`` : '';
      const link = txHash ? `[View on Explorer ↗](${exp}/tx/${txHash})` : '';
      msg = `✅ **Completed!** Agent sent ${amt} to ${to}\n\n${link}\nBlock #${blockNumber}`;
    } else if (status === 'broadcast') {
      const link = txHash ? `[Track TX ↗](${exp}/tx/${txHash})` : '';
      msg = `📤 **Transaction sent!** Waiting for block confirmation…\n\n${link}`;
    } else if (status === 'failed') {
      msg = `❌ **Agent failed:** ${error || 'Transaction failed. Check balance and try again.'}`;
    }

    if (msg) notifyFn('assistant', msg, status === 'failed' ? 'error' : 'payments');
  }

  if (typeof aeRefreshPanel === 'function') setTimeout(aeRefreshPanel, 300);
});

// ─── Meta-tx messages → Autonoma chat ────────────────────────────────────────
window.addEventListener('agentMetaTx:message', function (e) {
  const { msg, type } = e.detail || {};
  if (!msg) return;

  // Use window._autonomaActive (set by autonoma.js) — NOT window.autonomaActive (local var)
  const isAutonoma = !!window._autonomaActive;
  const notifyFn = isAutonoma && typeof window.appendChatMessage === 'function'
    ? window.appendChatMessage   // patched by autonoma context — routes to autonoma container
    : (typeof appendChatMessage === 'function' ? appendChatMessage : null);

  if (notifyFn) {
    const module = type === 'success' ? 'agents' : type === 'error' ? 'error' : 'agents';
    notifyFn('assistant', msg, module);
  }
});

// ─── Public API ───────────────────────────────────────────────────────────────
async function aeQueueTransfer(amount, token, to, memo) {
  return aeCreateIntent({ type: 'transfer', amount, token, to, memo });
}
async function aeQueueMultisend(receivers, token, memo) {
  return aeCreateIntent({ type: 'multisend', receivers, token, memo });
}
async function aeGetIntents(statusFilter) {
  const wallet = window.walletState?.address;
  if (!wallet) return [];
  const qs   = statusFilter ? `&status=${statusFilter}` : '';
  const data = await _get(`/intents?wallet=${encodeURIComponent(wallet)}${qs}`);
  return data.success ? data.intents : [];
}
async function aeCancelIntent(intentId) {
  const r = await fetch(`${AE_API_BASE}/intents/${intentId}`, { method: 'DELETE' });
  const d = await r.json();
  if (d.success) {
    _notify(intentId, 'cancelled', {});
    _toast('Intent cancelled.', 'info');
  }
  return d;
}
function aeStatusBadge(intentId, status, data) {
  return `<span data-intent-id="${intentId}" class="ae-intent-ref">${_renderBadge(intentId, status, data || {})}</span>`;
}
function aeGetPermitStatus(token) {
  const wallet = window.walletState?.address;
  if (!wallet) return { hasPermit: false, reason: 'wallet_not_connected' };
  const permit = _findPermit(wallet, token || 'USDC', 0.01);
  if (!permit) return { hasPermit: false, reason: 'no_permit' };
  const remaining = permit.amount - (permit.amountUsed || 0);
  const expiresIn = Math.round((permit.expiry - Date.now()) / 60000);
  return { hasPermit: true, permit, remaining, expiresIn,
    label: `${remaining} ${permit.token} · expires in ${expiresIn}m` };
}

// ─── Meta-tx status helper ────────────────────────────────────────────────────
function aeGetMetaTxStatus() {
  const contractDeployed = AE_CONTRACT_ADDR !== '0x0000000000000000000000000000000000000000';
  const relayerAddress   = _cachedRelayerAddr || null;
  const relayerConfigured = !!relayerAddress;
  return {
    contractDeployed,
    contractAddr:      AE_CONTRACT_ADDR,
    relayerConfigured,
    relayerAddress,
    mode:              contractDeployed ? 'A_agent_executor' : relayerConfigured ? 'B_direct_relay' : 'none',
    domain:            AE_EIP712_DOMAIN,
    capabilities:      contractDeployed
      ? ['gasless_transfer', 'gasless_batch', 'eip712_signing']
      : relayerConfigured
        ? ['direct_relay_transfer', 'direct_relay_batch']
        : ['permit2_transfer'],
    message: contractDeployed
      ? '✅ Gasless meta-transactions enabled — relayer pays all gas'
      : relayerConfigured
        ? '🔄 Direct relay mode — relayer uses transferFrom (one-time approval needed)'
        : '⚠️ Relay not configured — set RELAYER_PRIVATE_KEY',
  };
}

// ─── Deploy AgentExecutor via MetaMask ───────────────────────────────────────
// Called when user wants to deploy the contract from the browser
async function aeDeployContract(onProgress) {
  const log = (msg) => { _log(msg); if (onProgress) onProgress(msg); };

  if (!window.ethereum) throw new Error('MetaMask not found');

  // Get deployer address
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const deployer  = accounts[0];
  log(`Deployer: ${deployer}`);

  // Switch to Arc Testnet
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: AE_CHAIN_HEX }],
    });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: AE_CHAIN_HEX,
          chainName: 'Arc Testnet',
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
          rpcUrls: [AE_RPC],
          blockExplorerUrls: [AE_EXPLORER],
        }]
      });
    } else throw e;
  }

  // Build constructor calldata: (address[] relayers, address[] tokens)
  // Both are dynamic arrays, manually encode
  const relayers = [deployer]; // owner is also initial relayer
  const tokens   = [AE_USDC_ADDR, AE_EURC_ADDR];

  function encodeAddrArray(arr) {
    const len = arr.length.toString(16).padStart(64, '0');
    const items = arr.map(a => a.replace('0x','').padStart(64,'0')).join('');
    return len + items;
  }

  const off1 = '0000000000000000000000000000000000000000000000000000000000000040'; // 64
  const relayerBytesLen = 32 + relayers.length * 32;
  const off2 = (64 + relayerBytesLen).toString(16).padStart(64,'0');
  const constructorArgs = off1 + off2 + encodeAddrArray(relayers) + encodeAddrArray(tokens);

  const deployData = AE_BYTECODE + constructorArgs;
  log(`Bytecode: ${Math.round(AE_BYTECODE.length / 2)} bytes`);

  // Estimate gas
  let gasHex = '0x4C4B40'; // 5M default
  try {
    const estResult = await fetch(AE_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_estimateGas',
        params: [{ from: deployer, data: deployData }]
      })
    }).then(r => r.json());
    if (estResult.result) {
      const est = BigInt(estResult.result);
      gasHex = '0x' + (est * 130n / 100n).toString(16);
      log(`Gas estimate: ${est.toString()} → ${parseInt(gasHex,16)} (130%)`);
    }
  } catch(e) {
    log(`Gas estimate failed, using default: ${parseInt(gasHex,16)}`);
  }

  log('Sending deploy transaction...');
  const txHash = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from: deployer, data: deployData, gas: gasHex }]
  });

  log(`TX sent: ${txHash}`);
  log('Waiting for confirmation...');

  // Poll for receipt
  let receipt = null;
  for (let i = 0; i < 60 && !receipt; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(AE_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash]
      })
    }).then(r => r.json());
    if (res.result) receipt = res.result;
    if ((i + 1) % 5 === 0) log(`Waiting... (${(i+1)*2}s)`);
  }

  if (!receipt) throw new Error('Timeout waiting for receipt');
  if (receipt.status !== '0x1') throw new Error('Transaction failed on-chain');

  const contractAddress = receipt.contractAddress;
  log(`✅ Contract deployed at: ${contractAddress}`);

  // Save to localStorage
  localStorage.setItem('ae_contract_addr', contractAddress);
  log(`Saved to localStorage`);

  return {
    contractAddress,
    txHash,
    blockNumber: parseInt(receipt.blockNumber, 16),
    deployer,
    explorer: `${AE_EXPLORER}/address/${contractAddress}`,
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function _init() {
  _log(`Agent Executor v${AE_VERSION} loaded`);

  // Pre-fetch relayer address so Mode B status is available immediately
  _getRelayerAddress().then(addr => {
    if (addr) {
      _log(`Relayer address cached: ${addr}`);
      _log('Meta-tx status:', aeGetMetaTxStatus().message);
    } else {
      _log('Meta-tx status:', aeGetMetaTxStatus().message);
    }
  }).catch(() => {
    _log('Meta-tx status:', aeGetMetaTxStatus().message);
  });

  setInterval(() => {
    const session = _getSession();
    const wallet  = window.walletState?.address;
    const should  = !!(session && wallet);
    if (should && !_aePollTimer)  aeStartPolling();
    if (!should && _aePollTimer)  aeStopPolling();
  }, 5000);

  if (_getSession() && window.walletState?.address) aeStartPolling();
}

global.AgentExecutor = {
  version:         AE_VERSION,
  createIntent:    aeCreateIntent,
  queueTransfer:   aeQueueTransfer,
  queueMultisend:  aeQueueMultisend,
  getIntents:      aeGetIntents,
  cancelIntent:    aeCancelIntent,
  statusBadge:     aeStatusBadge,
  startPolling:    aeStartPolling,
  stopPolling:     aeStopPolling,
  getPermitStatus: aeGetPermitStatus,
  getMetaTxStatus: aeGetMetaTxStatus,
  deployContract:  aeDeployContract,
  bytecode:        AE_BYTECODE,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

})(window);
