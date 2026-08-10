// ============================================================
// CHAT-CSV.JS — CSV Upload + Auto Multisend Engine
// ExecDaat · Arc Testnet · Permit2-enabled batch payments
//
// Responsibilities:
//  • Parse CSV files (Formats A, B, C) from chatbot input
//  • Validate addresses / amounts / tokens
//  • Cache last CSV in memory (sessionStorage)
//  • Expose chatCSV state + helpers to chat.js
//  • Drive Permit2 multisend preview + execution flow
// ============================================================
(function () {
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
var CSV_STORAGE_KEY  = 'execDaat_last_csv_v1';
var MAX_CSV_ROWS     = 1000;
var MAX_CHUNK_SIZE   = 100;   // batch into chunks for large lists
var MAX_AMOUNT_PER   = 10000; // per-row cap
var VALID_TOKENS     = ['USDC', 'EURC'];

// ── Shared state (accessible to chat.js via window.chatCSVState) ───────────────
var csvState = {
  loaded:       false,
  fileName:     '',
  rows:         [],          // [{address, amount, token, note, priority}]
  invalidRows:  [],          // [{line, errs}]
  token:        'USDC',      // detected or overridden
  pendingAmountRequest: false, // waiting for user to type an amount
  lastUploadTime: 0,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function isEthAddr(s) { return /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim()); }
function toNum(s)     { return parseFloat(String(s || '').replace(',', '.').trim()); }
function toFixed2(n)  { return isNaN(n) ? '0.00' : Number(n).toFixed(2); }

function _log(msg, level) {
  if (typeof addLog === 'function') addLog('[CSV] ' + msg, level || 'info');
}
function _append(text, mod) {
  if (typeof appendChatMessage === 'function') appendChatMessage('assistant', text, mod || 'payments');
}
function _card(btns) {
  if (typeof appendActionCard === 'function') appendActionCard(btns);
}
function _toast(msg, type) {
  if (typeof showToast === 'function') showToast(msg, type || 'info');
}
function _hideTyping() {
  if (typeof hideTypingIndicator === 'function') hideTypingIndicator();
}
function _showTyping() {
  if (typeof showTypingIndicator === 'function') showTypingIndicator();
}

// ── RFC-4180 CSV Parser ────────────────────────────────────────────────────────
function parseCSV(text) {
  var normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  var lines = normalized.split('\n');
  if (lines.length < 1) return { headers: [], rows: [] };

  // Detect separator
  var sep = lines[0].includes(';') ? ';' : ',';

  function splitLine(line) {
    var result = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === sep && !inQ) { result.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    result.push(cur.trim());
    return result;
  }

  var headerLine = splitLine(lines[0]);
  var headers    = headerLine.map(function(h) {
    return h.toLowerCase().replace(/[^a-z0-9_]/g, '');
  });

  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var cells = splitLine(line);
    var obj   = {};
    headers.forEach(function(h, idx) { obj[h] = (cells[idx] || '').trim(); });
    rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

// ── Row normalizer — maps any column alias to canonical fields ──────────────────
function normalizeRow(raw) {
  var addrKeys  = ['address','to','toaddress','wallet','walletaddress','destination','recipient',
                   'endereco','endereço','destinatario','destinatário','addr'];
  var amtKeys   = ['amount','value','usdc','eurc','quantidade','valor','qtd','amt','quant'];
  var tokenKeys = ['token','currency','moeda','coin'];
  var noteKeys  = ['note','description','memo','notes','descricao','descrição','obs','observacao'];
  var prioKeys  = ['priority','prio','prioridade'];

  function find(keys) {
    for (var k = 0; k < keys.length; k++) {
      if (raw[keys[k]] !== undefined && raw[keys[k]] !== '') return raw[keys[k]];
    }
    return '';
  }

  return {
    address:  find(addrKeys),
    amount:   String(find(amtKeys)).replace(',', '.'),
    token:    find(tokenKeys).toUpperCase() || '',
    note:     find(noteKeys),
    priority: find(prioKeys) || 'medium',
  };
}

// ── Detect CSV format (A: addr+amt, B: addr only, C: addr+amt+token) ──────────
function detectFormat(headers) {
  var hasAddr  = ['address','to','toaddress','wallet','recipient','addr','endereco','endereço'].some(function(k) { return headers.includes(k); });
  var hasAmt   = ['amount','value','usdc','eurc','quantidade','valor','qtd','amt'].some(function(k) { return headers.includes(k); });
  var hasToken = ['token','currency','moeda','coin'].some(function(k) { return headers.includes(k); });
  if (!hasAddr) return 'unknown';
  if (hasToken) return 'C';
  if (hasAmt)   return 'A';
  return 'B';
}

// ── Validate + process parsed rows ────────────────────────────────────────────
function processRows(rawRows, overrideAmount, overrideToken) {
  var valid   = [];
  var invalid = [];
  var seenAddr = {};

  rawRows.slice(0, MAX_CSV_ROWS).forEach(function(raw, idx) {
    var r    = normalizeRow(raw);
    var errs = [];
    var lineNo = idx + 2;

    // Address
    var addr = r.address.trim();
    if (!addr)              errs.push('address missing');
    else if (!isEthAddr(addr)) errs.push('invalid EVM address');
    else if (seenAddr[addr.toLowerCase()]) errs.push('duplicate address');
    else seenAddr[addr.toLowerCase()] = true;

    // Amount (use override if row has none — FORMAT B)
    var rawAmt = r.amount !== '' ? r.amount : String(overrideAmount || '');
    var amt    = toNum(rawAmt);
    if (rawAmt === '' || rawAmt === undefined) errs.push('amount missing');
    else if (isNaN(amt) || amt <= 0)           errs.push('invalid amount');
    else if (amt > MAX_AMOUNT_PER)             errs.push('amount exceeds $' + MAX_AMOUNT_PER);

    // Token
    var tok = r.token !== '' ? r.token : (overrideToken || 'USDC');
    tok = tok.toUpperCase();
    if (!VALID_TOKENS.includes(tok)) tok = 'USDC'; // fallback

    if (errs.length) {
      invalid.push({ line: lineNo, addr: addr || '(empty)', errs: errs });
    } else {
      valid.push({
        address:  addr,
        amount:   amt,
        token:    tok,
        note:     r.note || ('Batch payment #' + (valid.length + 1)),
        priority: ['low','medium','high','critical'].includes(r.priority) ? r.priority : 'medium',
      });
    }
  });

  return { valid: valid, invalid: invalid };
}

// ── Persist CSV to sessionStorage ─────────────────────────────────────────────
function persistCSV() {
  try {
    sessionStorage.setItem(CSV_STORAGE_KEY, JSON.stringify({
      fileName:    csvState.fileName,
      rows:        csvState.rows,
      invalidRows: csvState.invalidRows,
      token:       csvState.token,
      savedAt:     Date.now(),
    }));
  } catch(e) { /* storage full — ignore */ }
}

function loadPersistedCSV() {
  try {
    var raw = sessionStorage.getItem(CSV_STORAGE_KEY);
    if (!raw) return false;
    var d = JSON.parse(raw);
    // Only reuse if < 2 hours old
    if (!d || !d.rows || Date.now() - d.savedAt > 2 * 3600 * 1000) return false;
    csvState.loaded    = true;
    csvState.fileName  = d.fileName  || '';
    csvState.rows      = d.rows      || [];
    csvState.invalidRows = d.invalidRows || [];
    csvState.token     = d.token     || 'USDC';
    return true;
  } catch(e) { return false; }
}

// ── Build Preview Message ──────────────────────────────────────────────────────
function buildPreviewMessage(rows, invalid, fileName, token) {
  var total     = rows.reduce(function(s, r) { return s + r.amount; }, 0);
  var sampleLen = Math.min(3, rows.length);
  var samples   = rows.slice(0, sampleLen).map(function(r, i) {
    return '`' + r.address.slice(0, 10) + '…' + r.address.slice(-4) + '` → **' + toFixed2(r.amount) + ' ' + r.token + '**';
  }).join('\n');

  var invalidNote = invalid.length
    ? '\n> ⚠️ **' + invalid.length + ' invalid row' + (invalid.length > 1 ? 's' : '') + ' ignored** — ' +
      invalid.slice(0, 2).map(function(r) { return 'row ' + r.line + ': ' + r.errs[0]; }).join(', ') +
      (invalid.length > 2 ? ' (+' + (invalid.length - 2) + ' more)' : '')
    : '';

  var chunkNote = rows.length > MAX_CHUNK_SIZE
    ? '\n> 📦 **Large batch** — will be sent in ' + Math.ceil(rows.length / MAX_CHUNK_SIZE) + ' chunks of ' + MAX_CHUNK_SIZE
    : '';

  return (
    '📊 **CSV Loaded: ' + escapeForChat(fileName) + '**\n\n' +
    '| Field | Value |\n' +
    '|---|---|\n' +
    '| Recipients | **' + rows.length + '** |\n' +
    '| Token | **' + token + '** |\n' +
    '| Total | **' + toFixed2(total) + ' ' + token + '** |\n' +
    '| Avg per address | ' + toFixed2(total / rows.length) + ' ' + token + ' |\n\n' +
    '**Sample addresses:**\n' + samples +
    (rows.length > sampleLen ? '\n…and ' + (rows.length - sampleLen) + ' more' : '') +
    invalidNote + chunkNote + '\n\n' +
    '**Confirm to execute Permit2 batch transfer?**'
  );
}

function escapeForChat(s) {
  return String(s || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Main file handler ─────────────────────────────────────────────────────────
function handleChatCSVFile(file, overrideAmount, overrideToken) {
  if (!file) return;
  var name = file.name.toLowerCase();
  if (!name.endsWith('.csv')) {
    _toast('❌ Only .csv files are accepted', 'error');
    _append('❌ **Unsupported file format.** Only `.csv` files are accepted.\n\nTry: `address,amount` or `address,amount,token`', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    _toast('❌ File too large (max 5 MB)', 'error');
    return;
  }

  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var text   = e.target.result;
      var parsed = parseCSV(text);

      if (parsed.rows.length === 0) {
        _append('⚠️ **CSV is empty.** The file has no valid data rows.', 'error');
        return;
      }

      var format  = detectFormat(parsed.headers);
      var result  = processRows(parsed.rows, overrideAmount, overrideToken);
      var valid   = result.valid;
      var invalid = result.invalid;

      if (valid.length === 0) {
        _append(
          '❌ **No valid rows found in CSV.**\n\n' +
          (invalid.length ? 'Errors found:\n' + invalid.slice(0, 5).map(function(r) {
            return '• Row ' + r.line + ': ' + r.errs.join(', ');
          }).join('\n') : 'Check address format (must be `0x` + 40 hex chars) and amounts.'),
          'error'
        );
        return;
      }

      // Detect dominant token
      var tokenCounts = {};
      valid.forEach(function(r) {
        tokenCounts[r.token] = (tokenCounts[r.token] || 0) + 1;
      });
      var dominantToken = Object.keys(tokenCounts).sort(function(a, b) {
        return tokenCounts[b] - tokenCounts[a];
      })[0] || 'USDC';

      // Update state
      csvState.loaded         = true;
      csvState.fileName       = file.name;
      csvState.rows           = valid;
      csvState.invalidRows    = invalid;
      csvState.token          = overrideToken || dominantToken;
      csvState.lastUploadTime = Date.now();
      csvState.pendingAmountRequest = false;
      persistCSV();

      // FORMAT B: no amounts found — need to ask user
      var needsAmount = (format === 'B') && !overrideAmount;
      if (needsAmount) {
        csvState.pendingAmountRequest = true;
        _hideTyping();
        _append(
          '📄 **CSV loaded — ' + valid.length + ' address' + (valid.length > 1 ? 'es' : '') + ' found**\n\n' +
          '⚠️ **Amount not found in CSV.** What amount should be sent per address?\n\n' +
          'Reply with the amount, for example:\n' +
          '• `10` — sends 10 USDC to each address\n' +
          '• `10 USDC` or `5 EURC`',
          'payments'
        );
        _log('FORMAT B: ' + valid.length + ' addresses, awaiting amount from user', 'warning');
        return;
      }

      // Show preview + confirm buttons
      _hideTyping();
      var previewMsg = buildPreviewMessage(valid, invalid, file.name, csvState.token);
      _append(previewMsg, 'payments');
      _card([
        { label: '✅ Execute Permit2 Batch',  action: 'window.csvExecuteBatch()',    primary: true, success: true },
        { label: '✏️ Edit in Multisend',       action: 'window.csvOpenInMultisend()', primary: false },
        { label: '✕ Cancel',                   action: 'window.csvCancelUpload()',    danger: true },
      ]);

      var skipMsg = invalid.length ? ' · ⚠️ ' + invalid.length + ' skipped' : '';
      _toast('✅ ' + valid.length + ' recipients loaded' + skipMsg, invalid.length ? 'warning' : 'success');
      _log(file.name + ' → ' + valid.length + ' valid, ' + invalid.length + ' invalid, format ' + format, valid.length > 0 ? 'success' : 'warning');

    } catch(err) {
      _append('❌ **CSV parse error:** ' + escapeForChat(err.message), 'error');
      _log('parse error: ' + err.message, 'error');
    }
  };
  reader.onerror = function() {
    _append('❌ **File read error.** Please try again.', 'error');
  };
  reader.readAsText(file, 'UTF-8');
}

// ── Handle amount reply (FORMAT B pending) ────────────────────────────────────
function handleCSVAmountReply(msg) {
  if (!csvState.pendingAmountRequest) return false;
  var m = msg.match(/^([\d.]+)\s*(usdc|eurc)?/i);
  if (!m) return false;

  var amt   = toNum(m[1]);
  var token = m[2] ? m[2].toUpperCase() : csvState.token;
  if (isNaN(amt) || amt <= 0) {
    _append('⚠️ Invalid amount. Please enter a positive number, e.g. `10` or `5 USDC`', 'payments');
    return true;
  }

  // Re-process rows with the provided amount
  // We need to reload from persistent storage to re-parse
  var savedRows = csvState.rows.map(function(r) { return Object.assign({}, r, { amount: amt, token: token }); });
  csvState.rows  = savedRows;
  csvState.token = token;
  csvState.pendingAmountRequest = false;
  persistCSV();

  _hideTyping();
  var previewMsg = buildPreviewMessage(savedRows, csvState.invalidRows, csvState.fileName, token);
  _append(previewMsg, 'payments');
  _card([
    { label: '✅ Execute Permit2 Batch',  action: 'window.csvExecuteBatch()',    primary: true, success: true },
    { label: '✏️ Edit in Multisend',       action: 'window.csvOpenInMultisend()', primary: false },
    { label: '✕ Cancel',                   action: 'window.csvCancelUpload()',    danger: true },
  ]);
  return true;
}

// ── Handle "send" after CSV is loaded ─────────────────────────────────────────
function handleCSVSendCommand(msg) {
  if (!csvState.loaded || csvState.rows.length === 0) return false;

  var lower = msg.toLowerCase().trim();

  // "reuse last csv" / "use last csv"
  if (/reuse.*(last|csv)|use.*last.*csv|last.*csv/i.test(lower)) {
    var restored = loadPersistedCSV();
    if (restored && csvState.rows.length > 0) {
      _hideTyping();
      var previewMsg = buildPreviewMessage(csvState.rows, csvState.invalidRows, csvState.fileName, csvState.token);
      _append('♻️ **Reusing last CSV:** ' + escapeForChat(csvState.fileName) + '\n\n' + previewMsg, 'payments');
      _card([
        { label: '✅ Execute Permit2 Batch',  action: 'window.csvExecuteBatch()',    primary: true, success: true },
        { label: '✏️ Edit in Multisend',       action: 'window.csvOpenInMultisend()', primary: false },
        { label: '✕ Cancel',                   action: 'window.csvCancelUpload()',    danger: true },
      ]);
      return true;
    }
    _append('ℹ️ No recent CSV found. Please upload a new file using the **📎** button.', 'payments');
    return true;
  }

  // "send" or "send X usdc" with CSV loaded
  var isSend = /^(?:send|pay|execute|enviar|pagar|executar|go|confirmar|confirm|sim|yes)\b/i.test(lower);

  // "edit" — open in multisend
  if (/^(?:edit|editar|review|open multisend|abrir multisend)\b/i.test(lower)) {
    _hideTyping();
    window.csvOpenInMultisend();
    return true;
  }

  // "cancel" — cancel CSV
  if (/^(?:cancel|cancelar|clear csv|limpar csv)\b/i.test(lower)) {
    window.csvCancelUpload();
    return true;
  }

  // "template" — download template
  if (/csv template|download template|modelo csv|baixar template/i.test(lower)) {
    _hideTyping();
    var fmtM = lower.match(/format\s*([abc])/i);
    window.csvDownloadTemplate(fmtM ? fmtM[1] : 'A');
    return true;
  }

  // "validate" — server-side validation
  if (/validate csv|verificar csv|check csv/i.test(lower)) {
    _hideTyping();
    if (typeof window.csvServerValidate === 'function') window.csvServerValidate();
    return true;
  }

  if (!isSend) return false;

  // Allow overriding amount/token: "send 20 USDC"
  var amtMatch = msg.match(/(?:send|pay|enviar)\s+([\d.]+)\s*(usdc|eurc)?/i);
  if (amtMatch) {
    var overAmt   = toNum(amtMatch[1]);
    var overToken = amtMatch[2] ? amtMatch[2].toUpperCase() : csvState.token;
    if (!isNaN(overAmt) && overAmt > 0) {
      csvState.rows  = csvState.rows.map(function(r) { return Object.assign({}, r, { amount: overAmt, token: overToken }); });
      csvState.token = overToken;
      persistCSV();
    }
  }

  _hideTyping();
  var preview = buildPreviewMessage(csvState.rows, csvState.invalidRows, csvState.fileName, csvState.token);
  _append(preview, 'payments');
  _card([
    { label: '✅ Execute Permit2 Batch',  action: 'window.csvExecuteBatch()',    primary: true, success: true },
    { label: '✏️ Edit in Multisend',       action: 'window.csvOpenInMultisend()', primary: false },
    { label: '✕ Cancel',                   action: 'window.csvCancelUpload()',    danger: true },
  ]);
  return true;
}

// ── Execute Permit2 batch ──────────────────────────────────────────────────────
window.csvExecuteBatch = async function() {
  if (!csvState.loaded || csvState.rows.length === 0) {
    _append('⚠️ No CSV data loaded. Upload a CSV file first.', 'error');
    return;
  }

  var wallet = window.walletState && window.walletState.address;
  if (!wallet) {
    _append('🔐 **Wallet required.** Connect your EVM wallet first.', 'payments');
    _card([{ label: '🔗 Connect Wallet', action: 'openWalletModal()', primary: true }]);
    return;
  }

  var rows  = csvState.rows;
  var token = csvState.token;
  var total = rows.reduce(function(s, r) { return s + r.amount; }, 0);

  // ── Step 1: Check / request Permit2 allowance ──────────────────────────────
  if (typeof p2CheckAllowance === 'function') {
    var check = p2CheckAllowance(wallet, token, total, 'multisend');
    if (!check.allowed) {
      _append(
        '🔐 **Permit2 authorization required**\n\n' +
        'This batch needs **' + toFixed2(total) + ' ' + token + '** authorized for multisend.\n\n' +
        'Run: `allow the agent to spend ' + Math.ceil(total * 1.05) + ' ' + token + ' for 1 hour`\n\n' +
        '*Then re-upload your CSV or type `send` to retry.*',
        'permit2'
      );
      _card([{
        label: '🔑 Create Permit2',
        action: "sendQuickMessage('allow the agent to spend " + Math.ceil(total * 1.05) + " " + token + " for 1 hour for multisend')",
        primary: true,
      }]);
      return;
    }
  }

  // ── Step 2: Guardian compliance check ─────────────────────────────────────
  _append('🛡️ Running Guardian compliance check…', 'agents');
  _showTyping();
  try {
    var gcRes = await (async function() {
   console.log('[fetch] POST', '/api/guardian/check');
   try {
     var _r = await fetch('/api/guardian/check', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      txType: 'payment', fromAddress: wallet,
      amount: total, token: token,
    })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', '/api/guardian/check', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', '/api/guardian/check', _ex.message); throw _ex; }
 }());
    _hideTyping();
    if (!gcRes.data.approved) {
      _append(
        '🚫 **Guardian blocked this batch.**\n\n' +
        (gcRes.data.check?.result?.reasons?.[0] || 'Compliance check failed.'),
        'error'
      );
      return;
    }
  } catch(e) {
    _hideTyping();
    // Guardian down — warn but continue
    _log('Guardian check failed (non-critical): ' + e.message, 'warning');
  }

  // ── Step 3: Split into chunks if needed ───────────────────────────────────
  var chunks = [];
  for (var i = 0; i < rows.length; i += MAX_CHUNK_SIZE) {
    chunks.push(rows.slice(i, i + MAX_CHUNK_SIZE));
  }

  var totalSubmitted = 0;
  var totalFailed    = 0;
  var batchIds       = [];

  _append(
    '⚙️ **Executing batch…** ' +
    (chunks.length > 1 ? chunks.length + ' chunks of up to ' + MAX_CHUNK_SIZE : '1 batch') +
    ' · ' + rows.length + ' recipients',
    'payments'
  );

  for (var ci = 0; ci < chunks.length; ci++) {
    var chunk = chunks[ci];
    _showTyping();
    try {
      // ── EVM signature for this chunk ──────────────────────────────────────
      var chunkTotal = chunk.reduce(function(s, r) { return s + r.amount; }, 0);
      var batchTxHash = null;
      if (window.evmSignOperation) {
        try {
          var sig = await window.evmSignOperation('BATCH_PAYMENT', {
            count: chunk.length, totalAmount: chunkTotal, token: token,
          });
          batchTxHash = sig.signature ? sig.signature.slice(0, 66) : null;
        } catch(sigErr) {
          if (/reject|cancel|denied/i.test(sigErr.message || '')) {
            _hideTyping();
            _append('✕ **Signature rejected.** Batch cancelled.', 'error');
            return;
          }
          _log('EVM sign skipped: ' + sigErr.message, 'warning');
        }
      }

      // ── Submit chunk to backend ───────────────────────────────────────────
      var payments = chunk.map(function(r) {
        return {
          from:        wallet,
          to:          r.address,
          amount:      r.amount,
          description: r.note || 'CSV batch payment',
          priority:    r.priority || 'medium',
          batchTxHash: batchTxHash,
        };
      });

      var res = await (async function() {
   console.log('[fetch] POST', '/api/payments/batch');
   try {
     var _r = await fetch('/api/payments/batch', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        payments: payments,
        fileName: csvState.fileName,
        csvBatch: true,
      })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', '/api/payments/batch', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', '/api/payments/batch', _ex.message); throw _ex; }
 }());
      var d = res.data;
      totalSubmitted += (d.submitted || chunk.length);
      if (d.batchId) batchIds.push(d.batchId);

      // Record Permit2 usage
      if (typeof p2CheckAllowance === 'function' && typeof p2RecordUsage === 'function') {
        var checkInner = p2CheckAllowance(wallet, token, chunkTotal, 'multisend');
        if (checkInner.allowed && checkInner.permit) {
          p2RecordUsage(checkInner.permit.id, chunkTotal);
        }
      }

      _hideTyping();
      if (chunks.length > 1) {
        _log('Chunk ' + (ci + 1) + '/' + chunks.length + ': ' + (d.submitted || chunk.length) + ' submitted', 'success');
      }
    } catch(err) {
      _hideTyping();
      totalFailed += chunk.length;
      _log('Chunk ' + (ci + 1) + ' failed: ' + (err.response?.data?.error || err.message), 'error');
    }
  }

  // ── Final result ──────────────────────────────────────────────────────────
  var success = totalSubmitted > 0;
  var finalTotal = rows.slice(0, totalSubmitted).reduce(function(s, r) { return s + r.amount; }, 0);

  _append(
    (success ? '✅' : '❌') + ' **Batch ' + (success ? 'Complete' : 'Failed') + '**\n\n' +
    '| | |\n' +
    '|---|---|\n' +
    '| Submitted | **' + totalSubmitted + '** payments |\n' +
    '| Total sent | **' + toFixed2(finalTotal) + ' ' + token + '** |\n' +
    (totalFailed > 0 ? '| Failed | **' + totalFailed + '** |\n' : '') +
    (batchIds.length ? '| Batch ID | `' + batchIds[0] + '` |\n' : '') +
    '\n' +
    (success ? '*Sends are processing on Arc Testnet.*' : '*Some sends failed — check the log.*'),
    'payments'
  );

  if (success) {
    _toast('✅ ' + totalSubmitted + ' payments sent — ' + toFixed2(finalTotal) + ' ' + token, 'success');
    _log('Batch complete: ' + totalSubmitted + '/' + rows.length + ' submitted', 'success');
    // Reset CSV state after success
    csvState.loaded = false;
    csvState.rows   = [];
    sessionStorage.removeItem(CSV_STORAGE_KEY);
    // Refresh dashboard
    if (typeof loadDashboard === 'function')  setTimeout(loadDashboard, 1500);
    if (typeof loadPayments  === 'function')  setTimeout(loadPayments,  1500);
  } else {
    _toast('❌ Batch failed', 'error');
  }
};

