// ─── Contract card ─────────────────────────────────────────────────────────────
function cfContractCard(c, wallet) {
  const uiStatus  = cfUiStatus(c);
  const isClient  = c.client?.toLowerCase()     === wallet?.toLowerCase();
  const isContr   = c.contractor?.toLowerCase() === wallet?.toLowerCase();
  const isParticipant = isClient || isContr;
  const role      = isClient ? 'Payer (Client)' : isContr ? 'Receiver (Contractor)' : 'Observer';
  const roleColor = isClient ? '#60b4ff' : isContr ? '#34d399' : '#6b7280';

  const total     = BigInt(c.totalValue);
  const deposited = BigInt(c.depositedValue);
  const pct       = total > 0n ? Math.min(100, Math.round(Number(deposited * 100n / total))) : 0;
  const feeRaw    = cfCalcFee(total);
  const netRaw    = cfNetAmount(total);

  const milestones  = c.milestones || [];
  const releasedAmt = milestones.filter(m => m.status === 'Released').reduce((s, m) => s + BigInt(m.amount), 0n);

  const meta        = cfGetMeta(c.id);
  const proofs      = meta.proofs || [];
  const proofStat   = cfProofStatus(meta);
  const hasProofs   = proofStat !== 'none';
  const isCommitted = proofStat === 'committed';
  const mode        = meta.mode || 'onchain';
  const modeInfo    = CF_MODES[mode] || CF_MODES.onchain;
  const isClosed    = !!meta.contractClosed;
  const dispute     = cfGetDispute(c.id);
  const disputeStat = cfGetDisputeStatus(c.id);
  const isInDispute = disputeStat === 'open';

  // ── Action buttons ─────────────────────────────────────────────────────────
  let actionBtns = '';

  // Closed contracts: no actions at all
  if (isClosed) {
    actionBtns = `<span style="font-size:11px;color:#3a4870;display:flex;align-items:center;gap:5px;padding:6px 10px;background:rgba(74,85,104,0.1);border:1px solid rgba(74,85,104,0.2);border-radius:8px;">
      <i class="fas fa-lock" style="color:#4a5568;"></i>${t("contracts_contrato_encerrado")}
    </span>`;
  } else if (isInDispute) {
    // During active dispute: only resolution options for participants
    actionBtns = `<span style="font-size:11px;color:#f87171;display:flex;align-items:center;gap:5px;padding:6px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;flex-wrap:wrap;gap:8px;">
      <i class="fas fa-gavel"></i>Funds locked — active dispute
    </span>`;
    if (isParticipant)
      actionBtns += `<button onclick="cfShowDisputeResolution(${c.id})" class="cf-action-btn" style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#f87171;">
        <i class="fas fa-balance-scale mr-1.5"></i>Resolve Dispute
      </button>`;
  } else {
    if (mode === 'onchain') {
      if ((uiStatus === 'Funded' || uiStatus === 'Pending') && isContr && !c.contractorSigned)
        actionBtns += `<button onclick="cfSignContract(${c.id})" class="cf-action-btn cf-btn-sign"><i class="fas fa-pen-nib mr-1.5"></i>Sign Contract</button>`;
      if (uiStatus === 'Active' && isContr)
        actionBtns += `<button onclick="cfShowProofUpload(${c.id})" class="cf-action-btn cf-btn-proof"><i class="fas fa-upload mr-1.5"></i>Upload Proof</button>`;
      if (uiStatus === 'Active' && isClient) {
        const proofLabel = proofStat === 'none' ? 'No proof yet' : proofStat === 'uploaded' ? 'Proof uploaded — commit first' : 'Proof committed ✓';
        const canComplete = isCommitted;
        actionBtns += `<button onclick="${canComplete ? `cfMarkComplete(${c.id})` : `showToast('${proofStat === "none" ? "Contractor must upload proof first." : "Proof must be committed before completion."}','warning')`}"
          class="cf-action-btn ${canComplete ? 'cf-btn-complete' : 'cf-btn-disabled'}"
          title="${proofLabel}">
          <i class="fas fa-flag-checkered mr-1.5"></i>Mark Complete
          ${!canComplete ? `<span style="font-size:9px;opacity:0.6;">(${proofStat === 'none' ? 'need proof' : 'commit first'})</span>` : ''}
        </button>`;
      }
      if ((uiStatus === 'Pending' || uiStatus === 'Funded' || uiStatus === 'Draft') && isClient)
        actionBtns += `<button onclick="cfCancelContract(${c.id})" class="cf-action-btn cf-btn-cancel"><i class="fas fa-times mr-1.5"></i>Cancel</button>`;
    } else {
      // Upload proof: available for contractor or for creator of their own offchain contract
      const canUploadProof = isContr || (c._isOffchain && !isClient);
      if (canUploadProof)
        actionBtns += `<button onclick="cfShowProofUpload(${c.id})" class="cf-action-btn cf-btn-proof"><i class="fas fa-upload mr-1.5"></i>Upload Proof</button>`;
      if (isClient && hasProofs && !isCommitted)
        actionBtns += `<button onclick="cfCommitProof(${c.id})" class="cf-action-btn cf-btn-sign" style="background:rgba(52,211,153,0.15);border-color:rgba(52,211,153,0.4);color:#34d399;"><i class="fas fa-stamp mr-1.5"></i>Commit Proof</button>`;
      // Offchain status update: available for participants or for any user on their own local offchain contracts
      const canUpdateStatus = isClient || (c._isOffchain && (meta.offchainStatus !== 'confirmed' && meta.offchainStatus !== 'disputed'));
      if (canUpdateStatus && meta.offchainStatus !== 'confirmed' && meta.offchainStatus !== 'disputed')
        actionBtns += `<button onclick="cfShowOffchainActions(${c.id})" class="cf-action-btn cf-btn-receipt"><i class="fas fa-tasks mr-1.5"></i>Update Status</button>`;
    }

    // Open Dispute button — available to both parties when active/funded (not closed, not already disputed)
    if (isParticipant && (uiStatus === 'Active' || uiStatus === 'Funded' || hasProofs) && !isClosed)
      actionBtns += `<button onclick="cfShowOpenDispute(${c.id})" class="cf-action-btn" style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;">
        <i class="fas fa-gavel mr-1.5"></i>Open Dispute
      </button>`;

    // Wallet-link
    if (uiStatus === 'Active' || uiStatus === 'Funded')
      actionBtns += `<button onclick="cfShowWalletLink(${c.id})" class="cf-action-btn" style="background:rgba(96,180,255,0.06);border:1px solid rgba(96,180,255,0.2);color:#60b4ff;"><i class="fas fa-qrcode mr-1.5"></i>Share Link</button>`;

    // View Receipt
    if (uiStatus === 'Completed' || (mode !== 'onchain' && isCommitted))
      actionBtns += `<button onclick="cfOpenReceipt(${c.id})" class="cf-action-btn cf-btn-receipt"><i class="fas fa-eye mr-1.5"></i>View Receipt</button>`;

    // View On-Chain Proofs — always available for any participant or observer
    actionBtns += `<button onclick="cfViewOnChainProofs(${c.id})" class="cf-action-btn" style="background:rgba(16,185,129,0.09);border:1px solid rgba(16,185,129,0.28);color:#34d399;">
      <i class="fas fa-search-plus mr-1.5"></i>View Proofs
    </button>`;

    // Close Contract — only when Completed and participant, dispute resolved or none
    if ((uiStatus === 'Completed' || disputeStat === 'resolved') && isParticipant && !isClosed)
      actionBtns += `<button onclick="cfCloseContract(${c.id})" class="cf-action-btn" style="background:rgba(74,85,104,0.12);border:1px solid rgba(74,85,104,0.3);color:#9ca3af;">
        <i class="fas fa-lock mr-1.5"></i>Close Contract
      </button>`;
  }

  // ── Proof status badge ─────────────────────────────────────────────────────
  const ps = CF_PROOF_STATUS[proofStat];
  const proofBadge = `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;
    background:rgba(${proofStat==='committed'?'52,211,153':proofStat==='uploaded'?'251,191,36':'74,85,104'},0.12);
    border:1px solid rgba(${proofStat==='committed'?'52,211,153':proofStat==='uploaded'?'251,191,36':'74,85,104'},0.3);
    color:${ps.color};padding:1px 8px;border-radius:999px;">
    <i class="fas ${ps.icon}" style="font-size:8px;"></i>${ps.label}
  </span>`;

  // ── Mode badge ─────────────────────────────────────────────────────────────
  const modeBadge = `<span class="cf-chip" style="color:${modeInfo.color};border-color:rgba(55,138,221,0.16);">
    <i class="fas ${modeInfo.icon}"></i>${modeInfo.label}
  </span>`;

  // ── Milestones — one card per milestone (dynamic count, handlers unchanged) ──
  const msHtml = milestones.length ? milestones.map((m, i) => {
    const rel = m.status === 'Released';
    return `<div class="cf-ms-block" style="padding-bottom:9px;margin-bottom:9px;border-bottom:1px solid rgba(55,138,221,0.08);">
      <div class="cf-ms">
        <span class="cf-ms-num" style="${rel?'background:rgba(52,211,153,0.16);border:1px solid rgba(52,211,153,0.35);color:#34d399':'background:rgba(55,138,221,0.12);border:1px solid rgba(55,138,221,0.25);color:#60b4ff'}">${i + 1}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:#dbe4f2;word-break:break-word;">${cfEsc(m.description || ('Milestone ' + (i + 1)))}</div>
          <div style="font-size:10.5px;color:#5f7ba0;margin-top:2px;">
            <span style="color:${rel?'#34d399':'#7f93b5'};font-weight:700;"><i class="fas ${rel?'fa-check-circle':'fa-clock'} mr-1" style="font-size:9px;"></i>${rel?'Released':'Pending'}</span>
            ${rel && Number(m.releasedAt) > 0 ? ` · Released ${cfTs(m.releasedAt)}` : ''}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:14px;font-weight:800;color:${rel?'#34d399':'#60b4ff'};">$${cfFmtUsdc(m.amount)}</div>
          ${uiStatus==='Active'&&isClient&&m.status==='Pending'&&mode==='onchain'&&!isInDispute&&!isClosed
            ? `<button onclick="cfReleaseMilestone(${c.id},${i})" class="cf-action-btn cf-btn-receive" style="margin-top:5px;padding:3px 10px;font-size:10px;"><i class="fas fa-unlock mr-1"></i>Release</button>`
            : isInDispute && m.status==='Pending'
              ? `<span style="font-size:10px;color:#f87171;" title="Funds locked due to active dispute"><i class="fas fa-lock mr-1"></i>Locked</span>`
              : ''}
        </div>
      </div>
      ${cfMilestoneWorkflowHtml(c, i, m, { isClient, isContr, mode, uiStatus, isInDispute, isClosed })}
    </div>`;
  }).join('') : `<p style="font-size:12px;color:#5f7ba0;font-style:italic;margin:0;">No milestones defined for this contract.</p>`;

  // ── Proofs — professional attachment cards (thumbnails / handlers unchanged) ─
  const proofsAddBtn = (uiStatus==='Active'||mode!=='onchain') && isContr
    ? `<button onclick="cfShowProofUpload(${c.id})" class="cf-action-btn cf-btn-proof" style="padding:3px 10px;font-size:10px;"><i class="fas fa-upload mr-1"></i>Add</button>` : '';
  const proofsHtml = `
      ${proofs.length ? proofs.map((p, pi) => {
        const isImg = p.type === 'image' || (p.mimeType && p.mimeType.startsWith('image/'));
        const isPdf = p.type === 'pdf' || p.mimeType === 'application/pdf';
        const isZip = /zip|compressed|x-7z|x-rar|x-tar|gzip/.test(p.mimeType || '') || /\.(zip|rar|7z|tar|gz)$/i.test(p.name || '');
        const fileIcon = isPdf ? 'fa-file-pdf' : isZip ? 'fa-file-archive' : p.type === 'doc' ? 'fa-file-alt' : 'fa-file';
        const thumb = isImg && p.url
          ? `<img src="${p.url}" alt="${cfEsc(p.name)} preview" loading="lazy">`
          : `<i class="fas ${fileIcon}" style="color:${p.committed?'#34d399':'#a78bfa'};font-size:17px;"></i>`;
        return `<div class="cf-attach">
          <span class="cf-attach-thumb">${thumb}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12.5px;font-weight:700;color:#dbe4f2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${cfEsc(p.name)}">${cfEsc(p.name)}</div>
            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px;">
              ${p.committed
                ? `<span style="font-size:9.5px;font-weight:700;color:#34d399;"><i class="fas fa-lock mr-1" style="font-size:8px;"></i>Committed</span>`
                : `<span style="font-size:9.5px;font-weight:700;color:#fbbf24;"><i class="fas fa-clock mr-1" style="font-size:8px;"></i>Pending commit</span>`}
              ${p.uploadedAt ? `<span style="font-size:9.5px;color:#5f7ba0;"><i class="far fa-calendar mr-1"></i>${cfTsMs(p.uploadedAt)}</span>` : ''}
              ${p.size ? `<span style="font-size:9.5px;color:#5f7ba0;">${(p.size/1024).toFixed(0)} KB</span>` : ''}
            </div>
            ${p.hash ? `<div style="display:flex;align-items:center;gap:5px;margin-top:5px;font-size:9.5px;color:#5f7ba0;">
              <span>SHA-256:</span>
              <span id="cf-hashS-${c.id}-${pi}" class="cf-mono">${p.hash.slice(0,10)}…</span>
              <span id="cf-hashF-${c.id}-${pi}" class="cf-mono" style="display:none;word-break:break-all;">${p.hash}</span>
              <button type="button" class="cf-icon-btn" title="Reveal full hash" aria-label="Reveal full hash" onclick="var S=document.getElementById('cf-hashS-${c.id}-${pi}'),F=document.getElementById('cf-hashF-${c.id}-${pi}');var open=F.style.display!=='none';F.style.display=open?'none':'inline';S.style.display=open?'inline':'none';this.querySelector('i').className=open?'fas fa-chevron-down':'fas fa-chevron-up';"><i class="fas fa-chevron-down"></i></button>
              ${cfCopyBtn(p.hash, 'SHA-256 hash')}
            </div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0;">
            <button onclick="cfViewProof(${c.id},${pi})" class="cf-action-btn cf-btn-proof" style="padding:4px 11px;font-size:10px;"><i class="fas fa-eye mr-1"></i>View</button>
            <button onclick="cfDownloadProofByUrl(${c.id},${pi})" class="cf-action-btn" style="padding:4px 11px;font-size:10px;background:rgba(96,180,255,0.08);border:1px solid rgba(96,180,255,0.2);color:#93c5fd;"><i class="fas fa-download mr-1"></i>Download</button>
            ${isContr && !p.committed ? `<button onclick="cfDeleteProof(${c.id},${pi})" title="Delete proof" aria-label="Delete proof" class="cf-action-btn cf-btn-cancel" style="padding:4px 11px;font-size:10px;"><i class="fas fa-trash-alt"></i></button>` : ''}
          </div>
        </div>`;
      }).join('')
        : `<p style="font-size:12px;color:#5f7ba0;font-style:italic;margin:0;">${t("cf_no_proof_submitted_yet")}</p>`}
      ${proofs.length > 0 && !isCommitted && isClient ? `
        <button onclick="cfCommitProof(${c.id})" style="width:100%;margin-top:10px;padding:9px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);color:#34d399;border-radius:10px;font-size:12px;font-weight:700;cursor:pointer;">
          <i class="fas fa-stamp mr-1.5"></i>Commit Proof — Lock & Verify
        </button>` : ''}`;

  // ── Off-chain fields ────────────────────────────────────────────────────────
  const offchainHtml = mode !== 'onchain' ? `
    <div style="margin-top:12px;padding:10px 12px;background:rgba(${mode==='custodial'?'167,139,250':'251,191,36'},0.06);border:1px solid rgba(${mode==='custodial'?'167,139,250':'251,191,36'},0.2);border-radius:11px;">
      <div style="font-size:10px;font-weight:700;color:${modeInfo.color};text-transform:uppercase;margin-bottom:4px;"><i class="fas ${modeInfo.icon} mr-1"></i>${modeInfo.label}</div>
      ${meta.paymentNote ? `<div style="font-size:11px;color:#8899bb;margin-bottom:4px;"><i class="fas fa-sticky-note mr-1" style="color:#fbbf24;"></i>${cfEsc(meta.paymentNote)}</div>` : ''}
      ${meta.escrowRef ? `<div style="font-size:11px;color:#8899bb;"><i class="fas fa-shield-alt mr-1" style="color:#a78bfa;"></i>Escrow Ref: <span style="font-family:monospace;">${cfEsc(meta.escrowRef)}</span></div>` : ''}
      ${meta.offchainStatus ? `<div style="margin-top:4px;font-size:11px;font-weight:600;color:${meta.offchainStatus==='confirmed'?'#34d399':meta.offchainStatus==='disputed'?'#f87171':'#fbbf24'};">
        Status: ${meta.offchainStatus.toUpperCase()}</div>` : ''}
    </div>` : '';

  // ── Dispute section ────────────────────────────────────────────────────────
  const disputeHtml = dispute ? (() => {
    const ds = CF_DISPUTE_STATUS[dispute.status] || CF_DISPUTE_STATUS.none;
    const evidences = dispute.evidence || [];
    const resolutionHtml = dispute.resolution ? `
      <div style="margin-top:8px;padding:7px 10px;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.2);border-radius:8px;">
        <div style="font-size:10px;font-weight:700;color:#34d399;margin-bottom:4px;"><i class="fas fa-check-circle mr-1"></i>${t("cf_resolution_label")}</div>
        <div style="font-size:11px;color:#8899bb;">${dispute.resolution.outcome === 'contractor' ? t('cf_resolution_contractor') : dispute.resolution.outcome === 'client' ? t('cf_resolution_client') : t('cf_resolution_mutual')}</div>
        <div style="font-size:10px;color:#3a4870;margin-top:3px;">${new Date(dispute.resolution.resolvedAt).toLocaleString('en-US')}</div>
        ${dispute.resolution.note ? `<div style="font-size:11px;color:#6b7280;margin-top:3px;font-style:italic;">"${cfEsc(dispute.resolution.note)}"</div>` : ''}
      </div>` : '';
    const approvalHtml = dispute.status === 'open' && dispute.mutualApproval ? (() => {
      const approvals = dispute.mutualApproval || {};
      const clientApproved = approvals[c.client?.toLowerCase()];
      const contrApproved  = approvals[c.contractor?.toLowerCase()];
      return `
        <div style="margin-top:6px;padding:6px 10px;background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.2);border-radius:8px;font-size:11px;color:#fbbf24;">
          <i class="fas fa-handshake mr-1"></i>${t("cf_mutual_agreement_ongoing")}
          <span style="color:${clientApproved?'#34d399':'#4a5568'};margin-left:6px;"><i class="fas fa-${clientApproved?'check':'times'}-circle mr-1"></i>Cliente</span>
          <span style="color:${contrApproved?'#34d399':'#4a5568'};margin-left:6px;"><i class="fas fa-${contrApproved?'check':'times'}-circle mr-1"></i>Contratado</span>
        </div>`;
    })() : '';
    return `
    <div style="margin-top:8px;padding:10px 12px;background:rgba(${ds.bg},0.06);border:1px solid rgba(${ds.bg},0.25);border-radius:10px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
        <i class="fas ${ds.icon}" style="color:${ds.color};"></i>
        <span style="font-size:11px;font-weight:800;color:${ds.color};text-transform:uppercase;letter-spacing:0.05em;">${ds.label}</span>
        <span style="font-size:10px;color:#3a4870;margin-left:auto;">${new Date(dispute.openedAt).toLocaleString('en-US')}</span>
      </div>
      <div style="font-size:12px;color:#dde2f0;margin-bottom:6px;font-weight:600;">"${cfEsc(dispute.reason)}"</div>
      <div style="font-size:10px;color:#4a6490;margin-bottom:6px;">
        <i class="fas fa-user mr-1"></i>Opened by: <span style="font-family:monospace;">${cfShort(dispute.openedBy)}</span>
        ${dispute.openedBy?.toLowerCase() === c.client?.toLowerCase() ? ' (Cliente)' : ' (Contratado)'}
      </div>
      ${evidences.length ? `
        <div style="font-size:10px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:4px;">${t("cf_evidences_label", evidences.length)}</div>
        ${evidences.map((ev, ei) => `
          <div style="display:flex;align-items:center;gap:6px;padding:4px 6px;background:rgba(239,68,68,0.04);border:1px solid rgba(239,68,68,0.12);border-radius:6px;margin-bottom:3px;">
            <i class="fas ${ev.type==='image'?'fa-image':ev.type==='pdf'?'fa-file-pdf':'fa-file'}" style="color:#f87171;font-size:11px;"></i>
            <span style="flex:1;font-size:10px;color:#8899bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${cfEsc(ev.name)}</span>
            <button onclick="cfViewDisputeEvidence(${c.id},${ei})" style="font-size:9px;color:#f87171;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.18);padding:2px 6px;border-radius:4px;cursor:pointer;">Ver</button>
          </div>`).join('')}` : ''}
      ${approvalHtml}
      ${resolutionHtml}
    </div>`;
  })() : '';

  // ── Closed banner ──────────────────────────────────────────────────────────
  const closedHtml = isClosed ? `
    <div style="margin-top:8px;padding:10px 12px;background:rgba(74,85,104,0.1);border:1px solid rgba(74,85,104,0.25);border-radius:10px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <i class="fas fa-lock" style="color:#6b7280;"></i>
        <span style="font-size:11px;font-weight:700;color:#9ca3af;">Contract Closed</span>
        <span style="font-size:10px;color:#3a4870;margin-left:auto;">${new Date(meta.closedAt || 0).toLocaleString('en-US')}</span>
      </div>
      <div style="font-size:10px;color:#4a5568;margin-top:4px;">Closed by: <span style="font-family:monospace;">${cfShort(meta.closedBy)}</span></div>
      <div style="font-size:10px;color:#3a4870;margin-top:2px;">All interactions have been permanently locked.</div>
    </div>` : '';

  // ── Notes section ──────────────────────────────────────────────────────────
  const notesHtml = meta.notes ? `
    <div style="margin-top:8px;padding:10px 12px;background:rgba(167,139,250,0.05);border:1px solid rgba(167,139,250,0.18);border-radius:10px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
        <i class="fas fa-sticky-note" style="color:#a78bfa;font-size:10px;"></i>
        <span style="font-size:10px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:0.07em;">Notes</span>
        <span style="font-size:9px;color:#4a6490;font-style:italic;margin-left:2px;">(visible to all parties)</span>
      </div>
      <p style="font-size:12px;color:#c4b5fd;line-height:1.55;margin:0;white-space:pre-wrap;word-break:break-word;">${meta.notes.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
    </div>` : '';

  // ── Meta info ──────────────────────────────────────────────────────────────
  const metaHtml = (meta.clientEmail || meta.contractorEmail || meta.custodianAddr) ? `
    <div style="margin-top:8px;padding:8px;background:rgba(55,138,221,0.04);border:1px solid rgba(55,138,221,0.1);border-radius:10px;">
      ${meta.clientEmail ? `<div style="font-size:11px;color:#4a6490;"><i class="fas fa-envelope mr-1" style="color:#60b4ff;"></i>Client: ${cfEsc(meta.clientEmail)}</div>` : ''}
      ${meta.contractorEmail ? `<div style="font-size:11px;color:#4a6490;"><i class="fas fa-envelope mr-1" style="color:#34d399;"></i>Contractor: ${cfEsc(meta.contractorEmail)}</div>` : ''}
      ${meta.custodianAddr ? `<div style="font-size:11px;color:#c4b5fd;margin-top:4px;"><i class="fas fa-shield-alt mr-1" style="color:#a78bfa;"></i>Custodian: <span style="font-family:monospace;">${meta.custodianAddr.slice(0,10)}…${meta.custodianAddr.slice(-6)}</span></div>` : ''}
    </div>` : '';

  // ── Derived workflow state (presentation only — no logic/data changes) ──────
  const msCount       = Number(c.milestoneCount) || milestones.length;
  const signed        = !!c.contractorSigned;
  const isFunded      = mode === 'onchain' ? (deposited > 0n) : (!!meta.offchainStatus && meta.offchainStatus !== 'pending');
  const workSubmitted = hasProofs;
  const approved      = isCommitted;
  const released      = releasedAmt > 0n || uiStatus === 'Completed';
  const completed     = uiStatus === 'Completed';
  const cancelled     = uiStatus === 'Cancelled';
  const youTag        = ' <span style="font-size:8.5px;font-weight:800;color:#34d399;">(You)</span>';

  // Current-status summary line
  let statusLine, statusLineColor, statusLineIcon;
  if (isClosed)         { statusLine = 'Contract Closed';                statusLineColor = '#9ca3af'; statusLineIcon = 'fa-lock'; }
  else if (isInDispute) { statusLine = 'In Dispute — funds locked';     statusLineColor = '#f87171'; statusLineIcon = 'fa-gavel'; }
  else if (cancelled)   { statusLine = 'Contract Cancelled — refunded'; statusLineColor = '#f87171'; statusLineIcon = 'fa-times-circle'; }
  else if (completed)   { statusLine = 'Contract Completed';            statusLineColor = '#34d399'; statusLineIcon = 'fa-check-circle'; }
  else if (!isFunded)                     { statusLine = 'Awaiting Funding';              statusLineColor = '#fbbf24'; statusLineIcon = 'fa-hourglass-half'; }
  else if (mode === 'onchain' && !signed) { statusLine = 'Awaiting Contractor Signature'; statusLineColor = '#67e8f9'; statusLineIcon = 'fa-pen-nib'; }
  else if (!workSubmitted)                { statusLine = 'Awaiting Work Submission';       statusLineColor = '#fbbf24'; statusLineIcon = 'fa-hourglass-half'; }
  else if (!approved)                     { statusLine = 'Waiting Client Approval';        statusLineColor = '#fbbf24'; statusLineIcon = 'fa-user-check'; }
  else if (!released)                     { statusLine = 'Awaiting Fund Release';          statusLineColor = '#fbbf24'; statusLineIcon = 'fa-coins'; }
  else                                    { statusLine = 'Finalizing';                     statusLineColor = '#67e8f9'; statusLineIcon = 'fa-spinner'; }

  // Workflow checklist steps
  const wfSteps = [{ label: 'Escrow Created', done: true }, { label: mode === 'onchain' ? 'Escrow Funded' : 'Agreement Registered', done: isFunded }];
  if (mode === 'onchain') wfSteps.push({ label: 'Contractor Signed', done: signed });
  wfSteps.push({ label: 'Work Submitted', done: workSubmitted }, { label: 'Client Approved', done: approved }, { label: 'Funds Released', done: released }, { label: 'Contract Completed', done: completed });
  let curMarked = false;
  const statusStepsHtml = wfSteps.map(s => {
    const isCurrent = !s.done && !curMarked && !completed && !cancelled && !isClosed && !isInDispute;
    if (isCurrent) curMarked = true;
    const dotStyle = s.done
      ? 'background:rgba(52,211,153,0.16);border:1px solid rgba(52,211,153,0.4);color:#34d399'
      : isCurrent ? 'background:rgba(96,180,255,0.16);border:1px solid rgba(96,180,255,0.45);color:#60b4ff'
                  : 'background:rgba(74,85,104,0.12);border:1px solid rgba(74,85,104,0.3);color:#5f7ba0';
    return `<div class="cf-status-step">
        <span class="dot" style="${dotStyle}"><i class="fas ${s.done ? 'fa-check' : isCurrent ? 'fa-dot-circle' : 'fa-circle'}" style="font-size:${s.done ? '9px' : '7px'};"></i></span>
        <span class="lbl" style="color:${s.done ? '#cdd8ea' : isCurrent ? '#dbe4f2' : '#5f7ba0'};font-weight:${isCurrent ? '700' : '500'};">${s.label}</span>
      </div>`;
  }).join('');
  const statusCardHtml = `${statusStepsHtml}
      <div style="margin-top:12px;display:flex;align-items:center;gap:9px;padding:10px 12px;border-radius:11px;background:rgba(${statusLineColor==='#f87171'?'239,68,68':statusLineColor==='#34d399'?'52,211,153':statusLineColor==='#9ca3af'?'74,85,104':'55,138,221'},0.07);border:1px solid rgba(${statusLineColor==='#f87171'?'239,68,68':statusLineColor==='#34d399'?'52,211,153':statusLineColor==='#9ca3af'?'74,85,104':'55,138,221'},0.22);">
        <i class="fas ${statusLineIcon}" style="color:${statusLineColor};"></i>
        <span style="font-size:13px;font-weight:800;color:${statusLineColor};">${statusLine}</span>
      </div>`;

  // ── Action Required (connected participant only) ────────────────────────────
  let ar = null;
  if (isParticipant) {
    if (isClosed) ar = { level: 'info', icon: 'fa-lock', title: 'No action required', sub: 'This contract has been closed.' };
    else if (isInDispute) ar = { level: 'danger', icon: 'fa-gavel', title: 'Active dispute', sub: 'Funds are locked until the dispute is resolved.' };
    else if (cancelled) ar = { level: 'danger', icon: 'fa-times-circle', title: 'Contract cancelled', sub: 'The escrow was refunded to the client.' };
    else if (completed) ar = { level: 'ok', icon: 'fa-check-circle', title: 'No action required', sub: 'Contract successfully completed.' };
    else if (mode === 'onchain') {
      if ((uiStatus === 'Funded' || uiStatus === 'Pending') && isContr && !signed) ar = { level: 'attention', icon: 'fa-pen-nib', title: 'Sign the contract', sub: 'Sign to activate the escrow and begin work.' };
      else if (uiStatus === 'Active' && isContr && !workSubmitted) ar = { level: 'attention', icon: 'fa-upload', title: 'Upload proof of work', sub: 'Submit your deliverables for client review.' };
      else if (uiStatus === 'Active' && isContr && workSubmitted && !approved) ar = { level: 'info', icon: 'fa-hourglass-half', title: 'Awaiting client review', sub: 'Your proof was submitted and is pending approval.' };
      else if (uiStatus === 'Active' && isClient && !workSubmitted) ar = { level: 'info', icon: 'fa-hourglass-half', title: 'Waiting for proof of work', sub: 'The contractor has not submitted deliverables yet.' };
      else if (uiStatus === 'Active' && isClient && workSubmitted && !approved) ar = { level: 'attention', icon: 'fa-user-check', title: 'Review & commit proof', sub: 'Verify the submitted work and commit to continue.' };
      else if (uiStatus === 'Active' && isClient && approved && !released) ar = { level: 'attention', icon: 'fa-coins', title: 'Release the funds', sub: 'Approve milestones to release escrow to the contractor.' };
      else if (!isFunded && isClient) ar = { level: 'attention', icon: 'fa-hand-holding-usd', title: 'Fund the escrow', sub: 'Deposit USDC to activate the contract.' };
    } else {
      if (isContr && !workSubmitted) ar = { level: 'attention', icon: 'fa-upload', title: 'Upload proof of work', sub: 'Attach deliverables for this agreement.' };
      else if (isClient && workSubmitted && !approved) ar = { level: 'attention', icon: 'fa-stamp', title: 'Commit the submitted proof', sub: 'Lock and verify the delivered work.' };
    }
    if (!ar) ar = { level: 'ok', icon: 'fa-check-circle', title: 'No action required', sub: 'Nothing needs your attention right now.' };
  }
  const actionReqHtml = ar ? `<div class="cf-alert cf-alert-${ar.level}">
      <span class="cf-alert-ic"><i class="fas ${ar.icon}"></i></span>
      <div><div class="cf-alert-title">${ar.title}</div><div class="cf-alert-sub">${ar.sub}</div></div>
    </div>` : '';

  // ── Participants ────────────────────────────────────────────────────────────
  const partyCard = (label, addr, color, amtLabel, amtVal, amtColor, isYou) => `
    <div class="cf-party"${isYou ? ' style="border-color:rgba(52,211,153,0.3);background:rgba(52,211,153,0.04);"' : ''}>
      <div style="display:flex;align-items:center;gap:11px;">
        ${cfAvatar(addr, 38)}
        <div style="flex:1;min-width:0;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.07em;font-weight:700;color:${color};">${label}${isYou ? youTag : ''}</div>
          <div style="display:flex;align-items:center;gap:5px;margin-top:3px;">
            <span class="cf-mono" style="font-size:11.5px;color:#cdd8ea;overflow:hidden;text-overflow:ellipsis;" title="${addr}">${cfShort(addr)}</span>
            ${cfCopyBtn(addr, label + ' address')}
            ${cfExplorerBtn('address/' + addr, label)}
          </div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:11px;padding-top:10px;border-top:1px solid rgba(55,138,221,0.1);">
        <span style="font-size:10px;color:#5f7ba0;">${amtLabel}</span>
        <span style="font-size:15px;font-weight:800;color:${amtColor};">$${amtVal}</span>
      </div>
    </div>`;
  const participantsHtml = `<div>
      ${partyCard('Client', c.client, '#60b4ff', 'Amount Paid', cfFmtUsdc(mode === 'onchain' ? deposited : total), '#60b4ff', isClient)}
      ${partyCard('Contractor', c.contractor, '#34d399', 'Amount Received', cfFmtUsdc(releasedAmt), '#34d399', isContr)}
    </div>${metaHtml}`;

  // ── Financial summary ───────────────────────────────────────────────────────
  const finMetrics = mode === 'onchain' ? `
      <div class="cf-metrics">
        <div class="cf-metric"><div class="k">Escrow Amount</div><div class="v">$${cfFmtUsdc(total)}</div></div>
        <div class="cf-metric"><div class="k">Platform Fee (0.2%)</div><div class="v sm" style="color:#fbbf24;">$${cfFmtUsdc(feeRaw)}</div></div>
        <div class="cf-metric"><div class="k">Contractor Receives</div><div class="v sm" style="color:#34d399;">$${cfFmtUsdc(netRaw)}</div></div>
        <div class="cf-metric"><div class="k">Funding</div><div class="v">${pct}%</div></div>
        <div class="cf-metric"><div class="k">Token</div><div class="v sm">USDC</div></div>
        <div class="cf-metric"><div class="k">Network</div><div class="v sm">${CF_NETWORK_NAME}</div></div>
      </div>
      <div style="margin-top:12px;">
        <div style="display:flex;justify-content:space-between;font-size:10.5px;color:#5f7ba0;margin-bottom:5px;">
          <span>Escrow funded: $${cfFmtUsdc(deposited)} / $${cfFmtUsdc(total)}</span><span>${pct}%</span>
        </div>
        <div style="height:6px;background:rgba(55,138,221,0.12);border-radius:6px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#378ADD,#1D9E75);border-radius:6px;transition:width 0.5s;"></div></div>
      </div>` : `
      <div class="cf-metrics">
        <div class="cf-metric"><div class="k">Contract Amount</div><div class="v">$${cfFmtUsdc(total)}</div></div>
        <div class="cf-metric"><div class="k">Escrow Type</div><div class="v sm" style="color:${modeInfo.color};">${modeInfo.label}</div></div>
        <div class="cf-metric"><div class="k">Network</div><div class="v sm">${CF_NETWORK_NAME}</div></div>
      </div>${offchainHtml}`;

  // ── Timeline (existing timestamps only) ─────────────────────────────────────
  const tlEvents = [];
  if (c.createdAt) tlEvents.push({ sort: Number(c.createdAt) * 1000, label: 'Contract Created', icon: 'fa-file-contract', color: '#60b4ff', time: cfTs(c.createdAt) });
  if (mode === 'onchain' && deposited > 0n && c.createdAt) tlEvents.push({ sort: Number(c.createdAt) * 1000 + 1, label: 'Escrow Funded', icon: 'fa-coins', color: '#34d399', time: cfTs(c.createdAt) });
  if (c.startedAt) tlEvents.push({ sort: Number(c.startedAt) * 1000, label: 'Contractor Signed', icon: 'fa-pen-nib', color: '#67e8f9', time: cfTs(c.startedAt) });
  const firstProofTs = proofs.length ? Math.min(...proofs.map(p => Number(p.uploadedAt) || Infinity)) : 0;
  if (firstProofTs && isFinite(firstProofTs)) tlEvents.push({ sort: firstProofTs, label: 'Work Submitted', icon: 'fa-upload', color: '#a78bfa', time: cfTsMs(firstProofTs) });
  if (meta.commitmentTs) tlEvents.push({ sort: Number(meta.commitmentTs), label: 'Proof Committed / Approved', icon: 'fa-stamp', color: '#34d399', time: cfTsMs(meta.commitmentTs) });
  const relTimes = milestones.filter(m => m.status === 'Released' && Number(m.releasedAt) > 0).map(m => Number(m.releasedAt) * 1000);
  if (relTimes.length) { const lr = Math.max(...relTimes); tlEvents.push({ sort: lr, label: 'Funds Released', icon: 'fa-unlock', color: '#34d399', time: cfTsMs(lr) }); }
  if (dispute && dispute.openedAt) tlEvents.push({ sort: Number(dispute.openedAt), label: 'Dispute Opened', icon: 'fa-gavel', color: '#f87171', time: cfTsMs(dispute.openedAt) });
  if (c.completedAt) tlEvents.push({ sort: Number(c.completedAt) * 1000, label: 'Contract Completed', icon: 'fa-flag-checkered', color: '#34d399', time: cfTs(c.completedAt) });
  if (isClosed && meta.closedAt) tlEvents.push({ sort: Number(meta.closedAt), label: 'Contract Closed', icon: 'fa-lock', color: '#9ca3af', time: cfTsMs(meta.closedAt) });
  tlEvents.sort((a, b) => a.sort - b.sort);
  const timelineHtml = tlEvents.length ? `<div class="cf-tl">${tlEvents.map((e, i) => `
      <div class="cf-tl-item">
        <div class="cf-tl-rail">
          <span class="cf-tl-dot" style="border:1px solid ${e.color};color:${e.color};background:rgba(8,11,24,0.6);"><i class="fas ${e.icon}"></i></span>
          ${i < tlEvents.length - 1 ? '<span class="cf-tl-line"></span>' : ''}
        </div>
        <div class="cf-tl-body"><div class="cf-tl-label">${e.label}</div><div class="cf-tl-time">${e.time}</div></div>
      </div>`).join('')}</div>` : `<p style="font-size:12px;color:#5f7ba0;font-style:italic;margin:0;">No timeline events recorded yet.</p>`;

  // ── Blockchain information (existing data only — no new requests) ────────────
  const txLogAll = (() => { try { return JSON.parse(localStorage.getItem(CF_TX_LOG_KEY) || '[]'); } catch (_) { return []; } })();
  const myTxs = txLogAll.filter(x => String(x.contractId) === String(c.id) && /^0x[0-9a-fA-F]{64}$/.test(x.txHash || ''));
  const bcRow = (label, value, mono, extra) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(55,138,221,0.08);">
      <span style="font-size:10.5px;color:#5f7ba0;min-width:118px;flex-shrink:0;">${label}</span>
      <span class="${mono ? 'cf-mono' : ''}" style="font-size:11.5px;color:#cdd8ea;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${cfEsc(String(value))}">${cfEsc(String(value))}</span>
      ${extra || ''}
    </div>`;
  const blockchainHtml = `
      ${bcRow('Network', CF_NETWORK_NAME + ' · Chain ' + CF_CHAIN_ID)}
      ${mode === 'onchain' ? bcRow('Contract (Factory)', CF_FACTORY_ADDR, true, cfCopyBtn(CF_FACTORY_ADDR, 'contract address') + cfExplorerBtn('address/' + CF_FACTORY_ADDR, 'contract')) : ''}
      ${mode === 'onchain' ? bcRow('USDC Token', CF_USDC_ADDR, true, cfCopyBtn(CF_USDC_ADDR, 'USDC address') + cfExplorerBtn('address/' + CF_USDC_ADDR, 'token')) : ''}
      ${meta.commitmentHash ? bcRow('Commit Hash', meta.commitmentHash, true, cfCopyBtn(meta.commitmentHash, 'commit hash')) : ''}
      ${meta.escrowRef ? bcRow('Escrow Ref', meta.escrowRef, true, cfCopyBtn(meta.escrowRef, 'escrow ref')) : ''}
      ${myTxs.map(x => bcRow('Tx · ' + (x.action || 'transaction'), x.txHash, true, cfCopyBtn(x.txHash, 'transaction hash') + cfExplorerBtn('tx/' + x.txHash, 'transaction'))).join('')}
      ${bcRow('Created', cfTs(c.createdAt))}
      ${c.completedAt ? bcRow('Completed', cfTs(c.completedAt)) : ''}
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="cfViewOnChainProofs(${c.id})" class="cf-action-btn" style="background:rgba(16,185,129,0.09);border:1px solid rgba(16,185,129,0.28);color:#34d399;"><i class="fas fa-search-plus mr-1.5"></i>View On-Chain Proofs</button>
        ${mode === 'onchain' ? `<a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" rel="noopener" class="cf-action-btn cf-btn-receipt"><i class="fas fa-external-link-alt mr-1.5"></i>Open in ArcScan</a>` : ''}
      </div>`;

  // ── Hide button (top of card) — contract stays on-chain, only hidden locally ─
  const hideBtn = `<button class="cf-action-btn" onclick="event.stopPropagation();if(typeof arcHideContract==='function')arcHideContract('${c.id}');cfRenderContracts(cfState.contracts,window.walletState?.address);" title="Hide from view — on-chain contracts cannot be deleted, only hidden" aria-label="Hide contract from view" style="padding:3px 9px;font-size:10px;background:rgba(74,85,104,0.12);border:1px solid rgba(74,85,104,0.3);color:#9ca3af;"><i class="fas fa-eye-slash mr-1"></i>Hide</button>`;
  const openPageBtn = `<button class="cf-action-btn" onclick="event.stopPropagation();cfOpenContractPage(${c.id});" title="Open this contract's information in a separate page" aria-label="Open contract in a separate page" style="padding:3px 9px;font-size:10px;background:rgba(55,138,221,0.1);border:1px solid rgba(55,138,221,0.28);color:#60b4ff;"><i class="fas fa-up-right-from-square mr-1"></i>Open Page</button>`;

  const headerBadges = `${cfStatusBadge(uiStatus)}
      ${cfIsNew(c) && uiStatus !== 'Completed' && uiStatus !== 'Cancelled' && !isClosed ? `<span title="Recently created" style="display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:800;letter-spacing:.06em;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;padding:2px 7px;border-radius:999px;box-shadow:0 0 10px rgba(34,197,94,.55);animation:cfNewPulse 2s ease-in-out infinite;"><i class="fas fa-star" style="font-size:7px;"></i>NEW</span>` : ''}
      ${isInDispute ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.35);color:#f87171;padding:2px 8px;border-radius:999px;"><i class="fas fa-gavel" style="font-size:8px;"></i>In Dispute</span>` : ''}
      ${isClosed ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;background:rgba(74,85,104,0.15);border:1px solid rgba(74,85,104,0.3);color:#9ca3af;padding:2px 8px;border-radius:999px;"><i class="fas fa-lock" style="font-size:8px;"></i>Closed</span>` : ''}`;

  const primaryActionsHtml = actionBtns
    ? `<div class="cf-actions-row">${actionBtns}</div>`
    : `<p style="font-size:12px;color:#5f7ba0;font-style:italic;margin:0;">No actions available for your role on this contract.</p>`;

  return `
  <div class="cf-card2 mb-4" id="cf-contract-${c.id}">
    <div style="height:3px;background:linear-gradient(90deg,transparent,#378ADD 40%,#1D9E75 60%,transparent);"></div>
    <div class="cf-body">

      <!-- 1. Header -->
      <div class="cf-hdr">
        <div style="min-width:0;flex:1;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:7px;">${headerBadges}</div>
          <h3 class="cf-hdr-title" title="${cfEsc(c.title || '')}">${cfEsc(c.title || 'Untitled Contract')}</h3>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px;">
            <span class="cf-chip cf-mono">#${c.id}</span>
            ${modeBadge}
            <span class="cf-chip"><i class="fas fa-tasks"></i>${msCount} Milestone${msCount === 1 ? '' : 's'}</span>
            <span class="cf-chip" style="color:${roleColor};"><i class="fas fa-user"></i>${role}</span>
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="display:flex;justify-content:flex-end;gap:6px;margin-bottom:6px;">${openPageBtn}${hideBtn}</div>
          <div class="cf-amount-xl">$${cfFmtUsdc(total)}<small>USDC</small></div>
          <div style="font-size:10px;color:#5f7ba0;margin-top:5px;">Net: <span style="color:#34d399;font-weight:700;">$${cfFmtUsdc(netRaw)}</span></div>
        </div>
      </div>

      <!-- 2. Action required -->
      ${actionReqHtml}

      <!-- Dispute / closed notices (existing data) -->
      ${disputeHtml}
      ${closedHtml}

      <!-- Two-column detail grid (compact) -->
      <div class="cf-cols">
        <div class="cf-col">
          ${cfSection('status-' + c.id, 'Current Status', 'fa-list-check', '#60b4ff', statusCardHtml)}
          ${cfSection('fin-' + c.id, 'Financial Summary', 'fa-coins', '#fbbf24', finMetrics)}
          ${cfSection('tl-' + c.id, 'Timeline', 'fa-stream', '#67e8f9', timelineHtml, { collapsible: true, defaultOpen: false })}
        </div>
        <div class="cf-col">
          ${cfSection('parties-' + c.id, 'Participants', 'fa-users', '#60b4ff', participantsHtml)}
          ${cfSection('ms-' + c.id, 'Milestones', 'fa-tasks', '#a78bfa', msHtml, { right: `<span class="cf-chip"><i class="fas fa-layer-group"></i>${milestones.length || msCount}</span>` })}
          ${cfSection('proof-' + c.id, 'Proof of Work', 'fa-shield-alt', '#a78bfa', proofsHtml, { collapsible: true, defaultOpen: true, right: `${proofBadge}${proofsAddBtn}` })}
          ${cfSection('bc-' + c.id, 'Blockchain Information', 'fa-link', '#60b4ff', blockchainHtml, { collapsible: true, defaultOpen: false })}
        </div>
      </div>

      <!-- Notes (existing data) -->
      ${notesHtml}

      <!-- 10. Actions -->
      ${cfSection('act-' + c.id, 'Actions', 'fa-bolt', '#34d399', primaryActionsHtml)}

    </div>
  </div>`;
}


// ─── Proof-of-Work Upload Modal ────────────────────────────────────────────────
// Allows contractor (or anyone on the contract) to upload proof files.
// Files are stored as base64 data URLs locally (localStorage via cfSetMeta).
// A SHA-256 fingerprint is computed for each file to prevent tampering.
// After upload, the client must "Commit Proof" to lock it.
function cfShowProofUpload(contractId) {
  document.getElementById('cf-proof-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-proof-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(167,139,250,0.3);border-radius:20px;width:100%;max-width:500px;padding:24px;box-shadow:0 0 40px rgba(167,139,250,0.15);max-height:90vh;overflow-y:auto;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
      <h3 style="color:#dde2f0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;">
        <i class="fas fa-upload" style="color:#a78bfa;"></i>Upload Proof of Work — #${contractId}
      </h3>
      <button onclick="document.getElementById('cf-proof-modal').remove()"
        style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#6b7280;cursor:pointer;display:flex;align-items:center;justify-content:center;">
        <i class="fas fa-times text-xs"></i>
      </button>
    </div>

    <div style="background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.15);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:11px;color:#a78bfa;">
      <i class="fas fa-info-circle mr-1"></i>
      ${t("cf_upload_proof_desc")}
      <strong>${t("cf_upload_proof_commit_hint")}</strong>
    </div>

    <!-- Drop zone -->
    <div id="cf-proof-drop"
      style="border:2px dashed rgba(167,139,250,0.3);border-radius:14px;padding:28px;text-align:center;cursor:pointer;margin-bottom:14px;transition:all 0.2s;"
      onclick="document.getElementById('cf-proof-file-input').click()"
      ondragover="event.preventDefault();this.style.borderColor='#a78bfa';this.style.background='rgba(167,139,250,0.08)'"
      ondragleave="this.style.borderColor='rgba(167,139,250,0.3)';this.style.background=''"
      ondrop="cfHandleProofDrop(event,${contractId})">
      <i class="fas fa-cloud-upload-alt" style="font-size:28px;color:#a78bfa;margin-bottom:8px;display:block;"></i>
      <p style="color:#dde2f0;font-size:13px;font-weight:600;margin-bottom:4px;">Drag files here or click to select</p>
      <p style="color:#4a3a7a;font-size:11px;">${t("cf_file_types_hint")}</p>
    </div>
    <input type="file" id="cf-proof-file-input" multiple accept="image/*,.pdf,.doc,.docx"
      style="display:none;" onchange="cfHandleProofFiles(event,${contractId})">

    <!-- Preview list -->
    <div id="cf-proof-preview-list" style="margin-bottom:14px;"></div>

    <!-- Upload status -->
    <div id="cf-proof-status" style="display:none;margin-bottom:12px;padding:10px 14px;border-radius:10px;font-size:12px;"></div>

    <div style="display:flex;gap:10px;">
      <button onclick="cfExecuteProofUpload(${contractId})" id="cf-proof-upload-btn"
        style="flex:1;background:linear-gradient(135deg,#6d28d9,#5b21b6);color:#fff;border:none;border-radius:12px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
        <i class="fas fa-cloud-upload-alt"></i>Upload & Gerar Hash
      </button>
      <button onclick="document.getElementById('cf-proof-modal').remove()"
        style="padding:11px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">
        Cancel      </button>
    </div>
    <p style="font-size:10px;color:#3a4870;margin-top:10px;text-align:center;">
      <i class="fas fa-shield-alt mr-1"></i>${t("cf_hash_generated_locally")}
    </p>
  </div>`;
  document.body.appendChild(modal);
  window._cfProofFiles = [];
}

function cfHandleProofDrop(event, contractId) {
  event.preventDefault();
  document.getElementById('cf-proof-drop').style.borderColor = 'rgba(167,139,250,0.3)';
  document.getElementById('cf-proof-drop').style.background  = '';
  cfHandleProofFilesRaw(Array.from(event.dataTransfer.files), contractId);
}
function cfHandleProofFiles(event, contractId) {
  cfHandleProofFilesRaw(Array.from(event.target.files), contractId);
}
function cfHandleProofFilesRaw(files, contractId) {
  if (!window._cfProofFiles) window._cfProofFiles = [];
  const MAX = 10 * 1024 * 1024;
  files.forEach(f => {
    if (f.size > MAX) { showToast(`${f.name} exceeds 10MB.`, 'error'); return; }
    if (window._cfProofFiles.length >= 5) { showToast('Max 5 files at a time.', 'warning'); return; }
    const dup = window._cfProofFiles.find(x => x.name === f.name && x.size === f.size);
    if (dup) { showToast(`${f.name} already added.`, 'warning'); return; }
    window._cfProofFiles.push(f);
  });
  cfRenderProofPreview();
}
function cfRenderProofPreview() {
  const el = document.getElementById('cf-proof-preview-list');
  if (!el) return;
  const files = window._cfProofFiles || [];
  if (!files.length) { el.innerHTML = ''; return; }
  el.innerHTML = files.map((f, i) => {
    const icon = f.type.startsWith('image') ? 'fa-image' : f.type === 'application/pdf' ? 'fa-file-pdf' : 'fa-file-word';
    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.15);border-radius:8px;margin-bottom:6px;">
      <i class="fas ${icon}" style="color:#a78bfa;font-size:14px;flex-shrink:0;"></i>
      <div style="flex:1;min-width:0;">
          <div style="font-size:12px;color:#8899bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${cfEsc(f.name)}</div>
        <div style="font-size:10px;color:#4a3a7a;">${(f.size/1024).toFixed(0)} KB · ${f.type || 'unknown'}</div>
      </div>
      <button onclick="window._cfProofFiles.splice(${i},1);cfRenderProofPreview()"
        style="width:22px;height:22px;border-radius:4px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;cursor:pointer;font-size:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-times"></i>
      </button>
    </div>`;
  }).join('');
}

