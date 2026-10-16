// MCP tools for the AFL Sales Tracker connector (v1).
// Reads: everything. Writes: tasks, contact activity notes, visit logs. No deletes.
'use strict';

const { z } = require('zod');

const TZ = 'America/New_York';
const CACHE_MS = 60 * 1000;
const VISIT_OUTCOMES = [
  'Met in person', 'Left card / brochure', 'Demo presented', 'Quote discussed', 'Not interested',
  'No contact — left materials', 'Follow-up scheduled', 'Closed deal', 'Other',
];
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const genId = p => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const todayNY = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const norm = s => String(s ?? '').toLowerCase();
const digits = s => String(s ?? '').replace(/\D/g, '');
const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
const fail = msg => ({ content: [{ type: 'text', text: msg }], isError: true });
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));

function createStore(db) {
  const cache = new Map(); // name -> { at, rows }
  async function all(name) {
    const c = cache.get(name);
    if (c && Date.now() - c.at < CACHE_MS) return c.rows;
    const snap = await db.collection(name).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    cache.set(name, { at: Date.now(), rows });
    return rows;
  }
  const invalidate = name => cache.delete(name);
  return { all, invalidate, db };
}

// ── Shapers ───────────────────────────────────────────────────────────────────
const contactName = l => l.contactName || [l.firstName, l.lastName].filter(Boolean).join(' ');
const leadBrief = l => clean({
  id: l.id, company: l.companyName, contact: contactName(l), phone: l.phone, email: l.email,
  city: l.city, zip: l.zip, status: l.status, industry: l.industry, lastActivity: l.lastActivityDate,
});
function quoteValue(q) {
  if (q.askingPrice) return q.askingPrice;
  const items = (q.lineItems || []).filter(i => !i.isAlternative && i.linePrice);
  return items.length ? items.reduce((s, i) => s + i.linePrice * (i.quantity || 1), 0) : null;
}
function overdueDays(q, today) {
  const stage = q.stage || 'quoted';
  if (stage !== 'quoted' && stage !== 'followup') return null;
  const ref = q.followUpDate || (q.createdAt ? q.createdAt.slice(0, 10) : null) || q.dateOfQuote;
  if (!ref) return null;
  const diff = Math.floor((Date.parse(today + 'T00:00:00Z') - Date.parse(ref + 'T00:00:00Z')) / 86400000) - 14;
  return diff >= 0 ? diff : null;
}
const quoteBrief = (q, today) => clean({
  id: q.id, customer: q.customerName, contact: [q.firstName, q.lastName].filter(Boolean).join(' '),
  phone: q.customerPhone, email: q.customerEmail, quoted: q.dateOfQuote, stage: q.stage || 'quoted',
  followUpDate: q.followUpDate, followUpTouches: q.followUpTouches, overdueDays: overdueDays(q, today),
  value: quoteValue(q),
  units: (q.lineItems || []).map(i => clean({ oem: i.oem, model: i.forkliftModel, qty: i.quantity, condition: i.condition, price: i.linePrice, stage: i.lineStage, alternative: i.isAlternative || null })),
  lossReason: q.lossReason, lostTo: q.lostToCompetitor, notes: q.notes,
});
const saleBrief = s => clean({
  id: s.id, customer: s.customerName, sold: s.dateSold, model: s.forkliftModel, qty: s.quantity,
  condition: s.condition, price: s.salePrice, financing: s.financingType, delivery: s.deliveryDate,
  commissionPaid: s.commissionPaidOut, notes: s.notes,
});
const taskEntered = t => {
  let ms = t.createdAt ? Date.parse(t.createdAt) : NaN;
  if (isNaN(ms)) { const m = /^t_(\d{12,})_/.exec(t.id || ''); if (m) ms = Number(m[1]); }
  return isNaN(ms) ? undefined : new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
};
const taskBrief = t => clean({
  id: t.id, title: t.title, entered: taskEntered(t), due: t.dueDate, done: !!t.completedAt, completedAt: t.completedAt,
  linkedTo: t.linkedName, linkedId: t.linkedId, notes: t.notes,
});
const visitBrief = v => clean({
  id: v.visitId || v.id, date: v.visitDate, time: v.visitTime, company: v.companyName, contact: v.contactName,
  contactId: v.contactId, outcome: v.outcome, notes: v.notes, nextAction: v.nextAction,
});

