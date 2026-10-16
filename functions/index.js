'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { createHandler } = require('./app');

initializeApp();
const handler = createHandler({ db: getFirestore() });

// Served at https://afl-sales-tracker-52890.web.app/mcp via the Hosting rewrites in firebase.json.
exports.mcp = onRequest({
  region: 'us-central1',
  memory: '256MiB',
  timeoutSeconds: 60,
  maxInstances: 3,
  invoker: 'public', // reachable from Claude; every data route still requires Kyle's OAuth token
}, handler);
