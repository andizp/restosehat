/* routes/api.js */
const express = require('express');
const router = express.Router();
const db = require('../scripts/db.js');
const { ensureAuth } = require('../middleware/auth');

// ----------------- API HELPERS: items, suppliers, branches ---------------
router.get('/api/items', ensureAuth, (req, res) => {
  db.query('SELECT id, name FROM items ORDER BY id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows || []);
  });
});
router.get('/api/suppliers', ensureAuth, (req, res) => {
  db.query("SELECT id, username, full_name FROM users WHERE role = 'supplier' ORDER BY id", [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows || []);
  });
});
router.get('/api/branches', ensureAuth, (req, res) => {
  db.query('SELECT id, name FROM branches ORDER BY id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows || []);
  });
});

// ----------------- MONITOR / OTHER API -----------------
router.get('/api/monitor', ensureAuth, (req, res) => {
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

module.exports = router;
