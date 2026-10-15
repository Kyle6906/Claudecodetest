// ═══════════════════════════════════════════════════════════════════════════════
// CLOUD SYNC — two-way sync of leads, quotes and sales with Firestore
// ═══════════════════════════════════════════════════════════════════════════════
// Before this file, the desktop overwrote every lead/quote/sale in Firestore on
// every save and never read changes back, so edits made on the phone could be
// wiped, phone-created records never reached the desktop, and desktop deletes
// never reached the cloud ("zombie" records).
//
// Now:
//  • Live listeners pull cloud changes into the desktop (newest updatedAt wins).
//  • _syncToFirestore only pushes records whose content differs from the cloud.
//  • Deleting on desktop deletes the cloud copy (CloudSync.deleteRemote).
//  • One-time review: records that exist only in the cloud (phone-created, or
//    zombies of desktop deletes) are listed so Kyle chooses what to keep.
//
// Loaded as a classic script; reads the global `appState` from index.html.

(function () {
  const COLS = ['leads', 'quotes', 'sales'];
  const remoteCache = { leads: {}, quotes: {}, sales: {} };   // id -> stable JSON of cloud copy
  const ready = { leads: false, quotes: false, sales: false }; // first snapshot received
  const pendingRemoteOnly = { leads: [], quotes: [], sales: [] };
  const unsub = {};
  let reviewShown = false;
  let saveTimer = null;

  // Stable JSON (sorted keys) so key order from Firestore doesn't look like a change
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(x => (x === undefined ? 'null' : stable(x))).join(',') + ']';
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }

  function arr(col) {
    if (!appState[col]) appState[col] = [];
    return appState[col];
  }

  function reviewDone() { return !!appState.cloudReviewV1; }

  function persistLocal() {
    try { window.aflAPI.writeData(appState); } catch (e) { console.error('[CloudSync] local save failed', e); }
  }

  function refreshUI() {
    try {
      if (typeof updateLeadsBadge === 'function') updateLeadsBadge();
      if (typeof updateOverdueBadge === 'function') updateOverdueBadge();
      if (typeof activeTab !== 'undefined' && typeof switchTab === 'function'
          && ['dashboard', 'deals', 'sales', 'leads', 'commission'].includes(activeTab)) {
        switchTab(activeTab);
      }
    } catch (e) { console.error('[CloudSync] refresh failed', e); }
  }

  function schedulePush() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (typeof saveData === 'function') saveData(); }, 1500);
  }

  function handleSnapshot(col, snap) {
    let changedLocal = false;
    let needsPush = false;
    const list = arr(col);

    for (const ch of snap.docChanges()) {
      const id = ch.doc.id;
      if (ch.type === 'removed') {
        delete remoteCache[col][id];
        if (ch.doc.metadata.hasPendingWrites) continue;          // our own delete
        const i = list.findIndex(r => r.id === id);
        if (i >= 0) { list.splice(i, 1); changedLocal = true; }
        continue;
      }

      const r = ch.doc.data();
      if (!r.id) r.id = id;
      remoteCache[col][id] = stable(r);
      if (ch.doc.metadata.hasPendingWrites) continue;            // echo of our own write

      const i = list.findIndex(x => x.id === id);
      if (i < 0) {
        if (reviewDone()) { list.push(r); changedLocal = true; }
        else if (!pendingRemoteOnly[col].some(x => x.id === id)) pendingRemoteOnly[col].push(r);
        continue;
      }
      const l = list[i];
      if (stable(l) === remoteCache[col][id]) continue;
      if ((l.updatedAt || '') > (r.updatedAt || '')) {
        needsPush = true;                                        // desktop copy is newer
      } else {
        list[i] = r;                                             // cloud copy is newer
        changedLocal = true;
      }
    }

    const firstSnapshot = !ready[col];
    ready[col] = true;

    if (changedLocal) {
      console.log(`[CloudSync] ${col}: pulled changes from cloud`);
      persistLocal();
      refreshUI();
    }
    if (needsPush || firstSnapshot) schedulePush();
    if (firstSnapshot) maybeReview();
  }

  function start() {
    if (!window.db || !window._fs || !window._fs.onSnapshot) return;
    const { collection, onSnapshot } = window._fs;
    for (const col of COLS) {
      if (unsub[col]) unsub[col]();
      ready[col] = false;
      remoteCache[col] = {};
      unsub[col] = onSnapshot(
        collection(window.db, col),
        snap => handleSnapshot(col, snap),
        err => console.error(`[CloudSync] ${col} listener error:`, err)
      );
    }
    console.log('[CloudSync] listeners started');
  }

  // Called by _syncToFirestore: push only once we know the cloud state, and only
  // if this record differs from the cloud copy.
  function shouldPush(col, rec) {
    if (!COLS.includes(col)) return true;
    if (!ready[col] || !rec || !rec.id) return false;
    return remoteCache[col][rec.id] !== stable(rec);
  }

  function isReady(col) { return !COLS.includes(col) || ready[col]; }

  async function deleteRemote(col, id) {
    delete remoteCache[col]?.[id];
    if (!window.db || !window._fs) return;
    try {
      await window._fs.deleteDoc(window._fs.doc(window.db, col, id));
    } catch (e) {
      console.error(`[CloudSync] delete ${col}/${id} failed`, e);
    }
  }

  // ── One-time review of cloud-only records ───────────────────────────────────
  function maybeReview() {
    if (reviewDone() || reviewShown) return;
    if (!COLS.every(c => ready[c])) return;
    const total = COLS.reduce((n, c) => n + pendingRemoteOnly[c].length, 0);
    if (total === 0) {
      appState.cloudReviewV1 = true;
      persistLocal();
      return;
    }
    reviewShown = true;
    showReview();
  }

  function label(col, r) {
    const name = r.companyName || r.customerName || '(no name)';
    const extra = col === 'leads' ? (r.status || '')
      : col === 'quotes' ? [r.forkliftModel || (r.lineItems && r.lineItems[0] && r.lineItems[0].forkliftModel), r.stage].filter(Boolean).join(' · ')
      : [r.forkliftModel || r.model, r.saleDate || r.dateOfSale].filter(Boolean).join(' · ');
    const when = (r.updatedAt || r.createdAt || '').slice(0, 10);
    return { name, extra, when };
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showReview() {
    const titles = { leads: 'Contacts / Leads', quotes: 'Quotes', sales: 'Sales' };
    const notes = {
      leads: 'Usually added on your phone — keep these unless you deleted them on purpose.',
      quotes: 'Phone quick-quotes, or quotes you deleted on desktop.',
      sales: 'Sales are only created on desktop, so these were deleted there. Unchecked by default.',
    };
    let html = '';
    for (const col of COLS) {
      const items = pendingRemoteOnly[col]
        .slice()
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      if (!items.length) continue;
      const checked = col !== 'sales';
      html += `<div style="margin:14px 0 6px;font-weight:700">${titles[col]} (${items.length})
          <a href="#" data-cs-all="${col}" style="font-weight:400;font-size:12px;margin-left:10px">all</a>
          <a href="#" data-cs-none="${col}" style="font-weight:400;font-size:12px;margin-left:6px">none</a></div>
        <div style="font-size:12px;color:#777;margin-bottom:6px">${notes[col]}</div>`;
      for (const r of items) {
        const { name, extra, when } = label(col, r);
        html += `<label style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #eee;font-size:13px">
            <input type="checkbox" data-cs-col="${col}" data-cs-id="${escHtml(r.id)}" ${checked ? 'checked' : ''}>
            <span style="flex:1"><b>${escHtml(name)}</b>${extra ? ' <span style="color:#777">' + escHtml(extra) + '</span>' : ''}</span>
            <span style="color:#999;font-size:12px">${escHtml(when)}</span>
          </label>`;
      }
    }

    const ov = document.createElement('div');
    ov.id = 'cloud-review';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99998;display:flex;align-items:center;justify-content:center';
    ov.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:620px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.3)">
        <div style="padding:20px 22px 6px">
          <div style="font-size:18px;font-weight:700">One-time cloud cleanup</div>
          <div style="font-size:13px;color:#555;margin-top:6px">These records are in the cloud but not on this computer.
            <b>Checked</b> = add to the app. <b>Unchecked</b> = permanently remove from the cloud.</div>
        </div>
        <div style="padding:0 22px;overflow:auto;flex:1">${html}</div>
        <div style="padding:14px 22px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid #eee">
          <button id="cs-later" style="padding:9px 14px;border:1px solid #ccc;background:#fff;border-radius:6px;cursor:pointer">Decide later</button>
          <button id="cs-apply" style="padding:9px 14px;border:0;background:#eb0a1e;color:#fff;border-radius:6px;font-weight:700;cursor:pointer">Apply</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    ov.addEventListener('click', e => {
      const all = e.target.getAttribute && e.target.getAttribute('data-cs-all');
      const none = e.target.getAttribute && e.target.getAttribute('data-cs-none');
      if (all || none) {
        e.preventDefault();
        ov.querySelectorAll(`input[data-cs-col="${all || none}"]`).forEach(cb => { cb.checked = !!all; });
      }
    });
    ov.querySelector('#cs-later').addEventListener('click', () => {
      ov.remove();
      if (typeof toast === 'function') toast('Cloud cleanup postponed — it will ask again next time you open the app.');
    });
    ov.querySelector('#cs-apply').addEventListener('click', async () => {
      const boxes = Array.from(ov.querySelectorAll('input[data-cs-col]'));
      const keep = boxes.filter(b => b.checked);
      const drop = boxes.filter(b => !b.checked);
      if (drop.length && !confirm(`Add ${keep.length} record(s) to the app and permanently remove ${drop.length} from the cloud?`)) return;
      for (const b of keep) {
        const col = b.dataset.csCol, id = b.dataset.csId;
        const r = pendingRemoteOnly[col].find(x => x.id === id);
        if (r && !arr(col).some(x => x.id === id)) arr(col).push(r);
      }
      for (const b of drop) await deleteRemote(b.dataset.csCol, b.dataset.csId);
      for (const c of COLS) pendingRemoteOnly[c] = [];
      appState.cloudReviewV1 = true;
      persistLocal();
      ov.remove();
      refreshUI();
      if (typeof toast === 'function') toast(`Cloud cleanup done — ${keep.length} added, ${drop.length} removed.`);
    });
  }

  window.CloudSync = { start, shouldPush, isReady, deleteRemote, stable };
})();
