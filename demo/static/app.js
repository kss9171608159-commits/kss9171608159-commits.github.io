/* ===== КартЭдит — frontend logic =====
   Данные грузятся из /api/telemetry (реальный .asc3, распакованный asc_parser.py).
   Если API недоступен / пуст — откат на mock-каркас. */
"use strict";

/* ---------- P6/S-1: сессионный токен API ----------
   Сервер вшивает window.ASC_TOKEN в index.html при отдаче «/». Обёртка fetch
   добавляет его в заголовок X-ASC-Token для всех запросов к /api/* — POST без
   токена бэкенд отбивает (защита от CSRF со сторонних вкладок на localhost). */
(() => {
  const f0 = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (typeof url === "string" && url.startsWith("/api/")) {
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers || {},
        { "X-ASC-Token": window.ASC_TOKEN || "" });
    }
    return f0(url, opts);
  };
})();

/* ---------- палитра для динамических каналов ---------- */
const PALETTE = [
  "#15539e", "#b5651d", "#2e8b57", "#c0392b", "#8e44ad", "#16a085", "#d35400",
  "#2980b9", "#596573", "#27ae60", "#9b59b6", "#e67e22", "#1abc9c", "#34495e",
];

/* ---------- короткие имена каналов (для тулбара/таблицы) ---------- */
const SHORT_NAMES = {
  "Вес на крюке": "Wk",
  "Давление в манифольде": "Pвх",
  "Положение крюкоблока": "Hk",
  "Скорость СПО": "Vсп",
  "Обороты ротора": "Nрот",
  "Момент на роторе": "Мрот",
  "Момент на ключе": "Мкл",
  "Загазованность": "ПДК",
  "Уровень": "Vт",
  "Расход": "Q",
};
function shortName(full) { return SHORT_NAMES[full] || full; }

/* ---------- состояние данных (заполняется loadData / genData) ---------- */
let CHANNELS = [];               // [{key,name,color,area?,step?}]
let DEFAULT_ACTIVE = new Set();  // ключи активных каналов
let SERIES = { ts: [], data: {} };

/* ---------- роли каналов и V8 (F16) ----------
   Роль канала определяется ПО ИМЕНИ, и правило живёт на сервере
   (tools/value_invariants.role_of). Здесь только полученный ответ: копия
   правила в JS отстала бы молча, а список ролей уже менялся дважды.
   CUM_KEYS — накопительные каналы (наработка каната). Их значения редактор
   умеет только ПЕРЕНОСИТЬ: закона «наработка = f(вес, путь)» в данных нет
   (probe_f16_rope_law), поэтому пересчитанное значение — выдумка. Ворота V8
   такую правку отклонят на сохранении. Предупреждение обязано появиться ДО
   правки: отказ на записи означает, что работа уже сделана впустую. */
let CUM_KEYS = new Set();        // ключи накопительных каналов
let ROLES_OK = true;             // движок ролей на сервере поднялся?
let ORIGIN_OPENED_AT = null;     // когда снят отсчёт F17 (сервер, dd.mm.yyyy hh:mm)
function cumInKeys(keys) { return (keys || []).filter((k) => CUM_KEYS.has(k)); }
/* Имя канала по ключу. При промахе — null, а НЕ сам ключ: ключ «c14» уехал бы
   на сервер как имя канала, там не нашёлся бы, был бы молча отброшен, и откат
   отчитался бы «возвращать нечего». Пусть вызывающий увидит промах. */
function chName(k) { const c = CHANNELS.find((x) => x.key === k); return c ? c.name : null; }

/* ---------- ДИММЕР ----------
   Глобальная непрозрачность второстепенных линий. Меняется ТОЛЬКО ползунком —
   не зависит от курсора, поэтому в принципе не может «моргать». «Вес на крюке»
   всегда фиксирован на HOOK_OPACITY и рисуется поверх остальных. */
let DIM = 0.60;                  // 0.05..1.00 — видимость фоновых линий
const HOOK_OPACITY = 0.90;       // «Вес на крюке» — всегда заметнее всех
let FOCUS_KEY = null;            // канал в фокусе (клик по линейке): линия/полоса ярче
let N = 0;                       // число точек
// Решение Б: карта происхождения строк для экспорта в .asc3.
// ROW_SRC[p] = индекс исходной записи (0..ORIG_N-1) или -1 для вставленной строки.
// Удаление = исходный индекс просто исчезает из ROW_SRC. Пока ROW_SRC ===
// identity (длина ORIG_N и ROW_SRC[i]===i) — экспорт идёт байт-точным патчем;
// иначе бэкенд пересобирает поток (rebuild_asc3).
let ROW_SRC = [];
let ORIG_N = 0;                  // число записей в исходном .asc3
let OPENED_NAME = "";            // имя открытого/сохранённого .asc3 (для «Сохранить как»)

// Многосуточность: карта суток из /api/telemetry = [{index,date,start,count}].
// DAY_SEL — множество индексов выбранных суток (показ + сохранение). Пусто/все
// выбраны = весь файл. dayOfIndex(i) — к каким суткам относится строка i.
let DAYS = [];
const DAY_SEL = new Set();
let DAY_ANCHOR = 0;             // якорь для Shift-диапазона выбора суток в дереве
// #74: сервер сообщает, ОТКУДА взял абсолютную дату суток. Раньше интерфейс во
// всех случаях писал «берётся из имени файла» — на файле «31,07
// (Скорректированный).asc3» имя не распозналось (запятая не была разделителем),
// дата пришла из даты изменения файла (12.08.2026), а подсказка продолжала
// врать про имя. Источник "file" — новый и главный: регистратор пишет номер дня
// в преамбуле суток, и это единственный источник, который не врёт на записях с
// пропущенными сутками.
let DATE_SRC = null;            // "file" | "name" | "csv" | "mtime" | "kept" | null
let SOURCE_LABEL = null;        // подпись источника данных для строки статуса (см. init)
function dateSourceHint() {
  return {
    file: "Дата прочитана ИЗ САМОГО ФАЙЛА: регистратор пишет в преамбуле каждых суток "
        + "номер дня. Самый точный источник — он верен и тогда, когда в записи есть "
        + "пропущенные сутки и соседние страницы относятся к НЕсоседним датам.",
    name: "Дата взята из имени файла — самый надёжный источник после архива.",
    csv: "Дата взята из CSV-архива регистратора рядом с файлом — настоящая дата записи.",
    mtime: "⚠ В имени файла даты нет, поэтому взята ДАТА ИЗМЕНЕНИЯ ФАЙЛА — это лишь оценка, "
         + "она может не совпадать с реальными сутками. Переименуйте файл так, чтобы дата была "
         + "в имени (например «31.07.2026 скв44.asc3»), и метка станет точной.",
    kept: "Дата сохранена от предыдущего открытия этого файла (вы её уже задавали).",
  }[DATE_SRC] || "Источник даты не сообщён сервером.";
}
function dayOfIndex(i) {
  for (let d = 0; d < DAYS.length; d++) {
    const s = DAYS[d].start;
    if (i >= s && i < s + DAYS[d].count) return d;
  }
  return -1;
}
function daySelActive() { return DAYS.length > 1 && DAY_SEL.size > 0 && DAY_SEL.size < DAYS.length; }
// #B19: сутки каждой ТЕКУЩЕЙ строки по её ВРЕМЕНИ (полночь..полночь из DAYS[].date).
// dayOfIndex не годится после вставки/удаления (его границы — исходные индексы).
function rowDaysByTime() {
  if (!DAYS.length) return null;
  const mids = DAYS.map((d) => {
    const p = String(d.date || "").split("-").map(Number);
    return new Date(p[0], (p[1] || 1) - 1, p[2] || 1).getTime();
  });
  const res = new Array(N);
  let d = 0;
  for (let i = 0; i < N; i++) {
    const t = SERIES.ts[i];
    while (d + 1 < mids.length && t >= mids[d + 1]) d++;
    res[i] = d;
  }
  return res;
}
function initRowSrc() { ORIG_N = N; ROW_SRC = Array.from({ length: N }, (_, i) => i); }
function rowSrcIsIdentity() {
  if (ROW_SRC.length !== ORIG_N) return false;
  for (let i = 0; i < ROW_SRC.length; i++) if (ROW_SRC[i] !== i) return false;
  return true;
}

// базовая дата для строк без даты / для mock; локальная, без UTC-сдвига
const MOCK_BASE = new Date(2026, 1, 12, 0, 0, 0).getTime();
let LAST_DATE_MS = MOCK_BASE;    // запоминаем дату из последнего полного таймстемпа

/* ---------- утилиты ---------- */
function pad(n) { return String(n).padStart(2, "0"); }
// #A20 (18.08.2026, аудит): экранирование для мест, где разметка собирается
// СТРОКОЙ и попадает в innerHTML. Недоверенный ввод здесь — содержимое .asc3
// заказчика (имена каналов, месторождение, № скважины, метка суток), имена
// открытых файлов и тексты ответов сервера. Кавычки экранируются наравне с
// угловыми скобками: половина подстановок стоит внутри title="…", и там
// одна кавычка выводит из атрибута ровно так же, как «<» из текста.
// Где можно было заменить сборку строки на узлы (addNote, плашка обновления) —
// заменено; здесь структура разметки нужна как есть, чтобы не переписывать
// привязку обработчиков через querySelector.
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtTime(ms) {
  const d = new Date(ms);
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}
// #A18 (18.08.2026): дата строки для выгрузок. Формат ДД.ММ.ГГГГ — как в
// эталонном CSV регистратора («Дата;Время; Вес на крюке (тс);…»).
function fmtDate(ms) {
  const d = new Date(ms);
  return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();
}
// подпись оси X — почасовая, без секунд (HH:MM), чтобы метки не слипались
function fmtAxisTime(ms) {
  const d = new Date(ms);
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}
// #v94: адаптивная сетка/формат оси времени по ВИДИМОМУ окну. Чинит две вещи:
// (1) «абракадабру» при показе многих суток (раньше жёстко 1–2ч на 360ч → сотни
//     налезающих меток); (2) отсутствие минутной разметки при сильном зуме
//     (жёсткий minInterval=1ч не давал тиков мельче часа).
function fmtHMS(ms){const d=new Date(ms);return pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds());}
function fmtHM(ms){const d=new Date(ms);return pad(d.getHours())+":"+pad(d.getMinutes());}
function fmtDayHM(ms){const d=new Date(ms);return pad(d.getDate())+"."+pad(d.getMonth()+1)+" "+pad(d.getHours())+":"+pad(d.getMinutes());}
function fmtDay(ms){const d=new Date(ms);return pad(d.getDate())+"."+pad(d.getMonth()+1);}
let _AXTICK = { mi: 3600000, ma: 7200000, fmt: fmtHM };
function pickAxisTick(span){
  const M=60000,H=3600000,D=86400000;
  if(span<=2*M)   return {mi:5000,   ma:15000, fmt:fmtHMS};
  if(span<=10*M)  return {mi:30000,  ma:M,     fmt:fmtHMS};
  if(span<=40*M)  return {mi:2*M,    ma:5*M,   fmt:fmtHM};
  if(span<=3*H)   return {mi:10*M,   ma:15*M,  fmt:fmtHM};
  if(span<=10*H)  return {mi:30*M,   ma:H,     fmt:fmtHM};
  if(span<=30*H)  return {mi:H,      ma:2*H,   fmt:fmtHM};
  if(span<=5*D)   return {mi:6*H,    ma:12*H,  fmt:fmtDayHM};
  return              {mi:D,      ma:2*D,   fmt:fmtDay};
}
function visibleSpanMs(){
  let lo, hi;
  if (XMIN != null) { lo = XMIN; hi = XMAX; }
  else if (SERIES && SERIES.ts && SERIES.ts.length) { lo = SERIES.ts[0]; hi = SERIES.ts[SERIES.ts.length-1]; }
  else return 86400000;
  const full = Math.max(1, hi - lo);
  return full * Math.max(1, (zEnd - zStart)) / 100;   // ширина видимого окна (мс)
}
function parseTs(str) {
  // Парсим АБСОЛЮТНОЕ локальное время БЕЗ часовых поясов (фикс сдвига +8ч).
  // Принимаем "YYYY-MM-DD HH:MM:SS" / "YYYY-MM-DDTHH:MM:SS" и "HH:MM:SS".
  if (!str || typeof str !== "string") return NaN;
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    const d = new Date(+m[1], +m[2] - 1, +m[3]); LAST_DATE_MS = d.getTime();
    return ms;
  }
  m = str.match(/^(\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const base = new Date(LAST_DATE_MS);
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(),
      +m[1], +m[2], +m[3]).getTime();
  }
  return NaN;
}
function msToInput(ms) {
  // для <input type="datetime-local"> -> "YYYY-MM-DDTHH:MM:SS" (локально)
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function inputToMs(v) {
  // парсим значение datetime-local как локальное время (без UTC-сдвига)
  const m = v && v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : NaN;
}

/* ---------- mulberry32 (для mock) ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- mock-каркас (fallback, если API пуст) ---------- */
function genMock() {
  const DURATION_S = 7200;
  const rnd = mulberry32(20260219);
  const chans = [
    { key: "Wk",   name: "Вес на крюке",   color: PALETTE[0], area: true, step: "end" },
    { key: "Hk",   name: "Положение крюка", color: PALETTE[8] },
    { key: "Q",    name: "Расход",          color: PALETTE[7] },
    { key: "Pvh",  name: "Давление вход",   color: PALETTE[2] },
    { key: "Nrot", name: "Обороты ротора",  color: PALETTE[6] },
  ];
  const ts = new Array(DURATION_S);
  const data = {};
  chans.forEach((c) => (data[c.key] = new Array(DURATION_S)));
  let pumpOn = false, rotOn = false;
  for (let i = 0; i < DURATION_S; i++) {
    ts[i] = MOCK_BASE + i * 1000;
    const phase = (i % 300) / 300;
    const hk = (phase < 0.5 ? phase * 2 : (1 - phase) * 2) * 28;
    data.Hk[i] = +hk.toFixed(1);
    let wk = 60 + hk / 6 + (rnd() - 0.5) * 1.2;
    if (rnd() < 0.01) wk += 10 + rnd() * 12;
    data.Wk[i] = +wk.toFixed(1);
    if (rnd() < 0.004) pumpOn = !pumpOn;
    const q = pumpOn ? 28 + (rnd() - 0.5) * 4 : 0.0;
    data.Q[i] = +Math.max(0, q).toFixed(1);
    data.Pvh[i] = +(q > 1 ? 95 + (rnd() - 0.5) * 8 : 2 + rnd()).toFixed(1);
    if (rnd() < 0.003) rotOn = !rotOn;
    data.Nrot[i] = +Math.max(0, rotOn ? 70 + (rnd() - 0.5) * 14 : 0).toFixed(1);
  }
  CHANNELS = chans;
  DEFAULT_ACTIVE = new Set(["Wk", "Hk", "Q"]);
  SERIES = { ts, data };
  N = DURATION_S;
}

/* #B36: плашка «в файле следы старых правок (чужие ниблы)». Обычное 💾
   нормализует их автоматически, поэтому плашка = подсказка «просто сохраните». */
function updateNibBanner(aliens) {
  let el = document.getElementById("nib-warn");
  const names = aliens ? Object.keys(aliens) : [];
  if (!names.length) { if (el) el.remove(); return; }
  const total = names.reduce((a, k) => a + aliens[k], 0);
  if (!el) {
    el = document.createElement("span");
    el.id = "nib-warn"; el.className = "nib-warn";
    const ft = document.getElementById("file-title");
    if (ft && ft.parentNode) ft.parentNode.insertBefore(el, ft.nextSibling);
    else document.body.appendChild(el);
  }
  el.textContent = "⚠ следы правок: " + total + " знач.";
  el.title = "В файле записи с «чужим» масштабом (следы старых битых экспортов; " +
    "Архив показывал их как «некалиброванные»).\nКаналы: " +
    names.map((k) => k + " ×" + aliens[k]).join(", ") +
    "\nОбычное «Сохранить» (💾) нормализует файл автоматически.";
}

/* ---------- загрузка реальных данных из API ---------- */
async function loadData() {
  try {
    const r = await fetch("/api/telemetry", { cache: "no-store" });
    const j = await r.json();
    if (!j || j.source === "missing" || !Array.isArray(j.columns) || j.columns.length < 2
        || !Array.isArray(j.rows) || j.rows.length === 0) {
      return false;
    }
    DAYS = Array.isArray(j.days) ? j.days : [];
    DATE_SRC = j.date_source || null;   // #74: откуда взялась дата суток (name/csv/mtime/kept)
    SOURCE_LABEL = typeof j.source_label === "string" ? j.source_label : null;
    updateNibBanner(j.nib_aliens);   // #B36: следы старых битых экспортов
    DAY_SEL.clear();
    DAYS.forEach((_, i) => DAY_SEL.add(i));      // по умолчанию — все сутки выбраны
    const names = j.columns.slice(1);           // columns[0] = "Время"
    CHANNELS = names.map((nm, i) => ({
      key: "c" + i,
      name: nm,
      color: PALETTE[i % PALETTE.length],
      area: i === 0,
      step: "end",   // #S1: все каналы событийно-сжаты → ступенька (не линейный наклон)
    }));
    DEFAULT_ACTIVE = new Set(CHANNELS.slice(0, 3).map((c) => c.key));
    // роли и накопительные каналы — с сервера, по ИМЕНИ канала (см. CUM_KEYS).
    // roles_ok отличает «каната в файле нет» от «движок ролей не поднялся»:
    // во втором случае предупреждение V8 промолчит, и молчание надо назвать.
    CUM_KEYS = new Set();
    const cumNames = new Set(Array.isArray(j && j.cumulative) ? j.cumulative : []);
    CHANNELS.forEach((c) => { if (cumNames.has(c.name)) CUM_KEYS.add(c.key); });
    ROLES_OK = !(j && j.roles_ok === false);
    ORIGIN_OPENED_AT = (j && j.origin_opened_at) || null;
    if (!ROLES_OK) {
      addNote("warn", "Сервер не смог определить роли каналов, поэтому "
        + "предупреждение о накопительных каналах (наработка каната) сейчас НЕ "
        + "работает: правка такого канала будет отклонена только при сохранении. "
        + "Это неисправность сборки, а не свойство файла.");
    }

    N = j.rows.length;
    const ts = new Array(N);
    const data = {};
    CHANNELS.forEach((c) => (data[c.key] = new Array(N)));
    let lastMs = MOCK_BASE;
    for (let i = 0; i < N; i++) {
      const row = j.rows[i];
      let t = parseTs(row[0]);
      if (!Number.isFinite(t)) t = lastMs + 1000;   // нет таймштампа -> шаг 1 с
      lastMs = t;
      ts[i] = t;
      for (let k = 0; k < names.length; k++) {
        const v = row[k + 1];
        data[CHANNELS[k].key][i] = (v === "" || v == null) ? null : +v;
      }
    }
    SERIES = { ts, data };
    return true;
  } catch (e) {
    console.warn("loadData failed:", e);
    return false;
  }
}

/* ---------- ECharts ---------- */
let chart = null;
let zStart = 0, zEnd = 100;
// Домен горизонтали (в % от всего файла), в котором разрешены зум/панорама.
// По умолчанию весь файл; при выборе суток в дереве сужается на окно суток —
// тогда панорама/зум не «уезжают» во весь массив. См. applyDayView.
let XLO = 0, XHI = 100;
// Абсолютные границы оси X (мс) при выборе суток: xAxis.min/max. null = весь файл
// (авто-экстент). Задаются в applyDayView по КАЛЕНДАРНЫМ границам выбранных суток —
// тогда слайдер-превью и подписи показывают ровно сутки 00:00..24:00, а не весь файл.
let XMIN = null, XMAX = null;

const axisMax = {};         // key -> фикс. максимум (нет ключа = Авто)
const AXIS_W = 52;          // ширина полосы-оси (вертикальный титул + чипы значений)

function hexToRgb(h) {
  h = h.replace("#", "");
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function chipColor(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Индекс первой строки с ts >= t (бинпоиск; SERIES.ts монотонно неубывающая).
function tsIndex(t) {
  const a = SERIES.ts;
  if (!a || !a.length) return 0;
  let lo = 0, hi = a.length - 1;
  if (t <= a[0]) return 0;
  if (t >= a[hi]) return hi;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t) lo = m + 1; else hi = m; }
  return lo;
}
// Видимое окно -> индексы строк. Ось X — type:"time", поэтому zStart/zEnd это
// доля ВРЕМЕНИ (как в dataZoom и рамочном зуме zbApply), а НЕ доля индекса.
// При событийном сжатии (строки неравномерны по времени) это принципиально:
// доля индекса давала неверные границы (хаотичная ось при выборе суток).
function windowRange() {
  const a = SERIES.ts;
  if (!a || !a.length) return [0, Math.max(0, N - 1)];
  const t0 = a[0], t1 = a[N - 1], full = t1 - t0;
  if (full <= 0) return [0, N - 1];
  const i0 = tsIndex(t0 + full * zStart / 100);
  const i1 = tsIndex(t0 + full * zEnd / 100);
  return [Math.max(0, Math.min(i0, i1)), Math.min(N - 1, Math.max(i0, i1))];
}
function windowMinMax(key) {
  const [i0, i1] = windowRange();
  const arr = SERIES.data[key];
  let mn = Infinity, mx = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const v = arr[i];
    if (v == null) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (mx === -Infinity) return [0, 1];
  return [mn, mx];
}
// СТАТИЧНАЯ шкала: min/max по ВСЕМУ датасету (не по видимому окну),
// иначе при панораме/зуме по X шкала Y пересчитывается и график прыгает по вертикали.
// Кэш сбрасывается при смене данных (invalidateScaleCache).
let _fullMinMaxCache = {};
function invalidateScaleCache() { _fullMinMaxCache = {}; }
function fullMinMax(key) {
  const c = _fullMinMaxCache[key];
  if (c) return c;
  const arr = SERIES.data[key] || [];
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v == null) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const res = mx === -Infinity ? [0, 1] : [mn, mx];
  _fullMinMaxCache[key] = res;
  return res;
}
// Общий уровень нуля: нули всех индикаторов ложатся ПОЧТИ на одну линию.
// НЕ обрезаем данные снизу — под нулём держим карман, вмещающий реальные
// минусы (самый глубокий среди каналов). Нули каналов чуть разнесены по
// вертикали (первый выше, каждый следующий ниже) — вплотную, чтобы линии
// нулей не сливались в одну и была видна их взаимосвязь.
const ZERO_MIN = 0.06;    // мин. доля высоты под нулём (карман), когда минусов нет
const ZERO_STEP = 0.007;  // разнос нулей соседних каналов (вплотную)
function chanHi(key) {
  const fixed = axisMax[key];
  if (fixed != null) return fixed;
  const [, mx] = fullMinMax(key);
  return mx <= 0 ? 1 : Math.ceil(mx * 1.3);
}
function zeroBase() {
  // самый глубокий минус (в долях своего hi) среди активных каналов ->
  // общий карман, гарантирующий что НИ ОДИН минус не обрежется.
  const axes = ACTIVE_AXES && ACTIVE_AXES.length ? ACTIVE_AXES : CHANNELS;
  let D = 0;
  for (const c of axes) {
    const [mn] = fullMinMax(c.key);
    const hi = chanHi(c.key);
    if (mn < 0 && hi > 0) { const d = -mn / hi; if (d > D) D = d; }
  }
  let f = (D / (1 + D)) * 1.05;        // доля высоты под нулём + 5% запас
  if (f < ZERO_MIN) f = ZERO_MIN;
  if (f > 0.6) f = 0.6;                // страховка от вырождения на грубых ошибках
  return f;
}
function axisBounds(c) {
  const hi = chanHi(c.key);
  const base = zeroBase();
  const axes = ACTIVE_AXES && ACTIVE_AXES.length ? ACTIVE_AXES : [];
  const n = axes.length;
  const idx = axes.findIndex((a) => a.key === c.key);
  // целевая доля высоты для нуля этого канала (первый выше -> больше доля)
  const f0 = base + (idx >= 0 ? (n - 1 - idx) * ZERO_STEP : 0);
  // lo подбираем так, чтобы frac(0)=f0 (нуль на общем уровне); форма не искажается
  const lo = (-f0 * hi) / (1 - f0);
  return [lo, hi > lo ? hi : lo + 1];
}
// Общее вертикальное окно (доля базового диапазона, единое для ВСЕХ осей).
// {0,1} — полный авто-масштаб. Вертикальный зум/панорама двигают это окно,
// поэтому все каналы масштабируются согласованно (как единый холст ASC).
let VY = { lo: 0, hi: 1 };
function axisView(c) {
  const [b0, b1] = axisBounds(c);
  const s = b1 - b0;
  return [b0 + VY.lo * s, b0 + VY.hi * s];
}

function buildAxesAndSeries() {
  const active = CHANNELS.filter((c) => DEFAULT_ACTIVE.has(c.key));
  ACTIVE_AXES = active;   // ВАЖНО: выставляем ДО axisBounds/zeroBase — иначе на ПЕРВОМ
                          // рендере zeroBase видит пустой ACTIVE_AXES и падает на все CHANNELS
                          // (карман нуля раздувался под самый глубокий минус среди 14 каналов).
  const yAxis = [];
  const series = [];

  // z-порядок: каналы с БОЛЬШИМ диапазоном рисуем СЗАДИ (ниже z), с меньшим —
  // спереди (выше z), чтобы крупные графики «прятались» за мелкими, а полупрозрачные
  // линии (opacity<1) просвечивали в местах пересечений.
  const ranges = active.map((c) => { const [lo, hi] = axisBounds(c); return hi - lo; });
  const order = active.map((_, i) => i).sort((a, b) => ranges[b] - ranges[a]);
  const zByIdx = {}; order.forEach((idx, rank) => { zByIdx[idx] = 2 + rank; });

  active.forEach((c, idx) => {
    // Полосы-оси идут в ПОРЯДКЕ ВКЛАДОК: первый активный канал (idx 0, напр. Вес
    // на крюке) — крайняя ЛЕВАЯ линейка; последний — вплотную к плоттеру.
    const offset = (active.length - 1 - idx) * AXIS_W;
    const [lo, hi] = axisView(c);   // с учётом общего вертикального окна VY
    const isRuler = idx === 0;
    const isFocus = c.key === FOCUS_KEY;
    const chipBg = chipColor(c.color, 0.92);
    const sepBorder = "rgba(255,255,255,0.65)";

    yAxis.push({
      type: "value",
      position: "left",
      offset: offset,
      min: lo,
      max: hi,
      splitNumber: 8,
      triggerEvent: true,
      // вертикальный титул канала прямо в полосе-оси (как на эталоне «Архив»)
      name: shortName(c.name),
      nameLocation: "middle",
      nameRotate: 90,
      nameGap: AXIS_W - 13,
      nameTextStyle: { color: c.color, fontSize: 10, fontWeight: 700 },
      axisLine: { show: true, lineStyle: { color: c.color, width: (isRuler || isFocus) ? 1.5 : 1 } },
      // засечки и подписи смотрят НАЛЕВО (в левый карман), а не в график
      axisTick: { show: true, inside: false, length: 3, lineStyle: { color: c.color } },
      minorTick: { show: isRuler, inside: false, splitNumber: 5, length: 2, lineStyle: { color: "#b9c0c9" } },
      splitLine: { show: isRuler, lineStyle: { color: "#e1e4e9" } },
      minorSplitLine: { show: isRuler, lineStyle: { color: "#f0f2f5" } },
      axisLabel: {
        inside: false,
        margin: 3,
        showMinLabel: true,
        align: "right",
        formatter: (v) => {
          const a = Math.abs(v);
          const s = a >= 100 ? v.toFixed(0) : (a >= 10 ? v.toFixed(1) : v.toFixed(2));
          return (Math.abs(v - hi) < 1e-6) ? `{top|${s}}` : `{chip|${s}}`;
        },
        rich: {
          chip: {
            color: "#fff", fontSize: 9, padding: [2, 2], borderRadius: 2,
            width: AXIS_W - 22, align: "center",
            backgroundColor: chipBg, borderColor: sepBorder, borderWidth: 1,
          },
          top: {
            color: "#fff", fontSize: 9, fontWeight: "bold", padding: [3, 2], borderRadius: 3,
            width: AXIS_W - 22, align: "center",
            backgroundColor: chipBg, borderColor: "#fff", borderWidth: 1.5, shadowBlur: 2,
            shadowColor: "rgba(0,0,0,0.35)",
          },
        },
      },
    });

    // «Вес на крюке» (Wk) — всегда заметнее: непрозрачнее и поверх всех.
    // Клик по линейке -> ФОКУС канала: линия ярче и чуть толще (НЕ жирная),
    // поверх, заливка плотнее. Остальные — полупрозрачные, не перекрывают.
    const isHook = c.key === "Wk";
    const s = {
      name: c.name,
      type: "line",
      smooth: false,
      showSymbol: false,
      connectNulls: false,
      // #v109 (тест 23.07): lttb-даунсэмплинг стал УСЛОВНЫМ — на типовых суточных
      // файлах (~20-25к строк) он сглаживал форму (интервал 12-13), «терял»
      // выделенную линию при зуме/переключении датчика и давал скачки при
      // рисовании (бэйкап-версия без lttb этих багов не имела). Включаем только
      // на аномально больших наборах (>80к строк), где без него тормозит рендер.
      sampling: (N > 80000 ? "lttb" : undefined),
      // #v101 (тест 07-16): large:true УБРАН — батч-рендер canvas не очищал старую
      // геометрию при правке данных -> «фантомные фигуры» в области правки (Alt+Del
      // менял таблицу, но на графике оставался призрак). sampling один даёт перф.
      large: false,
      yAxisIndex: idx,
      z: isFocus ? 110 : (isHook ? 100 : zByIdx[idx]),
      lineStyle: {
        width: isHook ? 1.6 : (isFocus ? 1.4 : 1),
        color: c.color,
        opacity: isHook ? HOOK_OPACITY : (isFocus ? 0.95 : DIM),
      },
      itemStyle: { color: c.color },
      // никакой подсветки/затухания — статичные полупрозрачные линии
      emphasis: { disabled: true },   // #v94: hover-подсветка убрана (по просьбе — было идеально без неё)
      data: SERIES.ts.map((t, i) => [t, SERIES.data[c.key][i]]),
    };
    if (c.step) s.step = c.step;
    // Заливка ПОД линией до нуля — как у Веса на крюке — но для ВСЕХ каналов лёгкая
    // (чтобы не мешала информативности); у Веса плотнее, у фокуса — заметнее.
    s.areaStyle = { color: chipColor(c.color, isHook ? 0.30 : (isFocus ? 0.20 : 0.06)) };
    series.push(s);
  });

  // #B5: слабые пунктирные вертикали на 00:00 каждых суток + мелкая (не жирная)
  // метка «скв.№ · месторождение» справа сверху; при СМЕНЕ № скважины между
  // сутками метка выделяется (акцентная линия) — видно переход на другую скважину.
  const ml = buildDayBoundaryMarkLine();
  if (ml && series.length) series[0].markLine = ml;

  // График физически сдвигается вправо под колонку полос-осей. Подписи и титулы
  // теперь рисуются НАЛЕВО (inside:false) и целиком лежат в левом кармане шириной
  // active*AXIS_W — поэтому ось idx=0 (линейка) стоит у самого края графика и
  // НИЧЕГО не наезжает на белое поле. +10px — лёгкий зазор до первой линии.
  const gridLeft = active.length * AXIS_W + 10;
  const gridRight = 14;

  if (yAxis.length === 0) {
    yAxis.push({ type: "value", axisLine: { lineStyle: { color: "#9aa2ad" } } });
  }
  return { yAxis, series, gridLeft, gridRight, active };
}

let ACTIVE_AXES = [];
let lastRender = { s: -1, e: -1 };

const GRID_TOP = 26, GRID_BOTTOM = 56;   // отступы плоттера (верх — белая полоса под метки суток, чтобы не мешать редактированию)

// Сплошные цветные полосы-оси на ВСЮ высоту графика (как на эталоне «Архив»).
// Рисуем как graphic-прямоугольники в левом кармане; градуировка (ticks/labels/
// титул) идёт поверх через настройки yAxis.
function buildAxisBands(active, gridLeft) {
  const H = chart.getHeight();
  const h = Math.max(10, H - GRID_TOP - GRID_BOTTOM);
  const n = active.length;
  return active.map((c, idx) => {
    // idx 0 (первая вкладка) — крайняя ЛЕВАЯ полоса; последняя — у плоттера.
    const isFocus = c.key === FOCUS_KEY;
    return {
      type: "rect", silent: true, z: isFocus ? 1 : 0,
      left: gridLeft - (n - idx) * AXIS_W, top: GRID_TOP,
      shape: { x: 0, y: 0, width: AXIS_W, height: h },
      style: {
        fill: chipColor(c.color, isFocus ? 0.30 : 0.16),
        stroke: chipColor(c.color, isFocus ? 0.85 : 0.5),
        lineWidth: isFocus ? 2 : 1,
      },
    };
  });
}

// throttle через requestAnimationFrame: при перетаскивании (СПО/превью) не
// копим полные перерисовки графика, а выполняем максимум одну за кадр
// Диммер: патчим только opacity линий у текущих series (без пересборки данных
// на 25k точек) — мгновенно и без мерцания. «Вес на крюке» всегда HOOK_OPACITY.
function applyDim() {
  if (!chart || !ACTIVE_AXES || !ACTIVE_AXES.length) return;
  const series = ACTIVE_AXES.map((c) => {
    const isHook = c.key === "Wk", isFocus = c.key === FOCUS_KEY;
    return { lineStyle: {
      width: isHook ? 1.6 : (isFocus ? 1.4 : 1),
      color: c.color,
      opacity: isHook ? HOOK_OPACITY : (isFocus ? 0.95 : DIM),
    } };
  });
  chart.setOption({ series }, { lazyUpdate: true });
}

