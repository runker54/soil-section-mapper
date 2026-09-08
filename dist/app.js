/* 土壤断面制图工具 —— 前端逻辑与 SVG 渲染引擎（版式规则移植自 make_sections.py） */
"use strict";

const invoke = window.__TAURI__.core.invoke;
const PX = 100 / 72; // pt -> px（按 100dpi）

/* ---------------- 土壤发生学知识表 ----------------
 * 剖面构型：土类 -> 发生层序列 [层名, 颜色, 相对厚度]（颜色取土壤颜色惯例 Munsell 近似）
 * 水稻土按亚类（淹育/渗育/潴育/漂洗/潜育）修正构型 */
const SOIL_PROFILES = {
  "黄壤":    [["O", "#5e4f36", 0.06], ["A", "#8a6d46", 0.16], ["B", "#d3b62e", 0.54], ["C", "#b8b09a", 0.24]],
  "红壤":    [["A", "#8a6d46", 0.16], ["B", "#c1653f", 0.59], ["C", "#b0a894", 0.25]],
  "黄棕壤":  [["O", "#5e4f36", 0.06], ["A", "#7d6440", 0.15], ["B", "#c09055", 0.55], ["C", "#b2aa96", 0.24]],
  "燥红土":  [["A", "#9c7a4e", 0.18], ["B", "#b56f45", 0.57], ["C", "#b5a68e", 0.25]],
  "石灰岩土":[["A", "#7d6440", 0.16], ["Bk", "#d9d2bd", 0.55], ["R", "#8f8a7c", 0.29]],
  "紫色土":  [["A", "#7d6440", 0.15], ["C", "#a97fa0", 0.85]],
  "潮土":    [["A", "#7d6440", 0.16], ["C", "#bfb49a", 0.84]],
  "泥炭土":  [["O", "#4f4232", 0.30], ["H", "#5d4c37", 0.40], ["G", "#6a8291", 0.30]],
  "水稻土":  [["Ap", "#6d5b3e", 0.18], ["P", "#8a6f52", 0.12], ["W", "#b9a06a", 0.45], ["G", "#6a8291", 0.25]],
};
const PADDY_VARIANTS = [
  [/潜育/, [["Ap", "#6d5b3e", 0.16], ["P", "#8a6f52", 0.10], ["G", "#5a7484", 0.74]]],
  [/漂洗/, [["Ap", "#6d5b3e", 0.16], ["P", "#8a6f52", 0.10], ["E", "#d8d3c6", 0.36], ["W", "#b9a06a", 0.38]]],
  [/淹育/, [["Ap", "#6d5b3e", 0.20], ["P", "#8a6f52", 0.12], ["C", "#b8b09a", 0.68]]],
  [/渗育/, [["Ap", "#6d5b3e", 0.18], ["P", "#8a6f52", 0.12], ["We", "#c4ac72", 0.30], ["C", "#b8b09a", 0.40]]],
];
/* 土类 -> 常见母岩/母质（显示行自动填充建议值） */
const SOIL_PARENT = {
  "石灰岩土": "石灰岩/白云岩风化物", "紫色土": "紫色砂页岩风化物", "燥红土": "干热河谷老冲积物",
  "黄壤": "砂页岩风化物", "红壤": "砂页岩/第四纪红土", "黄棕壤": "砂页岩残坡积物",
  "潮土": "河流冲积物", "水稻土": "冲积/坡积物", "泥炭土": "湖沼沉积物",
};
/** 母岩母质：土种名中的显式母质词优先（灰泥质/灰泥田 → 石灰岩/白云岩；泥质 → 泥岩/页岩），否则按土类映射 */
function parentOf(tz, tl) {
  const n = String(tz || "");
  if (/灰泥质|灰泥田/.test(n)) return "石灰岩/白云岩风化物";
  if (/泥质/.test(n)) return "泥岩/页岩风化物";
  return SOIL_PARENT[tl] || "";
}
/** 断面点表格同号点的字段值（地貌/母岩等：表格有值优先，自动推导兜底） */
function tblVal(no, key) {
  const r = S.table.find(t => String(t.no) === String(no));
  const v = r && r[key];
  return v == null ? "" : String(v);
}
/** 由土种名解析剖面层厚调制（薄/中/厚腐 × 薄/中/厚层） */
function profileSequence(tl, yl, tz) {
  let seq = SOIL_PROFILES[tl];
  if (!seq) return null;
  if (tl === "水稻土") {
    for (const [re, s] of PADDY_VARIANTS) {
      if (re.test(yl || "") || re.test(tz || "")) { seq = s; break; }
    }
  }
  const name = tz || "";
  const hum = /薄腐/.test(name) ? 0.6 : /厚腐/.test(name) ? 1.4 : 1.0;
  const dep = /薄层/.test(name) ? 0.62 : /厚层/.test(name) ? 1.3 : 1.0;
  // A 层 ×hum，B/Bk/W 主层 ×dep，归一化
  const mod = seq.map(([l, c, w]) => {
    if (l === "O" || l === "A") return [l, c, w * hum];
    if (l === "B" || l === "Bk" || l === "W" || l === "We") return [l, c, w * dep];
    return [l, c, w];
  });
  const sum = mod.reduce((a, [, , w]) => a + w, 0);
  return mod.map(([l, c, w]) => [l, c, w / sum]);
}

/* ---------------- 全局状态 ---------------- */
const S = {
  gdal: { dir: "", ok: false, version: "" },
  line: { path: "", layers: [], layer: "", meta: null, selIdx: 0 },
  points: { path: "", layers: [], layer: "", meta: null },
  soil: { path: "", layers: [], layer: "", meta: null },
  dem: { path: "", meta: null },
  cfg: {
    lineIndex: 0,
    sampleStep: 20, smoothing: 5, extendsM: 0, codeScheme: "province",
    orientation: "high_left", veAuto: true, ve: 10,
    ptNameField: "", ptNoField: "",
    filterMode: "field", filterField: "", filterValue: "", filterDist: 600,
    soilTL: "", soilYL: "", soilTS: "", soilTZ: "", soilAdmin: "", soilLith: "", soilGEO: "",
    zones: [
      { elev: 600, name: "红壤带", key: "红壤" },
      { elev: 800, name: "黄壤带", key: "黄壤" },
      { elev: 1600, name: "黄棕壤带", key: "黄棕壤" },
    ],
    rows: [
      { key: "code", label: "土种编号", on: true, band: true },
      { key: "tz", label: "三普土种", on: true, band: true },
      { key: "profile", label: "剖面构型", on: false, band: true },
      { key: "lith", label: "母岩母质", on: true, band: true },
      { key: "geo", label: "地貌类型", on: true, band: true },
      { key: "ts", label: "土属", on: false, band: true },
      { key: "yl", label: "亚类", on: false, band: true },
      { key: "tl", label: "土类", on: false, band: true },
      { key: "admin", label: "行政区", on: false, band: true },
    ],
    show: { names: true, elev: true, zones: true, compass: true, axis: true, elevAxis: true },
    sourceMode: "draw",   // 断面数据来源：draw=自绘当前剖面 / import=导入线点文件
    boundsOverride: null,   // 手动分段边界（拖拽产生；null = 自动 maximin）
    labelOffsets: null,     // 地名手动放置偏移 { [no]: {dx,dy} }
    pointerPos: null,       // 方向指针手动位置
    cellSel: null,          // 当前选中格子
    rowBands: null,         // 行级独立分段 { [rowKey]: [{a,b,text},...] }（与土种格不对齐；相邻同值合并初始化）
    bandSel: null,          // 当前选中的行分段 { key, k }
    layout: { figW: 0, terrainH: 470, topPad: 1.28, stripH: 46, rowH: 58, fontScale: 1, fontScaleScope: "all", terrStyle: "soil", terrBandH: 0, terrLine: "color", terrLineColor: "#3f3a36", fontFamily: "", fontScope: "all", terr1: "#b0a99f", terr2: "#ccc7be", terr3: "#e5e2db" },
  },
  table: [],
  result: null,
  useCustom: false,
  profiles: [{ id: 1, name: "剖面 1", drawLine: [], drawPts: [] }],
  activeProfile: 1,
  nextProfileId: 2,
  // 图层面板（QGIS Contents 风格）：固定层 + 导入套层 + 剖面层
  layerList: [],          // [{id, kind:"base"|"dem"|"soil"|"imp"|"prof", sub, name, visible, fixed, profileId?, impId?, style?}]
  imports: [],            // 导入套 [{id, kind:"line"|"pts", name, path, layer, meta, lines?, points?, config, style}]
  genLineId: "",          // 生成用的导入线套 id
  genPtsId: "",           // 生成用的导入点套 id
  nextImpId: 1,
  map: { ov: null, mode: "view", draw: [], drawing: false, pts: [], drawHist: [], ptsHist: [], mouse: null, customLine: null, customPts: null, view: { z: 1, px: 0, py: 0 }, base: null, eRange: null, __panMoved: false, layers: { basemap: true, dem: true, soil: true, lines: true, points: true }, ptsLoaded: false, lodTimer: null, loading: false },
  builtin: { codes: [], colors: [], tlNames: [], colorByName: {}, codeByTz: {} },
  builtinCounty: null,   // 区县重编方案表（后端按土壤图面积生成）：{ codes, colorByName }
};

/* ---------------- 工具 ---------------- */
const $ = (id) => document.getElementById(id);
/* 页脚版权（年份取当前年）：主页页脚归位到 #app 末尾（避开弹窗嵌套），版权居中 */
(function fillCopyright() {
  const app = document.getElementById("app");
  const footer = document.getElementById("appFooter");
  if (app && footer && footer.parentElement !== app) app.appendChild(footer);
  const el = document.getElementById("appCopyright");
  if (el) el.textContent = `© ${new Date().getFullYear()} 贵州雏阳生态环保科技有限公司`;
})();
/* 窄输入框完整内容浮层：聚焦/输入时显示被截断的值（侧栏窄列、界线描述等），失焦即隐藏 */
(function initInputTip() {
  const tip = document.createElement("div");
  tip.id = "inputTip"; tip.style.display = "none";
  document.body.appendChild(tip);
  let cur = null;
  const show = (inp) => {
    if (inp !== cur) { cur = inp; }
    tip.textContent = inp.value || inp.placeholder || "";
    const r = inp.getBoundingClientRect();
    tip.style.display = "block";
    const tw = tip.offsetWidth, vw = window.innerWidth;
    tip.style.left = Math.max(8, Math.min(r.left, vw - tw - 8)) + "px";
    tip.style.top = Math.min(r.bottom + 5, window.innerHeight - tip.offsetHeight - 6) + "px";
  };
  const hide = () => { tip.style.display = "none"; cur = null; };
  document.addEventListener("focusin", e => {
    const t = e.target;
    if (t.tagName === "INPUT" && !["checkbox", "radio", "color", "button", "file", "range"].includes(t.type)) show(t);
  });
  document.addEventListener("focusout", () => setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) hide(); }, 80));
  document.addEventListener("input", e => {
    const t = e.target;
    if (t === cur) { tip.textContent = t.value || t.placeholder || ""; }
  }, true);
})();
function log(msg, kind = "info") {
  const t = new Date().toTimeString().slice(0, 8);
  $("logPre").textContent += `[${t}] ${msg}\n`;
  $("logPre").scrollTop = 1e9;
  if (kind === "err") $("statusLeft").textContent = "✖ " + msg;
  else $("statusLeft").textContent = msg;
}
function statusRight(txt) { $("statusRight").textContent = txt; }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function contrast(hex) {
  const h = hex.replace("#", "");
  if (h.length !== 6) return "#000";
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#000000" : "#ffffff";
}
/* 通用拖动排序（QGIS 图层树风格）：⠿ 手柄按住跟手拖动，插入线指示落点。
 * 纯指针实现（mousedown/mousemove/mouseup）——不用 HTML5 draggable：
 * Tauri/WebView2 会拦截原生 drag 会话（dragstart 不派发且吞掉后续鼠标事件），
 * draggable 反而导致完全拖不动。手柄 mousedown preventDefault 阻止文本选择拖动。
 * bindDragSort(容器, 行选择器, (fromIdx, toIdx) => {...})
 * 行元素需含 .gripd 手柄与 data-i 序号。容器级事件幂等（重渲染重复调用安全） */
function bindDragSort(host, itemSel, onReorder) {
  if (!host.__dragSort) {
    host.__dragSort = { itemSel, onReorder, fb: null };
    const st = host.__dragSort;
    const clearMarks = () => host.querySelectorAll(st.itemSel).forEach(r => r.classList.remove("drop-above", "drop-below", "dragging"));
    const markAt = (over, clientY) => {
      clearMarks();
      if (!over || +over.dataset.i === st.fromIdx) return;
      const r = over.getBoundingClientRect();
      over.classList.add(clientY < r.top + r.height / 2 ? "drop-above" : "drop-below");
    };
    const targetOf = (x, y) => {
      const els = document.elementsFromPoint(x, y) || [];
      for (const el of els) { const row = el.closest && el.closest(st.itemSel); if (row && host.contains(row)) return row; }
      return null;
    };
    document.addEventListener("mousemove", e => {
      const fb = st.fb;
      if (!fb || !fb.armed) return;
      if (!fb.active) {
        if (Math.hypot(e.clientX - fb.sx, e.clientY - fb.sy) < 6) return;
        fb.active = true;
        st.fromIdx = fb.from;
        fb.row.classList.add("dragging");
        document.body.style.cursor = "grabbing";
        e.preventDefault();
      }
      e.preventDefault();
      markAt(targetOf(e.clientX, e.clientY), e.clientY);
    }, { passive: false });
    document.addEventListener("mouseup", e => {
      const fb = st.fb;
      if (!fb) return;
      st.fb = null;
      document.body.style.cursor = "";
      if (fb.active) {
        const over = targetOf(e.clientX, e.clientY);
        if (over) {
          const r = over.getBoundingClientRect();
          let to = +over.dataset.i + (e.clientY >= r.top + r.height / 2 ? 1 : 0);
          if (to > st.fromIdx) to--;
          if (to !== st.fromIdx) st.onReorder(st.fromIdx, to);
        }
      }
      clearMarks();
      st.fromIdx = null;
    });
  }
  const st = host.__dragSort;
  st.itemSel = itemSel;
  st.onReorder = onReorder;
  host.querySelectorAll(itemSel).forEach(row => {
    const grip = row.querySelector(".gripd");
    if (!grip || row.__dragBound) return;
    row.__dragBound = true;
    grip.addEventListener("mousedown", e => {
      e.preventDefault();   // 阻止文本选择/图片拖动起始（防触发原生 drag 会话）
      st.fb = { sx: e.clientX, sy: e.clientY, from: +row.dataset.i, row, armed: true, active: false };
    });
  });
}

/* ---------------- GDAL 初始化 ---------------- */
async function initGdal(dir) {
  try {
    const info = await invoke("gdal_init", { dir });
    S.gdal.ok = true; S.gdal.version = info.version;
    const b = $("gdalBadge");
    b.textContent = "GDAL " + info.version.split(",")[0].replace("GDAL ", "");
    b.classList.add("on");
    log("GDAL 初始化成功: " + info.version);
  } catch (e) {
    S.gdal.ok = false;
    log("GDAL 初始化失败: " + e, "err");
    throw e;
  }
}

/* ---------------- 文件与图层 ---------------- */
async function pickVector(kind, pickDir = false) {
  const p = await invoke("dlg_open", {
    title: (pickDir ? "选择 GDB 目录（" : "选择") + ({ line: "断面线", points: "断面点", soil: "土壤图" }[kind]) + "）",
    filterName: "GIS 矢量", filterExt: "*.shp;*.geojson;*.json;*.gpkg", pickDir: pickDir,
  });
  if (!p) return;
  const src = S[kind === "line" ? "line" : kind === "points" ? "points" : "soil"];
  src.path = p.replace(/\\?\?/g, "");
  try {
    src.layers = await invoke("vector_layers", { path: src.path });
    src.layer = "";
    src.meta = null;
    log(`${kind} 文件已打开：${src.path}（${src.layers.length} 个图层）`);
    buildSidebar();
  } catch (e) { log("打开失败: " + e, "err"); }
}

async function useLayerNow(kind) {
  const src = S[kind]; const cfg = S.cfg;
  if (!src.path || !src.layer) return;
  const path = src.path, layer = src.layer;
  // 去重：同文件+图层已装载过则提示，避免重复套堆积
  const dup = S.imports.find(x => x.kind === (kind === "line" ? "line" : "pts") && x.path === path && x.layer === layer);
  if (dup) {
    log(`「${dup.name}」已装载过（选择现有套即可，未重复添加）`, "warn");
    return;
  }
  try {
    if (kind === "line") {
      src.meta = await invoke("use_line", { path, layer });
      if (src.meta.lines.length) {
        cfg.lineIndex = 0;
        cfg.filterValue = "";
      }
    } else if (kind === "points") {
      src.meta = await invoke("use_points", { path, layer });
    } else {
      if (!src.meta) autoMatchFields();   // 首次装载自动匹配字段别名
      src.meta = await invoke("use_soil", {
        path, layer,
        tl: cfg.soilTL, yl: cfg.soilYL, ts: cfg.soilTS, tz: cfg.soilTZ,
        admin: cfg.soilAdmin, lithology: cfg.soilLith, geo: cfg.soilGEO,
      });
    }
    if (kind === "soil") autoMatchFields();
    log(`图层已装载：${layer}（${src.meta.count} 要素，EPSG:${src.meta.epsg ?? "?"}）`);
    if (kind === "soil") { buildSidebar(); return; }
    // 线/点：创建新导入套（多套并存，追加到图层面板），并自动设为生成用套
    try {
      const lg = await invoke("layer_geojson", { kind });
      // 坐标系防御：epsg 未知或坐标像投影米制（显示/高程会错位）——明确提示而非静默错绘
      const firstPt = kind === "line" ? (lg.lines || [])[0]?.[0] : (lg.points || [])[0];
      if (!src.meta.epsg) {
        log(`⚠「${layer}」缺少坐标系定义（.prj）${firstPt && (Math.abs(firstPt[0]) > 360 || Math.abs(firstPt[1]) > 360) ? "，且坐标为投影米制——无法当经纬度使用，请先在 GIS 中为其定义坐标系后重试" : "——将按经纬度处理"}`, "err");
      }
      const impId = "imp" + (S.nextImpId++);
      const imp = {
        id: impId,
        kind: kind === "line" ? "line" : "pts",
        name: `${path.split(/[\\/]/).pop()}（${kind === "line" ? "线" : "点"}）`,
        path, layer,
        meta: src.meta,
        lines: kind === "line" ? (lg.lines || []) : [],
        points: kind === "points" ? (lg.points || []) : [],
        config: kind === "pts"
          ? { noField: cfg.ptNoField, nameField: cfg.ptNameField, filterMode: cfg.filterMode, filterField: cfg.filterField, filterValue: cfg.filterValue, filterDist: cfg.filterDist }
          : { lineIndex: cfg.lineIndex },
        style: kind === "line" ? { color: "#d40000", width: 2.4 } : { color: "#1a1a1a", size: 6 },
      };
      S.imports.push(imp);
      S.layerList.unshift({ id: impId, kind: "imp", sub: imp.kind, name: imp.name, visible: true, fixed: false, impId, style: imp.style });
      if (kind === "line") S.genLineId = impId; else S.genPtsId = impId;
      log(`导入套已添加：${imp.name}（${imp.kind === "line" ? (imp.lines.length + " 条线") : (imp.points.length + " 个点")}，已设为生成用）`);
      if (ML && S.map.ov) {
        ensureDynamicSource(S.layerList[0]);   // 新导入套置于列表顶部（QGIS：新层在顶）
        updateDrawSources();
        applyLayerOrder();
      }
    } catch (e2) { log(`线/点坐标提取失败: ${e2}`, "err"); }
    buildSidebar();
    if (S.genLineId && S.genPtsId &&
        S.imports.find(i => i.id === S.genLineId) && S.imports.find(i => i.id === S.genPtsId)) {
      S.cfg.sourceMode = "import";   // 线点套齐备自动切导入模式（生成弹层可随时换）
      S.useCustom = false;
      buildSidebar();
      computeDebounced();
    }
  } catch (e) { log("装载图层失败: " + e, "err"); }
}

async function pickDem() {
  const p = await invoke("dlg_open", { title: "选择 DEM 栅格", filterName: "GeoTIFF", filterExt: "*.tif;*.tiff" });
  if (!p) return;
  S.dem.path = p;
  S.dem.meta = null;   // 待「载入底图」统一装载
  buildSidebar();
  log(`DEM 已选择：${p}（点击「载入并渲染地图」生效）`);
}

/* ---------------- 计算请求 ---------------- */
function buildReq() {
  const c = S.cfg;
  return {
    use_custom: !!S.useCustom,
    code_scheme: c.codeScheme || "province",
    sample_interval_m: +c.sampleStep || 20,
    extend_m: +c.extendsM || 0,
    smoothing: +c.smoothing || 0,
    orientation: c.orientation,
    ve: c.veAuto ? null : +c.ve || null,
    line_index: +c.lineIndex || 0,
    point_name_field: c.ptNameField,
    point_no_field: c.ptNoField,
    point_filter: {
      mode: c.filterMode,
      field: c.filterField,
      value: c.filterValue,
      max_dist_m: +c.filterDist || 600,
    },
    zones: c.zones.filter(z => z.elev).map(z => ({ elev: +z.elev, name: z.name, color_key: z.key })),
    // 自绘模式：点已由 set_custom_points 全量提交（吸附/增减即时生效），
    // 不再叠加表格 override（避免后端按旧 no 过滤/补回造成点数不同步）
    points_override: S.useCustom ? [] : S.table.map(r => ({
      no: r.no, name: r.name, elev: r.elev, ch_km: r.ch,
      code: r.code, tz: r.tz, ts: r.ts, yl: r.yl, tl: r.tl,
      admin: r.admin, lith: r.lith, color: "",
    })),
  };
}

async function compute(manual = false) {
  const baseReady = S.soil.meta && S.dem.meta;
  if (baseReady && S.cfg.sourceMode !== "import") S.useCustom = true;    // draw 模式始终自绘
  if (baseReady && S.cfg.sourceMode === "import") S.useCustom = false;   // import 模式用文件
  const ready = baseReady && (S.useCustom || (S.line.meta && S.points.meta));
  if (!ready) {
    if (manual) log(baseReady
      ? (S.cfg.sourceMode === "import"
        ? "请装载断面线/点（侧栏④「导入线/点」）"
        : `当前剖面「${currentProfile().name}」尚未自绘：请在地图工作台画线布点后点「用作断面并生成」`)
      : "请先在「② 数据源」装载土壤图与 DEM 高程", "err");
    return;
  }
  // ---- 数据源指纹：源切换（自绘↔导入、换剖面、换图层/字段）即失效旧表格 ----
  // 否则旧表作为 points_override 会篡改/丢弃新源的同号点（耦合缺陷根源）
  const c2 = S.cfg;
  const srcKey = S.useCustom
    ? `custom|${S.activeProfile}`
    : `file|${S.line.path}|${S.line.layer}|${c2.lineIndex}|${S.points.path}|${S.points.layer}|${c2.ptNoField}|${c2.ptNameField}`;
  const srcChanged = S.__srcKey !== undefined && S.__srcKey !== srcKey;
  S.__srcKey = srcKey;
  if (srcChanged) {
    S.table = [];
    if (manual) log("数据源已切换：断面点表格按新源重建");
  }
  try {
    const res = await invoke("compute_section", { req: buildReq() });
    S.result = res;
    mergeTable(res);
    // 自绘模式：表格人工编辑行（manual）属性回填计算结果——后端不接收 override，
    // 否则重算会用旧提取值覆盖前端编辑（图/表不一致根因）
    if (S.useCustom) {
      const tblB = S.cfg.codeScheme === "county" && S.builtinCounty ? S.builtinCounty : S.builtin;
      S.table.forEach(row => {
        if (!row || !row.manual) return;
        const noS = String(row.no);
        const pR = res.points.find(q => String(q.no) === noS);
        const sgR = res.segments.find(q => String(q.no) === noS);
        for (const f of ["name", "tz", "ts", "yl", "tl", "geo", "admin", "lith", "code"]) {
          const v = row[f];
          if (v != null && v !== "") {
            if (pR && f in pR) pR[f] = v;
            if (sgR && f in sgR) sgR[f] = v;
          }
        }
        if (pR && row.elev != null && row.elev !== "") pR.elev = row.elev;
        if (sgR && row.tz) {
          const rec = (tblB.codes || []).find(r2 => r2.tz === row.tz);
          if (rec) sgR.code = rec.code;
          const col = (tblB.colorByName || {})[row.tz] || (rec && (tblB.colorByName || {})[rec.tl]);
          if (col) sgR.color = col;
        }
      });
    }
    renderFigure(res);
    // 默认开启跨格合并的行：首次生成（渲染上下文就绪后）自动初始化分段；已有分段仅刷新文字
    let bandInit = false;
    if (!S.cfg.rowBands) S.cfg.rowBands = {};
    S.cfg.rows.forEach(r => {
      if (r.band && !S.cfg.rowBands[r.key]) {
        const sg = initBandSegs(r);
        if (sg) { S.cfg.rowBands[r.key] = sg; bandInit = true; }
      }
    });
    // 点集结构变化（删行/加点：no 集合与快照不符）→ band 分段按新格重建，
    // 否则旧快照与新 segments 错位，图上色带/土种编号/颜色不随删点更新
    const nosNow = new Set(res.points.map(q => String(q.no)));
    Object.keys(S.cfg.rowBands).forEach(key => {
      const arr = S.cfg.rowBands[key];
      if (!Array.isArray(arr) || !arr.length) return;
      const stale = arr.some(sg => sg.no != null && !nosNow.has(String(sg.no)))
        || res.points.some(q => !arr.some(sg => String(sg.no) === String(q.no)));
      if (stale) {
        const rw = S.cfg.rows.find(r => r.key === key);
        if (rw && rw.band) {
          const sg = initBandSegs(rw);
          if (sg) { S.cfg.rowBands[key] = sg; bandInit = true; }
        }
      }
    });
    Object.keys(S.cfg.rowBands).forEach(refreshBandTexts);   // band 段文字跟随表格/推导刷新
    if (bandInit) renderFigure(res);
    $("previewEmpty").style.display = "none";
    statusRight(`断面 ${res.total_km.toFixed(2)} km · ${res.sample_count} 采样点 · ${res.points.length} 断面点 · VE ×${res.ve}`);
    if (manual) log(`断面计算完成：${res.total_km.toFixed(2)}km，方位 ${res.wind}${res.azimuth.toFixed(0)}°${res.flip ? "（已翻转）" : ""}`);
    renderPointsTable();
    if (manual) {
      openFigModal();
      buildSidebar();
    }
  } catch (e) {
    log("计算失败: " + e, "err");
  }
}
const computeDebounced = debounce(() => compute(false), 420);

