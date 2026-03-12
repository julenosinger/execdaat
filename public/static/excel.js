// ============================================================
// ARC AI Agents — Excel Batch Payment Module
// Depende de SheetJS (XLSX) carregado antes deste script
// ============================================================

/* Estado do módulo */
window.excelState = {
  rows: [],          // linhas parseadas e validadas
  fileName: '',
  totalAmount: 0,
  validCount: 0,
  errorCount: 0,
};

// Colunas aceitas (case-insensitive, strip espaços)
const COL_ALIASES = {
  address  : ['address','to','wallet','recipient','destinatário','destinatario','endereço','endereco'],
  amount   : ['amount','value','usdc','qty','quantity','valor','quantidade'],
  note     : ['note','description','memo','notes','obs','observação','observacao','descrição','descricao'],
  priority : ['priority','prioridade','urgency'],
};

// ============================================================
// TEMPLATE — gera e faz download de um .xlsx modelo
// ============================================================
function downloadExcelTemplate() {
  if (typeof XLSX === 'undefined') {
    showToast('SheetJS não carregado ainda. Aguarde e tente novamente.', 'error');
    return;
  }

  const headers = ['address', 'amount', 'note', 'priority'];
  const examples = [
    ['0xB815A0c4bC23930119324d4359dB65e27A846A2d', 10.00, 'Consulting fee – Jan 2026', 'medium'],
    ['0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634',  5.50, 'Expense reimbursement',      'low'],
    ['0xD412E8b7cF5a3B9e1F2D5c8A7b3E6f9d2c5A8B1', 25.00, 'Software license payment',   'high'],
  ];

  const ws = XLSX.utils.aoa_to_sheet([headers, ...examples]);

  // Larguras de coluna
  ws['!cols'] = [{ wch: 46 }, { wch: 12 }, { wch: 35 }, { wch: 10 }];

  // Estilo de cabeçalho (só funciona em xlsx Pro, mas não quebra no padrão)
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payments');

  // Segunda aba de instruções
  const instr = XLSX.utils.aoa_to_sheet([
    ['Column',   'Required', 'Description'],
    ['address',  'YES',      'EVM wallet address (0x…, 42 chars)'],
    ['amount',   'YES',      'USDC amount (e.g. 10.50) — max 10 000'],
    ['note',     'no',       'Description / memo'],
    ['priority', 'no',       'low | medium | high | critical  (default: medium)'],
    [],
    ['USDC address on Arc Testnet:', '0x3600000000000000000000000000000000000000'],
    ['Explorer:',                    'https://testnet.arcscan.app'],
    ['Faucet:',                      'https://faucet.circle.com'],
  ]);
  instr['!cols'] = [{ wch: 24 }, { wch: 10 }, { wch: 55 }];
  XLSX.utils.book_append_sheet(wb, instr, 'Instructions');

  XLSX.writeFile(wb, 'arc_batch_payments_template.xlsx');
  if (typeof addLog === 'function')
    addLog('[EXCEL] Template downloaded: arc_batch_payments_template.xlsx', 'info');
}

// ============================================================
// PARSE — lê ArrayBuffer e retorna linhas normalizadas
// ============================================================
function parseExcelBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  // Converter para JSON com header da primeira linha
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!raw.length) throw new Error('Spreadsheet is empty or has no data rows.');

  // Normalizar nomes de colunas
  const normalizeKey = (k) => String(k).trim().toLowerCase().replace(/\s+/g, '');

  const colMap = {}; // 'address' -> chave real no objeto
  const firstRow = raw[0];
  Object.keys(firstRow).forEach(k => {
    const n = normalizeKey(k);
    Object.entries(COL_ALIASES).forEach(([canonical, aliases]) => {
      if (aliases.includes(n) && !colMap[canonical]) colMap[canonical] = k;
    });
  });

  if (!colMap.address) throw new Error('Column "address" (or alias: to, wallet, recipient…) not found.');
  if (!colMap.amount)  throw new Error('Column "amount" (or alias: value, usdc, qty…) not found.');

  const rows = raw.map((r, i) => {
    const address  = String(r[colMap.address]  || '').trim();
    const rawAmt   = r[colMap.amount];
    const note     = colMap.note     ? String(r[colMap.note]     || '').trim() : '';
    const priority = colMap.priority ? String(r[colMap.priority] || '').trim().toLowerCase() : 'medium';

    // Validações
    const errors = [];
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) errors.push('Invalid EVM address');

    const amount = parseFloat(String(rawAmt).replace(/,/g, '.'));
    if (isNaN(amount) || amount <= 0)      errors.push('Amount must be > 0');
    if (amount > 10000)                    errors.push('Amount exceeds max (10 000 USDC)');

    const validPriorities = ['low','medium','high','critical'];
    const finalPriority = validPriorities.includes(priority) ? priority : 'medium';

    return {
      row    : i + 2,         // linha na planilha (1-indexed + header)
      address,
      amount : isNaN(amount) ? 0 : amount,
      note   : note || `Batch payment row ${i + 2}`,
      priority: finalPriority,
      valid  : errors.length === 0,
      errors,
    };
  });

  return rows;
}

