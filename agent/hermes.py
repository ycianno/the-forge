#!/usr/bin/env python3
"""
Hermes — Game Master & Discord Agent for The Forge

Reads The Forge's SQLite database, mirrors the app's XP engine to know your
level / rank / attributes / streak / badges, detects milestones since the last
run, and posts a rich, game-aware Discord embed written by a local Ollama model.

Configure paths and your Discord webhook in config.json (see config.example.json).
Run it on a schedule (cron / systemd timer) to get morning quest boards,
midday nudges, evening recaps, and a weekly retrospective on Discord.

Usage:
  python3 hermes.py              # Normal run (cron mode)
  python3 hermes.py --dry-run    # Evaluate + print, no Discord, no state write
  python3 hermes.py --test       # Send a test embed to Discord
  python3 hermes.py --verbose    # Detailed debug output
"""

import argparse
import datetime
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
STATE_PATH = os.path.join(SCRIPT_DIR, "hermes_state.json")

DEFAULT_CONFIG = {
    "database_path": "/path/to/the-forge/data/database.sqlite",
    "ollama_url": "http://localhost:11434",
    "ollama_model": "qwen2.5:3b",
    "discord_webhook_url": "",
    "persona": "game_master",          # game_master | ruthless_sergeant | hype_coach
    "quiet_hours_start": 22,
    "quiet_hours_end": 8,
    "silent_if_complete": True,
    # --- Ollama performance / RAM tuning ---
    "ollama_keep_alive": 0,            # seconds to keep model in RAM after a call (0 = unload now)
    "ollama_num_ctx": 1024,            # small context = less KV-cache RAM
    "ollama_num_predict": 400,         # response budget (no reasoning model needed)
    "ollama_temperature": 0.8,
}

DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

# XP economy — mirrors public/game.js
XP_BY_CAT = {"discipline": 10, "training": 30, "study": 25, "protein": 12, "project": 30, "other": 8}
STUDY_HOUR_XP = 8
PROJECT_HOUR_XP = 12
ATTR_OF_CAT = {"discipline": "Discipline", "training": "Body", "study": "Mind", "protein": "Vitality", "project": "Craft"}
CAT_OF_ATTR = {v: k for k, v in ATTR_OF_CAT.items()}
ATTR_ORDER = ["Discipline", "Body", "Mind", "Vitality", "Craft"]
RANKS = [(1, "Bronze"), (8, "Silver"), (16, "Gold"), (26, "Platinum"), (40, "Diamond"), (60, "Master")]

BADGE_NAMES = {
    "first-steps": "First Steps", "disciplined": "Disciplined", "bookworm": "Bookworm",
    "flawless-week": "Flawless Week", "on-fire": "On Fire", "iron-body": "Iron Body",
    "scholar": "Scholar", "centurion": "Centurion", "polymath": "Polymath",
    "maker": "Maker", "relentless": "Relentless", "ascendant": "Ascendant",
}


def load_config():
    config = DEFAULT_CONFIG.copy()
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            config.update(json.load(f))
    return config


# ---------------------------------------------------------------------------
# The quest model (mirrors public/modules.js questCheckId / questOccurrenceRows)
# ---------------------------------------------------------------------------
# Hermes used to read settings["dayTemplates"] and rebuild `day-{i}-{slug}` ids.
# The v4 migration moved every task into settings["quests"] and left the
# templates empty, so this agent has been reporting an empty board and 0 XP for
# any current install. Only two things are mirrored now — how a check id is
# spelled and which days a quest lands on — and the category rides *inside* the
# id, so awarding XP needs no second copy of the economy's routing rules.

def quest_check_id(quest, day_index=None) -> str:
    cat = quest.get("category") or CAT_OF_ATTR.get(quest.get("attr")) or "discipline"
    base = f"quest-{cat}-{quest.get('id')}"
    if quest.get("scheduleType") != "weekly" or day_index is None:
        return base
    return f"{base}-d{day_index}"


