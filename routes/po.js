/* routes/po.js */
const express = require('express');
const router = express.Router();
const db = require('../scripts/db.js');
const { escapeHtml, renderLayout, fetchPoItemsSafe } = require('../utils');
const { ensureAuth, ensureSupplier } = require('../middleware/auth');
const { broadcastEvent } = require('../events');

// ----------------- PURCHASE ORDERS (PO) -----------------
// GET /po (PO Masuk / PO Keluar handling)
router.get('/po', ensureAuth, (req, res) => {
  const role = req.session.role;
  const userId = req.session.userId;
  const branchId = req.session.branchId;

  // Supplier: only show PO Masuk (purchase_orders where supplier_id = userId)
  if (role === 'supplier') {
    db.query('SELECT * FROM purchase_orders WHERE supplier_id = ? ORDER BY created_at DESC LIMIT 200', [userId], (err, rows) => {
      if (err) {
        console.error('GET /po supplier - purchase_orders select error:', err);
        return res.send(renderLayout('PO', `<div class="error-box">DB error</div>`, { user: req.session }));
      }
      const poIds = rows.map(r => r.id);
      if (!poIds.length) {
        const body = `<div class="page card"><h2>PO Masuk</h2><div>Tidak ada PO masuk.</div></div>`;
        return res.send(renderLayout('PO - RESTOSEHAT', body, { user: req.session }));
      }
      fetchPoItemsSafe(poIds, (err2, items) => {
        if (err2) {
          console.error('GET /po supplier - fetchPoItemsSafe error:', err2);
          items = [];
        }
        const byPo = {};
        (items||[]).forEach(it => { byPo[it.po_id] = byPo[it.po_id] || []; byPo[it.po_id].push(it); });
        const rowsHtml = (rows || []).map(r => {
          const itemsList = (byPo[r.id]||[]).map(i => `${escapeHtml(i.name || i.item_id)} x${escapeHtml(i.qty)}${i.unit_price ? ' @'+escapeHtml(i.unit_price) : ''}`).join(', ');
          let actions = '';
          // Supplier actions: ship / deliver (as before)
          if (r.status === 'PENDING') actions += `<form style="display:inline" method="post" action="/api/po/${r.id}/ship"><button type="submit">Mark DIKIRIM</button></form> `;
          if (r.status === 'SHIPPED') actions += `<form style="display:inline" method="post" action="/api/po/${r.id}/deliver"><button type="submit">Mark TERKIRIM</button></form> `;
          return `<tr><td>PO-${r.id}</td><td>${escapeHtml(r.branch_id)}</td><td>${escapeHtml(r.supplier_id||'')}</td><td>${escapeHtml(r.status)}</td><td>${itemsList}</td><td>${actions}</td></tr>`;
        }).join('');
        const body = `<div class="page card"><h2>Purchase Orders - PO Masuk</h2><table class="data-table"><thead><tr><th>No</th><th>Branch</th><th>Supplier</th><th>Status</th><th>Items</th><th>Aksi</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
        res.send(renderLayout('PO - RESTOSEHAT', body, { user: req.session }));
      });
    });
    return;
  }

  // Restaurant: show PO Masuk (purchase_orders that are addressed to this branch via orig_order mapping) + PO Keluar (PO created by this branch)
   if (role === 'restaurant') {
    const branchId = req.session.branchId;

    // fetch outgoing PO (purchase_orders where branch_id = this branch)
    db.query('SELECT * FROM purchase_orders WHERE branch_id = ? ORDER BY created_at DESC LIMIT 200', [branchId], (errOut, outPOs) => {
      if (errOut) { console.error('GET /po - outgoing PO select error:', errOut); outPOs = []; }

      // detect if purchase_orders has to_branch column to fetch incoming internal PO
      db.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'to_branch'", [], (colErr, colRows) => {
        if (colErr) { console.error('GET /po - schema detect error:', colErr); colRows = []; }
        const hasToBranch = (colRows || []).length > 0;

        // get incoming orders (if some older code still uses orders for incoming branch orders, keep as fallback)
        const incomingOrdersPromise = new Promise((resolve) => {
          // also fetch incoming legacy orders (from orders table) as before
          db.query('SELECT * FROM orders WHERE to_id = ? AND from_type = ? ORDER BY created_at DESC LIMIT 200', [branchId, 'branch'], (errIn, incomingOrders) => {
            if (errIn) { console.error('GET /po - incoming orders error:', errIn); incomingOrders = []; }
            resolve(incomingOrders || []);
          });
        });

        const incomingPoPromise = new Promise((resolve) => {
          if (!hasToBranch) return resolve([]); // no column => no purchase_orders-to_branch
          db.query('SELECT * FROM purchase_orders WHERE to_branch = ? ORDER BY created_at DESC LIMIT 200', [branchId], (errInPo, incomingPOs) => {
            if (errInPo) { console.error('GET /po - incoming purchase_orders error:', errInPo); return resolve([]); }
            resolve(incomingPOs || []);
          });
        });

        Promise.all([incomingOrdersPromise, incomingPoPromise]).then(([incomingOrders, incomingPOs]) => {
          // combine incoming orders (legacy) and incomingPOs (actual PO records). We'll render incomingPOs as "PO Masuk" and incomingOrders as older-order-incoming message.
          // Fetch po_items for ALL PO ids we will render (incomingPOs + outPOs)
          const poIdsAll = []
            .concat((outPOs||[]).map(p=>p.id))
            .concat((incomingPOs||[]).map(p=>p.id))
            .filter(Boolean);

          const finishRender = (poItems) => {
            const poBy = {};
            (poItems||[]).forEach(it => { poBy[it.po_id] = poBy[it.po_id] || []; poBy[it.po_id].push(it); });

            const incomingHtml = (incomingPOs||[]).map(p => {
              const its = (poBy[p.id]||[]).map(i => `${escapeHtml(i.name || i.item_id)} x${escapeHtml(i.qty)} ${i.unit_price?('@'+escapeHtml(i.unit_price)) : ''}`).join(', ');
              let actions = '';
              // receiver (this branch) sees PO Masuk (they are the to_branch) -- they should be able to "Terima PO" (approve) if PENDING
              if (String(p.status).toUpperCase() === 'PENDING') {
                actions += `<form style="display:inline" method="post" action="/api/po/${p.id}/approve"><button type="submit">Terima PO</button></form> `;
              }
              return `<tr><td>PO-${p.id}</td><td>${escapeHtml(p.branch_id)}</td><td>${escapeHtml(p.to_branch||'')}</td><td>${escapeHtml(p.status)}</td><td>${its}</td><td>${actions}</td></tr>`;
            }).join('');

            const outgoingHtml = (outPOs||[]).map(p => {
              const its = (poBy[p.id]||[]).map(i => `${escapeHtml(i.name || i.item_id)} x${escapeHtml(i.qty)} ${i.unit_price?('@'+escapeHtml(i.unit_price)) : ''}`).join(', ');
              let actions = '';
              // If outgoing PO was created by this branch and status APPROVED (by receiver), sender should see "Kirim PO" or similar.
              if (String(p.status).toUpperCase() === 'APPROVED') {
                actions += `<form style="display:inline" method="post" action="/api/po/${p.id}/ship"><button type="submit">Kirim PO</button></form> `;
              }
              return `<tr><td>PO-${p.id}</td><td>${escapeHtml(p.branch_id)}</td><td>${escapeHtml(p.supplier_id || p.to_branch || '')}</td><td>${escapeHtml(p.status)}</td><td>${its}</td><td>${actions}</td></tr>`;
            }).join('');

            const body = `
              <div class="page card">
                <h2>PO Masuk (PO yang ditujukan ke cabang Anda)</h2>
                ${incomingHtml ? `<table class="data-table"><thead><tr><th>No</th><th>Branch</th><th>To</th><th>Status</th><th>Items</th><th>Aksi</th></tr></thead><tbody>${incomingHtml}</tbody></table>` : '<div>Tidak ada PO masuk.</div>'}

                <h2 style="margin-top:18px">PO Keluar (PO yang dibuat cabang Anda ke supplier / cabang lain)</h2>
                ${outgoingHtml ? `<table class="data-table"><thead><tr><th>No</th><th>Branch</th><th>Supplier/To</th><th>Status</th><th>Items</th><th>Aksi</th></tr></thead><tbody>${outgoingHtml}</tbody></table>` : '<div>Tidak ada PO keluar.</div>'}
                <div style="margin-top:12px"><a href="/po/create">Buat PO Keluar</a></div>
              </div>
            `;
            res.send(renderLayout('PO - RESTOSEHAT', body, { user: req.session }));
          };

          if (!poIdsAll.length) return finishRender([]);
          // fetch items for all PO ids
          fetchPoItemsSafe(poIdsAll, (errItems, poItems) => {
            if (errItems) { console.error('GET /po - fetchPoItemsSafe error:', errItems); poItems = []; }
            finishRender(poItems || []);
          });
        });
      });
    });
    return;
  }

  // Admin / other roles: overview show both
  db.query('SELECT * FROM purchase_orders ORDER BY created_at DESC LIMIT 200', [], (err, pos) => {
    if (err) { console.error('GET /po admin - purchase_orders select error:', err); pos = []; }
    const poIds = (pos||[]).map(p=>p.id);

    db.query('SELECT * FROM orders WHERE from_type = ? ORDER BY created_at DESC LIMIT 200', ['branch'], (err2, incomingOrders) => {
      if (err2) { console.error('GET /po admin - incoming orders error:', err2); incomingOrders = []; }
      const inIds = (incomingOrders||[]).map(o=>o.id);
      const qInItems = inIds.length ? 'SELECT order_id, item_id, qty FROM order_items WHERE order_id IN (' + inIds.join(',') + ')' : null;

      // fetch both item sets
      const runPoItems = (cb) => {
        if (!poIds.length) return cb(null, []);
        fetchPoItemsSafe(poIds, (e1, poItems) => { if (e1) { console.error('GET /po admin - fetchPoItemsSafe error:', e1); return cb(null, []); } cb(null, poItems); });
      };
      const runInItems = (cb) => {
        if (!qInItems) return cb(null, []);
        db.query(qInItems, [], (e2, inItems) => { if (e2) { console.error('GET /po admin - inItems error:', e2); return cb(null, []); } cb(null, inItems); });
      };

      runInItems((e1, inItems) => {
        runPoItems((e2, poItems) => {
          // render combined overview
          const inBy = {};
          (inItems||[]).forEach(it => { inBy[it.order_id] = inBy[it.order_id] || []; inBy[it.order_id].push(it); });
          const poBy = {};
          (poItems||[]).forEach(it => { poBy[it.po_id] = poBy[it.po_id] || []; poBy[it.po_id].push(it); });

          const incomingHtml = (incomingOrders||[]).map(o => {
            const its = (inBy[o.id]||[]).map(i => `${escapeHtml(i.item_id)} x${escapeHtml(i.qty)}`).join(', ');
            return `<tr><td>ORD-${o.id}</td><td>${escapeHtml(o.from_id)}</td><td>${escapeHtml(o.to_id)}</td><td>${escapeHtml(o.status)}</td><td>${its}</td><td></td></tr>`;
          }).join('');

          const posHtml = (pos||[]).map(p => {
            const its = (poBy[p.id]||[]).map(i => `${escapeHtml(i.item_id)} x${escapeHtml(i.qty)}${i.unit_price ? ' @'+escapeHtml(i.unit_price) : ''}`).join(', ');
            return `<tr><td>PO-${p.id}</td><td>${escapeHtml(p.branch_id)}</td><td>${escapeHtml(p.supplier_id||'')}</td><td>${escapeHtml(p.status)}</td><td>${its}</td><td></td></tr>`;
          }).join('');

          const body = `
            <div class="page card">
              <h2>PO Masuk (dari cabang lain)</h2>
              ${incomingHtml ? `<table class="data-table"><thead><tr><th>No</th><th>Dari</th><th>Ke</th><th>Status</th><th>Items</th><th>Aksi</th></tr></thead><tbody>${incomingHtml}</tbody></table>` : '<div>Tidak ada order masuk dari cabang lain.</div>'}
              <h2 style="margin-top:18px">Purchase Orders</h2>
              ${posHtml ? `<table class="data-table"><thead><tr><th>No</th><th>Branch</th><th>Supplier</th><th>Status</th><th>Items</th><th>Aksi</th></tr></thead><tbody>${posHtml}</tbody></table>` : '<div>Tidak ada PO.</div>'}
            </div>
          `;
          res.send(renderLayout('PO - RESTOSEHAT', body, { user: req.session }));
        });
      });
    });
  });
});

// GET /po/create (restaurant only) - preload suppliers & branches, allow unit_price per item
// Now supports ?orderId= to prefill items (name + qty) from an order (for receiver to make PO)
router.get('/po/create', ensureAuth, (req, res) => {
  if (req.session.role !== 'restaurant') return res.send(renderLayout('Buat PO', `<div class="error-box">Hanya staff restoran yang dapat membuat PO.</div>`, { user: req.session }));

  const orderId = req.query.orderId ? String(req.query.orderId) : null;

  db.query("SELECT id, username, full_name FROM users WHERE role = 'supplier' ORDER BY id", [], (errS, suppliers) => {
    if (errS) { console.error('GET /po/create - suppliers select error:', errS); suppliers = []; }
    db.query('SELECT id, name FROM branches ORDER BY id', [], (errB, branches) => {
      if (errB) { console.error('GET /po/create - branches select error:', errB); branches = []; }

      const suppliersOptions = (suppliers || []).map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.full_name || s.username)} (S:${escapeHtml(String(s.id))})</option>`).join('');

      if (!orderId) {
        // original behaviour (manual PO create)
        const body = `
          <div class="page card">
            <h2>Buat Purchase Order (PO)</h2>
            <form id="poForm">
              <label>Asal Cabang</label>
              <input name="branch_id" id="branch_id" value="${escapeHtml(String(req.session.branchId||''))}" readonly />

              <label>Tujuan</label>
              <select id="dest_type" name="dest_type">
                <option value="supplier">Supplier</option>
                <option value="branch">Cabang Lain (Internal Transfer)</option>
              </select>
              <div id="dest_wrap">
                <select id="dest_select" name="dest_select">
                  ${suppliersOptions}
                </select>
              </div>

              <label>Items (masukkan harga per satuan untuk tiap item jika ada)</label>
              <div id="itemsArea">
                <div class="itemRow">
                  <input list="itemsList" name="item_id" placeholder="Item ID atau ketik baru" required />
                  <input name="qty" type="number" value="1" required />
                  <input name="unit_price" type="text" placeholder="Harga per satuan (opsional)" />
                  <button type="button" class="rmRow">-</button>
                </div>
              </div>
              <datalist id="itemsList"></datalist>
              <div style="margin-top:8px"><button type="button" id="addItem">+ Tambah Item</button></div>
              <div style="margin-top:8px"><strong>Total: </strong><span id="totalVal">0.00</span></div>
              <div style="margin-top:8px"><button type="submit">Buat PO</button></div>
            </form>
          </div>

          <script>
            const _suppliersData = ${JSON.stringify(suppliers || [])};
            const _branchesData = ${JSON.stringify(branches || [])};

            function fillDest(type){
              const el = document.getElementById('dest_select');
              if (type === 'supplier') {
                el.innerHTML = _suppliersData.map(s=>'<option value=\"'+s.id+'\">'+(s.full_name||s.username)+' (S:'+s.id+')</option>').join('');
              } else {
                el.innerHTML = _branchesData.filter(b=>String(b.id)!=='${escapeHtml(String(req.session.branchId||''))}').map(b=>'<option value=\"'+b.id+'\">'+b.name+' (B:'+b.id+')</option>').join('');
              }
            }

            (function(){
              fetch('/api/items').then(r => r.ok ? r.json() : []).then(items => {
                document.getElementById('itemsList').innerHTML = (items||[]).map(it=>'<option value=\"'+it.id+'\">'+(it.name||'')+'</option>').join('');
              }).catch(()=>{});

              document.getElementById('dest_type').addEventListener('change', function(){ fillDest(this.value); });
              fillDest(document.getElementById('dest_type').value);

              document.getElementById('addItem').addEventListener('click', function(){
                const d = document.createElement('div'); d.className='itemRow';
                d.innerHTML = '<input list=\"itemsList\" name=\"item_id\" placeholder=\"Item ID atau ketik baru\" required /> <input name=\"qty\" type=\"number\" value=\"1\" required /> <input name=\"unit_price\" type=\"text\" placeholder=\"Harga per satuan (opsional)\" /> <button type=\"button\" class=\"rmRow\">-</button>';
                document.getElementById('itemsArea').appendChild(d);
                attachUnitPriceHandlers();
              });
              document.getElementById('itemsArea').addEventListener('click', function(e){
                if (e.target && e.target.classList.contains('rmRow')) e.target.parentNode.remove();
              });

              function attachUnitPriceHandlers(){
                document.querySelectorAll('#itemsArea .itemRow').forEach(row => {
                  const up = row.querySelector('input[name=\"unit_price\"]');
                  const qty = row.querySelector('input[name=\"qty\"]');
                  const item = row.querySelector('input[name=\"item_id\"]');
                  // create subtotal span if not exists
                  if (!row.querySelector('.subtotal')) {
                    const span = document.createElement('span');
                    span.className = 'subtotal';
                    span.style.marginLeft = '8px';
                    span.innerText = 'Subtotal: 0.00';
                    row.appendChild(span);
                  }
                  function recalc(){
                    const q = Number(qty.value)||0;
                    let p = parseFloat((up && up.value) ? up.value.replace(/[^0-9\.]/g,'') : 0) || 0;
                    const s = (q * p).toFixed(2);
                    row.querySelector('.subtotal').innerText = 'Subtotal: ' + s;
                    recalcTotal();
                  }
                  if (up) up.removeEventListener('input', recalc);
                  if (qty) qty.removeEventListener('input', recalc);
                  if (up) up.addEventListener('input', recalc);
                  if (qty) qty.addEventListener('input', recalc);
                });
              }
              function recalcTotal(){
                let tot = 0;
                document.querySelectorAll('#itemsArea .itemRow').forEach(row=>{
                  const q = Number(row.querySelector('input[name=\"qty\"]').value)||0;
                  const upv = row.querySelector('input[name=\"unit_price\"]').value || '';
                  const p = parseFloat(String(upv).replace(/[^0-9\.]/g,''))||0;
                  tot += q*p;
                });
                document.getElementById('totalVal').innerText = tot.toFixed(2);
              }
              attachUnitPriceHandlers();

              document.getElementById('poForm').addEventListener('submit', async function(e){
                e.preventDefault();
                const branch_id = document.getElementById('branch_id').value;
                const dest_type = document.getElementById('dest_type').value;
                const dest_select = document.getElementById('dest_select').value;
                const itemRows = Array.from(document.querySelectorAll('#itemsArea .itemRow'));
                const items = itemRows.map(r => ({
                  item_id: r.querySelector('input[name=item_id]').value.trim(),
                  qty: Number(r.querySelector('input[name=qty]').value),
                  unit_price: r.querySelector('input[name=unit_price]').value ? r.querySelector('input[name=unit_price]').value.trim() : null
                })).filter(it=>it.item_id && it.qty>0);
                if (!branch_id) return alert('Asal cabang tidak terbaca');
                if (!dest_select) return alert('Pilih tujuan');
                if (items.length === 0) return alert('Isi minimal 1 item');
                try {
                  const res = await fetch('/api/po', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ supplier_id: dest_type==='supplier' ? dest_select : null, branch_id: branch_id, to_branch: dest_type==='branch' ? dest_select : null, items })});
                  if (!res.ok) {
                    const txt = await res.text(); throw new Error(txt || 'Gagal buat PO');
                  }
                  alert('PO dibuat');
                  location.href = '/po';
                } catch(err) {
                  alert('Gagal membuat PO: ' + (err.message||''));
                }
              });
            })();
          </script>
        `;
        return res.send(renderLayout('Buat PO', body, { user: req.session }));
      }

      // --- if orderId provided: preload order + items and render prefilled PO form ---
      db.query('SELECT o.id, o.from_id, o.to_id, o.status, o.from_type FROM orders o WHERE o.id = ? LIMIT 1', [orderId], (errO, ordRows) => {
        if (errO || !ordRows || ordRows.length === 0) {
          console.error('GET /po/create - order not found or error:', errO);
          return res.send(renderLayout('Buat PO', `<div class="error-box">Order tidak ditemukan atau error.</div>`, { user: req.session }));
        }
        const order = ordRows[0];
        // only receiver should be here (defensive)
        if (!(String(req.session.branchId) === String(order.to_id) || (req.session.role === 'supplier' && String(req.session.userId) === String(order.to_id)))) {
          return res.send(renderLayout('Buat PO', `<div class="error-box">Anda tidak berwenang membuat PO dari order ini.</div>`, { user: req.session }));
        }
        db.query('SELECT item_id, qty FROM order_items WHERE order_id = ?', [orderId], (errItems, oitems) => {
          if (errItems) { console.error('GET /po/create - order_items error:', errItems); oitems = []; }

          // build items rows (readonly item & qty, editable unit_price)
          const itemsHtml = (oitems||[]).map(it => {
            return `<div class="itemRow">
                      <input name="item_id" value="${escapeHtml(it.item_id)}" readonly />
                      <input name="qty" type="number" value="${escapeHtml(String(it.qty))}" readonly />
                      <input name="unit_price" type="text" placeholder="Harga per satuan (isi)" />
                      <span class="subtotal">Subtotal: 0.00</span>
                    </div>`;
          }).join('');

          // dest_select should be original order.from_id (pengirim)
          const destPrefill = escapeHtml(String(order.from_id || ''));

          const body = `
            <div class="page card">
              <h2>Buat Purchase Order (PO) (dari Order #${escapeHtml(orderId)})</h2>
              <form id="poForm">
                <label>Asal Cabang</label>
                <input name="branch_id" id="branch_id" value="${escapeHtml(String(req.session.branchId||''))}" readonly />

                <label>Tujuan</label>
                <select id="dest_type" name="dest_type" disabled>
                  <option value="branch">Cabang (pengirim order)</option>
                </select>
                <div id="dest_wrap">
                  <select id="dest_select" name="dest_select" disabled>
                    <option value="${destPrefill}">${escapeHtml('Branch ' + String(order.from_id))}</option>
                  </select>
                </div>

                <label>Items (diambil dari order; hanya isi harga per satuan)</label>
                <div id="itemsArea">
                  ${itemsHtml}
                </div>
                <div style="margin-top:8px"><strong>Total: </strong><span id="totalVal">0.00</span></div>
                <div style="margin-top:8px"><button type="submit">Buat PO</button></div>
              </form>
            </div>

            <script>
              (function(){
                function recalcRow(row){
                  const q = Number(row.querySelector('input[name=\"qty\"]').value)||0;
                  const upv = row.querySelector('input[name=\"unit_price\"]').value || '';
                  const p = parseFloat(String(upv).replace(/[^0-9\.]/g,''))||0;
                  const s = (q*p).toFixed(2);
                  row.querySelector('.subtotal').innerText = 'Subtotal: ' + s;
                }
                function recalcTotal(){
                  let tot = 0;
                  document.querySelectorAll('#itemsArea .itemRow').forEach(row=>{
                    const q = Number(row.querySelector('input[name=\"qty\"]').value)||0;
                    const upv = row.querySelector('input[name=\"unit_price\"]').value || '';
                    const p = parseFloat(String(upv).replace(/[^0-9\.]/g,''))||0;
                    tot += q*p;
                  });
                  document.getElementById('totalVal').innerText = tot.toFixed(2);
                }

                document.querySelectorAll('#itemsArea .itemRow').forEach(row => {
                  const up = row.querySelector('input[name=\"unit_price\"]');
                  if (up) up.addEventListener('input', function(){ recalcRow(row); recalcTotal(); });
                  // initialize
                  recalcRow(row);
                });
                recalcTotal();

                document.getElementById('poForm').addEventListener('submit', async function(e){
                  e.preventDefault();
                  const branch_id = document.getElementById('branch_id').value;
                  const dest_select = document.getElementById('dest_select').value;
                  const itemRows = Array.from(document.querySelectorAll('#itemsArea .itemRow'));
                  const items = itemRows.map(r => ({ item_id: r.querySelector('input[name=item_id]').value.trim(), qty: Number(r.querySelector('input[name=qty]').value), unit_price: r.querySelector('input[name=unit_price]').value ? r.querySelector('input[name=unit_price]').value.trim() : null })).filter(it=>it.item_id && it.qty>0);
                  if (!branch_id) return alert('Asal cabang tidak terbaca');
                  if (!dest_select) return alert('Tujuan tidak terbaca');
                  if (items.length === 0) return alert('Isi minimal 1 item');
                  try {
                    // create as internal order (branch -> branch) by using to_branch
                    // *** IMPORTANT FIX: include orig_order_id so the server can store the mapping to the original order
                    const res = await fetch('/api/po', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ supplier_id: null, branch_id: branch_id, to_branch: dest_select, orig_order_id: ${JSON.stringify(orderId)}, items })});
                    if (!res.ok) {
                      const txt = await res.text(); throw new Error(txt || 'Gagal buat PO/Internal Order');
                    }
                    alert('PO (internal order) dibuat');
                    location.href = '/po';
                  } catch(err) {
                    alert('Gagal membuat PO: ' + (err.message||''));
                  }
                });
              })();
            </script>
          `;
          res.send(renderLayout('Buat PO (dari Order)', body, { user: req.session }));
        });
      });
    });
  });
});

