/* routes/orders.js */
const express = require('express');
const router = express.Router();
const db = require('../scripts/db.js');
const { escapeHtml, renderLayout } = require('../utils');
const { ensureAuth } = require('../middleware/auth');
const { broadcastEvent } = require('../events');

// ----------------- ORDERS -----------------
router.get('/orders', ensureAuth, (req, res) => {
  // NEW: visibility filtering:
  const role = req.session.role;
  const userId = req.session.userId;
  const branchId = req.session.branchId;

  // We will detect whether orders table has to_type column to allow proper filtering
  db.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'to_type'", [], (colErr, colRows) => {
    const hasToType = !(colErr || !colRows || colRows.length === 0);
    // Build query & params based on role:
    let q = '';
    let params = [];

    if (role === 'restaurant') {
      // show orders created by this branch (creator view)
      // AND show incoming orders for this branch only if status != 'pending'
      if (hasToType) {
        q = `SELECT * FROM orders WHERE (from_type = 'branch' AND from_id = ?) OR (to_type = 'branch' AND to_id = ? AND (LOWER(status) <> 'pending' AND LOWER(status) <> 'peding')) ORDER BY created_at DESC LIMIT 200`;
        params = [branchId, branchId];
      } else {
        q = `SELECT * FROM orders WHERE (from_type = 'branch' AND from_id = ?) OR (to_id = ? AND (LOWER(status) <> 'pending' AND LOWER(status) <> 'peding')) ORDER BY created_at DESC LIMIT 200`;
        params = [branchId, branchId];
      }
    } else if (role === 'supplier') {
      // supplier sees only orders that were sent to them and status != pending
      if (hasToType) {
        q = `SELECT * FROM orders WHERE to_type = 'supplier' AND to_id = ? AND (LOWER(status) <> 'pending' AND LOWER(status) <> 'peding') ORDER BY created_at DESC LIMIT 200`;
        params = [userId];
      } else {
        q = `SELECT * FROM orders WHERE to_id = ? AND (LOWER(status) <> 'pending' AND LOWER(status) <> 'peding') ORDER BY created_at DESC LIMIT 200`;
        params = [userId];
      }
    } else {
      // admin/pimpinan: show recent orders (unchanged)
      q = `SELECT * FROM orders ORDER BY created_at DESC LIMIT 200`;
      params = [];
    }

    db.query(q, params, (err, orders) => {
      if (err) {
        console.error('GET /orders - SELECT orders error:', err);
        return res.send(renderLayout('Orders', `<div class="error-box">Error: ${escapeHtml(err.message)}</div>`, { user: req.session }));
      }

      const orderIds = (orders || []).map(o => o.id);
      // NEW: fetch item names for orders
      const qItems = orderIds.length ? 'SELECT oi.order_id, oi.item_id, oi.qty, it.name FROM order_items oi LEFT JOIN items it ON oi.item_id = it.id WHERE oi.order_id IN (' + orderIds.join(',') + ')' : null;

      // preload branches & suppliers for combobox
      db.query('SELECT id, name FROM branches ORDER BY id', [], (errB, branches) => {
        if (errB) { console.error('GET /orders - branches error:', errB); branches = []; }
        db.query("SELECT id, username, full_name FROM users WHERE role = 'supplier' ORDER BY id", [], (errS, suppliers) => {
          if (errS) { console.error('GET /orders - suppliers error:', errS); suppliers = []; }

          if (!qItems) {
            // no items to fetch
            renderOrdersPage(orders, [], branches, suppliers, req, res);
          } else {
            db.query(qItems, [], (err2, items) => {
              if (err2) {
                console.error('GET /orders - order_items error:', err2);
                items = [];
              }
              renderOrdersPage(orders, items, branches, suppliers, req, res);
            });
          }
        });
      });
    });
  });
});

