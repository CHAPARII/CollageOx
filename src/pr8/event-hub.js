const clients = new Map();

function bucket(userId) {
  let set = clients.get(userId);
  if (!set) {
    set = new Set();
    clients.set(userId, set);
  }
  return set;
}

function writeEvent(res, type, payload) {
  if (res.destroyed || res.writableEnded) return false;
  try {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function subscribe(userId, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  const set = bucket(userId);
  set.add(res);
  const heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) return;
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);
  const cleanup = () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (!set.size) clients.delete(userId);
  };
  req.once('close', cleanup);
  res.once('close', cleanup);
  return cleanup;
}

function emit(type, payload = {}, targetUserIds = null) {
  const targets = targetUserIds == null
    ? [...clients.keys()]
    : [...new Set((Array.isArray(targetUserIds) ? targetUserIds : [targetUserIds]).filter(Boolean))];
  let delivered = 0;
  for (const userId of targets) {
    const set = clients.get(userId);
    if (!set) continue;
    for (const res of [...set]) {
      if (writeEvent(res, type, payload)) delivered++;
      else set.delete(res);
    }
    if (!set.size) clients.delete(userId);
  }
  return delivered;
}

function connectedUsers() {
  return new Set(clients.keys());
}

function isConnected(userId) {
  return !!clients.get(userId)?.size;
}

module.exports = { subscribe, emit, connectedUsers, isConnected };