/* events.js - SSE client list & broadcastEvent */
const sseClients = [];

function addSseClient(res, req) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
}

function broadcastEvent(event, payload) {
  const data = JSON.stringify({ event, payload, ts: Date.now() });
  sseClients.forEach(res => {
    try { res.write(`data: ${data}\n\n`); } catch (e) {}
  });
}

module.exports = {
  addSseClient,
  broadcastEvent
};
