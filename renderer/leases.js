// ═══════════════════════════════════════════════════════════════════════════════
// LEASE MATURITIES — TICF maturity report import, Leases tab, alerts
// ═══════════════════════════════════════════════════════════════════════════════
// Data: appState.leases (synced to Firestore "leases"; desktop is the only writer).
// One record per unit, keyed by serial, so re-importing next month's report
// updates units in place. Units that drop off the report are kept and flagged
// offReport (paid off / bought out / returned) — never deleted.
//
// Alerts: FMV ("Lease") units alert 120 days before maturity, Dollar Out units
// 30 days before. One task per customer + maturity date + type, created once
// (lease.alertedAt), plus a Windows pop-up.
//
// Loaded as a classic script; uses globals from index.html (appState, saveData,
// toast, esc, genId, formatDate, fmtMoney, switchTab, openLeadProfile).

const LEASE_ALERT_DAYS = { fmv: 120, dollar_out: 30 };
const LEASE_TYPE_LABELS = { fmv: 'FMV Lease', dollar_out: 'Dollar Out' };

// ── Pure helpers (no DOM) ─────────────────────────────────────────────────────
function leaseTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function leaseDaysUntil(iso, today = leaseTodayISO()) {
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
}
// Excel serial (46236), Date, "2026-08-02", or "8/2/2026" → "YYYY-MM-DD"
function leaseToISO(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  return null;
}
function leaseType(transaction) {
  const t = String(transaction || '').toLowerCase();
  if (t.includes('dollar') || t.includes('$1')) return 'dollar_out';
  return 'fmv';
}
function leaseIdFor(serial) { return 'ls_' + String(serial).toUpperCase().replace(/[^A-Z0-9]+/g, '_'); }
function leaseNum(v) { const n = Number(String(v ?? '').replace(/[$,]/g, '')); return isFinite(n) ? n : 0; }

// Company-name matching: "TOYO TIRE NORTH AMERICA MANUFACTURING IN INC." ↔ "Toyo Tire"
const LEASE_NAME_NOISE = new Set(['inc', 'llc', 'l', 'lp', 'llp', 'corp', 'corporation', 'co', 'company', 'ltd', 'the',
  'of', 'and', 'usa', 'us', 'america', 'north', 'na', 'group', 'holdings', 'in', 'incorporated', 'industries', 'manufacturing', 'mfg']);
const LEASE_GENERIC_WORDS = new Set(['atlanta', 'georgia', 'southern', 'southeast', 'southeastern', 'american', 'national', 'united',
  'first', 'global', 'international', 'premier', 'quality', 'superior', 'advanced', 'metro', 'cherokee', 'cobb', 'bartow', 'paulding',
  'kennesaw', 'marietta', 'acworth', 'cartersville', 'canton', 'woodstock', 'dallas', 'calhoun', 'rome', 'white', 'adairsville', 'royal', 'general', 'standard']);
