// Firebase v10 modular SDK — loaded from CDN, initialised in renderer process.
// Exposes window.db and window._fs so the non-module inline script can use Firestore.
//
// ── Firebase Console setup required ────────────────────────────────────────────
//
// 1. Enable Anonymous Authentication:
//    Firebase Console → Authentication → Sign-in methods → Anonymous → Enable
//
// 2. Set Firestore security rules (Firestore Database → Rules → Publish):
//
//   rules_version = '2';
//   service cloud.firestore {
//     match /databases/{database}/documents {
//       match /{document=**} {
//         allow read, write: if request.auth != null;
//       }
//     }
//   }
//
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js';
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

// Sign in anonymously so Firestore security rules (require auth) are satisfied.
// Requires Anonymous Authentication to be ENABLED in Firebase Console:
//   Authentication → Sign-in methods → Anonymous → Enable
signInAnonymously(_auth)
  .then(function() {
    const uid = _auth.currentUser ? _auth.currentUser.uid : '(unknown)';
    console.log('[Firebase] Anonymous sign-in OK — uid:', uid);
    _setFbStatus(true);
    if (typeof window._firebaseReadyResolve === 'function') window._firebaseReadyResolve();
  })
  .catch(function(err) {
    const code = err.code || 'unknown';
    const msg  = err.message || String(err);
    console.error('[Firebase] signInAnonymously failed — code:', code, '| message:', msg);

    if (code === 'auth/operation-not-allowed') {
      console.error(
        '[Firebase] FIX: Enable Anonymous Authentication in Firebase Console\n' +
        '  1. Go to https://console.firebase.google.com\n' +
        '  2. Project: afl-sales-tracker-52890 → Authentication → Sign-in methods\n' +
        '  3. Click Anonymous → toggle Enable → Save\n' +
        '  4. Restart the app'
      );
      _setFbStatus(false, 'Enable Anon Auth');
      _delayedToast(
        'Action required: go to Firebase Console → Authentication → Sign-in methods → Anonymous → Enable, then restart the app.',
        'error'
      );
    } else if (code === 'auth/network-request-failed') {
      console.error('[Firebase] Network error — check internet connection');
      _setFbStatus(false, 'No internet');
      _delayedToast('Firebase: network error — check internet connection.', 'error');
    } else {
      console.error('[Firebase] Unexpected auth error — code:', code);
      _setFbStatus(false, code);
      _delayedToast('Firebase auth error (' + code + ') — see DevTools console (Ctrl+Shift+I) for details.', 'error');
    }

    // Still resolve so loadData() continues — reads may work if Firestore rules allow it.
    if (typeof window._firebaseReadyResolve === 'function') window._firebaseReadyResolve();
  });

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
