// AFL Sales Tracker — Mobile PWA
import { initializeApp }       from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js';
import {
  initializeFirestore, memoryLocalCache,
  collection, doc, getDocs, getDoc, setDoc, deleteDoc, updateDoc, query, where, orderBy, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js';

// ── Firebase config (same project as desktop app) ────────────────────────────
const FB_CONFIG = {
  apiKey:            'AIzaSyBThsQNL7lkh14gH_pwdZR04UqoglNpi14',
  authDomain:        'afl-sales-tracker-52890.firebaseapp.com',
  projectId:         'afl-sales-tracker-52890',
  storageBucket:     'afl-sales-tracker-52890.firebasestorage.app',
  messagingSenderId: '405184881454',
  appId:             '1:405184881454:web:f78a961296b3f8677190bf',
};

// ── Territory data (matches desktop app) ─────────────────────────────────────
const DEFAULT_ZIPS = ['30101','30102','30103','30107','30111','30114','30115','30120','30121','30132','30137','30142','30144','30145','30146','30151','30152','30156','30157','30169','30171','30178','30183','30184','30188','30189','30339'];
const ZIP_CITIES = {'30101':'Acworth','30102':'Acworth','30103':'Acworth','30107':'Ball Ground','30111':'Clarkdale','30114':'Canton','30115':'Canton','30120':'Cartersville','30121':'Cartersville','30132':'Dallas','30137':'Emerson','30142':'Holly Springs','30144':'Kennesaw','30145':'Kingston','30146':'Lebanon','30151':'Nelson','30152':'Marietta','30156':'Kennesaw','30157':'Dallas','30169':'Canton','30171':'Rydal','30178':'Taylorsville','30183':'Waleska','30184':'White','30188':'Woodstock','30189':'Woodstock','30339':'Atlanta'};

const TOYOTA_MODELS = {
  'IC Gas/LPG':      ['8FGU15','8FGU18','8FGU20','8FGU25','8FGU30','8FGU32','8FGU35','8FGU40','8FGU45','8FG60U','8FG70U','8FG80U'],
  'THD Lifts':       ['THD'],
  'IC Diesel':       ['8FDU15','8FDU18','8FDU20','8FDU25','8FDU30','8FDU32','8FDU35','8FDU40','8FDU45'],
  'IC Cushion':      ['8FGCU15','8FGCU18','8FGCU20','8FGCU25','8FGCU30','8FGCU32','8FGC35U','8FGC45U','8FGC55U','8FGC60U','8FGC70U'],
  'Electric 3-Whl':  ['8FBEU15','8FBEU18','8FBEU20'],
  'Electric Ctrbln': ['8FBC15U','8FBC18U','8FBC20U','8FBC25U','8FBC28U','8FBC30U','8FBC32U','7FBCU35','7FBCU45','7FBCU55'],
  'Stand-Up':        ['8BNCU18','8BNCU20','8FBA15','8FBA18','8FBA20','8FBA25'],
  'Reach Trucks':    ['9BRU18','9BRU23','RF1-3500','RF1-4500'],
  'Order Pickers':   ['8BPU15'],
  'Pallet Jack':     ['Pallet Jack'],
  'Allied Sales':    ['Scissor Lift','Big Joe'],
};

// ── App state ─────────────────────────────────────────────────────────────────
let db, auth;
let appData = { leads: [], equipment: [], tasks: [], quotes: [], sales: [], settings: {}, mapsApiKey: '', territoryZips: [...DEFAULT_ZIPS], contactDocuments: [] };
let activeTab    = 'home';
let viewingId    = null;   // contact ID in profile sheet
let isOnline     = navigator.onLine;
let deferredInstallPrompt = null;
let recentlyViewed = JSON.parse(localStorage.getItem('afl_recent') || '[]');

// ── Utility helpers ───────────────────────────────────────────────────────────
const esc = s => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const genId = p => `${p}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
const today = () => new Date().toISOString().slice(0,10);
const fmt = d => { if (!d) return ''; const [y,m,day] = d.split('-'); return `${m}/${day}/${y}`; };
const money = n => '$' + (Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});

function fleetAgeMs(dateStr) { if (!dateStr) return 0; return Date.now() - new Date(dateStr + 'T00:00:00').getTime(); }
function fleetAgeYears(dateStr) { return fleetAgeMs(dateStr) / (365.25 * 24 * 3600 * 1000); }
function fleetAgeText(dateStr) {
  if (!dateStr) return '—';
  const totalMonths = Math.floor(fleetAgeMs(dateStr) / (30.44 * 24 * 3600 * 1000));
  const yrs = Math.floor(totalMonths / 12), mos = totalMonths % 12;
  if (yrs === 0) return mos + ' mo';
  return yrs + ' yr' + (mos ? ' ' + mos + ' mo' : '');
}
function fleetPriority(dateStr) {
  const y = fleetAgeYears(dateStr);
  return y >= 10 ? 'high' : y >= 7 ? 'medium' : 'low';
}
function getLeadEquipment(leadId) { return appData.equipment.filter(e => e.leadId === leadId); }
function getLeadTopPriority(leadId) {
  const eq = getLeadEquipment(leadId);
  if (!eq.length) return null;
  if (eq.some(e => fleetPriority(e.dateOfPurchase) === 'high'))   return 'high';
  if (eq.some(e => fleetPriority(e.dateOfPurchase) === 'medium')) return 'medium';
  return 'low';
}
function priorityBadge(p) {
  if (!p) return '';
  return `<span class="badge badge-${p}">${p.charAt(0).toUpperCase()+p.slice(1)}</span>`;
}
function stageBadge(s) { return `<span class="badge badge-${s||'quoted'}">${(s||'quoted').charAt(0).toUpperCase()+(s||'quoted').slice(1)}</span>`; }
function statusBadge(s) {
  const k = (s||'lead').toLowerCase();
  return `<span class="badge badge-${k}">${k.charAt(0).toUpperCase()+k.slice(1)}</span>`;
}
function getAddress(lead) {
  if (!lead) return '';
  const parts = [lead.street, lead.city, lead.state ? lead.state + ' ' + (lead.zip||'') : (lead.zip||'')].filter(Boolean);
  return parts.join(', ').trim();
}

// ── Firebase init + sign-in (email/password, locked to one account) ───────────
// Anonymous sign-in was removed: it let anyone with this public config read and
// write the database. Rules now only allow ALLOWED_EMAIL. Sign-in is remembered
// on the phone, so it's only asked for once.
const ALLOWED_EMAIL = 'kwaite@atlantaforklifts.com';

async function initFirebase() {
  const app = initializeApp(FB_CONFIG);
  db   = initializeFirestore(app, { localCache: memoryLocalCache() });
  auth = getAuth(app);
  setDot('connecting');
  await new Promise(resolve => {
    onAuthStateChanged(auth, user => {
      if (user && !user.isAnonymous && (user.email || '').toLowerCase() === ALLOWED_EMAIL) {
        hideSignIn();
        setDot('online');
        console.log('[AFL] Signed in as', user.email);
        resolve();
      } else if (user) {
        signOut(auth).catch(() => {});   // leftover anonymous session or wrong account
      } else {
        setDot('error');
        showSignIn();
      }
    });
  });
}

function showSignIn() {
  let ov = document.getElementById('afl-signin');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'afl-signin';
    ov.style.cssText = 'position:fixed;inset:0;background:#f4f4f4;z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = `
      <form id="afl-signin-form" style="background:#fff;border-radius:14px;padding:24px;width:100%;max-width:360px;box-shadow:0 6px 24px rgba(0,0,0,.12)">
        <div style="font-size:20px;font-weight:700;margin-bottom:4px">AFL Sales Tracker</div>
        <div style="font-size:14px;color:#666;margin-bottom:18px">Sign in once on this phone.</div>
        <input id="afl-signin-email" type="email" autocomplete="username" value="${ALLOWED_EMAIL}" style="width:100%;box-sizing:border-box;padding:12px;font-size:16px;margin-bottom:10px;border:1px solid #ccc;border-radius:8px">
        <input id="afl-signin-pw" type="password" autocomplete="current-password" placeholder="Password" style="width:100%;box-sizing:border-box;padding:12px;font-size:16px;margin-bottom:10px;border:1px solid #ccc;border-radius:8px">
        <div id="afl-signin-err" style="color:#c62828;font-size:13px;min-height:18px;margin-bottom:8px"></div>
        <button type="submit" style="width:100%;padding:13px;font-size:16px;background:#eb0a1e;color:#fff;border:0;border-radius:8px;font-weight:700">Sign in</button>
        <a href="#" id="afl-signin-reset" style="display:block;text-align:center;margin-top:14px;font-size:13px;color:#555">Forgot password?</a>
      </form>`;
    document.body.appendChild(ov);
    document.getElementById('afl-signin-form').addEventListener('submit', async e => {
      e.preventDefault();
      const errEl = document.getElementById('afl-signin-err');
      errEl.textContent = 'Signing in…';
      try {
        await signInWithEmailAndPassword(auth,
          document.getElementById('afl-signin-email').value.trim(),
          document.getElementById('afl-signin-pw').value);
      } catch (err) {
        errEl.textContent = (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password')
          ? 'Wrong email or password.'
          : err.code === 'auth/network-request-failed' ? 'No internet connection.' : `Sign-in failed (${err.code || 'error'}).`;
      }
    });
    document.getElementById('afl-signin-reset').addEventListener('click', async e => {
      e.preventDefault();
      const email = document.getElementById('afl-signin-email').value.trim();
      const errEl = document.getElementById('afl-signin-err');
      try { await sendPasswordResetEmail(auth, email); errEl.textContent = `Reset link sent to ${email}`; }
      catch (err) { errEl.textContent = `Could not send reset email (${err.code || 'error'}).`; }
    });
  }
  ov.style.display = 'flex';
}

function hideSignIn() {
  const ov = document.getElementById('afl-signin');
  if (ov) ov.style.display = 'none';
}

// ── Data loading ──────────────────────────────────────────────────────────────
let _unsubTasks = null;
let _unsubLeads = null;

async function loadData(showSkeleton = true) {
  if (showSkeleton) showSkeletons();
  try {
    const [eqSnap, quotesSnap, salesSnap, settDoc] = await Promise.all([
      getDocs(collection(db, 'equipment')),
      getDocs(collection(db, 'quotes')),
      getDocs(collection(db, 'sales')),
      getDoc(doc(db, 'settings', 'main')),
    ]);
    const toArr = snap => snap.docs.map(d => d.data());
    appData.equipment = toArr(eqSnap);
    appData.quotes    = toArr(quotesSnap);
    appData.sales     = toArr(salesSnap);

    if (settDoc.exists()) {
      const sd = settDoc.data();
      appData.settings = sd;
      if (sd.territoryZips && sd.territoryZips.length) appData.territoryZips = sd.territoryZips;
      if (sd.leadGen && sd.leadGen.mapsApiKey) appData.mapsApiKey = sd.leadGen.mapsApiKey;
    }

    // Real-time listeners for leads and tasks
    _startLeadsListener();
    _startTasksListener();

    renderCurrentTab();
    console.log(`[AFL] Loaded: equipment=${appData.equipment.length} quotes=${appData.quotes.length} sales=${appData.sales.length}`);
  } catch (err) {
    console.error('[AFL] Load failed:', err);
    loadFromCache();
  }
}

function _startLeadsListener() {
  if (_unsubLeads) _unsubLeads();
  _unsubLeads = onSnapshot(
    collection(db, 'leads'),
    snap => {
      appData.leads = snap.docs.map(d => d.data());
      try { const c = JSON.parse(localStorage.getItem('afl_cache') || '{}'); c.leads = appData.leads; localStorage.setItem('afl_cache', JSON.stringify(c)); } catch {}
      if (activeTab === 'home' || activeTab === 'contacts' || activeTab === 'fleet') renderCurrentTab();
      updateTaskBadge();
    },
    err => console.error('[AFL] Leads listener error:', err)
  );
}

function _startTasksListener() {
  if (_unsubTasks) _unsubTasks();
  _unsubTasks = onSnapshot(
    collection(db, 'tasks'),
    snap => {
      appData.tasks = snap.docs.map(d => d.data());
      try { const c = JSON.parse(localStorage.getItem('afl_cache') || '{}'); c.tasks = appData.tasks; localStorage.setItem('afl_cache', JSON.stringify(c)); } catch {}
      updateTaskBadge();
      if (activeTab === 'tasks') renderTasksList();
      if (activeTab === 'home') renderHome();
    },
    err => console.error('[AFL] Tasks listener error:', err)
  );
}

function loadFromCache() {
  try {
    const raw = localStorage.getItem('afl_cache');
    if (!raw) return;
    const cached = JSON.parse(raw);
    appData = { ...appData, ...cached };
    showBanner('Showing cached data — pull down to refresh when online', 'warn');
    renderCurrentTab();
  } catch {}
}

function showSkeletons() {
  ['home','fleet','contacts','tasks'].forEach(tab => {
    const el = document.getElementById('tab-' + tab);
    if (el) el.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div>';
  });
}

// ── Status helpers ────────────────────────────────────────────────────────────
function setDot(state) {
  const dot = document.getElementById('fb-dot');
  if (!dot) return;
  dot.className = 'nav-dot';
  if (state === 'online') dot.classList.add('online');
  else if (state === 'error') dot.classList.add('error');
}

function showBanner(msg, type='info') {
  const b = document.getElementById('offline-banner');
  if (!b) return;
  b.textContent = msg;
  b.style.background = type === 'error' ? '#c62828' : type === 'warn' ? '#e65100' : '#e65100';
  b.classList.add('visible');
  if (type !== 'error') setTimeout(() => b.classList.remove('visible'), 5000);
}

// ── Tab navigation ────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('tab-' + name);
  if (panel) panel.classList.add('active');
  const btn = document.querySelector(`.nav-btn[data-tab="${name}"]`);
  if (btn) btn.classList.add('active');
  activeTab = name;
  renderTab(name);
}

function renderCurrentTab() { renderTab(activeTab); }
function renderTab(name) {
  if (name === 'home')          renderHome();
  else if (name === 'fleet')    renderFleetSearch();
  else if (name === 'contacts') renderContacts();
  else if (name === 'tasks')    renderTasks();
  else if (name === 'quote')    renderQuotes();
  else if (name === 'dailylog') renderMobileDailyLog();
  updateTaskBadge();
}

// ── Home Tab ──────────────────────────────────────────────────────────────────
function renderHome() {
  const el = document.getElementById('tab-home');
  if (!el) return;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const openTasks = appData.tasks.filter(t => !t.completedAt && !t.completed);
  const openQuotes = appData.quotes.filter(q => q.stage === 'quoted' || q.stage === 'followup');

  const recentHtml = recentlyViewed.slice(0,5).map(id => {
    const lead = appData.leads.find(l => l.id === id);
    if (!lead) return '';
    return `<div class="activity-item" data-contact="${esc(id)}">
      <div class="activity-dot"></div>
      <div>
        <div class="activity-company">${esc(lead.companyName)}</div>
        <div class="activity-meta">${esc(lead.city || '')}${lead.zip ? ' · ' + esc(lead.zip) : ''}</div>
      </div>
    </div>`;
  }).filter(Boolean).join('');

  el.innerHTML = `
    <div class="greeting-card">
      <div class="greeting-name">${esc(greeting)}, Kyle 👋</div>
      <div class="greeting-sub">Atlanta Fork Lifts Territory</div>
    </div>
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-num">${openTasks.length}</div>
        <div class="stat-lbl">Open Tasks</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${openQuotes.length}</div>
        <div class="stat-lbl">Open Quotes</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${appData.leads.length}</div>
        <div class="stat-lbl">Contacts</div>
      </div>
    </div>
    <button class="quick-prospect-btn" id="home-prospect-btn">🎯 Quick Prospect — High Priority Fleet</button>
    ${recentHtml ? `<div class="section-header">Recent Contacts</div>${recentHtml}` : ''}
  `;
  document.getElementById('home-prospect-btn')?.addEventListener('click', () => runQuickProspect());
  el.querySelectorAll('.activity-item[data-contact]').forEach(row => {
    row.addEventListener('click', () => openContactProfile(row.dataset.contact));
  });
}

// ── Fleet Search Tab ──────────────────────────────────────────────────────────
function renderFleetSearch() {
  const el = document.getElementById('tab-fleet');
  if (!el) return;
  const zips = appData.territoryZips;
  const zipOptions = `<option value="">All Territory</option>` + zips.map(z => `<option value="${z}">${z} — ${ZIP_CITIES[z]||''}</option>`).join('');
  el.innerHTML = `
    <div class="filter-row">
      <div class="filter-group">
        <div class="filter-label">Zip Code</div>
        <select class="filter-select" id="fleet-zip">${zipOptions}</select>
      </div>
      <div class="filter-group">
        <div class="filter-label">Min Age</div>
        <select class="filter-select" id="fleet-age">
          <option value="0">Any Age</option>
          <option value="5">5+ Years</option>
          <option value="7">7+ Years</option>
          <option value="10" selected>10+ Years</option>
        </select>
      </div>
      <div class="filter-group">
        <div class="filter-label">Priority</div>
        <select class="filter-select" id="fleet-priority">
          <option value="">Any</option>
          <option value="high" selected>High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>
    </div>
    <button id="fleet-search-btn">🔍 Search Fleet</button>
    <div id="fleet-results-header"></div>
    <div id="fleet-results"></div>
  `;
  document.getElementById('fleet-search-btn')?.addEventListener('click', doFleetSearch);
  doFleetSearch();
}

function doFleetSearch() {
  const zipFilter  = document.getElementById('fleet-zip')?.value || '';
  const ageFilter  = parseFloat(document.getElementById('fleet-age')?.value || '0');
  const priFilter  = document.getElementById('fleet-priority')?.value || '';
  const hdr = document.getElementById('fleet-results-header');
  const res = document.getElementById('fleet-results');
  if (!hdr || !res) return;

  const equipByLead = {};
  for (const eq of appData.equipment) {
    const age = fleetAgeYears(eq.dateOfPurchase);
    if (ageFilter > 0 && age < ageFilter) continue;
    if (!eq.leadId) continue;
    if (!equipByLead[eq.leadId]) equipByLead[eq.leadId] = [];
    equipByLead[eq.leadId].push(eq);
  }

  let results = [];
  for (const [leadId, eqs] of Object.entries(equipByLead)) {
    const lead = appData.leads.find(l => l.id === leadId);
    if (!lead) continue;
    if (zipFilter && lead.zip !== zipFilter) continue;
    const terr = appData.territoryZips;
    if (!zipFilter && !terr.includes(lead.zip || '')) continue;
    const oldest = eqs.sort((a,b) => fleetAgeMs(b.dateOfPurchase) - fleetAgeMs(a.dateOfPurchase))[0];
    const topPri = fleetPriority(oldest.dateOfPurchase);
    if (priFilter && topPri !== priFilter) continue;
    results.push({ lead, eqs, oldest, topPri, oldestAge: fleetAgeYears(oldest.dateOfPurchase) });
  }
  results.sort((a,b) => b.oldestAge - a.oldestAge);

  hdr.textContent = results.length ? `${results.length} companies found` : '';
  if (!results.length) {
    res.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">No results — try different filters</div></div>';
    return;
  }
  res.innerHTML = results.map(r => {
    const phoneHtml = r.lead.phone ? `<a href="tel:${esc(r.lead.phone)}" class="call-btn" data-phone="${esc(r.lead.phone)}">📞</a>` : '';
    return `<div class="fleet-result-item" data-lead="${esc(r.lead.id)}">
      <div class="fleet-result-main">
        <div class="fleet-result-company">${esc(r.lead.companyName)}</div>
        <div class="fleet-result-meta">${esc(r.lead.city||'')} ${esc(r.lead.zip||'')} · ${r.eqs.length} unit${r.eqs.length!==1?'s':''}</div>
      </div>
      <div class="fleet-result-right">
        <div class="fleet-result-age">${fleetAgeText(r.oldest.dateOfPurchase)}</div>
        ${priorityBadge(r.topPri)}
        <button class="fleet-quote-btn" data-lead="${esc(r.lead.id)}">+ Quote</button>
      </div>
      ${phoneHtml}
    </div>`;
  }).join('');

  res.querySelectorAll('.fleet-result-item').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.call-btn') || e.target.closest('.fleet-quote-btn')) return;
      openContactProfile(row.dataset.lead);
    });
  });
  res.querySelectorAll('.fleet-quote-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openQuoteFormForLead(btn.dataset.lead); });
  });
  res.querySelectorAll('.call-btn').forEach(btn => {
    btn.addEventListener('click', e => e.stopPropagation());
  });
}

function runQuickProspect() {
  switchTab('fleet');
  setTimeout(() => {
    const ageEl = document.getElementById('fleet-age');
    const priEl = document.getElementById('fleet-priority');
    if (ageEl) ageEl.value = '10';
    if (priEl) priEl.value = 'high';
    doFleetSearch();
  }, 50);
}

// ── Contacts Tab ──────────────────────────────────────────────────────────────
function renderContacts() {
  const el = document.getElementById('tab-contacts');
  if (!el) return;
  el.innerHTML = `
    <div class="search-bar-wrap">
      <input class="search-input" id="contacts-search" type="search" placeholder="Search companies, names, phone, city, zip…" autocomplete="off" autocorrect="off" spellcheck="false">
    </div>
    <div class="contacts-list" id="contacts-list"></div>
  `;
  const input = document.getElementById('contacts-search');
  input?.addEventListener('input', () => renderContactsList(input.value));
  renderContactsList('');
}

function renderContactsList(query) {
  const list = document.getElementById('contacts-list');
  if (!list) return;
  const q = (query||'').toLowerCase().trim();
  let leads = [...appData.leads];
  if (q) {
    leads = leads.filter(l => {
      const hay = [l.companyName, l.contactName, l.firstName, l.lastName, l.phone, l.email, l.city, l.zip, l.street].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  leads.sort((a,b) => (b.updatedAt||'').localeCompare(a.updatedAt||''));

  if (!leads.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">👥</div><div class="empty-text">No contacts found</div></div>';
    return;
  }
  list.innerHTML = leads.map(l => {
    const priority = getLeadTopPriority(l.id);
    const sub = [l.city, l.zip].filter(Boolean).join(' ');
    const phoneHtml = l.phone ? `<a href="tel:${esc(l.phone)}" class="contact-call-btn" onclick="event.stopPropagation()">📞</a>` : '';
    return `<div class="contact-row" data-id="${esc(l.id)}">
      <div class="contact-row-main">
        <div class="contact-row-company">${esc(l.companyName||'(no name)')}</div>
        <div class="contact-row-sub">${esc(sub)}${sub?' · ':''}${(l.contactName||l.firstName) ? esc(l.contactName||((l.firstName||'')+' '+(l.lastName||'')).trim()) : ''}</div>
      </div>
      <div class="contact-row-right">
        ${statusBadge(l.status)}
        ${priority ? priorityBadge(priority) : ''}
      </div>
      ${phoneHtml}
    </div>`;
  }).join('');

  list.querySelectorAll('.contact-row').forEach(row => {
    row.addEventListener('click', () => openContactProfile(row.dataset.id));
  });
}

// ── Contact Profile Sheet ─────────────────────────────────────────────────────
function openContactProfile(leadId) {
  const lead = appData.leads.find(l => l.id === leadId);
  if (!lead) return;
  viewingId = leadId;
  // Track recently viewed
  recentlyViewed = [leadId, ...recentlyViewed.filter(id => id !== leadId)].slice(0, 10);
  try { localStorage.setItem('afl_recent', JSON.stringify(recentlyViewed)); } catch {}

  const sheet = document.getElementById('contact-sheet');
  if (!sheet) return;
  document.getElementById('sheet-title').textContent = lead.companyName || '(no name)';

  const address = getAddress(lead);
  const mapsKey = appData.mapsApiKey;
  const encAddr = address ? encodeURIComponent(address) : '';

  // Map thumbnail
  let mapHtml;
  if (address && mapsKey) {
    const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${encAddr}&zoom=18&size=400x200&maptype=satellite&markers=color:red%7C${encAddr}&key=${mapsKey}`;
    mapHtml = `<div class="map-thumbnail"><img src="${esc(mapUrl)}" alt="Satellite view" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'map-no-address\\'>Map unavailable</div>'"></div>`;
  } else if (address && !mapsKey) {
    mapHtml = `<div class="map-thumbnail"><div class="map-no-address">📍 No Maps API key configured</div></div>`;
  } else {
    mapHtml = `<div class="map-thumbnail"><div class="map-no-address">No address on file</div></div>`;
  }

  // Map action buttons
  const mapsUrl    = address ? `https://maps.google.com/maps?q=${encAddr}&t=k` : '';
  const dirUrl     = address ? `https://maps.google.com/maps?daddr=${encAddr}` : '';
  const earthUrl   = address ? `https://earth.google.com/web/search/${encAddr}` : '';
  const mapBtns = address ? `
    <div class="map-btns">
      <a class="map-btn" href="${esc(mapsUrl)}" target="_blank" rel="noopener"><div class="map-btn-icon">🛰</div>Satellite Map</a>
      <a class="map-btn" href="${esc(dirUrl)}"  target="_blank" rel="noopener"><div class="map-btn-icon">🧭</div>Directions</a>
      <a class="map-btn" href="${esc(earthUrl)}" target="_blank" rel="noopener"><div class="map-btn-icon">🌍</div>Google Earth</a>
    </div>` : '';

  // Quotes
  const leadQuotes = appData.quotes.filter(q => q.linkedContactId === leadId || q.customerName === lead.companyName);
  const openQuotes = leadQuotes.filter(q => q.stage !== 'won' && q.stage !== 'lost');
  const quotesHtml = openQuotes.length ? openQuotes.map(q => {
    const model = q.items?.[0]?.forkliftModel || q.forkliftModel || '—';
    return `<div class="quote-row"><div><div class="quote-model">${esc(model)}</div><div class="quote-date">${fmt(q.dateOfQuote)}</div></div>${stageBadge(q.stage)}</div>`;
  }).join('') : '<div style="padding:10px 16px;color:var(--text3);font-size:13px">No open quotes</div>';

  // Sales
  const leadSales = appData.sales.filter(s => s.linkedContactId === leadId || s.customerName === lead.companyName);
  const totalSpend = leadSales.reduce((sum, s) => sum + (Number(s.salePrice)||0), 0);
  const salesHtml = leadSales.length ? leadSales.slice(0,5).map(s => {
    const model = s.forkliftModel || s.model || '—';
    return `<div class="sale-row"><div><div class="quote-model">${esc(model)}</div><div class="quote-date">${fmt(s.dateSold)}</div></div><div class="sale-amount">${money(s.salePrice)}</div></div>`;
  }).join('') + (totalSpend ? `<div style="padding:10px 16px;font-size:13px;color:var(--text2)">Total spend: <strong style="color:var(--green)">${money(totalSpend)}</strong></div>` : '') : '<div style="padding:10px 16px;color:var(--text3);font-size:13px">No sales history</div>';

  // Fleet
  const equipment = getLeadEquipment(leadId);
  const fleetHtml = equipment.length ? equipment.sort((a,b) => fleetAgeMs(b.dateOfPurchase)-fleetAgeMs(a.dateOfPurchase)).map(eq => {
    const pri = fleetPriority(eq.dateOfPurchase);
    return `<div class="fleet-row"><div><div class="fleet-model">${esc(eq.forkliftModel||'Unknown model')}</div><div class="fleet-age">${fleetAgeText(eq.dateOfPurchase)} · ${esc(eq.serialNumber||'')}</div></div>${priorityBadge(pri)}</div>`;
  }).join('') : '<div style="padding:10px 16px;color:var(--text3);font-size:13px">No fleet on record</div>';

  document.getElementById('sheet-body').innerHTML = `
    <div class="info-row"><div class="info-icon">🏢</div><div class="info-text"><div class="info-label">Company</div><div class="info-value">${esc(lead.companyName||'—')}</div></div></div>
    ${lead.contactName || lead.firstName ? `<div class="info-row"><div class="info-icon">👤</div><div class="info-text"><div class="info-label">Contact</div><div class="info-value">${esc(lead.contactName||(lead.firstName+' '+lead.lastName).trim())}</div></div></div>` : ''}
    ${lead.phone  ? `<div class="info-row"><div class="info-icon">📞</div><div class="info-text"><div class="info-label">Phone</div><a class="info-value" href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a></div></div>` : ''}
    ${lead.email  ? `<div class="info-row"><div class="info-icon">✉️</div><div class="info-text"><div class="info-label">Email</div><a class="info-value" href="mailto:${esc(lead.email)}">${esc(lead.email)}</a></div></div>` : ''}
    ${address     ? `<div class="info-row"><div class="info-icon">📍</div><div class="info-text"><div class="info-label">Address</div><div class="info-value">${esc(address)}</div></div></div>` : ''}
    <div class="divider"></div>
    ${mapHtml}${mapBtns}
    <div class="divider"></div>
    <div class="section-title">Open Quotes</div>${quotesHtml}
    <div class="section-title">Sales History</div>${salesHtml}
    <div class="section-title">Fleet on Record</div>${fleetHtml}
    <div class="section-title">Field Notes</div>
    <div style="padding:0 12px 8px">
      <textarea class="notes-area" id="sheet-notes" rows="3" placeholder="Type a note…">${esc(lead.notes||'')}</textarea>
      <button class="save-notes-btn" id="save-notes-btn">Save Note</button>
    </div>
    <div class="section-title">Documents</div>
    <div id="sheet-docs-list" class="doc-list-wrap"><div class="doc-list-loading">Loading…</div></div>
    <button class="start-quote-btn" id="sheet-quote-btn">+ Start Quote</button>
  `;

  document.getElementById('save-notes-btn')?.addEventListener('click', saveContactNote);
  document.getElementById('sheet-quote-btn')?.addEventListener('click', () => { closeSheet(); openQuoteFormForLead(leadId); });

  sheet.classList.add('open');
  loadContactDocs(leadId);
}

