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

// Update the badge immediately when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  backfillFromHistory();
});

// Update the badge when Chrome starts up (e.g. after a reboot)
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  backfillFromHistory();
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

// ─── History backfill ──────────────────────────────────────────────────────
// Pulls the user's chrome.history visits (last ~365 days) and aggregates them
// into daily_stats so the heatmap reflects their actual browsing past, not
// just events recorded since Tab Out was installed. Runs once per major
// version bump or once if the flag isn't set; the server's INSERT OR IGNORE
// guarantees we never clobber live event counters.

const BACKFILL_VERSION = 1;

async function backfillFromHistory() {
  try {
    const stored = await chrome.storage.local.get('historyBackfillVersion');
    if (stored.historyBackfillVersion === BACKFILL_VERSION) return;

    if (!chrome.history || !chrome.history.search) return;

    // Pull ~365 days of history. chrome.history.search caps at 1k results
    // by default — request a high maxResults so we get most visits. For
    // truly heavy users this still won't be exhaustive, but it covers the
    // visible heatmap window.
    const startTime = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const items = await chrome.history.search({
      text: '',
      startTime,
      maxResults: 100000,
    });
    if (!Array.isArray(items) || items.length === 0) {
      await chrome.storage.local.set({ historyBackfillVersion: BACKFILL_VERSION });
      return;
    }

    // Aggregate: per-day visit count + per-domain counts. We use lastVisitTime
    // as the bucket. visitCount applies to the URL across all time, so we'd
    // overcount if we used it; safer to count one event per HistoryItem.
    const byDay = {};
    for (const item of items) {
      if (!item.lastVisitTime) continue;
      const day = new Date(item.lastVisitTime).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { opens: 0, closes: 0, domains: {} };
      byDay[day].opens += 1;
      try {
        const host = new URL(item.url).hostname;
        if (host) byDay[day].domains[host] = (byDay[day].domains[host] || 0) + 1;
      } catch { /* skip unparseable */ }
    }

    const days = Object.entries(byDay).map(([day, agg]) => ({
      day,
      opens: agg.opens,
      closes: 0,                // history doesn't track closes
      domains: agg.domains,
    }));

    const res = await fetch('http://localhost:3456/api/stats/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    if (res.ok) {
      await chrome.storage.local.set({ historyBackfillVersion: BACKFILL_VERSION });
    }
  } catch { /* server may be down — try again on next startup */ }
}

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
