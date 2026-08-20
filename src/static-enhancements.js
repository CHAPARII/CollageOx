const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const previousCreateServer = http.createServer.bind(http);
const indexFile = path.join(__dirname, '..', 'public', 'index.html');

function enhancedIndex() {
  const source = fs.readFileSync(indexFile, 'utf8');
  return source
    .replace('/styles.css?v=3', '/styles.css?v=3&build=pr8')
    .replace('/app.js?v=3', '/app.js?v=3&build=pr8')
    .replace('</head>', '  <link rel="stylesheet" href="/enhancements.css?v=1">\n  <link rel="stylesheet" href="/pr8.css?v=1">\n  <link rel="stylesheet" href="/pr9-cleanup.css?v=2">\n</head>')
    .replace('</body>', '  <script src="/enhancements.js?v=1" defer></script>\n  <script src="/pr8.js?v=1" defer></script>\n  <script src="/pr8-fixes.js?v=1" defer></script>\n  <script src="/pr8-complete.js?v=1" defer></script>\n  <script src="/pr9-cleanup.js?v=1" defer></script>\n</body>');
}

http.createServer = function patchedStaticCreateServer(options, listener) {
  if (typeof options === 'function') {
    listener = options;
    options = undefined;
  }
  const wrapped = (req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; } catch {}
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = enhancedIndex();
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-cache'
      });
      res.end(html);
      return;
    }
    return listener(req, res);
  };
  return options === undefined ? previousCreateServer(wrapped) : previousCreateServer(options, wrapped);
};

module.exports = { enhancedIndex };
