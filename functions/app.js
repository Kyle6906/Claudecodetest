'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createOAuth } = require('./oauth');
const { registerTools } = require('./tools');

const INSTRUCTIONS = `This is Kyle Waite's AFL Sales Tracker (Atlanta Fork Lifts, Toyota Material Handling sales, NW Metro Atlanta).
Contacts are "leads"; quotes move through stages quoted → followup → won/lost; a follow-up is overdue 14+ days past its follow-up date.
Lease maturities come from the TICF report: "FMV lease" alerts 120 days out, "Dollar Out" ($1 buyout) 30 days out; use list_leases.
Find ids with search_contacts before using get_contact or any write tool. Dates are YYYY-MM-DD in Eastern time.
Writes are limited to tasks, contact activity notes, visit logs, and quote follow-ups/snoozes/outcomes; nothing can be deleted.`;

function createHandler({ db, fetchFn }) {
  const oauth = createOAuth({ db, fetchFn });

  return async function handler(req, res) {
    try {
      if (await oauth.handle(req, res)) return;

      const path = req.path.replace(/\/+$/, '') || '/';
      if (path !== '/mcp') { res.status(404).json({ error: 'not_found' }); return; }

      const hasAuth = !!req.get('authorization');
      if (!(await oauth.checkBearer(req))) { oauth.sendUnauthorized(res, hasAuth); return; }

      if (req.method !== 'POST') {
        res.set('Allow', 'POST');
        res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
        return;
      }

      // Stateless: a fresh server + transport per request.
      const server = new McpServer({ name: 'afl-sales-tracker', version: '1.0.0' }, { instructions: INSTRUCTIONS });
      registerTools(server, db);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[connector] error', err);
      if (!res.headersSent) res.status(500).json({ error: 'server_error' });
    }
  };
}

module.exports = { createHandler };