def quest_occurrences(settings, week_start):
    """Every (quest, date, check_id) this week, exactly as the app counts them."""
    rows = []
    for q in settings.get("quests") or []:
        if not q or q.get("archived"):
            continue
        if q.get("scheduleType") == "weekly":
            for di in sorted(q.get("repeatDays") or []):
                rows.append((q, week_start + datetime.timedelta(days=di), quest_check_id(q, di)))
        else:
            raw = q.get("scheduledDate")
            if not raw:
                continue
            try:
                d = datetime.date.fromisoformat(raw)
            except ValueError:
                continue
            if get_week_start(d) == week_start:
                rows.append((q, d, quest_check_id(q, get_day_index(d))))
    return rows


def quests_on(settings, date):
    return [r for r in quest_occurrences(settings, get_week_start(date)) if r[1] == date]


def get_week_start(date):
    return date - datetime.timedelta(days=(date.weekday() + 1) % 7)


def get_day_index(date):
    return (date.weekday() + 1) % 7


def iso(date):
    return date.strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Level curve / ranks (mirror game.js)
# ---------------------------------------------------------------------------

def xp_for_level(level: int, base: int) -> int:
    return round(base * (1.18 ** (level - 1)))


def level_from_xp(total_xp: float, base: int) -> dict:
    level, acc = 1, 0
    while level < 999:
        need = xp_for_level(level, base)
        if acc + need > total_xp:
            break
        acc += need
        level += 1
    return {"level": level, "into": max(0, int(total_xp - acc)), "next": xp_for_level(level, base)}


def rank_for(level: int) -> dict:
    name, idx = RANKS[0][1], 0
    for i, (mn, nm) in enumerate(RANKS):
        if level >= mn:
            name, idx = nm, i
    nxt = RANKS[idx + 1][0] if idx + 1 < len(RANKS) else None
    span = (nxt - RANKS[idx][0]) if nxt else 24
    tier_num = min(3, 1 + int(((level - RANKS[idx][0]) / span) * 3)) if span else 1
    return {"name": name, "tier": ["I", "II", "III"][tier_num - 1]}


# ---------------------------------------------------------------------------
# Database access
# ---------------------------------------------------------------------------