// ── Open loaded CSV in Multisend panel ────────────────────────────────────────
window.csvOpenInMultisend = function() {
  if (!csvState.rows.length) return;

  // Populate the multisend panel
  var container = document.getElementById('multisend-rows');
  if (container && typeof addMultisendRow === 'function') {
    container.innerHTML = '';
    if (typeof initMultisend === 'function') { window._rowCounterSave = true; }
    csvState.rows.forEach(function(r) {
      addMultisendRow(r.address, r.amount, r.note);
    });
    // Auto-fill sender
    var fromInp = document.getElementById('pay-from');
    if (fromInp && window.walletState?.address && !fromInp.value) {
      fromInp.value = window.walletState.address;
    }
    if (typeof updateMultisendTotal === 'function') updateMultisendTotal();
  }

  // Switch to multisend tab
  if (typeof switchTab === 'function') { switchTab('multisend'); }
  if (typeof toggleChat === 'function') { toggleChat(); }

  _append(
    '✏️ **CSV loaded into Multisend panel** (' + csvState.rows.length + ' rows)\n\n' +
    'Review and edit before sending. Click **Send All** when ready.',
    'payments'
  );
};

// ── Cancel CSV upload ─────────────────────────────────────────────────────────
window.csvCancelUpload = function() {
  csvState.loaded   = false;
  csvState.rows     = [];
  csvState.fileName = '';
  csvState.pendingAmountRequest = false;
  sessionStorage.removeItem(CSV_STORAGE_KEY);
  _append('↩️ **CSV cancelled.** No transactions executed.', 'payments');
};