let _renderRAF = 0;
function renderChartThrottled() {
  if (_renderRAF) return;
  _renderRAF = requestAnimationFrame(() => { _renderRAF = 0; renderChart(); });
}
let LAST_GRID = { left: 60, right: 14 };   // отступы плоттера (для ПКМ-панорамы)
function renderChart() {
  invalidateScaleCache();   // данные могли измениться (правка/шум/рисование/undo) — пересчитать полный min/max
  _AXTICK = pickAxisTick(visibleSpanMs());   // #v94: адаптивная сетка времени
  const { yAxis, series, gridLeft, gridRight, active } = buildAxesAndSeries();
  ACTIVE_AXES = active;
  LAST_GRID = { left: gridLeft, right: gridRight };
  lastRender = { s: zStart, e: zEnd };
  chart.setOption(
    {
      animation: false,
      // плавный переход состояний наведения (emphasis/blur) ≈1 сек, хотя
      // основная анимация данных выключена ради производительности на 25k точек
      stateAnimation: { duration: 900, easing: "cubicOut" },
      graphic: buildAxisBands(active, gridLeft),
      grid: { left: gridLeft, right: gridRight, top: GRID_TOP, bottom: GRID_BOTTOM },
      tooltip: {
        trigger: "axis",
        // triggerEmphasis:false — ось-тултип показывает значения, но НЕ подсвечивает
        // все линии разом (иначе в пустом месте всё становится ярким и перекрывает)
        // #B28 (живой тест 2026-07-09, "нет плавного передвижения точки вместе
        // с линией за пальцем... привязана к данным а не данные ко времени"):
        // без snap:false ECharts по умолчанию "прилипает" линию-курсор к
        // БЛИЖАЙШЕЙ точке данных (обычная логика axis-триггера) — в разреженных
        // интервалах это выглядит как "прыжки". snap:false отвязывает ЛИНИЮ от
        // данных — она идёт строго за мышью по пикселю/времени; подсказка при
        // этом всё равно показывает значение БЛИЖАЙШЕЙ точки (ступенькой, как и
        // раньше) — это штатная документированная опция ECharts, не кастомная
        // логика, поэтому риск низкий (не трогает разбор/экспорт .asc3).
        axisPointer: { type: "line", snap: false, lineStyle: { color: "#888", width: 1 }, triggerEmphasis: false },
        // компактная полупрозрачная подсказка, закреплена в верхней трети
        // вдоль вертикальной пунктирной линии — не перекрывает картограмму
        backgroundColor: "rgba(255,255,255,0.72)",
        borderColor: "#cbd2dc",
        borderWidth: 1,
        padding: [5, 8],
        textStyle: { fontSize: 11, color: "#222" },
        extraCssText: "box-shadow:0 1px 6px rgba(0,0,0,.12);backdrop-filter:blur(1px);",
        position: (point, params, dom, rect, size) => {
          const vw = size.viewSize[0], cw = size.contentSize[0];
          let x = point[0] + 12;                       // рядом с линией курсора
          if (x + cw > vw - 6) x = point[0] - cw - 12; // не вылезать за правый край
          if (x < 6) x = 6;
          const y = Math.max(6, size.viewSize[1] * 0.06); // верхняя треть
          return [x, y];
        },
        formatter: (params) => {
          if (!params || !params.length) return "";
          // #B18 «скачок курсора»: раньше время/значения брались у БЛИЖАЙШЕЙ
          // записанной точки (axisValue) — на событийной записи подсказка прыгала
          // по точкам и не давала ТОЧНУЮ секунду (оригинал ASC даёт). Теперь:
          // секунда = время курсора, округлённое к такту 1 Гц; значение канала =
          // последняя записанная точка <= этой секунды (ступенчатое удержание,
          // ровно то, что рисует линия step:"end"; null -> «х», как разрыв линии).
          const tc = Number.isFinite(HOV_T) ? Math.round(HOV_T / 1000) * 1000 : NaN;
          if (!Number.isFinite(tc) || !SERIES.ts || !SERIES.ts.length) {
            let html = "<b>" + fmtTime(params[0].axisValue) + "</b>";
            params.forEach((p) => {
              const v = p.value && p.value[1] != null ? (+p.value[1]).toFixed(2) : "х";
              html += "<br/>" + p.marker + " " + escHtml(p.seriesName) + ": <b>" + v + "</b>";   // #A20/Z4
            });
            return html;
          }
          let i = tsIndex(tc);
          if (i > 0 && SERIES.ts[i] > tc) i--;           // последняя точка <= tc
          const before = SERIES.ts[i] <= tc;             // курсор левее первой записи -> «х»
          let html = "<b>" + fmtTime(tc) + "</b>";
          // #v109 (K4, тест 23.07 «индикатор прыгает, а не отображает вес линии»):
          // в режиме рисования значение ЦЕЛЕВОГО канала = Y под курсором (то, что
          // ляжет в данные), а не ступень последней записи.
          const _dk = (typeof DRAW !== "undefined" && DRAW.active) ? drawTargetKey() : null;
          const _dyIdx = _dk ? ACTIVE_AXES.findIndex((c) => c.key === _dk) : -1;
          params.forEach((p) => {
            const c = CHANNELS.find((x) => x.name === p.seriesName);
            if (c && _dk === c.key && _dyIdx >= 0 && Number.isFinite(HOV_PY)) {
              const cv = chart.convertFromPixel({ yAxisIndex: _dyIdx }, HOV_PY);
              if (Number.isFinite(cv)) {
                html += "<br/>" + p.marker + " " + escHtml(p.seriesName) + ": <b>" + (+cv).toFixed(2) + "</b> ✎";   // #A20/Z4
                return;
              }
            }
            const arr = c ? SERIES.data[c.key] : null;
            const raw = (arr && before) ? arr[i] : null;
            const v = raw == null ? "х" : (+raw).toFixed(2);
            html += "<br/>" + p.marker + " " + escHtml(p.seriesName) + ": <b>" + v + "</b>";   // #A20/Z4
          });
          return html;
        },
      },
      xAxis: {
        type: "time",
        // Границы оси: при выборе суток сужаем ось на КАЛЕНДАРНЫЕ сутки (00:00..24:00),
        // чтобы слайдер-превью и подписи показывали ровно эти сутки, а не весь файл.
        // null → авто-экстент (все сутки). См. applyDayView / XMIN,XMAX.
        // #B26 (живой тест 2026-07-09, "в режиме сутки ось времени не
        // масштабируется, теряет подписи"): xAxis раньше НЕ входил в
        // replaceMerge (см. setOption ниже) — при повторном setOption
        // ECharts домёрживал новый xAxis поверх СТАРОГО вместо замены, и
        // min/max от предыдущего рендера (например, от прошлого выбора
        // суток) мог "прилипнуть" вместо актуального окна. Явный null
        // (а не undefined) — задокументированный в ECharts способ сказать
        // "авто-экстент", надёжнее, чем полагаться на то, что undefined-поле
        // просто выпадет при сериализации. xAxis добавлен в replaceMerge.
        min: XMIN,
        max: XMAX,
        minInterval: _AXTICK.mi,         // #v94: адаптивно по видимому окну (минуты при зуме, дни на многосуточном)
        maxInterval: _AXTICK.ma,
        axisLabel: { formatter: (v) => _AXTICK.fmt(v), color: "#333", fontSize: 11, hideOverlap: true },
        axisLine: { lineStyle: { color: "#9aa2ad" } },
        splitLine: { show: true, lineStyle: { color: "#e3e6ea" } },
        // #v99: snap:false и на самой оси — чтобы линия-курсор шла строго за
        // мышью (пиксель/секунда), а не «прилипала» к ближайшей точке данных.
        axisPointer: { snap: false },
      },
      // глобальный axisPointer — дублирует snap:false для надёжности (ECharts иногда
      // берёт snap с axis-уровня, а не с tooltip-уровня)
      axisPointer: { snap: false, link: [{ xAxisIndex: "all" }] },
      yAxis: yAxis,
      dataZoom: [
        // Зум/панораму по графику ведём САМИ (onWheel + ПКМ/ЛКМ-жесты через dispatchAction).
        // Компонент "inside" УБРАН: его roam-обработчик на canvas перехватывал колесо
        // (наш onWheel до всплытия не доходил) и вешал страницу. Оставляем только slider —
        // он даёт визуальную линейку и НАТИВНОЕ перетаскивание окна мышью.
        { type: "slider", start: zStart, end: zEnd, height: 18, bottom: 14 },
      ],
      series: series,
    },
    { replaceMerge: ["series", "yAxis", "graphic", "xAxis", "axisPointer"] }
  );
  positionSelBand();   // полоса ПКМ-выделения следует за новыми границами плоттера
  renderRuler();       // линейка месторождение/скважина над графиком
}

/* ---------- ЗАДАЧА 5: окно времени через поля datetime-local ---------- */
function bindTimeRange() {
  const a = document.getElementById("timeStart");
  const b = document.getElementById("timeEnd");
  if (!a || !b || !SERIES.ts.length) return;
  const t0 = SERIES.ts[0];
  const t1 = SERIES.ts[SERIES.ts.length - 1];
  // инициализация началом и концом файла (абсолютное локальное время)
  a.value = msToInput(t0); b.value = msToInput(t1);
  a.min = b.min = msToInput(t0);
  a.max = b.max = msToInput(t1);

  const apply = () => {
    let s = inputToMs(a.value);
    let e = inputToMs(b.value);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return;
    chart.dispatchAction({ type: "dataZoom", startValue: s, endValue: e });
  };
  a.onchange = apply;
  b.onchange = apply;
}
// синхронизируем поля при зуме мышью/слайдером
function syncTimeInputs() {
  const a = document.getElementById("timeStart");
  const b = document.getElementById("timeEnd");
  if (!a || !b || !SERIES.ts.length) return;
  const [i0, i1] = windowRange();
  a.value = msToInput(SERIES.ts[i0]);
  b.value = msToInput(SERIES.ts[i1]);
}

/* ---------- ручной масштаб оси ---------- */
function openAxisMax(c) {
  const cur = axisMax[c.key];
  const val = window.prompt(
    "Максимум для оси «" + c.name + "»\n" +
    "Режим сейчас: " + (cur != null ? "фикс " + cur : "Авто") + "\n\n" +
    "Введите число, чтобы зафиксировать. «авто» или пусто — сбросить:",
    cur != null ? String(cur) : ""
  );
  if (val === null) return;
  const t = val.trim().toLowerCase();
  const btn = document.querySelector('.chan-btn[data-key="' + c.key + '"]');
  if (t === "" || t === "авто" || t === "auto") {
    delete axisMax[c.key];
    if (btn) btn.classList.remove("fixed");
    addNote("status", "Ось " + c.name + ": возврат в Авто-масштаб.");
  } else {
    const num = parseFloat(val.replace(",", "."));
    if (isNaN(num)) { window.alert("Это не число."); return; }
    axisMax[c.key] = num;
    if (btn) btn.classList.add("fixed");
    addNote("status", "Ось " + c.name + ": зафиксирован max = " + num + ".");
  }
  renderChart();
}

// Колесо над цветной линейкой канала: меняем max оси — график канала
// становится ВЫШЕ (меньше max) или НИЖЕ (больше max). Удобно «прижать»
// Момент на ключе / Скорость СПО, чтобы не перекрывали Вес на крюке.
function wheelAxisMax(c, up) {
  const [mn, mx] = fullMinMax(c.key);
  const auto = mx <= 0 ? (mn < 0 ? 0 : 1) : Math.ceil(mx * 1.3);
  let cur = axisMax[c.key];
  if (cur == null) cur = auto;
  let next = up ? cur * 1.15 : cur / 1.15;   // вверх — max БОЛЬШЕ (короче), вниз — МЕНЬШЕ (выше)
  next = Math.round(next);
  if (next === cur) next = up ? cur + 1 : cur - 1;
  if (next < 1) next = 1;
  axisMax[c.key] = next;
  const btn = document.querySelector('.chan-btn[data-key="' + c.key + '"]');
  if (btn) btn.classList.add("fixed");
  renderChartThrottled();
}

let zoomTimer = null;
function bindChartEvents() {
  chart.on("dataZoom", () => {
    const dz = chart.getOption().dataZoom[0];
    zStart = dz.start; zEnd = dz.end;
    syncTimeInputs();
    if (typeof markZoomed === "function") markZoomed();
    if (RULER_ON && !RULER_STATE.dragging) renderRuler();  // линейка следует за окном
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      if (Math.abs(zStart - lastRender.s) < 0.01 && Math.abs(zEnd - lastRender.e) < 0.01) return;
      renderChart();
    }, 130);
  });
  chart.on("click", (p) => {
    if (p.componentType !== "yAxis") return;
    const c = ACTIVE_AXES[p.yAxisIndex];
    if (c) openAxisMax(c);
  });
  let rsTimer = null;
  window.addEventListener("resize", () => {
    chart.resize();
    clearTimeout(rsTimer);
    rsTimer = setTimeout(renderChart, 120);   // пересчитать высоту цветных полос-осей
  });
}

/* ====================================================================
   ПОДСВЕТКА ПО ЗАДЕРЖКЕ (dwell):
   Зона захвата — снап-точки под курсором (по одной на каждый включённый
   канал, двигаются влево/вправо вместе с курсором). Логика:
   • курсор замер у точки канала дольше DWELL_MS (2с) -> линия плавно
     (≈1с, stateAnimation) проявляется до 90%;
   • остаётся подсвеченной, пока курсор у точки; когда ушёл с точки —
     держится ещё HOLD_MS (10с), затем плавно (≈1с) гаснет до 0.35;
   • повторная задержка у той же точки до истечения 10с — отменяет гашение.
   ==================================================================== */
const DWELL_MS = 2000, HOLD_MS = 10000, CATCH_PX = 22, STILL_PX = 5;
let HOV = { onSeries: -1 };  // #v93: строгий индивидуальный hover
// #B18: точное ВРЕМЯ под курсором (мс). Тултип оси показывает ближайшую ЗАПИСАННУЮ
// точку — на событийно-сжатой записи (строка раз в ~7с и реже) время в подсказке
// «прыгало» и не давало точную секунду. Держим сырое время курсора здесь и строим
// ридаут сами (см. formatter тултипа): секунда = округление к такту 1 Гц, значение =
// последняя записанная точка <= этой секунды (ровно то, что рисует step:"end").
let HOV_T = NaN;
let HOV_PY = NaN;  // #v109 (K4): пиксель Y курсора — ридаут «вес линии» при рисовании
const HOV_HIT_PX = 6;        // подсветка ТОЛЬКО когда курсор прямо на линии
function hovNearestSeries(px, py) {
  const t = chart.convertFromPixel({ xAxisIndex: 0 }, px);
  if (!Number.isFinite(t)) return { idx: -1, dist: Infinity };
  const di = nearestIdx(t);
  let best = -1, bd = Infinity;
  for (let i = 0; i < ACTIVE_AXES.length; i++) {
    const v = SERIES.data[ACTIVE_AXES[i].key][di];
    if (v == null) continue;
    const yp = chart.convertToPixel({ yAxisIndex: i }, v);
    if (!Number.isFinite(yp)) continue;
    const d = Math.abs(yp - py);
    if (d < bd) { bd = d; best = i; }
  }
  return { idx: best, dist: bd };
}
function hovClear() {
  if (HOV.onSeries >= 0) { chart.dispatchAction({ type: "downplay", seriesIndex: HOV.onSeries }); HOV.onSeries = -1; }
}
function hovHighlight(sIdx) {
  if (HOV.onSeries === sIdx) return;
  hovClear();
  HOV.onSeries = sIdx;
  chart.dispatchAction({ type: "highlight", seriesIndex: sIdx });
}
function hovOnMove(px, py) {
  // #v94: hover-подсветка отключена полностью (по просьбе). Линии статичны;
  // вертикальная линия-курсор со значением остаётся (отдельно, через axisPointer).
}
function bindHoverDwell() {
  const zr = chart.getZr();
  zr.on("mousemove", (e) => {
    // #v109 (K4, тест 23.07): время/пиксель курсора обновляем ВСЕГДА (и в режимах
    // правки) — иначе при рисовании ридаут замирал и «прыгал» по ближайшим точкам.
    HOV_T = px2time(e.offsetX, e.offsetY);   // #B18: сырое время курсора для ридаута
    HOV_PY = e.offsetY;
    if (editDragOn()) return;            // в режимах рисования/стёрки/СПО — не мешаем
    // Курсор: над линейкой ↕ (ns-resize — колесо меняет max), над графиком — ладонь (grab).
    const dom = document.getElementById("chart");
    if (dom && !GEST && !PAN) {
      dom.style.cursor = (e.offsetX > 0 && e.offsetX < LAST_GRID.left) ? "ns-resize" : "grab";
    }
    hovOnMove(e.offsetX, e.offsetY);
  });
  zr.on("globalout", () => { hovClear(); HOV_T = NaN; HOV_PY = NaN; });
}

/* ---------- кнопки каналов ---------- */
function buildChannelTabs() {
  const box = document.getElementById("channel-tabs");
  box.innerHTML = "";
  CHANNELS.forEach((c) => {
    const b = document.createElement("button");
    b.className = "chan-btn" + (DEFAULT_ACTIVE.has(c.key) ? " active" : "");
    b.dataset.key = c.key;
    b.title = c.name;   // полное имя во всплывающей подсказке
    b.innerHTML = `<span class="dot"></span><span class="cname">${escHtml(shortName(c.name))}</span>`;   // #A20
    const dot = b.querySelector(".dot");
    if (DEFAULT_ACTIVE.has(c.key)) { b.style.background = c.color; b.style.borderColor = c.color; }
    dot.style.background = c.color;
    b.addEventListener("click", () => {
      if (DEFAULT_ACTIVE.has(c.key)) {
        DEFAULT_ACTIVE.delete(c.key);
        b.classList.remove("active"); b.style.background = "#fff"; b.style.borderColor = "";
      } else {
        DEFAULT_ACTIVE.add(c.key);
        b.classList.add("active"); b.style.background = c.color; b.style.borderColor = c.color;
      }
      renderChart();
    });
    box.appendChild(b);
  });
}

/* ---------- посуточная лента (многосуточный .asc3) ---------- */
// Показываем тумблеры суток только для файлов с >1 сутками. Клик по чипу
// переключает сутки в выборке (показ + сохранение). Кадрируем график по
// диапазону выбранных суток и фильтруем таблицу. По умолчанию выбраны все.
// Верхняя лента суток убрана — выбор суток теперь в дереве слева.
// Функция оставлена как no-op (прячет контейнер), чтобы не трогать вызовы.
function buildDayBar() {
  const box = document.getElementById("day-bar");
  if (box) { box.style.display = "none"; box.innerHTML = ""; }
}
// Кадрируем график на диапазон выбранных суток и фильтруем таблицу.
// Все сутки выбраны -> показываем весь файл (сброс окна на 0–100%).
// Полночь (локальные мс) для даты "YYYY-MM-DD" из DAYS[i].date
function dayMidnightMs(dstr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dstr || "");
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0).getTime();
}

// #B5: пунктирные вертикали на 00:00 каждых суток с мелкой меткой «скв.№ · м-е».
// № скважины/месторождение берём из ПРЕАМБУЛЫ .asc3 (TREE_MODEL[0].dates[i]);
// при СМЕНЕ скважины между сутками — линия акцентная (заметнее), метка обязательна.
// null → markLine не рисуем (моно-сутки/нет метаданных).
function buildDayBoundaryMarkLine() {
  // #v94: пунктирная вертикаль на 00:00 КАЖДЫХ суток в видимом окне (в т.ч. при
  // нескольких выбранных сутках). Без подписей (инфо в дереве). Упрощено, чтобы
  // линии рисовались стабильно и в много-суточном виде.
  if (!DAYS || DAYS.length < 1) return null;
  const data = [];
  DAYS.forEach((d) => {
    const t = dayMidnightMs(d.date);
    if (!Number.isFinite(t)) return;
    if (XMIN != null && (t < XMIN - 1 || t > XMAX + 1)) return;   // вне окна
    data.push({ xAxis: t, lineStyle: { color: "#8a93a3", width: 1, type: "dashed", opacity: 0.6 } });
  });
  if (!data.length) return null;
  return { silent: true, symbol: "none", z: 5, emphasis: { disabled: true }, label: { show: false }, data };
}

/* ==================================================================
   ЛИНЕЙКА над графиком: месторождение + № скважины по сериям суток.
   • сутки группируются в непрерывные серии по № скважины (одна ячейка = одна
     скважина); подписи месторождения/скважины редактируются по клику;
   • разделитель между ячейками тянется мышью — физически двигает границу
     «где кончается одна скважина и начинается следующая» с перезаписью в файл
     (крайние сутки переназначаются соседней скважине: patch_well + patch_field);
   • правка месторождения распространяется вперёд на серии того же названия
     (/api/patch_field propagate=true).
   ================================================================== */
let RULER_ON = false;  // линейка убрана по решению 07.07: правка № скв/м-я — через дерево;
                       // метки суток вернулись в белую полосу (markLine, #B5/#B6)
let RULER_STATE = { runs: [], dragging: false };

// стабильный оттенок по № скважины: одинаковый номер → один цвет, другой → иной
function wellTint(s, a) {
  s = String(s == null ? "" : s);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const light = a < 0.6 ? 72 : 46;
  return "hsla(" + hue + ",52%," + light + "%," + a + ")";
}

// серии суток по № скважины (соседние сутки с тем же № — одна ячейка)
function rulerRuns() {
  const meta = (TREE_MODEL[0] && TREE_MODEL[0].dates) || [];
  const runs = [];
  if (!DAYS || !DAYS.length) return runs;
  DAYS.forEach((d, i) => {
    const md = meta[i] || {};
    const well = (md.well != null ? md.well : d.well) || "—";
    const field = (md.field != null ? md.field : d.field) || "";
    const last = runs[runs.length - 1];
    if (last && String(last.well) === String(well)) {
      last.i1 = i; if (!last.field) last.field = String(field || "");
    } else {
      runs.push({ i0: i, i1: i, well: String(well), field: String(field || "") });
    }
  });
  return runs;
}

function ensureRulerEl() {
  const host = document.getElementById("chart");
  if (!host) return null;
  let bar = document.getElementById("ruler");
  if (!bar) { bar = document.createElement("div"); bar.id = "ruler"; host.appendChild(bar); }
  return bar;
}

// пиксель по времени в системе координат #chart (0 — левый край контейнера)
function tPx(t) {
  const p = chart.convertToPixel({ xAxisIndex: 0 }, t);
  return Number.isFinite(p) ? p : null;
}

function renderRuler() {
  const bar = ensureRulerEl();
  if (!bar || !chart) return;
  if (!RULER_ON || !DAYS || DAYS.length < 1) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "block";
  bar.style.width = chart.getWidth() + "px";
  bar.innerHTML = "";
  const runs = rulerRuns();
  RULER_STATE.runs = runs;
  const gL = LAST_GRID.left, gR = chart.getWidth() - LAST_GRID.right;
  runs.forEach((r, ri) => {
    const tL = dayMidnightMs(DAYS[r.i0].date);
    const tR = dayMidnightMs(DAYS[r.i1].date) + 86400000;
    let xL = tPx(tL), xR = tPx(tR);
    if (xL == null || xR == null) return;
    xL = Math.max(gL, Math.min(gR, xL));
    xR = Math.max(gL, Math.min(gR, xR));
    if (xR - xL < 2) return;                       // серия вне окна просмотра
    const cell = document.createElement("div");
    cell.className = "rl-cell";
    cell.style.left = xL + "px";
    cell.style.width = (xR - xL) + "px";
    cell.style.background = wellTint(r.well, 0.42);
    cell.style.borderColor = wellTint(r.well, 0.8);
    cell.dataset.run = ri;
    const fld = document.createElement("span");
    fld.className = "rl-fld"; fld.textContent = r.field || "—";
    fld.title = "Месторождение (клик — правка; применится к этим и последующим суткам того же названия)";
    fld.onclick = (e) => { e.stopPropagation(); editRunField(r); };
    const sep = document.createElement("span"); sep.className = "rl-sep"; sep.textContent = "· скв.";
    const wel = document.createElement("span");
    wel.className = "rl-wel"; wel.textContent = r.well;
    wel.title = "№ скважины (клик — правка всех суток этой серии, запись в файл)";
    wel.onclick = (e) => { e.stopPropagation(); editRunWell(r); };
    cell.appendChild(fld); cell.appendChild(sep); cell.appendChild(wel);
    bar.appendChild(cell);
  });
  // разделители между соседними сериями — точки перетаскивания границы
  for (let ri = 0; ri < runs.length - 1; ri++) {
    const b = runs[ri].i1 + 1;                     // индекс первых суток следующей серии
    const xb = tPx(dayMidnightMs(DAYS[b].date));
    if (xb == null || xb < gL - 2 || xb > gR + 2) continue;
    const h = document.createElement("div");
    h.className = "rl-div";
    h.style.left = xb + "px";
    h.title = "Тянуть — сдвинуть границу скважин по суткам (перезапись в файл)";
    h.addEventListener("mousedown", (e) => startBoundaryDrag(e, ri));
    bar.appendChild(h);
  }
}

// перетаскивание границы между серией leftRunIdx и следующей
function startBoundaryDrag(e, leftRunIdx) {
  e.preventDefault(); e.stopPropagation();
  const runs = RULER_STATE.runs;
  const L = runs[leftRunIdx], R = runs[leftRunIdx + 1];
  if (!L || !R) return;
  const b0 = L.i1 + 1;                             // текущая граница
  const bMin = L.i0 + 1;                           // левая серия хранит ≥1 сутки
  const bMax = R.i1;                               // правая серия хранит ≥1 сутки
  const host = document.getElementById("chart");
  const rect = host.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "rl-ghost";
  host.appendChild(ghost);
  RULER_STATE.dragging = true;
  let curB = b0;
  const dayX = (i) => tPx(dayMidnightMs(DAYS[i].date));
  function nearestB(clientX) {
    const px = clientX - rect.left;
    let best = b0, bd = Infinity;
    for (let i = bMin; i <= bMax; i++) {
      const x = dayX(i); if (x == null) continue;
      const d = Math.abs(x - px);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function preview() {
    const x = dayX(curB);
    if (x != null) ghost.style.left = x + "px";
    const cells = document.querySelectorAll(".rl-cell");
    cells.forEach((c) => c.classList.remove("rl-pull"));
    if (cells[leftRunIdx]) cells[leftRunIdx].classList.add("rl-pull");
    if (cells[leftRunIdx + 1]) cells[leftRunIdx + 1].classList.add("rl-pull");
  }
  preview();
  function onMove(ev) { curB = nearestB(ev.clientX); preview(); }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    ghost.remove();
    RULER_STATE.dragging = false;
    if (curB !== b0) applyBoundaryMove(leftRunIdx, b0, curB);
    else renderRuler();
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// перезапись файла: крайние сутки переходят к соседней скважине
async function applyBoundaryMove(leftRunIdx, b0, b1) {
  const runs = RULER_STATE.runs;
  const L = runs[leftRunIdx], R = runs[leftRunIdx + 1];
  if (!L || !R) return;
  let days = [], well, field;
  if (b1 < b0) {                                   // граница влево: хвост левой → правой
    for (let i = b1; i < b0; i++) days.push(i);
    well = R.well; field = R.field;
  } else {                                         // граница вправо: голова правой → левой
    for (let i = b0; i < b1; i++) days.push(i);
    well = L.well; field = L.field;
  }
  if (!days.length) { renderRuler(); return; }
  addNote("status", "Сдвиг границы: сутки [" + days.join(",") + "] → скв." + well +
    (field ? " · " + field : "") + "…");
  await patchWellDays(days, well);               // № скважины (перечитывает DAYS)
  for (const di of days) { await patchFieldDay(di, field, false); }  // месторождение
  buildTree(); renderChart();
}

async function editRunField(r) {
  const v = window.prompt("Месторождение для скв." + r.well +
    "\n(запишется в файл; применится к этим и последующим суткам того же названия):",
    r.field || "");
  if (v === null) return;
  const nf = v.trim();
  if (!nf || nf === r.field) return;
  await patchFieldDay(r.i0, nf, true);
  buildTree(); renderChart();
}

async function editRunWell(r) {
  const v = window.prompt("№ скважины для суток " +
    humanDate(DAYS[r.i0].date) + " … " + humanDate(DAYS[r.i1].date) +
    "\n(запишется в файл .asc3):", r.well || "");
  if (v === null) return;
  const nw = v.trim();
  if (!nw || nw === r.well) return;
  const list = [];
  for (let i = r.i0; i <= r.i1; i++) list.push(i);
  await patchWellDays(list, nw);
}

// патч месторождения одних суток (+опц. проброс вперёд), обновляет DAYS
async function patchFieldDay(day, field, propagate) {
  let j;
  try {
    const r = await fetch("/api/patch_field", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day, field, propagate: !!propagate }),
    });
    j = await r.json();
  } catch (e) { addNote("status", "Ошибка запроса месторождения: " + e); return false; }
  if (!j || !j.ok) {
    addNote("status", "Месторождение не записано: " + ((j && j.error) || "не удалось"));
    return false;
  }
  if (j.warn) addNote("warn", j.warn);   // см. patchWellDays
  if (Array.isArray(j.days)) {
    j.days.forEach((d, i) => {
      if (DAYS[i]) { DAYS[i].well = d.well; DAYS[i].field = d.field; DAYS[i].krs = d.krs; }
    });
  }
  addNote("status", "Месторождение → «" + field + "» записано" +
    (propagate ? " (проброс на серии того же названия)" : "") + ".");
  return true;
}

function applyDayView() {
  if (!DAYS.length || !N) return;
  const sel = [...DAY_SEL].sort((a, b) => a - b);
  if (sel.length && sel.length < DAYS.length) {
    // Сужаем ОСЬ на КАЛЕНДАРНЫЕ границы выбранных суток: 00:00 первых → 24:00 последних.
    // Ось type:"time" с заданными min/max делает слайдер-превью ровно суточным, а
    // проценты dataZoom (zStart/zEnd, XLO/XHI) становятся долей ВНУТРИ суток → зум/панорама
    // и клампы работают в суточных границах независимо от того, сколько суток в файле.
    const mMin = dayMidnightMs(DAYS[sel[0]].date);
    const mMax = dayMidnightMs(DAYS[sel[sel.length - 1]].date) + 86400000;
    if (Number.isFinite(mMin) && Number.isFinite(mMax) && mMax > mMin) {
      XMIN = mMin; XMAX = mMax;
    } else {
      // fallback: если даты нет — по фактическим данным суток
      let lo = Infinity, hi = -Infinity;
      sel.forEach((di) => {
        lo = Math.min(lo, DAYS[di].start);
        hi = Math.max(hi, DAYS[di].start + DAYS[di].count - 1);
      });
      XMIN = SERIES.ts[Math.max(0, lo)];
      XMAX = SERIES.ts[Math.min(N - 1, hi)];
    }
    XLO = 0; XHI = 100; zStart = 0; zEnd = 100;
    renderChart();                 // ось пересоберётся с новыми min/max
    markZoomed();                  // #B47: класс .zoomed мог зависнуть после смены суток
    scopeTimeInputsMs(XMIN, XMAX - 1000);
  } else {
    XMIN = null; XMAX = null;      // выбраны все сутки — весь файл (авто-экстент)
    XLO = 0; XHI = 100; zStart = 0; zEnd = 100;
    renderChart();
    markZoomed();                  // #B47
    if (SERIES.ts.length) scopeTimeInputsMs(SERIES.ts[0], SERIES.ts[N - 1]);
  }
  if (GRID_API && typeof GRID_API.onFilterChanged === "function") GRID_API.onFilterChanged();
}
// Ограничить поля datetime-local абсолютным окном [t0..t1] (мс)
function scopeTimeInputsMs(t0, t1) {
  const a = document.getElementById("timeStart");
  const b = document.getElementById("timeEnd");
  if (!a || !b || !Number.isFinite(t0) || !Number.isFinite(t1)) return;
  a.min = b.min = msToInput(t0);
  a.max = b.max = msToInput(t1);
  a.value = msToInput(t0);
  b.value = msToInput(t1);
}
// Ограничить поля времени (datetime-local) окном [i0..i1]: min/max/value = границы
// выбранных суток. Убирает «абракадабру» календаря (спиннер на весь файл) и держит
// время панели в синхроне с графиком.
function scopeTimeInputs(i0, i1) {
  const a = document.getElementById("timeStart");
  const b = document.getElementById("timeEnd");
  if (!a || !b || !SERIES.ts || !SERIES.ts.length) return;
  const t0 = SERIES.ts[Math.max(0, i0)];
  const t1 = SERIES.ts[Math.min(SERIES.ts.length - 1, i1)];
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return;
  a.min = b.min = msToInput(t0);
  a.max = b.max = msToInput(t1);
  a.value = msToInput(t0);
  b.value = msToInput(t1);
}

/* ---------- Ag-Grid ---------- */
const NAME2KEY = {};
let GRID_API = null;

