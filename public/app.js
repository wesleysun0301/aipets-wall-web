"use strict";

const FIELD_ORDER = ["who", "whenWhere", "incident", "behavior", "input", "output"];
const DETAIL_FIELDS = [
  ["setting", "在哪個情境", "這件事出現在誰的生活、什麼場合。"],
  ["situation", "什麼樣的情況", "當下碰到什麼，才需要這個。"],
  ["value", "對主辦方的潛在商業價值", "主辦方為什麼在意，可能帶來什麼。"],
  ["appeal", "裁判為什麼會欣賞這個提案", "評審會看上這一則的理由。"],
  ["aiFit", "AI 的結合在哪裡", "人工智慧用在這件事的哪一步。"],
];
const SCENE_STEPS = ["origin", "theme", "who", "when", "incident", "behavior", "input", "output", "ruleDiagnosis", "ruleScreen", "ruleFiction", "preview"];
const FRAME_STEPS = ["f0", "f1", "f2", "f3", "s0", "s1", "s2", "preview"];
const PHASE_IDS = ["collect", "score", "story", "mute", "lock"];
const THEME_MARKS = ["主題一", "主題二", "主題三", "主題四"];
const TOUR_SLIDES = [
  { t: "一次只寫一件事", d: "每則只寫一件具體的事，不要寫成功能清單。" },
  { t: "不能從空白開始", d: "先選一個例子，或抽三個限制。範圍太大就進不了下一步。" },
  { t: "評分不是按讚", d: "分數是在指出看不看得懂、夠不夠集中、三分鐘講不講得完，或有沒有寫成診斷、治療。" },
];

let cat = null;
let state = null;
let me = null;
let rev = 0;
let pollTimer = null;
let selectedId = null;
let viewMode = "wall";
let openTheme = "";
let pins = [];
let wizard = null;
let drawerEl = null;
let detailEl = null;
let rulesOpen = false;
let renderLater = false;
let modalEl = null;
let draftTimer = null;
let draftChain = Promise.resolve();
let dicePick = null;
let sparkHoverId = null;
let resetConfirm = 0;
let tourSlide = 0;

function $(sel, root) {
  return (root || document).querySelector(sel);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function clear(n) {
  while (n.firstChild) n.removeChild(n.firstChild);
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
}

function loadPins() {
  try {
    pins = JSON.parse(localStorage.getItem("aipets-pins") || "[]").slice(0, 2);
  } catch {
    pins = [];
  }
}

function savePins() {
  localStorage.setItem("aipets-pins", JSON.stringify(pins.slice(0, 2)));
}

function togglePin(id) {
  if (!id) return;
  if (pins.includes(id)) pins = pins.filter((x) => x !== id);
  else {
    if (pins.length >= 2) pins.shift();
    pins.push(id);
  }
  savePins();
  if (!wizard) renderStage();
}

function rx(p) {
  return new RegExp(p);
}

function blob(idea, fields) {
  return fields.map((f) => String(idea[f] || "")).join("\n");
}

function medicalProblem(text) {
  if (!text) return false;
  if (rx(cat.medicalAny).test(text)) return true;
  if (rx(cat.medicalPrevent).test(text)) return true;
  return false;
}

function specificWho(text) {
  const [lo, hi] = cat.limits.who;
  if (text.length < lo || text.length > hi) return false;
  let rest = text;
  for (const w of cat.genericWho) rest = rest.split(w).join("");
  for (const ch of "的們、，。 \t") rest = rest.split(ch).join("");
  return rest.length >= 4;
}

function wideProblem(text) {
  return rx(cat.widePattern).test(text || "");
}

function secondProblem(text) {
  return rx(cat.secondPattern).test(text || "");
}

function copiesSpark(idea) {
  if (idea.origin !== "spark") return false;
  const spark = cat.sparks.find((s) => s.id === idea.sparkId);
  if (!spark) return false;
  const inc = (idea.incident || "").replace(/\s/g, "");
  const pic = spark.picture.replace(/\s/g, "");
  if (inc.length >= 8 && pic.includes(inc)) return true;
  return pic.length >= 12 && inc.includes(pic.slice(0, 12));
}

function constraintOk(idea, rule) {
  for (const req of rule.require || []) {
    if (!rx(req.pattern).test(blob(idea, req.fields))) return false;
  }
  for (const ban of rule.forbid || []) {
    if (rx(ban.pattern).test(blob(idea, ban.fields))) return false;
  }
  return true;
}

function diceEntities(idea) {
  const d = idea.dice || {};
  return {
    person: cat.people.find((p) => p.id === d.personId),
    time: cat.times.find((t) => t.id === d.timeId),
    cons: cat.constraints.find((c) => c.id === d.constraintId),
  };
}

function diceOk(idea) {
  if (idea.origin !== "dice") return true;
  const { person, time, cons } = diceEntities(idea);
  if (!person || !time || !cons) return false;
  if (!rx(person.pattern).test(idea.who || "")) return false;
  if (!rx(time.pattern).test(idea.whenWhere || "")) return false;
  return constraintOk(idea, cons);
}

function forkBlock(idea) {
  if (!idea.forkedFrom || !state) return "";
  const origin = state.ideas.find((i) => i.id === idea.forkedFrom);
  if (!origin) return "";
  if (
    (idea.who || "").trim() === (origin.who || "").trim() &&
    (idea.whenWhere || "").trim() === (origin.whenWhere || "").trim()
  ) {
    return "縮小範圍時，人或時間地點至少要改一個。";
  }
  return "";
}

function coachWho(idea) {
  const t = idea.who || "";
  const [lo, hi] = cat.limits.who;
  if (t.length < lo) return `至少 ${lo} 個字。`;
  if (t.length > hi) return `最多 ${hi} 個字。`;
  if (!specificWho(t)) return "不要只寫飼主、使用者或所有人。剩下要有具體描述。";
  if (wideProblem(t)) return "範圍還太大。拿掉平台、管理、報告。";
  if (idea.origin === "dice") {
    const { person } = diceEntities(idea);
    if (person && !rx(person.pattern).test(t)) return person.hint;
  }
  const fb = forkBlock(idea);
  if (fb) return fb;
  return "";
}

function coachWhen(idea) {
  const t = idea.whenWhere || "";
  const [lo, hi] = cat.limits.whenWhere;
  if (t.length < lo) return `至少 ${lo} 個字。`;
  if (t.length > hi) return `最多 ${hi} 個字。`;
  if (!rx(cat.timePattern).test(t) || !rx(cat.placePattern).test(t)) {
    return "要同時寫幾點、在哪。";
  }
  if (wideProblem(t)) return "範圍還太大。";
  if (idea.origin === "dice") {
    const { time } = diceEntities(idea);
    if (time && !rx(time.pattern).test(t)) return time.hint;
  }
  return "";
}

function coachIncident(idea) {
  const t = idea.incident || "";
  const [lo, hi] = cat.limits.incident;
  if (t.length < lo) return `至少 ${lo} 個字。`;
  if (t.length > hi) return `最多 ${hi} 個字。`;
  if (wideProblem(t)) return "範圍還太大。";
  if (copiesSpark(idea)) return "不要照抄例子。寫你看得到的動作。";
  return "";
}

function coachBehavior(idea) {
  const t = idea.behavior || "";
  const [lo, hi] = cat.limits.behavior;
  if (t.length < lo) return `至少 ${lo} 個字。`;
  if (t.length > hi) return `最多 ${hi} 個字。`;
  if (wideProblem(t)) return "範圍還太大。";
  if (/痛點|缺乏資訊|所以焦慮/.test(t)) return "寫他正在做的動作。";
  return "";
}

function coachInput(idea) {
  const t = idea.input || "";
  const [lo, hi] = cat.limits.input;
  if (t.length < lo) return `至少 ${lo} 個字。`;
  if (t.length > hi) return `最多 ${hi} 個字。`;
  if (wideProblem(t)) return "輸入只能有一件事。";
  if (secondProblem(t)) return "輸入只能有一件事。";
  if (medicalProblem(t)) return "不要寫診斷、治療或療效。";
  return "";
}

function coachOutput(idea) {
  const t = idea.output || "";
  const [lo, hi] = cat.limits.output;
  if (t.length < lo) return `至少 ${lo} 個字。`;
  if (t.length > hi) return `最多 ${hi} 個字。`;
  if (wideProblem(t)) return "輸出只能還一句話。";
  if (secondProblem(t)) return "輸出只能還一句話。";
  if (medicalProblem(t)) return "輸出要停在照護提醒。";
  if ((idea.input || "").trim() === t.trim() && t.trim()) return "輸出要和輸入不同。";
  return "";
}

function coachForStep(step, idea) {
  if (step === "who") return coachWho(idea);
  if (step === "when") return coachWhen(idea);
  if (step === "incident") return coachIncident(idea);
  if (step === "behavior") return coachBehavior(idea);
  if (step === "input") return coachInput(idea);
  if (step === "output") return coachOutput(idea);
  return "";
}

function stepFieldIndex(step) {
  const map = { who: 0, when: 1, incident: 2, behavior: 3, input: 4, output: 5 };
  return map[step] ?? -1;
}

function constraintBlocking(idea, step) {
  if (idea.origin !== "dice") return false;
  const { cons } = diceEntities(idea);
  if (!cons) return false;
  const cur = stepFieldIndex(step);
  if (cur < 0) return false;
  const related = cons.fields || [];
  const maxIdx = Math.max(...related.map((f) => FIELD_ORDER.indexOf(f)).filter((i) => i >= 0));
  if (cur < maxIdx) return false;
  for (const f of related) {
    const idx = FIELD_ORDER.indexOf(f);
    if (idx <= cur && !(idea[f] || "").trim()) return false;
  }
  return true;
}

function constraintCoach(idea, step) {
  if (!constraintBlocking(idea, step)) return "";
  const { cons } = diceEntities(idea);
  if (!cons) return "";
  if (!constraintOk(idea, cons)) return cons.hint || "這三個限制都要出現在內容裡。";
  return "";
}

function sceneStepsFor(idea) {
  const steps = ["origin"];
  if (idea.origin === "dice") steps.push("theme");
  steps.push("who", "when", "incident", "behavior", "input", "output", "ruleDiagnosis", "ruleScreen", "ruleFiction", "preview");
  return steps;
}

function sceneErrors(idea) {
  const errs = [];
  if (!idea.origin) errs.push({ step: "origin", msg: "先點一個現場，或抽三個限制。" });
  if (idea.origin === "spark" && !idea.sparkId) errs.push({ step: "origin", msg: "先點一個現場。" });
  if (idea.origin === "dice" && !idea.theme) errs.push({ step: "theme", msg: "選主題。" });
  const checks = [
    ["who", coachWho],
    ["when", coachWhen],
    ["incident", coachIncident],
    ["behavior", coachBehavior],
  ];
  for (const [st, fn] of checks) {
    const m = fn(idea);
    if (m) errs.push({ step: st, msg: m });
  }
  const ci = coachInput(idea);
  if (ci) errs.push({ step: "input", msg: ci });
  const co = coachOutput(idea);
  if (co) errs.push({ step: "output", msg: co });
  if (!diceOk(idea)) errs.push({ step: "who", msg: "這三個限制都要出現。" });
  const c = idea.compliance || {};
  if (!c.noDiagnosis) errs.push({ step: "ruleDiagnosis", msg: "這句不能寫成病名。" });
  if (!c.sameScreen) errs.push({ step: "ruleScreen", msg: "免責句要和這句在同一頁。" });
  if (!c.fictional) errs.push({ step: "ruleFiction", msg: "展示要用虛構的例子。" });
  const fb = forkBlock(idea);
  if (fb) errs.push({ step: "who", msg: fb });
  return errs;
}

function framesReady(idea) {
  const frames = idea.frames || [];
  const shots = idea.shots || [];
  if (frames.length !== 4 || shots.length !== 3) return "四格畫面和三句說明都要補上。";
  const output = (idea.output || "").trim();
  const prefix = output.slice(0, 4);
  for (let index = 0; index < 4; index++) {
    const frame = frames[index] || {};
    const line = (frame.line || "").trim();
    const stickers = frame.stickers || [];
    const [lo, hi] = cat.limits.frame;
    if (line.length < lo || line.length > hi) return "每一格都要有一句說明。";
    if (!stickers.length || stickers.length > 3) return "每一格選 1 到 3 個圖。";
    if (line.startsWith("畫面")) return "「畫面」不用再寫。";
    if (wideProblem(line)) return "這格範圍太大。";
    if (index === 2 && prefix && !line.includes(prefix) && !line.includes(output)) {
      return "第三格要看得到輸出的前幾個字。";
    }
  }
  if (medicalProblem((frames[2] || {}).line || "")) return "第三格不要像診斷。";
  for (const shot of shots) {
    const text = (shot || "").trim();
    const [lo, hi] = cat.limits.shot;
    if (text.length < lo || text.length > hi) return "三句說明都要寫完。";
    if (text.startsWith("畫面")) return "「畫面」不用再寫。";
    if (wideProblem(text)) return "這句範圍太大。";
  }
  return "";
}

function votesFor(ideaId, authorId) {
  return (state.votes || []).filter((v) => v.ideaId === ideaId && v.voterId !== authorId);
}

function myVote(ideaId) {
  return (state.votes || []).find((v) => v.ideaId === ideaId && v.voterId === me.id);
}

function avgScore(ideaId, key, authorId) {
  const vs = votesFor(ideaId, authorId);
  if (!vs.length) return 0;
  return vs.reduce((a, v) => a + Number(v[key] || 0), 0) / vs.length;
}

function othersOnline(authorId) {
  return (state.people || []).filter((p) => p.id !== authorId && p.online);
}

function myMute(ideaId) {
  return (state.mutes || []).find((m) => m.ideaId === ideaId && m.personId === me.id);
}

function lockedOnWall() {
  return (state.ideas || []).some((i) => i.status === "locked");
}

function gateChecks(idea) {
  const items = [];
  const se = sceneErrors(idea);
  items.push({ ok: !se.length, label: "句子都夠具體" });
  const fr = framesReady(idea);
  items.push({ ok: !fr, label: "四格畫面都補了" });
  items.push({ ok: !(idea.shots || []).some((s) => !(s || "").trim()), label: "三句說明都寫了" });
  const c = idea.compliance || {};
  items.push({ ok: c.sameScreen && c.noDiagnosis && c.fictional, label: "三個規則都選了" });
  const others = othersOnline(idea.authorId);
  if (others.length) {
    const needed = Math.min(2, others.length);
    const vs = votesFor(idea.id, idea.authorId);
    items.push({ ok: vs.length >= needed, label: `至少 ${needed} 位隊友打分` });
    for (const key of ["visual", "focus", "creative", "demo"]) {
      const avg = avgScore(idea.id, key, idea.authorId);
      items.push({ ok: vs.length && avg >= 1.5, label: `${cat.rubric.find((r) => r.key === key).label}平均 ≥ 1.5` });
    }
    items.push({
      ok: vs.length && vs.every((v) => Number(v.compliance) === 2),
      label: "「規則」這一項每個人都給過",
    });
    const mutes = (state.mutes || []).filter((m) => m.ideaId === idea.id && m.personId !== idea.authorId);
    items.push({ ok: mutes.length > 0, label: "至少一位隊友寫過他看到什麼" });
  }
  return items;
}

function clientGateError(idea) {
  if (idea.status !== "published" && idea.status !== "locked") return "還沒給大家看。";
  const se = sceneErrors(idea);
  if (se.length) return se[0].msg;
  const fr = framesReady(idea);
  if (fr) return fr;
  const others = othersOnline(idea.authorId);
  if (!others.length) return "";
  const needed = Math.min(2, others.length);
  const vs = votesFor(idea.id, idea.authorId);
  if (vs.length < needed) return "還要隊友評分。";
  for (const key of ["visual", "focus", "creative", "demo"]) {
    if (avgScore(idea.id, key, idea.authorId) < 1.5) return "還有項目平均不到 1.5。";
  }
  if (vs.some((v) => Number(v.compliance) !== 2)) return "「規則」這一項要每位評分的人都給過。";
  const mutes = (state.mutes || []).filter((m) => m.ideaId === idea.id && m.personId !== idea.authorId);
  if (!mutes.length) return "至少要有一位隊友先看圖、寫下他看到什麼。";
  return "";
}

function authHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  const token = localStorage.getItem("aipets-token") || "";
  if (token) headers.Authorization = "Bearer " + token;
  return headers;
}

