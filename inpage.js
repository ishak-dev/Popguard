// PopGuard layer 2. Runs inside the page's own JavaScript world on protected sites,
// before the page's scripts, and takes away the tricks used to open ad tabs:
//   - window.open to other sites (returns a harmless fake window so the ad script thinks it worked),
//     including the trick of borrowing a clean window.open from a fresh hidden iframe
//   - real or scripted clicks on links that open other sites in a new tab
//   - forms that submit to other sites in a new tab
//   - invisible layers laid over the video player to steal clicks
//   - "click Allow to continue" notification prompts
// Anything this misses is still caught by layer 1 in background.js.
(() => {
  'use strict';
  if (window.__popguard__) return;
  Object.defineProperty(window, '__popguard__', { value: true });

  // ---------- which site are we protecting ----------

  const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);
  function baseDomain(host) {
    host = host.toLowerCase().replace(/\.$/, '');
    if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return host;
    const parts = host.split('.');
    const n = parts.length;
    const take = n > 2 && parts[n - 1].length === 2 && SECOND_LEVEL.has(parts[n - 2]) ? 3 : 2;
    return parts.slice(-take).join('.');
  }

  // In an iframe (e.g. an embedded video player from another domain), protect on behalf of
  // the top page's site.
  const ancestors = location.ancestorOrigins;
  const topOrigin = ancestors && ancestors.length ? ancestors[ancestors.length - 1] : location.origin;
  let SITE;
  try {
    SITE = baseDomain(new URL(topOrigin).hostname);
  } catch {
    SITE = baseDomain(location.hostname);
  }
  let OWN_SITE;
  try {
    OWN_SITE = baseDomain(new URL(location.origin === 'null' ? topOrigin : location.origin).hostname);
  } catch {
    OWN_SITE = SITE;
  }
  // A player iframe from another domain: guard tab opening, but don't touch its layout,
  // since players have plenty of legitimate transparent layers.
  const FOREIGN_FRAME = OWN_SITE !== SITE;

  function isExternal(url) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const site = baseDomain(u.hostname);
      return site !== SITE && site !== OWN_SITE;
    } catch {
      return false;
    }
  }

  const opensNewTab = (target) => !!target && !/^_(self|top|parent)$/i.test(target);

  // bridge.js picks this up and forwards it to the background for the counter.
  function report(kind, url) {
    try {
      document.dispatchEvent(
        new CustomEvent('popguard:blocked', { detail: JSON.stringify({ kind, url: String(url || '') }) })
      );
    } catch {}
  }

  const looksNative = (fn, name) =>
    Object.defineProperty(fn, 'toString', { value: () => `function ${name}() { [native code] }` });

  // Stand-in for a popup window: every property and call returns itself, writes are ignored.
  const fakeWindow = new Proxy(function () {}, {
    get: (_, prop) =>
      prop === 'closed' ? false : prop === 'then' ? undefined : prop === Symbol.toPrimitive ? () => '' : fakeWindow,
    set: () => true,
    apply: () => fakeWindow,
  });

  const linkOf = (node) => (node && node.nodeType === 1 ? node.closest('a[href], area[href]') : null);

  // ---------- guards, installed in this window and in every same-origin child window ----------

  function guardWindow(win) {
    try {
      // The marker lives on the window itself, so a frame that navigates to a new page gets guarded again.
      if (!win || win.__popguardGuarded__) return;
      Object.defineProperty(win, '__popguardGuarded__', { value: true });
    } catch {
      return; // cross-origin window: it gets its own copy of this script from the background
    }
    try {
      guardOpen(win);
      guardLinks(win);
      guardForms(win);
      guardNotifications(win);
      guardChildFrames(win);
    } catch {}
  }

  function guardOpen(win) {
    const nativeOpen = win.open;
    const guardedOpen = function open(url) {
      const s = url == null ? '' : String(url);
      if (s === '' || s === 'about:blank' || isExternal(s)) {
        report('window.open', s || 'about:blank');
        return fakeWindow;
      }
      return nativeOpen.apply(win, arguments);
    };
    looksNative(guardedOpen, 'open');
    try {
      Object.defineProperty(win, 'open', { value: guardedOpen, writable: false, configurable: false });
    } catch {
      win.open = guardedOpen;
    }
  }

  function guardLinks(win) {
    // Real clicks on new-tab links to other sites, and any scripted click on a link to another site.
    win.addEventListener(
      'click',
      (e) => {
        const a = linkOf(e.target);
        if (!a || !isExternal(a.href)) return;
        if (e.isTrusted && !opensNewTab(a.target)) return; // normal link the user clicked: allow
        e.preventDefault();
        e.stopImmediatePropagation();
        report(e.isTrusted ? 'new-tab link' : 'scripted link', a.href);
        if (!FOREIGN_FRAME && win === window && looksLikeOverlay(a)) a.remove();
      },
      true
    );

    // a.click() on a link that isn't in the page never reaches the listener above.
    const nativeClick = win.HTMLElement.prototype.click;
    const guardedClick = function click() {
      const a = linkOf(this);
      if (a && isExternal(a.href)) {
        report('scripted link', a.href);
        return;
      }
      return nativeClick.call(this);
    };
    looksNative(guardedClick, 'click');
    win.HTMLElement.prototype.click = guardedClick;

    const nativeDispatch = win.EventTarget.prototype.dispatchEvent;
    const guardedDispatch = function dispatchEvent(event) {
      if (event && event.type === 'click') {
        const a = linkOf(this);
        if (a && isExternal(a.href)) {
          report('scripted link', a.href);
          return true;
        }
      }
      return nativeDispatch.call(this, event);
    };
    looksNative(guardedDispatch, 'dispatchEvent');
    win.EventTarget.prototype.dispatchEvent = guardedDispatch;
  }

  function guardForms(win) {
    const nativeSubmit = win.HTMLFormElement.prototype.submit;
    const guardedSubmit = function submit() {
      const action = this.getAttribute('action') || '';
      if (opensNewTab(this.getAttribute('target')) && isExternal(action)) {
        report('form popup', action);
        return;
      }
      return nativeSubmit.call(this);
    };
    looksNative(guardedSubmit, 'submit');
    win.HTMLFormElement.prototype.submit = guardedSubmit;

    win.addEventListener(
      'submit',
      (e) => {
        const form = e.target;
        const target = (e.submitter && e.submitter.getAttribute('formtarget')) || form.getAttribute('target');
        const action = (e.submitter && e.submitter.getAttribute('formaction')) || form.getAttribute('action') || '';
        if (opensNewTab(target) && isExternal(action)) {
          e.preventDefault();
          report('form popup', action);
        }
      },
      true
    );
  }

  function guardNotifications(win) {
    if (!win.Notification || !win.Notification.requestPermission) return;
    const guardedRequest = function requestPermission(callback) {
      report('notification prompt', location.href);
      if (typeof callback === 'function') setTimeout(() => callback('denied'));
      return Promise.resolve('denied');
    };
    looksNative(guardedRequest, 'requestPermission');
    win.Notification.requestPermission = guardedRequest;
  }

  // Ad scripts create a hidden about:blank iframe and call its (untouched) window.open.
  // Guard every same-origin child window the moment the page can get hold of it.
  function guardChildFrames(win) {
    const guardFrames = () => {
      for (let i = 0; i < win.frames.length; i++) guardWindow(win.frames[i]);
    };

    // iframe.contentWindow / iframe.contentDocument
    for (const Ctor of [win.HTMLIFrameElement, win.HTMLFrameElement, win.HTMLObjectElement]) {
      if (!Ctor) continue;
      for (const prop of ['contentWindow', 'contentDocument']) {
        const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
        if (!desc || !desc.get) continue;
        const nativeGet = desc.get;
        const guardedGet = function () {
          const value = nativeGet.call(this);
          if (value) guardWindow(prop === 'contentWindow' ? value : value.defaultView);
          return value;
        };
        Object.defineProperty(Ctor.prototype, prop, { ...desc, get: guardedGet });
      }
    }

    // window.frames[0] / window[0] skip the getters above, so also guard right after anything
    // is inserted into the page (a new iframe's window exists as soon as it's inserted).
    const wrapInsert = (proto, name) => {
      const native = proto && proto[name];
      if (typeof native !== 'function') return;
      const wrapped = {
        [name]() {
          const result = native.apply(this, arguments);
          guardFrames();
          return result;
        },
      }[name];
      looksNative(wrapped, name);
      proto[name] = wrapped;
    };
    for (const name of ['appendChild', 'insertBefore', 'replaceChild']) wrapInsert(win.Node.prototype, name);
    for (const name of ['append', 'prepend', 'before', 'after', 'replaceWith', 'insertAdjacentElement', 'insertAdjacentHTML']) {
      wrapInsert(win.Element.prototype, name);
    }
    for (const prop of ['innerHTML', 'outerHTML']) {
      const desc = Object.getOwnPropertyDescriptor(win.Element.prototype, prop);
      if (!desc || !desc.set) continue;
      const nativeSet = desc.set;
      Object.defineProperty(win.Element.prototype, prop, {
        ...desc,
        set(value) {
          nativeSet.call(this, value);
          guardFrames();
        },
      });
    }
    guardFrames();
  }

  guardWindow(window);

  // ---------- invisible click-hijacking layers ----------
  // Only on the protected site's own pages, not inside embedded players.

  if (FOREIGN_FRAME) return;

  const MEDIA = 'video, iframe, embed, object, canvas';

  // Fraction of rect `inner` that lies inside rect `outer`.
  function overlap(outer, inner) {
    const w = Math.min(outer.right, inner.right) - Math.max(outer.left, inner.left);
    const h = Math.min(outer.bottom, inner.bottom) - Math.max(outer.top, inner.top);
    const area = inner.width * inner.height;
    return w > 0 && h > 0 && area > 0 ? (w * h) / area : 0;
  }

  // Embedded players (iframes big enough to be a video).
  const playerFrames = () =>
    [...document.querySelectorAll('iframe')].filter((f) => {
      const r = f.getBoundingClientRect();
      return r.width >= 200 && r.height >= 120;
    });

  // Does the element show anything at all? Ghost layers are empty and see-through.
  function showsSomething(el, cs) {
    if (parseFloat(cs.opacity) <= 0.05) return false;
    const bg = cs.backgroundColor.match(/[\d.]+/g);
    const bgAlpha = !bg ? 0 : bg.length === 4 ? parseFloat(bg[3]) : 1;
    if (bgAlpha > 0.1 || cs.backgroundImage !== 'none') return true;
    if (el.innerText && el.innerText.trim()) return true;
    return !!el.querySelector('img, svg, picture, video, canvas');
  }

  function looksLikeOverlay(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return false;
    if (el.tagName === 'IFRAME') return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    if (cs.pointerEvents === 'none' || cs.visibility !== 'visible') return false; // can't catch clicks

    const r = el.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return false;
    if (el.querySelector(MEDIA)) return false; // this element holds the real player: leave it alone

    const coversFrame = playerFrames().some((f) => overlap(r, f.getBoundingClientRect()) >= 0.6);
    const coversVideo = [...document.querySelectorAll('video')].some((v) => overlap(r, v.getBoundingClientRect()) >= 0.6);
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
    const coversScreen = overlap(r, viewport) >= 0.25;
    if (!coversFrame && !coversVideo && !coversScreen) return false;

    // An empty see-through layer on top of an embedded player: there's no reason for it to exist.
    if (coversFrame && !showsSomething(el, cs)) return true;

    // Big invisible layer floating on top of everything.
    const onTop = cs.position === 'fixed' || (parseInt(cs.zIndex, 10) || 0) >= 1000;
    if (parseFloat(cs.opacity) <= 0.05 && onTop) return true;

    // Big layer that is (or is filled by) a link to another site.
    if (el.matches('a[href], area[href]') && isExternal(el.href)) return true;
    return [...el.querySelectorAll('a[href]')].some(
      (a) => isExternal(a.href) && overlap(a.getBoundingClientRect(), r) >= 0.8
    );
  }

  function removeOverlay(el) {
    report('click-hijack overlay', el.href || el.querySelector('a[href]')?.href || '');
    el.remove();
  }

  // Walk up from the element under the pointer and remove the first hijacking layer found.
  function removeOverlayAt(el) {
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      if (looksLikeOverlay(el)) {
        removeOverlay(el);
        return true;
      }
    }
    return false;
  }

  // Last-chance check when you press: if a layer slipped through, eat this press and remove it.
  function onPress(e) {
    if (!e.isTrusted) return;
    if (removeOverlayAt(e.target && e.target.nodeType === 1 ? e.target : null)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  window.addEventListener('pointerdown', onPress, true);
  window.addEventListener('mousedown', onPress, true);

  // Sweep proactively so layers are gone before you click, letting the first click reach the player.
  let sweepTimer = 0;
  function sweep() {
    sweepTimer = 0;
    if (!document.body) return;

    // Whatever sits on top of each player iframe should be the iframe itself.
    for (const f of playerFrames()) {
      const r = f.getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.75]]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && hit !== f && !hit.contains(f)) removeOverlayAt(hit);
      }
    }

    const candidates = new Set([...document.body.children, ...document.querySelectorAll('a[href]')]);
    let checked = 0;
    for (const el of candidates) {
      if (++checked > 800) break;
      if (el.isConnected && looksLikeOverlay(el)) removeOverlay(el);
    }
  }
  const scheduleSweep = () => {
    if (!sweepTimer) sweepTimer = setTimeout(sweep, 150);
  };
  new MutationObserver(scheduleSweep).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'href'],
  });
  window.addEventListener('load', scheduleSweep);
  window.addEventListener('scroll', scheduleSweep, { passive: true, capture: true });
  // Layers are often added only once the pointer moves over the player.
  window.addEventListener('pointerover', scheduleSweep, { passive: true, capture: true });
})();