function buildGrid() {
  // Повторный вызов (открытие файла поверх стартового пробника) обязан снести
  // предыдущий экземпляр Ag-Grid: createGrid ДОБАВЛЯЕТ грид в контейнер, и без
  // destroy пользователь продолжает смотреть на старую таблицу, пока GRID_API
  // указывает на новую, невидимую (замечание владельца 12.08 №3).
  if (GRID_API) {
    try { GRID_API.destroy(); } catch (e) { /* грид уже разрушен */ }
    GRID_API = null;
  }
  const gridDiv = document.getElementById("grid");
  if (gridDiv) gridDiv.innerHTML = "";
  for (const k in NAME2KEY) delete NAME2KEY[k];

  CHANNELS.forEach((c) => (NAME2KEY[c.name] = c.key));
  const colDefs = [
    // ширина под «ЧЧ:ММ:СС» моноширинным + флажок выделения: при 92 px время
    // обрезалось до «08:0…» (найдено на демо сайта 17.10.2026)
    { field: "Время", width: 118, minWidth: 110, pinned: "left", editable: false,
      checkboxSelection: true, headerCheckboxSelection: true,
      cellStyle: { fontFamily: "var(--mono)" } },
  ];
  CHANNELS.forEach((c) => {
    colDefs.push({
      field: c.name,
      headerName: shortName(c.name),   // короткий заголовок
      headerTooltip: c.name,           // полное имя при наведении
      flex: 1, minWidth: 46,           // делят ширину поровну -> все каналы в строке
      type: "numericColumn",
      editable: true,
      // «х» = осознанный разрыв (null). Показываем «х», а не пусто, чтобы
      // отличать намеренный разрыв от незаполненного значения.
      valueFormatter: (p) => (p.value == null || p.value === "" ? "х" : Number(p.value).toFixed(2)),
      // ввод «х»/«x»/пусто/«-» -> null (разрыв); иначе число.
      valueParser: (p) => {
        const s = String(p.newValue).trim().toLowerCase();
        if (s === "" || s === "х" || s === "x" || s === "-" || s === "—") return null;
        const n = parseFloat(s.replace(",", "."));
        return isNaN(n) ? p.oldValue : n;
      },
      cellStyle: (p) => {
        const st = (p.value == null || p.value === "")
          ? { color: "#c0392b", fontStyle: "italic", textAlign: "center" }
          : {};
        if (isCellSel(p)) st.backgroundColor = "rgba(56,132,255,.22)";  // подсветка только выбранных индикаторов
        return Object.keys(st).length ? st : null;
      },
    });
  });

  const rowData = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = fmtTime(SERIES.ts[i]);
    const row = { "Время": t, __idx: i };
    CHANNELS.forEach((c) => (row[c.name] = SERIES.data[c.key][i]));
    rowData[i] = row;
  }

  let hideTimer = null;
  // Индекс берём из строки (__idx), а НЕ по времени: время пишется с точностью
  // до секунды, и записи-близнецы в одной секунде (в этом файле их 380 из 22415)
  // дают один ключ — по времени промахнёшься мимо строки. __idx уникален.
  const syncChart = (idx) => {
    if (idx == null || !ACTIVE_AXES.length) return;
    clearTimeout(hideTimer);
    chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: idx });
  };

  agGrid.createGrid(gridDiv, {
    columnDefs: colDefs,
    rowData,
    headerHeight: 24,
    rowHeight: 20,
    defaultColDef: { sortable: true, filter: true, resizable: true },
    rowSelection: "multiple",
    suppressRowClickSelection: true,
    // внешний фильтр таблицы по выбранным суткам (посуточная лента)
    isExternalFilterPresent: () => daySelActive(),
    doesExternalFilterPass: (node) => {
      const i = node.data ? node.data.__idx : null;
      if (i == null) return true;
      return DAY_SEL.has(dayOfIndex(i));
    },
    onCellMouseOver: (e) => { if (e.data) syncChart(e.data.__idx); },
    onCellMouseOut: () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => chart.dispatchAction({ type: "hideTip" }), 120);
    },
    onCellValueChanged: (e) => {
      if (SUPPRESS_EDIT) return;       // программное обновление (undo/redo/refresh) — не пишем в историю
      const key = NAME2KEY[e.colDef.field];
      const idx = e.data.__idx;   // не по времени: близнецы в одной секунде увели бы правку в чужую запись
      if (key && idx != null) {
        SERIES.data[key][idx] = e.newValue;
        renderChart();                 // правка в таблице сразу меняет график
        histPush("Правка " + shortName(e.colDef.field) + " @ " + e.data["Время"]);
      }
      addNote("note", "Правка: " + e.colDef.field + " @ " + e.data["Время"] +
        " → " + (e.newValue == null ? "«х» (разрыв)" : Number(e.newValue).toFixed(2)) + ".");
    },
    onGridReady: (e) => { GRID_API = e.api; e.api.sizeColumnsToFit(); },
    onGridSizeChanged: (e) => e.api.sizeColumnsToFit(),
  });
}

/* ---------- дерево бригад (только ФАКТИЧЕСКИ загруженные данные) ---------- */
// Модель: бригада -> месторождение/скважина -> загруженные заезды.
// Поля редактируются через ПКМ-контекстное меню (правка «в исходнике» — пока
// в памяти; постоянное сохранение требует backend-эндпоинта).
let TREE_MODEL = [];
function loadedDateStr() {
  const d = new Date(SERIES.ts[0] || MOCK_BASE);
  return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();
}
// «YYYY-MM-DD» -> «DD.MM.YYYY» (для отображения в дереве)
function humanDate(iso) {
  const p = String(iso || "").split("-");
  return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : (iso || "");
}
// Метаданные скважины из имени файла — в .asc3 их НЕТ, единственный источник имя.
// Пример: «КРС7 (01.03.-12.03) 1020 Демо.asc3» -> бригада КРС-7,
// скв. 1020, месторождение «Демо». Всё правится ПКМ (правка в памяти).
function parseWellMeta(name) {
  let brigade = "Бригада", field = "—", well = "—";
  let s = String(name || "").replace(/\.asc3$/i, "");
  const mbr = s.match(/(ТКРС|КРС)\s*[-–]?\s*(\d+)/i);
  if (mbr) brigade = mbr[1].toUpperCase() + "-" + mbr[2];
  s = s.replace(/\([^)]*\)/g, " ");                 // убрать «(14.05.-25.05)»
  const nums = s.match(/(?:^|\s)(\d{2,4})(?=\s|$)/g);
  if (nums && nums.length) well = nums[nums.length - 1].trim();
  const words = s.match(/[А-ЯЁA-Z][а-яёa-z]+/g) || [];
  let fw = words.filter((w) => !/^(ТКРС|КРС)$/i.test(w)).pop();
  if (fw) {
    fw = fw.replace(/ского$/, "ское").replace(/овского$/, "овское")
           .replace(/ого$/, "ое");
    field = fw;
  }
  return { brigade, field, well };
}
function buildTreeModel() {
  const meta = parseWellMeta(OPENED_NAME);
  let dates;
  if (DAYS && DAYS.length) {
    // № скважины/месторождение — из ПРЕАМБУЛЫ .asc3 (истинная метка записи, может
    // меняться между сутками); если поле пусто — резерв из имени файла.
    dates = DAYS.map((d, i) => ({
      idx: i, date: humanDate(d.date), count: d.count || 0, loaded: true,
      well: (d.well != null && String(d.well).trim()) ? String(d.well).trim() : meta.well,
      field: (d.field != null && String(d.field).trim()) ? String(d.field).trim() : meta.field,
      krs: (d.krs != null && String(d.krs).trim()) ? String(d.krs).trim() : null,
    }));
  } else {
    dates = [{ idx: -1, date: loadedDateStr(), count: N || 0, loaded: true,
               well: meta.well, field: meta.field, krs: null }];
  }
  // Заголовок бригады: КРС из файла (если декодирован), иначе из имени файла.
  const krs0 = dates.find((d) => d.krs)?.krs;
  const brigade = krs0 ? "КРС-" + krs0 : meta.brigade;
  // Месторождение в шапке — по первым суткам (из файла).
  const field0 = dates.find((d) => d.field && d.field !== "—")?.field || meta.field;
  // Уникальные скважины по файлу (для шапки, если менялась).
  const wells = [...new Set(dates.map((d) => d.well).filter((w) => w && w !== "—"))];
  const wellHdr = wells.length ? wells.join("/") : meta.well;
  TREE_MODEL = [{
    brigade,
    field: field0,       // месторождение (редактируемо)
    well: wellHdr,       // № скважины файла (может быть несколько)
    dates,
  }];
}
function renderTree() {
  const root = document.getElementById("tree");
  if (!root) return;
  root.innerHTML = "";
  TREE_MODEL.filter((br) => br.dates.some((d) => d.loaded)).forEach((br) => {
    const node = document.createElement("div");
    node.className = "tree-node";
    const head = document.createElement("div");
    head.className = "tree-row";
    head.innerHTML =        // #A20: brigade/well/field приходят из .asc3 заказчика
      `<span class="tw-name"><span class="tw-toggle">▾</span>${escHtml(br.brigade)}</span>` +
      `<span class="tw-type" title="Скв. ${escHtml(br.well)} · ${escHtml(br.field)} — ПКМ для правки">` +
      `скв.${escHtml(br.well)} · ${escHtml(br.field)}</span>`;
    head.addEventListener("contextmenu", (e) => { e.preventDefault(); openTreeMenu(e, br); });
    node.appendChild(head);
    const children = [];
    const multi = DAYS && DAYS.length > 1;
    br.dates.filter((d) => d.loaded).forEach((d) => {
      const ch = document.createElement("div");
      ch.className = "tree-row tree-child";
      ch.dataset.day = d.idx;
      const isSel = d.idx >= 0 ? DAY_SEL.has(d.idx) : true;
      // #B27 (живой тест 2026-07-09, "в дереве не хватает месторождения"):
      // строка суток раньше показывала только № скважины — месторождение было
      // видно лишь в title-подсказке родительской "бригады". Теперь показываем
      // оба, как и обещает заголовок колонки "Месторожд./скв".
      // #74 (замечание владельца 12.08): раньше подсказка ВСЕГДА утверждала
      // «берётся из имени файла», даже когда имя не распозналось и дата тихо
      // бралась из даты изменения файла (файл «31,07 (Скорректированный).asc3»
      // показывал 12.08.2026). Теперь сервер сообщает реальный источник в
      // date_source, и подсказка называет его честно.
      // #A20: date/field/well — из .asc3; часть подстановок стоит ВНУТРИ title="…",
      // поэтому escHtml экранирует и кавычки, иначе из атрибута можно выйти.
      ch.innerHTML = `<span class="tw-name" title="Метка суток для навигации. Определяется при импорте, правкой файла не изменить.\n${escHtml(dateSourceHint())}">📅 ${escHtml(d.date)}${DATE_SRC === "mtime" ? " ⚠" : ""}</span>` +
        `<span class="tw-type">` +
        `<span class="tw-field" title="Месторождение — двойной клик: изменить название только этих суток">${escHtml(d.field || "—")}</span>` +
        ` · <span class="tw-well" title="№ скважины — двойной клик: изменить и сохранить в файл">скв.${escHtml(d.well || "—")}</span></span>`;
      if (isSel) ch.classList.add("selected");
      // двойной клик по № скважины суток → правка + запись в исходный .asc3
      if (d.idx >= 0) {
        const ws = ch.querySelector(".tw-well");
        if (ws) ws.ondblclick = (e) => { e.stopPropagation(); editDayWell(d.idx, d.well); };
        const fs = ch.querySelector(".tw-field");   // #v93: клик по месторождению правит НАЗВАНИЕ, не № скв
        if (fs) fs.ondblclick = (e) => { e.stopPropagation(); editDayField(d.idx, d.field); };
        // #v98: правка даты УБРАНА — бессмысленна для цели (дату определяет сервер/оператор
        // при импорте, в файле её нет). Метка суток здесь только для навигации (из имени файла).
      }
      // клик по суткам управляет выборкой: клик=только эти, Shift=диапазон,
      // Ctrl/Cmd=добавить/убрать. Для файлов с 1 сутками — просто индикатор.
      ch.onclick = (e) => {
        e.stopPropagation();
        if (!multi || d.idx < 0) return;
        const i = d.idx;
        if (e.shiftKey) {
          const lo = Math.min(DAY_ANCHOR, i), hi = Math.max(DAY_ANCHOR, i);
          DAY_SEL.clear();
          for (let k = lo; k <= hi; k++) DAY_SEL.add(k);
        } else if (e.ctrlKey || e.metaKey) {
          if (DAY_SEL.has(i)) { if (DAY_SEL.size > 1) DAY_SEL.delete(i); }
          else DAY_SEL.add(i);
          DAY_ANCHOR = i;
        } else {
          DAY_SEL.clear(); DAY_SEL.add(i); DAY_ANCHOR = i;
        }
        refreshTreeDaySel();
        applyDayView();
        const sel = [...DAY_SEL].sort((a, b) => a - b);
        const lab = sel.length === 1 ? humanDate(DAYS[sel[0]].date)
          : humanDate(DAYS[sel[0]].date) + "–" + humanDate(DAYS[sel[sel.length - 1]].date);
        addNote("status", "Сутки: " + lab + " (" + sel.length + " из " + DAYS.length +
          ") · " + br.field + " скв." + br.well + ".");
      };
      node.appendChild(ch);
      children.push(ch);
    });
    head.onclick = () => {
      const tgl = head.querySelector(".tw-toggle");
      const hidden = children[0] && children[0].classList.contains("hidden");
      children.forEach((c) => c.classList.toggle("hidden", !hidden));
      tgl.textContent = hidden ? "▾" : "▸";
    };
    root.appendChild(node);
  });
}
// подсветить в дереве строки суток по текущему DAY_SEL
function refreshTreeDaySel() {
  document.querySelectorAll("#tree .tree-child").forEach((ch) => {
    const i = +ch.dataset.day;
    ch.classList.toggle("selected", i >= 0 && DAY_SEL.has(i));
  });
}
function buildTree() { buildTreeModel(); renderTree(); }

// контекстное меню правки бригады/скважины
function openTreeMenu(e, br) {
  closeTreeMenu();
  const m = document.createElement("div");
  m.className = "ctx-menu";
  m.style.left = e.clientX + "px";
  m.style.top = e.clientY + "px";
  const items = [
    ["Переименовать бригаду…", () => editField(br, "brigade", "Название бригады")],
    ["Изменить месторождение…", () => editField(br, "field", "Месторождение")],
    ["Изменить № скважины (выбранные сутки)…", () => editWellForSelected(br)],
  ];
  items.forEach(([label, fn]) => {
    const it = document.createElement("div");
    it.className = "ctx-item"; it.textContent = label;
    it.onclick = () => { closeTreeMenu(); fn(); };
    m.appendChild(it);
  });
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener("mousedown", closeTreeMenu, { once: true }), 0);
}
function closeTreeMenu() {
  document.querySelectorAll(".ctx-menu").forEach((x) => x.remove());
}
function editField(br, field, label) {
  const v = window.prompt(label + ":", br[field]);
  if (v === null) return;
  br[field] = v.trim() || br[field];
  renderTree();
  addNote("status", "Изменено («" + label + "» → «" + br[field] + "») в памяти. № скважины пишется в файл через двойной клик по строке суток.");
}

// Правка № скважины ОДНИХ суток с записью в исходный .asc3 (двойной клик в дереве).
// #v93: правка НАЗВАНИЯ месторождения суток (пакетно на эти и последующие сутки
// того же названия, propagate=true), запись в файл. Отдельно от № скважины.
async function editDayField(dayIdx, curField) {
  if (dayIdx == null || dayIdx < 0 || !DAYS[dayIdx]) return;
  const v = window.prompt(
    "Месторождение для суток " + humanDate(DAYS[dayIdx].date) +
    "\n(запишется в файл, только эти сутки):",
    curField || "");
  if (v === null) return;
  const f = v.trim();
  if (!f || f === (curField || "")) return;
  await patchFieldDay(dayIdx, f, false);   // #v94: только ЭТИ сутки (не распространять на скважины ниже)
  buildTree(); renderChart();
}
// #v98: функция правки даты (editDayDate) УДАЛЕНА. Причина (уточнение Stanislav):
// цель редактора — файл ДЛЯ ОРИГИНАЛЬНОЙ ПРОГРАММЫ, а не показ в нашей. Абсолютную
// дату в экосистеме ASC определяет СЕРВЕР (ключ записи Day) или ОПЕРАТОР в диалоге
// импорта (Day1/Day2/IncludeDays) — в самом .asc3 даты нет. Значит наша локальная
// правка даты ни на что в оригинале не влияла бы => она бессмысленна и убрана.
// Дата суток в дереве/оси — косметическая метка навигации из имени файла.

async function editDayWell(dayIdx, curWell) {
  if (dayIdx == null || dayIdx < 0 || !DAYS[dayIdx]) return;
  const v = window.prompt(
    "№ скважины для суток " + humanDate(DAYS[dayIdx].date) +
    "\n(запишется прямо в файл .asc3):", curWell || "");
  if (v === null) return;
  const well = v.trim();
  if (!well || well === (curWell || "")) return;
  await patchWellDays([dayIdx], well);
}

// Правка № скважины для всех ВЫБРАННЫХ суток (ПКМ по бригаде).
async function editWellForSelected(br) {
  const sel = (DAYS && DAYS.length)
    ? [...DAY_SEL].sort((a, b) => a - b)
    : [];
  if (!sel.length) { addNote("status", "Не выбрано ни одних суток."); return; }
  const cur = (DAYS[sel[0]] && DAYS[sel[0]].well) || "";
  const lab = sel.length === 1 ? humanDate(DAYS[sel[0]].date)
    : "сутки " + sel.map((i) => humanDate(DAYS[i].date)).join(", ");
  const v = window.prompt(
    "№ скважины для: " + lab + "\n(запишется прямо в файл .asc3):", cur);
  if (v === null) return;
  const well = v.trim();
  if (!well) return;
  await patchWellDays(sel, well);
}

// Последовательно патчим № скважины у списка суток и перезаписываем открытый файл.
async function patchWellDays(idxList, well) {
  addNote("status", "Записываю № скважины «" + well + "» в файл…");
  let backup = null;
  for (const di of idxList) {
    let j;
    try {
      const r = await fetch("/api/patch_well", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: di, well }),
      });
      j = await r.json();
    } catch (e) {
      addNote("status", "Ошибка запроса: " + e); return;
    }
    if (!j || !j.ok) {
      addNote("status", "Ошибка на сутках " + di + ": " + ((j && j.error) || "не удалось"));
      return;
    }
    backup = backup || j.backup;
    // аудит 18.08: сервер сообщает, если таблица длин контейнера не обновилась
    // (asc_parser desc_updated=False). Раньше этот флаг не читал никто.
    if (j.warn) addNote("warn", j.warn);
    if (Array.isArray(j.days)) {
      j.days.forEach((d, i) => {
        if (DAYS[i]) { DAYS[i].well = d.well; DAYS[i].field = d.field; DAYS[i].krs = d.krs; }
      });
    }
  }
  buildTree();
  renderChart();
  addNote("status", "№ скважины → «" + well + "» записан в файл для " +
    idxList.length + " сут." + (backup ? " (бэкап " + backup + ")" : "") + ".");
}

/* ---------- AI-ассистент ---------- */
function addNote(kind, text) {
  const box = document.getElementById("ai-messages");
  const tag = { status: "Статус", note: "Заметка", question: "Вопрос",
                warn: "Внимание" }[kind] || "Заметка";
  const el = document.createElement("div");
  el.className = "msg note";
  // #A20 (18.08.2026, аудит): было el.innerHTML = `<span…>${tag}</span>${text}`.
  // Самый широкий сток разметки в программе: сюда 121 вызовом приходят имя
  // открытого файла, имя месторождения и № скважины из .asc3, тексты ошибок
  // сервера. Всё это — содержимое файла ЗАКАЗЧИКА, т.е. недоверенный ввод.
  // `tag` берётся из своего словаря, `text` — нет. Собираем узлами: текст
  // остаётся текстом при любом содержимом. Побочный эффект: если какой-то
  // вызов рассчитывал на <b> в сообщении, он покажет literal-теги — это
  // косметика, и она дешевле исполнения чужой разметки.
  const nt = document.createElement("span");
  nt.className = "nt";
  nt.textContent = tag;
  el.appendChild(nt);
  el.appendChild(document.createTextNode(text == null ? "" : String(text)));
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
function addMsg(role, text) {
  const box = document.getElementById("ai-messages");
  const el = document.createElement("div");
  el.className = "msg " + role;
  if (text && text.indexOf("\n") !== -1) el.style.whiteSpace = "pre-line"; // v105: помощь/расшифровка
  el.textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
/* реплика пользователя с цветными бейджами каналов + окном времени */
function addUserMsg(text, tags, sel) {
  const box = document.getElementById("ai-messages");
  const el = document.createElement("div");
  el.className = "msg user";
  let head = "";
  if (sel) {
    head += `<span class="umsg-win">${fmtTime(sel.t0)}–${fmtTime(sel.t1)}</span>`;
  }
  if (tags && tags.length) {
    head += `<span class="umsg-tags">`;
    tags.forEach((k) => {
      const c = CHANNELS.find((x) => x.key === k);
      // #A20: имя канала — из .asc3; цвет свой, но экранируем и его (он попадает в style="…")
      head += `<span class="umsg-tag" style="background:${escHtml(c ? c.color : "#888")}">${escHtml(c ? shortName(c.name) : k)}</span>`;
    });
    head += `</span>`;
  }
  const body = document.createElement("span");
  body.textContent = text;
  el.innerHTML = head;
  el.appendChild(body);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
function bindAI(sourceLabel) {
  addMsg("ai", "Готов помочь с картограммой: «убери выбросы», «сгладь», «выровняй», " +
    "«подними на 2», «расшифруй», «исправь»… Напишите «помощь» — полный список. " +
    "Выделите окно на графике, чтобы править только его.");
  addNote("status", "Данные: " + sourceLabel + " — " + N + " точек, " + CHANNELS.length + " каналов.");

  const input = document.getElementById("ai-input");
  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 96) + "px"; };
  input.addEventListener("input", grow);
  const send = () => {
    const t = input.value.trim();
    if (!t && !SEL_TAGS.length) return;
    const tags = SEL_TAGS.slice();
    const sel = SEL;
    addUserMsg(t, tags, sel);
    input.value = ""; grow();
    // после отправки сбрасываем нажатые токены, но само выделение оставляем —
    // пользователь может разметить тот же диапазон ещё раз другими каналами
    SEL_TAGS = [];
    renderContext();
    aiCommand(t, tags, sel);   // v105: живой ассистент (движок корректировок)
  };
  document.getElementById("ai-send").onclick = send;

  // 📎 СКРЕПКА: прикрепить скан картограммы. Превью показываем сразу,
  // саму оцифровку выполнит бэкенд-ИИ (подключается позже).
  let clipInput = document.getElementById("ai-clip-input");
  if (!clipInput) {
    clipInput = document.createElement("input");
    clipInput.type = "file"; clipInput.id = "ai-clip-input";
    // image/* — скан картограммы (оцифровка позже); текст — сводный отчёт -> интервалы
    clipInput.accept = "image/*,.txt,.md,.csv,.json,.log,text/plain";
    clipInput.style.display = "none";
    document.body.appendChild(clipInput);
    clipInput.onchange = (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      const isImage = (f.type && f.type.indexOf("image/") === 0) ||
        /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(f.name);
      const reader = new FileReader();
      if (isImage) {
        reader.onload = () => {
          addImageMsg(reader.result, f.name);
          addMsg("ai", "Скан «" + f.name + "» прикреплён. Оцифровка картограммы ИИ будет выполнена бэкендом (в подготовке) — после этого значения подгонятся под эталон.");
        };
        reader.readAsDataURL(f);
      } else {
        // сводный отчёт (текст) -> разбор на интервалы работ
        reader.onload = () => {
          const ctx = SEL ? { t0: msToInput(SEL.t0), t1: msToInput(SEL.t1) } : null;
          attachReport(f.name, String(reader.result || ""), ctx);
        };
        reader.readAsText(f);
      }
    };
  }
  document.getElementById("ai-clip").onclick = () => clipInput.click();

  // 🎤 МИКРОФОН: реальная диктовка через Web Speech API (если поддерживается)
  bindMic(input, grow);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
}
// сообщение-картинка в ленте ассистента
function addImageMsg(dataUrl, name) {
  const box = document.getElementById("ai-messages");
  const el = document.createElement("div");
  el.className = "msg user";
  // #A20: name — имя файла, выбранного пользователем; dataUrl уходит в атрибут src
  el.innerHTML = '<div style="font-size:10px;opacity:.7;margin-bottom:3px">📎 ' + escHtml(name || "скан") +
    '</div><img src="' + escHtml(dataUrl) + '" style="max-width:100%;border-radius:6px;display:block">';
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
// голосовой ввод
let REC = null, RECING = false;
function bindMic(input, grow) {
  const btn = document.getElementById("ai-mic");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { btn.onclick = () => addNote("note", "Голосовой ввод недоступен в этом браузере. В Chrome работает Web Speech API."); return; }
  btn.onclick = () => {
    if (RECING) { try { REC.stop(); } catch (e) {} return; }
    REC = new SR();
    REC.lang = "ru-RU"; REC.interimResults = true; REC.continuous = false;
    const baseText = input.value;
    REC.onstart = () => { RECING = true; btn.classList.add("on"); addNote("status", "🎤 Слушаю… говорите."); };
    REC.onerror = (e) => addNote("note", "Микрофон: " + (e.error || "ошибка") + ".");
    REC.onend = () => { RECING = false; btn.classList.remove("on"); };
    REC.onresult = (e) => {
      let txt = "";
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      input.value = (baseText ? baseText + " " : "") + txt;
      grow();
    };
    try { REC.start(); } catch (e) { addNote("note", "Не удалось запустить микрофон."); }
  };
}

/* ---------- открыть / сохранить ---------- */
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function downloadBlob(text, name, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}
// ТЗ 2026-08-02: в триале сохранение результата запрещено. JSON/CSV-выгрузки —
// чисто клиентские (Blob), серверный гейт (/api/export и др.) их не видит,
// поэтому спрашиваем сервер явно. Единый источник правды — /api/save_allowed
// (та же логика, что у 402-гейта, включая dev-обход ASC_DEV_LICENSE_BYPASS).
async function saveAllowed() {
  try {
    const j = await (await fetch("/api/save_allowed")).json();
    if (j && j.ok === false) {
      addNote("note", j.error || "Сохранение недоступно: лицензия не активна.");
      return false;
    }
  } catch (e) { /* сервер недоступен — не блокируем сверх серверного гейта */ }
  return true;
}
// сохранить полный снимок правок (JSON) — открывается обратно кнопкой «Открыть»
async function doSaveJson() {
  if (!await saveAllowed()) return;
  const payload = {
    project: "КартЭдит", saved_at: new Date().toISOString(), n: N,
    ts: SERIES.ts,
    data: CHANNELS.map((c) => ({ key: c.key, name: c.name, values: SERIES.data[c.key] })),
  };
  const name = "cartogram_edit_" + stamp() + ".json";
  downloadBlob(JSON.stringify(payload), name, "application/json");
  addNote("status", "Сохранено: «" + name + "» — снимок правок (" + N + " точек). Его можно открыть обратно кнопкой 📂.");
}
// сохранить как CSV (для внешних инструментов)
// #A18 (18.08.2026, аудит) — две правки, обе про НЕВЕРНЫЕ ДАННЫЕ НАРУЖУ:
//  1) была только колонка «Время» (ЧЧ:ММ:СС). В многосуточном файле строки
//     разных суток в выгрузке неразличимы: внешний расчёт по такому CSV даёт
//     заказчику неверный отчёт, и предупреждения не было. Добавлена «Дата»
//     первой колонкой — порядок как в эталонном CSV регистратора. Дата пишется в
//     КАЖДОЙ строке, а не только при смене суток (как делает штатное ПО для
//     Excel): пустая ячейка заставляет потребителя тянуть состояние и
//     возвращает ровно ту неоднозначность, которую мы чиним.
//  2) выгружались ВСЕ строки файла независимо от выбранных суток. На экране
//     одно, в файле другое. При этом код сам направляет пользователя в CSV
//     именно за отдельными сутками (см. #B48 в doSaveAsc3: «нужны отдельные
//     сутки — выгружайте их отдельно (CSV/импорт)»), т.е. выгрузка обязана
//     слушаться выбора. Сутки берём по ВРЕМЕНИ строки (rowDaysByTime, #B19),
//     а не по dayOfIndex — тот врёт после вставки/удаления строк.
async function doSaveCsv() {
  if (!await saveAllowed()) return;
  const head = ["Дата", "Время"].concat(CHANNELS.map((c) => c.name)).join(";");
  const rdays = daySelActive() ? rowDaysByTime() : null;
  const lines = [];
  let skipped = 0;
  for (let i = 0; i < N; i++) {
    if (rdays && !DAY_SEL.has(rdays[i])) { skipped++; continue; }
    const cells = [fmtDate(SERIES.ts[i]), fmtTime(SERIES.ts[i])];
    for (const c of CHANNELS) { const v = SERIES.data[c.key][i]; cells.push(v == null ? "" : v); }
    lines.push(cells.join(";"));
  }
  const name = "cartogram_edit_" + stamp() + ".csv";
  downloadBlob("﻿" + head + "\n" + lines.join("\n"), name, "text/csv");
  addNote("status", "Сохранено: «" + name + "» (CSV, " + lines.length + " строк"
    + (skipped ? "; только ВЫБРАННЫЕ сутки — " + skipped + " строк остальных суток не вошли" : "")
    + ").");
}
// есть ли нативный мост pywebview (в .exe) — тогда файловые диалоги нативные
function hasNative() {
  return !!(window.pywebview && window.pywebview.api &&
            typeof window.pywebview.api.open_file === "function");
}
// #v93: системное окно выбора файла через бэкенд (сервер локальный) — для режима
// run.bat/браузера, где нет pywebview. Заменяет уродливый prompt() с вводом пути.
async function nativePickPath(mode, initial) {
  try {
    const r = await fetch("/api/pick_file", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: mode || "open", initial: initial || "" }),
    });
    const j = await r.json();
    if (!j || !j.ok) return null;   // отмена или ошибка
    return j.path;
  } catch (e) { addNote("note", "Диалог файла недоступен: " + e); return null; }
}
// экспорт правок ОБРАТНО в .asc3 (байт-точный патч на бэкенде).
//   mode="overwrite" — перезаписать открытый файл (💾);
//   mode="saveas"    — нативный диалог: выбрать имя/папку (🗄).
async function doSaveAsc3(mode) {
  mode = mode || "overwrite";
  // #v111 (#B45-diag-front): вкладка могла быть открыта ДО правки app.js —
  // AUTOVER спасает только при перезагрузке страницы. Сверяем версию, с которой
  // страница загружена (window.ASC_BOOT_VER), с текущей на диске (/api/health).
  try {
    const _h = await (await fetch("/api/health")).json();
    if (_h && _h.static_autover && window.ASC_BOOT_VER && _h.static_autover !== window.ASC_BOOT_VER) {
      addNote("warn", "⚠ Код редактора на диске НОВЕЕ, чем в этой вкладке — сохранение пойдёт со СТАРОЙ логикой фронта. Обновите страницу (Ctrl+F5) и повторите правку.");
    }
    if (_h && _h.asc_exporter_stale) {
      addNote("warn", "⚠ Сервер держит УСТАРЕВШИЙ asc_exporter (файл на диске изменён после старта). Перезапустите run.bat перед сохранением.");
    }
  } catch (e) { /* health недоступен — не блокируем сохранение */ }
  const payload = {
    channels: CHANNELS.map((c) => ({ name: c.name, values: SERIES.data[c.key] })),
  };
  // #B19: структурные правки (вставка/удаление строк) сохраняются ПОСУТОЧНОЙ
  // пересборкой потоков (rebuild_asc3_days): шлём row_src + сутки каждой строки
  // + ТОЧНЫЕ времена строк (#B21 — вставки пишутся ровно как на экране).
  // #Q2: по умолчанию пишется ВЕСЬ файл (все сутки); подмножество — только по
  // явному подтверждению (иначе правки невыбранных суток тихо терялись).
  const multiDay = DAYS.length > 1;
  let structural = !rowSrcIsIdentity();
  if (structural) {
    payload.row_src = ROW_SRC;
    payload.row_ts = SERIES.ts;
    const rdays = rowDaysByTime();
    if (rdays) payload.row_days = rdays;
  }
  // ТЗ 2026-07-10: кнопка 💾 «Сохранить» ВСЕГДА пишет ВСЕ открытые сутки.
  // #B48 (2026-07-31): обрезка суток (#B26) ПОЛНОСТЬЮ УБРАНА — .asc3 не хранит
  // явную дату суток (вычисляется по порядку от базовой даты), поэтому обрезка
  // произвольного подмножества суток ломала даты оставшихся суток при переоткрытии.
  // «Сохранить» и «Сохранить как» теперь ВСЕГДА пишут файл целиком (все сутки).
  // Нужны отдельные сутки — выгружайте их отдельно на этапе исходных данных
  // (CSV/импорт), а не обрезкой уже собранного многосуточного .asc3.

  if (mode === "saveas") {
    // выбрать путь. В .exe — нативный диалог; в браузере — ввод пути (как в
    // «Открыть», #2026-07-09g) → бэкенд (локальный run.bat) пишет .asc3
    // напрямую на диск — тот же сервер видит ту же файловую систему что и
    // .exe, разницы в доступе к диску тут НЕТ, поэтому JSON-скачивание было
    // не нужным обходным путём (#B25, живой тест 2026-07-09: "плодятся
    // .json"). JSON-снимок остаётся доступен явно через Shift+💾, если
    // именно он нужен (например, для передачи правок без .asc3-файла).
    if (hasNative()) {
      let res;
      try { res = await window.pywebview.api.save_file(OPENED_NAME || "kartogramma.asc3"); }
      catch (e) { addNote("note", "Диалог сохранения недоступен: " + e); return; }
      if (!res || !res.ok) { if (res && res.cancelled) return; addNote("note", "Сохранение отменено: " + ((res && res.error) || "")); return; }
      payload.out_path = res.path;
    } else {
      // #v93: системное окно "Сохранить как" вместо prompt()
      const pth = await nativePickPath("save", OPENED_NAME || "kartogramma.asc3");
      if (!pth) return;
      // #v95: схлопнуть повторные .asc3 (диалог мог дописать расширение к имени, уже с .asc3)
      payload.out_path = pth.replace(/(?:\.asc3)+$/i, "") + ".asc3";
    }
  } else {
    payload.overwrite = true;   // перезапись открытого файла (бэкенд сделает .bak)
  }

  addNote("status", "Сохранение в .asc3…" + (structural
    ? " (пересборка потока: строк " + N + ", было " + ORIG_N + ")" : ""));
  try {
    const r = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      if (j && j.code === "row_count_mismatch") {
        addNote("note", "Экспорт заблокирован: число строк изменилось (" +
          j.got + " вместо " + j.expected + " в исходнике). Сохранение в .asc3 " +
          "пока поддерживает только правку значений — без вставки/удаления строк. " +
          "Верните прежнее число строк или сохраните правки в JSON (Shift+💾).");
        return;
      }
      if (j && r.status === 503) {
        addNote("note", "Сначала откройте .asc3 (📂) — нет исходного файла для сохранения.");
        return;
      }
      addNote("note", "Сохранение не удалось: " + (j && j.error ? j.error : r.status));
      return;
    }
    OPENED_NAME = j.file || OPENED_NAME;
    const where = j.overwritten
      ? "перезаписан «" + j.file + "»" + (j.backup ? " (бэкап " + j.backup + ")" : "")
      : "сохранён «" + j.file + "» в " + (j.dir || "папке рядом с исходником");
    let detail;
    if (structural && j.blocks_out != null && j.days_src != null) {
      detail = " — пересобрано: записей " + j.blocks_out + " (было " + j.blocks_src +
        "; вставлено " + j.inserted + ", удалено " + j.deleted + "), суток изменено " +
        j.days_written + " из " + j.days_src + ", значений " + j.changed;
    } else if (j.days_written != null) {
      detail = " — сохранено суток " + j.days_written + " из " + j.days_src +
        ", изменено значений " + j.changed;
    } else if (structural) {
      detail = " — поток пересобран: записей " + j.blocks_out + " (было " + j.blocks_src +
        "; вставлено " + j.inserted + ", удалено " + j.deleted + "), изменено значений " + j.changed;
    } else {
      detail = " — изменено значений " + j.changed + " в " + j.blocks + " записях";
    }
    addNote("status", "Готово: " + where + detail + ".");
    // #B21 корень 2: после СТРУКТУРНОГО сохранения (число строк менялось)
    // состояние фронта (ROW_SRC/ORIG_N) и карта суток указывали на СТАРЫЙ файл —
    // повторное 💾 применяло вставки ещё раз (наложение/дубли, тест 07.07 на 44).
    // Бэкенд перечитывает файл (j.reloaded), фронт перезагружает данные и
    // обнуляет происхождение строк. Правки уже в файле — ничего не теряется.
    if (structural && j.reloaded) {
      await reloadAfterOpen(true);   // #B27: сохранить каналы/цвета/масштаб
      addNote("status", "Данные перечитаны из сохранённого файла — можно продолжать правки.");
    }
    markSavedClean();
  } catch (e) {
    addNote("note", "Сохранение не удалось (бэкенд недоступен?): " + e);
  }
}
function markSavedClean() {
  updateNibBanner(null);   // #B36: сохранение нормализует чужие ниблы
  SAVED_HIST_IDX = HIST.idx; AUTOSAVE_LAST_IDX = HIST.idx; updateDirtyUI();
  discardAutosave();   // A.2: правки уже в .asc3 — черновик-страховка больше не нужен
}
function loadFromJson(text) {
  let j; try { j = JSON.parse(text); } catch (e) { addNote("note", "Файл повреждён — не разобрать JSON."); return; }
  if (!j || !Array.isArray(j.ts) || !Array.isArray(j.data)) { addNote("note", "Это не снимок картограммы КартЭдит."); return; }
  if (j.ts.length !== N) {
    addNote("note", "Длина снимка (" + j.ts.length + ") не совпадает с текущими данными (" + N + " точек). Сначала откройте исходный .asc3 через run.bat, затем накладывайте JSON-правки.");
    return;
  }
  let applied = 0;
  j.data.forEach((col) => {
    const c = CHANNELS.find((x) => x.name === col.name) || CHANNELS.find((x) => x.key === col.key);
    if (c && Array.isArray(col.values)) { for (let i = 0; i < N; i++) SERIES.data[c.key][i] = col.values[i]; applied++; }
  });
  renderChart(); refreshGrid(); histReset();
  addNote("status", "Открыт снимок правок: применено каналов — " + applied + ".");
}
// перезагрузить телеметрию из бэкенда после открытия нового .asc3
async function reloadAfterOpen(preserveView) {
  // #B27 (тест 2026-07-10): перезагрузка ПОСЛЕ СОХРАНЕНИЯ не должна сбрасывать
  // рабочую область. loadData() пересоздаёт CHANNELS и ставит DEFAULT_ACTIVE=3,
  // цвета=палитра — при открытии НОВОГО файла верно, но после 💾 (тот же файл)
  // пользователь терял каналы, цвета, фокус, выбор суток и масштаб. Файл тот же →
  // имена/порядок каналов идентичны, снимок по ИМЕНИ канала переносится корректно.
  let snap = null;
  if (preserveView) {
    const colors = {};
    CHANNELS.forEach((c) => (colors[c.name] = c.color));
    snap = {
      colors,
      activeNames: CHANNELS.filter((c) => DEFAULT_ACTIVE.has(c.key)).map((c) => c.name),
      focusName: FOCUS_KEY ? (CHANNELS.find((c) => c.key === FOCUS_KEY) || {}).name : null,
      daySel: [...DAY_SEL], z0: zStart, z1: zEnd,
      vlo: VY.lo, vhi: VY.hi, xmin: XMIN, xmax: XMAX,
    };
  }
  const ok = await loadData();
  if (!ok) { addNote("note", "Файл открыт, но телеметрия не загрузилась."); return; }
  initRowSrc();
  if (snap) {
    const nameToKey = {};
    CHANNELS.forEach((c) => {
      nameToKey[c.name] = c.key;
      if (snap.colors[c.name]) c.color = snap.colors[c.name];
    });
    const act = snap.activeNames.map((n) => nameToKey[n]).filter(Boolean);
    if (act.length) DEFAULT_ACTIVE = new Set(act);
    FOCUS_KEY = snap.focusName ? (nameToKey[snap.focusName] || null) : null;
    DAY_SEL.clear();
    snap.daySel.forEach((i) => { if (i < DAYS.length) DAY_SEL.add(i); });
    if (!DAY_SEL.size) DAYS.forEach((_, i) => DAY_SEL.add(i));
    zStart = snap.z0; zEnd = snap.z1; VY = { lo: snap.vlo, hi: snap.vhi };
    XMIN = snap.xmin; XMAX = snap.xmax;
  }
  buildChannelTabs();
  buildDayBar();
  // #v102 (тест 07-16, «фантомные фигуры»): ПЕРЕД первым рендером нового файла
  // ПОЛНОСТЬЮ очищаем холст ECharts. Иначе старая геометрия (линии/заливка
  // предыдущего файла или суток) могла оставаться «призраком» поверх новых данных
  // — особенно на файле, где вес=0, но на графике висела пила прошлого файла.
  // clear() сносит всю прошлую отрисовку; renderChart строит с нуля (zr-обработчики
  // висят на инстансе zrender, а не на option — их clear() не трогает).
  try { if (chart && chart.clear) chart.clear(); } catch (e) {}
  renderChart();
  markZoomed();       // #B47: после восстановления снимка zStart/zEnd/VY класс .zoomed мог остаться устаревшим
  bindTimeRange();   // #v99b: обновить поля диапазона времени на дату ОТКРЫТОГО файла
                     // (раньше не вызывалось при открытии -> в полях висела дата
                     //  стартового превью 12.02.26 вместо реальной даты файла)
  buildGrid();
  buildTree();
  clearSelection();
  histReset();
}
// открыть .asc3 по абсолютному пути (путь даёт нативный диалог pywebview)
async function openAsc3ByPath(path) {
  if (!path) return;
  addNote("status", "Открываю «" + path + "»…");
  try {
    const r = await fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) { addNote("note", "Не удалось открыть: " + (j && j.error ? j.error : r.status)); return; }
    OPENED_NAME = j.name || "";
    await reloadAfterOpen();
    addNote("status", "Открыт файл «" + (j.name || "") + "»: каналов " +
      (j.columns ? j.columns.length - 1 : "?") + ", записей " + (j.rows_count || N) + ".");
    noteIntegrity(j.integrity);                    // #B70/#B71: прочитает ли Архив файл целиком
    notePlausibility(j.plausibility);              // п. 4 решений: осмысленность содержимого
    await maybeOfferAutosaveRestore(j.autosave);   // A.2: спросить про черновик ПОСЛЕ загрузки данных
  } catch (e) {
    addNote("note", "Не удалось открыть (бэкенд недоступен?): " + e);
  }
}
// #B70/#B71 (19.08.2026): предупредить, что Архив прочитает открытый файл НЕ ЦЕЛИКОМ.
// КартЭдит рисует всё, что есть в файле, а Архив 3.0.153 читает меньше и при этом
// пишет «данные полностью обработаны» — молча, поэтому расхождение раньше ловилось
// только сверкой двух картинок глазами. Сам файл при открытии не меняется.
function notePlausibility(pl) {
  if (!pl || pl.ok !== false || !(pl.warnings || []).length) return;
  addNote("warn", "Содержимое файла выглядит подозрительно: " + pl.warnings.join("; ") +
    ". Файл открыт как есть. Сверьте с исходной картограммой, прежде чем сохранять правки.");
}
function noteIntegrity(it) {
  if (!it || it.ok !== false) return;
  // #B72 (20.08.2026): обрыв контейнера — случай отдельный и более тяжёлый.
  // Остальные дефекты лечатся сохранением, этот НЕ лечится: недостающих байт
  // в файле нет. Поэтому и текст другой, и совет обратный — не сохранять поверх.
  const c = it.container || null;
  if (c && c.truncated) {
    const где = (c.broken || []).map(b => "поток " + b.stream).join(", ");
    addNote("warn", "файл ОБОРВАН — часть байтов отсутствует (" +
      (где || "конец файла") + "). Показаны только уцелевшие данные, и " +
      "сохранение их не восстановит. Перезапись поверх этого файла заблокирована: " +
      "если нужно сохранить правку, используйте «Сохранить как» в НОВЫЙ файл, " +
      "а оригинал оставьте для восстановления.");
  }
  const части = [];
  if (it.b70_rows_cut) части.push("обрыв хвоста суток: " + it.b70_rows_cut + " строк(и)");
  if (it.b71_rows_lost) части.push("повторы ключа: " + it.b71_rows_lost + " строк(и)");
  if (!части.length) return;
  addNote("note", "Внимание: этот файл менеджер Архив прочитает не целиком — " +
    части.join(", ") + ". Сохраните его из КартЭдит (Экспорт), и дефект уйдёт.");
}
// открыть из браузерного input (дев-режим): .asc3 — по пути нельзя, только JSON-снимок
function doOpenFile(file) {
  if (!file) return;
  const low = file.name.toLowerCase();
  if (low.endsWith(".asc3")) {
    addNote("note", "Открытие .asc3 выбором файла недоступно в браузере (нет пути к диску). Нажмите «Открыть» ещё раз и введите полный путь к файлу в появившемся окне.");
    return;
  }
  if (!low.endsWith(".json")) { addNote("note", "Поддерживается открытие JSON-снимка правок. Для .csv используйте импорт на бэкенде."); return; }
  const reader = new FileReader();
  reader.onload = () => loadFromJson(String(reader.result));
  reader.onerror = () => addNote("note", "Не удалось прочитать файл.");
  reader.readAsText(file);
}