// ── "Reuse last CSV" command ──────────────────────────────────────────────────
window.csvReuseLastCSV = function() {
  var ok = loadPersistedCSV();
  if (!ok || !csvState.rows.length) {
    _append('ℹ️ No recent CSV found. Upload a new file using the **📎** button in the chat input.', 'payments');
    return;
  }
  var preview = buildPreviewMessage(csvState.rows, csvState.invalidRows, csvState.fileName, csvState.token);
  _append('♻️ **Reusing last CSV:** ' + escapeForChat(csvState.fileName) + '\n\n' + preview, 'payments');
  _card([
    { label: '✅ Execute Permit2 Batch',  action: 'window.csvExecuteBatch()',    primary: true, success: true },
    { label: '✏️ Edit in Multisend',       action: 'window.csvOpenInMultisend()', primary: false },
    { label: '✕ Cancel',                   action: 'window.csvCancelUpload()',    danger: true },
  ]);
};

// ── Download CSV template ─────────────────────────────────────────────────────
window.csvDownloadTemplate = function(format) {
  var templates = {
    A: 'address,amount,note,priority\n' +
       '0xB815A0c4bC23930119324d4359dB65e27A846A2d,10.00,Consulting payment,medium\n' +
       '0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634,25.50,License fee,high\n' +
       '0xC927B1d3fE6e12B1b72E3E5F3e3c5A7B9d4F2E1A,5.00,Reimbursement,low',
    B: 'address\n' +
       '0xB815A0c4bC23930119324d4359dB65e27A846A2d\n' +
       '0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634\n' +
       '0xC927B1d3fE6e12B1b72E3E5F3e3c5A7B9d4F2E1A',
    C: 'address,amount,token,note\n' +
       '0xB815A0c4bC23930119324d4359dB65e27A846A2d,10.00,USDC,Payment A\n' +
       '0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634,5.00,EURC,Payment B\n' +
       '0xC927B1d3fE6e12B1b72E3E5F3e3c5A7B9d4F2E1A,15.00,USDC,Payment C',
  };
  var fmt  = (format || 'A').toUpperCase();
  var csv  = templates[fmt] || templates.A;
  var name = 'execdaat_batch_template_format_' + fmt.toLowerCase() + '.csv';
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  _append('⬇️ **Template downloaded:** `' + name + '`\n\nFill it in and upload using the **📎** button.', 'payments');
};

