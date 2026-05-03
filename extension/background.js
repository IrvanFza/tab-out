/**
 * background.js — Service Worker for Badge Updates
 *
 * This is Chrome's "always-on" background script for the extension. Unlike a
 * normal webpage script, it keeps running even when no tabs are open.
 *
 * Its only job is to keep the toolbar badge up to date with the current
 * mission count from the dashboard server. The badge is the little number/text
 * that appears on the extension icon in the Chrome toolbar.
 *
 * Color coding gives the user a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–3 missions  (focused, manageable)
 *   Amber  (#b8892e) → 4–6 missions  (getting busy)
 *   Red    (#b35a5a) → 7+ missions   (overloaded — time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge — Fetches mission stats from the local server and updates the
 * Chrome toolbar badge to reflect the current total mission count.
 */
async function updateBadge() {
  try {
    const res  = await fetch('http://localhost:3456/api/stats');
    const data = await res.json();

    const count = data.totalMissions ?? 0;

    // Don't show "0" — an empty badge is cleaner when there's nothing to do
    if (count === 0) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }

    // Set the text (Chrome badge supports short strings; a number works great)
    chrome.action.setBadgeText({ text: String(count) });

    // Pick a color based on workload level
    let badgeColor;
    if (count <= 3) {
      badgeColor = '#3d7a4a'; // Green — you're in control
    } else if (count <= 6) {
      badgeColor = '#b8892e'; // Amber — things are piling up
    } else {
      badgeColor = '#b35a5a'; // Red — time to focus and close some tabs
    }

    chrome.action.setBadgeBackgroundColor({ color: badgeColor });

  } catch {
    // If the server isn't running, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update the badge immediately when the extension is first installed.
// History backfill is owned by the new-tab page (newtab.js) so it doesn't
// depend on the service worker being awake at the right moment.
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update the badge when Chrome starts up (e.g. after a reboot)
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update the badge whenever a new tab is opened — the user might be adding
// work that should bump the mission count
chrome.tabs.onCreated.addListener((tab) => {
  updateBadge();
  recordTabEvent('open', tab && tab.url);
});

// Update the badge whenever a tab is closed — a mission may have been completed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
  recordTabEvent('close', null);
});

// ─── Daily stats tracking ──────────────────────────────────────────────────
// Lightweight fire-and-forget events to the local server so the dashboard
// can show "yesterday at a glance." We only send the hostname, not the full
// URL, and never block on a failed network call.
async function recordTabEvent(type, url) {
  try {
    let domain = null;
    if (url) {
      try { domain = new URL(url).hostname; } catch { /* skip */ }
    }
    await fetch('http://localhost:3456/api/stats/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, domain }),
    });
  } catch { /* server may be down — drop the event */ }
}

// History backfill lives in newtab.js — the new-tab page has chrome.history
// access too and runs reliably on every dashboard open, so we don't need to
// duplicate it here in the service worker.

// ─── Snooze waker ──────────────────────────────────────────────────────────
// Poll the server every minute for snoozed tabs whose wake_at is past, then
// open them as background tabs and mark them woken. Uses chrome.alarms so it
// keeps firing even when the service worker has been put to sleep.

chrome.alarms.create('tabout-snooze-check', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'tabout-snooze-check') return;
  await wakeDueSnoozes();
});

async function wakeDueSnoozes() {
  try {
    const res = await fetch('http://localhost:3456/api/snoozes/due');
    if (!res.ok) return;
    const data = await res.json();
    const due = Array.isArray(data.due) ? data.due : [];
    if (due.length === 0) return;
    const win = await chrome.windows.getCurrent().catch(() => null);
    for (const s of due) {
      try {
        await chrome.tabs.create({
          url: s.url,
          windowId: win ? win.id : undefined,
          active: false,
        });
        await fetch(`http://localhost:3456/api/snoozes/${s.id}/woken`, { method: 'POST' });
      } catch { /* skip URLs Chrome refuses */ }
    }
  } catch { /* server may be down */ }
}

// ─── Polling ─────────────────────────────────────────────────────────────────

// Refresh the badge every 60 seconds in case missions are added/edited via
// the dashboard without any tab events firing (e.g. editing inside the app)
setInterval(updateBadge, 60 * 1000);

// Also run once immediately when the service worker first loads
updateBadge();