async function loadContactDocs(leadId) {
  const container = document.getElementById('sheet-docs-list');
  if (!container) return;
  try {
    const q = query(
      collection(db, 'contactDocuments'),
      where('linkedId', '==', leadId),
      orderBy('createdAt', 'desc')
    );
    const snap = await getDocs(q);
    const docs = snap.docs.map(d => d.data());
    if (!docs.length) {
      container.innerHTML = '<div class="doc-list-empty">No documents on file</div>';
      return;
    }
    container.innerHTML = docs.map(d => {
      const name = esc(d.displayName || d.originalFileName || 'Document');
      const cat  = (d.category || 'other').replace(/_/g, ' ');
      const url  = esc(d.downloadURL || '');
      return `<div class="doc-list-item">
        <div class="doc-list-icon">${docExtIcon(d.ext)}</div>
        <div class="doc-list-info">
          <div class="doc-list-name">${name}</div>
          <div class="doc-list-meta">${cat}${d.description ? ' · ' + esc(d.description) : ''}</div>
        </div>
        ${url ? `<a class="doc-open-btn" href="${url}" target="_blank" rel="noopener">Open</a>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div class="doc-list-empty">Could not load documents</div>';
    console.warn('[loadContactDocs]', e);
  }
}

function docExtIcon(ext) {
  const e = (ext || '').toLowerCase();
  if (e === 'pdf')  return 'PDF';
  if (e === 'docx' || e === 'doc') return 'DOC';
  if (e === 'xlsx' || e === 'xls') return 'XLS';
  if (e === 'jpg'  || e === 'jpeg'|| e === 'png' || e === 'gif' || e === 'webp') return 'IMG';
  return (e || 'FILE').toUpperCase().slice(0, 4);
}

function closeSheet() {
  document.getElementById('contact-sheet')?.classList.remove('open');
  viewingId = null;
}

async function saveContactNote() {
  if (!viewingId || !db) return;
  const lead = appData.leads.find(l => l.id === viewingId);
  if (!lead) return;
  const notes = document.getElementById('sheet-notes')?.value || '';
  const btn   = document.getElementById('save-notes-btn');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  try {
    lead.notes = notes;
    lead.updatedAt = new Date().toISOString();
    await setDoc(doc(db, 'leads', lead.id), lead);
    if (btn) { btn.textContent = 'Saved ✓'; setTimeout(() => { if (btn) { btn.textContent = 'Save Note'; btn.disabled = false; } }, 1500); }
    // Refresh cache
    try { const c = JSON.parse(localStorage.getItem('afl_cache')||'{}'); c.leads = appData.leads; localStorage.setItem('afl_cache', JSON.stringify(c)); } catch {}
  } catch (err) {
    console.error('[AFL] Save note failed:', err);
    if (btn) { btn.textContent = 'Failed — retry'; btn.disabled = false; }
  }
}

// ── Tasks Tab ─────────────────────────────────────────────────────────────────
let _tasksRendered = false;

// Date a task was entered: createdAt, or the timestamp baked into its id (t_<ms>_xxxxx)
function taskEnteredLabel(t) {
  let ms = t.createdAt ? Date.parse(t.createdAt) : NaN;
  if (isNaN(ms)) { const m = /^t_(\d{12,})_/.exec(t.id || ''); if (m) ms = Number(m[1]); }
  if (isNaN(ms)) return '';
  const d = new Date(ms);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return 'Entered ' + d.toLocaleDateString('en-US', opts);
}


// ── Task due dates: default, overdue highlight, grouping ───────────────────────
const TASK_DEFAULT_DUE_DAYS = 3;   // new tasks default to due this many days out
function taskLocalISO(offsetDays = 0) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Open tasks → overdue (oldest first), upcoming (soonest first), no date (newest first)
function groupOpenTasks(open) {
  const today = taskLocalISO();
  const byDue = (a, b) => a.dueDate.localeCompare(b.dueDate);
  const byNew = (a, b) => (b.createdAt || b.id || '').localeCompare(a.createdAt || a.id || '');
  return {
    overdue:  open.filter(t => t.dueDate && t.dueDate < today).sort(byDue),
    upcoming: open.filter(t => t.dueDate && t.dueDate >= today).sort(byDue),
    undated:  open.filter(t => !t.dueDate).sort(byNew),
  };
}
function taskDueClass(t) {
  if (!t.dueDate || t.completedAt || t.completed) return '';
  const today = taskLocalISO();
  return t.dueDate < today ? ' overdue' : t.dueDate === today ? ' due-today' : '';
}

function openTaskSectionsHtml(open) {
  const g = groupOpenTasks(open);
  const section = (label, list, cls = '') => list.length
    ? `<div class="task-section-label${cls}">${label} · ${list.length}</div><div class="task-list">${list.map(taskItemHtml).join('')}</div>` : '';
  return section('Overdue', g.overdue, ' overdue') + section('Upcoming', g.upcoming) + section('No due date', g.undated);
}

function taskItemHtml(t) {
  const done = !!t.completedAt || !!t.completed;
  const enteredLabel = taskEnteredLabel(t);
  const dueCls = taskDueClass(t);
  const dueLabel = t.dueDate ? (dueCls === ' overdue' ? `Overdue · ${fmt(t.dueDate)}` : dueCls === ' due-today' ? 'Due today' : `Due ${fmt(t.dueDate)}`) : '';
  const linkedName = t.linkedName || (t.linkedContactId ? appData.leads.find(l => l.id === t.linkedContactId)?.companyName : null);
  return `<div class="task-item${done ? ' completed' : ''}" data-task-id="${esc(t.id)}">
    <div class="task-checkbox${done ? ' checked' : ''}" data-task-check="${esc(t.id)}">${done ? '✓' : ''}</div>
    <div class="task-body">
      <div class="task-title${done ? ' checked' : ''}">${esc(t.title)}</div>
      <div class="task-meta">
        ${enteredLabel ? `<span class="task-entered">${esc(enteredLabel)}</span>` : ''}
        ${dueLabel ? `<span class="task-due${dueCls}">${esc(dueLabel)}</span>` : ''}
        ${linkedName ? `<span class="task-linked">${esc(linkedName)}</span>` : ''}
      </div>
      ${t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : ''}
    </div>
  </div>`;
}

function renderTasks() {
  const el = document.getElementById('tab-tasks');
  if (!el) return;
  const byCreatedDesc = (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '');
  const open = appData.tasks.filter(t => !t.completedAt && !t.completed).sort(byCreatedDesc);
  const done = appData.tasks.filter(t => !!t.completedAt || !!t.completed).sort(byCreatedDesc);
  const leadOptions = '<option value="">— No linked contact —</option>' +
    [...appData.leads].sort((a,b)=>(a.companyName||'').localeCompare(b.companyName||'')).map(l =>
      `<option value="${esc(l.id)}">${esc(l.companyName)}</option>`).join('');
  el.innerHTML = `
    <div class="task-add-bar">
      <input class="task-add-input" id="task-title-input" type="text" placeholder="Add a task…">
      <div class="task-add-fields" id="task-add-fields" style="display:none">
        <input class="task-add-subinput" id="task-due-input" type="date" value="${taskLocalISO(TASK_DEFAULT_DUE_DAYS)}">
        <textarea class="task-add-subinput" id="task-notes-input" rows="2" placeholder="Notes (optional)"></textarea>
        <select class="task-add-subinput" id="task-contact-input">${leadOptions}</select>
        <div class="task-add-actions">
          <button class="btn-cancel" id="task-add-cancel">Cancel</button>
          <button class="btn-save" id="task-add-save">Add Task</button>
        </div>
      </div>
    </div>
    <div id="tasks-list-body">
      ${!open.length && !done.length ? '<div class="empty-state"><div class="empty-text">No tasks yet — add one above!</div></div>' : ''}
      ${open.length ? openTaskSectionsHtml(open) : ''}
      ${done.length ? `<div class="task-section-label">Completed <button class="clear-done-btn" onclick="clearDoneTasks()">Clear</button></div><div class="task-list">${done.map(taskItemHtml).join('')}</div>` : ''}
    </div>`;
  document.getElementById('task-title-input')?.addEventListener('focus', () => {
    document.getElementById('task-add-fields').style.display = 'flex';
  });
  document.getElementById('task-title-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addTaskFromBar(); }
  });
  document.getElementById('task-add-save')?.addEventListener('click', addTaskFromBar);
  document.getElementById('task-add-cancel')?.addEventListener('click', () => {
    document.getElementById('task-title-input').value = '';
    document.getElementById('task-due-input').value = taskLocalISO(TASK_DEFAULT_DUE_DAYS);
    document.getElementById('task-notes-input').value = '';
    document.getElementById('task-contact-input').value = '';
    document.getElementById('task-add-fields').style.display = 'none';
  });
  el.addEventListener('click', e => {
    const cb = e.target.closest('[data-task-check]');
    if (cb) { toggleTask(cb.dataset.taskCheck); }
  });
  _tasksRendered = true;
}

function renderTasksList() {
  const body = document.getElementById('tasks-list-body');
  if (!body) { renderTasks(); return; }
  const byCreatedDesc = (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '');
  const open = appData.tasks.filter(t => !t.completedAt && !t.completed).sort(byCreatedDesc);
  const done = appData.tasks.filter(t => !!t.completedAt || !!t.completed).sort(byCreatedDesc);
  body.innerHTML =
    (!open.length && !done.length ? '<div class="empty-state"><div class="empty-text">No tasks yet — add one above!</div></div>' : '') +
    (open.length ? openTaskSectionsHtml(open) : '') +
    (done.length ? `<div class="task-section-label">Completed <button class="clear-done-btn" onclick="clearDoneTasks()">Clear</button></div><div class="task-list">${done.map(taskItemHtml).join('')}</div>` : '');
}

async function toggleTask(taskId) {
  const task = appData.tasks.find(t => t.id === taskId);
  if (!task || !db) return;
  const wasComplete = !!task.completedAt || !!task.completed;
  task.completedAt = wasComplete ? null : new Date().toISOString();
  task.completed = false;
  task.updatedAt = new Date().toISOString();
  try {
    await setDoc(doc(db, 'tasks', taskId), task);
  } catch (err) {
    task.completedAt = wasComplete ? new Date().toISOString() : null;
    console.error('[AFL] Toggle task failed:', err);
  }
}

function updateTaskBadge() {
  const count = appData.tasks.filter(t => !t.completedAt && !t.completed).length;
  const badge = document.getElementById('tasks-badge');
  if (badge) { badge.textContent = count; badge.style.display = count > 0 ? 'flex' : 'none'; }
}

async function addTaskFromBar() {
  const titleEl = document.getElementById('task-title-input');
  const title = (titleEl?.value || '').trim();
  if (!title) { titleEl?.focus(); return; }
  const now = new Date().toISOString();
  const leadId = document.getElementById('task-contact-input')?.value || '';
  const lead = leadId ? appData.leads.find(l => l.id === leadId) : null;
  const task = {
    id: genId('t'), title,
    dueDate:    document.getElementById('task-due-input')?.value || null,
    notes:      document.getElementById('task-notes-input')?.value.trim() || null,
    linkedType: lead ? 'lead' : null,
    linkedId:   lead ? lead.id : null,
    linkedName: lead ? lead.companyName : null,
    linkedContactId: leadId || null,
    assignedTo: null, completedAt: null, completed: false,
    createdAt: now, updatedAt: now,
  };
  appData.tasks.push(task);
  if (titleEl) titleEl.value = '';
  const dueEl = document.getElementById('task-due-input');
  const notesEl = document.getElementById('task-notes-input');
  const contactEl = document.getElementById('task-contact-input');
  if (dueEl) dueEl.value = taskLocalISO(TASK_DEFAULT_DUE_DAYS);
  if (notesEl) notesEl.value = '';
  if (contactEl) contactEl.value = '';
  document.getElementById('task-add-fields').style.display = 'none';
  renderTasksList();
  updateTaskBadge();
  if (db) {
    try { await setDoc(doc(db, 'tasks', task.id), task); } catch (err) { console.error('[AFL] Save task failed:', err); }
  }
}

async function clearDoneTasks() {
  const toDelete = appData.tasks.filter(t => !!t.completedAt || !!t.completed);
  appData.tasks = appData.tasks.filter(t => !t.completedAt && !t.completed);
  renderTasksList();
  updateTaskBadge();
  if (db) {
    for (const t of toDelete) {
      try { await deleteDoc(doc(db, 'tasks', t.id)); } catch (err) { console.error('[AFL] Delete task failed:', err); }
    }
  }
}
window.clearDoneTasks = clearDoneTasks;


// ── Quotes List Tab ───────────────────────────────────────────────────────────
function renderQuotes() {
  const el = document.getElementById('tab-quote');
  if (!el) return;

  const all = [...appData.quotes].sort((a, b) => (b.dateOfQuote || '').localeCompare(a.dateOfQuote || ''));
  const open   = all.filter(q => q.stage !== 'won' && q.stage !== 'lost');
  const closed = all.filter(q => q.stage === 'won' || q.stage === 'lost').slice(0, 10);

  function rowHtml(q) {
    const company = q.customerName || appData.leads.find(l => l.id === q.linkedContactId)?.companyName || '—';
    const model   = q.items?.[0]?.forkliftModel || q.forkliftModel || '—';
    const price   = q.items?.[0]?.price ?? q.salePrice ?? 0;
    return `<div class="quote-list-item" data-id="${esc(q.id)}">
      <div class="quote-list-main">
        <div class="quote-list-company">${esc(company)}</div>
        <div class="quote-list-meta">${esc(model)} · ${money(price)}</div>
      </div>
      <div class="quote-list-right">
        ${stageBadge(q.stage)}
        <div class="quote-list-date">${fmt(q.dateOfQuote)}</div>
      </div>
    </div>`;
  }

  el.innerHTML = `
    <button class="add-quote-fab" id="new-quote-btn">+ New Quote</button>
    ${open.length
      ? `<div class="section-header">Open Quotes (${open.length})</div>${open.map(rowHtml).join('')}`
      : '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">No open quotes — tap New Quote to add one</div></div>'}
    ${closed.length ? `<div class="section-header">Won / Lost</div>${closed.map(rowHtml).join('')}` : ''}
  `;

  document.getElementById('new-quote-btn')?.addEventListener('click', () => renderQuoteForm(null, true));
  el.querySelectorAll('.quote-list-item').forEach(row => {
    row.addEventListener('click', () => openQuoteDetail(row.dataset.id));
  });
}

function openQuoteDetail(quoteId) {
  const quote = appData.quotes.find(q => q.id === quoteId);
  if (!quote) return;
  if (quote.linkedContactId) {
    openContactProfile(quote.linkedContactId);
    return;
  }
  const lead = appData.leads.find(l => l.companyName === quote.customerName);
  if (lead) { openContactProfile(lead.id); return; }

  // Fallback: show a simple detail sheet
  const sheet = document.getElementById('contact-sheet');
  if (!sheet) return;
  document.getElementById('sheet-title').textContent = quote.customerName || 'Quote';
  const model = quote.items?.[0]?.forkliftModel || quote.forkliftModel || '—';
  const price = quote.items?.[0]?.price ?? quote.salePrice ?? 0;
  document.getElementById('sheet-body').innerHTML = `
    <div class="info-row"><div class="info-icon">📋</div><div class="info-text"><div class="info-label">Customer</div><div class="info-value">${esc(quote.customerName || '—')}</div></div></div>
    <div class="info-row"><div class="info-icon">🏗</div><div class="info-text"><div class="info-label">Model</div><div class="info-value">${esc(model)}</div></div></div>
    <div class="info-row"><div class="info-icon">💰</div><div class="info-text"><div class="info-label">Price</div><div class="info-value">${money(price)}</div></div></div>
    <div class="info-row"><div class="info-icon">📅</div><div class="info-text"><div class="info-label">Date</div><div class="info-value">${fmt(quote.dateOfQuote)}</div></div></div>
    <div class="info-row"><div class="info-icon">🏷</div><div class="info-text"><div class="info-label">Stage</div><div class="info-value">${stageBadge(quote.stage)}</div></div></div>
    ${quote.notes ? `<div class="info-row"><div class="info-icon">📝</div><div class="info-text"><div class="info-label">Notes</div><div class="info-value">${esc(quote.notes)}</div></div></div>` : ''}
  `;
  sheet.classList.add('open');
}

// ── Quick Quote Form ──────────────────────────────────────────────────────────
function renderQuoteForm(prefillLeadId, showBack = false) {
  const el = document.getElementById('tab-quote');
  if (!el) return;
  const leadOptions = `<option value="">— Select Customer —</option>` + appData.leads.sort((a,b)=>(a.companyName||'').localeCompare(b.companyName||'')).map(l => `<option value="${esc(l.id)}" ${l.id===prefillLeadId?'selected':''}>${esc(l.companyName)}</option>`).join('');
  const modelOptions = Object.entries(TOYOTA_MODELS).map(([group, models]) => `<optgroup label="${esc(group)}">${models.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('')}</optgroup>`).join('');
  el.innerHTML = `
    ${showBack ? '<button class="quote-back-btn" id="quote-back-btn">← Back</button>' : ''}
    <div class="quote-form-wrap">
      <div id="quote-success" class="success-banner">✅ Quote saved! Visible in the desktop app immediately.</div>
      <div class="form-group"><label class="form-label">Customer</label><select class="form-select" id="q-customer">${leadOptions}</select></div>
      <div class="form-group"><label class="form-label">OEM</label><input class="form-input" id="q-oem" type="text" value="Toyota" placeholder="Toyota"></div>
      <div class="form-group"><label class="form-label">Model</label><select class="form-select" id="q-model"><option value="">— Select Model —</option>${modelOptions}</select></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Quantity</label><input class="form-input" id="q-qty" type="number" value="1" min="1"></div>
        <div class="form-group"><label class="form-label">Price ($)</label><input class="form-input" id="q-price" type="number" placeholder="0" min="0"></div>
      </div>
      <div class="form-group"><label class="form-label">Stage</label>
        <select class="form-select" id="q-stage">
          <option value="quoted" selected>Quoted</option>
          <option value="followup">Follow-up</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><textarea class="form-textarea" id="q-notes" placeholder="Optional notes…"></textarea></div>
      <button class="submit-quote-btn" id="submit-quote-btn">Save Quote to Firebase</button>
    </div>
  `;
  document.getElementById('submit-quote-btn')?.addEventListener('click', submitQuote);
  document.getElementById('quote-back-btn')?.addEventListener('click', renderQuotes);
  document.getElementById('q-oem')?.addEventListener('change', e => {
    const sel = document.getElementById('q-model');
    if (sel && e.target.value.toLowerCase() !== 'toyota') sel.innerHTML = '<option value="">Enter model manually</option>';
  });
}

async function submitQuote() {
  const customerSel = document.getElementById('q-customer');
  const leadId = customerSel?.value;
  const lead   = leadId ? appData.leads.find(l => l.id === leadId) : null;
  if (!leadId || !lead) { customerSel?.focus(); return; }
  const oem   = document.getElementById('q-oem')?.value.trim()  || 'Toyota';
  const model = document.getElementById('q-model')?.value.trim() || '';
  const qty   = parseInt(document.getElementById('q-qty')?.value)   || 1;
  const price = parseFloat(document.getElementById('q-price')?.value) || 0;
  const stage = document.getElementById('q-stage')?.value || 'quoted';
  const notes = document.getElementById('q-notes')?.value.trim() || '';
  const btn   = document.getElementById('submit-quote-btn');

  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  const now = new Date().toISOString();
  const quote = {
    id: genId('q'), customerName: lead.companyName,
    linkedContactId: lead.id, linkedCustomerId: lead.linkedCustomerId || null,
    stage, dateOfQuote: today(), salesperson: 'Kyle',
    notes, items: [{ oem, forkliftModel: model, quantity: qty, price }],
    forkliftModel: model, quantity: qty, salePrice: price, oem,
    customerPhone: lead.phone||'', customerEmail: lead.email||'',
    customerStreet: lead.street||'', customerCity: lead.city||'',
    customerState: lead.state||'', customerZip: lead.zip||'',
    createdAt: now, updatedAt: now,
  };
  try {
    if (db) await setDoc(doc(db, 'quotes', quote.id), quote);
    appData.quotes.push(quote);
    const banner = document.getElementById('quote-success');
    if (banner) { banner.classList.add('visible'); }
    if (btn) { btn.textContent = 'Saved ✓'; btn.disabled = true; }
    setTimeout(() => renderQuotes(), 2000);
  } catch (err) {
    console.error('[AFL] Save quote failed:', err);
    if (btn) { btn.textContent = 'Failed — Retry'; btn.disabled = false; }
  }
}

function openQuoteFormForLead(leadId) {
  switchTab('quote');
  setTimeout(() => renderQuoteForm(leadId, true), 50);
}

// ── Pull-to-Refresh ───────────────────────────────────────────────────────────
let ptrStart = 0, ptrActive = false;
function setupPTR() {
  const main = document.getElementById('main-content');
  if (!main) return;
  main.addEventListener('touchstart', e => { ptrStart = e.touches[0].clientY; }, { passive: true });
  main.addEventListener('touchmove', e => {
    if (main.scrollTop === 0 && e.touches[0].clientY - ptrStart > 60) ptrActive = true;
  }, { passive: true });
  main.addEventListener('touchend', () => {
    if (ptrActive) { ptrActive = false; loadData(false); }
  });
}

// ── Online/Offline handling ───────────────────────────────────────────────────
function setupConnectivity() {
  const banner = document.getElementById('offline-banner');
  function update() {
    isOnline = navigator.onLine;
    if (banner) banner.classList.toggle('visible', !isOnline);
    if (banner && !isOnline) banner.textContent = '⚠ You are offline — showing cached data';
    if (isOnline) { setDot('online'); if (!ptrActive) loadData(false); }
    else setDot('error');
  }
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
}

// ── Install Prompt ────────────────────────────────────────────────────────────
function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const prompt = document.getElementById('install-prompt');
    if (prompt) prompt.classList.add('visible');
  });
  document.getElementById('install-btn')?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') document.getElementById('install-prompt')?.classList.remove('visible');
    deferredInstallPrompt = null;
  });
  document.getElementById('install-dismiss')?.addEventListener('click', () => {
    document.getElementById('install-prompt')?.classList.remove('visible');
  });
  // On iOS, show a custom instruction since beforeinstallprompt doesn't fire
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isIOS && !isStandalone) {
    setTimeout(() => {
      const p = document.getElementById('install-prompt');
      if (p && !p.classList.contains('visible')) {
        document.getElementById('install-text').innerHTML = '<strong>Install AFL Sales</strong>Tap <strong>Share ↑</strong> then <strong>Add to Home Screen</strong>';
        p.classList.add('visible');
        const btn = document.getElementById('install-btn');
        if (btn) btn.style.display = 'none';
      }
    }, 3000);
  }
}