/* ---------- тулбар ---------- */
function bindToolbar() {
  // скрытый input для «Открыть» (дев-фолбэк, когда нет нативного моста)
  let fi = document.getElementById("open-file-input");
  if (!fi) {
    fi = document.createElement("input");
    fi.type = "file"; fi.id = "open-file-input"; fi.accept = ".json,.asc3"; fi.style.display = "none";
    document.body.appendChild(fi);
    fi.onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; doOpenFile(f); };
  }
  // «Открыть»: в .exe — нативный диалог -> /api/open; в браузере — запрос
  // полного пути (input=file не даёт сайту путь к диску, только содержимое) ->
  // openAsc3ByPath (тот же /api/open). Пусто -> старый путь: выбор JSON-снимка.
  document.getElementById("btn-open").onclick = async () => {
    if (hasNative()) {
      let res;
      try { res = await window.pywebview.api.open_file(); }
      catch (e) { addNote("note", "Диалог открытия недоступен: " + e); return; }
      if (!res || !res.ok) { if (res && res.cancelled) return; addNote("note", "Открытие отменено: " + ((res && res.error) || "")); return; }
      openAsc3ByPath(res.path);
    } else {
      // #v93: штатное системное окно Windows через бэкенд вместо prompt()
      const pth = await nativePickPath("open");
      if (!pth) return;
      openAsc3ByPath(pth);
    }
  };
  // «Сохранить» (💾): ЛКМ — перезаписать открытый файл; Shift+ЛКМ — JSON-снимок; ПКМ — CSV
  const sb = document.getElementById("btn-save");
  sb.onclick = (e) => { if (e.shiftKey) doSaveJson(); else doSaveAsc3("overwrite"); };
  sb.oncontextmenu = (e) => { e.preventDefault(); doSaveCsv(); };
  sb.title = "ЛКМ — сохранить (перезаписать открытый .asc3). Shift+ЛКМ — JSON-снимок. ПКМ — CSV";
  // «Сохранить как…» (🗄): выбрать имя/папку
  const sa = document.getElementById("btn-saveas");
  if (sa) sa.onclick = () => doSaveAsc3("saveas");
  // F17 (⇄): сравнить с исходником — файлом, каким его открыли в этой сессии
  const db = document.getElementById("btn-diff");
  if (db) db.onclick = () => doDiff();
}

/* ---------- сплиттер ---------- */
function bindResizer() {
  const rz = document.getElementById("v-resizer");
  const content = document.getElementById("content");
  const charts = document.getElementById("charts-panel");
  let dragging = false;
  rz.addEventListener("mousedown", (e) => {
    dragging = true; rz.classList.add("dragging");
    document.body.classList.add("row-resizing"); e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = content.getBoundingClientRect();
    let pct = ((e.clientY - rect.top) / rect.height) * 100;
    pct = Math.max(30, Math.min(85, pct));
    charts.style.flex = "0 0 " + pct + "%";
    chart.resize();
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false; rz.classList.remove("dragging");
    document.body.classList.remove("row-resizing");
    chart.resize(); renderChart();   // обновить высоту полос-осей под новый размер
  });

  // --- граница дерево / AI внутри левой панели (по вертикали) ---
  const trz = document.getElementById("tree-resizer");
  const tree = document.getElementById("tree-section");
  const sidebar = document.getElementById("sidebar");
  if (trz && tree && sidebar) {
    let dragT = false;
    trz.addEventListener("mousedown", (e) => {
      dragT = true; trz.classList.add("dragging");
      document.body.classList.add("row-resizing"); e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragT) return;
      const rect = sidebar.getBoundingClientRect();
      let pct = ((e.clientY - rect.top) / rect.height) * 100;
      pct = Math.max(10, Math.min(70, pct));
      tree.style.flex = "0 0 " + pct + "%";
    });
    window.addEventListener("mouseup", () => {
      if (!dragT) return;
      dragT = false; trz.classList.remove("dragging");
      document.body.classList.remove("row-resizing");
    });
  }

  // --- граница левая панель / контент (по горизонтали) ---
  const srz = document.getElementById("side-resizer");
  if (srz && sidebar) {
    let dragS = false;
    srz.addEventListener("mousedown", (e) => {
      dragS = true; srz.classList.add("dragging");
      document.body.classList.add("col-resizing"); e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragS) return;
      const ws = document.getElementById("workspace").getBoundingClientRect();
      let w = e.clientX - ws.left;
      w = Math.max(200, Math.min(ws.width * 0.55, w));
      sidebar.style.width = w + "px";
      chart.resize();
    });
    window.addEventListener("mouseup", () => {
      if (!dragS) return;
      dragS = false; srz.classList.remove("dragging");
      document.body.classList.remove("col-resizing");
      chart.resize(); renderChart();
    });
  }
}

/* ====================================================================
   ВЫДЕЛЕНИЕ ДИАПАЗОНА ПКМ + ПОДГОТОВКА КОНТЕКСТА ДЛЯ ИИ
   - Правая кнопка + протяжка по графику -> выделяется диапазон времени.
   - Над полем ввода появляется «массив» активных каналов (цветные кнопки).
   - Клик по кнопке-каналу «нажимает» её (объёмная) и добавляет токен к запросу.
   - Несколько кнопок -> текст относится сразу к ним.
   - Левый клик по графику без протяжки -> сброс выделения.
   ==================================================================== */
let SEL = null;            // {t0,t1,i0,i1,stats:{key:{min,max,avg,first,last}}}
let SEL_TAGS = [];         // нажатые ключи каналов (порядок нажатия)
let selBandEl = null;      // overlay-полоса поверх графика
let selDown = false, selX0 = 0, selX1 = 0, selMoved = false;

function ensureSelBand() {
  if (selBandEl) return selBandEl;
  selBandEl = document.createElement("div");
  selBandEl.className = "sel-band";
  selBandEl.style.display = "none";
  document.getElementById("chart").appendChild(selBandEl);
  return selBandEl;
}
function px2time(px, py) {
  try {
    const v = chart.convertFromPixel({ gridIndex: 0 }, [px, py == null ? 20 : py]);
    return Array.isArray(v) ? v[0] : v;
  } catch (e) { return NaN; }
}
function time2px(t) {
  try {
    const p = chart.convertToPixel({ gridIndex: 0 }, [t, 0]);
    return Array.isArray(p) ? p[0] : NaN;
  } catch (e) { return NaN; }
}
function positionSelBand() {
  if (!SEL || !selBandEl) return;
  const x0 = time2px(SEL.t0), x1 = time2px(SEL.t1);
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) { selBandEl.style.display = "none"; return; }
  selBandEl.style.display = "";
  selBandEl.style.left = Math.min(x0, x1) + "px";
  selBandEl.style.width = Math.max(SEL.point ? 2 : 0, Math.abs(x1 - x0)) + "px";
}
function gatherSelection(t0, t1) {
  if (t1 < t0) { const x = t0; t0 = t1; t1 = x; }
  // индексы внутри окна
  let i0 = -1, i1 = -1;
  for (let i = 0; i < N; i++) {
    const t = SERIES.ts[i];
    if (t >= t0 && t <= t1) { if (i0 === -1) i0 = i; i1 = i; }
  }
  if (i0 === -1) return null;
  const stats = {};
  ACTIVE_AXES.forEach((c) => {
    const arr = SERIES.data[c.key];
    let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0, first = null, last = null;
    for (let i = i0; i <= i1; i++) {
      const v = arr[i];
      if (v == null) continue;
      if (first === null) first = v;
      last = v;
      if (v < mn) mn = v; if (v > mx) mx = v; sum += v; cnt++;
    }
    stats[c.key] = cnt ? { min: mn, max: mx, avg: sum / cnt, first, last } : null;
  });
  return { t0: SERIES.ts[i0], t1: SERIES.ts[i1], i0, i1, stats };
}
// ---- Пустые окна (разрывы в записи) -----------------------------------------
// В .asc3 бывают реальные «пробелы»: за интервал нет ни одной записи (событийное
// сжатие / простой бригады). gatherSelection там вернёт null — нечего выделять и
// некуда вставлять. Решение: разрешить ВИРТУАЛЬНОЕ выделение (полоса рисуется по
// времени), а реальные строки создавать ЛЕНИВО — только в момент записи (вставка
// СПО / фигура) через ensureRows(). Так нет тормозов на выделении и нет «мусорных»
// пустых строк, если передумал.
const GAP_STEP_MS = 1000;    // родной такт регистратора = 1 Гц
const GAP_MAX_ROWS = 7200;   // предохранитель: максимум 2 ч × 1 с за один раз
// Позиция вставки строк для окна, начинающегося в t0 (после всех строк с ts<=t0).
function gapInsertIndex(t0) {
  let ins = tsIndex(t0);
  if (ins < N && SERIES.ts[ins] <= t0) ins++;
  return ins;
}
// Виртуальное выделение пустого окна: строки НЕ создаются, полоса по времени.
function virtualSelection(t0, t1) {
  if (t1 < t0) { const x = t0; t0 = t1; t1 = x; }
  const ins = gapInsertIndex(t0);
  return { t0, t1, i0: ins, i1: ins - 1, virtual: true, stats: {} };
}
// Материализация разрыва: сетка строк шагом 1 с в [t0..t1], значения null («х»),
// ROW_SRC=-1 (экспорт уйдёт в rebuild_asc3). Возвращает реальные {i0,i1} или null.
function materializeGap(t0, t1) {
  if (t1 < t0) { const x = t0; t0 = t1; t1 = x; }
  const ins = gapInsertIndex(t0);
  const prevT = ins > 0 ? SERIES.ts[ins - 1] : t0 - GAP_STEP_MS;
  const nextT = ins < N ? SERIES.ts[ins] : t1 + GAP_STEP_MS;
  const a = Math.max(t0, prevT + 1);           // строго возрастающие ts, не наезжая на соседей
  const b = Math.min(t1, nextT - 1);
  if (b < a) return null;
  let M = Math.floor((b - a) / GAP_STEP_MS) + 1;
  if (M > GAP_MAX_ROWS) M = GAP_MAX_ROWS;
  const times = new Array(M);
  for (let k = 0; k < M; k++) times[k] = a + k * GAP_STEP_MS;
  SERIES.ts.splice(ins, 0, ...times);
  CHANNELS.forEach((c) => {
    const arr = SERIES.data[c.key]; if (arr) arr.splice(ins, 0, ...new Array(M).fill(null));
  });
  if (ROW_SRC && ROW_SRC.length) ROW_SRC.splice(ins, 0, ...new Array(M).fill(-1));
  N += M;
  rebuildGrid();
  return { i0: ins, i1: ins + M - 1 };
}
// Гарантировать реальные строки под выделением: виртуальный SEL -> создаёт сетку и
// становится обычным диапазоном. Возвращает {i0,i1} (реальные) или null.
function ensureRows(sel) {
  if (!sel) return null;
  if (!sel.virtual) return { i0: sel.i0, i1: sel.i1 };
  const r = materializeGap(sel.t0, sel.t1);
  if (!r) { addNote("note", "Разрыв слишком узкий для создания строк."); return null; }
  sel.i0 = r.i0; sel.i1 = r.i1; sel.virtual = false;
  return r;
}
function clearSelection() {
  SEL = null; SEL_TAGS = [];
  if (selBandEl) selBandEl.style.display = "none";
  renderContext();
  applySelHighlight();
}
// по умолчанию выделены ВСЕ активные индикаторы (чипы «вкл», подсветка ячеек по ним)
function defaultSelTags() {
  return (ACTIVE_AXES && ACTIVE_AXES.length) ? ACTIVE_AXES.map((c) => c.key) : [];
}
// набор ключей для подсветки: выбранные токены, иначе все активные
function selKeySet() {
  const keys = (SEL_TAGS && SEL_TAGS.length) ? SEL_TAGS : defaultSelTags();
  const set = {}; keys.forEach((k) => (set[k] = true)); return set;
}
// подсвечена ли ячейка таблицы: строка в диапазоне выделения И канал выбран
function isCellSel(p) {
  if (!SEL || !p || !p.data) return false;
  const idx = p.data.__idx;
  if (idx == null) return false;
  const i1 = SEL.point ? SEL.i0 : SEL.i1;
  if (idx < SEL.i0 || idx > i1) return false;
  return !!selKeySet()[NAME2KEY[p.colDef.field]];
}
// перекрасить ячейки таблицы под текущее выделение (без row-selection: без фриза на 25k строк)
function applySelHighlight() {
  if (!GRID_API) return;
  if (SEL && GRID_API.ensureIndexVisible) GRID_API.ensureIndexVisible(SEL.i0, "middle");
  GRID_API.refreshCells({ force: true });
}
function renderContext() {
  const box = document.getElementById("ai-context");
  if (!box) return;
  box.innerHTML = "";
  if (!SEL) { box.style.display = "none"; return; }
  box.style.display = "";

  const hd = document.createElement("div");
  hd.className = "sel-hd";
  hd.textContent = SEL.point
    ? `Точка ${fmtTime(SEL.t0)} · кликай каналы (Ctrl+C/V, Del):`
    : `Выделено ${fmtTime(SEL.t0)}–${fmtTime(SEL.t1)} · ${SEL.i1 - SEL.i0 + 1} точек · кликай каналы (Ctrl+C/V, Del):`;
  box.appendChild(hd);

  // ---- Часть B: обучающийся бар частых действий (грей-подсказки) ----
  const quick = document.createElement("div");
  quick.className = "sel-quick"; quick.id = "sel-quick";
  box.appendChild(quick);
  renderQuickActions();

  const chips = document.createElement("div");
  chips.className = "sel-chips";
  ACTIVE_AXES.forEach((c) => {
    const st = SEL.stats[c.key];
    const b = document.createElement("button");
    b.className = "sel-chip" + (SEL_TAGS.includes(c.key) ? " on" : "");
    b.style.setProperty("--cc", c.color);
    b.title = c.name + (st ? ` · мин ${st.min.toFixed(1)} / макс ${st.max.toFixed(1)} / сред ${st.avg.toFixed(1)}` : "");
    b.innerHTML = `<span class="sc-name">${escHtml(shortName(c.name))}</span>` +   // #A20
      `<span class="sc-val">${st ? st.last.toFixed(1) : "—"}</span>`;
    b.onclick = () => {
      const i = SEL_TAGS.indexOf(c.key);
      if (i >= 0) SEL_TAGS.splice(i, 1); else SEL_TAGS.push(c.key);
      renderContext();
      applySelHighlight();   // перекрасить ячейки таблицы под новый набор каналов
      // НЕ забираем фокус в textarea — иначе Ctrl+C/V уходят в редактирование текста
    };
    chips.appendChild(b);
  });
  box.appendChild(chips);

  // ---- V8 (F16): предупреждение ДО правки, а не отказ ПОСЛЕ ----------------
  // Накопительный канал редактор умеет только переносить: закона
  // «наработка = f(вес, путь)» в данных нет, пересчитанное значение — выдумка,
  // и ворота V8 отклонят такую запись. Сказать об этом надо здесь, пока правка
  // не сделана: узнать о запрете на сохранении — значит потерять работу.
  // Это НЕ стена: отказ поканальный, ручка рядом — снять канал с выделения.
  const cumSel = cumInKeys(selKeys());
  if (cumSel.length) {
    const w = document.createElement("div");
    w.className = "sel-warn";
    const names = cumSel.map((k) => escHtml(chName(k) || k)).join(", ");
    w.innerHTML = "⚠ В выделении накопительный канал: <b>" + names + "</b>. "
      + "Его значения можно только ПЕРЕНЕСТИ — пересчитать наработку по весу и "
      + "пути нельзя, такого закона в данных нет. Правка этого канала будет "
      + "отклонена при сохранении (инвариант V8), остальные каналы сохранятся.";
    const off = document.createElement("button");
    off.className = "sel-act"; off.textContent = "Убрать из выделения";
    off.title = "Снять накопительный канал с выделения — остальные каналы правятся свободно";
    off.onclick = () => {
      const keys = SEL_TAGS.length ? SEL_TAGS : defaultSelTags();
      SEL_TAGS = keys.filter((k) => !CUM_KEYS.has(k));
      renderContext(); applySelHighlight();
    };
    w.appendChild(document.createElement("br"));
    w.appendChild(off);
    box.appendChild(w);
  }

  // явные кнопки (не зависят от фокуса/раскладки) — копировать/вставить/удалить
  const acts = document.createElement("div");
  acts.className = "sel-acts";
  const mk = (label, title, fn, dis) => {
    const a = document.createElement("button");
    a.className = "sel-act"; a.textContent = label; a.title = title;
    if (dis) a.disabled = true;
    a.onclick = fn;
    return a;
  };
  acts.appendChild(mk("⧉ Копировать", "Скопировать выделение (Ctrl+C)", doCopy));
  acts.appendChild(mk("⎘ Вставить", CLIP ? "Вставить от начала выделения (Ctrl+V)" : "Сначала скопируйте диапазон", doPaste, !CLIP));
  acts.appendChild(mk("🗑 Удалить", "Очистить значения выделения (Del)", doDelete));
  // F17: вернуть участок к тому, чем он был при ОТКРЫТИИ файла. Работает по
  // файлу на диске, поэтому после вставки/удаления строк отключается — иначе
  // вернул бы значения не туда (объяснение выдаёт сам doRevert).
  acts.appendChild(mk("⟲ Вернуть участок",
    "Вернуть выделенные каналы участка к значениям исходника — файла, каким его "
    + "открыли в этой сессии" + (ORIGIN_OPENED_AT ? " (" + ORIGIN_OPENED_AT + ")" : "")
    + ".\nОткат — такая же правка: он проходит те же ворота при сохранении.",
    doRevert));
  box.appendChild(acts);

  // Вставка/удаление СТРОК (блоков) убраны из UI как «прошлый век» —
  // работа со значениями идёт через график, а не таблицу.
  // Функции insertRowAtSel/deleteSelRows оставлены в коде: понадобятся
  // движку авто-подгонки (растяжение промежутков между СПО, §5 роадмапа).
  // Горячие клавиши Insert / Ctrl+Del по-прежнему работают.

  // ---- Этап 3: арифметика по выделению (+N / −N / =N / ·N%) ----
  // Применяется к выбранным каналам (или всем активным) в диапазоне выделения.
  // Число строк не меняется -> экспорт .asc3 не блокируется.
  const ar = document.createElement("div");
  ar.className = "sel-arith";
  const num = document.createElement("input");
  num.type = "number"; num.step = "any"; num.value = "1";
  num.className = "sel-arith-n"; num.title = "Операнд N для арифметики";
  const getN = () => num.value;
  ar.appendChild(num);
  const mkA = (label, title, op) => {
    const a = document.createElement("button");
    a.className = "sel-act sel-arith-b"; a.textContent = label; a.title = title;
    a.onclick = () => applyArith(op, getN());
    return a;
  };
  ar.appendChild(mkA("+N", "Прибавить N к каждому значению", "add"));
  ar.appendChild(mkA("−N", "Вычесть N из каждого значения", "sub"));
  ar.appendChild(mkA("=N", "Присвоить (заменить значением N)", "set"));
  ar.appendChild(mkA("·N%", "Масштабировать: умножить на N% (110 = ×1.1)", "pct"));
  box.appendChild(ar);

  // ---- СПО: детерминированный движок (production/spo_engine.py), без ИИ ----
  // Каналы отдаём ВСЕ, а не выбранные чипами: движок ищет «Вес на крюке» и
  // «Момент на ключе» ПО ИМЕНИ (у каждого файла свой словарь каналов —
  // грабля, стоившая отдельного измерения на трёх картограммах).
  const sp = document.createElement("div");
  sp.className = "sel-arith sel-spo";
  const spl = document.createElement("span");
  spl.className = "sel-hint"; spl.textContent = "СПО:";
  sp.appendChild(spl);
  const mkS = (label, title, fn) => {
    const a = document.createElement("button");
    a.className = "sel-act sel-arith-b"; a.textContent = label; a.title = title;
    a.onclick = fn;
    return a;
  };
  sp.appendChild(mkS("⌁ Разметить",
    "Найти зубья СПО по весу и определить спуск/подъём по тренду пиков.\n" +
    "Ничего не меняет — только рассказывает, что видит движок.",
    () => spoCall("analyze", {})));
  const mkNum = (val, title, on) => {
    const n = document.createElement("input");
    n.type = "number"; n.step = "0.1"; n.value = String(val);
    n.className = "sel-arith-n"; n.title = title;
    n.onchange = () => { const v = parseFloat(n.value); if (Number.isFinite(v)) on(v); };
    return n;
  };
  sp.appendChild(mkNum(SPO_LO, "Нижняя граница коридора момента, кН·м", (v) => (SPO_LO = v)));
  sp.appendChild(mkNum(SPO_HI, "Верхняя граница коридора момента, кН·м", (v) => (SPO_HI = v)));
  sp.appendChild(mkS("⌂ Момент в коридор",
    "Загнать «Момент на ключе» в коридор мягко (tanh, без срезанных полок).\n" +
    "Паразитный момент при взятии трубы с мостков исключается из правки.",
    () => spoCall("torque", { lo: SPO_LO, hi: SPO_HI })));
  box.appendChild(sp);

  // ---- F6/F7/F8: правка канала кнопкой, с подсказкой, измеренной здесь ----
  // Числа в подсказке считает сервер ОДНИМ прогоном с правкой (_corr_run в
  // production/main.py): подсказка — это прогон правки, у которого просто не
  // забирают значения. Поэтому «тронет 12 точек» — не обещание, а результат.
  // До 28.08 подсказку и правку считали разные ветки, и они расходились:
  // 120 случаев из 120 по F7 и 39 окон из 40 по «Наработке каната» (КРИТИКА №4).
  // Ограничения кнопок взяты из замеров, а не из головы (см. /api/correct):
  //   F8 правит только выбранные каналы (полка веса ≠ нули Vсп/Мкл: 25,4 %);
  //   F7 не подставляет сдвиг для веса (оценка устойчива на 70,3 % < 80 %)
  //     и для каналов без роли — им уровень покоя не мерили вовсе;
  //   F6 не трогает серии длиннее 2 точек (запрет в движке).
  const cr = document.createElement("div");
  cr.className = "sel-arith sel-corr";
  const crl = document.createElement("span");
  crl.className = "sel-hint"; crl.textContent = "Правка:";
  cr.appendChild(crl);
  cr.appendChild(mkS("? Что сделают",
    "Посчитать на этом выделении, сколько точек тронет каждая правка.\n" +
    "Ничего не меняет — это меню подсказок, выбор за вами.",
    () => correctPreview()));
  cr.appendChild(mkS("✖ Убрать выброс",
    "Фильтр Хампеля 4σ по скользящей медиане (окно 5).\n" +
    "Серии длиннее 2 точек НЕ трогаются: 10 подряд «выбросов» — это взятие "
    + "трубы, а не сбой прибора.",
    () => correctCall("despike", {})));
  const shiftN = document.createElement("input");
  shiftN.type = "number"; shiftN.step = "0.1"; shiftN.value = "";
  shiftN.className = "sel-arith-n";
  shiftN.placeholder = "сдвиг";
  shiftN.title = "Сдвиг канала. Пусто — сервер подставит уровень покоя сам "
    + "(для момента и скорости; для веса откажет и попросит число).";
  cr.appendChild(shiftN);
  cr.appendChild(mkS("↕ Сдвинуть уровень",
    "Сдвинуть канал так, чтобы уровень покоя встал в ноль.\n" +
    "Пустое поле — уровень измеряется по выделению; для «Веса на крюке» "
    + "число обязан ввести человек (оценка неустойчива на корпусе).",
    () => {
      const v = parseFloat(String(shiftN.value).replace(",", "."));
      correctCall("shift", Number.isFinite(v) ? { delta: v } : {});
    }));
  cr.appendChild(mkS("▭ Заморозить участок",
    "Полка на уровне медианы выделения — по выбранным каналам.\n" +
    "Скорость и момент сами не обнуляются: внутри полки веса они нули лишь "
    + "у 25,4 % участков корпуса.",
    () => correctCall("flatten", { mode: "median" })));
  box.appendChild(cr);

  if (SEL_TAGS.length) {
    const tk = document.createElement("div");
    tk.className = "sel-tokens";
    SEL_TAGS.forEach((k) => {
      const c = CHANNELS.find((x) => x.key === k);
      const s = document.createElement("span");
      s.className = "sel-token"; s.style.background = c.color;
      s.textContent = shortName(c.name);
      tk.appendChild(s);
    });
    const hint = document.createElement("span");
    hint.className = "sel-hint";
    hint.textContent = "— текст ниже относится к этим каналам";
    tk.appendChild(hint);
    box.appendChild(tk);
  }
}
/* ====================================================================
   ИНТЕРВАЛЫ ИЗ СВОДНОГО ОТЧЁТА (ФАЗА 2, Часть A)
   Текст отчёта -> POST /api/report/attach -> список интервалов работ.
   UI над #ai-context: мастер-тумблер + тумблер на интервал + «+ добавить все».
   Клик по интервалу подсвечивает соответствующее окно на картограмме
   (через gatherSelection + dataZoom по абсолютному времени).
   ==================================================================== */