// ---------- renderOrdersPage (updated to show item name + qty, visibility controls kept) ----------
function renderOrdersPage(orders, items, branches, suppliers, req, res) {
  const itemsByOrder = {};
  (items||[]).forEach(it => { itemsByOrder[it.order_id] = itemsByOrder[it.order_id] || []; itemsByOrder[it.order_id].push(it); });

  const rows = (orders||[]).map(o => {
    // items show: nama (jika ada) atau id + " xN"
    const its = (itemsByOrder[o.id]||[]).map(i => `${escapeHtml(i.name || i.item_id)} x${escapeHtml(i.qty)}`).join(', ');
    let actions = '';
    const st = String(o.status || '').toLowerCase();

    const isCreator = (req.session.role === 'restaurant' && String(req.session.branchId) === String(o.from_id));
    const isReceiver = ( (req.session.role === 'restaurant' && String(req.session.branchId) === String(o.to_id)) || (req.session.role === 'supplier' && String(req.session.userId) === String(o.to_id)) );

    // Creator actions:
    // - Jika creator dan status pending => tombol Kirim
    if (isCreator && (st === 'pending' || st === 'peding')) {
      actions += `<form style="display:inline" method="post" action="/api/order/${o.id}/kirim" onsubmit="return confirm('Kirim order ini?');"><button type="submit">Kirim</button></form> `;
    }

    // If creator and status == dikirimkan => creator can "Terima" to finish & add inventory
    if (isCreator && (st === 'dikirimkan' || st === 'shipped')) {
      actions += `<form style="display:inline" method="post" action="/api/order/${o.id}/finish_by_creator" onsubmit="return confirm('Selesaikan order ini dan tambah inventory?');"><button type="submit">Terima</button></form> `;
    }

    // Receiver actions:
    // - Jika penerima dan status menunggu => tampilkan tombol "Buat PO" yang akan redirect ke form PO terisi otomatis
    if (isReceiver && (st === 'menunggu' || st === 'waiting')) {
      actions += `<form style="display:inline" method="get" action="/po/create" onsubmit="return true;"><input type="hidden" name="orderId" value="${escapeHtml(o.id)}" /><button type="submit">Buat PO</button></form> `;
    }

    return `<tr>
      <td>ORD-${o.id}</td>
      <td>${escapeHtml(o.from_type || '')} ${escapeHtml(String(o.from_id||''))}</td>
      <td>${escapeHtml(String(o.to_id||''))}</td>
      <td>${escapeHtml(String(o.status||''))}</td>
      <td>${escapeHtml(its)}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');

  const branchesJson = JSON.stringify(branches || []);
  const suppliersJson = JSON.stringify(suppliers || []);

  // Create order form unchanged (kept as-is to avoid breaking other flows)
  const createForm = `
    <div style="margin-bottom:12px">
      <h3>Buat Order Baru</h3>
      <form id="createOrderForm">
        <label>Asal Cabang</label>
        ${req.session.role === 'restaurant'
          ? `<input name="from_id" id="from_id" value="${escapeHtml(req.session.branchId||'')}" readonly />`
          : `<select id="from_select" name="from_id"><option value="">Pilih cabang asal</option>${(branches||[]).map(b=>'<option value="'+escapeHtml(b.id)+'">'+escapeHtml(b.name)+' ('+escapeHtml(b.id)+')</option>').join('')}</select>`
        }

        <label>Tujuan Order</label>
        <select id="to_type" name="to_type">
          <option value="supplier">Supplier</option>
          <option value="branch">Cabang Lain</option>
        </select>
        <div id="to_target_wrap">
          <select id="to_target" name="to_target"></select>
        </div>

        <label>Items</label>
        <div id="itemsArea">
          <div class="itemRow">
            <input list="itemsList" name="item_id" placeholder="Item ID atau ketik baru" required />
            <input name="qty" type="number" placeholder="Qty" value="1" required />
            <button type="button" class="rmRow">-</button>
          </div>
        </div>
        <datalist id="itemsList"></datalist>
        <div style="margin-top:8px"><button type="button" id="addItem">+ Tambah Item</button></div>
        <div style="margin-top:8px"><button type="submit">Buat Order</button></div>
      </form>
    </div>

    <script>
      const _branchesData = ${branchesJson};
      const _suppliersData = ${suppliersJson};

      function fillTargetsFromData(type){
        const el = document.getElementById('to_target');
        if (type === 'supplier') {
          el.innerHTML = _suppliersData.map(s=>'<option value=\"'+s.id+'\">'+(s.full_name||s.username)+' (S:'+s.id+')</option>').join('');
        } else {
          el.innerHTML = _branchesData.map(b=>'<option value=\"'+b.id+'\">'+b.name+' (B:'+b.id+')</option>').join('');
        }
      }

      (function(){
        fetch('/api/items').then(r=>r.ok? r.json() : []).then(items=>{
          document.getElementById('itemsList').innerHTML = (items||[]).map(it=>'<option value=\"'+it.id+'\">'+(it.name||'')+'</option>').join('');
        }).catch(()=>{});

        fillTargetsFromData(document.getElementById('to_type').value);
        document.getElementById('to_type').addEventListener('change', function(){ fillTargetsFromData(this.value); });

        document.getElementById('addItem').addEventListener('click', function(){
          const d = document.createElement('div');
          d.className='itemRow';
          d.innerHTML = '<input list=\"itemsList\" name=\"item_id\" placeholder=\"Item ID atau ketik baru\" required /> <input name=\"qty\" type=\"number\" placeholder=\"Qty\" value=\"1\" required /> <button type=\"button\" class=\"rmRow\">-</button>';
          document.getElementById('itemsArea').appendChild(d);
        });
        document.getElementById('itemsArea').addEventListener('click', function(e){
          if (e.target && e.target.classList.contains('rmRow')) e.target.parentNode.remove();
        });

        document.getElementById('createOrderForm').addEventListener('submit', async function(e){
          e.preventDefault();
          const from_id = ${req.session.role === 'restaurant' ? JSON.stringify(String(req.session.branchId||'')) : 'document.getElementById(\"from_select\").value'};
          if (!from_id) return alert('Pilih asal cabang');
          const to_type = document.getElementById('to_type').value;
          const to_target = document.getElementById('to_target').value;
          if (!to_target) return alert('Pilih tujuan (supplier atau cabang)');
          const itemRows = Array.from(document.querySelectorAll('#itemsArea .itemRow'));
          const items = itemRows.map(r => ({ item_id: r.querySelector('input[name=item_id]').value.trim(), qty: Number(r.querySelector('input[name=qty]').value) })).filter(it=>it.item_id && it.qty>0);
          if (items.length === 0) return alert('Isi minimal 1 item');
          try {
            const payload = { from_type:'branch', from_id: from_id, to_type: to_type, to_id: to_target, items };
            const res = await fetch('/api/order', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
            if (!res.ok) {
              const txt = await res.text();
              throw new Error(txt || 'Gagal membuat order');
            }
            alert('Order berhasil dibuat');
            location.reload();
          } catch(err) {
            alert('Gagal membuat order: ' + (err.message||''));
          }
        });
      })();
    </script>
  `;

  const body = `<div class="page card"><h2>Orders</h2>${createForm}<table class="data-table"><thead><tr><th>No</th><th>Dari</th><th>Ke</th><th>Status</th><th>Items</th><th>Aksi</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  res.send(renderLayout('Orders - RESTOSEHAT', body, { user: req.session }));
}

// API create manual order
router.post('/api/order', ensureAuth, (req, res) => {
  const { from_type = 'branch', from_id = null, to_type = 'supplier', to_id, items } = req.body;
  if (!from_id || !to_id || !items || !Array.isArray(items) || items.length === 0) return res.status(400).send('field tidak lengkap');
  for (const it of items) {
    if (!it.item_id || !/^[A-Za-z0-9\-_]+$/.test(it.item_id)) return res.status(400).send('invalid item_id');
    if (!Number.isFinite(Number(it.qty)) || Number(it.qty) <= 0) return res.status(400).send('invalid qty');
  }
  if (req.session.role === 'restaurant' && String(from_id) !== String(req.session.branchId)) return res.status(403).send('Asal cabang harus cabang Anda');

  // deteksi apakah kolom to_type tersedia pada tabel orders; jika ada, simpan juga
  db.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'to_type'", [], (colErr, colRows) => {
    if (colErr) {
      console.error('order insert schema detect error:', colErr);
      return res.status(500).send('DB error');
    }
    const hasToType = (colRows || []).length > 0;
    let insertSql, insertParams;
    if (hasToType) {
      insertSql = 'INSERT INTO orders (from_type, from_id, to_type, to_id, status, auto, created_at) VALUES (?,?,?,?,?,?,NOW())';
      insertParams = [from_type, from_id, to_type, to_id, 'pending', 0];
    } else {
      insertSql = 'INSERT INTO orders (from_type, from_id, to_id, status, auto, created_at) VALUES (?,?,?,?,?,NOW())';
      insertParams = [from_type, from_id, to_id, 'pending', 0];
    }

    db.query(insertSql, insertParams, (err, r) => {
      if (err) {
        console.error('Insert order error:', err);
        return res.status(500).send('DB error');
      }
      const orderId = r.insertId;
      const stmts = items.map(it => new Promise((resolve) => db.query('INSERT INTO order_items (order_id, item_id, qty) VALUES (?,?,?)', [orderId, it.item_id, it.qty], () => resolve())));
      Promise.all(stmts).then(() => {
        broadcastEvent('order_created', { ok:true, id: orderId, from_id, to_type, to_id, items });
        res.json({ ok: true, orderId });
      });
    });
  });
});

// endpoints for order flow: kirim -> menunggu, create_po_back by receiver (redirect to PO create), accept_po by creator -> dikirimkan; finish_by_creator -> selesai
router.post('/api/order/:orderId/kirim', ensureAuth, (req, res) => {
  const id = req.params.orderId;
  if (req.session.role !== 'restaurant') return res.status(403).send('Only restaurant can kirim');
  db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [id], (err, rows) => {
    if (err) { console.error('kirim select error:', err); return res.status(500).send('DB error'); }
    if (!rows || rows.length === 0) return res.status(404).send('Order tidak ditemukan');
    const order = rows[0];
    if (String(order.from_id) !== String(req.session.branchId)) return res.status(403).send('Order bukan dari cabang Anda');
    const cur = String(order.status || '').toLowerCase();
    if (cur !== 'pending' && cur !== 'peding') return res.status(400).send('Order bukan dalam status pending');
    db.query('UPDATE orders SET status = ?, shipped_at = NOW() WHERE id = ?', ['menunggu', id], (e) => {
      if (e) { console.error('kirim update error:', e); return res.status(500).send('DB error'); }
      db.query('SELECT * FROM orders WHERE id = ?', [id], (sqe, newRows) => {
        if (!sqe && newRows && newRows[0]) broadcastEvent('order_kirim', newRows[0]);
        res.redirect('/orders');
      });
    });
  });
});

