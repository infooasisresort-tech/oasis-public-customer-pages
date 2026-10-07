const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'daypass/index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'daypass/app.js'), 'utf8');
const GUARD = 'or-reservas-read-v1';
const START = Date.parse('2026-10-07T12:00:00Z');
const DATE = '2026-10-08';
const event = () => ({ preventDefault() { this.defaultPrevented = true; } });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

class Element {
  constructor(tag = 'div', attrs = '') {
    this.tag = tag;
    this.attrs = attrs;
    this.value = '';
    this.checked = false;
    this.disabled = /\bdisabled\b/.test(attrs);
    this.required = /\brequired\b/.test(attrs);
    this.type = /type="([^"]+)"/.exec(attrs)?.[1];
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = '';
    this.href = '#';
    this.attributes = {};
    const classes = new Set((/class="([^"]*)"/.exec(attrs)?.[1] || '').split(/\s+/));
    this.classList = {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name),
      toggle: (name, force) => { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); }
    };
  }
  addEventListener(type, callback) { const handlers = this.listeners.get(type) || []; handlers.push(callback); this.listeners.set(type, handlers); }
  setAttribute(name, value) { this.attributes[name] = value; }
  scrollIntoView() { this.scrolled = true; }
  async fire(type, value = event()) { value.target = this; await Promise.all((this.listeners.get(type) || []).map((fn) => fn(value))); return value; }
}

