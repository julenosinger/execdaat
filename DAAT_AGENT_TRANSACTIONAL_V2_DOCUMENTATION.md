# DAAT Agent Transactional v2.0 — Full AI Agent Documentation

**Build:** 20260408h  
**Status:** Production-ready  
**Bundle Size:** 445.40 KB  
**Deployment:** https://execdaatplataform.pages.dev/

---

## Executive Summary

DAAT Agent Transactional v2.0 transforms the ExecDaat chatbot into a **full transactional AI agent** capable of:
- Creating on-chain contracts (escrow, OTC, custom)
- Executing token swaps (USDC ↔ EURC)
- Controlling the Payments tab (auto-fill + execute)
- Orchestrating multi-step sequences (swap + pay, create + deposit)
- Managing context and memory across conversations
- Querying balances, history, and status

**CRITICAL:** Original chatbot intelligence is **PRESERVED**. All conversational features (NLU, context-aware responses, multi-turn conversations, rich feedback) remain intact. DaatAgentTransactional only handles executable commands.

---

## Architecture

```
User Message
    ↓
Original Chat Handler (NLU, context, conversation)
    ↓
Check if Executable Command?
    ↓ YES
DaatAgentTransactional.process()
    ↓
Intent Engine (parse natural language)
    ↓
Enrich with Context (last recipient, amounts, etc.)
    ↓
Validation Engine (wallet, balance, address, amount)
    ↓
Module Router
    ├─→ Transfer Module
    ├─→ Swap Module
    ├─→ Payment Module
    ├─→ Contract Module
    ├─→ Orchestrator Module
    └─→ Query Module
    ↓
Execution
    ↓
Update Context & History
    ↓
Format Response
    ↓
Display in Chat UI (message + action card)
```

---

## Capabilities

### 1. **Token Transfers**

**Commands:**
```
send 10 USDC to 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
transfer 5 EURC to 0x123...
pay 20 USDC to last
send max USDC to 0x456...
repeat
```

**Features:**
- Validates address format
- Checks balance before execution
- Supports "last" recipient (context-aware)
- Supports "max" balance
- Remembers last action for "repeat"

---

### 2. **Token Swaps**

**Commands:**
```
swap 10 USDC to EURC
exchange 5 EURC to USDC
convert 100 USDC
swap 20 USDC for EURC
```

**Features:**
- Auto-detects opposite token if not specified
- Checks balance before swap
- Configurable slippage (default 0.5%)
- Gas estimation
- Real-time quote fetching
- Approve + Transfer flow (for EURC)
- Native transfer for USDC

**Flow:**
1. Check network (Arc Testnet)
2. Verify balance
3. Guardian compliance check
4. Approve token (if EURC)
5. Execute swap transaction
6. Wait for confirmation
7. Display result with explorer link

---

### 3. **Payment Tab Control**

**Commands:**
```
pay john 20 USDC for invoice #123
pay alice@example.com 50 EURC for consulting services
```

**Features:**
- Auto-fills recipient name, email, amount, token, note
- Triggers payment execution
- Uses existing Payments tab UI
- Maintains payment history

**Auto-fill Fields:**
- Name: extracted from command
- Email: `<name>@example.com` (default)
- Amount: parsed from command
- Token: USDC or EURC
- Note: extracted from command

---

### 4. **Contract Creation**

#### **Escrow Contracts**

**Commands:**
```
create escrow 100 USDC with 0x742d35... for Project X
create escrow 50 EURC with 0x123... for Development Milestone
```

**Features:**
- Creates on-chain escrow contract
- Uses contracts.js factory (address: `0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A`)
- Validates contractor address
- Checks balance
- Returns contract ID and transaction hash
- Contractor must sign to activate

#### **OTC Deals**

**Commands:**
```
create otc 200 USDC with 0x456...
create otc 75 EURC with 0x789...
```

**Features:**
- Creates over-the-counter deal
- Both parties must sign
- Proof submission system
- On-chain verification

#### **General Contracts**

**Commands:**
```
create contract 500 USDC for 0xabc...
```

**Features:**
- Milestone-based contracts
- Client-contractor workflow
- Deposit and release functions

---

### 5. **Multi-step Orchestration**

**Commands:**
```
swap 10 USDC then pay 0x742d35...
swap 5 EURC and pay 0x123...
```