// Compute SHA-256 hash of file ArrayBuffer
async function cfHashFile(file) {
  try {
    const buf    = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

// Execute proof upload — stores files as base64 + SHA-256 hash
async function cfExecuteProofUpload(contractId) {
  const files = window._cfProofFiles || [];
  if (!files.length) { showToast('Please select at least one file.', 'warning'); return; }

  const btn    = document.getElementById('cf-proof-upload-btn');
  const status = document.getElementById('cf-proof-status');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing…'; }
  if (status) {
    status.style.display = 'block';
    status.style.cssText += ';background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.2);color:#60b4ff;';
    status.textContent = 'Generating hashes and storing files…';
  }

  const uploaded = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      if (status) status.textContent = `[${i+1}/${files.length}] Processing: ${file.name}…`;

      // Compute SHA-256 fingerprint
      const hash = await cfHashFile(file);

      // Store as base64 data URL (secure local storage, no external dependency)
      const url = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload  = e => res(e.target.result);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });

      const type = file.type.startsWith('image') ? 'image' : file.type === 'application/pdf' ? 'pdf' : 'doc';
      uploaded.push({
        name:       file.name,
        url,
        type,
        hash:       hash || 'no-crypto',
        size:       file.size,
        mimeType:   file.type,
        uploadedAt: Date.now(),
        committed:  false,  // must be explicitly committed by client
      });
      cfLog(`Proof uploaded: ${file.name} | SHA-256: ${hash?.slice(0,16)}…`);
    } catch (e) {
      cfErr(`Proof upload error (${file.name}):`, e.message);
      showToast(`Erro ao processar ${file.name}: ${e.message}`, 'error');
    }
  }

  if (uploaded.length) {
    const existing = cfGetMeta(contractId).proofs || [];
    // Check for duplicate hashes
    const newProofs = uploaded.filter(u => !existing.some(e => e.hash === u.hash));
    const dupes     = uploaded.length - newProofs.length;
    if (dupes > 0) showToast(`${dupes} duplicate file(s) ignored.`, 'warning');

    cfSetMeta(contractId, { proofs: [...existing, ...newProofs] });
    if (status) {
      status.style.background = 'rgba(52,211,153,0.08)';
      status.style.border     = '1px solid rgba(52,211,153,0.2)';
      status.style.color      = '#34d399';
      status.innerHTML = `✅ ${newProofs.length} file(s) stored!<br>
        <span style="font-size:10px;color:#60b4ff;">${t("cf_hash_click_commit")}</span>`;
    }
    showToast(`✅ ${newProofs.length} proof(s) submitted! Awaiting client commit.`, 'success');
    window._cfProofFiles = [];
    cfRenderProofPreview();
    setTimeout(() => {
      document.getElementById('cf-proof-modal')?.remove();
      cfLoadContracts({ force: true });
    }, 2500);
  } else {
    if (status) { status.style.color = '#f87171'; status.textContent = 'Failed to process files. Please try again.'; }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-cloud-upload-alt mr-2"></i>Upload & Gerar Hash'; }
  }
}

