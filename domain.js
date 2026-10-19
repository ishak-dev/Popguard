// Shared helpers for the background worker and the popup.
// (inpage.js keeps its own copy because it runs inside the web page.)

const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

// "player.cdn.example.co.uk" -> "example.co.uk". A rough stand-in for the public suffix list.
function baseDomain(host) {
  host = host.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  const n = parts.length;
  const take = n > 2 && parts[n - 1].length === 2 && SECOND_LEVEL.has(parts[n - 2]) ? 3 : 2;
  return parts.slice(-take).join('.');
}

// Site (base domain) of an http(s) URL, or null for about:blank, chrome://, etc.
function siteOf(url) {
  try {
    let u = new URL(url);
    if (u.protocol === 'blob:') u = new URL(u.pathname);
    return u.protocol === 'http:' || u.protocol === 'https:' ? baseDomain(u.hostname) : null;
  } catch {
    return null;
  }
}