/* 用计算结果同步表格（保留人工修改/删除；新增数据点追加） */
function mergeTable(res) {
  // 同步语义：以计算结果为基准——新增点追加、消失点删除（换剖面/换来源后表格不残留旧点）；
  // 已存在的行保留（含人工编辑），并刷新数据侧字段（里程/海拔）
  const byNo = new Map(S.table.map(r => [String(r.no), r]));
  const next = [];
  for (const p of res.points) {
    const old = byNo.get(String(p.no));
    if (old && old.manual) {
      // 人工编辑行：仅刷新里程/海拔，其余保留
      old.ch = +p.ch_km.toFixed(3);
      old.elev = +p.elev.toFixed(1);
      next.push(old);
    } else if (old) {
      // 数据行：全量刷新（换剖面后同名号是新点——名字/土种等一律以新结果为准）
      old.name = p.name;
      old.ch = +p.ch_km.toFixed(3);
      old.elev = +p.elev.toFixed(1);
      old.code = p.code; old.tz = p.tz; old.ts = p.ts; old.yl = p.yl; old.tl = p.tl;
      old.geo = p.geo || ""; old.profile = p.profile || "";
      old.admin = p.admin || ""; old.lith = p.lith || "";
      next.push(old);
    } else {
      next.push({
        no: p.no, name: p.name, ch: +p.ch_km.toFixed(3), elev: +p.elev.toFixed(1),
        code: p.code, tz: p.tz, ts: p.ts, yl: p.yl, tl: p.tl,
        geo: (p.geo || ""), profile: (p.profile || ""),
        admin: p.admin || "", lith: p.lith || "", manual: false, deleted: false,
      });
    }
  }
  S.table = next;
  S.table.sort((a, b) => a.ch - b.ch);
}

/* ---------------- 字段自动匹配：按别名自动选择土壤/行政区/母质字段 ---------------- */
const FIELD_AUTO = {
  soilTL: ["土类", "TL", "土壤类型", "土类名称"],
  soilYL: ["亚类", "YL", "亚类名称"],
  soilTS: ["土属", "TS", "土属名称"],
  soilTZ: ["土种", "TZ", "土种名称", "土名"],
  soilAdmin: ["乡镇", "XZQMC", "行政区", "行政区划", "县乡村", "XZ", "XZMC"],
  soilLith: ["母岩", "母质", "母岩母质", "母质名称", "MZMC", "成土母质", "母岩类型"],
  soilGEO: ["地貌", "地貌类型", "地貌名称", "GEO", "DM", "DMLX", "地貌部位"],
};
function autoMatchFields() {
  const c = S.cfg;
  const fields = (S.soil.meta && S.soil.meta.fields) || [];
  const pick = (alts) => alts.find(a => fields.includes(a)) || "";
  c.soilTL = pick(FIELD_AUTO.soilTL);
  c.soilYL = pick(FIELD_AUTO.soilYL);
  c.soilTS = pick(FIELD_AUTO.soilTS);
  c.soilTZ = pick(FIELD_AUTO.soilTZ);
  c.soilAdmin = pick(FIELD_AUTO.soilAdmin);
  c.soilLith = pick(FIELD_AUTO.soilLith);
  c.soilGEO = pick(FIELD_AUTO.soilGEO);
}

/* ---------------- 图层面板（QGIS Contents 风格） ---------------- */
function initLayerList() {
  // 初始仅影像底图；DEM/土壤图在装载后按需加入（ensureBaseLayerItems），
  // 剖面/导入套在创建时加入——新图层一律插到列表顶部（QGIS 惯例：列表顶 = 地图顶层）
  if (!S.layerList.find(x => x.kind === "base")) {
    S.layerList.unshift({ id: "ly-base", kind: "base", name: "天地图影像", visible: true, fixed: true });
  }
  // 有线/点的剖面（启动/打开项目）恢复为图层项；空剖面不占图层
  for (const pr of S.profiles) {
    if ((pr.drawLine.length || pr.drawPts.length) && !S.layerList.find(x => x.kind === "prof" && x.profileId === pr.id)) {
      S.layerList.unshift({ id: "lyp-" + pr.id, kind: "prof", name: `${pr.name}（线/点）`, visible: true, fixed: false, profileId: pr.id, style: pr.style || { color: "#ffd400", width: 2.4, size: 6 } });
    }
  }
}
/* 侧栏③剖面统计实时刷新（不重建整个侧栏，避免闪烁/丢焦点） */
function updateProfileStat() {
  const pr = currentProfile();
  const el = document.querySelector("#sidebar .ds-stat");
  if (el) el.innerHTML = `线 ${pr.drawLine.length} 顶点 · 点 ${pr.drawPts.length} 个<span title="在地图工具栏选择「✏ 画断面线」「📍 布点」绘制，归属当前剖面">ⓘ</span>`;
}
/* 「✓ 完成」：结束画线/布点编辑，保存到当前剖面并刷新侧栏统计 */
function finishDrawing() {
  const pr = currentProfile();
  S.map.drawing = false;
  const v = document.querySelector('input[name=mapmode][value=view]');
  if (v) v.checked = true;
  S.map.mode = "view";
  const cv = ML && ML.map && ML.map.getCanvas();
  if (cv) cv.style.cursor = "";
  syncMapToProfile();
  updateDrawSources();
  updateProfileStat();
  if (!pr.drawLine.length && !pr.drawPts.length) {
    $("mapStatus").textContent = "当前剖面尚无绘制内容";
    log(`剖面「${pr.name}」尚无线/点，无内容可保存`);
    return;
  }
  $("mapStatus").textContent = `「${pr.name}」编辑已保存：线 ${pr.drawLine.length} 顶点 · 点 ${pr.drawPts.length} 个`;
  log(`✓ 剖面「${pr.name}」编辑完成并保存（线 ${pr.drawLine.length} 顶点 · 点 ${pr.drawPts.length} 个）`);
}
/* 剖面开始绘制时确保其图层项存在（置于顶部） */
function ensureProfileLayerItem(pr) {
  if (S.layerList.find(x => x.kind === "prof" && x.profileId === pr.id)) return;
  S.layerList.unshift({ id: "lyp-" + pr.id, kind: "prof", name: `${pr.name}（线/点）`, visible: true, fixed: false, profileId: pr.id, style: pr.style || { color: "#ffd400", width: 2.4, size: 6 } });
  if (ML && S.map.ov) { ensureDynamicSource(S.layerList[0]); bindProfilePtEvents(); applyLayerOrder(); }
  renderLayerPanel();
}
/* DEM/土壤图装载后加入图层列表（顶部）；未装载不出现 */
function ensureBaseLayerItems() {
  let added = false;
  if (S.dem.meta && !S.layerList.find(x => x.kind === "dem")) {
    S.layerList.unshift({ id: "ly-dem", kind: "dem", name: "DEM 高程", visible: true, fixed: false });
    added = true;
  }
  if (S.soil.meta && !S.layerList.find(x => x.kind === "soil")) {
    S.layerList.unshift({ id: "ly-soil", kind: "soil", name: "土壤类型图", visible: true, fixed: false });
    added = true;
  }
  if (added) applyLayerOrder();
}
/* 渲染顺序引擎：图层列表顶 = 地图最上层（QGIS 惯例）。
 * moveLayer(id) 把层移到最顶：按期望自顶向下序列逆序处理，最终序列首在顶 */