def load_db(config: dict):
    db_path = config["database_path"]
    if not os.path.exists(db_path):
        print(f"[ERROR] Database not found: {db_path}", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT week_key, data FROM weeks")
    weeks = {k: json.loads(d) for k, d in cur.fetchall()}
    cur.execute("SELECT value FROM settings WHERE key = 'app_settings'")
    row = cur.fetchone()
    settings = json.loads(row[0]) if row else {}
    conn.close()
    return weeks, settings


# ---------------------------------------------------------------------------
# XP engine (mirror of public/modules.js weekXp / weekScore, quest branch)
# ---------------------------------------------------------------------------

def add_week_xp(week, settings, attr_totals):
    """Completed quests + logged hours, exactly as the engine awards them."""
    if not week:
        return 0
    checks = week.get("checks", {})
    fields = week.get("fields", {})
    xp = 0

    def award(cat, amount):
        nonlocal xp
        xp += amount
        attr = ATTR_OF_CAT.get(cat)
        if attr is not None:
            attr_totals[attr] = attr_totals.get(attr, 0) + amount

    # A quest's check id carries its category — `quest-training-q-abc123-d3` —
    # so the id alone says which stat the XP feeds. No second routing table.
    for cid, on in checks.items():
        if not on or not str(cid).startswith("quest-"):
            continue
        m = re.match(r"^quest-([a-z]+)-", str(cid))
        cat = m.group(1) if m else "discipline"
        award(cat, XP_BY_CAT.get(cat, XP_BY_CAT["other"]))

    study_hours = sum(float(v or 0) for k, v in fields.items() if str(k).startswith("hours-study-"))
    if study_hours > 0:
        award("study", round(study_hours * STUDY_HOUR_XP))
    proj_hours = float(fields.get("projectHours") or 0)
    if proj_hours > 0:
        award("project", round(proj_hours * PROJECT_HOUR_XP))
    return xp


def calculate_week_score(week, settings, week_start=None) -> int:
    """Completion % over the week's scheduled quest occurrences."""
    rows = quest_occurrences(settings, week_start or get_week_start(datetime.date.today()))
    if not rows:
        return 0
    checks = (week or {}).get("checks", {})
    done = sum(1 for _, _, cid in rows if checks.get(cid))
    return round(done / len(rows) * 100)


def week_start_of_key(key):
    try:
        return datetime.date.fromisoformat(key)
    except (TypeError, ValueError):
        return None


def compute_streak(weeks, settings) -> int:
    grade = settings.get("streakGrade") or 75
    wk = get_week_start(datetime.date.today())
    streak = 0
    cur = weeks.get(iso(wk))
    if cur and calculate_week_score(cur, settings, wk) >= grade:
        streak += 1
    wk -= datetime.timedelta(days=7)
    while True:
        data = weeks.get(iso(wk))
        if data and calculate_week_score(data, settings, wk) >= grade:
            streak += 1
            wk -= datetime.timedelta(days=7)
        else:
            break
    return streak


BOSSES = [
    ("Inertia", "\U0001FAA8", "training", "You won't even start."),
    ("The Procrastinator", "\U0001F9A5", "discipline", "Tomorrow, right?"),
    ("Brain Fog", "\U0001F32B\uFE0F", "study", "Why study? You'll just forget it."),
    ("The Glutton", "\U0001F354", "protein", "One more cheat day won't hurt\u2026"),
    ("The Drifter", "\U0001F300", "project", "Busywork feels like progress."),
    ("Lord Snooze", "\U0001F634", "discipline", "Five more minutes. Every morning."),
    ("Doomscroll Hydra", "\U0001F40D", "study", "Just one more scroll\u2026"),
    ("The Couch Wraith", "\U0001F47B", "training", "Skip the workout. Stay cozy."),
]
BOSS_ATTR = {"discipline": "Discipline", "training": "Body", "study": "Mind", "protein": "Vitality", "project": "Craft"}


def resolve_boss(settings, week_key):
    """Mirror of Forge.resolveBoss — a stored pick wins, then a banked win,
    then the date hash. Without this the agent announced a different monster
    from the one on the board, because the app started choosing adaptively."""
    by_name = {b[0]: b for b in BOSSES}
    pick = (settings.get("bossPick") or {}).get(week_key)
    if pick:
        name = pick if isinstance(pick, str) else pick.get("n")
        if name in by_name:
            return by_name[name]
    won = (settings.get("bossDefeated") or {}).get(week_key)
    if won in by_name:
        return by_name[won]
    h = 0
    for ch in week_key:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return BOSSES[h % len(BOSSES)]


def compute_boss(weeks, settings):
    """Mirror of Forge.bossDamage — quest occurrences, weak category at 2x."""
    week_start = get_week_start(datetime.date.today())
    wk_key = iso(week_start)
    name, emoji, weak, taunt = resolve_boss(settings, wk_key)
    checks = (weeks.get(wk_key, {}) or {}).get("checks", {})
    weak_tot = weak_done = other_tot = other_done = 0
    for q, _date, cid in quest_occurrences(settings, week_start):
        cat = q.get("category") or CAT_OF_ATTR.get(q.get("attr")) or "discipline"
        on = bool(checks.get(cid))
        if cat == weak:
            weak_tot += 1
            weak_done += 1 if on else 0
        else:
            other_tot += 1
            other_done += 1 if on else 0
    tot = weak_tot * 2 + other_tot
    dmg = round((weak_done * 2 + other_done) / tot * 100) if tot else 0
    grade = settings.get("streakGrade") or 75
    return {"name": name, "emoji": emoji, "weak": BOSS_ATTR.get(weak, weak),
            "taunt": taunt, "dmg": dmg, "grade": grade, "defeated": dmg >= grade,
            "weak_left": weak_tot - weak_done,
            "weak_left_worth": round((weak_tot - weak_done) * 2 / tot * 100) if tot else 0}


def compute_profile(weeks, settings) -> dict:
    base = settings.get("gameBase") or 100
    attr_totals = {a: 0 for a in ATTR_ORDER}
    lifetime = 0
    study_total = 0.0
    best_week = 0
    for key, wk in weeks.items():
        lifetime += add_week_xp(wk, settings, attr_totals)
        if wk and wk.get("fields"):
            study_total += sum(float(v or 0) for k, v in wk["fields"].items() if str(k).startswith("hours-study-"))
        # Score each week against ITS OWN schedule — one-off quests belong to
        # the week they were scheduled in, so scoring every week against this
        # week's board would misreport all of them.
        ws = week_start_of_key(key)
        if ws:
            best_week = max(best_week, calculate_week_score(wk, settings, ws))
    lv = level_from_xp(lifetime, base)
    attrs = {a: level_from_xp(attr_totals[a], base)["level"] for a in ATTR_ORDER}
    return {
        "lifetime": lifetime, "level": lv["level"], "into": lv["into"], "next": lv["next"],
        "rank": rank_for(lv["level"]), "attrs": attrs,
        "streak": compute_streak(weeks, settings),
        "best_week": best_week, "study_hours": round(study_total),
        "callsign": settings.get("callsign") or "Operator",
        "badges": list((settings.get("badges") or {}).keys()),
    }


# ---------------------------------------------------------------------------
# Today's quest evaluation
# ---------------------------------------------------------------------------

def evaluate_today(weeks, settings) -> dict:
    today = datetime.date.today()
    day = DAY_NAMES[get_day_index(today)]
    week = weeks.get(iso(get_week_start(today)), {})
    checks = week.get("checks", {})
    completed, incomplete = [], []
    for q, _date, cid in quests_on(settings, today):
        title = q.get("title") or "Untitled quest"
        (completed if checks.get(cid) else incomplete).append(title)
    total = len(completed) + len(incomplete)
    done = len(completed)
    return {
        "day_name": day, "total": total, "done": done,
        "pct": round(done / total * 100) if total else 0,
        "completed": completed, "incomplete": incomplete,
    }


# ---------------------------------------------------------------------------
# State (milestone detection across runs)
# ---------------------------------------------------------------------------

def load_state():
    if os.path.exists(STATE_PATH):
        try:
            with open(STATE_PATH) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_state(state):
    try:
        with open(STATE_PATH, "w") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        print(f"[Hermes] Could not write state: {e}", file=sys.stderr)


def detect_milestones(profile, state):
    first = not state
    leveled_up = (not first) and profile["level"] > state.get("level", profile["level"])
    new_badges = [b for b in profile["badges"] if b not in state.get("badges", profile["badges"] if first else [])]
    if first:
        new_badges = []  # silent backfill
    streak_milestone = None
    if (not first) and profile["streak"] > state.get("streak", 0) and profile["streak"] in (2, 4, 8, 12, 26, 52):
        streak_milestone = profile["streak"]
    return {"leveled_up": leveled_up, "new_badges": new_badges, "streak_milestone": streak_milestone}


# ---------------------------------------------------------------------------
# Run mode (morning quest board / evening recap / midday nudge)
# ---------------------------------------------------------------------------

def run_mode(hour, state):
    today = datetime.date.today().isoformat()
    if hour < 10 and state.get("morning_date") != today:
        return "morning"
    if hour >= 20 and state.get("evening_date") != today:
        return "evening"
    return "midday"


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

PERSONAS = {
    "game_master": """\
You are the Game Master narrating the operator's real life as an epic solo RPG. \
You are dramatic, vivid and motivating, but you genuinely want the hero to win. \
Rules:
- Under 170 words. Plain text only, no markdown, at most one emoji.
- Address the hero by callsign. Frame tasks as quests and progress as XP/levels.
- If there is a milestone (level up, new badge, streak), open by celebrating it.
- If completion is high (>75%), hype the final push to 100%. If low (<50%), \
rally them urgently without shaming.
- End with one clear next quest objective.
- Only reference numbers, tasks and stats that appear in the briefing below. Never invent quantities.""",
    "ruthless_sergeant": """\
You are a ruthless military sergeant keeping a recruit accountable for his daily \
discipline checklist. You do NOT accept excuses; firm, direct, relentless — but \
you care about his success.
Rules:
- Under 170 words. Plain text only, no markdown, no emojis.
- Address him as "soldier" or "recruit". Reference specific incomplete tasks.
- High completion (>75%): acknowledge, push to 100%. Low (<50%): harsh + motivational.
- End with one clear, actionable order.""",
    "hype_coach": """\
You are a high-energy hype coach who believes in the operator completely. \
Warm, electric, relentlessly positive, but specific and honest.
Rules:
- Under 170 words. Plain text only, no markdown, at most one emoji.
- Use the callsign. Celebrate any milestone first. Name specific remaining tasks.
- End with one punchy call to action.""",
}


def build_prompt(config, profile, status, milestones, mode, hour, boss):
    persona = config.get("persona", "game_master")
    system = PERSONAS.get(persona, PERSONAS["game_master"])

    mile = []
    if milestones["leveled_up"]:
        mile.append(f"LEVELED UP to Level {profile['level']} ({profile['rank']['name']} {profile['rank']['tier']}).")
    for b in milestones["new_badges"]:
        mile.append(f"Unlocked badge: {BADGE_NAMES.get(b, b)}.")
    if milestones["streak_milestone"]:
        mile.append(f"Hit a {milestones['streak_milestone']}-week streak.")

    mode_ctx = {
        "morning": "It is morning. Present today's QUEST BOARD and set the tone for the day.",
        "evening": "It is evening. Give a RECAP of today and a directive for tomorrow.",
        "midday": "Mid-day check-in. Push execution on what's left.",
    }[mode]

    completed = "\n".join(f"- {t}" for t in status["completed"]) or "None yet."
    incomplete = "\n".join(f"- {t}" for t in status["incomplete"]) or "None — all clear."
    attrs = ", ".join(f"{a} Lv{profile['attrs'][a]}" for a in ATTR_ORDER)

    user = f"""\
OPERATOR: {profile['callsign']}
LEVEL: {profile['level']} ({profile['rank']['name']} {profile['rank']['tier']}) — {profile['into']}/{profile['next']} XP to next
STREAK: {profile['streak']} weeks | ATTRIBUTES: {attrs}
DAY: {status['day_name']} | TODAY: {status['done']}/{status['total']} quests ({status['pct']}%)
CONTEXT: {mode_ctx}
WEEKLY BOSS: {boss['name']} — {'DEFEATED' if boss['defeated'] else str(boss['dmg']) + '% damage dealt, still alive'}; weak to {boss['weak']}. Taunt: "{boss['taunt']}"
MILESTONES: {' '.join(mile) if mile else 'none'}

COMPLETED TODAY:
{completed}

OUTSTANDING QUESTS:
{incomplete}

Write the message now."""
    return system, user


# ---------------------------------------------------------------------------
# Ollama
# ---------------------------------------------------------------------------

def call_ollama(config, system_prompt, user_prompt, verbose=False):
    url = f"{config['ollama_url']}/api/chat"
    payload = {
        "model": config["ollama_model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
        "keep_alive": config.get("ollama_keep_alive", 0),
        "options": {
            "temperature": config.get("ollama_temperature", 0.8),
            "num_predict": config.get("ollama_num_predict", 400),
            "num_ctx": config.get("ollama_num_ctx", 1024),
        },
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            raw = result.get("message", {}).get("content", "")
            cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
            if verbose:
                print(f"[Ollama] model={config['ollama_model']} keep_alive={payload['keep_alive']} "
                      f"raw={len(raw)} cleaned={len(cleaned)} chars")
            return cleaned or None
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        if verbose:
            print(f"[Ollama] Connection failed: {e}")
        return None


def fallback_message(profile, status, milestones, mode):
    pct = status["pct"]
    head = []
    if milestones["leveled_up"]:
        head.append(f"LEVEL UP — you're now Level {profile['level']} ({profile['rank']['name']}).")
    for b in milestones["new_badges"]:
        head.append(f"Badge unlocked: {BADGE_NAMES.get(b, b)}.")
    if mode == "morning":
        body = "A new day, a fresh quest board. Clear the board."
    elif mode == "evening":
        body = "Day's almost logged. Close out what you can."
    elif pct >= 75:
        body = "You've got momentum — finish the last quests and hit 100%."
    elif pct >= 50:
        body = "Halfway. Keep pushing the outstanding quests."
    else:
        body = "The board is wide open. Pick one quest and move."
    out = "\n".join(head)
    if out:
        out += "\n\n"
    out += body
    if status["incomplete"]:
        out += "\n\nOutstanding:\n" + "\n".join(f"  • {t}" for t in status["incomplete"][:8])
    out += "\n\n(Ollama offline — fallback)"
    return out


# ---------------------------------------------------------------------------
# Discord
# ---------------------------------------------------------------------------

def xp_bar(into, nxt, segments=10):
    filled = int(round((into / nxt) * segments)) if nxt else 0
    filled = max(0, min(segments, filled))
    return "▰" * filled + "▱" * (segments - filled)


def post_discord(config, profile, status, message, mode, milestones, boss, is_test=False):
    pct = status["pct"]
    color = 0x22C55E if pct >= 75 else 0xF59E0B if pct >= 50 else 0xEF4444
    r = profile["rank"]
    titles = {
        "morning": f"🗺️ Quest Board — {profile['callsign']}",
        "evening": f"🌙 Evening Recap — {profile['callsign']}",
        "midday": f"🎮 {profile['callsign']} — Lv {profile['level']} {r['name']}",
    }
    title = "🧪 Hermes — Test" if is_test else titles[mode]

    fields = [
        {"name": "⚔️ Level", "value": f"**Lv {profile['level']}** · {r['name']} {r['tier']}\n`{xp_bar(profile['into'], profile['next'])}` {profile['into']}/{profile['next']} XP", "inline": True},
        {"name": "🔥 Streak", "value": f"**{profile['streak']}** weeks", "inline": True},
        {"name": "📊 Today", "value": f"**{status['done']}/{status['total']}** ({pct}%)", "inline": True},
    ]
    mile = []
    if milestones["leveled_up"]:
        mile.append(f"⬆️ Reached **Level {profile['level']}**")
    for b in milestones["new_badges"]:
        mile.append(f"🏅 Badge: **{BADGE_NAMES.get(b, b)}**")
    if milestones["streak_milestone"]:
        mile.append(f"🔥 **{milestones['streak_milestone']}-week** streak")
    if mile:
        fields.append({"name": "🎉 Milestones", "value": "\n".join(mile), "inline": False})

    boss_val = (f"**{boss['emoji']} {boss['name']}** — DEFEATED ✓" if boss["defeated"]
                else f"**{boss['emoji']} {boss['name']}** — {boss['dmg']}% dealt · weak to {boss['weak']}")
    fields.append({"name": "⚔️ Weekly Boss", "value": boss_val, "inline": False})

    if status["incomplete"]:
        quests = "\n".join(f"▫️ {t}" for t in status["incomplete"][:10])
        fields.append({"name": f"🗒️ Outstanding ({len(status['incomplete'])})", "value": quests, "inline": False})
    if status["completed"]:
        doned = "\n".join(f"✅ {t}" for t in status["completed"][:10])
        fields.append({"name": f"✅ Cleared ({len(status['completed'])})", "value": doned, "inline": False})

    now = datetime.datetime.now()
    embed = {
        "title": title,
        "description": message[:2000],
        "color": color,
        "fields": fields,
        "footer": {"text": f"Hermes · {profile['callsign']} · {now.strftime('%I:%M %p')}"},
    }
    payload = {"embeds": [embed]}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        config["discord_webhook_url"], data=data,
        headers={"Content-Type": "application/json", "User-Agent": "Hermes/2.0"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        if resp.status not in (200, 204):
            raise Exception(f"Discord returned status {resp.status}")


# ---------------------------------------------------------------------------
# Weekly retrospective (--retro)
# ---------------------------------------------------------------------------

RETRO_SYSTEM = """\
You are the operator's Game Master, writing a short weekly RETROSPECTIVE of the \
week that just ended. Insightful, specific and motivating — never generic.
Rules:
- Under 190 words. Plain text only, no markdown, at most one emoji.
- Open with a one-line verdict on the week (use the score/grade).
- Call out 1-2 concrete wins and 1-2 friction patterns, using the data AND the \
operator's own notes.
- Close with ONE clear focus for the week ahead.
- Only use facts from the briefing; never invent numbers."""


def get_retro_week(weeks, settings):
    ref = datetime.date.today() - datetime.timedelta(days=1)   # yesterday → last week on Sunday
    start = get_week_start(ref)
    wk = weeks.get(iso(start), {"fields": {}, "checks": {}})
    attr = {a: 0 for a in ATTR_ORDER}
    xp = add_week_xp(wk, settings, attr)
    checks = wk.get("checks", {})
    by_day = {i: [] for i in range(7)}
    for _q, date, cid in quest_occurrences(settings, start):
        by_day[get_day_index(date)].append(bool(checks.get(cid)))
    days = []
    for i, name in enumerate(DAY_NAMES):
        marks = by_day[i]
        days.append((name, round(sum(marks) / len(marks) * 100) if marks else None))
    f = wk.get("fields", {})
    return {
        "start": start, "score": calculate_week_score(wk, settings, start), "xp": xp, "attr": attr,
        "days": days, "wins": f.get("wins", ""), "misses": f.get("misses", ""),
        "changes": f.get("changes", ""), "grade": f.get("grade", ""),
    }


def build_retro_prompt(profile, retro):
    top = [k for k, v in sorted(retro["attr"].items(), key=lambda kv: kv[1], reverse=True) if v > 0][:2]
    daily = " · ".join(f"{n[:3]} {p}%" for n, p in retro["days"] if p is not None)
    rng = f"{retro['start']:%b %d}–{retro['start'] + datetime.timedelta(days=6):%b %d}"
    user = f"""\
WEEKLY RETRO — week of {rng}
Operator: {profile['callsign']} · Level {profile['level']} ({profile['rank']['name']} {profile['rank']['tier']})
Weekly completion: {retro['score']}%  ·  Self-grade: {retro['grade'] or 'not graded'}
XP earned this week: {retro['xp']}
Strongest areas: {', '.join(top) if top else 'none logged'}
Day-by-day: {daily or 'no data'}
Operator's own notes —
  Wins: {retro['wins'] or 'none'}
  Friction: {retro['misses'] or 'none'}
  Planned changes: {retro['changes'] or 'none'}

Write the retrospective now."""
    return RETRO_SYSTEM, user


def retro_fallback(retro):
    s = retro["score"]
    verdict = ("A strong week — keep the pressure on." if s >= 85 else
               "Solid week. Tighten the gaps." if s >= 60 else
               "Tough week. Protect the basics first and reset.")
    return f"{verdict}\n\nWeekly completion: {s}%. XP earned: {retro['xp']}.\n\n(Ollama offline — fallback)"


def post_retro_discord(config, profile, retro, message):
    s = retro["score"]
    color = 0x22C55E if s >= 75 else 0xF59E0B if s >= 50 else 0xEF4444
    rng = f"{retro['start']:%b %d}–{retro['start'] + datetime.timedelta(days=6):%b %d}"
    fields = [
        {"name": "📊 Completion", "value": f"**{s}%**", "inline": True},
        {"name": "✨ XP earned", "value": f"**{retro['xp']}**", "inline": True},
        {"name": "🎓 Grade", "value": retro["grade"] or "—", "inline": True},
    ]
    dd = " · ".join(f"{n[:1]} {p}%" for n, p in retro["days"] if p is not None)
    if dd:
        fields.append({"name": "🗓️ Day-by-day", "value": dd, "inline": False})
    embed = {
        "title": f"📜 Week in Review — {rng}",
        "description": message[:2000],
        "color": color, "fields": fields,
        "footer": {"text": f"Hermes · {profile['callsign']} · weekly retro"},
    }
    data = json.dumps({"embeds": [embed]}).encode("utf-8")
    req = urllib.request.Request(config["discord_webhook_url"], data=data,
        headers={"Content-Type": "application/json", "User-Agent": "Hermes/2.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        if resp.status not in (200, 204):
            raise Exception(f"Discord returned status {resp.status}")


def run_retro(config, weeks, settings, profile, dry_run, verbose):
    retro = get_retro_week(weeks, settings)
    system, user = build_retro_prompt(profile, retro)
    if verbose:
        print(f"\n[Retro Prompt]\n{user}\n")
    msg = call_ollama(config, system, user, verbose=verbose) or retro_fallback(retro)
    if dry_run:
        print(f"\n{'=' * 60}\nWEEKLY RETRO (week of {retro['start']:%b %d}) — {retro['score']}% · {retro['xp']} XP\n{'=' * 60}\n{msg}\n")
        return
    post_retro_discord(config, profile, retro, msg)
    print(f"[Hermes] weekly retro sent (week of {retro['start']:%Y-%m-%d}, {retro['score']}%)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Hermes — The Forge Game Master & Discord Agent")
    parser.add_argument("--dry-run", action="store_true", help="Print, don't send Discord or write state")
    parser.add_argument("--test", action="store_true", help="Send a test embed to Discord")
    parser.add_argument("--retro", action="store_true", help="Post the weekly retrospective for the week just ended")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    config = load_config()
    if not config.get("discord_webhook_url") and not args.dry_run:
        print("[ERROR] discord_webhook_url not set in config.json", file=sys.stderr)
        sys.exit(1)

    now = datetime.datetime.now()
    hour = now.hour

    weeks, settings = load_db(config)
    profile = compute_profile(weeks, settings)

    if args.retro:
        run_retro(config, weeks, settings, profile, args.dry_run, args.verbose)
        sys.exit(0)

    status = evaluate_today(weeks, settings)
    boss = compute_boss(weeks, settings)
    state = load_state()
    milestones = detect_milestones(profile, state)
    mode = run_mode(hour, state)

    has_milestone = milestones["leveled_up"] or milestones["new_badges"] or milestones["streak_milestone"]

    if args.verbose:
        print(f"[Hermes] {profile['callsign']} Lv{profile['level']} {profile['rank']['name']} "
              f"{profile['rank']['tier']} | streak {profile['streak']} | today {status['done']}/{status['total']}")
        print(f"[Hermes] mode={mode} milestones={milestones} badges={len(profile['badges'])}")

    # Quiet hours (still allow milestone celebrations through)
    if not args.dry_run and not args.test and not has_milestone:
        if hour >= config.get("quiet_hours_start", 22) or hour < config.get("quiet_hours_end", 8):
            if args.verbose:
                print("[Hermes] Quiet hours. Skipping.")
            sys.exit(0)

    # Silent if everything done (midday only; always send morning/evening/milestones)
    if (config.get("silent_if_complete", True) and mode == "midday" and not has_milestone
            and status["total"] > 0 and status["done"] == status["total"]):
        if args.verbose or args.dry_run:
            print("[Hermes] All quests cleared, midday, no milestone — silent.")
        if not args.dry_run:
            sys.exit(0)

    if status["total"] == 0 and mode == "midday" and not has_milestone:
        if args.verbose or args.dry_run:
            print("[Hermes] No quests today. Skipping.")
        if not args.dry_run:
            sys.exit(0)

    system_prompt, user_prompt = build_prompt(config, profile, status, milestones, mode, hour, boss)
    if args.verbose:
        print(f"\n[Prompt]\n{user_prompt}\n")

    message = call_ollama(config, system_prompt, user_prompt, verbose=args.verbose)
    if message is None:
        message = fallback_message(profile, status, milestones, mode)

    if args.dry_run:
        print(f"\n{'=' * 60}\nHERMES DRY RUN — {mode.upper()} — {now.strftime('%a %I:%M %p')}\n{'=' * 60}")
        print(f"{profile['callsign']} · Lv {profile['level']} {profile['rank']['name']} {profile['rank']['tier']} · "
              f"streak {profile['streak']} · today {status['done']}/{status['total']} ({status['pct']}%)")
        print(f"\n--- Message ---\n{message}\n")
        sys.exit(0)

    try:
        post_discord(config, profile, status, message, mode, milestones, boss, is_test=args.test)
        print(f"[Hermes] {now.strftime('%Y-%m-%d %H:%M')} — sent ({mode}, {status['pct']}% complete)")
    except Exception as e:
        print(f"[Hermes] ERROR sending Discord: {e}", file=sys.stderr)
        sys.exit(1)

    # Persist state
    if not args.test:
        state["level"] = profile["level"]
        state["streak"] = profile["streak"]
        state["badges"] = profile["badges"]
        if mode == "morning":
            state["morning_date"] = datetime.date.today().isoformat()
        if mode == "evening":
            state["evening_date"] = datetime.date.today().isoformat()
        save_state(state)


if __name__ == "__main__":
    main()
