# Сборщик для панели «Пульт сессий»: читает логи всех сессий Claude Code
# (~/.claude/projects/**/*.jsonl) инкрементально и печатает сводку в JSON.
# Аргументы: [начало 5-часового окна ISO] [процент 5-часового окна] [id этой сессии]
# [процент недельного окна] [сброс недельного окна ISO]
import ctypes
import ctypes.wintypes
import datetime as dt
import glob
import json
import os
import re
import sys
import time

ROOT = os.path.join(os.path.expanduser("~"), ".claude", "projects")
CACHE = os.path.join(os.path.expanduser("~"), ".claude", "cache", "session-pult.json")
# Где приложение Claude хранит свои сессии: зависит от способа установки
LOCAL = os.environ.get("LOCALAPPDATA", "")
APP_DIRS = (
    os.path.join(LOCAL, "Claude-Data", "*", "claude-code-sessions"),
    os.path.join(LOCAL, "Packages", "Claude_*", "LocalCache", "Roaming", "Claude", "claude-code-sessions"),
    os.path.join(os.environ.get("APPDATA", ""), "Claude", "claude-code-sessions"),
)
APP_ID = re.compile(r"local_[0-9a-f-]{36}")
CACHE_VERSION = 3
DAY = 86400
# Веса по цене относительно входного токена: запись кэша 5 мин и 1 час, чтение кэша, ответ
W_IN, W_CW5, W_CW1, W_CR, W_OUT = 1.0, 1.25, 2.0, 0.1, 5.0
MODEL_K = {"opus": 1.0, "sonnet": 0.6, "haiku": 0.2}
DEFAULT_CAL = 255_000  # ед. на 1% пятичасового лимита, замер 29.10.2026
RUNNING_SEC = 120
COLD_MIN = 60
COOLING_MIN = 40  # с этого простоя пульт показывает, сколько будет стоить опоздание
URGENT_MIN = 15  # за столько минут до остывания сессия поднимается в начало списка
BIG_CTX = 100_000
NOTE_LEN = 140
WEEK = 7 * DAY
WEEK_STEP = 1800  # точка истории недельного лимита раз в полчаса


def model_k(model):
    for name, k in MODEL_K.items():
        if name in (model or ""):
            return k
    return 1.0


def ts_epoch(ts):
    try:
        return dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def load_cache():
    try:
        with open(CACHE, encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("v") == CACHE_VERSION:
            return data
    except Exception:
        pass
    return {"v": CACHE_VERSION, "files": {}, "cal": None}


def save_cache(data):
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, CACHE)


def app_in_front():
    """Активно ли окно Claude. Пока оно в фоне, баннер о конце хода показывает само приложение."""
    try:
        user, kernel = ctypes.windll.user32, ctypes.windll.kernel32
    except AttributeError:
        return False
    w = ctypes.wintypes
    user.GetForegroundWindow.restype = w.HWND
    user.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
    kernel.OpenProcess.restype = w.HANDLE
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    pid = w.DWORD()
    user.GetWindowThreadProcessId(user.GetForegroundWindow(), ctypes.byref(pid))
    proc = kernel.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not proc:
        return False
    name = ctypes.create_unicode_buffer(1024)
    size = w.DWORD(1024)
    ok = kernel.QueryFullProcessImageNameW(proc, 0, name, ctypes.byref(size))
    kernel.CloseHandle(proc)
    return bool(ok) and os.path.basename(name.value).lower() == "claude.exe"


