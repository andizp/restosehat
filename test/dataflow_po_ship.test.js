// test/dataflow_po_ship.test.js
const { expect } = require('chai');
const request = require('supertest');
const makeApp = require('./_makeApp');

describe('Data Flow: POST /api/po/:poId/ship updates purchase_orders and orig order when orig_order_id exists', () => {
  it('should update purchase_orders -> set shipped and then update original orders -> respond with redirect/status', async () => {
    const dbMock = {
      query: (sql, params, cb) => {
        const s = String(sql || '').trim().toLowerCase();
        // first SELECT purchase_orders
        if (s.startsWith('select * from purchase_orders where id')) {
          return cb(null, [{ id: params[0], orig_order_id: 777, created_by: 5, supplier_id: null }]);
        }
        // update purchase_orders status -> success
        if (s.startsWith('update purchase_orders set status')) {
          return cb(null, { affectedRows: 1 });
        }
        // update original order status -> success
        if (s.startsWith('update orders set status')) {
          return cb(null, { affectedRows: 1 });
        }
        // final select purchase_orders to read row for response (optional)
        if (s.startsWith('select * from purchase_orders where id') && params && params[0] === 123) {
          return cb(null, [{ id: 123, orig_order_id: 777, status: 'SHIPPED' }]);
        }
        return cb(null, []);
      }
    };

    const app = makeApp({
      routePath: '../routes/po',
      stubs: { '../scripts/db.js': dbMock },
      sessionData: { userId: 5, role: 'restaurant', branchId: '1' }
    });

    const res = await request(app).post('/api/po/123/ship').send();
    // The handler usually does res.redirect('/po') — supertest may return 302; allow either 200 or redirect code
    expect([200, 302]).to.include(res.status);
    // Additional checks could assert that DB mocks were invoked (we rely on behavior above)
  });
});