function leaseNameTokens(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(t => t && !LEASE_NAME_NOISE.has(t));
}
function leaseNamesMatch(a, b) {
  const x = leaseNameTokens(a), y = leaseNameTokens(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // One-word names must be distinctive ("Vanderlande" yes, "Atlanta" no) or match exactly
  if (short.length === 1 && (short[0].length < 5 || LEASE_GENERIC_WORDS.has(short[0]))) return x.join(' ') === y.join(' ');
  return short.every((t, i) => long[i] === t);
}
function leaseFindLead(customerName, zip, leads) {
  const z = String(zip || '').slice(0, 5);
  const hits = leads.filter(l => leaseNamesMatch(customerName, l.companyName));
  if (!hits.length) return null;
  return hits.find(l => z && String(l.zip || '').slice(0, 5) === z)
    || hits.find(l => l.status === 'customer' || l.status === 'active_customer')
    || hits[0];
}

// Header → column index for the TICF maturity report
function leaseColumns(headers) {
  const h = headers.map(x => String(x || '').toLowerCase().trim());
  const find = (...keys) => h.findIndex(c => keys.some(k => c.includes(k)));
  return {
    rep: find('sales rep', 'rep'), customer: find('customer'), serial: find('serial', 'vin'),
    start: find('start'), maturity: find('maturity', 'expir', 'end date'), term: find('term'),
    address: find('address'), city: find('city'), county: find('county'), state: find('state'),
    zip: find('postal', 'zip'), transaction: find('transaction', 'type'),
    base: find('base pay'), fm: find('fm pay'),
  };
}

// Parse report rows → lease records (without app ids/links)
function leaseParseReport(headers, rows) {
  const c = leaseColumns(headers);
  if (c.customer < 0 || c.serial < 0 || c.maturity < 0) {
    return { error: 'This doesn’t look like a TICF maturity report (need Customer Name, Vin-Model/Serial and Maturity Date columns).' };
  }
  const get = (r, i) => (i >= 0 ? r[i] : '');
  const out = [], skipped = [];
  const seen = new Set();
  for (const r of rows) {
    const serial = String(get(r, c.serial) ?? '').trim();
    const customerName = String(get(r, c.customer) ?? '').trim();
    const maturityDate = leaseToISO(get(r, c.maturity));
    if (!serial || !customerName || !maturityDate) { if (serial || customerName) skipped.push(serial || customerName); continue; }
    const id = leaseIdFor(serial);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, serial, customerName, maturityDate,
      startDate: leaseToISO(get(r, c.start)),
      term: leaseNum(get(r, c.term)) || null,
      type: leaseType(get(r, c.transaction)),
      transaction: String(get(r, c.transaction) ?? '').trim(),
      basePayment: leaseNum(get(r, c.base)),
      fmPayment: leaseNum(get(r, c.fm)),
      street: String(get(r, c.address) ?? '').trim(),
      city: String(get(r, c.city) ?? '').trim(),
      county: String(get(r, c.county) ?? '').trim(),
      state: String(get(r, c.state) ?? '').trim(),
      zip: String(get(r, c.zip) ?? '').trim(),
      salesRep: String(get(r, c.rep) ?? '').trim(),
    });
  }
  return { leases: out, skipped };
}

// Merge a parsed report into existing leases. Returns { leases, stats }.
function leaseMerge(existing, parsed, leads, now = new Date().toISOString()) {
  const byId = new Map(existing.map(l => [l.id, l]));
  const inReport = new Set();
  const stats = { added: 0, updated: 0, unchanged: 0, droppedOff: 0, returned: 0, matched: new Set(), unmatched: new Set() };
  const merged = [];
  for (const p of parsed) {
    inReport.add(p.id);
    const lead = leaseFindLead(p.customerName, p.zip, leads);
    (lead ? stats.matched : stats.unmatched).add(p.customerName);
    const old = byId.get(p.id);
    const rec = {
      ...(old || {}), ...p,
      leadId: lead ? lead.id : (old?.leadId && leads.some(l => l.id === old.leadId) ? old.leadId : null),
      linkedName: lead ? lead.companyName : (old?.linkedName || null),
      offReport: false, offReportSince: null,
      lastReportAt: now, createdAt: old?.createdAt || now,
    };
    // Maturity moved (extension/rewrite) → allow a fresh alert
    if (old && old.maturityDate !== p.maturityDate) rec.alertedAt = null;
    if (!old) { stats.added++; rec.alertedAt = null; }
    else if (old.offReport) stats.returned++;
    else if (['maturityDate', 'type', 'basePayment', 'customerName', 'street', 'zip'].some(k => old[k] !== rec[k])) stats.updated++;
    else stats.unchanged++;
    const changed = !old || old.offReport || ['maturityDate', 'type', 'basePayment', 'customerName', 'street', 'zip', 'leadId', 'term'].some(k => old[k] !== rec[k]);
    rec.updatedAt = changed ? now : (old.updatedAt || now);
    merged.push(rec);
  }
  for (const old of existing) {
    if (inReport.has(old.id)) continue;
    if (!old.offReport) { stats.droppedOff++; merged.push({ ...old, offReport: true, offReportSince: now.slice(0, 10), updatedAt: now }); }
    else merged.push(old);
  }
  return { leases: merged, stats: { ...stats, matched: [...stats.matched], unmatched: [...stats.unmatched] } };
}