function harness({ fetch = async () => { throw new Error('Unexpected mocked request'); }, storage = new Map(),
  digest = (algorithm, value) => webcrypto.subtle.digest(algorithm, value), randomUUID = () => webcrypto.randomUUID() } = {}) {
  let now = START;
  let timerId = 0;
  const timers = new Map();
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const elements = new Map();
  const controls = [];
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1], match[2]);
    elements.set(`#${match[3]}`, element);
    if (['input', 'button', 'textarea'].includes(match[1])) controls.push(element);
  }
  const consent = new Element('input', 'type="checkbox" required');
  consent.checked = true;
  controls.push(consent);
  const counterButtons = [];
  for (const name of ['adults', 'children', 'paellaServings']) {
    for (const step of [-1, 1]) {
      const button = new Element('button');
      button.dataset.step = String(step);
      button.parentElement = { dataset: { counter: name } };
      counterButtons.push(button);
      controls.push(button);
    }
  }
  const options = (key, values) => values.map((value) => { const element = new Element('button'); element.dataset[key] = value; controls.push(element); return element; });
  const entry = options('entry', ['10:00', '10:15', 'Después de las 12:00']);
  const tent = options('tent', ['none', 'C9', 'C10']);
  const paella = options('paella', ['valenciana', 'marisco', 'verduras', 'bogavante']);
  const queryAll = {
    '[data-counter] button': counterButtons, '[data-entry]': entry, '[data-tent]': tent, '[data-paella]': paella,
    '#booking-form input, #booking-form textarea, #booking-form button': controls
  };
  const input = (id, value) => { elements.get(id).value = value; };
  input('#first-name', 'Test'); input('#last-name', 'Customer'); input('#phone', '+34000000000');
  elements.get('#card-payment-button').textContent = 'Pagar con tarjeta';
  elements.get('#manual-transfer-button').textContent = 'Usar transferencia y WhatsApp';
  elements.get('#booking-form').reportValidity = () => controls.every((control) => {
    if (control.disabled) return true;
    if (control.required && !(control.type === 'checkbox' ? control.checked : control.value)) return false;
    if (control.type === 'email' && control.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(control.value)) return false;
    return true;
  });
  const requests = [];
  const redirects = [];
  const opens = [];
  const history = [];
  const window = {
    location: { search: '', pathname: '/daypass/', assign: (url) => redirects.push(url) },
    open: (...args) => opens.push(args), history: { replaceState: (...args) => history.push(args) }
  };
  const context = vm.createContext({
    document: {
      querySelector: (selector) => { if (!elements.has(selector)) throw new Error(`Missing element: ${selector}`); return elements.get(selector); },
      querySelectorAll: (selector) => { if (!queryAll[selector]) throw new Error(`Missing query: ${selector}`); return queryAll[selector]; }
    },
    window, Date: TestDate, URL, URLSearchParams, AbortController, TextEncoder, crypto: { subtle: { digest }, randomUUID },
    sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    fetch: async (url, options) => { const request = { url: new URL(url), options, payload: options.body ? JSON.parse(options.body) : undefined }; requests.push(request); return fetch(request); },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(source, context, { filename: 'daypass/app.js' });
  const run = (code) => vm.runInContext(code, context);
  const tick = async (duration) => {
    now += duration;
    for (let safety = 0; safety < 100; safety++) {
      const due = [...timers.entries()].find(([, timer]) => timer.at <= now);
      if (!due) return;
      timers.delete(due[0]); due[1].callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('Too many mocked timers');
  };
  const available = (request, remaining = 10, overrides = {}) => ({
    capacityGuard: GUARD, date: request.url.searchParams.get('date'),
    adults: Number(request.url.searchParams.get('adults')), children: Number(request.url.searchParams.get('children')),
    remaining, available: remaining >= Number(request.url.searchParams.get('adults')) + Number(request.url.searchParams.get('children')),
    checkedAt: new TestDate().toISOString(), ...overrides
  });
  const reservation = (overrides = {}) => ({ reference: 'DP-MOCK-ONLY', capacityGuard: GUARD, ...overrides });
  const checkout = (overrides = {}) => ({ capacityGuard: GUARD, url: 'https://checkout.stripe.com/c/pay/mock-not-real', ...overrides });
  return { context, run, elements, controls, input, requests, redirects, opens, history, window, available, reservation, checkout, storage, tick,
    select: async (date = DATE) => { input('#date', date); if (run('availability.selection') === run('selectionKey(capacitySelection())')) await run('checkAvailability()'); else await elements.get('#date').fire('input'); },
    submit: (method = 'card') => { context.testEvent = event(); return run(`submitBooking(testEvent, ${JSON.stringify(method)})`); },
    buttonsBlocked: () => elements.get('#card-payment-button').disabled && elements.get('#manual-transfer-button').disabled,
    status: () => elements.get('#availability-status').dataset.state,
    hidden: (id) => elements.get(id).classList.contains('hidden')
  };
}

test('HTML is blocked before JavaScript and preserves the published field/content contract', () => {
  for (const id of ['card-payment-button', 'manual-transfer-button']) assert.match(html, new RegExp(`<button[^>]*id="${id}"[^>]*disabled`));
  for (const id of ['first-name', 'last-name', 'phone']) assert.match(html, new RegExp(`<input[^>]*id="${id}"[^>]*required`));
  for (const id of ['email', 'additional-info']) {
    const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(html)[0]; assert.doesNotMatch(tag, /\brequired\b/);
  }
  assert.match(html, /Indica alergias, intolerancias o cualquier requisito especial que debamos tener en cuenta\./);
  assert.match(html, /CESTA incluida/); assert.match(html, /Tu oasis de verano, muy cerca de Valencia\./);
  assert.match(html, /La hora reservada es estricta\./); assert.match(html, /destination=Carrer\+Oasis\+1/);
  const app = harness(); assert.ok(app.buttonsBlocked()); assert.equal(app.requests.length, 0);
});

test('zero, insufficient capacity and invalid/legacy data block both methods without any order or charge', async (t) => {
  const cases = [
    ['zero', 0, {}], ['insufficient', 1, {}], ['legacy', 10, { capacityGuard: undefined }],
    ['wrong date', 10, { date: '2026-10-09' }], ['wrong group', 10, { adults: 3 }],
    ['negative', -1, {}], ['fraction', 2.5, {}], ['text count', '10', {}],
    ['incoherent', 0, { available: true }], ['invalid timestamp', 10, { checkedAt: 'yesterday' }],
    ['invalid calendar', 10, { checkedAt: '2026-02-30T12:00:00Z' }],
    ['stale timestamp', 10, { checkedAt: '2000-01-01T00:00:00Z' }],
    ['future timestamp', 10, { checkedAt: new Date(START + 6000).toISOString() }]
  ];
  for (const [name, remaining, overrides] of cases) await t.test(name, async () => {
    const app = harness({ fetch: (request) => response(app.available(request, remaining, overrides)) });
    await app.select(); await app.submit(); await app.submit('transfer');
    assert.ok(app.buttonsBlocked()); assert.equal(app.requests.length, 1); assert.equal(app.opens.length, 0); assert.equal(app.redirects.length, 0);
    assert.ok(app.hidden('#confirmation')); assert.ok(['blocked', 'error'].includes(app.status()));
  });
});

test('network, HTTP and JSON failures are fail closed, and availability timeout does not hang', async (t) => {
  for (const [name, fetch] of [
    ['network', () => { throw new Error('offline'); }], ['HTTP', () => response({}, 503)],
    ['JSON', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); } })]
  ]) await t.test(name, async () => {
    const app = harness({ fetch }); await app.select(); assert.equal(app.status(), 'error'); assert.ok(app.buttonsBlocked());
  });
  const app = harness({ fetch: () => new Promise(() => {}) });
  const checking = app.select(); await app.tick(10000); await checking;
  assert.equal(app.status(), 'error'); assert.ok(app.requests[0].options.signal.aborted); assert.ok(app.buttonsBlocked());
});