// ── Server-side validate (for large batches, optional) ────────────────────────
window.csvServerValidate = async function() {
  if (!csvState.rows.length) return;
  try {
    var res = await (async function() {
   console.log('[fetch] POST', '/api/csv/validate');
   try {
     var _r = await fetch('/api/csv/validate', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      rows:  csvState.rows,
      token: csvState.token,
    })});
     if (!_r.ok) { var _e = new Error('POST failed: '+_r.status); _e.response={data:await _r.json().catch(function(){return null;}),status:_r.status}; throw _e; }
     var _d = await _r.json().catch(function(){return null;});
     console.log('[fetch] POST OK', '/api/csv/validate', _r.status);
     return {data:_d, status:_r.status};
   } catch(_ex) { console.error('[fetch] POST ERR', '/api/csv/validate', _ex.message); throw _ex; }
 }());
    var d = res.data;
    _append(
      '🔍 **Server validation result:**\n\n' +
      '| | |\n|---|---|\n' +
      '| Valid rows | **' + d.valid + '** |\n' +
      '| Invalid | **' + d.invalid + '** |\n' +
      '| Total | **' + d.total + ' ' + d.token + '** |\n\n' +
      (d.errors && d.errors.length
        ? '**Errors:** ' + d.errors.map(function(e) { return 'row ' + e.index + ': ' + e.errs.join(', '); }).join(' · ')
        : '✅ All rows valid.'),
      'payments'
    );
  } catch(e) {
    _log('Server validation error: ' + e.message, 'error');
  }
};

// ── Global exports ────────────────────────────────────────────────────────────
window.chatCSVState          = csvState;
window.handleChatCSVFile     = handleChatCSVFile;
window.handleCSVAmountReply  = handleCSVAmountReply;
window.handleCSVSendCommand  = handleCSVSendCommand;
window.csvParseOnly          = parseCSV;
window.csvProcessRows        = processRows;
window.csvBuildPreview       = buildPreviewMessage;

// ── Auto-load persisted CSV on page load ──────────────────────────────────────
(function() {
  var ok = loadPersistedCSV();
  if (ok && csvState.rows.length > 0) {
    console.log('[CSV] Restored ' + csvState.rows.length + ' rows from session (' + csvState.fileName + ')');
  }
})();

console.log('[CSV] Module loaded — max ' + MAX_CSV_ROWS + ' rows, chunk size ' + MAX_CHUNK_SIZE);

})(); // end IIFE
