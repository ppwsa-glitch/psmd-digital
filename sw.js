// ប្តូរលេខ version នេះរាល់ពេលកែ index.html ដើម្បីឱ្យ cache ថ្មីជំនួសចាស់
const V = 'ppwsa-hub-v12';
const SHELL = ['./', 'index.html', 'admin.html', 'psmd-admin.html', 'setpoint.html', 'wtp.html', 'chemical.html', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/app-calendar.png', 'icons/app-setpoint.png', 'icons/app-task-tracker.png', 'icons/app-maintenance.png', 'icons/app-chemical.png',
  'icons/logo-ppwsa.png', 'icons/logo-ppwsa-dark.png',
  'icons/login-1.jpg', 'icons/login-2.jpg', 'icons/login-3.jpg', 'icons/login-4.jpg', 'icons/logo-login.png'];

self.addEventListener('install', e => {
  // cache ម្តងមួយៗ៖ បើឯកសារណាមួយបាត់ មិនធ្វើឱ្យ install ទាំងមូលបរាជ័យទេ
  e.waitUntil(
    caches.open(V).then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: ទាញថ្មីជាមុន បើគ្មានអ៊ីនធឺណិតប្រើ cache (រួមទាំង Font ខ្មែរ)
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const sameOrigin = u.origin === location.origin;
  const isFont = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (!sameOrigin && !isFont) return; // Mini App ខាងក្រៅ មិនចូលរាប់ទេ
  e.respondWith(
    fetch(r)
      .then(res => { const copy = res.clone(); caches.open(V).then(c => c.put(r, copy)); return res; })
      .catch(() => caches.match(r).then(m => m || caches.match('index.html')))
  );
});