function matchesQuery(obj, fields, q) {
  if (!q) return true;
  const hay = fields.map(f => norm(obj[f])).join(' ');
  const hayDigits = digits(fields.map(f => obj[f]).join(' '));
  return norm(q).split(/\s+/).filter(Boolean).every(tok =>
    hay.includes(tok) || (/^\d{4,}$/.test(digits(tok)) && hayDigits.includes(digits(tok))));
}
const LEAD_FIELDS = ['companyName','contactName','firstName','lastName','email','phone','city','zip','street','sc2FirstName','sc2LastName','sc2Email','sc2Phone','notes'];

function relatedToLead(lead, rows, idField) {
  const ids = new Set([lead.id, lead.linkedCustomerId].filter(Boolean));
  const co = norm(lead.companyName).trim();
  return rows.filter(r => ids.has(r[idField]) || (co && norm(r.customerName).trim() === co));
}

// ── Registration ──────────────────────────────────────────────────────────────
function registerTools(server, db) {
  const S = createStore(db);
  const RO = { readOnlyHint: true, openWorldHint: false };
  const WR = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  async function getLead(id) {
    const snap = await db.collection('leads').doc(id).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  server.registerTool('search_contacts', {
    title: 'Search contacts',
    description: 'Search Kyle\'s contacts/leads (companies and people) by name, company, phone, email, city or zip. Returns brief records with ids for get_contact.',
    inputSchema: {
      query: z.string().optional().describe('Words to match, e.g. "toyo tire" or "ronald"'),
      status: z.string().optional().describe('Filter by status, e.g. prospect, lead, customer, active_customer'),
      city: z.string().optional(), zip: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: RO,
  }, async ({ query, status, city, zip, limit = 25 }) => {
    const leads = await S.all('leads');
    const hits = leads.filter(l =>
      matchesQuery(l, LEAD_FIELDS, query) &&
      (!status || norm(l.status) === norm(status)) &&
      (!city || norm(l.city) === norm(city)) &&
      (!zip || String(l.zip || '').startsWith(zip)));
    return ok({ total: hits.length, contacts: hits.slice(0, limit).map(leadBrief) });
  });

  server.registerTool('get_contact', {
    title: 'Get contact details',
    description: 'Full record for one contact: details, recent activity notes, status history, and their quotes, sales, equipment (fleet), tasks and logged visits.',
    inputSchema: { contact_id: z.string() },
    annotations: RO,
  }, async ({ contact_id }) => {
    const lead = await getLead(contact_id);
    if (!lead) return fail(`No contact with id ${contact_id}. Use search_contacts first.`);
    const today = todayNY();
    const [quotes, sales, equipment, tasks, visits] = await Promise.all(
      ['quotes', 'sales', 'equipment', 'tasks', 'visitLogs'].map(n => S.all(n)));
    const { activityLog = [], statusHistory = [], ...rest } = lead;
    return ok({
      contact: clean(rest),
      recentActivity: activityLog.slice(-25),
      statusHistory: statusHistory.slice(-10),
      quotes: relatedToLead(lead, quotes, 'linkedCustomerId').map(q => quoteBrief(q, today)),
      sales: relatedToLead(lead, sales, 'linkedCustomerId').map(saleBrief),
      equipment: equipment.filter(e => e.leadId === lead.id).map(e => clean({ id: e.id, oem: e.oem, model: e.model, serial: e.serialNumber, purchased: e.dateOfPurchase, city: e.city, notes: e.notes })),
      tasks: tasks.filter(t => t.linkedId === lead.id).map(taskBrief),
      visits: visits.filter(v => v.contactId === lead.id).sort((a, b) => String(b.visitDate).localeCompare(String(a.visitDate))).map(visitBrief),
    });
  });

  server.registerTool('list_quotes', {
    title: 'List quotes',
    description: 'Quotes in the pipeline. stage: open (quoted + followup, default), quoted, followup, won, lost, or all. Includes follow-up dates, days overdue (14+ days past follow-up date), units and value.',
    inputSchema: {
      stage: z.enum(['open', 'quoted', 'followup', 'won', 'lost', 'all']).optional(),
      customer: z.string().optional().describe('Match customer/company name'),
      follow_up_due_by: DATE.optional().describe('Only quotes with a follow-up date on or before this date'),
      quoted_since: DATE.optional(), quoted_until: DATE.optional(),
      limit: z.number().int().min(1).max(300).optional(),
    },
    annotations: RO,
  }, async ({ stage = 'open', customer, follow_up_due_by, quoted_since, quoted_until, limit = 50 }) => {
    const today = todayNY();
    let rows = await S.all('quotes');
    rows = rows.filter(q => {
      const st = q.stage || 'quoted';
      if (stage === 'open' ? !(st === 'quoted' || st === 'followup') : stage !== 'all' && st !== stage) return false;
      if (customer && !matchesQuery(q, ['customerName', 'firstName', 'lastName'], customer)) return false;
      if (follow_up_due_by && !(q.followUpDate && q.followUpDate <= follow_up_due_by)) return false;
      if (quoted_since && !(q.dateOfQuote >= quoted_since)) return false;
      if (quoted_until && !(q.dateOfQuote <= quoted_until)) return false;
      return true;
    }).sort((a, b) => String(a.followUpDate || a.dateOfQuote || '').localeCompare(String(b.followUpDate || b.dateOfQuote || '')));
    const total = rows.reduce((s, q) => s + (quoteValue(q) || 0), 0);
    return ok({ count: rows.length, totalValue: total, quotes: rows.slice(0, limit).map(q => quoteBrief(q, today)) });
  });

  server.registerTool('whats_due', {
    title: 'What\'s due',
    description: 'Kyle\'s to-do radar: open quotes whose follow-up date falls within the window (or are overdue), plus open tasks due in the window or overdue. Default window is the next 7 days.',
    inputSchema: { days_ahead: z.number().int().min(0).max(90).optional() },
    annotations: RO,
  }, async ({ days_ahead = 7 }) => {
    const today = todayNY(), until = addDays(today, days_ahead);
    const [quotes, tasks] = await Promise.all([S.all('quotes'), S.all('tasks')]);
    const qDue = quotes.filter(q => {
      const st = q.stage || 'quoted';
      return (st === 'quoted' || st === 'followup') && ((q.followUpDate && q.followUpDate <= until) || overdueDays(q, today) !== null);
    }).sort((a, b) => String(a.followUpDate || '').localeCompare(String(b.followUpDate || '')));
    const tDue = tasks.filter(t => !t.completedAt && t.dueDate && t.dueDate <= until)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const undated = tasks.filter(t => !t.completedAt && !t.dueDate).length;
    return ok({
      today, through: until,
      quoteFollowUps: qDue.map(q => quoteBrief(q, today)),
      tasks: tDue.map(t => ({ ...taskBrief(t), overdue: t.dueDate < today || undefined })),
      openTasksWithNoDueDate: undated,
    });
  });

  server.registerTool('list_tasks', {
    title: 'List tasks',
    description: 'Tasks from the tracker. status: open (default), completed, or all.',
    inputSchema: {
      status: z.enum(['open', 'completed', 'all']).optional(),
      due_by: DATE.optional(), contact_id: z.string().optional(),
      limit: z.number().int().min(1).max(300).optional(),
    },
    annotations: RO,
  }, async ({ status = 'open', due_by, contact_id, limit = 100 }) => {
    let rows = await S.all('tasks');
    rows = rows.filter(t =>
      (status === 'all' || (status === 'open' ? !t.completedAt : !!t.completedAt)) &&
      (!due_by || (t.dueDate && t.dueDate <= due_by)) &&
      (!contact_id || t.linkedId === contact_id))
      .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
    return ok({ count: rows.length, tasks: rows.slice(0, limit).map(taskBrief) });
  });

  server.registerTool('list_sales', {
    title: 'List sales',
    description: 'Closed sales with price, financing, delivery and commission status. Includes totals for the filtered range.',
    inputSchema: {
      since: DATE.optional(), until: DATE.optional(), customer: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: RO,
  }, async ({ since, until, customer, limit = 100 }) => {
    let rows = await S.all('sales');
    rows = rows.filter(s =>
      (!since || s.dateSold >= since) && (!until || s.dateSold <= until) &&
      (!customer || matchesQuery(s, ['customerName', 'firstName', 'lastName'], customer)))
      .sort((a, b) => String(b.dateSold || '').localeCompare(String(a.dateSold || '')));
    return ok({
      count: rows.length,
      units: rows.reduce((s, r) => s + (r.quantity || 1), 0),
      revenue: rows.reduce((s, r) => s + (r.salePrice || 0), 0),
      sales: rows.slice(0, limit).map(saleBrief),
    });
  });

  server.registerTool('list_visits', {
    title: 'List visits',
    description: 'Logged drop-in / field visits with outcome and notes.',
    inputSchema: {
      since: DATE.optional(), until: DATE.optional(),
      contact_id: z.string().optional(), company: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: RO,
  }, async ({ since, until, contact_id, company, limit = 100 }) => {
    let rows = await S.all('visitLogs');
    rows = rows.filter(v =>
      (!since || v.visitDate >= since) && (!until || v.visitDate <= until) &&
      (!contact_id || v.contactId === contact_id) &&
      (!company || matchesQuery(v, ['companyName', 'contactName'], company)))
      .sort((a, b) => `${b.visitDate} ${b.visitTime || ''}`.localeCompare(`${a.visitDate} ${a.visitTime || ''}`));
    return ok({ count: rows.length, visits: rows.slice(0, limit).map(visitBrief) });
  });

  server.registerTool('search_equipment', {
    title: 'Search equipment',
    description: 'Search customer fleet equipment (installed units) by model, serial, company, city or OEM.',
    inputSchema: { query: z.string().optional(), contact_id: z.string().optional(), limit: z.number().int().min(1).max(300).optional() },
    annotations: RO,
  }, async ({ query, contact_id, limit = 50 }) => {
    let rows = await S.all('equipment');
    rows = rows.filter(e => (!contact_id || e.leadId === contact_id) &&
      matchesQuery(e, ['companyName', 'model', 'serialNumber', 'oem', 'city', 'zip', 'notes'], query));
    return ok({ count: rows.length, equipment: rows.slice(0, limit).map(e => clean({ id: e.id, contactId: e.leadId, company: e.companyName, oem: e.oem, model: e.model, serial: e.serialNumber, purchased: e.dateOfPurchase, city: e.city, zip: e.zip, notes: e.notes })) });
  });

  server.registerTool('pipeline_summary', {
    title: 'Pipeline summary',
    description: 'Snapshot of the business: open pipeline by stage with value, overdue follow-ups, won/lost this year, sales this month and year, contacts by status, open tasks.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    const today = todayNY(), year = today.slice(0, 4), month = today.slice(0, 7);
    const [quotes, sales, leads, tasks] = await Promise.all(['quotes', 'sales', 'leads', 'tasks'].map(n => S.all(n)));
    const byStage = {};
    for (const q of quotes) {
      const st = q.stage || 'quoted';
      byStage[st] ??= { count: 0, value: 0 };
      byStage[st].count++; byStage[st].value += quoteValue(q) || 0;
    }
    const ytd = s => String(s || '').startsWith(year);
    const salesYTD = sales.filter(s => ytd(s.dateSold));
    const salesMTD = sales.filter(s => String(s.dateSold || '').startsWith(month));
    const statusCounts = {};
    for (const l of leads) statusCounts[l.status || 'none'] = (statusCounts[l.status || 'none'] || 0) + 1;
    return ok({
      today,
      quotesByStage: byStage,
      overdueFollowUps: quotes.filter(q => overdueDays(q, today) !== null).length,
      quotesThisYear: quotes.filter(q => ytd(q.dateOfQuote)).length,
      wonThisYear: quotes.filter(q => q.stage === 'won' && ytd(q.wonAt || q.dateOfQuote)).length,
      lostThisYear: quotes.filter(q => q.stage === 'lost' && ytd(q.lostAt || q.dateOfQuote)).length,
      salesThisMonth: { count: salesMTD.length, revenue: salesMTD.reduce((s, r) => s + (r.salePrice || 0), 0) },
      salesThisYear: { count: salesYTD.length, units: salesYTD.reduce((s, r) => s + (r.quantity || 1), 0), revenue: salesYTD.reduce((s, r) => s + (r.salePrice || 0), 0) },
      contactsByStatus: statusCounts,
      totalContacts: leads.length,
      openTasks: tasks.filter(t => !t.completedAt).length,
    });
  });

  // ── Writes ──────────────────────────────────────────────────────────────────
  server.registerTool('create_task', {
    title: 'Create task',
    description: 'Add a task to Kyle\'s tracker (shows in the Tasks tab on desktop and mobile). Optionally link it to a contact.',
    inputSchema: {
      title: z.string().min(1).max(200),
      due_date: DATE.optional(),
      notes: z.string().max(4000).optional(),
      contact_id: z.string().optional().describe('Link to a contact from search_contacts'),
    },
    annotations: WR,
  }, async ({ title, due_date, notes, contact_id }) => {
    let lead = null;
    if (contact_id) { lead = await getLead(contact_id); if (!lead) return fail(`No contact with id ${contact_id}.`); }
    const now = new Date().toISOString();
    const task = {
      id: genId('t'), title, dueDate: due_date || null,
      linkedType: lead ? 'lead' : null, linkedId: lead ? lead.id : null, linkedName: lead ? (lead.companyName || contactName(lead)) : null,
      assignedTo: null, notes: notes || null, completed: false, completedAt: null,
      createdAt: now, updatedAt: now, source: 'claude',
    };
    await db.collection('tasks').doc(task.id).set(task);
    S.invalidate('tasks');
    return ok({ created: taskBrief(task) });
  });

  server.registerTool('complete_task', {
    title: 'Complete task',
    description: 'Mark an open task as done.',
    inputSchema: { task_id: z.string() },
    annotations: { ...WR, idempotentHint: true },
  }, async ({ task_id }) => {
    const ref = db.collection('tasks').doc(task_id);
    const snap = await ref.get();
    if (!snap.exists) return fail(`No task with id ${task_id}.`);
    const t = snap.data();
    if (t.completedAt) return ok({ alreadyDone: taskBrief({ id: task_id, ...t }) });
    const now = new Date().toISOString();
    const updated = { ...t, id: t.id || task_id, completed: true, completedAt: now, updatedAt: now };
    await ref.set(updated);
    S.invalidate('tasks');
    return ok({ completed: taskBrief({ id: task_id, ...updated }) });
  });

  server.registerTool('log_contact_activity', {
    title: 'Log contact activity',
    description: 'Add a note to a contact\'s activity history (call, email, note, meeting). For an in-person drop-in visit use log_visit instead.',
    inputSchema: {
      contact_id: z.string(),
      note: z.string().min(1).max(4000),
      type: z.enum(['note', 'call', 'email', 'meeting']).optional(),
    },
    annotations: WR,
  }, async ({ contact_id, note, type = 'note' }) => {
    const lead = await getLead(contact_id);
    if (!lead) return fail(`No contact with id ${contact_id}.`);
    const now = new Date().toISOString();
    const entry = { date: now, type, note, source: 'claude' };
    const data = { ...lead };   // keeps the id field the desktop app relies on
    data.activityLog = [...(data.activityLog || []), entry];
    data.lastActivityDate = todayNY();
    data.updatedAt = now;
    await db.collection('leads').doc(lead.id).set(data);
    S.invalidate('leads');
    return ok({ logged: entry, contact: leadBrief(lead) });
  });

  server.registerTool('log_visit', {
    title: 'Log visit',
    description: 'Log an in-person visit to a contact: adds it to that day\'s Daily Log as a completed stop, records the visit, notes it on the contact, and optionally creates a follow-up task.',
    inputSchema: {
      contact_id: z.string(),
      outcome: z.enum(VISIT_OUTCOMES),
      notes: z.string().max(4000).optional(),
      visit_date: DATE.optional().describe('Defaults to today'),
      visit_time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('24h HH:MM'),
      follow_up_due: DATE.optional().describe('If set, also create a follow-up task due this date'),
    },
    annotations: WR,
  }, async ({ contact_id, outcome, notes = '', visit_date, visit_time = '', follow_up_due }) => {
    const lead = await getLead(contact_id);
    if (!lead) return fail(`No contact with id ${contact_id}.`);
    const date = visit_date || todayNY();
    const now = new Date().toISOString();

    // Day's activity log (create if missing)
    const q = await db.collection('activityLogs').where('date', '==', date).limit(1).get();
    let log;
    if (!q.empty) log = { ...q.docs[0].data(), id: q.docs[0].data().id || q.docs[0].id };
    else log = { id: genId('al'), date, stops: [], optimized: false, createdAt: now, updatedAt: now };
    log.stops = log.stops || [];

    let stop = log.stops.find(s => s.contactId === lead.id);
    if (!stop) {
      stop = {
        stopId: genId('s'), contactId: lead.id, companyName: lead.companyName || '', contactName: contactName(lead),
        phone: lead.phone || '', address: lead.street || '', city: lead.city || '', state: lead.state || '', zip: lead.zip || '',
        note: '', plannedOrder: log.stops.length + 1, optimizedOrder: null,
        status: 'planned', isUnplanned: true, isNewLead: false, isAddressOnly: false,
      };
      log.stops.push(stop);
    }
    stop.status = 'completed';
    log.updatedAt = now;
    await db.collection('activityLogs').doc(log.id).set(log);

    const visit = {
      visitId: genId('vl'), activityLogId: log.id,
      contactId: lead.id, companyName: stop.companyName, contactName: stop.contactName,
      phone: stop.phone, email: lead.email || '', address: stop.address, city: stop.city, zip: stop.zip,
      plannedOrder: stop.plannedOrder, optimizedOrder: stop.optimizedOrder ?? null,
      status: 'completed', outcome, notes, nextAction: follow_up_due ? 'add-task' : '',
      visitDate: date, visitTime: visit_time, stopId: stop.stopId,
      createdAt: now, isUnplanned: !!stop.isUnplanned, isNewLead: false, source: 'claude',
    };
    await db.collection('visitLogs').doc(visit.visitId).set(visit);
    S.invalidate('visitLogs');

    const data = { ...lead };
    data.activityLog = [...(data.activityLog || []), { date: now, type: 'visit', note: `Visit on ${date} — ${outcome}${notes ? ': ' + notes : ''}`, source: 'claude' }];
    data.lastActivityDate = date > (data.lastActivityDate || '') ? date : data.lastActivityDate;
    data.updatedAt = now;
    await db.collection('leads').doc(lead.id).set(data);
    S.invalidate('leads');

    let task = null;
    if (follow_up_due) {
      task = {
        id: genId('t'), title: `Follow up with ${lead.companyName || 'contact'}`, dueDate: follow_up_due,
        linkedType: 'lead', linkedId: lead.id, linkedName: lead.companyName || contactName(lead),
        assignedTo: null, notes: notes ? `Visit notes: ${notes}` : null, completed: false, completedAt: null,
        createdAt: now, updatedAt: now, source: 'claude',
      };
      await db.collection('tasks').doc(task.id).set(task);
      S.invalidate('tasks');
    }
    return ok({ logged: visitBrief(visit), followUpTask: task ? taskBrief(task) : undefined });
  });
}

module.exports = { registerTools, todayNY, VISIT_OUTCOMES };
