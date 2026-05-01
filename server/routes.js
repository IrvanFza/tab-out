// server/routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Express API routes for Tab Out.
//
// Think of this file as the "front desk" of the app's backend. The browser
// sends requests here, and these routes figure out what data to fetch or what
// action to take, then send back a JSON response.
//
// Every endpoint path starts with /api/, so:
//   - The browser asks  →  GET /api/missions
//   - This file handles →  router.get('/missions', ...)
//   - The main server (index.js) mounts this router at /api
//
// All "prepared statements" from db.js follow the better-sqlite3 pattern:
//   - .all()    → returns an array of rows (for SELECT queries)
//   - .run()    → executes a write (INSERT / UPDATE / DELETE)
//   - .get()    → returns a single row or undefined
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const path = require('path');
const config = require('./config');
const { getUpdateStatus } = require('./updater');

// Pull in the database prepared statements we need
const {
  getMissions,
  getMissionUrls,
  dismissMission,
  archiveMission,
  getMeta,
  db,
  getDeferredActive,
  getDeferredArchived,
  insertDeferred,
  checkDeferred,
  dismissDeferred,
  ageOutDeferred,
  searchDeferredArchived,
  insertSession,
  getSessions,
  getSession,
  deleteSession,
} = require('./db');

// An Express Router is like a mini-app: it holds a group of related routes.
// We export it and mount it on the main Express app in index.js.
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/missions
//
// Returns all non-dismissed missions, each with their URLs attached.
//
// The database stores missions and URLs in separate tables (a "one-to-many"
// relationship). This endpoint joins them together in JavaScript — we first
// fetch all missions, then for each mission, fetch its URLs and attach them
// as a `urls` property on the mission object.
//
// Response shape:
//   [
//     {
//       id: "abc123",
//       name: "Planning Tokyo Trip",
//       summary: "...",
//       status: "active",
//       last_activity: "2024-01-15T10:00:00Z",
//       urls: [
//         { id: 1, mission_id: "abc123", url: "https://...", title: "...", visit_count: 3 },
//         ...
//       ]
//     },
//     ...
//   ]
// ─────────────────────────────────────────────────────────────────────────────
router.get('/missions', (req, res) => {
  try {
    // Fetch all non-dismissed missions (ordered by status priority, then recency)
    const missions = getMissions.all();

    // For each mission, fetch its associated URLs and attach them
    const missionsWithUrls = missions.map(mission => ({
      ...mission,                                    // spread all mission fields
      urls: getMissionUrls.all({ id: mission.id }),  // attach urls array
    }));

    res.json(missionsWithUrls);
  } catch (err) {
    console.error('[routes] GET /missions failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch missions' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/missions/:id/dismiss
//
// Soft-deletes a mission by marking it dismissed = 1 in the database.
// The mission data is kept (for history) but it won't appear in the main list.
//
// :id is a URL parameter — e.g. POST /api/missions/abc123/dismiss
//
// Response: { success: true }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/missions/:id/dismiss', (req, res) => {
  try {
    const { id } = req.params; // extract the mission ID from the URL

    // Run the UPDATE query: sets dismissed = 1 for this mission id
    dismissMission.run({ id });

    res.json({ success: true });
  } catch (err) {
    console.error('[routes] POST /missions/:id/dismiss failed:', err.message);
    res.status(500).json({ error: 'Failed to dismiss mission' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/missions/:id/archive
//
// Saves a snapshot of the mission into the archives table, then dismisses it.
// Archiving is "dismiss + save a record". It's useful for reviewing what you
// worked on in the past — the archive keeps the name and URLs even after dismiss.
//
// Steps:
//   1. Find the mission by id (return 404 if not found)
//   2. Fetch its associated URLs
//   3. Insert a row into the archives table (mission + urls as JSON)
//   4. Dismiss the mission (soft-delete it from the active list)
//
// Response: { success: true }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/missions/:id/archive', (req, res) => {
  try {
    const { id } = req.params;

    // ── Step 1: Find the mission ───────────────────────────────────────────────
    // db.prepare().get() returns a single row object or undefined.
    // We need to check if the mission actually exists before archiving it.
    const mission = db
      .prepare('SELECT * FROM missions WHERE id = ? AND dismissed = 0')
      .get(id);

    if (!mission) {
      return res.status(404).json({ error: 'Mission not found or already dismissed' });
    }

    // ── Step 2: Fetch the mission's URLs ───────────────────────────────────────
    const urls = getMissionUrls.all({ id: mission.id });

    // ── Step 3: Insert into archives ───────────────────────────────────────────
    // We store the URLs as a JSON string (urls_json) because the archives table
    // only needs to display them as a list — we don't need to query individual
    // archived URLs. Storing as JSON keeps the archives table simple.
    archiveMission.run({
      mission_id: mission.id,
      mission_name: mission.name,
      urls_json: JSON.stringify(urls),      // array of URL objects → JSON string
      archived_at: new Date().toISOString(),  // ISO timestamp of when archived
    });

    // ── Step 4: Dismiss the mission ────────────────────────────────────────────
    // This soft-deletes it from the active list (dismissed = 1).
    // We do this after archiving so we don't lose data if the archive insert fails.
    dismissMission.run({ id: mission.id });

    res.json({ success: true });
  } catch (err) {
    console.error('[routes] POST /missions/:id/archive failed:', err.message);
    res.status(500).json({ error: 'Failed to archive mission' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/stats
//
// Returns summary statistics about the current state of missions.
// Used by the dashboard footer to show things like open tab count.
//
// Response:
//   {
//     totalMissions:    14,   // non-dismissed missions
//     totalUrls:        87,   // total URLs across all active missions
//     abandonedMissions: 3,   // missions with status = 'abandoned'
//     lastAnalysis:     "2024-01-15T10:30:00Z"  // ISO timestamp (or null)
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  try {
    // Count total non-dismissed missions
    // .get() returns a single row — here it's { count: 14 }
    const { count: totalMissions } = db
      .prepare('SELECT COUNT(*) as count FROM missions WHERE dismissed = 0')
      .get();

    // Count total URLs across all active (non-dismissed) missions
    // We join mission_urls to missions to only count URLs from active missions
    const { count: totalUrls } = db
      .prepare(`
        SELECT COUNT(*) as count
        FROM   mission_urls mu
        JOIN   missions m ON mu.mission_id = m.id
        WHERE  m.dismissed = 0
      `)
      .get();

    // Count missions with status = 'abandoned' (non-dismissed only)
    const { count: abandonedMissions } = db
      .prepare(`
        SELECT COUNT(*) as count
        FROM   missions
        WHERE  dismissed = 0
          AND  status    = 'abandoned'
      `)
      .get();

    // Get last_analysis timestamp from the meta key-value store
    // getMeta.get() returns { value: "2024-01-15T..." } or undefined if never run
    const metaRow = getMeta.get({ key: 'last_analysis' });
    const lastAnalysis = metaRow ? metaRow.value : null;

    res.json({
      totalMissions,
      totalUrls,
      abandonedMissions,
      lastAnalysis,
    });
  } catch (err) {
    console.error('[routes] GET /stats failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/update-status
//
// Read-only check: is there a newer version on GitHub?
// No shell commands, no code execution. Just returns a boolean.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/update-status', (req, res) => {
  try {
    res.json(getUpdateStatus());
  } catch {
    res.json({ updateAvailable: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/defer
//
// Save one or more tabs for later. The browser closes them; we store them here
// so they appear in the "Saved for Later" checklist on the dashboard.
//
// Expects: { tabs: [{ url, title, favicon_url?, source_mission? }] }
// Returns: { success: true, deferred: [{ id, url, title, ... }] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/defer', (req, res) => {
  try {
    const { tabs } = req.body;
    if (!tabs || !Array.isArray(tabs) || tabs.length === 0) {
      return res.status(400).json({ error: 'tabs array is required' });
    }

    const created = [];
    for (const tab of tabs) {
      if (!tab.url || !tab.title) continue; // skip incomplete entries
      const result = insertDeferred.run({
        url: tab.url,
        title: tab.title,
        favicon_url: tab.favicon_url || null,
        source_mission: tab.source_mission || null,
      });
      created.push({
        id: result.lastInsertRowid,
        url: tab.url,
        title: tab.title,
        favicon_url: tab.favicon_url || null,
        source_mission: tab.source_mission || null,
        deferred_at: new Date().toISOString(),
      });
    }

    res.json({ success: true, deferred: created });
  } catch (err) {
    console.error('[tab-out] Error deferring tabs:', err);
    res.status(500).json({ error: 'Failed to defer tabs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/deferred
//
// Returns both active and archived deferred tabs. Also runs the 30-day
// age-out check — any deferred tab older than 30 days gets auto-archived.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/deferred', (req, res) => {
  try {
    // Auto-archive anything older than 30 days
    ageOutDeferred.run();

    const active = getDeferredActive.all();
    const archived = getDeferredArchived.all();

    res.json({ active, archived });
  } catch (err) {
    console.error('[tab-out] Error fetching deferred tabs:', err);
    res.status(500).json({ error: 'Failed to fetch deferred tabs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/deferred/search?q=query
//
// Search archived deferred tabs by title or URL. Returns up to 50 matches.
//
// IMPORTANT: This route MUST come before PATCH /deferred/:id. Express matches
// routes in order — if the PATCH came first, "search" would be treated as the
// :id parameter and this endpoint would never be reached.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/deferred/search', (req, res) => {
  try {
    const q = req.query.q || '';
    if (q.length < 2) {
      return res.json({ results: [] });
    }
    const results = searchDeferredArchived.all({ q });
    res.json({ results });
  } catch (err) {
    console.error('[tab-out] Error searching deferred tabs:', err);
    res.status(500).json({ error: 'Failed to search deferred tabs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/deferred/:id
//
// Update a deferred tab — either check it off or dismiss it.
// Expects: { checked: true } or { dismissed: true }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/deferred/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    if (req.body.checked) {
      checkDeferred.run({ id });
    } else if (req.body.dismissed) {
      dismissDeferred.run({ id });
    } else {
      return res.status(400).json({ error: 'Must provide checked or dismissed' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[tab-out] Error updating deferred tab:', err);
    res.status(500).json({ error: 'Failed to update deferred tab' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SESSIONS — save/list/restore/delete a named set of tabs.
//
// A "session" is a named snapshot of tabs. The user clicks Save on the
// dashboard → we store the current tab URLs as JSON. Later they can restore
// the session (extension reopens each URL as a new tab) or delete it.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/sessions', (req, res) => {
  try {
    const rows = getSessions.all();
    const sessions = rows.map(r => ({
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      tabs: safeParseTabs(r.urls_json),
    }));
    res.json({ sessions });
  } catch (err) {
    console.error('[routes] GET /sessions failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

router.post('/sessions', (req, res) => {
  try {
    const name = (req.body && req.body.name || '').trim();
    const tabs = req.body && req.body.tabs;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!Array.isArray(tabs) || tabs.length === 0) {
      return res.status(400).json({ error: 'tabs array is required' });
    }
    // Strip to just the fields we want stored — extension Tab objects can be huge
    const slim = tabs
      .filter(t => t && t.url)
      .map(t => ({ url: t.url, title: t.title || '', favIconUrl: t.favIconUrl || null }));
    if (slim.length === 0) {
      return res.status(400).json({ error: 'no valid tabs to save' });
    }
    const result = insertSession.run({
      name: name.slice(0, 100),
      urls_json: JSON.stringify(slim),
    });
    const row = getSession.get({ id: result.lastInsertRowid });
    res.json({
      session: {
        id: row.id,
        name: row.name,
        created_at: row.created_at,
        tabs: safeParseTabs(row.urls_json),
      },
    });
  } catch (err) {
    console.error('[routes] POST /sessions failed:', err.message);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

router.delete('/sessions/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });
    deleteSession.run({ id });
    res.json({ success: true });
  } catch (err) {
    console.error('[routes] DELETE /sessions/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

function safeParseTabs(urlsJson) {
  try {
    const arr = JSON.parse(urlsJson);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/quote
//
// Proxies the daily quote from ZenQuotes. The browser can't fetch
// zenquotes.io directly due to CORS restrictions, so we route it
// through the server.
//
// Response: { text, author } or { error } on failure.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/quote', async (req, res) => {
  try {
    const resp = await fetch('https://zenquotes.io/api/random');
    const json = await resp.json();
    if (Array.isArray(json) && json.length > 0) {
      res.json({ text: json[0].q, author: json[0].a });
    } else {
      res.status(502).json({ error: 'Unexpected ZenQuotes response' });
    }
  } catch (err) {
    console.error('[routes] GET /quote proxy failed:', err.message);
    res.status(502).json({ error: 'Failed to fetch quote' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/config
//
// Returns the current dashboard configuration (port, userName, pomodoro, clock,
// search engine, quote visibility, quick links).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  try {
    const { port, userName, pomodoroWorkMinutes, pomodoroBreakMinutes, clockShowSeconds, clockFormat, quoteText, quoteAuthor, useDynamicQuote, searchEngine, quickLinks } = config;
    res.json({ port, userName, pomodoroWorkMinutes, pomodoroBreakMinutes, clockShowSeconds, clockFormat, quoteText, quoteAuthor, useDynamicQuote, searchEngine, quickLinks: quickLinks || [] });
  } catch (err) {
    console.error('[routes] GET /config failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/config
//
// Updates configuration values. Only known keys are accepted; unknown keys
// are silently ignored. Validates ranges and enums before saving.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/config', (req, res) => {
  try {
    const allowed = ['userName', 'pomodoroWorkMinutes', 'pomodoroBreakMinutes', 'clockShowSeconds', 'clockFormat', 'quoteText', 'quoteAuthor', 'useDynamicQuote', 'searchEngine', 'quickLinks'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid config keys provided' });
    }
    config.save(updates);
    const { port, userName, pomodoroWorkMinutes, pomodoroBreakMinutes, clockShowSeconds, clockFormat, quoteText, quoteAuthor, useDynamicQuote, searchEngine, quickLinks } = config;
    res.json({ port, userName, pomodoroWorkMinutes, pomodoroBreakMinutes, clockShowSeconds, clockFormat, quoteText, quoteAuthor, useDynamicQuote, searchEngine, quickLinks: quickLinks || [] });
  } catch (err) {
    console.error('[routes] PATCH /config failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Export
//
// The main Express app (index.js) does:
//   const routes = require('./routes');
//   app.use('/api', routes);
//
// That mounts all of our router.get('/missions') etc. at /api/missions.
// ─────────────────────────────────────────────────────────────────────────────
module.exports = router;
