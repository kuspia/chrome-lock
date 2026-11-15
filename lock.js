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

// Already unlocked (e.g. Back button)? The background moves this tab onward.
// Opened by a navigation attempt while locked? The background closes Chrome.
chrome.runtime.sendMessage({ type: 'status' }).then(r => { if (r && !r.locked) leaving = true; });

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

// Every frame (~16ms, only while the tab is visible): if the password box doesn't
// have focus, close. Catches the case where focus started in the address bar, so
// no "blur" ever happened. During the startup grace period, ask the background
// once to reopen this tab so the password box gets focus instead.
let askedForFocus = false;
function watch() {
  if (document.visibilityState === 'visible' &&
      !(document.hasFocus() && document.activeElement === pw)) {
    if (!inGrace()) die(false);
    else if (!askedForFocus && !document.hasFocus()) {
      askedForFocus = true;
      chrome.runtime.sendMessage({ type: 'unfocused', armed: false });
    }
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
