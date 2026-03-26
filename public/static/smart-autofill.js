// ============================================================
// ARC SMART AUTOFILL v1 — Intelligent Form Auto-Fill & Suggestions
// Auto-fills: name, email, wallet, token, amount, recipient
// Shows: chips for addresses, emails, amounts; dropdown for tokens
// Tabs: Payments (pay-*) + Contracts (cf-*)
// ============================================================
'use strict';

(function () {

  // ─── CSS Injection ───────────────────────────────────────────────────────────
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
    transition: all 0.18s;
    user-select: none;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .arc-af-chip:hover {
    background: rgba(55,138,221,0.18);
    border-color: rgba(55,138,221,0.55);
    color: #b8d9f5;
  }
  .arc-af-chip .arc-af-remove {
    opacity: 0;
    font-size: 10px;
    color: #ff7070;
    transition: opacity 0.15s;
    flex-shrink: 0;
    padding: 0 1px;
    line-height: 1;
    cursor: pointer;
  }
  .arc-af-chip:hover .arc-af-remove {
    opacity: 1;
  }
  .arc-af-chip.arc-af-email {
    border-color: rgba(167,139,250,0.3);
    background: rgba(167,139,250,0.07);
    color: #c4b5fd;
  }
  .arc-af-chip.arc-af-email:hover {
    background: rgba(167,139,250,0.16);
    border-color: rgba(167,139,250,0.55);
  }
  .arc-af-chip.arc-af-amount {
    border-color: rgba(52,211,153,0.3);
    background: rgba(52,211,153,0.06);
    color: #6ee7b7;
  }
  .arc-af-chip.arc-af-amount:hover {
    background: rgba(52,211,153,0.14);
    border-color: rgba(52,211,153,0.5);
  }
  .arc-af-section {
    margin-top: 6px;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(30,45,65,0.45);
    border: 1px solid rgba(55,138,221,0.12);
  }
  .arc-af-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #5a8aaa;
    margin-bottom: 5px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .arc-af-profile-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 10px;
    background: rgba(55,138,221,0.06);
    border: 1px solid rgba(55,138,221,0.15);
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .arc-af-profile-bar .arc-af-pb-name {
    font-size: 12px;
    font-weight: 600;
    color: #90bce0;
    flex: 1;
  }
  .arc-af-profile-bar .arc-af-pb-email {
    font-size: 11px;
    color: #6a8daa;
  }
  .arc-af-profile-bar .arc-af-pb-edit {
    font-size: 10px;
    color: #60a5fa;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 6px;
    border: 1px solid rgba(96,165,250,0.25);
    background: rgba(96,165,250,0.06);
    transition: all 0.15s;
    white-space: nowrap;
  }
  .arc-af-profile-bar .arc-af-pb-edit:hover {
    background: rgba(96,165,250,0.14);
  }
  .arc-af-privacy-note {
    font-size: 9px;
    color: #4a6a80;
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  `;

  function injectCSS() {
    if (document.getElementById('arc-af-styles')) return;
    const s = document.createElement('style');
    s.id = 'arc-af-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }
  function shortAddr(a) {
    if (!a || a.length < 12) return a || '';
    return a.slice(0, 8) + '…' + a.slice(-6);
  }

  // ─── Profile Bar (shown above Payments & Contracts form) ─────────────────────
  function renderProfileBar(containerId) {
    const wrap = el(containerId);
    if (!wrap) return;
    // Remove old bar
    const old = wrap.querySelector('.arc-af-profile-bar');
    if (old) old.remove();

    const profile = typeof getUserProfile === 'function' ? getUserProfile() : {};
    if (!profile.name && !profile.email) return; // nothing to show

    const bar = document.createElement('div');
    bar.className = 'arc-af-profile-bar';
    bar.innerHTML = `
      <div style="width:28px;height:28px;border-radius:50%;background:rgba(55,138,221,0.15);
        border:1px solid rgba(55,138,221,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-user" style="color:#90bce0;font-size:12px;"></i>
      </div>
      <div style="flex:1;min-width:0;">
        ${profile.name  ? `<div class="arc-af-pb-name">${escHtml(profile.name)}</div>` : ''}
        ${profile.email ? `<div class="arc-af-pb-email">${escHtml(profile.email)}</div>` : ''}
      </div>
      <span class="arc-af-pb-edit" onclick="arcOpenProfileModal()">
        <i class="fas fa-pen" style="font-size:9px;margin-right:3px;"></i>Edit Profile
      </span>
    `;
    wrap.insertBefore(bar, wrap.firstChild);
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ─── Chip renderer ───────────────────────────────────────────────────────────
  function makeChip(text, onClickFn, onRemoveFn, extraClass = '') {
    const chip = document.createElement('span');
    chip.className = 'arc-af-chip ' + extraClass;
    chip.title = text;
    chip.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;">${escHtml(text)}</span>
      <span class="arc-af-remove" title="Remove" onclick="event.stopPropagation();">✕</span>`;
    chip.querySelector('.arc-af-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      onRemoveFn && onRemoveFn();
      chip.remove();
    });
    chip.addEventListener('click', onClickFn);
    return chip;
  }

  // ─── Suggestion container factory ────────────────────────────────────────────
  function makeSuggestBox(id, label, icon) {
    const existing = el(id);
    if (existing) { existing.innerHTML = ''; return existing; }
    const box = document.createElement('div');
    box.id = id;
    box.className = 'arc-af-section';
    box.innerHTML = `<div class="arc-af-label"><i class="fas ${icon}"></i>${label}</div>
      <div class="arc-af-row" id="${id}-chips"></div>`;
    return box;
  }

  // ─── Insert suggestion box after a field's parent element ────────────────────
  function insertAfterField(fieldId, box) {
    const fieldEl = el(fieldId);
    if (!fieldEl) return;
    const parent = fieldEl.closest('div');
    if (!parent) return;
    // Avoid duplicates
    const existBox = el(box.id);
    if (existBox) return;
    parent.parentNode.insertBefore(box, parent.nextSibling);
  }

  // ─── PAYMENTS: Address suggestions ───────────────────────────────────────────
  function buildPayAddressSuggestions() {
    const addresses = typeof getRecentAddresses === 'function' ? getRecentAddresses() : [];
    if (!addresses.length) return;

    const box = makeSuggestBox('arc-af-pay-addrs', 'Recent Recipients', 'fa-history');
    const chipsRow = box.querySelector('#arc-af-pay-addrs-chips');

    addresses.forEach(item => {
      const label = item.label ? `${item.label} (${shortAddr(item.addr)})` : shortAddr(item.addr);
      const chip = makeChip(label,
        () => {
          const inp = el('pay-recipient');
          if (inp) { inp.value = item.addr; inp.dispatchEvent(new Event('input')); }
          if (typeof payValidateField === 'function') payValidateField('recipient');
          if (typeof updatePayPreview === 'function') updatePayPreview();
          if (typeof payValidateForm === 'function') payValidateForm();
        },
        () => {
          if (typeof removeRecentAddress === 'function') removeRecentAddress(item.addr);
        },
        ''
      );
      chipsRow.appendChild(chip);
    });

    insertAfterField('pay-recipient', box);
  }

  // ─── PAYMENTS: Amount suggestions ────────────────────────────────────────────
  function buildPayAmountSuggestions() {
    const amounts = typeof getRecentAmounts === 'function' ? getRecentAmounts() : [];
    if (!amounts.length) return;

    const box = makeSuggestBox('arc-af-pay-amts', 'Recent Amounts', 'fa-coins');
    const chipsRow = box.querySelector('#arc-af-pay-amts-chips');

    amounts.forEach(item => {
      const chip = makeChip(`${item.value} ${item.token}`,
        () => {
          const inp = el('pay-amount');
          if (inp) { inp.value = item.value; inp.dispatchEvent(new Event('input')); }
          if (typeof selectPayToken === 'function') selectPayToken(item.token);
          if (typeof updatePayPreview === 'function') updatePayPreview();
          if (typeof payValidateForm === 'function') payValidateForm();
        },
        () => {
          if (typeof removeRecentAmount === 'function') removeRecentAmount(item.value, item.token);
        },
        'arc-af-amount'
      );
      chipsRow.appendChild(chip);
    });

    insertAfterField('pay-amount', box);
  }

  // ─── PAYMENTS: Email suggestions ─────────────────────────────────────────────
  function buildPayEmailSuggestions() {
    const emails = typeof getRecentEmails === 'function' ? getRecentEmails() : [];
    if (!emails.length) return;

    const box = makeSuggestBox('arc-af-pay-emails', 'Recent Emails', 'fa-envelope');
    const chipsRow = box.querySelector('#arc-af-pay-emails-chips');

    emails.forEach(item => {
      const label = item.label ? `${item.label} <${item.email}>` : item.email;
      const chip = makeChip(label,
        () => {
          // Fill recipient email field
          const recipInp = el('pay-recipient-email');
          if (recipInp) { recipInp.value = item.email; recipInp.dispatchEvent(new Event('input')); }
          if (typeof payValidateField === 'function') payValidateField('recipientEmail');
        },
        () => {
          if (typeof removeRecentEmail === 'function') removeRecentEmail(item.email);
        },
        'arc-af-email'
      );
      chipsRow.appendChild(chip);
    });

    insertAfterField('pay-recipient-email', box);
  }

  // ─── CONTRACTS: Address suggestions ──────────────────────────────────────────
  function buildCfAddressSuggestions() {
    const addresses = typeof getRecentAddresses === 'function' ? getRecentAddresses() : [];
    if (!addresses.length) return;

    const box = makeSuggestBox('arc-af-cf-addrs', 'Recent Contractors', 'fa-history');
    const chipsRow = box.querySelector('#arc-af-cf-addrs-chips');

    addresses.forEach(item => {
      const label = item.label ? `${item.label} (${shortAddr(item.addr)})` : shortAddr(item.addr);
      const chip = makeChip(label,
        () => {
          const inp = el('cf-contractor');
          if (inp) { inp.value = item.addr; inp.dispatchEvent(new Event('input')); }
        },
        () => {
          if (typeof removeRecentAddress === 'function') removeRecentAddress(item.addr);
        },
        ''
      );
      chipsRow.appendChild(chip);
    });

    insertAfterField('cf-contractor', box);
  }

  // ─── CONTRACTS: Amount suggestions ───────────────────────────────────────────
  function buildCfAmountSuggestions() {
    const amounts = typeof getRecentAmounts === 'function' ?
      getRecentAmounts().filter(a => a.token === 'USDC') : [];
    if (!amounts.length) return;

    const box = makeSuggestBox('arc-af-cf-amts', 'Recent Contract Values', 'fa-coins');
    const chipsRow = box.querySelector('#arc-af-cf-amts-chips');

    amounts.forEach(item => {
      const chip = makeChip(`${item.value} USDC`,
        () => {
          const inp = el('cf-value');
          if (inp) {
            inp.value = item.value;
            inp.dispatchEvent(new Event('input'));
            if (typeof cfUpdateMilestoneSum === 'function') cfUpdateMilestoneSum();
            if (typeof cfUpdateFeePreview === 'function') cfUpdateFeePreview();
          }
        },
        () => {
          if (typeof removeRecentAmount === 'function') removeRecentAmount(item.value, 'USDC');
        },
        'arc-af-amount'
      );
      chipsRow.appendChild(chip);
    });

    insertAfterField('cf-value', box);
  }

  // ─── CONTRACTS: Email suggestions ────────────────────────────────────────────
  function buildCfEmailSuggestions() {
    const emails = typeof getRecentEmails === 'function' ? getRecentEmails() : [];
    if (!emails.length) return;

    ['cf-client-email', 'cf-contractor-email'].forEach(fieldId => {
      const boxId = 'arc-af-' + fieldId + '-sugg';
      const box = makeSuggestBox(boxId, 'Recent Emails', 'fa-envelope');
      const chipsRow = box.querySelector(`#${boxId}-chips`);

      emails.forEach(item => {
        const chip = makeChip(item.email,
          () => {
            const inp = el(fieldId);
            if (inp) { inp.value = item.email; inp.dispatchEvent(new Event('input')); }
          },
          () => {
            if (typeof removeRecentEmail === 'function') removeRecentEmail(item.email);
          },
          'arc-af-email'
        );
        chipsRow.appendChild(chip);
      });

      insertAfterField(fieldId, box);
    });
  }

  // ─── Auto-fill form fields ────────────────────────────────────────────────────
  function autofillPayments() {
    const prefs   = typeof getUserPreferences === 'function' ? getUserPreferences() : {};
    if (prefs.autofill === false) return;

    const profile = typeof getUserProfile === 'function' ? getUserProfile() : {};

    // Fill sender name + email
    const nameEl  = el('pay-fullname');
    const emailEl = el('pay-email');
    if (nameEl  && !nameEl.value  && profile.name)  { nameEl.value  = profile.name; }
    if (emailEl && !emailEl.value && profile.email) { emailEl.value = profile.email; }

    // Fill token preference
    const prefToken = prefs.defaultToken || getMostUsedToken?.() || 'USDC';
    if (typeof selectPayToken === 'function') {
      try { selectPayToken(prefToken); } catch (_) {}
    }

    // Re-validate after fill
    setTimeout(() => {
      if (typeof payValidateForm === 'function') payValidateForm();
      if (typeof updatePayPreview === 'function') updatePayPreview();
    }, 150);
  }

  function autofillContracts() {
    const prefs   = typeof getUserPreferences === 'function' ? getUserPreferences() : {};
    if (prefs.autofill === false) return;

    const profile = typeof getUserProfile === 'function' ? getUserProfile() : {};

    // Fill client email with profile email
    const clientEmailEl = el('cf-client-email');
    if (clientEmailEl && !clientEmailEl.value && profile.email) {
      clientEmailEl.value = profile.email;
    }

    // Restore last contract params
    const params = typeof getContractParams === 'function' ? getContractParams() : {};
    if (params && (Date.now() - (params.savedAt || 0)) < 7 * 24 * 60 * 60 * 1000) {
      // Only restore if saved within 7 days and fields are empty
      const fields = {
        'cf-title':           params.title,
        'cf-contractor':      params.contractor,
        'cf-value':           params.totalValue,
        'cf-client-email':    params.clientEmail,
        'cf-contractor-email':params.contractorEmail,
      };
      for (const [id, val] of Object.entries(fields)) {
        const inp = el(id);
        if (inp && !inp.value && val) {
          inp.value = val;
          inp.dispatchEvent(new Event('input'));
        }
      }
    }
  }

  // ─── Capture data on form submit (hook into existing events) ─────────────────
  function capturePaymentData() {
    const recipient = el('pay-recipient')?.value?.trim();
    const amount    = el('pay-amount')?.value?.trim();
    const token     = document.querySelector('.pay-token-btn.active')?.dataset?.token || 'USDC';
    const name      = el('pay-fullname')?.value?.trim();
    const email     = el('pay-email')?.value?.trim();
    const recpEmail = el('pay-recipient-email')?.value?.trim();
    const recpName  = el('pay-recipient-name')?.value?.trim();

    if (name || email) {
      if (typeof saveUserProfile === 'function') {
        const profile = getUserProfile();
        saveUserProfile({ ...profile, name: name || profile.name, email: email || profile.email });
      }
    }
    if (recipient && /^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      if (typeof addRecentAddress === 'function') addRecentAddress(recipient, recpName || '');
    }
    if (amount && !isNaN(parseFloat(amount))) {
      if (typeof addRecentAmount === 'function') addRecentAmount(amount, token);
      if (typeof addRecentToken  === 'function') addRecentToken(token);
    }
    if (recpEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recpEmail)) {
      if (typeof addRecentEmail === 'function') addRecentEmail(recpEmail, recpName || '');
    }
    if (typeof saveUserPreferences === 'function') {
      saveUserPreferences({ defaultToken: token });
    }
  }

  function captureContractData() {
    const contractor      = el('cf-contractor')?.value?.trim();
    const totalValue      = el('cf-value')?.value?.trim();
    const clientEmail     = el('cf-client-email')?.value?.trim();
    const contractorEmail = el('cf-contractor-email')?.value?.trim();
    const title           = el('cf-title')?.value?.trim();

    if (contractor && /^0x[0-9a-fA-F]{40}$/.test(contractor)) {
      if (typeof addRecentAddress === 'function') addRecentAddress(contractor, '');
    }
    if (totalValue && !isNaN(parseFloat(totalValue))) {
      if (typeof addRecentAmount === 'function') addRecentAmount(totalValue, 'USDC');
    }
    if (clientEmail)     { if (typeof addRecentEmail === 'function') addRecentEmail(clientEmail, ''); }
    if (contractorEmail) { if (typeof addRecentEmail === 'function') addRecentEmail(contractorEmail, ''); }

    if (typeof saveContractParams === 'function') {
      saveContractParams({ contractor, totalValue, clientEmail, contractorEmail, title });
    }
  }

  // ─── Hook into form submit buttons ───────────────────────────────────────────
  function hookPaymentSubmit() {
    const btn = el('pay-submit-btn') || document.querySelector('[onclick*="executePayment"]');
    if (btn && !btn.dataset.afHooked) {
      btn.dataset.afHooked = '1';
      btn.addEventListener('click', capturePaymentData, { capture: true });
    }
    // Also hook the main form if there's an onsubmit
    const form = document.querySelector('#pay-form, form[data-module="payments"]');
    if (form && !form.dataset.afHooked) {
      form.dataset.afHooked = '1';
      form.addEventListener('submit', capturePaymentData, { capture: true });
    }
  }

  function hookContractSubmit() {
    const btn = el('cf-submit-btn') || document.querySelector('[onclick*="cfCreateContract"]');
    if (btn && !btn.dataset.afHooked) {
      btn.dataset.afHooked = '1';
      btn.addEventListener('click', captureContractData, { capture: true });
    }
  }

  // ─── Learn from existing history on load ──────────────────────────────────────
  function learnFromExistingHistory() {
    // Listen for payment/contract history events
    window.addEventListener('arcPayHistoryLoaded', (e) => {
      if (e.detail?.items && typeof learnFromPaymentHistory === 'function') {
        learnFromPaymentHistory(e.detail.items);
      }
    });
    window.addEventListener('arcContractHistoryLoaded', (e) => {
      if (e.detail?.contracts && typeof learnFromContractHistory === 'function') {
        learnFromContractHistory(e.detail.contracts);
      }
    });
  }

  // ─── Main initialization ──────────────────────────────────────────────────────
  function initPayAutofill() {
    injectCSS();

    // Profile bar above the payment form
    renderProfileBar('pay-form-top');

    // Auto-fill fields
    autofillPayments();

    // Suggestion chips (only if prefs allow)
    const prefs = typeof getUserPreferences === 'function' ? getUserPreferences() : {};
    if (prefs.showSuggestions !== false) {
      buildPayAddressSuggestions();
      buildPayAmountSuggestions();
      buildPayEmailSuggestions();
    }

    // Hook submit
    hookPaymentSubmit();
  }

  function initContractAutofill() {
    injectCSS();

    // Profile bar above contract form
    renderProfileBar('cf-form-top');

    // Auto-fill
    autofillContracts();

    // Suggestions
    const prefs = typeof getUserPreferences === 'function' ? getUserPreferences() : {};
    if (prefs.showSuggestions !== false) {
      buildCfAddressSuggestions();
      buildCfAmountSuggestions();
      buildCfEmailSuggestions();
    }

    hookContractSubmit();
  }

  // ─── Profile Modal ────────────────────────────────────────────────────────────
  function arcOpenProfileModal() {
    const profile = typeof getUserProfile === 'function' ? getUserProfile() : {};
    const prefs   = typeof getUserPreferences === 'function' ? getUserPreferences() : {};

    // Remove old
    const old = el('arc-profile-modal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.id = 'arc-profile-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);padding:16px;
    `;
    modal.innerHTML = `
      <div style="background:#0f1e2e;border:1px solid rgba(55,138,221,0.25);border-radius:18px;
        padding:28px 28px 22px;max-width:420px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,0.7);
        position:relative;">

        <button onclick="document.getElementById('arc-profile-modal').remove()"
          style="position:absolute;top:14px;right:16px;background:none;border:none;color:#5a8aaa;
          font-size:16px;cursor:pointer;padding:4px 8px;" title="Close">✕</button>

        <h3 style="color:#90bce0;font-size:16px;font-weight:700;margin-bottom:18px;
          display:flex;align-items:center;gap:8px;">
          <i class="fas fa-user-circle" style="color:#60a5fa;"></i>
          My Profile
        </h3>

        <!-- Privacy note -->
        <div class="arc-af-privacy-note" style="margin-bottom:14px;font-size:10px;
          background:rgba(52,211,153,0.05);border:1px solid rgba(52,211,153,0.15);
          border-radius:8px;padding:6px 10px;">
          <i class="fas fa-shield-alt" style="color:#34d399;"></i>
          <span style="color:#5a8070;">All data stored locally on this device only. No private keys ever stored.</span>
        </div>

        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="font-size:10px;font-weight:700;text-transform:uppercase;
              letter-spacing:0.07em;color:#5a8aaa;display:block;margin-bottom:5px;">
              <i class="fas fa-user" style="margin-right:4px;"></i>Your Name
            </label>
            <input id="arc-pm-name" type="text" value="${escHtml(profile.name || '')}"
              placeholder="e.g. Alice Johnson"
              style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(55,138,221,0.2);
              border-radius:8px;padding:9px 12px;color:#c8dff0;font-size:13px;
              outline:none;transition:border 0.15s;"
              onfocus="this.style.borderColor='rgba(55,138,221,0.55)'"
              onblur="this.style.borderColor='rgba(55,138,221,0.2)'" />
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;text-transform:uppercase;
              letter-spacing:0.07em;color:#5a8aaa;display:block;margin-bottom:5px;">
              <i class="fas fa-envelope" style="margin-right:4px;"></i>Your Email
            </label>
            <input id="arc-pm-email" type="email" value="${escHtml(profile.email || '')}"
              placeholder="you@example.com"
              style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(55,138,221,0.2);
              border-radius:8px;padding:9px 12px;color:#c8dff0;font-size:13px;
              outline:none;transition:border 0.15s;"
              onfocus="this.style.borderColor='rgba(55,138,221,0.55)'"
              onblur="this.style.borderColor='rgba(55,138,221,0.2)'" />
          </div>

          <!-- Preferences -->
          <div style="padding:12px;background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.1);
            border-radius:10px;">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;
              color:#5a8aaa;margin-bottom:10px;"><i class="fas fa-sliders-h" style="margin-right:5px;"></i>Preferences</div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px;">
              <input type="checkbox" id="arc-pm-autofill" ${prefs.autofill !== false ? 'checked' : ''}
                style="width:14px;height:14px;accent-color:#378add;" />
              <span style="font-size:12px;color:#8aadcc;">Auto-fill forms with saved data</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="arc-pm-suggestions" ${prefs.showSuggestions !== false ? 'checked' : ''}
                style="width:14px;height:14px;accent-color:#378add;" />
              <span style="font-size:12px;color:#8aadcc;">Show suggestion chips</span>
            </label>
          </div>
        </div>

        <!-- Buttons -->
        <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap;">
          <button onclick="arcSaveProfileModal()"
            style="flex:1;background:rgba(55,138,221,0.15);border:1px solid rgba(55,138,221,0.35);
            color:#90bce0;padding:9px 16px;border-radius:10px;font-size:13px;font-weight:600;
            cursor:pointer;transition:all 0.15s;min-width:100px;"
            onmouseover="this.style.background='rgba(55,138,221,0.25)'"
            onmouseout="this.style.background='rgba(55,138,221,0.15)'">
            <i class="fas fa-save" style="margin-right:5px;"></i>Save Profile
          </button>
          <button onclick="arcClearProfileModal()"
            style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);
            color:#fca5a5;padding:9px 14px;border-radius:10px;font-size:12px;
            cursor:pointer;transition:all 0.15s;"
            onmouseover="this.style.background='rgba(239,68,68,0.16)'"
            onmouseout="this.style.background='rgba(239,68,68,0.08)'">
            <i class="fas fa-trash-alt" style="margin-right:4px;"></i>Clear All Data
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.getElementById('arc-pm-name')?.focus();
  }

  function arcSaveProfileModal() {
    const name  = el('arc-pm-name')?.value?.trim()  || '';
    const email = el('arc-pm-email')?.value?.trim() || '';
    const autofill    = el('arc-pm-autofill')?.checked    !== false;
    const suggestions = el('arc-pm-suggestions')?.checked !== false;

    if (typeof saveUserProfile === 'function') {
      const current = getUserProfile();
      saveUserProfile({ ...current, name, email });
    }
    if (typeof saveUserPreferences === 'function') {
      saveUserPreferences({ autofill, showSuggestions: suggestions });
    }

    el('arc-profile-modal')?.remove();

    // Refresh profile bars + autofill
    setTimeout(() => {
      renderProfileBar('pay-form-top');
      renderProfileBar('cf-form-top');
      autofillPayments();
      autofillContracts();
    }, 100);

    if (typeof showToast === 'function') showToast('✅ Profile saved', 'success');
  }

  function arcClearProfileModal() {
    if (!confirm('Clear all saved profile data? This includes saved addresses, emails and amounts.')) return;
    if (typeof clearAllProfileData === 'function') clearAllProfileData();
    el('arc-profile-modal')?.remove();

    // Remove suggestion boxes
    ['arc-af-pay-addrs','arc-af-pay-amts','arc-af-pay-emails',
     'arc-af-cf-addrs','arc-af-cf-amts','arc-af-cf-client-email-sugg','arc-af-cf-contractor-email-sugg']
      .forEach(id => { el(id)?.remove(); });

    // Remove profile bars
    document.querySelectorAll('.arc-af-profile-bar').forEach(b => b.remove());

    if (typeof showToast === 'function') showToast('🗑 All profile data cleared', 'info');
  }

  // ─── Tab switch: re-init on tab activation ────────────────────────────────────
  function onTabActivated(tabName) {
    if (tabName === 'payments') setTimeout(initPayAutofill, 250);
    if (tabName === 'contracts') setTimeout(initContractAutofill, 250);
  }

  // ─── Global exports ──────────────────────────────────────────────────────────
  window.arcOpenProfileModal  = arcOpenProfileModal;
  window.arcSaveProfileModal  = arcSaveProfileModal;
  window.arcClearProfileModal = arcClearProfileModal;
  window.arcInitPayAutofill   = initPayAutofill;
  window.arcInitCfAutofill    = initContractAutofill;
  window.arcAutofillOnTab     = onTabActivated;
  window.arcCapturePayData    = capturePaymentData;
  window.arcCaptureCfData     = captureContractData;

  // ─── Init on DOMContentLoaded ─────────────────────────────────────────────────
  function onDOMReady() {
    injectCSS();
    learnFromExistingHistory();

    // Init if already on payments/contracts tab
    setTimeout(() => {
      if (el('pay-fullname')) initPayAutofill();
      if (el('cf-contractor')) initContractAutofill();
    }, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDOMReady);
  } else {
    onDOMReady();
  }

  // Re-init when wallet connects (fresh data)
  window.addEventListener('walletConnected', () => {
    setTimeout(() => {
      if (el('pay-fullname')) initPayAutofill();
      if (el('cf-contractor')) initContractAutofill();
    }, 600);
  });

  // Listen to profile changes to refresh bars
  window.addEventListener('arcProfileUpdated', () => {
    renderProfileBar('pay-form-top');
    renderProfileBar('cf-form-top');
  });

  console.log('[AUTOFILL v1] Smart autofill module loaded — Payments & Contracts');

})();