// API create PO - supports supplier_id (PO) or to_branch (internal order). Sanitize unit_price.
// NEW: if payload contains orig_order_id -> try to insert into purchase_orders with orig_order_id (defensive)
router.post('/api/po', ensureAuth, (req, res) => {
  if (req.session.role !== 'restaurant') return res.status(403).json({ error: 'Hanya staff restoran yang dapat membuat PO' });
  const supplier_id = req.body.supplier_id || null;
  const branch_id = req.body.branch_id || req.session.branchId;
  const to_branch = req.body.to_branch || null;
  const orig_order_id = req.body.orig_order_id || null;
  const items = req.body.items;
  if (!branch_id || !items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'missing fields' });
  for (const it of items) {
    if (!it.item_id || !/^[A-Za-z0-9\-_]+$/.test(it.item_id)) return res.status(400).json({ error: 'invalid item_id' });
    if (!Number.isFinite(Number(it.qty)) || Number(it.qty) <= 0) return res.status(400).json({ error: 'invalid qty' });
  }

    if (to_branch) {
    // create as a Purchase Order record (internal PO) instead of a plain 'orders' record.
    // We'll try to use purchase_orders.to_branch or purchase_orders.orig_order_id if available.
    // Defensive: detect schema columns first.
    db.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME IN ('to_branch','orig_order_id')", [], (colErr, cols) => {
      if (colErr) {
        console.error('api/po -> schema detect error:', colErr);
        return res.status(500).json({ error: 'DB error' });
      }
      const hasToBranch = (cols || []).some(c => String(c.COLUMN_NAME).toLowerCase() === 'to_branch');
      const hasOrigOrder = (cols || []).some(c => String(c.COLUMN_NAME).toLowerCase() === 'orig_order_id');

      // build insert dynamically depending on detected cols
      let insertSql, insertParams;
      if (hasToBranch && hasOrigOrder) {
        insertSql = 'INSERT INTO purchase_orders (created_by, supplier_id, branch_id, to_branch, orig_order_id, status, created_at) VALUES (?,?,?,?,?,?,NOW())';
        insertParams = [req.session.userId, null, branch_id, to_branch, req.body.orig_order_id || null, 'PENDING'];
      } else if (hasToBranch) {
        insertSql = 'INSERT INTO purchase_orders (created_by, supplier_id, branch_id, to_branch, status, created_at) VALUES (?,?,?,?,NOW())';
        insertParams = [req.session.userId, null, branch_id, to_branch, 'PENDING'];
      } else if (hasOrigOrder) {
        insertSql = 'INSERT INTO purchase_orders (created_by, supplier_id, branch_id, orig_order_id, status, created_at) VALUES (?,?,?,?,?,NOW())';
        insertParams = [req.session.userId, null, branch_id, req.body.orig_order_id || null, 'PENDING'];
      } else {
        // no special column available — still try to create a purchase_orders record
        insertSql = 'INSERT INTO purchase_orders (created_by, supplier_id, branch_id, status, created_at) VALUES (?,?,?,?,NOW())';
        insertParams = [req.session.userId, null, branch_id, 'PENDING'];
      }

      db.query(insertSql, insertParams, (errPo, rPo) => {
        if (errPo) {
          console.error('api/po -> insert purchase_orders error:', errPo);
          // If the insert failed due to unknown column or schema mismatch, return a clear error
          return res.status(500).json({ error: 'Gagal membuat PO pada tabel purchase_orders. Periksa skema DB (kolom to_branch/orig_order_id mungkin diperlukan).' });
        }
        const poId = rPo.insertId;
        const stmts = items.map(it => new Promise((resolve) => {
          // sanitize unit_price
          let unitPrice = null;
          if (it.unit_price !== undefined && it.unit_price !== null && String(it.unit_price).trim() !== '') {
            const cleaned = String(it.unit_price).replace(/[^0-9\.\-]/g, '');
            const parsed = parseFloat(cleaned);
            if (!Number.isNaN(parsed)) unitPrice = parsed;
            else unitPrice = null;
          }
          db.query('INSERT INTO po_items (po_id, item_id, qty, unit_price) VALUES (?,?,?,?)', [poId, it.item_id, it.qty, unitPrice], (err2) => {
            if (err2) {
              console.error('po_items insert error for poId', poId, err2);
              // try fallback without unit_price
              db.query('INSERT INTO po_items (po_id, item_id, qty) VALUES (?,?,?)', [poId, it.item_id, it.qty], () => resolve());
            } else resolve();
          });
        }));
        Promise.all(stmts).then(() => {
          broadcastEvent('po_created', { id: poId, branch_id, to_branch, items });
          res.json({ ok:true, poId, createdAs: 'po' });
        });
      });
    });
  } else {
    // existing supplier PO path (unchanged)
    db.query('INSERT INTO purchase_orders (created_by, supplier_id, branch_id, status, created_at) VALUES (?,?,?,?,NOW())', [req.session.userId, supplier_id, branch_id, 'PENDING'], (err, r) => {
      if (err) { console.error('api/po -> insert purchase_orders error:', err); return res.status(500).json({ error: 'DB error' }); }
      const poId = r.insertId;
      const stmts = items.map(it => new Promise((resolve) => {
        // sanitize unit_price: number or null
        let unitPrice = null;
        if (it.unit_price !== undefined && it.unit_price !== null && String(it.unit_price).trim() !== '') {
          const cleaned = String(it.unit_price).replace(/[^0-9\.\-]/g, '');
          const parsed = parseFloat(cleaned);
          if (!Number.isNaN(parsed)) unitPrice = parsed;
          else unitPrice = null;
        }
        db.query('INSERT INTO po_items (po_id, item_id, qty, unit_price) VALUES (?,?,?,?)', [poId, it.item_id, it.qty, unitPrice], (err2) => {
          if (err2) {
            console.error('po_items insert error with unit_price, trying without unit_price:', err2);
            db.query('INSERT INTO po_items (po_id, item_id, qty) VALUES (?,?,?)', [poId, it.item_id, it.qty], () => resolve());
          } else resolve();
        });
      }));
      Promise.all(stmts).then(() => {
        broadcastEvent('po_created', { id: poId, branch_id, supplier_id, items });
        res.json({ ok:true, poId, createdAs: 'po' });
      });
    });
  }

});