let INTERVALS = [];   // [{t0,t1,operation,kind,vol,depth_from,depth_to,confidence,_on,_t0ms,_t1ms}]

async function attachReport(filename, text, ctx) {
  addNote("status", "Отчёт «" + (filename || "текст") + "» отправлен на разбор…");
  try {
    const r = await fetch("/api/report/attach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: filename || "", text: text || "", ctx: ctx || null }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      addNote("note", "Разбор отчёта не удался: " + (j && j.error ? j.error : r.status));
      return;
    }
    INTERVALS = (j.intervals || []).map((it) => {
      const t0ms = parseTs(it.t0), t1ms = parseTs(it.t1);
      return Object.assign({}, it, { _on: false, _t0ms: t0ms, _t1ms: t1ms });
    });
    renderIntervals();
    const src = j.source === "llm" ? "ИИ" : "эвристика";
    addMsg("ai", "Из отчёта «" + (j.filename || filename || "") + "» выделено интервалов: " +
      INTERVALS.length + " (" + src + "). Включите нужные тумблером или «+ добавить все», " +
      "клик по интервалу — подсветка окна на картограмме.");
    (j.warnings || []).forEach((w) => addNote("note", w));
  } catch (e) {
    addNote("note", "Разбор отчёта не удался (бэкенд недоступен?): " + e);
  }
}

/* ====================================================================
   ЖИВОЙ АССИСТЕНТ (ФАЗА 2, Часть B; v105) — движок корректировок.
   Текст команды -> POST /api/ai/command -> сервер разбирает (правила + опц. LLM)
   и возвращает скорректированные значения; применяем к рабочей копии
   (histPush -> отмена Ctrl+Z). P1: без выделения — только с confirm();
   в файл изменения попадают лишь через обычное «Сохранить».
   ==================================================================== */
let AI_BUSY = false;
async function aiCommand(text, tags, sel) {
  if (!text) { addNote("note", "Напишите команду (например «помощь»)."); return; }
  if (AI_BUSY) { addNote("note", "Предыдущая команда ещё выполняется…"); return; }
  const keys = (tags && tags.length) ? tags : ACTIVE_AXES.map((c) => c.key);
  const hasSel = !!sel;
  const i0 = hasSel ? sel.i0 : 0;
  const i1 = hasSel ? (sel.point ? sel.i0 : sel.i1) : (N - 1);
  const channels = keys.map((k) => {
    const c = CHANNELS.find((x) => x.key === k);
    return { key: k, name: c ? c.name : k, values: (SERIES.data[k] || []).slice(i0, i1 + 1) };
  }).filter((c) => c.values.length);
  // включённые интервалы отчёта — контекст для «расшифруй»
  const intervals = INTERVALS
    .filter((it) => it._on && Number.isFinite(it._t0ms) && Number.isFinite(it._t1ms))
    .map((it) => ({
      t0: msToInput(it._t0ms).replace("T", " "),
      t1: msToInput(it._t1ms).replace("T", " "),
      operation: it.operation, kind: it.kind,
    }));
  AI_BUSY = true;
  let j;
  try {
    const r = await fetch("/api/ai/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, has_selection: hasSel, channels: channels, intervals: intervals }),
    });
    j = await r.json();
    if (!r.ok || !j.ok) {
      addNote("note", "Ассистент: " + ((j && j.error) || ("HTTP " + r.status)));
      return;
    }
  } catch (e) {
    addNote("note", "Ассистент недоступен (бэкенд?): " + e);
    return;
  } finally { AI_BUSY = false; }

  if (j.results && j.results.length) {
    if (!hasSel && !confirm("Выделение не сделано — применить «" + (j.label || "корректировку") +
        "» ко ВСЕМУ файлу (" + N + " точек)?")) {
      addNote("note", "Отменено: без выделения корректировка не применена.");
      return;
    }
    let applied = 0;
    j.results.forEach((res) => {
      const arr = SERIES.data[res.key];
      if (!arr || !Array.isArray(res.values)) return;
      const upTo = Math.min(res.values.length, i1 - i0 + 1);
      for (let x = 0; x < upTo; x++) arr[i0 + x] = res.values[x];
      applied += res.changed || 0;
    });
    if (applied > 0) {
      histPush("ИИ: " + (j.label || "корректировка"));
      refreshGrid();
      renderChart();
    }
  }
  addMsg("ai", j.answer || "Готово.");
}

/* ====================================================================
   ДВИЖОК СПО (v109) — детерминированные правки без ИИ.
   Выделение -> POST /api/spo -> сервер (production/spo_engine.py) считает и
   САМ проверяет инварианты T1–T5; при нарушении приходит ошибка, а не
   испорченные значения. Применяем как ассистент: в рабочую копию + histPush
   (Ctrl+Z отменяет), в .asc3 уходит только через «Сохранить» (P1).
   ==================================================================== */
let SPO_BUSY = false;
let SPO_LO = 0.5, SPO_HI = 2.5;   // коридор момента по умолчанию, кН·м
async function spoCall(op, params) {
  if (!SEL) { addNote("note", "Сначала выделите окно на графике."); return; }
  if (SPO_BUSY) { addNote("note", "Движок СПО ещё считает…"); return; }
  const i0 = SEL.i0, i1 = SEL.point ? SEL.i0 : SEL.i1;
  if (i1 - i0 + 1 < 3) {
    addNote("note", "Слишком узкое выделение: движку СПО нужно минимум 3 точки.");
    return;
  }
  const ts = SERIES.ts.slice(i0, i1 + 1);
  const channels = CHANNELS
    .map((c) => ({ key: c.key, name: c.name, values: (SERIES.data[c.key] || []).slice(i0, i1 + 1) }))
    .filter((c) => c.values.length === ts.length);
  if (!channels.length) { addNote("note", "В выделении нет данных."); return; }
  SPO_BUSY = true;
  let j;
  const post = (confirm) => fetch("/api/spo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: op, ts: ts, channels: channels,
                           params: params || {}, confirm_dispute: !!confirm }),
  });
  try {
    let r = await post(false);
    j = await r.json();
    // Ворота F12/Д3 — то же поведение, что у кнопок правки: спрашиваем один раз.
    if (r.status === 409 && j && j.dispute) {
      const d = j.dispute || {};
      if (!window.confirm(
        "Признаки направления спорят: " + (d.why || "") + ".\n\n"
        + "По ТЗ (F12/Д3) движок на таком окне сам не правит. Сузьте выделение "
        + "до участка с одним направлением — это безопаснее.\n\n"
        + "Нажмите ОК, чтобы всё-таки применить правку и взять решение на себя.")) {
        addMsg("ai", "Правка отменена: окно спорное по направлению ("
                     + (d.why || "") + "). Файл не изменён.");
        return;
      }
      r = await post(true);
      j = await r.json();
    }
    if (!r.ok || !j.ok) {
      addNote("note", "СПО: " + ((j && j.error) || ("HTTP " + r.status)));
      return;
    }
  } catch (e) {
    addNote("note", "Движок СПО недоступен (бэкенд?): " + e);
    return;
  } finally { SPO_BUSY = false; }

  let applied = 0;
  (j.results || []).forEach((res) => {
    const arr = SERIES.data[res.key];
    if (!arr || !Array.isArray(res.values)) return;
    const upTo = Math.min(res.values.length, i1 - i0 + 1);
    for (let x = 0; x < upTo; x++) arr[i0 + x] = res.values[x];
    applied += res.changed || 0;
  });
  if (applied > 0) {
    histPush("СПО: " + (j.label || op));
    refreshGrid();
    renderChart();
  }
  addMsg("ai", j.answer || "Готово.");
}

/* ====================================================================
   F6/F7/F8 — правка канала кнопкой (ТЗ §5, Этап 3)
   Один вход /api/correct: preview=true считает подсказку, preview=false правит.
   Каналы отдаём ВЫБРАННЫЕ чипами (или все активные) — в отличие от СПО, где
   движок сам ищет вес и момент по имени: здесь оператор указывает, что править.
   ==================================================================== */
let CORR_BUSY = false;

// К4-6: одно нажатие «? Что сделают» на выделении во весь файл — это 3 запроса,
// 3,62 с и 5,1 МБ трафика (research/out/critique4_attack.log), а на экране за
// это время не менялось НИЧЕГО. Оператор в такой тишине жмёт второй раз, и для
// despike это не безобидно: кнопка не идемпотентна (75 -> 23 -> 9 -> 3 -> 2).
// Поэтому на время счёта кнопки гасим и говорим, что считаем.
function corrSetBusy(on) {
  CORR_BUSY = !!on;
  const box = document.querySelector(".sel-corr");
  if (!box) return;
  box.querySelectorAll("button, input").forEach((el) => { el.disabled = !!on; });
  let m = box.querySelector(".sel-corr-busy");
  if (on) {
    if (!m) {
      m = document.createElement("span");
      m.className = "sel-hint sel-corr-busy";
      box.appendChild(m);
    }
    m.textContent = "считаю…";
  } else if (m) {
    m.remove();
  }
}

// Запас контекста по краям выделения — держать В СОГЛАСИИ с _CORR_PAD в
// production/main.py. Окно медианы despike смотрит на соседей за границей
// выделения; голый срез давал у края обрезанное окно и результат, отличный от
// честного, в 46 окнах из 200 по весу и 77 из 200 по моменту
// (research/out/critique4_attack2.log, п.3). Шлём срез с запасом, а в idx
// говорим, где внутри него само выделение: писать за idx серверу нельзя.
const CORR_PAD = 8;

function corrPayload() {
  if (!SEL) { addNote("note", "Сначала выделите окно на графике."); return null; }
  const i0 = SEL.i0, i1 = SEL.point ? SEL.i0 : SEL.i1;
  if (i1 - i0 + 1 < 3) {
    addNote("note", "Слишком узкое выделение: движку нужно минимум 3 точки.");
    return null;
  }
  const o0 = Math.max(0, i0 - CORR_PAD);      // начало присылаемого куска
  const o1 = i1 + CORR_PAD;                   // slice сам обрежет по концу ряда
  const keys = selKeys();
  const channels = keys
    .map((k) => CHANNELS.find((c) => c.key === k))
    .filter(Boolean)
    .map((c) => ({ key: c.key, name: c.name,
                   values: (SERIES.data[c.key] || []).slice(o0, o1 + 1) }))
    .filter((c) => c.values.length >= i1 - o0 + 1);
  if (!channels.length) { addNote("note", "В выделении нет данных."); return null; }
  // ctx — каналы для ЧТЕНИЯ направления (F12/Д3), а не для правки: сервер
  // читает по ним спор методов A и B и НЕ пишет в них ничего. Без этого ворота
  // не работали бы на самом частом выделении — «правлю только момент».
  const need = /вес на крюке|момент на ключе|скорость спо/i;
  const have = new Set(keys);
  const ctx = CHANNELS
    .filter((c) => !have.has(c.key) && need.test(c.name || ""))
    .map((c) => ({ key: c.key, name: c.name,
                   values: (SERIES.data[c.key] || []).slice(o0, o1 + 1) }))
    .filter((c) => c.values.length >= i1 - o0 + 1);
  return { i0: i0, i1: i1, o0: o0, idx: [i0 - o0, i1 - o0 + 1],
           ts: (SERIES.ts || []).slice(o0, o1 + 1),
           channels: channels, ctx: ctx };
}

async function correctPost(op, params, preview, pay, confirm) {
  const r = await fetch("/api/correct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: op, params: params || {}, preview: !!preview,
                           idx: pay.idx, channels: pay.channels,
                           ts: pay.ts, ctx: pay.ctx,
                           confirm_dispute: !!confirm }),
  });
  const j = await r.json();
  // 409 = ворота F12: окно спорное по направлению. Это не отказ навсегда —
  // решение по ТЗ за человеком, поэтому спрашиваем и повторяем ОДИН раз.
  if (r.status === 409 && j && j.dispute && !confirm) {
    const e = new Error((j && j.error) || "спор направления");
    e.dispute = j;
    throw e;
  }
  if (!r.ok || !j.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
  return j;
}

async function correctPreview() {
  const pay = corrPayload();
  if (!pay || CORR_BUSY) return;
  corrSetBusy(true);
  try {
    const ops = [["despike", {}], ["shift", {}], ["flatten", { mode: "median" }]];
    const outs = [];
    for (const [op, pr] of ops) {
      const j = await correctPost(op, pr, true, pay);
      outs.push(j.answer);
    }
    addMsg("ai", outs.join("\n\n"));
  } catch (e) {
    addNote("note", "Подсказку посчитать не удалось: " + e);
  } finally { corrSetBusy(false); }
}

async function correctCall(op, params) {
  const pay = corrPayload();
  if (!pay) return;
  if (CORR_BUSY) { addNote("note", "Движок правки ещё считает…"); return; }
  corrSetBusy(true);
  let j;
  try {
    j = await correctPost(op, params, false, pay);
  } catch (e) {
    // Ворота F12/Д3: движок сам на спорном окне не правит, но и не решает за
    // человека. Спрашиваем ОДИН раз и повторяем с подтверждением; отказ от
    // подтверждения — это не ошибка, а нормальный исход.
    if (e && e.dispute) {
      const d = e.dispute.dispute || {};
      const ok = window.confirm(
        "Признаки направления спорят: " + (d.why || "") + ".\n\n"
        + "По ТЗ (F12/Д3) движок на таком окне сам не правит. Сузьте выделение "
        + "до участка с одним направлением — это безопаснее.\n\n"
        + "Нажмите ОК, чтобы всё-таки применить «" + (op || "правку")
        + "» и взять решение на себя.");
      if (!ok) {
        addMsg("ai", "Правка отменена: окно спорное по направлению ("
                     + (d.why || "") + "). Файл не изменён.");
        corrSetBusy(false);
        return;
      }
      try {
        j = await correctPost(op, params, false, pay, true);
      } catch (e2) {
        addNote("note", "Правка не выполнена: " + e2);
        corrSetBusy(false);
        return;
      }
    } else {
      addNote("note", "Правка не выполнена: " + e);
      corrSetBusy(false);
      return;
    }
  }
  corrSetBusy(false);
  let applied = 0;
  (j.results || []).forEach((res) => {
    const arr = SERIES.data[res.key];
    if (!arr || !Array.isArray(res.values)) return;
    // Сервер вернул кусок С ЗАПАСОМ; в ряд кладём ТОЛЬКО выделение — запас
    // существует для чтения соседей, и записывать его обратно незачем.
    const off = (pay.idx && pay.idx[0]) || 0;
    const upTo = Math.min(res.values.length - off, pay.i1 - pay.i0 + 1);
    for (let x = 0; x < upTo; x++) arr[pay.i0 + x] = res.values[off + x];
    applied += res.changed || 0;
  });
  if (applied > 0) {
    histPush("Правка: " + (j.label || op));
    refreshGrid();
    renderChart();
  }
  addMsg("ai", j.answer || "Готово.");
}

/* ====================================================================
   F17 — сравнение с исходником и откат участка (S-023)
   Отсчёт — файл, каким его ОТКРЫЛИ в этой сессии; сохранения его не двигают.
   Оба вызова работают с файлом НА ДИСКЕ: сервер разбирает два .asc3 и
   выравнивает их по времени записи. Значит несохранённые правки в отчёт не
   попадают, и об этом надо говорить вслух — «изменений нет» при грязном
   редакторе оператор прочтёт как «я ничего не менял», а это ложный зелёный.
   ==================================================================== */
let F17_BUSY = false;

async function doDiff() {
  if (F17_BUSY) { addNote("note", "Сравнение уже идёт…"); return; }
  F17_BUSY = true;
  try {
    const r = await fetch("/api/diff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base: "origin", limit: 50 }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      addNote("note", "Сравнение: " + ((j && j.error) || ("HTTP " + r.status)));
      return;
    }
    // E6: отчёт построен по файлу на диске. Если в редакторе есть несохранённое,
    // молчать об этом нельзя — иначе «изменений нет» будет неправдой.
    if (isDirty()) {
      addNote("warn", "В редакторе есть НЕСОХРАНЁННЫЕ правки — в этот отчёт они "
        + "не вошли: сравниваются два файла на диске. Сохраните и сравните снова, "
        + "чтобы увидеть их.");
    }
    addMsg("ai", j.report || "Отчёт пуст.");
  } catch (e) {
    addNote("note", "Движок сравнения недоступен (бэкенд?): " + e);
  } finally { F17_BUSY = false; }
}

async function doRevert() {
  if (!SEL) { addNote("note", "Сначала выделите участок на графике (тяните ЛКМ)."); return; }
  if (SEL.virtual) { addNote("note", "Это пустое окно — возвращать в нём нечего."); return; }
  // Номера строк в /api/revert — строки ФАЙЛА. Пока в памяти не вставляли и не
  // удаляли строк, они совпадают с нашими индексами; после структурной правки
  // совпадение теряется, и откат вернул бы значения НЕ ТУДА. Молча пересчитать
  // сдвиг нельзя — ROW_SRC знает происхождение строк, но не знает, что стало с
  // файлом на диске. Поэтому честный ответ — отказ с названной причиной.
  if (!rowSrcIsIdentity()) {
    addNote("note", "Вернуть участок нельзя: в этой сессии добавлялись или "
      + "удалялись строки, и номера строк в памяти уже не совпадают с файлом. "
      + "Сохраните файл и откройте заново — тогда откат снова точен.");
    return;
  }
  if (F17_BUSY) { addNote("note", "Откат уже идёт…"); return; }
  const i0 = SEL.i0, i1 = SEL.point ? SEL.i0 : SEL.i1;
  const keys = selKeys();
  if (!keys.length) { addNote("note", "Не выбрано ни одного канала."); return; }
  // Ключ, которому не нашлось имени, сервер отбросил бы молча, и откат
  // отчитался бы «возвращать нечего» — ложный зелёный вместо отказа.
  const names = keys.map(chName);
  if (names.some((nm) => !nm)) {
    addNote("note", "Откат отменён: не удалось назвать по имени "
      + names.filter((nm) => !nm).length + " из " + names.length
      + " выбранных каналов. Переоткройте файл.");
    return;
  }
  F17_BUSY = true;
  let j;
  try {
    const r = await fetch("/api/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base: "origin", channels: names, row_from: i0, row_to: i1 }),
    });
    j = await r.json();
    if (!r.ok || !j.ok) {
      addNote("note", "Откат: " + ((j && j.error) || ("HTTP " + r.status)));
      return;
    }
  } catch (e) {
    addNote("note", "Движок отката недоступен (бэкенд?): " + e);
    return;
  } finally { F17_BUSY = false; }

  // Строки могли вставить или удалить ГОРЯЧЕЙ КЛАВИШЕЙ, пока шёл запрос:
  // проверка в начале функции была до await и уже устарела. Применить значения
  // по старым номерам строк — записать их не туда, тихо и с записью в историю.
  if (!rowSrcIsIdentity()) {
    addNote("note", "Откат отменён: пока шёл запрос, в редакторе добавились или "
      + "удалились строки, и номера строк из ответа уже не те. Повторите откат.");
    return;
  }

  const NAME2K = {};
  CHANNELS.forEach((c) => (NAME2K[c.name] = c.key));
  const rows = j.rows || [];
  const got = j.values || {};
  let applied = 0, chans = 0, skipped = 0, outside = 0;
  // Канал, который спросили, но не получили назад (сервер не нашёл колонку с
  // таким именем — например имена каналов в файле дублируются), обязан быть
  // назван числом. Иначе «восстановлено N значений» скрывает, что часть
  // выделения не тронута вовсе.
  names.forEach((nm) => { if (!(nm in got)) skipped++; });
  Object.keys(got).forEach((nm) => {
    const k = NAME2K[nm], arr = k ? SERIES.data[k] : null;
    if (!arr) { skipped++; return; }
    const col = got[nm] || [];
    let n = 0;
    for (let x = 0; x < rows.length && x < col.length; x++) {
      const i = rows[x];
      if (i < 0 || i >= N) { outside++; continue; }
      if (arr[i] !== col[x]) { arr[i] = col[x]; n++; }
    }
    if (n) { applied += n; chans++; }
  });
  if (applied) {
    histPush("Возврат участка (" + chans + "к)");
    refreshGrid(); renderChart();
  }
  let txt = "Возврат к исходнику: восстановлено " + applied + " значений в "
    + chans + " канале(ах), строк в участке " + rows.length + ".";
  if (!applied) {
    // Ноль восстановленных значит «совпадает с исходником» ТОЛЬКО когда все
    // выбранные каналы дошли и все строки попали в диапазон. Иначе это не
    // «нечего возвращать», а «не получилось» — разные вещи для оператора.
    txt = (skipped || outside)
      ? "Откат ничего не вернул, но и участок не проверен целиком — см. ниже."
      : "Возвращать нечего: в этом участке значения совпадают с исходником.";
  }
  if (skipped) {
    txt += " Каналов не сопоставлено: " + skipped + " из " + names.length
      + " — их значения НЕ возвращены (имена каналов в файле не уникальны?).";
  }
  if (outside) {
    txt += " Строк вне таблицы: " + outside + " — пропущены.";
  }
  // Строки без пары — вставленные после открытия файла. Молчать о них нельзя:
  // «участок возвращён» тогда означало бы не то, что видит оператор.
  if (j.missing_count) {
    txt += " Строк без пары в исходнике: " + j.missing_count
      + " — они появились после открытия файла, у них нет исходного значения; "
      + "убрать их можно только удалением строк, и это отдельная осознанная правка.";
  }
  if (ORIGIN_OPENED_AT || j.base) {
    txt += " Отсчёт: " + (j.base || "исходник")
      + (ORIGIN_OPENED_AT ? ", снят при открытии " + ORIGIN_OPENED_AT : "") + ".";
  }
  addMsg("ai", txt);
}

function intervalLabel(it) {
  const a = Number.isFinite(it._t0ms) ? fmtTime(it._t0ms) : (it.t0 || "?");
  const b = Number.isFinite(it._t1ms) ? fmtTime(it._t1ms) : (it.t1 || "");
  return a + (b ? "–" + b : "");
}

function highlightInterval(it) {
  if (!Number.isFinite(it._t0ms)) { addNote("note", "У интервала не распознано время начала — подсветка недоступна."); return; }
  const t0 = it._t0ms, t1 = Number.isFinite(it._t1ms) ? it._t1ms : it._t0ms;
  const s = gatherSelection(t0, t1);
  if (!s) { addNote("note", "Интервал «" + (it.operation || it.kind || "") + "» вне диапазона данных картограммы."); return; }
  SEL = s; SEL_TAGS = [];
  positionSelBand(); renderContext();
  if (typeof selectGridRange === "function") selectGridRange(s.i0, s.i1);
  // подвинуть видимое окно к интервалу (dataZoom по абсолютному времени)
  chart.dispatchAction({ type: "dataZoom", startValue: t0, endValue: t1 });
  if (typeof markZoomed === "function") markZoomed();
}

function renderIntervals() {
  const box = document.getElementById("ai-intervals");
  if (!box) return;
  box.innerHTML = "";
  if (!INTERVALS.length) { box.style.display = "none"; return; }
  box.style.display = "";

  const hd = document.createElement("div");
  hd.className = "iv-hd";
  const allOn = INTERVALS.every((it) => it._on);
  const anyOn = INTERVALS.some((it) => it._on);
  const master = document.createElement("button");
  master.className = "iv-master" + (anyOn ? " on" : "");
  master.textContent = (allOn ? "▣ " : anyOn ? "◪ " : "▢ ") + "Интервалы из отчёта (" + INTERVALS.length + ")";
  master.title = "Включить/выключить все интервалы";
  master.onclick = () => { const v = !allOn; INTERVALS.forEach((it) => (it._on = v)); renderIntervals(); };
  hd.appendChild(master);
  const addAll = document.createElement("button");
  addAll.className = "iv-addall";
  addAll.textContent = "+ добавить все";
  addAll.title = "Включить все интервалы";
  addAll.onclick = () => { INTERVALS.forEach((it) => (it._on = true)); renderIntervals(); };
  hd.appendChild(addAll);
  box.appendChild(hd);

  const list = document.createElement("div");
  list.className = "iv-list";
  INTERVALS.forEach((it) => {
    const row = document.createElement("div");
    row.className = "iv-row" + (it._on ? " on" : "");
    const tg = document.createElement("button");
    tg.className = "iv-tg" + (it._on ? " on" : "");
    tg.textContent = it._on ? "☑" : "☐";
    tg.title = "Включить интервал в разметку";
    tg.onclick = (e) => { e.stopPropagation(); it._on = !it._on; renderIntervals(); };
    row.appendChild(tg);

    const main = document.createElement("div");
    main.className = "iv-main";
    const time = document.createElement("span"); time.className = "iv-time"; time.textContent = intervalLabel(it);
    const op = document.createElement("span"); op.className = "iv-op"; op.textContent = it.operation || it.kind || "—";
    main.appendChild(time); main.appendChild(op);
    const bits = [];
    if (it.vol != null) bits.push("V=" + it.vol + " м³");
    if (it.depth_from != null) bits.push(it.depth_from + (it.depth_to != null ? "–" + it.depth_to : "") + " м");
    if (bits.length) { const meta = document.createElement("span"); meta.className = "iv-meta"; meta.textContent = bits.join(" · "); main.appendChild(meta); }
    main.title = "Клик — подсветить окно на картограмме";
    main.onclick = () => highlightInterval(it);
    row.appendChild(main);

    if (!Number.isFinite(it._t0ms)) {
      const warn = document.createElement("span"); warn.className = "iv-warn"; warn.textContent = "⚠";
      warn.title = "Время не распознано — подсветка недоступна"; row.appendChild(warn);
    }
    list.appendChild(row);
  });
  box.appendChild(list);
}

function bindSelection() {
  const dom = document.getElementById("chart");
  ensureSelBand();
  dom.addEventListener("contextmenu", (e) => e.preventDefault());
  dom.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;                      // выделение = обычный ЛКМ (В2 Гибрид)
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return; // модификаторы — аккорды/box-zoom
    if (editDragOn()) return;                       // в режимах ✎/⌫/СПО не вмешиваемся
    e.preventDefault();
    selDown = true; selMoved = false;
    selX0 = e.offsetX; selX1 = e.offsetX;
    const band = ensureSelBand();
    band.style.display = ""; band.style.left = selX0 + "px"; band.style.width = "0px";
  });
  window.addEventListener("mousemove", (e) => {
    if (!selDown) return;
    const rect = dom.getBoundingClientRect();
    selX1 = e.clientX - rect.left;
    if (Math.abs(selX1 - selX0) > 3) selMoved = true;
    const band = ensureSelBand();
    band.style.left = Math.min(selX0, selX1) + "px";
    band.style.width = Math.abs(selX1 - selX0) + "px";
  });
  window.addEventListener("mouseup", (e) => {
    if (!selDown) return;
    selDown = false;
    if (!selMoved) {
      // ЛКМ без протяжки -> выделяем ОДНУ ближайшую точку (для вставки/правки)
      const t = px2time(selX0);
      if (Number.isFinite(t)) {
        const idx = nearestIdx(t);
        const s = gatherSelection(SERIES.ts[idx], SERIES.ts[idx]);
        if (s) { s.point = true; SEL = s; SEL_TAGS = []; positionSelBand(); renderContext(); selectGridRow(idx); }
      } else if (selBandEl) { selBandEl.style.display = "none"; }
      return;
    }
    const t0 = px2time(Math.min(selX0, selX1));
    const t1 = px2time(Math.max(selX0, selX1));
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) { clearSelection(); return; }
    const s = gatherSelection(t0, t1);
    if (!s) { clearSelection(); return; }
    SEL = s; SEL_TAGS = [];
    positionSelBand();
    renderContext();
    selectGridRange(s.i0, s.i1);
  });
  // левый клик по пустому месту графика -> сброс выделения
  chart.getZr().on("click", (e) => {
    if (!e.target && SEL) clearSelection();
  });
}

/* ====================================================================
   УПРАВЛЕНИЕ — схема «В2 Гибрид» (минимум клавиатуры, максимум мыши).
   Базовый слой (когда не включён инструмент тулбара ✎/⌫/СПО):
   • ЛКМ-драг       — выделение интервала (bindSelection); клик без драга — точка
   • Колесо         — зум под курсором (обе оси), адаптивная скорость + флик-сброс
       ◦ +Ctrl      — зум только по времени (горизонталь)
       ◦ +Shift     — зум только по амплитуде (вертикаль)
   • ПКМ-драг       — панорама по времени; ПКМ-клик без драга — снять выделение
   • Двойной клик   — сброс масштаба на весь файл (= средняя кнопка / Ctrl+/)
   • Alt+ЛКМ-драг   — рамка-зум области (box-zoom, опционально)
   Точечные аккорды активного канала:
   • Ctrl+ЛКМ       — добавить/править точку + курсор в таблицу
   • Ctrl+ПКМ       — обнулить точку (=0); +Alt — «х» (разрыв/null); +Shift — с соседями
   • в таблице      — ввод «х»/«x»/пусто/«-» в ячейку = разрыв (null)
   • Ctrl+A — выделить всё; Ctrl+Shift+A — снять; Ctrl+I — инвертировать каналы
   • по выделению: панель «Частые» / «Выделено» — сглаживание, заполнение, арифметика
   ==================================================================== */