async function api(path, body) {
  const tokenAtSend = localStorage.getItem("aipets-token") || "";
  const res = await fetch(path, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body || {}),
  });
  if ((localStorage.getItem("aipets-token") || "") !== tokenAtSend) {
    const err = new Error("已退出。");
    err.stale = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    localStorage.removeItem("aipets-token");
    const err = new Error(data.error || "請先登錄。");
    err.login = true;
    throw err;
  }
  if (!data.ok) throw new Error(data.error || "連線失敗");
  if (data.me) me = data.me;
  if (data.slim) applyPeople(data);
  else if (data.state) applyState(data.state);
  return data;
}

function applyPeople(data) {
  if (!state || !Array.isArray(data.people)) return;
  if (typeof data.rev === "number" && data.rev !== rev) return;
  state.people = data.people;
  updatePeopleDots();
}

function applyState(st) {
  if (!st || typeof st.rev !== "number") return;
  if (st.rev < rev) return;
  const increased = st.rev > rev;
  rev = st.rev;
  state = st;
  if (!increased) {
    updatePeopleDots();
    return;
  }
  if (noteTyping() || wizard || detailEl || rulesOpen) {
    renderLater = true;
    updatePeopleDots();
    return;
  }
  if (drawerEl) {
    updatePeopleDots();
    if (selectedId && !(state.ideas || []).some((i) => i.id === selectedId)) closeDrawer();
    renderStage();
    return;
  }
  renderLater = false;
  renderAll();
}

function noteTyping() {
  const node = document.activeElement;
  if (!node || !node.closest) return false;
  if (!node.closest("#app, .shade")) return false;
  return node.tagName === "TEXTAREA" || node.tagName === "INPUT" || node.tagName === "SELECT";
}

function flushRender() {
  if (!renderLater || noteTyping() || wizard || detailEl || rulesOpen) return;
  renderLater = false;
  renderAll();
}

function personById(id) {
  return (state.people || []).find((p) => p.id === id);
}

function themeLabel(id) {
  const t = cat.themes.find((x) => x.id === id);
  return t ? t.label : id;
}

function sparkById(id) {
  return cat.sparks.find((s) => s.id === id);
}

function publishedCount(authorId, ignoreId) {
  return (state.ideas || []).filter(
    (i) => i.authorId === authorId && (i.status === "published" || i.status === "locked") && i.id !== ignoreId
  ).length;
}

function myDraft() {
  return (state.ideas || []).find((i) => i.authorId === me.id && i.status === "draft");
}

function blankIdea() {
  return {
    id: "",
    authorId: me.id,
    status: "draft",
    origin: "",
    sparkId: "",
    dice: null,
    theme: "",
    forkedFrom: "",
    who: "",
    whenWhere: "",
    incident: "",
    behavior: "",
    input: "",
    output: "",
    setting: "",
    situation: "",
    value: "",
    appeal: "",
    aiFit: "",
    frames: [{ stickers: [], line: "" }, { stickers: [], line: "" }, { stickers: [], line: "" }, { stickers: [], line: "" }],
    shots: ["", "", ""],
    compliance: { sameScreen: false, noDiagnosis: false, fictional: false },
    rehearsal: false,
  };
}

function cloneIdea(src) {
  return JSON.parse(JSON.stringify(src));
}

function scheduleDraft(idea) {
  if (!idea.origin) return;
  if (idea.status === "published" || idea.status === "locked") return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!me) return;
    draftChain = draftChain.then(() => {
      if (!me) return null;
      return api("/api/save", { personId: me.id, mode: "draft", idea }).then((d) => {
        if (!wizard || !me) return d;
        if (d.ideaId && !idea.id) wizard.idea.id = d.ideaId;
        return d;
      });
    });
  }, 600);
}

function svgNS(tag, attrs) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
  return n;
}

function stickerSvg(id) {
  const svg = svgNS("svg", { viewBox: "0 0 64 64", width: "28", height: "28" });
  const bg = svgNS("rect", { x: "4", y: "4", width: "56", height: "56", rx: "10", fill: "#fff8ee", stroke: "#1e1914", "stroke-width": "2" });
  svg.appendChild(bg);
  const g = svgNS("g", { fill: "#1e1914", stroke: "#1e1914" });
  const add = (node) => {
    g.appendChild(node);
  };
  switch (id) {
    case "person":
      add(svgNS("circle", { cx: "32", cy: "22", r: "8", fill: "#1e1914" }));
      add(svgNS("rect", { x: "22", y: "32", width: "20", height: "22", rx: "6", fill: "#1e1914" }));
      break;
    case "cat":
      add(svgNS("polygon", { points: "18,28 24,14 30,28", fill: "#1e1914" }));
      add(svgNS("polygon", { points: "34,28 40,14 46,28", fill: "#1e1914" }));
      add(svgNS("ellipse", { cx: "32", cy: "38", rx: "16", ry: "12", fill: "#1e1914" }));
      break;
    case "dog":
      add(svgNS("ellipse", { cx: "32", cy: "38", rx: "18", ry: "12", fill: "#1e1914" }));
      add(svgNS("circle", { cx: "32", cy: "24", r: "10", fill: "#1e1914" }));
      add(svgNS("rect", { x: "14", y: "26", width: "8", height: "14", rx: "3", fill: "#1e1914" }));
      break;
    case "phone":
      add(svgNS("rect", { x: "22", y: "12", width: "20", height: "40", rx: "4", fill: "none", "stroke-width": "3" }));
      add(svgNS("circle", { cx: "32", cy: "46", r: "2", fill: "#1e1914" }));
      break;
    case "clock":
      add(svgNS("circle", { cx: "32", cy: "34", r: "16", fill: "none", "stroke-width": "3" }));
      add(svgNS("line", { x1: "32", y1: "34", x2: "32", y2: "22", "stroke-width": "3" }));
      add(svgNS("line", { x1: "32", y1: "34", x2: "42", y2: "34", "stroke-width": "3" }));
      break;
    case "bed":
      add(svgNS("rect", { x: "12", y: "36", width: "40", height: "12", rx: "3", fill: "#1e1914" }));
      add(svgNS("rect", { x: "14", y: "28", width: "36", height: "10", rx: "3", fill: "none", "stroke-width": "2" }));
      break;
    case "clinic":
      add(svgNS("rect", { x: "28", y: "16", width: "8", height: "32", fill: "#1e1914" }));
      add(svgNS("rect", { x: "18", y: "28", width: "28", height: "8", fill: "#1e1914" }));
      break;
    case "note":
      add(svgNS("rect", { x: "16", y: "16", width: "32", height: "36", rx: "2", fill: "none", "stroke-width": "2" }));
      add(svgNS("line", { x1: "22", y1: "26", x2: "42", y2: "26", "stroke-width": "2" }));
      add(svgNS("line", { x1: "22", y1: "34", x2: "38", y2: "34", "stroke-width": "2" }));
      break;
    case "bowl":
      add(svgNS("ellipse", { cx: "32", cy: "38", rx: "18", ry: "8", fill: "none", "stroke-width": "3" }));
      add(svgNS("path", { d: "M14 38 Q32 52 50 38", fill: "none", "stroke-width": "3" }));
      break;
    case "door":
      add(svgNS("rect", { x: "18", y: "14", width: "28", height: "42", rx: "2", fill: "none", "stroke-width": "3" }));
      add(svgNS("circle", { cx: "40", cy: "36", r: "3", fill: "#1e1914" }));
      break;
    case "search":
      add(svgNS("circle", { cx: "28", cy: "28", r: "12", fill: "none", "stroke-width": "3" }));
      add(svgNS("line", { x1: "36", y1: "36", x2: "48", y2: "48", "stroke-width": "4" }));
      break;
    case "card":
      add(svgNS("rect", { x: "16", y: "18", width: "32", height: "28", rx: "4", fill: "none", "stroke-width": "3" }));
      add(svgNS("line", { x1: "22", y1: "28", x2: "42", y2: "28", "stroke-width": "2" }));
      break;
    case "night":
      add(svgNS("path", { d: "M40 18 A16 16 0 1 1 28 46 A12 12 0 0 0 40 18", fill: "#1e1914" }));
      break;
    case "stairs":
      for (let i = 0; i < 4; i++) {
        add(svgNS("rect", { x: 14 + i * 8, y: 44 - i * 8, width: 24 - i * 8, height: "8", fill: "#1e1914" }));
      }
      break;
    case "table":
      add(svgNS("rect", { x: "12", y: "28", width: "40", height: "6", rx: "2", fill: "#1e1914" }));
      add(svgNS("rect", { x: "16", y: "34", width: "4", height: "16", fill: "#1e1914" }));
      add(svgNS("rect", { x: "44", y: "34", width: "4", height: "16", fill: "#1e1914" }));
      break;
    case "cage":
      add(svgNS("rect", { x: "14", y: "18", width: "36", height: "32", rx: "4", fill: "none", "stroke-width": "2" }));
      for (let x = 22; x <= 42; x += 8) {
        add(svgNS("line", { x1: String(x), y1: "18", x2: String(x), y2: "50", "stroke-width": "2" }));
      }
      break;
    default:
      add(svgNS("circle", { cx: "32", cy: "32", r: "10", fill: "#1e1914" }));
  }
  svg.appendChild(g);
  return svg;
}

function fillPreviewCard(card, idea, opts) {
  opts = opts || {};
  clear(card);
  const picked = idea.origin === "spark" ? sparkById(idea.sparkId) : null;
  if (!picked && !idea.who && !idea.whenWhere && !idea.incident && !idea.behavior && !idea.input && !idea.output) {
    return;
  }
  if (idea.theme) card.appendChild(el("div", "kicker", themeLabel(idea.theme)));
  if (picked && !idea.incident) {
    card.appendChild(el("div", "field-label", "你點的現場"));
    card.appendChild(el("div", "scene", picked.picture));
    card.appendChild(el("div", "muted", picked.clock + "｜" + picked.place));
    card.appendChild(el("p", "muted", "下一題改成你們自己的人、時間，和他正在做的事。"));
    return;
  }
  if (picked) card.appendChild(el("p", "muted", "從「" + picked.place + "」這個情境改來的。"));
  let when = idea.whenWhere;
  if (!when && picked) when = picked.clock;
  if (when) {
    card.appendChild(el("div", "field-label", "時間地點"));
    card.appendChild(el("div", "muted", when));
  }
  card.appendChild(el("div", "field-label", "發生的事"));
  const scene = el("div", "scene", idea.incident || "還沒寫");
  card.appendChild(scene);
  card.appendChild(ioBlock(idea.input, idea.output));
  if (opts.frames && idea.frames) {
    const fr = el("div", "frames");
    idea.frames.forEach((f, i) => {
      const frame = el("div", "frame");
      const row = el("div", "sticker-row");
      (f.stickers || []).forEach((sid) => {
        const st = el("span", "sticker");
        st.appendChild(stickerSvg(sid));
        row.appendChild(st);
      });
      frame.appendChild(row);
      frame.appendChild(el("div", "", "畫面" + (f.line || "")));
      fr.appendChild(frame);
    });
    card.appendChild(fr);
  }
}

function exampleBox(kind, text) {
  const box = el("div", "ex " + kind);
  box.appendChild(el("small", "", kind === "bad" ? "不要這樣寫" : "只看寫法，不必照這個故事"));
  box.appendChild(document.createTextNode(text));
  return box;
}

function ioBlock(input, output) {
  const io = el("div", "io");
  const left = el("div", "");
  left.appendChild(el("div", "field-label", "他提供的"));
  left.appendChild(el("div", "", input || "還沒寫"));
  const right = el("div", "");
  right.appendChild(el("div", "field-label", "畫面回他的"));
  right.appendChild(el("div", "", output || "還沒寫"));
  io.appendChild(left);
  io.appendChild(el("div", "arrow", "→"));
  io.appendChild(right);
  return io;
}

