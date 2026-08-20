const CACHE = 'collegeox-v3-pr8-v3';
const SHELL = [
  '/',
  '/styles.css?v=3&build=pr8',
  '/app.js?v=3&build=pr8',
  '/enhancements.css?v=1',
  '/enhancements.js?v=1',
  '/pr8.css?v=1',
  '/pr8.js?v=1',
  '/pr8-fixes.js?v=1',
  '/pr8-complete.js?v=1',
  '/manifest.json',
  '/icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request)) || (await caches.match('/')))
  );
});

function pushUrl(payload) {
  const kind = String(payload.kind || '');
  const entityId = encodeURIComponent(String(payload.entityId || ''));
  if (kind === 'dm_message') return '/#messages';
  if (kind === 'mention' && entityId) return `/?post=${entityId}`;
  if (kind.startsWith('project_')) return '/#projects';
  if (kind.startsWith('club_')) return '/#clubs';
  if (kind.startsWith('event_')) return '/#events';
  if (kind === 'announcement') return '/#announcements';
  return '/';
}

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch {}
  const title = payload.title || 'College Ox';
  const options = {
    body: payload.body || 'You have a new campus notification.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: `collegeox:${payload.kind || 'notification'}:${payload.entityId || ''}`,
    data: { url: pushUrl(payload) }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(client => client.url.startsWith(self.location.origin));
      if (existing) return existing.focus().then(client => client.navigate(url));
      return self.clients.openWindow(url);
    })
  );
});
