# -*- coding: utf-8 -*-
"""Local ideation wall. One scene per card, shared with teammates on the same server."""

from __future__ import annotations

import atexit
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = Path(os.environ.get("ROOM_PATH") or (ROOT / "room.json"))
CATALOG_PATH = PUBLIC / "catalog.json"
PASSWORD_PATH = ROOT / "password.txt"
PUBLIC_URL_PATH = ROOT / "public-url.txt"
LOCK = threading.Lock()
FAIL_LOCK = threading.Lock()
FAILS: dict[str, list[float]] = {}
PALETTE = ["#9e2b22", "#1f6a45", "#2a6f97", "#c47b2b", "#6b3f69", "#0f6e6e", "#a33b5b", "#3d4f1f"]

PHASES = ["collect", "score", "story", "mute", "lock"]
NARRATIVE = ["who", "whenWhere", "incident", "behavior", "input", "output"]
DETAIL = ["setting", "situation", "value", "appeal", "aiFit"]
ONLINE_SECONDS = 30
FLUSH_SECONDS = 20
PRESENCE: dict[str, str] = {}
PRESENCE_FLUSH_AT = time.monotonic()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def catalog() -> dict:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def fresh() -> dict:
    return {
        "rev": 0,
        "phase": "collect",
        "facilitatorId": None,
        "people": [],
        "ideas": [],
        "votes": [],
        "comments": [],
        "mutes": [],
        "features": [],
        "ratings": [],
    }


class RoomCorrupt(Exception):
    pass


class AuthError(Exception):
    pass


