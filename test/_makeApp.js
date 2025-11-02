// test/_makeApp.js
const express = require('express');
const bodyParser = require('body-parser');
const proxyquire = require('proxyquire').noCallThru();

function makeApp({ routePath, stubs = {}, sessionData = {} }) {
  // routePath: relatif ke project, misal '../routes/po' atau '../apps' tergantung struktur Anda
  const router = proxyquire(routePath, stubs);
  const app = express();
  app.use(bodyParser.json());
  // simple session mock middleware (inject session untuk route handlers)
  app.use((req, res, next) => { req.session = Object.assign({}, sessionData); next(); });
  app.use('/', router);
  return app;
}

module.exports = makeApp;