// ══ DAILY LOG ════════════════════════════════════════════════════════════════

let _dailyLogRendered  = false;
let mobileDailyLog     = null;
let mobileDlVisits     = [];
let mobileDlView       = 'plan';
let mobileDlDate       = null;


// ── Data helpers ──────────────────────────────────────────────────────────────
async function mobileLoadDailyLog(date) {
  if (!db) { mobileDailyLog = null; return; }
  try {
    const q = query(collection(db, 'activityLogs'), where('date', '==', date));
    const snap = await getDocs(q);
    if (!snap.empty) {
      mobileDailyLog = snap.docs[0].data();
    } else {
      const now = new Date().toISOString();
      const id = genId('al');
      mobileDailyLog = { id, date, stops: [], optimized: false, createdAt: now, updatedAt: now };
      await setDoc(doc(db, 'activityLogs', id), mobileDailyLog);
    }
    // Load visits
    await mobileLoadDlVisits(mobileDailyLog.id);
  } catch (err) {
    console.error('[DL] mobileLoadDailyLog', err);
    mobileDailyLog = null;
  }
}

async function mobileLoadDlVisits(activityLogId) {
  if (!db || !activityLogId) { mobileDlVisits = []; return; }
  try {
    const q = query(collection(db, 'visitLogs'), where('activityLogId', '==', activityLogId));
    const snap = await getDocs(q);
    mobileDlVisits = snap.docs.map(d => d.data());
    mobileDlVisits.sort((a, b) => (a.visitTime || '').localeCompare(b.visitTime || ''));
  } catch (e) {
    mobileDlVisits = [];
  }
}