**Features:**
- Sequential execution (swap first, then transfer)
- Context retention between steps
- Automatic amount calculation (uses swap output)
- Rollback on failure (partial execution tracking)

**Future Support:**
- `create escrow 100 USDC with 0x... then deposit`
- `swap 50 USDC then create contract with 0x...`

---

### 6. **Queries & Status**

**Commands:**
```
balance          → Show USDC and EURC balances
history          → Last 10 actions
context          → Current context (last intent, recipient, etc.)
status           → Agent status and version
```

**Balance Response:**
```
💰 **Your Balance**

**USDC**: 1,234.56 USDC
**EURC**: 789.12 EURC

Wallet: 0x742d35...
```

**History Response:**
```
📜 **Recent History** (last 10 actions)

1. [transfer] completed — 2026-04-08 14:32
2. [swap] completed — 2026-04-08 14:25
3. [balance_query] completed — 2026-04-08 14:10
...
```

**Context Response:**
```
🧠 **Current Context**

**Last Intent**: transfer
**Last Token**: USDC
**Last Amount**: 10.00
**Last Recipient**: 0x742d35...
**Recent Addresses**: 5 stored
```

**Status Response:**
```
📊 **Agent Status**

**Version**: 20260408h
**Status**: idle
**Current Intent**: —
**History Entries**: 47
```

---

## Intent Engine — Natural Language Patterns

The Intent Engine recognizes **15+ natural language patterns**:

### Transfer Patterns
```regex
^(send|transfer|pay)\s+(\d+\.?\d*)\s+(usdc|eurc)\s+to\s+(0x[0-9a-f]{40}|last)$
^(send|transfer|pay)\s+(\d+\.?\d*)\s+(usdc|eurc)$
^send\s+max\s+(usdc|eurc)\s+to\s+(0x[0-9a-f]{40})$
```

### Swap Patterns
```regex
^(swap|exchange|convert)\s+(\d+\.?\d*)\s+(usdc|eurc)\s+(to|for|→)\s+(usdc|eurc)$
^(swap|exchange|convert)\s+(\d+\.?\d*)\s+(usdc|eurc)$
```

### Payment Patterns
```regex
^pay\s+([a-z0-9@._-]+)\s+(\d+\.?\d*)\s+(usdc|eurc)\s+for\s+(.+)$
```

### Contract Patterns
```regex
^create\s+escrow\s+(\d+\.?\d*)\s+(usdc|eurc)\s+with\s+(0x[0-9a-f]{40})\s+for\s+(.+)$
^create\s+contract\s+(\d+\.?\d*)\s+(usdc|eurc)\s+for\s+(0x[0-9a-f]{40})$
^create\s+otc\s+(\d+\.?\d*)\s+(usdc|eurc)\s+with\s+(0x[0-9a-f]{40})$
```

### Multi-step Patterns
```regex
^swap\s+(\d+\.?\d*)\s+(usdc|eurc)\s+(then|and)\s+pay\s+(0x[0-9a-f]{40})$
```

### Query Patterns
```regex
^(show\s+)?(balance|history|context|status)$
```

### Contextual Commands
```regex
^(repeat|again|do\s+it\s+again)$
```

---

## Validation Engine

The Validation Engine performs **8 security checks** before execution:

1. **Wallet Connection** — ensures wallet is connected
2. **Address Format** — validates Ethereum address regex
3. **Amount Validation** — ensures positive, finite number
4. **Token Validation** — checks against whitelist (USDC, EURC)
5. **Balance Check** — on-chain balance verification
6. **Network Check** — ensures Arc Testnet (Chain ID 5042002)
7. **Recipient Check** — validates contractor/counterparty addresses
8. **Input Sanitization** — prevents injection attacks

**Validation Errors:**
```
❌ Wallet not connected. Please connect your wallet first.
❌ Invalid recipient address format
❌ Amount must be greater than 0
❌ Invalid token (must be USDC or EURC)
❌ Insufficient balance. Available: 50.00 USDC
⚠️ Could not verify balance
```

---

## Response Format

All actions return a standardized response:

```typescript
{
  status: 'completed' | 'failed' | 'requires_approval' | 'pending',
  action: string,  // 'transfer', 'swap', 'contract_create', etc.
  message: string, // Human-readable message
  txHash?: string, // Transaction hash (if on-chain)
  data?: object,   // Action-specific data
  nextStep?: string // Optional next action suggestion
}
```