// ─── Proof Viewer Modal ────────────────────────────────────────────────────────
// Opens a full-screen modal to view an uploaded proof (image, PDF or download).
function cfViewProof(contractId, proofIndex) {
  const meta   = cfGetMeta(contractId);
  const proofs = meta.proofs || [];
  if (!proofs.length) { showToast('No proofs available.', 'warning'); return; }

  let idx = (proofIndex != null && proofIndex >= 0 && proofIndex < proofs.length) ? proofIndex : 0;

  document.getElementById('cf-proof-viewer-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-proof-viewer-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.92);backdrop-filter:blur(4px);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:0;overflow:hidden;';

  function buildContent(p) {
    if (!p || !p.url) return `<div style="color:#f87171;font-size:14px;padding:40px;text-align:center;"><i class="fas fa-exclamation-circle" style="font-size:32px;display:block;margin-bottom:12px;"></i>${t("contracts_file_not_available")}</div>`;

    const isImg = p.type === 'image' || (p.mimeType && p.mimeType.startsWith('image/')) || /^data:image\//i.test(p.url);
    const isPdf = p.type === 'pdf' || p.mimeType === 'application/pdf' || /^data:application\/pdf/i.test(p.url);

    if (isImg) {
      return `<div style="flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:16px;">
          <img src="${p.url}" alt="${cfEsc(p.name)}"
          style="max-width:100%;max-height:calc(100vh - 140px);object-fit:contain;border-radius:10px;box-shadow:0 0 40px rgba(0,0,0,0.6);"
          onerror="this.outerHTML='<div style=\\'color:#f87171;text-align:center;padding:40px;\\'><i class=\\"fas fa-image-slash\\" style=\\"font-size:40px;display:block;margin-bottom:12px;\\"></i>Could not render image.</div>'" />
      </div>`;
    }

    if (isPdf) {
      return `<div style="flex:1;width:100%;padding:8px 16px 0;">
<iframe src="${p.url}" sandbox="allow-scripts" style="width:100%;height:calc(100vh - 140px);border:none;border-radius:10px;background:#fff;"
       title="${cfEsc(p.name)}" onerror="">

        </iframe>
        <div style="text-align:center;padding:8px;font-size:11px;color:#4a6490;">
          ${t("cf_pdf_download_hint").replace("{0}", `<button onclick="cfDownloadProof('${btoa(JSON.stringify({url:p.url,name:p.name}))}')" style="background:none;border:none;color:#a78bfa;cursor:pointer;font-size:11px;text-decoration:underline;">${t("contracts_download_here")}</button>`)}
        </div>
      </div>`;
    }

    // Generic / Word / unknown — offer download
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center;">
      <i class="fas fa-file-alt" style="font-size:56px;color:#a78bfa;margin-bottom:16px;"></i>
        <p style="color:#dde2f0;font-size:15px;font-weight:700;margin-bottom:6px;">${cfEsc(p.name)}</p>
      <p style="color:#4a6490;font-size:12px;margin-bottom:20px;">${p.mimeType || 'Tipo desconhecido'} · ${p.size ? (p.size/1024).toFixed(0)+' KB' : ''}</p>
      <button onclick="cfDownloadProofByUrl('${contractId}',${proofs.indexOf(p)})"
        style="padding:11px 24px;background:linear-gradient(135deg,#6d28d9,#5b21b6);color:#fff;border:none;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-download mr-2"></i>${t("cf_download_file")}
      </button>
    </div>`;
  }

  function render() {
    const p = proofs[idx];
    const committed = p?.committed;
    const statusLabel = committed
      ? `<span style="font-size:10px;color:#34d399;"><i class="fas fa-lock mr-1"></i>Committed</span>`
      : `<span style="font-size:10px;color:#fbbf24;"><i class="fas fa-clock mr-1"></i>Pendente</span>`;
    const hashShort = p?.hash ? p.hash.slice(0,16)+'…' : '';
    const hashFull  = p?.hash || '';

    modal.innerHTML = `
      <!-- Header -->
      <div style="width:100%;display:flex;align-items:center;gap:10px;padding:14px 20px;background:rgba(10,12,24,0.95);border-bottom:1px solid rgba(55,138,221,0.12);flex-shrink:0;">
        <button onclick="document.getElementById('cf-proof-viewer-modal').remove()"
          style="width:32px;height:32px;border-radius:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:#f87171;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <i class="fas fa-times"></i>
        </button>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:#dde2f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p?.name || t('cf_file_label')}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:2px;flex-wrap:wrap;">
            ${statusLabel}
            ${hashShort ? `<span style="font-size:9px;font-family:monospace;color:#3a4870;" title="SHA-256: ${hashFull}">${hashShort}</span>` : ''}
            <span style="font-size:9px;color:#252a40;">${idx+1} / ${proofs.length}</span>
          </div>
        </div>
        <!-- Navigation -->
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button onclick="cfViewProofNav(${contractId},${idx - 1})"
            ${idx===0?'disabled':''} id="cf-pv-prev"
            style="width:32px;height:32px;border-radius:8px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.2);color:${idx===0?'#252a40':'#60b4ff'};cursor:${idx===0?'default':'pointer'};font-size:13px;display:flex;align-items:center;justify-content:center;">
            <i class="fas fa-chevron-left"></i>
          </button>
          <button onclick="cfViewProofNav(${contractId},${idx + 1})"
            ${idx===proofs.length-1?'disabled':''} id="cf-pv-next"
            style="width:32px;height:32px;border-radius:8px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.2);color:${idx===proofs.length-1?'#252a40':'#60b4ff'};cursor:${idx===proofs.length-1?'default':'pointer'};font-size:13px;display:flex;align-items:center;justify-content:center;">
            <i class="fas fa-chevron-right"></i>
          </button>
          <button onclick="cfDownloadProofByUrl(${contractId},${idx})"
            style="width:32px;height:32px;border-radius:8px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);color:#a78bfa;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;" title="Baixar">
            <i class="fas fa-download"></i>
          </button>
        </div>
      </div>

      <!-- Thumbnail strip (when multiple proofs) -->
      ${proofs.length > 1 ? `
      <div style="width:100%;display:flex;gap:6px;padding:8px 20px;background:rgba(10,12,24,0.85);overflow-x:auto;flex-shrink:0;border-bottom:1px solid rgba(55,138,221,0.07);">
        ${proofs.map((pp,ii) => {
          const isImg2 = pp.type==='image'||(pp.mimeType&&pp.mimeType.startsWith('image/'))||/^data:image\//i.test(pp.url||'');
          const thumb = isImg2 && pp.url
            ? `<img src="${pp.url}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;">`
            : `<i class="fas ${pp.type==='pdf'?'fa-file-pdf':'fa-file'}" style="font-size:20px;color:${pp.type==='pdf'?'#f87171':'#a78bfa'};"></i>`;
          return `<button onclick="cfViewProofNav(${contractId},${ii})"
            style="flex-shrink:0;width:52px;height:52px;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden;
              background:rgba(${ii===idx?'167,139,250':'55,138,221'},0.1);
              border:2px solid rgba(${ii===idx?'167,139,250':'55,138,221'},${ii===idx?'0.6':'0.15'});
              cursor:pointer;padding:0;">
            ${thumb}
          </button>`;
        }).join('')}
      </div>` : ''}

      <!-- Content area -->
      <div style="flex:1;width:100%;display:flex;flex-direction:column;overflow:auto;">
        ${buildContent(p)}
      </div>
    `;
  }

  render();
  document.body.appendChild(modal);

  // Close on backdrop click (but not on content)
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// Navigate within proof viewer
window.cfViewProofNav = function(contractId, newIdx) {
  const meta   = cfGetMeta(contractId);
  const proofs = meta.proofs || [];
  const safeIdx = Math.max(0, Math.min(proofs.length - 1, Number(newIdx) || 0));
  document.getElementById('cf-proof-viewer-modal')?.remove();
  cfViewProof(contractId, safeIdx);
};

// Download proof by contract id + index
window.cfDownloadProofByUrl = function(contractId, proofIndex) {
  const meta   = cfGetMeta(contractId);
  const proofs = meta.proofs || [];
  const p      = proofs[proofIndex];
  if (!p || !p.url) { showToast(t('contracts_file_unavailable_download'), 'error'); return; }
  try {
    const a = document.createElement('a');
    a.href     = p.url;
    a.download = p.name || `proof_${contractId}_${proofIndex}`;
    a.click();
  } catch(e) {
    showToast('Error downloading file: ' + e.message, 'error');
  }
};

// ─── View On-Chain Proofs Modal ────────────────────────────────────────────────
// Fetches real ARC Testnet data: TX hash, contract address, event logs,
// stored on-chain state, and local proof metadata — all in one modal.
// No mock data — everything is fetched via RPC from Arc Testnet.
window.cfViewOnChainProofs = async function(contractId) {
  document.getElementById('cf-onchain-proofs-modal')?.remove();

  // ── Build skeleton modal immediately ──────────────────────────────────────
  const modal = document.createElement('div');
  modal.id = 'cf-onchain-proofs-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.88);backdrop-filter:blur(6px);display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto;';

  const card = document.createElement('div');
  card.style.cssText = 'background:#0a0c18;border:1px solid rgba(16,185,129,0.3);border-radius:20px;width:100%;max-width:700px;margin:auto;overflow:hidden;box-shadow:0 0 60px rgba(16,185,129,0.1);';
  card.innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:center;gap:10px;padding:16px 20px;background:rgba(16,185,129,0.05);border-bottom:1px solid rgba(16,185,129,0.15);">
      <div style="width:36px;height:36px;border-radius:10px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-search-plus" style="color:#34d399;font-size:14px;"></i>
      </div>
      <div style="flex:1;">
        <div style="font-size:14px;font-weight:800;color:#dde2f0;">On-Chain Proofs & Verification</div>
        <div style="font-size:11px;color:#4a6490;">Contract #${contractId} · ARC Testnet · Chain ID 5042002</div>
      </div>
      <button onclick="document.getElementById('cf-onchain-proofs-modal').remove()"
        style="width:32px;height:32px;border-radius:8px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:#f87171;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-times"></i>
      </button>
    </div>
    <!-- Body -->
    <div id="cf-ocp-body" style="padding:20px;">
      <div style="text-align:center;padding:32px;color:#4a6490;">
        <i class="fas fa-spinner fa-spin" style="font-size:24px;color:#34d399;display:block;margin-bottom:12px;"></i>
        Fetching on-chain data from Arc Testnet…
      </div>
    </div>`;

  modal.appendChild(card);
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  const body = document.getElementById('cf-ocp-body');

  // ── Helper: copy to clipboard ──────────────────────────────────────────────
  window._cfCopy = function(text) {
    navigator.clipboard?.writeText(text).then(() => showToast('Copied!', 'success')).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); showToast('Copied!', 'success'); } catch (_) {}
      document.body.removeChild(ta);
    });
  };

  const copyBtn = (val, label) => `<button onclick="_cfCopy('${val}')" title="Copy ${label}"
    style="width:22px;height:22px;border-radius:5px;background:rgba(55,138,221,0.08);border:1px solid rgba(55,138,221,0.2);color:#3a6090;cursor:pointer;font-size:9px;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;margin-left:4px;">
    <i class="fas fa-copy"></i></button>`;

  const explorerLink = (path, label, color = '#60b4ff') =>
    `<a href="${CF_EXPLORER}/${path}" target="_blank" rel="noopener"
      style="color:${color};font-size:10px;text-decoration:none;display:inline-flex;align-items:center;gap:3px;background:rgba(55,138,221,0.07);border:1px solid rgba(55,138,221,0.15);padding:1px 7px;border-radius:5px;margin-left:4px;">
      <i class="fas fa-external-link-alt" style="font-size:8px;"></i>${label}
    </a>`;

  try {
    const ethers = window.ethers;
    if (!ethers) throw new Error('ethers.js not available');

    const provider = new ethers.JsonRpcProvider(CF_RPC);
    const factory  = new ethers.Contract(CF_FACTORY_ADDR, CF_ABI, provider);

    // ── Fetch on-chain contract data ─────────────────────────────────────────
    const [onChain, milestones, latestBlock] = await Promise.all([
      factory.getContract(contractId).catch(e => { throw new Error('getContract failed: ' + e.message); }),
      factory.getMilestones(contractId).catch(() => []),
      provider.getBlockNumber().catch(() => 0),
    ]);

    const createdAtMs = Number(onChain.createdAt) * 1000;
    const startedAtMs = Number(onChain.startedAt) * 1000;
    const completedAtMs = Number(onChain.completedAt) * 1000;
    const statusLabels = ['Draft', 'Active', 'Completed', 'Cancelled'];
    const onChainStatus = statusLabels[Number(onChain.status)] || `Status(${Number(onChain.status)})`;

    // ── Fetch relevant event logs from ARC Testnet ───────────────────────────
    const iface = new ethers.Interface(CF_ABI);
    const contractIdTopic = '0x' + BigInt(contractId).toString(16).padStart(64, '0');
    const fromBlock = Math.max(0, latestBlock - 100000);

    const eventTopics = {
      ContractCreated:   ethers.id('ContractCreated(uint256,address,address,string,uint256,uint256,uint256)'),
      ContractSigned:    ethers.id('ContractSigned(uint256,address,uint256)'),
      MilestoneReleased: ethers.id('MilestoneReleased(uint256,uint256,address,uint256,uint256)'),
      ContractCancelled: ethers.id('ContractCancelled(uint256,address,uint256,uint256)'),
    };

    const allLogs = [];
    for (const [evName, topic0] of Object.entries(eventTopics)) {
      try {
        const logs = await provider.getLogs({
          address: CF_FACTORY_ADDR,
          topics: [topic0, contractIdTopic],
          fromBlock,
          toBlock: latestBlock,
        });
        for (const log of logs) {
          try {
            const parsed = iface.parseLog(log);
            allLogs.push({ evName, log, parsed, blockNum: Number(log.blockNumber || log.blockNum || 0) });
          } catch(_) {
            allLogs.push({ evName, log, parsed: null, blockNum: Number(log.blockNumber || 0) });
          }
        }
      } catch (_) { /* silently skip if RPC range too large */ }
    }

    // Sort by block number
    allLogs.sort((a, b) => a.blockNum - b.blockNum);

    // Fetch block timestamps for discovered blocks
    const blockNums = [...new Set(allLogs.map(e => e.blockNum).filter(Boolean))];
    const blockTsMap = {};
    await Promise.all(blockNums.slice(0, 20).map(async bn => {
      try {
        const blk = await provider.getBlock(bn);
        if (blk) blockTsMap[bn] = blk.timestamp;
      } catch (_) {}
    }));

    // ── Local proof metadata ──────────────────────────────────────────────────
    const meta = cfGetMeta(contractId);
    const localProofs = meta.proofs || [];
    const txLog = (() => { try { return JSON.parse(localStorage.getItem(CF_TX_LOG_KEY) || '[]'); } catch(_) { return []; } })();
    const myTxLogs = txLog.filter(t => String(t.contractId) === String(contractId));

    // ── Render ─────────────────────────────────────────────────────────────────
    const totalUsdc = (Number(onChain.totalValue) / 1e6).toFixed(2);
    const deposited = (Number(onChain.depositedValue) / 1e6).toFixed(2);
    const signed = onChain.contractorSigned;

    body.innerHTML = `
      <!-- Network banner -->
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:10px;margin-bottom:16px;font-size:11px;">
        <span style="width:8px;height:8px;border-radius:50%;background:#34d399;flex-shrink:0;box-shadow:0 0 6px #34d399;"></span>
        <span style="color:#34d399;font-weight:700;">Live Data — Arc Testnet</span>
        <span style="color:#4a6490;margin-left:auto;">Block #${latestBlock.toLocaleString()} · Fetched ${new Date().toLocaleTimeString()}</span>
        <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" rel="noopener" style="color:#34d399;font-size:10px;text-decoration:none;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);padding:2px 8px;border-radius:5px;white-space:nowrap;">
          <i class="fas fa-external-link-alt" style="font-size:8px;margin-right:3px;"></i>ArcScan
        </a>
      </div>

      <!-- Contract state from on-chain -->
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;color:#34d399;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <i class="fas fa-link"></i>On-Chain Contract State
        </div>
        <div style="background:rgba(10,12,24,0.8);border:1px solid rgba(55,138,221,0.15);border-radius:12px;padding:14px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
            <div style="background:rgba(55,138,221,0.05);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Contract ID</div>
              <div style="font-size:12px;font-weight:800;color:#60b4ff;">#${Number(onChain.id)}</div>
            </div>
            <div style="background:rgba(${onChainStatus==='Active'?'52,211,153':onChainStatus==='Completed'?'96,180,255':onChainStatus==='Cancelled'?'239,68,68':'251,191,36'},0.07);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Status</div>
              <div style="font-size:12px;font-weight:800;color:${onChainStatus==='Active'?'#34d399':onChainStatus==='Completed'?'#60b4ff':onChainStatus==='Cancelled'?'#f87171':'#fbbf24'};">${onChainStatus}</div>
            </div>
            <div style="background:rgba(52,211,153,0.05);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Total Value</div>
              <div style="font-size:13px;font-weight:800;color:#34d399;">$${totalUsdc} USDC</div>
            </div>
            <div style="background:rgba(55,138,221,0.05);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Deposited</div>
              <div style="font-size:13px;font-weight:800;color:#60b4ff;">$${deposited} USDC</div>
            </div>
            <div style="background:rgba(55,138,221,0.04);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Contractor Signed</div>
              <div style="font-size:12px;font-weight:700;color:${signed?'#34d399':'#f87171'};">${signed ? '✓ Signed' : '✗ Unsigned'}</div>
            </div>
            <div style="background:rgba(55,138,221,0.04);border-radius:8px;padding:8px 10px;">
              <div style="font-size:9px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:3px;">Milestones</div>
              <div style="font-size:12px;font-weight:700;color:#a78bfa;">${Number(onChain.completedMilestones)} / ${Number(onChain.milestoneCount)} done</div>
            </div>
          </div>

          <!-- Addresses -->
          <div style="border-top:1px solid rgba(55,138,221,0.1);padding-top:10px;">
            <div style="font-size:10px;margin-bottom:6px;">
              <span style="color:#3a4870;font-weight:700;">Factory:</span>
              <span style="font-family:monospace;font-size:10px;color:#60b4ff;">${CF_FACTORY_ADDR}</span>
              ${copyBtn(CF_FACTORY_ADDR, 'factory address')}
              ${explorerLink('address/' + CF_FACTORY_ADDR, '↗', '#60b4ff')}
            </div>
            <div style="font-size:10px;margin-bottom:6px;">
              <span style="color:#3a4870;font-weight:700;">Client:</span>
              <span style="font-family:monospace;font-size:10px;color:#60b4ff;">${onChain.client}</span>
              ${copyBtn(onChain.client, 'client address')}
              ${explorerLink('address/' + onChain.client, '↗', '#60b4ff')}
            </div>
            <div style="font-size:10px;margin-bottom:6px;">
              <span style="color:#3a4870;font-weight:700;">Contractor:</span>
              <span style="font-family:monospace;font-size:10px;color:#34d399;">${onChain.contractor}</span>
              ${copyBtn(onChain.contractor, 'contractor address')}
              ${explorerLink('address/' + onChain.contractor, '↗', '#34d399')}
            </div>
            <div style="font-size:10px;">
              <span style="color:#3a4870;font-weight:700;">USDC Token:</span>
              <span style="font-family:monospace;font-size:10px;color:#fbbf24;">${CF_USDC_ADDR}</span>
              ${copyBtn(CF_USDC_ADDR, 'USDC address')}
              ${explorerLink('address/' + CF_USDC_ADDR, '↗', '#fbbf24')}
            </div>
          </div>

          <!-- Timestamps -->
          <div style="border-top:1px solid rgba(55,138,221,0.1);padding-top:10px;margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;font-size:10px;color:#4a6490;">
            ${createdAtMs > 0 ? `<span><i class="fas fa-clock mr-1"></i>Created: <span style="color:#8899bb;">${new Date(createdAtMs).toLocaleString()}</span></span>` : ''}
            ${startedAtMs > 0 ? `<span><i class="fas fa-play mr-1"></i>Started: <span style="color:#8899bb;">${new Date(startedAtMs).toLocaleString()}</span></span>` : ''}
            ${completedAtMs > 0 ? `<span><i class="fas fa-flag-checkered mr-1"></i>Completed: <span style="color:#34d399;">${new Date(completedAtMs).toLocaleString()}</span></span>` : ''}
          </div>
        </div>
      </div>

      <!-- Milestones on-chain -->
      ${milestones.length > 0 ? `
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <i class="fas fa-tasks"></i>Milestones (On-Chain)
        </div>
        <div style="background:rgba(10,12,24,0.8);border:1px solid rgba(167,139,250,0.15);border-radius:12px;overflow:hidden;">
          ${milestones.map((m, i) => {
            const msStatus = ['Pending','Released'][Number(m.status)] || `Status(${Number(m.status)})`;
            const relTs = Number(m.releasedAt) > 0 ? new Date(Number(m.releasedAt)*1000).toLocaleString() : null;
            return `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid rgba(167,139,250,0.06);${i===milestones.length-1?'border-bottom:none;':''}">
              <div style="width:22px;height:22px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:9px;
                ${msStatus==='Released'?'background:rgba(52,211,153,0.2);border:1px solid rgba(52,211,153,0.4);color:#34d399':'background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);color:#a78bfa'}">
                <i class="fas ${msStatus==='Released'?'fa-check':'fa-clock'}"></i>
              </div>
              <span style="flex:1;font-size:12px;color:#8899bb;">${m.description}</span>
              <span style="font-size:12px;font-weight:700;color:#a78bfa;">$${(Number(m.amount)/1e6).toFixed(2)}</span>
              <span style="font-size:10px;padding:2px 8px;border-radius:5px;
                ${msStatus==='Released'?'background:rgba(52,211,153,0.12);color:#34d399':'background:rgba(167,139,250,0.1);color:#a78bfa'}">
                ${msStatus}${relTs ? ` · ${relTs}` : ''}
              </span>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

      <!-- Event Logs from ARC Testnet -->
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;color:#fbbf24;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <i class="fas fa-receipt"></i>On-Chain Event Logs (${allLogs.length})
          ${allLogs.length === 0 ? `<span style="font-size:9px;color:#4a6490;font-weight:400;">(scanned last 100k blocks)</span>` : ''}
        </div>
        <div style="background:rgba(10,12,24,0.8);border:1px solid rgba(245,158,11,0.15);border-radius:12px;overflow:hidden;">
          ${allLogs.length === 0 ? `
            <div style="text-align:center;padding:20px;font-size:12px;color:#4a6490;">
              <i class="fas fa-search" style="font-size:20px;display:block;margin-bottom:8px;"></i>
              No indexed events found in the scanned range.<br>
              <span style="font-size:10px;">Contract may have been created before the scan window, or no events have occurred yet.</span>
              <div style="margin-top:8px;">
                ${explorerLink('address/' + CF_FACTORY_ADDR, 'View Factory on ArcScan ↗', '#fbbf24')}
              </div>
            </div>` :
            allLogs.map((e, i) => {
              const ts = blockTsMap[e.blockNum] ? new Date(blockTsMap[e.blockNum] * 1000).toLocaleString() : `Block #${e.blockNum}`;
              const txShort = e.log.transactionHash ? e.log.transactionHash.slice(0,24) + '…' : '—';
              const evColors = {
                ContractCreated:   { bg: '52,211,153', color: '#34d399', icon: 'fa-file-contract' },
                ContractSigned:    { bg: '96,180,255', color: '#60b4ff', icon: 'fa-pen-nib' },
                MilestoneReleased: { bg: '167,139,250', color: '#a78bfa', icon: 'fa-flag-checkered' },
                ContractCancelled: { bg: '239,68,68',  color: '#f87171', icon: 'fa-times-circle' },
              };
              const ec = evColors[e.evName] || { bg: '251,191,36', color: '#fbbf24', icon: 'fa-bolt' };
              return `<div style="padding:10px 14px;border-bottom:1px solid rgba(245,158,11,0.06);${i===allLogs.length-1?'border-bottom:none;':''}">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                  <span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;background:rgba(${ec.bg},0.12);border:1px solid rgba(${ec.bg},0.25);color:${ec.color};padding:2px 8px;border-radius:5px;">
                    <i class="fas ${ec.icon}" style="font-size:8px;"></i>${e.evName}
                  </span>
                  <span style="font-size:10px;color:#4a6490;">${ts}</span>
                  <span style="font-size:9px;font-family:monospace;color:#3a4870;margin-left:auto;">Block #${e.blockNum.toLocaleString()}</span>
                </div>
                ${e.log.transactionHash ? `
                <div style="display:flex;align-items:center;gap:4px;font-size:10px;color:#3a6090;">
                  <span style="color:#4a6490;">TX:</span>
                  <span style="font-family:monospace;color:#60b4ff;">${txShort}</span>
                  ${copyBtn(e.log.transactionHash, 'tx hash')}
                  ${explorerLink('tx/' + e.log.transactionHash, '↗', '#60b4ff')}
                </div>` : ''}
                ${e.parsed ? `<div style="margin-top:4px;font-size:9px;color:#3a4870;font-family:monospace;background:rgba(55,138,221,0.04);border-radius:5px;padding:4px 8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;">
                  ${Object.keys(e.parsed.args).filter(k => isNaN(Number(k))).map(k => {
                    let v = e.parsed.args[k];
                    if (typeof v === 'bigint') v = v.toString();
                    else if (typeof v === 'object') v = JSON.stringify(v);
                    return `${k}: ${v}`;
                  }).join('\n')}
                </div>` : ''}
              </div>`;
            }).join('')
          }
        </div>
      </div>

      <!-- Local Proof Metadata -->
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <i class="fas fa-shield-alt"></i>Proof of Work — Local Records (${localProofs.length})
        </div>
        ${localProofs.length === 0 ? `
          <div style="background:rgba(10,12,24,0.8);border:1px solid rgba(167,139,250,0.12);border-radius:12px;padding:16px;text-align:center;font-size:12px;color:#4a6490;">
            <i class="fas fa-inbox" style="font-size:18px;display:block;margin-bottom:6px;"></i>
            No proofs available. The contractor hasn't uploaded any proof of work yet.
          </div>` :
          `<div style="background:rgba(10,12,24,0.8);border:1px solid rgba(167,139,250,0.15);border-radius:12px;overflow:hidden;">
            ${localProofs.map((p, pi) => {
              const committed = !!p.committed;
              const hashShort = p.hash ? p.hash.slice(0,20) + '…' : '—';
              const sizeKb = p.size ? (p.size/1024).toFixed(0) + ' KB' : '';
              return `<div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(167,139,250,0.06);${pi===localProofs.length-1?'border-bottom:none;':''}">
                <div style="width:32px;height:32px;border-radius:8px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.2);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                  <i class="fas ${p.type==='image'?'fa-image':p.type==='pdf'?'fa-file-pdf':'fa-file'}" style="color:${committed?'#34d399':'#a78bfa'};font-size:14px;"></i>
                </div>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:12px;font-weight:700;color:#dde2f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name || 'Unnamed file'}</div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;align-items:center;">
                    <span style="font-size:9px;padding:1px 7px;border-radius:5px;font-weight:700;
                      ${committed?'background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.3);color:#34d399':'background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);color:#fbbf24'}">
                      <i class="fas ${committed?'fa-lock':'fa-clock'} mr-1" style="font-size:7px;"></i>${committed?'Committed':'Pending'}
                    </span>
                    ${sizeKb ? `<span style="font-size:9px;color:#4a6490;">${sizeKb}</span>` : ''}
                    ${p.uploadedAt ? `<span style="font-size:9px;color:#4a6490;">${new Date(p.uploadedAt).toLocaleDateString()}</span>` : ''}
                  </div>
                  ${p.hash ? `<div style="font-size:9px;font-family:monospace;color:#3a4870;margin-top:3px;">
                    SHA-256: <span style="color:#4a6490;">${hashShort}</span>
                    ${copyBtn(p.hash, 'SHA-256 hash')}
                  </div>` : ''}
                  ${p.committedAt ? `<div style="font-size:9px;color:#34d399;margin-top:2px;"><i class="fas fa-check mr-1"></i>Committed: ${new Date(p.committedAt).toLocaleString()}</div>` : ''}
                </div>
                <button onclick="cfViewProof(${contractId},${pi})"
                  style="flex-shrink:0;padding:5px 12px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);color:#a78bfa;border-radius:7px;font-size:10px;cursor:pointer;white-space:nowrap;">
                  <i class="fas fa-eye mr-1"></i>View
                </button>
              </div>`;
            }).join('')}
          </div>`
        }
      </div>

      <!-- Local TX log for this contract -->
      ${myTxLogs.length > 0 ? `
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;color:#60b4ff;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <i class="fas fa-list"></i>Local Transaction Log (${myTxLogs.length})
        </div>
        <div style="background:rgba(10,12,24,0.8);border:1px solid rgba(96,180,255,0.15);border-radius:12px;overflow:hidden;">
          ${myTxLogs.map((t, ti) => `
            <div style="padding:10px 14px;border-bottom:1px solid rgba(96,180,255,0.06);${ti===myTxLogs.length-1?'border-bottom:none;':''}">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:${t.txHash?'4px':'0'};">
                <span style="font-size:11px;font-weight:600;color:#dde2f0;">${t.action || t.type || 'tx'}</span>
                <span style="font-size:9px;color:#4a6490;margin-left:auto;">${t.timestamp ? new Date(t.timestamp).toLocaleString() : ''}</span>
              </div>
              ${t.txHash ? `<div style="font-size:10px;font-family:monospace;color:#60b4ff;">
                ${t.txHash.slice(0,26)}…
                ${copyBtn(t.txHash, 'tx hash')}
                ${explorerLink('tx/' + t.txHash, '↗', '#60b4ff')}
              </div>` : ''}
            </div>`).join('')}
        </div>
      </div>` : ''}

      <!-- Footer actions -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid rgba(55,138,221,0.1);padding-top:14px;">
        <a href="${CF_EXPLORER}/address/${CF_FACTORY_ADDR}" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);color:#34d399;border-radius:10px;font-size:11px;font-weight:700;text-decoration:none;">
          <i class="fas fa-external-link-alt"></i>View Factory on ArcScan
        </a>
        <button onclick="document.getElementById('cf-onchain-proofs-modal').remove()"
          style="padding:8px 16px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;border-radius:10px;font-size:11px;font-weight:700;cursor:pointer;">
          <i class="fas fa-times mr-1"></i>Close
        </button>
      </div>
    `;

  } catch (err) {
    console.error('[cfViewOnChainProofs]', err);
    if (body) body.innerHTML = `
      <div style="text-align:center;padding:32px;">
        <i class="fas fa-exclamation-circle" style="font-size:32px;color:#f87171;display:block;margin-bottom:12px;"></i>
        <div style="font-size:14px;font-weight:700;color:#f87171;margin-bottom:8px;">Failed to fetch on-chain data</div>
        <div style="font-size:12px;color:#4a6490;margin-bottom:16px;">${err.message}</div>

        <!-- Local proof fallback -->
        ${(() => {
          const meta2 = cfGetMeta(contractId);
          const lp = meta2.proofs || [];
          if (!lp.length) return `<div style="font-size:12px;color:#4a6490;">No local proof records found either.</div>`;
          return `<div style="text-align:left;margin-top:12px;">
            <div style="font-size:10px;font-weight:700;color:#a78bfa;margin-bottom:8px;text-transform:uppercase;">Local Proof Records (${lp.length})</div>
            ${lp.map((p, pi) => `
              <div style="display:flex;align-items:center;gap:8px;padding:8px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.15);border-radius:8px;margin-bottom:4px;">
                <i class="fas ${p.type==='image'?'fa-image':p.type==='pdf'?'fa-file-pdf':'fa-file'}" style="color:${p.committed?'#34d399':'#a78bfa'};"></i>
                <span style="flex:1;font-size:11px;color:#8899bb;">${cfEsc(p.name)}</span>
                <span style="font-size:9px;color:${p.committed?'#34d399':'#fbbf24'};">${p.committed?'Committed':'Pending'}</span>
                <button onclick="cfViewProof(${contractId},${pi})" style="font-size:10px;color:#a78bfa;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.18);padding:2px 8px;border-radius:5px;cursor:pointer;">View</button>
              </div>`).join('')}
          </div>`;
        })()}

        <div style="display:flex;gap:8px;justify-content:center;margin-top:16px;">
          <button onclick="cfViewOnChainProofs(${contractId})"
            style="padding:8px 16px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);color:#34d399;border-radius:8px;font-size:11px;cursor:pointer;">
            <i class="fas fa-redo mr-1"></i>Retry
          </button>
          <button onclick="document.getElementById('cf-onchain-proofs-modal').remove()"
            style="padding:8px 16px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#f87171;border-radius:8px;font-size:11px;cursor:pointer;">
            Close
          </button>
        </div>
      </div>`;
  }
};

// ─── Delete Proof (contractor action) ─────────────────────────────────────────
// Allows the contractor (uploader) to delete a pending (uncommitted) proof.
// Shows a confirmation modal before deletion.
// Committed proofs are protected and cannot be deleted.
function cfDeleteProof(contractId, proofIndex) {
  const meta   = cfGetMeta(contractId);
  const proofs = meta.proofs || [];
  const proof  = proofs[proofIndex];

  if (!proof) { showToast('Proof not found.', 'error'); return; }
  if (proof.committed) {
    showToast('Committed proofs cannot be deleted.', 'warning');
    return;
  }

  // ── Confirmation modal ──────────────────────────────────────────────────────
  document.getElementById('cf-delete-proof-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-delete-proof-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.82);backdrop-filter:blur(4px);';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(239,68,68,0.35);border-radius:20px;width:100%;max-width:420px;padding:26px;box-shadow:0 0 40px rgba(239,68,68,0.12);">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
      <div style="width:38px;height:38px;border-radius:10px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fas fa-trash-alt" style="color:#f87171;font-size:15px;"></i>
      </div>
      <div>
        <h3 style="color:#f1f5f9;font-size:15px;font-weight:800;margin:0 0 2px;">Delete Proof?</h3>
        <p style="color:#6b7280;font-size:11px;margin:0;">This action cannot be undone.</p>
      </div>
    </div>
    <div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.18);border-radius:10px;padding:10px 14px;margin-bottom:18px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <i class="fas fa-file" style="color:#f87171;font-size:13px;flex-shrink:0;"></i>
          <span style="font-size:12px;color:#dde2f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${cfEsc(proof.name)}</span>
      </div>
      <div style="font-size:10px;color:#6b7280;margin-top:4px;font-family:monospace;">SHA-256: ${proof.hash ? proof.hash.slice(0,16) + '…' : 'n/a'}</div>
    </div>
    <p style="font-size:12px;color:#9ca3af;margin-bottom:20px;line-height:1.5;">
      Are you sure you want to delete this proof?<br>
      <span style="color:#fbbf24;">Only pending (uncommitted) proofs can be deleted.</span>
    </p>
    <div style="display:flex;gap:10px;">
      <button onclick="cfConfirmDeleteProof(${contractId},${proofIndex})"
        style="flex:1;background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;border:none;border-radius:12px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
        <i class="fas fa-trash-alt"></i>Yes, Delete Proof
      </button>
      <button onclick="document.getElementById('cf-delete-proof-modal').remove()"
        style="padding:11px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;font-weight:600;">
        Cancel
      </button>
    </div>
  </div>`;
  document.body.appendChild(modal);

  // Close on backdrop click
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// Execute the actual deletion after confirmation
function cfConfirmDeleteProof(contractId, proofIndex) {
  document.getElementById('cf-delete-proof-modal')?.remove();

  const meta   = cfGetMeta(contractId);
  const proofs = meta.proofs || [];
  const proof  = proofs[proofIndex];

  if (!proof) { showToast('Proof not found.', 'error'); return; }
  if (proof.committed) { showToast('Cannot delete a committed proof.', 'warning'); return; }

  const proofName = proof.name;

  // Remove from array and save
  proofs.splice(proofIndex, 1);
  cfSetMeta(contractId, { proofs });

  showToast(`✅ Proof "${proofName}" deleted successfully.`, 'success');
  cfLog(`Proof deleted: contract #${contractId}, index ${proofIndex}, file: ${proofName}`);

  // Refresh contracts view
  cfLoadContracts({ force: true });
}