async function mobileSaveDailyLog() {
  if (!mobileDailyLog || !db) return;
  try {
    await setDoc(doc(db, 'activityLogs', mobileDailyLog.id), mobileDailyLog);
  } catch (err) {
    console.error('[DL] save error', err);
    showBanner('Failed to save daily log', 'error');
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderMobileDailyLog() {
  const el = document.getElementById('tab-dailylog');
  if (!el) return;
  const dateVal = mobileDlDate || today();
  mobileDlDate = dateVal;

  el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Daily Log</div>
    </div>
    <div class="dl-sub-tabs">
      <button class="dl-sub-tab${mobileDlView === 'plan' ? ' active' : ''}" onclick="window.mobileDlSwitchView('plan')">Today's Plan</button>
      <button class="dl-sub-tab${mobileDlView === 'history' ? ' active' : ''}" onclick="window.mobileDlSwitchView('history')">History</button>
    </div>
    <div id="mdl-content"><div class="dl-empty">Loading...</div></div>`;

  if (mobileDlView === 'plan') {
    renderMobileDlPlan();
  } else {
    renderMobileDlHistory();
  }
}

async function renderMobileDlPlan() {
  const content = document.getElementById('mdl-content');
  if (!content) return;

  const dateVal = mobileDlDate || today();

  content.innerHTML = `
    <div style="padding:0 0 8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input type="date" id="mdl-date-picker" value="${esc(dateVal)}" onchange="window.mobileDlDateChanged(this.value)"
        style="border:1px solid var(--border);background:var(--bg3);color:var(--text);border-radius:8px;padding:8px 10px;font-size:14px;flex:1;min-width:140px">
      <button onclick="window.mobileOpenAddStop()" style="background:var(--blue);color:#fff;border:none;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;white-space:nowrap">+ Add Stop</button>
    </div>
    <div style="display:flex;gap:8px;padding-bottom:12px;flex-wrap:wrap">
      <button onclick="window.mobileOptimizeRoute()" style="flex:1;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:13px;font-weight:600">⚡ Optimize Route</button>
      <button onclick="window.mobileOpenFullRoute()" style="flex:1;background:var(--bg3);color:var(--blue);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:13px;font-weight:600">🗺 Open in Maps</button>
    </div>
    <div id="mdl-stops-list"><div class="dl-empty">Loading stops...</div></div>
    <div style="padding:12px 0">
      <button onclick="window.mobileOpenAddStop(true)" style="width:100%;background:var(--bg3);color:var(--text2);border:1px dashed var(--border);border-radius:8px;padding:12px;font-size:14px">+ Add Unplanned Stop</button>
    </div>
    <div id="mdl-summary"></div>`;

  if (!mobileDailyLog || mobileDailyLog.date !== dateVal) {
    await mobileLoadDailyLog(dateVal);
  }
  renderMobileDlStops();
  renderMobileDlSummary();
}

function renderMobileDlStops() {
  const el = document.getElementById('mdl-stops-list');
  if (!el || !mobileDailyLog) return;

  const stops = (mobileDailyLog.stops || []).slice();
  stops.sort((a, b) => {
    const ao = (mobileDailyLog.optimized && a.optimizedOrder != null) ? a.optimizedOrder : (a.plannedOrder || 999);
    const bo = (mobileDailyLog.optimized && b.optimizedOrder != null) ? b.optimizedOrder : (b.plannedOrder || 999);
    return ao - bo;
  });

  if (!stops.length) {
    el.innerHTML = '<div class="dl-empty">No stops yet. Tap "+ Add Stop" to plan your route.</div>';
    return;
  }

  el.innerHTML = stops.map((s, idx) => {
    const order = (mobileDailyLog.optimized && s.optimizedOrder != null) ? s.optimizedOrder : (s.plannedOrder || idx + 1);
    const statusCls = s.status === 'completed' ? 'completed' : s.status === 'skipped' ? 'skipped' : 'planned';
    const statusLbl = s.status === 'completed' ? 'Done' : s.status === 'skipped' ? 'Skipped' : 'Planned';
    const addrParts = [s.address, s.city, s.zip].filter(Boolean).join(', ');
    const mapsUrl = addrParts ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addrParts)}&travelmode=driving` : '';
    const stopIdSafe = (s.stopId || '').replace(/'/g, "\\'");
    return `<div class="dl-stop-card${s.isUnplanned ? ' unplanned' : s.isNewLead ? ' new-lead' : ''}" data-stop-id="${esc(s.stopId)}">
      <div style="display:flex;gap:4px;align-items:flex-start">
        <div class="dl-drag-handle" style="cursor:grab;color:#bbb;font-size:20px;padding:4px 4px 0;user-select:none;touch-action:none" title="Drag to reorder">⠿</div>
        <div class="dl-stop-num" style="flex-shrink:0">${order}</div>
        <div style="flex:1;min-width:0">
          <div class="dl-stop-company">${esc(s.companyName || 'Unknown')}</div>
          ${s.contactName ? `<div class="dl-stop-contact">${esc(s.contactName)}</div>` : ''}
          ${addrParts ? `<div class="dl-stop-addr">${mapsUrl ? `<a href="${esc(mapsUrl)}" target="_blank" style="color:var(--blue);text-decoration:none">${esc(addrParts)}</a>` : esc(addrParts)}</div>` : ''}
          ${s.phone ? `<div style="margin-top:3px"><a href="tel:${esc(s.phone)}" style="color:var(--blue);font-size:13px;text-decoration:none">${esc(s.phone)}</a></div>` : ''}
          ${s.note ? `<div style="font-size:12px;color:#888;margin-top:2px;font-style:italic">${esc(s.note)}</div>` : ''}
          <div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap">
            <span class="dl-stop-status ${statusCls}">${statusLbl}</span>
            ${s.status !== 'completed' ? `<button onclick="window.mobileOpenLogVisit('${stopIdSafe}')" style="background:var(--blue);color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:13px;font-weight:600">Log Visit</button>` : ''}
            <button onclick="window.mobileStartQuoteFromStop('${stopIdSafe}')" style="background:#1a3a7a;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:13px;font-weight:600">Start Quote</button>
            ${s.status === 'planned' ? `<button onclick="window.mobileMkSkipped('${stopIdSafe}')" style="background:var(--bg3);color:var(--text2);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:12px">Skip</button>` : ''}
            <button onclick="window.mobileRemoveStop('${stopIdSafe}')" style="background:none;color:#c62828;border:1px solid #c62828;border-radius:6px;padding:5px 10px;font-size:12px">Remove</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  _initMobileDlTouchDrag(el);
}

function renderMobileDlSummary() {
  const el = document.getElementById('mdl-summary');
  if (!el || !mobileDailyLog) return;
  const stops = mobileDailyLog.stops || [];
  if (!stops.length) { el.innerHTML = ''; return; }
  const completed = stops.filter(s => s.status === 'completed').length;
  const skipped   = stops.filter(s => s.status === 'skipped').length;
  const newLeads  = stops.filter(s => s.isNewLead).length;
  el.innerHTML = `<div class="dl-summary-bar">
    <div class="dl-summary-stat"><div class="dl-summary-num">${stops.length}</div><div class="dl-summary-label">Total</div></div>
    <div class="dl-summary-stat"><div class="dl-summary-num" style="color:var(--green)">${completed}</div><div class="dl-summary-label">Done</div></div>
    <div class="dl-summary-stat"><div class="dl-summary-num" style="color:var(--orange)">${skipped}</div><div class="dl-summary-label">Skipped</div></div>
    ${newLeads > 0 ? `<div class="dl-summary-stat"><div class="dl-summary-num" style="color:var(--green)">${newLeads}</div><div class="dl-summary-label">New Leads</div></div>` : ''}
  </div>`;
}

// ── Stop management ───────────────────────────────────────────────────────────
const _mdlInp = (placeholder, id, type = 'text', extra = '') =>
  `<input id="${id}" type="${type}" placeholder="${placeholder}" ${extra} style="width:100%;box-sizing:border-box;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:11px 12px;font-size:15px;margin-bottom:8px">`;

function mobileOpenAddStop(isUnplanned) {
  const overlay = document.createElement('div');
  overlay.id = 'mdl-overlay-add-stop';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9000;display:flex;align-items:flex-end';
  const tabBtn = (id, label, active) =>
    `<button id="mdl-stype-${id}" onclick="window.mobileDlSwitchStopType('${id}')" style="flex:1;padding:10px 4px;border:none;${id !== 'address' ? 'border-right:1px solid var(--border);' : ''}background:${active ? 'var(--red)' : 'var(--bg3)'};color:${active ? '#fff' : 'var(--text2)'};font-size:12px;font-weight:600;cursor:pointer">${label}</button>`;
  overlay.innerHTML = `
    <div style="background:var(--bg2);border-radius:16px 16px 0 0;padding:20px;width:100%;max-height:85vh;overflow-y:auto">
      <div style="font-size:17px;font-weight:700;color:var(--text);margin-bottom:14px">${isUnplanned ? 'Unplanned Stop' : 'Add Stop'}</div>
      <div style="display:flex;gap:0;margin-bottom:14px;border:1px solid var(--border);border-radius:8px;overflow:hidden">
        ${tabBtn('existing','Existing Contact',true)}
        ${tabBtn('new','New Prospect',false)}
        ${tabBtn('address','Address Only',false)}
      </div>
      <div id="mdl-stop-section-existing">
        <input id="mdl-stop-lead-search" type="text" placeholder="Type company, contact name, or phone…" autocomplete="off"
          style="width:100%;box-sizing:border-box;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:11px 12px;font-size:15px;margin-bottom:4px">
        <input type="hidden" id="mdl-stop-lead-id">
        <div id="mdl-stop-info" style="display:none;background:var(--bg3);border-radius:8px;padding:10px;font-size:13px;color:var(--text2);margin-bottom:8px"></div>
      </div>
      <div id="mdl-stop-section-new" style="display:none">
        ${_mdlInp('Company name *','mdl-new-company')}
        <div style="display:flex;gap:8px">
          <input id="mdl-new-first" type="text" placeholder="First name" style="flex:1;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:11px 12px;font-size:15px;margin-bottom:8px">
          <input id="mdl-new-last"  type="text" placeholder="Last name"  style="flex:1;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:11px 12px;font-size:15px;margin-bottom:8px">
        </div>
        ${_mdlInp('Phone','mdl-new-phone','tel')}
        ${_mdlInp('Email','mdl-new-email','email')}
        ${_mdlInp('Address','mdl-new-address')}
        <div style="display:flex;gap:8px">
          <input id="mdl-new-city"  type="text" placeholder="City"  style="flex:1;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:11px 12px;font-size:15px;margin-bottom:8px">
          <input id="mdl-new-state" type="text" placeholder="State" value="GA" style="width:64px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:11px 12px;font-size:15px;margin-bottom:8px">
          <input id="mdl-new-zip"   type="text" placeholder="Zip"   style="width:90px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:11px 12px;font-size:15px;margin-bottom:8px">
        </div>
      </div>
      <div id="mdl-stop-section-address" style="display:none">
        ${_mdlInp('Address *','mdl-addr-street')}
        <div style="display:flex;gap:8px">
          <input id="mdl-addr-city"  type="text" placeholder="City"  style="flex:1;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:11px 12px;font-size:15px;margin-bottom:8px">
          <input id="mdl-addr-state" type="text" placeholder="State" value="GA" style="width:64px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:11px 12px;font-size:15px;margin-bottom:8px">
          <input id="mdl-addr-zip"   type="text" placeholder="Zip"   style="width:90px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:11px 12px;font-size:15px;margin-bottom:8px">
        </div>
        ${_mdlInp('Location name (optional — defaults to address)','mdl-addr-company')}
        ${_mdlInp('Note (optional)','mdl-addr-note')}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button onclick="document.getElementById('mdl-overlay-add-stop').remove()" style="flex:1;background:var(--bg3);color:var(--text2);border:1px solid var(--border);border-radius:8px;padding:14px;font-size:15px">Cancel</button>
        <button onclick="window.mobileDlConfirmAddStop(${isUnplanned ? 'true' : 'false'})" style="flex:2;background:var(--red);color:#fff;border:none;border-radius:8px;padding:14px;font-size:15px;font-weight:600">Add Stop</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  // Wire autocomplete after DOM is ready
  setTimeout(() => {
    _mobileWireExistingContactSearch('mdl-stop-lead-search');
    _mobileWireCompanyAutocomplete('mdl-new-company');
    _mobileWireAddressAutocomplete('mdl-new-address');
    _mobileWireAddressAutocomplete('mdl-addr-street');
  }, 50);
}

function mobileDlSwitchStopType(type) {
  ['existing', 'new', 'address'].forEach(t => {
    const btn = document.getElementById(`mdl-stype-${t}`);
    const sec = document.getElementById(`mdl-stop-section-${t}`);
    const active = t === type;
    if (btn) { btn.style.background = active ? 'var(--red)' : 'var(--bg3)'; btn.style.color = active ? '#fff' : 'var(--text2)'; }
    if (sec) sec.style.display = active ? '' : 'none';
  });
}

function _mobileWireExistingContactSearch(inputId) {
  const input   = document.getElementById(inputId);
  const hidden  = document.getElementById('mdl-stop-lead-id');
  const infoBox = document.getElementById('mdl-stop-info');
  if (!input) return;
  let dropdown = null;

  const showInfo = lead => {
    if (!infoBox) return;
    if (!lead) { infoBox.style.display = 'none'; return; }
    const addr = [lead.street, lead.city, lead.zip].filter(Boolean).join(', ');
    const contact = lead.contactName || [lead.firstName, lead.lastName].filter(Boolean).join(' ');
    infoBox.style.display = 'block';
    infoBox.innerHTML = `<b style="color:var(--text)">${esc(lead.companyName)}</b>${contact ? '<br>' + esc(contact) : ''}${lead.phone ? '<br>' + esc(lead.phone) : ''}${addr ? '<br>' + esc(addr) : ''}`;
  };

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (hidden) hidden.value = '';
    showInfo(null);
    if (dropdown) { dropdown.remove(); dropdown = null; }
    if (q.length < 2) return;
    const matches = (appData.leads || []).filter(l => {
      return [l.companyName, l.firstName, l.lastName, l.contactName, l.phone].join(' ').toLowerCase().includes(q);
    }).slice(0, 10);
    if (!matches.length) return;
    dropdown = document.createElement('div');
    dropdown.style.cssText = 'position:absolute;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);max-height:220px;overflow-y:auto;width:100%;top:calc(100% + 4px);left:0';
    const wrap = input.parentElement;
    if (wrap.style.position !== 'relative') wrap.style.position = 'relative';
    wrap.appendChild(dropdown);
    matches.forEach(lead => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:10px 12px;font-size:14px;cursor:pointer;border-bottom:1px solid var(--border);color:var(--text)';
      const contact = lead.contactName || [lead.firstName, lead.lastName].filter(Boolean).join(' ');
      const addr = [lead.street, lead.city].filter(Boolean).join(', ');
      item.innerHTML = `<div style="font-weight:600">${esc(lead.companyName || '')}</div>${contact ? `<div style="font-size:12px;color:var(--text2)">${esc(contact)}${lead.phone ? ' · ' + esc(lead.phone) : ''}</div>` : ''}${addr ? `<div style="font-size:11px;color:var(--text3)">${esc(addr)}</div>` : ''}`;
      item.addEventListener('click', () => {
        input.value = lead.companyName || '';
        if (hidden) hidden.value = lead.id;
        showInfo(lead);
        dropdown.remove(); dropdown = null;
      });
      dropdown.appendChild(item);
    });
    setTimeout(() => document.addEventListener('click', function h(e) {
      if (!dropdown?.contains(e.target)) { if (dropdown) { dropdown.remove(); dropdown = null; } document.removeEventListener('click', h); }
    }), 0);
  });
}