// supplier actions for PO (unchanged except keep ship & deliver)
// NOTE: we also handle ship for PO created from orig_order_id: when shipped we will update original order to 'dikirimkan' if mapping exists
router.post('/api/po/:poId/ship', ensureAuth, (req, res) => {
  const poId = req.params.poId;
  // allow either supplier to ship (if supplier_id matches) OR allow the creator (branch) who created PO to ship internal transfer
  db.query('SELECT * FROM purchase_orders WHERE id = ? LIMIT 1', [poId], (err, rows) => {
    if (err) { console.error('api/po/:poId/ship select error:', err); return res.status(500).send('DB error'); }
    if (!rows || rows.length === 0) return res.status(404).send('PO tidak ditemukan');
    const po = rows[0];
    // Two cases:
    // - If supplier_id is set: then only supplier can mark shipped (ensure role supplier and userId matches)
    // - If supplier_id is null: allow creator (created_by) to mark shipped (this is for internal branch->branch flows where branch made PO)
    if (po.supplier_id) {
      if (!(req.session.role === 'supplier' && String(req.session.userId) === String(po.supplier_id))) {
        return res.status(403).send('Hanya supplier yang bisa mengirim PO ini');
      }
    } else {
      // allow creator to ship (creator may be branch staff)
      if (String(po.created_by) !== String(req.session.userId)) {
        return res.status(403).send('Hanya pembuat PO yang bisa menandai kirim');
      }
    }

    db.query('UPDATE purchase_orders SET status = ?, shipped_at = NOW() WHERE id = ? AND status IN (?,?)', ['SHIPPED', poId, 'PENDING', 'APPROVED'], (err2, r) => {
      if (err2) { console.error('api/po/:poId/ship error:', err2); return res.status(500).send('DB error'); }
      if (r.affectedRows === 0) return res.status(400).send('PO tidak dalam status yang bisa dikirim');
      // If this PO maps to an orig_order_id, update that order status to dikirimkan
      if (po.orig_order_id) {
        db.query('UPDATE orders SET status = ?, shipped_at = NOW() WHERE id = ?', ['dikirimkan', po.orig_order_id], (e3) => {
          if (e3) console.error('api/po/:poId/ship update orig order error:', e3);
          db.query('SELECT * FROM purchase_orders WHERE id = ?', [poId], (e4, newRows) => {
            if (!e4 && newRows && newRows[0]) broadcastEvent('po_shipped', newRows[0]);
            return res.redirect('/po');
          });
        });
      } else {
        db.query('SELECT * FROM purchase_orders WHERE id = ?', [poId], (e4, newRows) => {
          if (!e4 && newRows && newRows[0]) broadcastEvent('po_shipped', newRows[0]);
          return res.redirect('/po');
        });
      }
    });
  });
});

