// db.js
// Inisialisasi koneksi MySQL dan export koneksi sebagai module

const mysql = require("mysql2");

// konfigurasi koneksi ke MySQL
const db = mysql.createConnection({
  host: "127.0.0.1",   // ganti jika pakai server luar
  user: "root",        // username MySQL
  password: "1234",        // password MySQL
  database: "restosehat_scm" // nama database MySQL
});


/* server luar
host: "sql.freedb.tech"
user: "freedb_andri",
password: "kcW?HmbZ8AJg9c2",
database: "freedb_invention_db" 
*/

// cek koneksi
db.connect(err => {
  if (err) {
    console.error("Gagal konek ke MySQL:", err);
  } else {
    console.log("Terkoneksi ke MySQL");
  }
});

module.exports = db;