async function mobileCreateLeadFromStop(data) {
  const now = new Date().toISOString();
  const id = genId('l');
  const lead = {
    id,
    companyName: data.companyName,
    contactName: data.contactName || [data.firstName, data.lastName].filter(Boolean).join(' '),
    firstName: data.firstName || '', lastName: data.lastName || '',
    phone: data.phone || '', email: data.email || '',
    street: data.address || '', city: data.city || '',
    state: data.state || '', zip: data.zip || '',
    sc2FirstName: '', sc2LastName: '', sc2Title: '', sc2Phone: '', sc2Email: '',
    leadSource: 'daily_log', status: 'prospect',
    statusHistory: [], activityLog: [],
    lastActivityDate: now.slice(0, 10),
    createdAt: now, updatedAt: now,
  };
  appData.leads.push(lead);
  try {
    await setDoc(doc(db, 'leads', id), lead);
    const c = JSON.parse(localStorage.getItem('afl_cache') || '{}');
    c.leads = appData.leads;
    localStorage.setItem('afl_cache', JSON.stringify(c));
  } catch (e) { console.error('[AFL] createLeadFromStop failed:', e); }
  return id;
}

async function mobileDlConfirmAddStop(isUnplanned) {
  const activeSection = ['existing', 'new', 'address'].find(t => document.getElementById(`mdl-stop-section-${t}`)?.style.display !== 'none') || 'existing';
  let contactId = '', companyName = '', contactName = '', firstName = '', lastName = '', phone = '', email = '', address = '', city = '', state = '', zip = '', note = '', isNewLead = false, isAddressOnly = false;

  if (activeSection === 'existing') {
    const leadId = document.getElementById('mdl-stop-lead-id')?.value || '';
    if (!leadId) { showBanner('Select a contact from the search results', 'warn'); return; }
    const lead = appData.leads.find(l => l.id === leadId);
    if (!lead) { showBanner('Contact not found', 'warn'); return; }
    contactId   = leadId;
    companyName = lead.companyName || '';
    contactName = lead.contactName || [lead.firstName, lead.lastName].filter(Boolean).join(' ');
    phone       = lead.phone   || '';
    email       = lead.email   || '';
    address     = lead.street  || '';
    city        = lead.city    || '';
    state       = lead.state   || '';
    zip         = lead.zip     || '';

  } else if (activeSection === 'new') {
    companyName = (document.getElementById('mdl-new-company')?.value || '').trim();
    if (!companyName) { showBanner('Company name required', 'warn'); return; }
    firstName   = (document.getElementById('mdl-new-first')?.value  || '').trim();
    lastName    = (document.getElementById('mdl-new-last')?.value   || '').trim();
    contactName = [firstName, lastName].filter(Boolean).join(' ');
    phone       = (document.getElementById('mdl-new-phone')?.value  || '').trim();
    email       = (document.getElementById('mdl-new-email')?.value  || '').trim();
    address     = (document.getElementById('mdl-new-address')?.value || '').trim();
    city        = (document.getElementById('mdl-new-city')?.value   || '').trim();
    state       = (document.getElementById('mdl-new-state')?.value  || 'GA').trim();
    zip         = (document.getElementById('mdl-new-zip')?.value    || '').trim();
    isNewLead   = true;
    contactId   = await mobileCreateLeadFromStop({ companyName, firstName, lastName, contactName, phone, email, address, city, state, zip });

  } else {
    address = (document.getElementById('mdl-addr-street')?.value  || '').trim();
    if (!address) { showBanner('Address is required', 'warn'); return; }
    city    = (document.getElementById('mdl-addr-city')?.value    || '').trim();
    state   = (document.getElementById('mdl-addr-state')?.value   || 'GA').trim();
    zip     = (document.getElementById('mdl-addr-zip')?.value     || '').trim();
    const nameOverride = (document.getElementById('mdl-addr-company')?.value || '').trim();
    companyName   = nameOverride || [address, city].filter(Boolean).join(', ');
    note          = (document.getElementById('mdl-addr-note')?.value || '').trim();
    isAddressOnly = true;
  }

  document.getElementById('mdl-overlay-add-stop')?.remove();
  if (!mobileDailyLog) { showBanner('Daily log not loaded', 'error'); return; }
  const stopId = genId('s');
  const plannedOrder = (mobileDailyLog.stops || []).length + 1;
  const stop = { stopId, contactId, companyName, contactName, phone, address, city, state: state || '', zip, note: note || '', plannedOrder, optimizedOrder: null, status: 'planned', isUnplanned: !!isUnplanned, isNewLead: !!isNewLead, isAddressOnly: !!isAddressOnly };
  if (!mobileDailyLog.stops) mobileDailyLog.stops = [];
  mobileDailyLog.stops.push(stop);
  mobileDailyLog.updatedAt = new Date().toISOString();
  await mobileSaveDailyLog();
  renderMobileDlStops();
  renderMobileDlSummary();
  showBanner('Stop added', 'info');
}