test('People shows the current maximum only when adults plus children exceeds it, including zero', async (t) => {
  for (const [remaining, children, exceeds] of [[0, 0, true], [1, 0, true], [2, 0, false], [3, 0, false], [2, 1, true], [3, 1, false], [4, 1, false]]) {
    await t.test(`${2 + children} people / ${remaining} places`, async () => {
      const app = harness({ fetch: (request) => response(app.available(request, remaining)) });
      app.run(`state.children = ${children}`);
      await app.select();
      const message = app.elements.get('#availability-status').textContent;
      if (exceeds) {
        assert.match(message, new RegExp(`Máximo disponible para esta fecha: ${remaining} persona${remaining === 1 ? '' : 's'}\\.`));
        assert.equal(app.status(), 'blocked'); assert.ok(app.buttonsBlocked());
      } else {
        assert.doesNotMatch(message, /Máximo|\d/); assert.equal(app.status(), 'available'); assert.ok(!app.buttonsBlocked());
      }
    });
  }
  assert.match(html, /<legend><b>2<\/b> Personas<\/legend>\s*<div[^>]*class="availability-panel"[\s\S]*?id="availability-status"/);
});

test('a new availability read and error clear the previous blocked maximum instead of reusing it', async (t) => {
  for (const previousRemaining of [0, 1]) await t.test(`previous maximum ${previousRemaining}`, async () => {
    const pending = deferred();
    let reads = 0;
    const app = harness({ fetch: (request) => ++reads === 1 ? response(app.available(request, previousRemaining)) : pending.promise });
    await app.select();
    assert.match(app.elements.get('#availability-status').textContent, new RegExp(`Máximo disponible para esta fecha: ${previousRemaining} personas?`));
    const checking = app.select();
    assert.equal(app.status(), 'checking'); assert.doesNotMatch(app.elements.get('#availability-status').textContent, /Máximo|\d/);
    pending.resolve(response({}, 503)); await checking;
    assert.equal(app.status(), 'error'); assert.ok(app.buttonsBlocked());
    assert.match(app.elements.get('#availability-status').textContent, /No podemos comprobar las plazas/);
    assert.doesNotMatch(app.elements.get('#availability-status').textContent, /Máximo|\d/);
    assert.ok(app.hidden('#confirmation')); assert.equal(app.opens.length, 0); assert.equal(app.redirects.length, 0);
  });
});

test('out-of-order availability cannot enable a new date or changed group', async () => {
  const pending = [];
  const app = harness({ fetch: (request) => { const task = deferred(); pending.push({ task, request }); return task.promise; } });
  const first = app.select(); const second = app.select('2026-10-09');
  assert.ok(app.requests[0].options.signal.aborted); assert.ok(app.buttonsBlocked());
  pending[1].task.resolve(response(app.available(pending[1].request, 0))); await second;
  pending[0].task.resolve(response(app.available(pending[0].request, 10))); await first;
  assert.equal(app.status(), 'blocked'); assert.ok(app.buttonsBlocked());
  app.run('changeCounter("children", 1)'); assert.ok(app.buttonsBlocked());
  assert.equal(pending[2].request.url.searchParams.get('children'), '1');
  pending[2].task.resolve(response(app.available(pending[2].request, 2))); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.status(), 'blocked'); assert.ok(app.buttonsBlocked());
});

