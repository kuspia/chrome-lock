const form = document.getElementById('f');
const pw = document.getElementById('pw');

// ---- instant close, done right here in the page (no round trip to the background) ----
const GRACE_MS = 5000;
let lockedAt = 0, freshStart = true, leaving = false, dead = false;
chrome.storage.session.get(['lockedAt', 'freshStart']).then(s => {
  lockedAt = s.lockedAt || 0;
  freshStart = !!s.freshStart;
});
chrome.storage.session.onChanged.addListener(c => {
  if (c.lockedAt) lockedAt = c.lockedAt.newValue || 0;
  if (c.freshStart) freshStart = !!c.freshStart.newValue;
});
const inGrace = () => !lockedAt || freshStart || Date.now() - lockedAt <= GRACE_MS;

// human = direct input on this page (ignores the startup grace period)
function die(human) {
  if (dead || leaving || (!human && inGrace())) return;
  dead = true;
  chrome.storage.session.set({ freshStart: true });
  chrome.windows.getAll().then(ws => ws.forEach(w => chrome.windows.remove(w.id).catch(() => {})));
}

addEventListener('beforeunload', () => { leaving = true; });

// Lock state is read right here (no waiting for the background to wake up).
// Unlocked: this is just a new tab / old lock tab -> go to the real page at once.
// Locked: show the lock screen; the background also checks how the tab got here
// and closes Chrome if it was a navigation attempt.
document.documentElement.style.visibility = 'hidden';
chrome.declarativeNetRequest.getSessionRules().then(async rules => {
  if (rules.some(r => r.id === 2)) {           // ALLOW rule = unlocked
    leaving = true;
    const i = location.href.indexOf('#');
    let orig = i < 0 ? '' : location.href.slice(i + 1);
    if (!orig || /^(javascript|data):/i.test(orig) || orig === 'chrome://newtab/') {
      // Google's normal new tab page; if that bounces back here within 2s, use google.com.
      let last = 0;
      try { last = +sessionStorage.getItem('ntpJump') || 0; sessionStorage.setItem('ntpJump', Date.now()); } catch (_) {}
      orig = Date.now() - last < 2000 ? 'https://www.google.com/' : 'chrome://new-tab-page/';
    }
    const t = await chrome.tabs.getCurrent();
    chrome.tabs.update(t.id, { url: orig });
    return;
  }
  // Shown as the new tab page: Chrome keeps keyboard focus in the address bar for
  // that. Reload as a normal page (real navigation, not just a #hash change) so
  // the keyboard goes to the page instead.
  if (!location.search && !location.hash) {
    leaving = true;
    location.replace(location.pathname + '?n#chrome://newtab/');
    return;
  }
  document.documentElement.style.visibility = '';
  pw.focus();
  chrome.runtime.sendMessage({ type: 'status' });
});

// ---- strict watch: only the keyboard is allowed; any mouse use closes Chrome ----
document.addEventListener('mousedown', () => die(true), true);
document.addEventListener('auxclick', () => die(true), true);
document.addEventListener('wheel', () => die(true), { capture: true, passive: true });
// Mouse movement: more than 2px from where the pointer was first seen (Chrome can
// fire a "fake" mousemove with unchanged coordinates when the page loads).
let mx = null, my = null;
document.addEventListener('mousemove', e => {
  if (mx === null) { mx = e.screenX; my = e.screenY; return; }
  if (Math.abs(e.screenX - mx) > 2 || Math.abs(e.screenY - my) > 2) die(true);
}, true);
document.addEventListener('contextmenu', e => { e.preventDefault(); die(true); }, true);
document.addEventListener('dragstart', () => die(true), true);

// Keyboard: the only allowed key is "/" (the password). Pressing it unlocks at
// once, no Enter needed. Any other key closes Chrome.
document.addEventListener('keydown', e => {
  e.preventDefault();
  if (e.key === '/' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) {
    leaving = true;
    chrome.runtime.sendMessage({ type: 'unlock', pw: '/' });
    return;
  }
  die(true);
}, true);

// Focus leaving the password box, or leaving the page (address bar, toolbar,
// menus, extension icons, another app) -> close.
pw.addEventListener('blur', () => die(false));
addEventListener('blur', () => die(false));

pw.focus();

// Every frame (~16ms, only while the tab is visible): if this page's window is the
// one in front but the password box doesn't have focus, focus is in Chrome's own
// UI (address bar, menus...) -> close. Catches focus that started in the address
// bar, where no "blur" ever happens. Lock screens in other, background windows are
// ignored. During the startup grace period, ask the background once to reopen this
// tab so the password box gets focus instead.
let askedForFocus = false, checking = false;
const pwFocused = () => document.hasFocus() && document.activeElement === pw;
function watch() {
  if (!dead && !leaving && !checking && document.visibilityState === 'visible' && !pwFocused()) {
    checking = true;
    chrome.windows.getCurrent().then(w => {
      checking = false;
      if (!w.focused || pwFocused()) return;   // background window / another app in front
      if (!inGrace()) die(false);
      else if (!askedForFocus && !document.hasFocus()) {
        askedForFocus = true;
        chrome.runtime.sendMessage({ type: 'unfocused', armed: false });
      }
    }, () => { checking = false; });
  }
  if (!dead) requestAnimationFrame(watch);
}
requestAnimationFrame(watch);

form.addEventListener('submit', async e => {
  e.preventDefault();
  const value = pw.value;
  pw.value = '';
  leaving = true;  // correct: background restores the tabs; wrong: background closes Chrome
  await chrome.runtime.sendMessage({ type: 'unlock', pw: value });
});