let PAN = null;
function plotWidthPx() { return Math.max(10, chart.getWidth() - LAST_GRID.left - LAST_GRID.right); }
function chordAddPoint(px, py) {
  drawPoint(px, py);                                  // ставит точку + история + перерисовка
  const t = chart.convertFromPixel({ xAxisIndex: 0 }, px);
  if (Number.isFinite(t)) selectGridRow(nearestIdx(t));
  addNote("status", "Точка добавлена (Ctrl+ЛКМ). Случайно? Ctrl+Z — отменить.");   // Ф6: защита от случайного клика
}
function chordFind(px) {
  const t = chart.convertFromPixel({ xAxisIndex: 0 }, px);
  if (!Number.isFinite(t)) return;
  const idx = nearestIdx(t);
  selectGridRow(idx);
  addNote("status", "Найдено: " + fmtTime(SERIES.ts[idx]) + " — строка подсвечена в таблице.");
}
function chordDeletePoint(px, alt, shift) {
  const key = drawTargetKey();
  if (!key || !SERIES.data[key]) { addNote("note", "Включите канал для удаления в шапке графика."); return; }
  const t = chart.convertFromPixel({ xAxisIndex: 0 }, px);
  if (!Number.isFinite(t)) return;
  const idx = nearestIdx(t), arr = SERIES.data[key];
  const a = shift ? Math.max(0, idx - 1) : idx;
  const b = shift ? Math.min(N - 1, idx + 1) : idx;
  const val = alt ? null : 0;                          // Alt -> «х»(null, разрыв), иначе 0
  for (let i = a; i <= b; i++) arr[i] = val;
  histPush((alt ? "Очистка «" : "Обнуление «") + drawName(key) + "»" + (shift ? " ±сосед" : ""));
  renderChart(); refreshGrid();
}
function resetZoom() {
  // Сброс — на текущий домен: выбраны сутки -> в границы суток, иначе -> весь файл.
  zStart = XLO; zEnd = XHI;
  VY = { lo: 0, hi: 1 };
  chart.dispatchAction({ type: "dataZoom", start: XLO, end: XHI });
  renderChart();
  markZoomed();
  addNote("status", daySelActive() ? "Масштаб сброшен на выбранные сутки." : "Масштаб сброшен на весь файл.");
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
// красная рамка-сигнал «масштаб изменён» (привычная схема управления)
function markZoomed() {
  const dom = document.getElementById("chart");
  if (!dom) return;
  const z = zStart > 0.01 || zEnd < 99.99 || VY.lo > 0.001 || VY.hi < 0.999;
  dom.classList.toggle("zoomed", z);
}
/* ---- горизонталь (время): домен процентов 0..100 ---- */
function applyX(s, e) { zStart = s; zEnd = e; chart.dispatchAction({ type: "dataZoom", start: s, end: e }); markZoomed(); }
function xPan(frac) {
  const span = zEnd - zStart, d = frac * span;
  let s = zStart + d, e = zEnd + d;
  if (s < XLO) { e += XLO - s; s = XLO; } if (e > XHI) { s -= e - XHI; e = XHI; if (s < XLO) s = XLO; }
  applyX(s, e);
}
function xZoom(factor, pivot) {
  const span = zEnd - zStart, p = zStart + pivot * span, ns = span / factor;
  let s = p - pivot * ns, e = s + ns;
  if (s < XLO) s = XLO; if (e > XHI) e = XHI; if (e - s < 0.05) return;
  applyX(s, e);
}
/* ---- вертикаль: общее окно VY (0..1) ---- */
function yPan(frac) {
  const span = VY.hi - VY.lo, d = frac * span;
  let lo = VY.lo + d, hi = VY.hi + d;
  if (lo < 0) { hi -= lo; lo = 0; } if (hi > 1) { lo -= hi - 1; hi = 1; if (lo < 0) lo = 0; }
  VY = { lo, hi }; renderChartThrottled(); markZoomed();
}
function yZoom(factor, pivot) {
  const span = VY.hi - VY.lo, p = VY.lo + pivot * span, ns = span / factor;
  let lo = p - pivot * ns, hi = lo + ns;
  if (lo < 0) lo = 0; if (hi > 1) hi = 1; if (hi - lo < 0.01) return;
  VY = { lo, hi }; renderChartThrottled(); markZoomed();
}
function pivotX(px) { return clamp01((px - LAST_GRID.left) / plotWidthPx()); }
function pivotY(py) {
  const plotH = Math.max(10, chart.getHeight() - GRID_TOP - GRID_BOTTOM);
  return clamp01(1 - (py - GRID_TOP) / plotH);   // 0 — низ, 1 — верх
}
// Колесо: простой надёжный зум под курсором по обеим осям (фикс. скорость).
// Ctrl — только время, Shift — только амплитуда. Без адаптива/флик-сброса
// (их вернём позже аккуратнее: на части мышей серия событий ломала зум).
function onWheel(e) {
  if (editDragOn()) return;
  e.preventDefault();
  // Наведение на левую линейку (карман цветных осей) + колесо → меняем max этого канала.
  if (e.offsetX < LAST_GRID.left && !e.ctrlKey && !e.metaKey && !e.altKey && ACTIVE_AXES.length) {
    // полосы идут в порядке вкладок (idx0 слева) -> считаем от ПРАВОГО края кармана
    const bandFromRight = Math.floor((LAST_GRID.left - e.offsetX) / AXIS_W);
    const c = ACTIVE_AXES[ACTIVE_AXES.length - 1 - bandFromRight];
    if (c) { wheelAxisMax(c, e.deltaY < 0); return; }
  }
  const ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey;
  if (alt) {                                    // Alt — плавная ПРОКРУТКА по времени (панорама), масштаб НЕ меняется
    const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    xPan(d < 0 ? -0.08 : 0.08);                 // вверх — влево (раньше), вниз — вправо (позже)
    return;
  }
  const up = e.deltaY < 0;
  const f = up ? 1.15 : 1 / 1.15;
  const px = pivotX(e.offsetX), py = pivotY(e.offsetY);
  if (ctrl) { xZoom(f, px); }                  // Ctrl — только время
  else if (shift) { yZoom(f, py); }            // Shift — только амплитуда
  else { xZoom(f, px); yZoom(f, py); }         // обычное колесо — обе оси под курсором
}
function plotHeightPx() { return Math.max(10, chart.getHeight() - GRID_TOP - GRID_BOTTOM); }
function panStart(px, py) {
  const dom = document.getElementById("chart"); if (dom) dom.style.cursor = "grabbing";   // кулачок сжат
  // Якорь — ТЕКУЩЕЕ окно: X в процентах (zStart/zEnd), Y — вертикальное окно VY (0..1).
  // Так первый же pointermove при px≈PAN.px / py≈PAN.py даёт нулевой сдвиг — БЕЗ скачка захвата.
  PAN = { px, py: py || 0, s0: zStart, e0: zEnd, vlo0: VY.lo, vhi0: VY.hi,
          w: plotWidthPx(), h: plotHeightPx(), moved: false };
}
function panMove(px, py) {
  if (!PAN) return;
  const dpx = px - PAN.px, dpy = (py || 0) - PAN.py;
  if (Math.abs(dpx) > 3 || Math.abs(dpy) > 3) PAN.moved = true;
  // --- горизонталь (время) ---
  const wspan = PAN.e0 - PAN.s0;                        // ширина окна в %
  const dPct = (dpx / PAN.w) * wspan;                  // пиксельный сдвиг курсора -> % окна
  let s = PAN.s0 - dPct, e = PAN.e0 - dPct;             // тянем вправо -> окно влево (контент следует за курсором)
  if (s < XLO) { s = XLO; e = XLO + wspan; }
  if (e > XHI) { e = XHI; s = XHI - wspan; if (s < XLO) s = XLO; }
  applyX(s, e);                                         // тот же канал (start/end %), что зум и слайдер — без value-снапа
  // --- вертикаль (амплитуда): двигаем окно VY, только если зумились по вертикали ---
  const vspan = PAN.vhi0 - PAN.vlo0;
  if (vspan < 0.999 && py != null) {                   // есть вертикальный зум -> разрешаем вертикальную панораму
    const dv = (dpy / PAN.h) * vspan;                  // тянем вниз (dpy>0) -> окно VY вверх (контент следует за курсором)
    let lo = PAN.vlo0 + dv, hi = PAN.vhi0 + dv;
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > 1) { lo -= hi - 1; hi = 1; if (lo < 0) lo = 0; }
    VY = { lo, hi }; renderChartThrottled();
  }
}
/* ---- резиновая рамка зума по ЛКМ (привычная схема управления) ---- */
let ZB = null;       // {x0,y0,x1,y1,el}
function zbEnsure(dom) {
  let el = document.getElementById("zoom-rect");
  if (!el) { el = document.createElement("div"); el.id = "zoom-rect"; el.className = "zoom-rect"; dom.appendChild(el); }
  return el;
}
function zbStart(dom, px, py) {
  const el = zbEnsure(dom);
  ZB = { x0: px, y0: py, x1: px, y1: py, el };
  el.style.display = "block";
  zbDraw();
}
function zbDraw() {
  if (!ZB) return;
  const x = Math.min(ZB.x0, ZB.x1), y = Math.min(ZB.y0, ZB.y1);
  const w = Math.abs(ZB.x1 - ZB.x0), h = Math.abs(ZB.y1 - ZB.y0);
  ZB.el.style.left = x + "px"; ZB.el.style.top = y + "px";
  ZB.el.style.width = w + "px"; ZB.el.style.height = h + "px";
}
function zbApply() {
  if (!ZB) return;
  const dx = Math.abs(ZB.x1 - ZB.x0), dy = Math.abs(ZB.y1 - ZB.y0);
  ZB.el.style.display = "none";
  const band = ZB; ZB = null;
  if (dx < 6 && dy < 6) return;                         // клик, а не рамка — игнор
  // X (время): рамка в ПИКСЕЛЯХ -> доля ширины плоттера -> проценты dataZoom
  // ВНУТРИ текущего окна [zStart..zEnd]. НЕ через convertFromPixel/диапазон файла:
  // при выборе суток ось сужена (xAxis.min/max, #B2 v72), и «проценты от файла»
  // трактовались как проценты от суток -> зум уезжал, выделенная область не
  // отображалась после отпускания рамки (#B9). Пиксель-доля от min/max не зависит.
  if (dx >= 6) {
    const fr0 = pivotX(Math.min(band.x0, band.x1));   // доля 0..1 по ширине плоттера
    const fr1 = pivotX(Math.max(band.x0, band.x1));
    const win = zEnd - zStart;                          // текущее окно в процентах оси
    let s = zStart + fr0 * win, e = zStart + fr1 * win;
    s = Math.max(XLO, Math.min(XHI, s)); e = Math.max(XLO, Math.min(XHI, e));
    if (e - s >= 0.05) applyX(s, e);
  }
  // Y (вертикаль) -> компонуем в общее окно VY
  if (dy >= 6) {
    const fr1 = pivotY(band.y0), fr2 = pivotY(band.y1);
    const hiFr = Math.max(fr1, fr2), loFr = Math.min(fr1, fr2);
    const span = VY.hi - VY.lo;
    const nhi = VY.lo + hiFr * span, nlo = VY.lo + loFr * span;
    if (nhi - nlo >= 0.01) { VY = { lo: nlo, hi: nhi }; renderChart(); }
  }
  markZoomed();
}
function bindChords() {
  const dom = document.getElementById("chart");
  dom.addEventListener("mousedown", (e) => {
    if (editDragOn()) return;                           // в режимах инструментов — не мешаем
    const ctrl = e.ctrlKey || e.metaKey, alt = e.altKey, shift = e.shiftKey;
    if (e.button === 0) {
      if (ctrl && !shift && !alt) { e.preventDefault(); chordAddPoint(e.offsetX, e.offsetY); } // Ctrl+ЛКМ — точка
      else if (alt && !ctrl && !shift) { e.preventDefault(); zbStart(dom, e.offsetX, e.offsetY); } // Alt+ЛКМ — рамка-зум
      // чистый ЛКМ-драг — выделение (bindSelection), здесь не трогаем
    } else if (e.button === 2) {
      e.preventDefault();
      if (ctrl) chordDeletePoint(e.offsetX, alt, shift);  // Ctrl+ПКМ — удаление точки
      else panStart(e.offsetX);                           // ПКМ — панорама (клик без драга — снять выделение)
    } else if (e.button === 1) {
      e.preventDefault(); resetZoom();
    }
  });
  window.addEventListener("mousemove", (e) => {
    const rect = dom.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (ZB) { ZB.x1 = px; ZB.y1 = py; zbDraw(); return; }
    if (PAN) panMove(px);
  });
  window.addEventListener("mouseup", () => {
    if (ZB) zbApply();
    if (PAN && !PAN.moved && SEL) clearSelection();       // ПКМ-клик без протяжки — снять выделение
    PAN = null;
  });
  dom.addEventListener("dblclick", (e) => {
    if (editDragOn()) return;
    e.preventDefault(); resetZoom();                      // двойной клик — сброс масштаба
  });
  dom.addEventListener("wheel", onWheel, { passive: false });
}

/* ====================================================================
   ЕДИНЫЙ КОНТРОЛЛЕР ВВОДА (Этап 0 унификации управления).
   ОДИН владелец событий #chart: Pointer Events + setPointerCapture.
   Заменяет bindSelection + bindChords + bindDraw (их в init() больше не зовём).
   Один дескриптор жеста GEST; жест выбирается ОДИН раз в pointerdown и
   держится захватом указателя — никаких window-listeners и гонок.
   Диспетчеризация детерминирована: сперва активный инструмент (кисть/стёрка)
   на чистом ЛКМ, иначе — кнопка+модификатор. Семантику жестов НЕ меняем
   (тот же вокабуляр, что был) — лечим только проводку, не математику.
   Операционные функции (gatherSelection, panStart, panMove, xZoom, yZoom,
   drawPoint, finishDraw, erase, zb, chord) переиспользованы как есть.
   ==================================================================== */
let GEST = null;   // {kind: 'select'|'pan'|'zoombox'|'draw'|'erase'}
function bindInput() {
  const dom = document.getElementById("chart");
  ensureSelBand();
  dom.addEventListener("contextmenu", (e) => e.preventDefault());
  // ВАЖНО: colесо ловим в фазе ЗАХВАТА (capture) — раньше любых обработчиков canvas,
  // чтобы наш зум срабатывал гарантированно и ничто его не «съедало».
  dom.addEventListener("wheel", onWheel, { passive: false, capture: true });
  dom.addEventListener("dblclick", (e) => {
    if (editDragOn()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // Ctrl/Alt зажаты — НЕ сбрасывать зум (рисование/стёрка/панорама)
    e.preventDefault(); resetZoom();
  });

  dom.addEventListener("pointerdown", (e) => {
    // Линейка месторождение/скважина (#ruler) лежит ПОВЕРХ графика внутри #chart.
    // Её ячейки/метки/разделители имеют свои обработчики (клик-правка, drag границы).
    // Не перехватываем такие события жестами графика — иначе preventDefault/захват
    // «съедает» click, и правка через линейку не срабатывала (баг #5).
    if (e.target && e.target.closest && e.target.closest("#ruler")) return;
    // Координаты берём ОТ rect графика — ТОТ ЖЕ базис, что и в pointermove.
    // Раньше был e.offsetX (относительно цели события): при захвате давал скачок на константу.
    const r = dom.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const ctrl = e.ctrlKey || e.metaKey, alt = e.altKey, shift = e.shiftKey;

    // Нижняя полоса (ось X + линейка-слайдер) — НЕ перехватываем: отдаём ECharts,
    // чтобы слайдер (линейка) таскался мышью. Наши жесты — только внутри плоттера.
    // (H>0 — страховка: при невидимом графике getHeight()=0, тогда гейт не применяем.)
    const H = chart.getHeight();
    if (H > 0 && py > H - GRID_BOTTOM + 6) return;
    if (LAST_GRID && px < LAST_GRID.left) return;  // левый карман (линейки) — не перехватываем

    if (e.button === 0) {                                              // ==== ЛКМ ====
      // Shift — рамка-зум (box-zoom): тянем прямоугольник, отпускаем — вписываем.
      if (shift && !ctrl && !alt) {
        GEST = { kind: "zoombox" }; zbStart(dom, px, py);
        _capture(dom, e); e.preventDefault(); return;
      }
      // Ctrl — кисть (рисуем, пока держим); Alt — стёрка; иначе панорама графика.
      if (ctrl && !alt) {
        GEST = { kind: "draw", noSpo: true };                         // чистая кисть без СПО-жеста (СПО — по Shift)
        DRAW.drawing = true; DRAW.noSpo = true; DRAW.pts = [[px, py]];
        _capture(dom, e); e.preventDefault(); return;
      }
      if (alt && !ctrl) {
        GEST = { kind: "erase" }; eraseStart(px, py);
        _capture(dom, e); e.preventDefault(); return;
      }
      // инструменты из тулбара (✎/⌫) — сохраняем прежнее поведение при включённом режиме
      if (editDragOn()) {
        if (typeof ERASE !== "undefined" && ERASE.active) { GEST = { kind: "erase" }; eraseStart(px, py); }
        else if (DRAW.active) { GEST = { kind: "draw" }; DRAW.drawing = true; DRAW.noSpo = false; DRAW.pts = [[px, py]]; }
        _capture(dom, e); e.preventDefault(); return;
      }
      // чистый ЛКМ — ПЕРЕМЕЩЕНИЕ графика (влево/вправо)
      GEST = { kind: "pan" }; panStart(px, py); _capture(dom, e); e.preventDefault();
    } else if (e.button === 2) {                                       // ==== ПКМ ====
      e.preventDefault();
      if (ctrl) { chordDeletePoint(px, alt, shift); return; }          // Ctrl+ПКМ — обнулить точку
      // ПКМ — ВЫДЕЛЕНИЕ интервала; с Shift — после выделения строим фигуру (СПО/райбер)
      GEST = { kind: "select", figure: shift };
      selDown = true; selMoved = false; selX0 = px; selX1 = px;
      const band = ensureSelBand();
      band.style.display = ""; band.style.left = selX0 + "px"; band.style.width = "0px";
      _capture(dom, e);
    } else if (e.button === 1) {                                       // средняя — сброс
      e.preventDefault(); resetZoom();
    }
  });

  dom.addEventListener("pointermove", (e) => {
    if (!GEST) return;
    const rect = dom.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    switch (GEST.kind) {
      case "erase":  eraseMove(px, py); break;
      case "draw":   if (DRAW.drawing) DRAW.pts.push([px, py]); break;
      case "zoombox": if (ZB) { ZB.x1 = px; ZB.y1 = py; zbDraw(); } break;
      case "pan":    panMove(px, py); break;
      case "select": {
        selX1 = px;
        if (Math.abs(selX1 - selX0) > 3) selMoved = true;
        const band = ensureSelBand();
        band.style.left = Math.min(selX0, selX1) + "px";
        band.style.width = Math.abs(selX1 - selX0) + "px";
        break;
      }
    }
  });

  const endGesture = () => {
    if (!GEST) return;
    const kind = GEST.kind, figure = GEST.figure; GEST = null;
    if (kind === "erase") { eraseFinish(); return; }
    if (kind === "draw")  { if (DRAW.drawing) { DRAW.drawing = false; finishDraw(); } return; }
    if (kind === "zoombox") { zbApply(); return; }
    if (kind === "pan")   { const dom = document.getElementById("chart"); if (dom) dom.style.cursor = "grab"; if (PAN && !PAN.moved && SEL) clearSelection(); PAN = null; return; }
    if (kind === "select") {
      selDown = false;
      if (!selMoved) {                                                 // клик без драга — одна точка
        let t = px2time(selX0);
        if (Number.isFinite(t)) {
          t = Math.round(t / 1000) * 1000;                             // привязка к такту регистратора (1 Гц)
          const idx = nearestIdx(t);
          const s = gatherSelection(SERIES.ts[idx], SERIES.ts[idx]);
          // ВАЖНО: якорь = ровно секунда под курсором, а НЕ ближайшая записанная точка.
          // Из-за событийного сжатия «тихая» секунда (вес не менялся) строки не имеет,
          // nearestIdx снапит её к точке след. изменения — раньше вставка прыгала туда.
          if (s) { s.point = true; s.t0 = s.t1 = t; SEL = s; SEL_TAGS = defaultSelTags(); positionSelBand(); renderContext(); applySelHighlight(); }
        } else if (selBandEl) { selBandEl.style.display = "none"; }
        return;
      }
      const t0 = px2time(Math.min(selX0, selX1));                      // драг — интервал
      const t1 = px2time(Math.max(selX0, selX1));
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) { clearSelection(); return; }
      let s = gatherSelection(t0, t1);
      if (s) { s.t0 = Math.min(t0, t1); s.t1 = Math.max(t0, t1); } // полоса ровно по драгу (без прыжка к точкам)
      else s = virtualSelection(t0, t1);                            // пустое окно (разрыв) — виртуальное выделение
      if (!s) { clearSelection(); return; }
      SEL = s; SEL_TAGS = defaultSelTags();
      positionSelBand(); renderContext(); applySelHighlight();
      if (SEL.virtual && !figure)
        addNote("status", "Пустой интервал " + fmtTime(SEL.t0) + "–" + fmtTime(SEL.t1) +
          " выделен. Вставьте (Ctrl+V) или постройте фигуру — строки создадутся автоматически.");
      if (figure) {                                                    // Shift+ПКМ — построить фигуру
        const wasV = SEL.virtual;
        const r = ensureRows(SEL);
        if (r && r.i1 > r.i0) {
          if (wasV) histPush("Участок в разрыве " + fmtTime(SEL.t0) + "–" + fmtTime(SEL.t1));
          positionSelBand(); renderContext();
          figureFromInterval(r.i0, r.i1);
        } else if (wasV) addNote("note", "Разрыв слишком узкий для фигуры.");
      }
    }
  };
  dom.addEventListener("pointerup", endGesture);
  dom.addEventListener("pointercancel", endGesture);

  // клик по пустому месту графика — снять выделение (ZRender-слой)
  chart.getZr().on("click", (e) => {
    // клик по линейке (левый карман) — фокус на соответствующем канале (переключатель)
    if (LAST_GRID && e.offsetX < LAST_GRID.left && ACTIVE_AXES.length) {
      const bandFromRight = Math.floor((LAST_GRID.left - e.offsetX) / AXIS_W);
      const c = ACTIVE_AXES[ACTIVE_AXES.length - 1 - bandFromRight];
      if (c) { FOCUS_KEY = (FOCUS_KEY === c.key) ? null : c.key; renderChart(); return; }
    }
    if (!e.target && SEL) clearSelection();
  });
}
function _capture(dom, e) { try { dom.setPointerCapture(e.pointerId); } catch (_) {} }

/* ====================================================================
   РУЧНОЕ РЕДАКТИРОВАНИЕ: история (undo/redo), шум, copy/paste/delete,
   точечное выделение. Все мутации SERIES.data проходят через histPush().
   ==================================================================== */
let SUPPRESS_EDIT = false;            // глушим onCellValueChanged при программном обновлении
let HIST = { stack: [], idx: -1 };
const HIST_MAX = 60;
let CLIP = null;                      // буфер копирования {keys,len,data}
// «Несохранённые правки»: SAVED_HIST_IDX — HIST.idx на момент последнего ПОЛНОГО
// сохранения в .asc3 (все открытые сутки). Пока HIST.idx !== SAVED_HIST_IDX —
// в файле на диске НЕ то, что видно на экране (баг живого теста 2026-07-09:
// правки суток 27.02 потерялись, т.к. «Сохранить» нажали только один раз, ДО
// этих правок, и это осталось незаметным — индикатора не было). Актуально и
// для undo/redo: они двигают HIST.idx, а не создают новых записей, поэтому
// сравнение с SAVED_HIST_IDX остаётся верным и после отмены/повтора.
let SAVED_HIST_IDX = 0;
function isDirty() { return HIST.idx !== SAVED_HIST_IDX; }

function cloneData() { const o = {}; for (const k in SERIES.data) o[k] = SERIES.data[k].slice(); return o; }
// Полный снимок состояния: значения каналов + ts + карта происхождения строк.
// ts/rowSrc нужны для корректного undo вставки/удаления строк (Решение Б).
function snapState() { return { data: cloneData(), ts: SERIES.ts.slice(), rowSrc: ROW_SRC.slice() }; }
function histReset() {
  HIST = { stack: [Object.assign({ label: "Загрузка данных" }, snapState())], idx: 0 };
  SAVED_HIST_IDX = 0;   // свежезагруженный файл = «чисто», нечего сохранять
  AUTOSAVE_LAST_IDX = 0; if (AUTOSAVE_TIMER) { clearTimeout(AUTOSAVE_TIMER); AUTOSAVE_TIMER = null; }
  renderHistUI();
}
function histPush(label) {
  if (HIST.idx < HIST.stack.length - 1) HIST.stack = HIST.stack.slice(0, HIST.idx + 1);
  HIST.stack.push(Object.assign({ label }, snapState()));
  if (HIST.stack.length > HIST_MAX) {
    HIST.stack.shift();
    // #A19 (18.08.2026, аудит): shift() сдвигает ВСЕ индексы стека на -1, а
    // SAVED_HIST_IDX/AUTOSAVE_LAST_IDX раньше оставались на месте и после
    // HIST_MAX=60 правок начинали указывать на ЧУЖИЕ записи. Итог: isDirty()
    // врал в обе стороны — индикатор «сохранено» на несохранённом файле и
    // молчащий автосейв. Уходим в -1 сознательно: запись, на которую они
    // ссылались, из стека выпала, доказать «это уже сохранено» больше нечем,
    // а -1 не равен ни одному живому HIST.idx (>=0) — значит «грязно».
    // Консервативно в нужную сторону: лишний автосейв дешевле потерянных правок.
    SAVED_HIST_IDX--;
    AUTOSAVE_LAST_IDX--;
  }
  HIST.idx = HIST.stack.length - 1;
  renderHistUI();
  scheduleAutosave();
}

/* ---------- A.2: автосохранение черновика + восстановление после сбоя ----------
   Черновик — JSON рядом с открытым .asc3 (не байт-точный .asc3, это только 💾).
   Триггеры записи: (1) через AUTOSAVE_DEBOUNCE мс тишины после правки — не пишем
   на КАЖДЫЙ histPush при быстрой серии правок; (2) страховка — раз в
   AUTOSAVE_INTERVAL мс, если правки продолжаются непрерывно и debounce всё время
   откладывается. Не мешает работе: ошибки автосейва тихие (addNote не дёргаем). */
const AUTOSAVE_DEBOUNCE = 4000, AUTOSAVE_INTERVAL = 20000;
let AUTOSAVE_TIMER = null, AUTOSAVE_LAST_IDX = 0, AUTOSAVE_INFLIGHT = false;
function scheduleAutosave() {
  if (AUTOSAVE_TIMER) clearTimeout(AUTOSAVE_TIMER);
  AUTOSAVE_TIMER = setTimeout(doAutosave, AUTOSAVE_DEBOUNCE);
}
setInterval(() => { if (isDirty() && HIST.idx !== AUTOSAVE_LAST_IDX) doAutosave(); }, AUTOSAVE_INTERVAL);
async function doAutosave() {
  if (AUTOSAVE_TIMER) { clearTimeout(AUTOSAVE_TIMER); AUTOSAVE_TIMER = null; }
  if (AUTOSAVE_INFLIGHT || !isDirty() || HIST.idx === AUTOSAVE_LAST_IDX || !OPENED_NAME) return;
  const idxAtSave = HIST.idx;
  const payload = {
    channels: CHANNELS.map((c) => ({ name: c.name, values: SERIES.data[c.key] })),
    label: (HIST.stack[HIST.idx] || {}).label || "",
  };
  if (!rowSrcIsIdentity()) {
    payload.row_src = ROW_SRC; payload.row_ts = SERIES.ts;
    const rdays = rowDaysByTime(); if (rdays) payload.row_days = rdays;
  }
  AUTOSAVE_INFLIGHT = true;
  try {
    const r = await fetch("/api/autosave", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j && j.ok) AUTOSAVE_LAST_IDX = idxAtSave;
  } catch (e) { /* автосейв не должен мешать работе — тихо пропускаем */ }
  AUTOSAVE_INFLIGHT = false;
}
function discardAutosave() {
  fetch("/api/autosave/discard", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .catch(() => {});
}
// применить черновик автосохранения (после подтверждения пользователем).
// Формат совпадает с payload /api/export: channels[+row_src/row_ts/row_days].
function applyAutosaveDraft(draft) {
  if (!draft || !Array.isArray(draft.channels)) return false;
  const data = {}; let matched = 0;
  draft.channels.forEach((col) => {
    const c = CHANNELS.find((x) => x.name === col.name);
    if (c && Array.isArray(col.values)) { data[c.key] = col.values; matched++; }
  });
  if (!matched) return false;
  const structural = Array.isArray(draft.row_src) && Array.isArray(draft.row_ts);
  if (!structural) {
    for (const k in data) {
      if (data[k].length !== N) return false;   // длина не совпала — не применяем частично
    }
  }
  for (const k in data) SERIES.data[k] = data[k].slice();
  if (structural) {
    SERIES.ts = draft.row_ts.slice();
    ROW_SRC = draft.row_src.slice();
    N = SERIES.ts.length;
  }
  clearSelection();
  renderChart();
  if (structural) rebuildGrid(); else refreshGrid();
  histPush("Восстановлено из автосохранения" + (draft.saved_at ? " (" + draft.saved_at + ")" : ""));
  return true;
}
async function maybeOfferAutosaveRestore(info) {
  if (!info || !info.available) return;
  const when = info.saved_at || "неизвестное время";
  const ok = confirm(
    "Найден черновик несохранённых правок от " + when +
    (info.label ? " («" + info.label + "»)" : "") +
    " — вероятно, приложение закрылось до сохранения. Восстановить черновик поверх открытого файла?");
  if (!ok) { discardAutosave(); return; }
  try {
    const r = await fetch("/api/autosave/data");
    const j = await r.json();
    if (!j || !j.ok) { addNote("note", "Черновик не удалось прочитать: " + (j && j.error ? j.error : r.status)); return; }
    if (applyAutosaveDraft(j.draft)) {
      addNote("status", "Черновик восстановлен — проверьте правки и сохраните (💾), если всё верно.");
    } else {
      addNote("note", "Черновик не подходит к открытому файлу (изменилось число строк) — восстановление отменено.");
    }
  } catch (e) {
    addNote("note", "Не удалось восстановить черновик: " + e);
  }
}
function histRestore(i) {
  if (i < 0 || i >= HIST.stack.length) return;
  HIST.idx = i;
  const snap = HIST.stack[i];
  const structural = snap.ts && snap.ts.length !== N;   // изменилось число строк
  for (const k in snap.data) if (SERIES.data[k]) SERIES.data[k] = snap.data[k].slice();
  if (snap.ts) SERIES.ts = snap.ts.slice();
  if (snap.rowSrc) ROW_SRC = snap.rowSrc.slice();
  if (snap.ts) N = snap.ts.length;
  // #B20: выделение обязано умирать вместе с откатом — иначе следующая операция
  // («Сгладить») бьёт по устаревшим индексам строк и «возвращает» отменённое.
  clearSelection();
  renderChart();
  if (structural) rebuildGrid(); else refreshGrid();
  renderHistUI();
}
function undo() { if (HIST.idx > 0) { histRestore(HIST.idx - 1); addNote("status", "Отменено → «" + HIST.stack[HIST.idx].label + "»."); } }
function redo() { if (HIST.idx < HIST.stack.length - 1) { histRestore(HIST.idx + 1); addNote("status", "Возвращено → «" + HIST.stack[HIST.idx].label + "»."); } }

// визуальный индикатор «есть несохранённые правки»: точка на кнопке 💾 +
// префикс в заголовке вкладки (заметно, даже если вкладка не активна).
function updateDirtyUI() {
  const dirty = isDirty();
  const sb = document.getElementById("btn-save");
  if (sb) {
    sb.classList.toggle("dirty", dirty);
    sb.title = dirty
      ? "Сохранить (перезаписать открытый файл) — ЕСТЬ несохранённые правки"
      : "Сохранить (перезаписать открытый файл)";
  }
  // #v94: в шапке — имя открытого файла (а не «ГТИ/СПО»); дефолт, пока не открыт
  // KE_DEFAULT_TITLE задаёт страница-обёртка (демо сайта: «КартЭдит — ДЕМО»)
  const base = OPENED_NAME ? OPENED_NAME : (window.KE_DEFAULT_TITLE || "КартЭдит — ГТИ / СПО");
  const tb = document.querySelector(".tb-title");
  if (tb) tb.textContent = (dirty ? "● " : "") + base;
  document.title = dirty ? "● " + base : base;
  // Ф4: имя файла КРУПНО над графиком (пусто, пока файл не открыт)
  const ft = document.getElementById("file-title");
  if (ft) {
    ft.textContent = OPENED_NAME ? (dirty ? "● " : "") + OPENED_NAME : "";
    ft.classList.toggle("dirty", dirty);
    ft.title = OPENED_NAME ? "Открыт: " + OPENED_NAME : "Имя открытого .asc3";
  }
}
function renderHistUI() {
  const u = document.getElementById("btn-undo"), r = document.getElementById("btn-redo");
  if (u) u.style.opacity = HIST.idx > 0 ? 1 : 0.35;
  if (r) r.style.opacity = HIST.idx < HIST.stack.length - 1 ? 1 : 0.35;
  updateDirtyUI();
  const m = document.getElementById("hist-menu");
  if (!m) return;
  m.innerHTML = "";
  for (let i = HIST.stack.length - 1; i >= 0; i--) {
    const it = document.createElement("div");
    it.className = "ctx-item" + (i === HIST.idx ? " cur" : "");
    it.textContent = (i === HIST.idx ? "● " : "    ") + HIST.stack[i].label;
    it.onclick = () => { m.style.display = "none"; histRestore(i); };
    m.appendChild(it);
  }
}

// синхронизировать таблицу с SERIES без записи в историю.
// ВАЖНО: прямая мутация node.data + один refreshCells вместо setDataValue
// на каждую ячейку (иначе 25k×14 событий вешают страницу). refreshCells
// перерисовывает только видимые ячейки — мгновенно.
function refreshGrid() {
  if (!GRID_API) return;
  GRID_API.forEachNode((node) => {
    const idx = node.data.__idx;   // точный индекс строки, время не уникально
    if (idx == null) return;
    for (const c of CHANNELS) node.data[c.name] = SERIES.data[c.key][idx];
  });
  GRID_API.refreshCells({ force: true });
}

// Полная пересборка строк таблицы (после вставки/удаления — число строк изменилось).
// Пересобираем rowData (вместе с __idx) и отдаём в AG Grid одним setGridOption.
function rebuildGrid() {
  if (!GRID_API) return;
  const rowData = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = fmtTime(SERIES.ts[i]);
    const row = { "Время": t, __idx: i };
    CHANNELS.forEach((c) => (row[c.name] = SERIES.data[c.key][i]));
    rowData[i] = row;
  }
  GRID_API.setGridOption("rowData", rowData);
}

/* ---------- Решение Б: вставка / удаление строк (блоков TLV) ----------
   Меняют число строк. ROW_SRC ведёт происхождение: исходные строки несут свой
   индекс, вставленные — -1. Экспорт при не-identity ROW_SRC уходит в rebuild_asc3
   (бэкенд клонирует метаданные соседа и пересчитывает ts вставок).
   ts на фронте — для отображения; бэкенд пересчитывает ts вставок сам. */
function insertRowAt(i) {
  i = Math.max(0, Math.min(N, i | 0));
  // ts вставки = середина между соседями (или шаг 1 с на краях)
  const prev = i > 0 ? SERIES.ts[i - 1] : null;
  const next = i < N ? SERIES.ts[i] : null;
  let t;
  if (prev != null && next != null) t = Math.round((prev + next) / 2);
  else if (prev != null) t = prev + 1000;
  else if (next != null) t = next - 1000;
  else t = MOCK_BASE;
  SERIES.ts.splice(i, 0, t);
  // значения — копия соседа (i-1, иначе i) как стартовая точка
  const srcRow = i > 0 ? i - 1 : i;     // индекс в СТАРОМ массиве
  CHANNELS.forEach((c) => {
    const arr = SERIES.data[c.key];
    arr.splice(i, 0, arr[srcRow] != null ? arr[srcRow] : null);
  });
  ROW_SRC.splice(i, 0, -1);
  N += 1;
  rebuildGrid(); renderChart();
  histPush("Вставка строки @ " + fmtTime(t));
  addNote("status", "Вставлена строка на позицию " + (i + 1) + " (" + fmtTime(t) +
    "). Значения скопированы у соседа; при экспорте бэкенд пересчитает время.");
}
function deleteRowsRange(i0, i1) {
  i0 = Math.max(0, i0 | 0); i1 = Math.min(N - 1, i1 | 0);
  if (i1 < i0) return;
  const cnt = i1 - i0 + 1;
  if (cnt >= N) { addNote("note", "Нельзя удалить все строки — должна остаться хотя бы одна."); return; }
  SERIES.ts.splice(i0, cnt);
  CHANNELS.forEach((c) => SERIES.data[c.key].splice(i0, cnt));
  ROW_SRC.splice(i0, cnt);
  N -= cnt;
  rebuildGrid(); renderChart();
  histPush("Удаление строк " + (i0 + 1) + "–" + (i1 + 1));
  addNote("status", "Удалено строк: " + cnt + ". Осталось " + N + ".");
}
// Вставка/удаление по текущему выделению (или по подсвеченной строке таблицы).
function insertRowAtSel() {
  const i = SEL ? SEL.i0 : (lastGridRow() != null ? lastGridRow() : N);
  insertRowAt(i);
}
function deleteSelRows() {
  if (SEL) { deleteRowsRange(SEL.i0, SEL.i1); clearSelection && clearSelection(); return; }
  const i = lastGridRow();
  if (i != null) deleteRowsRange(i, i);
  else addNote("note", "Выделите строки на графике (Shift+ЛКМ) или строку в таблице.");
}
function lastGridRow() {
  if (!GRID_API) return null;
  const sel = GRID_API.getSelectedNodes();
  if (sel && sel.length) {
    let mn = Infinity;
    sel.forEach((nd) => { const ix = nd.data.__idx; if (ix != null && ix < mn) mn = ix; });
    if (mn !== Infinity) return mn;
  }
  return null;
}

