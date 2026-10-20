// AFL Sales Tracker — Service Worker v11 (2026-10-15)
// Network-first for app files; cache-first only for images

const CACHE_NAME = 'afl-mobile-v15';

const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
];

const STATIC_ASSETS = [
  '/icon-192.png',
  '/icon-512.png',
];

const FIREBASE_CDN = [
  'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js',
];

// Install: pre-cache static assets and Firebase CDN; skip waiting immediately
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await Promise.allSettled([
        cache.addAll(APP_SHELL),
        cache.addAll(STATIC_ASSETS),
        ...FIREBASE_CDN.map(url =>
          fetch(url, { mode: 'cors' })
            .then(r => r.ok ? cache.put(url, r) : null)
            .catch(() => null)
        ),
      ]);
    }).then(() => self.skipWaiting())
  );
});

// Activate: delete all old caches, claim clients immediately
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Firebase API / Firestore / Auth — always network, never cache
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.pathname.includes('/google.firestore.')
  ) {
    event.respondWith(
      fetch(request).catch(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
    );
    return;
  }

  // Images — cache-first (they rarely change)
  if (request.destination === 'image') {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }))
    );
    return;
  }

  // Firebase CDN JS — cache-first (versioned URLs, stable)
  if (url.hostname === 'www.gstatic.com') {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }))
    );
    return;
  }

  // App shell (HTML, JS, CSS) — network-first so updates deploy immediately
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request).then(cached => {
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('/index.html');
      }))
  );
});
