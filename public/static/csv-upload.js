// ============================================================
// CSV BATCH UPLOAD MODULE
// ARC AI Agents - Pagamentos em Lote via CSV
// Parser puro JS, sem bibliotecas externas
// ============================================================

const CSVUpload = (() => {
  // ── Estado ──────────────────────────────────────────────
  let parsedRows   = [];   // linhas válidas
  let invalidRows  = [];   // linhas com erro
  let senderAddr   = '';   // endereço "from" da wallet conectada

  // ── Constantes ─────────────────────────────────────────
  const MAX_ROWS        = 500;
  const MAX_AMOUNT_ROW  = 10000; // USDC por linha
  const USDC_DECIMALS   = 6;

  // ── Helpers ─────────────────────────────────────────────
  function isValidEthAddress(addr) {
    return /^0x[0-9a-fA-F]{40}$/.test(String(addr || '').trim());
  }

  function toFixed2(n) {
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ── Parser CSV (RFC-4180 simplificado) ──────────────────
  function parseCSVText(text) {
    // Normalise line endings
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    if (lines.length < 2) return { headers: [], rows: [] };

    // Detectar separador: vírgula ou ponto-e-vírgula
    const firstLine = lines[0];
    const sep = firstLine.includes(';') ? ';' : ',';

    function splitLine(line) {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
          else inQuotes = !inQuotes;
        } else if (ch === sep && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      result.push(current.trim());
      return result;
    }

    const headers = splitLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, ''));
    const rows    = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cells = splitLine(line);
      const obj   = {};
      headers.forEach((h, idx) => { obj[h] = (cells[idx] || '').trim(); });
      rows.push(obj);
    }

    return { headers, rows };
  }

  // ── Normalizar nomes de colunas ──────────────────────────
  //  Aceita variantes como "wallet_address", "to_address", "destination", etc.
  function normalizeHeaders(rawObj) {
    const normalizeMap = {
      address    : ['address','to','to_address','wallet','wallet_address','destination','recipient','endereco','endereço'],
      amount     : ['amount','value','usdc','quantidade','valor','qtd'],
      note       : ['note','description','memo','notes','descricao','descrição','observacao'],
      priority   : ['priority','prio','prioridade'],
    };

    const out = {};
    Object.keys(rawObj).forEach(key => {
      for (const [norm, aliases] of Object.entries(normalizeMap)) {
        if (aliases.includes(key)) { out[norm] = rawObj[key]; break; }
      }
      if (!out[key]) out[key] = rawObj[key]; // keep unknown
    });
    return out;
  }

  // ── Validar e classificar linhas ────────────────────────
  function validateRows(rawRows, fromAddr) {
    const valid   = [];
    const invalid = [];

    rawRows.forEach((raw, idx) => {
      const row  = normalizeHeaders(raw);
      const errs = [];
      const lineNum = idx + 2; // 1-based + header

      const address  = (row.address  || '').trim();
      const amountRaw= (row.amount   || '').trim().replace(',', '.');
      const note     = (row.note     || row.description || row.memo || '').trim();
      const priority = (row.priority || 'medium').toLowerCase().trim();

      if (!address) errs.push('address is required');
      else if (!isValidEthAddress(address)) errs.push(`invalid EVM address: ${address}`);

      const amount = parseFloat(amountRaw);
      if (!amountRaw) errs.push('amount is required');
      else if (isNaN(amount))      errs.push(`invalid amount: ${amountRaw}`);
      else if (amount <= 0)        errs.push('amount must be > 0');
      else if (amount > MAX_AMOUNT_ROW) errs.push(`amount exceeds max $${MAX_AMOUNT_ROW} per row`);

      const validPriorities = ['low','medium','high','critical'];
      const finalPriority = validPriorities.includes(priority) ? priority : 'medium';

      if (errs.length > 0) {
        invalid.push({ lineNum, raw, errors: errs });
      } else {
        valid.push({
          lineNum,
          from        : fromAddr || '(wallet not connected)',
          to          : address,
          amount      : amount,
          amountRaw   : Math.round(amount * Math.pow(10, USDC_DECIMALS)),
          description : note || `CSV batch payment row ${lineNum}`,
          priority    : finalPriority,
        });
      }
    });

    return { valid, invalid };
  }

  // ── Processar arquivo ────────────────────────────────────
  function processFile(file) {
    if (!file) return;

    const name = file.name.toLowerCase();
    if (!name.endsWith('.csv') && !name.endsWith('.txt')) {
      showCSVError('Please upload a .csv file. For Excel files, save as CSV first.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text  = e.target.result;
        const { rows } = parseCSVText(text);

        if (rows.length === 0) {
          showCSVError('CSV has no data rows (or missing headers).');
          return;
        }
        if (rows.length > MAX_ROWS) {
          showCSVError(`CSV has ${rows.length} rows. Maximum is ${MAX_ROWS}.`);
          return;
        }

        // Get sender from connected wallet
        senderAddr = window.walletState?.address || '';

        const { valid, invalid } = validateRows(rows, senderAddr);
        parsedRows  = valid;
        invalidRows = invalid;

        renderPreview(file.name, rows.length);
      } catch (err) {
        showCSVError('Failed to parse CSV: ' + err.message);
      }
    };
    reader.readAsText(file, 'UTF-8');
  }

  // ── Renderizar preview ───────────────────────────────────
  function renderPreview(fileName, totalLines) {
    const container = document.getElementById('csv-preview-container');
    if (!container) return;

    const totalAmount = parsedRows.reduce((s, r) => s + r.amount, 0);
    const hasErrors   = invalidRows.length > 0;

    container.innerHTML = `
      <!-- Summary header -->
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <i class="fas fa-file-csv text-green-400"></i>
          <span class="text-white text-sm font-medium truncate max-w-[160px]" title="${fileName}">${fileName}</span>
        </div>
        <button onclick="CSVUpload.clearFile()" class="text-gray-500 hover:text-red-400 transition-colors text-xs">
          <i class="fas fa-times"></i> Clear
        </button>
      </div>

      <!-- Stats row -->
      <div class="grid grid-cols-3 gap-2 mb-3">
        <div class="bg-green-900/20 border border-green-700/30 rounded-lg p-2 text-center">
          <div class="text-lg font-bold text-green-400">${parsedRows.length}</div>
          <div class="text-xs text-gray-400">Valid</div>
        </div>
        <div class="bg-red-900/20 border border-red-700/30 rounded-lg p-2 text-center">
          <div class="text-lg font-bold text-red-400">${invalidRows.length}</div>
          <div class="text-xs text-gray-400">Errors</div>
        </div>
        <div class="bg-blue-900/20 border border-blue-700/30 rounded-lg p-2 text-center">
          <div class="text-lg font-bold text-blue-400">$${toFixed2(totalAmount)}</div>
          <div class="text-xs text-gray-400">Total USDC</div>
        </div>
      </div>

      <!-- Wallet warning -->
      ${!senderAddr ? `
        <div class="mb-3 p-2 bg-yellow-900/20 border border-yellow-700/30 rounded-lg flex items-center gap-2">
          <i class="fas fa-exclamation-triangle text-yellow-400 text-xs"></i>
          <span class="text-xs text-yellow-400">Connect your wallet to set the sender address.</span>
        </div>
      ` : `
        <div class="mb-3 p-2 bg-gray-800/50 rounded-lg">
          <span class="text-xs text-gray-400">From: </span>
          <span class="text-xs text-purple-300 font-mono">${senderAddr.substring(0,10)}...${senderAddr.substring(36)}</span>
        </div>
      `}

      <!-- Errors panel -->
      ${hasErrors ? `
        <div class="mb-3 bg-red-900/20 border border-red-700/30 rounded-lg p-3">
          <div class="text-xs text-red-400 font-medium mb-1.5"><i class="fas fa-times-circle mr-1"></i>${invalidRows.length} row(s) with errors (will be skipped):</div>
          <div class="max-h-28 overflow-y-auto space-y-1">
            ${invalidRows.map(r => `
              <div class="text-xs text-gray-400">Row ${r.lineNum}: <span class="text-red-300">${r.errors.join(', ')}</span></div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Preview table (first 5 rows) -->
      ${parsedRows.length > 0 ? `
        <div class="mb-3">
          <div class="text-xs text-gray-500 mb-1.5 uppercase tracking-wider">Preview (${Math.min(5, parsedRows.length)} of ${parsedRows.length} valid rows)</div>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-gray-500 border-b border-gray-700/30">
                  <th class="text-left py-1 pr-2">To</th>
                  <th class="text-right py-1 pr-2">Amount</th>
                  <th class="text-left py-1">Priority</th>
                </tr>
              </thead>
              <tbody>
                ${parsedRows.slice(0, 5).map(r => `
                  <tr class="border-b border-gray-800/40">
                    <td class="py-1 pr-2 font-mono text-gray-300">${r.to.substring(0,8)}...${r.to.substring(38)}</td>
                    <td class="py-1 pr-2 text-right text-green-400 font-medium">$${toFixed2(r.amount)}</td>
                    <td class="py-1 capitalize text-gray-400">${r.priority}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          ${parsedRows.length > 5 ? `<div class="text-xs text-gray-600 text-center mt-1">... and ${parsedRows.length - 5} more rows</div>` : ''}
        </div>
      ` : ''}

      <!-- Submit button -->
      ${parsedRows.length > 0 ? `
        <button onclick="CSVUpload.submitBatch()"
          class="w-full bg-green-700 hover:bg-green-600 text-white rounded-lg py-2.5 text-sm font-semibold transition-colors flex items-center justify-center gap-2">
          <i class="fas fa-paper-plane"></i>
          Queue ${parsedRows.length} Payment${parsedRows.length > 1 ? 's' : ''}
          <span class="text-green-200 font-normal">($${toFixed2(totalAmount)} USDC)</span>
        </button>
      ` : `
        <div class="text-center text-gray-500 text-xs py-2">No valid rows to submit.</div>
      `}
    `;
    container.classList.remove('hidden');
    document.getElementById('csv-drop-zone')?.classList.add('hidden');
  }

  // ── Submeter batch ───────────────────────────────────────
  async function submitBatch() {
    if (parsedRows.length === 0) {
      if (typeof showToast === 'function') showToast('No valid rows to submit', 'warning');
      return;
    }

    // Refresh sender from wallet
    const from = window.walletState?.address || senderAddr;
    if (!from || !isValidEthAddress(from)) {
      if (typeof showToast === 'function') showToast('Connect your wallet to set the sender address.', 'warning');
      return;
    }

    const payments = parsedRows.map(r => ({
      from       : from,
      to         : r.to,
      amount     : r.amount,
      description: r.description,
      priority   : r.priority,
    }));

    // Disable button
    const btn = document.querySelector('#csv-preview-container button[onclick="CSVUpload.submitBatch()"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Submitting…'; }

    try {
      const res = await axios.post('/api/payments/batch', {
        payments,
        fileName: 'csv-upload',
      });

      const d = res.data;
      if (typeof showToast === 'function')
        showToast(`✅ ${d.submitted} payments queued (${d.skipped} skipped) — $${Number(d.totalAmount).toFixed(2)} USDC total`, 'success');

      if (typeof addLog === 'function')
        addLog(`[CSV] Batch submitted: ${d.submitted} payments, $${Number(d.totalAmount).toFixed(2)} USDC — batchId: ${d.batchId}`, 'success');

      clearFile();
      if (typeof loadPayments === 'function') await loadPayments();
      if (typeof loadDashboard === 'function') await loadDashboard();

    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      if (typeof showToast === 'function') showToast('Batch error: ' + msg, 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-paper-plane mr-2"></i>Queue ${parsedRows.length} Payments`; }
    }
  }

  // ── Limpar ────────────────────────────────────────────────
  function clearFile() {
    parsedRows  = [];
    invalidRows = [];
    const container = document.getElementById('csv-preview-container');
    const dropZone  = document.getElementById('csv-drop-zone');
    const fileInput = document.getElementById('csv-file-input');
    if (container) { container.innerHTML = ''; container.classList.add('hidden'); }
    if (dropZone)  dropZone.classList.remove('hidden');
    if (fileInput) fileInput.value = '';
  }

  // ── Error helper ────────────────────────────────────────
  function showCSVError(msg) {
    if (typeof showToast === 'function') showToast(msg, 'error');
    console.error('[CSV Upload]', msg);
  }

  // ── Download template CSV ────────────────────────────────
  function downloadTemplate() {
    const header = 'address,amount,note,priority';
    const rows   = [
      '0xB815A0c4bC23930119324d4359dB65e27A846A2d,10.00,Payment for consulting services,medium',
      '0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634,25.50,Software license fee,high',
      '0xC927B1d3fE6e12B1b72E3E5F3e3c5A7B9d4F2E1A,5.00,Expense reimbursement,low',
    ];
    const csv    = [header, ...rows].join('\n');
    const blob   = new Blob([csv], { type: 'text/csv' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href       = url;
    a.download   = 'arc_batch_payments_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Public API ───────────────────────────────────────────
  return {
    processFile,
    submitBatch,
    clearFile,
    downloadTemplate,
    get rows()    { return parsedRows; },
    get invalid() { return invalidRows; },
  };
})();

// ── Global helpers chamados pelo HTML ────────────────────────
function handleCSVFile(file) {
  CSVUpload.processFile(file);
}

function downloadCSVTemplate() {
  CSVUpload.downloadTemplate();
}
