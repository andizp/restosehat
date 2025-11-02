/* utils.js - helper: escapeHtml, renderLayout, fetchPoItemsSafe */
const db = require('./scripts/db.js');

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

module.exports = {
  escapeHtml,
  renderLayout,
  fetchPoItemsSafe
};