function nowTask() {
  if (viewMode === "park") {
    return {
      title: "這些先不討論",
      body: "要繼續寫或評分，按「回到想法」。",
    };
  }
  if (state.phase === "score") {
    return {
      title: "打開別人的想法來評分",
      body: "點一則想法，五項都要選。自己的不能自己評。",
    };
  }
  if (state.phase === "story") {
    return {
      title: "補上使用過程",
      body: "點自己的想法，按「補上畫面」。一次補一格。",
    };
  }
  if (state.phase === "mute") {
    return {
      title: "先看圖，寫下你看到什麼",
      body: "點別人的想法。文字會先遮住，寫完才看得到原文。",
    };
  }
  if (state.phase === "lock") {
    return {
      title: "選定一則拿去提案",
      body: "只留一則。由寫的人按「選定這則」。",
    };
  }
  return {
    title: "先寫一則想法",
    body: "四個主題都在下面。寫一句要做的事，貼上牆，再評分。",
  };
}

function joinStep(n, label) {
  const button = el("button", "join-step");
  button.type = "button";
  button.appendChild(el("b", "", n));
  button.appendChild(el("span", "", label));
  return button;
}

function renderPassword(root) {
  clear(root);
  const gate = el("div", "gate center");
  gate.appendChild(el("h1", "", "法國皇家 AI for Pets 創新徵件計畫"));
  gate.appendChild(el("p", "quote", "請輸入密碼以登入"));
  const inp = el("input", "");
  inp.type = "password";
  inp.autocomplete = "current-password";
  inp.setAttribute("aria-label", "密碼");
  gate.appendChild(inp);
  const btn = el("button", "btn primary", "登錄");
  async function submit() {
    const password = inp.value.trim();
    if (!password) {
      toast("請輸入組員密碼。");
      return;
    }
    btn.disabled = true;
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok || !data.token) throw new Error(data.error || "密碼不對。");
      localStorage.setItem("aipets-token", data.token);
      await enterWall();
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
      inp.focus();
    }
  }
  btn.addEventListener("click", submit);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  gate.appendChild(btn);
  root.appendChild(gate);
  inp.focus();
}

async function renderJoin(root) {
  clear(root);
  let faces = { colors: [], people: [], nicknames: [] };
  try {
    const res = await fetch("/api/faces", { headers: authHeaders() });
    if (res.status === 401) {
      localStorage.removeItem("aipets-token");
      renderPassword(root);
      return;
    }
    if (res.ok) faces = await res.json();
  } catch {
    faces = { colors: [], people: [], nicknames: cat.nicknames || [] };
  }
  const taken = new Set((faces.people || []).map((person) => person.color));
  const colors = faces.colors || [];
  const gate = el("div", "gate center");
  gate.appendChild(el("h1", "", "發想牆"));
  const themes = el("div", "join-themes");
  cat.themes.forEach((th, index) => {
    const row = el("div", "join-theme");
    row.appendChild(el("span", "theme-mark", THEME_MARKS[index] || "主題"));
    row.appendChild(el("span", "", th.full));
    themes.appendChild(row);
  });
  gate.appendChild(themes);
  const stepNick = joinStep("1", "選暱稱");
  const stepColor = joinStep("2", "選顏色");
  const stepEnter = joinStep("3", "進入");
  const flow = el("div", "join-flow");
  flow.appendChild(stepNick);
  flow.appendChild(stepColor);
  flow.appendChild(stepEnter);
  gate.appendChild(flow);
  const known = new Map();
  (faces.people || []).forEach((person) => {
    if (person.name && !known.has(person.name)) known.set(person.name, person);
  });
  if ((faces.people || []).length) {
    const here = el("div", "join-here");
    here.appendChild(el("div", "field-label", "點名稱接回進度"));
    const row = el("div", "people");
    faces.people.forEach((person) => {
      const chip = el("button", "person-chip");
      chip.type = "button";
      const dot = el("span", "dot");
      dot.style.background = person.color || "#6d6256";
      dot.textContent = (person.name || "?").slice(0, 1);
      chip.appendChild(dot);
      chip.appendChild(el("span", "", person.name || ""));
      chip.addEventListener("click", () => chooseName(person.name || ""));
      row.appendChild(chip);
    });
    here.appendChild(row);
    gate.appendChild(here);
  }
  gate.appendChild(el("label", "field-label", "選一個暱稱"));
  gate.appendChild(el("p", "hint", "選之前用過的名稱，會接回那個人的提案、草稿和評分。"));
  const picks = el("div", "nick-picks");
  const inp = el("input", "");
  inp.maxLength = cat.limits.name[1];
  inp.placeholder = "或自己取一個";
  let chosen = "";
  function chooseName(name) {
    chosen = name;
    inp.value = name;
    picks.querySelectorAll(".nick-pick").forEach((node) => node.classList.toggle("on", node.textContent === name));
    paintPreview();
  }
  (faces.nicknames || cat.nicknames || []).forEach((name) => {
    const chip = el("button", "btn tiny nick-pick", name);
    chip.type = "button";
    chip.addEventListener("click", () => chooseName(name));
    picks.appendChild(chip);
  });
  gate.appendChild(picks);
  gate.appendChild(inp);
  const resumeNote = el("p", "hint", "");
  resumeNote.hidden = true;
  gate.appendChild(resumeNote);
  const colorLabel = el("label", "field-label", "頭像顏色");
  gate.appendChild(colorLabel);
  const swatches = el("div", "color-picks");
  let color = colors.find((item) => !taken.has(item)) || colors[0] || "";
  colors.forEach((item) => {
    const button = el("button", "color-pick" + (item === color ? " on" : ""));
    button.type = "button";
    button.dataset.color = item;
    button.style.background = item;
    button.disabled = taken.has(item);
    button.title = taken.has(item) ? "這個顏色已經有人用了" : "選這個顏色";
    button.addEventListener("click", () => {
      if (known.get(inp.value.trim())) return;
      color = item;
      swatches.querySelectorAll(".color-pick").forEach((node) => node.classList.toggle("on", node === button));
      paintPreview();
    });
    swatches.appendChild(button);
  });
  gate.appendChild(swatches);
  const preview = el("div", "join-preview");
  const previewDot = el("span", "dot");
  const previewName = el("span", "", "你的頭像");
  preview.appendChild(previewDot);
  preview.appendChild(previewName);
  gate.appendChild(preview);
  function paintPreview() {
    const person = known.get(inp.value.trim());
    if (person && person.color) color = person.color;
    else if (taken.has(color)) color = colors.find((item) => !taken.has(item)) || "";
    const name = (inp.value || chosen || "你").trim();
    previewDot.style.background = color || "#6d6256";
    previewDot.textContent = name.slice(0, 1) || "你";
    previewName.textContent = name || "你的頭像";
    swatches.querySelectorAll(".color-pick").forEach((node) => {
      const item = node.dataset.color;
      const mine = !!(person && item === person.color);
      node.disabled = person ? !mine : taken.has(item);
      node.classList.toggle("on", person ? mine : item === color);
      node.title = person
        ? (mine ? "沿用之前的頭像顏色" : "找回這個名稱時，頭像顏色沿用")
        : (taken.has(item) ? "這個顏色已經有人用了" : "選這個顏色");
    });
    colorLabel.textContent = person ? "沿用之前的頭像顏色" : "頭像顏色";
    resumeNote.hidden = !person;
    resumeNote.textContent = person ? "會接回這個名稱的提案、草稿和評分。" : "";
  }
  inp.addEventListener("input", () => {
    picks.querySelectorAll(".nick-pick").forEach((node) => node.classList.toggle("on", node.textContent === inp.value.trim()));
    paintPreview();
  });
  paintPreview();
  stepNick.addEventListener("click", () => {
    picks.scrollIntoView({ behavior: "smooth", block: "center" });
    inp.focus();
  });
  stepColor.addEventListener("click", () => {
    swatches.scrollIntoView({ behavior: "smooth", block: "center" });
    const open = swatches.querySelector(".color-pick:not(:disabled)");
    if (open) open.focus();
  });
  const btn = el("button", "btn primary", "進入發想牆");
  stepEnter.addEventListener("click", () => btn.click());
  btn.addEventListener("click", async () => {
    const name = inp.value.trim();
    if (name.length < cat.limits.name[0]) {
      toast("請選一個暱稱，或自己取一個。");
      return;
    }
    try {
      const data = await api("/api/join", { name, color });
      me = data.me;
      localStorage.setItem("aipets-name", me.name);
      localStorage.setItem("aipets-id", me.id);
      renderAll();
      startPoll();
    } catch (e) {
      toast(e.message);
    }
  });
  gate.appendChild(btn);
  root.appendChild(gate);
}

function weekList() {
  return (state && state.weeks) || [];
}

function currentWeek() {
  const weeks = weekList();
  return weeks.find((week) => week.id === state.weekId) || weeks[0] || null;
}

function onWallWeek() {
  return !currentWeek() || currentWeek().kind !== "meeting";
}

function meetCopy() {
  return (cat && cat.meeting) || {};
}

async function meetOp(op, extra) {
  try {
    await api("/api/meeting", Object.assign({ personId: me.id, op }, extra || {}));
    renderAll();
  } catch (e) {
    toast(e.message);
  }
}

async function goWeek(weekId) {
  if (!state || state.weekId === weekId) return;
  if (wizard) closeWizard();
  if (detailEl) closeDetail();
  closeModal();
  if (drawerEl) closeDrawer();
  await meetOp("switch", { weekId });
}

function renderHeader() {
  let top = $(".topbar");
  if (!top) {
    top = el("div", "topbar");
    $("#app").prepend(top);
  }
  clear(top);
  const week = currentWeek();
  const wall = onWallWeek();
  const brand = el("div", "brand");
  brand.appendChild(el("div", "mark"));
  const titles = el("div", "");
  titles.appendChild(el("h1", "", wall ? "發想牆" : (week && week.title) || "會議"));
  titles.appendChild(el("p", "", wall ? "四個主題，貼提案、一起評分" : (meetCopy().subtitle || "本週應完成、會議紀錄、決定與待辦")));
  brand.appendChild(titles);
  document.title = wall ? "發想牆" : ((week && week.title) || "會議");

  const actions = el("div", "actions");
  if (wall) {
    const inTally = viewMode === "tally";
    const room = el("button", "btn tiny" + (inTally ? " primary" : ""), inTally ? (openTheme ? "回到主題" : "回到大廳") : "評分室");
    room.addEventListener("click", () => {
      viewMode = inTally ? "wall" : "tally";
      renderAll();
    });
    actions.appendChild(room);
  }
  const rules = el("button", "btn tiny", "競賽規則");
  rules.addEventListener("click", () => openListModal("競賽規則", cat.boundaries));
  actions.appendChild(rules);
  if (scheduleData()) {
    const schedule = el("button", "btn tiny", "徵件時程");
    schedule.addEventListener("click", openScheduleModal);
    actions.appendChild(schedule);
  }
  const copy = el("button", "btn tiny", "複製網址給組員");
  copy.addEventListener("click", async () => {
    let url = location.href;
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      const host = location.hostname;
      if (data.publicUrl && (host === "127.0.0.1" || host === "localhost")) url = data.publicUrl;
    } catch {
      /* 用網址列上的那條 */
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("已複製網址");
    } catch {
      toast(url);
    }
  });
  actions.appendChild(copy);
  const right = el("div", "top-right");
  right.appendChild(actions);
  const main = el("div", "top-main");
  main.appendChild(brand);
  main.appendChild(right);
  top.appendChild(main);

  const bar = el("div", "weekbar");
  bar.appendChild(el("span", "week-label", "週次"));
  const weeks = el("div", "weeks");
  weekList().forEach((item) => {
    const on = item.id === state.weekId;
    const btn = el("button", "week-tab" + (on ? " on" : ""), item.title || "週次");
    btn.type = "button";
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.addEventListener("click", () => goWeek(item.id));
    weeks.appendChild(btn);
  });
  bar.appendChild(weeks);
  if (me && state.facilitatorId === me.id && weekList().length < 12) {
    const add = el("button", "week-add", meetCopy().addWeek || "加下一週");
    add.type = "button";
    add.addEventListener("click", () => meetOp("add"));
    bar.appendChild(add);
  }
  top.appendChild(bar);

  const people = el("div", "people");
  right.appendChild(people);
  const leave = el("button", "btn tiny danger", "退出");
  leave.type = "button";
  leave.title = "退出後要重新輸入組員密碼";
  leave.addEventListener("click", openSignOut);
  right.appendChild(leave);
  updatePeopleDots();
}

function openSignOut() {
  const box = el("div", "");
  box.appendChild(el("h2", "", "退出發想牆"));
  box.appendChild(el("p", "", "這台電腦要重新輸入組員密碼才能再進來。牆上的提案會留著。"));
  const row = el("div", "row");
  const stay = el("button", "btn tiny", "再留一下");
  stay.type = "button";
  stay.addEventListener("click", closeModal);
  const go = el("button", "btn tiny danger", "退出");
  go.type = "button";
  go.addEventListener("click", signOut);
  row.appendChild(stay);
  row.appendChild(go);
  box.appendChild(row);
  mountModal().appendChild(box);
}

function signOut() {
  clearInterval(pollTimer);
  pollTimer = null;
  clearTimeout(draftTimer);
  draftTimer = null;
  localStorage.removeItem("aipets-token");
  localStorage.removeItem("aipets-name");
  localStorage.removeItem("aipets-id");
  document.body.classList.remove("writing");
  document.querySelectorAll(".shade").forEach((node) => node.remove());
  wizard = null;
  draftChain = Promise.resolve();
  drawerEl = null;
  detailEl = null;
  modalEl = null;
  rulesOpen = false;
  renderLater = false;
  selectedId = null;
  sparkHoverId = null;
  openTheme = "";
  viewMode = "wall";
  me = null;
  state = null;
  rev = 0;
  renderPassword($("#app"));
}

