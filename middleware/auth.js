/* middleware/auth.js */
function ensureAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}
function ensureAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    const { renderLayout } = require('../utils');
    return res.send(renderLayout('Akses Ditolak', `<div class="page"><div class="error-box">Akses ditolak - hanya admin.</div></div>`, { user: req.session }));
  }
  next();
}
function ensureSupplier(req, res, next) {
  if (!req.session.userId || req.session.role !== 'supplier') {
    const { renderLayout } = require('../utils');
    return res.send(renderLayout('Akses Ditolak', `<div class="page"><div class="error-box">Akses ditolak - hanya supplier.</div></div>`, { user: req.session }));
  }
  next();
}
function readOnlyForPimpindanMiddleware(req, res, next) {
  if (req.session.role === 'pimpinan') return res.status(403).send('Pimpinan hanya boleh melihat data (read-only).');
  next();
}

module.exports = {
  ensureAuth,
  ensureAdmin,
  ensureSupplier,
  readOnlyForPimpindanMiddleware
};