// Create PO back: penerima menekan "Buat PO Balasan" => redirect ke /po/create?orderId=...
// Ganti handler lama dengan yang ini:
router.post('/api/order/:orderId/create_po_back', ensureAuth, (req, res) => {
  const id = req.params.orderId;
  db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [id], (err, rows) => {
    if (err) { console.error('create_po_back select error:', err); return res.status(500).send('DB error'); }
    if (!rows || rows.length === 0) return res.status(404).send('Order tidak ditemukan');
    const order = rows[0];

    // hanya penerima yang boleh membuat PO balasan
    // penerima bisa branch atau supplier
    const isBranchReceiver = (String(req.session.branchId) === String(order.to_id));
    const isSupplierReceiver = (req.session.role === 'supplier' && String(req.session.userId) === String(order.to_id));
    if (!isBranchReceiver && !isSupplierReceiver) {
      return res.status(403).send('Anda bukan penerima order ini');
    }

    const curStatus = String(order.status||'').toLowerCase();
    if (!(curStatus === 'menunggu' || curStatus === 'waiting')) return res.status(400).send('Order bukan pada status menunggu');

    // ambil item dari order asli
    db.query('SELECT item_id, qty FROM order_items WHERE order_id = ?', [id], (err2, items) => {
      if (err2) { console.error('create_po_back items select error:', err2); return res.status(500).send('DB error'); }
      // Build values for purchase_orders:
      // - created_by = current user id
      // - supplier_id = current user if supplier, else NULL
      // - branch_id = current user's branch id if branch user, else NULL
      // - to_branch = original order.from_id (the branch that requested)
      // - orig_order_id = id (link to original order)
      const createdBy = req.session.userId || null;
      const supplierId = (req.session.role === 'supplier') ? req.session.userId : null;
      const branchIdOfCreator = (req.session.branchId ? req.session.branchId : null);
      const toBranch = order.from_id || null;
      const origOrderId = id;

      // Try insert into purchase_orders with defensive columns (to_branch / orig_order_id)
      // First detect available columns
      db.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME IN ('to_branch','orig_order_id','created_by','supplier_id','branch_id','status')", [], (colErr, cols) => {
        if (colErr) { console.error('create_po_back schema detect error:', colErr); return res.status(500).send('DB error'); }
        // prefer to include to_branch & orig_order_id if present
        const colNames = (cols || []).map(c => String(c.COLUMN_NAME).toLowerCase());
        const hasToBranch = colNames.includes('to_branch');
        const hasOrigOrder = colNames.includes('orig_order_id');

        // Build insert SQL & params depending on detected columns
        let insertSql, insertParams;
        if (hasToBranch && hasOrigOrder) {
          insertSql = 'INSERT INTO purchase_orders (created_by, supplier_id, branch_id, to_branch, orig_order_id, status, created_at) VALUES (?,?,?,?,?, ?, NOW())';
          insertParams = [createdBy, supplierId, branchIdOfCreator, toBranch, origOrderId, 'PENDING'];
        } else if (hasToBranch) {
          insertSql = 'INSERT INTO purchase_orders (created_by, supplier_id, branch_id, to_branch, status, created_at) VALUES (?,?,?,?,?, NOW())';
          insertParams = [createdBy, supplierId, branchIdOfCreator, toBranch, 'PENDING'];
        } else if (hasOrigOrder) {
          insertSql = 'INSERT INTO purchase_orders (created_by, supplier_id, branch_id, orig_order_id, status, created_at) VALUES (?,?,?,?,?, NOW())';
          insertParams = [createdBy, supplierId, branchIdOfCreator, origOrderId, 'PENDING'];
        } else {
          // fallback: insert minimal columns (created_by, supplier_id, branch_id, status)
          insertSql = 'INSERT INTO purchase_orders (created_by, supplier_id, branch_id, status, created_at) VALUES (?,?,?,?, NOW())';
          insertParams = [createdBy, supplierId, branchIdOfCreator, 'PENDING'];
        }

        db.query(insertSql, insertParams, (errPo, rPo) => {
          if (errPo) {
            console.error('create_po_back -> insert purchase_orders error:', errPo);
            return res.status(500).send('Gagal membuat PO. Periksa skema DB purchase_orders.');
          }
          const poId = rPo.insertId;
          const stmts = (items || []).map(it => new Promise((resolve) => {
            // unit_price unknown here (receiver membuat PO dari order) => leave null; user will set unit_price later in PO edit if needed
            db.query('INSERT INTO po_items (po_id, item_id, qty) VALUES (?,?,?)', [poId, it.item_id, it.qty], (err3) => {
              if (err3) {
                console.error('create_po_back -> po_items insert error:', err3);
                // try fallback without causing crash
              }
              resolve();
            });
          }));

          Promise.all(stmts).then(() => {
            broadcastEvent('po_back_created', { id: poId, from: branchIdOfCreator, to: toBranch, orig_order_id: origOrderId, items });
            // redirect to /po so pengirim (original requester) can see PO Masuk
            res.redirect('/po');
          }).catch((e) => {
            console.error('create_po_back -> po_items promise error:', e);
            res.redirect('/po');
          });
        });
      });
    });
  });
});

