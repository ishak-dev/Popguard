// PopGuard background service worker.
//
// Layer 1 (this file): watches tabs from the browser's side, where page scripts can't interfere.
//   - A protected site opens a tab to a different site  -> close it, refocus the original tab.
//   - A protected tab gets redirected to another site right after opening a tab (a "tab-under")
//     or by a script redirect                           -> go back.
// It also registers layer 2 (inpage.js + bridge.js) on protected sites only, and blocks scripts
// from other domains on them (that's where the ad scripts come from).

importScripts('domain.js');

const CHILD_WATCH_MS = 10_000; // how long a newly opened tab is watched for redirects to other sites
const TABUNDER_MS = 3_000;     // opener leaving the site this soon after opening a tab = tab-under
const RECENT_LIMIT = 20;
const SCRIPT_RULE_ID = 1;       // scripts the protected site's own pages load from other domains
const FRAME_SCRIPT_RULE_ID = 2; // same, but for every frame in a protected tab (embedded players' ads)

// Shared code hosts that sites legitimately load libraries from; never blocked.
const SCRIPT_CDN_ALLOWLIST = [
  'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'code.jquery.com', 'ajax.googleapis.com',
  'www.gstatic.com', 'www.google.com', 'www.recaptcha.net', 'challenges.cloudflare.com', 'hcaptcha.com',
  // video players embedded sites rely on
  'jwplayer.com', 'jwpcdn.com', 'jwplatform.com', 'vjs.zencdn.net', 'cdn.plyr.io', 'cdn.fluidplayer.com',
  'cdn.jwplayer.com', 'ssl.p.jwpcdn.com', 'imasdk.googleapis.com', 'www.youtube.com', 'player.vimeo.com',
];

// Tab navigations that come from the user, never treated as a tab-under.
const USER_TRANSITIONS = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'reload', 'start_page', 'form_submit']);

const children = new Map();    // childTabId -> { site, openerId, created }
const lastChildAt = new Map(); // openerTabId -> time it last opened a tab
const tabSite = new Map();     // tabId -> protected site the tab is on, or null

// ---------- protected sites ----------

async function getSites() {
  const { sites = [] } = await chrome.storage.sync.get('sites');
  return sites;
}

async function protectedSiteOf(url) {
  const site = siteOf(url || '');
  return site && (await getSites()).includes(site) ? site : null;
}

async function setProtected(site, on, tabId) {
  const sites = new Set(await getSites());
  if (on) sites.add(site);
  else sites.delete(site);
  await chrome.storage.sync.set({ sites: [...sites].sort() });
  await syncContentScripts();
  if (tabId != null) chrome.tabs.reload(tabId).catch(() => {});
}

// Sites where the user turned script blocking off because it broke something.
async function getScriptsAllowed() {
  const { scriptsAllowed = [] } = await chrome.storage.sync.get('scriptsAllowed');
  return scriptsAllowed;
}

async function setScriptsAllowed(site, allowed, tabId) {
  const list = new Set(await getScriptsAllowed());
  if (allowed) list.add(site);
  else list.delete(site);
  await chrome.storage.sync.set({ scriptsAllowed: [...list].sort() });
  await syncContentScripts();
  if (tabId != null) chrome.tabs.reload(tabId).catch(() => {});
}

// ---------- layer 2 registration + outside-script blocking ----------

// Ad scripts are loaded from the ad network's own domains. Block every script a protected site's
// pages request from another domain. Embedded players are unaffected: their scripts are requested
// by the player's own frame, not by the protected site.
async function syncScriptBlocking(sites) {
  const allowed = await getScriptsAllowed();
  const domains = sites.filter((s) => !allowed.includes(s));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [SCRIPT_RULE_ID],
    addRules: domains.length
      ? [{
          id: SCRIPT_RULE_ID,
          priority: 1,
          action: { type: 'block' },
          condition: {
            initiatorDomains: domains,
            domainType: 'thirdParty',
            resourceTypes: ['script'],
            excludedRequestDomains: SCRIPT_CDN_ALLOWLIST,
          },
        }]
      : [],
  });
}

