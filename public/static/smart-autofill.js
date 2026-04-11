// ============================================================
// ARC SMART AUTOFILL v2 — STATELESS (Privacy-First)
// Only shows deterministic preset amount chips.
// NO email suggestions, NO name autofill, NO address history.
// NO data capture. Fully stateless.
// ============================================================
'use strict';

(function () {

  // ─── CSS ─────────────────────────────────────────────────────────────────────
  const CSS = `
  .arc-af-row {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 5px;
    min-height: 0;
  }
  .arc-af-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid rgba(55,138,221,0.3);
    background: rgba(55,138,221,0.08);
    color: #90bce0;
    transition: all 0.15s ease;
    user-select: none;
  }
  .arc-af-chip:hover {
    border-color: rgba(55,138,221,0.55);
    background: rgba(55,138,221,0.16);
    color: #c5ddf5;
  }
  .arc-af-chip.arc-af-amount {
    border-color: rgba(29,158,117,0.3);
    background: rgba(29,158,117,0.08);
    color: #34d399;
  }
  .arc-af-chip.arc-af-amount:hover {
    border-color: rgba(29,158,117,0.55);
    background: rgba(29,158,117,0.16);
  }
  .arc-af-suggest-box {
    margin-top: 4px;
    padding: 6px 8px;
    border-radius: 9px;
    background: rgba(15,23,42,0.6);
    border: 1px solid rgba(55,138,221,0.12);
  }
  .arc-af-suggest-label {
    font-size: 9px;
    font-weight: 700;
    color: #5a7898;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  `;

  function injectCSS() {
    if (document.getElementById('arc-af-styles')) return;
    const s = document.createElement('style');
    s.id = 'arc-af-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(id) { return document.getElementById(id); }

  // ─── Suggest box builder ──────────────────────────────────────────────────────
  function makeSuggestBox(id, label, icon) {
    const old = document.getElementById(id);
    if (old) old.remove();

    const box = document.createElement('div');
    box.id = id;
    box.className = 'arc-af-suggest-box';
    box.innerHTML = `
      <div class="arc-af-suggest-label">
        <i class="fas ${icon}" style="font-size:9px;"></i>${label}
      </div>
      <div id="${id}-chips" class="arc-af-row"></div>
    `;
    return box;
  }

  function makeChip(text, onClick, extraClass) {
    const chip = document.createElement('span');
    chip.className = 'arc-af-chip' + (extraClass ? ' ' + extraClass : '');
    chip.textContent = text;
    chip.addEventListener('click', onClick);
    return chip;
  }

  function insertAfterField(fieldId, box) {
    const inp = el(fieldId);
    if (!inp) return;
    const parent = inp.closest('.arc-af-field-wrap') || inp.parentElement;
    if (!parent) return;
    const hint = parent.querySelector('[id^="pay-hint-"], [id^="cf-hint-"]');
    if (hint) {
      parent.insertBefore(box, hint.nextSibling || null);
    } else {
      parent.appendChild(box);
    }
  }

  // ─── PAYMENTS: Amount presets (deterministic, never from storage) ─────────────
  const PAY_PRESET_AMOUNTS = [
    { value: '10',   token: 'USDC' },
    { value: '25',   token: 'USDC' },
    { value: '50',   token: 'USDC' },
    { value: '100',  token: 'USDC' },
    { value: '250',  token: 'USDC' },
    { value: '500',  token: 'USDC' },
    { value: '1000', token: 'USDC' },
  ];

  function buildPayAmountSuggestions() {
    const box = makeSuggestBox('arc-af-pay-amts', 'Quick Amounts', 'fa-coins');
    const chipsRow = box.querySelector('#arc-af-pay-amts-chips');

    PAY_PRESET_AMOUNTS.forEach(item => {
      const chip = makeChip(`${item.value} ${item.token}`,
        () => {
          const inp = el('pay-amount');
          if (inp) { inp.value = item.value; inp.dispatchEvent(new Event('input')); }
          if (typeof selectPayToken === 'function') selectPayToken(item.token);
          if (typeof updatePayPreview === 'function') updatePayPreview();
          if (typeof payValidateForm === 'function') payValidateForm();
        },
        'arc-af-amount'
      );
      chipsRow.appendChild(chip);
    });

    insertAfterField('pay-amount', box);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    injectCSS();
    buildPayAmountSuggestions();
  }

  // Run after DOM + scripts loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 400));
  } else {
    setTimeout(init, 400);
  }

  // Re-init when payments tab opens
  window.addEventListener('arcTabOpened', (e) => {
    if (e?.detail?.tab === 'payments') setTimeout(buildPayAmountSuggestions, 200);
  });

  // No-op capture functions (kept for API compatibility)
  window.arcCapturePaymentData  = function() { /* stateless — no capture */ };
  window.arcCaptureContractData = function() { /* stateless — no capture */ };

})();
