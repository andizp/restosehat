/* routes/dashboard.js */
const express = require('express');
const router = express.Router();
const db = require('../scripts/db.js');
const { escapeHtml, renderLayout } = require('../utils');
const { addSseClient, broadcastEvent } = require('../events');
const { ensureAuth, ensureAdmin } = require('../middleware/auth');

// AUTH ROUTES (login, logout, register)
router.get('/login', (req, res) => {
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

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.send(renderLayout('Login', `<div class="error-box">Isi username & password.</div>`, { bare: true }));
  db.query('SELECT id, username, password, role, branch_id FROM users WHERE username = ? LIMIT 1', [username], (err, rows) => {
    if (err) {
      console.error('Login error:', err);
      return res.send(renderLayout('Login', `<div class="error-box">Terjadi kesalahan. Cek server.</div>`, { bare: true }));
    }
    if (!rows || rows.length === 0) return res.send(renderLayout('Login', `<div class="error-box">User tidak ditemukan.</div>`, { bare: true }));
    const u = rows[0];
    const bcrypt = require('bcrypt');
    if (!bcrypt.compareSync(password, u.password)) return res.send(renderLayout('Login', `<div class="error-box">Username atau password salah.</div>`, { bare: true }));
    req.session.userId = u.id;
    req.session.username = u.username;
    req.session.role = u.role;
    req.session.branchId = u.branch_id || null;
    res.redirect('/dashboard');
  });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- GET /register (ambil cabang dari DB) ----------
router.get('/register', (req, res) => {
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
router.post('/register', (req, res) => {
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
    const bcrypt = require('bcrypt');
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
router.get('/session', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Belum login' });
  db.query('SELECT id, username, role, branch_id FROM users WHERE id = ? LIMIT 1', [req.session.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'User tidak ditemukan' });
    const u = rows[0];
    res.json({ userId: u.id, username: u.username, role: u.role, branchId: u.branch_id });
  });
});

// ----------------- DASHBOARD / EVENTS -----------------
router.get('/dashboard', ensureAuth, (req, res) => {
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

router.get('/events', ensureAuth, (req, res) => {
  addSseClient(res, req);
});

// ----------------- USER MANAGEMENT (admin) -----------------
router.get('/admin/users', ensureAdmin, (req, res) => {
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

router.get('/admin/users/:id/edit', ensureAdmin, (req, res) => {
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

router.post('/admin/users/:id/update', ensureAdmin, (req, res) => {
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
    const bcrypt = require('bcrypt');
    const hashed = bcrypt.hashSync(password, 10);
    db.query('UPDATE users SET password=? WHERE id=?', [hashed, uid], (er) => {
      if (er) { console.error(er); return res.send(renderLayout('Edit User', `<div class="error-box">Gagal update password.</div>`, { user: req.session })); }
      updateUser();
    });
  } else {
    updateUser();
  }
});

router.post('/admin/users/:id/delete', ensureAdmin, (req, res) => {
  const uid = req.params.id;
  db.query('DELETE FROM users WHERE id = ?', [uid], (err) => {
    if (err) { console.error(err); return res.send(renderLayout('Manajemen User', `<div class="error-box">Gagal hapus user.</div>`, { user: req.session })); }
    res.redirect('/admin/users');
  });
});

// ----------------- BRANCHES -----------------
router.get('/branches', ensureAuth, (req, res) => {
  db.query('SELECT id, name, location FROM branches ORDER BY id', [], (err, rows) => {
    if (err) return res.send(renderLayout('Cabang', `<div class="error-box">Error: ${escapeHtml(err.message)}</div>`, { user: req.session }));
    const list = rows.map(r => `<tr><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.location||'')}</td></tr>`).join('');
    const body = `<div class="page card"><h2>Daftar Cabang</h2><table class="data-table"><thead><tr><th>ID</th><th>Nama</th><th>Lokasi</th></tr></thead><tbody>${list}</tbody></table></div>`;
    res.send(renderLayout('Cabang - RESTOSEHAT', body, { user: req.session }));
  });
});

module.exports = router;