test('authoritative rejection after successful preview never opens checkout or transfer', async () => {
  const app = harness({ fetch: (request) => request.url.pathname === '/availability'
    ? response(app.available(request)) : response({ error: 'capacity changed' }, 409) });
  await app.select(); assert.ok(!app.buttonsBlocked()); await app.submit();
  assert.equal(app.status(), 'blocked'); assert.ok(app.buttonsBlocked());
  assert.equal(app.requests.filter((r) => r.url.pathname === '/create-checkout-session').length, 0);
  assert.equal(app.opens.length, 0); assert.equal(app.redirects.length, 0);
});

test('availability preview expires after 30 seconds, blocks new orders, and change-only date events refresh it', async () => {
  const app = harness({ fetch: (request) => response(app.available(request)) });
  await app.select(); assert.ok(!app.buttonsBlocked());
  await app.tick(30001); assert.equal(app.status(), 'stale'); assert.ok(app.buttonsBlocked());
  await app.submit(); assert.equal(app.requests.length, 1);
  app.input('#date', '2026-10-09'); await app.elements.get('#date').fire('change');
  assert.equal(app.status(), 'available'); assert.ok(!app.buttonsBlocked()); assert.equal(app.requests.length, 2);
  await app.elements.get('#date').fire('input'); await app.elements.get('#date').fire('change');
  assert.equal(app.requests.length, 2);
});

