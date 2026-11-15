// c-lock - background service worker
//
// How the lock works:
//  1. A persistent DYNAMIC rule redirects every http/https/ftp page load to lock.html.
//     Chrome applies dynamic rules from the moment the browser starts, before any
//     extension code runs, so bookmarks / restored tabs / links can never load early.
//  2. Unlocking adds a higher-priority SESSION "allow" rule. Session rules are wiped
//     when Chrome closes, so every new browser start is locked automatically.
//  3. STRICT WATCH: while locked, the only allowed action is typing the password.
//     Any other action closes Chrome immediately: wrong password, opening /
//     switching / closing tabs, new windows, any navigation (bookmark, history,
//     typed address, chrome:// pages, extensions page), reload, clicks outside the
//     password box, right-click, shortcut keys, clicking browser UI (toolbar,
//     menus, extension icons).
//  A short grace period right after locking lets Chrome restore its tabs at
//  startup and turn them into lock screens without tripping the watch.

// SHA-256 of the password. Default password is "/".
// To change it: PowerShell ->
//   ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes('NEWPASS'))|%{$_.ToString('x2')}) -join ''
const PASSWORD_SHA256 = '8a5edab282632443219e051e4ade2d1d5bbc671c781051bf1437897cbdfea0f1';

const REDIRECT_RULE_ID = 1;
const ALLOW_RULE_ID = 2;
const LOCK_PAGE = chrome.runtime.getURL('lock.html');
const OLD_LOCK_EXTENSION_ID = 'cjmgjihapgicbhmniemjkjeaedanank';
const GRACE_MS = 5000;

// ---------- state ----------

async function ensureRedirectRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [REDIRECT_RULE_ID],
    addRules: [{
      id: REDIRECT_RULE_ID,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: LOCK_PAGE + '#\\0' } },
      condition: { regexFilter: '^(https?|ftp)://.*$', resourceTypes: ['main_frame'] }
    }]
  });
}

async function isLocked() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return !rules.some(r => r.id === ALLOW_RULE_ID);
}

// freshStart: c-lock closed every window but Chrome kept running (always the case
// on Mac, or on Windows with "continue running background apps"). The next window
// is treated like a fresh browser start: it gets the lock screen, not an instant close.
async function inGrace() {
  const { lockedAt, freshStart } = await chrome.storage.session.get(['lockedAt', 'freshStart']);
  return !lockedAt || freshStart || Date.now() - lockedAt <= GRACE_MS;
}

// Lock-screen URLs this extension itself put into each tab (during grace).
async function getKnown() {
  const { known = {} } = await chrome.storage.session.get('known');
  return known;
}
async function remember(tabId, lockUrl) {
  const known = await getKnown();
  known[tabId] = lockUrl;
  await chrome.storage.session.set({ known });
}

function isLockPage(url) {
  return typeof url === 'string' && url.startsWith(LOCK_PAGE);
}

function originalUrlFrom(lockUrl) {
  const i = lockUrl.indexOf('#');
  if (i < 0) return '';
  const u = lockUrl.slice(i + 1);
  return /^(javascript|data):/i.test(u) ? '' : u;
}

// ---------- the watch ----------

let closing = false;
async function closeChrome() {
  if (closing) return;
  closing = true;
  try {
    await chrome.storage.session.set({ freshStart: true });
    const wins = await chrome.windows.getAll();
    await Promise.all(wins.map(w => chrome.windows.remove(w.id).catch(() => {})));
  } finally {
    setTimeout(() => { closing = false; }, 2000);
  }
}

// Close Chrome if locked. Browser events respect the startup grace period;
// direct human input on the lock page (ignoreGrace) never does.
async function trip(ignoreGrace = false) {
  if (!(await isLocked())) return;
  if (!ignoreGrace && (await inGrace())) return;
  closeChrome();
}

async function guardTab(tabId, url) {
  if (!url) return;
  if (!(await isLocked())) return;
  const grace = await inGrace();
  if (isLockPage(url)) {
    if (grace) await remember(tabId, url);
    else if ((await getKnown())[tabId] !== url) closeChrome(); // came from a navigation attempt
    return;
  }
  if (!grace) { closeChrome(); return; }
  // Grace period (startup / just locked): turn the tab into a lock screen.
  const lockUrl = LOCK_PAGE + '#' + url;
  await remember(tabId, lockUrl);
  try { await chrome.tabs.update(tabId, { url: lockUrl }); } catch (_) {}
}

// Reopen a lock tab as a new extension-created tab: Chrome gives page content the
// focus for those, taking it away from the address bar. Once per tab.
const regrabbed = new Set();
async function grabFocus(tab) {
  if (regrabbed.has(tab.id)) return;
  regrabbed.add(tab.id);
  try {
    const t = await chrome.tabs.create({ windowId: tab.windowId, index: tab.index, url: tab.url, active: true });
    regrabbed.add(t.id);
    await remember(t.id, tab.url);
    await chrome.tabs.remove(tab.id);
  } catch (_) {}
}