function updatePeopleDots() {
  const people = $(".people");
  if (!people || !state) return;
  clear(people);
  const online = (state.people || []).filter((p) => p.online);
  for (const p of state.people || []) {
    const chip = el("span", "person-chip" + (p.online ? "" : " off"));
    const d = el("span", "dot");
    d.style.background = p.color || "#6d6256";
    d.textContent = (p.name || "?").slice(0, 1);
    chip.appendChild(d);
    chip.appendChild(el("span", "person-name", p.name || ""));
    chip.title = p.name;
    people.appendChild(chip);
  }
  if (online.length === 1) people.appendChild(el("span", "muted", "把網址貼給組員。"));
}

function renderPhaseBar() {
  document.querySelectorAll(".phasebar").forEach((n) => n.remove());
}

async function setPhase(phase) {
  try {
    await api("/api/phase", { personId: me.id, phase });
  } catch (e) {
    toast(e.message);
  }
}

function wallIdeas() {
  const list = (state.ideas || []).filter((i) => i.status === "published" || i.status === "locked");
  list.sort((a, b) => {
    if (a.status === "locked" && b.status !== "locked") return -1;
    if (b.status === "locked" && a.status !== "locked") return 1;
    return 0;
  });
  return list;
}

function cardRibbon(idea) {
  if (state.phase === "score" && idea.authorId !== me.id && !myVote(idea.id)) {
    return "你還沒評這則";
  }
  if (state.phase === "story" && idea.authorId === me.id && framesReady(idea)) {
    return "請補上使用過程";
  }
  if (state.phase === "mute" && idea.authorId !== me.id && !myMute(idea.id)) {
    return "先寫你看到什麼";
  }
  return "";
}

function shouldHideText(idea) {
  return state.phase === "mute" && idea.authorId !== me.id && !myMute(idea.id);
}

function buildCard(idea) {
  const card = el("article", "card");
  if (idea.status === "locked") {
    const rib = el("div", "ribbon", "已選定");
    card.appendChild(rib);
  }
  const ribbonText = cardRibbon(idea);
  if (ribbonText) card.appendChild(el("div", "ribbon", ribbonText));

  card.appendChild(el("div", "kicker", themeLabel(idea.theme)));
  const hide = shouldHideText(idea);
  if (!hide) {
    card.appendChild(el("div", "field-label", "誰"));
    card.appendChild(el("div", "muted", idea.who || "還沒寫"));
    card.appendChild(el("div", "field-label", "時間地點"));
    card.appendChild(el("div", "muted", idea.whenWhere || "還沒寫"));
    card.appendChild(el("div", "field-label", "行為"));
    card.appendChild(el("div", "muted", idea.behavior || "還沒寫"));
    card.appendChild(el("div", "field-label", "發生的事"));
    card.appendChild(el("div", "scene", idea.incident || ""));
    card.appendChild(ioBlock(idea.input, idea.output));
  } else {
    const row = el("div", "sticker-row");
    const stickers = new Set();
    (idea.frames || []).forEach((f) => (f.stickers || []).forEach((s) => stickers.add(s)));
    if (!stickers.size && idea.origin === "spark") {
      const sp = sparkById(idea.sparkId);
      (sp?.stickers || []).forEach((s) => stickers.add(s));
    }
    stickers.forEach((sid) => {
      const st = el("span", "sticker");
      st.appendChild(stickerSvg(sid));
      row.appendChild(st);
    });
    card.appendChild(row);
    card.appendChild(el("div", "block", "我看到的是"));
  }

  const voted = votesFor(idea.id, idea.authorId);
  if (!voted.length) {
    card.appendChild(el("div", "field-label", "還沒有人評分。點開這則就能評。"));
  } else {
    const meterRow = el("div", "row");
    for (const r of cat.rubric) {
      const avg = avgScore(idea.id, r.key, idea.authorId);
      meterRow.appendChild(el("div", "meter", r.label + " " + avg.toFixed(1)));
    }
    card.appendChild(meterRow);
  }

  const stamps = el("div", "stamps");
  if (idea.compliance?.noDiagnosis) stamps.appendChild(el("span", "stamp ok", "不診斷"));
  if (idea.compliance?.sameScreen) stamps.appendChild(el("span", "stamp ok", "免責在同一頁"));
  if (idea.compliance?.fictional) stamps.appendChild(el("span", "stamp ok", "虛構例子"));
  if (!idea.byAi && framesReady(idea)) stamps.appendChild(el("span", "stamp bad", "還沒補畫面"));
  card.appendChild(stamps);

  card.addEventListener("click", () => openDrawer(idea.id));
  return card;
}

function renderPrivateStrip(stage) {
  const drafts = (state.ideas || []).filter((i) => i.authorId === me.id && i.status === "draft");
  if (!drafts.length) return;
  const strip = el("div", "private");
  strip.appendChild(el("span", "muted", "你的草稿"));
  drafts.forEach((d) => {
    const row = el("div", "row");
    row.appendChild(el("span", "", d.incident || "寫到一半"));
    const drop = el("button", "btn tiny danger", "丟掉");
    drop.addEventListener("click", (e) => {
      e.stopPropagation();
      api("/api/discard", { personId: me.id, ideaId: d.id }).catch((err) => toast(err.message));
    });
    row.appendChild(drop);
    strip.appendChild(row);
  });
  stage.appendChild(strip);
}

function byCreated(a, b) {
  return (a.createdAt || "").localeCompare(b.createdAt || "") || a.id.localeCompare(b.id);
}

function ideasInTheme(themeId) {
  return wallIdeas()
    .filter((idea) => idea.theme === themeId)
    .sort(byCreated);
}

function proposalNo(idea) {
  const mates = wallIdeas().slice().sort(byCreated);
  const index = mates.findIndex((item) => item.id === idea.id);
  const n = index < 0 ? 1 : index + 1;
  const digits = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  let label = String(n);
  if (n <= 10) label = n === 10 ? "十" : digits[n];
  else if (n < 20) label = "十" + digits[n - 10];
  else if (n === 20) label = "二十";
  return "提案" + label;
}

function proposalMark(idea) {
  const theme = (cat.themes || []).find((item) => item.id === idea.theme);
  return proposalNo(idea) + (theme && theme.label ? " · " + theme.label : "");
}

function authorLabel(idea) {
  if (idea.byAi) return "AI";
  return personById(idea.authorId)?.name || "組員";
}

function authorBadge(idea) {
  const person = idea.byAi ? null : personById(idea.authorId);
  const badge = el("span", "author-badge");
  badge.style.background = idea.byAi ? "#243e5a" : (person && person.color) || "#1c1917";
  badge.appendChild(el("span", "who", "提案者"));
  badge.appendChild(el("span", "who-name", authorLabel(idea)));
  return badge;
}

function voterLabel(voterId) {
  const person = personById(voterId);
  const name = (person && person.name) || "已離開的人";
  return voterId === me.id ? name + "（你）" : name;
}

function appendRoster(card, idea) {
  const ratings = ratingsFor(idea);
  const box = el("div", "roster");
  box.appendChild(el("div", "field-label", ratings.length ? "評了這則" : "還沒有人評這則"));
  if (!ratings.length) {
    card.appendChild(box);
    return;
  }
  const names = el("div", "roster-names");
  ratings.forEach((item) => {
    const mean = personMean(idea, item.voterId);
    const text = voterLabel(item.voterId) + (mean == null ? "" : " · " + formatScore(mean) + " 分");
    names.appendChild(el("span", "voter" + (item.voterId === me.id ? " mine" : ""), text));
  });
  box.appendChild(names);
  card.appendChild(box);
}

function buildPitchCard(idea) {
  const card = el("article", "card pitch");
  const head = el("div", "pitch-head");
  head.appendChild(el("div", "proposal-mark", proposalMark(idea)));
  head.appendChild(authorBadge(idea));
  card.appendChild(head);
  if (idea.title) card.appendChild(el("h4", "proposal-title", idea.title));
  card.appendChild(el("p", "scene", idea.incident || ""));
  if (viewMode === "tally") {
    appendHeat(card, idea);
    appendRoster(card, idea);
  } else {
    const meta = el("div", "row");
    meta.appendChild(el("span", "muted", heatLine(idea)));
    if (idea.status === "locked") meta.appendChild(el("span", "stamp ok", "已選定"));
    card.appendChild(meta);
  }
  const actions = el("div", "row");
  const detail = el("button", "btn tiny", "詳細資訊");
  detail.addEventListener("click", (event) => {
    event.stopPropagation();
    openDetail(idea.id);
  });
  actions.appendChild(detail);
  card.appendChild(actions);
  return card;
}

async function postThemeIdea(themeId, text) {
  const sentence = text.trim();
  const [lo, hi] = cat.limits.incident;
  if (sentence.length < lo) {
    toast("寫一句，至少 " + lo + " 個字。");
    return;
  }
  if (sentence.length > hi) {
    toast("一句就好，" + hi + " 個字以內。");
    return;
  }
  if (myDraft()) {
    toast("還有一則寫到一半。先丟掉再貼。");
    return;
  }
  if (publishedCount(me.id, "") >= 3) {
    toast("已經有三則。");
    return;
  }
  if (await ensureWriteRules()) {
    await publishThemeIdea(themeId, sentence);
  }
}

function ownProposal() {
  return (state.ideas || []).some((idea) => idea.authorId === me.id && (idea.status === "published" || idea.status === "locked"));
}

function writeRuleLines() {
  const lines = (cat.boundaries || []).filter((line) => line.startsWith("作品停在照護提醒") || line.startsWith("展示時用虛構"));
  if (lines.length) return lines;
  return [
    "作品停在照護提醒：不能診斷、治療、治癒、預防特定疾病，也不能取代獸醫。",
    "展示時用虛構的人或動物。真實病歷、收容資料、飼主資料，要有授權才可以用。",
  ];
}

function ensureWriteRules() {
  if (!me || rulesOpen) return Promise.resolve(false);
  if (ownProposal() || localStorage.getItem("aipets-write-rules-" + me.id) === "1") return Promise.resolve(true);
  rulesOpen = true;
  return new Promise((resolve) => {
    const shade = el("div", "shade center");
    const modal = el("div", "modal");
    shade.appendChild(modal);
    modal.appendChild(el("h2", "", "第一次寫提案"));
    modal.appendChild(el("p", "muted", "貼上去之前，先看這兩條。"));
    const list = el("ol", "write-rules");
    writeRuleLines().forEach((line) => list.appendChild(el("li", "", line)));
    modal.appendChild(list);
    const row = el("div", "row");
    const ok = el("button", "btn primary", "知道了，貼上");
    const cancel = el("button", "btn", "先不要");
    const finish = (accepted) => {
      if (accepted) localStorage.setItem("aipets-write-rules-" + me.id, "1");
      rulesOpen = false;
      shade.remove();
      resolve(accepted);
      flushRender();
    };
    ok.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
    shade.addEventListener("click", (event) => {
      if (event.target === shade) finish(false);
    });
    row.appendChild(ok);
    row.appendChild(cancel);
    modal.appendChild(row);
    document.body.appendChild(shade);
    ok.focus();
  });
}

async function publishThemeIdea(themeId, sentence) {
  const idea = blankIdea();
  idea.origin = "theme";
  idea.theme = themeId;
  idea.incident = sentence;
  try {
    await api("/api/save", { personId: me.id, mode: "publish", idea });
    toast("已貼上牆");
  } catch (err) {
    toast(err.message);
  }
}

function openDetail(id) {
  const idea = (state.ideas || []).find((item) => item.id === id);
  if (!idea) return;
  closeDetail();
  const shade = el("div", "shade center");
  shade.addEventListener("click", (event) => {
    if (event.target === shade) closeDetail();
  });
  detailEl = el("div", "modal");
  shade.appendChild(detailEl);
  document.body.appendChild(shade);
  const theme = cat.themes.find((item) => item.id === idea.theme);
  detailEl.appendChild(el("div", "kicker", theme ? theme.full : "提案"));
  const head = el("div", "pitch-head");
  head.appendChild(el("div", "proposal-mark", proposalMark(idea)));
  head.appendChild(authorBadge(idea));
  detailEl.appendChild(head);
  detailEl.appendChild(el("h2", "", idea.title || "詳細資訊"));
  const mine = idea.authorId === me.id;
  if (!mine) {
    detailEl.appendChild(el("p", "scene", idea.incident || ""));
    detailEl.appendChild(el("p", "muted", "要補內容，由寫的人來。"));
    detailFields().forEach(([key, label]) => {
      const value = idea[key];
      if (!value) return;
      detailEl.appendChild(el("div", "field-label", label));
      detailEl.appendChild(el("p", "detail-text", value));
    });
    appendScore(detailEl, idea);
    const leave = el("button", "btn", "關閉");
    leave.addEventListener("click", () => closeDetail());
    detailEl.appendChild(leave);
    return;
  }
  detailEl.appendChild(el("p", "muted", "這句是牆上的想法。下面是拿去寫提案用的，現在可以先空著。"));
  const sentence = el("textarea", "");
  sentence.value = idea.incident || "";
  sentence.maxLength = cat.limits.incident[1];
  detailEl.appendChild(el("label", "field-label", "這一則要做什麼"));
  detailEl.appendChild(sentence);
  const fields = detailFields();
  const inputs = {};
  const detailLimit = (cat.limits && cat.limits.detail && cat.limits.detail[1]) || 320;
  fields.forEach(([key, label, hint]) => {
    const box = el("textarea", "");
    box.value = idea[key] || "";
    box.rows = 3;
    box.maxLength = detailLimit;
    inputs[key] = box;
    detailEl.appendChild(el("label", "field-label", label));
    if (hint) detailEl.appendChild(el("p", "field-hint", hint));
    detailEl.appendChild(box);
  });
  appendScore(detailEl, idea);
  const save = el("button", "btn primary", "存起來");
  save.addEventListener("click", async () => {
    const next = cloneIdea(idea);
    if (next.origin !== "spark" && next.origin !== "dice") next.origin = "theme";
    next.incident = sentence.value.trim();
    fields.forEach(([key]) => {
      next[key] = inputs[key].value.trim();
    });
    try {
      await api("/api/save", { personId: me.id, mode: "publish", idea: next });
      closeDetail();
      toast("已存好");
    } catch (err) {
      toast(err.message);
    }
  });
  const leave = el("button", "btn", "先不要");
  leave.addEventListener("click", () => closeDetail());
  const row = el("div", "row");
  row.appendChild(save);
  row.appendChild(leave);
  detailEl.appendChild(row);
}

