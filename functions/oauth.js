// OAuth 2.1 authorization server for the AFL Sales Tracker connector.
// Only one person can ever get a token: the Firebase account in ALLOWED_EMAIL,
// proven by its Firebase password on our own sign-in page.
'use strict';

const crypto = require('crypto');

const BASE          = 'https://afl-sales-tracker-52890.web.app';
const RESOURCE      = BASE + '/mcp';
const ALLOWED_EMAIL = 'kwaite@atlantaforklifts.com';
// Public Firebase web key (same one the desktop and mobile apps ship with).
const WEB_API_KEY   = 'AIzaSyBThsQNL7lkh14gH_pwdZR04UqoglNpi14';

const CODE_TTL_MS    = 5 * 60 * 1000;            // 5 minutes
const ACCESS_TTL_S   = 60 * 60;                  // 1 hour
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

const HOSTED_CALLBACKS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

const sha256  = s => crypto.createHash('sha256').update(s).digest();
const b64url  = buf => Buffer.from(buf).toString('base64url');
const hashKey = s => sha256(s).toString('hex');
const randTok = () => b64url(crypto.randomBytes(32));

function isAllowedRedirect(uri) {
  if (typeof uri !== 'string') return false;
  if (HOSTED_CALLBACKS.has(uri)) return true;
  // Claude Code: loopback redirect on any port (RFC 8252).
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      && u.pathname === '/callback' && !u.search && !u.hash;
  } catch { return false; }
}