def load() -> dict:
    if not DATA.exists():
        base = fresh()
        drop_ai_proposals(base)
        return base
    try:
        data = json.loads(DATA.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RoomCorrupt("房間資料讀不出來，已保留原檔。") from exc
    if not isinstance(data, dict):
        raise RoomCorrupt("房間資料讀不出來，已保留原檔。")
    base = fresh()
    base.update(data)
    if not isinstance(base.get("ratings"), list):
        base["ratings"] = []
    drop_ai_proposals(base)
    if link_ratings_to_votes(base):
        base["rev"] = int(base.get("rev") or 0) + 1
        save(base)
    return base


GITHUB_ED25519 = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"


def hosted() -> bool:
    return bool(os.environ.get("WALL_DATA_REPO", "").strip())


def deploy_key_text() -> str:
    raw = os.environ.get("WALL_DEPLOY_KEY", "")
    if not raw.strip():
        for candidate in (os.environ.get("WALL_DEPLOY_KEY_FILE", ""), "/etc/secrets/wall_deploy_key"):
            if candidate and Path(candidate).is_file():
                raw = Path(candidate).read_text(encoding="utf-8")
                break
    raw = raw.replace("\r\n", "\n").replace("\\n", "\n").strip()
    if not raw:
        return ""
    if not raw.endswith("\n"):
        raw += "\n"
    return raw


def git_env() -> dict[str, str]:
    env = os.environ.copy()
    env["GIT_AUTHOR_NAME"] = "aipets-wall"
    env["GIT_AUTHOR_EMAIL"] = "wall@localhost"
    env["GIT_COMMITTER_NAME"] = "aipets-wall"
    env["GIT_COMMITTER_EMAIL"] = "wall@localhost"
    env["GIT_TERMINAL_PROMPT"] = "0"
    key = deploy_key_text()
    repo = os.environ.get("WALL_DATA_REPO", "").strip()
    if key and repo.startswith("git@"):
        key_path = Path("/tmp/wall_deploy_key")
        known = Path("/tmp/github_known_hosts")
        config = Path("/tmp/wall_ssh_config")
        key_path.write_text(key, encoding="utf-8")
        key_path.chmod(0o600)
        known.write_text(
            f"ssh.github.com ssh-ed25519 {GITHUB_ED25519}\n"
            f"github.com ssh-ed25519 {GITHUB_ED25519}\n",
            encoding="utf-8",
        )
        config.write_text(
            "Host github.com\n"
            "  HostName ssh.github.com\n"
            "  Port 443\n"
            "  User git\n"
            f"  IdentityFile {key_path}\n"
            "  IdentitiesOnly yes\n"
            "  StrictHostKeyChecking yes\n"
            f"  UserKnownHostsFile {known}\n",
            encoding="utf-8",
        )
        env["GIT_SSH_COMMAND"] = f'ssh -F "{config}"'
    return env


def run_git(args: list[str], cwd: Path | None = None) -> None:
    result = subprocess.run(
        ["git", "-c", "core.autocrlf=false", *args],
        cwd=str(cwd) if cwd else None,
        env=git_env(),
        capture_output=True,
        text=True,
        timeout=45,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        lines = (result.stderr or result.stdout or "").strip().splitlines()
        tail = lines[-1][:180] if lines else ""
        raise ValueError("提案沒有寫上網路上。" + (f" {tail}" if tail else ""))


def push_room() -> None:
    if not hosted():
        return
    repo = DATA.parent
    if not (repo / ".git").exists():
        raise ValueError("提案沒有寫上網路上。")
    run_git(["add", "--", DATA.name], cwd=repo)
    quiet = subprocess.run(
        ["git", "-c", "core.autocrlf=false", "diff", "--cached", "--quiet", "--", DATA.name],
        cwd=str(repo),
        env=git_env(),
        capture_output=True,
        text=True,
        timeout=45,
    )
    if quiet.returncode == 0:
        return
    if quiet.returncode != 1:
        raise ValueError("提案沒有寫上網路上。")
    run_git(["commit", "-m", "更新提案"], cwd=repo)
    try:
        run_git(["push"], cwd=repo)
    except ValueError:
        run_git(["pull", "--rebase", "--autostash"], cwd=repo)
        run_git(["push"], cwd=repo)


def restore_hosted_room() -> None:
    if not hosted():
        return
    repo_url = os.environ.get("WALL_DATA_REPO", "").strip()
    if repo_url.startswith("git@") and not deploy_key_text().startswith("-----BEGIN"):
        raise SystemExit("缺少 WALL_DEPLOY_KEY")
    dest = DATA.parent
    dest.parent.mkdir(parents=True, exist_ok=True)
    if (dest / ".git").exists():
        run_git(["pull", "--rebase", "--autostash"], cwd=dest)
    else:
        if dest.exists() and any(dest.iterdir()):
            raise SystemExit("資料目錄不是空的，沒有把遠端提案蓋上去。")
        run_git(["clone", "--branch", "data", "--single-branch", repo_url, str(dest)])
    if DATA.exists():
        return
    bundled = ROOT / "room.json"
    if not bundled.exists() or bundled.resolve() == DATA.resolve():
        raise SystemExit("遠端還沒有提案資料。")
    DATA.write_text(bundled.read_text(encoding="utf-8"), encoding="utf-8")
    push_room()


def save(state: dict, remote: bool = True) -> None:
    payload = json.dumps(state, ensure_ascii=False, indent=2)
    tmp = DATA.with_suffix(".json.tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(DATA)
    if remote:
        push_room()


def touch_presence(person_id: str) -> None:
    if person_id:
        PRESENCE[person_id] = now_iso()


def seen_iso(person: dict) -> str:
    pid = person.get("id")
    if pid and pid in PRESENCE:
        return PRESENCE[pid]
    return person.get("lastSeen") or ""


def stamp_presence(state: dict) -> None:
    for person in state.get("people") or []:
        mem = PRESENCE.get(person.get("id"))
        if mem:
            person["lastSeen"] = mem


def presence_due() -> bool:
    return (time.monotonic() - PRESENCE_FLUSH_AT) >= FLUSH_SECONDS


def note_flushed() -> None:
    global PRESENCE_FLUSH_AT
    PRESENCE_FLUSH_AT = time.monotonic()


def flush_presence_to_disk() -> None:
    with LOCK:
        try:
            state = load()
        except RoomCorrupt:
            return
        before = json.dumps(state, ensure_ascii=False, sort_keys=True)
        stamp_presence(state)
        after = json.dumps(state, ensure_ascii=False, sort_keys=True)
        if after != before:
            save(state)


atexit.register(flush_presence_to_disk)


def uid() -> str:
    return uuid.uuid4().hex[:12]


def clean_text(value, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def online_seconds(person: dict, seconds: int = ONLINE_SECONDS) -> bool:
    raw = seen_iso(person)
    if not raw:
        return False
    try:
        seen = datetime.fromisoformat(raw)
    except ValueError:
        return False
    if seen.tzinfo is None:
        seen = seen.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - seen).total_seconds() <= seconds


def view_for(state: dict, person_id: str) -> dict:
    out = json.loads(json.dumps(state))
    visible = []
    for idea in out["ideas"]:
        if idea.get("status") == "draft" and idea.get("authorId") != person_id:
            continue
        visible.append(idea)
    out["ideas"] = visible
    for person in out["people"]:
        person["online"] = online_seconds(person)
    return out


def bump(state: dict) -> None:
    state["rev"] = int(state.get("rev") or 0) + 1


def find_person(state: dict, person_id: str):
    return next((p for p in state["people"] if p["id"] == person_id), None)


def find_idea(state: dict, idea_id: str):
    return next((i for i in state["ideas"] if i["id"] == idea_id), None)


def require_person(state: dict, body: dict):
    person = find_person(state, str(body.get("personId") or ""))
    if not person:
        raise ValueError("請先留下名字再加入。")
    touch_presence(person["id"])
    return person


def drop_ai_proposals(state: dict) -> None:
    ideas = state.get("ideas") or []
    gone = {
        item.get("id")
        for item in ideas
        if item.get("byAi") or item.get("authorId") == "ai"
    }
    gone.discard(None)
    if not gone:
        return
    state["ideas"] = [item for item in ideas if item.get("id") not in gone]
    for key in ("votes", "ratings", "comments", "mutes", "features"):
        rows = state.get(key)
        if isinstance(rows, list):
            state[key] = [row for row in rows if row.get("ideaId") not in gone]
    state["rev"] = int(state.get("rev") or 0) + 1
    save(state)


def blank_idea(author_id: str) -> dict:
    return {
        "id": uid(),
        "authorId": author_id,
        "status": "draft",
        "origin": "",
        "sparkId": "",
        "dice": None,
        "theme": "",
        "forkedFrom": "",
        "who": "",
        "whenWhere": "",
        "incident": "",
        "behavior": "",
        "input": "",
        "output": "",
        "setting": "",
        "situation": "",
        "value": "",
        "appeal": "",
        "aiFit": "",
        "frames": [{"stickers": [], "line": ""} for _ in range(4)],
        "shots": ["", "", ""],
        "compliance": {"sameScreen": False, "noDiagnosis": False, "fictional": False},
        "rehearsal": False,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }


def rx(pattern: str) -> re.Pattern:
    return re.compile(pattern)


def blob(idea: dict, fields: list[str]) -> str:
    return "\n".join(str(idea.get(f) or "") for f in fields)


def medical_problem(text: str, cat: dict) -> bool:
    if rx(cat["medicalAny"]).search(text or ""):
        return True
    if rx(cat["medicalPrevent"]).search(text or ""):
        return True
    return False


def specific_who(text: str, cat: dict) -> bool:
    limits = cat["limits"]["who"]
    if not (limits[0] <= len(text) <= limits[1]):
        return False
    rest = text
    for word in cat["genericWho"]:
        rest = rest.replace(word, "")
    for ch in "的們、，。 \t":
        rest = rest.replace(ch, "")
    return len(rest) >= 4


def wide_problem(text: str, cat: dict) -> bool:
    return bool(rx(cat["widePattern"]).search(text or ""))


def second_problem(text: str, cat: dict) -> bool:
    return bool(rx(cat["secondPattern"]).search(text or ""))


def constraint_ok(idea: dict, rule: dict) -> bool:
    for req in rule.get("require") or []:
        if not rx(req["pattern"]).search(blob(idea, req["fields"])):
            return False
    for ban in rule.get("forbid") or []:
        if rx(ban["pattern"]).search(blob(idea, ban["fields"])):
            return False
    return True


def dice_ok(idea: dict, cat: dict) -> bool:
    dice = idea.get("dice") or {}
    if idea.get("origin") != "dice":
        return True
    person = next((p for p in cat["people"] if p["id"] == dice.get("personId")), None)
    time = next((t for t in cat["times"] if t["id"] == dice.get("timeId")), None)
    cons = next((c for c in cat["constraints"] if c["id"] == dice.get("constraintId")), None)
    if not person or not time or not cons:
        return False
    if not rx(person["pattern"]).search(idea.get("who") or ""):
        return False
    if not rx(time["pattern"]).search(idea.get("whenWhere") or ""):
        return False
    return constraint_ok(idea, cons)


def copies_spark(idea: dict, cat: dict) -> bool:
    if idea.get("origin") != "spark":
        return False
    spark = next((s for s in cat["sparks"] if s["id"] == idea.get("sparkId")), None)
    if not spark:
        return False
    inc = re.sub(r"\s", "", idea.get("incident") or "")
    pic = re.sub(r"\s", "", spark["picture"])
    if len(inc) >= 8 and inc in pic:
        return True
    return len(pic) >= 12 and pic[:12] in inc


def scene_error(idea: dict, cat: dict, state: dict) -> str:
    limits = cat["limits"]
    if idea.get("origin") not in ("spark", "dice", "theme"):
        return "先選一個主題，寫一句要做的事。"
    if idea.get("origin") == "theme":
        if idea.get("theme") not in {t["id"] for t in cat["themes"]}:
            return "先選四個主題裡的一個。"
        text = (idea.get("incident") or "").strip()
        lo, hi = limits["incident"]
        if not (lo <= len(text) <= hi):
            return "用一句話說這個主題要做什麼。"
        if detail_medical(idea, cat) or medical_problem(text, cat) or medical_problem(idea.get("output") or "", cat):
            return "不要寫成診斷、治療或療效。"
        return ""
    if idea.get("origin") == "spark":
        spark = next((s for s in cat["sparks"] if s["id"] == idea.get("sparkId")), None)
        if not spark:
            return "這個例子不存在。"
        if idea.get("theme") != spark["theme"]:
            return "主題要跟著你選的例子。"
    themes = {t["id"] for t in cat["themes"]}
    if idea.get("theme") not in themes:
        return "先選定這次競賽的一個主題。"
    if not specific_who(idea.get("who") or "", cat):
        return "人要具體。不要只寫飼主、使用者或所有人。"
    when = idea.get("whenWhere") or ""
    lo, hi = limits["whenWhere"]
    if not (lo <= len(when) <= hi):
        return "時間和地點要寫成一句放得進畫面的話。"
    if not rx(cat["timePattern"]).search(when) or not rx(cat["placePattern"]).search(when):
        return "時間地點要同時有「幾點」和「在哪」。"
    for key in ("incident", "behavior", "input", "output"):
        text = idea.get(key) or ""
        lo, hi = limits[key]
        if not (lo <= len(text) <= hi):
            return "有一格還沒收成一句話。"
        if wide_problem(text, cat):
            return "這句還是一個範圍。拿掉平台、管理、報告、各種。"
    if second_problem(idea.get("input") or "", cat) or second_problem(idea.get("output") or "", cat):
        return "輸入和輸出都只能有一件事。"
    if medical_problem(idea.get("input") or "", cat) or medical_problem(idea.get("output") or "", cat):
        return "輸出要停在照護提醒，不要寫成診斷、治療或療效。"
    if copies_spark(idea, cat):
        return "這句還是例子裡的句子。改成你看得到的動作。"
    if not dice_ok(idea, cat):
        return "這三個限制都要出現在內容裡。"
    comp = idea.get("compliance") or {}
    if not (comp.get("sameScreen") and comp.get("noDiagnosis") and comp.get("fictional")):
        return "三個規則都要選對。"
    origin = find_idea(state, idea.get("forkedFrom") or "")
    if origin and idea.get("who", "").strip() == origin.get("who", "").strip() and idea.get("whenWhere", "").strip() == origin.get("whenWhere", "").strip():
        return "縮小範圍時，人或時間地點至少要改一個。"
    if detail_medical(idea, cat):
        return "不要寫成診斷、治療或療效。"
    return ""


def frames_ready(idea: dict, cat: dict) -> str:
    frames = idea.get("frames") or []
    shots = idea.get("shots") or []
    if len(frames) != 4 or len(shots) != 3:
        return "四格畫面和三句說明都要補上。"
    known = {s["id"] for s in cat["stickers"]}
    output = (idea.get("output") or "").strip()
    prefix = output[:4]
    for index, frame in enumerate(frames):
        line = (frame.get("line") or "").strip()
        stickers = frame.get("stickers") or []
        lo, hi = cat["limits"]["frame"]
        if not (lo <= len(line) <= hi):
            return "每一格都要有一句說明。"
        if not stickers or len(stickers) > 3 or any(s not in known for s in stickers):
            return "每一格選 1 到 3 個看得懂的圖。"
        if line.startswith("畫面"):
            return "「畫面」不用再寫。"
        if wide_problem(line, cat):
            return "這格範圍太大。"
        if index == 2 and prefix and prefix not in line and output not in line:
            return "第三格要看得到那個輸出的前幾個字。"
    if index_medical(frames[2].get("line") or "", cat):
        return "第三格不要寫成診斷或療效。"
    for shot in shots:
        text = (shot or "").strip()
        lo, hi = cat["limits"]["shot"]
        if not (lo <= len(text) <= hi):
            return "三句說明都要寫完。"
        if text.startswith("畫面"):
            return "「畫面」不用再寫。"
        if wide_problem(text, cat):
            return "這句範圍太大。"
    return ""


def index_medical(text: str, cat: dict) -> bool:
    return medical_problem(text, cat)


def votes_for(state: dict, idea_id: str, author_id: str) -> list[dict]:
    return [v for v in state["votes"] if v["ideaId"] == idea_id and v["voterId"] != author_id]


def others_online(state: dict, author_id: str) -> list[dict]:
    return [p for p in state["people"] if p["id"] != author_id and online_seconds(p)]


def gate_error(idea: dict, state: dict, cat: dict) -> str:
    if idea.get("status") not in ("published", "locked"):
        return "還沒給大家看。"
    err = scene_error(idea, cat, state)
    if err:
        return err
    err = frames_ready(idea, cat)
    if err:
        return err
    others = others_online(state, idea["authorId"])
    if not others:
        return ""
    needed = min(2, len(others))
    votes = votes_for(state, idea["id"], idea["authorId"])
    if len(votes) < needed:
        return "還要隊友評分。"
    for key in ("visual", "focus", "creative", "demo"):
        avg = sum(int(v[key]) for v in votes) / len(votes)
        if avg < 1.5:
            return "還有項目平均不到 1.5。"
    if any(int(v["compliance"]) != 2 for v in votes):
        return "「規則」這一項要每位評分的人都給過。"
    mutes = [m for m in state["mutes"] if m["ideaId"] == idea["id"] and m["personId"] != idea["authorId"]]
    if not mutes:
        return "至少要有一位隊友先看圖、寫下他看到什麼。"
    return ""


def published_count(state: dict, author_id: str, ignore_id: str = "") -> int:
    return sum(
        1
        for idea in state["ideas"]
        if idea["authorId"] == author_id and idea["status"] in ("published", "locked") and idea["id"] != ignore_id
    )


def sanitize_idea(payload: dict, cat: dict) -> dict:
    limits = cat["limits"]
    frames_in = payload.get("frames") if isinstance(payload.get("frames"), list) else []
    frames = []
    for index in range(4):
        raw = frames_in[index] if index < len(frames_in) and isinstance(frames_in[index], dict) else {}
        stickers = raw.get("stickers") if isinstance(raw.get("stickers"), list) else []
        known = {s["id"] for s in cat["stickers"]}
        frames.append({
            "stickers": [s for s in stickers if isinstance(s, str) and s in known][:3],
            "line": clean_text(raw.get("line"), limits["frame"][1]),
        })
    shots_in = payload.get("shots") if isinstance(payload.get("shots"), list) else []
    shots = [clean_text(shots_in[i], limits["shot"][1]) if i < len(shots_in) else "" for i in range(3)]
    dice = payload.get("dice") if isinstance(payload.get("dice"), dict) else None
    if dice:
        dice = {
            "personId": clean_text(dice.get("personId"), 20),
            "timeId": clean_text(dice.get("timeId"), 20),
            "constraintId": clean_text(dice.get("constraintId"), 20),
        }
    comp_in = payload.get("compliance") if isinstance(payload.get("compliance"), dict) else {}
    return {
        "origin": payload.get("origin") if payload.get("origin") in ("spark", "dice", "theme") else "",
        "sparkId": clean_text(payload.get("sparkId"), 40),
        "dice": dice,
        "theme": clean_text(payload.get("theme"), 20),
        "forkedFrom": clean_text(payload.get("forkedFrom"), 20),
        "who": clean_text(payload.get("who"), limits["who"][1]),
        "whenWhere": clean_text(payload.get("whenWhere"), limits["whenWhere"][1]),
        "incident": clean_text(payload.get("incident"), limits["incident"][1]),
        "behavior": clean_text(payload.get("behavior"), limits["behavior"][1]),
        "input": clean_text(payload.get("input"), limits["input"][1]),
        "output": clean_text(payload.get("output"), limits["output"][1]),
        "frames": frames,
        "shots": shots,
        "compliance": {
            "sameScreen": bool(comp_in.get("sameScreen")),
            "noDiagnosis": bool(comp_in.get("noDiagnosis")),
            "fictional": bool(comp_in.get("fictional")),
        },
    }


def detail_limit(cat: dict) -> int:
    raw = (cat.get("limits") or {}).get("detail") or [0, 320]
    try:
        return int(raw[1])
    except (TypeError, ValueError, IndexError):
        return 320


def clean_detail(payload: dict, cat: dict) -> dict:
    limit = detail_limit(cat)
    return {key: clean_text(payload.get(key), limit) for key in DETAIL if key in payload}


def detail_medical(idea: dict, cat: dict) -> bool:
    return any(medical_problem(idea.get(key) or "", cat) for key in DETAIL)


def apply_fields(idea: dict, clean: dict, fields: list[str]) -> None:
    for key in fields:
        idea[key] = clean[key]
    idea["updatedAt"] = now_iso()


def person_public(person: dict) -> dict:
    return {
        "id": person.get("id"),
        "name": person.get("name"),
        "color": person.get("color"),
        "lastSeen": seen_iso(person),
        "joinedAt": person.get("joinedAt"),
        "online": online_seconds(person),
    }


def people_public(state: dict) -> list[dict]:
    return [person_public(person) for person in state.get("people") or []]


def used_colors(state: dict, except_id: str = "") -> set[str]:
    return {person.get("color") for person in state.get("people") or [] if person.get("id") != except_id and person.get("color")}


def pick_color(state: dict, requested: str, person_id: str) -> str:
    used = used_colors(state, person_id)
    color = str(requested or "").strip().lower()
    if color:
        if color not in PALETTE:
            raise ValueError("這個顏色不能用。")
        if color in used:
            raise ValueError("這個顏色已經有人用了，換一個。")
        return color
    for item in PALETTE:
        if item not in used:
            return item
    return PALETTE[len(state.get("people") or []) % len(PALETTE)]


def wall_password() -> str:
    env = os.environ.get("WALL_PASSWORD", "").strip()
    if env:
        return env
    if not PASSWORD_PATH.exists():
        return ""
    return PASSWORD_PATH.read_text(encoding="utf-8").strip()


def ensure_password() -> str:
    current = wall_password()
    if current:
        return current
    alphabet = "abcdefghijkmnopqrstuvwxyz23456789"
    generated = "".join(secrets.choice(alphabet) for _ in range(8))
    PASSWORD_PATH.write_text(generated + "\n", encoding="utf-8")
    return generated


def token_secret() -> bytes:
    return hashlib.sha256(b"aipets-wall:" + wall_password().encode("utf-8")).digest()


def make_token() -> str:
    exp = int(time.time()) + 30 * 24 * 3600
    msg = str(exp).encode("ascii")
    sig = hmac.new(token_secret(), msg, hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def token_ok(token: str) -> bool:
    if not wall_password():
        return False
    exp_s, dot, sig = token.partition(".")
    if not dot or not exp_s.isdigit() or len(sig) != 64:
        return False
    exp = int(exp_s)
    now = int(time.time())
    if exp < now or exp > now + 31 * 24 * 3600:
        return False
    expected = hmac.new(token_secret(), exp_s.encode("ascii"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


def require_token(handler: BaseHTTPRequestHandler) -> None:
    header = handler.headers.get("Authorization") or ""
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    if not token_ok(token):
        raise AuthError("請先登錄。")


def client_ip(handler: BaseHTTPRequestHandler) -> str:
    forwarded = handler.headers.get("CF-Connecting-IP") or handler.headers.get("X-Forwarded-For") or ""
    if forwarded:
        return forwarded.split(",")[0].strip() or "unknown"
    return handler.client_address[0]


def too_many(ip: str) -> bool:
    now = time.time()
    with FAIL_LOCK:
        hits = [stamp for stamp in FAILS.get(ip, []) if now - stamp < 600]
        FAILS[ip] = hits
        return len(hits) >= 8


def note_fail(ip: str) -> None:
    now = time.time()
    with FAIL_LOCK:
        hits = [stamp for stamp in FAILS.get(ip, []) if now - stamp < 600]
        hits.append(now)
        FAILS[ip] = hits


def clear_fails(ip: str) -> None:
    with FAIL_LOCK:
        FAILS.pop(ip, None)


def passwords_match(given: str, expected: str) -> bool:
    left = hashlib.sha256(given.encode("utf-8")).digest()
    right = hashlib.sha256(expected.encode("utf-8")).digest()
    return hmac.compare_digest(left, right)


def handle_login(body: dict, ip: str) -> dict:
    if too_many(ip):
        raise ValueError("試太多次了，請稍後再試。")
    expected = wall_password()
    if not expected:
        raise ValueError("這面牆還沒有設定密碼。")
    if not passwords_match(str(body.get("password") or ""), expected):
        note_fail(ip)
        raise ValueError("密碼不對。")
    clear_fails(ip)
    return {"ok": True, "token": make_token()}


def public_url() -> str:
    env = os.environ.get("PUBLIC_URL", "").strip()
    if env:
        return env
    if PUBLIC_URL_PATH.exists():
        return PUBLIC_URL_PATH.read_text(encoding="utf-8").strip()
    return ""


def handle_join(state: dict, body: dict) -> dict:
    cat = catalog()
    name = clean_text(body.get("name"), cat["limits"]["name"][1])
    if len(name) < cat["limits"]["name"][0]:
        raise ValueError("先留一個隊友叫得出來的名字。")
    pid = str(body.get("personId") or "")
    if not re.fullmatch(r"[A-Za-z0-9-]{8,64}", pid or ""):
        pid = uid()
    person = find_person(state, pid)
    if not person:
        person = {
            "id": pid,
            "name": name,
            "color": pick_color(state, body.get("color"), pid),
            "lastSeen": now_iso(),
            "joinedAt": now_iso(),
        }
        state["people"].append(person)
        bump(state)
    else:
        person["name"] = name
        if body.get("color"):
            person["color"] = pick_color(state, body.get("color"), person["id"])
    touch_presence(person["id"])
    return {"ok": True, "me": person_public(person), "state": view_for(state, person["id"])}


def handle_pulse(state: dict, body: dict) -> dict:
    person = require_person(state, body)
    try:
        client_rev = int(body.get("rev"))
    except (TypeError, ValueError):
        client_rev = -1
    current = int(state.get("rev") or 0)
    if client_rev == current:
        return {
            "ok": True,
            "slim": True,
            "rev": current,
            "me": person_public(person),
            "people": people_public(state),
        }
    return {"ok": True, "me": person_public(person), "state": view_for(state, person["id"])}


def handle_save(state: dict, body: dict) -> dict:
    cat = catalog()
    person = require_person(state, body)
    mode = body.get("mode")
    if mode not in ("draft", "publish", "frames"):
        raise ValueError("儲存方式不對。")
    payload = body.get("idea") if isinstance(body.get("idea"), dict) else {}
    clean = sanitize_idea(payload, cat)
    detail = clean_detail(payload, cat)
    idea_id = str(payload.get("id") or "")
    idea = find_idea(state, idea_id) if idea_id else None
    if idea and idea["authorId"] != person["id"]:
        raise ValueError("這則是隊友的。你可以評分、留言，或再縮小範圍。")
    if idea and idea.get("status") == "locked":
        raise ValueError("已經選定的要先取消選定，才能改。")
    if mode == "frames":
        if not idea or idea["status"] != "published":
            raise ValueError("先給大家看，再補畫面。")
        apply_fields(idea, clean, ["frames", "shots"])
        bump(state)
        return {"ok": True, "ideaId": idea["id"], "state": view_for(state, person["id"])}
    if not idea:
        if any(i["authorId"] == person["id"] and i["status"] == "draft" for i in state["ideas"]):
            raise ValueError("你還有一則寫到一半。先完成或丟掉它。")
        idea = blank_idea(person["id"])
        state["ideas"].append(idea)
    scene_fields = ["origin", "sparkId", "dice", "theme", "forkedFrom", *NARRATIVE, "compliance"]
    if mode == "draft":
        apply_fields(idea, clean, scene_fields + ["frames", "shots"])
        idea.update(detail)
        for key in DETAIL:
            idea.setdefault(key, "")
        idea["status"] = "draft"
        bump(state)
        return {"ok": True, "ideaId": idea["id"], "state": view_for(state, person["id"])}
    err = scene_error({**idea, **clean, **detail}, cat, state)
    if err:
        raise ValueError(err)
    if published_count(state, person["id"], idea["id"]) >= 3:
        raise ValueError("你已經有三則給大家看了。")
    apply_fields(idea, clean, scene_fields)
    idea.update(detail)
    for key in DETAIL:
        idea.setdefault(key, "")
    idea["status"] = "published"
    idea["rehearsal"] = False
    bump(state)
    return {"ok": True, "ideaId": idea["id"], "state": view_for(state, person["id"])}


def handle_discard(state: dict, body: dict) -> dict:
    person = require_person(state, body)
    idea = find_idea(state, str(body.get("ideaId") or ""))
    if not idea or idea["authorId"] != person["id"]:
        raise ValueError("找不到這則草稿。")
    if idea["status"] != "draft":
        raise ValueError("已經給大家看的想法不能刪。")
    state["ideas"] = [i for i in state["ideas"] if i["id"] != idea["id"]]
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def handle_vote(state: dict, body: dict) -> dict:
    person = require_person(state, body)
    idea = find_idea(state, str(body.get("ideaId") or ""))
    if not idea or idea["status"] not in ("published", "locked"):
        raise ValueError("這則還不能評分。")
    if idea["authorId"] == person["id"]:
        raise ValueError("自己的想法不能自己評。")
    scores = body.get("scores") if isinstance(body.get("scores"), dict) else {}
    vote = {"ideaId": idea["id"], "voterId": person["id"], "updatedAt": now_iso()}
    for key in ("visual", "focus", "creative", "demo", "compliance"):
        try:
            value = int(scores.get(key))
        except (TypeError, ValueError):
            raise ValueError("五個項目都要選。")
        if value not in (0, 1, 2):
            raise ValueError("五個項目都要選。")
        vote[key] = value
    if vote["visual"] == 2 and frames_ready(idea, catalog()):
        raise ValueError("還沒補上使用過程之前，畫面分最高給 1。")
    state["votes"] = [v for v in state["votes"] if not (v["ideaId"] == idea["id"] and v["voterId"] == person["id"])]
    state["votes"].append(vote)
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def link_ratings_to_votes(state: dict) -> bool:
    votes = state.setdefault("votes", [])
    have = {(vote.get("ideaId"), vote.get("voterId")) for vote in votes}
    added = False
    for rating in state.get("ratings") or []:
        key = (rating.get("ideaId"), rating.get("voterId"))
        if not key[0] or not key[1] or key in have:
            continue
        idea = find_idea(state, key[0])
        if not idea or idea.get("authorId") == key[1]:
            continue
        person = {"id": key[1]}
        support_vote(state, idea, person)
        have.add(key)
        added = True
    return added


def support_vote(state: dict, idea: dict, person: dict) -> None:
    if any(vote.get("ideaId") == idea["id"] and vote.get("voterId") == person["id"] for vote in state["votes"]):
        return
    state["votes"].append({
        "ideaId": idea["id"],
        "voterId": person["id"],
        "updatedAt": now_iso(),
        "visual": 1,
        "focus": 2,
        "creative": 2,
        "demo": 2,
        "compliance": 2,
    })


def handle_unvote(state: dict, body: dict) -> dict:
    person = require_person(state, body)
    idea_id = str(body.get("ideaId") or "")
    idea = find_idea(state, idea_id)
    if not idea or idea["status"] not in ("published", "locked"):
        raise ValueError("這則還不能改票。")
    kept = [
        vote for vote in state["votes"]
        if not (vote.get("ideaId") == idea["id"] and vote.get("voterId") == person["id"])
    ]
    if len(kept) == len(state["votes"]):
        raise ValueError("你還沒投這則。")
    state["votes"] = kept
    state["ratings"] = [
        item for item in state.get("ratings") or []
        if not (item.get("ideaId") == idea["id"] and item.get("voterId") == person["id"])
    ]
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def handle_rate(state: dict, body: dict) -> dict:
    person = require_person(state, body)
    idea = find_idea(state, str(body.get("ideaId") or ""))
    if not idea or idea["status"] not in ("published", "locked"):
        raise ValueError("這則還不能評分。")
    if idea["authorId"] == person["id"]:
        raise ValueError("自己的想法不能自己評。")
    filled = []
    if str(idea.get("incident") or "").strip():
        filled.append("incident")
    filled.extend(key for key in DETAIL if str(idea.get(key) or "").strip())
    if not filled:
        raise ValueError("詳細資訊還沒寫，先不能評。")
    raw = body.get("scores") if isinstance(body.get("scores"), dict) else {}
    scores = {}
    for key in filled:
        try:
            value = int(raw.get(key))
        except (TypeError, ValueError):
            raise ValueError("每一段都要選 1 到 5 分。")
        if value not in (1, 2, 3, 4, 5):
            raise ValueError("每一段都要選 1 到 5 分。")
        scores[key] = value
    rating = {"ideaId": idea["id"], "voterId": person["id"], "scores": scores, "updatedAt": now_iso()}
    state.setdefault("ratings", [])
    state["ratings"] = [
        item for item in state["ratings"]
        if not (item.get("ideaId") == idea["id"] and item.get("voterId") == person["id"])
    ]
    state["ratings"].append(rating)
    support_vote(state, idea, person)
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def handle_comment(state: dict, body: dict) -> dict:
    cat = catalog()
    person = require_person(state, body)
    idea = find_idea(state, str(body.get("ideaId") or ""))
    if not idea or idea["status"] == "draft":
        raise ValueError("草稿還不能留言。")
    kind = body.get("kind")
    if kind not in cat["stems"]:
        raise ValueError("先選一種留言：範圍又變大了、這一格只留，或你想留下的畫面。")
    text = clean_text(body.get("text"), cat["limits"]["comment"][1])
    lo = cat["limits"]["comment"][0]
    if len(text) < lo:
        raise ValueError("留言寫成一句就好。")
    state["comments"].append({
        "id": uid(),
        "ideaId": idea["id"],
        "authorId": person["id"],
        "kind": kind,
        "text": text,
        "createdAt": now_iso(),
    })
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def handle_mute(state: dict, body: dict) -> dict:
    cat = catalog()
    person = require_person(state, body)
    idea = find_idea(state, str(body.get("ideaId") or ""))
    if not idea or idea["status"] not in ("published", "locked"):
        raise ValueError("這則還沒給大家看，不能先看圖。")
    if idea["authorId"] == person["id"]:
        raise ValueError("先看圖是給隊友做的。")
    text = clean_text(body.get("saw"), cat["limits"]["saw"][1])
    if len(text) < cat["limits"]["saw"][0]:
        raise ValueError("寫下你看到的那一個畫面。")
    state["mutes"] = [m for m in state["mutes"] if not (m["ideaId"] == idea["id"] and m["personId"] == person["id"])]
    state["mutes"].append({"ideaId": idea["id"], "personId": person["id"], "saw": text, "createdAt": now_iso()})
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def handle_feature(state: dict, body: dict) -> dict:
    cat = catalog()
    person = require_person(state, body)
    idea = find_idea(state, str(body.get("ideaId") or ""))
    if not idea or idea["status"] == "draft":
        raise ValueError("先有一則給大家看的想法，再決定功能放哪。")
    text = clean_text(body.get("text"), cat["limits"]["feature"][1])
    if len(text) < cat["limits"]["feature"][0]:
        raise ValueError("用一句話說這個功能。")
    slot = str(body.get("slot") or "off")
    if slot not in ("off", "0", "1", "2", "3"):
        raise ValueError("選它出現在第幾格，或承認它對不上。")
    state["features"].append({
        "id": uid(),
        "ideaId": idea["id"],
        "authorId": person["id"],
        "text": text,
        "slot": slot,
        "createdAt": now_iso(),
    })
    message = "先擱下，不會放進這則想法。" if slot == "off" else "請改那一格的畫面，不要在旁邊再加一項功能。"
    bump(state)
    return {"ok": True, "message": message, "state": view_for(state, person["id"])}


def handle_phase(state: dict, body: dict) -> dict:
    person = require_person(state, body)
    if state.get("facilitatorId") != person["id"]:
        raise ValueError("這一段由主持人往下帶。")
    phase = body.get("phase")
    if phase not in PHASES:
        raise ValueError("沒有這個階段。")
    state["phase"] = phase
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def handle_facilitate(state: dict, body: dict) -> dict:
    person = require_person(state, body)
    state["facilitatorId"] = person["id"]
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def handle_lock(state: dict, body: dict) -> dict:
    cat = catalog()
    person = require_person(state, body)
    idea = find_idea(state, str(body.get("ideaId") or ""))
    if not idea or idea["status"] != "published":
        raise ValueError("只能選定已經給大家看的想法。")
    if any(i["status"] == "locked" for i in state["ideas"]):
        raise ValueError("已經選定一則了。要換，先取消選定。")
    err = gate_error(idea, state, cat)
    if err:
        raise ValueError(err)
    idea["status"] = "locked"
    idea["rehearsal"] = not others_online(state, idea["authorId"])
    idea["updatedAt"] = now_iso()
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def handle_unlock(state: dict, body: dict) -> dict:
    person = require_person(state, body)
    facilitator = state.get("facilitatorId")
    if facilitator and facilitator != person["id"] and online_seconds(find_person(state, facilitator) or {}, 30):
        raise ValueError("取消選定請由正在帶這段的人來。")
    idea = find_idea(state, str(body.get("ideaId") or ""))
    if not idea or idea["status"] != "locked":
        raise ValueError("目前沒有選定的想法。")
    idea["status"] = "published"
    idea["rehearsal"] = False
    idea["updatedAt"] = now_iso()
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def handle_park(state: dict, body: dict) -> dict:
    person = require_person(state, body)
    idea = find_idea(state, str(body.get("ideaId") or ""))
    if not idea or idea["status"] != "published":
        raise ValueError("只有給大家看的想法可以先擱下。")
    facilitator = state.get("facilitatorId")
    if idea["authorId"] != person["id"] and facilitator != person["id"]:
        raise ValueError("作者或主持人才能先擱下。")
    idea["status"] = "parked"
    idea["updatedAt"] = now_iso()
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def handle_restore(state: dict, body: dict) -> dict:
    person = require_person(state, body)
    idea = find_idea(state, str(body.get("ideaId") or ""))
    if not idea or idea["authorId"] != person["id"] or idea["status"] != "parked":
        raise ValueError("這則不能再給大家看。")
    if published_count(state, person["id"]) >= 3:
        raise ValueError("已經有三則給大家看了。")
    idea["status"] = "published"
    idea["updatedAt"] = now_iso()
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


def handle_reset(state: dict, body: dict) -> dict:
    person = require_person(state, body)
    if state.get("facilitatorId") != person["id"]:
        raise ValueError("只有主持人可以重新開始這場。")
    people = state["people"]
    state.clear()
    state.update(fresh())
    state["people"] = people
    state["facilitatorId"] = person["id"]
    drop_ai_proposals(state)
    bump(state)
    return {"ok": True, "state": view_for(state, person["id"])}


ROUTES = {
    "/api/join": handle_join,
    "/api/pulse": handle_pulse,
    "/api/save": handle_save,
    "/api/discard": handle_discard,
    "/api/vote": handle_vote,
    "/api/unvote": handle_unvote,
    "/api/rate": handle_rate,
    "/api/comment": handle_comment,
    "/api/mute": handle_mute,
    "/api/feature": handle_feature,
    "/api/phase": handle_phase,
    "/api/facilitate": handle_facilitate,
    "/api/lock": handle_lock,
    "/api/unlock": handle_unlock,
    "/api/park": handle_park,
    "/api/restore": handle_restore,
    "/api/reset": handle_reset,
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        if args and isinstance(args[0], str) and args[0].startswith("GET /api/pulse"):
            return
        super().log_message(fmt, *args)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json(200, {"ok": True, "publicUrl": public_url()})
            return
        if path == "/api/faces":
            try:
                require_token(self)
            except AuthError as exc:
                self.send_json(401, {"ok": False, "error": str(exc)})
                return
            with LOCK:
                state = load()
            cat = catalog()
            self.send_json(200, {
                "ok": True,
                "colors": PALETTE,
                "nicknames": cat.get("nicknames") or [],
                "people": [{"name": person.get("name"), "color": person.get("color")} for person in state.get("people") or []],
            })
            return
        self.serve_static(path)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        route = ROUTES.get(path)
        if path != "/api/login" and not route:
            self.send_json(404, {"ok": False, "error": "找不到這個動作。"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > 300_000:
            self.send_json(413, {"ok": False, "error": "內容太長。"})
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_json(400, {"ok": False, "error": "資料格式不對。"})
            return
        if not isinstance(body, dict):
            self.send_json(400, {"ok": False, "error": "資料格式不對。"})
            return
        if path == "/api/login":
            try:
                self.send_json(200, handle_login(body, client_ip(self)))
            except ValueError as exc:
                self.send_json(400, {"ok": False, "error": str(exc)})
            return
        try:
            require_token(self)
        except AuthError as exc:
            self.send_json(401, {"ok": False, "error": str(exc)})
            return
        try:
            with LOCK:
                state = load()
                before = json.dumps(state, ensure_ascii=False, sort_keys=True)
                result = route(state, body)
                write = path != "/api/pulse" or presence_due()
                if write:
                    stamp_presence(state)
                    after = json.dumps(state, ensure_ascii=False, sort_keys=True)
                    if after != before:
                        save(state, remote=path != "/api/pulse")
                    if path == "/api/pulse":
                        note_flushed()
            self.send_json(200, result)
        except RoomCorrupt as exc:
            self.send_json(500, {"ok": False, "error": str(exc)})
        except ValueError as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})
        except Exception:
            self.send_json(500, {"ok": False, "error": "這台發想牆暫時出錯，請再試一次。"})

    def serve_static(self, path: str) -> None:
        rel = "index.html" if path == "/" else path.lstrip("/")
        file = (PUBLIC / rel).resolve()
        if not file.is_relative_to(PUBLIC) or not file.is_file():
            self.send_error(404)
            return
        kind = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
        }.get(file.suffix, "application/octet-stream")
        data = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, code: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    import socket

    if hosted() and not os.environ.get("WALL_PASSWORD", "").strip():
        raise SystemExit("缺少 WALL_PASSWORD")
    password = ensure_password()
    port = int(os.environ.get("PORT") or 8765)
    host = "0.0.0.0"
    if hosted():
        restore_hosted_room()
    else:
        DATA.parent.mkdir(parents=True, exist_ok=True)
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        lan = probe.getsockname()[0]
        probe.close()
    except OSError:
        lan = "127.0.0.1"
    server = ThreadingHTTPServer((host, port), Handler)
    print("發想牆已開", flush=True)
    print(f"這台電腦： http://127.0.0.1:{port}/", flush=True)
    print(f"同一 Wi-Fi 的組員： http://{lan}:{port}/", flush=True)
    if os.environ.get("WALL_PASSWORD", "").strip():
        print("組員密碼：用環境變數 WALL_PASSWORD", flush=True)
    else:
        print(f"組員密碼： {password}", flush=True)
    shared = public_url()
    if shared:
        print(f"公開網址： {shared}", flush=True)
    if hosted():
        print("提案寫進遠端資料庫。這台電腦關機，牆還在。", flush=True)
    else:
        print("視窗留著，關掉就暫停。提案存在 room.json。", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