function detailFields() {
  const fromCat = Array.isArray(cat.detailFields) ? cat.detailFields : [];
  const usable = fromCat.filter((item) => item && DETAIL_FIELDS.some(([key]) => key === item.key) && item.label);
  if (usable.length) return usable.map((item) => [item.key, item.label, item.hint || ""]);
  return DETAIL_FIELDS;
}

function closeDetail() {
  if (!detailEl) return;
  const shade = detailEl.parentElement;
  if (shade && shade.classList.contains("shade")) shade.remove();
  else detailEl.remove();
  detailEl = null;
  flushRender();
}

function renderLobby(stage) {
  renderPrivateStrip(stage);
  const intro = el("div", "board-intro");
  intro.appendChild(el("h2", "", "選一個主題"));
  intro.appendChild(el("p", "", "點進主題看提案，也可以自己寫一句。哪幾件平均分比較高，到評分室看。"));
  const official = el("p", "lobby-official");
  official.appendChild(document.createTextNode("徵件頁 "));
  const link = el("a", "lobby-link", "https://bhuntr.com/tw/competitions/AIforPets");
  link.href = "https://bhuntr.com/tw/competitions/AIforPets";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  official.appendChild(link);
  intro.appendChild(official);
  stage.appendChild(intro);
  renderSchedule(stage);
  const grid = el("div", "lobby-grid");
  cat.themes.forEach((theme, index) => {
    const door = el("button", "door");
    door.type = "button";
    door.appendChild(el("span", "theme-mark", THEME_MARKS[index] || "主題"));
    door.appendChild(el("h3", "", theme.full || theme.label));
    if (theme.blurb) door.appendChild(el("p", "", theme.blurb));
    const count = ideasInTheme(theme.id).length;
    door.appendChild(el("p", "door-count", count ? count + " 件提案" : "還沒有提案"));
    door.addEventListener("click", () => {
      openTheme = theme.id;
      viewMode = "wall";
      renderAll();
    });
    grid.appendChild(door);
  });
  stage.appendChild(grid);
  const rank = el("button", "door vote");
  rank.type = "button";
  rank.appendChild(el("h3", "", "評分室"));
  rank.appendChild(el("p", "", "看平均分排行，也可以改自己的分數。"));
  rank.addEventListener("click", () => {
    viewMode = "tally";
    renderAll();
  });
  stage.appendChild(rank);
}

function renderWall(stage) {
  const theme = cat.themes.find((item) => item.id === openTheme);
  const index = cat.themes.indexOf(theme);
  if (!theme || index < 0) {
    openTheme = "";
    renderLobby(stage);
    return;
  }
  renderPrivateStrip(stage);
  const back = el("button", "back-lobby", "← 回到大廳");
  back.addEventListener("click", () => {
    openTheme = "";
    viewMode = "wall";
    renderAll();
  });
  stage.appendChild(back);
  const section = el("section", "theme-board");
  const head = el("div", "theme-head");
  head.appendChild(el("div", "theme-mark", THEME_MARKS[index] || "主題"));
  head.appendChild(el("h3", "", theme.full || theme.label));
  const en = String(theme.en || "").split("｜")[0].trim();
  if (en) head.appendChild(el("p", "theme-en", en));
  if (theme.blurb) head.appendChild(el("p", "theme-sub", theme.blurb));
  section.appendChild(head);
  section.appendChild(el("div", "field-label", "建議方向"));
  section.appendChild(el("p", "", theme.direction || ""));
  section.appendChild(el("div", "field-label", "範例提點"));
  section.appendChild(el("p", "", theme.example || ""));
  const ideas = ideasInTheme(theme.id);
  if (!ideas.length) section.appendChild(el("p", "muted", "這個主題還沒有提案。"));
  ideas.forEach((idea) => section.appendChild(buildPitchCard(idea)));
  const box = el("div", "composer");
  const area = el("textarea", "");
  area.rows = 2;
  area.maxLength = cat.limits.incident[1];
  area.placeholder = "這個主題想做什麼？用一句話寫下來。";
  const post = el("button", "btn primary", "貼上這一句");
  post.addEventListener("click", () => postThemeIdea(theme.id, area.value));
  box.appendChild(area);
  box.appendChild(post);
  section.appendChild(box);
  stage.appendChild(section);
}

function renderPark(stage) {
  const parked = (state.ideas || []).filter((i) => i.status === "parked");
  const offFeatures = (state.features || []).filter((f) => f.slot === "off");
  stage.appendChild(el("h2", "", "先擱下"));
  stage.appendChild(el("p", "", "這些先不討論。要繼續寫，回到想法。"));
  const back = el("button", "btn primary", "回到想法");
  back.addEventListener("click", () => {
    viewMode = "wall";
    renderStage();
  });
  stage.appendChild(back);
  if (!parked.length && !offFeatures.length) {
    stage.appendChild(el("p", "muted", "目前沒有停放的項目。"));
    return;
  }
  parked.forEach((idea) => {
    const card = el("div", "card");
    card.appendChild(el("div", "scene", idea.incident || idea.theme));
    if (idea.authorId === me.id) {
      const b = el("button", "btn tiny", "取回");
      b.addEventListener("click", () => api("/api/restore", { personId: me.id, ideaId: idea.id }).catch((e) => toast(e.message)));
      card.appendChild(b);
    }
    stage.appendChild(card);
  });
  offFeatures.forEach((f) => {
    const row = el("div", "card");
    row.appendChild(el("div", "", f.text));
    row.appendChild(el("div", "muted", "對不上的功能"));
    stage.appendChild(row);
  });
}

function renderPinbar(stage) {
  if (!pins.length) return;
  const bar = el("div", "pinbar");
  bar.appendChild(el("span", "muted", "並排比較"));
  pins.forEach((id) => {
    const idea = state.ideas.find((i) => i.id === id);
    if (!idea) return;
    const box = el("div", "card");
    box.appendChild(el("div", "scene", idea.incident || ""));
    box.appendChild(el("div", "io", idea.output || ""));
    const rm = el("button", "btn tiny", "拿掉");
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(id);
    });
    box.appendChild(rm);
    bar.appendChild(box);
  });
  const pinBtn = el("button", "btn tiny", "並排比較");
  pinBtn.addEventListener("click", () => {
    if (!selectedId) {
      toast("先點一則想法。");
      return;
    }
    if (pins.includes(selectedId)) return;
    togglePin(selectedId);
  });
  bar.appendChild(pinBtn);
  stage.appendChild(bar);
}

function ratingsFor(idea) {
  return (state.ratings || []).filter((item) => item.ideaId === idea.id && item.voterId !== idea.authorId);
}

function scoreAverage(idea) {
  return linkedAverage(idea);
}

function linkedAverage(idea) {
  const means = ratingsFor(idea)
    .map((item) => personMean(idea, item.voterId))
    .filter((n) => n != null);
  if (!means.length) return null;
  return means.reduce((sum, n) => sum + n, 0) / means.length;
}

function personMean(idea, voterId) {
  const item = (state.ratings || []).find((rating) => rating.ideaId === idea.id && rating.voterId === voterId);
  if (!item) return null;
  const vals = Object.values(item.scores || {}).map(Number).filter((n) => n >= 1 && n <= 5);
  if (!vals.length) return null;
  return vals.reduce((sum, n) => sum + n, 0) / vals.length;
}

function heatScore(idea) {
  return linkedAverage(idea) || 0;
}

function heatKey(idea) {
  return Math.round(heatScore(idea) * 10);
}

function heatLine(idea) {
  const count = ratingsFor(idea).length;
  const avg = linkedAverage(idea);
  if (!count || avg == null) return "還沒有人評分";
  return "平均 " + formatScore(avg) + " · " + count + " 人評過";
}

function rankWord(n) {
  const digits = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n <= 10) return n === 10 ? "十" : digits[n];
  if (n < 20) return "十" + digits[n - 10];
  if (n === 20) return "二十";
  return String(n);
}

function fieldAverage(idea, key) {
  const vals = ratingsFor(idea).map((item) => Number((item.scores || {})[key])).filter((n) => n >= 1 && n <= 5);
  if (!vals.length) return null;
  return vals.reduce((sum, n) => sum + n, 0) / vals.length;
}

function formatScore(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function detailWritten(idea) {
  return detailFields().some(([key]) => String(idea[key] || "").trim());
}

function scoreFields(idea) {
  const rows = [];
  if (String(idea.incident || "").trim()) rows.push(["incident", "這一則要做什麼"]);
  detailFields().forEach(([key, label]) => {
    if (String(idea[key] || "").trim()) rows.push([key, label]);
  });
  return rows;
}

function appendScore(box, idea) {
  const fields = scoreFields(idea);
  const block = el("div", "score-block");
  const written = detailWritten(idea);
  const mine = idea.authorId === me.id;
  block.appendChild(el("h3", "", mine || written ? "依詳細資訊評分" : "先評牆上這一句"));
  if (!fields.length) {
    block.appendChild(el("p", "muted", "詳細資訊還沒寫，還不能評。"));
    box.appendChild(block);
    return;
  }
  const avg = scoreAverage(idea);
  const count = ratingsFor(idea).length;
  if (mine) {
    block.appendChild(el("p", "muted", avg == null ? "還沒有人評。自己的不能自己評。" : "平均 " + formatScore(avg) + " 分，" + count + " 人評過。自己的不能自己評。"));
    fields.forEach(([key, label]) => {
      const part = fieldAverage(idea, key);
      block.appendChild(el("p", "", label + (part == null ? "：還沒有人評" : "：平均 " + formatScore(part))));
    });
    box.appendChild(block);
    return;
  }
  const lead = written
    ? (avg == null ? "看上面寫的內容，每一段選 1 到 5 分。" : "目前平均 " + formatScore(avg) + " 分，" + count + " 人評過。")
    : (avg == null ? "提案者還沒寫詳細資訊。先看上面這一句，選 1 到 5 分。" : "提案者還沒寫詳細資訊。目前平均 " + formatScore(avg) + " 分，" + count + " 人評過。");
  block.appendChild(el("p", "muted", lead));
  const existing = (state.ratings || []).find((item) => item.ideaId === idea.id && item.voterId === me.id);
  const picks = {};
  fields.forEach(([key, label]) => {
    const line = el("div", "score-line");
    const part = fieldAverage(idea, key);
    line.appendChild(el("div", "field-label", label + (part == null ? "" : " · 目前 " + formatScore(part))));
    const opts = el("div", "score-picks");
    const chosen = existing && existing.scores ? Number(existing.scores[key]) : null;
    if (chosen) picks[key] = chosen;
    for (let n = 1; n <= 5; n += 1) {
      const button = el("button", "opt" + (chosen === n ? " on" : ""), String(n));
      button.type = "button";
      button.addEventListener("click", () => {
        picks[key] = n;
        opts.querySelectorAll(".opt").forEach((node) => node.classList.remove("on"));
        button.classList.add("on");
      });
      opts.appendChild(button);
    }
    line.appendChild(opts);
    block.appendChild(line);
  });
  const send = el("button", "btn primary", existing ? "改評分" : "送出評分");
  send.addEventListener("click", async () => {
    if (fields.some(([key]) => picks[key] == null)) {
      toast(written ? "每一段都要選 1 到 5 分。" : "這一則要選 1 到 5 分。");
      return;
    }
    try {
      await api("/api/rate", { personId: me.id, ideaId: idea.id, scores: picks });
      toast("已評分");
      openDetail(idea.id);
    } catch (err) {
      toast(err.message);
    }
  });
  block.appendChild(send);
  box.appendChild(block);
}

function heatStat(label, value, hot) {
  const chip = el("div", "heat-stat" + (hot ? " hot" : ""));
  chip.appendChild(el("b", "", value));
  chip.appendChild(el("span", "", label));
  return chip;
}

function appendHeat(card, idea) {
  const count = ratingsFor(idea).length;
  const avg = linkedAverage(idea);
  const stats = el("div", "heat-stats");
  stats.appendChild(heatStat("平均", avg == null ? "未評" : formatScore(avg), true));
  stats.appendChild(heatStat("人數", String(count), false));
  card.appendChild(stats);
}

function renderTally(stage) {
  const ideas = wallIdeas();
  const head = el("div", "board-intro");
  head.appendChild(el("h2", "", "評分室"));
  head.appendChild(el("p", "", "依平均分排列。平均一樣時，評的人比較多的在前，再一樣就並列。"));
  stage.appendChild(head);
  if (!ideas.length) {
    stage.appendChild(el("p", "muted", "牆上還沒有提案。"));
    return;
  }
  const best = Math.max(...ideas.map((idea) => heatKey(idea)));
  const leaders = ideas.filter((idea) => heatKey(idea) === best).sort(byCreated);
  if (best <= 0) {
    stage.appendChild(el("p", "tally-note", "還沒有人評分。打開詳細資訊，選 1 到 5 分。"));
  } else if (leaders.length > 1) {
    stage.appendChild(el("p", "tally-note", "並列第一名：" + leaders.map(proposalMark).join("、") + "。平均 " + formatScore(heatScore(leaders[0])) + "。"));
  }
  const ranked = ideas.slice().sort((a, b) => heatKey(b) - heatKey(a) || ratingsFor(b).length - ratingsFor(a).length || byCreated(a, b));
  const crowd = {};
  ranked.forEach((idea) => {
    const key = heatKey(idea);
    crowd[key] = (crowd[key] || 0) + 1;
  });
  let place = 0;
  let lastKey = null;
  ranked.forEach((idea, index) => {
    const key = heatKey(idea);
    if (key !== lastKey) {
      place = index + 1;
      lastKey = key;
    }
    const card = buildPitchCard(idea);
    card.classList.add("tally-card");
    const row = card.querySelector(".pitch-head");
    const rankText = (crowd[key] > 1 ? "並列" : "") + "第" + rankWord(place) + "名";
    if (best > 0 && row) card.insertBefore(el("div", "rank-mark", rankText), row);
    if (best > 0 && key === best) card.classList.add("leading");
    stage.appendChild(card);
  });
}

function personName(id) {
  const person = personById(id);
  return person ? person.name : "有人";
}

function meetWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function meetComposer(week, op, placeholder, multiline) {
  const form = el("form", "meet-add");
  const field = el(multiline ? "textarea" : "input", "meet-field");
  if (!multiline) field.type = "text";
  field.maxLength = multiline ? 2000 : 200;
  field.placeholder = placeholder;
  field.setAttribute("aria-label", placeholder);
  const btn = el("button", "btn tiny primary", meetCopy().add || "加上");
  btn.type = "submit";
  form.appendChild(field);
  form.appendChild(btn);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = field.value.trim();
    if (!text) return;
    meetOp(op, { weekId: week.id, text });
  });
  return form;
}