// ============================================================
// HANDLE FILE INPUT — chamado pelo input[type=file]
// ============================================================
function handleExcelFile(file) {
  if (!file) return;

  const allowed = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
  ];
  const extOk = /\.(xlsx|xls|csv)$/i.test(file.name);
  if (!extOk) {
    showToast('Only .xlsx / .xls / .csv files are accepted.', 'error');
    return;
  }

  if (typeof XLSX === 'undefined') {
    showToast('SheetJS not loaded. Please refresh the page.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const rows = parseExcelBuffer(e.target.result);

      const valid  = rows.filter(r => r.valid);
      const errors = rows.filter(r => !r.valid);
      const total  = valid.reduce((s, r) => s + r.amount, 0);

      window.excelState = {
        rows,
        fileName   : file.name,
        totalAmount: total,
        validCount : valid.length,
        errorCount : errors.length,
      };

      renderExcelPreview(rows, file.name);
      if (typeof addLog === 'function')
        addLog(`[EXCEL] Parsed "${file.name}": ${valid.length} valid rows, ${errors.length} errors, total $${total.toFixed(2)} USDC`, valid.length > 0 ? 'success' : 'warning');
    } catch (err) {
      showToast('Parse error: ' + err.message, 'error');
      if (typeof addLog === 'function')
        addLog('[EXCEL] Parse error: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

// ============================================================
// RENDER PREVIEW TABLE
// ============================================================
function renderExcelPreview(rows, fileName) {
  const container = document.getElementById('excel-preview-container');
  if (!container) return;

  const valid   = rows.filter(r => r.valid);
  const invalid = rows.filter(r => !r.valid);
  const total   = valid.reduce((s, r) => s + r.amount, 0);

  const priorityBadge = (p) => ({
    low      : 'bg-gray-700/50 text-gray-300',
    medium   : 'bg-blue-900/40 text-blue-300',
    high     : 'bg-orange-900/40 text-orange-300',
    critical : 'bg-red-900/40 text-red-300',
  }[p] || 'bg-gray-700/50 text-gray-300');

  container.innerHTML = `
    <!-- Summary bar -->
    <div class="flex flex-wrap gap-3 mb-4">
      <div class="flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2 text-sm">
        <i class="fas fa-file-excel text-green-400"></i>
        <span class="text-white font-medium truncate max-w-[160px]" title="${fileName}">${fileName}</span>
      </div>
      <div class="flex items-center gap-2 bg-green-900/30 border border-green-700/30 rounded-lg px-3 py-2 text-sm">
        <i class="fas fa-check-circle text-green-400"></i>
        <span class="text-green-400 font-semibold">${valid.length}</span>
        <span class="text-gray-400">valid rows</span>
      </div>
      ${invalid.length > 0 ? `
      <div class="flex items-center gap-2 bg-red-900/30 border border-red-700/30 rounded-lg px-3 py-2 text-sm">
        <i class="fas fa-exclamation-triangle text-red-400"></i>
        <span class="text-red-400 font-semibold">${invalid.length}</span>
        <span class="text-gray-400">errors</span>
      </div>` : ''}
      <div class="flex items-center gap-2 bg-purple-900/30 border border-purple-700/30 rounded-lg px-3 py-2 text-sm ml-auto">
        <i class="fas fa-coins text-purple-400"></i>
        <span class="text-white font-bold">$${total.toFixed(2)}</span>
        <span class="text-purple-400">USDC total</span>
      </div>
    </div>

    <!-- Table -->
    <div class="overflow-x-auto rounded-xl border border-gray-700/40">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-gray-800/80 text-gray-400 text-xs uppercase tracking-wider">
            <th class="px-3 py-2.5 text-left w-6">#</th>
            <th class="px-3 py-2.5 text-left">Address</th>
            <th class="px-3 py-2.5 text-right">Amount (USDC)</th>
            <th class="px-3 py-2.5 text-left hidden sm:table-cell">Note</th>
            <th class="px-3 py-2.5 text-center">Priority</th>
            <th class="px-3 py-2.5 text-center">Status</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-700/30">
          ${rows.map(r => `
            <tr class="${r.valid ? 'hover:bg-gray-800/30' : 'bg-red-900/10'} transition-colors">
              <td class="px-3 py-2.5 text-gray-500 text-xs">${r.row}</td>
              <td class="px-3 py-2.5 font-mono text-xs ${r.valid ? 'text-gray-300' : 'text-red-400'}">
                ${r.address ? r.address.slice(0,10)+'…'+r.address.slice(-6) : '<em class="text-red-400">missing</em>'}
              </td>
              <td class="px-3 py-2.5 text-right font-semibold ${r.valid ? 'text-white' : 'text-red-400'}">
                $${r.amount.toFixed(2)}
              </td>
              <td class="px-3 py-2.5 text-gray-400 text-xs hidden sm:table-cell max-w-[180px] truncate" title="${r.note}">
                ${r.note}
              </td>
              <td class="px-3 py-2.5 text-center">
                <span class="text-xs px-2 py-0.5 rounded-full ${priorityBadge(r.priority)}">${r.priority}</span>
              </td>
              <td class="px-3 py-2.5 text-center">
                ${r.valid
                  ? '<i class="fas fa-check-circle text-green-400 text-base"></i>'
                  : `<span class="text-red-400 text-xs" title="${r.errors.join('; ')}"><i class="fas fa-times-circle mr-1"></i>${r.errors[0]}</span>`
                }
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- Action buttons -->
    <div class="flex flex-wrap gap-2 mt-4">
      ${valid.length > 0 ? `
        <button onclick="submitExcelBatch()"
          class="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-5 py-2.5 text-sm font-semibold transition-all shadow-lg shadow-purple-900/30">
          <i class="fas fa-paper-plane"></i>
          Submit ${valid.length} payments to AI Agent
        </button>
        <button onclick="downloadValidRows()"
          class="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white rounded-xl px-4 py-2.5 text-sm font-medium transition-colors">
          <i class="fas fa-download"></i>Export valid rows
        </button>
      ` : ''}
      ${invalid.length > 0 ? `
        <button onclick="downloadErrorReport()"
          class="flex items-center gap-2 bg-red-900/40 hover:bg-red-800/40 border border-red-700/40 text-red-400 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors">
          <i class="fas fa-bug"></i>Download error report
        </button>
      ` : ''}
      <button onclick="clearExcelUpload()"
          class="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-xl px-4 py-2.5 text-sm transition-colors ml-auto">
        <i class="fas fa-trash-alt"></i>Clear
      </button>
    </div>
  `;

  // Scroll suave até o preview
  container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================================
// SUBMIT BATCH — envia as linhas válidas para /api/payments/batch
// ============================================================
async function submitExcelBatch() {
  const { rows, fileName } = window.excelState;
  const valid = rows.filter(r => r.valid);
  if (!valid.length) {
    showToast('No valid rows to submit.', 'warning');
    return;
  }

  const from = (window.walletState && window.walletState.address) || '';
  if (!from) {
    showToast('Please connect your EVM wallet first.', 'warning');
    if (typeof openWalletModal === 'function') openWalletModal();
    return;
  }

  // Montar payload
  const payments = valid.map(r => ({
    from,
    to          : r.address,
    amount      : r.amount,
    description : r.note,
    priority    : r.priority,
  }));

  // Desabilitar botão durante envio
  const btn = document.querySelector('[onclick="submitExcelBatch()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Submitting…'; }

  try {
    const res = await axios.post('/api/payments/batch', { payments, fileName });
    const data = res.data;

    showToast(`✅ ${data.submitted} payments queued for AI analysis!`, 'success');
    if (typeof addLog === 'function')
      addLog(`[EXCEL] Batch submitted: ${data.submitted} payments, total $${data.totalAmount.toFixed(2)} USDC`, 'success');

    // Mostrar resultado inline
    const container = document.getElementById('excel-preview-container');
    if (container) {
      const resultBanner = document.createElement('div');
      resultBanner.className = 'mt-4 p-4 bg-green-900/30 border border-green-700/40 rounded-xl';
      resultBanner.innerHTML = `
        <div class="flex items-center gap-2 mb-2">
          <i class="fas fa-check-circle text-green-400 text-lg"></i>
          <span class="text-white font-semibold">Batch submitted successfully!</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><div class="text-gray-400 text-xs">Queued</div><div class="text-white font-bold">${data.submitted}</div></div>
          <div><div class="text-gray-400 text-xs">Total USDC</div><div class="text-white font-bold">$${data.totalAmount.toFixed(2)}</div></div>
          <div><div class="text-gray-400 text-xs">Batch ID</div><div class="text-purple-400 text-xs font-mono">${data.batchId}</div></div>
          <div><div class="text-gray-400 text-xs">Network</div><div class="text-green-400 text-xs">Arc Testnet</div></div>
        </div>
        <div class="mt-3 flex gap-2">
          <button onclick="switchTab('payments'); loadPayments();"
            class="text-xs bg-purple-600 hover:bg-purple-700 text-white rounded-lg px-3 py-1.5 transition-colors">
            <i class="fas fa-list mr-1"></i>View Queue
          </button>
          <button onclick="processPayments()"
            class="text-xs bg-green-700 hover:bg-green-600 text-white rounded-lg px-3 py-1.5 transition-colors">
            <i class="fas fa-play mr-1"></i>Process Now
          </button>
        </div>
      `;
      container.appendChild(resultBanner);
    }

    // Recarregar fila
    if (typeof loadPayments === 'function') loadPayments();

  } catch (err) {
    const msg = err?.response?.data?.error || err.message;
    showToast('Submission error: ' + msg, 'error');
    if (typeof addLog === 'function')
      addLog('[EXCEL] Batch submission error: ' + msg, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-paper-plane mr-2"></i>Submit ${valid.length} payments to AI Agent`; }
  }
}

// ============================================================
// EXPORT HELPERS
// ============================================================
function downloadValidRows() {
  const valid = window.excelState.rows.filter(r => r.valid);
  if (!valid.length) return;

  const data = [
    ['address', 'amount', 'note', 'priority'],
    ...valid.map(r => [r.address, r.amount, r.note, r.priority]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 46 }, { wch: 12 }, { wch: 40 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ValidPayments');
  XLSX.writeFile(wb, 'arc_valid_payments.xlsx');
}

function downloadErrorReport() {
  const invalid = window.excelState.rows.filter(r => !r.valid);
  if (!invalid.length) return;

  const data = [
    ['row', 'address', 'amount', 'note', 'priority', 'errors'],
    ...invalid.map(r => [r.row, r.address, r.amount, r.note, r.priority, r.errors.join('; ')]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 5 }, { wch: 46 }, { wch: 10 }, { wch: 35 }, { wch: 10 }, { wch: 60 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Errors');
  XLSX.writeFile(wb, 'arc_payments_errors.xlsx');
}

// ============================================================
// CLEAR
// ============================================================
function clearExcelUpload() {
  window.excelState = { rows: [], fileName: '', totalAmount: 0, validCount: 0, errorCount: 0 };
  const container = document.getElementById('excel-preview-container');
  if (container) container.innerHTML = '';
  const input = document.getElementById('excel-file-input');
  if (input) input.value = '';
  const dropZone = document.getElementById('excel-drop-zone');
  if (dropZone) dropZone.classList.remove('border-purple-500', 'bg-purple-900/10');
}