def week_forecast(cache, pct, reset, now):
    """История недельного окна и прогноз: темп за последние сутки, а пока их нет, средний с начала окна."""
    hist = cache.get("week") or {}
    if abs(hist.get("reset", 0) - reset) > 3600:
        hist = {"reset": reset, "points": []}
    points = hist["points"]
    if not points or now - points[-1][0] >= WEEK_STEP:
        points.append([round(now), pct])
    cache["week"] = hist
    start = reset - WEEK
    day_ago = [p for p in points if p[0] <= now - DAY * 0.8]
    base = day_ago[-1] if day_ago else [start, 0]
    span = now - base[0]
    per_sec = (pct - base[1]) / span if span >= 6 * 3600 else None
    hit = now + (100 - pct) / per_sec if per_sec and per_sec > 0 and pct < 100 else None
    return {
        "start": round(start * 1000),
        "reset": round(reset * 1000),
        "points": [[p[0] * 1000, p[1]] for p in points],
        "perDay": round(per_sec * DAY, 1) if per_sec is not None else None,
        "hitAt": round(hit * 1000) if hit and hit < reset else None,
        "endPct": round(pct + per_sec * (reset - now)) if per_sec is not None else None,
    }


def app_sessions():
    """Сессии приложения по id лога: ссылка, название из боковой панели, архив и что нужно от человека."""
    found = {}
    for base in APP_DIRS:
        for path in glob.iglob(os.path.join(base, "*", "*", "local_*.json")):
            try:
                with open(path, encoding="utf-8") as fh:
                    d = json.load(fh)
            except (OSError, ValueError):
                continue
            cli, sid = d.get("cliSessionId"), d.get("sessionId") or ""
            if cli and APP_ID.fullmatch(sid):
                # Вопрос к человеку верен только для последнего ответа сессии
                summary = (d.get("postTurnSummary") or {}) if d.get("postTurnSummaryFor") == d.get("lastAssistantUuid") else {}
                need = (summary.get("needs_action") or "").strip()
                wrap = ((d.get("turnWrapUp") or {}).get("description") or "").strip()
                note = need or wrap
                found[cli] = {
                    "id": sid,
                    "link": f"claude://claude.ai/epitaxy/{sid}",
                    "title": d.get("title"),
                    "archived": bool(d.get("isArchived")),
                    "focus": d.get("lastFocusedAt") or 0,
                    "needs": bool(need),
                    "note": note[: NOTE_LEN - 1] + "…" if len(note) > NOTE_LEN else note,
                }
    return found


def describe(path):
    rel = os.path.relpath(path, ROOT).split(os.sep)
    session = os.path.splitext(rel[1])[0] if len(rel) == 2 else rel[1]
    return session, "main" if len(rel) == 2 else "sub"


def read_new(path, st, since):
    size = os.path.getsize(path)
    if size < st["off"]:
        st.update(off=0, ev=[], ids=[])
    if size == st["off"]:
        return
    with open(path, "rb") as fh:
        fh.seek(st["off"])
        chunk = fh.read()
    end = chunk.rfind(b"\n")
    if end < 0:
        return
    st["off"] += end + 1
    ids = set(st["ids"])
    for raw in chunk[: end + 1].splitlines():
        try:
            d = json.loads(raw)
        except Exception:
            continue
        kind = d.get("type")
        if kind == "ai-title":
            st["title"] = d.get("aiTitle") or st.get("title")
        elif kind == "custom-title":
            st["ctitle"] = d.get("customTitle") or st.get("ctitle")
        if d.get("cwd"):
            st["cwd"] = d["cwd"]
        if kind not in ("user", "assistant") or d.get("isMeta"):
            continue
        ts = ts_epoch(d.get("timestamp", ""))
        msg = d.get("message") or {}
        if kind == "user":
            content = msg.get("content")
            is_result = isinstance(content, list) and any(
                isinstance(c, dict) and c.get("type") == "tool_result" for c in content
            )
            st["last"] = {"role": "user", "ts": ts, "result": is_result}
            continue
        text = json.dumps(msg.get("content", ""), ensure_ascii=False)
        st["last"] = {
            "role": "assistant",
            "ts": ts,
            "stop": msg.get("stop_reason"),
            "limit": "hit your" in text and "limit" in text,
        }
        usage = msg.get("usage")
        if not usage or msg.get("model") == "<synthetic>":
            continue
        key = f'{msg.get("id")}|{d.get("requestId")}'
        if key in ids:
            continue
        ids.add(key)
        cc = usage.get("cache_creation") or {}
        cw5 = cc.get("ephemeral_5m_input_tokens")
        cw1 = cc.get("ephemeral_1h_input_tokens")
        if cw5 is None and cw1 is None:
            cw5, cw1 = usage.get("cache_creation_input_tokens", 0), 0
        inp, cr, out = usage.get("input_tokens", 0), usage.get("cache_read_input_tokens", 0), usage.get("output_tokens", 0)
        ctx = inp + (cw5 or 0) + (cw1 or 0) + cr
        st["ctx"] = ctx
        if ts < since:
            continue
        units = (inp * W_IN + (cw5 or 0) * W_CW5 + (cw1 or 0) * W_CW1 + cr * W_CR + out * W_OUT) * model_k(msg.get("model"))
        st["ev"].append([round(ts), round(units), ctx + out, out, (msg.get("model") or "?").replace("claude-", ""), key])
    st["ids"] = list(ids)[-400:]


