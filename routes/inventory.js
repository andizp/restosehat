/* routes/inventory.js */
const express = require('express');
const router = express.Router();
const db = require('../scripts/db.js');
const { escapeHtml, renderLayout } = require('../utils');
const { ensureAuth, readOnlyForPimpindanMiddleware } = require('../middleware/auth');
const { broadcastEvent } = require('../events');

// ----------------- INVENTORY -----------------
router.get('/inventory', ensureAuth, (req, res) => {
  const role = req.session.role;
  if (role === 'kitchen') {
    const body = `
      <div class="page card">
        <h2>Input Pemakaian Bahan - Cabang ${escapeHtml(String(req.session.branchId||''))}</h2>
        <p>Masukkan bahan yang digunakan hari ini. Ini akan langsung mengurangi stok inventori cabang Anda.</p>
        <form id="useForm">
          <div id="rows">
            <div class="row">
              <input list="itemsList" name="item_id" placeholder="Item ID atau ketik baru" required />
              <input name="qty" type="number" placeholder="Qty" value="1" required />
              <button type="button" class="rm">-</button>
            </div>
          </div>
          <datalist id="itemsList"></datalist>
          <div style="margin-top:8px"><button type="button" id="addRow">+ Tambah Baris</button></div>
          <div style="margin-top:8px"><button type="submit">Kirim Pemakaian</button></div>
        </form>
        <div id="msg"></div>
      </div>

      <script>
        async function fetchItems() {
          try {
            const r = await fetch('/api/items');
            if (!r.ok) return [];
            return await r.json();
          } catch(e) { return []; }
        }
        (async function(){
          const items = await fetchItems();
          const dl = document.getElementById('itemsList');
          dl.innerHTML = items.map(it => '<option value="'+it.id+'">'+(it.name||'')+'</option>').join('');
        })();

        document.getElementById('addRow').addEventListener('click', function(){
          const d = document.createElement('div');
          d.className='row';
          d.innerHTML = '<input list="itemsList" name="item_id" placeholder="Item ID atau ketik baru" required /> <input name="qty" type="number" placeholder="Qty" value="1" required /> <button type="button" class="rm">-</button>';
          document.getElementById('rows').appendChild(d);
        });
        document.getElementById('rows').addEventListener('click', function(e){
          if (e.target && e.target.classList.contains('rm')) e.target.parentNode.remove();
        });

        document.getElementById('useForm').addEventListener('submit', async function(e){
          e.preventDefault();
          const rows = Array.from(document.querySelectorAll('#rows .row'));
          const items = rows.map(r => ({ itemId: r.querySelector('input[name=item_id]').value.trim(), qty: Number(r.querySelector('input[name=qty]').value) })).filter(i=>i.itemId && i.qty>0);
          if (items.length === 0) return alert('Isi minimal 1 bahan');
          try {
            const res = await fetch('/api/use', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ items })});
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Gagal');
            document.getElementById('msg').innerHTML = '<div class="success-box">Pemakaian tersimpan.</div>';
            setTimeout(()=>location.reload(), 800);
          } catch(err) {
            alert('Gagal mengirim pemakaian: ' + (err.message||''));
          }
        });
      </script>
    `;
    return res.send(renderLayout('Inventory - Pemakaian Bahan', body, { user: req.session }));
  }

  if (role === 'restaurant') {
    const body = `
      <div class="page card">
        <h2>Inventory Cabang Anda</h2>
        <div id="stockArea">Memuat...</div>
        <div style="margin-top:12px">
          <button id="reportBtn">Buat Laporan Stok</button>
          <button id="createPOBtn">Buat Purchase Order (PO)</button>
        </div>
      </div>

      <script>
        async function api(path, opts){ const r = await fetch(path, opts); if(!r.ok) throw new Error('API'); return r.json(); }
        async function load(){
          try {
            const data = await api('/api/inventory/${encodeURIComponent(req.session.branchId)}');
            const rows = Object.entries(data).map(([id,it])=>'<tr><td>'+id+'</td><td>'+it.name+'</td><td>'+it.qty+'</td><td>'+it.reorderLevel+'</td><td><button class="editBtn" data-id="'+id+'">Edit</button></td></tr>').join('');
            document.getElementById('stockArea').innerHTML = '<table class="data-table"><thead><tr><th>ID</th><th>Item</th><th>Qty</th><th>Reorder</th><th>Aksi</th></tr></thead><tbody>'+rows+'</tbody></table>';
            document.querySelectorAll('.editBtn').forEach(b => b.addEventListener('click', function(){
              const id = this.dataset.id;
              const newQty = prompt('Masukkan qty baru untuk ' + id);
              if (newQty !== null) {
                fetch('/api/inventory/${encodeURIComponent(req.session.branchId)}/adjust', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ itemId:id, qty: Number(newQty) })}).then(r=> {
                  if (r.ok) { alert('OK'); load(); } else r.text().then(t=>alert('Gagal: '+t));
                });
              }
            }));
          } catch(e){ document.getElementById('stockArea').innerText = 'Gagal memuat inventory'; }
        }
        load();
        document.getElementById('reportBtn').addEventListener('click', ()=> location.href='/inventory/report?branchId=${encodeURIComponent(req.session.branchId)}');
        document.getElementById('createPOBtn').addEventListener('click', ()=> location.href='/po/create');
      </script>
    `;
    return res.send(renderLayout('Inventory - RESTOSEHAT', body, { user: req.session }));
  }

  if (role === 'admin' || role === 'pimpinan' || role === 'supplier') {
    db.query('SELECT id, name FROM branches', [], (err, branches) => {
      if (err) return res.send(renderLayout('Inventory', `<div class="error-box">Error: ${escapeHtml(err.message)}</div>`, { user: req.session }));
      const options = branches.map(b => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)} (${escapeHtml(b.id)})</option>`).join('');
      const body = `
        <div class="page card">
          <h2>Inventory</h2>
          <label>Pilih Cabang</label>
          <select id="branchSelect">${options}</select>
          <div style="margin-top:8px"><button id="checkBtn">Cek Stok</button> <button id="reportBtn">Buat Laporan Stok</button></div>
          <div id="stockArea" style="margin-top:12px"></div>
        </div>

        <script>
          async function api(path, opts){ const r = await fetch(path, opts); if(!r.ok) throw new Error('API'); return r.json(); }
          document.getElementById('checkBtn').addEventListener('click', async ()=> {
            const bid = document.getElementById('branchSelect').value;
            if(!bid) return alert('Pilih cabang');
            try {
              const data = await api('/api/inventory/' + bid);
              const rows = Object.entries(data).map(([id,it])=>'<tr><td>'+id+'</td><td>'+it.name+'</td><td>'+it.qty+'</td><td>'+it.reorderLevel+'</td></tr>').join('');
              document.getElementById('stockArea').innerHTML = '<table class="data-table"><thead><tr><th>ID</th><th>Item</th><th>Qty</th><th>Reorder</th></tr></thead><tbody>'+rows+'</tbody></table>';
            } catch(e){ alert('Gagal ambil inventory'); }
          });
          document.getElementById('reportBtn').addEventListener('click', ()=> {
            const bid = document.getElementById('branchSelect').value;
            if(!bid) return alert('Pilih cabang dulu');
            location.href = '/inventory/report?branchId=' + encodeURIComponent(bid);
          });
        </script>
      `;
      res.send(renderLayout('Inventory - RESTOSEHAT', body, { user: req.session }));
    });
    return;
  }

  res.send(renderLayout('Inventory', `<div class="error-box">Tidak diizinkan</div>`, { user: req.session }));
});

// inventory report (unchanged)
router.get('/inventory/report', ensureAuth, (req, res) => {
  const bid = req.query.branchId;
  if (!bid) return res.send(renderLayout('Laporan Stok', `<div class="error-box">branchId required</div>`, { user: req.session }));
  if (req.session.role === 'restaurant' && String(req.session.branchId) !== String(bid)) {
    return res.send(renderLayout('Akses Ditolak', `<div class="error-box">Anda hanya dapat melihat laporan cabang sendiri.</div>`, { user: req.session }));
  }
  db.query(`SELECT i.item_id, it.name, i.qty, i.reorder_level FROM inventory i JOIN items it ON i.item_id = it.id WHERE i.branch_id = ?`, [bid], (err, rows) => {
    if (err) return res.send(renderLayout('Laporan Stok', `<div class="error-box">DB error</div>`, { user: req.session }));
    const rowsHtml = (rows || []).map(r => `<tr><td>${escapeHtml(r.item_id)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.qty)}</td><td>${escapeHtml(r.reorder_level)}</td></tr>`).join('');
    const body = `
      <div class="page card">
        <h2>Laporan Stok - Cabang ${escapeHtml(bid)}</h2>
        <table class="data-table"><thead><tr><th>Item ID</th><th>Nama</th><th>Qty</th><th>Reorder</th></tr></thead><tbody>${rowsHtml}</tbody></table>
        <div style="margin-top:12px"><button onclick="window.print()">Cetak</button> <a href="/inventory">Kembali</a></div>
      </div>
    `;
    res.send(renderLayout('Laporan Stok', body, { user: req.session }));
  });
});

// API: get inventory for branch
router.get('/api/inventory/:branchId', ensureAuth, (req, res) => {
  const bid = req.params.branchId;
  if (req.session.role === 'restaurant' && String(req.session.branchId) !== String(bid)) {
    return res.status(403).json({ error: 'Not authorized for that branch' });
  }
  db.query(`SELECT i.item_id, it.name, i.qty, i.reorder_level
            FROM inventory i JOIN items it ON i.item_id = it.id
            WHERE i.branch_id = ?`, [bid], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'inventory not found' });
    const result = {};
    rows.forEach(r => result[r.item_id] = { name: r.name, qty: Number(r.qty), reorderLevel: Number(r.reorder_level) });
    res.json(result);
  });
});

// API: adjust inventory (restaurant only) - set qty
router.post('/api/inventory/:branchId/adjust', ensureAuth, readOnlyForPimpindanMiddleware, (req, res) => {
  const bid = req.params.branchId;
  if (req.session.role !== 'restaurant') return res.status(403).send('Only restaurant staff can adjust their inventory');
  if (String(req.session.branchId) !== String(bid)) return res.status(403).send('Not your branch');
  const { itemId, qty } = req.body;
  if (!itemId || !Number.isFinite(Number(qty))) return res.status(400).send('invalid input');
  db.query('UPDATE inventory SET qty = ? WHERE branch_id = ? AND item_id = ?', [Number(qty), bid, itemId], (err, r) => {
    if (err) return res.status(500).send('DB error');
    if (r.affectedRows === 0) return res.status(404).send('item not found in inventory');
    db.query('SELECT qty FROM inventory WHERE branch_id = ? AND item_id = ?', [bid, itemId], (e, rows) => {
      if (!e && rows && rows[0]) broadcastEvent('inventory_updated', { branchId: bid, itemId, qty: rows[0].qty });
      res.send('ok');
    });
  });
});

// API: use ingredient (kitchen) reduces stock
router.post('/api/use', ensureAuth, (req, res) => {
  if (req.session.role !== 'kitchen') return res.status(403).json({ error: 'Only kitchen staff allowed' });
  const { branchId = req.session.branchId, items } = req.body;
  if (!branchId || !items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'missing fields' });

  for (const it of items) {
    if (!it.itemId || !/^[A-Za-z0-9\-_]+$/.test(it.itemId)) return res.status(400).json({ error: 'invalid itemId' });
    if (!Number.isFinite(Number(it.qty)) || Number(it.qty) <= 0) return res.status(400).json({ error: 'invalid qty' });
  }

  const tasks = items.map(it => new Promise((resolve) => {
    db.query('UPDATE inventory SET qty = GREATEST(qty - ?, 0) WHERE branch_id = ? AND item_id = ?', [Number(it.qty), branchId, it.itemId], (err) => {
      if (err) return resolve({ ok:false });
      db.query('SELECT qty, reorder_level FROM inventory WHERE branch_id = ? AND item_id = ?', [branchId, it.itemId], (e2, rows) => {
        if (e2 || !rows || rows.length === 0) return resolve({ ok:true });
        const inv = rows[0];
        broadcastEvent('inventory_updated', { branchId, itemId: it.itemId, qty: inv.qty });
        if (inv.qty <= inv.reorder_level) {
          const suggested = Math.max(inv.reorder_level * 3 - inv.qty, 1);
          db.query('INSERT INTO orders (from_type, from_id, to_id, status, auto, created_at) VALUES (?,?,?,?,?,NOW())', ['warehouse', null, branchId, 'pending', 1], (err3, r3) => {
            if (!err3) {
              const orderId = r3.insertId;
              db.query('INSERT INTO order_items (order_id, item_id, qty) VALUES (?,?,?)', [orderId, it.itemId, suggested], () => {
                broadcastEvent('order_created', { id: orderId, to_id: branchId, items: [{ itemId: it.itemId, qty: suggested }], auto: true });
              });
            }
          });
        }
        resolve({ ok:true, item: it.itemId, qty: inv.qty });
      });
    });
  }));

  Promise.all(tasks).then(results => res.json({ ok: true, results }));
});

module.exports = router;