async function mobileRemoveStop(stopId) {
  if (!mobileDailyLog) return;
  mobileDailyLog.stops = (mobileDailyLog.stops || []).filter(s => s.stopId !== stopId);
  mobileDailyLog.updatedAt = new Date().toISOString();
  await mobileSaveDailyLog();
  renderMobileDlStops();
  renderMobileDlSummary();
}

async function mobileMkSkipped(stopId) {
  if (!mobileDailyLog) return;
  const stop = (mobileDailyLog.stops || []).find(s => s.stopId === stopId);
  if (stop) stop.status = 'skipped';
  mobileDailyLog.updatedAt = new Date().toISOString();
  await mobileSaveDailyLog();
  renderMobileDlStops();
  renderMobileDlSummary();
}

// ── Visit logging ─────────────────────────────────────────────────────────────
function mobileOpenLogVisit(stopId) {
  if (!mobileDailyLog) return;
  const stop = (mobileDailyLog.stops || []).find(s => s.stopId === stopId);
  if (!stop) return;
  const overlay = document.createElement('div');
  overlay.id = 'mdl-overlay-log-visit';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9000;display:flex;align-items:flex-end';
  const now = new Date();
  const timeVal = now.toTimeString().slice(0, 5);
  const stopIdSafe = (stopId || '').replace(/'/g, "\\'");
  overlay.innerHTML = `
    <div style="background:var(--bg2);border-radius:16px 16px 0 0;padding:20px;width:100%;max-height:85vh;overflow-y:auto">
      <div style="font-size:17px;font-weight:700;color:var(--text);margin-bottom:4px">Log Visit</div>
      <div style="font-size:14px;color:var(--text2);margin-bottom:16px">${esc(stop.companyName || '')}</div>
      <input type="time" id="mdl-visit-time" value="${timeVal}" style="width:140px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:9px 10px;font-size:14px;margin-bottom:12px">
      <select id="mdl-visit-outcome" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:14px;margin-bottom:12px">
        <option value="">-- Outcome --</option>
        <option>Met in person</option>
        <option>Left card / brochure</option>
        <option>Demo presented</option>
        <option>Quote discussed</option>
        <option>Not interested</option>
        <option>No contact — left materials</option>
        <option>Follow-up scheduled</option>
        <option>Closed deal</option>
        <option>Other</option>
      </select>
      <textarea id="mdl-visit-notes" rows="3" placeholder="Notes..." style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:14px;resize:vertical;margin-bottom:12px"></textarea>
      <select id="mdl-visit-next" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:14px;margin-bottom:16px">
        <option value="">No follow-up needed</option>
        <option value="add-task">Add follow-up task</option>
        <option value="schedule-followup">Schedule follow-up visit</option>
      </select>
      <div style="display:flex;gap:8px">
        <button onclick="document.getElementById('mdl-overlay-log-visit').remove()" style="flex:1;background:var(--bg3);color:var(--text2);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:15px">Cancel</button>
        <button onclick="window.mobileSaveVisit('${stopIdSafe}')" style="flex:2;background:var(--green);color:#fff;border:none;border-radius:8px;padding:12px;font-size:15px;font-weight:600">Save Visit</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

async function mobileSaveVisit(stopId) {
  if (!mobileDailyLog) return;
  const stop = (mobileDailyLog.stops || []).find(s => s.stopId === stopId);
  if (!stop) return;
  const outcome    = (document.getElementById('mdl-visit-outcome')?.value || '').trim();
  const notes      = (document.getElementById('mdl-visit-notes')?.value   || '').trim();
  const nextAction = (document.getElementById('mdl-visit-next')?.value    || '');
  const visitTime  = (document.getElementById('mdl-visit-time')?.value    || '');
  if (!outcome) { showBanner('Select an outcome', 'warn'); return; }

  const now = new Date().toISOString();
  const visitId = genId('vl');
  const visitLog = {
    visitId, activityLogId: mobileDailyLog.id, contactId: stop.contactId,
    companyName: stop.companyName, contactName: stop.contactName, phone: stop.phone,
    address: stop.address, city: stop.city, zip: stop.zip,
    plannedOrder: stop.plannedOrder, optimizedOrder: stop.optimizedOrder,
    status: 'completed', outcome, notes, nextAction,
    visitDate: mobileDailyLog.date, visitTime, stopId,
    createdAt: now, isUnplanned: stop.isUnplanned, isNewLead: stop.isNewLead,
  };

  if (db) {
    try { await setDoc(doc(db, 'visitLogs', visitId), visitLog); mobileDlVisits.push(visitLog); } catch (e) {}
  }

  // Create task if needed
  if (nextAction === 'add-task' || nextAction === 'schedule-followup') {
    const taskId = genId('t');
    const task = {
      id: taskId, title: 'Follow up with ' + (stop.companyName || 'contact'),
      notes: notes ? 'Visit notes: ' + notes : '',
      dueDate: '', completed: false, completedAt: null,
      linkedType: 'lead', linkedId: stop.contactId, linkedName: stop.companyName,
      createdAt: now, updatedAt: now,
    };
    if (db) { try { await setDoc(doc(db, 'tasks', taskId), task); appData.tasks.push(task); } catch (e) {} }
  }

  stop.status = 'completed';
  mobileDailyLog.updatedAt = now;
  await mobileSaveDailyLog();
  document.getElementById('mdl-overlay-log-visit')?.remove();
  renderMobileDlStops();
  renderMobileDlSummary();
  showBanner('Visit logged!', 'info');
}

function mobileDlSwitchView(v) {
  mobileDlView = v;
  renderMobileDailyLog();
}

async function mobileDlDateChanged(val) {
  mobileDlDate = val;
  mobileDailyLog = null;
  mobileDlVisits = [];
  await renderMobileDlPlan();
}

// ── Fix 1: Route optimization ─────────────────────────────────────────────────
async function mobileOptimizeRoute() {
  if (!mobileDailyLog) return;
  const stops = (mobileDailyLog.stops || []).filter(s => s.status !== 'skipped');
  if (stops.length < 2) { showBanner('Need at least 2 stops to optimize', 'info'); return; }
  const apiKey = appData.mapsApiKey;
  const homeAddr = appData.settings?.homeAddress || '';
  const stopAddrs = stops.map(s => [s.address, s.city, s.state, s.zip].filter(Boolean).join(', '));
  showBanner('Optimizing route...', 'info');
  try {
    let optimized = false;
    if (apiKey && homeAddr) {
      optimized = await _mobileOptimizeDistMatrix(homeAddr, stops, stopAddrs, apiKey)
                  || await _mobileOptimizeGeocode(homeAddr, stops, stopAddrs, apiKey);
    }
    if (!optimized) {
      console.log('[DL] Optimize: keeping stops as entered (no API key or home address)');
      showBanner('Route kept as entered (set Home Address + Maps API key for auto-optimize)', 'info');
      return;
    }
    mobileDailyLog.optimized = true;
    mobileDailyLog.updatedAt = new Date().toISOString();
    await mobileSaveDailyLog();
    renderMobileDlStops();
    showBanner('Route optimized!', 'info');
  } catch (err) {
    console.error('[DL] mobileOptimizeRoute error:', err);
    showBanner('Route kept as entered', 'info');
  }
}

async function _mobileOptimizeDistMatrix(homeAddr, stops, stopAddrs, apiKey) {
  try {
    const allAddrs = [homeAddr, ...stopAddrs, homeAddr];
    const origins    = encodeURIComponent(allAddrs.slice(0, -1).join('|'));
    const dests      = encodeURIComponent(allAddrs.slice(1).join('|'));
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${dests}&key=${encodeURIComponent(apiKey)}&units=imperial`;
    const resp = await fetch(url);
    const data = await resp.json();
    console.log('[DL] DistMatrix status:', data.status, 'rows:', data.rows?.length);
    if (data.status !== 'OK') return false;
    const n = stops.length;
    const dist = Array.from({length: n + 1}, (_, i) =>
      Array.from({length: n + 1}, (_, j) => {
        const row = data.rows[i]; if (!row) return 99999;
        const el = row.elements[j]; if (!el || el.status !== 'OK') return 99999;
        return el.duration.value;
      })
    );
    // Nearest-neighbor from home (index 0)
    const visited = new Array(n).fill(false);
    const order = [];
    let cur = 0;
    for (let i = 0; i < n; i++) {
      let best = -1, bestDist = Infinity;
      for (let j = 0; j < n; j++) {
        if (!visited[j] && dist[cur][j + 1] < bestDist) { best = j; bestDist = dist[cur][j + 1]; }
      }
      visited[best] = true; order.push(best); cur = best + 1;
    }
    order.forEach((origIdx, newIdx) => { stops[origIdx].optimizedOrder = newIdx + 1; });
    return true;
  } catch (err) { console.error('[DL] _mobileOptimizeDistMatrix error:', err); return false; }
}