// Creator accepts PO that was created from order (we implemented purchase_orders insertion with orig_order_id)
// New endpoint: approve PO (sets purchase_orders.status = 'APPROVED' and optionally will not yet ship)
router.post('/api/po/:poId/approve', ensureAuth, (req, res) => {
  const poId = req.params.poId;
  // only allow if current user is creator of original order
  db.query('SELECT * FROM purchase_orders WHERE id = ? LIMIT 1', [poId], (err, rows) => {
    if (err) { console.error('api/po/:poId/approve select error:', err); return res.status(500).send('DB error'); }
    if (!rows || rows.length === 0) return res.status(404).send('PO tidak ditemukan');
    const po = rows[0];
    if (!po.orig_order_id) {
      // cannot map to original order; disallow approve via this flow
      return res.status(400).send('PO ini tidak terhubung ke order asli (orig_order_id tidak ada).');
    }
    // fetch original order to confirm current user (branch) is owner (from_id)
    db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [po.orig_order_id], (e2, orders) => {
      if (e2) { console.error('api/po/:poId/approve orig order select error:', e2); return res.status(500).send('DB error'); }
      if (!orders || orders.length === 0) return res.status(404).send('Order asli tidak ditemukan');
      const orig = orders[0];
      if (String(orig.from_id) !== String(req.session.branchId)) {
        return res.status(403).send('Anda bukan pembuat order asli, tidak boleh approve PO ini.');
      }
      // set PO status to APPROVED
      db.query('UPDATE purchase_orders SET status = ? WHERE id = ?', ['APPROVED', poId], (e3) => {
        if (e3) { console.error('api/po/:poId/approve update error:', e3); }
        broadcastEvent('po_approved', { poId, orig_order_id: po.orig_order_id });
        return res.redirect('/po');
      });
    });
  });
});