async function sweepAllTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(t => guardTab(t.id, t.pendingUrl || t.url)));
}

// ---------- lock / unlock ----------

async function lock() {
  await chrome.storage.session.set({ lockedAt: Date.now(), known: {}, freshStart: false });
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ALLOW_RULE_ID] });
  await ensureRedirectRule();
  await sweepAllTabs();
}

async function lockOrTrip() {
  if (await isLocked()) trip(true);
  else lock();
}

async function unlock() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ALLOW_RULE_ID],
    addRules: [{
      id: ALLOW_RULE_ID,
      priority: 2,
      action: { type: 'allow' },
      condition: { resourceTypes: ['main_frame'] }
    }]
  });
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    const u = t.pendingUrl || t.url;
    if (isLockPage(u)) releaseTab(t.id, u);
  }
  cleanHistory();
}

function releaseTab(tabId, lockUrl) {
  const orig = originalUrlFrom(lockUrl) || 'chrome://newtab/';
  chrome.tabs.update(tabId, { url: orig }).catch(() => {});
}

// Remove every trace of the lock page (and the old lock extension) from history.
async function cleanHistory() {
  for (const text of [chrome.runtime.id, OLD_LOCK_EXTENSION_ID]) {
    const items = await chrome.history.search({ text, startTime: 0, maxResults: 10000 });
    for (const it of items) {
      if (it.url && it.url.includes(text)) chrome.history.deleteUrl({ url: it.url });
    }
  }
}

// ---------- password ----------

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function tryUnlock(pw) {
  if ((await sha256Hex(String(pw))) === PASSWORD_SHA256) {
    await unlock();
    return { ok: true };
  }
  closeChrome();
  return { ok: false };
}

// ---------- events (registered at top level so they wake the worker) ----------

chrome.runtime.onInstalled.addListener(async () => {
  await lock();
  cleanHistory();
});
chrome.runtime.onStartup.addListener(lock);

// Navigation of any kind.
chrome.webNavigation.onBeforeNavigate.addListener(d => {
  if (d.frameId === 0 && !isLockPage(d.url)) trip();
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url) guardTab(tabId, info.url);
  else if (info.status === 'loading') guardTab(tabId, tab.pendingUrl || tab.url);
});
chrome.tabs.onReplaced.addListener(async addedId => {
  try { const t = await chrome.tabs.get(addedId); guardTab(t.id, t.pendingUrl || t.url); } catch (_) {}
});

// Tabs and windows being opened, switched, closed, moved.
chrome.tabs.onCreated.addListener(async t => {
  if (!(await inGrace())) return trip();
  guardTab(t.id, t.pendingUrl || t.url);
});
chrome.tabs.onActivated.addListener(() => trip());
chrome.tabs.onRemoved.addListener(() => trip());
chrome.tabs.onMoved.addListener(() => trip());
chrome.tabs.onDetached.addListener(() => trip());
chrome.windows.onCreated.addListener(async () => {
  const { freshStart } = await chrome.storage.session.get('freshStart');
  if (freshStart && !closing) lock(); // first window after c-lock closed Chrome
  else trip();
}, { windowTypes: ['normal', 'popup', 'panel', 'app', 'devtools'] });
chrome.windows.onRemoved.addListener(() => trip());

// Toolbar icon / shortcut: lock when unlocked; while locked it's a random click -> exit.
chrome.action.onClicked.addListener(lockOrTrip);
chrome.commands.onCommand.addListener(cmd => { if (cmd === 'lock-now') lockOrTrip(); });

// Lock when Windows locks (Win+L / sleep).
chrome.idle.onStateChanged.addListener(state => { if (state === 'locked') lock(); });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const tab = sender.tab;

  if (msg?.type === 'unlock') {
    tryUnlock(msg.pw).then(reply);
    return true;
  }

  // Human input on the lock page other than typing the password.
  if (msg?.type === 'trip') {
    trip(true);
    return;
  }

  // Focus is in browser UI (address bar, toolbar, menus, extension icons) while the
  // lock page is showing -> exit. During the startup grace period, a lock page that
  // never got focus (e.g. a new window starts with focus in the address bar) is
  // reopened once in a fresh tab so the page, not the address bar, gets focus.
  if (msg?.type === 'unfocused' && tab) {
    (async () => {
      if (!(await isLocked())) return;
      if (!(await inGrace())) return trip();
      if (!msg.armed) grabFocus(tab);
    })();
    return;
  }

  if (msg?.type === 'status') {
    (async () => {
      const locked = await isLocked();
      if (tab) {
        if (!locked) releaseTab(tab.id, tab.url || ''); // e.g. Back button after unlock
        else await guardTab(tab.id, tab.url);
      }
      reply({ locked });
    })();
    return true;
  }
});
