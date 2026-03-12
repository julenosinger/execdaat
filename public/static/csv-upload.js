// ============================================================
// CSV BATCH UPLOAD + MULTI-SEND MODULE
// ARC AI Agents — parser RFC-4180 puro (sem dependências)
// ============================================================

// ── Constantes ────────────────────────────────────────────
const MAX_ROWS       = 500;
const MAX_AMOUNT_ROW = 10000;
let   rowCounter     = 0;        // id incremental para linhas

// ── Helpers ───────────────────────────────────────────────
function isValidEthAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(addr || '').trim());
}

function toFixed4(n) {
  return Number(n || 0).toFixed(4);
}

// ── Atualizar total no cabeçalho ──────────────────────────
function updateMultisendTotal() {
  let total = 0;
  document.querySelectorAll('.ms-amount-input').forEach(inp => {
    const v = parseFloat(inp.value);
    if (!isNaN(v) && v > 0) total += v;
  });
  const el = document.getElementById('multisend-total');
  if (el) el.innerHTML = `${toFixed4(total)} <span class="text-sm text-gray-400 font-normal">USDC</span>`;
}

// ── Criar uma linha de destinatário ───────────────────────
function createRow(address = '', amount = '', note = '') {
  const id  = ++rowCounter;
  const div = document.createElement('div');
  div.id    = `ms-row-${id}`;
  div.className = 'grid grid-cols-12 gap-3 px-5 py-3 items-center hover:bg-gray-800/20 transition-colors';
  div.innerHTML = `
    <div class="col-span-5">
      <input type="text"
        class="ms-addr-input w-full bg-gray-800/80 border border-gray-700 hover:border-gray-600 focus:border-cyan-500 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none font-mono transition-colors"
        placeholder="0x..."
        value="${address}"
        oninput="validateRowAddress(this)">
    </div>
    <div class="col-span-3">
      <input type="number"
        class="ms-amount-input w-full bg-gray-800/80 border border-gray-700 hover:border-gray-600 focus:border-cyan-500 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none transition-colors"
        placeholder="0.00"
        step="0.01"
        min="0"
        value="${amount}"
        oninput="updateMultisendTotal()">
    </div>
    <div class="col-span-3">
      <input type="text"
        class="ms-note-input w-full bg-gray-800/80 border border-gray-700 hover:border-gray-600 focus:border-gray-500 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none transition-colors"
        placeholder="Nota"
        value="${note}">
    </div>
    <div class="col-span-1 flex justify-center">
      <button onclick="removeRow('ms-row-${id}')"
        class="w-7 h-7 flex items-center justify-center text-gray-600 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-all">
        <i class="fas fa-trash-alt text-xs"></i>
      </button>
    </div>
  `;
  return div;
}

function validateRowAddress(input) {
  const val = input.value.trim();
  if (val && !isValidEthAddress(val)) {
    input.classList.add('border-red-500');
    input.classList.remove('border-gray-700', 'border-cyan-500');
  } else {
    input.classList.remove('border-red-500');
    input.classList.add('border-gray-700');
  }
}

// ── Adicionar linha vazia ─────────────────────────────────
function addMultisendRow(address = '', amount = '', note = '') {
  const container = document.getElementById('multisend-rows');
  if (!container) return;
  container.appendChild(createRow(address, amount, note));
  updateMultisendTotal();
}

// ── Remover linha ─────────────────────────────────────────
function removeRow(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
  updateMultisendTotal();
  ensureMinRows();
}

// ── Garantir mínimo de 2 linhas ───────────────────────────
function ensureMinRows() {
  const container = document.getElementById('multisend-rows');
  if (!container) return;
  while (container.children.length < 2) addMultisendRow();
}

// ── Inicializar painel (2 linhas vazias) ──────────────────
function initMultisend() {
  const container = document.getElementById('multisend-rows');
  if (!container) return;
  container.innerHTML = '';
  rowCounter = 0;
  addMultisendRow();
  addMultisendRow();
}

// ── Coletar linhas preenchidas ────────────────────────────
function collectRows() {
  const from     = (document.getElementById('pay-from')?.value || '').trim();
  const priority = document.getElementById('pay-priority')?.value || 'medium';
  const rows     = [];
  const errors   = [];

  document.querySelectorAll('#multisend-rows > div').forEach((row, i) => {
    const addr   = row.querySelector('.ms-addr-input')?.value.trim()   || '';
    const amt    = row.querySelector('.ms-amount-input')?.value.trim() || '';
    const note   = row.querySelector('.ms-note-input')?.value.trim()   || '';
    if (!addr && !amt) return; // linha vazia — ignorar

    const amount = parseFloat(amt);
    if (!addr)                          errors.push(`Linha ${i+1}: endereço obrigatório`);
    else if (!isValidEthAddress(addr))  errors.push(`Linha ${i+1}: endereço inválido`);
    if (!amt)                           errors.push(`Linha ${i+1}: valor obrigatório`);
    else if (isNaN(amount) || amount<=0)errors.push(`Linha ${i+1}: valor inválido`);
    else if (amount > MAX_AMOUNT_ROW)   errors.push(`Linha ${i+1}: valor excede $${MAX_AMOUNT_ROW}`);

    if (addr && isValidEthAddress(addr) && !isNaN(amount) && amount > 0) {
      rows.push({ from: from || undefined, to: addr, amount, description: note || `Pagamento batch linha ${i+1}`, priority });
    }
  });

  return { rows, errors, from, priority };
}

