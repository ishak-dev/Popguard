const $ = (sel) => document.querySelector(sel);

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function li(children) {
  const item = document.createElement('li');
  item.append(...children);
  return item;
}

function text(tag, content, className) {
  const el = document.createElement(tag);
  el.textContent = content;
  if (className) el.className = className;
  return el;
}

function setProtected(site, on, tabId) {
  return chrome.runtime.sendMessage({ type: 'setProtected', site, on, tabId });
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = tab ? siteOf(tab.url || '') : null;
  const { sites = [], scriptsAllowed = [] } = await chrome.storage.sync.get(['sites', 'scriptsAllowed']);
  const { stats = { total: 0, sites: {}, recent: [] } } = await chrome.storage.local.get('stats');
  const isOn = !!site && sites.includes(site);

  $('#total').textContent = `${stats.total} blocked in total`;

  // Current site
  if (site) {
    $('#host').textContent = site;
    $('#toggleRow').hidden = false;
    $('#toggle').checked = isOn;
    $('#scriptsRow').hidden = !isOn;
    $('#scripts').checked = !scriptsAllowed.includes(site);
    const n = stats.sites[site] || 0;
    $('#status').textContent = isOn
      ? `Protected · ${n} blocked on this site. If the site stops working, turn off ad-script blocking.`
      : 'Not protected. Turn on for sites that spam tabs.';
  } else {
    $('#host').textContent = 'This page';
    $('#toggleRow').hidden = true;
    $('#scriptsRow').hidden = true;
    $('#status').textContent = 'PopGuard only works on normal websites.';
  }

  $('#toggle').onchange = async (e) => {
    $('#status').textContent = e.target.checked ? 'Turning on, reloading page…' : 'Turning off, reloading page…';
    await setProtected(site, e.target.checked, tab.id);
    render();
  };

  $('#scripts').onchange = async (e) => {
    $('#status').textContent = 'Saving, reloading page…';
    await chrome.runtime.sendMessage({ type: 'setScriptsAllowed', site, allowed: !e.target.checked, tabId: tab.id });
    render();
  };

  // Recent blocks
  const recent = $('#recent');
  recent.replaceChildren();
  for (const r of stats.recent.slice(0, 6)) {
    const what = document.createElement('div');
    what.className = 'what';
    what.append(text('span', r.kind, 'kind'), ` on ${r.site}`, text('span', r.url, 'url'));
    recent.append(li([what, text('span', timeAgo(r.time), 'muted')]));
  }
  if (!recent.children.length) recent.append(text('li', 'Nothing yet.', 'empty'));

  // Protected sites
  const list = $('#sites');
  list.replaceChildren();
  for (const s of sites) {
    const btn = text('button', 'Remove', 'remove');
    btn.onclick = async () => {
      await setProtected(s, false, s === site ? tab.id : null);
      render();
    };
    list.append(li([text('span', s), btn]));
  }
  if (!sites.length) list.append(text('li', 'None yet.', 'empty'));
}

render();
