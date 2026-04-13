// Fred's Rehab Tracker - Service Worker
// Handles Web Share Target so videos/photos shared from WhatsApp
// are automatically pre-loaded into the upload form.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Intercept the Web Share Target POST
  if (url.pathname === '/share-target' && event.request.method === 'POST') {
    // Immediately redirect to the upload page
    event.respondWith(Response.redirect('/exercise-videos.html'));

    // In the background: parse the shared files and post them to the new page
    event.waitUntil((async () => {
      try {
        const formData = await event.request.formData();
        const files = formData.getAll('media');
        if (!files.length) return;

        // Poll until the redirected client is ready (up to 3 seconds)
        const clientId = event.resultingClientId;
        let client = null;
        for (let i = 0; i < 30 && !client; i++) {
          await new Promise(r => setTimeout(r, 100));
          client = await clients.get(clientId);
        }

        if (client) {
          client.postMessage({ type: 'share-target', files });
        }
      } catch (e) {
        console.error('[SW] Share target error:', e);
      }
    })());
  }
  // All other requests: let the browser handle normally (no caching)
});
