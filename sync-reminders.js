#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

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
    console.error("JXA Execution Error:", error.message);
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

    const reminders = list.reminders();
    const result = reminders.map(r => ({
      id: r.id(),
      name: r.name(),
      body: r.body() || "",
      completed: r.completed()
    }));
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

function markReminderCompleted(id) {
  const script = `
    const app = Application("Reminders");
    const rem = app.reminders.byId(${JSON.stringify(id)});
    rem.completed = true;
  `;
  runJxa(script);
}

function deleteReminder(id) {
  const script = `
    const app = Application("Reminders");
    const rem = app.reminders.byId(${JSON.stringify(id)});
    rem.delete();
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

// 5. Attribute → category fallback (matches The Forge's attrCat() function)
function attrCat(attr) {
  const map = { Discipline: 'discipline', Body: 'training', Mind: 'study', Vitality: 'provisions', Craft: 'projects' };
  return map[attr] || 'discipline';
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

    // Compute today's active quests
    const activeQuests = {};
    (settings.quests || []).forEach(q => {
      if (q.archived) return;

      const category = q.category || attrCat(q.attr || 'Discipline');
      let checkId = null;

      if (q.scheduleType === 'weekly' && q.repeatDays && q.repeatDays.includes(dayIndex)) {
        checkId = `quest-${category}-${q.id}-d${dayIndex}`;
      } else if (q.scheduleType !== 'weekly' && q.scheduledDate === todayStr) {
        checkId = `quest-${category}-${q.id}`;
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

    const reminders = getReminders();
    let forgeUpdates = false;

    // Reconcile Forge <-> Reminders
    for (const checkId in activeQuests) {
      const q = activeQuests[checkId];
      // Match by title (clean) OR checkId in body for backwards compatibility
      const reminder = reminders.find(r => 
        cleanTitle(r.name) === q.title.trim() || r.body.includes('forge:' + checkId)
      );

      if (!reminder) {
        // Quest not in Reminders yet — create it (unless already completed in Forge)
        if (!q.isCompleted) {
          console.log(`  + Creating Reminder: ${q.title} (${q.dueTime || 'all-day'})`);
          createReminder('🗡️ ' + q.title, q.attr || 'Discipline', q.dueTime);
          syncedCount++;
        }
      } else {
        if (reminder.completed && !q.isCompleted) {
          // Completed in Reminders but not in Forge → mark done in Forge
          console.log(`  ← Forge complete: ${q.title}`);
          checks[checkId] = true;
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

    // Cleanup stale/orphaned Reminders (quests no longer active today)
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

    // Push updated week data back to Forge if anything changed
    if (forgeUpdates) {
      console.log(`  ↑ Uploading week data to Forge...`);
      weekData.checks = checks;
      await fetchApi('/api/week/' + weekKey, 'POST', weekData);
    }

    // Report heartbeat
    await fetchApi('/api/sync/heartbeat', 'POST', {
      lastSync: new Date().toISOString(),
      synced: syncedCount,
      errors: errorCount
    });

    console.log(`[${ts}] Sync complete — ${syncedCount} actions, ${Object.keys(activeQuests).length} active quests.`);

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
