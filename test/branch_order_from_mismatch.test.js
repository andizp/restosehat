// test/branch_order_from_mismatch.test.js
const { expect } = require('chai');
const request = require('supertest');
const makeApp = require('./_makeApp');

describe('Branch Coverage: POST /api/order from_id ownership checks', () => {
  it('should return 403 when restaurant tries to create order with different from_id', async () => {
    const dbMock = { query: (sql, params, cb) => cb(null, []) };

    const app = makeApp({
      routePath: '../routes/orders',
      stubs: { '../scripts/db.js': dbMock },
      sessionData: { userId: 2, role: 'restaurant', branchId: 'BR-2' } // branchId = BR-2
    });

    const payload = {
      from_type: 'branch',
      from_id: 'BR-1',   // mismatch -> should be rejected
      to_type: 'supplier',
      to_id: '10',
      items: [{ item_id: 'X1', qty: 1 }]
    };

    const res = await request(app).post('/api/order').send(payload);
    expect(res.status).to.equal(403);
  });

  it('should allow creation when from_id matches session branchId', async () => {
    const dbMock = {
      query: (sql, params, cb) => {
        // 1) schema detect -> return 'to_type' exists
        if (/INFORMATION_SCHEMA.COLUMNS.*orders/i.test(String(sql))) return cb(null, [{COLUMN_NAME:'to_type'}]);
        // 2) insert order
        if (/INSERT INTO orders/i.test(String(sql))) return cb(null, { insertId: 55 });
        // 3) insert order_items
        if (/INSERT INTO order_items/i.test(String(sql))) return cb(null, { affectedRows: 1 });
        return cb(null, []);
      }
    };

    const app = makeApp({
      routePath: '../routes/orders',
      stubs: { '../scripts/db.js': dbMock },
      sessionData: { userId: 3, role: 'restaurant', branchId: 'BR-1' }
    });

    const payload = {
      from_type: 'branch',
      from_id: 'BR-1',   // matches session
      to_type: 'supplier',
      to_id: '10',
      items: [{ item_id: 'X1', qty: 2 }]
    };

    const res = await request(app).post('/api/order').send(payload);
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('ok', true);
    expect(res.body).to.have.property('orderId', 55);
  });
});