let syncChain = Promise.resolve();
function syncContentScripts() {
  syncChain = syncChain
    .then(async () => {
      const sites = await getSites();
      await syncScriptBlocking(sites);
      await chrome.scripting.unregisterContentScripts();
      if (!sites.length) return;
      const matches = sites.flatMap((s) =>
        /^[\d.]+$|^\[/.test(s) ? [`*://${s}/*`] : [`*://${s}/*`, `*://*.${s}/*`]
      );
      const common = { matches, runAt: 'document_start', allFrames: true, matchOriginAsFallback: true };
      await chrome.scripting.registerContentScripts([
        { id: 'popguard-inpage', js: ['inpage.js'], world: 'MAIN', ...common },
        { id: 'popguard-bridge', js: ['bridge.js'], ...common },
      ]);
    })
    .catch((err) => console.error('PopGuard: could not register page scripts', err));
  return syncChain;
}

// ---------- which tab is on which protected site (survives worker restarts) ----------

async function refreshTabSites() {
  const sites = await getSites();
  tabSite.clear();
  for (const t of await chrome.tabs.query({})) {
    const s = siteOf(t.url || '');
    tabSite.set(t.id, s && sites.includes(s) ? s : null);
  }
  saveTabSites();
}

function saveTabSites() {
  chrome.storage.session.set({ tabSite: Object.fromEntries(tabSite) }).catch(() => {});
  syncTabScriptBlocking();
}

// Embedded players (iframes from other domains) bring their own ad scripts, e.g. floating
// "bubble" ads. Those requests come from the player's frame, so the site-based rule doesn't see
// them. This session rule covers every frame of every tab that's on a protected site.
let tabRuleChain = Promise.resolve();
function syncTabScriptBlocking() {
  tabRuleChain = tabRuleChain
    .then(async () => {
      const allowed = await getScriptsAllowed();
      const tabIds = [...tabSite].filter(([, site]) => site && !allowed.includes(site)).map(([id]) => id);
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [FRAME_SCRIPT_RULE_ID],
        addRules: tabIds.length
          ? [{
              id: FRAME_SCRIPT_RULE_ID,
              priority: 1,
              action: { type: 'block' },
              condition: {
                tabIds,
                domainType: 'thirdParty',
                resourceTypes: ['script'],
                excludedRequestDomains: SCRIPT_CDN_ALLOWLIST,
              },
            }]
          : [],
      });
    })
    .catch((err) => console.error('PopGuard: could not update tab rule', err));
}

const ready = (async () => {
  const { tabSite: saved } = await chrome.storage.session.get('tabSite');
  if (saved) {
    for (const [id, site] of Object.entries(saved)) tabSite.set(Number(id), site);
    syncTabScriptBlocking();
  } else {
    await refreshTabSites();
  }
})();

// ---------- stats + badge ----------

let statsChain = Promise.resolve();
function record(tabId, site, kind, url) {
  if (tabId != null && tabId >= 0) {
    chrome.action
      .getBadgeText({ tabId })
      .then((t) => chrome.action.setBadgeText({ tabId, text: String((parseInt(t, 10) || 0) + 1) }))
      .catch(() => {});
  }
  statsChain = statsChain
    .then(async () => {
      const { stats = { total: 0, sites: {}, recent: [] } } = await chrome.storage.local.get('stats');
      stats.total++;
      stats.sites[site] = (stats.sites[site] || 0) + 1;
      stats.recent.unshift({ site, kind, url: String(url || '').slice(0, 300), time: Date.now() });
      stats.recent.length = Math.min(stats.recent.length, RECENT_LIMIT);
      await chrome.storage.local.set({ stats });
    })
    .catch(() => {});
}

// ---------- layer 1: tabs opened by protected sites ----------

async function adoptChild(tabId, openerId, url) {
  if (!children.has(tabId)) {
    let opener;
    try {
      opener = await chrome.tabs.get(openerId);
    } catch {
      return;
    }
    const site = await protectedSiteOf(opener.url);
    if (!site) return;
    lastChildAt.set(openerId, Date.now());
    children.set(tabId, { site, openerId, created: Date.now() });
  }
  checkChild(tabId, url);
}