function meetRemove(week, op, item) {
  if (!me || state.facilitatorId !== me.id) return null;
  const del = el("button", "btn tiny danger", meetCopy().remove || "刪掉");
  del.type = "button";
  del.addEventListener("click", () => meetOp(op, { weekId: week.id, itemId: item.id, remove: true }));
  return del;
}

function renderMeetChecks(week, op, items) {
  const list = el("div", "meet-list");
  items.forEach((item) => {
    const row = el("div", "meet-item" + (item.done ? " done" : ""));
    const label = el("label", "meet-check");
    const box = el("input", "");
    box.type = "checkbox";
    box.checked = !!item.done;
    box.addEventListener("change", () => meetOp(op, { weekId: week.id, itemId: item.id, done: box.checked }));
    label.appendChild(box);
    label.appendChild(el("span", "meet-text", item.text || ""));
    row.appendChild(label);
    const del = meetRemove(week, op, item);
    if (del) row.appendChild(del);
    list.appendChild(row);
  });
  return list;
}

function renderMeetLines(week, op, items) {
  const list = el("div", "meet-list");
  items.forEach((item) => {
    const row = el("div", "meet-line");
    const body = el("div", "meet-body");
    const meta = personName(item.authorId) + (item.at ? " · " + meetWhen(item.at) : "");
    body.appendChild(el("div", "meet-meta", meta));
    body.appendChild(el("p", "", item.text || ""));
    row.appendChild(body);
    const del = meetRemove(week, op, item);
    if (del) row.appendChild(del);
    list.appendChild(row);
  });
  return list;
}

function renderMeetCard(title, empty, body, composer) {
  const card = el("section", "meet-card");
  card.appendChild(el("h2", "", title));
  if (body) card.appendChild(body);
  if (empty) card.appendChild(el("p", "muted", empty));
  if (composer) card.appendChild(composer);
  return card;
}

function renderMeeting(stage, week) {
  const copy = meetCopy();
  if (me && state.facilitatorId === me.id) {
    const form = el("form", "meet-rename");
    const field = el("input", "meet-field");
    field.type = "text";
    field.maxLength = 30;
    field.value = week.title || "";
    field.placeholder = copy.renamePlaceholder || "這一週的名稱";
    field.setAttribute("aria-label", copy.renamePlaceholder || "這一週的名稱");
    const btn = el("button", "btn tiny", copy.rename || "改週名");
    btn.type = "submit";
    form.appendChild(field);
    form.appendChild(btn);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const title = field.value.trim();
      if (!title || title === week.title) return;
      meetOp("rename", { weekId: week.id, title });
    });
    stage.appendChild(form);
  }
  const tasks = week.tasks || [];
  const notes = week.notes || [];
  const decisions = week.decisions || [];
  const todos = week.todos || [];
  const grid = el("div", "meet-grid");
  const left = el("div", "meet-col");
  const right = el("div", "meet-col");
  left.appendChild(renderMeetCard(
    copy.tasks || "本週應完成",
    tasks.length ? "" : (copy.emptyTasks || "這一週還沒寫應完成的進度。"),
    tasks.length ? renderMeetChecks(week, "task", tasks) : null,
    meetComposer(week, "task", copy.taskPlaceholder || "這一週要完成的一項", false)
  ));
  left.appendChild(renderMeetCard(
    copy.todos || "待辦",
    todos.length ? "" : (copy.emptyTodos || "還沒有待辦。"),
    todos.length ? renderMeetChecks(week, "todo", todos) : null,
    meetComposer(week, "todo", copy.todoPlaceholder || "會後要做的一件事", false)
  ));
  right.appendChild(renderMeetCard(
    copy.notes || "會議紀錄",
    notes.length ? "" : (copy.emptyNotes || "還沒有會議紀錄。"),
    notes.length ? renderMeetLines(week, "note", notes) : null,
    meetComposer(week, "note", copy.notePlaceholder || "記下剛才說的", true)
  ));
  right.appendChild(renderMeetCard(
    copy.decisions || "決定",
    decisions.length ? "" : (copy.emptyDecisions || "還沒有決定。"),
    decisions.length ? renderMeetLines(week, "decision", decisions) : null,
    meetComposer(week, "decision", copy.decisionPlaceholder || "這一項決定是", false)
  ));
  grid.appendChild(left);
  grid.appendChild(right);
  stage.appendChild(grid);
}

function renderStage() {
  if (wizard) return;
  let stage = $(".stage");
  if (!stage) {
    stage = el("div", "stage");
    $("#app").appendChild(stage);
  }
  clear(stage);
  const week = currentWeek();
  if (week && week.kind === "meeting") renderMeeting(stage, week);
  else if (viewMode === "park") renderPark(stage);
  else if (viewMode === "tally") renderTally(stage);
  else renderWall(stage);
}

function renderAll() {
  document.querySelectorAll(".gate.center").forEach((n) => n.remove());
  if (!me || !state) return;
  renderHeader();
  renderPhaseBar();
  if (!wizard) renderStage();
  if (drawerEl && selectedId) refreshDrawer();
}

function pickDice() {
  const ri = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return {
    personId: ri(cat.people).id,
    timeId: ri(cat.times).id,
    constraintId: ri(cat.constraints).id,
  };
}

function openSceneWizard(idea, jumpStep) {
  closeDrawer();
  dicePick = idea.dice || pickDice();
  const steps = sceneStepsFor(idea);
  wizard = {
    mode: "scene",
    idea,
    steps,
    step: jumpStep || steps[0],
    ui: {},
  };
  mountWizard();
  if (idea.origin) scheduleDraft(idea);
}

function openFrameWizard(idea) {
  closeDrawer();
  wizard = {
    mode: "frames",
    idea: cloneIdea(idea),
    steps: FRAME_STEPS.slice(),
    step: "f0",
    ui: {},
  };
  mountWizard();
}

function closeWizard() {
  if (!wizard) return;
  document.body.classList.remove("writing");
  const w = document.querySelector(".wizard");
  if (w) w.remove();
  wizard = null;
  sparkHoverId = null;
  renderStage();
}

function wizardScroll() {
  return document.querySelector(".wiz-scroll");
}

function setWizardAction(node) {
  const box = document.querySelector(".wiz-actions");
  if (!box) return;
  clear(box);
  if (node) box.appendChild(node);
}

function mountWizard() {
  document.body.classList.add("writing");
  document.querySelectorAll(".wizard").forEach((n) => n.remove());
  const w = el("div", "wizard");
  const side = el("div", "wiz-side");
  const preview = el("div", "card");
  preview.setAttribute("data-preview", "");
  fillPreviewCard(preview, wizard.idea, { frames: wizard.mode === "frames" });
  side.appendChild(el("p", "muted preview-note", ""));
  side.appendChild(preview);
  const main = el("div", "wiz-main");
  const scroll = el("div", "wiz-scroll");
  const actions = el("div", "wiz-actions");
  main.appendChild(scroll);
  main.appendChild(actions);
  w.appendChild(side);
  w.appendChild(main);
  const stage = $(".stage");
  if (stage) {
    clear(stage);
    stage.appendChild(w);
  } else {
    document.body.appendChild(w);
  }
  renderWizardStep(scroll);
}

function renderWizardStep(main) {
  clear(main);
  setWizardAction(null);
  if (wizard.mode === "scene") renderSceneStep(main);
  else renderFrameStep(main);
  const head = el("div", "stephead");
  const steps = wizard.steps || [];
  const idx = Math.max(0, steps.indexOf(wizard.step));
  head.appendChild(el("div", "progress", "第 " + (idx + 1) + " 步，共 " + steps.length + " 步"));
  const nav = el("div", "row");
  if (idx > 0) {
    const back = el("button", "btn tiny", "上一步");
    back.addEventListener("click", () => goStep(steps[idx - 1]));
    nav.appendChild(back);
  }
  const leave = el("button", "btn tiny", "先離開");
  leave.addEventListener("click", () => closeWizard());
  nav.appendChild(leave);
  head.appendChild(nav);
  main.prepend(head);
  const preview = document.querySelector("[data-preview]");
  if (preview) updatePreview();
}

function renderSceneStep(main) {
  const idea = wizard.idea;
  const step = wizard.step;

  if (step === "origin") {
    main.appendChild(el("h2", "", "這頁用來收集想法"));
    main.appendChild(el("p", "", "一次只寫一件看得到的事，不要從空白開始。先點下面一個現場。下一題會問：這個人是誰、幾點在哪、他正在做什麼。再改成你們自己的。"));
    const panel = el("div", "");
    main.appendChild(panel);

    const startBtn = el("button", "btn primary full", "就用這個現場，開始寫");
    startBtn.addEventListener("click", () => {
      if (!(idea.origin === "spark" && idea.sparkId)) return;
      wizard.steps = sceneStepsFor(idea);
      goStep("who");
    });

    const chooseSpark = (sp) => {
      idea.origin = "spark";
      idea.sparkId = sp.id;
      idea.theme = sp.theme;
      idea.dice = null;
      wizard.steps = sceneStepsFor(idea);
      renderSparks();
      updatePreview();
      scheduleDraft(idea);
    };
    const sparkButton = (sp) => {
      const b = el("button", "spark" + (idea.sparkId === sp.id && idea.origin === "spark" ? " on" : ""));
      b.appendChild(el("div", "kicker", sp.clock));
      b.appendChild(el("div", "spark-title", sp.place));
      b.appendChild(el("p", "spark-picture", sp.picture));
      b.addEventListener("click", () => chooseSpark(sp));
      return b;
    };
    const renderSparks = () => {
      clear(panel);
      const lead = el("div", "theme-group");
      lead.appendChild(el("h3", "", "從這兩個開始"));
      const leadGrid = el("div", "sparks");
      cat.shortlist.forEach((id) => {
        const sp = sparkById(id);
        if (sp) leadGrid.appendChild(sparkButton(sp));
      });
      lead.appendChild(leadGrid);
      panel.appendChild(lead);
      const more = el("button", "btn", wizard.ui.showMore ? "收起其他情境" : "看其他情境");
      more.addEventListener("click", () => {
        wizard.ui.showMore = !wizard.ui.showMore;
        renderSparks();
      });
      panel.appendChild(more);
      if (wizard.ui.showMore) {
        cat.themes.forEach((th) => {
          const list = cat.sparks.filter((sp) => sp.theme === th.id && !cat.shortlist.includes(sp.id));
          if (!list.length) return;
          const block = el("div", "theme-group");
          block.appendChild(el("h3", "", th.full));
          const grid = el("div", "sparks");
          list.forEach((sp) => grid.appendChild(sparkButton(sp)));
          block.appendChild(grid);
          panel.appendChild(block);
        });
      }
      const diceLink = el("button", "btn tiny", "改抽三個限制");
      diceLink.addEventListener("click", () => {
        idea.origin = "dice";
        renderDice();
      });
      panel.appendChild(diceLink);
      startBtn.disabled = !(idea.origin === "spark" && idea.sparkId);
      setWizardAction(startBtn);
    };

    const renderDice = () => {
      clear(panel);
      if (!dicePick) dicePick = pickDice();
      const back = el("button", "btn tiny", "回到選情境");
      back.addEventListener("click", () => {
        idea.origin = idea.sparkId ? "spark" : "";
        renderSparks();
        updatePreview();
      });
      panel.appendChild(back);
      const diceWrap = el("div", "dice");
      const mkDie = (label, val, reroll) => {
        const d = el("div", "die");
        d.appendChild(el("div", "kicker", label));
        d.appendChild(el("div", "", val));
        const rb = el("button", "btn tiny", "換一個");
        rb.addEventListener("click", reroll);
        d.appendChild(rb);
        return d;
      };
      const p = cat.people.find((x) => x.id === dicePick.personId);
      const t = cat.times.find((x) => x.id === dicePick.timeId);
      const c = cat.constraints.find((x) => x.id === dicePick.constraintId);
      diceWrap.appendChild(mkDie("人", p?.label || "", () => {
        dicePick.personId = pickDice().personId;
        renderDice();
      }));
      diceWrap.appendChild(mkDie("時間", t?.label || "", () => {
        dicePick.timeId = pickDice().timeId;
        renderDice();
      }));
      diceWrap.appendChild(mkDie("限制", c?.label || "", () => {
        dicePick.constraintId = pickDice().constraintId;
        renderDice();
      }));
      panel.appendChild(diceWrap);
      panel.appendChild(el("p", "muted", "這三個限制都要寫進你的想法裡。"));
      const swap = el("button", "btn tiny", "換一組");
      swap.addEventListener("click", () => {
        dicePick = pickDice();
        renderDice();
      });
      panel.appendChild(swap);
      const ok = el("button", "btn primary full", "就用這三個限制");
      ok.addEventListener("click", () => {
        idea.origin = "dice";
        idea.dice = { ...dicePick };
        idea.sparkId = "";
        wizard.steps = sceneStepsFor(idea);
        goStep("theme");
        scheduleDraft(idea);
      });
      setWizardAction(ok);
    };

    if (idea.origin === "dice") renderDice();
    else renderSparks();
    return;
  }

  if (step === "theme") {
    main.appendChild(el("h2", "", "選競賽主題"));
    main.appendChild(el("p", "muted", "選了主題之後，還是要寫成一件具體的事。"));
    const grid = el("div", "grid");
    cat.themes.forEach((th) => {
      const c = el("button", "card choice");
      c.appendChild(el("div", "kicker", th.full));
      c.appendChild(el("p", "", th.blurb));
      c.addEventListener("click", () => {
        idea.theme = th.id;
        goStep("who");
        scheduleDraft(idea);
      });
      grid.appendChild(c);
    });
    main.appendChild(grid);
    return;
  }

  if (step === "ruleDiagnosis" || step === "ruleScreen" || step === "ruleFiction") {
    renderRuleStep(main, step);
    return;
  }

  if (step === "preview") {
    main.appendChild(el("h2", "", "給大家看之前"));
    main.appendChild(el("p", "", "先讀一遍。要改哪一句，點那一行。沒有紅字才能給組員看。"));
    const rows = [
      ["人", idea.who, "who"],
      ["時間地點", idea.whenWhere, "when"],
      ["發生的事", idea.incident, "incident"],
      ["他正在做的", idea.behavior, "behavior"],
      ["他提供的", idea.input, "input"],
      ["畫面回他的", idea.output, "output"],
    ];
    rows.forEach(([label, value, target]) => {
      const b = el("button", "answer");
      b.appendChild(el("div", "field-label", label));
      b.appendChild(el("div", "", value || "還沒寫"));
      b.addEventListener("click", () => goStep(target));
      main.appendChild(b);
    });
    const errs = sceneErrors(idea);
    if (errs.length) {
      const list = el("div", "block");
      errs.forEach((e) => {
        const b = el("button", "btn tiny bad", e.msg);
        b.addEventListener("click", () => goStep(e.step));
        list.appendChild(b);
      });
      main.appendChild(list);
    }
    const pub = el("button", "btn primary full", "給大家看");
    pub.disabled = !!errs.length;
    pub.addEventListener("click", async () => {
      try {
        clearTimeout(draftTimer);
        await draftChain.catch(() => {});
        const data = await api("/api/save", { personId: me.id, mode: "publish", idea });
        if (data.ideaId) idea.id = data.ideaId;
        closeWizard();
        selectedId = idea.id;
        openDrawer(idea.id);
        toast("已給大家看");
      } catch (e) {
        toast(e.message);
      }
    });
    setWizardAction(pub);
    return;
  }

  const fieldMap = {
    who: "who",
    when: "when",
    incident: "incident",
    behavior: "behavior",
    input: "input",
    output: "output",
  };
  const key = fieldMap[step];
  if (key) renderTextStep(main, step, cat.fields[key]);
}