function applyLayerOrder() {
  const ml = ML;
  if (!ml || !ml.map.getLayer) return;
  const map = ml.map;
  // layerMapIds 返回自底向上顺序；列表顶 = 地图顶层（QGIS 惯例）。
  // 期望自顶向下序列 = 每组内反转、组间按列表正序；逆序逐个 moveLayer(id)（移到最顶）
  const seq = [];
  for (const it of S.layerList) {
    seq.push(...layerMapIds(it).slice().reverse());
  }
  for (let i = seq.length - 1; i >= 0; i--) {
    if (map.getLayer(seq[i])) map.moveLayer(seq[i]);
  }
  // 工具层（测距线/预览/节点）不属于图层数据，永远置顶，避免被影像/DEM 盖住
  for (const tl of ["meas-line", "meas-prev", "meas-pts"]) {
    if (map.getLayer(tl)) map.moveLayer(tl);
  }
}
function layerMapIds(it) {
  if (it.kind === "prof") return ["pl-" + it.profileId, "pp-" + it.profileId];
  if (it.kind === "imp") return [(it.sub === "line" ? "il-" : "ip-") + it.impId];
  if (it.kind === "base") return ["tdt-img-l", "tdt-cia-l"];
  if (it.kind === "dem") return ["dem-l"];
  return ["soil-fill", "soil-line"];
}
function layerColorOf(it) {
  const st = it.style || {};
  if (it.kind === "prof") return st.color || "#ffd400";
  if (it.kind === "imp") return st.color || (it.sub === "line" ? "#d40000" : "#1a1a1a");
  return { base: "#8a8f98", dem: "#5c8c3e", soil: "#c8b89a" }[it.kind] || "#888";
}
function renderLayerPanel() {
  const host = $("layerList");
  if (!host) return;
  initLayerList();
  host.innerHTML = S.layerList.map((it, i) => {
    const geo = it.kind === "prof" || it.kind === "imp";
    const st = it.style || {};
    const w = st.width || (it.sub === "line" || it.kind === "prof" ? 2.4 : 6);
    const s = st.size || 6;
    return `<div class="ly-row" data-lyid="${it.id}" data-i="${i}">
      <span class="gripd" title="拖动调整渲染顺序（上层先绘制，位于底部）">⠿</span>
      <label class="ly-ckbox" title="显示/隐藏"><input type="checkbox" class="ly-ck" ${it.visible ? "checked" : ""}/></label>
      <input type="color" class="ly-color" value="${layerColorOf(it)}" ${geo ? "" : "disabled"}/>
      <span class="ly-name" title="双击名称重命名 / 双击空白处展开样式">${esc(it.name)}</span>
      <button class="btn tiny" data-lyact="zoom" title="缩放到图层">⇱</button>
      ${geo ? `<button class="btn tiny danger" data-lyact="rm" title="移除图层">✕</button>` : ""}
    </div>${geo ? `<div class="ly-style" id="lysty-${it.id}" style="display:none">
      <label>线宽 <input type="number" class="ly-w" min="0.5" max="12" step="0.2" value="${w}"/></label>
      ${it.kind === "prof" || it.sub === "pts" ? `<label>点大小 <input type="number" class="ly-s" min="2" max="20" step="1" value="${s}"/></label>` : ""}
    </div>` : ""}`;
  }).join("");
  host.querySelectorAll(".ly-ck").forEach(ck => ck.onchange = () => setLayerVisible(ck.closest(".ly-row").dataset.lyid, ck.checked));
  host.querySelectorAll(".ly-color").forEach(inp => inp.oninput = () => setLayerStyle(inp.closest(".ly-row").dataset.lyid, { color: inp.value }));
  host.querySelectorAll(".ly-w").forEach(inp => inp.onchange = () => setLayerStyle(inp.closest(".ly-row").dataset.lyid, { width: +inp.value }));
  host.querySelectorAll(".ly-s").forEach(inp => inp.onchange = () => setLayerStyle(inp.closest(".ly-row").dataset.lyid, { size: +inp.value }));
  host.querySelectorAll(".ly-name").forEach(nm => nm.ondblclick = () => {
    const id = nm.closest(".ly-row").dataset.lyid;
    const it = S.layerList.find(x => x.id === id);
    if (!it) return;
    const st = $("lysty-" + id);
    if (st) st.style.display = st.style.display === "none" ? "" : "none";
    if (st && st.style.display === "none") {
      const n = prompt("图层名称：", it.name);
      if (n) { it.name = n; renderLayerPanel(); }
    }
  });
  host.querySelectorAll("button[data-lyact]").forEach(btn => btn.onclick = () => {
    const id = btn.closest(".ly-row").dataset.lyid;
    const act = btn.dataset.lyact;
    if (act === "zoom") zoomToLayer(id);
    else if (act === "rm") removeLayerItem(id);
  });
  // 拖动排序（QGIS 风格）：列表顺序 = 渲染顺序
  bindDragSort(host, ".ly-row", (from, to) => {
    const [it] = S.layerList.splice(from, 1);
    S.layerList.splice(to, 0, it);
    rebuildDynamicLayers();
    renderLayerPanel();
  });
}
function setLayerVisible(id, vis) {
  const it = S.layerList.find(x => x.id === id);
  if (!it) return;
  it.visible = vis;
  const ml = ML;
  if (!ml || !ml.map.getLayer) return;
  const map = ml.map, vs = vis ? "visible" : "none";
  layerMapIds(it).forEach(l => map.getLayer(l) && map.setLayoutProperty(l, "visibility", vs));
  if (it.kind === "dem") { const el = $("elevLegend"); if (el) el.style.display = vis ? "block" : "none"; }
}
function setLayerStyle(id, st) {
  const it = S.layerList.find(x => x.id === id);
  if (!it) return;
  it.style = Object.assign({}, it.style || {}, st);
  if (it.kind === "prof") { const pr = S.profiles.find(x => x.id === it.profileId); if (pr) pr.style = it.style; }
  if (it.kind === "imp") { const im = S.imports.find(x => x.id === it.impId); if (im) im.style = it.style; }
  applyLayerStyle(it);
}
function applyLayerStyle(it) {
  const ml = ML;
  if (!ml || !ml.map.getLayer) return;
  const map = ml.map;
  const paint = (l, p, v) => map.getLayer(l) && map.setPaintProperty(l, p, v);
  const st = it.style || {};
  if (it.kind === "prof") {
    paint("pl-" + it.profileId, "line-color", layerColorOf(it));
    paint("pl-" + it.profileId, "line-width", st.width || 2.4);
    paint("pp-" + it.profileId, "circle-color", layerColorOf(it));
    paint("pp-" + it.profileId, "circle-radius", st.size || 6);
  } else if (it.kind === "imp") {
    if (it.sub === "line") { paint("il-" + it.impId, "line-color", layerColorOf(it)); paint("il-" + it.impId, "line-width", st.width || 2.4); }
    else { paint("ip-" + it.impId, "circle-color", layerColorOf(it)); paint("ip-" + it.impId, "circle-radius", st.size || 6); }
  }
}
/* 确保某动态图层项的地图源/层存在（源 id 与层 id 同名） */
function ensureDynamicSource(it) {
  const ml = ML;
  if (!ml || !ml.map.getSource) return;
  const map = ml.map;
  for (const lid of layerMapIds(it)) {
    if (map.getSource(lid)) continue;
    const isLine = lid.startsWith("pl") || lid.startsWith("il");
    if (isLine) {
      map.addSource(lid, { type: "geojson", data: emptyFC() });
      map.addLayer({ id: lid, type: "line", source: lid, paint: { "line-color": layerColorOf(it), "line-width": (it.style && it.style.width) || 2.4 } });
    } else {
      map.addSource(lid, { type: "geojson", data: emptyFC() });
      map.addLayer({ id: lid, type: "circle", source: lid, paint: { "circle-radius": (it.style && it.style.size) || 6, "circle-color": layerColorOf(it), "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
    }
    if (!it.visible) map.setLayoutProperty(lid, "visibility", "none");
  }
}
function rebuildDynamicLayers() {
  const ml = ML;
  if (!ml || !ml.map.getSource) return;
  const map = ml.map;
  const dyn = S.layerList.filter(x => x.kind === "prof" || x.kind === "imp");
  const ids = dyn.map(layerMapIds).flat();
  ids.forEach(l => map.getLayer(l) && map.removeLayer(l));
  ids.forEach(l => map.getSource(l) && map.removeSource(l));
  dyn.forEach(ensureDynamicSource);
  updateDrawSources();
  dyn.forEach(applyLayerStyle);
  applyLayerOrder();   // 列表顶 = 地图顶层
}
function zoomToLayer(id) {
  const it = S.layerList.find(x => x.id === id);
  if (!it || !ML) return;
  let pts = [];
  if (it.kind === "prof") { const pr = S.profiles.find(x => x.id === it.profileId); pts = pr ? [...pr.drawLine, ...pr.drawPts.map(p => [p[0], p[1]])] : []; }
  else if (it.kind === "imp") { const im = S.imports.find(x => x.id === it.impId); pts = im ? ((im.lines || []).flat().concat(im.points || [])) : []; }
  else if ((it.kind === "soil" || it.kind === "dem") && S.map.ov && S.map.ov.bounds) {
    pts = [[S.map.ov.bounds[0], S.map.ov.bounds[1]], [S.map.ov.bounds[2], S.map.ov.bounds[3]]];
  }
  if (!pts.length) return;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const lo = Math.min(...xs), hi = Math.max(...xs), la = Math.min(...ys), ha = Math.max(...ys);
  if (isFinite(lo) && isFinite(la)) ML.map.fitBounds([[lo, la], [hi, ha]], { padding: 30 });
}
function removeLayerItem(id) {
  const it = S.layerList.find(x => x.id === id);
  if (!it || it.fixed) return;
  if (!confirm(`移除图层「${it.name}」？`)) return;
  const ml = ML;
  if (ml && ml.map.getLayer) {
    layerMapIds(it).forEach(l => ml.map.getLayer(l) && ml.map.removeLayer(l));
    layerMapIds(it).forEach(l => ml.map.getSource(l) && ml.map.removeSource(l));
  }
  S.layerList = S.layerList.filter(x => x.id !== id);
  if (it.kind === "prof") {
    const pr = S.profiles.find(x => x.id === it.profileId);
    if (pr && S.profiles.length > 1) {
      S.profiles = S.profiles.filter(x => x.id !== pr.id);
      if (S.activeProfile === pr.id) { S.activeProfile = S.profiles[0].id; syncProfileToMap(); }
    } else if (pr) { pr.drawLine = []; pr.drawPts = []; }
  } else if (it.kind === "imp") {
    S.imports = S.imports.filter(x => x.id !== it.impId);
    if (S.genLineId === it.impId) S.genLineId = "";
    if (S.genPtsId === it.impId) S.genPtsId = "";
  }
  buildSidebar();
  log(`已移除图层「${it.name}」`);
}
/* 已装载导入套列表（⑤组内，点击设置生成用套） */
function renderImpList() {
  const host = $("impList");
  if (!host) return;
  if (!S.imports.length) { host.innerHTML = '<div class="ds-file" style="display:block;text-align:center">尚无导入套</div>'; return; }
  host.innerHTML = S.imports.map(im => {
    const gen = (im.kind === "line" ? S.genLineId : S.genPtsId) === im.id;
    return `<div class="imp-row ${gen ? "sel" : ""}" data-iid="${im.id}" title="点击设为生成用${im.kind === "line" ? "线" : "点"}套">
      <span class="tag">${im.kind === "line" ? "线" : "点"}</span>
      <span class="ly-name">${esc(im.name)}</span>${gen ? "<b class=\"gen-tag\">生成用</b>" : ""}
    </div>`;
  }).join("");
  host.querySelectorAll(".imp-row").forEach(r => r.onclick = () => {
    const im = S.imports.find(x => x.id === r.dataset.iid);
    if (!im) return;
    if (im.kind === "line") S.genLineId = im.id; else S.genPtsId = im.id;
    renderImpList();
  });
}

/* ---------------- 侧栏 ---------------- */
function group(title, bodyHtml, open = true, id = "") {
  // 折叠状态记忆：用户手动展开/折叠后，重建侧栏（导入图层等）不重置
  S.__grp = S.__grp || {};
  const closed = Object.prototype.hasOwnProperty.call(S.__grp, title) ? S.__grp[title] : !open;
  return `<section class="group ${closed ? "closed" : ""}" data-g="${esc(title)}" ${id ? `id="${id}"` : ""}>
    <div class="ghead"><span class="arrow">▼</span>${title}</div>
    <div class="gbody">${bodyHtml}</div></section>`;
}
function selectHtml(id, options, cur) {
  return `<select id="${id}">${options.map(o =>
    `<option value="${esc(o.v)}" ${o.v === cur ? "selected" : ""}>${esc(o.t)}</option>`).join("")}</select>`;
}

function buildSidebar() {
  const c = S.cfg;
  const layerSel = (kind) => {
    const src = S[kind];
    const opts = [{ v: "", t: "— 选择图层 —" }, ...src.layers.map(l => ({ v: l.name, t: `${l.name} (${l.count})` }))];
    return selectHtml(`sel-${kind}-layer`, opts, src.layer);
  };
  const fopts = (meta, cur) => [{ v: "", t: "（无）" }, ...(meta?.fields || []).map(f => ({ v: f, t: f }))];

  const baseReady = !!(S.soil.meta && S.dem.meta);
  const pr0 = S.profiles.find(x => x.id === S.activeProfile) || S.profiles[0];
  const lineOk = pr0.drawLine.length >= 2 && pr0.drawPts.length >= 1;
  const impOk = !!(S.line.meta && S.points.meta);
  const shortName = (p) => p ? p.split(/[\\/]/).pop() : "";
  const fldAuto = [["soilTL", "土类"], ["soilYL", "亚类"], ["soilTS", "土属"], ["soilTZ", "土种"], ["soilAdmin", "行政区"], ["soilLith", "母岩母质"], ["soilGEO", "地貌类型"]];
  const fldHit = fldAuto.filter(([k]) => c[k]).length;
  const html = [
    group("① 图层", `<div id="layerList"></div>`, true),

    ...(S.gdal.ok ? [] : [group(`GDAL 运行时`, `
      <div class="row"><label>DLL 目录</label>
        <input type="text" class="fill" id="gdalDir" value="${esc(S.gdal.dir)}" placeholder="含 gdal*.dll 的目录"/>
        <button class="btn small" id="btnGdalInit">初始化</button></div>`)]),

    group(`${baseReady ? "✔" : ""}② 数据源`, `
      <div class="ds-row" title="土壤类型图（.shp/.gdb），供土种提取与着色">
        <span class="ds-name">土壤图</span>
        <button class="btn small" id="pick-soil">文件</button>
        <button class="btn small" id="pickdir-soil" title="选择 .gdb 目录">GDB</button>
        <span class="fill">${layerSel("soil")}</span>
      </div>
      <div class="ds-row" title="DEM 高程（GeoTIFF）">
        <span class="ds-name">DEM</span>
        <button class="btn small" id="pick-dem">文件</button>
        <span class="ds-file${S.dem.meta ? " ok" : ""}" title="${esc(S.dem.path)}${S.dem.meta ? ` · ${S.dem.meta.xsize}×${S.dem.meta.ysize} · ${S.dem.meta.emin.toFixed(0)}~${S.dem.meta.emax.toFixed(0)} m` : ""}">${S.dem.path ? (shortName(S.dem.path) + (S.dem.meta ? " ✔" : "")) : "未选择"}</span>
      </div>
      <button class="btn small primary" id="btnLoadBase" style="width:100%;margin:5px 0 2px">${baseReady ? "↻ 重新载入" : "⭳ 载入并渲染地图"}</button>
      <details class="adv" id="advSoilFields" title="土壤图属性字段映射（装载时自动匹配，可改）">
        <summary>字段映射<span class="adv-tag">${fldHit ? `已匹配 ${fldHit}/7` : "待设置"}</span></summary>
        ${fldAuto.map(([k, t]) => `<div class="row"><label>${t}</label><span class="fill">${selectHtml("sel-soil" + { soilTL: "TL", soilYL: "YL", soilTS: "TS", soilTZ: "TZ", soilAdmin: "AD", soilLith: "LI", soilGEO: "GE" }[k], fopts(S.soil.meta, c[k]), c[k])}</span></div>`).join("")}
      </details>`, !baseReady),

    group(`${lineOk ? "✔" : ""}③ 剖面（地图绘制）`, `
      <div class="ds-row">
        <span class="fill">${selectHtml("selProfile", S.profiles.map(pr => ({ v: pr.id, t: `${pr.name}（${pr.drawPts.length} 点）` })), S.activeProfile)}</span>
        <button class="btn small" id="btnProfileAdd" title="新建剖面">＋</button>
        <button class="btn small danger" id="btnProfileDel" title="删除当前剖面">✕</button>
      </div>
      <button class="btn small" id="btnProfileExport" title="导出当前剖面的断面线与断面点为 GeoJSON（WGS84，可再导入使用）" style="width:100%;margin:4px 0">⇩ 导出断面线/点（GeoJSON）</button>
      <div class="ds-stat">线 ${pr0.drawLine.length} 顶点 · 点 ${pr0.drawPts.length} 个<span title="在地图工具栏选择「✏ 画断面线」「📍 布点」绘制，归属当前剖面">ⓘ</span></div>`, true),

    group(`${impOk ? "✔" : ""}④ 导入线/点`, `
      <div class="ds-row" title="断面线文件（.shp/.gdb），装载后成为导入图层">
        <span class="ds-name">线</span>
        <button class="btn small" id="pick-line">文件</button>
        <button class="btn small" id="pickdir-line" title="选择 .gdb 目录">GDB</button>
        <span class="fill">${layerSel("line")}</span>
        <button class="btn small primary" id="btnLoadLine" title="装载为新导入图层（可多套并存）">＋</button>
      </div>
      <div class="ds-row" title="断面点文件（.shp/.gdb），装载后成为导入图层">
        <span class="ds-name">点</span>
        <button class="btn small" id="pick-points">文件</button>
        <button class="btn small" id="pickdir-points" title="选择 .gdb 目录">GDB</button>
        <span class="fill">${layerSel("points")}</span>
        <button class="btn small primary" id="btnLoadPts" title="装载为新导入图层（可多套并存）">＋</button>
      </div>
      <details class="adv" id="advImpConf" title="导入属性：线要素 / 点字段 / 点筛选（装载点套前设置）">
        <summary>线要素与点属性<span class="adv-tag">${S.points.meta ? "已配置" : "待设置"}</span></summary>
        <div class="row" id="lineFeatSel"><label>线要素</label><span class="fill">${
          S.line.meta ? selectHtml("sel-linefeat",
            S.line.meta.lines.map(l => ({ v: l.index, t: `线${l.index + 1} ${l.label ? "· " + l.label : ""} (${l.len_km} km)` })), c.lineIndex) : '<span class="ds-file">待装载</span>'
        }</span></div>
        <div class="row"><label>编号字段</label><span class="fill">${selectHtml("sel-ptno", fopts(S.points.meta, c.ptNoField), c.ptNoField)}</span></div>
        <div class="row"><label>地名字段</label><span class="fill">${selectHtml("sel-ptname", fopts(S.points.meta, c.ptNameField), c.ptNameField)}</span></div>
        <div class="row"><label>点筛选</label>
          <label class="mini"><input type="radio" name="fmode" value="field" ${c.filterMode === "field" ? "checked" : ""}/> 按字段</label>
          <label class="mini"><input type="radio" name="fmode" value="all" ${c.filterMode === "all" ? "checked" : ""}/> 全部投影</label></div>
        <div class="row" id="fmodeFieldRow"><label>字段/值</label>
          <span class="fill">${selectHtml("sel-ffield", fopts(S.points.meta, c.filterField), c.filterField)}</span>
          <input type="text" id="fvalue" value="${esc(c.filterValue)}" style="width:80px" placeholder="值"/></div>
        <div class="row" id="fmodeAllRow" style="display:none"><label>距离 m</label>
          <input type="number" id="fdist" value="${c.filterDist}"/></div>
      </details>
      <div id="impList"></div>`, false),

  ];
  const modalHtml = [
    group("⑥ 断面参数", `
      <div class="row"><label>垂直夸张</label>
        <label class="mini"><input type="radio" name="ve" value="auto" ${c.veAuto ? "checked" : ""}/> 自动</label>
        <label class="mini"><input type="radio" name="ve" value="man" ${!c.veAuto ? "checked" : ""}/> 手动</label>
        <input type="number" id="cfgVe" value="${c.ve}" ${c.veAuto ? "disabled" : ""}/></div>
      <div class="row"><label>断面定向</label><span class="fill">${selectHtml("cfgOri", [
        { v: "high_left", t: "左高右低（默认）" }, { v: "high_right", t: "左低右高" }, { v: "as_line", t: "按线方向" }], c.orientation)}</span></div>
      <div class="row"><label>采样间距 m</label><input type="number" id="cfgStep" value="${c.sampleStep}" min="1"/><span class="mini">越小越精细</span></div>
      <div class="row"><label>两端外延 m</label><input type="number" id="cfgExt" value="${c.extendsM}" min="0" title="0 = 按线长自适应（每端1%，上限500m，超出DEM范围自动收缩）"/><span class="mini">0=自适应</span></div>
      <div class="row"><label>平滑窗口</label><input type="number" id="cfgSmooth" value="${c.smoothing}" min="0"/></div>`, true),

    group("⑦ 制图要素", `
      <div class="chips">
        <label class="chip"><input type="checkbox" id="showNames" ${c.show.names ? "checked" : ""}/>地名</label>
        <label class="chip"><input type="checkbox" id="showElev" ${c.show.elev ? "checked" : ""}/>高程</label>
        <label class="chip"><input type="checkbox" id="showZones" ${c.show.zones ? "checked" : ""}/>界线</label>
        <label class="chip"><input type="checkbox" id="showCompass" ${c.show.compass ? "checked" : ""}/>指针</label>
        <label class="chip"><input type="checkbox" id="showAxis" ${c.show.axis ? "checked" : ""}/>距离轴</label>
        <label class="chip"><input type="checkbox" id="showElevAxis" ${c.show.elevAxis ? "checked" : ""}/>高程轴</label>
      </div>
      <div class="mini" style="margin:2px 0 6px">下方表格行：勾选显示 · ⠿ 拖动排序（“土种编号”渲染于色带内）</div>
      <div class="rows-list" id="rowsList">${c.rows.map((r, i) => rowItemHtml(r, i)).join("")}</div>`, true),

    group("⑧ 地带性界线", `
      <div id="zoneRows">${c.zones.map((z, i) => zoneRowHtml(z, i)).join("")}</div>
      <button class="btn small" id="btnAddZone">＋ 添加界线</button>
      <div class="mini">⠿ 拖动排序；名称含土类名自动取土类色。</div>`, false),

    group("⑨ 版式（高级）", (() => {
      const L = c.layout || {};
      // 滑块 + 手动输入双绑定（输入框 id = 滑块 id + N）
      const rng = (id, label, min, max, step, val, unit = "") =>
        `<div class="row"><label>${label}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"/><input type="number" class="lay-num" id="${id}N" min="${min}" max="${max}" step="${step}" value="${val}"/><span class="mini lay-unit">${unit}</span></div>`;
      return rng("layTerrainH", "地形区高度", 240, 900, 10, L.terrainH || 470, "px") +
        rng("layTopPad", "顶部留白", 1.05, 3.0, 0.05, L.topPad || 1.28) +
        rng("layStripH", "色带高度", 24, 100, 2, L.stripH || 46, "px") +
        rng("layRowH", "默认行高", 34, 160, 2, L.rowH || 58, "px") +
        `<div class="row" title="区县重编：按当前土壤图实际出现的土种重新编号（保持全省分类排序），同土类内面积大→淡、面积小→浓">
          <label>编码方案</label>
          <label class="mini"><input type="radio" name="codeScheme" value="province" ${(c.codeScheme || "province") === "province" ? "checked" : ""}/>全省统一</label>
          <label class="mini"><input type="radio" name="codeScheme" value="county" ${c.codeScheme === "county" ? "checked" : ""}/>区县重编</label>
        </div>` +
        rng("layFont", "整体字号", 0.5, 2.5, 0.05, L.fontScale || 1, "×") +
        `<div class="row" title="字号应用范围：全部文字，或仅表格/图面标注/轴刻度某一部位（与字体范围相互独立）">
          <label>字号范围</label>
          <select id="layFSScope" class="lay-num" style="flex:1">
            ${[["all", "全部"], ["tbl", "仅表格"], ["lab", "仅图面标注"], ["axis", "仅轴刻度"]]
              .map(([v, n]) => `<option value="${v}" ${(L.fontScaleScope || "all") === v ? "selected" : ""}>${n}</option>`).join("")}
          </select>
        </div>` +
        rng("layBandH", "表层色带厚", 0, 220, 4, L.terrBandH || 0, "px") +
        `<div class="row" title="剖面轮廓线：选择色阶（默认黑）或按土种色分段着色">
          <label>剖面线</label>
          <input type="color" id="layLineColor" value="${L.terrLineColor || "#3f3a36"}" style="width:30px;padding:0" title="选择剖面线色阶"/>
          <label class="mini"><input type="radio" name="terrLine" value="soil" ${L.terrLine === "soil" ? "checked" : ""}/>土种色</label>
        </div>
        <div class="row" title="字体族与应用范围：可整体换字体，或仅作用于表格/图面标注/轴刻度某一部位">
          <label>字体</label>
          <select id="layFontFam" class="lay-num" style="flex:1">
            ${[["", "跟随界面"], ["SimSun, serif", "宋体"], ["SimHei, sans-serif", "黑体"], ["KaiTi, serif", "楷体"], ["FangSong, serif", "仿宋"], ["'Microsoft YaHei', sans-serif", "微软雅黑"], ["DengXian, sans-serif", "等线"], ["Arial, sans-serif", "Arial"], ["'Times New Roman', serif", "Times New Roman"]]
              .map(([v, n]) => `<option value="${v}" ${(L.fontFamily || "") === v ? "selected" : ""}>${n}</option>`).join("")}
          </select>
          <select id="layFontScope" class="lay-num" style="flex:1">
            ${[["all", "全部"], ["tbl", "仅表格"], ["lab", "仅图面标注"], ["axis", "仅轴刻度"]]
              .map(([v, n]) => `<option value="${v}" ${(L.fontScope || "all") === v ? "selected" : ""}>${n}</option>`).join("")}
          </select>
        </div>` +
        `<div class="row"><label>图幅宽 px</label><input type="number" class="lay-num" id="layFigWN" min="0" max="6000" step="50" value="${L.figW || 0}"/><span class="mini lay-unit">0=自动</span></div>
        <div class="row"><label>地形配色</label>
          <label class="mini"><input type="radio" name="terrStyle" value="soil" ${L.terrStyle !== "classic" ? "checked" : ""}/>土种色</label>
          <label class="mini"><input type="radio" name="terrStyle" value="classic" ${L.terrStyle === "classic" ? "checked" : ""}/>经典灰</label>
        </div>
        <div class="row" title="土种色模式顶部自动取土种颜色，仅下两级可调；经典灰模式三级均可调">
          <label>渐变色阶</label>
          <input type="color" id="layT1" value="${L.terr1 || "#b0a99f"}" style="width:30px;padding:0"/>
          <input type="color" id="layT2" value="${L.terr2 || "#ccc7be"}" style="width:30px;padding:0"/>
          <input type="color" id="layT3" value="${L.terr3 || "#e5e2db"}" style="width:30px;padding:0"/>
        </div>
        <div class="mini">整体字号作用于全部文字；各行行高可在「⑦ 制图要素」行内单独设置；随项目保存。
          <button class="btn small" id="btnLayReset" title="将本组版式参数全部恢复为默认值">↺ 恢复默认</button></div>`;
    })(), false),
  ];

  $("sidebar").innerHTML = html.join("");
  const ms = $("modalSidebar");
  if (ms) ms.innerHTML = modalHtml.join("");
  wireSidebar();
  renderLayerPanel();
  renderImpList();
}
function zoneRowHtml(z, i) {
  const color = (S.builtin.colorByName || {})[z.key] || "#cccccc";
  return `<div class="zrow" data-i="${i}">
    <span class="gripd" title="拖动调整顺序">⠿</span>
    <input type="number" class="z-elev" value="${z.elev}" title="高程 m"/>
    <input type="text" class="z-name" value="${esc(z.name)}" placeholder="名称"/>
    <input type="text" class="z-key" value="${esc(z.key)}" list="tlNames" placeholder="土类色"/>
    <span class="swatch" style="background:${color}" title="点击删除该界线"></span>
  </div><datalist id="tlNames">${(S.builtin.tlNames || []).map(t => `<option value="${esc(t)}"/>`).join("")}</datalist>`;
}
function rowItemHtml(r, i) {
  return `<div class="rrow" data-i="${i}">
    <span class="gripd" title="拖动调整顺序">⠿</span>
    <input type="checkbox" class="r-on" ${r.on ? "checked" : ""}/>
    <span class="lbl">${r.label}</span>
    <input type="number" class="r-rh" min="20" max="200" step="2" value="${r.rh || ""}" placeholder="高" title="本行行高 px（留空用默认）"/>
    <input type="checkbox" class="r-band" ${r.band ? "checked" : ""} title="跨格合并：相邻同值自动合并为一条宽格（土种编号/剖面构型相邻相同合并，地貌类型等跨土种分段），边界可拖动、双击合并/拆分"/>
  </div>`;
}

/* band 行分段初始化：按逐格显示值（表格优先、推导兜底）相邻同值合并；无可初始化返回 null */
function initBandSegs(row) {
  const svg = $("figure"), ctx = svg && svg.__dragCtx;
  const res = S.result;
  if (!ctx || !res || !Array.isArray(res.segments) || res.segments.length < 1) return null;
  const B = ctx.B;
  const valOf = (s) => {
    if (row.key === "lith") return tblVal(s.no, "lith") || s.lith || parentOf(s.tz, s.tl) || "—";
    if (row.key === "geo") return tblVal(s.no, "geo") || s.geo || "—";
    if (row.key === "profile") return `${s.tl || ""}|${s.yl || ""}|${s.tz || ""}`;   // 构型序列指纹（同序列合并）
    const v = s[row.key];
    return v == null || v === "" ? "—" : String(v);
  };
  const segs = [];
  res.segments.forEach((s, i) => {
    const v = valOf(s);
    const last = segs[segs.length - 1];
    if (last && last.text === v) last.b = B[i + 1];   // 相邻同值合并（跨土种）
    else segs.push({ a: B[i], b: B[i + 1], text: v, color: s.color, tl: s.tl, yl: s.yl, tz: s.tz, no: s.no });
  });
  return segs;
}

/* 开/关行级独立分段：开启时按当前逐格值相邻同值合并初始化条带 */
function toggleBand(row, on) {
  const c = S.cfg;
  row.band = !!on;
  if (!on) {
    if (c.rowBands) delete c.rowBands[row.key];
    if (c.bandSel && c.bandSel.key === row.key) { c.bandSel = null; hideCellBar(); }
    log(`「${row.label}」已恢复逐格显示`);
    return;
  }
  if (!$("figure") || !$("figure").__dragCtx || !S.result) {
    log("请先生成断面，再开启跨土种分段");
    row.band = false;
    buildSidebar();
    return;
  }
  const segs = initBandSegs(row);
  if (!segs) return;
  if (!c.rowBands) c.rowBands = {};
  c.rowBands[row.key] = segs;
  log(`「${row.label}」跨土种分段已开启：自动合并为 ${segs.length} 段（边界可拖动 · 双击边界合并 · 双击段内拆分）`);
  buildSidebar();
}

/* band 段文字跟随数据源刷新：表格值优先、自动推导兜底（保留用户拖动的边界几何） */
function refreshBandTexts(key) {
  const segsB = (S.cfg.rowBands || {})[key];
  if (!Array.isArray(segsB) || !S.result) return;
  segsB.forEach(sg => {
    if (sg.no == null) return;
    const p = S.result.points.find(q => String(q.no) === String(sg.no)) || {};
    let v = "";
    if (key === "lith") v = tblVal(sg.no, "lith") || p.lith || parentOf(sg.tz, sg.tl) || "";
    else if (key === "geo") v = tblVal(sg.no, "geo") || p.geo || "";
    else v = tblVal(sg.no, key) || p[key] || "";
    if (v) sg.text = v;
  });
}

function currentProfile() {
  return S.profiles.find(x => x.id === S.activeProfile) || S.profiles[0];
}
function syncProfileToMap() {
  const pr = currentProfile();
  S.map.draw = pr.drawLine.map(p => [p[0], p[1]]);
  S.map.pts = pr.drawPts.map(p => [p[0], p[1], p[2] || ""]);
  S.map.drawing = false;
  S.map.ptsLoaded = true;   // 已是编辑态，防回传覆盖
  if (ML) updateDrawSources();
}
function syncMapToProfile() {
  const pr = currentProfile();
  pr.drawLine = S.map.draw.map(p => [p[0], p[1]]);
  pr.drawPts = S.map.pts.map(p => [p[0], p[1], p[2] || ""]);
}

function wireSidebar() {
  const c = S.cfg;
  const sp = $("selProfile");
  if (sp) sp.onchange = () => { syncMapToProfile(); S.activeProfile = +sp.value || S.profiles[0].id; syncProfileToMap(); buildSidebar(); computeDebounced(); };
  // 生成用数据源由顶栏「生成断面」弹层选择（侧栏不再放 radio）
  const pa = $("btnProfileAdd");
  if (pa) pa.onclick = () => {
    syncMapToProfile();
    const name = prompt("剖面名称：", `剖面 ${S.nextProfileId}`);
    if (!name) return;
    const pid = S.nextProfileId;
    S.profiles.push({ id: pid, name, drawLine: [], drawPts: [] });
    // 空剖面不占图层项——首次绘制时由 ensureProfileLayerItem 自动创建（顶部）
    S.activeProfile = pid;
    S.nextProfileId++;
    syncProfileToMap();
    buildSidebar();
    log(`已创建剖面「${name}」，请在地图工作台为其绘制线/点`);
  };
  const pd = $("btnProfileDel");
  if (pd) pd.onclick = () => {
    if (S.profiles.length <= 1) return log("至少保留一个剖面");
    const pr = currentProfile();
    if (!confirm(`删除剖面「${pr.name}」？其自绘线点将丢失。`)) return;
    S.profiles = S.profiles.filter(x => x.id !== pr.id);
    S.layerList = S.layerList.filter(x => !(x.kind === "prof" && x.profileId === pr.id));
    const ml = ML;
    if (ml && ml.map.getLayer) {
      ["pl-" + pr.id, "pp-" + pr.id].forEach(l => ml.map.getLayer(l) && ml.map.removeLayer(l));
      ["pl-" + pr.id, "pp-" + pr.id].forEach(l => ml.map.getSource(l) && ml.map.removeSource(l));
    }
    S.activeProfile = S.profiles[0].id;
    syncProfileToMap();
    buildSidebar();
    log(`已删除剖面「${pr.name}」`);
  };
  const pe = $("btnProfileExport");
  if (pe) pe.onclick = async () => {
    syncMapToProfile();
    const pr = currentProfile();
    if (!pr.drawLine.length && !pr.drawPts.length) return log("当前剖面尚无绘制的线/点", "err");
    const fmt = await pickExportFmt();
    if (!fmt) return;
    if (fmt === "shp") {
      const pth = await invoke("dlg_save", { title: `导出剖面「${pr.name}」线/点（Shapefile）`, defaultName: `剖面-${pr.name}-断面线点.shp`, filterName: "Shapefile", filterExt: "*.shp" });
      if (!pth) return;
      try {
        const r = await invoke("export_shp", {
          basePath: pth, name: pr.name,
          line: pr.drawLine.map(q => [+q[0], +q[1]]),
          points: pr.drawPts.map(q => [+q[0], +q[1], q[2] || ""]),
        });
        log(`剖面「${pr.name}」已导出 Shapefile（UTF-8）：${(r.files || []).join("、")}`);
      } catch (e) { log("SHP 导出失败: " + e, "err"); }
      return;
    }
    const feats = [];
    if (pr.drawLine.length >= 2) {
      feats.push({ type: "Feature", properties: { profile: pr.name, kind: "断面线", vertices: pr.drawLine.length, length_km: +lineLenKm(pr.drawLine).toFixed(3) },
        geometry: { type: "LineString", coordinates: pr.drawLine.map(p => [+p[0].toFixed(6), +p[1].toFixed(6)]) } });
    }
    pr.drawPts.forEach((p, i) => {
      feats.push({ type: "Feature", properties: { profile: pr.name, kind: "断面点", no: i + 1, name: p[2] || `点${i + 1}` },
        geometry: { type: "Point", coordinates: [+p[0].toFixed(6), +p[1].toFixed(6)] } });
    });
    const gj = JSON.stringify({ type: "FeatureCollection", name: pr.name, crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } }, features: feats }, null, 1);
    const pth = await invoke("dlg_save", { title: `导出剖面「${pr.name}」线/点`, defaultName: `剖面-${pr.name}-断面线点.geojson`, filterName: "GeoJSON", filterExt: "*.geojson" });
    if (!pth) return;
    await invoke("write_text_file", { path: pth, content: gj });
    log(`剖面「${pr.name}」已导出：${pr.drawLine.length} 线顶点 · ${pr.drawPts.length} 点（WGS84 GeoJSON）: ` + pth);
  };
  const __gi = $("btnGdalInit");
  if (__gi) __gi.onclick = () => initGdal($("gdalDir").value.trim()).then(loadBuiltin);
  ["line", "points", "soil"].forEach(kind => {
    const pick = $("pick-" + kind), pickd = $("pickdir-" + kind);
    if (pick) pick.onclick = () => pickVector(kind, false);
    if (pickd) pickd.onclick = () => pickVector(kind, true);
    const sel = $("sel-" + kind + "-layer");
    if (sel) sel.onchange = () => {
      S[kind].layer = sel.value;
      if (kind === "soil" && sel.value) useLayerNow(kind);   // 土壤图选定即装载（字段映射）；线/点由「＋装载」按钮创建新套
    };
  });
  const bll = $("btnLoadLine"); if (bll) bll.onclick = () => useLayerNow("line");
  const blp = $("btnLoadPts"); if (blp) blp.onclick = () => useLayerNow("points");
  $("pick-dem").onclick = pickDem;
  window.__undoMapDraw = () => {
    if (S.map.mode === "line" && S.map.drawHist.length) {
      S.map.draw = S.map.drawHist.pop();
      S.map.drawing = S.map.draw.length > 0;
      syncMapToProfile();
      updateDrawSources();
      $("mapStatus").textContent = `已撤销顶点（剩余 ${S.map.draw.length}）`;
    } else if (S.map.ptsHist.length) {
      S.map.pts = S.map.ptsHist.pop();
      syncMapToProfile();
      updateDrawSources();
      $("mapStatus").textContent = `已撤销布点（剩余 ${S.map.pts.length}）`;
    } else {
      $("mapStatus").textContent = "没有可撤销的绘制";
    }
  };
  const ud = $("btnUndoDraw");
  if (ud) ud.onclick = () => window.__undoMapDraw();
  const ap = $("btnAutoPts");
  if (ap) ap.onclick = () => { const iv = +($("ptInterval")?.value || 1); placePointsAlongLine(iv); };
  const fdb = $("btnFinishDraw");
  if (fdb) fdb.onclick = () => finishDrawing();
  const lb = $("btnLoadBase");
  if (lb) lb.onclick = async () => {
    if (!S.soil.path || !S.soil.layer) return log("请先选择土壤类型图文件与图层", "err");
    if (!S.dem.path) return log("请先选择 DEM 高程文件", "err");
    try {
      await useLayerNow("soil");
      S.dem.meta = await invoke("use_dem", { path: S.dem.path });
      log(`底图已载入：DEM ${S.dem.meta.xsize}×${S.dem.meta.ysize} · EPSG:${S.dem.meta.epsg ?? "?"}`);
      buildSidebar();
      refreshMap();
    } catch (e) { log("底图载入失败: " + e, "err"); }
  };
  const lf = $("sel-linefeat");
  if (lf) lf.onchange = () => { c.lineIndex = +lf.value; computeDebounced(); };
  const bindField = (id, k) => { const e = $(id); if (e) { e.onchange = () => { c[k] = e.value; if (S.soil.meta) useLayerNow("soil"); }; } };
  bindField("sel-soilTL", "soilTL"); bindField("sel-soilYL", "soilYL"); bindField("sel-soilTS", "soilTS");
  bindField("sel-soilTZ", "soilTZ"); bindField("sel-soilAD", "soilAdmin"); bindField("sel-soilLI", "soilLith"); bindField("sel-soilGE", "soilGEO");
  const pno = $("sel-ptno"), pnm = $("sel-ptname");
  if (pno && !c.ptNoField && S.points.meta) {
    const autoNo = ["点编号", "编号", "NO", "no", "ID", "OBJECTID"].find(f => S.points.meta.fields.includes(f));
    if (autoNo) { c.ptNoField = autoNo; pno.value = autoNo; }
  }
  if (pnm && !c.ptNameField && S.points.meta) {
    const autoNm = ["地名", "名称", "NAME", "Name", "名字"].find(f => S.points.meta.fields.includes(f));
    if (autoNm) { c.ptNameField = autoNm; pnm.value = autoNm; }
  }
  if (pno) pno.onchange = () => { c.ptNoField = pno.value; computeDebounced(); };
  if (pnm) pnm.onchange = () => { c.ptNameField = pnm.value; computeDebounced(); };
  document.querySelectorAll('input[name="fmode"]').forEach(r => r.onchange = () => {
    c.filterMode = document.querySelector('input[name="fmode"]:checked').value;
    $("fmodeFieldRow").style.display = c.filterMode === "field" ? "" : "none";
    $("fmodeAllRow").style.display = c.filterMode === "all" ? "" : "none";
    computeDebounced();
  });
  $("fmodeFieldRow").style.display = c.filterMode === "field" ? "" : "none";
  $("fmodeAllRow").style.display = c.filterMode === "all" ? "" : "none";
  const ff = $("sel-ffield"), fv = $("fvalue"), fd = $("fdist");
  if (ff) ff.onchange = () => { c.filterField = ff.value; computeDebounced(); };
  if (fv) fv.oninput = () => { c.filterValue = fv.value; computeDebounced(); };
  if (fd) fd.oninput = () => { c.filterDist = +fd.value || 600; computeDebounced(); };
  const st = $("cfgStep"), sm = $("cfgSmooth"), ori = $("cfgOri"), ex = $("cfgExt");
  if (ex) ex.oninput = () => { c.extendsM = Math.max(0, +ex.value || 0); computeDebounced(); };
  if (st) st.oninput = () => { c.sampleStep = Math.max(1, +st.value || 50); computeDebounced(); };
  if (sm) sm.oninput = () => { c.smoothing = Math.max(0, +sm.value || 0); computeDebounced(); };
  if (ori) ori.onchange = () => { c.orientation = ori.value; computeDebounced(); };
  document.querySelectorAll('input[name="ve"]').forEach(r => r.onchange = () => {
    c.veAuto = document.querySelector('input[name="ve"]:checked').value === "auto";
    $("cfgVe").disabled = c.veAuto;
    computeDebounced();
  });
  const ve = $("cfgVe");
  if (ve) ve.oninput = () => { c.ve = +ve.value || 10; computeDebounced(); };
  // 界线
  document.querySelectorAll(".zrow").forEach(row => {
    const i = +row.dataset.i;
    row.querySelector(".z-elev").oninput = e => { c.zones[i].elev = +e.target.value || 0; computeDebounced(); };
    row.querySelector(".z-name").oninput = e => {
      const nm = e.target.value;
      c.zones[i].name = nm;
      const cb = S.builtin.colorByName;
      c.zones[i].key = cb[nm] ? nm : (nm.replace(/带$/, "") && cb[nm.replace(/带$/, "")] ? nm.replace(/带$/, "") : nm);
      row.querySelector(".z-key").value = c.zones[i].key;
      row.querySelector(".swatch").style.background = cb[c.zones[i].key] || "#ccc";
      computeDebounced();
    };
    row.querySelector(".z-key").oninput = e => {
      c.zones[i].key = e.target.value;
      row.querySelector(".swatch").style.background = (S.builtin.colorByName || {})[e.target.value] || "#ccc";
      computeDebounced();
    };
    row.querySelector(".swatch").onclick = () => { c.zones.splice(i, 1); buildSidebar(); computeDebounced(); };
  });
  const baz = $("btnAddZone");
  if (baz) baz.onclick = () => { c.zones.push({ elev: 1000, name: "新界线", key: "" }); buildSidebar(); };
  // 显示行（勾选即时生效；顺序拖动调整）
  document.querySelectorAll("#rowsList .rrow").forEach(row => {
    const i = +row.dataset.i;
    row.querySelector(".r-on").onchange = e => {
      c.rows[i].on = e.target.checked;
      if (S.result) renderFigure(S.result);   // 显示行是纯渲染层开关，即时生效
      computeDebounced();
    };
    const rhInp = row.querySelector(".r-rh");
    if (rhInp) rhInp.onchange = () => {
      const v = +rhInp.value;
      c.rows[i].rh = (rhInp.value === "" || !isFinite(v)) ? 0 : Math.max(20, Math.min(200, v));
      if (S.result) renderFigure(S.result);
    };
    const bandInp = row.querySelector(".r-band");
    if (bandInp) bandInp.onchange = e => {
      toggleBand(c.rows[i], e.target.checked);
      if (S.result) renderFigure(S.result);
    };
  });
  const rl = $("rowsList");
  if (rl) bindDragSort(rl, ".rrow", (from, to) => {
    const [r] = c.rows.splice(from, 1);
    c.rows.splice(to, 0, r);
    buildSidebar(); computeDebounced();
  });
  // 地带界线顺序拖动
  const zw = $("zoneRows");
  if (zw) bindDragSort(zw, ".zrow", (from, to) => {
    const [z] = c.zones.splice(from, 1);
    c.zones.splice(to, 0, z);
    buildSidebar(); computeDebounced();
  });
  const bindShow = (id, key) => $(id).onchange = e => { c.show[key] = e.target.checked; if (S.result) renderFigure(S.result); };
  bindShow("showNames", "names"); bindShow("showElev", "elev");
  bindShow("showZones", "zones"); bindShow("showCompass", "compass"); bindShow("showAxis", "axis"); bindShow("showElevAxis", "elevAxis");
  // 版式
  if (!c.layout) c.layout = {};
  // 版式绑定：滑块/数字输入双向同步（数字框 id = 滑块 id + N）
  const bindLay = (id, key, isNum = true) => {
    const inp = $(id);
    const num = $(id + "N");
    const onVal = (src) => {
      if (isNum) {
        let v = +(src === "num" ? num.value : inp.value);
        if (!isFinite(v)) return;
        if (num && num.min !== "" ) v = Math.max(+num.min, Math.min(+num.max || 1e9, v));
        c.layout[key] = v;
        if (inp) inp.value = v;
        if (num && src !== "num") num.value = v;
      } else {
        c.layout[key] = inp.value;
      }
      if (S.result) renderFigure(S.result);
    };
    if (inp) { inp.oninput = () => onVal("range"); inp.onchange = () => onVal("range"); }
    if (num) {
      // input：键入/微调箭头即时生效（去抖渲染）；change：失焦钳制
      let t = null;
      num.oninput = () => {
        onVal("num");
        clearTimeout(t);
        t = setTimeout(() => { if (S.result) renderFigure(S.result); }, 200);
      };
      num.onchange = () => onVal("num");
    }
  };
  // 图幅宽度仅数字输入
  const fw = $("layFigWN");
  if (fw) fw.onchange = () => {
    let v = +fw.value || 0;
    v = Math.max(0, Math.min(6000, v));
    fw.value = v; c.layout.figW = v;
    if (S.result) renderFigure(S.result);
  };
  bindLay("layTerrainH", "terrainH"); bindLay("layTopPad", "topPad");
  bindLay("layStripH", "stripH"); bindLay("layRowH", "rowH"); bindLay("layFont", "fontScale");
  bindLay("layT1", "terr1", false); bindLay("layT2", "terr2", false); bindLay("layT3", "terr3", false);
  document.querySelectorAll('input[name="terrStyle"]').forEach(r => r.onchange = e => {
    if (!e.target.checked) return;
    c.layout.terrStyle = e.target.value;
    if (S.result) renderFigure(S.result);
  });
  bindLay("layBandH", "terrBandH");
  document.querySelectorAll('input[name="terrLine"]').forEach(r => r.onchange = e => {
    if (!e.target.checked) return;
    c.layout.terrLine = e.target.value;
    if (S.result) renderFigure(S.result);
  });
  const lcSel = $("layLineColor");
  if (lcSel) lcSel.oninput = () => { c.layout.terrLine = "color"; c.layout.terrLineColor = lcSel.value; if (S.result) renderFigure(S.result); };
  document.querySelectorAll('#figModal input[name="codeScheme"]').forEach(r => r.onchange = e => {
    if (e.target.checked) applyCodeScheme(e.target.value);
  });
  const layReset = $("btnLayReset");
  if (layReset) layReset.onclick = () => {
    c.layout = { figW: 0, terrainH: 470, topPad: 1.28, stripH: 46, rowH: 58, fontScale: 1, fontScaleScope: "all", terrStyle: "soil", terrBandH: 0, terrLine: "color", terrLineColor: "#3f3a36", fontFamily: "", fontScope: "all", terr1: "#b0a99f", terr2: "#ccc7be", terr3: "#e5e2db" };
    buildSidebar();
    if (S.result) renderFigure(S.result);
    log("版式已恢复默认");
  };
  const ffSel = $("layFontFam"), fsSel = $("layFontScope"), fssSel = $("layFSScope");
  if (ffSel) ffSel.onchange = () => { c.layout.fontFamily = ffSel.value; if (S.result) renderFigure(S.result); };
  if (fsSel) fsSel.onchange = () => { c.layout.fontScope = fsSel.value; if (S.result) renderFigure(S.result); };
  if (fssSel) fssSel.onchange = () => { c.layout.fontScaleScope = fssSel.value; if (S.result) renderFigure(S.result); };
  document.querySelectorAll(".ghead").forEach(h => h.onclick = () => {
    const sec = h.parentElement;
    sec.classList.toggle("closed");
    const t = sec.dataset.g;
    if (t) S.__grp[t] = sec.classList.contains("closed");
  });
}

/* ---------------- 断面点表格 ---------------- */
const PT_COLS = [
  { k: "no", t: "点编号", w: 60, num: true },
  { k: "name", t: "地名", w: 90 },
  { k: "ch", t: "里程 km", w: 70, num: true },
  { k: "elev", t: "海拔 m", w: 70, num: true },
  { k: "code", t: "土种编号", w: 70 },
  { k: "tz", t: "土种", w: 200 },
  { k: "ts", t: "土属", w: 150 },
  { k: "yl", t: "亚类", w: 110 },
  { k: "tl", t: "土类", w: 80 },
  { k: "geo", t: "地貌类型", w: 90 },
  { k: "profile", t: "剖面构型", w: 100 },
  { k: "admin", t: "行政区", w: 90 },
  { k: "lith", t: "母岩母质", w: 110 },
];

function renderPointsTable() {
  const tbl = $("pointsTable");
  if (!tbl) return;
  let html = "<thead><tr><th></th>" + PT_COLS.map(c2 => `<th>${c2.t}</th>`).join("") + "<th>标注</th><th>来源</th><th></th></tr></thead><tbody>";
  S.table.forEach((r, i) => {
    const flash = S.__flashRow != null && r.no === S.__flashRow;
    html += `<tr data-i="${i}" class="${flash ? "row-flash" : ""}"><td class="grip"><span class="gripd" title="拖动调整顺序（里程随之重新分配）">⠿</span></td>` + PT_COLS.map(c2 =>
      `<td class="${c2.num ? "num" : ""}"><input data-k="${c2.k}" value="${esc(r[c2.k])}"/></td>`).join("")
      + `<td title="地名/点位/高程 标注开关"><input type="checkbox" class="lbl-ck" ${r.lbl === false ? "" : "checked"}/></td>`
      + `<td><span class="tag ${r.manual ? "manual" : ""}">${r.manual ? "手工" : "数据"}</span></td>`
      + `<td><button class="btn small danger" data-del="${i}">✕</button></td></tr>`;
  });
  html += "</tbody>";
  tbl.innerHTML = html;
  if (S.__flashRow != null) {
    const fr = tbl.querySelector("tr.row-flash");
    if (fr) { fr.scrollIntoView({ block: "center" }); setTimeout(() => fr.classList.remove("row-flash"), 2600); }
    S.__flashRow = null;
  }
  tbl.querySelectorAll("td input").forEach(inp => {
    inp.onfocus = () => { inp.__snap = snapshotState(); };
    inp.oninput = () => {
      const i = +inp.closest("tr").dataset.i, k = inp.dataset.k;
      let v = inp.value;
      if (["no", "ch", "elev"].includes(k)) v = +v || 0;
      S.table[i][k] = v; S.table[i].manual = true;
      clearTimeout(inp.__t);
      inp.__t = setTimeout(() => {
        if (inp.__snap) { pushUndo(inp.__snap); inp.__snap = null; }
        if (k === "ch" && v > 0 && S.useCustom) autoFillRowFromChainage(i, v);
        // 自绘模式：后端不接收表格 override——前端直改计算结果，图即时更新
        if (S.useCustom && S.result) {
          const row = S.table[i];
          const noS = String(row && row.no);
          const kk = k === "ch" ? "ch_km" : k;
          const pR = S.result.points.find(q => String(q.no) === noS);
          const sgR = S.result.segments.find(q => String(q.no) === noS);
          if (pR && kk in pR) pR[kk] = v;
          if (sgR && kk in sgR) sgR[kk] = v;
          if (k === "tz" && sgR) {
            const tbl2 = S.cfg.codeScheme === "county" && S.builtinCounty ? S.builtinCounty : S.builtin;
            const rec = (tbl2.codes || []).find(r2 => r2.tz === v);
            if (rec) sgR.code = rec.code;
            const col = (tbl2.colorByName || {})[v] || (rec && (tbl2.colorByName || {})[rec.tl]);
            if (col) sgR.color = col;
          }
        }
        // band 行字段被编辑：值序列已变，按新值重新自动分段（数据驱动）
        const rw = S.cfg.rows.find(r => r.key === k);
        if (rw && rw.band && $("figure") && $("figure").__dragCtx) {
          const sg2 = initBandSegs(rw);
          if (sg2) { if (!S.cfg.rowBands) S.cfg.rowBands = {}; S.cfg.rowBands[k] = sg2; }
        }
        if (S.result) renderFigure(S.result);
        computeDebounced();
      }, 600);
    };
  });
  tbl.querySelectorAll("input.lbl-ck").forEach(ck => ck.onchange = () => {
    const i = +ck.closest("tr").dataset.i;
    S.table[i].lbl = ck.checked;
    if (S.result) renderFigure(S.result);
  });
  tbl.querySelectorAll("button[data-del]").forEach(b => b.onclick = async () => {
    pushUndo(snapshotState());
    // 删除前快照：判断被删行是否为里程首/末点（仅端点删除才修剪剖面线，中间点不影响）
    const chsBefore = S.table.map(r => +r.ch).filter(v => isFinite(v));
    const chMinB = chsBefore.length ? Math.min(...chsBefore) : 0;
    const chMaxB = chsBefore.length ? Math.max(...chsBefore) : 0;
    const row = S.table.splice(+b.dataset.del, 1)[0];
    const wasFirst = row && Math.abs(+row.ch - chMinB) < 0.01;
    const wasLast = row && Math.abs(+row.ch - chMaxB) < 0.01;
    if (S.useCustom && row) {
      // 自绘模式：同步删除对应剖面点（按 名称/序号 匹配），并把删减后的点集提交后端。
      // 若不提交，重算会以旧点集为准 → 被删点复活（表格"自动补回"根因）
      const pr = currentProfile();
      const num = String(row.no).replace(/^点/, "");
      const before = pr.drawPts.length;
      pr.drawPts = pr.drawPts.filter((p) => {
        const pn = String(p[2] || "").replace(/^点/, "");
        return !(pn === num || (row.name && p[2] === row.name));
      });
      if (pr.drawPts.length !== before) {
        S.map.pts = pr.drawPts.slice();
        // 仅当被删的是里程首/末点才修剪对应一侧（删中间点不影响剖面长度）；
        // 等距布点的末点里程天然小于线长（尾段不满一个间隔），不能以"末点距线端的差"作修剪判据
        if (pr.drawPts.length >= 2 && pr.drawLine.length >= 2) {
          const chs = S.table.map(r => +r.ch).filter(v => isFinite(v) && v >= 0);
          if (chs.length >= 2) {
            const lenM = lineLenKm(pr.drawLine) * 1000;
            let a = 0, bb = lenM;
            if (wasFirst) a = Math.min(...chs) * 1000;
            if (wasLast) bb = Math.max(...chs) * 1000;
            if (a > 1 || bb < lenM - 1) {
              pr.drawLine = trimLineToCh(pr.drawLine, a, bb);
              S.map.draw = pr.drawLine.map(q => [q[0], q[1]]);
              log(`端点删除：剖面线已修剪至 ${((bb - a) / 1000).toFixed(2)} km`);
            }
          }
        }
        updateDrawSources();
        try {
          await invoke("set_custom_line", { pts: pr.drawLine.map(q => [q[0], q[1]]), epsg: 4326 });   // 修剪后的线同步后端
          await commitCustomPoints();
        } catch (e) { log("线/点提交失败: " + e, "err"); }
      } else {
        log(`未匹配到剖面点（${row.name || "点" + row.no}），表格行已删除；若再次生成该点可能恢复`, "warn");
      }
    }
    renderPointsTable();   // 删除后重渲染（即使自绘同步失败也保证表格更新）
    computeDebounced();    // 重算后 renderFigure 与表格以新结果为准（图/表同步）
  });
  const reorder = (from, to) => {
    if (to < 0 || to >= S.table.length || to === from) return;
    const snap = snapshotState();
    if (S.useCustom) {
      // 自绘模式：点顺序 = 剖面点数组顺序（几何不变仅排列变化）。必须同步重排 drawPts
      // 并提交后端，否则重算以几何为准，顺序被覆盖回原样
      const pr = currentProfile();
      if (pr.drawPts.length === S.table.length) {
        const [pp] = pr.drawPts.splice(from, 1);
        pr.drawPts.splice(to, 0, pp);
        S.map.pts = pr.drawPts.slice();
        updateDrawSources();
      }
      const [mv] = S.table.splice(from, 1);
      S.table.splice(to, 0, mv);
      renderPointsTable();
      pushUndo(snap);
      commitCustomPoints().then(() => computeDebounced()).catch(e => log("点集提交失败: " + e, "err"));
      log(`断面点顺序已调整：${mv.name}（点${mv.no}）移至第 ${to + 1} 位`);
      return;
    }
    const chsSorted = S.table.map(r => r.ch).sort((a, b) => a - b);
    const [mv] = S.table.splice(from, 1);
    S.table.splice(to, 0, mv);
    S.table.forEach((r, k) => { r.ch = chsSorted[k]; r.manual = true; });
    renderPointsTable();
    pushUndo(snap);
    computeDebounced();
    log(`断面点顺序已调整：${mv.name}（点${mv.no}）移至第 ${to + 1} 位`);
  };
  // 行顺序：统一拖动引擎（与图层面板一致，插入线指示落点）
  bindDragSort(tbl, "tbody tr", (from, to) => reorder(from, to));
}

function renderCodesTable() {
  const tbl = $("codesTable");
  if (!tbl) return;
  const useCounty = S.cfg.codeScheme === "county" && S.builtinCounty;
  const all = useCounty ? S.builtinCounty.codes : S.builtin.codes;
  const cmap = useCounty ? S.builtinCounty.colorByName : (S.builtin.colorByName || {});
  const q = ($("codeSearch")?.value || "").trim();
  const rows = all.filter(r => !q || [r.code, r.tz, r.ts, r.yl, r.tl].some(v => String(v || "").includes(q)));
  tbl.innerHTML = "<thead><tr><th>编号</th><th>色</th><th>土类</th><th>亚类</th><th>土属</th><th>土种</th></tr></thead><tbody>"
    + rows.slice(0, 500).map(r => `<tr>
      <td class="num">${esc(r.code)}</td>
      <td><span class="swatch" style="background:${esc(cmap[r.tz] || cmap[r.tl] || "#ccc")}"></span></td>
      <td>${esc(r.tl)}</td><td>${esc(r.yl)}</td><td>${esc(r.ts)}</td><td>${esc(r.tz)}</td></tr>`).join("") + "</tbody>";
  const cc = $("codeCount");
  if (cc) cc.textContent = `${rows.length} 条` + (rows.length > 500 ? "（显示前 500）" : "");
}

/* ---------------- 撤销 / 重做 ---------------- */
const UNDO = { u: [], r: [], cap: 50 };
function snapshotState() {
  return JSON.stringify({ cfg: S.cfg, table: S.table });
}
function pushUndo(prevSnap) {
  if (UNDO.u.length && UNDO.u[UNDO.u.length - 1] === prevSnap) return;
  UNDO.u.push(prevSnap);
  if (UNDO.u.length > UNDO.cap) UNDO.u.shift();
  UNDO.r.length = 0;
}
function applyState(snap) {
  const s = JSON.parse(snap);
  S.cfg = s.cfg;
  S.table = s.table;
  buildSidebar(); renderPointsTable();
  if (S.result) renderFigure(S.result);
  computeDebounced();
}
function doUndo() {
  if (!UNDO.u.length) { log("无可撤销操作"); return; }
  UNDO.r.push(snapshotState());
  applyState(UNDO.u.pop());
  log("已撤销");
}
function doRedo() {
  if (!UNDO.r.length) { log("无可重做操作"); return; }
  UNDO.u.push(snapshotState());
  applyState(UNDO.r.pop());
  log("已重做");
}
document.addEventListener("keydown", e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  const onMap = !document.getElementById("figModal").classList.contains("open");
  if (k === "z" && !e.shiftKey) {
    e.preventDefault();
    if (onMap && (S.map.drawHist.length || S.map.ptsHist.length)) window.__undoMapDraw && window.__undoMapDraw();
    else doUndo();
  }
  else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); doRedo(); }
});

