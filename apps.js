/* === START OF FILE = combined server with Orders & PO updates === */
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcrypt");
const session = require("express-session");

// import koneksi db (callback style)
const db = require('./scripts/db.js');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: "rahasia_super_restosehat",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// SSE clients
const sseClients = [];
function broadcastEvent(event, payload) {
  const data = JSON.stringify({ event, payload, ts: Date.now() });
  sseClients.forEach(res => {
    try { res.write(`data: ${data}\n\n`); } catch (e) {}
  });
}

// helpers
function escapeHtml(s){
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper: aman ambil po_items (log & fallback) — sekarang juga ambil nama item jika tersedia
function fetchPoItemsSafe(poIds, cb) {
  if (!poIds || poIds.length === 0) return cb(null, []);
  const q = 'SELECT pi.po_id, pi.item_id, pi.qty, pi.unit_price, it.name FROM po_items pi LEFT JOIN items it ON pi.item_id = it.id WHERE pi.po_id IN (' + poIds.join(',') + ')';
  db.query(q, [], (err, rows) => {
    if (!err) return cb(null, rows || []);
    console.error('fetchPoItemsSafe - primary query error:', err);
    const q2 = 'SELECT po_id, item_id, qty FROM po_items WHERE po_id IN (' + poIds.join(',') + ')';
    db.query(q2, [], (err2, rows2) => {
      if (err2) {
        console.error('fetchPoItemsSafe - fallback query error:', err2);
        return cb(err2);
      }
      const normalized = (rows2 || []).map(r => ({ po_id: r.po_id, item_id: r.item_id, qty: r.qty, unit_price: null, name: null }));
      return cb(null, normalized);
    });
  });
}

// renderLayout supports 'bare' for no header/footer; navbar dynamic by role
function renderLayout(title, bodyHtml, opts = {}) {
  const extraHead = opts.extraHead || '';
  const extraScripts = opts.extraScripts || '';
  const user = opts.user || null;
  const bare = !!opts.bare;

  let navHtml = '';
  if (!bare) {
    if (!user) {
      navHtml = `
      <nav class="primary-nav">
        <ul>
          <li><a href="/dashboard">Dashboard</a></li>
          <li><a href="/branches">Cabang</a></li>
        </ul>
      </nav>`;
    } else {
      const role = (user.role || '').toLowerCase();
      let items = [];
      if (role === 'admin') {
        items = [
          { href: '/dashboard', label: 'Dashboard' },
          { href: '/branches', label: 'Cabang' },
          { href: '/inventory', label: 'Inventory' },
          { href: '/orders', label: 'Orders' },
          { href: '/po', label: 'Purchase Orders' },
          { href: '/admin/users', label: 'Manajemen User' }
        ];
      } else if (role === 'supplier') {
        items = [
          { href: '/dashboard', label: 'Dashboard' },
          { href: '/po', label: 'PO Masuk' },
          { href: '/orders', label: 'Orders (Masuk)' },
          { href: '/inventory', label: 'Inventory (Read-only)' }
        ];
      } else if (role === 'kitchen') {
        items = [
          { href: '/dashboard', label: 'Dashboard' },
          { href: '/inventory', label: 'Pemakaian Bahan' },
        ];
      } else if (role === 'pimpinan') {
        items = [
          { href: '/dashboard', label: 'Dashboard' },
          { href: '/branches', label: 'Cabang' },
          { href: '/inventory', label: 'Inventory (Laporan)' },
          { href: '/orders', label: 'Orders' },
          { href: '/po', label: 'PO' }
        ];
      } else { // restaurant (staff) and default
        items = [
          { href: '/dashboard', label: 'Dashboard' },
          { href: '/inventory', label: 'Inventory' },
          { href: '/orders', label: 'Orders' },
          { href: '/po', label: 'Purchase Orders' }
        ];
      }
      navHtml = `<nav class="primary-nav"><ul>${items.map(i=>`<li><a href="${i.href}">${escapeHtml(i.label)}</a></li>`).join('')}</ul></nav>`;
    }
  }

  if (bare) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/style.css">
  <style>
    body { display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; background:#f5f7fb; font-family: Arial, sans-serif; }
    .bare-card{ width:420px; max-width:94%; background:#fff; padding:18px; border-radius:8px; box-shadow:0 6px 18px rgba(0,0,0,0.06); }
    .bare-card h2{ margin-top:0; margin-bottom:12px; font-size:20px }
    .bare-card label{ display:block; margin-top:8px; font-size:13px }
    .bare-card input, .bare-card select, .bare-card button, .bare-card textarea{ width:100%; padding:8px; margin-top:6px; box-sizing:border-box }
    .error-box{ background:#ffe6e6; padding:8px; border-radius:4px; color:#900; }
    .success-box{ background:#e6ffef; padding:8px; border-radius:4px; color:#046; }
  </style>
  ${extraHead}
</head>
<body>
  <div class="bare-card">${bodyHtml}</div>
  ${extraScripts}
</body>
</html>`;
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/style.css">
  ${extraHead}
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a href="/dashboard" class="brand"><div class="logo">R</div><div class="brand-text">RESTOSEHAT</div></a>
      ${navHtml}
      <div class="user-area">
        ${user ? `
          <span class="user-greet">Hi, <strong>${escapeHtml(user.username)}</strong> (${escapeHtml(user.role)})</span>
          <a class="btn-logout" href="/logout">Logout</a>
        ` : `
          <a class="btn-link" href="/login">Login</a>
          <a class="btn-link" href="/register">Register</a>
        `}
      </div>
    </div>
  </header>

  <main class="main">${bodyHtml}</main>

  <footer class="site-footer">
    <div>© RESTOSEHAT — Sistem SCM. Demo. Untuk produksi: gunakan validasi & proteksi keamanan.</div>
  </footer>

  ${extraScripts}
</body>
</html>`;
}

// Auth checks
function ensureAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}
function ensureAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.send(renderLayout('Akses Ditolak', `<div class="page"><div class="error-box">Akses ditolak - hanya admin.</div></div>`, { user: req.session }));
  }
  next();
}
function ensureSupplier(req, res, next) {
  if (!req.session.userId || req.session.role !== 'supplier') {
    return res.send(renderLayout('Akses Ditolak', `<div class="page"><div class="error-box">Akses ditolak - hanya supplier.</div></div>`, { user: req.session }));
  }
  next();
}
function readOnlyForPimpindanMiddleware(req, res, next) {
  if (req.session.role === 'pimpinan') return res.status(403).send('Pimpinan hanya boleh melihat data (read-only).');
  next();
}

// ----------------- AUTH ROUTES -----------------
app.get('/login', (req, res) => {
  const body = `
    <h2>Login RESTOSEHAT</h2>
    <form method="post" action="/login">
      <label>Username</label><input name="username" required />
      <label>Password</label><input name="password" type="password" required />
      <div style="margin-top:12px"><button type="submit">Login</button></div>
    </form>
    <div style="margin-top:10px">Belum punya akun? <a href="/register">Daftar</a></div>
  `;
  res.send(renderLayout('Login', body, { bare: true }));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.send(renderLayout('Login', `<div class="error-box">Isi username & password.</div>`, { bare: true }));
  db.query('SELECT id, username, password, role, branch_id FROM users WHERE username = ? LIMIT 1', [username], (err, rows) => {
    if (err) {
      console.error('Login error:', err);
      return res.send(renderLayout('Login', `<div class="error-box">Terjadi kesalahan. Cek server.</div>`, { bare: true }));
    }
    if (!rows || rows.length === 0) return res.send(renderLayout('Login', `<div class="error-box">User tidak ditemukan.</div>`, { bare: true }));
    const u = rows[0];
    if (!bcrypt.compareSync(password, u.password)) return res.send(renderLayout('Login', `<div class="error-box">Username atau password salah.</div>`, { bare: true }));
    req.session.userId = u.id;
    req.session.username = u.username;
    req.session.role = u.role;
    req.session.branchId = u.branch_id || null;
    res.redirect('/dashboard');
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- GET /register (ambil cabang dari DB) ----------
app.get('/register', (req, res) => {
  db.query('SELECT id, name FROM branches ORDER BY id', [], (err, branches) => {
    if (err) {
      console.error('Error fetch branches for register:', err);
      const body = `
        <h2>Daftar Akun</h2>
        <form method="post" action="/register">
          <label>Username</label><input name="username" required />
          <label>Password (minimal 6 karakter)</label><input name="password" type="password" required />
          <label>Nama Lengkap</label><input name="full_name" />
          <label>Telepon</label><input name="phone" />
          <label>Cabang (ID) - jika staff restoran</label><input name="branch_id" />
          <label>Role</label>
          <select name="role">
            <option value="restaurant">Staff Restoran</option>
            <option value="kitchen">Staff Dapur</option>
            <option value="supplier">Supplier</option>
            <option value="pimpinan">Pimpinan</option>
          </select>
          <div style="margin-top:12px"><button type="submit">Daftar</button></div>
        </form>
        <div style="margin-top:8px">Catatan: role <strong>admin</strong> hanya bisa dibuat oleh admin melalui manajemen user.</div>
      `;
      return res.send(renderLayout('Register', body, { bare: true }));
    }

    const opts = (branches || []).map(b => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)} (${escapeHtml(b.id)})</option>`).join('');
    const body = `
      <h2>Daftar Akun</h2>
      <form method="post" action="/register">
        <label>Username</label><input name="username" required />
        <label>Password (minimal 6 karakter)</label><input name="password" type="password" required />
        <label>Nama Lengkap</label><input name="full_name" />
        <label>Telepon</label><input name="phone" />
        <label>Cabang (pilih jika staff restoran)</label>
        <select name="branch_id">
          <option value="">-- tidak ada --</option>
          ${opts}
        </select>
        <label>Role</label>
        <select name="role">
          <option value="restaurant">Staff Restoran</option>
          <option value="kitchen">Staff Dapur</option>
          <option value="supplier">Supplier</option>
          <option value="pimpinan">Pimpinan</option>
        </select>
        <div style="margin-top:12px"><button type="submit">Daftar</button></div>
      </form>
      <div style="margin-top:8px">Catatan: role <strong>admin</strong> hanya bisa dibuat oleh admin melalui manajemen user.</div>
    `;
    res.send(renderLayout('Register', body, { bare: true }));
  });
});

// ---------- POST /register (validasi branch sebelum insert) ----------
app.post('/register', (req, res) => {
  const { username, password, role, branch_id, full_name, phone } = req.body;
  if (!username || !password || !role) return res.send(renderLayout('Register', `<div class="error-box">Lengkapi username, password, dan role.</div>`, { bare:true }));
  if (password.length < 6) return res.send(renderLayout('Register', `<div class="error-box">Password minimal 6 karakter.</div>`, { bare:true }));

  if (role === 'admin') {
    if (!(req.session && req.session.role === 'admin')) {
      return res.send(renderLayout('Register', `<div class="error-box">Role 'admin' hanya bisa dibuat oleh admin.</div>`, { bare:true }));
    }
  }

  const branchIdToSave = branch_id ? String(branch_id).trim() : null;

  const proceedInsert = () => {
    const hashed = bcrypt.hashSync(password, 10);
    db.query('INSERT INTO users (username, password, role, branch_id, full_name, phone) VALUES (?,?,?,?,?,?)',
      [username, hashed, role, branchIdToSave || null, full_name || '', phone || ''],
      (err) => {
        if (err) {
          console.error('Register error:', err);
          if (err.code === 'ER_DUP_ENTRY') {
            return res.send(renderLayout('Register', `<div class="error-box">Username sudah terpakai. Gunakan username lain.</div>`, { bare:true }));
          }
          return res.send(renderLayout('Register', `<div class="error-box">Gagal registrasi. Cek server.</div>`, { bare:true }));
        }
        res.send(renderLayout('Register Sukses', `<div class="success-box">Registrasi berhasil. Silakan <a href="/login">login</a>.</div>`, { bare:true }));
      });
  };

  if (branchIdToSave) {
    db.query('SELECT id FROM branches WHERE id = ? LIMIT 1', [branchIdToSave], (err, rows) => {
      if (err) {
        console.error('Register branch check error:', err);
        return res.send(renderLayout('Register', `<div class="error-box">Gagal validasi cabang. Cek server.</div>`, { bare:true }));
      }
      if (!rows || rows.length === 0) {
        return res.send(renderLayout('Register', `<div class="error-box">Cabang tidak ditemukan. Pilih cabang dari daftar.</div>`, { bare:true }));
      }
      proceedInsert();
    });
  } else {
    proceedInsert();
  }
});

// Session API
app.get('/session', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Belum login' });
  db.query('SELECT id, username, role, branch_id FROM users WHERE id = ? LIMIT 1', [req.session.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'User tidak ditemukan' });
    const u = rows[0];
    res.json({ userId: u.id, username: u.username, role: u.role, branchId: u.branch_id });
  });
});

// ----------------- DASHBOARD / EVENTS -----------------
app.get('/dashboard', ensureAuth, (req, res) => {
  const body = `
    <div class="page">
      <h2>Dashboard SCM - RESTOSEHAT</h2>
      <p>Selamat datang, <strong>${escapeHtml(req.session.username)}</strong> — role: ${escapeHtml(req.session.role)}</p>

      <div class="panel-grid">
        <div class="card">
          <h3>Aksi Cepat</h3>
          <ul>
            <li><a href="/branches">Kelola Cabang</a></li>
            <li><a href="/inventory">Inventory</a></li>
            <li><a href="/orders">Orders</a></li>
            <li><a href="/po">Purchase Orders</a></li>
            ${req.session.role==='admin' ? '<li><a href="/admin/users">Manajemen User</a></li>' : ''}
          </ul>
        </div>

        <div class="card">
          <h3>Event Real-time</h3>
          <div class="log" id="eventLog">Menunggu event...</div>
        </div>
      </div>

      <script>
        (function(){
          const es = new EventSource('/events');
          es.onmessage = function(e){
            try {
              const d = JSON.parse(e.data);
              const el = document.getElementById('eventLog');
              el.innerText = '[' + new Date(d.ts).toLocaleTimeString() + '] ' + d.event + ' ' + JSON.stringify(d.payload) + '\\n' + el.innerText;
            } catch(e){}
          };
        })();
      </script>
    </div>
  `;
  res.send(renderLayout('Dashboard - RESTOSEHAT', body, { user: req.session }));
});

app.get('/events', ensureAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// ----------------- USER MANAGEMENT (admin) -----------------
app.get('/admin/users', ensureAdmin, (req, res) => {
  db.query('SELECT u.id, u.username, u.role, u.branch_id, u.full_name, u.phone, b.name as branch_name FROM users u LEFT JOIN branches b ON u.branch_id = b.id ORDER BY u.id', [], (err, rows) => {
    if (err) return res.send(renderLayout('Manajemen User', `<div class="error-box">DB error</div>`, { user: req.session }));
    const list = (rows || []).map(r => `<tr>
      <td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.username)}</td><td>${escapeHtml(r.full_name||'')}</td><td>${escapeHtml(r.phone||'')}</td>
      <td>${escapeHtml(r.role)}</td><td>${escapeHtml(r.branch_name||'')}</td>
      <td>
        <a href="/admin/users/${r.id}/edit">Edit</a>
        <form style="display:inline" method="post" action="/admin/users/${r.id}/delete" onsubmit="return confirm('Hapus user?');"><button type="submit">Hapus</button></form>
      </td>
    </tr>`).join('');
    const body = `<div class="page card"><h2>Manajemen User</h2><table class="data-table"><thead><tr><th>ID</th><th>Username</th><th>Nama</th><th>Phone</th><th>Role</th><th>Cabang</th><th>Aksi</th></tr></thead><tbody>${list}</tbody></table></div>`;
    res.send(renderLayout('Manajemen User - RESTOSEHAT', body, { user: req.session }));
  });
});

app.get('/admin/users/:id/edit', ensureAdmin, (req, res) => {
  const uid = req.params.id;
  db.query('SELECT id, username, role, branch_id, full_name, phone FROM users WHERE id = ? LIMIT 1', [uid], (err, rows) => {
    if (err || !rows || rows.length === 0) return res.send(renderLayout('Edit User', `<div class="error-box">User tidak ditemukan</div>`, { user: req.session }));
    const u = rows[0];
    db.query('SELECT id, name FROM branches ORDER BY id', [], (er, branches) => {
      const opts = (branches || []).map(b => `<option value="${escapeHtml(b.id)}" ${String(b.id)===String(u.branch_id)?'selected':''}>${escapeHtml(b.name)}</option>`).join('');
      const body = `
        <div class="page card">
          <h2>Edit User: ${escapeHtml(u.username)}</h2>
          <form id="editUserForm" method="post" action="/admin/users/${u.id}/update">
            <label>Username</label><input name="username" value="${escapeHtml(u.username)}" required />
            <label>Nama Lengkap</label><input name="full_name" value="${escapeHtml(u.full_name||'')}" />
            <label>Phone</label><input name="phone" value="${escapeHtml(u.phone||'')}" />
            <label>Cabang</label>
            <select name="branch_id">
              <option value="">-- tidak ada --</option>
              ${opts}
            </select>
            <label>Role</label>
            <select name="role" required>
              <option value="restaurant" ${u.role==='restaurant'?'selected':''}>Staff Restoran</option>
              <option value="kitchen" ${u.role==='kitchen'?'selected':''}>Staff Dapur</option>
              <option value="supplier" ${u.role==='supplier'?'selected':''}>Supplier</option>
              <option value="pimpinan" ${u.role==='pimpinan'?'selected':''}>Pimpinan</option>
              <option value="admin" ${u.role==='admin'?'selected':''}>Admin</option>
            </select>
            <label>Reset Password (kosongkan untuk tidak mengubah)</label>
            <input name="password" type="password" />
            <div style="margin-top:12px"><button type="submit">Simpan</button> <a href="/admin/users">Batal</a></div>
          </form>
        </div>
      `;
      res.send(renderLayout('Edit User', body, { user: req.session }));
    });
  });
});

app.post('/admin/users/:id/update', ensureAdmin, (req, res) => {
  const uid = req.params.id;
  const { username, full_name, phone, branch_id, role, password } = req.body;
  if (!username || !role) return res.send(renderLayout('Edit User', `<div class="error-box">Username dan role wajib diisi.</div>`, { user: req.session }));
  if (password && password.length < 6) return res.send(renderLayout('Edit User', `<div class="error-box">Password minimal 6 karakter.</div>`, { user: req.session }));
  const updateUser = () => {
    db.query('UPDATE users SET username=?, full_name=?, phone=?, branch_id=?, role=? WHERE id=?', [username, full_name||'', phone||'', branch_id||null, role, uid], (e) => {
      if (e) { console.error(e); return res.send(renderLayout('Edit User', `<div class="error-box">Gagal update user.</div>`, { user: req.session })); }
      res.redirect('/admin/users');
    });
  };
  if (password && password.length >= 6) {
    const hashed = bcrypt.hashSync(password, 10);
    db.query('UPDATE users SET password=? WHERE id=?', [hashed, uid], (er) => {
      if (er) { console.error(er); return res.send(renderLayout('Edit User', `<div class="error-box">Gagal update password.</div>`, { user: req.session })); }
      updateUser();
    });
  } else {
    updateUser();
  }
});

app.post('/admin/users/:id/delete', ensureAdmin, (req, res) => {
  const uid = req.params.id;
  db.query('DELETE FROM users WHERE id = ?', [uid], (err) => {
    if (err) { console.error(err); return res.send(renderLayout('Manajemen User', `<div class="error-box">Gagal hapus user.</div>`, { user: req.session })); }
    res.redirect('/admin/users');
  });
});

// ----------------- BRANCHES -----------------
app.get('/branches', ensureAuth, (req, res) => {
  db.query('SELECT id, name, location FROM branches ORDER BY id', [], (err, rows) => {
    if (err) return res.send(renderLayout('Cabang', `<div class="error-box">Error: ${escapeHtml(err.message)}</div>`, { user: req.session }));
    const list = rows.map(r => `<tr><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.location||'')}</td></tr>`).join('');
    const body = `<div class="page card"><h2>Daftar Cabang</h2><table class="data-table"><thead><tr><th>ID</th><th>Nama</th><th>Lokasi</th></tr></thead><tbody>${list}</tbody></table></div>`;
    res.send(renderLayout('Cabang - RESTOSEHAT', body, { user: req.session }));
  });
});

// ----------------- API HELPERS: items, suppliers, branches ---------------
app.get('/api/items', ensureAuth, (req, res) => {
  db.query('SELECT id, name FROM items ORDER BY id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows || []);
  });
});
app.get('/api/suppliers', ensureAuth, (req, res) => {
  db.query("SELECT id, username, full_name FROM users WHERE role = 'supplier' ORDER BY id", [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows || []);
  });
});
app.get('/api/branches', ensureAuth, (req, res) => {
  db.query('SELECT id, name FROM branches ORDER BY id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows || []);
  });
});

// ----------------- INVENTORY -----------------
app.get('/inventory', ensureAuth, (req, res) => {
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
app.get('/inventory/report', ensureAuth, (req, res) => {
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
app.get('/api/inventory/:branchId', ensureAuth, (req, res) => {
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
app.post('/api/inventory/:branchId/adjust', ensureAuth, readOnlyForPimpindanMiddleware, (req, res) => {
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
app.post('/api/use', ensureAuth, (req, res) => {
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

// ----------------- ORDERS -----------------
app.get('/orders', ensureAuth, (req, res) => {
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
app.post('/api/order', ensureAuth, (req, res) => {
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
app.post('/api/order/:orderId/kirim', ensureAuth, (req, res) => {
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
app.post('/api/order/:orderId/create_po_back', ensureAuth, (req, res) => {
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
app.post('/api/po/:poId/approve', ensureAuth, (req, res) => {
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
app.post('/api/order/:orderId/create_po_back_fallback', ensureAuth, (req, res) => {
  // kept for compatibility if needed (not used in main flow)
  res.redirect('/po/create?orderId=' + encodeURIComponent(req.params.orderId));
});

// Creator accepts PO as previous (for backward compatible accept of PO that were made as orders)
app.post('/api/order/:orderId/accept_po', ensureAuth, (req, res) => {
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
app.post('/api/order/:orderId/finish_by_creator', ensureAuth, (req, res) => {
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

// ----------------- PURCHASE ORDERS (PO) -----------------
// GET /po (PO Masuk / PO Keluar handling)
app.get('/po', ensureAuth, (req, res) => {
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
app.get('/po/create', ensureAuth, (req, res) => {
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
app.post('/api/po', ensureAuth, (req, res) => {
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
app.post('/api/po/:poId/ship', ensureAuth, (req, res) => {
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

app.post('/api/po/:poId/deliver', ensureAuth, ensureSupplier, (req, res) => {
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
app.post('/api/po/:poId/receive', ensureAuth, (req, res) => {
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

// ----------------- MONITOR / OTHER API -----------------
app.get('/api/monitor', ensureAuth, (req, res) => {
  db.query('SELECT id, name FROM branches', [], (err, branches) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    const tasks = branches.map(b => new Promise((resolve) => {
      db.query(`SELECT i.item_id, it.name, i.qty, i.reorder_level FROM inventory i JOIN items it ON i.item_id = it.id WHERE i.branch_id = ?`, [b.id], (e, rows) => {
        resolve({ branch: b, items: rows || [] });
      });
    }));
    Promise.all(tasks).then(results => {
      db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50', [], (er, orders) => {
        res.json({ branches: results, orders: orders || [] });
      });
    });
  });
});

// ----------------- START SERVER -----------------
app.listen(port, () => console.log(`RESTOSEHAT SCM running at http://localhost:${port}`));
/* === END OF FILE === */