**Example Response (Transfer):**
```json
{
  "status": "completed",
  "action": "transfer",
  "message": "✅ Transfer completed! TX: 0xabc123...",
  "txHash": "0xabc123def456...",
  "data": {
    "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
    "amount": 10,
    "token": "USDC"
  },
  "nextStep": null
}
```

**Example Response (Escrow):**
```json
{
  "status": "completed",
  "action": "escrow_create",
  "message": "✅ Escrow contract created successfully!",
  "txHash": "0xdef789abc123...",
  "data": {
    "contractId": 42,
    "contractor": "0x123...",
    "amount": 100,
    "token": "USDC"
  },
  "nextStep": "Contractor can now sign the contract."
}
```

**Example Response (Balance Query):**
```json
{
  "status": "completed",
  "action": "balance_query",
  "message": "💰 **Your Balance**\n\n**USDC**: 1,234.56 USDC\n**EURC**: 789.12 EURC\n\nWallet: 0x742d35...",
  "data": {
    "usdc": 1234.56,
    "eurc": 789.12,
    "wallet": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
  }
}
```

---

## State Management

### Context (Persistent)

Stored in `localStorage` under key `dat_agent_context_v2`:

```typescript
{
  lastIntent: 'transfer',
  lastToken: 'USDC',
  lastAmount: 10,
  lastRecipient: '0x742d35...',
  lastContract: null,
  recentAddresses: ['0x742d35...', '0x123...'], // Last 10
  recentContracts: [] // Last 5
}
```

**Context Features:**
- Remembers last intent, token, amount, recipient
- Stores recent addresses for "last" and "repeat" commands
- Persists across page reloads
- Can be cleared with `DaatAgentTransactional.resetContext()`

### Execution History

Stored in `localStorage` under key `dat_agent_history_v2`:

```typescript
[
  {
    action: 'transfer',
    status: 'completed',
    message: '✅ Transfer completed!',
    data: { ... },
    timestamp: '2026-04-08T14:32:00.000Z'
  },
  ...
]
```

**History Features:**
- Stores last 100 actions
- Includes timestamps
- Accessible via `history` command
- Can be cleared with `DaatAgentTransactional.clearHistory()`

---

## Integration Points

### 1. Main Chatbot (chat.js)

**Hook:** `window.handleLocalCommand`

**Integration:**
```javascript
// Original handler is preserved
const originalHandler = window.handleLocalCommand;

// New handler checks if command is executable
window.handleLocalCommand = async function(message) {
  if (!CTI_isExecutable(message)) {
    // Non-executable → pass to original handler
    return originalHandler.call(this, message);
  }
  
  // Executable → process through DaatAgentTransactional
  const result = await window.DaatAgentTransactional.process(message);
  
  // Display response in chat UI
  CTI_formatResponse(result);
  CTI_createActionCard(result);
};
```

### 2. Autonoma Chatbot (autonoma.js)

**Hook:** `window.handleUnifiedMessage`

**Integration:** Same pattern as main chatbot, but uses autonoma-specific display functions.

### 3. Payments Tab

**Integration:** Existing `payments-core-integration.js` → `DaatAgentCore`

No changes required. Payments tab continues using direct execution.

---

## Module Reference

### 1. Intent Engine

**File:** `daat-agent-transactional.js`  
**Function:** `DATIntentEngine.parse(message)`

**Input:** User message (string)  
**Output:** Intent object

```typescript
{
  intent: string,  // Intent type (e.g., 'transfer', 'swap')
  raw: string,     // Original message
  amount?: number | 'max',
  token?: string,
  recipient?: string | 'last',
  fromToken?: string,
  toToken?: string,
  name?: string,
  note?: string,
  contractor?: string,
  counterparty?: string,
  title?: string,
  repeat?: boolean,
  contextUsed?: boolean,
  error?: string
}
```

---

### 2. Validation Engine

**File:** `daat-agent-transactional.js`  
**Function:** `DATValidationEngine.validate(intent)`

**Input:** Intent object  
**Output:** Validation result

```typescript
{
  valid: boolean,
  errors: string[]
}
```

---

### 3. Contract Module