// Status of one unit today
function leaseStatus(l, today = leaseTodayISO()) {
  if (l.offReport) return 'off';
  const d = leaseDaysUntil(l.maturityDate, today);
  if (d < 0) return 'matured';
  if (d <= (LEASE_ALERT_DAYS[l.type] ?? 30)) return 'alert';
  return 'upcoming';
}

// Group units: customer + maturity date + type
function leaseGroups(leases) {
  const map = new Map();
  for (const l of leases) {
    const key = `${l.leadId || l.customerName}|${l.maturityDate}|${l.type}`;
    if (!map.has(key)) map.set(key, { key, customerName: l.linkedName || l.customerName, reportName: l.customerName, leadId: l.leadId || null, maturityDate: l.maturityDate, type: l.type, units: [] });
    map.get(key).units.push(l);
  }
  const groups = [...map.values()];
  for (const g of groups) g.monthly = g.units.reduce((s, u) => s + (u.basePayment || 0), 0);
  return groups.sort((a, b) => a.maturityDate.localeCompare(b.maturityDate) || a.customerName.localeCompare(b.customerName));
}

// Groups that should get an alert task now (in window, not yet alerted, not past)
function leaseDueAlerts(leases, today = leaseTodayISO()) {
  const due = leases.filter(l => !l.alertedAt && leaseStatus(l, today) === 'alert');
  return leaseGroups(due);
}

