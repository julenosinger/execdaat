// build:v2-20260627-151358
// ============================================================
// Chatbot Transactional Integration v1.0
// DISABLED TO PRESERVE ORIGINAL CHAT INTELLIGENCE
// Build: 20260408k
// ============================================================
// CRITICAL: This file is DISABLED to preserve original chatbot intelligence.
//
// REASON:
// The original chat.js and autonoma.js provide:
//   ✅ Full natural language understanding (NLU)
//   ✅ Context-aware responses
//   ✅ Multi-turn conversations
//   ✅ Rich feedback with status updates
//   ✅ Error handling with helpful suggestions
//   ✅ Intent parsing and validation
//   ✅ Transaction previews before signing
//
// This integration was intercepting messages and bypassing the original
// chat intelligence, causing loss of conversational features.
//
// DECISION: Keep chatbot intelligence INTACT
//   - Main chatbot: chat.js handles ALL messages (including transactional)
//   - Autonoma chatbot: autonoma.js handles ALL messages
//   - Payments tab: payments-core-integration.js → DaatAgentCore
//
// AVAILABLE (but not used for chat interception):
//   - window.DaatAgentTransactional (available for direct calls)
//   - window.DaatAgentCore (available for Payments tab)
//   - window.SafeDaatAgentCore (available with auto-initialization)
//
// CHATBOT FLOW (current, working):
//   User Message → chat.js/autonoma.js → Full NLU → Execution → Rich Feedback
//
// DO NOT:
//   ❌ Patch handleLocalCommand
//   ❌ Patch handleUnifiedMessage
//   ❌ Intercept chat messages
//   ❌ Bypass original chat handlers
//
// The original chatbots work perfectly as designed.
// ============================================================

'use strict';

const CTI_VERSION = '20260408k';

console.log(`%c[CTI v${CTI_VERSION}] Chatbot Transactional Integration DISABLED`, 'color: #fbbf24; font-weight: bold');
console.log(`%c[CTI] Original chatbot intelligence preserved ✓`, 'color: #34d399');
console.log(`%c[CTI] chat.js and autonoma.js handle all messages ✓`, 'color: #34d399');
console.log(`%c[CTI] No interception, no patches, no hooks`, 'color: #60b4ff');

// ─── Expose version info only ─────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.ChatbotTransactionalIntegration = {
    version: CTI_VERSION,
    enabled: false,
    disabled: true,
    reason: 'Disabled to preserve original chat intelligence',
    message: 'Original chat.js and autonoma.js provide full NLU and conversational features',
    recommendation: 'Use chat.js and autonoma.js directly for all chat interactions',
  };
  
  console.log(`%c[CTI] Module info exposed at window.ChatbotTransactionalIntegration`, 'color: #a78bfa');
}

// ─── Log available alternatives ───────────────────────────────────────────────
console.log(`%c[CTI] Available alternatives:`, 'color: #60b4ff; font-weight: bold');
console.log(`  • window.DaatAgentTransactional (for direct API calls)`);
console.log(`  • window.DaatAgentCore (for Payments tab integration)`);
console.log(`  • window.SafeDaatAgentCore (with auto-initialization)`);
console.log(`  • window.DaatAgentCoreInit (initialization utilities)`);

console.log(`%c[CTI] Module loaded in DISABLED mode ✓`, 'color: #34d399; font-weight: bold');