// ── Analisar (IA) ─────────────────────────────────────────
async function analyzeMultisend() {
  const { rows, errors, from } = collectRows();
  if (errors.length) { showToast(errors[0], 'warning'); return; }
  if (rows.length === 0) { showToast('Adicione pelo menos uma linha', 'warning'); return; }
  if (!from || !isValidEthAddress(from)) { showToast('Preencha o endereço remetente', 'warning'); return; }

  const result_div = document.getElementById('payment-analysis-result');
  try {
    // Analisar primeira linha como prévia
    const r = rows[0];
    const res = await axios.post('/api/payments/analyze', { from: r.from || from, to: r.to, amount: r.amount, description: r.description, priority: r.priority });
    const d = res.data;
    const colors = { low: 'green', medium: 'yellow', high: 'orange', critical: 'red' };
    const c = colors[d.decision.riskLevel] || 'gray';
    result_div.className = `bg-${c}-900/20 border border-${c}-700/40 rounded-xl p-4`;
    result_div.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <h4 class="text-white font-semibold text-sm">Análise IA — ${rows.length} pagamento(s)</h4>
        <span class="text-xs px-2 py-0.5 rounded-full bg-${c}-900/50 text-${c}-400 border border-${c}-700/40">${d.decision.riskLevel.toUpperCase()}</span>
      </div>
      <div class="flex items-center gap-2 mb-1">
        <i class="fas fa-${d.decision.action==='approve'?'check-circle text-green-400':d.decision.action==='reject'?'times-circle text-red-400':'exclamation-circle text-yellow-400'}"></i>
        <span class="text-sm font-medium text-white capitalize">${d.decision.action}</span>
        <span class="text-xs text-gray-400">• Confiança: ${d.decision.confidence}%</span>
      </div>
      <p class="text-xs text-gray-300">${d.decision.reason}</p>
    `;
    result_div.classList.remove('hidden');
    addLog(`[AGENT:PAY] Análise: ${d.decision.action.toUpperCase()} — ${d.decision.riskLevel} risk (${d.decision.confidence}% conf)`, 'agent');
  } catch(e) {
    showToast('Erro na análise: ' + (e.response?.data?.error || e.message), 'error');
  }
}

// ── Submeter multi-send ───────────────────────────────────
async function submitMultisend() {
  const { rows, errors, from } = collectRows();

  if (errors.length) { showToast(errors[0], 'warning'); return; }
  if (rows.length === 0) { showToast('Adicione pelo menos uma linha com endereço e valor', 'warning'); return; }
  if (!from || !isValidEthAddress(from)) { showToast('Preencha o endereço remetente (campo "De")', 'warning'); return; }

  const btn = document.querySelector('button[onclick="submitMultisend()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Enviando...'; }

  try {
    const payments = rows.map(r => ({ ...r, from }));
    const res = await axios.post('/api/payments/batch', { payments, fileName: 'multisend' });
    const d = res.data;
    showToast(`✅ ${d.submitted} pagamento(s) na fila — $${Number(d.totalAmount).toFixed(2)} USDC`, 'success');
    addLog(`[MULTI-SEND] ${d.submitted} pagamentos enviados | $${Number(d.totalAmount).toFixed(2)} USDC | batchId: ${d.batchId}`, 'success');
    initMultisend();
    await loadPayments();
    if (typeof loadDashboard === 'function') await loadDashboard();
  } catch(e) {
    showToast('Erro: ' + (e.response?.data?.error || e.message), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Enviar Tudo'; }
  }
}

// ════════════════════════════════════════════════════════
// PARSER CSV
// ════════════════════════════════════════════════════════
function parseCSVText(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return { headers: [], rows: [] };

  const sep = lines[0].includes(';') ? ';' : ',';

  function splitLine(line) {
    const result = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQ && line[i+1]==='"') { cur+='"'; i++; } else inQ=!inQ; }
      else if (ch === sep && !inQ) { result.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    result.push(cur.trim());
    return result;
  }

  const headers = splitLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9_]/g,''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = splitLine(line);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] || '').trim(); });
    rows.push(obj);
  }
  return { headers, rows };
}

function normalizeRow(raw) {
  const addrKeys = ['address','to','to_address','wallet','wallet_address','destination','recipient','endereco','endereço'];
  const amtKeys  = ['amount','value','usdc','quantidade','valor','qtd'];
  const noteKeys = ['note','description','memo','notes','descricao','descrição','observacao'];
  const prioKeys = ['priority','prio','prioridade'];

  const find = (keys) => { for (const k of keys) if (raw[k] !== undefined) return raw[k]; return ''; };
  return {
    address : find(addrKeys),
    amount  : find(amtKeys).replace(',','.'),
    note    : find(noteKeys),
    priority: find(prioKeys) || 'medium',
  };
}

// ── Mostrar erro no banner ────────────────────────────────
function showCSVBanner(msg) {
  const banner = document.getElementById('csv-error-banner');
  const text   = document.getElementById('csv-error-text');
  if (banner && text) { text.textContent = msg; banner.classList.remove('hidden'); }
  setTimeout(() => { if (banner) banner.classList.add('hidden'); }, 6000);
}

// ── Processar arquivo CSV ─────────────────────────────────
function handleCSVFile(file) {
  if (!file) return;
  const name = file.name.toLowerCase();
  if (!name.endsWith('.csv') && !name.endsWith('.txt')) {
    showCSVBanner('Use arquivos .csv. Para Excel: Arquivo → Salvar como → CSV.');
    if (typeof showToast === 'function') showToast('Formato inválido. Use .csv', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const { rows } = parseCSVText(e.target.result);
      if (rows.length === 0) { showCSVBanner('CSV sem dados (verifique cabeçalhos).'); return; }
      if (rows.length > MAX_ROWS) { showCSVBanner(`CSV com ${rows.length} linhas. Máximo: ${MAX_ROWS}.`); return; }

      const senderAddr = window.walletState?.address || '';
      const valid = [], invalid = [];

      rows.forEach((raw, idx) => {
        const r    = normalizeRow(raw);
        const errs = [];
        const amt  = parseFloat(r.amount);
        if (!r.address)                             errs.push('endereço obrigatório');
        else if (!isValidEthAddress(r.address))     errs.push('endereço EVM inválido');
        if (!r.amount)                              errs.push('valor obrigatório');
        else if (isNaN(amt) || amt <= 0)            errs.push('valor inválido');
        else if (amt > MAX_AMOUNT_ROW)              errs.push(`valor > $${MAX_AMOUNT_ROW}`);

        if (errs.length) invalid.push({ line: idx+2, errs });
        else valid.push({ address: r.address, amount: amt, note: r.note, priority: r.priority });
      });

      // Preencher painel multi-send
      const container = document.getElementById('multisend-rows');
      if (container) {
        container.innerHTML = '';
        rowCounter = 0;
        valid.forEach(r => addMultisendRow(r.address, r.amount, r.note));
        if (container.children.length === 0) { addMultisendRow(); addMultisendRow(); }
      }

      // Auto-preencher remetente
      if (senderAddr) {
        const fromInp = document.getElementById('pay-from');
        if (fromInp && !fromInp.value) fromInp.value = senderAddr;
      }

      updateMultisendTotal();

      // Feedback
      const skipped = invalid.length;
      if (typeof showToast === 'function') {
        showToast(
          `✅ ${valid.length} linha(s) carregada(s)` + (skipped ? ` · ${skipped} ignorada(s)` : ''),
          skipped ? 'warning' : 'success'
        );
      }
      if (typeof addLog === 'function') {
        addLog(`[CSV] ${file.name}: ${valid.length} linhas válidas, ${skipped} erros`, skipped ? 'warning' : 'success');
      }

      // Mostrar erros no banner se houver
      if (invalid.length) {
        const msg = invalid.slice(0,3).map(r => `Linha ${r.line}: ${r.errs.join(', ')}`).join(' | ')
                  + (invalid.length > 3 ? ` (+${invalid.length-3} mais)` : '');
        showCSVBanner(msg);
      }

      // Reset input
      const inp = document.getElementById('csv-file-input');
      if (inp) inp.value = '';

    } catch(err) {
      showCSVBanner('Falha ao parsear CSV: ' + err.message);
    }
  };
  reader.readAsText(file, 'UTF-8');
}

// ── Download template ─────────────────────────────────────
function downloadCSVTemplate() {
  const csv = [
    'address,amount,note,priority',
    '0xB815A0c4bC23930119324d4359dB65e27A846A2d,10.00,Pagamento consultoria,medium',
    '0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634,25.50,Taxa de licença de software,high',
    '0xC927B1d3fE6e12B1b72E3E5F3e3c5A7B9d4F2E1A,5.00,Reembolso de despesas,low',
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'arc_batch_payments_template.csv'; a.click();
  URL.revokeObjectURL(url);
}

// ── Inicializar ao carregar ───────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMultisend();
});