function renderRuleStep(main, step) {
  const idea = wizard.idea;
  const spec = {
    ruleDiagnosis: {
      ask: "你剛寫的這句，有沒有寫成病名？",
      flag: "noDiagnosis",
      bad: "有，聽起來像診斷或病名",
      good: "沒有，只提醒何時聯絡獸醫",
      why: "輸出要停在何時該聯絡獸醫，不要寫病名。",
    },
    ruleScreen: {
      ask: "免責句會和這句出現在同一頁嗎？",
      flag: "sameScreen",
      bad: "不會，免責放頁尾就好",
      good: "會，個別建議和免責句在同一個畫面",
      why: "個別建議和免責句要出現在同一個畫面，放頁尾不算。",
      disclaimer: true,
    },
    ruleFiction: {
      ask: "展示時用的是虛構的例子嗎？",
      flag: "fictional",
      bad: "不是，會用真實病歷",
      good: "是，用虛構的這一隻",
      why: "沒有授權就不能用真實病歷。展示要用虛構的例子。",
    },
  }[step];
  const where = situationLine(idea);
  if (where) main.appendChild(el("p", "muted", where));
  main.appendChild(el("h2", "ask", spec.ask));
  main.appendChild(el("div", "field-label", "你寫的那句"));
  main.appendChild(el("div", "quote", idea.output || "還沒寫"));
  const reason = el("div", "coach");
  reason.hidden = true;
  const choices = el("div", "choices");
  const next = el("button", "btn primary full", "下一步");
  const paint = (good) => {
    idea.compliance[spec.flag] = good;
    choices.querySelectorAll(".choice").forEach((node, index) => {
      node.classList.toggle("on", good ? index === 1 : index === 0);
    });
    reason.hidden = good;
    reason.textContent = good ? "" : spec.why;
    let note = main.querySelector(".fineprint");
    if (spec.disclaimer && good) {
      if (!note) {
        note = el("p", "fineprint", cat.disclaimer);
        main.appendChild(note);
      }
    } else if (note) note.remove();
    next.disabled = !good;
    updatePreview();
    scheduleDraft(idea);
  };
  const badBtn = el("button", "choice bad", spec.bad);
  const goodBtn = el("button", "choice good", spec.good);
  badBtn.addEventListener("click", () => paint(false));
  goodBtn.addEventListener("click", () => paint(true));
  choices.appendChild(badBtn);
  choices.appendChild(goodBtn);
  main.appendChild(choices);
  main.appendChild(reason);
  next.disabled = !idea.compliance[spec.flag];
  if (idea.compliance[spec.flag]) paint(true);
  next.addEventListener("click", () => {
    if (!idea.compliance[spec.flag]) return;
    const steps = wizard.steps;
    const idx = steps.indexOf(wizard.step);
    if (idx < steps.length - 1) goStep(steps[idx + 1]);
  });
  setWizardAction(next);
}

function situationLine(idea) {
  if (idea.origin === "spark") {
    const sp = sparkById(idea.sparkId);
    if (sp) return "你選的情境：" + sp.clock + "｜" + sp.place;
  }
  if (idea.origin === "dice") {
    const { person, time, cons } = diceEntities(idea);
    const bits = [person, time, cons].filter(Boolean).map((item) => item.label);
    if (bits.length) return "這三個限制：" + bits.join("、");
  }
  return "";
}

function renderTextStep(main, step, field) {
  const idea = wizard.idea;
  if (!wizard.ui.textBuilt || wizard.ui.textStep !== step) {
    wizard.ui.textStep = step;
    wizard.ui.textBuilt = true;
    clear(main);
    const where = situationLine(idea);
    if (where) main.appendChild(el("p", "muted", where));
    if (field) {
      main.appendChild(el("div", "lead", field.lead));
      main.appendChild(el("h2", "ask", field.ask));
      const pair = el("div", "pair");
      pair.appendChild(exampleBox("bad", field.bad));
      pair.appendChild(exampleBox("good", field.good));
      main.appendChild(pair);
    }
    const ta = el("textarea", "");
    ta.setAttribute("data-field", step);
    wizard.ui.ta = ta;
    main.appendChild(ta);
    const coach = el("div", "coach");
    coach.setAttribute("data-coach", "");
    main.appendChild(coach);
    const chips = el("div", "row");
    chips.setAttribute("data-chips", "");
    main.appendChild(chips);
    const counter = el("div", "counter");
    counter.setAttribute("data-counter", "");
    main.appendChild(counter);
    const next = el("button", "btn primary full", "下一步");
    next.setAttribute("data-next", "");
    next.disabled = true;
    next.addEventListener("click", () => {
      const steps = wizard.steps;
      const idx = steps.indexOf(wizard.step);
      if (idx < steps.length - 1) goStep(steps[idx + 1]);
    });
    setWizardAction(next);
    wizard.ui.coach = coach;
    wizard.ui.next = next;
    wizard.ui.chips = chips;
    wizard.ui.counter = counter;

    const map = { who: "who", when: "whenWhere", incident: "incident", behavior: "behavior", input: "input", output: "output" };
    const onInput = () => {
      idea[map[step]] = wizard.ui.ta.value;
      updateTextUI(step);
      updatePreview();
      scheduleDraft(idea);
    };
    wizard.ui.ta.value = idea[map[step]] || "";
    wizard.ui.ta.addEventListener("input", onInput);
    wizard.ui.ta.focus();
  }
  updateTextUI(step);
}

function updateTextUI(step) {
  const idea = wizard.idea;
  let msg = coachForStep(step, idea);
  const cc = constraintCoach(idea, step);
  if (cc) msg = msg ? msg + " " + cc : cc;
  wizard.ui.coach.textContent = msg || "可以了，下一步。";
  wizard.ui.coach.classList.toggle("ok", !msg && !cc);
  wizard.ui.next.disabled = !!(msg || cc);
  wizard.ui.next.textContent = msg || cc ? "下一步" : "可以了，下一步";

  const map = { who: "who", when: "whenWhere", incident: "incident", behavior: "behavior", input: "input", output: "output" };
  const limKey = step === "when" ? "whenWhere" : map[step];
  const hi = cat.limits[limKey][1];
  wizard.ui.counter.textContent = `${(idea[map[step]] || "").length}/${hi}`;

  clear(wizard.ui.chips);
  if (idea.origin === "dice") {
    const { cons } = diceEntities(idea);
    if (cons && constraintBlocking(idea, step)) {
      const ok = constraintOk(idea, cons);
      const chip = el("button", "chip " + (ok ? "ok" : "bad"), cons.label);
      chip.addEventListener("click", () => {
        const first = (cons.fields || ["who"])[0];
        const jump = first === "whenWhere" ? "when" : first;
        goStep(jump);
      });
      wizard.ui.chips.appendChild(chip);
    }
  }
}

function updatePreview() {
  const prev = document.querySelector("[data-preview]");
  const side = document.querySelector(".wiz-side");
  if (!prev || !wizard) return;
  const idea = wizard.idea;
  const started = Boolean(
    idea.sparkId || idea.who || idea.whenWhere || idea.incident || idea.behavior || idea.input || idea.output || idea.theme
  );
  if (side) side.hidden = wizard.step === "origin" && !started;
  fillPreviewCard(prev, idea, { frames: wizard.mode === "frames" });
  const note = side && side.querySelector(".preview-note");
  if (note) note.textContent = started ? "這是目前這則想法。" : "";
}

function goStep(step) {
  wizard.step = step;
  wizard.ui.textBuilt = false;
  const main = wizardScroll() || document.querySelector(".wiz-main");
  if (main) renderWizardStep(main);
}

function renderFrameStep(main) {
  const idea = wizard.idea;
  const step = wizard.step;
  if (step === "preview") {
    main.appendChild(el("h2", "", "畫面補完了"));
    const err = framesReady(idea);
    const fin = el("button", "btn primary", "完成");
    fin.disabled = !!err;
    fin.addEventListener("click", async () => {
      try {
        await api("/api/save", { personId: me.id, mode: "frames", idea });
        closeWizard();
        toast("已儲存四格畫面");
      } catch (e) {
        toast(e.message);
      }
    });
    main.appendChild(fin);
    if (err) main.appendChild(el("p", "bad", err));
    return;
  }
  const isShot = step.startsWith("s");
  const index = isShot ? parseInt(step.slice(1), 10) : parseInt(step.slice(1), 10);
  if (isShot) {
    main.appendChild(el("h2", "", "說明 " + (index + 1)));
    main.appendChild(el("p", "muted", cat.shotAsk));
    const pair = el("div", "pair");
    pair.appendChild(exampleBox("bad", cat.shotBad));
    pair.appendChild(exampleBox("good", cat.shotGood));
    main.appendChild(pair);
  } else {
    const fr = cat.frames[index];
    main.appendChild(el("h2", "", "第 " + (index + 1) + " 格"));
    main.appendChild(el("p", "ask", fr.ask));
    const pair = el("div", "pair");
    pair.appendChild(exampleBox("bad", fr.bad));
    pair.appendChild(exampleBox("good", fr.good));
    main.appendChild(pair);
    const stickerRow = el("div", "sticker-row");
    cat.stickers.forEach((st) => {
      const b = el("button", "sticker");
      b.appendChild(stickerSvg(st.id));
      b.appendChild(document.createTextNode(st.label));
      const sel = (idea.frames[index].stickers || []).includes(st.id);
      if (sel) b.classList.add("on");
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        let arr = idea.frames[index].stickers || [];
        if (arr.includes(st.id)) arr = arr.filter((x) => x !== st.id);
        else if (arr.length < 3) arr = [...arr, st.id];
        idea.frames[index].stickers = arr;
        b.classList.toggle("on", arr.includes(st.id));
        validate();
      });
      stickerRow.appendChild(b);
    });
    main.appendChild(stickerRow);
  }

  const row = el("div", "row");
  row.appendChild(el("span", "", "畫面"));
  const ta = el("textarea", "");
  const val = isShot ? idea.shots[index] : idea.frames[index].line;
  ta.value = val || "";
  row.appendChild(ta);
  main.appendChild(row);

  const coach = el("div", "coach");
  main.appendChild(coach);
  const next = el("button", "btn primary", "下一步");
  next.setAttribute("data-next", "");

  const validate = () => {
    const text = ta.value.trim();
    if (isShot) idea.shots[index] = text;
    else idea.frames[index].line = text;
    let err = "";
    if (text.startsWith("畫面")) err = "不用再寫「畫面」。";
    else if (isShot) {
      const [lo, hi] = cat.limits.shot;
      if (text.length < lo || text.length > hi) err = `請寫 ${lo}–${hi} 字。`;
      else if (wideProblem(text)) err = "範圍太大。";
    } else {
      const [lo, hi] = cat.limits.frame;
      if (text.length < lo || text.length > hi) err = `請寫 ${lo}–${hi} 字。`;
      else if (!(idea.frames[index].stickers || []).length) err = "選 1–3 個圖。";
      else if (wideProblem(text)) err = "範圍太大。";
      else if (index === 2) {
        const prefix = (idea.output || "").slice(0, 4);
        if (prefix && !text.includes(prefix) && !text.includes(idea.output)) err = "第三格要含輸出的前幾字。";
      }
    }
    coach.textContent = err || "可以下一步。";
    next.disabled = !!err;
    updatePreview();
  };
  ta.addEventListener("input", validate);
  validate();

  next.addEventListener("click", async () => {
    validate();
    if (next.disabled) return;
    try {
      await api("/api/save", { personId: me.id, mode: "frames", idea });
    } catch (e) {
      toast(e.message);
      return;
    }
    const idx = wizard.steps.indexOf(step);
    goStep(wizard.steps[idx + 1] || "preview");
  });
  main.appendChild(next);
}