// Close the child tab as soon as it heads to a different site. Blank / same-site URLs are
// kept but still watched, because popunders often open about:blank and redirect afterwards.
function checkChild(tabId, url) {
  const info = children.get(tabId);
  if (!info) return;
  if (Date.now() - info.created > CHILD_WATCH_MS) {
    children.delete(tabId);
    return;
  }
  const site = siteOf(url || '');
  if (!site || site === info.site) return;
  children.delete(tabId);
  chrome.tabs.remove(tabId).catch(() => {});
  chrome.tabs.update(info.openerId, { active: true }).catch(() => {});
  record(info.openerId, info.site, 'popup tab', url);
}

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  adoptChild(d.tabId, d.sourceTabId, d.url);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId != null) adoptChild(tab.id, tab.openerTabId, tab.pendingUrl || tab.url);
});

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) checkChild(d.tabId, d.url);
});

// ---------- layer 1: tab-under redirects of the protected tab itself ----------

async function handleTopCommit({ tabId, url, transitionType, transitionQualifiers = [] }) {
  await ready;
  const prev = tabSite.get(tabId);
  const next = siteOf(url);
  const userDriven =
    USER_TRANSITIONS.has(transitionType) ||
    transitionQualifiers.includes('forward_back') ||
    transitionQualifiers.includes('from_address_bar');
  const recentChild = Date.now() - (lastChildAt.get(tabId) || 0) < TABUNDER_MS;
  const scripted = transitionQualifiers.includes('client_redirect');

  if (prev && next && next !== prev && !userDriven && (recentChild || scripted)) {
    record(tabId, prev, 'tab-under redirect', url);
    chrome.tabs.goBack(tabId).catch(() => {});
    return; // the tab is going back to the protected site, keep its entry
  }
  tabSite.set(tabId, await protectedSiteOf(url));
  saveTabSites();
}

// The registered page scripts only match the protected site's own URLs. Embedded players usually
// come from other domains (often several iframes deep), so inject layer 2 into those frames too.
async function guardSubframe({ tabId, frameId, url }) {
  await ready;
  if (!tabSite.get(tabId) || !/^https?:/.test(url)) return;
  const target = { tabId, frameIds: [frameId] };
  chrome.scripting
    .executeScript({ target, files: ['inpage.js'], world: 'MAIN', injectImmediately: true })
    .catch(() => {});
  chrome.scripting.executeScript({ target, files: ['bridge.js'], injectImmediately: true }).catch(() => {});
}

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) {
    guardSubframe(d);
    return;
  }
  checkChild(d.tabId, d.url);
  handleTopCommit(d);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  children.delete(tabId);
  lastChildAt.delete(tabId);
  if (tabSite.delete(tabId)) saveTabSites();
});

// ---------- messages from bridge.js and the popup ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'blocked' && sender.tab) {
    protectedSiteOf(sender.tab.url).then((site) => {
      if (site) record(sender.tab.id, site, msg.kind, msg.url);
    });
    return;
  }
  if (msg.type === 'setProtected') {
    setProtected(msg.site, msg.on, msg.tabId).then(() => sendResponse(true));
    return true; // async response
  }
  if (msg.type === 'setScriptsAllowed') {
    setScriptsAllowed(msg.site, msg.allowed, msg.tabId).then(() => sendResponse(true));
    return true;
  }
});

// Count blocked ad scripts too. (This event exists for unpacked extensions, which PopGuard is.)
chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener(({ request, rule }) => {
  if (rule.ruleId !== SCRIPT_RULE_ID && rule.ruleId !== FRAME_SCRIPT_RULE_ID) return;
  const site = tabSite.get(request.tabId) || siteOf(request.initiator || '');
  if (site) record(request.tabId, site, 'ad script', request.url);
});

// ---------- lifecycle ----------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.sites) {
    syncContentScripts();
    refreshTabSites();
  } else if (area === 'sync' && changes.scriptsAllowed) {
    syncContentScripts();
    syncTabScriptBlocking();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  syncContentScripts();
  refreshTabSites();
});

chrome.runtime.onStartup.addListener(() => {
  syncContentScripts();
  refreshTabSites();
});