async function _mobileOptimizeGeocode(homeAddr, stops, stopAddrs, apiKey) {
  try {
    const geocode = async addr => {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${encodeURIComponent(apiKey)}`;
      const data = await (await fetch(url)).json();
      if (data.status !== 'OK') return null;
      const loc = data.results[0]?.geometry?.location;
      return loc ? { lat: loc.lat, lng: loc.lng } : null;
    };
    const haversine = (a, b) => {
      const R = 3958.8, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
      const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
    };
    const homeGeo = await geocode(homeAddr);
    if (!homeGeo) return false;
    const geos = await Promise.all(stopAddrs.map(a => geocode(a)));
    if (geos.some(g => !g)) return false;
    const n = stops.length;
    const visited = new Array(n).fill(false);
    const order = [];
    let cur = homeGeo;
    for (let i = 0; i < n; i++) {
      let best = -1, bestDist = Infinity;
      for (let j = 0; j < n; j++) {
        if (!visited[j]) { const d = haversine(cur, geos[j]); if (d < bestDist) { best = j; bestDist = d; } }
      }
      visited[best] = true; order.push(best); cur = geos[best];
    }
    order.forEach((origIdx, newIdx) => { stops[origIdx].optimizedOrder = newIdx + 1; });
    return true;
  } catch (err) { console.error('[DL] _mobileOptimizeGeocode error:', err); return false; }
}

function mobileOpenFullRoute() {
  if (!mobileDailyLog) return;
  const stops = (mobileDailyLog.stops || []).filter(s => s.status !== 'skipped');
  if (!stops.length) { showBanner('No stops to map', 'info'); return; }
  stops.sort((a, b) => {
    const ao = (mobileDailyLog.optimized && a.optimizedOrder != null) ? a.optimizedOrder : (a.plannedOrder || 999);
    const bo = (mobileDailyLog.optimized && b.optimizedOrder != null) ? b.optimizedOrder : (b.plannedOrder || 999);
    return ao - bo;
  });
  const addrs = stops.map(s => [s.address, s.city, s.state, s.zip].filter(Boolean).join(', ')).filter(Boolean);
  if (!addrs.length) { showBanner('No addresses on stops', 'info'); return; }
  const home = appData.settings?.homeAddress || '';
  const origin = home ? `&origin=${encodeURIComponent(home)}` : '';
  const waypoints = addrs.slice(0, -1).map(a => encodeURIComponent(a)).join('|');
  const dest = encodeURIComponent(addrs[addrs.length - 1]);
  const waypointParam = waypoints ? `&waypoints=${waypoints}` : '';
  const url = `https://www.google.com/maps/dir/?api=1${origin}&destination=${dest}${waypointParam}&travelmode=driving`;
  window.open(url, '_blank');
}

// ── Fix 2: Touch drag-to-reorder ──────────────────────────────────────────────
let _mobileDlDragSrc = null;

function _initMobileDlTouchDrag(container) {
  let dragEl = null, clone = null, offsetX = 0, offsetY = 0;

  container.querySelectorAll('.dl-drag-handle').forEach(handle => {
    handle.addEventListener('touchstart', e => {
      const card = handle.closest('[data-stop-id]');
      if (!card) return;
      dragEl = card;
      const touch = e.touches[0];
      const rect = card.getBoundingClientRect();
      offsetX = touch.clientX - rect.left;
      offsetY = touch.clientY - rect.top;
      clone = card.cloneNode(true);
      clone.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;opacity:.85;z-index:9999;pointer-events:none;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.3)`;
      document.body.appendChild(clone);
      card.style.opacity = '0.3';
      e.preventDefault();
    }, { passive: false });
  });

  container.addEventListener('touchmove', e => {
    if (!dragEl || !clone) return;
    const touch = e.touches[0];
    clone.style.top  = (touch.clientY - offsetY) + 'px';
    clone.style.left = (touch.clientX - offsetX) + 'px';
    container.querySelectorAll('.dl-drag-over').forEach(c => c.classList.remove('dl-drag-over'));
    const elBelow = document.elementFromPoint(touch.clientX, touch.clientY);
    const target = elBelow?.closest('[data-stop-id]');
    if (target && target !== dragEl) target.classList.add('dl-drag-over');
    e.preventDefault();
  }, { passive: false });

  container.addEventListener('touchend', async e => {
    if (!dragEl || !clone) return;
    clone.remove(); clone = null;
    dragEl.style.opacity = '';
    const touch = e.changedTouches[0];
    container.querySelectorAll('.dl-drag-over').forEach(c => c.classList.remove('dl-drag-over'));
    const elBelow = document.elementFromPoint(touch.clientX, touch.clientY);
    const target = elBelow?.closest('[data-stop-id]');
    if (target && target !== dragEl) {
      await _mobileReorderStop(dragEl.dataset.stopId, target.dataset.stopId);
    }
    dragEl = null;
  });
}

async function _mobileReorderStop(srcId, destId) {
  if (!mobileDailyLog || !srcId || !destId || srcId === destId) return;
  const stops = mobileDailyLog.stops || [];
  const srcIdx  = stops.findIndex(s => s.stopId === srcId);
  const destIdx = stops.findIndex(s => s.stopId === destId);
  if (srcIdx < 0 || destIdx < 0) return;
  const [moved] = stops.splice(srcIdx, 1);
  stops.splice(destIdx, 0, moved);
  stops.forEach((s, i) => { s.plannedOrder = i + 1; s.optimizedOrder = null; });
  mobileDailyLog.optimized = false;
  mobileDailyLog.updatedAt = new Date().toISOString();
  await mobileSaveDailyLog();
  renderMobileDlStops();
  renderMobileDlSummary();
}

// ── Fix 3: Autocomplete helpers ───────────────────────────────────────────────
function _mobileWireCompanyAutocomplete(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  let dropdown = null;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (dropdown) { dropdown.remove(); dropdown = null; }
    if (!q || q.length < 2) return;
    const leads = appData.leads || [];
    const matches = leads.filter(l => (l.companyName || '').toLowerCase().includes(q)).slice(0, 8);
    if (!matches.length) return;
    dropdown = document.createElement('div');
    dropdown.style.cssText = 'position:absolute;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.2);max-height:200px;overflow-y:auto;width:100%';
    const wrap = input.parentElement;
    const oldPos = wrap.style.position;
    wrap.style.position = 'relative';
    wrap.appendChild(dropdown);
    matches.forEach(l => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:10px 12px;font-size:14px;cursor:pointer;border-bottom:1px solid var(--border);color:var(--text)';
      item.textContent = l.companyName;
      item.addEventListener('click', () => {
        input.value = l.companyName;
        dropdown.remove(); dropdown = null;
      });
      dropdown.appendChild(item);
    });
    const cleanup = () => { if (dropdown) { dropdown.remove(); dropdown = null; } wrap.style.position = oldPos; };
    setTimeout(() => document.addEventListener('click', cleanup, { once: true }), 0);
  });
}

async function _mobileWireAddressAutocomplete(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const apiKey = appData.mapsApiKey;
  if (!apiKey) return;
  let dropdown = null, debTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debTimer);
    const q = input.value.trim();
    if (dropdown) { dropdown.remove(); dropdown = null; }
    if (q.length < 3) return;
    debTimer = setTimeout(async () => {
      try {
        const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(q)}&types=address&components=country:us&key=${encodeURIComponent(apiKey)}`;
        const data = await (await fetch(url)).json();
        if (!data.predictions?.length) return;
        if (dropdown) { dropdown.remove(); dropdown = null; }
        dropdown = document.createElement('div');
        dropdown.style.cssText = 'position:absolute;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.2);max-height:200px;overflow-y:auto;width:100%';
        const wrap = input.parentElement;
        const oldPos = wrap.style.position;
        wrap.style.position = 'relative';
        wrap.appendChild(dropdown);
        data.predictions.slice(0, 5).forEach(p => {
          const item = document.createElement('div');
          item.style.cssText = 'padding:10px 12px;font-size:14px;cursor:pointer;border-bottom:1px solid var(--border);color:var(--text)';
          item.textContent = p.description;
          item.addEventListener('click', () => {
            // Parse address into parts
            const parts = p.description.split(',').map(s => s.trim());
            input.value = parts[0] || p.description;
            // Try to fill city/state/zip sibling fields
            const container = input.closest('[id^="mdl-stop-section-"], [id^="mdl-"]')?.closest('.mdl-section-wrap') || input.parentElement?.parentElement;
            if (parts[1]) {
              const prefix = inputId.startsWith('mdl-new-') ? 'mdl-new-' : 'mdl-addr-';
              const cityEl  = document.getElementById(prefix + 'city');
              const stateEl = document.getElementById(prefix + 'state');
              const zipEl   = document.getElementById(prefix + 'zip');
              if (cityEl)  cityEl.value  = parts[1] || '';
              if (stateEl && parts[2]) stateEl.value = parts[2].replace(/\d+/g, '').trim() || 'GA';
              if (zipEl   && parts[2]) zipEl.value   = (parts[2].match(/\d{5}/) || [''])[0];
            }
            dropdown.remove(); dropdown = null;
          });
          dropdown.appendChild(item);
        });
        const cleanup = () => { if (dropdown) { dropdown.remove(); dropdown = null; } };
        setTimeout(() => document.addEventListener('click', cleanup, { once: true }), 0);
      } catch (err) { console.error('[DL] places autocomplete error:', err); }
    }, 300);
  });
}