function leaseTaskFor(g, now = new Date().toISOString()) {
  const n = g.units.length;
  const typeLabel = LEASE_TYPE_LABELS[g.type];
  const dateStr = new Date(g.maturityDate + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const action = g.type === 'dollar_out'
    ? 'Dollar Out: get $1 buyout paperwork going and have the upgrade/replacement conversation.'
    : 'FMV lease: decide return, renew, or replace. New-unit lead time is long, so quote replacements now.';
  const lines = g.units.map(u => `• ${u.serial}${u.basePayment ? ` — $${u.basePayment.toFixed(2)}/mo` : ''}${u.city ? ` (${u.city}${u.state ? ', ' + u.state : ''})` : ''}`);
  return {
    id: (typeof genId === 'function' ? genId('t') : `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
    title: `Lease maturing ${dateStr}: ${g.customerName} — ${n} ${typeLabel} unit${n === 1 ? '' : 's'}`,
    dueDate: null,
    linkedType: g.leadId ? 'lead' : null, linkedId: g.leadId || null, linkedName: g.leadId ? g.customerName : null,
    assignedTo: null,
    notes: `${action}\n\n${lines.join('\n')}`,
    completedAt: null, createdAt: now, updatedAt: now, source: 'lease_alert',
  };
}

// Node/test export
if (typeof module !== 'undefined') {
  module.exports = { LEASE_ALERT_DAYS, leaseToISO, leaseType, leaseIdFor, leaseNameTokens, leaseNamesMatch, leaseFindLead,
    leaseParseReport, leaseMerge, leaseStatus, leaseGroups, leaseDueAlerts, leaseTaskFor, leaseDaysUntil, leaseTodayISO };
}

// ── App wiring (browser only) ─────────────────────────────────────────────────
if (typeof window !== 'undefined' && typeof document !== 'undefined') {

  window.importLeaseReport = async function importLeaseReport() {
    const filePath = await window.aflAPI.openExcel();
    if (!filePath) return;
    const result = await window.aflAPI.parseExcel(filePath);
    if (result.error) { toast('Error reading file: ' + result.error, 'error'); return; }
    const parsed = leaseParseReport(result.headers || [], result.rows || []);
    if (parsed.error) { toast(parsed.error, 'error'); return; }
    if (!parsed.leases.length) { toast('No lease rows found in that file', 'error'); return; }
    const preview = leaseMerge(appState.leases || [], parsed.leases, appState.leads || []);
    window._leasePending = preview;
    const s = preview.stats;
    const custCount = new Set(parsed.leases.map(l => l.customerName)).size;
    const byType = parsed.leases.reduce((a, l) => (a[l.type]++, a), { fmv: 0, dollar_out: 0 });
    const willAlert = leaseDueAlerts(preview.leases);
    document.getElementById('lease-import-body').innerHTML = `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:13px;margin-bottom:12px">
        <span style="color:#888">Units in report</span><strong>${parsed.leases.length} (${byType.fmv} FMV · ${byType.dollar_out} Dollar Out)</strong>
        <span style="color:#888">Customers</span><span>${custCount} — ${s.matched.length} matched to your contacts</span>
        <span style="color:#888">New units</span><span>${s.added}</span>
        <span style="color:#888">Updated</span><span>${s.updated}${s.returned ? ` · ${s.returned} back on report` : ''}</span>
        <span style="color:#888">Unchanged</span><span>${s.unchanged}</span>
        <span style="color:#888">Dropped off report</span><span>${s.droppedOff}${s.droppedOff ? ' <span style="color:#999">(kept, marked off-report)</span>' : ''}</span>
        <span style="color:#888">Alert tasks to create</span><strong>${willAlert.length}</strong>
      </div>
      ${parsed.skipped.length ? `<div style="font-size:12px;color:#c62828;margin-bottom:8px">${parsed.skipped.length} row(s) skipped — missing customer, serial or maturity date.</div>` : ''}
      ${s.unmatched.length ? `<details style="font-size:12px;color:#666"><summary style="cursor:pointer">${s.unmatched.length} customer(s) not matched to a contact — leases still import</summary>
        <div style="max-height:160px;overflow:auto;margin-top:6px">${s.unmatched.map(n => esc(n)).join('<br>')}</div></details>` : ''}`;
    document.getElementById('overlay-lease-import').classList.add('open');
  };

  window.confirmLeaseImport = function confirmLeaseImport() {
    const p = window._leasePending;
    if (!p) return;
    appState.leases = p.leases;
    appState.leaseReportImportedAt = new Date().toISOString();
    window._leasePending = null;
    document.getElementById('overlay-lease-import').classList.remove('open');
    saveData();
    const made = runLeaseAlerts({ notify: true });
    toast(`Lease report imported — ${p.stats.added} new, ${p.stats.updated} updated${made ? `, ${made} alert task${made === 1 ? '' : 's'} created` : ''}`);
    refreshLeaseViews();
    if (typeof switchTab === 'function') switchTab('leases');
  };

  // Create alert tasks for anything newly in its window. Returns # tasks made.
  window.runLeaseAlerts = function runLeaseAlerts({ notify = true } = {}) {
    const groups = leaseDueAlerts(appState.leases || []);
    if (!groups.length) return 0;
    const now = new Date().toISOString();
    for (const g of groups) {
      const task = leaseTaskFor(g, now);
      appState.tasks.push(task);
      // Write straight to the cloud so the tasks listener can't drop it
      if (window.db && window._fs?.setDoc) {
        window._fs.setDoc(window._fs.doc(window.db, 'tasks', task.id), task).catch(err => console.error('[Leases] task write failed', err));
      }
      for (const u of g.units) { u.alertedAt = now; u.alertTaskId = task.id; u.updatedAt = now; }
    }
    saveData();
    if (typeof updateTaskBadge === 'function') updateTaskBadge();
    if (typeof renderDashboardTasks === 'function') renderDashboardTasks();
    if (notify && window.aflAPI?.showNotification) {
      const units = groups.reduce((n, g) => n + g.units.length, 0);
      const names = [...new Set(groups.map(g => g.customerName))].slice(0, 3).join(', ');
      window.aflAPI.showNotification('Leases maturing soon',
        `${units} unit${units === 1 ? '' : 's'} entered the alert window — ${names}${groups.length > 3 ? '…' : ''}. Tasks added.`);
    }
    return groups.length;
  };

  function leaseBadgeCount() {
    return (appState.leases || []).filter(l => leaseStatus(l) === 'alert').length;
  }

  window.refreshLeaseViews = function refreshLeaseViews() {
    const badge = document.getElementById('leases-alert-badge');
    if (badge) { const n = leaseBadgeCount(); badge.textContent = n; badge.style.display = n ? 'inline-flex' : 'none'; }
    renderDashboardLeases();
    if (typeof activeTab !== 'undefined' && activeTab === 'leases') renderLeases();
  };

  function statusChip(st) {
    return { matured: '<span class="lease-chip matured">Matured</span>', alert: '<span class="lease-chip alert">Act now</span>',
      off: '<span class="lease-chip off">Off report</span>' }[st] || '<span></span>';
  }
  function fmtLeaseDate(iso) { return typeof formatDate === 'function' ? formatDate(iso) : iso; }
  function daysText(iso) {
    const d = leaseDaysUntil(iso);
    return d < 0 ? `${-d}d ago` : d === 0 ? 'today' : `in ${d}d`;
  }
  function groupRow(g) {
    const st = leaseStatus(g.units[0]);
    const nameHtml = g.leadId
      ? `<a href="#" class="lease-cust" onclick="event.preventDefault();openLeadProfile('${esc(g.leadId)}')">${esc(g.customerName)}</a>`
      : `<span class="lease-cust unlinked" title="Not matched to a contact">${esc(g.customerName)}</span>`;
    return `<details class="lease-group ${st}">
      <summary>
        <span class="lease-date">${esc(fmtLeaseDate(g.maturityDate))}<small>${esc(daysText(g.maturityDate))}</small></span>
        <span class="lease-name">${nameHtml}${g.reportName.toLowerCase() !== g.customerName.toLowerCase() ? `<small>${esc(g.reportName)}</small>` : ''}</span>
        <span class="lease-type ${g.type}">${LEASE_TYPE_LABELS[g.type]}</span>
        <span class="lease-units">${g.units.length} unit${g.units.length === 1 ? '' : 's'}</span>
        <span class="lease-pay">${g.monthly ? fmtMoney(g.monthly) + '/mo' : ''}</span>
        ${statusChip(st)}
      </summary>
      <table class="lease-units-table"><thead><tr><th>Serial</th><th>Start</th><th>Term</th><th>Payment</th><th>Location</th><th></th></tr></thead><tbody>
        ${g.units.map(u => `<tr><td>${esc(u.serial)}</td><td>${esc(fmtLeaseDate(u.startDate) || '')}</td><td>${u.term ? u.term + ' mo' : ''}</td>
          <td>${u.basePayment ? '$' + u.basePayment.toFixed(2) : ''}</td><td>${esc([u.street, u.city, u.state].filter(Boolean).join(', '))}</td>
          <td>${u.alertedAt ? '<span style="color:#2e7d32;font-size:11px">Task created</span>' : ''}</td></tr>`).join('')}
      </tbody></table>
    </details>`;
  }

  let _leaseFilter = { type: '', view: 'upcoming', q: '' };
  window.renderLeases = function renderLeases() {
    const root = document.getElementById('leases-root');
    if (!root) return;
    const all = appState.leases || [];
    if (!all.length) {
      root.innerHTML = `<div class="card" style="text-align:center;padding:40px">
        <div style="font-size:16px;font-weight:700;margin-bottom:8px">No lease report imported yet</div>
        <div style="color:#888;margin-bottom:16px">Import your TICF Maturity Report to track lease expirations and get alerts.</div>
        <button class="btn-save" onclick="importLeaseReport()">Import Maturity Report</button></div>`;
      return;
    }
    const counts = { matured: 0, alert: 0, upcoming: 0, off: 0 };
    for (const l of all) counts[leaseStatus(l)]++;
    const yearOut = all.filter(l => !l.offReport && leaseDaysUntil(l.maturityDate) >= 0 && leaseDaysUntil(l.maturityDate) <= 365).length;
    const f = _leaseFilter;
    const q = f.q.toLowerCase();
    let rows = all.filter(l => {
      const st = leaseStatus(l);
      if (f.view === 'upcoming' && !(st === 'alert' || st === 'upcoming')) return false;
      if (f.view === 'alert' && st !== 'alert') return false;
      if (f.view === 'matured' && st !== 'matured') return false;
      if (f.view === 'off' && st !== 'off') return false;
      if (f.view === 'all' && st === 'off') return false;
      if (f.type && l.type !== f.type) return false;
      if (q && !`${l.customerName} ${l.linkedName || ''} ${l.serial} ${l.city}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const groups = leaseGroups(rows);
    if (f.view === 'matured' || f.view === 'off') groups.reverse();
    const byMonth = new Map();
    for (const g of groups) {
      const m = g.maturityDate.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(g);
    }
    const monthLabel = m => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const imported = appState.leaseReportImportedAt ? new Date(appState.leaseReportImportedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    root.innerHTML = `
      <div class="lease-stats">
        <div class="lease-stat matured" onclick="setLeaseView('matured')"><b>${counts.matured}</b><span>Matured, still on report</span></div>
        <div class="lease-stat alert" onclick="setLeaseView('alert')"><b>${counts.alert}</b><span>Act now (FMV ≤120d · $1 ≤30d)</span></div>
        <div class="lease-stat" onclick="setLeaseView('upcoming')"><b>${yearOut}</b><span>Maturing next 12 months</span></div>
        <div class="lease-stat" onclick="setLeaseView('all')"><b>${all.length - counts.off}</b><span>Units on report · ${new Set(all.filter(l => !l.offReport).map(l => l.customerName)).size} customers</span></div>
      </div>
      <div class="lease-toolbar">
        <input class="search-input" id="lease-search" placeholder="Search customer, serial, city…" value="${esc(f.q)}" style="flex:1;min-width:200px">
        <select class="filter-input" id="lease-view">
          ${[['upcoming', 'Upcoming'], ['alert', 'Act now'], ['matured', 'Matured'], ['all', 'All on report'], ['off', 'Off report']].map(([v, t]) => `<option value="${v}"${f.view === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <select class="filter-input" id="lease-type">
          <option value="">All types</option>
          <option value="fmv"${f.type === 'fmv' ? ' selected' : ''}>FMV Lease</option>
          <option value="dollar_out"${f.type === 'dollar_out' ? ' selected' : ''}>Dollar Out</option>
        </select>
        <button class="btn-save" onclick="importLeaseReport()">Import Maturity Report</button>
      </div>
      ${imported ? `<div style="font-size:11px;color:#999;margin:-6px 0 10px">Last imported ${esc(imported)}</div>` : ''}
      ${groups.length ? [...byMonth].map(([m, gs]) => `
        <div class="lease-month">${esc(monthLabel(m))} <span>${gs.reduce((n, g) => n + g.units.length, 0)} units</span></div>
        ${gs.map(groupRow).join('')}`).join('') : '<div class="card" style="text-align:center;color:#999;padding:24px">No leases match.</div>'}`;
    const search = document.getElementById('lease-search');
    search.addEventListener('input', () => { _leaseFilter.q = search.value; clearTimeout(window._leaseSearchT); window._leaseSearchT = setTimeout(() => { renderLeases(); const s = document.getElementById('lease-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 250); });
    document.getElementById('lease-view').addEventListener('change', e => { _leaseFilter.view = e.target.value; renderLeases(); });
    document.getElementById('lease-type').addEventListener('change', e => { _leaseFilter.type = e.target.value; renderLeases(); });
  };
  window.setLeaseView = v => { _leaseFilter.view = v; renderLeases(); };

  window.renderDashboardLeases = function renderDashboardLeases() {
    const card = document.getElementById('dash-leases-widget');
    const list = document.getElementById('dash-leases-list');
    if (!card || !list) return;
    const all = appState.leases || [];
    const hot = all.filter(l => ['alert', 'matured'].includes(leaseStatus(l)));
    card.style.display = all.length ? 'block' : 'none';
    if (!all.length) return;
    const alertGroups = leaseGroups(hot.filter(l => leaseStatus(l) === 'alert'));
    const maturedUnits = hot.filter(l => leaseStatus(l) === 'matured');
    const maturedCust = new Set(maturedUnits.map(l => l.linkedName || l.customerName)).size;
    list.innerHTML = (alertGroups.length ? alertGroups.slice(0, 8).map(g => `
      <div class="dash-lease-row" onclick="switchTab('leases')">
        <span class="lease-type ${g.type}">${g.type === 'fmv' ? 'FMV' : '$1'}</span>
        <span class="dash-lease-name">${esc(g.customerName)}</span>
        <span class="dash-lease-units">${g.units.length} unit${g.units.length === 1 ? '' : 's'}</span>
        <span class="dash-lease-date">${esc(fmtLeaseDate(g.maturityDate))} · ${esc(daysText(g.maturityDate))}</span>
      </div>`).join('') : '<div style="color:#bbb;font-size:13px;padding:6px 0">Nothing in the alert window.</div>')
      + (alertGroups.length > 8 ? `<div style="font-size:12px;color:#888;padding-top:4px">+${alertGroups.length - 8} more</div>` : '')
      + (maturedUnits.length ? `<div class="dash-lease-matured" onclick="setLeaseView('matured');switchTab('leases')">⚠ ${maturedUnits.length} matured unit${maturedUnits.length === 1 ? '' : 's'} still on the report (${maturedCust} customer${maturedCust === 1 ? '' : 's'}) — likely month-to-month</div>` : '');
  };

  window.renderLeadLeases = function renderLeadLeases(lead, container) {
    const mine = (appState.leases || []).filter(l => l.leadId === lead.id || (!l.leadId && leaseNamesMatch(l.customerName, lead.companyName)));
    if (!mine.length) { container.innerHTML = ''; return; }
    const groups = leaseGroups(mine.filter(l => !l.offReport));
    const off = mine.filter(l => l.offReport).length;
    container.innerHTML = `<div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
        Leases (${mine.length - off} on report)
        <button class="btn-icon" style="font-size:12px" onclick="document.getElementById('overlay-lead-profile').classList.remove('open');_leaseFilter_setQ(${JSON.stringify(lead.companyName || '').replace(/"/g, '&quot;')})">Open in Leases →</button>
      </div>
      ${groups.map(groupRow).join('')}
      ${off ? `<div style="font-size:11px;color:#999;margin-top:4px">${off} unit(s) no longer on the report</div>` : ''}`;
  };
  window._leaseFilter_setQ = q => { _leaseFilter = { type: '', view: 'all', q }; switchTab('leases'); };

  // Alerts run once the cloud task list has loaded (so a new task can't be
  // overwritten by the first tasks snapshot), then every 6 hours — the app
  // lives in the tray, so this catches units crossing into their window.
  let _leaseAlertsStarted = false;
  window.startLeaseAlerts = function startLeaseAlerts() {
    if (_leaseAlertsStarted) return;
    _leaseAlertsStarted = true;
    if (!appState.leases) appState.leases = [];
    runLeaseAlerts({ notify: true });
    refreshLeaseViews();
    setInterval(() => { runLeaseAlerts({ notify: true }); refreshLeaseViews(); }, 6 * 3600 * 1000);
  };
}
