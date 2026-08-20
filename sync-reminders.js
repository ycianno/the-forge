#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// The Forge's engine — the single source of truth for check-id derivation and
// the attribute→category map. Shared with the browser (public/modules.js) so
// this script and the app can never disagree about which id a quest owns.
const Forge = require('./public/modules.js');

// 1. Load Environment Variables
function loadEnv() {
  const envPath = path.join(__dirname, '.env.sync');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?$/);
      if (match) {
        const key = match[1];
        let value = (match[2] || '').trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (!process.env[key]) process.env[key] = value;
      }
    });
  }
}

loadEnv();

const FORGE_URL = process.env.FORGE_URL;
const FORGE_SYNC_TOKEN = process.env.FORGE_SYNC_TOKEN;

if (!FORGE_URL || !FORGE_SYNC_TOKEN) {
  console.error("Missing FORGE_URL or FORGE_SYNC_TOKEN in environment or .env.sync");
  process.exit(1);
}

// 2. Forge API Helper
async function fetchApi(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, FORGE_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${FORGE_SYNC_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };

    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data ? JSON.parse(data) : null);
        } else {
          reject(new Error(`API Error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 3. JXA Apple Reminders Helpers
function runJxa(script) {
  const tmpFile = path.join(require('os').tmpdir(), `forge-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  try {
    fs.writeFileSync(tmpFile, script, 'utf8');
    const output = execSync(`osascript -l JavaScript "${tmpFile}"`, { encoding: 'utf8' });
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    return output.trim();
  } catch (error) {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    return null;
  }
}

function getReminders() {
  const script = `
    const app = Application("Reminders");
    let list;
    try { list = app.lists.byName("The Forge"); list.name(); }
    catch(e) { list = app.List({ name: "The Forge" }); app.lists.push(list); }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const reminders = list.reminders();
    const result = reminders.map(r => {
      let dueTime = "";
      let isPast = false;
      let dateStr = "";
      try {
        const d = r.dueDate();
        if (d) {
          const dt = new Date(d);
          const y = dt.getFullYear();
          const mo = String(dt.getMonth() + 1).padStart(2, '0');
          const dy = String(dt.getDate()).padStart(2, '0');
          dateStr = \`\${y}-\${mo}-\${dy}\`;

          if (dt < todayStart) {
            isPast = true;
          }
          const h = dt.getHours();
          const m = dt.getMinutes();
          if (h !== 0 || m !== 0) {
            dueTime = (h < 10 ? '0' + h : '' + h) + ':' + (m < 10 ? '0' + m : '' + m);
          }
        }
      } catch(e) {}

      return {
        id: r.id(),
        name: r.name(),
        body: r.body() || "",
        completed: r.completed(),
        dueTime,
        isPast,
        dateStr
      };
    });
    JSON.stringify(result);
  `;
  const res = runJxa(script);
  return res ? JSON.parse(res) : [];
}

function createReminder(name, body, dueTime) {
  let timeSetup = '';
  let dueField = '';
  if (dueTime && /^\d{1,2}:\d{2}$/.test(dueTime)) {
    const [h, m] = dueTime.split(':').map(Number);
    timeSetup = `const d = new Date(); d.setHours(${h}, ${m}, 0, 0);`;
    dueField = `dueDate: d`;
  } else {
    timeSetup = `const d = new Date(); d.setHours(0, 0, 0, 0);`;
    dueField = `alldayDueDate: d`;
  }

  const script = `
    const app = Application("Reminders");
    let list;
    try { list = app.lists.byName("The Forge"); list.name(); }
    catch(e) { list = app.List({ name: "The Forge" }); app.lists.push(list); }
    ${timeSetup}
    const rem = app.Reminder({
      name: ${JSON.stringify(name)},
      body: ${JSON.stringify(body)},
      ${dueField}
    });
    list.reminders.push(rem);
  `;
  runJxa(script);
}

function updateReminderTimeAndBody(id, dueTime, body) {
  let timeSetup = '';
  if (dueTime && /^\d{1,2}:\d{2}$/.test(dueTime)) {
    const [h, m] = dueTime.split(':').map(Number);
    timeSetup = `const d = new Date(); d.setHours(${h}, ${m}, 0, 0); rem.dueDate = d;`;
  } else {
    timeSetup = `const d = new Date(); d.setHours(0, 0, 0, 0); rem.alldayDueDate = d;`;
  }

  const script = `
    const app = Application("Reminders");
    try {
      const rem = app.reminders.byId(${JSON.stringify(id)});
      ${timeSetup}
      if (${JSON.stringify(body)}) rem.body = ${JSON.stringify(body)};
    } catch(e) {}
  `;
  runJxa(script);
}

function markReminderCompleted(id) {
  const script = `
    const app = Application("Reminders");
    try {
      const rem = app.reminders.byId(${JSON.stringify(id)});
      rem.completed = true;
    } catch(e) {}
  `;
  runJxa(script);
}

function deleteReminder(id) {
  const script = `
    const app = Application("Reminders");
    try {
      const rem = app.reminders.byId(${JSON.stringify(id)});
      rem.delete();
    } catch(e) {}
  `;
  runJxa(script);
}

// 4. Date & Key Computations
function getDates() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  const todayStr = `${year}-${month}-${date}`;
  const dayIndex = now.getDay(); // 0-6, 0=Sunday

  const sunday = new Date(now);
  sunday.setDate(now.getDate() - dayIndex);
  const sYear = sunday.getFullYear();
  const sMonth = String(sunday.getMonth() + 1).padStart(2, '0');
  const sDate = String(sunday.getDate()).padStart(2, '0');
  const weekKey = `${sYear}-${sMonth}-${sDate}`;

  return { todayStr, dayIndex, weekKey };
}

// Clean title helper (strips 🗡️ prefix if present)
function cleanTitle(str) {
  return String(str || '').replace(/^🗡️\s*/, '').trim();
}

// 6. Main Sync Logic
async function sync() {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] Starting Forge Reminders Sync...`);
  let syncedCount = 0;
  let errorCount = 0;

  try {
    const [settings, database] = await Promise.all([
      fetchApi('/api/settings'),
      fetchApi('/api/database')
    ]);

    const { todayStr, dayIndex, weekKey } = getDates();
    const weekData = (database.weeks && database.weeks[weekKey]) ? database.weeks[weekKey] : { checks: {}, fields: {} };
    const checks = weekData.checks || {};

    // 1. Fetch current Apple Reminders
    const allReminders = getReminders();

    // 2. Clean up past/yesterday reminders AND duplicate reminders from Apple Reminders
    const seenTitles = new Set();
    for (let i = allReminders.length - 1; i >= 0; i--) {
      const r = allReminders[i];
      const isForgeReminder = (r.name || '').includes('🗡️') || (r.body || '').includes('forge:');
      if (!isForgeReminder) continue;

      const cTitle = cleanTitle(r.name);
      if (r.isPast || (r.dateStr && r.dateStr < todayStr)) {
        console.log(`  ✕ Cleaning past reminder from ${r.dateStr || 'yesterday'}: ${r.name}`);
        deleteReminder(r.id);
        syncedCount++;
      } else if (seenTitles.has(cTitle)) {
        console.log(`  ✕ Cleaning duplicate reminder: ${r.name}`);
        deleteReminder(r.id);
        syncedCount++;
      } else {
        seenTitles.add(cTitle);
      }
    }

    // Fetch fresh active reminders after clearing past and duplicate items
    const reminders = getReminders().filter(r => !r.isPast && (!r.dateStr || r.dateStr >= todayStr));

    // 3. Compute today's active quests
    const activeQuests = {};
    (settings.quests || []).forEach(q => {
      if (q.archived) return;

      // Check ids come from the engine (public/modules.js) — never rebuilt here.
      // A private copy of this format silently desyncs Reminders from The Forge.
      let checkId = null;

      if (q.scheduleType === 'weekly' && q.repeatDays && q.repeatDays.includes(dayIndex)) {
        checkId = Forge.questCheckId(q, dayIndex);
      } else if (q.scheduleType !== 'weekly' && q.scheduledDate === todayStr) {
        checkId = Forge.questCheckId(q);
      }

      if (checkId) {
        activeQuests[checkId] = {
          title: q.title,
          attr: q.attr || 'Discipline',
          dueTime: q.dueTime || '',
          checkId,
          isCompleted: !!checks[checkId]
        };
      }
    });

    let forgeUpdates = false;
    // Only the completions this cycle produced — the payload for the merge patch.
    const completedHere = {};

    // 4. Reconcile Today's Forge Quests <-> Today's Reminders
    for (const checkId in activeQuests) {
      const q = activeQuests[checkId];
      const reminder = reminders.find(r => 
        cleanTitle(r.name) === q.title.trim() || r.body.includes('forge:' + checkId)
      );

      if (!reminder) {
        // Quest not in Reminders yet — create it for Today (unless already completed in Forge)
        if (!q.isCompleted) {
          console.log(`  + Creating Today Reminder: ${q.title} (${q.dueTime || 'all-day'})`);
          createReminder('🗡️ ' + q.title, q.attr || 'Discipline', q.dueTime);
          syncedCount++;
        }
      } else {
        // Reminder exists for Today: check if dueTime needs updating
        if (q.dueTime !== reminder.dueTime) {
          console.log(`  ✎ Updating Reminder time for ${q.title}: ${reminder.dueTime || 'all-day'} -> ${q.dueTime || 'all-day'}`);
          updateReminderTimeAndBody(reminder.id, q.dueTime, q.attr || 'Discipline');
          syncedCount++;
        }

        if (reminder.completed && !q.isCompleted) {
          // Completed in Reminders but not in Forge → mark done in Forge for Today
          console.log(`  ← Forge complete: ${q.title}`);
          checks[checkId] = true;
          completedHere[checkId] = true;
          forgeUpdates = true;
          syncedCount++;
        } else if (q.isCompleted && !reminder.completed) {
          // Completed in Forge but not in Reminders → mark Reminder done
          console.log(`  → Reminder complete: ${q.title}`);
          markReminderCompleted(reminder.id);
          syncedCount++;
        }
      }
    }

    // 5. Cleanup stale/orphaned Reminders for Today (quests no longer active today)
    for (const r of reminders) {
      const rName = cleanTitle(r.name);
      const isForgeReminder = (r.name || '').includes('🗡️') || (r.body || '').includes('forge:');
      if (!isForgeReminder) continue;

      const matchQuest = Object.values(activeQuests).find(q => q.title.trim() === rName);
      if (!matchQuest && !r.completed) {
        console.log(`  ✕ Removing stale: ${r.name}`);
        deleteReminder(r.id);
        syncedCount++;
      }
    }

    // Push back only the checks this cycle actually completed.
    // A whole-week POST would carry the snapshot fetched at the top of this run
    // and silently discard anything ticked in the browser since — which is the
    // one thing a two-way sync must never do.
    if (forgeUpdates) {
      const count = Object.keys(completedHere).length;
      console.log(`  ↑ Sending ${count} completion${count === 1 ? '' : 's'} to Forge...`);
      await fetchApi('/api/week/' + weekKey, 'PATCH', { checks: completedHere });
    }

    // Report heartbeat
    await fetchApi('/api/sync/heartbeat', 'POST', {
      lastSync: new Date().toISOString(),
      synced: syncedCount,
      errors: errorCount
    });

    console.log(`[${ts}] Sync complete — ${syncedCount} actions, ${Object.keys(activeQuests).length} active quests today.`);

  } catch (error) {
    console.error(`[${ts}] Sync failed:`, error.message);
    errorCount++;
    try {
      await fetchApi('/api/sync/heartbeat', 'POST', {
        lastSync: new Date().toISOString(),
        synced: syncedCount,
        errors: errorCount
      });
    } catch (_) {
      // Forge unreachable — nothing we can do
    }
    process.exit(1);
  }
}

sync();