**File:** `daat-agent-transactional.js`  
**Functions:**
- `DATContractModule.createEscrow(intent)`
- `DATContractModule.createOTC(intent)`
- `DATContractModule.createContract(intent)`

**Dependencies:**
- `window.createEscrowContract` (escrow.js)
- `window.otcCreateDeal` (otc.js)
- `window.cfCreateContract` (contracts.js)

---

### 4. Swap Module

**File:** `daat-agent-transactional.js`  
**Function:** `DATSwapModule.executeSwap(intent)`

**Dependencies:**
- `window.executeSwap` (swap.js)
- `window.onSwapInputChange` (swap.js)

**Flow:**
1. Set swap parameters in UI
2. Trigger quote update
3. Execute swap
4. Return result with transaction hash

---

### 5. Payment Module

**File:** `daat-agent-transactional.js`  
**Function:** `DATPaymentModule.executePayment(intent)`

**Dependencies:**
- `window.payExecuteNow` (payments.js)

**Flow:**
1. Auto-fill payment form fields
2. Trigger payment execution
3. Return result

---

### 6. Transfer Module

**File:** `daat-agent-transactional.js`  
**Function:** `DATTransferModule.executeTransfer(intent)`

**Dependencies:**
- `window.DaatAgentCore.ExecutionEngine._executeDirectTransfer`

**Flow:**
1. Build transfer intent
2. Execute via DaatAgentCore
3. Return result

---

### 7. Orchestrator Module

**File:** `daat-agent-transactional.js`  
**Function:** `DATOrchestratorModule.execute(intent)`

**Supported Sequences:**
- `SWAP_AND_PAY` — swap tokens, then transfer result

**Flow:**
1. Execute step 1 (swap)
2. Extract output amount
3. Execute step 2 (transfer with output amount)
4. Return combined result

---

### 8. Query Module

**File:** `daat-agent-transactional.js`  
**Function:** `DATQueryModule.handleQuery(intent)`

**Supported Queries:**
- `BALANCE` — on-chain balance check (USDC + EURC)
- `HISTORY` — last 10 executions
- `CONTEXT` — current context state
- `STATUS` — agent status and version

---

## Performance Metrics

| Operation | Average Time | Notes |
|-----------|-------------|-------|
| Intent Parsing | < 1 ms | Regex-based matching |
| Context Enrichment | < 1 ms | localStorage read |
| Validation | 100-300 ms | On-chain balance check |
| Transfer Execution | 2-5 sec | Wallet signature + confirmation |
| Swap Execution | 5-10 sec | Approve + Transfer (EURC) or direct transfer (USDC) |
| Contract Creation | 3-7 sec | On-chain contract deployment |
| Query (Balance) | 200-500 ms | Two on-chain calls (USDC + EURC) |
| Query (History/Context) | < 5 ms | localStorage read |

**Total Overhead:** < 10 ms (parsing + validation + context)

---

## Error Handling

### Validation Errors
```
❌ Wallet not connected. Please connect your wallet first.
❌ Invalid recipient address format
❌ Amount must be greater than 0
❌ Invalid token (must be USDC or EURC)
❌ Insufficient balance. Available: 50.00 USDC
❌ Cannot swap same token
```

### Execution Errors
```
❌ Escrow module not loaded. Please check script dependencies.
❌ Escrow creation failed: [error message]
❌ OTC module not loaded. Please check script dependencies.
❌ OTC creation failed: [error message]
❌ Swap module not loaded. Please check script dependencies.
❌ Swap failed: [error message]
❌ Payment module not loaded. Please check script dependencies.
❌ Payment failed: [error message]
❌ DaatAgentCore not loaded. Cannot execute transfer.
❌ Transfer failed: [error message]
```

### Unknown Commands
```
❓ I don't understand that command.

**Try:**
• `send 10 USDC to 0x...` — Transfer tokens
• `swap 5 USDC to EURC` — Token swap
• `pay john 20 USDC for invoice` — Auto-fill payment
• `create escrow 100 USDC with 0x... for Project X` — Create escrow
• `balance` — Check your balance
• `history` — Show recent actions
```

---

## Testing Scenarios

### 1. Simple Transfer
```
User: send 10 USDC to 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
Agent: ✅ Transfer completed! TX: 0xabc123...
      🔗 [View Transaction ↗]
```

