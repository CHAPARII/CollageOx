const http = require('node:http');
const { send, assertSameOrigin, requireUser } = require('./common');
const eventHub = require('./event-hub');

const previousCreateServer = http.createServer.bind(http);
const routes = [];

function registerRoute(method, matcher, handler) {
  routes.push({ method: String(method).toUpperCase(), matcher, handler });
}

function routeMatch(matcher, pathname) {
  if (typeof matcher === 'string') return matcher === pathname ? true : null;
  if (matcher instanceof RegExp) return pathname.match(matcher);
  if (typeof matcher === 'function') return matcher(pathname);
  return null;
}

async function dispatch(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = routeMatch(route.matcher, url.pathname);
    if (!match) continue;
    assertSameOrigin(req);
    res.json = (payload, status = 200) => send(res, status, payload);
    const result = await route.handler({ req, res, url, match });
    return result !== false;
  }
  return false;
}

registerRoute('GET', '/api/pr8/stream', async ({ req, res }) => {
  const user = await requireUser(req);
  const { touchPresence } = require('./presence');
  const { processDueReminders } = require('./reminders');
  await touchPresence(user.id, true);
  await processDueReminders(user.id);
  eventHub.subscribe(user.id, req, res);
  return true;
});

require('./safety').registerRoutes(registerRoute);
require('./safety-controls').registerRoutes(registerRoute);
require('./presence').registerRoutes(registerRoute);
require('./notifications').registerRoutes(registerRoute);
require('./dm').registerRoutes(registerRoute);
require('./feed').registerRoutes(registerRoute);
require('./profile').registerRoutes(registerRoute);
require('./search').registerRoutes(registerRoute);
require('./social').registerRoutes(registerRoute);
require('./context-pins').registerRoutes(registerRoute);
require('./media').registerRoutes(registerRoute);
require('./projects').registerRoutes(registerRoute);
require('./club-list').registerRoutes(registerRoute);
require('./club-chat').registerRoutes(registerRoute);
require('./clubs').registerRoutes(registerRoute);
require('./marketplace').registerRoutes(registerRoute);
require('./lost-found').registerRoutes(registerRoute);
require('./qa').registerRoutes(registerRoute);
require('./discovery').registerRoutes(registerRoute);
require('./reminders').registerRoutes(registerRoute);
require('./push').registerRoutes(registerRoute);
require('./moderation').registerRoutes(registerRoute);

http.createServer = function patchedPr8CreateServer(options, listener) {
  if (typeof options === 'function') {
    listener = options;
    options = undefined;
  }

  const server = options === undefined
    ? previousCreateServer(listener)
    : previousCreateServer(options, listener);
  const inheritedRequestListeners = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', async function pr8RequestListener(req, res) {
    try {
      if (await dispatch(req, res)) return;
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Unexpected server error.' });
      else if (!res.writableEnded) res.end();
      if (!error.status) console.error(`PR8 route failed: ${error.stack || error.message}`);
      return;
    }
    for (const inherited of inheritedRequestListeners) {
      inherited.call(server, req, res);
      if (res.writableEnded) break;
    }
  });
  return server;
};

module.exports = {
  registerRoute,
  dispatch,
  emit: eventHub.emit,
  subscribe: eventHub.subscribe,
  eventHub
};