/* ---------- шум (ручное зашумление картограммы) ----------
   Шумовое поле строится ОДИН раз при открытии (фиксированная сглаженная
   форма на [-1..1] по каждому каналу). Ползунок лишь масштабирует это поле,
   поэтому шум «нарастает» плавно, без перерисовки случайностей на каждый тик.
   Сглаживание (скользящее среднее) даёт спокойную картограмму, а не «зерно». */
let NOISE = { base: null, field: null, active: false };
function smoothField(len) {
  // ПОМЕХИ, а не «козявки»: мелкое высокочастотное дрожание прибора.
  // Гаусс-подобное зерно (сумма двух random -> ближе к нормальному),
  // лёгкое сглаживание окном 2 (убрать одиночные пики, оставить дрожь),
  // строгая центровка на ноль -> шум не сдвигает базовую линию.
  let a = new Float64Array(len);
  for (let i = 0; i < len; i++) a[i] = (Math.random() + Math.random() - 1); // ~[-1..1], пик у нуля
  const b = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const p = i > 0 ? a[i - 1] : a[i];
    b[i] = (p + a[i]) * 0.5;
  }
  a = b;
  // центровка: среднее -> 0 (нулевое смещение), нормировка амплитуды
  let sum = 0; for (const x of a) sum += x;
  const mean = sum / (len || 1);
  let mx = 1e-9;
  for (let i = 0; i < len; i++) { a[i] -= mean; const ax = Math.abs(a[i]); if (ax > mx) mx = ax; }
  for (let i = 0; i < len; i++) a[i] /= mx; // [-1..1], нулевое среднее
  return a;
}
function noiseOpen() {
  NOISE.base = cloneData(); NOISE.active = true; NOISE.field = {};
  CHANNELS.forEach((c) => { NOISE.field[c.key] = smoothField((NOISE.base[c.key] || []).length); });
  const r = document.getElementById("noise-range"); if (r) r.value = 0;
  const v = document.getElementById("noise-val"); if (v) v.textContent = "0%";
}
function noiseApply(amp) {
  if (!NOISE.base || !NOISE.field) return;
  CHANNELS.forEach((c) => {
    const base = NOISE.base[c.key], fld = NOISE.field[c.key], out = SERIES.data[c.key];
    if (!base || !fld) return;
    let mn = Infinity, mx = -Infinity;
    for (const x of base) { if (x == null) continue; if (x < mn) mn = x; if (x > mx) mx = x; }
    const span = mx > mn ? mx - mn : 1;
    // мелкая помеха: небольшая доля диапазона, БЕЗ нарастающей огибающей
    // (равномерно по всей картограмме) — форма сигнала не искажается.
    const sigma = span * (amp / 100) * 0.08;
    const len = base.length;
    for (let i = 0; i < len; i++) {
      const b = base[i];
      out[i] = b == null ? null : +(b + fld[i] * sigma).toFixed(2);
    }
  });
  renderChart();
}
function noiseCommit() {
  if (!NOISE.active) return;
  const val = +(document.getElementById("noise-range") || {}).value || 0;
  if (val > 0) { histPush("Шум ±" + val + "%"); refreshGrid(); addNote("note", "Добавлен случайный шум ±" + val + "% по всем каналам."); }
  NOISE.active = false; NOISE.base = null; NOISE.field = null;
}

/* ---------- copy / paste / delete (диапазон или точка) ---------- */
function selKeys() { return SEL_TAGS.length ? SEL_TAGS.slice() : ACTIVE_AXES.map((c) => c.key); }
function doCopy() {
  if (!SEL) return;
  const i0 = SEL.i0, i1 = SEL.point ? SEL.i0 : SEL.i1;
  if (i1 < i0) return;
  const keys = selKeys(), data = {};
  const base = SERIES.ts[i0];
  const dt = new Array(i1 - i0 + 1);
  for (let i = i0; i <= i1; i++) dt[i - i0] = SERIES.ts[i] - base;   // смещение точки по времени от начала копии
  keys.forEach((k) => { if (SERIES.data[k]) data[k] = SERIES.data[k].slice(i0, i1 + 1); });
  CLIP = { keys, len: i1 - i0 + 1, dt, data };
  learnAction("copy");
  addNote("status", "Скопировано: " + keys.length + " канал(ов) × " + CLIP.len + " точек.");
  renderContext();   // активировать кнопку «Вставить»
}
// Ближайшая существующая строка по времени (бинпоиск). -1 если строк нет.
function nearestIdxTime(t) {
  const a = SERIES.ts; if (!a || !a.length) return -1;
  let i = tsIndex(t);
  if (i > 0 && Math.abs(a[i - 1] - t) <= Math.abs(a[i] - t)) i--;
  return i;
}
// Вставка = ЗАМЕНА окна приёмника скопированным участком «точь-в-точь».
// Якорь = начало текущего выделения/точки (куда щёлкнул). Копия переносится своей
// сеткой времени (якорь + смещение каждой точки от начала копии) -> форма и тайминг
// сохраняются. Старые строки в окне [якорь .. якорь+длительность] УДАЛЯЮТСЯ (не растёт
// число точек, старые данные не остаются). Копируемые каналы берут значения из буфера;
// прочие каналы переносятся ближайшей реальной точкой (кривая сохраняется, без фабрикации).
function doPaste() {
  if (!SEL || !CLIP || !CLIP.dt) return;
  let anchor = Number.isFinite(SEL.t0) ? SEL.t0 : SERIES.ts[SEL.i0];
  if (!Number.isFinite(anchor)) return;
  anchor = Math.round(anchor / 1000) * 1000;   // Ф6: снап к целой секунде (сетка файла — секунды; иначе дубли/«полусекунды»)
  const n = CLIP.len; if (n <= 0) return;
  const span = CLIP.dt[n - 1] || 0;
  const winA = anchor, winB = anchor + span;          // окно замены
  const copied = Object.create(null); CLIP.keys.forEach((k) => (copied[k] = true));

  // 1) времена новых строк = сетка источника у якоря
  const newTs = new Array(n);
  for (let j = 0; j < n; j++) newTs[j] = anchor + CLIP.dt[j];
  // 2) ближайшая старая строка для каждого нового времени (для переноса прочих каналов)
  const nn = new Array(n);
  for (let j = 0; j < n; j++) nn[j] = nearestIdxTime(newTs[j]);
  // 3) значения новых строк по каналам
  const newData = {};
  for (const k in SERIES.data) {
    const arr = SERIES.data[k]; if (!arr) continue;
    const col = new Array(n);
    if (copied[k]) for (let j = 0; j < n; j++) col[j] = CLIP.data[k] ? CLIP.data[k][j] : null;
    else           for (let j = 0; j < n; j++) col[j] = nn[j] >= 0 ? arr[nn[j]] : null;
    newData[k] = col;
  }

  // 4) старые строки ВНЕ окна остаются; строки в [winA..winB] выкидываем
  const oldTs = SERIES.ts, oldSrc = ROW_SRC;
  const keep = [];
  for (let i = 0; i < N; i++) { const t = oldTs[i]; if (t < winA || t > winB) keep.push(i); }
  // 5) слияние оставшихся строк с новыми по времени
  const total = keep.length + n;
  const mTs = new Array(total), src = new Array(total), isNew = new Array(total);
  let a = 0, b = 0, m = 0;
  while (a < keep.length || b < n) {
    const ta = a < keep.length ? oldTs[keep[a]] : Infinity;
    const tb = b < n ? newTs[b] : Infinity;
    if (ta === tb) { a++; continue; }                 // Ф6: дубль времени — старую строку выкидываем (новая заменяет)
    if (ta < tb) { mTs[m] = ta; src[m] = keep[a]; isNew[m] = false; a++; }
    else         { mTs[m] = tb; src[m] = b;       isNew[m] = true;  b++; }
    m++;
  }
  const cnt = m;                                     // Ф6: после дедупа строк может быть меньше total
  // 6) собрать каналы и происхождение строк
  for (const k in SERIES.data) {
    const arr = SERIES.data[k]; if (!arr) continue;
    const na = new Array(cnt);
    for (let i = 0; i < cnt; i++) na[i] = isNew[i] ? newData[k][src[i]] : arr[src[i]];
    SERIES.data[k] = na;
  }
  const nsrc = new Array(cnt);
  for (let i = 0; i < cnt; i++) nsrc[i] = isNew[i] ? -1 : (oldSrc ? oldSrc[src[i]] : src[i]);
  SERIES.ts = mTs.slice(0, cnt); ROW_SRC = nsrc; N = cnt;
  rebuildGrid();

  // 7) выделение на вставленный участок
  const gi0 = tsIndex(newTs[0]);
  SEL = { t0: newTs[0], t1: newTs[n - 1], i0: gi0, i1: gi0 + n - 1, stats: {} };
  learnAction("paste");
  histPush("Вставка " + CLIP.keys.length + "к×" + n + " (замена окна)");
  renderChart(); refreshGrid(); positionSelBand(); renderContext(); applySelHighlight();
  addNote("note", "Вставлено с " + fmtTime(anchor) + " — " + n + " точек, окно заменено.");
}
function doDelete() {
  if (!SEL) return;
  if (SEL.virtual) { addNote("note", "Пустой интервал — нечего удалять (строк ещё нет)."); return; }
  const keys = selKeys();
  keys.forEach((k) => { if (SERIES.data[k]) for (let i = SEL.i0; i <= SEL.i1; i++) SERIES.data[k][i] = null; });
  learnAction("zero");
  histPush("Очистка «х» " + keys.length + "к");
  renderChart(); refreshGrid();
  addNote("note", "Очищено в «х» " + keys.length + " канал(ов) в выделении.");
}

// Схема управления: Del ОБНУЛЯЕТ (=0, датчик в покое), Alt+Del/Backspace очищает
// в «х» (null, «нет датчика») — как в привычных таблицах значений.
function doZero() {
  if (!SEL) return;
  if (SEL.virtual) { addNote("note", "Пустой интервал — нечего обнулять (строк ещё нет)."); return; }
  const keys = selKeys();
  keys.forEach((k) => { if (SERIES.data[k]) for (let i = SEL.i0; i <= SEL.i1; i++) SERIES.data[k][i] = 0; });
  learnAction("zero");
  histPush("Обнуление " + keys.length + "к");
  renderChart(); refreshGrid();
  addNote("note", "Обнулено (=0) " + keys.length + " канал(ов) в выделении.");
}

/* ---------- новые операции над выделением (для подсказок Части B) ----------
   Сглаживание и заполнение разрывов. Применяются к диапазону SEL.i0..i1 по
   выбранным каналам selKeys(). Число строк НЕ меняется -> экспорт безопасен. */
function doSmooth() {
  if (!SEL) { addNote("note", "Сначала выделите диапазон на графике (тяните ЛКМ)."); return; }
  const keys = selKeys(), W = 5, half = (W - 1) >> 1; let cnt = 0;
  keys.forEach((k) => {
    const arr = SERIES.data[k]; if (!arr) return;
    const src = arr.slice(SEL.i0, SEL.i1 + 1);   // копия, чтобы сглаживание не каскадировало
    for (let i = SEL.i0; i <= SEL.i1; i++) {
      if (arr[i] == null) continue;              // разрыв «х» не трогаем
      let sum = 0, c = 0;
      for (let j = -half; j <= half; j++) {
        const p = i - SEL.i0 + j;
        if (p < 0 || p >= src.length) continue;
        const v = src[p]; if (v == null) continue;
        sum += v; c++;
      }
      if (c) { arr[i] = +(sum / c).toFixed(2); cnt++; }
    }
  });
  if (!cnt) { addNote("note", "Нет значений для сглаживания в выделении."); return; }
  learnAction("smooth");
  histPush("Сглаживание (" + keys.length + "к)");
  renderChart(); refreshGrid();
  addNote("note", "Сглажено " + cnt + " значений (окно " + W + ") в " + keys.length + " канале(ах).");
}
function doFillGaps() {
  if (!SEL) { addNote("note", "Сначала выделите диапазон на графике (тяните ЛКМ)."); return; }
  const keys = selKeys(); let filled = 0;
  keys.forEach((k) => {
    const arr = SERIES.data[k]; if (!arr) return;
    const a = SEL.i0, b = SEL.i1;
    let i = a;
    while (i <= b) {
      if (arr[i] != null) { i++; continue; }
      const s = i; while (i <= b && arr[i] == null) i++;
      const e = i - 1;                            // пробел [s..e]
      const left = s > 0 ? arr[s - 1] : null;     // опора слева (можно вне выделения)
      const right = e < N - 1 ? arr[e + 1] : null;// опора справа
      if (left != null && right != null) {
        const span = e - s + 2;
        for (let j = s; j <= e; j++) { const t = (j - s + 1) / span; arr[j] = +(left + (right - left) * t).toFixed(2); filled++; }
      } else if (left != null) {
        for (let j = s; j <= e; j++) { arr[j] = +left.toFixed(2); filled++; }
      } else if (right != null) {
        for (let j = s; j <= e; j++) { arr[j] = +right.toFixed(2); filled++; }
      }
    }
  });
  if (!filled) { addNote("note", "В выделении нет разрывов для заполнения."); return; }
  learnAction("fill");
  histPush("Заполнение разрывов (" + keys.length + "к)");
  renderChart(); refreshGrid();
  addNote("note", "Заполнено " + filled + " разрывов в " + keys.length + " канале(ах).");
}

/* ====================================================================
   ФАЗА 2, Часть B: ОБУЧАЮЩИЕСЯ ПОДСКАЗКИ ЧАСТЫХ ДЕЙСТВИЙ
   Реестр быстрых действий над выделением. Частота применения копится в
   localStorage и переупорядочивает бар «Частые:» — чаще используешь = левее.
   learnAction() вызывается из самих операций, поэтому учатся ВСЕ пути вызова
   (бар, явные кнопки, хоткеи). Полностью офлайн, без сервера.
   ==================================================================== */
const ACT_STATS_KEY = "asc_act_stats_v1";
let ACT_STATS = loadActStats();
function loadActStats() { try { return JSON.parse(localStorage.getItem(ACT_STATS_KEY)) || {}; } catch (e) { return {}; } }
function saveActStats() { try { localStorage.setItem(ACT_STATS_KEY, JSON.stringify(ACT_STATS)); } catch (e) {} }
function learnAction(id) {
  if (!id) return;
  ACT_STATS[id] = (ACT_STATS[id] || 0) + 1;
  saveActStats();
  if (document.getElementById("sel-quick")) renderQuickActions();  // переупорядочить бар
}
const QUICK_ACTIONS = [
  { id: "smooth", label: "〜 Сгладить", title: "Скользящее среднее по выделению", run: doSmooth },
  { id: "fill",   label: "⤳ Заполнить", title: "Убрать разрывы: линейная интерполяция «х» (null)", run: doFillGaps },
  { id: "zero",   label: "⌫ Обнулить", title: "Очистить значения выделения (Del)", run: doDelete },
  { id: "copy",   label: "⧉ Копир.",   title: "Скопировать выделение (Ctrl+C)", run: doCopy },
  { id: "paste",  label: "⎘ Встав.",   title: "Вставить из буфера (Ctrl+V)", run: doPaste, enabled: () => !!CLIP },
];
const QA_DEFAULT_ORDER = ["smooth", "fill", "zero", "copy", "paste"];
function topActions(n) {
  const arr = QUICK_ACTIONS.slice().sort((x, y) => {
    const cx = ACT_STATS[x.id] || 0, cy = ACT_STATS[y.id] || 0;
    if (cy !== cx) return cy - cx;                                  // чаще -> левее
    return QA_DEFAULT_ORDER.indexOf(x.id) - QA_DEFAULT_ORDER.indexOf(y.id);
  });
  return n ? arr.slice(0, n) : arr;
}
function renderQuickActions() {
  const box = document.getElementById("sel-quick");
  if (!box) return;
  box.innerHTML = "";
  if (!SEL) return;
  const lbl = document.createElement("span");
  lbl.className = "qa-lbl"; lbl.textContent = "Частые:";
  lbl.title = "Подсказки адаптируются под ваши частые действия над выделением";
  box.appendChild(lbl);
  topActions(5).forEach((qa) => {
    const b = document.createElement("button");
    b.className = "qa-btn"; b.textContent = qa.label;
    const cnt = ACT_STATS[qa.id] || 0;
    b.title = qa.title + (cnt ? " · применяли " + cnt + "×" : "");
    if (qa.enabled && !qa.enabled()) b.disabled = true;
    b.onclick = () => { qa.run(); };               // run -> операция -> learnAction
    box.appendChild(b);
  });
}

/* ---------- Этап 3: арифметика по выделению ----------
   Операции применяются к диапазону SEL.i0..i1 по выбранным каналам selKeys().
   Число строк НЕ меняется -> совместимо с безопасным экспортом .asc3.
   Разрывы «х» (null) НЕ трогаем — арифметика только над реальными значениями.
   op: add(+N) sub(−N) set(=N, присвоить) pct(·N%, масштаб) */
const ARITH_LBL = { add: "+", sub: "−", set: "=", pct: "·", _suf: { pct: "%" } };
function applyArith(op, nRaw) {
  if (!SEL) { addNote("note", "Сначала выделите диапазон на графике (тяните ЛКМ) или Ctrl+A."); return; }
  const n = parseFloat(String(nRaw).replace(",", "."));
  if (!isFinite(n)) { addNote("note", "Введите число N для операции."); return; }
  const keys = selKeys();
  // +N / −N применяем ТОЛЬКО к «пикам СПО» — верхней полке пилы (колонна на
  // крюке). Фон/парковку (нижнюю полосу, в т.ч. НОЛЬ) НЕ трогаем.
  // Идентификация без привязки к нулю: базу берём как 10-й перцентиль значений
  // канала в выделении (устойчив к выбросам), пик — 90-й; порог = середина
  // между базой и пиком. Всё, что <= порога — фон, не двигаем. Для −N ещё и
  // не даём пику упасть НИЖЕ базы (крюк не легче пустого). =N и ·N% — на всё.
  // #v101 (тест 07-16 п.5.6): +/- применяем ЛИНЕЙНО ко ВСЕМ значениям выделения
  // (гибкие инструменты «только пики» — позже отдельной функцией). peaksOnly=false.
  const peaksOnly = false;
  const FRAC = 0.5;                       // доля высоты пики, ниже которой — фон
  function pct(sorted, p) {               // линейный перцентиль по отсортированному массиву
    if (!sorted.length) return NaN;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  let cnt = 0, skipped = 0, flatCh = 0;
  keys.forEach((k) => {
    const arr = SERIES.data[k];
    if (!arr) return;
    let thr = -Infinity, base = -Infinity;
    if (peaksOnly) {
      const vals = [];
      for (let i = SEL.i0; i <= SEL.i1; i++) { const v = arr[i]; if (v != null) vals.push(v); }
      if (!vals.length) return;
      vals.sort((a, b) => a - b);
      base = pct(vals, 0.10);             // фон/парковка (устойчивый минимум)
      const peak = pct(vals, 0.90);       // характерный пик
      const span = peak - base;
      if (span <= 1e-9) { flatCh++; return; }  // выделение плоское — пиков СПО нет, канал не трогаем
      thr = base + FRAC * span;           // граница фон/пик
    }
    for (let i = SEL.i0; i <= SEL.i1; i++) {
      const v = arr[i];
      if (v == null) continue;            // разрыв «х» не трогаем
      if (peaksOnly && v <= thr) { skipped++; continue; }   // фон/ноль/впадины не трогаем
      let nv = v;
      if (op === "add") nv = v + n;
      else if (op === "sub") nv = Math.max(v - n, base);    // не ниже базы
      else if (op === "set") nv = n;
      else if (op === "pct") nv = v * n / 100;
      arr[i] = +nv.toFixed(2);
      cnt++;
    }
  });
  const lbl = ARITH_LBL[op] + n + (op === "pct" ? "%" : "");
  learnAction("arith");
  histPush("Аритм " + lbl + " (" + keys.length + "к)");
  renderChart(); refreshGrid();
  let tail = "";
  if (peaksOnly) {
    tail = " (только пики СПО; фон/ноль оставлен на месте: " + skipped + " точек";
    if (flatCh) tail += "; без выраженных пиков каналов: " + flatCh;
    tail += ")";
  }
  addNote("note", "Арифметика «" + lbl + "»: изменено " + cnt + " значений в " + keys.length + " канале(ах)" + tail + ".");
}

/* выделить весь диапазон (Ctrl+A) */
function selectAll() {
  if (!N) return;
  const s = gatherSelection(SERIES.ts[0], SERIES.ts[N - 1]);
  if (!s) return;
  SEL = s; SEL_TAGS = [];
  ensureSelBand(); positionSelBand(); renderContext();
  selectGridRange(0, N - 1);
  addNote("status", "Выделено всё: " + N + " точек.");
}
/* инвертировать выбор каналов в пределах активных осей (Ctrl+I) */
function invertTags() {
  if (!SEL) return;
  const all = ACTIVE_AXES.map((c) => c.key);
  SEL_TAGS = all.filter((k) => !SEL_TAGS.includes(k));
  renderContext();
  addNote("status", "Каналы инвертированы: выбрано " + SEL_TAGS.length + " из " + all.length + ".");
}

function nearestIdx(t) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < N; i++) { const d = Math.abs(SERIES.ts[i] - t); if (d < bd) { bd = d; best = i; } }
  return best;
}
function selectGridRow(idx) {
  if (!GRID_API) return;
  GRID_API.forEachNode((n) => {
    const sel = n.data.__idx === idx;   // по индексу, а не по времени: в одной секунде бывает две записи
    n.setSelected(sel);
    if (sel) GRID_API.ensureNodeVisible(n, "middle");
  });
}
// выделить в таблице ВЕСЬ диапазон строк i0..i1 (соответствует выделению на графике)
function selectGridRange(i0, i1) {
  if (!GRID_API) return;
  let first = null;
  GRID_API.forEachNode((n) => {
    const idx = n.data.__idx;
    const sel = idx != null && idx >= i0 && idx <= i1;
    n.setSelected(sel);
    if (sel && first === null) first = n;
  });
  if (first) GRID_API.ensureNodeVisible(first, "middle");
}

/* ---------- режим рисования: ручная отрисовка / подрезка линии ----------
   Клавиша «0» или кнопка ✎ включает режим. Тянешь ЛКМ по графику — линия
   выбранного канала прорисовывается/подрезается по траектории курсора.
   Панорамирование/зум на это время отключаются. Канал = первый отмеченный
   тег (клик по чипу выделения) либо первый активный канал. */
let DRAW = { active: false, drawing: false, pts: [] };
function drawTargetKey() {
  if (typeof SEL_TAGS !== "undefined" && SEL_TAGS.length) return SEL_TAGS[0];
  return ACTIVE_AXES && ACTIVE_AXES.length ? ACTIVE_AXES[0].key : null;
}
function drawName(key) { const c = CHANNELS.find((x) => x.key === key); return c ? c.name : "канал"; }
function drawSetMode(on) {
  if (on) {
    if (typeof ERASE !== "undefined" && ERASE.active) eraseSetMode(false);
    if (typeof SPO !== "undefined" && SPO.active) spoSetMode(false);
  }
  DRAW.active = !!on; DRAW.drawing = false; DRAW.pts = [];
  const dom = document.getElementById("chart"); if (dom) dom.style.cursor = on ? "crosshair" : "";
  const btn = document.getElementById("btn-draw"); if (btn) btn.classList.toggle("on", DRAW.active);
  renderChart();   // переинициализирует dataZoom (вкл/выкл панорамирование)
  if (on) addNote("status", "✎ Рисование «" + drawName(drawTargetKey()) + "»: клик — одна точка, протяжка — линия, протяжка ровно вправо → СПО (трапеция). «0» — выход.");
  else addNote("status", "Режим рисования выключен.");
}
function bindDraw() {
  const zr = chart.getZr();
  zr.on("mousedown", (e) => {
    if (e.event && e.event.button !== 0) return;   // только ЛКМ
    if (e.event && (e.event.ctrlKey || e.event.metaKey || e.event.altKey || e.event.shiftKey)) return; // модиф. -> аккорды
    if (typeof ERASE !== "undefined" && ERASE.active) { eraseStart(e.offsetX, e.offsetY); return; }
    if (!DRAW.active) return;
    DRAW.drawing = true; DRAW.pts = [[e.offsetX, e.offsetY]];
  });
  zr.on("mousemove", (e) => {
    if (typeof ERASE !== "undefined" && ERASE.active && ERASE.drag) { eraseMove(e.offsetX, e.offsetY); return; }
    if (!DRAW.active || !DRAW.drawing) return;
    DRAW.pts.push([e.offsetX, e.offsetY]);
  });
  const finish = () => {
    if (typeof ERASE !== "undefined" && ERASE.active && ERASE.drag) { eraseFinish(); return; }
    if (DRAW.active && DRAW.drawing) { DRAW.drawing = false; finishDraw(); }
  };
  zr.on("mouseup", finish);
  zr.on("globalout", finish);
}
/* решаем по жесту: клик -> одна точка; ровная протяжка вправо -> СПО; иначе freehand */
function finishDraw() {
  const pts = DRAW.pts;
  if (!pts || pts.length < 1) { DRAW.pts = []; return; }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const spanX = maxX - minX, spanY = maxY - minY;
  // одиночный клик (почти без смещения) -> поставить/перебить одну точку (порог 6px, #C1)
  if (spanX < 6 && spanY < 6) { drawPoint(pts[0][0], pts[0][1]); DRAW.pts = []; return; }
  // вертикальный штрих (без горизонтального хода) = та же одна точка, значение = конец штриха
  if (spanX < 6) { drawPoint(pts[0][0], pts[pts.length - 1][1]); DRAW.pts = []; return; }
  const dxSigned = pts[pts.length - 1][0] - pts[0][0];
  // жест СПО: уверенная протяжка вправо (>50px), почти горизонтальная И >=5с по времени
  // (защита от случайной «СПО-фигуры 2с» при микро-дрожании клика, #C1).
  // Ctrl-кисть (DRAW.noSpo) — чистое рисование без авто-СПО (фигуры строим по Shift).
  const _tA = chart.convertFromPixel({ xAxisIndex: 0 }, minX);
  const _tB = chart.convertFromPixel({ xAxisIndex: 0 }, maxX);
  const _durMs = (Number.isFinite(_tA) && Number.isFinite(_tB)) ? (_tB - _tA) : 0;
  if (!DRAW.noSpo && dxSigned > 50 && spanX > 2.2 * spanY && _durMs >= 5000) {
    spoFromGesture(pts[0][0], pts[0][1], pts[pts.length - 1][0], pts[pts.length - 1][1]);
    DRAW.pts = [];
    return;
  }
  applyDraw();
}
// материализовать строку на ТОЧНОЙ секунде tt (мс), если её нет. Прочие каналы
// получают step-hold значение (последняя запись <= tt) — величина, которую прибор
// реально удерживал; новых значений НЕ фабрикуем (P1). ROW_SRC=-1 -> экспорт rebuild.
function insertRowAtTime(tt, skipRebuild) {
  const pos = tsIndex(tt);                                   // lower_bound: первый ts >= tt
  const at = (SERIES.ts.length && SERIES.ts[pos] < tt) ? pos + 1 : pos;
  const hold = at - 1;                                        // строка-источник удержания
  for (const k in SERIES.data) {
    const arr = SERIES.data[k]; if (!arr) continue;
    const v = hold >= 0 && hold < arr.length ? arr[hold] : null;
    arr.splice(at, 0, v);
  }
  SERIES.ts.splice(at, 0, tt);
  if (typeof ROW_SRC !== "undefined" && ROW_SRC) ROW_SRC.splice(at, 0, -1);
  N++;
  if (!skipRebuild) rebuildGrid();   // #v109 (K2): пакетная вставка — rebuild один раз снаружи
  return at;
}
// поставить одну точку канала по клику — на СЕКУНДЕ КУРСОРА (1 Гц),
// а не на ближайшей записанной точке (семантика #B15/#B18; фикс #C1 «снап к точке»)
function drawPoint(px, py) {
  const key = drawTargetKey();
  const yIdx = ACTIVE_AXES.findIndex((c) => c.key === key);
  if (!key || yIdx < 0) return;
  const t = chart.convertFromPixel({ xAxisIndex: 0 }, px);
  const v = chart.convertFromPixel({ yAxisIndex: yIdx }, py);
  if (!Number.isFinite(t) || !Number.isFinite(v)) return;
  const tt = Math.round(t / 1000) * 1000;                     // секунда под курсором
  let idx = tsIndex(tt);
  if (!SERIES.ts.length) return;
  if (SERIES.ts[idx] !== tt) idx = insertRowAtTime(tt);       // строки на секунде нет — материализуем
  SERIES.data[key][idx] = +v.toFixed(2);
  histPush("Точка «" + drawName(key) + "»");
  renderChart(); refreshGrid();
  addNote("note", "Точка канала «" + drawName(key) + "» = " + (+v.toFixed(2)) + " (" + fmtTime(tt) + ").");
}
// инициализировать СПО из жеста (две пиксельные точки) и показать панель настройки
function spoFromGesture(px0, py0, px1, py1) {
  const key = spoTargetKey();
  const yIdx = ACTIVE_AXES.findIndex((c) => c.key === key);
  if (!key || yIdx < 0) { addNote("note", "Включите канал для СПО (по умолчанию «Положение крюкоблока») в шапке графика."); return; }
  SPO.key = key; SPO.yIdx = yIdx; SPO.base = SERIES.data[key].slice();
  SPO._t0 = chart.convertFromPixel({ xAxisIndex: 0 }, px0);
  const t1 = chart.convertFromPixel({ xAxisIndex: 0 }, px1);
  SPO._py0 = py0; SPO._py1 = py1;
  SPO.vStart = chart.convertFromPixel({ yAxisIndex: yIdx }, py0);
  SPO.vEnd = chart.convertFromPixel({ yAxisIndex: yIdx }, py1);
  const a = Math.min(SPO._t0, t1), b = Math.max(SPO._t0, t1);
  SPO.i0 = nearestIdx(a); SPO.i1 = nearestIdx(b);
  SPO.drag = false;
  if (SPO.i1 <= SPO.i0) { SPO.base = null; return; }
  spoRender(false);
  spoPanel(true);
}
function applyDraw() {
  const key = drawTargetKey();
  const yIdx = ACTIVE_AXES.findIndex((c) => c.key === key);
  if (!key || yIdx < 0 || DRAW.pts.length < 2) { DRAW.pts = []; return; }
  // пиксели -> [время, значение] (X по оси времени, Y по оси нужного канала)
  const conv = DRAW.pts.map((p) => {
    const t = chart.convertFromPixel({ xAxisIndex: 0 }, p[0]);
    const v = chart.convertFromPixel({ yAxisIndex: yIdx }, p[1]);
    return [t, v];
  }).filter((d) => Number.isFinite(d[0]) && Number.isFinite(d[1]));
  if (conv.length < 2) { DRAW.pts = []; return; }
  conv.sort((a, b) => a[0] - b[0]);
  const tMin = conv[0][0], tMax = conv[conv.length - 1][0];
  // #v109 (K2, тест 23.07 «данные сохраняются не идентично»): запись прибора
  // событийная — между строками дыры в десятки секунд, и freehand, писавший
  // только в СУЩЕСТВУЮЩИЕ строки, давал в штатном ПО форму грубее нарисованной.
  // Материализуем строки 1 Гц вдоль жеста (как drawPoint): прочие каналы
  // получают step-hold, ROW_SRC=-1 — ничего не фабрикуем (P1).
  let _ins = 0;
  const _ttA = Math.ceil(tMin / 1000) * 1000, _ttB = Math.floor(tMax / 1000) * 1000;
  if (_ttB >= _ttA && (_ttB - _ttA) / 1000 <= 20000) {   // страж: жест шире ~5.5 ч не материализуем
    for (let tt = _ttA; tt <= _ttB; tt += 1000) {
      const pos = tsIndex(tt);
      if (SERIES.ts[pos] !== tt) { insertRowAtTime(tt, true); _ins++; }
    }
    if (_ins) rebuildGrid();
  }
  const arr = SERIES.data[key];
  // #v110 (K7, решение 23.07): «закрывающая строка» — через 1 с после конца жеста
  // возвращаем значение, которое ОТОБРАЖАЛОСЬ до рисования (step-hold), чтобы в
  // В штатном ПО горка завершалась как нарисовано, а не удерживалась до следующей
  // исходной строки. Значение снимаем ДО перезаписи жестом; существующую строку
  // на этой секунде не трогаем (реальные данные, P1).
  let _ttC = -1, _vC = null;
  if (_ttB >= _ttA && (_ttB - _ttA) / 1000 <= 20000) {
    const _c = _ttB + 1000;
    const _p = tsIndex(_c);                                  // lower_bound: первый ts >= _c
    if (SERIES.ts[_p] !== _c && _p - 1 >= 0) {
      _ttC = _c;
      // #v111 (K7-фикс, 28.07): раньше бралось ровно arr[_p-1] — в разрежённой
      // зоне записи (СПО/фон) значение соседа может быть null (событийная запись:
      // канал в этой строке не писался), K7 тогда молча не срабатывала (тест №3).
      // Теперь идём назад до первого НЕ-null — это и есть step-hold, который
      // реально отображался до рисования.
      for (let _q = _p - 1; _q >= 0; _q--) {
        if (arr[_q] != null) { _vC = arr[_q]; break; }
      }
    }
  }
  // #B73 (20.08.2026): раньше счётчик считал ВСЕ точки, накрытые рисунком, и
  // сообщал их как «нарисовано». Если линия легла ровно поверх прежних значений
  // (частый случай на полке), пользователь видел «нарисовано 300 точек», а на
  // графике не менялось ничего — и не мог отличить «совпало» от «не сохранилось».
  // Считаем отдельно: touched — накрыто, changed — реально изменено.
  let changed = 0, touched = 0;
  for (let i = 0; i < N; i++) {
    const t = SERIES.ts[i];
    if (t < tMin || t > tMax) continue;
    let v = null;
    for (let j = 1; j < conv.length; j++) {
      if (t <= conv[j][0]) {
        const t0 = conv[j - 1][0], v0 = conv[j - 1][1], t1 = conv[j][0], v1 = conv[j][1];
        const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        v = v0 + (v1 - v0) * f; break;
      }
    }
    if (v != null) {
      const nv = +v.toFixed(2);
      if (arr[i] !== nv) changed++;
      arr[i] = nv; touched++;
    }
  }
  DRAW.pts = [];
  if (touched) {
    if (_ttC > 0 && _vC != null) {                           // #v110 (K7): закрывающая строка
      const _at = insertRowAtTime(_ttC, true);
      arr[_at] = _vC;                                        // вернуть pre-draw значение цели
      rebuildGrid();
      // #A22 (18.08.2026, аудит): отладочные строки «[K7-диагностика] …» уходили
      // в ленту ассистента, т.е. их видел ПОКУПАТЕЛЬ. Оба сообщения адресованы
      // разработчику (имена внутренних переменных _ttC/_vC), пользователю по ним
      // нечего решать. Не удаляю — переношу в консоль: диагностика нужна при
      // разборе обращений, а лента должна говорить на языке покупателя.
      console.debug("[K7] закрывающая строка вставлена:", fmtTime(_ttC), "=", _vC);
    } else {
      console.debug("[K7] закрывающая строка НЕ вставлена: _ttC=", _ttC, "_vC=", _vC);
    }
    histPush("Рисование «" + drawName(key) + "» (" + touched + " тчк)");
    renderChart(); refreshGrid();
    const совпало = touched - changed;
    addNote("note", "Нарисовано/подрезано " + touched + " точек канала «" +
      drawName(key) + "»" +
      (совпало ? ", из них " + совпало + " уже имели это значение — изменено " +
                 changed : "") + ".");
  }
}