// ─── Commit Proof (client action) ─────────────────────────────────────────────
// Locks all uploaded proofs, marking them as committed.
// Only the client should do this after reviewing the proof.
async function cfCommitProof(contractId) {
  const wallet = window.walletState?.address;
  const c = cfState.contracts.find(x => x.id === contractId);
  const meta = cfGetMeta(contractId);
  const proofs = meta.proofs || [];

  if (!proofs.length) { showToast(t('cf_no_proof_to_confirm'), 'warning'); return; }
  const uncommitted = proofs.filter(p => !p.committed);
  if (!uncommitted.length) { showToast(t('contracts_all_proofs_committed'), 'info'); return; }

  // Show confirmation modal
  document.getElementById('cf-commit-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-commit-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(52,211,153,0.3);border-radius:20px;width:100%;max-width:440px;padding:24px;">
    <h3 style="color:#dde2f0;font-size:15px;font-weight:800;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
      <i class="fas fa-stamp" style="color:#34d399;"></i>Confirmar Prova de Trabalho — #${contractId}
    </h3>
    <div style="background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.2);border-radius:10px;padding:12px;margin-bottom:14px;">
      <p style="font-size:12px;color:#6ee7b7;margin-bottom:8px;font-weight:600;">${t("cf_files_to_confirm", uncommitted.length)}</p>
      ${uncommitted.map(p => `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(52,211,153,0.1);">
          <i class="fas ${p.type==='image'?'fa-image':p.type==='pdf'?'fa-file-pdf':'fa-file'}" style="color:#34d399;font-size:12px;"></i>
          <span style="flex:1;font-size:11px;color:#8899bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${cfEsc(p.name)}</span>
          <span style="font-size:9px;font-family:monospace;color:#3a4870;">${p.hash?.slice(0,12)}…</span>
        </div>`).join('')}
    </div>
    <div style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:8px;padding:10px;margin-bottom:14px;font-size:11px;color:#fbbf24;">
      <i class="fas fa-exclamation-triangle mr-1"></i>
      By confirming, you attest that you have reviewed the proof of work and agree. This action <strong>cannot be undone</strong>.
      ${(c?.milestoneCount || 0) > 0 ? `<br><br>${t("cf_after_confirm_hint")}` : ''}
    </div>
    <div style="display:flex;gap:10px;">
      <button onclick="cfExecuteCommitProof(${contractId})" id="cf-commit-btn"
        style="flex:1;background:linear-gradient(135deg,#065f46,#047857);color:#fff;border:none;border-radius:12px;padding:12px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-stamp mr-2"></i>Confirm & Lock Proof
      </button>
      <button onclick="document.getElementById('cf-commit-modal').remove()"
        style="padding:12px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancelar</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

async function cfExecuteCommitProof(contractId) {
  const btn = document.getElementById('cf-commit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Confirmando…'; }

  try {
    const meta = cfGetMeta(contractId);
    const proofs = (meta.proofs || []).map(p => ({
      ...p,
      committed:   true,
      committedAt: Date.now(),
      committedBy: window.walletState?.address || 'unknown',
    }));

    // Compute a combined commitment hash (SHA-256 of all individual hashes)
    const combinedInput = proofs.map(p => p.hash).join('|') + '|' + contractId + '|' + Date.now();
    const enc = new TextEncoder().encode(combinedInput);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    const commitmentHash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');

    cfSetMeta(contractId, {
      proofs,
      commitmentHash,
      commitmentTs: Date.now(),
      commitmentWallet: window.walletState?.address || 'unknown',
    });

    cfLog(`Proof committed for #${contractId} | commitment: ${commitmentHash.slice(0,16)}…`);
    cfLogTx('commitProof', commitmentHash, contractId, {
      proofCount: proofs.length,
      commitment: commitmentHash,
    });

    document.getElementById('cf-commit-modal')?.remove();
    showToast(`✅ Prova confirmada e bloqueada! Hash: ${commitmentHash.slice(0,16)}…`, 'success');
    await cfLoadContracts({ force: true });
  } catch (e) {
    cfErr('cfExecuteCommitProof:', e.message);
    showToast(`❌ Erro ao confirmar: ${e.message}`, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-stamp mr-2"></i>Confirm & Lock Proof'; }
  }
}

// ─── QR Code Generator (native canvas — no external APIs required) ───────────
// Uses Google Charts API as primary, canvas fallback as secondary.
function cfGenerateQrCanvas(text, size) {
  size = size || 200;
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'text-align:center;';
  const img = document.createElement('img');
  img.src = `https://chart.googleapis.com/chart?cht=qr&chs=${size}x${size}&chl=${encodeURIComponent(text)}&choe=UTF-8&chld=M|2`;
  img.style.cssText = `border-radius:10px;background:#fff;padding:6px;width:${size}px;height:${size}px;display:inline-block;`;
  img.alt = 'QR Code';
  img.onerror = function() {
    this.style.display = 'none';
    // Fallback: simple canvas pattern
    try {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
        const bytes = Array.from(text).map(function(c) { return c.charCodeAt(0); });
        const cell  = Math.max(4, Math.floor(size / 29));
        const cols  = Math.floor(size / cell);
        ctx.fillStyle = '#000000';
        // Draw corner finder patterns
        [[0,0],[0,cols-7],[cols-7,0]].forEach(function(pos) {
          var cx = pos[0], cy = pos[1];
          ctx.fillStyle = '#000000';
          ctx.fillRect(cx*cell, cy*cell, 7*cell, 7*cell);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect((cx+1)*cell, (cy+1)*cell, 5*cell, 5*cell);
          ctx.fillStyle = '#000000';
          ctx.fillRect((cx+2)*cell, (cy+2)*cell, 3*cell, 3*cell);
        });
        // Encode data from URL bytes
        var bi = 0;
        for (var row = 0; row < cols; row++) {
          for (var col = 0; col < cols; col++) {
            if (row < 9 && (col < 9 || col > cols-9)) continue;
            if (row > cols-9 && col < 9) continue;
            var b   = bytes[bi % bytes.length];
            var bit = (b >> (7 - (bi % 8))) & 1;
            if (bit) { ctx.fillStyle = '#000000'; ctx.fillRect(col*cell, row*cell, cell, cell); }
            bi++;
          }
        }
        canvas.style.cssText = `border-radius:10px;display:inline-block;`;
        wrapper.appendChild(canvas);
      }
    } catch(e) {
      wrapper.innerHTML += '<p style="font-size:11px;color:#3a4870;padding:10px;">QR indispon\u00edvel \u2014 copie o link abaixo</p>';
    }
  };
  wrapper.appendChild(img);
  return wrapper;
}

// ─── Wallet-Link / QR Code (wallet-less authorization) ────────────────────────
// Generates a shareable link + QR code for the contractor to interact
// without a browser wallet extension.
function cfShowWalletLink(contractId) {
  const c    = cfState.contracts.find(function(x) { return x.id === contractId; });
  const meta = cfGetMeta(contractId);
  const mode = meta.mode || 'onchain';

  const baseUrl    = window.location.origin + window.location.pathname;
  const linkParams = new URLSearchParams({
    action:     'contract',
    id:         String(contractId),
    factory:    CF_FACTORY_ADDR,
    chain:      String(CF_CHAIN_ID),
    client:     c && c.client ? c.client : '',
    contractor: c && c.contractor ? c.contractor : '',
    title:      c && c.title ? c.title : '',
    mode:       mode,
  });
  const shareLink   = `${baseUrl}?${linkParams.toString()}#contracts`;
  const mmLink      = `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}?${linkParams.toString()}`;
  const rainbowLink = `rainbow://dapp?url=${encodeURIComponent(shareLink)}`;
  const trustLink   = `trust://open_url?coin_id=60&url=${encodeURIComponent(shareLink)}`;
  const contractorEmail = meta.contractorEmail || '';

  const emailSubject = encodeURIComponent(`ARC Contract #${contractId} \u2014 A\u00e7\u00e3o Necess\u00e1ria`);
  const emailBody    = encodeURIComponent(
    'Ol\u00e1!\n\nVoc\u00ea foi convidado para interagir com o contrato ARC #' + contractId + '.\n\n' +
    'T\u00edtulo: ' + (c && c.title ? c.title : 'Sem t\u00edtulo') + '\n' +
    'Valor: $' + (c ? cfFmtUsdc(c.totalValue) : '?') + ' USDC\n' +
    'Rede: Arc Testnet (Chain ' + CF_CHAIN_ID + ')\n\n' +
    '=== ACESSO DIRETO ===\n' + shareLink + '\n\n' +
    '=== DEEP LINKS MOBILE ===\n' +
    'MetaMask Mobile: ' + mmLink + '\n' +
    'Rainbow: ' + rainbowLink + '\n\n' +
    'Se n\u00e3o tiver wallet, baixe MetaMask: https://metamask.io/download/\n\n' +
    'Factory: ' + CF_FACTORY_ADDR + '\nChain: ' + CF_CHAIN_ID
  );
  const emailLink = `mailto:${contractorEmail}?subject=${emailSubject}&body=${emailBody}`;

  document.getElementById('cf-walletlink-modal') && document.getElementById('cf-walletlink-modal').remove();
  const modal = document.createElement('div');
  modal.id = 'cf-walletlink-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(96,180,255,0.3);border-radius:20px;width:100%;max-width:500px;padding:24px;max-height:90vh;overflow-y:auto;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
      <h3 style="color:#dde2f0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;">
        <i class="fas fa-qrcode" style="color:#60b4ff;"></i>Wallet-Link &mdash; #${contractId}
      </h3>
      <button onclick="document.getElementById('cf-walletlink-modal').remove()"
        style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#6b7280;cursor:pointer;">&times;</button>
    </div>

    <div style="background:rgba(96,180,255,0.06);border:1px solid rgba(96,180,255,0.15);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:11px;color:#60b4ff;">
      <i class="fas fa-info-circle mr-1"></i>
      Compartilhe com o contratado. Ele pode assinar, enviar prova ou interagir com o contrato
      <strong>sem MetaMask instalado</strong> &mdash; basta uma wallet mobile (Rainbow, Trust, MetaMask Mobile).
    </div>

    <div id="cf-wl-qr-container" style="text-align:center;margin-bottom:16px;min-height:220px;display:flex;align-items:center;justify-content:center;"></div>

    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#3a4870;text-transform:uppercase;font-weight:700;margin-bottom:4px;display:block;">Link de Acesso Direto</label>
      <div style="display:flex;gap:6px;">
        <input id="cf-share-link-${contractId}" value="${shareLink.replace(/"/g,'&quot;')}" readonly
          style="flex:1;background:rgba(55,138,221,0.06);border:1px solid rgba(55,138,221,0.2);color:#dde2f0;border-radius:8px;padding:8px 10px;font-size:11px;font-family:monospace;outline:none;">
        <button onclick="var inp=document.getElementById('cf-share-link-${contractId}');if(inp){navigator.clipboard.writeText(inp.value).then(function(){showToast('Link copiado!','success')});}"
          style="padding:8px 12px;background:rgba(55,138,221,0.15);border:1px solid rgba(55,138,221,0.3);color:#60b4ff;border-radius:8px;cursor:pointer;font-size:11px;white-space:nowrap;">
          <i class="fas fa-copy mr-1"></i>Copiar
        </button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
      <a href="${emailLink}" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;background:rgba(96,180,255,0.08);border:1px solid rgba(96,180,255,0.2);color:#60b4ff;border-radius:10px;font-size:12px;font-weight:600;text-decoration:none;">
        <i class="fas fa-envelope"></i>${contractorEmail ? 'Email Contratado' : 'Abrir Email'}
      </a>
      <a href="${mmLink}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);color:#fbbf24;border-radius:10px;font-size:12px;font-weight:600;text-decoration:none;">
        <i class="fas fa-mobile-alt"></i>MetaMask Mobile
      </a>
      <a href="${rainbowLink}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);color:#a78bfa;border-radius:10px;font-size:12px;font-weight:600;text-decoration:none;">
        <i class="fas fa-mobile-alt"></i>Rainbow Wallet
      </a>
      <a href="${trustLink}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);color:#34d399;border-radius:10px;font-size:12px;font-weight:600;text-decoration:none;">
        <i class="fas fa-shield-alt"></i>Trust Wallet
      </a>
    </div>

    <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px;font-size:11px;margin-bottom:10px;">
      <div style="color:#3a4870;font-weight:700;text-transform:uppercase;margin-bottom:6px;letter-spacing:0.06em;">Detalhes do Contrato</div>
      <div style="color:#8899bb;margin-bottom:2px;">T&iacute;tulo: <span style="color:#dde2f0;">${c && c.title ? c.title.replace(/</g,'&lt;').replace(/>/g,'&gt;') : '&mdash;'}</span></div>
      <div style="color:#8899bb;margin-bottom:2px;">Valor: <span style="color:#dde2f0;">$${c ? cfFmtUsdc(c.totalValue) : '&mdash;'} USDC</span></div>
      <div style="color:#8899bb;margin-bottom:2px;">Mode: <span style="color:${CF_MODES[mode] ? CF_MODES[mode].color : '#dde2f0'};">${CF_MODES[mode] ? CF_MODES[mode].label : mode}</span></div>
      <div style="color:#8899bb;margin-bottom:2px;">Chain: <span style="color:#dde2f0;">Arc Testnet (${CF_CHAIN_ID})</span></div>
      <div style="color:#8899bb;">Contratado: <span style="font-family:monospace;color:#34d399;">${cfShort(c && c.contractor ? c.contractor : '')}</span></div>
      ${contractorEmail ? `<div style="color:#8899bb;margin-top:4px;">Email: <span style="color:#60b4ff;">${contractorEmail}</span></div>` : ''}
    </div>

    <p style="font-size:10px;color:#252a40;text-align:center;">
      <i class="fas fa-clock mr-1"></i>Link expira quando o contrato for conclu&iacute;do ou cancelado.
    </p>
  </div>`;
  document.body.appendChild(modal);

  // Inject QR code after modal is in DOM
  const qrContainer = document.getElementById('cf-wl-qr-container');
  if (qrContainer) {
    const qrEl = cfGenerateQrCanvas(shareLink, 200);
    qrContainer.appendChild(qrEl);
  }
}

// ─── Off-Chain Status Update Modal ────────────────────────────────────────────
function cfShowOffchainActions(contractId) {
  const meta = cfGetMeta(contractId);
  document.getElementById('cf-offchain-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'cf-offchain-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  const mode = meta.mode || 'offchain';
  modal.innerHTML = `
  <div style="background:#0a0c18;border:1px solid rgba(251,191,36,0.3);border-radius:20px;width:100%;max-width:460px;padding:24px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
      <h3 style="color:#dde2f0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;">
        <i class="fas fa-tasks" style="color:#fbbf24;"></i>Atualizar Status — #${contractId}
      </h3>
      <button onclick="document.getElementById('cf-offchain-modal').remove()"
        style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#6b7280;cursor:pointer;">✕</button>
    </div>

    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#3a4870;font-weight:700;display:block;margin-bottom:6px;">Status do Pagamento</label>
      <select id="cf-offchain-status" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(251,191,36,0.3);color:#dde2f0;border-radius:8px;padding:9px 12px;font-size:13px;outline:none;">
        <option value="pending"   ${meta.offchainStatus==='pending'  ?'selected':''}>${t("cf_status_pending")}</option>
        <option value="in_custody" ${meta.offchainStatus==='in_custody'?'selected':''}>${t("cf_status_in_custody")}</option>
        <option value="paid"      ${meta.offchainStatus==='paid'     ?'selected':''}>💳 Paid — Awaiting confirmation</option>
        <option value="confirmed" ${meta.offchainStatus==='confirmed'?'selected':''}>✅ Confirmed — Confirmado</option>
        <option value="disputed"  ${meta.offchainStatus==='disputed' ?'selected':''}>${t("cf_status_disputed")}</option>
        <option value="released"  ${meta.offchainStatus==='released' ?'selected':''}>🎉 Released</option>
      </select>
    </div>

    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#3a4870;font-weight:700;display:block;margin-bottom:6px;">Nota de Pagamento</label>
      <textarea id="cf-offchain-note" placeholder="${t('cf_offchain_note_placeholder')}"
        style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(251,191,36,0.2);color:#dde2f0;border-radius:8px;padding:9px 12px;font-size:12px;outline:none;resize:vertical;min-height:72px;">${meta.paymentNote || ''}</textarea>
    </div>

    ${mode === 'custodial' ? `
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;color:#3a4870;font-weight:700;display:block;margin-bottom:6px;">${t("contracts_custody_reference")}</label>
      <input id="cf-escrow-ref" type="text" placeholder="Ex: escrow-abc123, hash da tx, ID da plataforma…"
        value="${meta.escrowRef || ''}"
        style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(167,139,250,0.2);color:#dde2f0;border-radius:8px;padding:9px 12px;font-size:12px;outline:none;">
    </div>` : ''}

    <div style="display:flex;gap:10px;">
      <button onclick="cfSaveOffchainStatus(${contractId})" id="cf-offchain-save-btn"
        style="flex:1;background:linear-gradient(135deg,#92400e,#b45309);color:#fff;border:none;border-radius:12px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;">
        <i class="fas fa-save mr-2"></i>Salvar Status
      </button>
      <button onclick="document.getElementById('cf-offchain-modal').remove()"
        style="padding:11px 18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#6b7280;border-radius:12px;cursor:pointer;font-size:13px;">Cancelar</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

function cfSaveOffchainStatus(contractId) {
  const status   = document.getElementById('cf-offchain-status')?.value;
  const note     = document.getElementById('cf-offchain-note')?.value?.trim();
  const escrowRef = document.getElementById('cf-escrow-ref')?.value?.trim();

  cfSetMeta(contractId, {
    offchainStatus:   status,
    paymentNote:      note || cfGetMeta(contractId).paymentNote,
    ...(escrowRef ? { escrowRef } : {}),
    offchainUpdatedAt: Date.now(),
    offchainUpdatedBy: window.walletState?.address || 'unknown',
  });

  cfLogTx('offchainStatusUpdate', 'local-' + Date.now(), contractId, { status, note });
  document.getElementById('cf-offchain-modal')?.remove();
  showToast(`✅ Status atualizado: ${status}`, 'success');
  cfLoadContracts({ force: true });
}

// ─── Mark as Complete (release all milestones) ─────────────────────────────────
async function cfMarkComplete(contractId) {
  const wallet = window.walletState?.address;
  if (!wallet) { showToast('Connect your wallet.', 'warning'); return; }
  if (cfState.pending) { showToast(t('contracts_pending_tx'), 'warning'); return; }

  const c = cfState.contracts.find(x => x.id === contractId);
  if (!c) { showToast(t('contracts_contract_not_found'), 'error'); return; }
  if (c.client?.toLowerCase() !== wallet.toLowerCase()) { showToast('❌ Only the client can mark as complete.', 'error'); return; }

  const meta = cfGetMeta(contractId);
  if (!meta.proofs?.length) { showToast(t('contracts_upload_proof_first'), 'warning'); return; }

  const milestones = c.milestones || [];
  const pending = milestones.filter(m => m.status === 'Pending');

  if (!(await cfConfirm(
    `Mark Contract #${contractId} as COMPLETE?\n\n` +
    `This will release ${pending.length} pending milestone(s) to the contractor.\n` +
    `Platform fee (0.2%) = $${cfFmtUsdc(cfCalcFee(BigInt(c.totalValue)))} USDC will be deducted.\n` +
    `Net to contractor: $${cfFmtUsdc(cfNetAmount(BigInt(c.totalValue)))} USDC.\n\n` +
    t("contracts_irreversible_action"),
    'Complete Contract'
  ))) return;

  cfState.pending = true;
  try {
    // Release all pending milestones sequentially
    const init = await cfInitProvider();
    if (!init.ok) { showToast(`❌ ${init.message}`, 'error'); return; }

    for (let i = 0; i < milestones.length; i++) {
      if (milestones[i].status === 'Pending') {
        showToast(`📝 Releasing milestone ${i+1}/${milestones.length} — confirme na carteira…`, 'info');
        const tx = await init.factory.completeMilestone(contractId, i);
        cfLog(`Milestone ${i} tx submitted:`, tx.hash);
        cfLogTx('completeMilestone', tx.hash, contractId, { milestoneIdx: i });
        const r = await tx.wait(1);
        if (r.status !== 1) throw new Error(`Milestone ${i} tx revertida.`);
        cfLog(`Milestone ${i} released at block ${r.blockNumber}`);
      }
    }

    // Save completion metadata
    const completedAt = Date.now();
    cfSetMeta(contractId, {
      completedAt,
      receiptData: {
        contractId, title: c.title,
        client: c.client, contractor: c.contractor,
        clientEmail: meta.clientEmail || '', contractorEmail: meta.contractorEmail || '',
        totalValue: cfFmtUsdc(c.totalValue), feeValue: cfFmtUsdc(cfCalcFee(BigInt(c.totalValue))),
        netValue: cfFmtUsdc(cfNetAmount(BigInt(c.totalValue))),
        proofCount: meta.proofs.length, proofRefs: meta.proofs.map(p => p.name).join(', '),
        custodianAddr: meta.custodianAddr || '', escrowRef: meta.escrowRef || '',
        completedAt: new Date(completedAt).toLocaleString('en-US'),
        network: CF_NETWORK_NAME, chainId: CF_CHAIN_ID, factory: CF_FACTORY_ADDR,
      }
    });

    showToast(`✅ Contrato #${contractId} marcado como COMPLETO! Todos os milestones liberados.`, 'success');
    setTimeout(() => cfLoadContracts({ force: true }), 1500);
  } catch (err) {
    cfErr('cfMarkComplete error:', err);
    const rej = err.code === 4001 || err.code === 'ACTION_REJECTED';
    showToast(rej ? t('cf_tx_rejected') : `❌ ${err.reason || err.message}`, rej ? 'warning' : 'error');
  } finally {
    cfState.pending = false;
  }
}

// ─── Open Receipt in new tab (replaces Download PDF Receipt) ────────────────────
function cfOpenReceipt(contractId) {
  const c    = cfState.contracts.find(x => x.id === contractId);
  const meta = cfGetMeta(contractId);
  const r    = meta.receiptData || {};

  const receiptObj = {
    id:              'cf-' + contractId + '-' + Date.now(),
    contractId,
    title:           c?.title || r.title || 'Contract',
    network:         CF_NETWORK_NAME,
    chainId:         CF_CHAIN_ID,
    factory:         CF_FACTORY_ADDR,
    client:          c?.client || r.client || '',
    contractor:      c?.contractor || r.contractor || '',
    clientEmail:     meta.clientEmail || r.clientEmail || '',
    contractorEmail: meta.contractorEmail || r.contractorEmail || '',
    totalValue:      c ? cfFmtUsdc(c.totalValue) : r.totalValue || '?',
    feeValue:        c ? cfFmtUsdc(cfCalcFee(BigInt(c?.totalValue || 0))) : r.feeValue || '?',
    netValue:        c ? cfFmtUsdc(cfNetAmount(BigInt(c?.totalValue || 0))) : r.netValue || '?',
    custodianAddr:   meta.custodianAddr || '',
    escrowRef:       meta.escrowRef || '',
    proofs:          meta.proofs    || [],
    completedAt:     r.completedAt  || new Date().toLocaleString(),
    _type:           'contract',
  };

  if (typeof arcSaveContractReceipt === 'function') arcSaveContractReceipt(receiptObj).catch(() => {});

  if (typeof arcViewContractReceipt === 'function') {
    arcViewContractReceipt(receiptObj);
    return;
  }
  // Fallback to legacy HTML receipt
  cfDownloadReceipt(contractId);
}

// ─── Download Receipt (legacy — now opens in new tab) ───────────────────────────
function cfDownloadReceipt(contractId) {
  const c    = cfState.contracts.find(x => x.id === contractId);
  const meta = cfGetMeta(contractId);
  const r    = meta.receiptData || {};

  const total    = c ? cfFmtUsdc(c.totalValue) : r.totalValue || '?';
  const fee      = c ? cfFmtUsdc(cfCalcFee(BigInt(c?.totalValue || 0))) : r.feeValue || '?';
  const net      = c ? cfFmtUsdc(cfNetAmount(BigInt(c?.totalValue || 0))) : r.netValue || '?';
  const title    = c?.title || r.title || 'Contract';
  const proofs   = meta.proofs || [];
  const now      = new Date().toLocaleString('en-US');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>ARC Contract Receipt #${contractId}</title>
<style>
  body { font-family: 'Courier New', monospace; background: #fff; color: #111; padding: 40px; max-width: 700px; margin: 0 auto; }
  .header { text-align: center; border-bottom: 3px solid #1565c0; padding-bottom: 20px; margin-bottom: 28px; }
  .header h1 { font-size: 24px; color: #1565c0; margin: 0 0 4px; }
  .header p { color: #666; font-size: 12px; margin: 0; }
  .badge { display: inline-block; background: #d4edda; color: #155724; border: 1px solid #c3e6cb; border-radius: 4px; padding: 4px 14px; font-size: 13px; font-weight: bold; margin-top: 10px; }
  .section { margin-bottom: 24px; }
  .section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: #1565c0; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #f5f5f5; font-size: 12px; }
  .row .label { color: #666; }
  .row .value { font-weight: bold; color: #111; text-align: right; max-width: 60%; word-break: break-all; }
  .fee-box { background: #fff8e1; border: 1px solid #ffe082; border-radius: 6px; padding: 12px 16px; margin-top: 8px; }
  .fee-box .total { font-size: 18px; font-weight: bold; color: #1565c0; }
  .proof-item { padding: 6px 0; border-bottom: 1px solid #f5f5f5; font-size: 11px; color: #333; }
  .footer { text-align: center; margin-top: 40px; padding-top: 16px; border-top: 2px solid #1565c0; font-size: 10px; color: #999; }
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
<div class="header">
  <h1>⛓ ARC CONTRACT RECEIPT</h1>
  <p>Arc Network Testnet · Trustless Escrow · On-Chain Verified</p>
  <div class="badge">✅ COMPLETED</div>
</div>

<div class="section">
  <h2>Contract Details</h2>
  <div class="row"><span class="label">Contract ID</span><span class="value">#${contractId}</span></div>
  <div class="row"><span class="label">Title</span><span class="value">${title}</span></div>
  <div class="row"><span class="label">Network</span><span class="value">${CF_NETWORK_NAME} (Chain ${CF_CHAIN_ID})</span></div>
  <div class="row"><span class="label">Factory</span><span class="value">${CF_FACTORY_ADDR}</span></div>
  <div class="row"><span class="label">Completed At</span><span class="value">${r.completedAt || now}</span></div>
  <div class="row"><span class="label">Generated At</span><span class="value">${now}</span></div>
</div>

<div class="section">
  <h2>Parties</h2>
  <div class="row"><span class="label">Client Wallet</span><span class="value">${c?.client || r.client || '—'}</span></div>
  ${(meta.clientEmail || r.clientEmail) ? `<div class="row"><span class="label">Client Email</span><span class="value">${meta.clientEmail || r.clientEmail}</span></div>` : ''}
  <div class="row"><span class="label">Contractor Wallet</span><span class="value">${c?.contractor || r.contractor || '—'}</span></div>
  ${(meta.contractorEmail || r.contractorEmail) ? `<div class="row"><span class="label">Contractor Email</span><span class="value">${meta.contractorEmail || r.contractorEmail}</span></div>` : ''}
</div>

<div class="section">
  <h2>Financial Summary</h2>
  <div class="fee-box">
    <div class="row" style="border:none;padding:4px 0;"><span class="label">Total Contract Value</span><span class="value total">$${total} USDC</span></div>
    <div class="row" style="border:none;padding:4px 0;"><span class="label">Platform Fee (0.2%)</span><span class="value" style="color:#e65100;">−$${fee} USDC</span></div>
    <div class="row" style="border:none;padding:4px 0;border-top:1px solid #ffe082;margin-top:4px;"><span class="label" style="font-weight:bold;">Net to Contractor</span><span class="value" style="color:#2e7d32;font-size:16px;">$${net} USDC</span></div>
  </div>
</div>

${meta.custodianAddr ? `<div class="section">
  <h2>Custodial Escrow</h2>
  <div class="row"><span class="label">Custodian Address</span><span class="value" style="font-family:monospace;font-size:12px;">${meta.custodianAddr}</span></div>
  <div class="row"><span class="label">Escrow Reference</span><span class="value">${meta.escrowRef || 'N/A'}</span></div>
</div>` : ''}

<div class="section">
  <h2>Proof of Work (${proofs.length} file${proofs.length !== 1 ? 's' : ''})</h2>
  ${proofs.length ? proofs.map((p, i) => `<div class="proof-item">${i+1}. ${cfEsc(p.name)} ${p.cid ? `— IPFS: ${p.cid}` : '(stored locally)'} — ${new Date(p.uploadedAt).toLocaleString('en-US')}</div>`).join('') : '<p style="color:#999;font-size:12px;">No proof files.</p>'}
</div>

<div class="footer">
  <p>This receipt was generated by the ARC Contracts Module v5.</p>
  <p>All on-chain data is verifiable at <strong>testnet.arcscan.app</strong></p>
  <p style="margin-top:8px;color:#bbb;">Contract #${contractId} · ${CF_FACTORY_ADDR}</p>
</div>
</body></html>`;

  // Open in new tab (no auto-download)
  if (typeof arcOpenReceiptTab === 'function') {
    arcOpenReceiptTab(html, `Contract Receipt #${contractId}`);
    return;
  }
  // Fallback: write to new window
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 500);
  } else {
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url; a.download = `arc-contract-${contractId}-receipt.html`; a.click();
    URL.revokeObjectURL(url);
  }
}