// ── Fix 4: History with date range + richer detail ────────────────────────────
let _mobileHistSearch = '';
let _mobileHistFrom   = '';
let _mobileHistTo     = '';

async function renderMobileDlHistory() {
  const content = document.getElementById('mdl-content');
  if (!content) return;
  content.innerHTML = `
    <div style="padding:0 0 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input type="text" id="mdl-hist-search" placeholder="Search company..." value="${esc(_mobileHistSearch)}"
        oninput="window._mobileHistFilter()"
        style="flex:1;min-width:120px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:14px">
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding-bottom:10px">
      <span style="font-size:12px;color:var(--text2)">From:</span>
      <input type="date" id="mdl-hist-from" value="${esc(_mobileHistFrom)}" onchange="window._mobileHistFilter()"
        style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 8px;font-size:13px;flex:1;min-width:120px">
      <span style="font-size:12px;color:var(--text2)">To:</span>
      <input type="date" id="mdl-hist-to" value="${esc(_mobileHistTo)}" onchange="window._mobileHistFilter()"
        style="background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 8px;font-size:13px;flex:1;min-width:120px">
    </div>
    <div id="mdl-history-list"><div class="dl-empty">Loading history...</div></div>`;
  await _mobileLoadAndRenderHistory();
}

let _mobileHistoryLogs = [];

async function _mobileLoadAndRenderHistory() {
  const listEl = document.getElementById('mdl-history-list');
  if (!listEl) return;
  try {
    const q = query(collection(db, 'activityLogs'), orderBy('date', 'desc'));
    const snap = await getDocs(q);
    _mobileHistoryLogs = snap.docs.map(d => d.data());
    _mobileRenderHistoryList();
  } catch (e) {
    if (listEl) listEl.innerHTML = '<div class="dl-empty">Could not load history.</div>';
  }
}

function _mobileRenderHistoryList() {
  const listEl = document.getElementById('mdl-history-list');
  if (!listEl) return;
  _mobileHistSearch = document.getElementById('mdl-hist-search')?.value || _mobileHistSearch;
  _mobileHistFrom   = document.getElementById('mdl-hist-from')?.value   || '';
  _mobileHistTo     = document.getElementById('mdl-hist-to')?.value     || '';
  let logs = _mobileHistoryLogs;
  if (_mobileHistSearch) {
    const q = _mobileHistSearch.toLowerCase();
    logs = logs.filter(log => (log.stops || []).some(s => (s.companyName || '').toLowerCase().includes(q)));
  }
  if (_mobileHistFrom) logs = logs.filter(log => log.date >= _mobileHistFrom);
  if (_mobileHistTo)   logs = logs.filter(log => log.date <= _mobileHistTo);
  if (!logs.length) { listEl.innerHTML = '<div class="dl-empty">No history found.</div>'; return; }
  listEl.innerHTML = logs.map(log => {
    const stops = log.stops || [];
    const completed = stops.filter(s => s.status === 'completed').length;
    const newLeads  = stops.filter(s => s.isNewLead).length;
    return `<div class="dl-history-row" onclick="window.mobileDlExpandHistory('${esc(log.id)}')">
      <div class="dl-history-row-header">
        <div class="dl-history-date">${fmt(log.date)}</div>
        <div class="dl-history-stats">
          <span>${stops.length} stop${stops.length !== 1 ? 's' : ''}</span>
          <span style="color:var(--green)">${completed} done</span>
          ${newLeads > 0 ? `<span style="color:var(--green)">${newLeads} new</span>` : ''}
        </div>
        <span style="color:var(--text2);font-size:12px" id="mdl-hist-arrow-${esc(log.id)}">▶</span>
      </div>
      <div id="mdl-hist-detail-${esc(log.id)}" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
        <div class="dl-empty" style="font-size:12px">Loading visits...</div>
      </div>
    </div>`;
  }).join('');
}

window._mobileHistFilter = _mobileRenderHistoryList;

async function mobileDlExpandHistory(logId) {
  const detailEl = document.getElementById('mdl-hist-detail-' + logId);
  const arrowEl  = document.getElementById('mdl-hist-arrow-' + logId);
  if (!detailEl) return;
  const isOpen = detailEl.style.display !== 'none';
  detailEl.style.display = isOpen ? 'none' : 'block';
  if (arrowEl) arrowEl.textContent = isOpen ? '▶' : '▼';
  if (isOpen) return;
  // Load visit logs for this activity log
  try {
    const log = _mobileHistoryLogs.find(l => l.id === logId);
    const stops = log?.stops || [];
    let visits = [];
    try {
      const q = query(collection(db, 'visitLogs'), where('activityLogId', '==', logId));
      const snap = await getDocs(q);
      visits = snap.docs.map(d => d.data());
    } catch (e) {}
    detailEl.innerHTML = stops.length === 0
      ? '<div style="color:var(--text2);font-size:13px;padding:4px 0">No stops recorded.</div>'
      : stops.map(s => {
          const vis = visits.find(v => v.stopId === s.stopId);
          const statusCls = s.status === 'completed' ? 'completed' : s.status === 'skipped' ? 'skipped' : 'planned';
          const profileBtn = s.contactId
            ? `<button onclick="event.stopPropagation();openContactProfile('${esc(s.contactId)}')" style="background:var(--blue);color:#fff;border:none;border-radius:5px;padding:3px 8px;font-size:11px;margin-left:4px">Profile</button>`
            : '';
          return `<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px">
              <span class="dl-stop-status ${statusCls}" style="font-size:10px">${s.status}</span>
              <span style="font-weight:600">${esc(s.companyName || '')}</span>
              ${profileBtn}
            </div>
            ${vis?.visitTime ? `<div style="font-size:11px;color:var(--text2)">Time: ${esc(vis.visitTime)}</div>` : ''}
            ${vis?.outcome   ? `<div style="font-size:12px;color:var(--text)">${esc(vis.outcome)}</div>` : ''}
            ${vis?.notes     ? `<div style="font-size:12px;color:var(--text2);font-style:italic">${esc(vis.notes)}</div>` : ''}
            ${s.note         ? `<div style="font-size:12px;color:var(--text2)">${esc(s.note)}</div>` : ''}
          </div>`;
        }).join('');
  } catch (e) {
    detailEl.innerHTML = '<div style="color:var(--text2);font-size:13px">Could not load visit details.</div>';
  }
}

// Expose window functions for onclick handlers
function mobileStartQuoteFromStop(stopId) {
  const stop = (mobileDailyLog?.stops || []).find(s => s.stopId === stopId);
  if (!stop) return;
  if (stop.contactId) {
    openQuoteFormForLead(stop.contactId);
    return;
  }
  // No linked contact — try to find by company name, else navigate to quote tab
  const lead = (appData.leads || []).find(l => l.companyName === stop.companyName);
  if (lead) { openQuoteFormForLead(lead.id); return; }
  // Address-only or unmatched — open quote tab (user can pick company)
  switchTab('quote');
  setTimeout(() => renderQuoteForm(null, true), 50);
}

window.mobileDlSwitchView      = mobileDlSwitchView;
window.mobileDlDateChanged     = mobileDlDateChanged;
window.mobileOpenAddStop       = mobileOpenAddStop;
window.mobileDlSwitchStopType  = mobileDlSwitchStopType;
window.mobileDlConfirmAddStop  = mobileDlConfirmAddStop;
window.mobileRemoveStop        = mobileRemoveStop;
window.mobileMkSkipped         = mobileMkSkipped;
window.mobileOpenLogVisit      = mobileOpenLogVisit;
window.mobileSaveVisit         = mobileSaveVisit;
window.mobileDlExpandHistory   = mobileDlExpandHistory;
window.mobileOptimizeRoute     = mobileOptimizeRoute;
window.mobileOpenFullRoute     = mobileOpenFullRoute;
window.mobileStartQuoteFromStop = mobileStartQuoteFromStop;

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  // Register service worker — detect updates and reload automatically
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker?.addEventListener('statechange', () => {
          if (newWorker.statechange === 'installed' && navigator.serviceWorker.controller) {
            showBanner('App updated — reloading…', 'info');
            setTimeout(() => window.location.reload(), 1500);
          }
        });
      });
    }).catch(err => console.warn('[AFL] SW register failed:', err));
    // When a new SW takes control, reload to get fresh files
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
  }

  // Nav tab buttons
  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Sheet back button
  document.getElementById('sheet-back')?.addEventListener('click', closeSheet);

  // Refresh button
  document.getElementById('refresh-btn')?.addEventListener('click', () => loadData(false));

  setupConnectivity();
  setupInstallPrompt();
  setupPTR();

  await initFirebase();
  await loadData();
}

boot();