test('one guarded card attempt freezes controls, ignores duplicate submits, and opens only valid Stripe HTTPS', async () => {
  const pending = deferred();
  const app = harness({ fetch: (request) => {
    if (request.url.pathname === '/availability') return response(app.available(request));
    if (request.url.pathname === '/reservations') return pending.promise;
    return response(app.checkout());
  } });
  await app.select(); const first = app.submit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(app.buttonsBlocked()); assert.ok(app.controls.filter((c) => c !== app.elements.get('#availability-retry')).every((c) => c.disabled));
  await app.submit(); await app.submit('transfer');
  const adults = app.run('state.adults'); app.run('changeCounter("adults", 1)'); assert.equal(app.run('state.adults'), adults);
  pending.resolve(response(app.reservation())); await first;
  const orders = app.requests.filter((r) => r.url.pathname === '/reservations'); assert.equal(orders.length, 1);
  assert.equal(orders[0].payload.paymentMethod, 'card'); assert.match(orders[0].payload.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(app.redirects.length, 1); assert.equal(app.opens.length, 0);
  assert.equal(app.elements.get('#date').disabled, false);
});

test('uncertain reservation retries keep the UUID; failed checkout retries keep the UUID and reference', async () => {
  let reservations = 0; let checkouts = 0;
  const app = harness({ fetch: (request) => {
    if (request.url.pathname === '/availability') return response(app.available(request));
    if (request.url.pathname === '/reservations') {
      if (++reservations === 1) throw new Error('Connection dropped after server write');
      return response(app.reservation());
    }
    if (++checkouts === 1) throw new Error('Checkout connection lost');
    return response(app.checkout());
  } });
  await app.select(); await app.submit(); await app.select(); await app.submit();
  const orders = app.requests.filter((r) => r.url.pathname === '/reservations');
  assert.equal(orders.length, 2); assert.equal(orders[0].payload.idempotencyKey, orders[1].payload.idempotencyKey);
  await app.select(); await app.submit();
  assert.equal(app.requests.filter((r) => r.url.pathname === '/reservations').length, 2);
  const checkoutRequests = app.requests.filter((r) => r.url.pathname === '/create-checkout-session');
  assert.equal(checkoutRequests.length, 2); assert.equal(checkoutRequests[0].payload.idempotencyKey, checkoutRequests[1].payload.idempotencyKey);
  assert.equal(checkoutRequests[0].payload.reference, checkoutRequests[1].payload.reference); assert.equal(app.redirects.length, 1);
  const saved = [...app.storage.values()].join(''); assert.doesNotMatch(saved, /Test|Customer|34000000000|dietaryNotes|firstName/);
});

test('old reservation or checkout guards block payment; read-v1 requires no hold metadata', async (t) => {
  for (const method of ['card', 'transfer']) await t.test(`old reservation/${method}`, async () => {
    const app = harness({ fetch: (request) => request.url.pathname === '/availability'
      ? response(app.available(request)) : response({ reference: 'LEGACY' }) });
    await app.select(); await app.submit(method);
    assert.ok(app.buttonsBlocked()); assert.ok(app.hidden('#confirmation')); assert.equal(app.requests.length, 2);
    assert.equal(app.redirects.length, 0); assert.equal(app.opens.length, 0);
  });
  for (const override of [{ capacityGuard: 'or-reservas-v1' }, { capacityGuard: undefined },
    { url: 'http://checkout.stripe.com/pay' }, { url: 'https://checkout.stripe.com.evil.invalid/pay' },
    { url: 'https://user:password@checkout.stripe.com/pay' }, { url: 'javascript:alert(1)' }]) await t.test(JSON.stringify(override), async () => {
    const app = harness({ fetch: (request) => {
      if (request.url.pathname === '/availability') return response(app.available(request));
      if (request.url.pathname === '/reservations') return response(app.reservation());
      return response(app.checkout(override));
    } });
    await app.select(); await app.submit(); assert.equal(app.redirects.length, 0); assert.ok(app.buttonsBlocked());
  });
  assert.doesNotMatch(source, /holdExpiresAt|liveHold|sessionStorage|recoverStoredAttempt/);
});

test('a known reference gives no exception for zero capacity, and Checkout is revalidated independently', async () => {
  let reads = 0;
  const app = harness({ fetch: (request) => {
    if (request.url.pathname === '/availability') return response(app.available(request, ++reads === 1 ? 2 : 0));
    if (request.url.pathname === '/reservations') return response(app.reservation());
    throw new Error('Mock checkout unavailable');
  } });
  await app.select(); await app.submit(); await app.select();
  const before = app.requests.length; await app.submit(); await app.submit('transfer');
  assert.equal(app.requests.length, before); assert.ok(app.buttonsBlocked()); assert.equal(app.redirects.length, 0);
  assert.match(app.elements.get('#availability-status').textContent, /Máximo disponible para esta fecha: 0 personas/);
  const conflicting = harness({ fetch: (request) => {
    if (request.url.pathname === '/availability') return response(conflicting.available(request));
    if (request.url.pathname === '/reservations') return response(conflicting.reservation());
    return response({}, 409);
  } });
  await conflicting.select(); await conflicting.submit();
  assert.equal(conflicting.requests.at(-1).url.pathname, '/create-checkout-session');
  assert.ok(conflicting.buttonsBlocked()); assert.equal(conflicting.redirects.length, 0);
});

test('transfer sends paymentMethod and waits for backend guard before revealing bank/WhatsApp, and any change/read error clears it', async (t) => {
  for (const kind of ['customer', 'date', 'people', 'tent', 'error', 'stale']) await t.test(kind, async () => {
    let availabilityReads = 0;
    const app = harness({ fetch: (request) => {
      if (request.url.pathname === '/availability') {
        if (++availabilityReads > 1 && kind === 'error') return response({}, 503);
        return response(app.available(request));
      }
      return response(app.reservation());
    } });
    app.input('#additional-info', 'Mock note'); await app.select(); await app.submit('transfer');
    assert.ok(!app.hidden('#confirmation')); assert.equal(app.opens.length, 1); assert.equal(app.redirects.length, 0);
    assert.equal(app.requests.find((r) => r.payload).payload.paymentMethod, 'transfer');
    const message = new URL(app.elements.get('#whatsapp-link').href).searchParams.get('text');
    assert.match(message, /Nombre: Test/); assert.match(message, /Apellidos: Customer/); assert.match(message, /Información adicional: Mock note/);
    if (kind === 'customer') { app.input('#phone', '+34000000001'); await app.elements.get('#phone').fire('input'); }
    if (kind === 'date') await app.select('2026-10-09');
    if (kind === 'people') { app.run('changeCounter("children", 1)'); await new Promise((r) => setImmediate(r)); }
    if (kind === 'tent') app.run('state.tent="C9"; render()');
    if (kind === 'error') await app.select();
    if (kind === 'stale') await app.tick(30001);
    assert.ok(app.hidden('#confirmation')); assert.equal(app.elements.get('#whatsapp-link').href, '#');
    assert.equal((await app.elements.get('#whatsapp-link').fire('click')).defaultPrevented, true);
    if (['error', 'stale'].includes(kind)) assert.ok(app.buttonsBlocked());
  });
  const pending = deferred();
  const app = harness({ fetch: (request) => request.url.pathname === '/availability' ? response(app.available(request)) : pending.promise });
  await app.select(); const preparation = app.submit('transfer');
  assert.ok(app.hidden('#confirmation')); assert.equal(app.opens.length, 0); assert.ok(app.buttonsBlocked());
  pending.resolve(response(app.reservation())); await preparation; assert.equal(app.opens.length, 1);
});

test('required contact fields and late arrival prevent any order; email and notes remain optional', async () => {
  const app = harness({ fetch: (request) => request.url.pathname === '/availability' ? response(app.available(request)) : response(app.reservation()) });
  await app.select();
  for (const id of ['#first-name', '#last-name', '#phone']) {
    const prior = app.elements.get(id).value; app.input(id, ''); await app.submit('transfer'); app.input(id, prior);
  }
  app.run('state.entry="Después de las 12:00"'); await app.submit('transfer');
  assert.equal(app.requests.length, 1); app.input('#late-time', '13:00'); await app.submit('transfer');
  assert.equal(app.requests.length, 2); assert.ok(!app.hidden('#confirmation'));
});

test('payment return confirms only PAYMENT and never claims a retained or confirmed plaza', async (t) => {
  assert.match(html, /Tu pago con tarjeta está confirmado\./); assert.doesNotMatch(html, /Tu reserva está pagada y confirmada/);
  for (const [name, result, confirmed] of [
    ['original paid', { confirmed: true, reference: 'DP-MOCK-ONLY' }, true],
    ['read paid', { confirmed: true, capacityGuard: GUARD, reference: 'DP-MOCK-ONLY', status: 'paid' }, true],
    ['expired contradiction', { confirmed: true, reference: 'DP-MOCK-ONLY', status: 'expired' }, false],
    ['cancelled', { confirmed: false, status: 'cancelled' }, false],
    ['missing ref', { confirmed: true, status: 'expired' }, false]
  ]) await t.test(name, async () => {
    const app = harness({ fetch: () => response(result) });
    app.window.location.search = '?payment=success&session_id=mock-session'; await app.run('verifyReturnedPayment()');
    assert.equal(app.hidden('#payment-confirmation'), !confirmed); assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].options.body, undefined); assert.equal(app.redirects.length, 0); assert.equal(app.opens.length, 0);
  });
  const cancel = harness(); cancel.window.location.search = '?payment=cancel'; await cancel.run('verifyReturnedPayment()');
  assert.equal(cancel.requests.length, 0); assert.ok(cancel.hidden('#payment-confirmation'));
});

test('pending or unidentifiable returned payment performs only bounded reads and blocks another payment', async () => {
  const app = harness({ fetch: () => response({ confirmed: false }) });
  app.window.location.search = '?payment=success&session_id=mock-session'; const verification = app.run('verifyReturnedPayment()');
  for (let i = 0; i < 8; i++) { await new Promise((r) => setImmediate(r)); await app.tick(1200); }
  await verification; assert.equal(app.requests.length, 8); assert.ok(app.buttonsBlocked()); assert.ok(app.hidden('#payment-confirmation'));
  const missing = harness(); missing.window.location.search = '?payment=success'; await missing.run('verifyReturnedPayment()');
  assert.equal(missing.requests.length, 0); assert.ok(missing.buttonsBlocked());
});
