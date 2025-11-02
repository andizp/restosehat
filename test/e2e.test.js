// test/e2e.test.js
// RESTOSEHAT E2E - Flow: register roles -> sender creates order -> kirim -> receiver buat PO balasan -> sender terima PO -> sender terima order -> inventory update
// Run: npx mocha --timeout 240000 test/e2e.test.js

const { Builder, By, until } = require('selenium-webdriver');
require('chromedriver');
const chrome = require('selenium-webdriver/chrome');

let expect;
before(async function() {
  const chai = await import('chai');
  expect = chai.expect;
});

const BASE = 'http://localhost:3000';

// Branch IDs used in your environment - adjust if needed
const SENDER_BRANCH = '1';
const RECEIVER_BRANCH = '2';

describe('RESTOSEHAT E2E - Full order <-> PO flow (sender->receiver->po-back->accept->finish)', function () {
  this.timeout(240000);
  let driver;

  // Users created during test
  const USERS = {
    sender: { username: null, password: 'TestPass123!', role: 'restaurant', branch: SENDER_BRANCH },
    receiver: { username: null, password: 'TestPass123!', role: 'restaurant', branch: RECEIVER_BRANCH },
    kitchen: { username: null, password: 'TestPass123!', role: 'kitchen', branch: SENDER_BRANCH },
    supplier: { username: null, password: 'TestPass123!', role: 'supplier', branch: '' }, // supplier doesn't need branch
    pimpinan: { username: null, password: 'TestPass123!', role: 'pimpinan', branch: '' }
  };

  before(async () => {
    const opts = new chrome.Options();
    // Uncomment to see browser:
    // opts.headless(false);
    opts.addArguments('--no-sandbox', '--disable-dev-shm-usage');
    driver = await new Builder().forBrowser('chrome').setChromeOptions(opts).build();
  });

  after(async () => {
    if (driver) await driver.quit();
  });

  // ---------- helpers ----------
  function genUsername(base) {
    const t = Date.now();
    const r = Math.floor(Math.random() * 10000);
    return `${base}_${t}_${r}`;
  }

  async function clearSessionStorageAndCookies() {
    try { await driver.manage().deleteAllCookies(); } catch (e) {}
    try { await driver.executeScript('window.localStorage && window.localStorage.clear(); window.sessionStorage && window.sessionStorage.clear();'); } catch (e) {}
  }

  async function acceptAlertIfPresent(timeout = 4000) {
    try {
      await driver.wait(until.alertIsPresent(), timeout);
      const a = await driver.switchTo().alert();
      await a.accept();
      await driver.sleep(300);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Robust register that supports select branch OR input branch, and sets role
  async function registerUserUnique(userObj, nameBase) {
    for (let attempt = 0; attempt < 6; attempt++) {
      await clearSessionStorageAndCookies();
      await driver.get(BASE + '/register');

      // ensure form present
      try { await driver.wait(until.elementLocated(By.css('form')), 7000); } catch (e) { await driver.sleep(600); continue; }

      const uname = genUsername(nameBase);
      userObj.username = uname;

      const usernameEl = await driver.findElement(By.css('input[name="username"]'));
      await usernameEl.clear(); await usernameEl.sendKeys(uname);

      const passwordEl = await driver.findElement(By.css('input[name="password"]'));
      await passwordEl.clear(); await passwordEl.sendKeys(userObj.password);

      // optional fields
      const fullNameEls = await driver.findElements(By.css('input[name="full_name"]'));
      if (fullNameEls.length) { await fullNameEls[0].clear(); await fullNameEls[0].sendKeys(`${nameBase} Test`); }

      const phoneEls = await driver.findElements(By.css('input[name="phone"]'));
      if (phoneEls.length) { await phoneEls[0].clear(); await phoneEls[0].sendKeys('081234567890'); }

      // set branch if provided (try select first)
      if (userObj.branch) {
        const branchSelects = await driver.findElements(By.css('select[name="branch_id"]'));
        if (branchSelects.length) {
          await driver.executeScript(
            `const s = document.querySelector('select[name="branch_id"]'); if(s){ s.value = arguments[0]; s.dispatchEvent(new Event('change')); }`,
            userObj.branch
          );
        } else {
          const branchInputs = await driver.findElements(By.css('input[name="branch_id"]'));
          if (branchInputs.length) { await branchInputs[0].clear(); await branchInputs[0].sendKeys(userObj.branch); }
        }
      }

      // set role
      const roleSelects = await driver.findElements(By.css('select[name="role"]'));
      if (roleSelects.length) {
        await driver.executeScript(`const s=document.querySelector('select[name="role"]'); if(s){ s.value=arguments[0]; s.dispatchEvent(new Event('change')); }`, userObj.role);
      } else {
        // fallback: radio / input not expected, but attempt
        const roleInputs = await driver.findElements(By.css('input[name="role"]'));
        if (roleInputs.length) {
          await roleInputs[0].clear();
          await roleInputs[0].sendKeys(userObj.role);
        }
      }

      // submit button - find the button in form
      const submitCandidates = await driver.findElements(By.xpath("//form//button[normalize-space(.)='Daftar' or normalize-space(.)='Register' or normalize-space(.)='Buat' or normalize-space(.)='Submit' or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'daftar')]"));
      if (submitCandidates.length) {
        await submitCandidates[0].click();
      } else {
        const btns = await driver.findElements(By.css('form button[type="submit"], form button'));
        if (!btns.length) throw new Error('Register form submit button not found');
        await btns[0].click();
      }

      // handle alert if any
      await acceptAlertIfPresent(3000);

      try {
        await driver.wait(until.elementLocated(By.css('.success-box, .error-box, a[href="/login"]')), 7000);
      } catch (e) {
        await driver.sleep(700);
      }

      const errors = await driver.findElements(By.css('.error-box'));
      if (errors.length) {
        const txt = await errors[0].getText();
        if (/username sudah terpakai|duplicate|already exists|ER_DUP_ENTRY/i.test(txt)) {
          await driver.sleep(300);
          continue; // retry
        } else {
          throw new Error('Register error: ' + txt);
        }
      }

      const succ = await driver.findElements(By.css('.success-box, a[href="/login"]'));
      if (succ.length) { await driver.sleep(350); return; }

      await driver.sleep(500);
    }
    throw new Error('Gagal registrasi setelah beberapa percobaan.');
  }

  async function login(user) {
    await clearSessionStorageAndCookies();
    await driver.get(BASE + '/login');
    await driver.wait(until.elementLocated(By.css('form')), 7000);
    const uel = await driver.findElement(By.css('input[name="username"]'));
    const pel = await driver.findElement(By.css('input[name="password"]'));
    await uel.clear(); await uel.sendKeys(user.username);
    await pel.clear(); await pel.sendKeys(user.password);
    const submit = await driver.findElement(By.css('form button[type="submit"], form button'));
    await submit.click();
    try { await driver.wait(until.urlContains('/dashboard'), 8000); } catch (e) { await driver.wait(until.elementLocated(By.css('.panel-grid, .log')), 7000); }
  }

  async function logout() {
    const logoutLink = await driver.findElements(By.css('.btn-logout, a[href="/logout"]'));
    if (logoutLink.length) {
      try { await logoutLink[0].click(); await driver.wait(until.urlContains('/login'), 6000).catch(()=>driver.sleep(400)); }
      catch (e) { await driver.get(BASE + '/logout'); await driver.wait(until.urlContains('/login'), 5000).catch(()=>driver.sleep(400)); }
    } else { await driver.get(BASE + '/logout'); await driver.wait(until.urlContains('/login'), 5000).catch(()=>driver.sleep(400)); }
  }

  async function findOrderRowByFromTo(fromId, toId, timeout = 8000) {
    await driver.wait(until.elementLocated(By.css('table.data-table tbody')), timeout);
    const rows = await driver.findElements(By.css('table.data-table tbody tr'));
    for (const r of rows) {
      const tds = await r.findElements(By.css('td'));
      if (tds.length < 4) continue;
      const dariText = (await tds[1].getText()).trim().toLowerCase();
      const keText = (await tds[2].getText()).trim();
      if ((String(dariText).includes(String(fromId)) || dariText.includes(String(fromId))) && String(keText) === String(toId)) {
        return { row: r, tds };
      }
    }
    return null;
  }

  async function waitForOrderInMonitor(fromId, toId, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await driver.executeAsyncScript(function(cb){
        fetch('/api/monitor', { credentials: 'same-origin' }).then(r => r.ok ? r.json().then(d=>cb(d)) : r.text().then(t=>cb({__err:true,text:t}))).catch(e=>cb({__err:true,text:String(e)}));
      });
      if (result && result.orders && Array.isArray(result.orders)) {
        const found = result.orders.find(o => String(o.from_id) === String(fromId) && String(o.to_id) === String(toId));
        if (found) return found;
      }
      await driver.sleep(500);
    }
    return null;
  }

  // check navbar links visible for role
  async function checkNavForRole(role) {
    await driver.wait(until.elementLocated(By.css('header.site-header')), 5000);
    const navLinks = await driver.findElements(By.css('header.site-header .primary-nav a'));
    const texts = await Promise.all(navLinks.map(a => a.getText()));
    if (String(role).toLowerCase() === 'admin') {
      expect(texts.join(' ').toLowerCase()).to.include('manajemen user');
    } else if (String(role).toLowerCase() === 'supplier') {
      expect(texts.join(' ').toLowerCase()).to.include('po masuk');
    } else if (String(role).toLowerCase() === 'kitchen') {
      expect(texts.join(' ').toLowerCase()).to.include('pemakaian bahan');
    } else {
      expect(texts.join(' ').toLowerCase()).to.satisfy(s => s.includes('orders') || s.includes('inventory') || s.includes('purchase'));
    }
  }

  // ---------- tests ----------
  it('registers users for each role', async () => {
    // create sender & receiver & other roles
    await registerUserUnique(USERS.sender, 'e2e_sender');
    await registerUserUnique(USERS.receiver, 'e2e_receiver');
    await registerUserUnique(USERS.kitchen, 'e2e_kitchen');
    await registerUserUnique(USERS.supplier, 'e2e_supplier');
    await registerUserUnique(USERS.pimpinan, 'e2e_pimpinan');

    // sanity
    for (const k of Object.keys(USERS)) {
      expect(USERS[k].username).to.be.a('string').and.to.have.length.greaterThan(3);
    }
  });

  let createdOrderMonitor = null; // store order object from /api/monitor

  it('sender creates order and clicks Kirim (all UI buttons pressed)', async () => {
    await login(USERS.sender);
    await checkNavForRole(USERS.sender.role);

    await driver.get(BASE + '/orders');
    await driver.wait(until.elementLocated(By.css('#createOrderForm')), 8000);

    // set destination to branch (internal transfer)
    await driver.executeScript("const t = document.getElementById('to_type'); if(t){ t.value='branch'; t.dispatchEvent(new Event('change')); }");
    await driver.wait(async () => (await driver.findElements(By.css('#to_target option'))).length > 0, 7000);
    await driver.executeScript(`const t = document.getElementById('to_target'); if(t){ t.value = arguments[0]; t.dispatchEvent(new Event('change')); }`, RECEIVER_BRANCH);

    // fill item and qty
    const itemInput = await driver.findElement(By.css('#itemsArea .itemRow input[name="item_id"]'));
    await itemInput.clear(); await itemInput.sendKeys('TESTITEM-01');
    const qtyInput = await driver.findElement(By.css('#itemsArea .itemRow input[name="qty"]'));
    await qtyInput.clear(); await qtyInput.sendKeys('5');

    // click create order
    const createBtn = await driver.findElement(By.xpath("//form[@id='createOrderForm']//button[normalize-space(.)='Buat Order' or contains(normalize-space(.),'Buat Order')]"));
    await createBtn.click();

    // accept alert if present
    await acceptAlertIfPresent(5000);

    // wait for order to appear in monitor (server persisted)
    const found = await waitForOrderInMonitor(SENDER_BRANCH, RECEIVER_BRANCH, 20000);
    expect(found, 'order must be present in server monitor after create').to.not.be.null;
    createdOrderMonitor = found;

    // now find order row in UI and click Kirim
    let rowObj = null;
    for (let i = 0; i < 8; i++) {
      await driver.navigate().refresh();
      await driver.sleep(700);
      rowObj = await findOrderRowByFromTo(SENDER_BRANCH, RECEIVER_BRANCH);
      if (rowObj) break;
      await driver.sleep(300);
    }
    expect(rowObj, 'order row should exist after creation').to.not.be.null;

    const kirimBtns = await rowObj.row.findElements(By.xpath(".//button[contains(normalize-space(.),'Kirim')]"));
    expect(kirimBtns.length, 'Kirim button for sender should exist').to.be.greaterThan(0);
    await kirimBtns[0].click();

    // confirm dialog
    await acceptAlertIfPresent(5000);

    // refresh and ensure status becomes menunggu/waiting
    await driver.sleep(800);
    await driver.navigate().refresh();
    await driver.sleep(700);
    const afterRow = await findOrderRowByFromTo(SENDER_BRANCH, RECEIVER_BRANCH);
    expect(afterRow).to.not.be.null;
    const statusText = (await afterRow.tds[3].getText()).toLowerCase();
    expect(statusText).to.satisfy(s => s.includes('menunggu') || s.includes('waiting') || s.includes('pending'));

    await logout();
  });

  it('receiver clicks "Buat PO Balasan" (and ensures it was created)', async () => {
    await login(USERS.receiver);
    await checkNavForRole(USERS.receiver.role);

    await driver.get(BASE + '/orders');
    await driver.wait(until.elementLocated(By.css('table.data-table tbody')), 8000);
    await driver.sleep(600);

    // find the order from sender -> receiver
    let rowObj = await findOrderRowByFromTo(SENDER_BRANCH, RECEIVER_BRANCH);
    if (!rowObj) {
      for (let i = 0; i < 6 && !rowObj; i++) {
        await driver.navigate().refresh();
        await driver.sleep(700);
        rowObj = await findOrderRowByFromTo(SENDER_BRANCH, RECEIVER_BRANCH);
      }
    }
    expect(rowObj, 'order should be visible to receiver').to.not.be.null;

    // ensure status is menunggu (so receiver must create PO)
    const statusNow = (await rowObj.tds[3].getText()).toLowerCase();
    expect(statusNow).to.satisfy(s => s.includes('menunggu') || s.includes('waiting') || s.includes('pending'));

    // click "Buat PO" (our UI creates a GET form redirect to /po/create?orderId=...)
    const poBackBtns = await rowObj.row.findElements(By.xpath(".//button[contains(normalize-space(.),'Buat PO') or contains(normalize-space(.),'Buat PO Balasan')]"));
    expect(poBackBtns.length, 'Buat PO button should be present for receiver').to.be.greaterThan(0);
    await poBackBtns[0].click();

    // confirm if any
    await acceptAlertIfPresent(4000);

    // after creating PO back, the UI should redirect to /po/create (or directly to /po)
    await driver.wait(async () => (await driver.getCurrentUrl()).includes('/po') || (await driver.getCurrentUrl()).includes('/po/create'), 8000).catch(()=>driver.sleep(400));
    await driver.sleep(600);

    // If landed on /po/create page we need to fill unit_price fields then submit
    const curUrl = await driver.getCurrentUrl();
    if (curUrl.includes('/po/create')) {
      // wait for itemsArea
      await driver.wait(until.elementLocated(By.css('#itemsArea')), 7000);

      // Fill unit_price for each row (>0). Find all input[name=unit_price]
      const priceInputs = await driver.findElements(By.css('#itemsArea input[name="unit_price"]'));
      if (priceInputs.length === 0) {
        // maybe the prefilled inputs are present but with different attribute - try any input[text]
      }
      // Fill all unit_price fields with "5000"
      for (const pi of priceInputs) {
        try {
          await pi.clear();
          await pi.sendKeys('5000');
        } catch (e) {}
      }

      // submit form
      const submitBtn = await driver.findElements(By.xpath("//form[@id='poForm']//button[normalize-space(.)='Buat PO' or contains(normalize-space(.),'Buat PO')]"));
      if (submitBtn.length) {
        await submitBtn[0].click();
      } else {
        const btn = await driver.findElement(By.css('form#poForm button[type="submit"], form#poForm button'));
        await btn.click();
      }
      await acceptAlertIfPresent(4000);

      // should redirect to /po
      await driver.wait(until.urlContains('/po'), 8000).catch(()=>driver.sleep(400));
      await driver.sleep(600);
    }

    // Now in /po - ensure PO exists (either as purchase_orders, or as internal order created)
    await driver.get(BASE + '/po');
    await driver.wait(until.elementLocated(By.css('.page, table')), 7000);
    await driver.sleep(600);

    // Check PO table for presence of our test item (or a new internal order in orders)
    const poTableRows = await driver.findElements(By.css('.data-table tbody tr'));
    let foundPoForOrder = false;
    for (const r of poTableRows) {
      const tds = await r.findElements(By.css('td'));
      const tdText = tds.length ? (await Promise.all(tds.map(td=>td.getText()))).join(' | ') : '';
      if (tdText.toLowerCase().includes('testitem') || tdText.includes('TESTITEM-01')) {
        foundPoForOrder = true;
        break;
      }
    }

    // Also check if an internal order was created (search /orders for an order from receiver -> sender)
    let internalOrderFound = false;
    await driver.get(BASE + '/orders');
    await driver.wait(until.elementLocated(By.css('table.data-table tbody')), 7000);
    await driver.sleep(600);
    const maybe = await findOrderRowByFromTo(RECEIVER_BRANCH, SENDER_BRANCH).catch ? await findOrderRowByFromTo(RECEIVER_BRANCH, SENDER_BRANCH) : null;
    if (maybe) internalOrderFound = true;

    expect(foundPoForOrder || internalOrderFound, 'Either a purchase_orders row or an internal order should have been created by receiver').to.be.true;

    await logout();
  });

  it('sender accepts PO (either purchase_orders -> approve/ship flow OR internal order -> accept_po) then completes order and inventory increases', async () => {
    await login(USERS.sender);
    await checkNavForRole(USERS.sender.role);

    // First try to find a purchase_orders row in /po that corresponds to that orig order or contains TESTITEM-01
    await driver.get(BASE + '/po');
    await driver.wait(until.elementLocated(By.css('.page, table')), 7000);
    await driver.sleep(600);
    let poRowElem = null;
    const poRows = await driver.findElements(By.css('.data-table tbody tr'));
    for (const r of poRows) {
      const tds = await r.findElements(By.css('td'));
      if (!tds.length) continue;
      const combined = (await Promise.all(tds.map(td => td.getText()))).join(' | ');
      if (combined.toLowerCase().includes('testitem') || combined.includes('TESTITEM-01') || combined.includes(String(RECEIVER_BRANCH))) {
        poRowElem = { row: r, tds };
        break;
      }
    }

    // If we found a PO row in /po, we will try to Approve it (if button shown) or click Kirim PO if present
    if (poRowElem) {
      // try to find Approve / Terima PO button
      const approveBtns = await poRowElem.row.findElements(By.xpath(".//button[contains(normalize-space(.),'Approve') or contains(normalize-space(.),'Terima PO') or contains(normalize-space(.),'Terima')]"));
      if (approveBtns.length) {
        await approveBtns[0].click();
        await acceptAlertIfPresent(4000);
        await driver.sleep(700);
      }

      // After approve, check if receiver (creator) needs to ship: we will log out and login as receiver to press Kirim PO
      await logout();
      await login(USERS.receiver);
      await driver.get(BASE + '/po');
      await driver.wait(until.elementLocated(By.css('.data-table tbody')), 7000);
      await driver.sleep(600);
      // find PO row with TESTITEM
      let myPoRow = null;
      const rrows = await driver.findElements(By.css('.data-table tbody tr'));
      for (const r of rrows) {
        const tds = await r.findElements(By.css('td'));
        if (!tds.length) continue;
        const txt = (await Promise.all(tds.map(td=>td.getText()))).join(' | ');
        if (txt.toLowerCase().includes('testitem') || txt.includes('TESTITEM-01')) {
          myPoRow = { row: r, tds };
          break;
        }
      }
      if (myPoRow) {
        // find Kirim PO / Mark DIKIRIM / Kirim button
        const shipBtns = await myPoRow.row.findElements(By.xpath(".//button[contains(normalize-space(.),'Kirim PO') or contains(normalize-space(.),'Mark DIKIRIM') or contains(normalize-space(.),'Kirim')]"));
        if (shipBtns.length) {
          await shipBtns[0].click();
          await acceptAlertIfPresent(4000);
          await driver.sleep(700);
        }
      }

      // go back to sender to finish order
      await logout();
      await login(USERS.sender);
      await driver.get(BASE + '/orders');
      await driver.wait(until.elementLocated(By.css('table.data-table tbody')), 8000);
      await driver.sleep(700);

      // find original order row (sender->receiver) and check status dikirimkan
      let origRow = await findOrderRowByFromTo(SENDER_BRANCH, RECEIVER_BRANCH);
      for (let i = 0; i < 8 && origRow; i++) {
        const st = (await origRow.tds[3].getText()).toLowerCase();
        if (st.includes('dikirimkan') || st.includes('shipped')) break;
        await driver.navigate().refresh();
        await driver.sleep(600);
        origRow = await findOrderRowByFromTo(SENDER_BRANCH, RECEIVER_BRANCH);
      }
      expect(origRow, 'original order (sender->receiver) should be visible to sender').to.not.be.null;
      const stAfter = (await origRow.tds[3].getText()).toLowerCase();
      expect(stAfter).to.satisfy(s => s.includes('dikirimkan') || s.includes('shipped'));

      // Click Terima (finish_by_creator)
      const terimaBtns = await origRow.row.findElements(By.xpath(".//button[contains(normalize-space(.),'Terima') and not(contains(normalize-space(.),'Terima PO'))]"));
      expect(terimaBtns.length, 'Terima (finish) button should appear for sender').to.be.greaterThan(0);
      await terimaBtns[0].click();
      await acceptAlertIfPresent(5000);

      // refresh and ensure order is selesai
      await driver.sleep(800);
      await driver.navigate().refresh();
      await driver.sleep(700);
      const finalRow = await findOrderRowByFromTo(SENDER_BRANCH, RECEIVER_BRANCH);
      expect(finalRow).to.not.be.null;
      const finalStatus = (await finalRow.tds[3].getText()).toLowerCase();
      expect(finalStatus).to.satisfy(s => s.includes('selesai') || s.includes('received') || s.includes('done'));
    } else {
      // fallback: maybe PO was created as internal order in /orders by receiver -> find that, accept it, and continue
      await driver.get(BASE + '/orders');
      await driver.wait(until.elementLocated(By.css('table.data-table tbody')), 8000);
      await driver.sleep(600);

      let poRow = await findOrderRowByFromTo(RECEIVER_BRANCH, SENDER_BRANCH);
      if (!poRow) {
        for (let i = 0; i < 8 && !poRow; i++) {
          await driver.navigate().refresh();
          await driver.sleep(600);
          poRow = await findOrderRowByFromTo(RECEIVER_BRANCH, SENDER_BRANCH);
        }
      }
      expect(poRow, 'PO (internal order created by receiver) should be visible to sender').to.not.be.null;

      // Click "Terima PO" (this triggers accept_po which should change the original order status to dikirimkan)
      const terimaPoBtns = await poRow.row.findElements(By.xpath(".//button[contains(normalize-space(.),'Terima PO') or contains(normalize-space(.),'Terima')]"));
      expect(terimaPoBtns.length, 'Terima PO button should be present for sender to accept PO masuk').to.be.greaterThan(0);
      await terimaPoBtns[0].click();
      await acceptAlertIfPresent(4000);

      // After accepting PO, original order (sender->receiver) should be set to dikirimkan
      await driver.sleep(800);
      await driver.get(BASE + '/orders');
      await driver.wait(until.elementLocated(By.css('table.data-table tbody')), 8000);
      await driver.sleep(600);

      let origRow = await findOrderRowByFromTo(SENDER_BRANCH, RECEIVER_BRANCH);
      for (let i = 0; i < 8 && origRow; i++) {
        const st = (await origRow.tds[3].getText()).toLowerCase();
        if (st.includes('dikirimkan') || st.includes('shipped')) break;
        await driver.navigate().refresh();
        await driver.sleep(600);
        origRow = await findOrderRowByFromTo(SENDER_BRANCH, RECEIVER_BRANCH);
      }
      expect(origRow, 'original order should exist after accept_po').to.not.be.null;
      const stAfter = (await origRow.tds[3].getText()).toLowerCase();
      expect(stAfter).to.satisfy(s => s.includes('dikirimkan') || s.includes('shipped'));

      // Now click Terima (finish_by_creator)
      const terimaBtns2 = await origRow.row.findElements(By.xpath(".//button[contains(normalize-space(.),'Terima') and not(contains(normalize-space(.),'Terima PO'))]"));
      expect(terimaBtns2.length, 'Terima (finish) should be visible').to.be.greaterThan(0);
      await terimaBtns2[0].click();
      await acceptAlertIfPresent(5000);

      await driver.sleep(800);
      await driver.navigate().refresh();
      await driver.sleep(700);
      const finalRow = await findOrderRowByFromTo(SENDER_BRANCH, RECEIVER_BRANCH);
      expect(finalRow).to.not.be.null;
      const finalStatus = (await finalRow.tds[3].getText()).toLowerCase();
      expect(finalStatus).to.satisfy(s => s.includes('selesai') || s.includes('received') || s.includes('done'));
    }

    // verify inventory increased for sender branch for TESTITEM-01
    const inv = await driver.executeScript(`
      const BR = arguments[0];
      return fetch('/api/inventory/' + BR, { credentials: 'same-origin' }).then(r => {
        if (!r.ok) return { __err: 'not-ok', status: r.status };
        return r.json();
      }).catch(e => ({ __err: String(e) }));
    `, SENDER_BRANCH);

    expect(inv, 'inventory result should exist for sender').to.not.be.undefined;
    if (inv && inv.__err) throw new Error('Inventory API error: ' + JSON.stringify(inv));

    // find key that matches TESTITEM-01 (case-insensitive)
    const key = Object.keys(inv || {}).find(k => k.toLowerCase().includes('testitem')) || 'TESTITEM-01';
    expect(key, 'expected TESTITEM-01 (or similar) present in inventory keys of sender').to.exist;
    const qtyVal = inv[key] && inv[key].qty;
    expect(Number(qtyVal), 'inventory qty for TESTITEM-01 at sender').to.be.at.least(5);

    await logout();
  });

});
