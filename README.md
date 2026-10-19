# PopGuard

A personal Chrome extension that stops shady streaming sites from opening ad and scam tabs every time you click "Play".

You turn it on per site. On a protected site it works in two layers:

| Layer | Where it runs | What it does |
|---|---|---|
| 1. Tab guard (`background.js`) | Chrome itself, the page can't see or touch it | Closes any tab the site opens to a **different site** and puts you back on the video. If the site redirects your own tab elsewhere right after opening a tab (a "tab-under"), it goes back. |
| 2. In-page guard (`inpage.js`) | Inside the page and inside embedded player iframes, before their scripts run | Disables `window.open` to other sites (it hands back a fake window so the ad script thinks it worked), including copies borrowed from hidden blank iframes. Blocks scripted and new-tab links and forms to other sites, removes invisible layers sitting on the player, and auto-denies "click Allow" notification prompts. |

On top of that, PopGuard **blocks scripts that a protected site loads from other domains**. That's where ad networks' code (popups, fake "notification" cards, floating bubble ads, interstitials) comes from. This applies to every frame in the tab, including embedded video players, which often bring their own ad networks. A player's own code (from its own domain) still loads. Popular code hosts and video players (cdnjs, jsDelivr, Google, reCAPTCHA/hCaptcha, JW Player, Video.js, Plyr, YouTube, Vimeo) are never blocked. If a site breaks, turn off **Block ad scripts from other sites** for that site in the popup.

Layer 2 stops most tricks before a tab exists and makes your *first* click reach the real player. Layer 1 catches everything layer 2 misses.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this `popguard` folder
4. Pin PopGuard from the puzzle-piece menu so the icon is visible

After editing any file, click the reload ↻ icon on PopGuard's card in `chrome://extensions`.

## Use

Go to the annoying site, click the PopGuard icon, and switch on **Protect this site**. The page reloads with protection on. The red badge counts what was blocked in that tab.

Protection covers the whole site, including subdomains (`player.site.com` is covered when you protect `site.com`).

## Test it

```bash
cd popguard && python3 -m http.server 8765
```

Open http://localhost:8765/test/spam-test.html, protect `localhost`, and try every button. Nothing should open, and both Play buttons (the plain one and the embedded iframe player) should work on the first click. Without protection, every button opens example.com or example.org (harmless sites).

## Things to know

- On a protected site, links to **other** sites won't open in a new tab, even when you click them on purpose. Links within the same site work normally. Right-click → Copy link if you really need one.
- Domain matching is approximate: `a.example.co.uk` and `b.example.co.uk` count as the same site, but uncommon setups may not.
- For debugging, open `chrome://extensions` → PopGuard → **service worker** to see background logs.
- This is a safety net, not antivirus. Never click "Allow" on notification prompts and never run files downloaded from these sites.

## License

MIT. See [LICENSE](LICENSE).