// Create PO back flow revised: this endpoint used by UI /po/create when ?orderId provided (see below)
router.post('/api/order/:orderId/create_po_back_fallback', ensureAuth, (req, res) => {
  // kept for compatibility if needed (not used in main flow)
  res.redirect('/po/create?orderId=' + encodeURIComponent(req.params.orderId));
});

// Creator accepts PO as previous (for backward compatible accept of PO that were made as orders)
router.post('/api/order/:orderId/accept_po', ensureAuth, (req, res) => {
  const poId = req.params.orderId;
  db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [poId], (err, rows) => {
    if (err) { console.error('accept_po select error:', err); return res.status(500).send('DB error'); }
    if (!rows || rows.length === 0) return res.status(404).send('PO tidak ditemukan');
    const po = rows[0];
    if (String(req.session.branchId) !== String(po.to_id)) return res.status(403).send('Bukan PO untuk cabang Anda');
    const st = String(po.status||'').toLowerCase();
    if (!(st === 'pending' || st === 'peding')) return res.status(400).send('PO tidak dalam status pending');
    db.query('UPDATE orders SET status = ?, received_at = NOW() WHERE id = ?', ['received_po', poId], (e) => {
      if (e) { console.error('accept_po update error:', e); return res.status(500).send('DB error'); }
      db.query('SELECT id FROM orders WHERE from_id = ? AND to_id = ? AND (LOWER(status) = ? OR LOWER(status) = ?) ORDER BY created_at DESC LIMIT 1',
        [po.to_id, po.from_id, 'menunggu', 'waiting'], (e2, found) => {
          if (e2) { console.error('accept_po find original error:', e2); return res.redirect('/po'); }
          if (!found || found.length === 0) return res.redirect('/po'); // no matching original order
          const origId = found[0].id;
          db.query('UPDATE orders SET status = ?, shipped_at = NOW() WHERE id = ?', ['dikirimkan', origId], (e3) => {
            if (e3) { console.error('accept_po update original error:', e3); }
            broadcastEvent('po_accepted', { poId, origId });
            return res.redirect('/po');
          });
      });
    });
  });
});