/* ---------------- SVG 渲染引擎 ---------------- */
const SVGNS = "http://www.w3.org/2000/svg";
function el(name, attrs, text) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}
const haloAttr = { "paint-order": "stroke", stroke: "#ffffff", "stroke-width": 3, "stroke-linejoin": "round" };

function renderFigure(res) {
  const svg = $("figure");
  svg.innerHTML = "";
  const c = S.cfg;

  /* --- 版式常量（侧栏⑦可调） --- */
  const totalKm = res.total_km;
  const LAY = c.layout || {};
  const figW = LAY.figW > 0 ? LAY.figW : (totalKm > 20 ? 1600 : 1250);
  const left = 0.09 * figW;
  const rightMargin = (6.4 * 9.5 + 26) * PX;
  const right = figW - rightMargin;
  const axesW = right - left;
  const terrainH = LAY.terrainH || 470;
  const topY = 34;
  const axisGap = 30 * PX;
  const stripH = LAY.stripH || 46;
  const rowH = LAY.rowH || 58;
  const profileRowH = 86;

  const ve = res.ve;
  const stations = res.stations;
  const dispBase = res.y_base * ve;
  const disp = stations.map(s => s[1] * ve);
  let maxDisp = -Infinity;
  for (const d of disp) if (d > maxDisp) maxDisp = d;
  const yTop = dispBase + (maxDisp - dispBase) * (LAY.topPad || 1.28);

  /* --- 分段边界（maximin：中点基础 + 二分最小格宽 + E/La 夹逼） --- */
  const ext = res.ext_km || 0;
  const spanKm = totalKm + 2 * ext;
  const chs = res.points.map(p => p.ch_km);
  const nPts = chs.length;
  const epsB = Math.max(totalKm * 1e-4, 1e-4);
  const deltaJ = (j) => Math.max((chs[j] - chs[j - 1]) * 0.02, epsB);
  const B = new Array(nPts + 1);
  B[0] = 0; B[nPts] = totalKm;
  for (let j = 1; j <= nPts - 1; j++) B[j] = (chs[j - 1] + chs[j]) / 2;
  if (nPts >= 2) {
    const ppk = axesW / spanKm;
    const wCap = 72 / ppk;
    const feasible = (w) => {
      let prev = 0;
      for (let j = 1; j <= nPts - 1; j++) {
        const lo = Math.max(prev + w, chs[j - 1] + deltaJ(j));
        if (lo > chs[j] - deltaJ(j)) return false;
        prev = lo;
      }
      return prev + w <= totalKm + epsB;
    };
    let wLo = 0, wHi = Math.min(wCap, totalKm / nPts);
    for (let it = 0; it < 48 && wHi - wLo > epsB; it++) {
      const mid = (wLo + wHi) / 2;
      feasible(mid) ? wLo = mid : wHi = mid;
    }
    const E = new Array(nPts + 1), La = new Array(nPts + 1);
    E[0] = 0; La[nPts] = totalKm;
    for (let j = 1; j <= nPts - 1; j++) E[j] = Math.max(E[j - 1] + wLo, chs[j - 1] + deltaJ(j));
    for (let j = nPts - 1; j >= 1; j--) La[j] = Math.min(La[j + 1] - wLo, chs[j] - deltaJ(j));
    for (let j = 1; j <= nPts - 1; j++) {
      B[j] = Math.max(E[j], Math.min(B[j], La[j]));
    }
    for (let j = 1; j <= nPts; j++) if (B[j] <= B[j - 1] + epsB) B[j] = B[j - 1] + epsB;
  }
  const Bauto = B.slice();
  if (Array.isArray(c.boundsOverride) && c.boundsOverride.length === nPts + 1) {
    B[0] = 0; B[nPts] = totalKm;
    for (let j = 1; j <= nPts - 1; j++) {
      let v = +c.boundsOverride[j] || 0;
      v = Math.min(Math.max(v, chs[j - 1] + deltaJ(j)), chs[j] - deltaJ(j));
      if (v <= B[j - 1] + epsB) v = Math.min(B[j - 1] + epsB, chs[j] - deltaJ(j));
      B[j] = v;
    }
  }

  /* --- 三普土种行预算（满字号优先，行数让步） --- */
  const segs = res.segments;
  const FS = LAY.fontScale || 1;   // 整体字号：参与换行/缩字号度量（渲染后统一缩放，二者叠加正好填满格宽）
  // 字号应用范围不含表格时，表格换行/缩字号度量按原字号（表格不被缩放）
  const FSTbl = ["all", "tbl"].includes(LAY.fontScaleScope || "all") ? FS : 1;
  const tzFit = (text, cellPx) => {
    const L = Math.max(String(text).length, 1);
    const perFull = Math.max(2, Math.floor((cellPx - 8) / (15.3 * FSTbl)));
    let rowsN = Math.ceil(L / perFull), fs = 15.3, per = perFull;
    if (rowsN > 4) { rowsN = 4; per = Math.ceil(L / 4); fs = Math.max(6, Math.min(15.3, (cellPx - 8) / per / FSTbl)); }
    const lines = [];
    for (let k = 0; k < L; k += per) lines.push(String(text).slice(k, k + per));
    return { rowsN, fs, lines };
  };
  const ppkAll = axesW / spanKm;
  let maxTzRows = 1;
  segs.forEach((s, i) => {
    const wpx = (B[i + 1] - B[i]) * ppkAll + (i === 0 || i === segs.length - 1 ? ext * ppkAll : 0);
    maxTzRows = Math.max(maxTzRows, tzFit(s.tz || "—", wpx).rowsN);
  });
  const tzRowH = Math.max(rowH, maxTzRows * 15.3 * FSTbl * 1.18 + 10);

  const rowsOn = c.rows.filter(r => r.on && r.key !== "code");
  // 行高按行独立：行内 rh 优先；tz 行取 max(行高, 内容所需)；profile 行特例
  const rowHOf = (row) => {
    const base = row && row.rh > 0 ? +row.rh : rowH;
    if (!row) return base;
    if (row.key === "profile") return Math.max(base, profileRowH);
    if (row.key === "tz") return Math.max(base, tzRowH);
    return base;
  };
  const tableH = stripH + rowsOn.reduce((a, r) => a + rowHOf(r), 0) + 8;   // 行区紧贴色带，底线紧贴末行（btmY=行区底）
  const figH = Math.round(topY + terrainH + axisGap + tableH + 26);   // 取整：导出画布与分辨率提示为整数

  svg.setAttribute("viewBox", `0 0 ${figW} ${figH}`);
  svg.setAttribute("width", figW); svg.setAttribute("height", figH);

  const tableTop = topY + terrainH + axisGap;
  const xpx = (km) => left + (km + ext) / spanKm * axesW;
  const ypx = (d) => topY + (yTop - d) / (yTop - dispBase) * terrainH;

  /* --- 行级独立分段（band 行）：各行可拥有与土种格不对齐的条带 --- */
  const bandOf = (row) => (row.band && Array.isArray((c.rowBands || {})[row.key]) && c.rowBands[row.key].length ? c.rowBands[row.key] : null);
  const rowYs = new Map();
  { let acc = tableTop + stripH; rowsOn.forEach(r => { rowYs.set(r.key, { y: acc, h: rowHOf(r) }); acc += rowHOf(r); }); }
  const bandSpans = rowsOn.map(r => ({ row: r, yv: rowYs.get(r.key) })).filter(x => bandOf(x.row));

  /* --- 地形剖面（两种配色：土种色分段渐变（默认）/ 经典灰渐变） --- */
  const terrStyle = LAY.terrStyle === "classic" ? "classic" : "soil";
  // 地形着色段：与色带行一致（土种编号跨格合并时按合并段，否则逐格）
  const terrSegs = (() => {
    const cb = bandOf(c.rows.find(r => r.key === "code") || {});
    if (cb) return cb.map(sg => ({ a: Math.max(0, sg.a ?? 0), b: Math.min(totalKm, sg.b ?? totalKm), color: sg.color }));
    return segs.map((s, i) => ({ a: B[i], b: B[i + 1], color: s.color }));
  })();
  const defs = el("defs", {});
  if (terrStyle === "classic") {
    const grad = el("linearGradient", { id: "terrGrad", x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(el("stop", { offset: "0%", "stop-color": LAY.terr1 || "#b0a99f" }));
    grad.appendChild(el("stop", { offset: "55%", "stop-color": LAY.terr2 || "#ccc7be" }));
    grad.appendChild(el("stop", { offset: "100%", "stop-color": LAY.terr3 || "#e5e2db" }));
    defs.appendChild(grad);
  } else {
    // 全局灰底渐变（userSpaceOnUse：全图灰度一致，不随段内高差变化）
    const gBase = el("linearGradient", { id: "terrBase", gradientUnits: "userSpaceOnUse", x1: 0, y1: topY, x2: 0, y2: ypx(dispBase) });
    gBase.appendChild(el("stop", { offset: "0%", "stop-color": LAY.terr2 || "#ccc7be" }));
    gBase.appendChild(el("stop", { offset: "100%", "stop-color": LAY.terr3 || "#e5e2db" }));
    defs.appendChild(gBase);
    // 表层色带渐变（每段：顶部薄层实色，向下四段过渡至完全透明，与灰底无级融合）
    terrSegs.forEach((sg, i) => {
      const col = sg.color || "#b0a99f";
      const g = el("linearGradient", { id: "terrG" + i, x1: 0, y1: 0, x2: 0, y2: 1 });
      g.appendChild(el("stop", { offset: "0%", "stop-color": col, "stop-opacity": "1" }));
      g.appendChild(el("stop", { offset: "35%", "stop-color": col, "stop-opacity": "0.82" }));
      g.appendChild(el("stop", { offset: "70%", "stop-color": col, "stop-opacity": "0.36" }));
      g.appendChild(el("stop", { offset: "100%", "stop-color": col, "stop-opacity": "0" }));
      defs.appendChild(g);
    });
  }
  svg.appendChild(defs);
  // 公共几何：段内地形点/边界插值（土种色表层、土类色剖面线共用）
  const kmLo = stations[0][0], kmHi = stations[stations.length - 1][0];
  const dispAt = (km) => {
    const kk = Math.min(Math.max(km, kmLo), kmHi);
    let i = 0;
    while (i < stations.length - 2 && stations[i + 1][0] < kk) i++;
    const t = (kk - stations[i][0]) / Math.max(stations[i + 1][0] - stations[i][0], 1e-9);
    return disp[i] + t * (disp[i + 1] - disp[i]);
  };
  const D = LAY.terrBandH > 0 ? Math.round(+LAY.terrBandH) : Math.max(42, Math.round(terrainH * 0.13));   // 表层色带厚度（0=自动）
  // 段范围：首末段扩展覆盖两端外延区；左右各重叠 0.7px 消除相邻段抗锯齿白缝
  const segRange = terrSegs.map((sg, i) => ({
    a: i === 0 ? Math.min(sg.a, kmLo) : sg.a,
    b: i === terrSegs.length - 1 ? Math.max(sg.b, kmHi) : sg.b,
    color: sg.color,
  }));
  const segPts = (a, b) => {
    const ka = Math.min(Math.max(a, kmLo), kmHi), kb = Math.min(Math.max(b, kmLo), kmHi);
    const pts = [[ka, dispAt(ka)]];
    stations.forEach((s, j) => { if (s[0] > ka && s[0] < kb) pts.push([s[0], disp[j]]); });
    pts.push([kb, dispAt(kb)]);
    return pts;
  };
  if (terrStyle === "classic") {
    let dPath = `M ${xpx(stations[0][0])} ${ypx(dispBase)}`;
    stations.forEach((s, i) => dPath += ` L ${xpx(s[0])} ${ypx(disp[i])}`);
    dPath += ` L ${xpx(stations[stations.length - 1][0])} ${ypx(dispBase)} Z`;
    svg.appendChild(el("path", { d: dPath, fill: "url(#terrGrad)", stroke: "none" }));
  } else {
    // 表层着色：色带贴地形表面垂直向下 D 像素（同一土种无论高低位置都有颜色），带下接灰底渐变
    // ① 各段灰底：上边界 = 地形线下移 D（表层带下至基线）
    segRange.forEach(sg => {
      const pts = segPts(sg.a, sg.b);
      if (pts[pts.length - 1][0] - pts[0][0] < 0.3) return;
      let d = `M ${xpx(pts[0][0]) - 0.7} ${ypx(dispBase)}`;
      pts.forEach(p => d += ` L ${xpx(p[0])} ${ypx(p[1]) + D}`);
      d += ` L ${xpx(pts[pts.length - 1][0]) + 0.7} ${ypx(dispBase)} Z`;
      svg.appendChild(el("path", { d, fill: "url(#terrBase)", stroke: "none" }));
    });
    // ② 各段表层色带：地形线与其平行下移线围成的表层条带
    segRange.forEach((sg, i) => {
      const pts = segPts(sg.a, sg.b);
      if (pts[pts.length - 1][0] - pts[0][0] < 0.3) return;
      let d = `M ${xpx(pts[0][0]) - 0.7} ${ypx(pts[0][1]) + D}`;
      pts.forEach(p => d += ` L ${xpx(p[0])} ${ypx(p[1]) + D}`);
      for (let k = pts.length - 1; k >= 0; k--) d += ` L ${xpx(pts[k][0])} ${ypx(pts[k][1])}`;
      d += " Z";
      svg.appendChild(el("path", { d, fill: `url(#terrG${i})`, stroke: "none" }));
    });
  }
  /* --- 地形轮廓线：黑色（整体）或土种色（表面按段着色，端竖线与基线仍为黑） --- */
  if (LAY.terrLine === "soil") {
    segRange.forEach(sg => {
      const pts = segPts(sg.a, sg.b);
      if (pts.length < 2 || pts[pts.length - 1][0] - pts[0][0] < 0.3) return;
      let d = `M ${xpx(pts[0][0])} ${ypx(pts[0][1])}`;
      pts.forEach(p => d += ` L ${xpx(p[0])} ${ypx(p[1])}`);
      svg.appendChild(el("path", { d, fill: "none", stroke: sg.color || "#3f3a36", "stroke-width": 1.5 }));
    });
    svg.appendChild(el("line", { x1: xpx(kmLo), x2: xpx(kmLo), y1: ypx(disp[0]), y2: ypx(dispBase), stroke: "#3f3a36", "stroke-width": 1.5 }));
    svg.appendChild(el("line", { x1: xpx(kmHi), x2: xpx(kmHi), y1: ypx(disp[disp.length - 1]), y2: ypx(dispBase), stroke: "#3f3a36", "stroke-width": 1.5 }));
    svg.appendChild(el("line", { x1: xpx(kmLo), x2: xpx(kmHi), y1: ypx(dispBase), y2: ypx(dispBase), stroke: "#3f3a36", "stroke-width": 1.5 }));
  } else {
    const lineC = LAY.terrLineColor || "#3f3a36";
    let dPath2 = `M ${xpx(stations[0][0])} ${ypx(dispBase)}`;
    stations.forEach((s, i) => dPath2 += ` L ${xpx(s[0])} ${ypx(disp[i])}`);
    dPath2 += ` L ${xpx(stations[stations.length - 1][0])} ${ypx(dispBase)} Z`;
    svg.appendChild(el("path", { d: dPath2, fill: "none", stroke: lineC, "stroke-width": 1.5 }));
  }

  /* --- 高程刻度与网格（可在制图要素中开关） --- */
  if (c.show.elevAxis) {
    const eSpan = res.elev_max - res.elev_min;
    const tickStep = eSpan < 400 ? 100 : (eSpan < 1200 ? 200 : 250);
    const ticks = [];
    for (let t = res.y_base; t <= res.elev_max + tickStep; t += tickStep) {
      if (t * ve <= yTop) ticks.push(t);
    }
    ticks.shift();
    ticks.forEach(t => {
      const y = ypx(t * ve);
      svg.appendChild(el("line", { x1: left, x2: right, y1: y, y2: y, stroke: "#cfcfcf", "stroke-width": 1, "stroke-dasharray": "1,3" }));
      svg.appendChild(el("line", { x1: left - 5, x2: left, y1: y, y2: y, stroke: "#444", "stroke-width": 1 }));
      svg.appendChild(el("text", { x: left - 9, y: y + 4.5, "text-anchor": "end", "font-size": 14.6, fill: "#333" }, String(Math.round(t))));
    });
    const yl = el("text", { x: 0, y: 0, "font-size": 13.2, fill: "#333", "text-anchor": "middle" }, "高程 (m)");
    yl.setAttribute("transform", `translate(${left - 52 * PX}, ${topY + terrainH / 2}) rotate(-90)`);
    svg.appendChild(yl);
  }

  /* --- 地带性界线 --- */
  if (c.show.zones) {
    res.zones.forEach(z => {
      const y = ypx(z.elev * ve);
      if (y < topY - 1 || y > topY + terrainH) return;
      svg.appendChild(el("line", { x1: left, x2: right, y1: y, y2: y, stroke: z.color, "stroke-width": 1.5, "stroke-dasharray": "5.5,4" }));
    });
    const zs = res.zones.slice().sort((a, b) => b.elev - a.elev);
    let prevY = -1e9;
    zs.forEach(z => {
      const y = ypx(z.elev * ve);
      if (y < topY - 2 || y > topY + terrainH) return;
      const ty = Math.max(y + 4, prevY - 14);
      svg.appendChild(el("text", { x: right + 16, y: ty, "font-size": 11.7, fill: z.color }, `${z.elev} m·${z.name}`));
      prevY = ty;
    });
  }

  /* --- 方向指针（右上角单向箭头，可拖） --- */
  const namePlacedRects = [];
  if (c.show.compass) {
    const half = Math.max(30, Math.min(axesW * 0.04, 46));
    let cx2 = right - 26 - half, ay = topY + 30;
    if (c.pointerPos) {
      cx2 = Math.min(Math.max(c.pointerPos.x, left + half + 10), right - half - 10);
      ay = Math.min(Math.max(c.pointerPos.y, topY + 26), topY + terrainH - 20);
    }
    const hintZ = svg.__dragCtx && svg.__dragCtx.dragHint && svg.__dragCtx.dragHint.type === "pointer";
    const aw = 13;
    svg.appendChild(el("line", { x1: cx2 - half, x2: cx2 + half, y1: ay, y2: ay, stroke: "#ffffff", "stroke-width": 5.5, opacity: 0.85 }));
    svg.appendChild(el("line", { x1: cx2 - half, x2: cx2 + half, y1: ay, y2: ay, stroke: hintZ ? "#c0392b" : "#1a1a1a", "stroke-width": 2.2 }));
    svg.appendChild(el("path", { d: `M ${cx2 + half} ${ay} l ${-aw} -6.5 v 13 Z`, fill: hintZ ? "#c0392b" : "#1a1a1a" }));
    svg.appendChild(el("text", { x: cx2, y: ay - 9, "font-size": 14.5, fill: hintZ ? "#c0392b" : "#111", "text-anchor": "middle",
      ...haloAttr, "stroke-width": 4 }, `${res.wind} ${res.azimuth.toFixed(0)}°`));
    svg.appendChild(el("rect", { x: cx2 - half - 14, y: ay - 26, width: 2 * (half + 14), height: 42, fill: "rgba(0,0,0,0)",
      "data-drag": "pointer", "pointer-events": "all", style: "cursor:move" }));
    namePlacedRects.push([cx2 - half - 14, cx2 + half + 16, ay - 24 * PX, ay + 12]);
  }

  /* --- 点位标记 + 高程 + 地名 --- */
  const kmOf = (x) => (x - left) * spanKm / axesW - ext;
  const terrY = (km) => {
    let lo = 0, hi = stations.length - 1;
    if (km <= stations[0][0]) return ypx(disp[0]);
    if (km >= stations[hi][0]) return ypx(disp[hi]);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; stations[m][0] <= km ? lo = m : hi = m; }
    const t = (km - stations[lo][0]) / Math.max(stations[hi][0] - stations[lo][0], 1e-9);
    return ypx(disp[lo] + t * (disp[hi] - disp[lo]));
  };
  const lblHidden = {};
  S.table.forEach(r => { if (r.lbl === false) lblHidden[String(r.no)] = true; });
  const sortedPts = res.points.slice().sort((a, b) => a.ch_km - b.ch_km);
  sortedPts.forEach(p => {
    const cx = xpx(p.ch_km);
    const cy = terrY(p.ch_km);   // 贴合平滑后高程曲线（原始 DEM 采样点会偏离平滑曲线）
    if (lblHidden[String(p.no)]) return;
    const hintP = svg.__dragCtx && svg.__dragCtx.dragHint && svg.__dragCtx.dragHint.type === "point" && String(svg.__dragCtx.dragHint.no) === String(p.no);
    svg.appendChild(el("path", { d: `M ${cx} ${cy - 4.5} l ${hintP ? 7 : 5} ${hintP ? 10 : 8} h ${hintP ? -14 : -10} Z`,
      fill: "#c0392b", stroke: "#7b241c", "stroke-width": hintP ? 2 : 0.7,
      "data-drag": "point", "data-no": p.no, "pointer-events": "all", style: "cursor:ew-resize" }));
    if (c.show.elev) {
      const elevTxt = p.elev.toFixed(0);
      const eHa = p.ch_km < 0.04 * totalKm ? "start" : (p.ch_km > 0.96 * totalKm ? "end" : "middle");
      let eX = p.ch_km < 0.04 * totalKm ? cx + 2 : (p.ch_km > 0.96 * totalKm ? cx - 2 : cx);
      const ew = elevTxt.length * 7.8;
      if (eHa === "middle") {
        if (eX - ew / 2 < left + 4) eX = left + 4 + ew / 2;
        else if (eX + ew / 2 > right - 4) eX = right - 4 - ew / 2;
      } else if (eHa === "start" && eX + ew > right - 4) {
        eX = right - 4 - ew;
      } else if (eHa === "end" && eX - ew < left + 4) {
        eX = left + 4 + ew;
      }
      const eY = Math.min(cy + 9 * PX + 8, topY + terrainH - 5);
      svg.appendChild(el("text", { x: eX, y: eY, "font-size": 13, fill: "#a03030", "text-anchor": eHa, ...haloAttr }, elevTxt));
    }
    if (!c.show.names) return;
    const name = p.name || "—";
    const fsName = 14, lh = 18;
    const lw = name.length * fsName + 10;
    const xHa = p.ch_km < 0.04 * totalKm ? "start"
            : p.ch_km > 0.96 * totalKm ? "end"
            : "middle";
    let baseX = p.ch_km < 0.04 * totalKm ? cx + 4
             : p.ch_km > 0.96 * totalKm ? cx - 4
             : cx;
    if (xHa === "middle") {
      if (baseX - lw / 2 < left + 6) baseX = left + 6 + lw / 2;
      else if (baseX + lw / 2 > right - 6) baseX = right - 6 - lw / 2;
    } else if (xHa === "start" && baseX + lw > right - 6) {
      baseX = right - 6 - lw;
    } else if (xHa === "end" && baseX - lw < left + 6) {
      baseX = left + 6 + lw;
    }
    const DXS = xHa === "start" ? [0, 0.58, 1.12]
              : xHa === "end" ? [0, -0.58, -1.12]
              : [0, 0.58, -0.58, 1.12, -1.12];
    const rectOf = (lx, yTop2) => {
      const rx0 = xHa === "middle" ? lx - lw / 2 : (xHa === "start" ? lx : lx - lw);
      return [rx0, rx0 + lw, yTop2, yTop2 + lh + 2];
    };
    const clashes = (r) => namePlacedRects.some(q => q[0] < r[1] && r[0] < q[1] && q[2] < r[3] && r[2] < q[3]);
    const clearOfTerrain = (r) => {
      let minY = 1e9;
      for (let s2 = 0; s2 <= 4; s2++) {
        const yy = terrY(kmOf(r[0] + (r[1] - r[0]) * s2 / 4));
        if (yy < minY) minY = yy;
      }
      return r[3] <= minY - 2;
    };
    const off = (c.labelOffsets || {})[p.no];
    let pick;
    if (off) {
      const lx = Math.min(Math.max(cx + off.dx, left + lw / 2 + 4), right - lw / 2 - 4);
      const yTop2 = Math.min(Math.max(cy + off.dy, topY + 4), topY + terrainH + 24);
      pick = { lx, yTop: yTop2, up: yTop2 + lh / 2 < cy, dxf: 0, rect: rectOf(lx, yTop2) };
    } else {
      const cands = [];
      for (let k = 0; k < 3; k++) {
        cands.push({ up: true, k, dy: -(34 + k * (lh + 4)) });
        cands.push({ up: false, k, dy: 34 + k * (lh + 4) });
      }
      cands.sort((a, b) => (a.k * 2 + (a.up ? 0 : 3)) - (b.k * 2 + (b.up ? 0 : 3)));
      let pickA = null;
      for (const cd of cands) {
        for (const dxf of [0, 0.58, -0.58, 1.12, -1.12]) {
          if (!DXS.includes(dxf)) continue;
          const lx = baseX + dxf * lw;
          const yTopT = cy + cd.dy;
          const r = rectOf(lx, yTopT);
          if (r[0] < left + 4 || r[1] > right - 4) continue;
          if (cd.up && yTopT < topY + 4) continue;
          if (!cd.up && yTopT + lh > topY + terrainH - 8) continue;
          if (cd.up && !clearOfTerrain(r)) continue;
          if (!clashes(r)) { pickA = { lx, yTop: yTopT, up: cd.up, dxf, rect: r }; break; }
          if (!pickA) pickA = { lx, yTop: yTopT, up: cd.up, dxf, rect: r };
        }
        if (pickA && !clashes(pickA.rect)) break;
      }
      if (!pickA) {
        const yTopT = Math.max(cy - 34 - lh, topY + 4);
        pickA = { lx: baseX, yTop: yTopT, up: true, dxf: 0, rect: rectOf(baseX, yTopT) };
      }
      pick = pickA;
    }
    const labX = pick.lx, labTop = pick.yTop;
    namePlacedRects.push(pick.rect);
    const attachX = xHa === "middle" ? labX - Math.sign(pick.dxf || 0) * lw * 0.42
                  : xHa === "start" ? labX : labX - lw;
    const ly1 = pick.up ? cy - 6 : cy + 24;
    const ly2 = pick.up ? labTop + lh + 2 : labTop - 1;
    svg.appendChild(el("line", { x1: cx, x2: attachX, y1: ly1, y2: ly2,
      stroke: "#888", "stroke-width": 0.8, "stroke-dasharray": "2.6,2.6" }));
    const hintN = svg.__dragCtx && svg.__dragCtx.dragHint && svg.__dragCtx.dragHint.type === "name" && String(svg.__dragCtx.dragHint.no) === String(p.no);
    svg.appendChild(el("text", { x: labX, y: labTop + lh - 2, "font-size": fsName,
      fill: hintN ? "#c0392b" : "#111", "font-weight": hintN ? "bold" : "normal",
      "text-anchor": "middle", "data-drag": "name", "data-no": p.no,
      "pointer-events": "all", style: "cursor:move", ...haloAttr }, name));
  });

  /* --- 水平距离轴 --- */
  if (c.show.axis) {
    const axisY = topY + terrainH;
    svg.appendChild(el("line", { x1: left, x2: right, y1: axisY, y2: axisY, stroke: "#444", "stroke-width": 1.4 }));
    const kmStep = totalKm > 20 ? 5 : (totalKm > 6 ? 1 : 0.5);
    for (let t = 0; t <= spanKm + 1e-9; t += kmStep) {
      const x = xpx(t - ext);
      svg.appendChild(el("line", { x1: x, x2: x, y1: axisY, y2: axisY + 5, stroke: "#444", "stroke-width": 1 }));
      const lbl = Math.abs(t % 1) < 1e-9 ? String(t) : t.toFixed(1);
      svg.appendChild(el("text", { x, y: axisY + 19, "font-size": 14.6, fill: "#333", "text-anchor": "middle" }, lbl));
    }
    svg.appendChild(el("text", { x: left - 9, y: axisY + 13.9, "font-size": 13.2, fill: "#333", "text-anchor": "end" }, "水平距离(km)"));
  }

  /* --- 土种色带 + 表格 --- */
  if (segs.length) {
    const xpx0 = xpx;
    const dispB = B;
    const stripTop = tableTop;
    const showCode = c.rows.find(r => r.key === "code")?.on;
    const codeBand = bandOf(c.rows.find(r => r.key === "code") || {});
    const fitFontCode = (text, cellPx) => Math.max(6, Math.min(15.3, (cellPx - 6) / (text.length * 0.62 * FSTbl)));
    segs.forEach((s, i) => {
      let x0 = xpx0(dispB[i]), x1 = xpx0(dispB[i + 1]);
      if (i === 0) x0 = left;
      if (i === segs.length - 1) x1 = right;
      if (x1 <= x0 + 0.5) return;
      if (!codeBand) {   // 色带行 band 模式：相邻同编号合并，在格循环后按段绘制
        const sel = c.cellSel === i;
        svg.appendChild(el("rect", { x: x0, y: stripTop, width: x1 - x0, height: stripH, fill: s.color, stroke: sel ? "#c0392b" : "#fff", "stroke-width": sel ? 2.6 : 1.4, "data-drag": "cell", "data-i": i, "pointer-events": "all", style: "cursor:pointer" }));
        if (showCode && s.code) {
          svg.appendChild(el("text", { x: (x0 + x1) / 2, y: stripTop + stripH / 2 + 5.5,
            "font-size": fitFontCode(String(s.code), x1 - x0).toFixed(1), "font-weight": "bold",
            fill: contrast(s.color), "text-anchor": "middle", "pointer-events": "none" }, String(s.code)));
        }
      }
      const v = s.tz || "—";
      let ryAcc = stripTop + stripH;
      rowsOn.forEach((row) => {
        const rh = rowHOf(row);
        const ry = ryAcc;
        ryAcc += rh;
        if (bandOf(row)) return;   // band 行在格循环外按行独立绘制（分段与土种格不对齐）；行高已记账
        if (row.key === "profile") {
          const seq = profileSequence(s.tl, s.yl, s.tz);
          if (seq && x1 > x0 + 1) {
            const colW = Math.max(9, Math.min(x1 - x0 - 8, 44));
            const colX = (x0 + x1) / 2 - colW / 2;
            const colH = rh - 14;
            let yy = ry + 7;
            const topY2 = yy;
            seq.forEach(([ln, lc, lw2]) => {
              const hh = lw2 * colH;
              svg.appendChild(el("rect", { x: colX, y: yy, width: colW, height: hh, fill: lc, stroke: "#fff", "stroke-width": 0.7 }));
              if (hh > 11 && colW >= 18) {
                svg.appendChild(el("text", { x: colX + colW / 2, y: yy + hh / 2 + 3.6, "font-size": 8.5,
                  fill: contrast(lc), "text-anchor": "middle", "font-weight": "bold" }, ln));
              }
              yy += hh;
            });
            svg.appendChild(el("line", { x1: colX - 3, x2: colX + colW + 3, y1: topY2, y2: topY2, stroke: "#3f3a36", "stroke-width": 1.6 }));
          }
        } else {
          let lines, fs2;
          if (row.key === "tz") {
            ({ lines, fs: fs2 } = tzFit(v, x1 - x0));
          } else {
            let txt;
            if (row.key === "lith") txt = tblVal(s.no, "lith") || s.lith || parentOf(s.tz, s.tl) || "—";
            else if (row.key === "geo") txt = tblVal(s.no, "geo") || s.geo || "—";
            else txt = s[row.key] || "—";
            fs2 = Math.max(6, Math.min(row.key === "lith" ? 13.5 : 15.3, (x1 - x0 - 8) / (String(txt).length * FSTbl)));
            lines = [String(txt)];
          }
          const lh2 = fs2 * 1.18;
          const yFirst = ry + rh / 2 - (lines.length - 1) * lh2 / 2 + fs2 * 0.36;
          const e = el("text", { x: (x0 + x1) / 2, y: yFirst,
            "font-size": fs2.toFixed(1), fill: "#111", "text-anchor": "middle" });
          lines.forEach((line, li2) => {
            e.appendChild(el("tspan", { x: (x0 + x1) / 2, dy: li2 === 0 ? 0 : lh2 }, line));
          });
          svg.appendChild(e);
        }
      });
    });
    /* --- 色带行 band 模式：相邻同编号合并为宽色带段 --- */
    if (codeBand) {
      codeBand.forEach((sg, k) => {
        let x0 = xpx(Math.max(0, Math.min(sg.a ?? 0, totalKm)));
        let x1 = xpx(Math.max(0, Math.min(sg.b ?? totalKm, totalKm)));
        if (k === 0) x0 = left;
        if (k === codeBand.length - 1) x1 = right;
        if (x1 <= x0 + 0.5) return;
        const selB = c.bandSel && c.bandSel.key === "code" && c.bandSel.k === k;
        svg.appendChild(el("rect", { x: x0, y: stripTop, width: x1 - x0, height: stripH, fill: sg.color || "#ccc", stroke: selB ? "#c0392b" : "#fff", "stroke-width": selB ? 2.6 : 1.4, "data-drag": "bcell", "data-bk": "code", "data-k": k, "pointer-events": "all", style: "cursor:pointer" }));
        if (showCode && sg.text && sg.text !== "—") {
          svg.appendChild(el("text", { x: (x0 + x1) / 2, y: stripTop + stripH / 2 + 5.5,
            "font-size": fitFontCode(String(sg.text), x1 - x0).toFixed(1), "font-weight": "bold",
            fill: contrast(sg.color || "#ccc"), "text-anchor": "middle", "pointer-events": "none" }, String(sg.text)));
        }
        if (k >= 1) {
          const hintBB = svg.__dragCtx && svg.__dragCtx.dragHint && svg.__dragCtx.dragHint.type === "bbound" && svg.__dragCtx.dragHint.key === "code" && svg.__dragCtx.dragHint.i === k;
          svg.appendChild(el("line", { x1: x0, x2: x0, y1: stripTop, y2: stripTop + stripH, stroke: hintBB ? "#c0392b" : "#5a4632", "stroke-width": hintBB ? 2.6 : 1.3, "pointer-events": "none" }));
          svg.appendChild(el("line", { x1: x0, x2: x0, y1: stripTop, y2: stripTop + stripH, stroke: "rgba(192,57,43,0)", "stroke-width": 16, "pointer-events": "all", "data-drag": "bbound", "data-bk": "code", "data-k": k, style: "cursor:ew-resize" }));
        }
      });
    }
    const btmY = tableTop + tableH - 8;
    // 共享边界可见线只在行区内绘制：不穿色带行（色带格白描边自分隔）、
    // 不穿色带下 8px 间隙与行区底部 8px 间隙（避免底稿竖线在段块外透出）
    const rowTop = stripTop + stripH;
    const rowBot = rowTop + rowsOn.reduce((a, r) => a + rowHOf(r), 0);
    const solidSpans = (() => {
      if (!bandSpans.length) return rowBot > rowTop + 0.5 ? [[rowTop, rowBot]] : [];
      const cuts = bandSpans.map(bs => [bs.yv.y, bs.yv.y + bs.yv.h]).sort((p, q) => p[0] - q[0]);
      const spans = []; let cur = rowTop;
      for (const [y0, y1] of cuts) { if (y0 > cur + 0.5) spans.push([cur, y0]); cur = Math.max(cur, y1); }
      if (rowBot > cur + 0.5) spans.push([cur, rowBot]);
      return spans;
    })();
    dispB.slice(1, -1).forEach((b, k) => {
      const j = k + 1, x = xpx0(b);
      const hintB = svg.__dragCtx && svg.__dragCtx.dragHint && svg.__dragCtx.dragHint.type === "bound" && svg.__dragCtx.dragHint.j === j;
      solidSpans.forEach(([y0, y1]) => svg.appendChild(el("line", { x1: x, x2: x, y1: y0, y2: y1, stroke: hintB ? "#c0392b" : "#888", "stroke-width": hintB ? 2.4 : 1, "pointer-events": "none" })));
      svg.appendChild(el("line", { x1: x, x2: x, y1: stripTop, y2: btmY, stroke: "rgba(192,57,43,0)", "stroke-width": 16, "class": "bound-hit", "pointer-events": "all", "data-drag": "bound", "data-j": j, style: "cursor:ew-resize" }));
    });
    /* --- band 行绘制：跨土种条带（不透明段块填满 + 段文字/构型柱 + 行内边界线） --- */
    bandSpans.forEach(({ row, yv }) => {
      const segsB = bandOf(row);
      const rh = yv.h, ry = yv.y;
      segsB.forEach((sg, k) => {
        let x0 = xpx(Math.max(0, Math.min(sg.a ?? 0, totalKm)));
        let x1 = xpx(Math.max(0, Math.min(sg.b ?? totalKm, totalKm)));
        if (k === 0) x0 = left;
        if (k === segsB.length - 1) x1 = right;
        if (x1 <= x0 + 0.5) return;
        const selB = c.bandSel && c.bandSel.key === row.key && c.bandSel.k === k;
        if (row.key === "profile") {
          // 构型柱按段绘制（相邻同序列合并为宽柱）
          const seq = profileSequence(sg.tl, sg.yl, sg.tz);
          if (seq && x1 > x0 + 1) {
            const colW = Math.max(9, Math.min(x1 - x0 - 8, 44));
            const colX = (x0 + x1) / 2 - colW / 2;
            const colH = rh - 14;
            let yy = ry + 7;
            const topY2 = yy;
            seq.forEach(([ln, lc, lw2]) => {
              const hh = lw2 * colH;
              svg.appendChild(el("rect", { x: colX, y: yy, width: colW, height: hh, fill: lc, stroke: "#fff", "stroke-width": 0.7 }));
              if (hh > 11 && colW >= 18) {
                svg.appendChild(el("text", { x: colX + colW / 2, y: yy + hh / 2 + 3.6, "font-size": 8.5,
                  fill: contrast(lc), "text-anchor": "middle", "font-weight": "bold", "pointer-events": "none" }, ln));
              }
              yy += hh;
            });
            svg.appendChild(el("line", { x1: colX - 3, x2: colX + colW + 3, y1: topY2, y2: topY2, stroke: "#3f3a36", "stroke-width": 1.6, "pointer-events": "none" }));
          }
          if (selB) svg.appendChild(el("rect", { x: x0 + 1.5, y: ry + 1.5, width: x1 - x0 - 3, height: rh - 3, fill: "none", stroke: "#c0392b", "stroke-width": 2.2, "pointer-events": "none" }));
        } else {
          if (selB) svg.appendChild(el("rect", { x: x0 + 1.5, y: ry + 1.5, width: x1 - x0 - 3, height: rh - 3, fill: "none", stroke: "#c0392b", "stroke-width": 2.2, "pointer-events": "none" }));
          const v = sg.text == null || sg.text === "" ? "—" : String(sg.text);
          const fit = tzFit(v, x1 - x0);
          const fs2 = Math.min(fit.fs, 15.3);
          const lh2 = fs2 * 1.18;
          const yFirst = ry + rh / 2 - (fit.lines.length - 1) * lh2 / 2 + fs2 * 0.36;
          const e = el("text", { x: (x0 + x1) / 2, y: yFirst, "font-size": fs2.toFixed(1), fill: "#111", "text-anchor": "middle", "pointer-events": "none" });
          fit.lines.forEach((line, li2) => e.appendChild(el("tspan", { x: (x0 + x1) / 2, dy: li2 === 0 ? 0 : lh2 }, line)));
          svg.appendChild(e);
        }
        svg.appendChild(el("rect", { x: x0, y: ry, width: x1 - x0, height: rh, fill: "transparent", "data-drag": "bcell", "data-bk": row.key, "data-k": k, "pointer-events": "all", style: "cursor:pointer" }));
        if (k >= 1) {
          const hintBB = svg.__dragCtx && svg.__dragCtx.dragHint && svg.__dragCtx.dragHint.type === "bbound" && svg.__dragCtx.dragHint.key === row.key && svg.__dragCtx.dragHint.i === k;
          svg.appendChild(el("line", { x1: x0, x2: x0, y1: ry, y2: ry + rh, stroke: hintBB ? "#c0392b" : "#8a5a2a", "stroke-width": hintBB ? 2.6 : 1.3, "pointer-events": "none" }));
          svg.appendChild(el("line", { x1: x0, x2: x0, y1: ry, y2: ry + rh, stroke: "rgba(192,57,43,0)", "stroke-width": 16, "pointer-events": "all", "data-drag": "bbound", "data-bk": row.key, "data-k": k, style: "cursor:ew-resize" }));
        }
      });
    });
    svg.appendChild(el("line", { x1: left, x2: right, y1: stripTop, y2: stripTop, stroke: "#666", "stroke-width": 1.2 }));
    svg.appendChild(el("line", { x1: left, x2: right, y1: stripTop + stripH, y2: stripTop + stripH, stroke: "#666", "stroke-width": 1.2 }));
    let ryAcc2 = stripTop + stripH;
    rowsOn.forEach((row) => {
      const rh = rowHOf(row);
      const ry = ryAcc2;
      ryAcc2 += rh;
      svg.appendChild(el("line", { x1: left, x2: right, y1: ry, y2: ry, stroke: "#999", "stroke-width": 0.7 }));
      svg.appendChild(el("text", { x: left - 9, y: ry + rh / 2 + 4.5, "font-size": 13.9, fill: "#333", "text-anchor": "end" }, row.label));
    });
    svg.appendChild(el("line", { x1: left, x2: right, y1: tableTop + tableH - 8, y2: tableTop + tableH - 8, stroke: "#666", "stroke-width": 1.2 }));
    if (c.rows.find(r => r.key === "code")?.on) {
      svg.appendChild(el("text", { x: left - 9, y: stripTop + stripH / 2 + 4.5, "font-size": 13.9, fill: "#333", "text-anchor": "end" }, "土种编号"));
    }
  }

  /* --- 四边框线 + 拖拽数值气泡 --- */
  svg.appendChild(el("line", { x1: left, x2: right, y1: topY, y2: topY, stroke: "#444", "stroke-width": 1.4 }));
  svg.appendChild(el("line", { x1: left, x2: left, y1: topY, y2: topY + terrainH, stroke: "#444", "stroke-width": 1.4 }));
  svg.appendChild(el("line", { x1: left, x2: left, y1: tableTop, y2: tableTop + tableH - 8, stroke: "#444", "stroke-width": 1.4 }));
  svg.appendChild(el("line", { x1: right, x2: right, y1: topY, y2: topY + terrainH, stroke: "#444", "stroke-width": 1.4 }));
  svg.appendChild(el("line", { x1: right, x2: right, y1: tableTop, y2: tableTop + tableH - 8, stroke: "#444", "stroke-width": 1.4 }));
  if (svg.__dragCtx && svg.__dragCtx.bubble && svg.__dragCtx.bubble.text) {
    const txt = svg.__dragCtx.bubble.text;
    const bw = txt.length * 7.6 + 20;
    const bx = (figW - bw) / 2, by = 8;
    svg.appendChild(el("rect", { x: bx, y: by, width: bw, height: 24, rx: 4, fill: "rgba(30,30,30,0.88)", "pointer-events": "none" }));
    svg.appendChild(el("text", { x: figW / 2, y: by + 16.5, "font-size": 13, fill: "#fff", "text-anchor": "middle", "pointer-events": "none" }, txt));
  }
  svg.__dragCtx = { chs, B, autoB: Bauto, deltaJ, epsB, left, spanKm, axesW, ext, res, c, ppk: axesW / spanKm, ypx, topY, terrainH,
    dragHint: svg.__dragCtx ? svg.__dragCtx.dragHint : null,
    bubble: svg.__dragCtx ? svg.__dragCtx.bubble : null };
  // 部位判定（字号/字体族范围共用）：轴刻度（图区左外侧）/ 表格 / 图面标注
  const scopeOf = (t) => {
    const x = +(t.getAttribute("x") || 0), y = +(t.getAttribute("y") || 0);
    let tx = 0;
    const tr = t.getAttribute("transform");
    if (tr) { const m = tr.match(/translate\(\s*([-\d.]+)/); if (m) tx = +m[1]; }
    const px = x || tx;
    if (px < left - 4) return "axis";
    if (y > tableTop) return "tbl";
    return "lab";
  };
  // 整体字号：按应用范围缩放（viewBox 尺寸不变，字号真实缩放；宽高属性保持 1:1 便于导出）
  if (FS !== 1) {
    const fsScope = LAY.fontScaleScope || "all";
    svg.querySelectorAll("[font-size]").forEach(t => {
      if (fsScope !== "all" && scopeOf(t) !== fsScope) return;
      const v = parseFloat(t.getAttribute("font-size"));
      if (isFinite(v)) t.setAttribute("font-size", (v * FS).toFixed(2));
    });
  }
  // 字体族：按应用范围分部位设置
  const FF = LAY.fontFamily || "";
  if (FF) {
    const scope = LAY.fontScope || "all";
    svg.querySelectorAll("text").forEach(t => {
      if (scope === "all" || scopeOf(t) === scope) t.setAttribute("font-family", FF);
    });
  }
  bindDragEngine(svg);
}

/* ---------------- 统一拖拽引擎（分段线/点位/地名/指针） ---------------- */
let __lastClick = null;
function bindDragEngine(svg) {
  if (svg.__dragEngine) return;
  svg.__dragEngine = true;
  svg.addEventListener("pointerdown", e => {
    const t = e.target.closest("[data-drag]");
    if (!t) {   // 点击图面空白：清除格子/段选中态与编辑条（点击外部取消，Excel 惯例）
      if (e.button !== 0) return;
      if (S.cfg.cellSel != null || S.cfg.bandSel) {
        S.cfg.cellSel = null; S.cfg.bandSel = null;
        hideCellBar();
        if (S.result && document.getElementById("figModal").classList.contains("open")) renderFigure(S.result);
      }
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const type = t.dataset.drag;
    const ctx0 = svg.__dragCtx;
    if (!ctx0) return;
    const rect = svg.getBoundingClientRect();
    const vb = svg.getAttribute("viewBox").split(" ").map(Number);
    const sc = Math.min(rect.width / vb[2], rect.height / vb[3]) || 1;
    const ox = (rect.width - vb[2] * sc) / 2, oy = (rect.height - vb[3] * sc) / 2;
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    const st = { type, key: t.dataset.j ?? t.dataset.no ?? t.dataset.i, bk: t.dataset.bk || null, bkI: t.dataset.k != null ? +t.dataset.k : -1, snap: snapshotState(), moved: false };
    const kmAt = ev => { const x = (ev.clientX - rect.left - ox) / sc; return (x - ctx0.left) * ctx0.spanKm / ctx0.axesW - ctx0.ext; };
    const xyAt = ev => ({ x: (ev.clientX - rect.left - ox) / sc, y: (ev.clientY - rect.top - oy) / sc });
    const move = ev => { if (applyDrag(svg, st, kmAt(ev), xyAt(ev))) st.moved = true; };
    const up = (ev) => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      svg.removeEventListener("pointercancel", up);
      if (svg.__dragCtx) { svg.__dragCtx.bubble = null; }
      if (!st.moved) {
        const now = Date.now();
        const isDbl = __lastClick && __lastClick.type === st.type && String(__lastClick.key) === String(st.key)
          && String(__lastClick.bk || "") === String(st.bk || "") && String(__lastClick.bkI) === String(st.bkI)
          && now - __lastClick.t < 450;
        __lastClick = { type: st.type, key: st.key, bk: st.bk, bkI: st.bkI, t: now };
        if (isDbl) { onDragDblClick(svg, st, ev ? xyAt(ev) : null); __lastClick = null; }
        else if (st.type === "cell") selectCell(+st.key);
        else if (st.type === "bcell" && st.bk) selectBandCell(st.bk, st.bkI);
        if (svg.__dragCtx) renderFigure(svg.__dragCtx.res);
        return;
      }
      afterDragEnd(svg, st);
      pushUndo(st.snap);
      if (svg.__dragCtx) svg.__dragCtx.dragHint = null;   // 拖动结束清高亮，避免红线残留
      renderFigure(svg.__dragCtx.res);
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);
  });
}
function applyDrag(svg, st, km, xy) {
  const ctx = svg.__dragCtx;
  if (!ctx) return false;
  const c = ctx.c;
  if (st.type === "bound") {
    const j = +st.key;
    if (!Array.isArray(c.boundsOverride)) c.boundsOverride = ctx.B.slice();
    const lo = Math.max(ctx.chs[j - 1] + ctx.deltaJ(j), ctx.B[j - 1] + ctx.epsB);
    const hi = Math.min(ctx.chs[j] - ctx.deltaJ(j), ctx.B[j + 1] - ctx.epsB);
    const v = Math.min(Math.max(km, lo), hi);
    if (v === c.boundsOverride[j]) return false;
    c.boundsOverride[j] = v;
    ctx.dragHint = { type: "bound", j };
    ctx.bubble = { text: `边界 ${v.toFixed(2)} km ｜ 左格 ${(v - ctx.B[j - 1]).toFixed(2)}km·${((v - ctx.B[j - 1]) * ctx.ppk).toFixed(0)}px ｜ 右格 ${(ctx.B[j + 1] - v).toFixed(2)}km·${((ctx.B[j + 1] - v) * ctx.ppk).toFixed(0)}px` };
  } else if (st.type === "point") {
    const p = ctx.res.points.find(q => String(q.no) === String(st.key));
    if (!p) return false;
    const chs2 = ctx.chs, i = chs2.findIndex(v => Math.abs(v - p.ch_km) < 1e-9);
    const gap = Math.max(ctx.spanKm * 0.002, 0.01);
    const lo = i > 0 ? chs2[i - 1] + gap : 0, hi = i < chs2.length - 1 ? chs2[i + 1] - gap : ctx.res.total_km;
    const v = Math.min(Math.max(km, lo), hi);
    if (Math.abs(v - p.ch_km) < 1e-6) return false;
    p.ch_km = v;
    const row = S.table.find(r => String(r.no) === String(p.no));
    if (row) { row.ch = +v.toFixed(3); row.manual = true; }
    ctx.dragHint = { type: "point", no: p.no };
    ctx.bubble = { text: `${p.name || "点" + p.no} ｜ 里程 ${v.toFixed(2)} km` };
  } else if (st.type === "name") {
    const p = ctx.res.points.find(q => String(q.no) === String(st.key));
    if (!p) return false;
    const xpxP = ctx.left + (p.ch_km + ctx.ext) / ctx.spanKm * ctx.axesW;
    const ypxP = ctx.ypx ? ctx.ypx(p.elev * ctx.res.ve) : xy.y;
    if (!c.labelOffsets) c.labelOffsets = {};
    const off = { dx: +(xy.x - xpxP).toFixed(1), dy: +(xy.y - ypxP).toFixed(1) };
    if (c.labelOffsets[p.no] && Math.abs(c.labelOffsets[p.no].dx - off.dx) < 0.5 && Math.abs(c.labelOffsets[p.no].dy - off.dy) < 0.5) return false;
    c.labelOffsets[p.no] = off;
    ctx.dragHint = { type: "name", no: p.no };
  } else if (st.type === "pointer") {
    const half = Math.max(30, Math.min(ctx.axesW * 0.04, 46));
    const x = Math.min(Math.max(xy.x, ctx.left + half + 10), ctx.left + ctx.axesW - half - 10);
    const y = Math.min(Math.max(xy.y, ctx.topY + 26), ctx.topY + ctx.terrainH - 20);
    if (c.pointerPos && Math.abs(c.pointerPos.x - x) < 0.5 && Math.abs(c.pointerPos.y - y) < 0.5) return false;
    c.pointerPos = { x: +x.toFixed(1), y: +y.toFixed(1) };
    ctx.dragHint = { type: "pointer" };
  } else if (st.type === "bbound") {
    // 行级分段边界拖拽：钳制在相邻两段之间（不吸附土种格边界，自由不对齐）
    const segsB = (c.rowBands || {})[st.bk];
    if (!Array.isArray(segsB)) return false;
    const i = st.bkI;
    if (i < 1 || i >= segsB.length) return false;
    const minW = Math.max(ctx.spanKm * 0.004, 0.02);
    const lo = segsB[i - 1].a + minW, hi = segsB[i].b - minW;
    const v = Math.min(Math.max(km, lo), hi);
    if (Math.abs(v - segsB[i].a) < 1e-6) return false;
    segsB[i - 1].b = v; segsB[i].a = v;
    const rowLabel = (c.rows.find(r => r.key === st.bk) || {}).label || st.bk;
    ctx.dragHint = { type: "bbound", key: st.bk, i };
    ctx.bubble = { text: `${rowLabel} 边界 ${v.toFixed(2)} km ｜ 左段 ${(v - segsB[i - 1].a).toFixed(2)}km·${((v - segsB[i - 1].a) * ctx.ppk).toFixed(0)}px ｜ 右段 ${(segsB[i].b - v).toFixed(2)}km·${((segsB[i].b - v) * ctx.ppk).toFixed(0)}px` };
  } else return false;
  renderFigure(ctx.res);
  return true;
}
function afterDragEnd(svg, st) {
  if (st.type === "point") computeDebounced();
}
function onDragDblClick(svg, st, xy) {
  const ctx = svg.__dragCtx;
  if (!ctx) return;
  const c = ctx.c;
  if (st.type === "bound" && Array.isArray(c.boundsOverride)) {
    c.boundsOverride[+st.key] = ctx.autoB[+st.key];
    log(`分段边界 ${+st.key} 已恢复自动`);
  } else if (st.type === "name" && c.labelOffsets) {
    delete c.labelOffsets[st.key];
    log("地名标注已恢复自动放置");
  } else if (st.type === "pointer") {
    c.pointerPos = null;
    log("方向指针已回右上角");
  } else if (st.type === "cell") {
    c.cellSel = null; hideCellBar();
    return;
  } else if (st.type === "bbound") {
    // 双击行内分段边界：合并相邻两段（保留左段文字）
    const segsB = (c.rowBands || {})[st.bk];
    if (!Array.isArray(segsB) || st.bkI < 1 || st.bkI >= segsB.length) return;
    const L = segsB[st.bkI - 1], R = segsB[st.bkI];
    segsB.splice(st.bkI - 1, 2, { a: L.a, b: R.b, text: L.text || R.text || "" });
    if (c.bandSel && c.bandSel.key === st.bk) c.bandSel = null;
    hideCellBar();
    const rowLabel = (c.rows.find(r => r.key === st.bk) || {}).label || st.bk;
    log(`${rowLabel}行：双击合并分段（现 ${segsB.length} 段）`);
  } else if (st.type === "bcell" && xy) {
    // 双击行内分段：在点击处拆分为两段
    const segsB = (c.rowBands || {})[st.bk];
    if (!Array.isArray(segsB) || st.bkI < 0 || st.bkI >= segsB.length) return;
    const sg = segsB[st.bkI];
    const minW = Math.max(ctx.spanKm * 0.004, 0.02);
    const km = (xy.x - ctx.left) * ctx.spanKm / ctx.axesW - ctx.ext;
    const v = Math.min(Math.max(km, sg.a + minW), sg.b - minW);
    if (v <= sg.a + minW * 0.5 || v >= sg.b - minW * 0.5) { log("该段太窄，无法再拆分"); return; }
    segsB.splice(st.bkI, 1, { a: sg.a, b: v, text: sg.text || "" }, { a: v, b: sg.b, text: sg.text || "" });
    const rowLabel = (c.rows.find(r => r.key === st.bk) || {}).label || st.bk;
    log(`${rowLabel}行：双击拆分分段（现 ${segsB.length} 段）`);
  } else return;
}
function selectCell(i) {
  S.cfg.cellSel = i;
  showCellBar(i);
  if (S.result) renderFigure(S.result);
}
function selectBandCell(key, k) {
  S.cfg.cellSel = null;
  S.cfg.bandSel = { key, k };
  const segsB = (S.cfg.rowBands || {})[key];
  if (!Array.isArray(segsB) || k < 0 || k >= segsB.length) { hideCellBar(); return; }
  const bar = $("cellBar");
  if (!bar) return;
  bar.style.display = "flex";
  bar.dataset.band = key; bar.dataset.bandK = k;
  delete bar.dataset.i;
  const rowLabel = (S.cfg.rows.find(r => r.key === key) || {}).label || key;
  $("cellBarTitle").textContent = `${rowLabel} · 第 ${k + 1} 段`;
  const cellG = $("cellBarCell"), bandG = $("cellBarBand");
  if (cellG) cellG.style.display = "none";
  if (bandG) bandG.style.display = "inline-flex";
  const inp = $("bandText");
  if (inp) { inp.value = segsB[k].text == null ? "" : String(segsB[k].text); }
  if (S.result) renderFigure(S.result);
}
function showCellBar(i) {
  const bar = $("cellBar");
  if (!bar) return;
  bar.style.display = "flex";
  S.cfg.bandSel = null;
  bar.dataset.i = i;
  delete bar.dataset.band; delete bar.dataset.bandK;
  $("cellBarTitle").textContent = `第 ${i + 1} 格`;
  const cellG = $("cellBarCell"), bandG = $("cellBarBand");
  if (cellG) cellG.style.display = "inline-flex";
  if (bandG) bandG.style.display = "none";
}
function hideCellBar() {
  const bar = $("cellBar");
  if (bar) bar.style.display = "none";
}
function moveBound(j, dKm) {
  const svg = $("figure");
  const ctx = svg.__dragCtx;
  if (!ctx || !S.result) return;
  const c = ctx.c;
  if (!Array.isArray(c.boundsOverride)) c.boundsOverride = ctx.B.slice();
  const lo = Math.max(ctx.chs[j - 1] + ctx.deltaJ(j), ctx.B[j - 1] + ctx.epsB);
  const hi = Math.min(ctx.chs[j] - ctx.deltaJ(j), ctx.B[j + 1] - ctx.epsB);
  const cur = c.boundsOverride[j] ?? ctx.B[j];
  const v = Math.min(Math.max(cur + dKm, lo), hi);
  if (v === cur) return;
  const snap = snapshotState();
  c.boundsOverride[j] = v;
  renderFigure(S.result);
  pushUndo(snap);
}

/* ---------------- 断面工作台弹窗 ---------------- */
function openFigModal() {
  const m = $("figModal");
  if (!m) return;
  m.classList.add("open");
  const t = $("figTitle");
  if (t && S.result) t.textContent = `${S.result.total_km.toFixed(2)} km · ${S.result.points.length} 点 · VE ×${S.result.ve}`;
  renderFigure(S.result);
}
const __figClose = $("figClose");
if (__figClose) __figClose.onclick = () => {
  $("figModal").classList.remove("open");
  if (ML) setTimeout(() => { ML.map.resize(); applyMapData(); }, 30);
};
const __png2 = $("btnPng2");
if (__png2) __png2.onclick = () => exportPng();
const __csv2 = $("btnCsv2");
if (__csv2) __csv2.onclick = () => exportCsv();

/* ---------------- 地图工作台（MapLibre + 标准 XYZ 瓦片） ---------------- */
let ML = null;
const emptyFC = () => ({ type: "FeatureCollection", features: [] });
const lineFC = lines => ({ type: "FeatureCollection", features: (lines || []).filter(l => l.length >= 2).map(l => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l.map(p => [p[0], p[1]]) } })) });
const ptFC = pts => ({ type: "FeatureCollection", features: (pts || []).map((p, i) => ({ type: "Feature", properties: { name: p[2] || "", idx: i }, geometry: { type: "Point", coordinates: [p[0], p[1]] } })) });