router.post('/api/po/:poId/deliver', ensureAuth, ensureSupplier, (req, res) => {
  const poId = req.params.poId;
  db.query('UPDATE purchase_orders SET status = ?, delivered_at = NOW() WHERE id = ? AND status = ?', ['DELIVERED', poId, 'SHIPPED'], (err, r) => {
    if (err) { console.error('api/po/:poId/deliver error:', err); return res.status(500).send('DB error'); }
    if (r.affectedRows === 0) return res.status(400).send('PO tidak dalam SHIPPED');
    db.query('SELECT * FROM purchase_orders WHERE id = ?', [poId], (e, rows) => {
      if (!e && rows && rows[0]) broadcastEvent('po_delivered', rows[0]);
      res.redirect('/po');
    });
  });
});

// receive PO (restaurant) - unchanged, but it works for purchase_orders that were shipped and destined to this branch
router.post('/api/po/:poId/receive', ensureAuth, (req, res) => {
  const poId = req.params.poId;
  if (req.session.role !== 'restaurant') return res.status(403).send('Only restaurant can receive PO');
  db.query('SELECT * FROM purchase_orders WHERE id = ? AND status = ?', [poId, 'DELIVERED'], (err, rows) => {
    if (err) { console.error('api/po/:poId/receive select error:', err); return res.status(500).send('DB error'); }
    if (!rows || rows.length === 0) return res.status(400).send('PO tidak dalam DELIVERED');
    const po = rows[0];
    // check branch ownership: ensure this PO was intended for this branch. We stored branch_id as origin branch (creator's branch).
    // If PO.orig_order_id exists we can check original order to confirm recipient
    const proceedToUpdateInventory = (targetBranchId) => {
      db.query('SELECT item_id, qty FROM po_items WHERE po_id = ?', [poId], (err2, items) => {
        if (err2) { console.error('api/po/:poId/receive items select error:', err2); return res.status(500).send('DB error'); }
        const tasks = items.map(it => new Promise((resolve) => {
          db.query('SELECT qty FROM inventory WHERE branch_id = ? AND item_id = ?', [targetBranchId, it.item_id], (e3, r3) => {
            if (e3) { console.error('api/po/:poId/receive inventory select error:', e3); return resolve(); }
            if (!r3 || r3.length === 0) {
              db.query('INSERT INTO inventory (branch_id, item_id, qty, reorder_level) VALUES (?,?,?,?)', [targetBranchId, it.item_id, it.qty, 5], () => resolve());
            } else {
              db.query('UPDATE inventory SET qty = qty + ? WHERE branch_id = ? AND item_id = ?', [it.qty, targetBranchId, it.item_id], () => resolve());
            }
          });
        }));
        Promise.all(tasks).then(() => {
          db.query('UPDATE purchase_orders SET status = ?, received_at = NOW() WHERE id = ?', ['RECEIVED', poId], (er) => {
            if (er) { console.error('api/po/:poId/receive update error:', er); return res.status(500).send('DB error'); }
            db.query('SELECT * FROM purchase_orders WHERE id = ?', [poId], (sqe, newRows) => {
              if (!sqe && newRows && newRows[0]) broadcastEvent('po_received', newRows[0]);
              res.redirect('/po');
            });
          });
        });
      });
    };

    if (po.orig_order_id) {
      // fetch original order to determine receiver
      db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [po.orig_order_id], (er2, ords) => {
        if (er2 || !ords || ords.length === 0) return res.status(400).send('Order asli tidak ditemukan');
        const orig = ords[0];
        // If current user branch is original from_id -> they are the creator; but the receiver/target is the other side. We need to check that current branch is the rightful recipient
        // In our flow orig_order was created by branch A to branch B. The PO was created by branch B (receiver) and targeted to branch A (creator). So when branch A receives shipment, we should allow receiving if req.session.branchId === orig.from_id
        if (String(req.session.branchId) !== String(orig.from_id)) {
          return res.status(403).send('PO bukan untuk cabang Anda');
        }
        proceedToUpdateInventory(orig.from_id);
      });
    } else {
      // fallback: if purchase_orders.supplier_id exists -> target is branch_id (origin)?? This depends on your schema. We'll assume the PO delivered is for branch_id (origin branch) if branch_id === recipient branch.
      // Here we check that the receiving branch is the branch that requested the PO (po.branch_id)
      // This is conservative: if uncertain, verify DB schema.
      if (String(po.branch_id) !== String(req.session.branchId)) {
        return res.status(403).send('PO bukan untuk cabang Anda');
      }
      proceedToUpdateInventory(po.branch_id);
    }
  });
});

module.exports = router;