// Client IDs are stateless: they encode the (already-allowlisted) redirect URIs.
function makeClientId(redirectUris) {
  return 'afl_' + b64url(JSON.stringify(redirectUris));
}
function readClientId(clientId) {
  if (typeof clientId !== 'string' || !clientId.startsWith('afl_')) return null;
  try {
    const uris = JSON.parse(Buffer.from(clientId.slice(4), 'base64url').toString('utf8'));
    if (!Array.isArray(uris) || !uris.length || !uris.every(isAllowedRedirect)) return null;
    return uris;
  } catch { return null; }
}
function redirectMatches(clientUris, uri) {
  if (!isAllowedRedirect(uri)) return false;
  if (clientUris.includes(uri)) return true;
  // Loopback: ignore the port when comparing.
  const strip = s => { try { const u = new URL(s); u.port = ''; return u.toString(); } catch { return s; } };
  return clientUris.some(c => strip(c) === strip(uri) && /^http:\/\/(localhost|127\.0\.0\.1)/.test(c));
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function protectedResourceMetadata() {
  return {
    resource: RESOURCE,
    authorization_servers: [BASE],
    scopes_supported: ['tracker'],
    bearer_methods_supported: ['header'],
    resource_name: 'AFL Sales Tracker',
  };
}
function authServerMetadata() {
  return {
    issuer: BASE,
    authorization_endpoint: BASE + '/oauth/authorize',
    token_endpoint: BASE + '/oauth/token',
    registration_endpoint: BASE + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['tracker'],
  };
}

function signInPage(p, error) {
  let host = '';
  try { host = new URL(p.redirect_uri).host; } catch {}
  const hidden = ['response_type','client_id','redirect_uri','state','code_challenge','code_challenge_method','scope','resource']
    .map(k => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect AFL Sales Tracker</title>
<style>
body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f4;color:#222;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;max-width:380px;width:calc(100% - 32px);padding:28px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 6px}p{font-size:14px;color:#555;line-height:1.45;margin:0 0 18px}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}
input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:11px;border:1px solid #ccc;border-radius:8px;font-size:15px}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;background:#c8102e;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{background:#fde8e8;color:#9b1c1c;padding:10px;border-radius:8px;font-size:13px;margin-bottom:8px}
.host{font-weight:600;color:#222}
</style></head><body><form class="card" method="post" action="/oauth/authorize">
<h1>Connect AFL Sales Tracker</h1>
<p><span class="host">${esc(host)}</span> is asking to read your tracker and log tasks and visits. Sign in with your tracker account to allow it.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
${hidden}
<label for="e">Email</label><input id="e" type="email" name="email" value="${esc(p.email || ALLOWED_EMAIL)}" autocomplete="username" required>
<label for="pw">Password</label><input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
<button type="submit">Allow access</button>
</form></body></html>`;
}

function errorPage(msg) {
  return `<!doctype html><meta charset="utf-8"><title>Connection error</title>
<body style="font-family:sans-serif;padding:40px;max-width:480px;margin:auto"><h2>Can't connect</h2><p>${esc(msg)}</p></body>`;
}

function createOAuth({ db, fetchFn = fetch, now = () => Date.now() }) {
  const codes  = () => db.collection('mcpCodes');
  const tokens = () => db.collection('mcpTokens');
  const accessCache = new Map(); // hash -> exp ms
  const failures = [];           // timestamps of failed sign-ins (per instance)

  function validateAuthParams(p) {
    if (p.response_type !== 'code') return 'Unsupported response_type.';
    const uris = readClientId(p.client_id);
    if (!uris) return 'Unknown client. Remove and re-add the connector.';
    if (!redirectMatches(uris, p.redirect_uri)) return 'Redirect address not allowed.';
    if (!p.code_challenge || p.code_challenge_method !== 'S256') return 'PKCE (S256) is required.';
    return null;
  }

  async function issueTokens(clientId, email) {
    const access = randTok(), refresh = randTok();
    const t = now();
    const aHash = hashKey(access), rHash = hashKey(refresh);
    await tokens().doc(aHash).set({ type: 'access', clientId, email, exp: t + ACCESS_TTL_S * 1000, createdAt: t });
    await tokens().doc(rHash).set({ type: 'refresh', clientId, email, exp: t + REFRESH_TTL_MS, accessHash: aHash, createdAt: t });
    accessCache.set(aHash, t + ACCESS_TTL_S * 1000);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'tracker' };
  }

  async function verifyPassword(email, password) {
    const r = await fetchFn(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: BASE + '/' },
      body: JSON.stringify({ email, password, returnSecureToken: false }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && String(j.email || '').toLowerCase() === ALLOWED_EMAIL) return { ok: true };
    const code = j?.error?.message || '';
    if (code.startsWith('TOO_MANY_ATTEMPTS')) return { ok: false, msg: 'Too many attempts. Wait a few minutes and try again.' };
    return { ok: false, msg: 'Email or password is incorrect.' };
  }

  // Returns true if handled.
  async function handle(req, res) {
    const path = req.path.replace(/\/+$/, '') || '/';
    const noStore = () => res.set('Cache-Control', 'no-store');

    if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      noStore(); res.json(protectedResourceMetadata()); return true;
    }
    if (req.method === 'GET' && (path.startsWith('/.well-known/oauth-authorization-server') || path.startsWith('/.well-known/openid-configuration'))) {
      noStore(); res.json(authServerMetadata()); return true;
    }

    if (path === '/oauth/register' && req.method === 'POST') {
      noStore();
      const body = req.body || {};
      const uris = body.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || !uris.every(isAllowedRedirect)) {
        res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'Only Claude callback URLs are accepted.' });
        return true;
      }
      res.status(201).json({
        client_id: makeClientId(uris),
        client_id_issued_at: Math.floor(now() / 1000),
        redirect_uris: uris,
        client_name: body.client_name || 'Claude',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
      return true;
    }

    if (path === '/oauth/authorize') {
      res.set('X-Frame-Options', 'DENY');
      noStore();
      const p = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      const bad = validateAuthParams(p);
      // form-action also governs the redirect after submit, so it must allow the (allowlisted) callback origin.
      let cbOrigin = '';
      try { cbOrigin = new URL(p.redirect_uri).origin; } catch {}
      res.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${bad || !cbOrigin ? '' : ' ' + cbOrigin}; frame-ancestors 'none'`);
      if (bad) { res.status(400).type('html').send(errorPage(bad)); return true; }

      if (req.method === 'GET') { res.type('html').send(signInPage(p)); return true; }
      if (req.method !== 'POST') { res.status(405).end(); return true; }

      const t = now();
      while (failures.length && failures[0] < t - 15 * 60 * 1000) failures.shift();
      if (failures.length >= 8) { res.status(429).type('html').send(signInPage(p, 'Too many attempts. Wait 15 minutes and try again.')); return true; }

      const email = String(p.email || '').trim().toLowerCase();
      if (email !== ALLOWED_EMAIL) {
        failures.push(t);
        res.status(403).type('html').send(signInPage(p, 'This tracker only allows its owner to connect.')); return true;
      }
      const v = await verifyPassword(email, String(p.password || ''));
      if (!v.ok) { failures.push(t); res.status(401).type('html').send(signInPage(p, v.msg)); return true; }

      const code = randTok();
      await codes().doc(hashKey(code)).set({
        clientId: p.client_id, redirectUri: p.redirect_uri, codeChallenge: p.code_challenge,
        email, exp: t + CODE_TTL_MS,
      });
      const u = new URL(p.redirect_uri);
      u.searchParams.set('code', code);
      if (p.state) u.searchParams.set('state', p.state);
      u.searchParams.set('iss', BASE);
      res.redirect(302, u.toString());
      return true;
    }

    if (path === '/oauth/token' && req.method === 'POST') {
      noStore();
      const b = req.body || {};
      const fail = (desc, status = 400, error = 'invalid_grant') => { res.status(status).json({ error, error_description: desc }); return true; };

      if (b.grant_type === 'authorization_code') {
        if (!b.code || !b.code_verifier) return fail('Missing code or code_verifier', 400, 'invalid_request');
        const ref = codes().doc(hashKey(String(b.code)));
        const snap = await ref.get();
        if (!snap.exists) return fail('Code not found or already used');
        const c = snap.data();
        await ref.delete();
        if (c.exp < now()) return fail('Code expired');
        if (b.client_id && b.client_id !== c.clientId) return fail('Client mismatch');
        if (b.redirect_uri && b.redirect_uri !== c.redirectUri) return fail('Redirect mismatch');
        if (b64url(sha256(String(b.code_verifier))) !== c.codeChallenge) return fail('PKCE check failed');
        res.json(await issueTokens(c.clientId, c.email));
        return true;
      }

      if (b.grant_type === 'refresh_token') {
        if (!b.refresh_token) return fail('Missing refresh_token', 400, 'invalid_request');
        const ref = tokens().doc(hashKey(String(b.refresh_token)));
        const snap = await ref.get();
        if (!snap.exists || snap.data().type !== 'refresh') return fail('Refresh token not recognised');
        const r = snap.data();
        await ref.delete(); // rotate
        if (r.accessHash) { await tokens().doc(r.accessHash).delete().catch(() => {}); accessCache.delete(r.accessHash); }
        if (r.exp < now()) return fail('Refresh token expired');
        if (b.client_id && b.client_id !== r.clientId) return fail('Client mismatch');
        if (r.email !== ALLOWED_EMAIL) return fail('Account not allowed');
        res.json(await issueTokens(r.clientId, r.email));
        return true;
      }
      return fail('Unsupported grant_type', 400, 'unsupported_grant_type');
    }

    return false;
  }

  // Returns true if the request carries a valid access token.
  async function checkBearer(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!m) return false;
    const h = hashKey(m[1].trim());
    const cached = accessCache.get(h);
    if (cached && cached > now()) return true;
    const snap = await tokens().doc(h).get();
    if (!snap.exists) return false;
    const d = snap.data();
    if (d.type !== 'access' || d.exp < now() || d.email !== ALLOWED_EMAIL) return false;
    accessCache.set(h, d.exp);
    return true;
  }

  function sendUnauthorized(res, hadToken) {
    res.set('Cache-Control', 'no-store');
    res.set('WWW-Authenticate',
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource", scope="tracker"` + (hadToken ? ', error="invalid_token"' : ''));
    res.status(401).json({ error: 'unauthorized' });
  }

  return { handle, checkBearer, sendUnauthorized };
}

module.exports = { createOAuth, BASE, RESOURCE, ALLOWED_EMAIL, isAllowedRedirect, readClientId, makeClientId };