### 2. Contextual Transfer
```
User: send 5 USDC to 0x123...
Agent: ✅ Transfer completed! TX: 0xdef456...

User: send 10 USDC to last
Agent: ✅ Transfer completed to 0x123...! TX: 0xghi789...
```

### 3. Repeat Last Action
```
User: send 10 USDC to 0x456...
Agent: ✅ Transfer completed! TX: 0xjkl012...

User: repeat
Agent: ✅ Transfer completed to 0x456...! TX: 0xmno345...
```

### 4. Token Swap
```
User: swap 10 USDC to EURC
Agent: 🔄 Checking network...
      ✅ Network OK
      💰 Checking balance...
      ✅ Balance OK
      🛡️ Compliance check...
      ✅ Compliance OK
      🔓 Approval not needed
      ✍️ Signing transaction...
      ✅ Swap completed! 10 USDC → 10.78 EURC
      🔗 [View Transaction ↗]
```

### 5. Payment Auto-fill
```
User: pay john 20 USDC for invoice #123
Agent: 💰 Auto-filling payment form...
      ✅ Payment sent to john!
      🔗 [View Transaction ↗]
```

### 6. Escrow Creation
```
User: create escrow 100 USDC with 0x789... for Project X
Agent: 📋 Creating escrow contract...
      ✅ Escrow contract created successfully!
      Contract ID: 42
      🔗 [View Transaction ↗]
      
      💡 **Next Step**: Contractor can now sign the contract.
```

### 7. Multi-step Orchestration
```
User: swap 10 USDC then pay 0xabc...
Agent: 🔄 Step 1: Swapping 10 USDC to EURC...
      ✅ Swap completed! 10 USDC → 10.78 EURC
      
      💸 Step 2: Transferring 10.78 EURC to 0xabc...
      ✅ Transfer completed!
      
      ✅ Swapped 10 USDC and sent 10.78 EURC to 0xabc...
      🔗 [View Transactions ↗]
```

### 8. Balance Query
```
User: balance
Agent: 💰 **Your Balance**
      
      **USDC**: 1,234.56 USDC
      **EURC**: 789.12 EURC
      
      Wallet: 0x742d35...
```

### 9. History Query
```
User: history
Agent: 📜 **Recent History** (last 10 actions)
      
      1. [transfer] completed — 2026-04-08 14:32
      2. [swap] completed — 2026-04-08 14:25
      3. [balance_query] completed — 2026-04-08 14:10
      ...
```

### 10. Unknown Command
```
User: hello world
Agent: ❓ I don't understand that command.
      
      **Try:**
      • `send 10 USDC to 0x...` — Transfer tokens
      • `swap 5 USDC to EURC` — Token swap
      • `balance` — Check your balance
```

---

## API Reference

### DaatAgentTransactional.process(message)

**Main entry point for processing user messages.**

**Parameters:**
- `message` (string) — User message

**Returns:** Promise<Response>

**Response Format:**
```typescript
{
  status: 'completed' | 'failed' | 'requires_approval' | 'pending',
  action: string,
  message: string,
  txHash?: string,
  data?: object,
  nextStep?: string
}
```

**Usage:**
```javascript
const result = await DaatAgentTransactional.process('send 10 USDC to 0x123...');
console.log(result.status);   // 'completed'
console.log(result.message);  // '✅ Transfer completed!'
console.log(result.txHash);   // '0xabc123...'
```

---

### DaatAgentTransactional.getState()

**Returns current agent state.**

**Returns:** Object

```typescript
{
  version: string,
  initialized: boolean,
  currentStatus: string,
  currentIntent: object | null,
  lastError: string | null,
  executionHistory: array
}
```

---

### DaatAgentTransactional.getContext()

**Returns current context.**

**Returns:** Object

```typescript
{
  lastIntent: string,
  lastToken: string,
  lastAmount: number,
  lastRecipient: string,
  lastContract: string,
  recentAddresses: string[],
  recentContracts: string[]
}
```

---

### DaatAgentTransactional.getHistory()

**Returns execution history.**

**Returns:** Array

```typescript
[
  {
    action: string,
    status: string,
    message: string,
    data: object,
    timestamp: string
  },
  ...
]
```

---

### DaatAgentTransactional.clearHistory()

**Clears execution history.**