def main():
    now = time.time()
    win_start = ts_epoch(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else 0
    win_pct = float(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None
    self_id = sys.argv[3] if len(sys.argv) > 3 else ""
    week_pct = float(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else None
    week_reset = ts_epoch(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else 0
    midnight = dt.datetime.combine(dt.date.today(), dt.time()).timestamp()
    keep_from = min(midnight, win_start or midnight, now - 6 * 3600)

    cache = load_cache()
    files = cache["files"]
    seen_paths = set()
    for dirpath, _, names in os.walk(ROOT):
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(dirpath, name)
            mtime = os.path.getmtime(path)
            if mtime < now - DAY:
                continue
            seen_paths.add(path)
            st = files.setdefault(path, {"off": 0, "ev": [], "ids": [], "born": os.path.getctime(path)})
            st["mtime"] = mtime
            try:
                read_new(path, st, keep_from)
            except OSError:
                continue
            st["ev"] = [e for e in st["ev"] if e[0] >= keep_from]
    for path in list(files):
        if path not in seen_paths:
            del files[path]

    sessions = {}
    today = {"units": 0, "tokens": 0, "out": 0, "models": {}}
    since_win = last30 = 0
    hours = [0] * 24
    win_buckets = [0] * 30  # окно 5 часов по 10 минут
    # Возобновлённая сессия копирует историю в новый файл: ответ считаем один раз,
    # за тем файлом, что создан раньше
    counted = set()
    for path, st in sorted(files.items(), key=lambda kv: kv[1].get("born", 0)):
        sid, kind = describe(path)
        s = sessions.setdefault(sid, {"id": sid, "agents": 0, "units": 0, "mtime": 0})
        s["mtime"] = max(s["mtime"], st["mtime"])
        if kind == "main":
            s["title"] = st.get("ctitle") or st.get("title")
            s["cwd"] = st.get("cwd")
            s["ctx"] = st.get("ctx", 0)
            s["last"] = st.get("last")
        elif now - st["mtime"] < RUNNING_SEC:
            s["agents"] += 1
        for ts, units, tokens, out, model, key in st["ev"]:
            if key in counted:
                continue
            counted.add(key)
            if ts >= midnight:
                today["units"] += units
                today["tokens"] += tokens
                today["out"] += out
                today["models"][model] = today["models"].get(model, 0) + units
                s["units"] += units
                hours[dt.datetime.fromtimestamp(ts).hour] += units
            if win_start and ts >= win_start:
                since_win += units
                win_buckets[min(29, int((ts - win_start) // 600))] += units
            if ts >= now - 1800:
                last30 += units

    cal = cache.get("cal") or DEFAULT_CAL
    if win_pct and win_pct >= 5 and since_win > 0:
        cal = since_win / win_pct
        cache["cal"] = cal
    week = week_forecast(cache, week_pct, week_reset, now) if week_pct is not None and week_reset else None
    save_cache(cache)

    # Те же копии истории дают две строки одной сессии: склеиваем по названию и папке
    apps = app_sessions()
    # На экране та сессия, в которую заходили последней: о ней уведомлять незачем
    on_screen = max(apps.values(), key=lambda a: a["focus"], default={}).get("id")
    merged = {}
    for s in sorted(sessions.values(), key=lambda s: s["mtime"]):
        if "last" not in s or not s.get("cwd"):
            continue
        s["app"] = apps.get(s["id"])
        key = (s.get("title"), s["cwd"])
        if key in merged:
            s["units"] += merged[key]["units"]
            s["agents"] += merged[key]["agents"]
            s["app"] = s["app"] or merged[key]["app"]
        merged[key] = s

    rows = []
    archived = set()
    for s in merged.values():
        idle = (now - s["mtime"]) / 60
        last = s["last"] or {}
        if idle * 60 < RUNNING_SEC or s["agents"]:
            status = "running"
        elif last.get("limit"):
            status = "limit"
        elif last.get("role") == "assistant" and last.get("stop") != "tool_use":
            status = "waiting"
        else:
            status = "stopped"
        if s["mtime"] < midnight and status != "running":
            continue
        ctx = s.get("ctx", 0)
        app = s["app"] or {}
        if app.get("archived"):
            archived.add(s["id"][:8])
        big = ctx >= BIG_CTX
        done_at = round((last.get("ts") or s["mtime"]) * 1000)
        rows.append({
            "id": s["id"][:8],
            "title": app.get("title") or s.get("title") or os.path.basename(s["cwd"]),
            "project": os.path.basename(s["cwd"].rstrip("\\/")),
            "link": app.get("link"),
            "note": (app.get("note") or None) if status in ("waiting", "limit") else None,
            "needs": status == "waiting" and bool(app.get("needs")),
            "doneAt": done_at,
            "seen": app.get("focus", 0) >= done_at or app.get("id") == on_screen,
            "status": status,
            "idleMin": round(idle),
            "ctx": ctx,
            "agents": s["agents"],
            "units": s["units"],
            # Сколько процентов лимита съест следующий ответ, если кэш остынет или уже остыл
            "coldPct": round(ctx * W_CW1 / cal, 1) if idle >= COOLING_MIN and big else None,
            "coldInMin": max(1, round(COLD_MIN - idle)) if COOLING_MIN <= idle < COLD_MIN and big else None,
            "urgent": big and COLD_MIN - URGENT_MIN <= idle < COLD_MIN,
        })
    order = {"running": 0, "waiting": 1, "limit": 2, "stopped": 3}
    # Сначала те, что вот-вот остынут: ближайшая к остыванию первой
    rows.sort(key=lambda r: (0, -r["idleMin"]) if r["urgent"] else (1 + order[r["status"]], r["idleMin"]))

    # Последнее сообщение этой сессии: по нему пульт видит, остыл ли кэш после перерыва
    me = None
    for path, st in files.items():
        if self_id and os.path.basename(path) == self_id + ".jsonl":
            last_ts = (st.get("last") or {}).get("ts")
            me = {"id": self_id[:8], "lastTs": round(last_ts * 1000) if last_ts else None, "ctx": st.get("ctx", 0)}

    print(json.dumps({
        "at": round(now * 1000),
        "tzOffsetMin": round(dt.datetime.now().astimezone().utcoffset().total_seconds() / 60),
        "today": today,
        "todayPct": round(today["units"] / cal, 1),
        "sinceWindow": since_win,
        "rate30Pct": round(last30 / cal, 2),
        "hours": [round(u / cal, 1) for u in hours],
        "winStart": round(win_start * 1000) if win_start else None,
        "winBuckets": [round(u / cal, 2) for u in win_buckets] if win_start else [],
        "cal": round(cal),
        "agents": sum(r["agents"] for r in rows),
        "self": me,
        "week": week,
        "appInFront": app_in_front(),
        # Архивные не ждут ответа, но их расход остаётся в итогах и лидерах
        "sessions": [r for r in rows if r["id"] not in archived][:12],
        "top": sorted(
            ({"title": r["title"], "pct": round(r["units"] / cal, 1)} for r in rows if r["units"]),
            key=lambda r: -r["pct"],
        )[:3],
    }, ensure_ascii=True))


if __name__ == "__main__":
    main()
