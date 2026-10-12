import vm from 'node:vm';

export function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> block found in html');
  return m[1];
}

function makeElement(id) {
  const el = {
    id,
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    title: '',
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    listeners: {},
  };
  el.classList = {
    add() {},
    remove() {},
    toggle() {},
    contains() {
      return false;
    },
  };
  el.addEventListener = (type, fn) => {
    (el.listeners[type] = el.listeners[type] || []).push(fn);
  };
  el.removeEventListener = () => {};
  el.click = () => {
    if (typeof el.onclick === 'function') el.onclick({ target: el });
    (el.listeners.click || []).forEach((fn) => fn({ target: el }));
  };
  el.setAttribute = () => {};
  el.getAttribute = () => null;
  el.removeAttribute = () => {};
  el.append = (...c) => {
    el.children.push(...c);
  };
  el.appendChild = (c) => {
    el.children.push(c);
    return c;
  };
  el.remove = () => {};
  el.focus = () => {};
  el.reset = () => {
    el.value = '';
  };
  el.closest = () => null;
  el.matches = () => false;
  el.querySelector = () => null;
  el.querySelectorAll = () => [];
  el.getBoundingClientRect = () => ({ width: 0, height: 0 });
  return el;
}

export function makeDom() {
  const elements = new Map();
  const app = makeElement('.app');
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const document = {
    getElementById: get,
    querySelector: (sel) => (sel === '.app' ? app : elements.values().next().value || makeElement('q')),
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(tag),
    addEventListener: () => {},
    body: { append: () => {}, appendChild: () => {} },
  };
  return { document, get, app };
}

export function loadFrontend(html, { fetch, location } = {}) {
  const code = extractScript(html);
  const { document, get, app } = makeDom();
  const windowObj = {
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
  };
  const loc =
    location ||
    {
      reload() {
        this.calls = (this.calls || 0) + 1;
      },
    };
  const ctx = vm.createContext({
    document,
    window: windowObj,
    location: loc,
    fetch,
    confirm: () => true,
    navigator: {},
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vm.runInContext(code, ctx);
  return {
    get,
    document,
    app,
    windowObj,
    async flush() {
      for (let i = 0; i < 12; i += 1) {
        await new Promise((r) => setImmediate(r));
      }
    },
    reloads: () => loc.calls || 0,
  };
}