/* ====================================================================
   РЕЖИМ СПО: протяжка ЛКМ вправо рисует спуско-подъёмную операцию
   (трапеция: спуск -> плато -> подъём) на канале «Положение крюкоблока».
   После отпускания всплывает панель: наклон, «повторить предыдущую»,
   Применить / Отмена. Превью пишется поверх снимка base, поэтому
   правка наклона/повтора не накапливается.
   ==================================================================== */
let SPO = { active: false, drag: false, key: null, yIdx: 0, base: null,
  i0: 0, i1: 0, vStart: 0, vEnd: 0, incline: 35, repeat: false, kind: "СПО" };
function editDragOn() { return DRAW.active || SPO.active || (typeof ERASE !== "undefined" && ERASE.active); }
// канал положения крюкоблока: по имени (реальные данные = c0..c13 с рус. именами)
function spoTargetKey() {
  const byName = CHANNELS.find((c) => /полож/i.test(c.name) && /крюк/i.test(c.name));
  if (byName) return byName.key;
  const hk = CHANNELS.find((c) => c.key === "Hk");
  if (hk) return hk.key;
  if (typeof SEL_TAGS !== "undefined" && SEL_TAGS.length) return SEL_TAGS[0];
  return ACTIVE_AXES && ACTIVE_AXES.length ? ACTIVE_AXES[0].key : null;
}
function spoSetMode(on) {
  if (on && DRAW.active) drawSetMode(false);
  SPO.active = !!on; SPO.drag = false;
  const dom = document.getElementById("chart"); if (dom) dom.style.cursor = on ? "crosshair" : "";
  const btn = document.getElementById("btn-spo"); if (btn) btn.classList.toggle("on", SPO.active);
  spoPanel(false);
  renderChart();
  if (on) addNote("status", "⛏ Режим СПО: протяните ЛКМ вправо по «" + drawName(spoTargetKey()) + "». Затем настройте наклон и нажмите «Применить».");
  else addNote("status", "Режим СПО выключен.");
}
function spoStart(px, py) {
  const key = spoTargetKey();
  const yIdx = ACTIVE_AXES.findIndex((c) => c.key === key);
  if (!key || yIdx < 0) { addNote("note", "Включите канал для СПО (по умолчанию «Положение крюкоблока») в шапке графика."); return false; }
  SPO.key = key; SPO.yIdx = yIdx; SPO.base = SERIES.data[key].slice();
  SPO._t0 = chart.convertFromPixel({ xAxisIndex: 0 }, px);
  SPO._py0 = py; SPO._py1 = py;
  SPO.vStart = chart.convertFromPixel({ yAxisIndex: yIdx }, py);
  SPO.vEnd = SPO.vStart;
  SPO.i0 = nearestIdx(SPO._t0); SPO.i1 = SPO.i0;
  SPO.drag = true; return true;
}
function spoMove(px, py) {
  if (!SPO.drag) return;
  const t1 = chart.convertFromPixel({ xAxisIndex: 0 }, px);
  SPO._py1 = py;
  SPO.vEnd = chart.convertFromPixel({ yAxisIndex: SPO.yIdx }, py);
  const a = Math.min(SPO._t0, t1), b = Math.max(SPO._t0, t1);
  SPO.i0 = nearestIdx(a); SPO.i1 = nearestIdx(b);
  spoRender(true);
}
// сменить целевой канал уже после отрисовки: вернуть прежний канал к снимку,
// взять снимок нового и пересчитать уровни из тех же пиксельных якорей
function spoSetKey(newKey) {
  if (SPO.base && SPO.key) { const a = SERIES.data[SPO.key]; for (let i = 0; i < a.length; i++) a[i] = SPO.base[i]; }
  const yIdx = ACTIVE_AXES.findIndex((c) => c.key === newKey);
  if (yIdx < 0) return;
  SPO.key = newKey; SPO.yIdx = yIdx; SPO.base = SERIES.data[newKey].slice();
  SPO.vStart = chart.convertFromPixel({ yAxisIndex: yIdx }, SPO._py0);
  SPO.vEnd = chart.convertFromPixel({ yAxisIndex: yIdx }, SPO._py1);
  spoRender();
}
// профиль трапеции (или повтор предыдущей) в индексах [i0..i1]
function spoBuildProfile() {
  const len = SPO.i1 - SPO.i0 + 1;
  if (len < 2) return null;
  const out = new Array(len);
  const vS = SPO.vStart, vE = SPO.vEnd;
  if (SPO.repeat) {
    // повторить форму равной длины ПЕРЕД выделением, нормировав к текущей амплитуде
    const ps = SPO.i0 - len;
    if (ps >= 0) {
      const seg = SPO.base.slice(ps, ps + len).map((x) => (x == null ? vS : x));
      let mn = Infinity, mx = -Infinity;
      for (const x of seg) { if (x < mn) mn = x; if (x > mx) mx = x; }
      const sp = mx > mn ? mx - mn : 1;
      for (let i = 0; i < len; i++) {
        const f = (seg[i] - mn) / sp;            // 0..1 форма предыдущей операции
        out[i] = vS + (vE - vS) * f;
      }
      return out;
    }
  }
  // трапеция: спуск -> плато -> подъём; наклон управляет длиной рампы
  const ramp = Math.max(0.06, 0.45 - (SPO.incline / 100) * 0.38);   // меньше наклон-> длиннее рампа
  for (let i = 0; i < len; i++) {
    const f = i / (len - 1);
    let v;
    if (f < ramp) v = vS + (vE - vS) * (f / ramp);
    else if (f > 1 - ramp) v = vE + (vS - vE) * ((f - (1 - ramp)) / ramp);
    else v = vE;
    out[i] = v;
  }
  return out;
}
function spoRender(throttled) {
  if (!SPO.base) return;
  const arr = SERIES.data[SPO.key];
  for (let i = 0; i < arr.length; i++) arr[i] = SPO.base[i];   // откат к снимку
  const prof = spoBuildProfile();
  if (prof) for (let j = 0; j < prof.length; j++) arr[SPO.i0 + j] = +prof[j].toFixed(2);
  if (throttled) renderChartThrottled(); else renderChart();
}
function spoCommit() {
  if (!SPO.base) { spoPanel(false); return; }
  spoRender();
  const kn = SPO.kind || "СПО";
  histPush(kn + " «" + drawName(SPO.key) + "» (" + (SPO.i1 - SPO.i0 + 1) + " тчк)");
  refreshGrid();
  addNote("note", "Добавлена фигура «" + kn + "» на канал «" + drawName(SPO.key) + "» (" + fmtTime(SERIES.ts[SPO.i0]) + "–" + fmtTime(SERIES.ts[SPO.i1]) + ").");
  SPO.base = null; spoPanel(false);
}
function spoCancel() {
  if (SPO.base) { const arr = SERIES.data[SPO.key]; for (let i = 0; i < arr.length; i++) arr[i] = SPO.base[i]; renderChart(); }
  SPO.base = null; spoPanel(false);
}
// всплывающая панель настройки СПО
function spoPanel(show) {
  let p = document.getElementById("spo-panel");
  if (!show) { if (p) p.style.display = "none"; return; }
  if (!p) {
    p = document.createElement("div");
    p.id = "spo-panel"; p.className = "tb-pop spo-panel";
    p.innerHTML =
      '<div class="np-row"><span>Фигура</span><select id="spo-kind" class="spo-sel"><option value="СПО">СПО</option><option value="Райберование">Райберование</option></select></div>' +
      '<div class="np-row"><span>Канал</span><select id="spo-chan" class="spo-sel"></select></div>' +
      '<div class="np-row"><span>Наклон</span><input type="range" id="spo-incline" min="0" max="100" value="35"><span id="spo-inc-val">35%</span></div>' +
      '<label class="np-row" style="cursor:pointer"><input type="checkbox" id="spo-repeat"><span>Повторить предыдущую</span></label>' +
      '<div class="np-row spo-btns"><button id="spo-apply" class="sel-act">Применить</button><button id="spo-cancel" class="sel-act">Отмена</button></div>';
    document.body.appendChild(p);
    p.querySelector("#spo-kind").onchange = (e) => { SPO.kind = e.target.value; spoRender(); };
    p.querySelector("#spo-chan").onchange = (e) => spoSetKey(e.target.value);
    p.querySelector("#spo-incline").oninput = (e) => {
      SPO.incline = +e.target.value; p.querySelector("#spo-inc-val").textContent = e.target.value + "%"; spoRender();
    };
    p.querySelector("#spo-repeat").onchange = (e) => { SPO.repeat = e.target.checked; spoRender(); };
    p.querySelector("#spo-apply").onclick = spoCommit;
    p.querySelector("#spo-cancel").onclick = spoCancel;
  }
  // список активных каналов (выбор того, к какому применить СПО)
  const sel = p.querySelector("#spo-chan");
  sel.innerHTML = "";
  ACTIVE_AXES.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.key; o.textContent = shortName(c.name);
    if (c.key === SPO.key) o.selected = true;
    sel.appendChild(o);
  });
  p.querySelector("#spo-kind").value = SPO.kind || "СПО";
  p.querySelector("#spo-incline").value = SPO.incline;
  p.querySelector("#spo-inc-val").textContent = SPO.incline + "%";
  p.querySelector("#spo-repeat").checked = SPO.repeat;
  const dom = document.getElementById("chart").getBoundingClientRect();
  p.style.left = (dom.left + 60) + "px"; p.style.top = (dom.top + 40) + "px";
  p.style.display = "";
}
// Построить фигуру из выделенного интервала (Shift+ПКМ). Тип — по длительности:
// длинный отрезок = СПО (спуск-подъём), короткий = Райберование. Высота вписывается
// между соседями: последнее значение ДО интервала и первое значение ПОСЛЕ; старт не
// выше финиша, чтобы трапеция логично села между предыдущей и следующей операцией.
function figureFromInterval(i0, i1) {
  const key = spoTargetKey();
  const yIdx = ACTIVE_AXES.findIndex((c) => c.key === key);
  if (!key || yIdx < 0) { addNote("note", "Включите канал «Положение крюкоблока» в шапке графика — по нему строится фигура."); return; }
  if (i1 <= i0) { addNote("note", "Слишком короткий отрезок для фигуры."); return; }
  const arr = SERIES.data[key];
  let vBefore = null; for (let i = i0 - 1; i >= 0; i--) { if (arr[i] != null) { vBefore = arr[i]; break; } }
  let vAfter = null;  for (let i = i1 + 1; i < N; i++) { if (arr[i] != null) { vAfter = arr[i]; break; } }
  if (vBefore == null) vBefore = (arr[i0] != null ? arr[i0] : 0);
  if (vAfter == null)  vAfter = (arr[i1] != null ? arr[i1] : vBefore);
  const vS = Math.min(vBefore, vAfter), vE = Math.max(vBefore, vAfter);  // старт ≤ финиш — фигура садится ровно
  const mins = (SERIES.ts[i1] - SERIES.ts[i0]) / 60000;
  SPO.key = key; SPO.yIdx = yIdx; SPO.base = arr.slice();
  SPO.i0 = i0; SPO.i1 = i1; SPO.vStart = vS; SPO.vEnd = vE;
  SPO._t0 = SERIES.ts[i0]; SPO._py0 = null; SPO._py1 = null; SPO.drag = false;
  SPO.kind = mins >= 20 ? "СПО" : "Райберование";
  SPO.incline = SPO.kind === "СПО" ? 35 : 60;
  SPO.repeat = false;
  spoRender(false);
  spoPanel(true);
  addNote("status", "Фигура «" + SPO.kind + "» на " + fmtTime(SERIES.ts[i0]) + "–" + fmtTime(SERIES.ts[i1]) +
    " (" + Math.round(mins) + " мин). Отрегулируйте высоту/наклон/тип и «Применить».");
}

/* ====================================================================
   СТЁРКА (ластик): тянешь ЛКМ по графику — значения активного канала
   под «кистью» (полоса шириной brush px) обнуляются (ставятся 0, без
   разрывов линии). Один взмах = один шаг отмены (Ctrl+Z вернёт всё).
   Канал-цель = первый отмеченный тег либо первый активный канал.
   ==================================================================== */
let ERASE = { active: false, drag: false, key: null, yIdx: 0, base: null, last: -1, count: 0 };
function eraseTargetKey() { return drawTargetKey(); }
function eraseSetMode(on) {
  if (on) { if (DRAW.active) drawSetMode(false); if (typeof SPO !== "undefined" && SPO.active) spoSetMode(false); }
  ERASE.active = !!on; ERASE.drag = false;
  const dom = document.getElementById("chart"); if (dom) dom.style.cursor = on ? "cell" : "";
  const btn = document.getElementById("btn-erase"); if (btn) btn.classList.toggle("on", ERASE.active);
  renderChart();   // вкл/выкл панорамирование
  if (on) addNote("status", "⌫ Стёрка: клик — точка, протяжка — линия по «" + drawName(eraseTargetKey()) + "» (значения = 0). Esc — выход.");
  else addNote("status", "Стёрка выключена.");
}
function eraseStart(px, py) {
  const key = eraseTargetKey();
  const yIdx = ACTIVE_AXES.findIndex((c) => c.key === key);
  if (!key || yIdx < 0) { addNote("note", "Включите канал для стёрки в шапке графика."); return; }
  ERASE.key = key; ERASE.yIdx = yIdx; ERASE.base = SERIES.data[key].slice();
  ERASE.last = -1; ERASE.count = 0; ERASE.drag = true;
  eraseAt(px);
}
// стираем ТОЛЬКО там, где реально прошёл курсор: соединяем соседние сэмплы пути,
// не заполняем весь диапазон между min/max (без «большого куска»)
function eraseAt(px) {
  const t = chart.convertFromPixel({ xAxisIndex: 0 }, px);
  if (!Number.isFinite(t)) return;
  const idx = nearestIdx(t);
  let a = idx, b = idx;
  if (ERASE.last >= 0) { a = Math.min(ERASE.last, idx); b = Math.max(ERASE.last, idx); }
  const arr = SERIES.data[ERASE.key];
  for (let i = a; i <= b; i++) { if (arr[i] !== 0) { arr[i] = 0; ERASE.count++; } }
  ERASE.last = idx;
  renderChartThrottled();
}
function eraseMove(px, py) { if (ERASE.drag) eraseAt(px); }
function eraseFinish() {
  ERASE.drag = false;
  if (!ERASE.base) return;
  renderChart();
  if (ERASE.count > 0) {
    histPush("Стёрка «" + drawName(ERASE.key) + "» (" + ERASE.count + " тчк)");
    refreshGrid();
    addNote("note", "Стёрто " + ERASE.count + " точек канала «" + drawName(ERASE.key) + "».");
  }
  ERASE.base = null;
}

/* ---------- горячие клавиши ---------- */
function isEditing(t) {
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable ||
    (t.closest && t.closest(".ag-cell-inline-editing")));
}
function bindKeys() {
  window.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = (e.key || "").toLowerCase();
    const code = e.code || "";   // физическая клавиша — НЕ зависит от раскладки (рус/eng): фикс Ctrl+C/V на кириллице
    if (isEditing(e.target)) return;   // в полях ввода/редакторе таблицы — штатное поведение
    if (ctrl && e.shiftKey && code === "KeyZ") { e.preventDefault(); redo(); }     // Ctrl+Shift+Z — повтор
    else if (ctrl && code === "KeyZ") { e.preventDefault(); undo(); }              // Ctrl+Z — отмена
    else if (ctrl && code === "KeyY") { e.preventDefault(); redo(); }              // Ctrl+Y — повтор
    else if (ctrl && code === "KeyX") { e.preventDefault(); redo(); }              // #v101: Ctrl+X — повтор (алиас Ctrl+Y)
    else if (ctrl && code === "KeyC") { if (SEL) { e.preventDefault(); doCopy(); } }
    else if (ctrl && code === "KeyV") { if (SEL && CLIP) { e.preventDefault(); doPaste(); } }
    else if (ctrl && e.shiftKey && code === "KeyA") { e.preventDefault(); clearSelection(); }   // Ctrl+Shift+A — снять выделение
    else if (ctrl && code === "KeyA") { e.preventDefault(); selectAll(); }                       // Ctrl+A — выделить всё
    else if (ctrl && code === "KeyI") { if (SEL) { e.preventDefault(); invertTags(); } }         // Ctrl+I — инвертировать каналы
    else if (ctrl && e.key === "Delete") { e.preventDefault(); deleteSelRows(); }   // Ctrl+Del — удалить СТРОКИ (блоки)
    // #v97 схема управления: Del ОБНУЛЯЕТ (=0), Alt+Del и Backspace очищают в «х» (null).
    else if (e.altKey && e.key === "Delete") { if (SEL) { e.preventDefault(); doDelete(); } }
    else if (e.key === "Delete") { if (SEL) { e.preventDefault(); doZero(); } }
    else if (e.key === "Backspace") { if (SEL) { e.preventDefault(); doDelete(); } }
    else if (e.key === "Insert") { e.preventDefault(); insertRowAtSel(); }          // Insert — вставить строку (блок)
    else if (!ctrl && (code === "Digit0" || code === "Numpad0")) { e.preventDefault(); drawSetMode(!DRAW.active); }
    else if (k === "escape") {
      if (SPO.base) { e.preventDefault(); spoCancel(); }
      else if (typeof ERASE !== "undefined" && ERASE.active) { e.preventDefault(); eraseSetMode(false); }
      else if (DRAW.active) { e.preventDefault(); drawSetMode(false); }
    }
  });
}

/* ---------- кнопки тулбара: undo/redo/история/шум ---------- */
function bindEditingTools() {
  const u = document.getElementById("btn-undo"); if (u) u.onclick = undo;
  const r = document.getElementById("btn-redo"); if (r) r.onclick = redo;
  const h = document.getElementById("btn-hist"), hm = document.getElementById("hist-menu");
  if (h && hm) h.onclick = (e) => {
    e.stopPropagation();
    const open = hm.style.display !== "none";
    if (open) { hm.style.display = "none"; return; }
    const rc = h.getBoundingClientRect();
    hm.style.left = rc.left + "px"; hm.style.top = (rc.bottom + 2) + "px";
    renderHistUI(); hm.style.display = "";
    setTimeout(() => document.addEventListener("mousedown", function cl(ev) {
      if (!hm.contains(ev.target) && ev.target !== h) { hm.style.display = "none"; document.removeEventListener("mousedown", cl); }
    }), 0);
  };
  const nb = document.getElementById("btn-noise"), np = document.getElementById("noise-pop"),
    nr = document.getElementById("noise-range"), nv = document.getElementById("noise-val");
  if (nb && np) nb.onclick = (e) => {
    e.stopPropagation();
    const open = np.style.display !== "none";
    if (open) { np.style.display = "none"; noiseCommit(); return; }
    const rc = nb.getBoundingClientRect();
    np.style.left = rc.left + "px"; np.style.top = (rc.bottom + 2) + "px";
    np.style.display = ""; noiseOpen();
    setTimeout(() => document.addEventListener("mousedown", function cl(ev) {
      if (!np.contains(ev.target) && ev.target !== nb) { np.style.display = "none"; noiseCommit(); document.removeEventListener("mousedown", cl); }
    }), 0);
  };
  if (nr) {
    nr.oninput = () => { if (nv) nv.textContent = nr.value + "%"; noiseApply(+nr.value); };
    nr.onchange = () => { if (nv) nv.textContent = nr.value + "%"; };
  }
  // ---- диммер: ползунок видимости фоновых линий (меняет только opacity, без перерисовки данных) ----
  const db = document.getElementById("btn-dim"), dp = document.getElementById("dim-pop"),
    drng = document.getElementById("dim-range"), dval = document.getElementById("dim-val");
  if (db && dp) db.onclick = (e) => {
    e.stopPropagation();
    const open = dp.style.display !== "none";
    if (open) { dp.style.display = "none"; return; }
    const rc = db.getBoundingClientRect();
    dp.style.left = rc.left + "px"; dp.style.top = (rc.bottom + 2) + "px";
    dp.style.display = "";
    setTimeout(() => document.addEventListener("mousedown", function cl(ev) {
      if (!dp.contains(ev.target) && ev.target !== db) { dp.style.display = "none"; document.removeEventListener("mousedown", cl); }
    }), 0);
  };
  if (drng) drng.oninput = () => {
    DIM = Math.max(0.05, Math.min(1, (+drng.value) / 100));
    if (dval) dval.textContent = drng.value + "%";
    applyDim();
  };
  const dr = document.getElementById("btn-draw");
  if (dr) dr.onclick = () => drawSetMode(!DRAW.active);
  const er = document.getElementById("btn-erase");
  if (er) er.onclick = () => eraseSetMode(!ERASE.active);
}

/* ---------- лицензия (B-fix 01-08): бейдж в тулбаре + попап активации ключа,
   без выхода из основного окна и без перезапуска приложения ---------- */
function licenseStateLabel(st) {
  if (st.state === "licensed") {
    // Пустой хвост запрещён: либо срок, либо «без даты окончания». Владелец 12.08
    // видел «Лицензия ✓» и не мог понять, сколько осталось (замечание №1).
    // 07.10 (R Z6): не «бессрочная» — лицензия без срока по закону действует
    // 5 лет (п. 4 ст. 1235 ГК), обещать «срок не ограничен» нельзя.
    const dl = (st.days_left == null)
      ? (st.perpetual ? " (без даты окончания)" : "")
      : ` (${st.days_left} дн.)`;
    return { text: "Лицензия ✓" + dl, cls: "lic-licensed" };
  }
  if (st.state === "trial") return { text: `Триал: ${st.days_left} дн.`, cls: "lic-trial" };
  if (st.state === "revoked") return { text: "Ключ отозван", cls: "lic-expired" };
  return { text: "Не активна", cls: "lic-expired" };
}

/* Дата окончания из unix-времени payload'а: показываем именно дату, счётчик
   дней сам по себе не даёт клиенту понять, до какого числа он оплачен. */
function licenseExpDate(exp) {
  if (!exp) return null;
  const d = new Date(Number(exp) * 1000);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

async function refreshLicenseBadge() {
  const btn = document.getElementById("btn-license");
  const row = document.getElementById("license-status-row");
  if (!btn) return null;
  let st;
  try {
    const resp = await fetch("/api/license/status");
    st = await resp.json();
  } catch (e) {
    btn.textContent = "?"; btn.className = "tb-icon tb-license-badge";
    return null;
  }
  const { text, cls } = licenseStateLabel(st);
  btn.textContent = text;
  btn.className = "tb-icon tb-license-badge " + cls;
  const hwidEl = document.getElementById("license-hwid");
  if (hwidEl && st.machine_id) hwidEl.textContent = st.machine_id;
  if (row) {
    if (st.state === "licensed") {
      const bind = st.bind
        ? (st.bind === st.machine_id ? " Ключ привязан к этому компьютеру." : ` Ключ привязан к компьютеру ${st.bind}.`)
        : " Ключ без привязки к компьютеру.";
      row.textContent = `План: ${st.plan || "—"}${st.email ? ", " + st.email : ""}.` + bind;
    } else if (st.state === "trial") {
      row.textContent = `Пробный период: осталось ${st.days_left} дн. Просмотр и редактирование — без ограничений, сохранение результата — после покупки лицензии.`;
    } else {
      row.textContent = st.reason || "Лицензия не активна.";
    }
  }
  // Срок: дата + остаток дней. Без exp — «дата окончания не указана» словами.
  const expRow = document.getElementById("license-exp-row");
  if (expRow) {
    const d = licenseExpDate(st.exp);
    let txt = "";
    if (st.state === "licensed") {
      txt = d ? `Действует до ${d} — осталось ${st.days_left} дн.`
              : "Дата окончания в ключе не указана.";
    } else if (st.state === "trial") {
      txt = d ? `Пробный период до ${d} — осталось ${st.days_left} дн.` : "";
    } else if (st.state === "revoked" && d) {
      txt = `Срок ключа был до ${d}.`;
    }
    expRow.textContent = txt;
    expRow.style.display = txt ? "" : "none";
  }
  // Номер лицензии (KE-XXXX-XXXX-XXXX) — производный от ключа, стабильный;
  // его называют в поддержке, по нему владелец находит покупку в реестре.
  const keyRow = document.getElementById("license-key-row"),
        keyId = document.getElementById("license-key-id");
  if (keyRow) {
    if (keyId) keyId.textContent = st.key_id || "—";   // не оставляем номер от прошлого статуса
    keyRow.style.display = st.key_id ? "" : "none";
  }
  return st;
}

/* Задание 56: в неактивированной программе (срок или триал истёк) редактор
   работает как просмотр, а окно активации всплывает при старте и затем раз в
   30 минут, пока ключ не введён. Сохранение закрыто на сервере (402). */
const LICENSE_NAG_MS = 30 * 60 * 1000;

function bindLicense() {
  const b = document.getElementById("btn-license"), p = document.getElementById("license-pop"),
    input = document.getElementById("license-key-input"),
    actBtn = document.getElementById("license-activate-btn"),
    msg = document.getElementById("license-msg");
  if (!b || !p) return;
  const openPop = () => {
    const rc = b.getBoundingClientRect();
    p.style.left = "auto"; p.style.right = (window.innerWidth - rc.right) + "px";
    p.style.top = (rc.bottom + 2) + "px";
    p.style.display = "";
    if (msg) { msg.style.display = "none"; msg.textContent = ""; }
    setTimeout(() => document.addEventListener("mousedown", function cl(ev) {
      if (!p.contains(ev.target) && ev.target !== b) { p.style.display = "none"; document.removeEventListener("mousedown", cl); }
    }), 0);
  };
  const nag = async () => {
    const st = await refreshLicenseBadge();
    if (st && st.state === "expired" && p.style.display === "none") openPop();
  };
  refreshLicenseBadge().then((st) => {
    if (st && st.state === "expired") {
      openPop();
      setInterval(nag, LICENSE_NAG_MS);
    }
  });
  b.onclick = (e) => {
    e.stopPropagation();
    const open = p.style.display !== "none";
    if (open) { p.style.display = "none"; return; }
    openPop();
    refreshLicenseBadge();
  };
  const doActivate = async () => {
    const key = (input && input.value || "").trim();
    if (!key) return;
    if (actBtn) actBtn.disabled = true;
    try {
      const resp = await fetch("/api/license/activate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await resp.json();
      if (msg) {
        msg.style.display = "";
        if (data.ok) {
          msg.className = "np-row ok"; msg.textContent = "Ключ принят, лицензия активна.";
          if (input) input.value = "";
        } else {
          msg.className = "np-row err"; msg.textContent = data.reason || "Ошибка активации.";
        }
      }
      await refreshLicenseBadge();
    } catch (e) {
      if (msg) { msg.style.display = ""; msg.className = "np-row err"; msg.textContent = "Сеть недоступна."; }
    } finally {
      if (actBtn) actBtn.disabled = false;
    }
  };
  if (actBtn) actBtn.onclick = doActivate;
  if (input) input.onkeydown = (e) => { if (e.key === "Enter") doActivate(); };
  // Код компьютера (HWID, лицензия v2): клик = скопировать — клиент сообщает
  // его при покупке, ключ выпускается с привязкой к этой машине.
  const hwRow = document.getElementById("license-hwid-row");
  if (hwRow) hwRow.onclick = async () => {
    const code = (document.getElementById("license-hwid") || {}).textContent || "";
    if (!code || code === "…") return;
    try { await navigator.clipboard.writeText(code); } catch (e) { /* http/webview без clipboard API — не критично */ }
    if (msg) {
      msg.style.display = ""; msg.className = "np-row ok";
      msg.textContent = "Код компьютера скопирован: " + code;
    }
  };
  const keyRow2 = document.getElementById("license-key-row");
  if (keyRow2) keyRow2.onclick = async () => {
    const num = (document.getElementById("license-key-id") || {}).textContent || "";
    if (!num || num === "—") return;
    try { await navigator.clipboard.writeText(num); } catch (e) { /* webview без clipboard API */ }
    if (msg) {
      msg.style.display = ""; msg.className = "np-row ok";
      msg.textContent = "Номер лицензии скопирован: " + num;
    }
  };
}

/* ---------- init ---------- */
async function init() {
  chart = echarts.init(document.getElementById("chart"));
  const real = await loadData();
  if (!real) genMock();
  // SOURCE_LABEL — подпись источника от сервера (демо: синтетическая картограмма;
  // без неё демо называло выдуманные данные «реальным .asc3»)
  const sourceLabel = real ? (SOURCE_LABEL || "реальный .asc3 (поканальная калибровка)") : "mock-каркас (API пуст)";

  initRowSrc();
  buildChannelTabs();
  buildDayBar();
  renderChart();
  bindChartEvents();
  bindTimeRange();
  buildGrid();
  buildTree();
  bindAI(sourceLabel);
  bindToolbar();
  bindResizer();
  bindEditingTools();
  bindLicense();
  bindKeys();
  bindInput();    // ЕДИНЫЙ контроллер ввода (Этап 0): заменил bindSelection+bindChords+bindDraw.
                  // Старые биндеры оставлены в коде как справка, но НЕ вызываются (иначе вернётся гонка).
  // подсветка по задержке отключена — линии статичны, без затухания
  histReset();
}
init();

// --- Проверка обновлений (OPS §2.3): ненавязчивая плашка -------------------
// Бэкенд /api/update_check сам кэширует (раз в 3 дня) и молчит при офлайне;
// здесь только UI. «Скрыть» запоминается на конкретную версию (localStorage).
setTimeout(async () => {
  try {
    const r = await fetch("/api/update_check");
    const d = await r.json();
    if (!d || !d.update) return;
    const latest = String(d.latest || "").replace(/[^0-9.]/g, "");
    if (!latest || localStorage.getItem("ke_upd_dismissed") === latest) return;
    const bar = document.createElement("div");
    bar.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:9999;" +
      "background:#1b2430;color:#fff;padding:10px 14px;border-radius:10px;" +
      "font:13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);" +
      "display:flex;gap:12px;align-items:center";
    // #A21 (18.08.2026, аудит): было bar.innerHTML с подстановкой d.url прямо
    // в href. `latest` чистился регуляркой, а url — нет: ответ /api/update_check
    // приходит по сети, и `javascript:`-ссылка или кавычка в нём ломала разметку
    // и исполняла чужой код в окне программы. Плюс target="_blank" без
    // rel="noopener" отдаёт открытой странице ссылку на наше окно.
    bar.appendChild(document.createTextNode("Доступна версия "));
    const b = document.createElement("b");
    b.textContent = latest;
    bar.appendChild(b);
    let href = "";
    try {
      const u = new URL(String(d.url || ""), location.href);
      if (u.protocol === "https:" || u.protocol === "http:") href = u.href;
    } catch (e) { /* мусор вместо ссылки — просто не показываем кнопку */ }
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.color = "#8ab4f8";
      a.textContent = "Скачать";
      bar.appendChild(document.createTextNode(" "));
      bar.appendChild(a);
    }
    const x = document.createElement("span");
    x.style.cssText = "cursor:pointer;opacity:.7";
    x.title = "Скрыть";
    x.textContent = "✕";
    bar.appendChild(document.createTextNode(" "));
    bar.appendChild(x);
    x.onclick = () => {
      localStorage.setItem("ke_upd_dismissed", latest);
      bar.remove();
    };
    document.body.appendChild(bar);
  } catch (e) { /* обновления — не критичный путь */ }
}, 4000);