function initMapLibre() {
  if (ML) return ML;
  if (typeof maplibregl === "undefined") { $("mapStatus").textContent = "MapLibre 未加载（vendor 缺失）"; return null; }
  // 天地图栅格（矢量底图 + 中文标注）——参考 cultivated-land-evaluation 项目
  const TDT_TOKEN = "48070a069392d01ec314e6ef03338b99";
  const tdtTiles = (pathSuffix, layerName) => {
    const tiles = [];
    for (let i = 0; i <= 7; i++) {
      tiles.push(`https://t${i}.tianditu.gov.cn/${pathSuffix}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
        `&LAYER=${layerName}&STYLE=default&TILEMATRIXSET=w&TILEMATRIX={z}&TILECOL={x}&TILEROW={y}&FORMAT=tiles&tk=${TDT_TOKEN}`);
    }
    return { type: "raster", tiles, tileSize: 256 };
  };
  const map = new maplibregl.Map({
    container: "mapLibre",
    style: {
      version: 8,
      sources: {
        "tdt-img": tdtTiles("img_w", "img"),
        "tdt-cia": tdtTiles("cia_w", "cia"),
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#dfe3e8" } },
        { id: "tdt-img-l", type: "raster", source: "tdt-img" },
        { id: "tdt-cia-l", type: "raster", source: "tdt-cia" },
      ],
    },
    attributionControl: false, doubleClickZoom: false, hash: false,
    center: [106.7, 26.6], zoom: 7.5,   // 默认聚焦贵州省（数据载入后 fitBounds）
  });
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-left");
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-left");
  map.on("load", () => {
    bindMapEvents();
    if (S.map.ov) applyMapData();
  });
  ML = { map, soilGeo: null, demUrl: null };
  return ML;
}

async function refreshMap() {
  if (!S.soil.meta || !S.dem.meta) { $("mapStatus").textContent = "请先在「② 数据源」装载土壤图与 DEM"; return; }
  if (S.map.loading) return;
  const ml = initMapLibre();
  if (!ml) return;
  S.map.loading = true;
  $("mapStatus").textContent = "地图数据准备中…";
  try {
    // DEM 单图（高程色带+山体阴影一次合成，GPU 缩放）
    const di = await invoke("get_dem_image");
    const pngBuf = await invoke("get_dem_png");
    if (ml.demUrl) URL.revokeObjectURL(ml.demUrl);
    ml.demUrl = URL.createObjectURL(new Blob([pngBuf instanceof ArrayBuffer ? new Uint8Array(pngBuf) : new Uint8Array(pngBuf)], { type: "image/png" }));
    // 土壤图 GeoJSON（矢量渲染，点击直读属性）
    const sg = await invoke("get_soil_geojson");
    ml.soilGeo = JSON.parse(sg.geojson);
    // 已装载线/点 + 已存自绘（4326，供显示与回退）
    const ovv = await getCustomData();
    S.map.ov = {
      bounds: sg.bounds,
      e_range: di.e_range,
      lines: (ovv && ovv.lines) || [],
      points: (ovv && ovv.points) || [],
    };
    S.map.customLine = (ovv && ovv.custom_line) || null;
    S.map.customPts = (ovv && ovv.custom_points) || null;
    if (!S.map.ptsLoaded && S.map.customPts && S.map.customPts.length) {
      // 无本地剖面数据时导入已存自绘点为编辑态
      const pr = currentProfile();
      if (!pr.drawPts.length && !pr.drawLine.length) {
        S.map.pts = S.map.customPts.map(p => [p[0], p[1], p[2] || ""]);
        syncMapToProfile();
      }
      S.map.ptsLoaded = true;
    }
    // 数据变化：重置视野并重建 dem/soil 层
    const dataKey = sg.bounds.join(",") + "|" + di.e_range.join(",");
    if (ml.__dataKey && ml.__dataKey !== dataKey) {
      S.map.__fitted = false;
      for (const id of ["dem-l", "soil-fill", "soil-line"]) { if (ml.map.getLayer(id)) ml.map.removeLayer(id); }
      for (const src of ["dem", "soil"]) { if (ml.map.getSource(src)) ml.map.removeSource(src); }
    }
    ml.__dataKey = dataKey;
    $("mapEmpty").style.display = "none";
    applyMapData();
    updateElevLegend(di.e_range.map(v => Math.round(v)));
    $("mapStatus").textContent = `地图就绪：土壤 ${sg.count} 图斑（矢量）· DEM ${di.w}×${di.h}`;
    // DEM/土壤图装载完成 → 图层列表顶部出现对应图层项（未装载不显示）
    ensureBaseLayerItems();
    buildSidebar();
  } catch (e) {
    $("mapStatus").textContent = "地图加载失败: " + e;
    log("地图数据失败: " + e, "err");
  } finally {
    S.map.loading = false;
    log(`地图刷新完成（来源模式：${S.cfg.sourceMode === "import" ? "导入线/点" : "自绘·" + currentProfile().name}）`);
  }
}

/* 已装载线/点 + 已存自绘（4326，由 map_overview 轻量带回） */
async function getCustomData() {
  try {
    return await invoke("map_overview", { gridW: 8 });
  } catch (e) { return null; }
}

function applyMapData() {
  const ml = ML;
  if (!ml || !S.map.ov) return;
  const map = ml.map;
  const st = map.getStyle && map.getStyle();
  if (!st) return;   // 样式未就绪（load 事件里会重调）
  const b = S.map.ov.bounds;
  // ---- 一次性建层（首次） ----
  if (!map.getSource("dem")) {
    if (ml.demUrl) {
      map.addSource("dem", {
        type: "image",
        url: ml.demUrl,
        coordinates: [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]],
      });
      map.addLayer({ id: "dem-l", type: "raster", source: "dem", paint: { "raster-opacity": 0.92 } });
    }
    if (ml.soilGeo) {
      map.addSource("soil", { type: "geojson", data: ml.soilGeo });
      // 土类着色：后端生成时已按内置色表写入 color 属性（权威、无时序依赖）
      map.addLayer({
        id: "soil-fill", type: "fill", source: "soil",
        paint: { "fill-color": ["coalesce", ["get", "color"], "#c8b89a"], "fill-opacity": 0.62 },
      });
      map.addLayer({
        id: "soil-line", type: "line", source: "soil",
        paint: { "line-color": "#4a4438", "line-width": 0.6, "line-opacity": 0.5 },
      });
    }
    // 测距层（工具层，不入图层列表）
    map.addSource("meas-line", { type: "geojson", data: emptyFC() });
    map.addLayer({ id: "meas-line", type: "line", source: "meas-line", paint: { "line-color": "#e67e22", "line-width": 2.2, "line-dasharray": [2, 1.6] } });
    map.addSource("meas-prev", { type: "geojson", data: emptyFC() });
    map.addLayer({ id: "meas-prev", type: "line", source: "meas-prev", paint: { "line-color": "#e67e22", "line-width": 1.4, "line-dasharray": [1.5, 2], "line-opacity": 0.7 } });
    map.addSource("meas-pts", { type: "geojson", data: emptyFC() });
    map.addLayer({ id: "meas-pts", type: "circle", source: "meas-pts", paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": "#e67e22", "circle-stroke-width": 2 } });
    // 动态图层（自绘剖面/导入套）：源 id 与层 id 同名（pl-{pid}/pp-{pid}/il-{id}/ip-{id}）
    initLayerList();
    for (const it of S.layerList) {
      if (it.kind === "prof" || it.kind === "imp") ensureDynamicSource(it);
    }
    bindSoilClick(map);
  } else {
    // 数据更新（换数据）：重建 soil/dem 源
    if (ml.soilGeo && map.getSource("soil")) map.getSource("soil").setData(ml.soilGeo);
  }
  if (!S.map.__fitted) {
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 24, duration: 0 });
    S.map.__fitted = true;
  }
  updateDrawSources();
  bindProfilePtEvents();
  applyLayerOrder();   // 列表顶 = 地图顶层（QGIS 惯例）
}
/* 由里程在断面线上定位坐标（线性链里程累加），异步提取高程/土类填充表格行 */
async function autoFillRowFromChainage(rowIdx, km) {
  const line = currentProfile().drawLine;
  if (!line || line.length < 2) return;
  const segs = [];
  let total = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const d = havM(line[i], line[i + 1]);   // 球面距离：与后端投影里程一致（度差×111320 会忽略纬度收缩）
    segs.push({ a: line[i], b: line[i + 1], len: d });
    total += d;
  }
  const [lng, lat] = pointAtKm(line, km);
  // 坐标同步：把该行对应的剖面点移动到线上里程处（自绘模式里程由坐标投影决定，
  // 只改表格 ch 不动坐标会导致点始终停在原位——新增点默认 0km 处的根因）
  if (S.useCustom) {
    const pr = currentProfile();
    const row = S.table[rowIdx];
    if (pr && row) {
      const num = String(row.no).replace(/^点/, "");
      const idx = pr.drawPts.findIndex(p => {
        const pn = String(p[2] || "").replace(/^点/, "");
        return pn === num || (row.name && p[2] === row.name);
      });
      if (idx >= 0) {
        pr.drawPts[idx] = [lng, lat, pr.drawPts[idx][2]];
        S.map.pts = pr.drawPts.slice();
        updateDrawSources();
        commitCustomPoints().then(() => computeDebounced());
      }
    }
  }
  try {
    const q = await invoke("soil_query", { x: lng, y: lat, epsg: 4326 });
    const row = S.table[rowIdx];
    if (!row) return;
    if (q.elev != null) row.elev = +q.elev.toFixed(1);
    if (q.tl) row.tl = q.tl;
    if (q.yl) row.yl = q.yl;
    if (q.ts) row.ts = q.ts;
    if (q.tz) row.tz = q.tz;
    if (q.admin) row.admin = q.admin;
    if (q.lith) row.lith = q.lith;
    row.name = row.name || ("里程" + km + "km点");
    renderPointsTable();
  } catch (e) { /* 查询失败静默 */ }
}

/* ---------------- 地图测距（📏 模式） ---------------- */
S.measure = { pts: [], done: false };
const lineLenKm = (pts) => { let d = 0; for (let i = 1; i < pts.length; i++) d += havM(pts[i - 1], pts[i]); return d / 1000; };
/* 线上指定里程（km）处的坐标（球面累计+段内插值）；越界钳制到端点 */
function pointAtKm(line, km) {
  if (!line || line.length < 2) return line && line[0] ? line[0].slice() : [0, 0];
  let target = Math.max(0, Math.min(km * 1000, lineLenKm(line) * 1000)), cur = 0;
  for (let i = 1; i < line.length; i++) {
    const d = havM(line[i - 1], line[i]);
    if (cur + d >= target) {
      const t = (target - cur) / Math.max(d, 1e-9);
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
    }
    cur += d;
  }
  return line[line.length - 1].slice();
}
/* 沿折线累计里程裁取 [chA, chB] 米区间子线（端点线性插值）——删端点后缩短剖面线用 */
function trimLineToCh(line, chA, chB) {
  const out = [];
  let acc = 0;
  const at = (p, q, d0, d1, ch) => {
    const t = Math.min(1, Math.max(0, (ch - d0) / Math.max(d1 - d0, 1e-9)));
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  for (let i = 1; i < line.length; i++) {
    const p = line[i - 1], q = line[i];
    const d = havM(p, q), a0 = acc, a1 = acc + d;
    if (a1 >= chA && a0 <= chB) {
      const lo = Math.max(a0, chA), hi = Math.min(a1, chB);
      if (lo > a0) out.push(at(p, q, a0, a1, lo)); else if (!out.length || out[out.length - 1] !== p) out.push(p);
      if (hi < a1) out.push(at(p, q, a0, a1, hi)); else out.push(q);
    }
    acc = a1;
  }
  return out.length >= 2 ? out : line.slice();
}
const havM = (a, b) => {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const measureTotal = () => S.measure.pts.slice(1).reduce((a, p, i) => a + havM(S.measure.pts[i], p), 0);
function updateMeasureLayers(hoverPt) {
  const ml = ML;
  if (!ml || !ml.map.getSource) return;
  const map = ml.map;
  const set = (id, d) => { const s = map.getSource(id); if (s) s.setData(d); };
  set("meas-line", lineFC([S.measure.pts.map(p => [p[0], p[1]])]));
  set("meas-pts", ptFC(S.measure.pts));
  const last = S.measure.pts[S.measure.pts.length - 1];
  set("meas-prev", (!S.measure.done && last && hoverPt) ? lineFC([[[last[0], last[1]], hoverPt]]) : lineFC([]));
}
function updateMeasureBar() {
  const bar = $("measureBar");
  if (!bar) return;
  const n = S.measure.pts.length;
  if (!n) { bar.style.display = "none"; return; }
  const total = measureTotal();
  const txt = total >= 1000 ? (total / 1000).toFixed(2) + " km" : total.toFixed(0) + " m";
  bar.style.display = "";
  bar.innerHTML = `<b>📏 ${txt}</b><span class="mb-sub">${n} 点${S.measure.done ? " · 已完成" : " · 双击结束"}</span>` +
    (S.measure.done ? "" : `<button class="btn tiny" id="mbDone">完成</button>`) +
    `<button class="btn tiny danger" id="mbClear">✕</button>`;
  const d = $("mbDone"); if (d) d.onclick = () => { S.measure.done = true; updateMeasureLayers(); updateMeasureBar(); };
  const c = $("mbClear"); if (c) c.onclick = () => {
    S.measure.pts = []; S.measure.done = false;
    updateMeasureLayers(); updateMeasureBar();
    $("mapStatus").textContent = "测距已清除";
  };
}
/* 点到折线最近点（球面近似：小范围平面） */
function snapToLine(lng, lat, line) {
  if (!line || line.length < 2) return null;
  let best = null, bestD = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let t = ((lng - ax) * dx + (lat - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const d = (lng - px) ** 2 + (lat - py) ** 2;
    if (d < bestD) { bestD = d; best = [px, py]; }
  }
  return best;
}
/* 沿线等距布点（按距离间隔；点数=按步长取整） */
function placePointsAlongLine(intervalKm) {
  const line = currentProfile().drawLine;
  if (line.length < 2) return log("请先绘制断面线", "err");
  const segs = [];
  let total = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const d = havM(line[i], line[i + 1]);   // 球面距离：与后端投影里程一致（度差×111320 会忽略纬度收缩）
    segs.push({ a: line[i], b: line[i + 1], len: d });
    total += d;
  }
  // 等分含首尾：间隔按线长均分微调，首点=0、末点=线终点（避免尾段不满一格造成端部断档）
  const stepReq = Math.max(0.05, intervalKm) * 1000;
  const n = Math.max(1, Math.round(total / stepReq));
  const step = total / n;
  const pts = [];
  let acc = 0, si = 0, cur = 0;
  for (let k = 0; k <= n; k++) {
    const target = Math.min(k * step, total);
    while (si < segs.length - 1 && cur + segs[si].len < target) { cur += segs[si].len; si++; }
    const seg = segs[si];
    const remain = target - cur;
    const t = Math.max(0, Math.min(1, remain / (seg.len || 1)));
    pts.push([seg.a[0] + (seg.b[0] - seg.a[0]) * t, seg.a[1] + (seg.b[1] - seg.a[1]) * t]);
    acc += step;
  }
  currentProfile().drawPts = pts.map((p, i) => [p[0], p[1], "点" + (i + 1)]);
  syncProfileToMap();
  updateDrawSources();
  updateProfileStat();
  refreshCustomSync();   // 已生成断面后自动重算，表格与图同步新增点
  log(`已沿断面线等距生成 ${pts.length} 个点（间隔 ${intervalKm} km）`);
  return pts;
}

/* 自绘点集全量提交后端：重算/表格同步以最新点为基准（删点不复活、加点即时生效） */
async function commitCustomPoints() {
  const pr = currentProfile();
  return invoke("set_custom_points", {
    pts: pr.drawPts.map(p => [p[0], p[1]]),
    names: pr.drawPts.map(p => p[2] || ""),
    epsg: 4326,
  });
}
/* 地图侧 增/删/移 点 后调用：提交后端并重算，断面图与表格自动跟随 */
function refreshCustomSync() {
  if (!S.result || !S.useCustom) return;
  commitCustomPoints().then(() => computeDebounced()).catch(e => log("点同步失败: " + e, "err"));
}

function updateDrawSources() {
  const ml = ML;
  if (!ml || !ml.map.getSource) return;
  const map = ml.map;
  const setD = (id, d) => { const src = map.getSource(id); if (src) src.setData(d); };
  // 每个自绘剖面独立源（pl-{id} 线 / pp-{id} 点），多套并存互不覆盖
  for (const pr of S.profiles) {
    setD("pl-" + pr.id, lineFC([pr.drawLine]));
    setD("pp-" + pr.id, ptFC(pr.drawPts.map(p => [p[0], p[1], p[2] || ""])));
  }
  // 每个导入套独立源
  for (const im of S.imports) {
    if (im.kind === "line") setD("il-" + im.id, lineFC(im.lines || []));
    else setD("ip-" + im.id, ptFC(im.points || []));
  }
}
/* 剖面点编辑交互（选择/拖拽/删除）：绑定所有 pp-* 层，仅当前剖面可编辑 */
function bindProfilePtEvents() {
  const ml = ML;
  if (!ml || !ml.map) return;
  const map = ml.map;
  map.__ppBound = map.__ppBound || new Set();
  for (const pr of S.profiles) {
    const lid = "pp-" + pr.id;
    if (map.__ppBound.has(lid) || !map.getLayer(lid)) continue;
    map.__ppBound.add(lid);
    map.on("click", lid, e => {
      if (S.map.mode !== "view" || pr.id !== S.activeProfile) return;
      const f = e.features && e.features[0];
      window.__selPt = (f && typeof f.properties.idx === "number") ? f.properties.idx : -1;
      $("mapStatus").textContent = window.__selPt >= 0 ? `已选中点${window.__selPt + 1}：Del 删除 · 拖拽移动` : "";
    });
    map.on("mousedown", lid, e => {
      if (S.map.mode !== "view" || pr.id !== S.activeProfile) return;
      const f = e.features && e.features[0];
      window.__selPt = (f && typeof f.properties.idx === "number") ? f.properties.idx : -1;
      window.__dragPt = { lng: e.lngLat.lng, lat: e.lngLat.lat, moved: false };
    });
  }
}
function updateElevLegend(er) {
  const el2 = $("elevLegend");
  if (!el2) return;
  const RAMP = ["#265c3a", "#5c8c3e", "#a8ba5a", "#d6c476", "#b08a5a", "#ded6c6"];
  el2.style.display = "block";
  // 色段竖排 高→低（米白→深绿）：高值标注置顶、低值标注置底，与色带方向对应
  el2.innerHTML = `<div class="el-title">高程</div><div class="el-max">${er[1]} m</div>`
    + RAMP.slice().reverse().map(c => `<div class="el-seg" style="background:${c}"></div>`).join("")
    + `<div class="el-min">${er[0]} m</div>`;
}
/* 点击图斑：属性直读（随要素）+ DEM 高程补充查询 */
function bindSoilClick(map) {
  if (!map.getLayer("soil-fill") || map.__soilClickBound) return;
  map.__soilClickBound = true;
  map.on("click", "soil-fill", e => {
    // 识别为显式模式：仅在「🔍 识别」下点击弹出属性，浏览/画线/布点不干扰
    if (S.map.mode !== "identify") return;
    const p = (e.features && e.features[0] && e.features[0].properties) || {};
    const { lng, lat } = e.lngLat;
    const row = (k, v) => v ? `<div class="mi-row"><span>${k}</span><b>${esc(String(v))}</b></div>` : "";
    const html = `<div class="mi-head">图斑属性</div>`
      + row("土类", p.tl) + row("亚类", p.yl) + row("土属", p.ts) + row("土种", p.tz)
      + row("行政区", p.admin)
      + `<div class="mi-coord">${lng.toFixed(5)}, ${lat.toFixed(5)}</div>`;
    const pop = new maplibregl.Popup({ maxWidth: "240px", closeButton: true }).setLngLat(e.lngLat).setHTML(html).addTo(map);
    invoke("soil_query", { x: lng, y: lat, epsg: 4326 }).then(r => {
      if (r.elev != null) {
        const el = pop.getElement() && pop.getElement().querySelector(".mi-coord");
        if (el) el.insertAdjacentHTML("beforebegin", row("高程", r.elev.toFixed(1) + " m"));
      }
    }).catch(() => {});
  });
  // 悬停手型也仅在识别模式
  map.on("mouseenter", "soil-fill", () => { if (S.map.mode === "identify") map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "soil-fill", () => { if (S.map.mode === "identify") map.getCanvas().style.cursor = ""; });
}

function bindMapEvents() {
  const ml = ML;
  if (!ml || ml.__bound) return;
  ml.__bound = true;
  const map = ml.map;
  const canvas = map.getCanvas();
  map.on("click", e => {
    if (!ml.__clickLogged) { ml.__clickLogged = true; log(`地图点击（模式：${S.map.mode}）`); }
    const impTip = S.cfg.sourceMode === "import" ? " ｜ ⚠ 导入模式：绘制不用于生成，点顶栏「生成断面」选择数据源" : "";
    if (S.map.mode === "line") {
      S.map.draw.push([e.lngLat.lng, e.lngLat.lat]);
      S.map.drawing = true;
      S.map.drawHist.push(S.map.draw.slice(0, -1));
      syncMapToProfile();
      ensureProfileLayerItem(currentProfile());   // 首次绘制时创建剖面图层项（顶部）
      $("mapStatus").textContent = `「${currentProfile().name}」断面线：${S.map.draw.length} 个顶点（双击结束 · Ctrl+Z 撤销）${impTip}`;
      updateDrawSources();
    } else if (S.map.mode === "point") {
      // 布点吸附：点必须落在断面线上（取线最近点）
      const line = currentProfile().drawLine;
      const snapPt = snapToLine(e.lngLat.lng, e.lngLat.lat, line);
      if (!snapPt) {
        $("mapStatus").textContent = `⚠ 请先完成断面线绘制，再沿线布点`;
        return;
      }
      S.map.pts.push([snapPt[0], snapPt[1], "点" + (S.map.pts.length + 1)]);
      S.map.ptsHist.push(S.map.pts.slice(0, -1));
      syncMapToProfile();
      ensureProfileLayerItem(currentProfile());
      updateProfileStat();
      $("mapStatus").textContent = `「${currentProfile().name}」已布 ${S.map.pts.length} 个点（已吸附沿线 · Ctrl+Z 撤销）${impTip}`;
      updateDrawSources();
      refreshCustomSync();   // 已生成断面后：提交新点并重算，表格新增行 + 图新增点
    } else if (S.map.mode === "measure") {
      if (S.measure.done) S.measure.done = false;   // 重新开始新一段
      S.measure.pts.push([e.lngLat.lng, e.lngLat.lat]);
      updateMeasureLayers();
      updateMeasureBar();
    }
  });
  map.on("dblclick", () => {
    if (S.map.mode === "measure") {
      const p = S.measure.pts;
      const last2 = p[p.length - 1], prev = p[p.length - 2];
      if (p.length >= 2 && last2 && prev && last2[0] === prev[0] && last2[1] === prev[1]) p.pop();  // 双击重复点
      S.measure.done = true;
      updateMeasureLayers();
      updateMeasureBar();
      return;
    }
    if (S.map.mode === "line" && S.map.drawing) {
      S.map.drawing = false;
      const n = S.map.draw.length;
      const len = S.map.draw.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - S.map.draw[i][0], p[1] - S.map.draw[i][1]), 0) * 111320;
      $("mapStatus").textContent = n < 2 ? "顶点不足 2 个，请继续绘制" : `「${currentProfile().name}」断面线完成：${n} 顶点 · ${(len / 1000).toFixed(2)} km，可布点或点「✓ 完成」保存`;
      syncMapToProfile();
      updateDrawSources();
      updateProfileStat();
    }
  });
  // 布点管理：view 模式点击剖面点选中 → Del 删除；拖拽移动（吸附沿线）。
  // 选中/按下由 bindProfilePtEvents 写入 window.__selPt / window.__dragPt（按 pp-{pid} 层）
  window.__selPt = -1;
  document.addEventListener("keydown", e => {
    if (e.key === "Delete" && window.__selPt >= 0 && S.map.pts[window.__selPt]) {
      S.map.pts.splice(window.__selPt, 1);
      window.__selPt = -1;
      syncMapToProfile();
      updateDrawSources();
      refreshCustomSync();   // 已生成断面后：提交删减点集并重算，表格与图同步删除
      $("mapStatus").textContent = "已删除所选点";
    }
  });
  map.on("mousemove", e => {
    if (window.__dragPt && Math.hypot(e.lngLat.lng - window.__dragPt.lng, e.lngLat.lat - window.__dragPt.lat) > 0.0002) window.__dragPt.moved = true;
    if (S.map.mode === "measure" && S.measure.pts.length && !S.measure.done) {
      updateMeasureLayers([e.lngLat.lng, e.lngLat.lat]);   // 预览段实时跟随
      updateMeasureBar();
    }
  });
  map.on("mouseup", e => {
    if (window.__dragPt && window.__dragPt.moved && window.__selPt >= 0 && S.map.pts[window.__selPt]) {
      const sn = snapToLine(e.lngLat.lng, e.lngLat.lat, currentProfile().drawLine);
      if (sn) {
        S.map.pts[window.__selPt] = [sn[0], sn[1], S.map.pts[window.__selPt][2]];
        syncMapToProfile();
        updateDrawSources();
        refreshCustomSync();   // 已生成断面后：移动点提交并重算，表格里程/图同步
        $("mapStatus").textContent = "点已移动（吸附沿线）——断面图与表格已同步更新";
      }
    }
    window.__dragPt = null;
  });
  document.querySelectorAll('input[name=mapmode]').forEach(r => r.onchange = () => {
    S.map.mode = document.querySelector('input[name=mapmode]:checked').value;
    if (S.map.mode !== "line") S.map.drawing = false;
    canvas.style.cursor = S.map.mode === "view" || S.map.mode === "identify" ? "" : "crosshair";
    $("mapStatus").textContent = S.map.mode === "line"
      ? "单击加顶点，双击结束"
      : (S.map.mode === "point" ? "单击布点（建议沿线）"
        : (S.map.mode === "identify" ? "识别模式：单击图斑查看土类/土种/高程属性"
          : (S.map.mode === "measure" ? "测距模式：依次单击落点，双击结束（球面距离）"
            : "浏览模式：滚轮缩放 · 拖动平移")));
    if (S.map.mode !== "measure") updateMeasureLayers();   // 切走时清预览线（保留结果）
  });
  $("btnMapFit").onclick = () => {
    if (S.map.ov) map.fitBounds([[S.map.ov.bounds[0], S.map.ov.bounds[1]], [S.map.ov.bounds[2], S.map.ov.bounds[3]]], { padding: 24 });
  };
  $("btnMapClear").onclick = async () => {
    // 先清当前剖面（否则 sync 会回写）
    const pr = currentProfile();
    pr.drawLine = []; pr.drawPts = [];
    S.map.draw = []; S.map.pts = []; S.map.drawing = false; S.map.ptsLoaded = false; S.map.drawHist = []; S.map.ptsHist = [];
    S.map.customLine = null; S.map.customPts = null;
    S.useCustom = false;
    const ub = $("useCustomBadge"); if (ub) ub.style.display = "none";
    try { await invoke("clear_custom"); } catch (e) {}
    log(`已清空剖面「${pr.name}」的绘制`);
    updateDrawSources();
  };
  // 生成入口：先让用户选择本次生成的数据源（自绘剖面 / 导入线/点），更直观
  window.__generateSection = () => showSrcPicker();
}

/* 数据源选择弹层：点「生成断面」时弹出，明确本次用哪套线/点 */
function showSrcPicker() {
  if (!S.soil.meta || !S.dem.meta) return log("请先在「② 数据源」装载土壤图与 DEM", "err");
  const old = $("srcPick");
  if (old) old.remove();
  const profs = S.profiles.filter(pr => pr.drawLine.length >= 2 && pr.drawPts.length >= 1);
  const lineImps = S.imports.filter(i => i.kind === "line");
  const ptsImps = S.imports.filter(i => i.kind === "pts");
  const ov = document.createElement("div");
  ov.id = "srcPick";
  ov.style.cssText = "position:fixed;inset:0;z-index:60;background:rgba(24,20,16,.58);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;";
  const profBtns = profs.length ? profs.map(pr => `
    <button class="src-prof" data-pid="${pr.id}" style="display:block;width:100%;text-align:left;background:var(--ok-bg);border:1px solid rgba(91,122,58,.5);border-radius:8px;padding:10px 14px;margin-bottom:8px;cursor:pointer;font-size:13px;color:var(--text);font-family:inherit;transition:border-color .12s"
      onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='rgba(91,122,58,.5)'">
      <b>✏ 自绘剖面「${esc(pr.name)}」</b>
      <span style="display:block;font-size:11.5px;color:var(--text2);margin-top:3px">线 ${pr.drawLine.length} 顶点 · 点 ${pr.drawPts.length} 个</span>
    </button>`).join("") : '<div class="mini" style="margin:6px 0">尚无绘制完成的剖面（线 ≥2 顶点 + 点 ≥1）</div>';
  ov.innerHTML = `<div style="background:var(--panel);border-radius:12px;padding:20px 24px;min-width:430px;max-width:460px;box-shadow:0 16px 48px rgba(20,16,12,.32);border:1px solid var(--border)">
    <h3 style="margin:0 0 4px;font-size:14.5px;font-weight:700;color:var(--accent-dk)">选择生成数据源</h3>
    <div style="color:var(--text2);font-size:12px;margin-bottom:12px">本次「生成断面」使用哪一套线/点数据</div>
    <div style="font-weight:600;font-size:12.5px;margin:6px 0">✏ 自绘剖面（地图工作台绘制）</div>
    ${profBtns}
    <hr style="border:none;border-top:1px dashed var(--border2);margin:10px 0"/>
    <div style="font-weight:600;font-size:12.5px;margin:6px 0">📂 导入线/点（文件图层）</div>
    <div class="row"><label>线套</label><span class="fill"><select id="srcLineSel" style="width:100%">${
      lineImps.map(i => `<option value="${i.id}" ${i.id === S.genLineId ? "selected" : ""}>${esc(i.name)}</option>`).join("") || '<option value="">（无，请先在侧栏④装载）</option>'
    }</select></span></div>
    <div class="row"><label>点套</label><span class="fill"><select id="srcPtsSel" style="width:100%">${
      ptsImps.map(i => `<option value="${i.id}" ${i.id === S.genPtsId ? "selected" : ""}>${esc(i.name)}</option>`).join("") || '<option value="">（无，请先在侧栏④装载）</option>'
    }</select></span></div>
    <button id="srcPickImpGo" class="btn small primary" style="width:100%;margin-top:8px" ${lineImps.length && ptsImps.length ? "" : "disabled"}>用所选导入套生成</button>
    <div style="text-align:center;margin-top:10px"><button id="srcPickCancel" class="btn small">取消</button></div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll(".src-prof").forEach(b => b.onclick = () => { ov.remove(); generateWithMode("draw", +b.dataset.pid); });
  const go = ov.querySelector("#srcPickImpGo");
  if (go) go.onclick = () => {
    const lid = ov.querySelector("#srcLineSel").value, pid2 = ov.querySelector("#srcPtsSel").value;
    if (!lid || !pid2) return log("请先选择导入线套与点套", "err");
    S.genLineId = lid; S.genPtsId = pid2;
    ov.remove(); generateWithMode("import");
  };
  ov.querySelector("#srcPickCancel").onclick = () => ov.remove();
  ov.addEventListener("click", e => { if (e.target === ov) ov.remove(); });
}

/* 按所选数据源生成断面（自绘：提交指定剖面的线/点；导入：激活所选线/点套后计算） */
async function generateWithMode(mode, profileId) {
  const c = S.cfg;
  c.sourceMode = mode;
  S.useCustom = mode === "draw";
  const ub = $("useCustomBadge");
  if (ub) ub.style.display = S.useCustom ? "" : "none";
  if (mode === "draw") {
    if (!S.map.ov) return log("底图未就绪", "err");
    syncMapToProfile();
    const pr = S.profiles.find(x => x.id === profileId) || currentProfile();
    if (pr.id !== S.activeProfile) { S.activeProfile = pr.id; syncProfileToMap(); }
    const line = pr.drawLine;
    if (line.length < 2) return log(`剖面「${pr.name}」尚无自绘断面线（≥2 顶点）：请在地图工作台画线后重试`, "err");
    const pts = pr.drawPts;
    if (!pts.length) return log(`剖面「${pr.name}」尚未布点（≥1）：请切换「📍 布点」模式沿线点击后重试`, "err");
    try {
      const r1 = await invoke("set_custom_line", { pts: line.map(p => [p[0], p[1]]), epsg: 4326 });
      await invoke("set_custom_points", {
        pts: pts.map(p => [p[0], p[1]]),
        names: pts.map(p => p[2] || ""),
        epsg: 4326,
      });
      const ub2 = $("useCustomBadge");
      if (ub2) { ub2.textContent = `使用剖面「${pr.name}」自绘线点`; ub2.style.display = ""; }
      log(`剖面「${pr.name}」用作断面：线 ${r1.vertices} 顶点 ${r1.length_km} km，点 ${pts.length} 个`);
      compute(true);
    } catch (e) { log("生成失败: " + e, "err"); }
  } else {
    // 导入模式：激活所选线套/点套到后端，写回套配置，再计算
    const li = S.imports.find(x => x.id === S.genLineId);
    const pi = S.imports.find(x => x.id === S.genPtsId);
    if (!li || !pi) return log("尚未选择导入线套/点套：请在⑤导入线/点装载，或弹出层中选择", "err");
    try {
      const ml1 = await invoke("use_line", { path: li.path, layer: li.layer });
      const mp1 = await invoke("use_points", { path: pi.path, layer: pi.layer });
      c.lineIndex = (li.config && li.config.lineIndex) || 0;
      c.ptNoField = (pi.config && pi.config.noField) || "";
      c.ptNameField = (pi.config && pi.config.nameField) || "";
      c.filterMode = (pi.config && pi.config.filterMode) || "field";
      c.filterField = (pi.config && pi.config.filterField) || "";
      c.filterValue = (pi.config && pi.config.filterValue) || "";
      c.filterDist = (pi.config && pi.config.filterDist) || 600;
      S.line.path = li.path; S.line.layer = li.layer; S.line.meta = li.meta;
      S.points.path = pi.path; S.points.layer = pi.layer; S.points.meta = pi.meta;
      const ub2 = $("useCustomBadge");
      if (ub2) { ub2.textContent = `使用导入套：${li.name} + ${pi.name}`; ub2.style.display = ""; }
      log(`导入套已激活：线 ${ml1.lines.length} 条 · 点 ${mp1.count} 个`);
      buildSidebar();
      compute(true);
    } catch (e) { log("导入套激活失败: " + e, "err"); }
  }
}

/* ---------------- 导出 ---------------- */
/* 导出分辨率选择弹层：返回倍率（Promise） */
function pickExportFmt() {
  return new Promise(resolve => {
    const old = $("expFmt");
    if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "expFmt";
    ov.style.cssText = "position:fixed;inset:0;z-index:60;background:rgba(24,20,16,.5);display:flex;align-items:center;justify-content:center;";
    ov.innerHTML = `<div style="background:var(--panel);border-radius:12px;padding:18px 22px;min-width:320px;box-shadow:var(--shadow-3);border:1px solid var(--border)">
      <h3 style="margin:0 0 4px;font-size:14px;color:var(--accent-dk)">导出格式</h3>
      <div style="color:var(--text2);font-size:11.5px;margin-bottom:10px">断面线 + 断面点，WGS84 坐标</div>
      <div style="display:flex;gap:8px">
        <button data-f="shp" class="btn small" style="flex:1;padding:9px 0"><b style="font-size:13px">Shapefile</b><br/><span style="font-size:10.5px;opacity:.75">.shp（UTF-8，GIS 直接打开）</span></button>
        <button data-f="geojson" class="btn small" style="flex:1;padding:9px 0"><b style="font-size:13px">GeoJSON</b><br/><span style="font-size:10.5px;opacity:.75">.geojson（通用轻量）</span></button>
      </div>
      <div style="text-align:center;margin-top:10px"><button id="expFmtCancel" class="btn small">取消</button></div>
    </div>`;
    document.body.appendChild(ov);
    ov.querySelectorAll("button[data-f]").forEach(b => b.onclick = () => { ov.remove(); resolve(b.dataset.f); });
    ov.querySelector("#expFmtCancel").onclick = () => { ov.remove(); resolve(null); };
    ov.addEventListener("click", e => { if (e.target === ov) { ov.remove(); resolve(null); } });
  });
}
function pickExportScale(w, h) {
  return new Promise(resolve => {
    const old = $("expScale");
    if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "expScale";
    ov.style.cssText = "position:fixed;inset:0;z-index:60;background:rgba(24,20,16,.5);display:flex;align-items:center;justify-content:center;";
    const opts = [2, 3, 4, 1];
    ov.innerHTML = `<div style="background:var(--panel);border-radius:12px;padding:18px 22px;min-width:360px;box-shadow:var(--shadow-3);border:1px solid var(--border)">
      <h3 style="margin:0 0 4px;font-size:14px;color:var(--accent-dk)">导出分辨率</h3>
      <div style="color:var(--text2);font-size:11.5px;margin-bottom:10px">当前图幅 ${w}×${h} px（矢量源，导出越高越清晰）</div>
      <div style="display:flex;gap:8px">${opts.map(k =>
        `<button data-k="${k}" class="btn small ${k === 3 ? "primary" : ""}" style="flex:1;padding:8px 0">
          <b style="font-size:13px">${k}×</b><br/><span style="font-size:10.5px;color:inherit;opacity:.75">${w * k}×${h * k}</span>
        </button>`).join("")}</div>
      <div style="text-align:center;margin-top:10px"><button id="expCancel" class="btn small">取消</button></div>
    </div>`;
    document.body.appendChild(ov);
    ov.querySelectorAll("button[data-k]").forEach(b => b.onclick = () => { ov.remove(); resolve(+b.dataset.k); });
    ov.querySelector("#expCancel").onclick = () => { ov.remove(); resolve(null); };
    ov.addEventListener("click", e => { if (e.target === ov) { ov.remove(); resolve(null); } });
  });
}
async function exportPng() {
  if (!S.result) return log("请先生成断面", "err");
  const svg = $("figure");
  const w0 = +svg.getAttribute("width"), h0 = +svg.getAttribute("height");
  const scale = await pickExportScale(w0, h0);
  if (!scale) return;
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = async () => {
    const w = +svg.getAttribute("width"), h = +svg.getAttribute("height");
    const cv = document.createElement("canvas");
    cv.width = w * scale; cv.height = h * scale;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise(resolve => cv.toBlob(resolve, "image/png"));
    const buf = await blob.arrayBuffer();
    const p = await invoke("dlg_save", { title: "导出 PNG", defaultName: "土壤断面图.png", filterName: "PNG 图像", filterExt: "*.png" });
    if (!p) return;
    await invoke("write_bytes_file", { path: p, data: Array.from(new Uint8Array(buf)) });
    log(`PNG 已导出: ${p}（${w * scale}×${h * scale} px）`);
  };
  img.onerror = () => log("SVG 渲染失败", "err");
  img.src = url;
};
async function exportCsv() {
  if (!S.result) return log("请先生成断面", "err");
  const head = ["点编号", "地名", "段起点km", "段终点km", "土种编号", "土类", "亚类", "土属", "土种", "行政区", "母岩母质", "颜色", "段内高程min", "段内高程mean", "段内高程max"];
  const byNo = new Map(S.table.map(r => [r.no, r]));
  const rows = S.result.segments.map(s => {
    const t = byNo.get(s.no) || {};
    return [s.no, t.name ?? "", (+s.x0_km).toFixed(3), (+s.x1_km).toFixed(3), t.code ?? s.code, t.tl ?? s.tl, t.yl ?? s.yl, t.ts ?? s.ts, t.tz ?? s.tz,
      t.admin ?? "", t.lith ?? "", s.color, s.emin.toFixed(1), s.emean.toFixed(1), s.emax.toFixed(1)].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
  });
  const csv = "\ufeff" + head.join(",") + "\n" + rows.join("\n");
  const p = await invoke("dlg_save", { title: "导出分段 CSV", defaultName: "断面土种分段表.csv", filterName: "CSV", filterExt: "*.csv" });
  if (!p) return;
  await invoke("write_text_file", { path: p, content: csv });
  log("CSV 已导出: " + p);
};

/* ---------------- 项目保存/打开 ---------------- */
/* 项目状态序列化（保存用；导入套坐标打开时按 path/layer 重新提取） */
function buildProjectState() {
  return {
    gdalDir: S.gdal.dir, cfg: S.cfg, table: S.table,
    profiles: S.profiles, activeProfile: S.activeProfile, nextProfileId: S.nextProfileId,
    paths: { line: S.line.path, lineLayer: S.line.layer, points: S.points.path, pointsLayer: S.points.layer, soil: S.soil.path, soilLayer: S.soil.layer, dem: S.dem.path },
    imports: S.imports.map(i => ({ id: i.id, kind: i.kind, name: i.name, path: i.path, layer: i.layer, config: i.config, style: i.style })),
    genLineId: S.genLineId, genPtsId: S.genPtsId, nextImpId: S.nextImpId,
    layers: S.layerList.filter(x => !x.fixed).map(x => ({ id: x.id, kind: x.kind, sub: x.sub, name: x.name, visible: x.visible, profileId: x.profileId, impId: x.impId, style: x.style })),
  };
}
/* 项目状态恢复（打开用；导入套坐标重新提取，底图按需重载） */
async function applyProject(proj) {
  Object.assign(S.cfg, proj.cfg || {});
  S.table = proj.table || [];
  if (Array.isArray(proj.profiles) && proj.profiles.length) {
    S.profiles = proj.profiles;
    S.activeProfile = proj.activeProfile || S.profiles[0].id;
    S.nextProfileId = proj.nextProfileId || (Math.max(...S.profiles.map(p => p.id)) + 1);
    syncProfileToMap();
  }
  // 图层配置（固定层重建；动态层按保存配置恢复）
  initLayerList();
  S.layerList = (proj.layers || []).map(x => ({ ...x, fixed: false })).concat(S.layerList.filter(x => x.fixed));   // 动态层在顶、影像底图在底
  S.imports = [];
  S.genLineId = proj.genLineId || ""; S.genPtsId = proj.genPtsId || "";
  S.nextImpId = proj.nextImpId || 1;
  S.gdal.dir = proj.gdalDir || "";
  const P = proj.paths || {};
  if (S.gdal.dir && !S.gdal.ok) { await initGdal(S.gdal.dir); await loadBuiltin(); }
  // 导入套：按 path/layer 重新提取坐标并装载到后端（保持多套并存）
  const impReload = async (im) => {
    try {
      if (im.kind === "line") {
        im.meta = await invoke("use_line", { path: im.path, layer: im.layer });
        S.line.meta = im.meta;
        const lg = await invoke("layer_geojson", { kind: "line" });
        im.lines = lg.lines || [];
        S.line.path = im.path; S.line.layer = im.layer;
      } else {
        im.meta = await invoke("use_points", { path: im.path, layer: im.layer });
        S.points.meta = im.meta;
        const lg = await invoke("layer_geojson", { kind: "points" });
        im.points = lg.points || [];
        S.points.path = im.path; S.points.layer = im.layer;
      }
      S.imports.push(im);
      return true;
    } catch (e) { log(`导入套恢复失败：${im.name}（${e}）`, "err"); return false; }
  };
  for (const im of (proj.imports || [])) { await impReload(im); }
  const reload = async (kind, path, layer) => {
    if (!path || !layer) return;
    const src = S[kind]; src.path = path;
    src.layers = await invoke("vector_layers", { path });
    src.layer = layer;
    await useLayerNow(kind);
  };
  await reload("soil", P.soil, P.soilLayer);
  if (P.dem) { S.dem.path = P.dem; S.dem.meta = await invoke("use_dem", { path: P.dem }); }
  buildSidebar(); renderPointsTable();
  if (S.soil.meta && S.dem.meta) refreshMap();
}
$("btnProjectSave").onclick = async () => {
  const proj = buildProjectState();
  const p = await invoke("dlg_save", { title: "保存项目", defaultName: "断面项目.json", filterName: "JSON", filterExt: "*.json" });
  if (!p) return;
  await invoke("write_text_file", { path: p, content: JSON.stringify(proj, null, 2) });
  log("项目已保存: " + p);
};
$("btnProjectOpen").onclick = async () => {
  const p = await invoke("dlg_open", { title: "打开项目", filterName: "JSON", filterExt: "*.json", pickDir: false });
  if (!p) return;
  try {
    const proj = JSON.parse(await invoke("read_text_file", { path: p }));
    await applyProject(proj);
    log("项目已打开: " + p);
    compute(true);
  } catch (e) { log("打开项目失败: " + e, "err"); }
};

/* ---------------- 其余按钮 ---------------- */
// 生成断面：始终先让用户选择数据源（自绘剖面 / 导入套），保证指向性
$("btnCompute").onclick = () => window.__generateSection();
$("btnUndo").onclick = doUndo;
$("btnRedo").onclick = doRedo;
/* 土种编码/色带表：导入用户 JSON / 导出模板 / 恢复内置 */
$("btnCodesImport").onclick = async () => {
  const pth = await invoke("dlg_open", { title: "导入土种编码/色带 JSON", filterName: "JSON", filterExt: "*.json", pickDir: false });
  if (!pth) return;
  try {
    const r = await invoke("import_builtin", { path: pth });
    await loadBuiltin();
    log(`编码/色带已导入：土种 ${r.codes} 条 · 颜色 ${r.colors} 条（生成与着色即时生效）`);
  } catch (e) { log("导入失败: " + e, "err"); }
};
$("btnCodesTpl").onclick = async () => {
  const pth = await invoke("dlg_save", { title: "导出模板（含当前全部表）", defaultName: "土种编码色带模板.json", filterName: "JSON", filterExt: "*.json" });
  if (!pth) return;
  const tpl = { codes: S.builtin.codes, colors: S.builtin.colors };
  await invoke("write_text_file", { path: pth, content: JSON.stringify(tpl, null, 2) });
  log("模板已导出（修改后可导入覆盖）: " + pth);
};
$("btnCodesReset").onclick = async () => {
  try { await invoke("reset_builtin"); await loadBuiltin(); log("已恢复内置编码/色带表"); } catch (e) { log("恢复失败: " + e, "err"); }
};
/* 导出当前编码方案表为 CSV（全省统一 / 区县重编随当前方案；色值 Hex 与 RGB 元组置末列，Excel 可直接打开） */
$("btnCodesExport").onclick = async () => {
  const useCounty = S.cfg.codeScheme === "county" && S.builtinCounty;
  if (useCounty && !S.builtinCounty.codes.length) return log("区县方案尚未生成：请先装载土壤图并切换为区县重编", "err");
  const all = useCounty ? S.builtinCounty.codes : S.builtin.codes;
  const cmap = useCounty ? S.builtinCounty.colorByName : (S.builtin.colorByName || {});
  const q = ($("codeSearch")?.value || "").trim();
  const rows = all.filter(r => !q || [r.code, r.tz, r.ts, r.yl, r.tl].some(v => String(v || "").includes(q)));
  const rgbOf = (hex) => {
    const h = String(hex || "").replace("#", "");
    if (h.length !== 6) return "";
    return `(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)})`;
  };
  const esc2 = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const csv = ["\uFEFF编号,土类,亚类,土属,土种,色值Hex,RGB"]
    .concat(rows.map(r => [r.code, r.tl, r.yl, r.ts, r.tz, (cmap[r.tz] || cmap[r.tl] || ""), rgbOf(cmap[r.tz] || cmap[r.tl] || "")].map(esc2).join(",")))
    .join("\r\n");
  const schemeName = useCounty ? "区县重编" : "全省统一";
  const suffix = q ? "-" + q : "";
  const pth = await invoke("dlg_save", { title: `导出编码表（${schemeName}）`, defaultName: `土种编码表-${schemeName}${suffix}.csv`, filterName: "CSV", filterExt: "*.csv" });
  if (!pth) return;
  await invoke("write_text_file", { path: pth, content: csv });
  log(`编码表已导出（${schemeName}，${rows.length} 条${q ? "，含搜索筛选" : ""}）: ` + pth);
};
$("btnAddPoint").onclick = async () => {
  if (S.useCustom) {
    // 自绘模式：同步往当前剖面点集加一个点（断面线起点），提交后端并重算，
    // 否则重算以旧点集为准，表格新增行会"复活消失"
    const line = currentProfile().drawLine;
    if (line.length < 2) return log("自绘模式：请先绘制断面线，再新增点", "err");
    const pr = currentProfile();
    // 新点默认放线中点：不与首点（里程 0）重合——放起点会出现两行 0 里程且无法分辨，
    // 编辑错行会把原首点移走而新点留在原位（表现为"只添加了一个点，原来的还在"）
    const mid = pointAtKm(line, lineLenKm(line) / 2);
    const newNo = pr.drawPts.length + 1;
    pr.drawPts.push([mid[0], mid[1], "点" + newNo]);
    S.map.pts = pr.drawPts.slice();
    updateDrawSources();
    try { await commitCustomPoints(); } catch (e) { log("点提交失败: " + e, "err"); }
    S.__flashRow = newNo;   // 表格渲染时定位高亮新行
    computeDebounced();
    log(`已在「${pr.name}」线中点（约 ${(lineLenKm(line) / 2).toFixed(1)} km）新增点${newNo}：请修改「里程 km」将其移到目标位置`);
    return;
  }
  const no = (S.table.reduce((m, r) => Math.max(m, r.no), 0) || 0) + 1;
  S.table.push({ no, name: "新点" + no, ch: 0, elev: 0, code: "", tz: "", ts: "", yl: "", tl: "", geo: "", profile: "", admin: "", lith: "", manual: true });
  renderPointsTable();
  log(`已新增点 ${no}：请填写「里程 km」列，将自动沿线定位并提取土种/高程`);
};
$("btnResetPoints").onclick = () => {
  if (!S.result) return;
  S.table = S.result.points.map(p => ({
    no: p.no, name: p.name, ch: +p.ch_km.toFixed(3), elev: +p.elev.toFixed(1),
    code: p.code, tz: p.tz, ts: p.ts, yl: p.yl, tl: p.tl, geo: "", profile: "", admin: p.admin || "", lith: p.lith || "", manual: false,
  }));
  renderPointsTable(); computeDebounced();
  log("断面点表格已从数据源重置");
};
$("btnAutoBounds").onclick = () => {
  const snap = snapshotState();
  S.cfg.boundsOverride = null;
  if (S.result) renderFigure(S.result);
  pushUndo(snap);
  log("分段格宽已恢复自动分配（maximin）");
};
document.querySelectorAll("#cellBar button[data-mb]").forEach(b => b.onclick = () => {
  const i = +$("cellBar").dataset.i;
  const step = Math.max(0.05, +$("cellStep").value || 0.5);
  const d = +b.dataset.mb * step;
  moveBound(b.dataset.side === "L" ? i : i + 1, d);
});
$("cellBarClose").onclick = () => { S.cfg.cellSel = null; S.cfg.bandSel = null; hideCellBar(); if (S.result) renderFigure(S.result); };
/* 行分段编辑条：文字 / 中点拆分 / 合并右段 */
const __bt = $("bandText");
if (__bt) {
  let __btT = null;
  __bt.oninput = () => {
    const bar = $("cellBar");
    const bKey = bar.dataset.band;
    const segsB = (S.cfg.rowBands || {})[bKey];
    const k = +bar.dataset.bandK;
    if (!Array.isArray(segsB) || !(k >= 0) || k >= segsB.length) return;
    segsB[k].text = __bt.value;
    // 土种编号行：新编号 → 当前编码方案表 → 色带色同步（拆分改码后色带随之更新）
    if (bKey === "code") {
      const useCounty = S.cfg.codeScheme === "county" && S.builtinCounty;
      const tblCodes = useCounty ? S.builtinCounty.codes : (S.builtin.codes || []);
      const tblColors = useCounty ? S.builtinCounty.colorByName : (S.builtin.colorByName || {});
      const rec = tblCodes.find(r => String(r.code) === String(__bt.value).trim());
      if (rec) {
        const col = tblColors[rec.tz] || tblColors[rec.tl];
        if (col) segsB[k].color = col;
      }
    }
    clearTimeout(__btT);
    __btT = setTimeout(() => renderFigure(S.result), 180);   // 去抖即时渲染，输入跟手
  };
}
const __bs = $("bandSplit");
if (__bs) __bs.onclick = () => {
  const bar = $("cellBar");
  const segsB = (S.cfg.rowBands || {})[bar.dataset.band];
  const k = +bar.dataset.bandK;
  const svg = $("figure"), ctx = svg.__dragCtx;
  if (!Array.isArray(segsB) || !(k >= 0) || k >= segsB.length || !ctx) return;
  const sg = segsB[k];
  const minW = Math.max(ctx.spanKm * 0.004, 0.02);
  if (sg.b - sg.a < minW * 2) { log("该段太窄，无法再拆分"); return; }
  const snap = snapshotState();
  const v = (sg.a + sg.b) / 2;
  segsB.splice(k, 1, { a: sg.a, b: v, text: sg.text || "" }, { a: v, b: sg.b, text: sg.text || "" });
  renderFigure(S.result);
  pushUndo(snap);
};
const __bm = $("bandMerge");
if (__bm) __bm.onclick = () => {
  const bar = $("cellBar");
  const segsB = (S.cfg.rowBands || {})[bar.dataset.band];
  const k = +bar.dataset.bandK;
  if (!Array.isArray(segsB) || !(k >= 0) || k >= segsB.length - 1) { log("已是最后一段，无右段可合并"); return; }
  const snap = snapshotState();
  const L = segsB[k], R = segsB[k + 1];
  segsB.splice(k, 2, { a: L.a, b: R.b, text: L.text || R.text || "" });
  renderFigure(S.result);
  selectBandCell(bar.dataset.band, k);
  pushUndo(snap);
};
const cs2 = $("codeSearch");
if (cs2) cs2.oninput = renderCodesTable;
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  document.querySelectorAll(".tabpanes > .pane").forEach(p => p.classList.remove("active"));
  $("pane-" + t.dataset.tab).classList.add("active");
});

/* ---------------- 内置表加载与启动 ---------------- */
async function loadBuiltin() {
  try {
    const bt = await invoke("builtin_tables");
    S.builtin.codes = bt.codes || [];
    S.builtin.colors = bt.colors || [];
    S.builtin.tlNames = bt.tl_names || [];
    S.builtin.colorByName = {};
    (S.builtin.colors || []).forEach(cc => { S.builtin.colorByName[cc.name || cc.tl] = cc.hex || cc.color; });
    S.builtinCounty = null;
    if (bt.county) {
      const m = {};
      (bt.county.colors || []).forEach(cc => { m[cc.name || cc.tl] = cc.hex || cc.color; });
      S.builtinCounty = { codes: bt.county.codes || [], colorByName: m };
    }
    renderCodesTable();
    buildSidebar();
  } catch (e) { /* 未初始化时忽略 */ }
}
/* 编码方案切换：全省统一 ↔ 区县重编（重算编号/颜色 → 拉方案表 → band 快照按新值序列重建） */
async function applyCodeScheme(v) {
  S.cfg.codeScheme = v;
  if (S.result && $("figure") && $("figure").__dragCtx) {
    await compute(true);
    await loadBuiltin();
    S.cfg.rows.forEach(rw => {
      if (rw.band) {
        const sg = initBandSegs(rw);
        if (sg) { if (!S.cfg.rowBands) S.cfg.rowBands = {}; S.cfg.rowBands[rw.key] = sg; }
      }
    });
    renderFigure(S.result);
  } else {
    await loadBuiltin();
  }
  log(S.cfg.codeScheme === "county" ? "已切换区县重编：按土壤图面积重新编号与配色" : "已切换全省统一编码");
}
(async () => {
  buildSidebar();
  renderPointsTable();
  try {
    const dir = await invoke("gdal_default_dir");
    if (dir) {
      S.gdal.dir = dir;
      await initGdal(dir);
      await loadBuiltin();
    }
  } catch (e) { /* 便携目录缺失时由侧栏①手动初始化 */ }
  setTimeout(() => { initMapLibre(); }, 60);   // 主界面常驻地图
  if (S.soil.meta && S.dem.meta) refreshMap();
})();