function openDrawer(id) {
  selectedId = id;
  closeDrawer();
  const shade = el("div", "shade");
  shade.addEventListener("click", (e) => {
    if (e.target === shade) closeDrawer();
  });
  drawerEl = el("aside", "drawer");
  shade.appendChild(drawerEl);
  document.body.appendChild(shade);
  refreshDrawer();
}

function closeDrawer() {
  if (drawerEl) {
    const shade = drawerEl.parentElement;
    if (shade && shade.classList.contains("shade")) shade.remove();
    else drawerEl.remove();
  }
  drawerEl = null;
}

function refreshDrawer() {
  if (!drawerEl || !selectedId) return;
  const idea = state.ideas.find((i) => i.id === selectedId);
  if (!idea) {
    closeDrawer();
    return;
  }
  clear(drawerEl);
  const hide = shouldHideText(idea);
  if (!hide) {
    drawerEl.appendChild(el("div", "field-label", "誰"));
    drawerEl.appendChild(el("div", "muted", idea.who || "還沒寫"));
    drawerEl.appendChild(el("div", "field-label", "時間地點"));
    drawerEl.appendChild(el("div", "muted", idea.whenWhere || "還沒寫"));
    drawerEl.appendChild(el("div", "field-label", "行為"));
    drawerEl.appendChild(el("div", "muted", idea.behavior || "還沒寫"));
    drawerEl.appendChild(el("div", "field-label", "發生的事"));
    drawerEl.appendChild(el("div", "scene", idea.incident || ""));
    drawerEl.appendChild(el("div", "io", (idea.input || "") + " → " + (idea.output || "")));
    const fr = el("div", "frames");
    (idea.frames || []).forEach((f) => {
      const frame = el("div", "frame");
      const row = el("div", "sticker-row");
      (f.stickers || []).forEach((s) => {
        const st = el("span", "sticker");
        st.appendChild(stickerSvg(s));
        row.appendChild(st);
      });
      frame.appendChild(row);
      frame.appendChild(el("div", "", "畫面" + (f.line || "")));
      fr.appendChild(frame);
    });
    drawerEl.appendChild(fr);
  } else {
    const muteBox = el("div", "block");
    muteBox.appendChild(el("h3", "", "我看到的是"));
    const ta = el("textarea", "");
    const sub = el("button", "btn primary", "送出");
    sub.addEventListener("click", () => {
      api("/api/mute", { personId: me.id, ideaId: idea.id, saw: ta.value.trim() })
        .then(() => refreshDrawer())
        .catch((e) => toast(e.message));
    });
    muteBox.appendChild(ta);
    muteBox.appendChild(sub);
    drawerEl.appendChild(muteBox);
  }

  const mute = myMute(idea.id);
  if (mute && hide === false && state.phase === "mute") {
    drawerEl.appendChild(el("div", "block", "你寫的：" + mute.saw));
  }

  if (state.phase === "score" && idea.authorId !== me.id) {
    drawerEl.appendChild(el("h3", "", "互相評分"));
    if (idea.authorId === me.id) drawerEl.appendChild(el("p", "muted", "自己的想法不能自己評。"));
    else {
      const form = el("div", "block");
      const scores = {};
      const existing = myVote(idea.id);
      cat.rubric.forEach((r) => {
        form.appendChild(el("div", "lead", r.label));
        const opts = el("div", "choices");
        r.options.forEach(([val, label]) => {
          const b = el("button", "opt");
          b.textContent = label;
          if (r.key === "visual" && val === "2" && framesReady(idea)) {
            b.disabled = true;
            b.title = "還沒補上使用過程之前，畫面分最高給 1。";
          }
          b.addEventListener("click", () => {
            scores[r.key] = parseInt(val, 10);
            opts.querySelectorAll(".opt").forEach((x) => x.classList.remove("on"));
            b.classList.add("on");
          });
          if (existing && String(existing[r.key]) === val) b.classList.add("on");
          opts.appendChild(b);
        });
        if (existing) scores[r.key] = existing[r.key];
        form.appendChild(opts);
      });
      const voteBtn = el("button", "btn primary", "送出評分");
      voteBtn.addEventListener("click", () => {
        api("/api/vote", { personId: me.id, ideaId: idea.id, scores })
          .then(() => {
            toast("已評分");
            refreshDrawer();
          })
          .catch((e) => toast(e.message));
      });
      form.appendChild(voteBtn);
      drawerEl.appendChild(form);
    }
  }

  for (const kind of Object.keys(cat.stems)) {
    const row = el("div", "row");
    row.appendChild(el("label", "", cat.stems[kind]));
    const ta = el("textarea", "");
    const b = el("button", "btn tiny", "留言");
    b.addEventListener("click", () => {
      api("/api/comment", { personId: me.id, ideaId: idea.id, kind, text: ta.value.trim() })
        .then(() => {
          toast("已留言");
          refreshDrawer();
        })
        .catch((e) => toast(e.message));
    });
    row.appendChild(ta);
    row.appendChild(b);
    drawerEl.appendChild(row);
  }

  (state.comments || [])
    .filter((c) => c.ideaId === idea.id)
    .forEach((c) => {
      const author = personById(c.authorId);
      drawerEl.appendChild(el("div", "muted", (author?.name || "") + "：" + c.text));
    });

  const feat = el("div", "block");
  feat.appendChild(el("h3", "", "這個功能放哪一格"));
  const ft = el("input", "");
  const slot = el("select", "");
  ["off", "0", "1", "2", "3"].forEach((s) => {
    const o = el("option", "", s === "off" ? "對不上，先擱下" : "第 " + (parseInt(s, 10) + 1) + " 格");
    o.value = s;
    slot.appendChild(o);
  });
  const fb = el("button", "btn tiny", "送出");
  fb.addEventListener("click", () => {
    api("/api/feature", { personId: me.id, ideaId: idea.id, text: ft.value.trim(), slot: slot.value })
      .then((d) => {
        toast(d.message || "已記錄");
        refreshDrawer();
      })
      .catch((e) => toast(e.message));
  });
  feat.appendChild(ft);
  feat.appendChild(slot);
  feat.appendChild(fb);
  drawerEl.appendChild(feat);

  const gate = el("div", "gate");
  gate.appendChild(el("h3", "", "選定前檢查"));
  gateChecks(idea).forEach((g) => {
    gate.appendChild(el("div", g.ok ? "ok" : "bad", g.label));
  });
  drawerEl.appendChild(gate);

  const actions = el("div", "actions");
  if (idea.authorId === me.id) {
    const edit = el("button", "btn", "改寫這則");
    edit.addEventListener("click", () => openSceneWizard(cloneIdea(idea)));
    actions.appendChild(edit);
    const frames = el("button", "btn", "補上畫面");
    frames.addEventListener("click", () => openFrameWizard(idea));
    actions.appendChild(frames);
  }
  const narrow = el("button", "btn", "再縮小範圍");
  narrow.addEventListener("click", () => {
    const draft = blankIdea();
    draft.forkedFrom = idea.id;
    draft.origin = idea.origin;
    draft.sparkId = idea.sparkId;
    draft.dice = idea.dice ? { ...idea.dice } : null;
    draft.theme = idea.theme;
    openSceneWizard(draft, "who");
  });
  actions.appendChild(narrow);

  const pin = el("button", "btn tiny", pins.includes(idea.id) ? "移出比較" : "並排比較");
  pin.addEventListener("click", () => {
    togglePin(idea.id);
    pin.textContent = pins.includes(idea.id) ? "移出比較" : "並排比較";
  });
  actions.appendChild(pin);

  const lockErr = clientGateError(idea);
  const others = othersOnline(idea.authorId);
  const lockLabel = others.length ? "選定這則" : "先自己選定";
  if (lockedOnWall() && idea.status !== "locked") {
    actions.appendChild(el("span", "muted", "已經選定一則了。"));
  } else if (idea.authorId === me.id && idea.status === "published") {
    const lock = el("button", "btn primary", lockLabel);
    lock.disabled = !!lockErr;
    lock.title = lockErr || "";
    lock.addEventListener("click", () =>
      api("/api/lock", { personId: me.id, ideaId: idea.id })
        .then(() => {
          toast("已選定");
          refreshDrawer();
        })
        .catch((e) => toast(e.message))
    );
    actions.appendChild(lock);
  }
  if (idea.status === "locked" && state.facilitatorId === me.id) {
    const ul = el("button", "btn tiny", "取消選定");
    ul.addEventListener("click", () =>
      api("/api/unlock", { personId: me.id, ideaId: idea.id })
        .then(() => refreshDrawer())
        .catch((e) => toast(e.message))
    );
    actions.appendChild(ul);
  }

  drawerEl.appendChild(actions);
  const close = el("button", "btn tiny", "關閉");
  close.addEventListener("click", closeDrawer);
  drawerEl.appendChild(close);
}

function closeModal() {
  if (modalEl) {
    const shade = modalEl.parentElement;
    if (shade && shade.classList.contains("shade")) shade.remove();
    else modalEl.remove();
  }
  modalEl = null;
  resetConfirm = 0;
}

function mountModal() {
  closeModal();
  const shade = el("div", "shade center");
  shade.addEventListener("click", (e) => {
    if (e.target === shade) closeModal();
  });
  modalEl = el("div", "modal");
  shade.appendChild(modalEl);
  document.body.appendChild(shade);
  return modalEl;
}

function openMeetingModal() {
  const box = el("div", "block");
  mountModal().appendChild(box);
  box.appendChild(el("h2", "", "怎麼進行"));
  cat.meeting.forEach((m) => {
    box.appendChild(el("h3", "", m.t));
    box.appendChild(el("p", "", m.d));
  });
  if (state.facilitatorId === me.id) {
    const reset = el("button", "btn danger", "重新開始這場");
    reset.addEventListener("click", () => {
      resetConfirm++;
      if (resetConfirm < 2) {
        toast("再按一次就會清掉想法。");
        return;
      }
      api("/api/reset", { personId: me.id })
        .then(() => {
          toast("已重新開始");
          closeModal();
        })
        .catch((e) => toast(e.message));
    });
    box.appendChild(reset);
  }
}

function scheduleData() {
  const data = cat && cat.schedule;
  if (!data || !Array.isArray(data.items) || !data.items.length) return null;
  return data;
}

function fillSchedule(parent) {
  const data = scheduleData();
  if (!data) return;
  parent.appendChild(el("h2", "", data.title || "徵件時程"));
  if (data.lead) parent.appendChild(el("p", "", data.lead));
  if (data.note) parent.appendChild(el("p", "schedule-note", data.note));
  const list = el("ol", "schedule-list");
  data.items.forEach((item) => {
    const row = el("li", "");
    row.appendChild(el("span", "schedule-date", item.date || ""));
    row.appendChild(el("span", "", item.text || ""));
    list.appendChild(row);
  });
  parent.appendChild(list);
}

function renderSchedule(stage) {
  if (!scheduleData()) return;
  const board = el("section", "schedule-board");
  fillSchedule(board);
  stage.appendChild(board);
}

function openScheduleModal() {
  const box = el("div", "block");
  fillSchedule(box);
  mountModal().appendChild(box);
}

function openListModal(title, lines) {
  const box = el("div", "block");
  box.appendChild(el("h2", "", title));
  lines.forEach((l) => box.appendChild(el("p", "", l)));
  mountModal().appendChild(box);
}

function openExampleModal() {
  const box = el("div", "block");
  box.appendChild(el("h2", "", "看一張合格的"));
  const card = el("div", "card");
  fillPreviewCard(card, cat.example, { frames: true });
  box.appendChild(card);
  mountModal().appendChild(box);
}

function openTourModal() {
  const box = el("div", "block");
  const slide = TOUR_SLIDES[tourSlide];
  box.appendChild(el("h2", "", slide.t));
  box.appendChild(el("p", "", slide.d));
  const next = el("button", "btn primary", tourSlide < TOUR_SLIDES.length - 1 ? "下一張" : "開始");
  next.addEventListener("click", () => {
    if (tourSlide < TOUR_SLIDES.length - 1) {
      tourSlide++;
      openTourModal();
    } else {
      localStorage.setItem("aipets-tour", "1");
      closeModal();
    }
  });
  box.appendChild(next);
  mountModal().appendChild(box);
}

function maybeTour() {
  if (!localStorage.getItem("aipets-tour")) {
    tourSlide = 0;
    openTourModal();
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (modalEl) closeModal();
  else if (wizard) closeWizard();
  else if (drawerEl) closeDrawer();
});

function startPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (!me || document.hidden) return;
  pollTimer = setInterval(pulseOnce, 2500);
}

async function pulseOnce() {
  if (!me || document.hidden) return;
  try {
    await api("/api/pulse", { personId: me.id, rev });
  } catch (e) {
    if (e.stale) return;
    if (e.login) {
      me = null;
      clearInterval(pollTimer);
      pollTimer = null;
      renderPassword($("#app"));
    }
  }
}

document.addEventListener("visibilitychange", () => {
  if (!me) return;
  if (document.hidden) {
    clearInterval(pollTimer);
    pollTimer = null;
    return;
  }
  pulseOnce();
  startPoll();
});

async function boot() {
  document.addEventListener("focusout", () => setTimeout(flushRender, 0));
  loadPins();
  const app = $("#app");
  try {
    const res = await fetch("/catalog.json");
    if (!res.ok) throw new Error("bad");
    cat = await res.json();
  } catch {
    clear(app);
    app.appendChild(el("div", "fatal center", "連不上發想牆。本機請先執行啟動發想牆.bat。若是公開網址，等一分鐘再重新整理。"));
    return;
  }

  if (!localStorage.getItem("aipets-token")) {
    renderPassword(app);
    return;
  }
  await enterWall();
}

async function enterWall() {
  const app = $("#app");
  const name = localStorage.getItem("aipets-name");
  const pid = localStorage.getItem("aipets-id");
  if (!name) {
    await renderJoin(app);
    return;
  }

  try {
    const data = await api("/api/join", { name, personId: pid || undefined });
    me = data.me;
    localStorage.setItem("aipets-id", me.id);
    renderAll();
    startPoll();
  } catch (e) {
    if (e.login) {
      renderPassword(app);
      return;
    }
    clear(app);
    app.appendChild(el("div", "fatal", e.message));
  }
}

boot();
