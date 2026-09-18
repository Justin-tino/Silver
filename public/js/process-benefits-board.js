// Process Benefits board helpers — additive only.
(function () {
  function $(id) { return document.getElementById(id); }
  function setText(id, v) { var el = $(id); if (el) el.textContent = v; }
  function countItems(box) {
    if (!box) return 0;
    // Tables: count real <tr> rows (employee.js injects full <table> markup).
    var bodyRows = box.querySelectorAll('tbody tr');
    if (bodyRows.length) return bodyRows.length;
    var full = (box.textContent || '').trim();
    if (!full) return 0;
    // Empty-state placeholders are the only single-message contents employee.js writes.
    if (/^(No |Loading|All approved senior)/i.test(full)) return 0;
    var kids = Array.prototype.slice.call(box.children || []);
    if (!kids.length) return 1;
    if (kids.length === 1 && /No |Loading/i.test(full) && !box.querySelector('[data-pb-searchable]')) return 0;
    return kids.length;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/</g, '&lt;'); }
  function renderClaimedPensions() {
    var box = $('pensionClaimedContainer');
    if (!box) return;
    box.style.maxHeight = '380px';
    box.style.overflowY = 'auto';
    box.style.overflowX = 'hidden';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '10px';
    try {
      var users = window.lastUsersData || {};
      var rows = [];
      Object.entries(users).forEach(function (entry) {
        var u = entry[1];
        if (!u || u.role !== 'senior') return;
        var benefits = (u.benefits && typeof u.benefits === 'object') ? Object.values(u.benefits) : [];
        benefits.forEach(function (b) {
          if (!b || !/pension/i.test(String(b.title || ''))) return;
          rows.push({
            name: u.name || 'Senior', sid: u.seniorId || '-',
            amount: b.amount || (u.pensionAmount ? ('PHP ' + Number(u.pensionAmount).toLocaleString()) : '-'),
            ref: b.refNumber || b.reference || '-', when: b.approvedAt || b.createdAt || u.lastPensionMonth || ''
          });
        });
      });
      rows.sort(function (a, b) { return String(b.when).localeCompare(String(a.when)); });
      setText('pbMiniClaimedPension', rows.length + ' released');
      if (!rows.length) {
        box.innerHTML = '<div style="text-align:center;color:#71717a;padding:18px 12px;border:1px dashed #d4d4d8;border-radius:4px;font-size:0.85rem;">No claimed pension payouts yet.<br>Released monthly pensions appear here.</div>';
        return;
      }
      var h = rows.slice(0, 30).map(function (r) {
        var when = r.when ? (isNaN(Number(r.when)) ? String(r.when) : new Date(Number(r.when)).toLocaleDateString()) : '-';
        return '<div data-pb-searchable style="border:1px solid #e4e4e7;border-radius:6px;padding:10px 12px;background:#fcfcfc;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;">' +
          '<div style="font-weight:700;color:#1e293b;font-size:0.85rem;overflow-wrap:anywhere;">' + esc(r.name) + '</div>' +
          '<div style="font-size:0.76rem;color:#71717a;overflow-wrap:anywhere;">ID: ' + esc(r.sid) + ' - Ref: ' + esc(r.ref) + ' - ' + esc(when) + '</div>' +
          '<div style="font-weight:700;color:#166534;font-size:0.85rem;margin-top:4px;">' + esc(r.amount) + '</div></div>';
      }).join('');
      if (rows.length > 30) h += '<div style="font-size:0.75rem;color:#71717a;margin-top:8px;">Showing latest 30 of ' + rows.length + '.</div>';
      box.innerHTML = h;
    } catch (e) { /* never break board */ }
  }
  function refreshCounts() {
    try {
      var cSetup = countItems($('pensionSetupContainer'));
      var cCfg = countItems($('pensionConfiguredContainer'));
      var cPen = 0;
      var pb = $('pensionClaimedContainer');
      if (pb && !/No claimed pension/i.test(pb.textContent || '')) {
        cPen = pb.querySelectorAll('[data-pb-searchable]').length || countItems(pb);
      }
      var cPend = countItems($('claimsListContainer'));
      var cPay = countItems($('claimsPayoutContainer'));
      var cClm = countItems($('claimsClaimedContainer'));
      var cHis = 0;
      var hb = $('claimsHistoryContainer');
      if (hb) {
        var rows = hb.querySelectorAll('tbody tr');
        if (rows.length) cHis = rows.length;
        else if (!/No claim history/i.test(hb.textContent || '')) cHis = countItems(hb);
      }
      setText('pbStatPendingSetup', cSetup); setText('pbStatWithPension', cCfg);
      setText('pbStatToPayout', cPay); setText('pbStatClaimed', cClm);
      setText('pbCountCol1', cSetup + cCfg); setText('pbCountCol2', cPen);
      setText('pbMiniPending', cSetup + ' waiting'); setText('pbMiniConfigured', cCfg + ' active');
      setText('pbMiniToPayout', cPay + ' ready'); setText('pbMiniClaimed', cClm + ' done');
      setText('pbCountPending', cPend); setText('pbCountHistory', cHis);
      var badge = $('approvedClaimsBadge');
      if (badge) { badge.textContent = cPay; badge.style.display = cPay > 0 ? 'inline-block' : 'none'; }
    } catch (e) {}
  }
  function applySearch() {
    try {
      var q = (($('processBenefitsSearch') || {}).value || '').trim().toLowerCase();
      var ids = ['pensionSetupContainer', 'pensionConfiguredContainer', 'pensionClaimedContainer', 'claimsListContainer', 'claimsPayoutContainer', 'claimsClaimedContainer', 'claimsHistoryContainer'];
      ids.forEach(function (id) {
        var box = $(id);
        if (!box) return;
        if (id === 'claimsHistoryContainer') {
          box.querySelectorAll('tbody tr').forEach(function (tr) {
            var hit = (!q || (tr.textContent || '').toLowerCase().indexOf(q) > -1);
            tr.style.display = hit ? '' : 'none';
          });
          return;
        }
        Array.prototype.slice.call(box.children).forEach(function (child) {
          if (child.tagName === 'TABLE') {
            child.querySelectorAll('tbody tr').forEach(function (tr) {
              var hit2 = (!q || (tr.textContent || '').toLowerCase().indexOf(q) > -1);
              tr.style.display = hit2 ? '' : 'none';
            });
            return;
          }
          var hit3 = (!q || (child.textContent || '').toLowerCase().indexOf(q) > -1);
          child.style.display = hit3 ? '' : 'none';
        });
      });
    } catch (e) {}
  }

  function toCell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
  function exportBoard() {
    try {
      var users = window.lastUsersData || {};
      var claims = window.lastClaimsData || {};
      var rows = [['Section', 'Senior Name', 'Senior ID', 'Detail', 'Amount', 'Status/Ref', 'Date']];
      Object.entries(users).forEach(function (entry) {
        var u = entry[1];
        if (!u || u.role !== 'senior') return;
        if (u.pensionAmount) rows.push(['Pension-configured', u.name || '', u.seniorId || '', 'Monthly pension', 'PHP ' + Number(u.pensionAmount).toLocaleString(), u.pensionSetBy || '', u.pensionSetAt ? new Date(Number(u.pensionSetAt)).toLocaleDateString() : '']);
        var benefits = (u.benefits && typeof u.benefits === 'object') ? Object.values(u.benefits) : [];
        benefits.forEach(function (b) {
          if (!b || !/pension/i.test(String(b.title || ''))) return;
          rows.push(['Pension-claimed', u.name || '', u.seniorId || '', b.title || '', b.amount || '', b.refNumber || b.reference || '', b.approvedAt ? new Date(Number(b.approvedAt)).toLocaleDateString() : '']);
        });
      });
      Object.entries(claims).forEach(function (entry) {
        var id = entry[0], c = entry[1];
        if (!c) return;
        var when = c.claimedAt || c.processedAt || c.approvedAt || c.createdAt || '';
        rows.push(['Assistance-' + (c.status || 'Pending'), c.applicantName || '', c.seniorId || c.uid || '', (c.serviceType || '') + ' / ' + id, c.amount || '', c.refNumber || c.status || '', when ? new Date(Number(when)).toLocaleDateString() : '']);
      });
      var d = new Date();
      var fname = 'process-benefits-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.csv';
      var csv = rows.map(function (r) { return r.map(toCell).join(','); }).join('\r\n');
      var blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = fname;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      if (window.scNotify) window.scNotify('success', 'Board exported (' + (rows.length - 1) + ' rows).');
    } catch (e) { if (window.scNotify) window.scNotify('error', 'Export failed. Please try again.'); }
  }
  function toggleRow(btnId, bodyId, chevId, hintId) {
    var btn = $(btnId), body = $(bodyId);
    if (!btn || !body) return;
    btn.addEventListener('click', function () {
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      var ch = $(chevId); if (ch) ch.className = open ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
      var hh = $(hintId); if (hh) hh.textContent = open ? 'show' : 'hide';
    });
  }
  function initBoard() {
    var s = $('processBenefitsSearch');
    if (s) s.addEventListener('input', applySearch);
    // Claim-reference confirmation input was removed from the markup —
    // the Claim Reference stays displayed on each Not Claimed Yet card,
    // matched live against the DB (claim.refNumber = senior notification ref).
    var r = $('processBenefitsRefresh');
    if (r) r.addEventListener('click', function () { renderClaimedPensions(); refreshCounts(); applySearch(); if (window.scNotify) window.scNotify('success', 'Board refreshed.'); });
    var x = $('processBenefitsExport');
    if (x) x.addEventListener('click', exportBoard);
    var p = $('processBenefitsPrint');
    if (p) p.addEventListener('click', function () { window.print(); });
    toggleRow('pbPendingToggle', 'pbPendingBody', 'pbPendingChevron', 'pbPendingHint');
    toggleRow('pbHistoryToggle', 'pbHistoryBody', 'pbHistoryChevron', 'pbHistoryHint');
    var ids = ['pensionSetupContainer', 'pensionConfiguredContainer', 'claimsListContainer', 'claimsPayoutContainer', 'claimsClaimedContainer', 'claimsHistoryContainer'];
    ids.forEach(function (id) {
      var box = $(id);
      if (!box || !window.MutationObserver) return;
      var t = null;
      new MutationObserver(function () {
        clearTimeout(t);
        t = setTimeout(function () {
          renderClaimedPensions(); refreshCounts(); applySearch();
        }, 120);
      }).observe(box, { childList: true, subtree: true });
    });
    var tries = 0;
    var boot = setInterval(function () {
      tries++;
      renderClaimedPensions(); refreshCounts(); applySearch();
      if (tries > 40) clearInterval(boot);
    }, 500);
    renderClaimedPensions(); refreshCounts();
  }
  window.initProcessBenefitsBoard = initBoard;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBoard);
  else initBoard();
})();

