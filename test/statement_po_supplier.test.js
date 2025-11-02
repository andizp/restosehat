// test/statement_po_supplier.test.js
const { expect } = require('chai');
const request = require('supertest');
const makeApp = require('./_makeApp');

describe('Statement Coverage: POST /api/po (supplier path)', () => {
  it('should create PO for supplier and insert po_items', async () => {
    const queries = [];
    const dbMock = {
      query: (sql, params, cb) => {
        // record SQL for assertions (simplified)
        queries.push(String(sql || '').trim().split('\n')[0]);
        // simulate insert into purchase_orders
        if (/INSERT INTO purchase_orders/i.test(sql)) {
          return cb(null, { insertId: 999 });
        }
        // simulate insert into po_items
        if (/INSERT INTO po_items/i.test(sql)) {
          return cb(null, { affectedRows: 1 });
        }
        return cb(null, []);
      }
    };

    const app = makeApp({
      routePath: '../routes/po', // sesuaikan dengan lokasi module route Anda
      stubs: {
        '../scripts/db.js': dbMock
      },
      sessionData: { userId: 10, role: 'restaurant', branchId: '1' }
    });

    const payload = {
      supplier_id: '45',
      branch_id: '1',
      items: [{ item_id: 'ITEM-A', qty: 3, unit_price: '12.50' }]
    };

    const res = await request(app).post('/api/po').send(payload);
    expect(res.status).to.be.oneOf([200, 201]); // handler mungkin respond 200 or 201 depending implementation
    expect(res.body).to.have.property('ok', true);
    expect(res.body).to.have.property('poId', 999);
    // ensure we hit purchase_orders insert and po_items insert
    expect(queries.some(q => /INSERT INTO purchase_orders/i.test(q))).to.be.true;
    expect(queries.some(q => /INSERT INTO po_items/i.test(q))).to.be.true;
  });
});