// Pengirim menyelesaikan order yang sudah dikirimkan -> ubah status selesai & tambahkan qty ke inventory
router.post('/api/order/:orderId/finish_by_creator', ensureAuth, (req, res) => {
  const id = req.params.orderId;
  db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [id], (err, rows) => {
    if (err) { console.error('finish_by_creator select error:', err); return res.status(500).send('DB error'); }
    if (!rows || rows.length === 0) return res.status(404).send('Order tidak ditemukan');
    const order = rows[0];
    if (!(req.session.role === 'restaurant' && String(req.session.branchId) === String(order.from_id))) return res.status(403).send('Hanya pengirim (cabang asal) yang bisa menyelesaikan order ini');
    const st = String(order.status||'').toLowerCase();
    if (!(st === 'dikirimkan' || st === 'shipped')) return res.status(400).send('Order bukan dalam status dikirimkan');
    db.query('SELECT item_id, qty FROM order_items WHERE order_id = ?', [id], (err2, items) => {
      if (err2) { console.error('finish_by_creator items select error:', err2); return res.status(500).send('DB error'); }
      const tasks = (items||[]).map(it => new Promise((resolve) => {
        // tambahkan ke inventory pengirim (from_id)
        db.query('SELECT qty FROM inventory WHERE branch_id = ? AND item_id = ?', [order.from_id, it.item_id], (e3, r3) => {
          if (e3) { console.error('finish_by_creator inventory select error:', e3); return resolve(); }
          if (!r3 || r3.length === 0) {
            db.query('INSERT INTO inventory (branch_id, item_id, qty, reorder_level) VALUES (?,?,?,?)', [order.from_id, it.item_id, it.qty, 5], () => resolve());
          } else {
            db.query('UPDATE inventory SET qty = qty + ? WHERE branch_id = ? AND item_id = ?', [it.qty, order.from_id, it.item_id], () => resolve());
          }
        });
      }));
      Promise.all(tasks).then(() => {
        db.query('UPDATE orders SET status = ?, received_at = NOW() WHERE id = ?', ['selesai', id], (er) => {
          if (er) { console.error('finish_by_creator update error:', er); return res.status(500).send('DB error'); }
          db.query('SELECT * FROM orders WHERE id = ?', [id], (sqe, newRows) => {
            if (!sqe && newRows && newRows[0]) broadcastEvent('order_finished_by_creator', newRows[0]);
            res.redirect('/orders');
          });
        });
      });
    });
  });
});

module.exports = router;
