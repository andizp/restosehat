// public/client.js
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(txt || 'API error');
  }
  return r.json();
}

const eventLogEl = document.getElementById('eventLog');
const ordersArea = document.getElementById('ordersArea');
const stockArea = document.getElementById('stockArea');

function logEvent(txt) {
  const now = new Date().toLocaleTimeString();
  eventLogEl.innerText = `[${now}] ${txt}\n` + eventLogEl.innerText;
}

async function loadOrders() {
  try {
    const orders = await api('/api/orders');
    if (!orders || orders.length === 0) { ordersArea.innerText = 'Tidak ada orders'; return; }
    ordersArea.innerHTML = orders.map(o => {
      const items = (o.items||[]).map(i => `${i.item_id} x${i.qty}`).join(', ');
      let controls = '';
      if (o.status === 'PENDING') controls += `<button onclick="shipOrder(${o.id})">Ship</button>`;
      if (o.status === 'SHIPPED') controls += `<button onclick="deliverOrder(${o.id})">Deliver</button>`;
      return `<div style="margin-bottom:8px;border:1px dashed #e5e7eb;padding:8px;">
        <strong>ORD-${o.id}</strong> ${o.auto? '(AUTO)':''}<div>From: ${o.from_type} (${o.from_id||''}) → To: ${o.to_id}</div><div>Status: ${o.status}</div><div>Items: ${items}</div>${controls}</div>`;
    }).join('');
  } catch (e) {
    ordersArea.innerText = 'Error loading orders';
  }
}

async function loadMonitor() {
  try {
    const m = await api('/api/monitor');
    // simple: log branches and low stocks
    const lines = m.branches.map(b => {
      const low = b.items.filter(it => it.qty <= it.reorder_level).map(it => `${it.item_id}:${it.qty}`).join(', ');
      return `${b.branch.name} (${b.branch.id}) — low: ${low || '-'}`;
    }).join('\n');
    logEvent('Monitor refreshed\n' + lines);
  } catch (e) {
    logEvent('Error fetching monitor');
  }
}

async function checkStock() {
  const bid = document.getElementById('branchSelect').value;
  if (!bid) return alert('Pilih cabang dulu');
  try {
    const inv = await api('/api/inventory/' + bid);
    stockArea.innerHTML = '<table style="width:100%"><thead><tr><th>ID</th><th>Item</th><th>Qty</th><th>Reorder</th></tr></thead><tbody>' +
      Object.entries(inv).map(([id,it]) => `<tr><td>${id}</td><td>${it.name}</td><td>${it.qty}</td><td>${it.reorderLevel}</td></tr>`).join('') +
      '</tbody></table>';
  } catch (e) {
    stockArea.innerText = 'Gagal memuat inventory';
  }
}

async function useIngredient() {
  const bid = document.getElementById('branchSelect').value;
  if (!bid) return alert('Pilih cabang dulu');
  const item = document.getElementById('useItem').value.trim();
  const qty = Number(document.getElementById('useQty').value);
  if (!item || !qty) return alert('Isi item dan qty');
  try {
    const res = await api('/api/use', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ branchId: bid, itemId: item, qty }) });
    alert('Usage recorded. New qty: ' + res.inventory.qty);
    checkStock();
  } catch (e) { alert('Error: ' + e.message); }
}

async function shipOrder(id) {
  try {
    await api(`/api/order/${id}/ship`, { method: 'POST' });
    loadOrders();
    logEvent(`Order ${id} shipped`);
  } catch (e) { alert('Error: ' + e.message); }
}

async function deliverOrder(id) {
  try {
    await api(`/api/order/${id}/deliver`, { method: 'POST' });
    loadOrders();
    logEvent(`Order ${id} delivered`);
  } catch (e) { alert('Error: ' + e.message); }
}

// events
document.getElementById('checkStockBtn').addEventListener('click', checkStock);
document.getElementById('useBtn').addEventListener('click', useIngredient);
document.getElementById('refreshOrders').addEventListener('click', loadOrders);
document.getElementById('refreshMonitor').addEventListener('click', loadMonitor);

loadOrders();
loadMonitor();

// SSE
const es = new EventSource('/events');
es.onmessage = (ev) => {
  try {
    const d = JSON.parse(ev.data);
    logEvent(JSON.stringify(d));
    loadOrders();
  } catch (e) {}
};
