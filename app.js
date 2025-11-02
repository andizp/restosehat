/* app.js - bootstrap utama (dipisah dari file panjang original) */
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

// Middleware global
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

// expose some shared objects via app.locals so route modules bisa akses jika perlu
app.locals.db = db;
app.locals.upload = upload;
app.locals.storage = storage;
app.locals.bcrypt = bcrypt;

// mount routes
const dashboardRoutes = require('./routes/dashboard');
const inventoryRoutes = require('./routes/inventory');
const ordersRoutes = require('./routes/orders');
const poRoutes = require('./routes/po');
const apiRoutes = require('./routes/api');

app.use('/', dashboardRoutes);
app.use('/', inventoryRoutes);
app.use('/', ordersRoutes);
app.use('/', poRoutes);
app.use('/', apiRoutes);

// start server
app.listen(port, () => console.log(`RESTOSEHAT SCM running at http://localhost:${port}`));
/* === END app.js === */