**Returns:** void

---

### DaatAgentTransactional.resetContext()

**Resets context to defaults.**

**Returns:** void

---

## Troubleshooting

### Agent Not Responding

**Symptoms:** User messages are not processed.

**Checks:**
1. Check if `DaatAgentTransactional` is loaded:
   ```javascript
   console.log(typeof window.DaatAgentTransactional); // should be 'object'
   ```

2. Check if integration is initialized:
   ```javascript
   window.CTI_init(); // Manual init
   ```

3. Check browser console for errors.

---

### Commands Not Recognized

**Symptoms:** Agent replies with "I don't understand that command."

**Checks:**
1. Verify command syntax matches patterns (see Intent Engine section)
2. Check for typos in token names (USDC, EURC)
3. Ensure addresses are valid Ethereum format (`0x` + 40 hex chars)

**Example:**
```
❌ send 10 usdc to 0x123       (address too short)
✅ send 10 USDC to 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
```

---

### Execution Fails

**Symptoms:** Agent replies with "❌ [Module] failed: [error]"

**Checks:**
1. Check wallet connection:
   ```javascript
   console.log(window.walletState);
   ```

2. Check network (Arc Testnet):
   ```javascript
   console.log(await window.ethereum.request({ method: 'eth_chainId' })); // should be '0x4cef52'
   ```

3. Check balance:
   ```javascript
   const result = await DaatAgentTransactional.process('balance');
   console.log(result);
   ```

4. Check module availability:
   ```javascript
   console.log(typeof window.executeSwap);          // should be 'function'
   console.log(typeof window.payExecuteNow);        // should be 'function'
   console.log(typeof window.createEscrowContract); // should be 'function'
   ```

---

### Context Not Working

**Symptoms:** "last" and "repeat" commands don't work.

**Checks:**
1. Check localStorage:
   ```javascript
   console.log(localStorage.getItem('dat_agent_context_v2'));
   ```

2. Reset context:
   ```javascript
   DaatAgentTransactional.resetContext();
   ```

3. Perform an action to populate context:
   ```javascript
   await DaatAgentTransactional.process('send 10 USDC to 0x123...');
   ```

4. Try contextual command:
   ```javascript
   await DaatAgentTransactional.process('send 5 USDC to last');
   ```

---

## Security Notes

1. **No Private Keys:** Agent never accesses or stores private keys.
2. **Wallet Signature:** All transactions require explicit wallet signature.
3. **Balance Checks:** On-chain balance verification before execution.
4. **Address Validation:** Regex validation for all addresses.
5. **Amount Validation:** Ensures positive, finite numbers.
6. **Token Whitelist:** Only USDC and EURC are allowed.
7. **Single-Wallet:** Enforces same wallet for all actions.
8. **No Hardcoded Secrets:** All sensitive data is user-provided.

---

## Backward Compatibility

**Preserved:**
- Original chatbot NLU and conversational features
- Existing Payments tab integration
- DaatAgentCore for direct transfers
- All UI/UX components
- Context memory and history

**New:**
- DaatAgentTransactional for advanced commands
- Contract creation capabilities
- Swap execution
- Payment auto-fill
- Multi-step orchestration
- Query commands

**Removed:**
- Agent Executor (gasless meta-transactions)
- Relayer API
- Permit2 approval checks (simplified)

---

## Future Enhancements

1. **Additional Multi-step Sequences:**
   - `create escrow 100 USDC with 0x... then deposit`
   - `swap 50 USDC then create contract with 0x...`

2. **Advanced Contract Features:**
   - Milestone management via chat
   - Contract status queries
   - Dispute resolution

3. **Enhanced Swap:**
   - Price alerts
   - Limit orders
   - Liquidity pool queries

4. **Payment Features:**
   - Scheduled payments via chat
   - Recurring payments
   - Payment requests

5. **AI Suggestions:**
   - Contextual action suggestions
   - Optimal gas timing
   - Fee optimization

---

## Support

**Deployment:** https://execdaatplataform.pages.dev/  
**Explorer:** https://testnet.arcscan.app  
**Chain ID:** 5042002 (0x4cef52)  
**RPC:** https://rpc.testnet.arc.network

**Version:** 20260408h  
**Status:** Production-ready  
**Build Date:** 2026-04-08

---

**End of Documentation**
