// Firebase v10 modular SDK — loaded from CDN, initialised in renderer process.
// Exposes window.db and window._fs so the non-module inline script can use Firestore.
//
// ── Firebase Console setup required ────────────────────────────────────────────
//
// 1. Enable Email/Password sign-in and add your user (see "Sign-in" below).
// 2. Security rules live in firestore.rules / storage.rules in this repo and are
//    deployed with:  firebase deploy --only firestore:rules,storage
//
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js';
import {
  initializeFirestore,
  memoryLocalCache,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  writeBatch,
  query,
  where,
  orderBy,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js';
import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-storage.js';

const _cfg = {
  apiKey:            'AIzaSyBThsQNL7lkh14gH_pwdZR04UqoglNpi14',
  authDomain:        'afl-sales-tracker-52890.firebaseapp.com',
  projectId:         'afl-sales-tracker-52890',
  storageBucket:     'afl-sales-tracker-52890.firebasestorage.app',
  messagingSenderId: '405184881454',
  appId:             '1:405184881454:web:f78a961296b3f8677190bf',
};

const _app  = initializeApp(_cfg);

// memoryLocalCache avoids IndexedDB entirely — no quota_database errors.
// Reads from Firestore network on every startup; writes go directly to Firestore.
const _db   = initializeFirestore(_app, { localCache: memoryLocalCache() });
const _auth = getAuth(_app);

const _storage = getStorage(_app);

window.db      = _db;
window.storage = _storage;
window._fs  = { collection, doc, getDocs, getDoc, setDoc, deleteDoc, writeBatch, query, where, orderBy, onSnapshot };
window._fss = { ref: storageRef, uploadBytesResumable, getDownloadURL, deleteObject };

console.log('[Firebase] SDK loaded — project:', _cfg.projectId);

// ── Sign-in (email + password, locked to one account) ──────────────────────────
// Anonymous sign-in was removed: it let ANYONE with this public config read and
// write the database. Firestore/Storage rules now only allow ALLOWED_EMAIL.
//
// Firebase Console setup required (one time):
//   1. Authentication → Sign-in method → Email/Password → Enable
//   2. Authentication → Users → Add user → kwaite@atlantaforklifts.com + password
// Sign-in is remembered on this computer, so you only enter it once.
const ALLOWED_EMAIL = 'kwaite@atlantaforklifts.com';
let _readyResolved = false;

function _resolveFirebaseReady() {
  if (_readyResolved) return;
  _readyResolved = true;
  if (typeof window._firebaseReadyResolve === 'function') window._firebaseReadyResolve();
}

onAuthStateChanged(_auth, function(user) {
  if (user && !user.isAnonymous && (user.email || '').toLowerCase() === ALLOWED_EMAIL) {
    console.log('[Firebase] Signed in as', user.email);
    _hideSignIn();
    _setFbStatus(true);
    _resolveFirebaseReady();
    // (Re)start live listeners that need an authenticated user
    if (typeof window.startTasksListener === 'function') {
      try { window.startTasksListener(); } catch (e) { console.error(e); }
    }
    return;
  }
  if (user) {
    // Leftover anonymous session or wrong account — sign it out
    signOut(_auth).catch(function() {});
    return;
  }
  _setFbStatus(false, 'Sign in');
  _showSignIn();
  // Let the app keep starting up on local data while signed out
  _resolveFirebaseReady();
});

function _showSignIn(errorMsg) {
  let ov = document.getElementById('afl-signin');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'afl-signin';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:inherit';
    ov.innerHTML =
      '<form id="afl-signin-form" style="background:#fff;border-radius:10px;padding:28px;width:340px;box-shadow:0 10px 40px rgba(0,0,0,.3)">' +
        '<div style="font-size:18px;font-weight:700;margin-bottom:4px">Sign in to AFL Sales Tracker</div>' +
        '<div style="font-size:13px;color:#666;margin-bottom:18px">Needed for cloud sync. You only do this once per computer.</div>' +
        '<label style="font-size:12px;color:#555">Email</label>' +
        '<input id="afl-signin-email" type="email" autocomplete="username" value="' + ALLOWED_EMAIL + '" style="width:100%;box-sizing:border-box;padding:9px;margin:4px 0 12px;border:1px solid #ccc;border-radius:6px">' +
        '<label style="font-size:12px;color:#555">Password</label>' +
        '<input id="afl-signin-pw" type="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:9px;margin:4px 0 12px;border:1px solid #ccc;border-radius:6px">' +
        '<div id="afl-signin-err" style="color:#c62828;font-size:12px;min-height:16px;margin-bottom:8px"></div>' +
        '<button type="submit" style="width:100%;padding:10px;background:#eb0a1e;color:#fff;border:0;border-radius:6px;font-weight:700;cursor:pointer">Sign in</button>' +
        '<div style="display:flex;justify-content:space-between;margin-top:12px;font-size:12px">' +
          '<a href="#" id="afl-signin-reset" style="color:#555">Forgot password?</a>' +
          '<a href="#" id="afl-signin-skip" style="color:#555">Work offline</a>' +
        '</div>' +
      '</form>';
    document.body.appendChild(ov);
    document.getElementById('afl-signin-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      const email = document.getElementById('afl-signin-email').value.trim();
      const pw = document.getElementById('afl-signin-pw').value;
      const errEl = document.getElementById('afl-signin-err');
      errEl.textContent = 'Signing in…';
      try {
        await signInWithEmailAndPassword(_auth, email, pw);
      } catch (err) {
        errEl.textContent = (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password')
          ? 'Wrong email or password.'
          : (err.code === 'auth/network-request-failed' ? 'No internet connection.' : 'Sign-in failed (' + (err.code || 'error') + ').');
      }
    });
    document.getElementById('afl-signin-reset').addEventListener('click', async function(e) {
      e.preventDefault();
      const email = document.getElementById('afl-signin-email').value.trim();
      const errEl = document.getElementById('afl-signin-err');
      try { await sendPasswordResetEmail(_auth, email); errEl.textContent = 'Reset link sent to ' + email; }
      catch (err) { errEl.textContent = 'Could not send reset email (' + (err.code || 'error') + ').'; }
    });
    document.getElementById('afl-signin-skip').addEventListener('click', function(e) {
      e.preventDefault();
      _hideSignIn();
      _delayedToast('Working offline — changes save to this computer only until you sign in.', 'error');
    });
  }
  ov.style.display = 'flex';
  if (errorMsg) document.getElementById('afl-signin-err').textContent = errorMsg;
  setTimeout(function() { const pw = document.getElementById('afl-signin-pw'); if (pw) pw.focus(); }, 50);
}

function _hideSignIn() {
  const ov = document.getElementById('afl-signin');
  if (ov) ov.style.display = 'none';
}

// Lets you re-open the sign-in box from DevTools or a future menu item
window.aflShowSignIn = function() { _showSignIn(); };

function _delayedToast(message, type) {
  // Delay so the DOM/toast function is ready when this fires
  setTimeout(function() {
    if (typeof toast === 'function') toast(message, type);
  }, 1500);
}

// Update the cloud status indicator in the header
function _setFbStatus(online, label) {
  const dot  = document.getElementById('fb-status-dot');
  const text = document.getElementById('fb-status-text');
  const wrap = document.getElementById('fb-status');
  if (dot)  dot.style.background = online ? '#4caf50' : '#ff9800';
  if (text) text.textContent     = label  || (online ? 'Cloud' : 'Offline');
  if (wrap) wrap.title = online
    ? 'Firebase: Connected — data saves to the cloud in real time'
    : 'Firebase: ' + (label || 'Offline') + ' — open DevTools console (Ctrl+Shift+I) for details';
}

window.addEventListener('online',  function() { if (_auth.currentUser) _setFbStatus(true); });
window.addEventListener('offline', function() { _setFbStatus(false, 'No internet'); });
