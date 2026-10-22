/* ==========================================================================
 * HP-DeepLore  v1.0.0（完整版）
 * 《HP贵族》原著深度素材插件
 * --------------------------------------------------------------------------
 * 标准三文件：manifest.json + index.js + style.css
 * 仓库只分发代码；小说 txt 与索引由用户本地上传，存 IndexedDB，不上传任何服务器
 * --------------------------------------------------------------------------
 * 功能：
 *  · 拦截发送 → 并行检索原文 / 推断情绪 / 组装画像 → 审查认知边界 → 注入
 *  · 三级变量回退（ST API → chat_metadata → 解析 UpdateVariable）
 *  · 年级判定四级回退（斯科皮比哈利低两级，1993 入学 = 一年级）
 *  · 时间硬过滤（防未来泄露）+ 已亲历/世界历史 标记
 *  · 8 套 LLM 提示词，各自可指定 API；任一步失败自动降级不影响其他步
 *  · 10 条 API 池 + 令牌桶 RPM 限流 + 重试 + 超时
 *  · 侧栏节点进度（可手动标记结算）、原文跳转、注入预览、缓存、冲突检测
 * ========================================================================== */
/* ==========================================================================
 * HP-DeepLore  v1.0.0  完整版
 * 《HP贵族》原著深度素材插件
 * 标准三文件：manifest.json / index.js / style.css
 * 仓库仅分发代码；txt 与索引由用户本地上传，存 IndexedDB，不上传任何服务器
 * ========================================================================== */
/* --------------------------------------------------------------------------
 * 【重要】不使用任何 import。
 * ST 把 API 挂在全局，直接运行时取：
 *   window.extension_settings / SillyTavern.getContext / window.eventSource
 * 这样无论插件放在 extensions/third-party/ 的哪一层、ST 是什么版本都能加载。
 * （此前用相对路径 import 曾导致模块解析失败、整个文件不执行）
 * -------------------------------------------------------------------------- */

/* ---- 全局 API 安全获取 ---- */
function ST() { return window.SillyTavern || window.SillyTavernContext || {}; }
function stExtensionSettings() {
  const o = window.extension_settings || ST().extension_settings;
  if (!o) { window.extension_settings = window.extension_settings || {}; return window.extension_settings; }
  return o;
}
function stGetContext() {
  if (typeof window.getContext === 'function') return window.getContext();
  const S = ST();
  if (typeof S.getContext === 'function') return S.getContext();
  return {};
}
let __saveTimer = null;
let __flushTimer = null;

/* 【修 v1.10】设置双写兜底。
   此前只依赖 ST 的 saveSettingsDebounced：万一它没写成功（版本差异、扩展未就绪、
   或 ST 把扩展设置存在别处），novelMeta / indexMeta / apis 就会在刷新后全部丢失，
   界面显示"没有小说"但 IndexedDB 里其实还有 → 用户误以为要重新上传。
   现在：先写自己的 localStorage 备份（一定成功），再调 ST 的保存。 */
const LS_BACKUP = 'hp_deeplore_settings_backup';
/* 【修 v1.24】API 配置独立存储。
   API 是最容易丢、丢了最烦的配置（要重新填 base/key/模型），但原方案把它和整份设置
   一起交给 ST 的 extension_settings + 防抖保存，链路一断就全没。
   现在 API 单独占一个 localStorage key，任何改动【同步立即写】，不等任何防抖。
   这样即使 ST 没保存成功、页面立刻刷新，API 也一定还在。 */
const LS_APIS = 'hp_deeplore_apis_v1';

function saveApisNow() {
  try {
    const arr = Array.isArray(settings?.apis) ? settings.apis : [];
    localStorage.setItem(LS_APIS, JSON.stringify({ t: Date.now(), apis: arr }));
    return true;
  } catch (e) {
    console.warn('[HP-DeepLore] API 独立存储写入失败：', e.message);
    return false;
  }
}

/* 读取独立存储的 API。返回 null 表示这份存储不存在/不可用 */
function loadApisStandalone() {
  try {
    const raw = localStorage.getItem(LS_APIS);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !Array.isArray(o.apis)) return null;
    return o;
  } catch (e) { return null; }
}

function writeLocalBackup() {
  try {
    localStorage.setItem(LS_BACKUP, JSON.stringify(stExtensionSettings()[EXT_ID] || {}));
    return true;
  } catch (e) {
    console.warn('[HP-DeepLore] 本地备份写入失败：', e.message);
    return false;
  }
}

function stSaveSettings() {
  clearTimeout(__saveTimer);
  // 立即写本地备份，不等防抖
  writeLocalBackup();
  __saveTimer = setTimeout(() => {
    writeLocalBackup();
    try {
      if (typeof window.saveSettingsDebounced === 'function') { window.saveSettingsDebounced(); return true; }
      const S = ST();
      if (typeof S.saveSettingsDebounced === 'function') { S.saveSettingsDebounced(); return true; }
      if (typeof S.saveSettings === 'function') { S.saveSettings(); return true; }
      return true; // 本地备份已写，不算失败
    } catch (e) { /* 忽略，本地备份已保底 */ }
  }, 300);
}

/* 【修 v1.23】立即落盘：不等防抖，同步写本地备份并立刻调 ST 保存。
   用于页面隐藏/卸载、切面板、关面板等"可能来不及防抖"的时刻。 */
function flushSettings() {
  try { clearTimeout(__flushTimer); } catch (e) { /* 忽略 */ }
  __flushTimer = null;
  try { clearTimeout(__saveTimer); } catch (e) { /* 忽略 */ }
  __saveTimer = null;
  try {
    settings.__savedAt = Date.now();
    stExtensionSettings()[EXT_ID] = settings;
    saveApisNow();          /* 【修 v1.24】同步写，不等防抖 */
    writeLocalBackup();
    const S = ST();
    if (typeof window.saveSettingsDebounced === 'function') { window.saveSettingsDebounced(); return true; }
    if (typeof S.saveSettingsDebounced === 'function') { S.saveSettingsDebounced(); return true; }
    if (typeof S.saveSettings === 'function') { S.saveSettings(); return true; }
    return true;
  } catch (e) { return false; }
}
/* 输入过程中用：先更新内存，200ms 内没有新输入再真正落盘（避免每敲一字写一次） */
function schedulePersist() {
  try { clearTimeout(__flushTimer); } catch (e) { /* 忽略 */ }
  __flushTimer = setTimeout(() => { try { flushSettings(); } catch (e) { /* 忽略 */ } }, 200);
}
/* 【修 v1.23】把面板里"已输入但还没失焦"的值强制回收进 settings。
   原逻辑只绑 change：change 要等失焦才触发，填完直接刷新/切后台 → 值根本没进 settings。 */
function syncInputsFromDOM(root) {
  const scope = root || document;
  /* 【v1.23.2 重要】只回收"用户真的敲过"的字段（data-dirty=1）。
     反例：程序改了 settings.memBase 却没重渲染面板，DOM 里还是旧值——
     若不加区分地回收，就会用陈旧的 DOM 值覆盖刚写进去的正确配置（实测踩过）。 */
  const dirty = el => !!(el && el.dataset && el.dataset.dirty === '1');
  try {
    scope.querySelectorAll('[data-api]').forEach(el => {
      if (!dirty(el)) return;
      const i = Number(el.dataset.api), f = el.dataset.f;
      if (!settings.apis || !settings.apis[i] || !f) return;
      settings.apis[i][f] = (f === 'rpm' || f === 'concurrency') ? Number(el.value) : el.value;
    });
    scope.querySelectorAll('[data-num]').forEach(el => {
      if (dirty(el)) settings[el.dataset.num] = Number(el.value) || 0;
    });
    scope.querySelectorAll('[data-str]').forEach(el => {
      if (dirty(el)) settings[el.dataset.str] = el.value;
    });
    /* 下拉框一律跳过：select 点选即触发 change，本就不会"未失焦丢失"；
       同步它的 value 反而会把渲染时不在 options 里的值写成空串，覆盖真实配置。 */
    scope.querySelectorAll('[data-txt]').forEach(el => {
      if (el.tagName === 'SELECT' || !dirty(el)) return;
      settings[el.dataset.txt] = el.value;
    });
    scope.querySelectorAll('.hp-ptxt[data-pk]').forEach(el => {
      if (!dirty(el)) return;
      const k = el.dataset.pk;
      settings.prompts[k] = settings.prompts[k] || {};
      settings.prompts[k].text = el.value;
    });
    scope.querySelectorAll('.hp-tier').forEach(el => {
      if (!dirty(el)) return;
      if (!Array.isArray(settings.tiers)) settings.tiers = TIERS.map(t => t.max);
      settings.tiers[Number(el.dataset.i)] = Number(el.value) || 0;
    });
  } catch (e) { /* 忽略：回收失败不影响主流程 */ }
}
/* 回收 + 立即落盘，供卸载 / 切页 / 关面板调用 */
function persistNow(root) {
  try { syncInputsFromDOM(root); } catch (e) { /* 忽略 */ }
  try { return flushSettings(); } catch (e) { return false; }
}

/* 载入时优先用 ST 的设置，缺失则用本地备份补齐 */
function restoreFromBackup() {
  try {
    const cur = stExtensionSettings()[EXT_ID];
    const bak = JSON.parse(localStorage.getItem(LS_BACKUP) || 'null');
    if (!bak || typeof bak !== 'object') return cur;
    if (!cur || typeof cur !== 'object' || !Object.keys(cur).length) return bak;
    /* 【修 v1.23】原判断是 cur[k] == null 才补——空数组 [] 不等于 null，
       于是"ST 里存着 apis:[]"会永远压住本地备份，API 刷新后必丢。
       改成：谁的时间戳新谁做基准，另一边补空字段（空数组/空对象都算空）。 */
    const tCur = Number(cur.__savedAt) || 0;
    const tBak = Number(bak.__savedAt) || 0;
    const base = tCur >= tBak ? cur : bak;
    const other = tCur >= tBak ? bak : cur;
    const isEmpty = v => v == null
      || (Array.isArray(v) && v.length === 0)
      || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
    for (const k of ['apis', 'novelMeta', 'indexMeta', 'aliasMap', 'nodeMap', 'prompts', 'tiers']) {
      if (isEmpty(base[k]) && !isEmpty(other[k])) base[k] = other[k];
    }
    return base;
  } catch (e) { return stExtensionSettings()[EXT_ID]; }
}
function stEventSource() {
  return window.eventSource || ST().eventSource || { on: () => {} };
}
function stEventTypes() {
  return window.event_types || ST().event_types || {};
}

const EXT_ID = 'hp-deeplore';
const EXT_VER = 'v1.26.0';
const EXT_NAME = 'HP DeepLore';
const DB_NAME = 'hp_deeplore';
const DB_VER = 1;
const STORE = {
  novel: 'novel', index: 'index', alias: 'alias', nodemap: 'nodemap',
  cache: 'cache', stats: 'stats', meta: 'meta',
};

/* 年级映射：斯科皮比哈利低两级，1993 入学 = 一年级 */
const ORIG_MAP = { Y1: '三年级', Y2: '四年级', Y3: '五年级', Y4: '六年级', Y5: '七年级' };
const LABEL_MAP = { Y1: '一年级', Y2: '二年级', Y3: '三年级', Y4: '四年级', Y5: '五年级' };
const CN_NUM = ['一', '二', '三', '四', '五'];
const TIERS = [
  { key: '敌视', max: -60 }, { key: '排斥', max: -20 }, { key: '冷淡', max: 19 },
  { key: '缓和', max: 49 }, { key: '亲近', max: 79 }, { key: '亲密', max: 100 },
];
const DRACO = 'char_draco_malfoy';

/* ------------------------ 默认设置 ------------------------ */
const DEFAULTS = {
  enabled: true,
  intercept: true,
  timeoutMs: 250000,
  maxRetry: 3,
  rerunOnRegenerate: true,
  aiTranslateLines: true,
  previewBeforeInject: false,
  cognitionCheck: true,
  cognitionMode: 'rewrite',
  maxChars: 3,
  tokenBudget: 2000,
  // 【v1.17】上一轮正文：拦截模式读不到本轮正文，只能读上一轮及更早
  historyTurns: 3,     // 读最近几轮
  historyChars: 3000,  // 正文截断长度
  topK: 3,
  recallTop: 30,
  // 【v1.13】整章召回：命中某章后补全该章全部块，避免"注入一半剧情就没了"
  chapterRecall: true,     // 开=整章；关=块级（旧行为）
  chapterMaxChars: 3000,   // 单章字符上限，0=不限
  chapterMaxCount: 2,      // 最多注入几章
  minQueryLen: 8,
  lineCount: 4,
  tierSource: 'affinity',
  tiers: TIERS.map(t => t.max),
  dracoDetail: true,
  dracoOffstageKeepPrep: true,
  showCognitionBadge: true,
  collapseByDefault: true,
  showLockedNodes: true,
  theme: 'slytherin',
  chunkSize: 400,
  chunkOverlap: 60,
  charFilterEnabled: false,
  boostWords: '',
  penaltyWords: '',
  cacheEnabled: true,
  cacheTTL: 600000,
  cacheSim: 0.82,
  conflictCheck: true,
  // 【v1.16】POV 二次过滤：注入前剥离斯科皮（{{user}}）的言行句。默认关。
  povFilter: false,
  // 【v1.18】永久记忆（Termux 后端 SQLite）。总开关默认关，需手动开启并检测连通。
  memEnabled: false,
  memBase: 'http://127.0.0.1:8899',
  memToken: '',
  memAutoProbe: true,      // 周期性自动检测（仅面板可见/已开启时低频探测）
  memProbeSec: 20,
  // 更新：默认关闭，允许手动每轮更新
  memAutoUpdate: false,
  memTurnsPerUpdate: 2,    // 每次更新扫描几轮（含本轮）
  memExtractApi: '',       // 抽取用 LLM，留空=按用途标签自动择
  memEmbedApi: '',         // 记忆向量用 embedding，留空=跟主 embedding
  memMinImportance: 3,     // 低于此重要度不入库
  memMaxPerTurn: 6,        // 单次最多入库几条事件
  memCharCap: 3000,        // 记忆注入字符上限（独立预算，不挤占原文）
  memTopK: 25,             // 检索条数
  memTimeoutMs: 15000,     // 后端请求超时
  memLastFloor: 0,         // 已同步到第几楼（0=从未）
  memDedup: 0.78,          // 后端去重阈值（写入时同步给后端）
  memGraph: true,          // 【v1.19】图扩散检索：多跳联想，救 IDF 抓不到的远期记忆
  memGraphLimit: 400,      // 图谱可视化节点上限
  // 【v1.25】剧情条目控制：插件按当前进度启用/禁用世界书里的章节剧情条目
  plotCtlOn: false,        // 总开关，默认关
  plotAutoRun: false,      // 每轮生成结束后自动定位（默认关，可手动点）
  plotRange: 1,            // 启用「当前章 ±N 章」，N=1 → 前一章/本章/下一章
  plotManualCh: 0,         // 手动指定章号，0=不指定（交给自动判定）
  plotTrustManual: false,  // true=手动值优先于自动判定
  plotLastCh: 0,           // 上次定位结果
  plotLastWhy: '',
  plotLastAt: 0,
  apis: [],
  embedApi: '',   // 【v1.10】建索引/向量检索单独指定；留空则按用途自动选
  prompts: {},
  aliasMap: {},
  nodeMap: {},
  novelMeta: null,
  indexMeta: null,
};
let settings = structuredClone(DEFAULTS);

/* ------------------------ IndexedDB ------------------------ */
function openDB() {
  return new Promise((res, rej) => {
    /* 【修 v1.23】隐私模式/老浏览器可能没有 indexedDB，原写法会直接抛
       ReferenceError 并产生未捕获 rejection，索引面板状态永远刷不出来。 */
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      rej(new Error('当前浏览器不支持 IndexedDB（可能是隐私模式），小说与索引将无法保存'));
      return;
    }
    let r;
    try { r = indexedDB.open(DB_NAME, DB_VER); } catch (e) { rej(e); return; }
    r.onupgradeneeded = e => {
      const db = e.target.result;
      for (const k of Object.values(STORE)) if (!db.objectStoreNames.contains(k)) db.createObjectStore(k);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(store, key, val) {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(val, key);
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { console.warn('[HP-DeepLore] 写入本地存储失败：', e?.message || e); return false; }
}
async function idbGet(store, key) {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const rq = tx.objectStore(store).get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  } catch (e) { console.warn('[HP-DeepLore] 读取本地存储失败：', e?.message || e); return null; }
}
async function idbDel(store, key) {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { console.warn('[HP-DeepLore] 删除本地存储失败：', e?.message || e); return false; }
}
async function idbKeys(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const rq = tx.objectStore(store).getAllKeys();
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

/* ------------------------ 变量读取（三级回退） ------------------------ */
function getStatData() {
  try {
    const ctx = stGetContext();
    if (ctx?.variables?.stat_data && Object.keys(ctx.variables.stat_data).length) return ctx.variables.stat_data;
    if (ctx?.chatMetadata?.stat_data && Object.keys(ctx.chatMetadata.stat_data).length) return ctx.chatMetadata.stat_data;
  } catch (e) { /* 忽略 */ }
  try {
    const ctx = stGetContext();
    const md = ctx?.chat_metadata ?? ctx?.chatMetadata;
    if (md?.stat_data && Object.keys(md.stat_data).length) return md.stat_data;
    if (md && md.stat_data !== undefined && Object.keys(md).length) {
      const root = md.stat_data || md;
      if (root && (root.世界 || root.主角 || root.NPC档案)) return root;
    }
  } catch (e) { /* 忽略 */ }
  try {
    const ctx = stGetContext();
    const chat = ctx?.chat;
    if (Array.isArray(chat) && chat.length) {
      for (let i = chat.length - 1; i >= 0; i--) {
        const mes = chat[i]?.mes ?? '';
        const m = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/.exec(mes);
        if (!m) continue;
        const body = m[1].trim();
        let obj = null;
        try { obj = JSON.parse(body); } catch (e) {
          const jm = /\{[\s\S]*"stat_data"[\s\S]*\}/.exec(body);
          if (jm) { try { obj = JSON.parse(jm[0]); } catch (e2) { obj = null; } }
        }
        if (obj?.stat_data) return obj.stat_data;
        if (obj && (obj.世界 || obj.主角 || obj.NPC档案)) return obj;
      }
    }
  } catch (e) { /* 忽略 */ }
  return {};
}

/* ==========================================================================
 * 【v1.17】上一轮正文读取
 * 拦截模式发生在 AI 生成之前，因此「本轮正文」在物理上尚不存在。
 * 插件能读到的上限就是「上一轮及更早」——这是拦截模式的边界，不是缺陷。
 * 但此前代码完全没读正文，只解析 <UpdateVariable> 的 JSON，
 * 导致情绪推断只能看到冷冰冰的数字（好感度 -45），看不到「上一轮他摔门说了狠话」。
 * 这一层补上后，情绪/预测动作/准备动作才真正接得上戏。
 * ========================================================================== */
function stripUpdateBlocks(mes) {
  let s = String(mes || '');
  s = s.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '');
  s = s.replace(/<hp-lore>[\s\S]*?<\/hp-lore>/gi, '');
  s = s.replace(/```[\s\S]*?```/g, '');
  return s.trim();
}
function recentContext(n) {
  const out = { turns: [], text: '', total: 0 };
  try {
    const ctx = stGetContext();
    const chat = ctx?.chat;
    if (!Array.isArray(chat) || !chat.length) return out;
    const maxTurns = Math.max(1, Math.min(10, n ?? settings?.historyTurns ?? 3));
    const maxChars = Math.max(400, Math.min(12000, settings?.historyChars ?? 3000));
    const buf = [];
    for (let i = chat.length - 1; i >= 0 && buf.length < maxTurns * 2; i--) {
      const m = chat[i];
      const raw = stripUpdateBlocks(m?.mes);
      if (!raw) continue;
      const who = m?.is_user ? '{{user}}' : (m?.name || '{{char}}');
      buf.unshift(`${who}：${raw}`);
    }
    out.turns = buf;
    let t = buf.join('\n');
    if (t.length > maxChars) t = t.slice(-maxChars);
    out.text = t;
    out.total = t.length;
  } catch (e) { /* 忽略 */ }
  return out;
}

/* ------------------------ 年级判定（斯科皮口径） ------------------------ */
function parseGradeNum(text) {
  if (text == null) return null;
  const s = String(text);
  let m = /([一二三四五六七1-7])\s*年级/.exec(s);
  if (m) {
    const cn = '一二三四五六七'.indexOf(m[1]);
    return cn >= 0 ? cn + 1 : Number(m[1]);
  }
  m = /(\d)/.exec(s);
  return m ? Number(m[1]) : null;
}
function currentGrade(sd) {
  const g1 = parseGradeNum(sd?.主角?.身份覆盖?.学校?.当前年级);
  if (g1 >= 1 && g1 <= 5) return 'Y' + g1;
  const g2 = parseGradeNum(sd?.主角?.学业?.课表?.学年);
  if (g2 >= 1 && g2 <= 5) return 'Y' + g2;
  const ge = parseGradeNum(sd?.世界?.事件年代 || sd?.世界?.当前学年);
  if (ge) { const s = ge - 2; if (s >= 1 && s <= 5) return 'Y' + s; }
  const now = String(sd?.世界?.当前时间 || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(now);
  if (m) {
    const startYear = now.slice(5, 10) >= '07-01' ? Number(m[1]) : Number(m[1]) - 1;
    const s = startYear - 1992;
    if (s >= 1 && s <= 5) return 'Y' + s;
  }
  return 'Y1';
}

/* ------------------------ 档位判定 ------------------------ */
const ROUTE_TIER = {
  未相识: '冷淡', 对立: '排斥', 朋友: '缓和', 感情萌芽: '亲近',
  互相承认: '亲近', 关系破裂: '敌视', 修复中: '缓和', 伴侣: '亲密', 路线结束: '冷淡',
};
/* 纯函数：好感度数值 → 档位名（供界面试算与内部判定共用） */
function tierFromAff(aff) {
  const t = settings.tiers || DEFAULTS.tiers;
  const v = Number.isFinite(Number(aff)) ? Number(aff) : 0;
  if (v <= t[0]) return '敌视';
  if (v <= t[1]) return '排斥';
  if (v <= t[2]) return '冷淡';
  if (v <= t[3]) return '缓和';
  if (v <= t[4]) return '亲近';
  return '亲密';
}

function tierOf(sd, charId) {
  const npc = sd?.NPC档案?.[charId] || {};
  const aff = Number.isFinite(Number(npc.好感度)) ? Number(npc.好感度) : 0;
  const byAff = () => tierFromAff(aff);
  if (settings.tierSource === 'route') {
    const st = sd?.世界线?.关系路线进程?.阶段;
    if (st && ROUTE_TIER[st] && sd?.世界线?.关系路线进程?.状态 !== '未启用') return { tier: ROUTE_TIER[st], aff, src: 'route' };
    return { tier: byAff(), aff, src: 'affinity(fallback)' };
  }
  if (settings.tierSource === 'higher') {
    const a = byAff();
    const st = sd?.世界线?.关系路线进程?.阶段;
    const r = ROUTE_TIER[st];
    if (r && TIERS.findIndex(x => x.key === r) > TIERS.findIndex(x => x.key === a)) return { tier: r, aff, src: 'higher' };
    return { tier: a, aff, src: 'higher' };
  }
  return { tier: byAff(), aff, src: 'affinity' };
}


/* ==========================================================================
 * API 层：池管理 + 令牌桶限流 + embedding / rerank / LLM
 * ========================================================================== */
const bucket = new Map();
/* RPM 取值语义：未填/非法 → 默认 60；<=0 → 不限速（并发才能真正跑满） */
function apiRpm(name) {
  const api = settings.apis.find(a => a.name === name);
  if (!api) return 60;
  const raw = api.rpm;
  if (raw === undefined || raw === null || raw === '') return 60;
  const v = Number(raw);
  return isFinite(v) ? v : 60;
}
function takeToken(name) {
  const api = settings.apis.find(a => a.name === name);
  if (!api) return false;
  const rpm = apiRpm(name);
  // 【v1.20】RPM 为 0 表示不限速：不再占用令牌桶，并发路数得以真正生效
  if (rpm <= 0) return true;
  const now = Date.now();
  let b = bucket.get(name);
  if (!b || now - b.t0 > 60000) { b = { t0: now, tokens: rpm }; bucket.set(name, b); }
  const elapsed = (now - b.t0) / 60000;
  b.tokens = Math.min(rpm, b.tokens + elapsed * rpm);
  b.t0 = now;
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  return false;
}
function waitMs(name) {
  const rpm = apiRpm(name);
  if (rpm <= 0) return 0;              // 不限速时永不等待
  const b = bucket.get(name);
  if (!b) return 0;
  return Math.max(0, Math.ceil((1 - b.tokens) / rpm * 60000) + 50);
}
async function acquire(name) {
  let tries = 0;
  while (!takeToken(name)) {
    if (++tries > 120) throw new Error('RPM 限流等待超时：' + name);
    await sleep(Math.min(waitMs(name), 1000));
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* --------------------------------------------------------------------------
 * 【v1.14】并发执行器
 *  par = 额外并发路数：0 → 完全串行（一次一个）；1 → 同时 2 路；N → 同时 N+1 路
 *  任一路失败不影响其他路，失败项返回 {ok:false}
 * -------------------------------------------------------------------------- */
async function runPool(items, worker, par) {
  const extra = Math.max(0, Math.floor(Number(par) || 0));
  const lanes = Math.max(1, 1 + extra);
  const out = new Array(items.length);
  let cursor = 0;
  const lane = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try { out[i] = { ok: true, v: await worker(items[i], i) }; }
      catch (e) { out[i] = { ok: false, e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane));
  return out;
}
/* 取某条 API 的并发路数（0=串行） */
function apiPar(api) { return Math.max(0, Math.floor(Number(api?.concurrency) || 0)); }

async function withRetry(fn, label) {
  let last;
  const n = Math.max(1, settings.maxRetry);
  for (let i = 0; i < n; i++) {
    try {
      return await Promise.race([
        fn(),
        new Promise((_, rj) => setTimeout(() => rj(new Error('超时')), settings.timeoutMs)),
      ]);
    } catch (e) {
      last = e;
      if (i < n - 1) await sleep(300 * (i + 1));
    }
  }
  throw new Error(`${label || '请求'}失败（重试${n}次）：${last?.message || '未知'}`);
}

function statAdd(key, n) {
  const m = settings.stats || (settings.stats = {});
  const d = new Date(); const mk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  m[mk] = m[mk] || { req: 0, tok: 0 };
  m[mk][key] = (m[mk][key] || 0) + (n || 1);
}
function statGet() {
  const m = settings.stats || {};
  const d = new Date(); const mk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  return m[mk] || { req: 0, tok: 0 };
}

/* ---- 底层请求 ---- */
async function apiPost(api, path, body) {
  await acquire(api.name);
  const url = String(api.base || '').replace(/\/+$/, '') + path;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (api.key || '') },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = r.status + '';
    try { const j = await r.json(); msg += ' ' + (j.error?.message || j.message || ''); } catch (e) { /* 忽略 */ }
    if (r.status === 401) msg += '（Key 错误）';
    if (r.status === 404) msg += '（Base URL 或路径错误）';
    throw new Error(msg);
  }
  statAdd('req', 1);
  return r.json();
}

/* ---- embedding ---- */
async function embed(texts) {
  const api = pickApi('embed');
  if (!api) throw new Error('未配置 embedding API');
  const model = api.model;
  const j = await apiPost(api, '/embeddings', { model, input: texts });
  statAdd('tok', Math.ceil(JSON.stringify(texts).length / 2));
  const arr = (j.data || []).map(x => x.embedding).filter(Boolean);
  if (!arr.length) throw new Error('embedding 返回为空');
  return arr;
}
/* 用途常量 */
const API_USES = [
  { key: 'embed',  label: '向量 embedding' },
  { key: 'rerank', label: '重排 rerank' },
  { key: 'llm',    label: '对话 LLM' },
];

/* 归一化旧数据：老字段 type:'embed' → uses:['embed'] */
function apiUses(a) {
  if (Array.isArray(a?.uses) && a.uses.length) return a.uses;
  const legacy = a?.type;
  if (legacy === 'embed' || legacy === 'rerank' || legacy === 'llm') return [legacy];
  // 旧档或未指定 → 视为全能，避免因"没勾用途"导致功能静默失效
  return ['embed', 'rerank', 'llm'];
}
function apiReady(a) { return !!(a && a.base && a.key && a.model); }

/* 【修 v1.9】此前用 (a.type||'embed')===type 硬过滤：
   用户把 embedding 服务标成别的类型、或压根没设 type，就永远找不到 → embedding 静默失败。
   现在改为：优先按用户勾选的用途找；找不到就退而用任意一条已配置完整的 API，
   绝不因为"类型标签不对"而让功能失效。 */
function pickApi(type) {
  const apis = settings.apis || [];
  // 【v1.10】指定优先：建索引可单独指定 embedding API，不受用途标签影响
  if (type === 'embed' && settings.embedApi) {
    const named = apis.find(a => a.name === settings.embedApi && apiReady(a));
    if (named) return named;
    console.warn(`[HP-DeepLore] 指定的 embedding API「${settings.embedApi}」不可用（未配置完整），改用自动选择`);
  }
  const exact = apis.filter(a => apiUses(a).includes(type) && apiReady(a));
  if (exact.length) return exact[0];
  const any = apis.filter(apiReady);
  if (any.length) {
    console.warn(`[HP-DeepLore] 未找到勾选「${type}」且配置完整的 API，改用「${any[0].name}」`);
    return any[0];
  }
  return null;
}
function pickApiByName(name) { return settings.apis.find(a => a.name === name) || null; }

/* ---- rerank ----
 * 【v1.17】精排不再与「建索引」绑定。
 * 此前 rerank 只能在检索面板靠用途标签选 API，跟 embedding 混在一起，
 * 想单独给精排配一个便宜/专用的模型做不到。
 * 现在改为：优先用「提示词」面板里 ⑨ 单独指定的 API，留空才退回用途标签。 */
async function rerank(query, docs) {
  const named = promptApi('rerank');
  const api = (named && pickApiByName(named)) || pickApi('rerank');
  if (!api || !docs.length) return docs.map((d, i) => ({ ...d, rr: 0, i }));
  try {
    const j = await apiPost(api, '/rerank', {
      model: api.model, query,
      documents: docs.map(d => d.text),
      top_n: Math.min(docs.length, Math.max(1, settings.topK)),
    });
    const out = (j.results || []).map(x => ({ ...docs[x.index], rr: x.relevance_score ?? x.score ?? 0, i: x.index }));
    return out.length ? out : docs.map((d, i) => ({ ...d, rr: 0, i }));
  } catch (e) {
    console.warn('[HP-DeepLore] rerank 失败，退回向量排序：', e.message);
    return docs.map((d, i) => ({ ...d, rr: 0, i }));
  }
}

/* ---- LLM（chat completions） ---- */
async function llm(prompt, useName, opts = {}) {
  const api = (useName && pickApiByName(useName)) || pickApi('llm');
  if (!api) throw new Error(useName ? `未配置名为「${useName}」的 API` : '未配置 LLM API');
  const j = await apiPost(api, '/chat/completions', {
    model: api.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: opts.temp ?? 0.4,
    max_tokens: opts.max ?? 900,
  });
  const txt = j.choices?.[0]?.message?.content ?? '';
  if (j.usage?.total_tokens) statAdd('tok', j.usage.total_tokens);
  else statAdd('tok', Math.ceil((prompt.length + txt.length) / 2));
  return String(txt).trim();
}

/* ══════════════════════════════════════════════════════════════
   【v1.18】永久记忆 · 客户端
   职责边界（重要）：
     · 插件   —— 调 LLM 抽取事件、调 embedding 算向量、组装注入
     · 后端   —— 只存取数字与结构化字段，不配置任何 API、不联网
   所以后端零配置：换抽取/向量模型全在插件面板点，Termux 那边不用动。
   数据落 SQLite 单文件，进程重启/换设备只要文件在就不会丢。
   ══════════════════════════════════════════════════════════════ */

const MEM_STATE = {
  ok: false,        // 最近一次检测是否连通
  ts: 0,           // 最近检测时间戳
  ms: 0,           // 最近检测耗时
  err: '',         // 失败原因
  stats: null,     // /stats 快照
  probing: false,
};

function memBaseUrl() {
  return String(settings.memBase || '').replace(/\/+$/, '');
}
function memHeaders(extra) {
  const h = { 'Content-Type': 'application/json' };
  const tk = String(settings.memToken || '').trim();
  if (tk) h.Authorization = 'Bearer ' + tk;
  return Object.assign(h, extra || {});
}

/* 带超时的 fetch：后端没起时不能让插件卡住 */
async function memFetch(path, opts = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const ms = Math.max(1000, Number(opts.timeoutMs || settings.memTimeoutMs) || 15000);
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  try {
    const r = await fetch(memBaseUrl() + path, {
      method: opts.method || 'GET',
      headers: memHeaders(),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctl ? ctl.signal : undefined,
    });
    if (!r.ok) {
      let d = '';
      try { const j = await r.json(); d = j.error || j.message || ''; } catch (e) { /* 忽略 */ }
      throw new Error(`HTTP ${r.status} ${d}`.trim());
    }
    return await r.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* 检测连通：GET /ping。红灯/绿灯就是看这个。 */
async function memProbe(silent) {
  if (MEM_STATE.probing) return MEM_STATE;
  MEM_STATE.probing = true;
  const t0 = Date.now();
  try {
    if (!settings.memEnabled) {
      MEM_STATE.ok = false; MEM_STATE.err = '未启用';
      return MEM_STATE;
    }
    if (!memBaseUrl()) {
      MEM_STATE.ok = false; MEM_STATE.err = '未填后端地址';
      return MEM_STATE;
    }
    await memFetch('/ping', { timeoutMs: Math.max(1000, Number(settings.memProbeSec || 20) * 100 > 0 ? 6000 : 6000) });
    MEM_STATE.ok = true; MEM_STATE.err = '';
    try { MEM_STATE.stats = (await memFetch('/stats', { timeoutMs: 6000 })).stats || null; } catch (e) { MEM_STATE.stats = null; }
  } catch (e) {
    MEM_STATE.ok = false;
    const m = String(e?.message || e || '');
    MEM_STATE.err = /Failed to fetch|NetworkError|aborted/i.test(m) ? '连不上（后端未启动/地址错/CORS）' : m.slice(0, 80);
  } finally {
    MEM_STATE.ts = Date.now();
    MEM_STATE.ms = Date.now() - t0;
    MEM_STATE.probing = false;
    memLightPaint();
    if (!silent) memPanePaint();
  }
  return MEM_STATE;
}

function memPost(path, body, timeoutMs) {
  return memFetch(path, { method: 'POST', body, timeoutMs });
}

/* ---------- 指示灯 ---------- */
function memLightHTML() {
  const s = MEM_STATE;
  const cls = !settings.memEnabled ? 'off' : (s.ok ? 'ok' : 'bad');
  const title = !settings.memEnabled ? '记忆库：未启用'
    : (s.ok ? `记忆库：已连接（${s.ms}ms）` : `记忆库：${s.err || '未连接'}`);
  return `<span class="hp-memlight ${cls}" id="hp-memlight" title="${esc(title)}"><i></i><b>记忆</b></span>`;
}
function memLightPaint() {
  document.querySelectorAll('#hp-memlight, #hp-memlight-pane').forEach(el => {
    const s = MEM_STATE;
    // 保留面板大号指示灯的 big 类，不要整体覆盖掉
    el.className = 'hp-memlight' + (el.id === 'hp-memlight-pane' ? ' big' : '')
      + ' ' + (!settings.memEnabled ? 'off' : (s.ok ? 'ok' : 'bad'));
    el.title = !settings.memEnabled ? '记忆库：未启用'
      : (s.ok ? `记忆库：已连接（${s.ms}ms）` : `记忆库：${s.err || '未连接'}`);
  });
  // 【修 v1.18.1】面板里状态卡的 id 是 hp-mem-out，原来写成 hp-mem-st 导致探测后卡片永远不刷新
  const d = document.getElementById('hp-mem-out');
  if (d) d.innerHTML = memStatusHTML();
}
function memStatusHTML() {
  const s = MEM_STATE;
  if (!settings.memEnabled) {
    return `<span class="hp-mem-badge off">未启用</span><span style="font-size:11.5px;color:var(--hp-tx3)">打开下方总开关后才会连接</span>`;
  }
  if (s.ok) {
    const st = s.stats || {};
    const bits = [];
    if (st.events != null) bits.push(`事件 ${st.events}`);
    if (st.promises != null) bits.push(`承诺 ${st.promises}`);
    if (st.open_promises != null) bits.push(`待兑现 ${st.open_promises}`);
    if (st.db_size_mb != null) bits.push(`${st.db_size_mb}MB`);
    return `<span class="hp-mem-badge ok">已连接 · ${s.ms}ms</span>`
      + `<span style="font-size:11.5px;color:var(--hp-tx3)">${esc(bits.join(' · ') || '后端正常')}　检测于 ${new Date(s.ts).toLocaleTimeString('zh-CN')}</span>`;
  }
  return `<span class="hp-mem-badge bad">未连接</span><span style="font-size:11.5px;color:var(--hp-tx3)">${esc(s.err || '尚未检测')}</span>`;
}
/* 面板内的大号状态卡（跟指示灯同源，只是信息更全） */
function memPanePaint() {
  const box = document.getElementById('hp-mem-out');
  if (box) box.innerHTML = memStatusHTML();
}

/* ---------- 抽取提示词 ---------- */
const MEM_EXTRACT_DEF = `你是记忆抽取器。阅读下方对话片段，抽取出"值得永久记住"的事件。

只输出 JSON 数组，不要任何解释文字、不要 markdown 代码块。每项格式：
{"text":"发生了什么（第三人称，一句话）","entities":["人物/地点/物品/概念"],"emotions":["情绪词"],"importance":1-10,"layer":"fact","type":"event","is_promise":false,"promise":null}

规则：
1. 只抽真正发生的事（承诺、关系变化、关键揭示、重要冲突、角色暴露的习惯/偏好）。纯闲聊、重复寒暄、无信息量的动作描写一律跳过。
2. 若某句构成承诺（"我答应…""我们会…""下次带你…"），is_promise 填 true，promise 填：
   {"text":"承诺原话，一字不改","speaker":"许诺者","addressee":"被许诺者","importance":1-10,"relation":"伴侣/暧昧/朋友/同学/陌生/敌对","affinity":许诺时好感度数字}
3. importance：随口小事 2-3，有意义的约定 5-6，重大誓言/背叛/揭示 8-10。
4. entities 只填名词性实体，便于日后按场景激活。
5. 一段对话可抽 0 条、1 条或多条。没有值得记的返回 []。

对话片段：
{{CHAT}}

只输出 JSON 数组：`;

function memPromptText() { return settings.memExtractPrompt || MEM_EXTRACT_DEF; }

/* 从 LLM 回复里抠出 JSON 数组（模型爱加代码块和废话） */
function memParseJSON(txt) {
  let s = String(txt || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : (v && Array.isArray(v.events) ? v.events : []);
  } catch (e) {
    return [];
  }
}

/* ---------- 程序层（词典累积）：不依赖 LLM，确定性补全实体 ---------- */
function memDictEntities(text) {
  const dict = settings.memDict || {};
  const hit = [];
  const t = String(text || '');
  for (const k of Object.keys(dict)) {
    if (t.includes(k)) hit.push(k);
  }
  // 内置人名兜底：别名表里所有姓名与别名都算已知实体
  try {
    const am = settings.aliasMap || {};
    for (const id of Object.keys(am)) {
      const names = [am[id]?.name, ...(am[id]?.alias || [])].filter(Boolean);
      for (const n of names) if (n && t.includes(n)) hit.push(n);
    }
  } catch (e) { /* 忽略 */ }
  return Array.from(new Set(hit));
}
function memBumpDict(entities) {
  settings.memDict = settings.memDict || {};
  for (const e of entities) {
    if (!e) continue;
    settings.memDict[e] = (settings.memDict[e] || 0) + 1;
  }
}

/* ---------- 本轮更新：抽 → embed → 写后端 ---------- */
async function memUpdate(opts = {}) {
  const o = opts || {};
  if (!settings.memEnabled) { if (!o.silent) toast('记忆库未启用'); return { ok: false, reason: '未启用' }; }
  if (!MEM_STATE.ok) await memProbe(true);
  if (!MEM_STATE.ok) { if (!o.silent) toast('记忆库未连接：' + (MEM_STATE.err || '')); return { ok: false, reason: MEM_STATE.err }; }

  const ctx = stGetContext();
  const chat = ctx?.chat || [];
  if (!chat.length) { if (!o.silent) toast('没有可扫描的消息'); return { ok: false, reason: '空对话' }; }

  const from = Math.max(0, Number(settings.memLastFloor) || 0);
  const turns = Math.max(1, Math.min(10, Number(settings.memTurnsPerUpdate) || 2));
  const slice = chat.slice(from);
  if (!slice.length) { if (!o.silent) toast('没有新的未同步消息'); return { ok: false, reason: '无新增' }; }

  const buf = [];
  for (let i = Math.max(0, slice.length - turns * 2); i < slice.length; i++) {
    const m = slice[i];
    const raw = stripUpdateBlocks(m?.mes);
    if (!raw) continue;
    const who = m?.is_user ? '{{user}}' : (m?.name || '{{char}}');
    buf.push(`${who}（第${from + i + 1}楼）：${raw}`);
  }
  if (!buf.length) { if (!o.silent) toast('没有可抽取的正文'); return { ok: false, reason: '无正文' }; }

  const sd = getStatData();
  const gameTime = String(sd?.世界?.当前时间 || '').slice(0, 16) || '';
  const floorNow = from + slice.length;

  // ① LLM 抽取
  let items = [];
  try {
    const prompt = memPromptText().replace('{{CHAT}}', buf.join('\n').slice(-6000));
    const txt = await llm(prompt, settings.memExtractApi || null, { temp: 0.2, max: 1600 });
    items = memParseJSON(txt);
  } catch (e) {
    console.warn('[HP-DeepLore] 记忆抽取失败：', e.message);
    if (!o.silent) toast('抽取失败：' + e.message.slice(0, 40));
    return { ok: false, reason: '抽取失败' };
  }

  const minImp = Math.max(0, Number(settings.memMinImportance) || 0);
  const cap = Math.max(1, Number(settings.memMaxPerTurn) || 6);
  const evs = items.filter(x => x && x.text && Number(x.importance || 0) >= minImp).slice(0, cap);
  if (!evs.length) {
    // 没有值得记的也算同步过，避免每轮重复扫描同一批
    settings.memLastFloor = floorNow; saveSettings();
    if (!o.silent) toast('本轮没有值得记住的事');
    return { ok: true, added: 0, promises: 0 };
  }

  // ② 程序层补全实体（词典累积：用过一次的词之后能确定性命中）
  for (const e of evs) {
    const got = Array.isArray(e.entities) ? e.entities.slice() : [];
    const extra = memDictEntities(e.text);
    e.entities = Array.from(new Set(got.concat(extra)));
  }

  // ③ 向量
  let vecs = [];
  try {
    const api = (settings.memEmbedApi && pickApiByName(settings.memEmbedApi)) || pickApi('embed');
    if (!api) throw new Error('未配置 embedding API');
    const j = await apiPost(api, '/embeddings', {
      model: api.model,
      input: evs.map(e => String(e.text).slice(0, 800)),
    });
    vecs = (j.data || []).map(x => x.embedding).filter(Boolean);
  } catch (e) {
    console.warn('[HP-DeepLore] 记忆向量化失败，改为无向量写入：', e.message);
    vecs = [];
  }

  // ④ 写入后端（失败绝不阻塞聊天）
  const payload = evs.map((e, i) => ({
    event: {
      // 【修 v1.18.1】模型若回报了楼层且落在本次扫描区间内就用它，否则退回本轮楼号
      floor: (function (ef) {
        const n = Number(ef);
        return Number.isFinite(n) && n >= from + 1 && n <= floorNow ? Math.round(n) : floorNow;
      })(e.floor),
      game_time: gameTime,
      layer: e.layer === 'narrative' ? 'narrative' : 'fact',
      type: e.type || 'event',
      text: String(e.text).slice(0, 500),
      entities: e.entities || [],
      emotions: Array.isArray(e.emotions) ? e.emotions : [],
      base_weight: Math.max(1, Math.min(10, Number(e.importance) || 3)),
      salience: 1.0,
      importance: Math.max(1, Math.min(10, Number(e.importance) || 3)),
      real_min: 0,
    },
    vec: vecs[i] || null,
  }));

  let addedIds = [];
  try {
    const r = await memPost('/events/add', payload);
    addedIds = (r.results || []).map(x => x.id);
  } catch (e) {
    console.warn('[HP-DeepLore] 记忆写入失败：', e.message);
    if (!o.silent) toast('写入失败：' + e.message.slice(0, 40));
    return { ok: false, reason: '写入失败' };
  }

  // ⑤ 承诺单独入 promises 表（带承认度所需的许诺时状态）
  let pn = 0;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    // 【修 v1.18.1】宽松判定：模型常写成 type:"promise" 而非 is_promise:true，两者都认
    const isP = e.is_promise === true || String(e.type || '').toLowerCase() === 'promise';
    if (!isP || !e.promise) continue;
    const p = e.promise || {};
    try {
      await memPost('/promises/add', {
        event_id: addedIds[i] || null,
        speaker: p.speaker || '',
        addressee: p.addressee || '',
        promise_text: String(p.text || e.text).slice(0, 300),
        made_floor: floorNow,
        made_game_time: gameTime,
        importance: Math.max(1, Math.min(10, Number(p.importance) || Number(e.importance) || 5)),
        affinity_at_creation: Number(p.affinity) || 0,
        relation_at_creation: p.relation || '',
        emotion_tags: Array.isArray(e.emotions) ? e.emotions : [],
      });
      pn++;
    } catch (err) { /* 单条失败不影响其他 */ }
  }

  memBumpDict(evs.flatMap(e => e.entities || []));
  settings.memLastFloor = floorNow;
  saveSettings();
  try { memProbe(true); } catch (e) { /* 忽略 */ }
  if (!o.silent) toast(`记忆已更新：${evs.length} 条事件${pn ? ` · ${pn} 条承诺` : ''}`);
  return { ok: true, added: evs.length, promises: pn };
}

/* ---------- 检索：SQL 结构化过滤 + 向量 + 情境激活 ---------- */
async function memRetrieve(userText, sd, grade) {
  if (!settings.memEnabled || !MEM_STATE.ok) return null;
  try {
    const api = (settings.memEmbedApi && pickApiByName(settings.memEmbedApi)) || pickApi('embed');
    if (!api) return null;
    const j = await apiPost(api, '/embeddings', {
      model: api.model,
      input: [String(userText || '').slice(0, 500)],
    });
    const vec = (j.data || [])[0]?.embedding;
    if (!vec) return null;

    const present = Object.keys(sd?.当前场景?.在场角色 || {});
    const loc = String(sd?.世界?.当前地点 || '');
    const ents = present.concat(loc ? [loc] : []);
    const gameTime = String(sd?.世界?.当前时间 || '').slice(0, 16);

    const r = await memPost('/search', {
      vec,
      floor_now: Number(settings.memLastFloor) || 0,
      now_game_time: gameTime,
      scene_entities: ents,
      use_graph: settings.memGraph === false ? 0 : 1,
      scene_emotions: [],
      top_k: Math.max(1, Math.min(50, Number(settings.memTopK) || 25)),
    }, 12000);
    return Array.isArray(r.items) ? r.items : [];
  } catch (e) {
    console.warn('[HP-DeepLore] 记忆检索失败：', e.message);
    return null;
  }
}

/* 记忆块渲染成给 AI 看的纯文本：只给原文与情境，不指挥它怎么用 */
function memToPlain(items) {
  if (!Array.isArray(items) || !items.length) return '';
  const cap = Math.max(500, Number(settings.memCharCap) || 3000);
  let t = '\n■ 长期记忆（以下都是本局真实发生过的事，不是待执行清单）\n';
  t += '（是否提起、怎么提起、用什么语气，全部由角色自行判断。不要逐条复述，不要当成任务清单。）\n';
  let used = 0;
  for (const it of items) {
    const line = `· [${it.ago || '—'}${it.game_time ? '｜' + it.game_time : ''}${it.reaction ? '｜' + (it.reaction === 'cynicism' ? '讽刺性回忆' : it.reaction === 'emotional_hurt' ? '带情绪的回忆' : '') : ''}] ${it.text}\n`;
    if (used + line.length > cap) break;
    t += line; used += line.length;
  }
  if (used === 0) return '';
  return t;
}

/* ---- 余弦相似度 ---- */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ---- 简易分词（用于关键词兜底与缓存相似度） ---- */
function tokens(s) {
  const t = String(s || '').toLowerCase();
  const cn = t.match(/[\u4e00-\u9fa5]/g) || [];
  const bi = [];
  for (let i = 0; i + 1 < cn.length; i++) bi.push(cn[i] + cn[i + 1]);
  const en = t.match(/[a-z]{2,}/g) || [];
  return new Set([...cn, ...bi, ...en]);
}
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  let inter = 0;
  A.forEach(x => { if (B.has(x)) inter++; });
  return inter / Math.max(1, A.size + B.size - inter);
}


/* ==========================================================================
 * 索引层：解析 / 切块 / 向量化 / 出场角色 / 节点抽取
 * ========================================================================== */
/* 【v1.16】章节正则容错。
   旧正则要求严格「一年级 | 分部 | 1993-09-01 | 第1章」，实测以下常见变形会全部失配为 0 章：
     · CRLF 换行（Windows 记事本另存 / 微信传输）→ 0 章   ← 致命，且静默失败
     · 全角｜分隔符
     · 阿拉伯数字年级「1年级」
     · 无空格分隔
     · BOM 头
   现统一放宽：分隔符 |｜、破折号 -—–、年级 一二三四五/12345、章号 阿拉伯或中文数字、容忍 \r 与 BOM。 */
const CH_SEP = '[ \\t]*[|\\uFF5C][ \\t]*';
const CH_GRADE = '([\\u4E00\\u4E8C\\u4E09\\u56DB\\u4E9412345])[ \\t]*\\u5E74\\u7EA7';
const CH_DATE = '(\\d{4})[ \\t]*[-\\u2014\\u2013][ \\t]*(\\d{1,2})[ \\t]*[-\\u2014\\u2013][ \\t]*(\\d{1,2})';
const CH_NUM = '\\u7B2C[ \\t]*([0-9]{1,4}|[\\u96F6\\u4E00\\u4E8C\\u4E09\\u56DB\\u4E94\\u516D\\u4E03\\u516B\\u4E5D\\u5341\\u767E\\u5343]{1,8})[ \\t]*\\u7AE0';
const CH_RE = new RegExp('^\\uFEFF?' + CH_GRADE + CH_SEP + '(.+?)' + CH_SEP + CH_DATE + CH_SEP + CH_NUM + '[ \\t\\r]*$', 'gm');

const CN_DIG = { '\u96f6': 0, '\u4e00': 1, '\u4e8c': 2, '\u4e09': 3, '\u56db': 4, '\u4e94': 5, '\u516d': 6, '\u4e03': 7, '\u516b': 8, '\u4e5d': 9 };
function cn2num(str) {
  if (/^[0-9]+$/.test(str)) return Number(str);
  let total = 0, section = 0, cur = 0;
  for (const ch of str) {
    if (ch in CN_DIG) cur = CN_DIG[ch];
    else if (ch === '\u5341') { section += (cur || 1) * 10; cur = 0; }
    else if (ch === '\u767e') { section += (cur || 1) * 100; cur = 0; }
    else if (ch === '\u5343') { section += (cur || 1) * 1000; cur = 0; }
    else if (ch === '\u4e07') { total += (section + cur) * 10000; section = 0; cur = 0; }
  }
  return total + section + cur;
}
const GRADE_CN = { '\u4e00': 1, '\u4e8c': 2, '\u4e09': 3, '\u56db': 4, '\u4e94': 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };

function parseChapters(text) {
  const out = [];
  let m;
  const re = new RegExp(CH_RE.source, 'gm');
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    // 捕获组顺序：1 年级 / 2 分部 / 3 年 / 4 月 / 5 日 / 6 章号
    const mo = String(m[4]).padStart(2, '0');
    const dy = String(m[5]).padStart(2, '0');
    out.push({
      i: m.index,
      grade: 'Y' + (GRADE_CN[String(m[1])] || 1),
      vol: String(m[2]).trim(),
      date: String(m[3]) + '-' + mo + '-' + dy,
      ch: cn2num(String(m[6])),
    });
  }
  return out;
}

/* 宽松兜底：只认「第X章」，用于非整理版 txt（无年级/日期） */
const CH_LOOSE = /^[ \t]*\u7B2C[ \t]*([0-9]{1,4}|[\u96F6\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341\u767E\u5343]{1,8})[ \t]*\u7AE0[ \t]*(.*)$/gm;
function parseChaptersLoose(text) {
  const out = [];
  const re = new RegExp(CH_LOOSE.source, 'gm');
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    out.push({ i: m.index, grade: 'Y1', vol: '', date: '', ch: cn2num(String(m[1])) });
  }
  return out;
}

/* 上传后即时诊断：告诉用户文件到底能不能被解析、差在哪 */
function diagnoseNovel(text) {
  const strict = parseChapters(text).length;
  const loose = parseChaptersLoose(text).length;
  const sample = text.slice(0, 300).split(/\r?\n/).filter(Boolean).slice(0, 6).join('\n');
  return { strict, loose, sample, crlf: /\r\n/.test(text.slice(0, 5000)), bom: text.charCodeAt(0) === 0xFEFF };
}

/* 切块：按章内滑窗，块级带 年级/日期/章号/序号 */
function splitNovel(text, size, ov) {
  const marks = parseChapters(text);
  if (!marks.length) return [];
  const chunks = [];
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].i;
    const end = k + 1 < marks.length ? marks[k + 1].i : text.length;
    const head = text.slice(start, start + 120).replace(/\s+/g, ' ');
    const body = text.slice(start + head.length, end).replace(/\n{2,}/g, '\n').trim();
    const step = Math.max(1, size - ov);
    for (let p = 0, n = 0; p < body.length; p += step, n++) {
      const seg = body.slice(p, p + size).trim();
      if (seg.length < 40) continue;
      chunks.push({
        id: `${marks[k].grade}_ch${String(marks[k].ch).padStart(3, '0')}_b${String(n).padStart(2, '0')}`,
        grade: marks[k].grade, vol: marks[k].vol, date: marks[k].date,
        chapter: marks[k].ch, seq: n, text: seg, chars: null, vec: null,
      });
    }
  }
  return chunks;
}

/* 出场角色：用别名表在块内做命中标记 */
function markChars(chunks, aliasMap) {
  const map = aliasMap || settings.aliasMap || {};
  for (const c of chunks) {
    const hit = new Set();
    for (const [id, info] of Object.entries(map)) {
      const names = [info.name, ...(info.alias || [])].filter(Boolean);
      for (const nm of names) if (nm && nm.length > 1 && c.text.includes(nm)) { hit.add(id); break; }
    }
    c.chars = [...hit];
  }
  return chunks;
}

/* 节点抽取：每章一个章级节点 */
function extractNodes(text) {
  return parseChapters(text).map(m => ({
    id: `${m.grade.toLowerCase()}_ch_${String(m.ch).padStart(3, '0')}`,
    grade: m.grade, vol: m.vol, date: m.date, chapter: m.ch,
    title: `第${m.ch}章 · ${m.vol}`,
  }));
}

/* 角色别名自动发现：从全文统计高频人名 */
function discoverChars(text) {
  const KNOWN = [
    ['char_draco_malfoy', '德拉科', ['马尔福', '德拉科·马尔福', '小龙', '德拉科妮娅', '马尔福少爷']],
    ['char_harry_potter', '哈利', ['波特', '救世主', '哈莉', '哈利·波特']],
    ['char_severus_snape', '斯内普', ['西弗勒斯', '教授', '塞维拉']],
    ['char_hermione_granger', '赫敏', ['格兰杰']],
    ['char_ron_weasley', '罗恩', ['韦斯莱', '罗娜']],
    ['char_remus_lupin', '卢平', ['莱姆斯']],
    ['char_albus_dumbledore', '邓布利多', ['阿不思', '校长']],
    ['char_voldemort', '伏地魔', ['黑魔王', '伏地米拉', '神秘人']],
    ['char_pansy_parkinson', '潘西', ['帕金森']],
    ['char_blaise_zabini', '扎比尼', ['布莱斯']],
    ['char_lucius_malfoy', '卢修斯', ['马尔福先生']],
    ['char_sirius_black', '小天狼星', ['布莱克', '西里斯']],
    ['char_rubeus_hagrid', '海格', ['鲁伯']],
    ['char_minerva_mcgonagall', '麦格', ['米勒娃']],
  ];
  const out = {};
  for (const [id, name, alias] of KNOWN) {
    let n = 0;
    for (const a of [name, ...alias]) {
      const re = new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      n += (text.match(re) || []).length;
    }
    if (n > 0) out[id] = { name, alias, hits: n, clusters: {} };
  }
  return out;
}

/* --------------------------------------------------------------------------
 * 【v1.16】扫描全文补充发现角色
 *   内置只有 14 人。这里从「谁在说话」的句式里挖高频称谓，
 *   取出现 >= minHits 次且不在现有表中的，供用户勾选加入。
 * -------------------------------------------------------------------------- */
const STOP_NAMES = new Set([
  '\u4ed6', '\u5979', '\u4f60', '\u6211', '\u5927\u5bb6', '\u4eba\u4eec', '\u8001\u5e08', '\u6559\u6388', '\u5148\u751f',
  '\u5c0f\u4f19\u4f34', '\u5bb6\u4f19', '\u5973\u5b69', '\u7537\u5b69', '\u5148\u751f\u4eec', '\u4f60\u4eec', '\u6211\u4eec',
  '\u4ed6\u4eec', '\u5979\u4eec', '\u8fd9\u4e2a', '\u90a3\u4e2a', '\u4e00\u4e2a', '\u6709\u4eba', '\u6ca1\u4eba',
  '\u7238\u7238', '\u5988\u5988', '\u7236\u4eb2', '\u6bcd\u4eb2', '\u8001\u7238', '\u8001\u5988', '\u963f\u59e8',
  '\u5b69\u5b50', '\u540c\u5b66', '\u670b\u53cb', '\u8001\u5bb6\u4f19', '\u5c11\u7237', '\u5c0f\u59d0',
]);

/* 【v1.17】人名合法性判定
   上一版只按「X说」句式统计高频词，会把「我知」「就是」「没有」「知道」
   这类非人名也捞进来。现加四道过滤：
   ① 首尾字黑名单：以常见动词/副词/助词开头或结尾的一律不是人名
   ② 姓氏表：优先保留百家姓开头的（哈利/德拉科等译名另走白名单形态）
   ③ 独立出现度：名字必须也在非「说」语境中出现过（被称呼、所属、并列）
   ④ 词性排除：整词若本身就是常用词（知道/觉得/其实……）直接丢 */
const NAME_HEAD_BAD = new Set(('我你他她它我们你们他们她们这那谁什么怎么为什么但是而且于是其实'
  + '就是还是不过只是已经还有可能应该可以不会没有知道觉得想到看见听见说道回答'
  + '一个人家大家自己彼此互相另外然后接着突然忽然慢慢轻轻渐渐'
  + '上下里外前后左右东西南北中').split(''));
const SURNAMES = new Set(('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜'
  + '戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳唐罗薛伍余米'
  + '贝姚孟顾尹江钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫房缪丁贾路林刁郁梅'
  + '盛林刀闻寇'.slice(0, 200)).split(''));
const COMMON_WORDS = new Set([
  '知道', '觉得', '其实', '就是', '还是', '不过', '只是', '已经', '还有', '可能', '应该', '可以',
  '不会', '没有', '什么', '怎么', '为什么', '但是', '而且', '于是', '然后', '接着', '突然', '忽然',
  '慢慢', '轻轻', '渐渐', '自己', '大家', '彼此', '互相', '另外', '一个', '人家', '我们', '你们',
  '他们', '她们', '这个', '那个', '这些', '那些', '因为', '所以', '如果', '虽然', '即使', '除非',
  '看见', '听见', '说道', '回答', '想到', '看到', '听到', '感觉', '发现', '明白', '记得', '忘记',
  '时候', '地方', '事情', '问题', '样子', '声音', '眼睛', '手里', '心里', '脸上', '头上', '嘴里',
]);

function looksLikeName(nm) {
  if (!nm || nm.length < 2 || nm.length > 4) return false;
  if (COMMON_WORDS.has(nm)) return false;
  if (STOP_NAMES.has(nm)) return false;
  const h = nm[0], t = nm[nm.length - 1];
  // 首尾是常见功能词 → 不是人名
  if (NAME_HEAD_BAD.has(h) || NAME_HEAD_BAD.has(t)) return false;
  // 叠字（哈哈/呵呵）不是人名
  if (nm.length === 2 && h === t) return false;
  // 含「的/了/着/过/是/在/和/与」等虚词 → 不是人名
  if (/[的了着过是在和与也很都很就才又再也]/.test(nm)) return false;
  return true;
}

function scanMoreChars(text, minHits) {
  const lim = Math.max(3, Number(minHits) || 20);
  const counter = new Map();
  const alone = new Map();   // 非「说」语境下的独立出现次数
  // 「XXX说/道/问/答/笑/喝/喊/嘀咕/嘟囔/补充/继续/摇头/点头」
  const VERBS = '\u8bf4|\u9053|\u95ee|\u7b54|\u7b11|\u559d|\u558a|\u5618|\u5620|\u5634|\u5427|\u554a|\u5462|\u5417|\u55ef|\u563f|\u55b5|\u563b|\u5445|\u5636|\u5632|\u5634\u91cc|\u53c8\u8bf4|\u63a5\u7740|\u7ee7\u7eed|\u8865\u5145|\u6447\u5934|\u70b9\u5934|\u770b\u7740|\u671b\u7740|\u8f6c\u8fc7\u5934|\u53f9\u4e86\u53e3\u6c14|\u54b8|\u54c4|\u563d|\u561e|\u562f';
  const re = new RegExp('([\u4e00-\u9fa5]{2,6}?)(?:' + VERBS + ')', 'g');
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const nm = m[1];
    if (!looksLikeName(nm)) continue;
    counter.set(nm, (counter.get(nm) || 0) + 1);
  }
  // 独立出现度：名字出现在「的」「和」「对」「把」「被」「给」等非说话语境
  const re2 = new RegExp('([\u4e00-\u9fa5]{2,4}?)(?:[\u7684\u548c\u4e0e\u5bf9\u628a\u88ab\u7ed9\u5411\u8ddf\u540c])(?![\u8bf4\u9053\u95ee])', 'g');
  re2.lastIndex = 0;
  while ((m = re2.exec(text)) !== null) {
    const nm = m[1];
    if (!looksLikeName(nm)) continue;
    alone.set(nm, (alone.get(nm) || 0) + 1);
  }
  // 排除已被现有表覆盖的名字与别名
  const taken = new Set();
  for (const info of Object.values(settings.aliasMap || {})) {
    taken.add(info.name);
    for (const a of (info.alias || [])) taken.add(a);
  }
  const out = [];
  for (const [nm, c] of [...counter.entries()].sort((a, b) => b[1] - a[1])) {
    if (c < lim) continue;
    if (taken.has(nm)) continue;
    // 独立出现度：只在「X说」语境出现过、从不在其他语境出现的，多半是句子片段而非人名。
    // 放宽处理——只要在别处出现过 1 次就算通过；完全没出现过的，需是姓氏开头或 3~4 字译名。
    const al = alone.get(nm) || 0;
    if (al === 0 && !SURNAMES.has(nm[0]) && nm.length < 3) continue;
    out.push({ name: nm, hits: c, alone: al });
    if (out.length >= 40) break;
  }
  return out;
}

/* --------------------------------------------------------------------------
 * 【v1.16】章节阅读：取某章全文，供节点面板点章号查看
 * -------------------------------------------------------------------------- */
async function chapterText(ch, grade) {
  const n = await idbGet(STORE.novel, 'main');
  if (!n?.text) return null;
  const all = parseChapters(n.text);
  let list = all;
  if (!list.length) list = parseChaptersLoose(n.text);
  if (!list.length) return null;
  const inGrade = grade ? list.filter(c => c.grade === grade) : list;
  const pool = inGrade.length ? inGrade : list;
  const cur = pool.find(c => c.ch === Number(ch));
  if (!cur) {
    // 也可能章号全局唯一（宽松模式）
    const alt = list.find(c => c.ch === Number(ch));
    if (!alt) return null;
    return sliceChapter(n.text, list, alt);
  }
  return sliceChapter(n.text, pool, cur);
}
function sliceChapter(text, marks, cur) {
  const k = marks.indexOf(cur);
  const start = cur.i;
  const end = k + 1 < marks.length ? marks[k + 1].i : text.length;
  const body = text.slice(start, end);
  const nl = body.indexOf('\n');
  const title = nl > 0 ? body.slice(0, nl).trim() : '';
  const content = nl > 0 ? body.slice(nl + 1) : body;
  return {
    ch: cur.ch, grade: cur.grade, date: cur.date, vol: cur.vol, title,
    text: content.replace(/^-{5,}$/gm, '').trim(),
  };
}

/* 把候选加进别名表（生成稳定 char_id） */
function addCharToAlias(name, hits) {
  const id = 'char_' + String(name).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase() || ('char_x' + Date.now());
  settings.aliasMap = settings.aliasMap || {};
  settings.aliasMap[id] = { name, alias: [], hits: hits || 0, clusters: {}, lines: [] };
  saveSettings();
  return id;
}

/* 台词簇挖掘：按角色抽中文引号台词，按档位粗分档（后期由 LLM 精修） */
function mineLines(text, aliasMap) {
  const map = aliasMap || settings.aliasMap || {};
  const sents = text.match(/“[^”]{4,120}”/g) || [];
  const out = {};
  for (const [id, info] of Object.entries(map)) {
    const names = [info.name, ...(info.alias || [])].filter(Boolean);
    const bag = [];
    for (const s of sents) {
      const inner = s.slice(1, -1);
      // 台词前后 40 字内出现该角色名 → 归属
      const idx = text.indexOf(s);
      if (idx < 0) continue;
      const ctx = text.slice(Math.max(0, idx - 40), idx + s.length + 40);
      if (names.some(nm => ctx.includes(nm))) bag.push(inner);
      if (bag.length >= 400) break;
    }
    out[id] = bag.slice(0, 400);
  }
  return out;
}

/* --------------------------------------------------------------------------
 * 【v1.16】POV 二次过滤：剥离斯科皮（= {{user}}）的言行句
 *   整理版 txt 已删心理描写与作者旁白，但斯科皮「说了什么 / 做了什么」仍在原文里。
 *   注入这些等于替玩家预设言行 —— 与本卡「{{user}} 主权」原则冲突。
 *   按句剔除，不整段丢弃，避免把剧情切碎。
 * -------------------------------------------------------------------------- */
const POV_NAMES = ['\u65af\u79d1\u76ae', '\u683c\u96f7\u7279'];   // 斯科皮 / 格雷特
const POV_SPEAK = ['\u8bf4', '\u9053', '\u95ee', '\u7b54', '\u559d', '\u7b11', '\u55b7', '\u558a', '\u56de\u7b54', '\u8bf7\u6c42', '\u547d\u4ee4', '\u8ba8\u4ef7\u8fd8\u4ef7', '\u5634\u91cc', '\u5f00\u53e3'];
const POV_ACT = ['\u8f6c\u8fc7\u5934', '\u62ac\u5934', '\u4f4e\u5934', '\u70b9\u5934', '\u6447\u5934', '\u8d70\u8fc7', '\u8dd1\u8fc7', '\u5750\u4e0b', '\u7ad9\u8d77', '\u62ff\u8d77', '\u653e\u4e0b', '\u63a8\u5f00', '\u63a5\u8fc7', '\u4f38\u624b', '\u62ac\u624b', '\u8f6c\u8eab', '\u8eac\u8eab', '\u770b\u5411', '\u671b\u5411', '\u8d70\u4e0a\u524d', '\u62d0\u51fa', '\u585e\u5165'];

function povStrip(text) {
  if (!text) return { text: '', removed: 0 };
  // 先按换行与句末标点切句，保留分隔符
  const parts = String(text).split(/(\n|[^\u3002\uff01\uff1f\uff0e!?\u2026]*[\u3002\uff01\uff1f\uff0e!?\u2026]+)/g).filter(x => x != null && x !== '');
  let removed = 0;
  const out = parts.map(seg => {
    if (!/[^\s]/.test(seg)) return seg;
    const hasName = POV_NAMES.some(n => seg.includes(n));
    if (!hasName) return seg;
    const isAct = POV_SPEAK.some(v => seg.includes(v)) || POV_ACT.some(v => seg.includes(v));
    if (isAct) { removed++; return ''; }
    return seg;
  });
  return { text: out.join('').replace(/\n{3,}/g, '\n\n'), removed };
}

/* 宽松切块：无年级/日期时按章序粗暴切分 */
function splitNovelLoose(text, size, ov, marks) {
  const chunks = [];
  const step = Math.max(1, size - ov);
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].i;
    const end = k + 1 < marks.length ? marks[k + 1].i : text.length;
    const body = text.slice(start, end).replace(/\n{2,}/g, '\n').trim();
    for (let pp = 0, seq = 0; pp < body.length; pp += step, seq++) {
      const seg = body.slice(pp, pp + size).trim();
      if (seg.length < 40) continue;
      chunks.push({
        id: 'Y1_ch' + String(marks[k].ch).padStart(3, '0') + '_b' + String(seq).padStart(2, '0'),
        grade: 'Y1', vol: '', date: '', chapter: marks[k].ch, seq,
        text: seg, chars: [], vec: null,
      });
    }
  }
  return chunks;
}

/* ---- 建索引主流程（v1.15：断点续建 + 耗时预估 + 中途可停） ---- */
let __buildAbort = false;
function abortBuild() { __buildAbort = true; }
function isBuildAborted() { return __buildAbort; }

function fmtEta(ms) {
  if (!isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60), r = s % 60;
  return m < 60 ? `${m} 分 ${r} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/* 索引指纹：小说 + 切块参数 + 向量模型 都一致才能续建 */
function indexFingerprint(n, chunkCount) {
  const emb = pickApi('embed');
  return [
    String(n?.name || ''), String(n?.size || ''),
    String(settings.chunkSize), String(settings.chunkOverlap),
    String(chunkCount), String(emb?.model || 'no-vec'),
  ].join('|');
}

async function buildIndex(progress, opt = {}) {
  const n = await idbGet(STORE.novel, 'main');
  if (!n?.text) throw new Error('请先保存 txt');
  const p = progress || (() => {});
  __buildAbort = false;

  // 【v1.16】角色发现提到章节解析之前：此前章节为 0 会直接 throw，
  // 导致「角色别名校对」永远空白，让人误以为建索引没生效。
  p('发现角色…');
  const aliasMap = discoverChars(n.text);
  settings.aliasMap = aliasMap;
  await idbSet(STORE.alias, 'main', aliasMap);
  saveSettings();

  p('解析章节…');
  let chs = parseChapters(n.text);
  let looseMode = false;
  if (!chs.length) {
    // 宽松兜底：只认「第X章」，无年级/日期 → 时间过滤与已亲历判定失效，但至少能用
    chs = parseChaptersLoose(n.text);
    looseMode = chs.length > 0;
    if (looseMode) p(`⚠ 整理版格式未匹配，已用宽松模式识别 ${chs.length} 章（无年级/日期，时间过滤失效）`);
  }
  if (!chs.length) throw new Error('未识别到章节。请确认上传的是整理版 txt（格式：一年级 | 阿兹卡班的囚徒 | 1993-09-01 | 第1章）');

  p(`切块（${settings.chunkSize} 字 / 重叠 ${settings.chunkOverlap}）…`);
  let chunks = splitNovel(n.text, settings.chunkSize, settings.chunkOverlap);
  if (!chunks.length && chs.length) chunks = splitNovelLoose(n.text, settings.chunkSize, settings.chunkOverlap, chs);

  p('标记出场角色…');
  chunks = markChars(chunks, aliasMap);

  p('挖掘台词簇…');
  const lines = mineLines(n.text, aliasMap);
  for (const id of Object.keys(lines)) if (aliasMap[id]) aliasMap[id].lines = lines[id];
  await idbSet(STORE.alias, 'main', aliasMap);

  p('抽取节点…');
  const nodes = extractNodes(n.text);

  const nodeMap = {};
  for (const nd of nodes) nodeMap[nd.chapter] = nodeMap[nd.chapter] || [];
  for (const nd of nodes) nodeMap[nd.chapter].push(nd.id);
  settings.nodeMap = nodeMap;
  await idbSet(STORE.nodemap, 'main', nodeMap);

  const emb = pickApi('embed');
  const fp = indexFingerprint(n, chunks.length);

  // ① 断点续建核心：指纹一致时，复用已有索引里已算好的向量（按块 id 匹配），
  //    只补缺失的块。指纹不一致（换了小说/改了参数/换了模型）则整体重建。
  let reused = 0;
  try {
    const old = await idbGet(STORE.index, 'main');
    if (old?.chunks?.length && old?.meta?.fp === fp) {
      const vecById = new Map();
      for (const c of old.chunks) if (c.vec && c.id) vecById.set(c.id, c.vec);
      for (const c of chunks) { if (!c.vec && vecById.has(c.id)) { c.vec = vecById.get(c.id); reused++; } }
    }
  } catch (e) { console.warn('[HP-DeepLore] 读取旧索引失败，将从头向量化：', e.message); }

  // 先落盘一次（切好的块 + 已复用的向量），再逐步补向量并定期存盘
  const baseMeta = {
    at: Date.now(), novel: n.name, novelSize: n.size,
    chapters: chs.length, chunks: chunks.length,
    chunkSize: settings.chunkSize, overlap: settings.chunkOverlap,
    vec: !!emb, vecModel: emb?.model || null,
    chars: Object.keys(aliasMap).length,
    fp, resume: false, pending: 0,
  };
  await idbSet(STORE.index, 'main', { chunks, nodes, meta: Object.assign({}, baseMeta) });
  settings.indexMeta = baseMeta;
  saveSettings();

  if (!emb) {
    if (reused) p(`复用已有向量 ${reused} 块（未配置 embedding，不再计算新的）`);
    p('未配置 embedding API → 仅关键词检索（可在 API 池补配后重建）');
    await sleep(400);
    return baseMeta;
  }

  const B = 16;
  const par = apiPar(emb);
  const lanes = 1 + par;

  // ② 只挑还没向量的块：续建时跳过已完成部分
  const todo = chunks.filter(c => !c.vec);
  const resumed = reused;

  // 【v1.20】已删除建索引前的「测速探针」：
  // 它会在正式批次之外额外打一次 embedding，与正式请求抢令牌、干扰限流，
  // 却只为了显示预估时间——副作用大于收益，且曾导致建索引卡在测速那一步。
  // 耗时预估改为开跑后按真实进度滚动计算，不额外发任何请求。
  let etaTxt = '';
  if (resumed) p(`断点续建：复用已有向量 ${resumed} 块，待补 ${todo.length} 块`);

  let doneN = resumed, failN = 0;
  const batches = [];
  for (let i = 0; i < todo.length; i += B) batches.push(todo.slice(i, i + B));
  const total = chunks.length;
  p(`向量化 ${doneN}/${total}${par ? `（并发 ${lanes} 路）` : '（串行）'}`);

  const tStart = Date.now();
  let processed = 0;
  let sinceSave = 0;

  await runPool(batches, async (batch) => {
    if (isBuildAborted()) return;
    try {
      const vecs = await withRetry(() => embed(batch.map(c => c.text.slice(0, 2000))), 'embedding');
      batch.forEach((c, k) => { if (vecs[k]) c.vec = vecs[k]; });
    } catch (e) {
      failN++;
      console.warn('[HP-DeepLore] 批次向量化失败，该批降级为关键词检索：', e.message);
    }
    processed += batch.length;
    sinceSave += batch.length;
    doneN = Math.min(total, resumed + processed);
    // 剩余耗时按已跑均速滚动更新
    const el = Date.now() - tStart;
    const left = todo.length - processed;
    const eta = processed > 0 && left > 0 ? fmtEta(el / processed * left / Math.max(1, lanes)) : '';
    // 【v1.21】不再显示实时速率数字（用户反馈干扰判断）。
    // 只在"并发开了却被 RPM 卡住"时给一句可执行的提示——这正是"并发只快一次"的根因。
    let rateTxt = '';
    if (processed >= B * 2) {
      const cap = apiRpm(emb?.name);
      const rpmNow = processed / Math.max(1, el / 60000);
      if (cap > 0 && par && rpmNow > cap * 0.6) {
        rateTxt = ` · 已被 RPM ${cap}/分 卡住（开了 ${lanes} 路也跑不快）：把该 API 的 RPM 设为 0 即可解除`;
      }
    }
    p(`向量化 ${doneN}/${total}${failN ? `（${failN} 批失败）` : ''}${eta ? `，剩余约 ${eta}` : ''}${rateTxt}`);
    if (!par) await sleep(120);
    // ③ 每 10 批存一次盘：中途关页面也不会全丢
    if (sinceSave >= B * 10 || isBuildAborted()) {
      sinceSave = 0;
      try {
        await idbSet(STORE.index, 'main', { chunks, nodes, meta: Object.assign({}, baseMeta, {
          at: Date.now(), resume: true, pending: chunks.filter(c => !c.vec).length,
        }) });
      } catch (e) { console.warn('[HP-DeepLore] 中途存盘失败：', e.message); }
    }
  }, par);

  const pending = chunks.filter(c => !c.vec).length;
  const meta = Object.assign({}, baseMeta, {
    at: Date.now(), resume: resumed > 0, pending, reused,
    vec: chunks.some(c => c.vec),
  });
  await idbSet(STORE.index, 'main', { chunks, nodes, meta });
  settings.indexMeta = meta;
  saveSettings();
  p(isBuildAborted() ? `已中止（已保存进度，剩 ${pending} 块未向量化）` : '完成');
  return meta;
}




/* --------------------------------------------------------------------------
 * 【v1.16】原文对比：同一查询分别用「关键词」与「向量」检索，看结果差多少。
 *   用于判断值不值得配 embedding——若两者命中章高度重合，说明关键词已够用。
 * -------------------------------------------------------------------------- */
async function compareRetrieve(query, grade, sd, opt = {}) {
  const idx = await idbGet(STORE.index, 'main');
  const emb = pickApi('embed');
  const hasVec = !!(emb && (idx?.chunks || []).some(c => c.vec));
  const nowDate = String(sd?.世界?.当前时间 || '9999-12-31').slice(0, 10);
  const pool = (idx?.chunks || []).filter(c => !c.date || c.date <= nowDate);

  const short = (t, n) => (String(t || '').replace(/\s+/g, '').slice(0, n));

  // 关键词路
  const kw = pool.map(c => ({ c, s: jaccard(query, c.text) }))
    .sort((a, b) => b.s - a.s).slice(0, settings.topK)
    .map(x => ({ chapter: x.c.chapter, date: x.c.date, score: x.s.toFixed(3), text: short(x.c.text, 60) }));

  // 向量路
  let vec = null, vecErr = '';
  if (!hasVec) {
    vecErr = emb ? '索引无向量（需要重建索引）' : '未配置 embedding API';
  } else {
    try {
      const qv = (await withRetry(() => embed([query]), '对比·查询向量化'))[0];
      vec = pool.filter(c => c.vec).map(c => ({ c, s: cosine(qv, c.vec) }))
        .sort((a, b) => b.s - a.s).slice(0, settings.topK)
        .map(x => ({ chapter: x.c.chapter, date: x.c.date, score: x.s.toFixed(3), text: short(x.c.text, 60) }));
    } catch (e) { vecErr = e.message || String(e); }
  }

  const a = new Set(kw.map(x => x.chapter));
  const b = new Set((vec || []).map(x => x.chapter));
  const inter = [...a].filter(x => b.has(x));
  const overlap = b.size ? Math.round(inter.length / b.size * 100) : 0;
  return { query, kw, vec, vecErr, hasVec, overlap, common: inter, onlyKw: [...a].filter(x => !b.has(x)), onlyVec: [...b].filter(x => !a.has(x)) };
}

/* --------------------------------------------------------------------------
 * 注入效果记录：本轮注入了什么 + AI 回复对原文的采信度估算
 *  采信度 = AI 回复中出现了多少注入原文的特征片段（取 4-8 字滑窗比对）
 * -------------------------------------------------------------------------- */
const INJECT_LOG = [];   // 最近 20 轮
function logInject(rec) {
  INJECT_LOG.push(Object.assign({ at: Date.now() }, rec));
  while (INJECT_LOG.length > 20) INJECT_LOG.shift();
}
function lastInject() { return INJECT_LOG[INJECT_LOG.length - 1] || null; }

function scoreAdoption(aiText, sources) {
  if (!aiText || !sources || !sources.length) return { pct: 0, hits: 0, total: 0 };
  const clean = String(aiText).replace(/\s+/g, '');
  let hits = 0, total = 0;
  for (const src of sources) {
    const st = String(src.text || '').replace(/\s+/g, '');
    if (st.length < 12) continue;
    // 从原文取 6 个 6 字片段作为特征
    const probes = [];
    for (let i = 0; i < 6; i++) {
      const p = Math.floor(st.length * (i + 0.5) / 6);
      const seg = st.slice(p, p + 6);
      if (seg.length === 6) probes.push(seg);
    }
    for (const pb of probes) { total++; if (clean.includes(pb)) hits++; }
  }
  return { pct: total ? Math.round(hits / total * 100) : 0, hits, total };
}
function adoptionLabel(pct) {
  if (pct >= 60) return '高（很可能用了原文）';
  if (pct >= 30) return '中（部分参考）';
  if (pct > 0) return '低（基本没用）';
  return '无（未检测到引用）';
}

/* --------------------------------------------------------------------------
 * 诊断信息：一键复制，便于排查
 * -------------------------------------------------------------------------- */
function diagText() {
  const L = [];
  const push = (k, v) => L.push(`${k}: ${v}`);
  push('插件版本', EXT_VER);
  push('manifest', (() => { try { return JSON.parse(localStorage.getItem('hp_deeplore_manifest_ver') || '"?"'); } catch (e) { return '?'; } })());
  push('时间', new Date().toLocaleString('zh-CN'));
  push('UA', navigator.userAgent);
  push('视口', `${window.innerWidth}x${window.innerHeight}`);
  push('主题', settings.theme);
  push('拦截模式', settings.intercept ? '开' : '关');
  push('整章召回', settings.chapterRecall ? '开' : '关');
  push('单章上限', settings.chapterMaxChars);
  push('token预算', settings.tokenBudget);
  push('并发', (settings.apis || []).map(a => `${a.name}=${a.concurrency ?? 0}`).join(', ') || '无');
  push('API数', (settings.apis || []).length + '/10');
  push('已配API', (settings.apis || []).filter(a => a.base && a.key).map(a => `${a.name}[${(a.uses || []).join('|') || '未选用途'}]${a.model ? '=' + a.model : '(无模型)'}`).join(', ') || '无');
  if (settings.indexMeta) {
    const m = settings.indexMeta;
    push('索引', `${m.chapters || '?'}章 / ${m.chunks || '?'}块 / 向量${m.vec ? '有(' + m.vecModel + ')' : '无'} / pending=${m.pending ?? '?'}`);
    push('索引时间', m.at ? new Date(m.at).toLocaleString('zh-CN') : '?');
  } else push('索引', '未建立');
  if (settings.novelMeta) push('小说', `${settings.novelMeta.name} (${settings.novelMeta.size} 字节)`);
  else push('小说', '未保存');
  push('角色数', Object.keys(settings.aliasMap || {}).length);
  // 不输出任何 Key
  return L.join('\n');
}

/* --------------------------------------------------------------------------
 * 索引体检：检查索引是否健康，给出可执行建议
 * -------------------------------------------------------------------------- */
async function checkIndex() {
  const n = await idbGet(STORE.novel, 'main');
  const ix = await idbGet(STORE.index, 'main');
  const out = { ok: true, items: [], novel: false, hasIndex: !!ix };
  out.novel = !!n?.text;

  if (!out.novel) {
    out.ok = false;
    out.items.push({ lv: 'err', t: '未保存小说', d: '请先在「索引」面板第 1 步选择 txt 并保存到本地。' });
    return out;
  }
  if (!ix?.chunks?.length) {
    out.ok = false;
    out.items.push({ lv: 'err', t: '索引未建立', d: '请执行第 3 步「建索引」。' });
  }

  const chunks = ix?.chunks || [];
  const meta = ix?.meta || {};
  const emb = pickApi('embed');

  // ① 向量覆盖率
  const withVec = chunks.filter(c => c.vec).length;
  if (chunks.length) {
    if (!withVec) {
      out.items.push({ lv: emb ? 'warn' : 'info', t: '无向量',
        d: emb ? '索引只有关键词检索。可点「建索引」续建补上向量（已切好的块会复用，不会重切）。'
               : '未配置 embedding API，当前为纯关键词检索。可在 API 池补配后重建。' });
    } else if (withVec < chunks.length) {
      out.ok = false;
      out.items.push({ lv: 'warn', t: `向量不完整（${withVec}/${chunks.length}）`,
        d: '上次建索引中途中断。点「建索引」可续建，只补未完成的块。' });
    } else {
      out.items.push({ lv: 'ok', t: `向量完整（${withVec}/${chunks.length}）`, d: '' });
    }
  }

  // ② embedding 模型是否换了
  if (meta.vecModel && emb && emb.model && meta.vecModel !== emb.model) {
    out.ok = false;
    out.items.push({ lv: 'err', t: 'embedding 模型已更换',
      d: `索引用的「${meta.vecModel}」，当前 API 是「${emb.model}」。向量空间不一致，检索结果会全乱，必须重建索引。` });
  }

  // ③ 切块参数是否变了
  if (chunks.length && (meta.chunkSize !== settings.chunkSize || meta.overlap !== settings.chunkOverlap)) {
    out.items.push({ lv: 'warn', t: '切块参数已改动',
      d: `索引是「${meta.chunkSize}/${meta.overlap}」，当前设置是「${settings.chunkSize}/${settings.chunkOverlap}」。需重建才生效。` });
  }

  // ④ 小说是否换了
  if (meta.novel && n && meta.novel !== n.name) {
    out.ok = false;
    out.items.push({ lv: 'err', t: '小说文件已更换',
      d: `索引来自「${meta.novel}」，当前是「${n.name}」。必须重建。` });
  }
  if (meta.novelSize && n && meta.novelSize !== n.size) {
    out.items.push({ lv: 'warn', t: '小说大小有变化', d: '可能是重新上传了不同版本，建议重建索引。' });
  }

  // ⑤ 章节数校验
  if (n?.text) {
    const chs = parseChapters(n.text).length;
    if (chs && meta.chapters && chs !== meta.chapters) {
      out.ok = false;
      out.items.push({ lv: 'err', t: `章节数不符（txt ${chs} / 索引 ${meta.chapters}）`, d: '索引已过期，需重建。' });
    } else if (chs) {
      out.items.push({ lv: 'ok', t: `章节 ${chs} 章`, d: '' });
    }
  }

  // ⑥ 别名表
  const aliasN = Object.keys(settings.aliasMap || {}).length;
  if (!aliasN && chunks.length) {
    out.items.push({ lv: 'warn', t: '角色别名表为空', d: '角色出场过滤与台词簇会失效，建议重建索引。' });
  } else if (aliasN) {
    out.items.push({ lv: 'ok', t: `角色 ${aliasN} 人`, d: '' });
  }

  // ⑦ 节点映射
  const nmN = Object.keys(settings.nodeMap || {}).length;
  if (!nmN && chunks.length) {
    out.items.push({ lv: 'info', t: '章节↔节点映射为空', d: '「已亲历/世界历史」判定会退化，可在「认知边界」面板校对。' });
  }

  // ⑧ API 配置
  if (!emb) out.items.push({ lv: 'info', t: '未配置 embedding API', d: '检索将只用关键词，精度较低。' });
  const llmApi = pickApi('llm');
  if (!llmApi) out.items.push({ lv: 'info', t: '未配置 LLM API', d: '情绪推断、台词微调、认知审查会跳过，只保留规则轨。' });
  const rrApi = pickApi('rerank');
  if (!rrApi) out.items.push({ lv: 'info', t: '未配置 rerank API', d: '会跳过精排，只用向量召回。不影响可用性。' });

  if (out.items.some(i => i.lv === 'err')) out.ok = false;
  return out;
}
function checkIndexHTML(r) {
  const ICON = { ok: '✓', warn: '!', err: '✕', info: 'i' };
  return r.items.map(i => `<div class="hp-chk ${i.lv}">
    <span class="hp-chk-i">${ICON[i.lv] || '·'}</span>
    <div><div class="hp-chk-t">${esc(i.t)}</div>${i.d ? `<div class="hp-chk-d">${esc(i.d)}</div>` : ''}</div>
  </div>`).join('') || '<div class="hp-chk ok"><span class="hp-chk-i">✓</span><div class="hp-chk-t">未发现异常</div></div>';
}

/* ---- 采样与块大小建议 ---- */
async function autoSample() {
  const n = await idbGet(STORE.novel, 'main');
  if (!n?.text) throw new Error('请先保存 txt');
  const chs = parseChapters(n.text);
  if (!chs.length) throw new Error('未识别到章节');
  const brief = chs.map(c => `${c.ch}:${c.date}:${c.vol}`).join('\n');
  const pcfg = settings.prompts?.sample;
  const api = pcfg?.api || null;
  let picked = [];
  if (api) {
    const txt = await withRetry(() => llm(
      (settings.prompts.sample?.text || PROMPT_DEF.sample) + '\n\n章节清单：\n' + brief, api, { max: 200 }), '采样');
    picked = (txt.match(/\d+/g) || []).map(Number).filter(x => x >= 1 && x <= chs.length).slice(0, 5);
  }
  if (!picked.length) {
    const L = chs.length;
    picked = [1, Math.round(L * 0.25), Math.round(L * 0.5), Math.round(L * 0.75), L].filter(x => x >= 1);
  }
  // 取这 5 章开头
  const samples = picked.map(ch => {
    const c = chs.find(x => x.ch === ch);
    if (!c) return { ch, text: '' };
    const end = chs[chs.indexOf(c) + 1]?.i ?? n.text.length;
    return { ch, date: c.date, text: n.text.slice(c.i, Math.min(end, c.i + 900)).trim() };
  }).filter(s => s.text);
  await idbSet(STORE.meta, 'samples', samples);
  return samples;
}

async function suggestChunk() {
  let samples = await idbGet(STORE.meta, 'samples');
  if (!samples?.length) samples = await autoSample();
  const api = settings.prompts?.chunksize?.api || null;
  if (!api) return 400;
  const body = samples.map(s => `【第${s.ch}章】\n${s.text}`).join('\n\n');
  const txt = await withRetry(() => llm(
    (settings.prompts.chunksize?.text || PROMPT_DEF.chunksize) + '\n\n' + body, api, { max: 40 }), '块大小');
  const num = Number((txt.match(/\d+/) || [])[0]);
  return Number.isFinite(num) && num >= 120 && num <= 2000 ? num : 400;
}


/* ==========================================================================
 * 8 套 LLM 提示词（默认文本）
 * ========================================================================== */
const PROMPT_DEF = {
  sample: '以下是小说的章节清单（格式：章号:日期:分部名）。\n请挑出 5 个最具代表性的章号，需覆盖：开篇、日常、冲突高潮、情感转折、收束。\n只输出 5 个阿拉伯数字，用逗号分隔，不要任何解释。',
  chunksize: '以下是从小说中抽取的 5 段原文样本。\n请给出一个适合做语义检索的「块大小」（汉字数）。\n要求：块太小失去上下文，太大则检索不精准。中文小说通常 300-600 字较合适。\n只输出一个整数，不要任何解释。',
  persona: '以下是角色在原文中的台词集合。\n请提炼：①该角色的恒定性格（3-5 个关键词 + 一句话概括）；②把这些台词按对主角的态度档位归类，档位为：敌视/排斥/冷淡/缓和/亲近/亲密。\n输出 JSON：{"traits":"","summary":"","tiers":{"敌视":["台词1"],"排斥":[],...}}',
  mood: '你是叙事分析器。请推断该 NPC 此刻的状态。\n\n【最近发生的事】（按时间顺序，最后一行是最近一次）\n{prev}\n\n【NPC 当前变量】\n{vars}\n\n【当前场景原文】\n{scene}\n\n【玩家这一轮说的话】\n{input}\n\n【长期记忆】（本局真实发生过的事，按与本轮情境的相关度召回，可能横跨数百乃至数千楼）\n{memory}\n\n═══ 推理顺序（严格按此顺序，跳步即为错）═══\n第 0 步｜先读「长期记忆」，判断有没有被本轮情境唤醒的旧事。\n　记忆每条都带时间锚点（几分钟前／几小时前／几天前／几周前／几月前／几年前）。\n　唤醒标准不是"它重不重要"，而是"它和眼下情境是否对上了"：\n　· 场景共现——记忆里的地点、天气、物品与当前场景重合（如雷雨夜 → 多年前那句"我怕打雷"）；\n　· 承诺被触发——记忆里有人许下过承诺，而本轮情境正在兑现或正在违背它；\n　· 人物被提及——记忆里那个人出现在当前场景或玩家的话里。\n　唤醒了就写进「当前情绪」的起因，格式如"（因多年前那句……而……）"。\n　一条都没对上就明确写"本轮无记忆唤醒"，不要为了用记忆而硬凑。\n　★ 记忆只提供素材。是否提起、怎么提起由角色自行判断，你只负责判断"他想不想起来了"。\n第 1 步｜读「最近发生的事」，找出情绪的因。\n　上一轮他具体说了哪句话、做了哪个动作，对方如何回应。情绪永远是上一轮事件的延续或转折，不会凭空产生。\n　若这里为空或读不出因果，输出「当前情绪」时写「（上下文不足，按变量推定）」前缀，不要假装读懂。\n第 2 步｜读变量，确定「允许的情绪区间」。\n　好感度与关系是天花板与地板：关系对立时，无论玩家说什么，都不允许出现依恋类情绪。\n　把变量当作约束条件，而不是情绪本身——好感度 80 不等于「他现在很高兴」。\n第 3 步｜读本轮输入，判断它构成了什么新刺激。\n　三种之一：火上浇油（强化既有情绪）／缓和（削弱）／转移（情绪被截断，产生未完成感）。\n　注意「没回应」也是一种回应：被无视会催生执念或恼怒，视性格而定。\n第 4 步｜三者合成「此刻」的情绪，并给出它与上一轮之间的变化方向。\n\n═══ 硬性约束（违反即判失败）═══\n· 情绪必须能追溯到「最近发生的事」里具体某一句或某一个动作；推导不出因果说明没读懂，重读再答。\n· 好感度为负 / 关系对立时，同类场景只能写：被冒犯、不耐烦、轻视、戒备、觉得碍眼、懒得搭理、讥讽。\n· 好感度为负时严禁写：吃醋、失落、患得患失、想靠近、心疼、在意、委屈。这些只在关系升温后才可能出现。\n· 不得用情绪反向暗示关系已升温——情绪是结果，不是关系的证据。\n· 情绪强度要与刺激量级匹配：被踩一脚不至于暴怒，被当众羞辱也不该无动于衷。\n· 「预测动作」必须是紧接着本轮情境的下一句或下一步，具体到可直接开演；禁止写「他会思考人生」这类空话。\n· 「预测动作」不得包含玩家才能决定的结果（如「主角答应了他」），只写他自己能完成的部分。\n· 「准备动作」是跨场事项（他私下在筹备什么）；变量里没有明确依据就写「无」，不要编。\n· 态度档位只能从「敌视/排斥/冷淡/缓和/亲近/亲密」中选一个，且必须与好感度区间一致。\n\n输出严格 JSON（不要 markdown 代码块，不要任何解释文字）：\n{"当前情绪":"一句，必须含起因","记忆唤醒":"被本轮情境唤醒的旧事，无则写无","态度档位":"敌视/排斥/冷淡/缓和/亲近/亲密","情绪变化":"强化/削弱/转移/持平","预测动作":"他下一句或下一步最可能做什么","准备动作":"他此刻正在筹备的跨场事项，无则写无"}',
  lines: '你是台词润色器。\n\n【角色】{name}　【态度档位】{tier}　【当前情绪】{mood}\n【场景】{scene}\n【刚刚发生过什么】\n{prev}\n【玩家这一轮说的话】\n{input}\n【长期记忆】（本局真实发生过的事，含时间锚点）\n{memory}\n\n【原作台词参考（仅供味道参考，禁止照搬）】\n{refs}\n\n═══ 任务 ═══\n写出 {n} 句该角色在此情此景下可能说的话。\n\n═══ 下笔前先过这四关（任何一关不过就不要写）═══\n① 时态关：这句话是在回应「刚刚发生过什么」之后说的，不是凭空开场。\n② 档位关：语气必须符合「态度档位」。敌视档不许出现关心，亲密档不许只剩客套。\n③ 情绪关：必须体现「当前情绪」的走向，且强度匹配——不能玩家道歉了他还火力全开，也不能上一秒被羞辱下一秒就笑着闲聊。\n④  continuity 关：若「刚刚发生过什么」里有未回应的话茬，至少有一句要接上它。\n⑤ 记忆关：「长期记忆」里若有一条被本轮情境唤醒，最多只在其中一句台词里露出一丝痕迹——\n　可以是一个只有他们才懂的词、一次突然的停顿、一句没头没尾的旧话，但绝不要把整件事复述一遍。\n　没有任何记忆被唤醒，就不要出现任何来路不明的怀旧。\n\n═══ 硬性约束 ═══\n· 禁止照搬「原作台词参考」任何一句。参考只用来拿捏用词习惯、句式长短、脏话与敬语的分寸。\n· 禁止替玩家写台词、禁止替玩家做决定、禁止叙述玩家的反应。只写该角色自己能说出口的部分。\n· 禁止出现「我知道你心里其实……」这类读心式台词，除非角色有明确依据。\n· 每句长度符合此人口吻：刻薄的人短促带刺，拘谨的人完整绕弯。\n· 不写旁白、不写动作描写、不加引号以外的说明文字。\n· 台词可以是半句、可以是反问、可以是沉默后的转移话题，但必须是「他说的话」。\n\n输出严格 JSON（不要 markdown 代码块）：\n{"lines":["第一句","第二句"]}',
  cognition: '你要审查「准备注入给角色 X 的参考内容」是否超出 X 此刻的认知范围。\n\n═══ 判为「可知」须满足其一 ═══\n① 他本人在场，亲眼见到或亲耳听到；\n② 有明确的转述者、信件、公开记录或已结算节点为证；\n③ 他学过、用过，或该知识属于他熟悉的体系（如本专业的常识）。\n\n═══ 以下一律判「不可知」 ═══\n· 作者旁白、心理描写、内心独白（无论属于谁）；\n· 他不在场时发生的对话与事件，且无人转述；\n· 未来信息、预言、尚未发生的情节；\n· 他人的隐藏动机、身份秘密、未挑明的关系；\n· 只存在于玩家视角的叙述，角色无从得知；\n· 需要「全知视角」才能成立的因果链。\n\n═══ 审查步骤 ═══\n1. 逐条过一遍待注入内容，标记出所有含「专有信息」的片段（人名、事件名、地点、秘密、时间点）。\n2. 对每条问：X 通过哪条路径得知？路径不存在即判不可知。\n3. 拿不准的一律判不可知——宁可少给，不可泄底。\n\n═══ 输出 ═══\n只输出需要删除的片段原文（每行一条）。若全部可知，只输出一个词：全部可知\n不要解释、不要编号、不要 markdown 代码块。',
  draco: '你是德拉科·马尔福的专项分析器。\n\n【刚刚发生过什么】（按时间顺序，最后一行是最近一次）\n{prev}\n\n【变量】{vars}\n【当前场景】{scene}\n【玩家这一轮说的话】{input}\n【当前时间线阶段】{stage}\n\n【长期记忆】（本局真实发生过的事，含时间锚点；可能横跨数千楼）\n{memory}\n\n═══ 角色基调（不可违背）═══\n· 傲慢、嘴硬、护短、记仇。情绪从不直说，总是绕一个弯。\n· 越在意越刻薄：真正触动他的事，他会用最刺的话盖过去，而不是坦白。\n· 有占有欲与醋意，但绝不会承认——被点破会立刻反讽或转移话题。\n· 对主角的态度取决于关系档位；档位越低，他的话越应该带刺、带距离感。\n· 他的自尊不允许他示弱、道歉或主动求和；即便想缓和，也只会用「施舍」的姿态。\n\n═══ 推理顺序 ═══\n0. 先读「长期记忆」：有没有旧事被本轮情境唤醒——尤其是他自己许下过、或收到过的承诺。\n   ★ 承诺的两种反应性质完全不同，判错即毁人设：\n   · 承认度高（许下时关系亲密、好感高）→ 违背时是受伤、嫉妒、被背叛感，但他绝不直说，会绕成刻薄话盖过去。\n   · 承认度低（许下时陌生或敌对、好感为负）→ 他根本不认这条承诺，提起时是讥讽、是拿它当笑话，不是伤心。\n   好感度为负时，严禁把一条旧承诺演绎成"他其实一直很在意"——那是吃醋，不是德拉科。\n   记忆没被唤醒就写"无"，不要为了显得深情而硬拗。\n1. 从「刚刚发生过什么」里找这轮情绪的源头：上一轮他被怎样对待、他回击了什么、有没有话茬没接。\n2. 看变量确认关系档位与好感度，这决定他说话的刺的密度。\n3. 判断玩家本轮输入是顺着他、顶撞他、还是无视他——他对此的反应截然不同。\n4. 综合得出：他此刻真正想要什么（往往不是嘴上说的那个）、他打算怎么说（嘴上会绕成什么样）。\n\n═══ 硬性约束 ═══\n· 好感度为负时严禁：吃醋、失落、患得患失、想靠近、心疼、在意。此时只能是轻蔑、戒备、被冒犯、不耐烦。\n· 严禁让他直接说出「我在乎你」「我担心你」这类直白表达，即便是亲密档也要拐弯。\n· 「口是心非」字段必须写：他嘴上说的 vs 实际想要的，两者要有落差；落差为零说明你没写好。\n· 不得替玩家做决定或预判玩家的回应。\n\n输出严格 JSON（不要 markdown 代码块）：\n{"当前情绪":"一句，含起因","记忆唤醒":"被本轮唤醒的旧事原文，无则写无","口是心非":"嘴上如何说 vs 实际想要什么","预测动作":"他下一句或下一步","准备动作":"跨场事项，无则写无"}',
  query: '把玩家这句话改写成适合检索小说原文的查询词。\n要求：保留关键实体（人名、地点、物品、事件），去掉口语虚词，控制在 20 字以内。\n只输出查询词，不要解释。\n\n玩家的话：{input}',
  rerank: '（本项不使用 LLM 生成，仅用于指定「每轮检索精排」走哪条 API）\n精排是在向量召回候选之后、按与查询的真实相关性重新排序的一步。\n在此选择一条支持 /rerank 接口的 API；留空则按 API 池的用途标签自动挑选。',
  plot: '你是剧情进度定位器。任务是判断「故事此刻演到了第几章」。\n\n【当前时间变量】\n{vars}\n\n【章节索引】（格式：章号 | 日期 | 年级·分部 | 标题；只列出与当前时间最接近的一段）\n{index}\n\n【最近正文】（按时间顺序，最后一轮在最下面）\n{prev}\n\n【玩家这一轮说的话】\n{input}\n\n═══ 判定顺序（严格按此，不得跳步）═══\n第 1 步｜若「当前时间变量」里有可用的游戏内日期，先按日期在「章节索引」里找到日期最接近且不晚于它的那一章，作为候选。\n第 2 步｜拿候选章去对照「最近正文」：正文里已经发生的事，是否与该章的剧情吻合？\n　· 吻合 → 确认它就在此章。\n　· 正文已经演过了这一章的内容 → 往后推（取索引里更靠后的章）。\n　· 正文还在演这一章之前的事 → 往前退。\n第 3 步｜时间变量缺失或与正文明显矛盾时，以「最近正文」为准，在索引里挑剧情最吻合的一章。\n第 4 步｜全部线索都读不出时，输出你最有把握的章号，并在「把握」里写「低」。\n\n═══ 硬性约束 ═══\n· 只输出一个章号，必须是「章节索引」里出现过的阿拉伯数字，不得编造。\n· 不得把"即将发生"当作"已经发生"——正文没演到的就不算演过。\n· 「理由」控制在 40 字以内，只写你据以判断的那条最硬的依据。\n\n输出严格 JSON（不要 markdown 代码块，不要任何解释文字）：\n{"章号":123,"理由":"……","把握":"高/中/低"}',
};

const PROMPT_KEYS = [
  { key: 'sample', label: '① 样本自动选取（离线）', def: PROMPT_DEF.sample },
  { key: 'chunksize', label: '② 块大小建议（离线）', def: PROMPT_DEF.chunksize },
  { key: 'persona', label: '③ 角色画像挖掘（离线）', def: PROMPT_DEF.persona },
  { key: 'mood', label: '④ 情绪与动作推断（每轮）', def: PROMPT_DEF.mood },
  { key: 'lines', label: '⑤ 台词微调（每轮）', def: PROMPT_DEF.lines },
  { key: 'cognition', label: '⑥ 认知边界审查（每轮）', def: PROMPT_DEF.cognition },
  { key: 'draco', label: '⑦ 德拉科细化（在场时）', def: PROMPT_DEF.draco },
  { key: 'query', label: '⑧ 查询改写（每轮）', def: PROMPT_DEF.query },
  { key: 'rerank', label: '⑨ 检索精排（每轮·选 API）', def: PROMPT_DEF.rerank, apiOnly: true },
  { key: 'plot', label: '⑩ 剧情进度定位（控世界书条目）', def: PROMPT_DEF.plot },
];

function promptApi(k) { return settings.prompts?.[k]?.api || null; }
function promptText(k) { return settings.prompts?.[k]?.text || PROMPT_DEF[k] || ''; }

function fill(tpl, map) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (map[k] != null ? String(map[k]) : ''));
}

/* ==========================================================================
 * 【v1.25】剧情进度定位 → 控制世界书剧情条目启停
 * 插件读时间变量 + 章节索引 + 最近正文 → 判定演到第几章
 * → 启用「当前章 ±N 章」的剧情条目，禁用其余，取代写死的触发器条目
 * ========================================================================== */

/* ---------- 世界书读写（多路径回退，失败不静默） ---------- */
let __wbProbe = { at: 0, ok: false, name: '', count: 0, plotCount: 0, writeOk: false, src: '', err: '' };

/* 从 ST 各种已知挂载点取世界书条目列表 */
function wbReadLive() {
  const c = stGetContext() || {};
  const cand = [c.worldInfo, c.world_info, c.worldinfo,
    (typeof window !== 'undefined') ? window.worldInfo : null,
    (typeof window !== 'undefined') ? window.world_info : null];
  for (const o of cand) {
    if (!o) continue;
    if (Array.isArray(o) && o.length) return { entries: o, src: 'context(数组)' };
    if (typeof o === 'object' && o.entries) {
      const e = o.entries;
      const arr = Array.isArray(e) ? e : Object.values(e);
      if (arr.length) return { entries: arr, src: 'context(entries)' };
    }
    if (typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length) {
      /* 形如 {123: {...}} 的 uid → 条目 映射 */
      const arr = Object.values(o).filter(x => x && typeof x === 'object');
      if (arr.length && arr.every(x => 'content' in x || 'comment' in x || 'key' in x)) {
        return { entries: arr, src: 'context(uid映射)' };
      }
    }
  }
  return null;
}

/* 【修 v1.26】Slash 命令层。
   有些 ST 版本里 context 拿不到 worldInfo、/worldinfo/get 也读不通，
   但原生 UI 的斜杠命令一定可用——它走的是 ST 自己的内部通道，最贴近手动操作。
   这里把命令解析封装起来，并做成"探测 + 多格式尝试 + 结果验证"，不硬编码赌一种写法。 */
function wbSlash() {
  const S = ST();
  return S.SlashCommandParser || (typeof window !== 'undefined' ? window.SlashCommandParser : null) || null;
}
async function wbSlashRun(cmd) {
  const P = wbSlash();
  if (!P) return { ok: false, err: 'SlashCommandParser 不存在' };
  try {
    if (typeof P.parse === 'function') await P.parse(cmd);
    else if (typeof P.execute === 'function') await P.execute(cmd);
    else return { ok: false, err: '解析器没有 parse/execute' };
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String(e?.message || e) };
  }
}
/* 探测可用命令，重点看有没有 world / enable / disable 相关的 */
function wbSlashProbe() {
  const P = wbSlash();
  const out = { has: false, total: 0, world: [], entryCmd: false, err: '' };
  if (!P) { out.err = 'SlashCommandParser 不存在'; return out; }
  out.has = true;
  let cmds = [];
  try {
    const src = P.commands || P.slashCommands || (typeof P.getCommands === 'function' ? P.getCommands() : null);
    if (src) {
      /* 用鸭子类型判断，不用 instanceof Map —— 跨 realm（iframe/沙盒）时 instanceof 会失效 */
      const looksMap = typeof src.keys === 'function' && typeof src.get === 'function';
      if (looksMap) { try { cmds = [...src.keys()]; } catch (e) { cmds = []; } }
      else if (typeof src.forEach === 'function' && !Array.isArray(src)) {
        try { src.forEach((v, k) => cmds.push(String(k))); } catch (e) { /* 忽略 */ }
      }
      else if (Array.isArray(src)) cmds = src.map(x => (x && (x.name || x.key)) ? String(x.name || x.key) : String(x));
      else if (typeof src === 'object') cmds = Object.keys(src);
    }
  } catch (e) { /* 某些版本不可枚举，退回黑名单试跑 */ }
  out.total = cmds.length;
  out.world = cmds.filter(c => /world|enable|disable/i.test(String(c))).slice(0, 30);
  /* 单条启停命令：ST 会为每个条目注册 enable-<名>/disable-<名> */
  out.entryCmd = out.world.some(c => /^(enable|disable)-/.test(String(c)));
  if (!out.total) out.err = '拿不到命令表（可枚举性受限），将用试跑探测';
  return out;
}

/* 当前世界书名字（多路径，含 DOM 兜底） */
function wbCurrentName() {
  try {
    const c = stGetContext() || {};
    const n = c.worldInfoName || c.world_info_name || c.worldInfo?.name || c.world_info?.name
      || (typeof c.getWorldInfoName === 'function' ? c.getWorldInfoName() : null);
    if (n) return String(n);
    const S = ST();
    if (typeof S.getCurrentWorldInfoName === 'function') {
      const g = String(S.getCurrentWorldInfoName() || '');
      if (g) return g;
    }
    /* DOM 兜底：世界书下拉框 / 编辑器选择框 */
    try {
      const sel = document.querySelector('#world_info_select, #world_editor_select, .world_info_select, select#world_info');
      const v = sel && (sel.value || (sel.options && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]?.text));
      if (v && String(v).trim() && !/^(select|选择)/i.test(String(v))) return String(v).trim();
    } catch (e) { /* 忽略 */ }
    /* 全局兜底 */
    if (typeof window !== 'undefined') {
      const w = window.world_info_name || window.worldInfoName || window.currentWorldInfoName;
      if (w) return String(w);
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

async function wbFetch(name) {
  const r = await fetch('/api/worldinfo/get', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const e = j?.entries || j?.data?.entries || j?.data || j;
  const arr = Array.isArray(e) ? e : Object.values(e || {});
  return arr;
}

async function wbWriteBack(name, entries) {
  const body = { name, data: { entries } };
  const r = await fetch('/api/worldinfo/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.ok;
}

/* 剧情条目识别：uid >= 900000 是由插件生成的 273 章节点；
   也兼容 comment 形如「[Y1-001] 剧情·…·第1章（…）」的命名 */
const PLOT_UID_BASE = 900000;
function isPlotEntry(e) {
  const uid = Number(e?.uid);
  if (Number.isFinite(uid) && uid >= PLOT_UID_BASE && uid <= PLOT_UID_BASE + 999) return true;
  const cm = String(e?.comment || '');
  return /\[Y\d-\d{3}\]/.test(cm) && /第\d+章/.test(cm);
}
function entryChapter(e) {
  /* 优先读 comment 里明写的「第N章」——那是显式章号，不依赖 uid 基准约定。
     uid 只在没有文字章号时作回退（900000 → 第1章）。 */
  const m = /第(\d+)章/.exec(String(e?.comment || e?.name || ''));
  if (m) { const n = Number(m[1]); if (n >= 1 && n <= 9999) return n; }
  const uid = Number(e?.uid);
  if (Number.isFinite(uid) && uid >= PLOT_UID_BASE && uid <= PLOT_UID_BASE + 999) return uid - PLOT_UID_BASE + 1;
  return null;
}

/* 读一次世界书并探测写入能力，结果缓存 30 秒 */
async function wbProbe(force) {
  if (!force && __wbProbe.ok && Date.now() - __wbProbe.at < 30000) return __wbProbe;
  const out = { at: Date.now(), ok: false, name: '', count: 0, plotCount: 0, writeOk: false, src: '', err: '' };
  let entries = null, src = '';
  const live = wbReadLive();
  if (live) { entries = live.entries; src = live.src; }
  else {
    const nm = wbCurrentName();
    if (!nm) { out.err = '读不到世界书：context 里没有条目，也拿不到世界书名字'; __wbProbe = out; return out; }
    try { entries = await wbFetch(nm); src = 'api:/worldinfo/get'; out.name = nm; }
    catch (e) { out.err = '读取失败：' + e.message; __wbProbe = out; return out; }
  }
  if (!entries || !entries.length) { out.err = '世界书里没有条目'; __wbProbe = out; return out; }
  out.ok = true; out.count = entries.length; out.src = src;
  out.plotCount = entries.filter(isPlotEntry).length;
  /* 写入能力：只在真要改的时候才试，这里仅记录名字是否可得 */
  out.writeOk = !!(out.name || wbCurrentName());
  __wbProbe = out;
  return out;
}

/* 按章号启用/禁用。返回 {ok, changed, list, err} */
async function wbApplyChapter(ch, range) {
  const p = await wbProbe(true);
  if (!p.ok) return { ok: false, changed: 0, list: [], err: p.err || '读不到世界书' };
  let entries = null;
  const live = wbReadLive();
  if (live) entries = live.entries;
  else entries = await wbFetch(wbCurrentName() || p.name);

  const lo = ch - range, hi = ch + range;
  const changed = [];
  for (const e of entries) {
    if (!isPlotEntry(e)) continue;
    const ec = entryChapter(e);
    if (ec == null) continue;
    const want = (ec >= lo && ec <= hi) ? false : true;   // disable: 范围内=false(启用)
    if (!!e.disable !== want) { e.disable = want; changed.push({ ch: ec, disable: want, e }); }
  }
  /* 写回。三条路依次试，任一成功即止：
     ① context 内存直改 —— 最快，但需 ST 自己保存才持久
     ② /worldinfo/edit API —— 标准后端写入
     ③ Slash 命令 —— 走 ST 原生 UI 通道，对读不通 context 的版本有效 */
  let ok = false, src = ''; const tried = [];

  /* ① context 内存：改得到 ≠ 存得住。只改内存而 ST 没保存，等于没改。 */
  let memOk = false, apiOk = false, saved = false;
  if (live) memOk = true;
  /* ② API（真正落盘，优先于内存） */
  try {
    const nm = wbCurrentName() || p.name;
    if (nm) { apiOk = await wbWriteBack(nm, entries); if (!apiOk) tried.push('API 返回非 200'); }
    else tried.push('拿不到世界书名字');
  } catch (e) { tried.push('API:' + e.message); }
  /* ③ 落盘：ST 有现成保存函数就调一次 */
  try {
    const c = stGetContext();
    if (typeof c?.saveWorldInfo === 'function') { await c.saveWorldInfo(); saved = true; }
  } catch (e) { /* 忽略 */ }

  /* 只有"API 成功"或"内存已改且确实存了"才算真成功，否则继续试 Slash */
  ok = apiOk || (memOk && saved);
  if (apiOk) src = 'api:/worldinfo/edit';
  else if (ok) src = 'context 内存 + saveWorldInfo';

  /* ③ Slash 命令逐条启停：只有前两条都失败时才走这条 */
  let slashUsed = 0, slashErr = '';
  if (!ok && changed.length) {
    const sp = wbSlashProbe();
    if (sp.has) {
      for (const it of changed) {
        const nm = entryName(it.e);
        if (!nm) continue;
        const r = await wbSlashSetEntry(nm, !it.disable);
        if (r.ok) slashUsed++; else if (!slashErr) slashErr = r.err || '命令未生效';
      }
      if (slashUsed) { ok = true; src = (src ? src + ' + ' : '') + `Slash 命令(${slashUsed} 条)`; }
    } else slashErr = sp.err;
  }
  /* 已经是目标状态、无需改动，也算成功 */
  if (!ok && !changed.length && (live || p.ok)) {
    return { ok: true, changed: 0, list: [], src: '无需改动（已是目标状态）', slash: 0, err: '' };
  }
  if (ok) return { ok: true, changed: changed.length, list: changed, src, slash: slashUsed, err: '' };
  return {
    ok: false, changed: 0, list: [], slash: 0, src,
    err: '世界书写入不可用（试过：' + (tried.join('；') || '无可用路径') + (slashErr ? '；Slash:' + slashErr : '') + '）。请手动改条目启用状态。'
  };
}

/* 条目名字（用于 Slash 命令） */
function entryName(e) {
  if (!e) return '';
  /* 压平换行：条目名会拼进斜杠命令，带换行会把命令截断 */
  return String(e.comment || e.name || e.entryName || e.key || '').replace(/[\r\n]+/g, ' ').trim();
}
/* 用 Slash 命令启停单条。多格式尝试，逐个试跑 */
async function wbSlashSetEntry(name, enable) {
  const safe = String(name || '').replace(/[\r\n]+/g, ' ').trim();
  if (!safe) return { ok: false, err: '条目名为空' };
  const forms = enable
    ? [`/enable-${safe}`, `/world-enable ${safe}`, `/enable ${safe}`]
    : [`/disable-${safe}`, `/world-disable ${safe}`, `/disable ${safe}`];
  let last = '';
  for (const f of forms) {
    const r = await wbSlashRun(f);
    if (r.ok) return { ok: true, cmd: f };
    last = r.err || '';
  }
  return { ok: false, err: last || '命令未生效' };
}

/* ---------- 章节索引：从已建索引里聚合成「章号|日期|年级·分部」清单 ---------- */
async function chapterIndexList() {
  try {
    const idx = await idbGet(STORE.index, 'main');
    const chunks = idx?.chunks || [];
    if (!chunks.length) return [];
    const m = new Map();
    for (const c of chunks) {
      const ch = Number(c.chapter);
      if (!Number.isFinite(ch) || ch <= 0) continue;
      if (!m.has(ch)) m.set(ch, { ch, date: String(c.date || ''), grade: String(c.grade || ''), vol: String(c.vol || '') });
    }
    return [...m.values()].sort((a, b) => a.ch - b.ch);
  } catch (e) { return []; }
}

/* 取与给定日期最接近的一段章节（前后各 6 章），供提示词使用 */
function sliceIndexNear(list, date, ch, span) {
  let at = -1;
  if (ch) at = list.findIndex(x => x.ch === ch);
  if (at < 0 && date) {
    let best = -1, bd = Infinity;
    list.forEach((x, i) => {
      if (!x.date) return;
      if (x.date <= date) { const d = date.localeCompare(x.date); if (d >= 0 && d < bd) { bd = d; best = i; } }
    });
    at = best;
  }
  if (at < 0) at = 0;
  const lo = Math.max(0, at - span), hi = Math.min(list.length, at + span + 1);
  return { rows: list.slice(lo, hi), at };
}

/* 自动执行：定位 → 同步世界书。全程静默，失败只记 console */
async function runPlotCtl(opt = {}) {
  try {
    if (!settings.plotCtlOn) return null;
    const sd = getStatData();
    const prev = recentContext(settings.historyTurns || 3).text;
    const r = await locateChapter(sd, prev, '');
    if (!r.ok) { if (!opt.silent) toast('剧情定位失败：' + r.why, 'err'); return null; }
    const before = settings.plotLastCh;
    settings.plotLastCh = r.ch; settings.plotLastWhy = r.why; settings.plotLastAt = Date.now();
    saveSettings();
    if (before !== r.ch) {
      const a = await wbApplyChapter(r.ch, Number(settings.plotRange) || 0);
      if (!opt.silent) {
        toast(a.ok ? `剧情推进到第 ${r.ch} 章，已同步 ${a.changed} 条条目` : `定位到第 ${r.ch} 章，但世界书写入失败`, a.ok ? 'ok' : 'err');
      }
      return { ch: r.ch, applied: a.ok, changed: a.changed };
    }
    return { ch: r.ch, applied: false, changed: 0 };
  } catch (e) {
    console.warn('[HP-DeepLore] 剧情自动定位失败：', e?.message || e);
    return null;
  }
}

/* ---------- 定位：变量 → 索引 → 正文（LLM） ---------- */
async function locateChapter(sd, prevText, userInput) {
  const list = await chapterIndexList();
  if (!list.length) return { ok: false, ch: 0, why: '尚未建立索引，读不到章节清单', src: '无' };

  const nowDate = String(sd?.世界?.当前时间 || '').slice(0, 10);
  /* ① 纯变量 + 索引：日期能定位就直接定，不必花钱问 LLM */
  let guess = null;
  if (nowDate) {
    let best = null;
    for (const x of list) { if (x.date && x.date <= nowDate) best = x; }
    if (best) guess = best.ch;
  }
  const manual = Number(settings.plotManualCh) || 0;
  if (settings.plotTrustManual && manual > 0) {
    return { ok: true, ch: manual, why: '手动指定', src: '手动', guess };
  }

  /* ② 交给 LLM：把日期、附近索引、正文一起给它判 */
  const api = (promptApi('plot') && pickApiByName(promptApi('plot'))) || pickApi('llm');
  if (!api) {
    if (guess) return { ok: true, ch: guess, why: '按变量日期落到不晚于当前时间的最近一章', src: '变量日期', guess };
    if (manual > 0) return { ok: true, ch: manual, why: '手动指定', src: '手动', guess };
    return { ok: false, ch: 0, why: '无可用 LLM，且变量日期也读不出', src: '无' };
  }
  const near = sliceIndexNear(list, nowDate, guess || manual, 6);
  const indexTxt = near.rows.map(x => `${x.ch} | ${x.date || '—'} | ${x.grade}${x.vol ? '·' + x.vol : ''}`).join('\n');
  const tp = fill(promptText('plot'), {
    vars: `当前时间：${nowDate || '（变量里读不到）'}\n其他：${String(JSON.stringify(sd?.世界 || {})).replace(/\s+/g, '').slice(0, 200)}`,
    index: indexTxt || '（空）',
    prev: prevText || '（读不到正文）',
    input: userInput || '（无）',
  });
  try {
    const txt = await llm(tp, api.name, { temp: 0.1, max: 200 });
    const m = /"章号"\s*:\s*(\d+)/.exec(txt) || /(\d+)/.exec(txt.replace(/[^\d]/g, ' ').trim());
    const why = (/"理由"\s*:\s*"([^"]*)"/.exec(txt) || [])[1] || '';
    const ch = m ? Number(m[1]) : 0;
    if (ch > 0 && list.some(x => x.ch === ch)) {
      return { ok: true, ch, why: why || 'LLM 判定', src: 'LLM', guess };
    }
    return { ok: false, ch: 0, why: 'LLM 返回了索引里不存在的章号：' + txt.slice(0, 60), src: 'LLM', guess };
  } catch (e) {
    if (guess) return { ok: true, ch: guess, why: 'LLM 失败（' + e.message + '），退回变量日期', src: '变量日期', guess };
    if (manual > 0) return { ok: true, ch: manual, why: 'LLM 失败，退回手动', src: '手动', guess };
    return { ok: false, ch: 0, why: 'LLM 调用失败：' + e.message, src: '无' };
  }
}

/* ==========================================================================
 * 检索
 * ========================================================================== */
async function retrieve(query, grade, sd, opt = {}) {
  const idx = await idbGet(STORE.index, 'main');
  if (!idx?.chunks?.length) return [];
  const nowDate = String(sd?.世界?.当前时间 || '9999-12-31').slice(0, 10);
  const done = sd?.世界线?.已结算节点 || {};
  const nm = settings.nodeMap || {};
  const boost = String(settings.boostWords || '').split(/[,，\s]+/).filter(Boolean);
  const penalty = String(settings.penaltyWords || '').split(/[,，\s]+/).filter(Boolean);

  // ① 时间硬过滤：剔除未来
  let pool = idx.chunks.filter(c => !c.date || c.date <= nowDate);

  // ② 角色过滤（可选）
  if (settings.charFilterEnabled && opt.charId) {
    const f = pool.filter(c => (c.chars || []).includes(opt.charId));
    if (f.length) pool = f;
  }

  // ③ 向量召回
  let cand;
  const emb = pickApi('embed');
  const hasVec = emb && pool.some(c => c.vec);
  if (hasVec) {
    try {
      const qv = (await withRetry(() => embed([query]), '查询向量化'))[0];
      cand = pool.filter(c => c.vec).map(c => ({ c, s: cosine(qv, c.vec) }));
      const noVec = pool.filter(c => !c.vec);
      if (noVec.length) cand = cand.concat(noVec.map(c => ({ c, s: jaccard(query, c.text) * 0.5 })));
      cand.sort((a, b) => b.s - a.s);
      cand = cand.slice(0, settings.recallTop);
    } catch (e) {
      console.warn('[HP-DeepLore] 向量检索失败，退回关键词：', e.message);
      cand = pool.map(c => ({ c, s: jaccard(query, c.text) }));
      cand.sort((a, b) => b.s - a.s);
      cand = cand.slice(0, settings.recallTop);
    }
  } else {
    cand = pool.map(c => ({ c, s: jaccard(query, c.text) }));
    cand.sort((a, b) => b.s - a.s);
    cand = cand.slice(0, settings.recallTop);
  }

  // ④ 加权
  const scored = cand.map(({ c, s }) => {
    let sc = s;
    if (c.grade === grade) sc += 0.15;
    const ids = nm[c.chapter] || [];
    const lived = ids.length && ids.some(id => done[id]);
    if (lived) sc += 0.3;
    if (boost.length && boost.some(w => c.text.includes(w))) sc += 0.25;
    if (penalty.length && penalty.some(w => c.text.includes(w))) sc -= 0.3;
    return { c, s: sc, lived: !!lived };
  });
  scored.sort((a, b) => b.s - a.s);

  // ⑤ rerank 精排
  const docs = scored.slice(0, Math.max(settings.topK * 3, 10)).map(x => ({
    id: x.c.id, chapter: x.c.chapter, date: x.c.date, grade: x.c.grade,
    vol: x.c.vol, text: x.c.text, s: x.s, lived: x.lived,
  }));
  let rank = await rerank(query, docs);
  rank.sort((a, b) => (b.rr - a.rr) || (b.s - a.s));

  const asItem = (r, text, extra) => Object.assign({
    id: r.id, chapter: r.chapter, date: r.date, grade: r.grade, vol: r.vol,
    text: text != null ? text : r.text,
    score: (r.s || 0).toFixed(2), rr: (r.rr || 0).toFixed(2), lived: !!r.lived,
  }, extra || {});

  // 【v1.13】⑥ 整章召回：命中块 → 补全该章全部块
  // 旧行为只注入命中的 3 个 400 字块，一章往往被切成 10~20 块，
  // 结果剧情只剩 30% 且不连贯。现在把命中的章整章拼回来。
  if (settings.chapterRecall) {
    const byChapter = new Map();
    // 用 topK 条线索块确定"命中了哪几章"，同章保留最高分
    for (const r of rank.slice(0, Math.max(1, settings.topK))) {
      const key = r.grade + '#' + r.chapter;
      const prev = byChapter.get(key);
      if (!prev || (r.rr || r.s) > (prev.rr || prev.s)) byChapter.set(key, r);
    }
    const chList = [...byChapter.values()]
      .sort((a, b) => (b.rr - a.rr) || (b.s - a.s))
      .slice(0, Math.max(1, settings.chapterMaxCount || 1));

    const out = [];
    for (const r of chList) {
      const blocks = idx.chunks
        .filter(c => c.grade === r.grade && c.chapter === r.chapter)
        .sort((a, b) => (a.seq || 0) - (b.seq || 0));
      if (!blocks.length) { out.push(asItem(r)); continue; }
      let text = blocks.map(b => b.text).join('\n');
      let truncated = false;
      const lim = Number(settings.chapterMaxChars) || 0;
      if (lim > 0 && text.length > lim) {
        text = text.slice(0, lim);
        truncated = true;
      }
      out.push(asItem(r, text, { blocks: blocks.length, truncated, full: !truncated }));
    }
    return out;
  }

  return rank.slice(0, settings.topK).map(r => asItem(r));
}

/* ==========================================================================
 * 画像 / 情绪 / 台词 / 德拉科 / 认知
 * ========================================================================== */
/* 主交互对象判定：德拉科在场且被提及/指代时优先锁定 */
function pickMainChar(sd, userText, presentIds) {
  const present = presentIds || Object.keys(sd?.当前场景?.在场角色 || {});
  if (!present.length) return null;
  const text = String(userText || '');
  // ① 德拉科在场 + 玩家提到他或用「他/你」指代 → 锁定
  if (present.includes(DRACO) && /德拉科|马尔福|他|你/.test(text)) return DRACO;
  // ② 玩家直接点名某个在场角色
  const named = present.find(id => {
    const nm = sd?.NPC档案?.[id]?.姓名;
    return nm && nm.length > 1 && text.includes(nm);
  });
  if (named) return named;
  // ③ 德拉科在场但没点名 → 仍优先
  if (present.includes(DRACO)) return DRACO;
  // ④ 兜底：第一个在场
  return present[0];
}

function npcSnapshot(sd, id) {
  const n = sd?.NPC档案?.[id] || {};
  const t = tierOf(sd, id);
  return {
    id, name: n.姓名 || id, tier: t.tier, aff: t.aff, tierSrc: t.src,
    mood: n.当前情绪 || '', attitude: n.对主角态度 || '',
    goal: n.当前目标 || '', prep: n.当前目标 || '', predict: '',
    action: n.状态 || '', relation: n.与主角关系 || '',
    inner: n.内心想法 || '', pos: n.位置 || '', identity: n.身份 || '',
  };
}

async function inferMood(sd, id, userText, scene, prev, memory) {
  const snap = npcSnapshot(sd, id);
  const api = promptApi('mood');
  const vars = JSON.stringify({
    姓名: snap.name, 身份: snap.identity, 与主角关系: snap.relation,
    对主角态度: snap.attitude, 当前情绪: snap.mood, 好感度: snap.aff,
    档位: snap.tier, 当前目标: snap.goal, 状态: snap.action, 内心想法: snap.inner,
  }, null, 1);
  if (!api) return { mood: snap.mood, tier: snap.tier, predict: '', prep: snap.goal, src: '变量直读' };
  try {
    const out = await withRetry(() => llm(fill(promptText('mood'), {
      vars, scene: (scene || '').slice(0, 1200), input: userText.slice(0, 400),
      prev: (prev || '').slice(-3000), memory: (memory || '').slice(-2600) || '（无）',
    }), api, { max: 600 }), '情绪推断');
    const j = JSON.parse((out.match(/\{[\s\S]*\}/) || [])[0] || '{}');
    return {
      mood: j.当前情绪 || snap.mood, tier: j.态度档位 || snap.tier,
      predict: j.预测动作 || '', prep: j.准备动作 || snap.goal, src: 'LLM',
    };
  } catch (e) {
    console.warn('[HP-DeepLore] 情绪推断失败，退回变量直读：', e.message);
    return { mood: snap.mood, tier: snap.tier, predict: '', prep: snap.goal, src: '变量直读(降级)' };
  }
}

async function tuneLines(snap, moodInfo, userText, scene, prev, memory) {
  const api = promptApi('lines');
  if (!api) return [];
  const alias = (await idbGet(STORE.alias, 'main')) || {};
  const bag = alias[snap.id]?.lines || [];
  if (!bag.length) return [];
  const refs = bag.slice(0, 12).map(x => '· ' + x).join('\n');
  try {
    const out = await withRetry(() => llm(fill(promptText('lines'), {
      name: snap.name, tier: moodInfo.tier || snap.tier, mood: moodInfo.mood || snap.mood,
      scene: (scene || '').slice(0, 800), input: userText.slice(0, 400), refs, n: settings.lineCount,
      prev: (prev || '').slice(-2000), memory: (memory || '').slice(-1800) || '（无）',
    }), api, { max: 600, temp: 0.7 }), '台词微调');
    return out.split('\n').map(x => x.trim()).filter(Boolean).map(x => {
      const [en, cn] = x.split('||');
      return { en: (en || '').trim(), cn: (cn || '').trim() };
    }).filter(x => x.en || x.cn).slice(0, settings.lineCount);
  } catch (e) {
    console.warn('[HP-DeepLore] 台词微调失败：', e.message);
    return [];
  }
}

async function dracoDetail(sd, userText, scene, grade, prev, memory) {
  const api = promptApi('draco');
  const snap = npcSnapshot(sd, DRACO);
  if (!api) return { ...snap, predict: '', prep: snap.goal, stage: '', jealous: '', src: '变量直读' };
  const vars = JSON.stringify({
    好感度: snap.aff, 档位: snap.tier, 与主角关系: snap.relation,
    对主角态度: snap.attitude, 当前情绪: snap.mood, 当前目标: snap.goal,
    状态: snap.action, 内心想法: snap.inner, 位置: snap.pos,
  }, null, 1);
  try {
    const out = await withRetry(() => llm(fill(promptText('draco'), {
      vars, scene: (scene || '').slice(0, 1200), input: userText.slice(0, 400),
      stage: `${LABEL_MAP[grade] || grade}（原著${ORIG_MAP[grade] || ''}）`,
      prev: (prev || '').slice(-3000), memory: (memory || '').slice(-2600) || '（无）',
    }), api, { max: 700 }), '德拉科细化');
    const j = JSON.parse((out.match(/\{[\s\S]*\}/) || [])[0] || '{}');
    return {
      ...snap,
      mood: j.当前情绪 || snap.mood, attitude: j.对主角态度 || snap.attitude,
      predict: j.预测动作 || '', prep: j.准备动作 || snap.goal,
      stage: j.阶段状态 || '', jealous: j.吃醋风险 || '', src: 'LLM',
    };
  } catch (e) {
    console.warn('[HP-DeepLore] 德拉科细化失败：', e.message);
    return { ...snap, predict: '', prep: snap.goal, stage: '', jealous: '', src: '变量直读(降级)' };
  }
}

async function cognitionCheck(name, content, sd, id) {
  if (!settings.cognitionCheck) return { text: content, note: '' };
  const api = promptApi('cognition');
  if (!api) return { text: content, note: '（未配置 LLM，仅规则轨：已剔除未来块与作者视角）' };
  try {
    const out = await withRetry(() => llm(
      `【角色】${name}（${id}）\n【他此刻是否在场】${(sd?.当前场景?.在场角色 || {})[id] ? '在场' : '不在场'}\n\n【待审查内容】\n${content}\n\n` +
      promptText('cognition'), api, { max: 1200, temp: 0.2 }), '认知边界');
    const m = /改动：/.exec(out);
    if (m) return { text: out.slice(0, m.index).trim(), note: out.slice(m.index).trim() };
    return { text: out.trim(), note: '' };
  } catch (e) {
    console.warn('[HP-DeepLore] 认知审查失败：', e.message);
    return { text: content, note: '审查失败，已原样注入（建议检查 API）' };
  }
}

async function rewriteQuery(userText, sd, grade) {
  if (userText.length < settings.minQueryLen) {
    const names = Object.keys(sd?.当前场景?.在场角色 || {})
      .map(id => sd?.NPC档案?.[id]?.姓名).filter(Boolean).join(' ');
    return `${LABEL_MAP[grade] || grade} ${names} ${sd?.世界?.当前地点 || ''}`.trim();
  }
  const api = promptApi('query');
  if (!api) return userText;
  try {
    const out = await withRetry(() => llm(fill(promptText('query'), { input: userText.slice(0, 400) }), api, { max: 60, temp: 0.2 }), '查询改写');
    return out.split('\n')[0].trim().slice(0, 60) || userText;
  } catch (e) { return userText; }
}


/* ==========================================================================
 * 缓存 / 冲突检测 / 组装 / 渲染
 * ========================================================================== */
function cacheKey(userText, sd, grade) {
  const present = Object.keys(sd?.当前场景?.在场角色 || {}).sort().join(',');
  return `${grade}|${present}|${userText.slice(0, 60)}`;
}
async function cacheGet(key) {
  if (!settings.cacheEnabled) return null;
  const c = await idbGet(STORE.cache, key);
  if (!c) return null;
  if (Date.now() - c.at > settings.cacheTTL) { await idbDel(STORE.cache, key); return null; }
  return c.val;
}
async function cachePut(key, val) {
  if (!settings.cacheEnabled) return;
  await idbSet(STORE.cache, key, { at: Date.now(), val });
}
async function cacheFind(key, userText) {
  if (!settings.cacheEnabled) return null;
  const keys = await idbKeys(STORE.cache);
  for (const k of keys) {
    const base = k.split('|').slice(0, 2).join('|');
    if (base === key.split('|').slice(0, 2).join('|') && jaccard(k, key) >= settings.cacheSim) {
      const c = await idbGet(STORE.cache, k);
      if (c && Date.now() - c.at <= settings.cacheTTL) return c.val;
    }
  }
  return null;
}

/* 剧情冲突检测 */
function detectConflicts(sd, sources) {
  if (!settings.conflictCheck) return [];
  const out = [];
  const nowDate = String(sd?.世界?.当前时间 || '').slice(0, 10);
  const present = Object.keys(sd?.当前场景?.在场角色 || {});
  for (const id of present) {
    const n = sd?.NPC档案?.[id] || {};
    if (n.生存状态 && /死亡/.test(n.生存状态)) {
      out.push(`变量显示「${n.姓名 || id}」已死亡，但仍在场集合中`);
    }
  }
  for (const s of sources) {
    if (s.date && nowDate && s.date > nowDate) out.push(`检索到第 ${s.chapter} 章（${s.date}）晚于当前时间 ${nowDate}`);
  }
  return out;
}

/* ---- 主流程 ---- */
async function buildLore(userText, sd, onStep) {
  const step = onStep || (() => {});
  const grade = currentGrade(sd);
  step(2, 5);

  const present = Object.keys(sd?.当前场景?.在场角色 || {});
  const away = Object.keys(sd?.当前场景?.离场关注 || {});

  const mainId = pickMainChar(sd, userText, present);

  const scene = await pickScene(sd, grade);

  // 【v1.17】读取上一轮及更早的正文。这是情绪/预测动作/准备动作的因果来源。
  const hist = recentContext();
  const prev = hist.text || '（无历史正文）';

  // 【v1.21】永久记忆必须先于情绪/台词/德拉科召回。
  // 此前它与其他三路并行，结果那三路拿到的永远是 null——记忆接进来了却没人用得上。
  // 现在先单独取回（失败返回 null，不拖垮管线），再喂给下面三处。
  const memItems = settings.memEnabled ? await memRetrieve(userText, sd, grade) : null;
  const memPlain = memItems ? memToPlain(memItems) : '';
  step(3, 5);   // 记忆召回完成

  // 并行：检索 / 主对象情绪 / 德拉科细化 / 其他在场精简
  const [sources, mainMood, draco] = await Promise.all([
    (async () => {
      const q = await rewriteQuery(userText, sd, grade);
      return retrieve(q, grade, sd, { charId: mainId });
    })(),
    mainId ? inferMood(sd, mainId, userText, scene, prev, memPlain) : null,
    (settings.dracoDetail && (present.includes(DRACO) || (settings.dracoOffstageKeepPrep && away.includes(DRACO))))
      ? dracoDetail(sd, userText, scene, grade, prev, memPlain) : null,
  ]);
  step(4, 5);

  // 【v1.16】POV 二次过滤（默认关）：剥离斯科皮的言行句，避免替 {{user}} 预设操作与发言
  let povRemoved = 0;
  if (settings.povFilter && Array.isArray(sources)) {
    for (const src of sources) {
      if (!src.text) continue;
      const r = povStrip(src.text);
      src.text = r.text;
      src.pov = r.removed;
      povRemoved += r.removed;
    }
  }

  const mainSnap = mainId ? npcSnapshot(sd, mainId) : null;
  if (mainMood && mainSnap) {
    mainSnap.mood = mainMood.mood || mainSnap.mood;
    mainSnap.tier = mainMood.tier || mainSnap.tier;
    mainSnap.predict = mainMood.predict || '';
    mainSnap.prep = mainMood.prep || mainSnap.goal;
    mainSnap.moodSrc = mainMood.src;
  }

  // 台词微调（依赖玩家这句话）
  const lines = mainSnap ? await tuneLines(mainSnap, mainMood || {}, userText, scene, prev, memPlain) : [];

  // 其他在场角色：精简版
  const others = [];
  const rest = present.filter(id => id !== mainId && id !== DRACO).slice(0, Math.max(0, settings.maxChars - 1));
  for (const id of rest) {
    const s = npcSnapshot(sd, id);
    others.push({ id, name: s.name, tier: s.tier, aff: s.aff, mood: s.mood, attitude: s.attitude, action: s.action });
  }

  // 离场德拉科：只留准备动作
  let dracoAway = null;
  if (settings.dracoOffstageKeepPrep && !present.includes(DRACO) && away.includes(DRACO)) {
    const s = draco || npcSnapshot(sd, DRACO);
    dracoAway = { name: s.name || '德拉科·马尔福', prep: s.prep || s.goal || '', stage: s.stage || '' };
  }

  step(4, 4);

  // 认知边界审查
  let cognition = '';
  if (settings.cognitionCheck && mainSnap) {
    const blob = sources.map(s => `【第${s.chapter}章 ${s.date}】${s.text}`).join('\n') +
      (lines.length ? '\n台词参考：\n' + lines.map(l => l.en + ' || ' + l.cn).join('\n') : '');
    const r = await cognitionCheck(mainSnap.name, blob.slice(0, 4000), sd, mainId);
    cognition = r.note || '';
    if (settings.cognitionMode === 'rewrite' && r.text) {
      // 用审查后文本覆盖（按章切回）
      const cleaned = r.text;
      for (const s of sources) {
        const m = new RegExp(`【第${s.chapter}章[^】]*】([\\s\\S]*?)(?=【第|$)`, '').exec(cleaned);
        if (m && m[1] && m[1].trim()) s.text = m[1].trim().slice(0, 800);
      }
    }
  }

  const conflicts = detectConflicts(sd, sources);

  return {
    grade, main: mainSnap, draco, dracoAway, others, lines,
    sources, cognition, conflicts, scene, povRemoved,
    mem: memItems || [],
    present: present.length, away: away.length,
  };
}

async function pickScene(sd, grade) {
  const idx = await idbGet(STORE.index, 'main');
  if (!idx?.chunks?.length) return '';
  const nowDate = String(sd?.世界?.当前时间 || '9999-12-31').slice(0, 10);
  const pool = idx.chunks.filter(c => c.grade === grade && (!c.date || c.date <= nowDate));
  if (!pool.length) return '';
  const ev = Object.values(sd?.当前场景?.当前事件 || {}).join(' ');
  const loc = sd?.世界?.当前地点 || '';
  const q = `${loc} ${ev}`.trim();
  const scored = pool.map(c => ({ c, s: q ? jaccard(q, c.text) : 0 }));
  scored.sort((a, b) => b.s - a.s);
  return scored[0]?.c?.text?.slice(0, 1200) || '';
}

/* ---- token 估算与裁剪 ---- */
function estTok(s) { return Math.ceil(String(s).length / 1.6); }
function trimToBudget(lore) {
  let used = 0;
  const keep = { sources: [], lines: [], others: [] };
  const B = settings.tokenBudget;
  for (const s of lore.sources) {
    const t = estTok(s.text);
    if (used + t > B * 0.5) break;
    keep.sources.push(s); used += t;
  }
  for (const l of lore.lines) {
    const t = estTok((l.en || '') + (l.cn || ''));
    if (used + t > B * 0.75) break;
    keep.lines.push(l); used += t;
  }
  for (const o of lore.others) {
    const t = estTok(JSON.stringify(o));
    if (used + t > B) break;
    keep.others.push(o); used += t;
  }
  return { ...lore, sources: keep.sources, lines: keep.lines, others: keep.others, tok: used };
}

/* ---- 渲染 ---- */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function renderLore(l) {
  const g = LABEL_MAP[l.grade] || l.grade;
  const o = ORIG_MAP[l.grade] ? `（原著${ORIG_MAP[l.grade]}）` : '';
  let h = `<div class="hp-lore-card${settings.collapseByDefault ? '' : ' open'}">`;
  h += `<div class="hp-lore-head"><span class="hp-ic">◈</span><span class="hp-tt">本轮注入</span>`;
  const sm = [`${g}${o}`];
  if (l.main) sm.push(`${l.main.name} · ${l.main.tier}`);
  if (l.draco) sm.push('德拉科细化');
  sm.push(`检索 ${l.sources.length} 段`);
  if (l.mem?.length) sm.push(`记忆 ${l.mem.length} 条`);
  if (l.tok) sm.push(`${l.tok} tok`);
  h += `<span class="hp-sm">${escapeHtml(sm.join(' · '))}</span>`;
  if (settings.showCognitionBadge && settings.cognitionCheck) h += `<span class="hp-badge">已审查</span>`;
  if (l.conflicts?.length) h += `<span class="hp-badge warn">冲突 ${l.conflicts.length}</span>`;
  h += `<span class="hp-arw">▶</span></div><div class="hp-lore-body">`;

  if (l.sources.length) {
    h += `<div class="hp-sec"><h4>检索原文</h4>`;
    for (const s of l.sources) {
      const capTag = s.blocks
        ? `<span class="hp-tag${s.truncated ? ' warn' : ''}">${s.truncated ? `整章 ${s.blocks} 块·已截断` : `整章 ${s.blocks} 块·完整`}</span>`
        : '';
      const povTag = s.pov ? `<span class="hp-tag">POV 剔 ${s.pov} 句</span>` : '';
      h += `<div class="hp-src"><div class="hp-mt"><span class="hp-ch">第 ${s.chapter} 章</span>`
        + `<span>${escapeHtml(s.date || '—')}</span>`
        + `<span class="hp-tag ${s.lived ? 'live' : 'hist'}">${s.lived ? '已亲历' : '世界历史'}</span>`
        + `<span class="hp-tag">${escapeHtml(LABEL_MAP[s.grade] || s.grade)}</span>`
        + capTag
        + povTag
        + `<span class="hp-sc">相关度 ${escapeHtml(s.score)}${s.rr && Number(s.rr) ? ' · 精排 ' + escapeHtml(s.rr) : ''}</span></div>`
        + `<div class="hp-qt">${escapeHtml(s.text)}</div></div>`;
    }
    h += `</div>`;
  }

  if (l.main) {
    const p = l.main;
    const pct = Math.max(0, Math.min(100, Math.round((Number(p.aff) + 100) / 2)));
    h += `<div class="hp-sec"><h4>角色 · ${escapeHtml(p.name)}<span style="font-weight:400;color:var(--hp-tx3)"> · 主交互</span></h4><div class="hp-pc">`
      + `<div class="hp-hd"><span class="hp-nm">${escapeHtml(p.name)}</span>`
      + `<span class="hp-st">${escapeHtml(p.tier)}</span>`
      + `<div class="hp-gbar"><i style="width:${pct}%"></i></div>`
      + `<span class="hp-st">${escapeHtml(p.aff)}</span></div><dl class="hp-kv">`;
    if (p.mood) h += `<dt>当前情绪</dt><dd>${escapeHtml(p.mood)}</dd>`;
    if (p.attitude) h += `<dt>对主角</dt><dd>${escapeHtml(p.attitude)}</dd>`;
    if (p.predict) h += `<dt>预测动作</dt><dd>${escapeHtml(p.predict)}</dd>`;
    if (p.prep) h += `<dt>准备动作</dt><dd>${escapeHtml(p.prep)}</dd>`;
    if (p.relation) h += `<dt>关系</dt><dd>${escapeHtml(p.relation)}</dd>`;
    h += `</dl>`;
    if (l.lines.length) {
      h += `<div class="hp-lines">`;
      for (const ln of l.lines) {
        h += `<div class="hp-ln"><div class="hp-en">${escapeHtml(ln.en)}</div>`
          + (ln.cn ? `<div class="hp-cn">${escapeHtml(ln.cn)}</div>` : '') + `</div>`;
      }
      h += `<div class="hp-note">以上仅示意语气与味道，禁止照搬原句${settings.aiTranslateLines ? '；英文由 AI 按卡的规范自行转换' : ''}</div></div>`;
    }
    h += `</div></div>`;
  }

  if (l.draco) {
    const d = l.draco;
    h += `<div class="hp-sec"><h4>德拉科 · 细化</h4><div class="hp-pc">`
      + `<div class="hp-hd"><span class="hp-nm">${escapeHtml(d.name || '德拉科·马尔福')}</span>`
      + `<span class="hp-st">${escapeHtml(d.tier || '')}</span>`
      + `<div class="hp-gbar"><i style="width:${Math.max(0, Math.min(100, Math.round((Number(d.aff) + 100) / 2)))}%"></i></div>`
      + `<span class="hp-st">${escapeHtml(d.aff ?? '')}</span></div><dl class="hp-kv">`;
    if (d.mood) h += `<dt>当前情绪</dt><dd>${escapeHtml(d.mood)}</dd>`;
    if (d.attitude) h += `<dt>对主角</dt><dd>${escapeHtml(d.attitude)}</dd>`;
    if (d.stage) h += `<dt>阶段状态</dt><dd>${escapeHtml(d.stage)}</dd>`;
    if (d.predict) h += `<dt>预测动作</dt><dd>${escapeHtml(d.predict)}</dd>`;
    if (d.prep) h += `<dt>准备动作</dt><dd>${escapeHtml(d.prep)}</dd>`;
    if (d.jealous) h += `<dt>吃醋风险</dt><dd>${escapeHtml(d.jealous)}</dd>`;
    h += `</dl></div></div>`;
  }

  if (l.dracoAway) {
    h += `<div class="hp-sec"><h4>德拉科 · 离场</h4><div class="hp-pc"><dl class="hp-kv">`
      + `<dt>准备动作</dt><dd>${escapeHtml(l.dracoAway.prep || '（无）')}</dd>`
      + (l.dracoAway.stage ? `<dt>阶段状态</dt><dd>${escapeHtml(l.dracoAway.stage)}</dd>` : '')
      + `</dl><div class="hp-note">离场仅保留准备动作，不含情绪与台词</div></div></div>`;
  }

  if (l.others.length) {
    h += `<div class="hp-sec"><h4>其他在场</h4>`;
    for (const o of l.others) {
      h += `<div class="hp-minirow"><span class="hp-nm2">${escapeHtml(o.name)}</span>`
        + `<span class="hp-st">${escapeHtml(o.tier)} ${escapeHtml(o.aff)}</span>`
        + (o.mood ? `<span class="hp-mood">${escapeHtml(o.mood)}</span>` : '') + `</div>`;
    }
    h += `</div>`;
  }

  if (l.cognition) h += `<div class="hp-sec"><h4>认知边界审查</h4><div class="hp-warn">${escapeHtml(l.cognition)}</div></div>`;
  /* 【v1.18】永久记忆：卡片里也展示，便于确认召回的对不对 */
  if (l.mem?.length) {
    h += `<div class="hp-sec"><h4>长期记忆<small style="font-weight:400;color:var(--hp-tx3)"> · ${l.mem.length} 条</small></h4>`;
    for (const m of l.mem.slice(0, 12)) {
      const rc = m.reaction === 'cynicism' ? '<span class="hp-tag warn">讽刺性回忆</span>'
        : m.reaction === 'emotional_hurt' ? '<span class="hp-tag live">带情绪的回忆</span>' : '';
      h += `<div class="hp-memitem"><div class="hp-mt"><span class="hp-ch">${escapeHtml(m.ago || '—')}</span>`
        + `<span>${escapeHtml(m.game_time || '')}</span>`
        + `<span class="hp-tag">${escapeHtml(m.bucket || '')}</span>${rc}`
        + `<span class="hp-sc">${escapeHtml(String(m.score ?? ''))}</span></div>`
        + `<div class="hp-qt">${escapeHtml(m.text || '')}</div></div>`;
    }
    if (l.mem.length > 12) h += `<div class="hp-hint">其余 ${l.mem.length - 12} 条已注入，此处省略显示</div>`;
    h += `</div>`;
  }
  if (l.conflicts?.length) {
    h += `<div class="hp-sec"><h4>冲突检测</h4><div class="hp-warn"><b>发现 ${l.conflicts.length} 处</b><br>${l.conflicts.map(escapeHtml).join('<br>')}</div></div>`;
  }
  h += `</div></div>`;
  return h;
}

function loreToPlain(l) {
  const g = LABEL_MAP[l.grade] || l.grade;
  let t = `【HP DeepLore 参考素材｜${g}${ORIG_MAP[l.grade] ? '（原著' + ORIG_MAP[l.grade] + '）' : ''}】\n`;
  t += '（以下为候参考文献，不是待执行清单。是否发生、由谁推动、{{user}} 说什么做什么，全部由 {{user}} 决定。\n';
  t += '条目中以斯科皮为主语的一切记述仅为参考，不是台词稿，{{user}} 不必复述或复现。）\n';
  if (l.sources.length) {
    t += '\n■ 相关原文（已剔除未来章节与作者视角）\n';
    for (const s of l.sources) {
      const cap = s.blocks ? (s.truncated ? `整章${s.blocks}块·已截断` : `整章${s.blocks}块·完整`) : '块';
      const pv = s.pov ? `｜POV剔${s.pov}句` : '';
      t += `· [第${s.chapter}章 ${s.date}｜${s.lived ? '已亲历' : '世界历史·非亲历'}｜${cap}${pv}] ${s.text}\n`;
    }
  }
  if (l.main) {
    t += `\n■ ${l.main.name}（主交互）\n`;
    if (l.main.mood) t += `· 当前情绪：${l.main.mood}\n`;
    if (l.main.attitude) t += `· 对主角：${l.main.attitude}\n`;
    if (l.main.predict) t += `· 预测动作：${l.main.predict}\n`;
    if (l.main.prep) t += `· 准备动作：${l.main.prep}\n`;
    if (l.main.relation) t += `· 关系：${l.main.relation}\n`;
  }
  if (l.lines.length) {
    t += '\n■ 台词参考（仅供语气与味道，禁止照搬）\n';
    for (const ln of l.lines) t += `· ${ln.en}${ln.cn ? ' （' + ln.cn + '）' : ''}\n`;
  }
  if (l.draco) {
    const d = l.draco;
    t += '\n■ 德拉科·马尔福（细化）\n';
    if (d.mood) t += `· 当前情绪：${d.mood}\n`;
    if (d.attitude) t += `· 对主角：${d.attitude}\n`;
    if (d.stage) t += `· 阶段状态：${d.stage}\n`;
    if (d.predict) t += `· 预测动作：${d.predict}\n`;
    if (d.prep) t += `· 准备动作：${d.prep}\n`;
    if (d.jealous) t += `· 吃醋风险：${d.jealous}\n`;
  }
  if (l.dracoAway) t += `\n■ 德拉科·马尔福（离场）\n· 准备动作：${l.dracoAway.prep || '（无）'}\n`;
  if (l.others.length) {
    t += '\n■ 其他在场（精简）\n';
    for (const o of l.others) t += `· ${o.name}｜${o.tier} ${o.aff}${o.mood ? '｜' + o.mood : ''}\n`;
  }
  if (l.cognition) t += `\n■ 认知边界\n${l.cognition}\n`;
  // 【v1.18】永久记忆：只给事实与情境，不指挥角色怎么用
  if (l.mem?.length) t += memToPlain(l.mem);
  if (l.conflicts?.length) t += `\n■ 冲突提醒\n${l.conflicts.join('\n')}\n`;
  t += '\n【结束】\n';
  return t;
}


/* ==========================================================================
 * 拦截发送
 * ========================================================================== */
let pipelineToken = 0;
let busy = false;
let lastLore = null;
let lastUserText = '';

function lockInput(on) {
  const ta = document.getElementById('send_textarea');
  const btn = document.getElementById('send_but');
  if (ta) { ta.disabled = on; ta.style.opacity = on ? .55 : 1; }
  if (btn) btn.disabled = on;
}
function showScan(n, total) {
  let el = document.getElementById('hp-scan');
  if (!el) {
    // 【v1.22】挂到 <html> 而不是输入框里：
    // 插在输入框父元素最前面时，手机端会被顶出视口顶部，根本看不见。
    // 挂 html 也顺便避开 body 上的 transform 让 fixed 失效的老问题。
    el = document.createElement('div');
    el.id = 'hp-scan';
    document.documentElement.appendChild(el);
  }
  const place = () => {
    const vv = window.visualViewport || window;
    const W = vv.width || innerWidth, H = vv.height || innerHeight;
    const w = Math.min(W - 24, 430);
    el.style.position = 'fixed';
    el.style.zIndex = '9998';
    el.style.left = Math.round((W - w) / 2) + 'px';
    el.style.width = w + 'px';
    // 垂直居中略偏上，避免被底部输入框与键盘顶掉
    const h = el.offsetHeight || 74;
    el.style.top = Math.max(8, Math.round(H / 2 - h / 2 - 30)) + 'px';
  };
  const steps = ['读取变量', '并行检索', '召回记忆', '推断与审查', '组装注入'];
  el.innerHTML = `<div class="hp-scan${n < total ? ' scanning' : ''}">
    <div class="hp-scan-in"><span class="hp-ic">◈</span> 分析中… ${n}/${total}
      <div class="hp-steps">${steps.map((s, i) =>
    `<span class="hp-stp ${i < n ? 'dn' : i === n ? 'on' : ''}">${s}</span>`).join('')}</div>
      <span class="hp-skip" id="hp-skip">跳过</span></div></div>`;
  const sk = el.querySelector('#hp-skip');
  if (sk) sk.onclick = () => {
    pipelineToken++; busy = false; lockInput(false); removeScan();
    // 【v1.22】跳过 = 不注入但照样把这条消息发出去，不再卡住
    window.__hp_skip = true;
    releaseSend();
  };
  place();
  requestAnimationFrame(place);
}
function removeScan() { document.getElementById('hp-scan')?.remove(); }

function shouldSkip(text) {
  if (!settings.enabled || !settings.intercept) return true;
  const t = (text || '').trim();
  if (!t) return true;
  if (t.startsWith('/')) return true;
  if (/^[（(\[【{]/.test(t) && /[）)\]】}]$/.test(t)) return true;
  return false;
}

/* 【v1.22】放行开关。
   旧逻辑的致命缺陷：管线跑完后直接 btn.click()，而 btn 的监听器又把这条点击当成
   "新的一次发送" → 再次 doSend → 再跑一遍管线 → 再 click……
   表现就是步骤条在 2 和 4 之间反复跳，永远到不了注入面；
   点「跳过本次」后更是直接死循环，消息彻底发不出去。
   现在：管线结束后置 passThrough，让这一次 click 原样放行给酒馆，不再重新分析。 */
let passThrough = false;
let passTimer = null;
function releaseSend() {
  const btn = document.getElementById('send_but');
  if (window.__hp_abort) { window.__hp_abort = false; return; }  // 被 Esc 中止过，不放行
  if (passThrough) return;   // 上一次放行还没被消费，绝不重复点击（否则会递归触发管线）
  passThrough = true;
  clearTimeout(passTimer);
  passTimer = setTimeout(() => { passThrough = false; }, 1500); // 兜底：没被消费就自动复位
  try { btn?.click(); } catch (e) { /* 忽略 */ }
}

async function runPipeline(text) {
  const my = ++pipelineToken;
  busy = true; lockInput(true); showScan(1, 5);
  window.__hp_skip = false;
  try {
    const sd = getStatData();
    if (!sd || !Object.keys(sd).length) {
      console.warn('[HP-DeepLore] 未读到 MVU 变量，降级为最小注入');
    }
    const ck = cacheKey(text, sd, currentGrade(sd));
    let lore = await cacheFind(ck, text);
    if (lore) { lore.cached = true; }
    else {
      lore = await buildLore(text, sd, (n, t) => { if (my === pipelineToken) showScan(n, t); });
      lore = trimToBudget(lore);
      await cachePut(ck + '|' + Date.now(), lore);
    }
    if (my !== pipelineToken) return null;
    lastLore = lore; lastUserText = text;
    showScan(5, 5);
    if (settings.previewBeforeInject) {
      const ok = await showPreview(lore);
      if (!ok) {
        // 跳过本次：只是不注入，消息照常发出去
        removeScan();
        window.__hp_skip = true;
        return null;
      }
    }
    window.__hp_lore = lore;
    window.__hp_lore_html = renderLore(lore);
    // 【v1.15】记录本轮注入内容，供「调试」面板做效果对比
    try {
      logInject({
        grade: lore.grade,
        chars: (lore.sources || []).length,
        tokens: lore.tok || 0,
        chapters: (lore.sources || []).map(x => x.chapter),
        blocks: (lore.sources || []).map(x => x.blocks || 0),
        truncated: (lore.sources || []).filter(x => x.truncated).length,
        lived: (lore.sources || []).filter(x => x.lived).length,
        main: lore.main ? lore.main.name : null,
        draco: !!lore.draco,
        lines: (lore.lines || []).length,
        sources: (lore.sources || []).map(x => ({ chapter: x.chapter, text: x.text })),
      });
    } catch (e) { /* 忽略 */ }
    return lore;
  } catch (e) {
    console.error('[HP-DeepLore] 管线失败：', e);
    toast('管线失败，本轮不注入素材（可直接发送）：' + (e?.message || e), 'err');
    return null;
  } finally {
    busy = false; lockInput(false); removeScan();
  }
}

function showPreview(lore) {
  return new Promise(res => {
    const box = document.createElement('div');
    box.className = 'hp-preview-mask';
    box.innerHTML = `<div class="hp-preview"><h3>注入预览</h3>
      <div class="hp-preview-body">${renderLore({ ...lore, collapseByDefault: false })}</div>
      <div class="hp-preview-btns">
        <button class="hp-btn p" data-a="ok">确认注入</button>
        <button class="hp-btn" data-a="no">跳过本次</button>
      </div></div>`;
    box.querySelector('.hp-lore-card')?.classList.add('open');
    document.documentElement.appendChild(box);
    // 【v1.22】JS 写死尺寸位置：挂 body 时若被 transform 影响，fixed 会失效、弹层跑到屏幕外
    const place = () => {
      const vv = window.visualViewport || window;
      const W = vv.width || innerWidth, H = vv.height || innerHeight;
      box.style.position = 'fixed';
      box.style.left = '0'; box.style.top = '0';
      box.style.width = W + 'px'; box.style.height = H + 'px';
      box.style.zIndex = '9999';
      const card = box.querySelector('.hp-preview');
      if (card) card.style.maxHeight = Math.round(H * 0.82) + 'px';
    };
    place();
    requestAnimationFrame(place);
    addEventListener('resize', place, { passive: true });
    box.querySelector('[data-a=ok]').onclick = () => { box.remove(); res(true); };
    box.querySelector('[data-a=no]').onclick = () => { box.remove(); res(false); };
    box.addEventListener('mousedown', e => { if (e.target === box) { box.remove(); res(false); } });
  });
}

function hookSend() {
  const bind = () => {
    const ta = document.getElementById('send_textarea');
    const btn = document.getElementById('send_but');
    if (!ta) return false;
    if (ta.dataset.hpHooked) return true;
    ta.dataset.hpHooked = '1';

    const doSend = () => {
      if (passThrough) { passThrough = false; clearTimeout(passTimer); return true; }
      const text = ta.value || '';
      if (shouldSkip(text)) return true;
      window.__hp_pending = true;
      runPipeline(text).finally(() => {
        window.__hp_pending = false;
        // 确认注入 / 跳过本次 / 管线失败 —— 三种情况都放行原消息，绝不卡住
        releaseSend();
      });
      return false;
    };
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (busy) { e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (!doSend()) { e.preventDefault(); e.stopImmediatePropagation(); }
      }
      if (e.key === 'Escape' && busy) {
        pipelineToken++; busy = false; lockInput(false); removeScan();
        window.__hp_abort = true;   // 【v1.22】主动中止 ≠ 放行，消息不发出
        e.preventDefault();
      }
    }, true);
    btn?.addEventListener('click', e => {
      if (busy || window.__hp_pending) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (!doSend()) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    return true;
  };
  if (!bind()) {
    const t = setInterval(() => { if (bind()) clearInterval(t); }, 400);
    setTimeout(() => clearInterval(t), 30000);
  }
}

/* ==========================================================================
 * 注入 Generate（position 0 / depth 0）
 * ========================================================================== */
function injectNow() {
  // 若本轮管线尚未跑完（如重生成、冷启动），复用上一轮结果，避免空注入
  const lore = window.__hp_lore || lastLore;
  if (!lore) return;
  if (!window.__hp_lore_html) window.__hp_lore_html = renderLore(lore);
  const plain = loreToPlain(lore);
  let done = false;
  try {
    const ctx = stGetContext();
    if (typeof ctx.setExtensionPrompt === 'function') {
      ctx.setExtensionPrompt(EXT_ID, plain, 0, 0, true, true);
      done = true;
    }
  } catch (e) { /* 忽略 */ }
  if (!done) {
    try {
      const ctx = stGetContext();
      ctx.extensionPrompts = ctx.extensionPrompts || {};
      ctx.extensionPrompts[EXT_ID] = { value: plain, position: 0, depth: 0, scan: true, enabled: true };
    } catch (e) { /* 忽略 */ }
  }
}
function clearInject() {
  try { stGetContext()?.setExtensionPrompt?.(EXT_ID, '', 0, 0, true, true); } catch (e) { /* 忽略 */ }
  window.__hp_lore = null;
  window.__hp_lore_html = null;
}

/* 聊天区卡片：把本轮注入渲染到最新一条 AI 消息之上 */
function renderCardIntoChat() {
  const html = window.__hp_lore_html;
  if (!html) return;
  try {
    const host = document.querySelector('#chat .mes.last_mes') || document.querySelector('#chat .mes:last-child');
    if (host) host.insertAdjacentHTML('beforebegin', html);
    bindCardEvents();
  } catch (e) { /* 忽略 */ }
  window.__hp_lore_html = null;
}
function bindCardEvents() {
  document.querySelectorAll('.hp-lore-head').forEach(hd => {
    if (hd.dataset.hpBound) return;
    hd.dataset.hpBound = '1';
    hd.addEventListener('click', () => hd.parentElement.classList.toggle('open'));
  });
  document.querySelectorAll('.hp-ch').forEach(el => {
    if (el.dataset.hpBound) return;
    el.dataset.hpBound = '1';
    el.style.cursor = 'pointer';
    el.title = '点击查看该章原文';
    el.addEventListener('click', async () => {
      const src = el.closest('.hp-src');
      const ch = (src?.querySelector('.hp-ch')?.textContent || '').match(/\d+/)?.[0];
      if (!ch) return;
      await showChapter(Number(ch));
    });
  });
}
async function showChapter(ch) {
  const idx = await idbGet(STORE.index, 'main');
  if (!idx?.chunks) return;
  const parts = idx.chunks.filter(c => c.chapter === ch).map(c => c.text);
  if (!parts.length) return;
  const box = document.createElement('div');
  box.className = 'hp-preview-mask';
  box.innerHTML = `<div class="hp-preview"><h3>第 ${ch} 章 · 原文上下文</h3>
    <div class="hp-preview-body" style="font-size:13px;line-height:1.8;color:var(--hp-tx2);white-space:pre-wrap">${escapeHtml(parts.join('\n').slice(0, 9000))}</div>
    <div class="hp-preview-btns"><button class="hp-btn" data-a="close">关闭</button></div></div>`;
  document.body.appendChild(box);
  box.querySelector('[data-a=close]').onclick = () => box.remove();
}

/* ==========================================================================
 * 侧栏面板
 * ========================================================================== */
async function renderSidebar() {
  const host = document.getElementById('hp_sidebar');
  if (!host) return;
  const sd = getStatData();
  const grade = currentGrade(sd);
  const idx = await idbGet(STORE.index, 'main');
  const done = sd?.世界线?.已结算节点 || {};
  const nodes = (idx?.nodes || []).filter(n => n.grade === grade);
  const doneN = nodes.filter(n => done[n.id]).length;
  const nowDate = String(sd?.世界?.当前时间 || '').slice(0, 10);
  const pct = nodes.length ? Math.round(doneN / nodes.length * 100) : 0;

  let h = `<div class="hp-side">
    <div class="hp-sh">
      <div class="hp-sht">斯科皮 · ${LABEL_MAP[grade] || grade}</div>
      <div class="hp-shs">${ORIG_MAP[grade] ? '原著' + ORIG_MAP[grade] + ' · ' : ''}${nodes.length} 节点</div>
      <div class="hp-pbar"><i style="width:${pct}%"></i></div>
      <div class="hp-pnum"><span>节点进度</span><span><b>${doneN}</b> / ${nodes.length}</span></div>
    </div><div class="hp-nlist">`;

  let curFound = false;
  for (const n of nodes) {
    const locked = n.date && nowDate && n.date > nowDate;
    if (locked && !settings.showLockedNodes) continue;
    const isDone = !!done[n.id];
    const isCur = !isDone && !locked && !curFound;
    if (isCur) curFound = true;
    const cls = isDone ? 'done' : (locked ? 'lock' : (isCur ? 'cur' : ''));
    const mk = isDone ? '✓' : (locked ? '🔒' : (isCur ? '▸' : '○'));
    h += `<div class="hp-ni ${cls}" data-id="${escapeHtml(n.id)}"><span class="hp-mk">${mk}</span>
      <div class="hp-nb"><div class="hp-nt">${escapeHtml(n.title)}</div>
      <div class="hp-nd">${escapeHtml(n.date || '—')}${locked ? ' · 未解锁' : ''}${isCur ? ' · 当前' : ''}</div></div>
      <span class="hp-ck"></span></div>`;
  }
  if (!nodes.length) h += `<div style="padding:14px;text-align:center;font-size:12px;color:var(--hp-tx3)">未建立索引</div>`;
  h += `</div><div class="hp-sf">
    <button class="hp-sbtn p" id="hp-sync">同步变量</button>
    <button class="hp-sbtn" id="hp-jump">跳章</button>
    <button class="hp-sbtn" id="hp-refresh">刷新</button>
  </div></div>`;
  host.innerHTML = h;

  host.querySelectorAll('[data-rd]').forEach(el => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const ch = Number(el.dataset.rd);
      const g = el.dataset.rdg || '';
      const c = await chapterText(ch, g || null);
      if (!c) { toast('未找到该章', 'err'); return; }
      showChapterModal(c);
    };
  });
  host.querySelectorAll('.hp-ni:not(.lock)').forEach(el => {
    el.onclick = async () => {
      const id = el.dataset.id;
      const sd2 = getStatData();
      const cur = !!sd2?.世界线?.已结算节点?.[id];
      const path = `stat_data.世界线.已结算节点.${id}`;
      const res = cur
        ? `_.unset(_.get(variables,'stat_data.世界线.已结算节点'),'${id}'); setvar('stat_data.世界线.已结算节点', _.get(variables,'stat_data.世界线.已结算节点'));`
        : `_.set(variables,'stat_data.世界线.已结算节点.${id}', true); setvar('stat_data.世界线.已结算节点', _.get(variables,'stat_data.世界线.已结算节点'));`;
      try {
        const ctx = stGetContext();
        if (ctx?.variables?.stat_data) {
          if (!ctx.variables.stat_data.世界线) ctx.variables.stat_data.世界线 = {};
          if (!ctx.variables.stat_data.世界线.已结算节点) ctx.variables.stat_data.世界线.已结算节点 = {};
          if (cur) delete ctx.variables.stat_data.世界线.已结算节点[id];
          else ctx.variables.stat_data.世界线.已结算节点[id] = true;
        }
      } catch (e) { /* 忽略 */ }
      try {
        const Mvu = window.Mvu;
        if (Mvu?.setVariable) await Mvu.setVariable(path, !cur);
        else if (window.setvar) window.setvar(path, !cur);
      } catch (e) { /* 忽略 */ }
      el.classList.toggle('done');
      console.log('[HP-DeepLore] 节点标记', id, !cur, res);
    };
  });
  host.querySelector('#hp-sync')?.addEventListener('click', () => renderSidebar());
  host.querySelector('#hp-refresh')?.addEventListener('click', () => renderSidebar());
  host.querySelector('#hp-jump')?.addEventListener('click', async () => {
    const idx2 = await idbGet(STORE.index, 'main');
    const all = idx2?.nodes || [];
    const pick = prompt('跳转到哪一章？（输入章号）\n可用范围：' +
      (all.length ? `${all[0].chapter} ~ ${all[all.length - 1].chapter}` : '无索引'), '');
    const n = Number(pick);
    if (!Number.isFinite(n)) return;
    const nd = all.find(x => x.chapter === n);
    if (!nd) { toast('未找到该章', 'err'); return; }
    toast(`第 ${nd.chapter} 章 · ${nd.date} · ${nd.vol} · ${LABEL_MAP[nd.grade]}`, 'ok');
  });
}




/* --------------------------------------------------------------------------
 * 模型选择器样式：独立注入，避免复用 .hp-modal 被移动端规则污染
 * （v1.11 修复弹层飞出屏幕）
 * -------------------------------------------------------------------------- */
const PICKER_STYLE_ID = 'hp-picker-style';
function ensurePickerStyle() {
  if (document.getElementById(PICKER_STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = PICKER_STYLE_ID;
  st.textContent = `
.hp-picker-mask{
  position:fixed;inset:0;z-index:10050;
  background:rgba(0,0,0,.55);
}
/* 【修 v1.12】不再用 transform 居中：
   1) 宿主页面（SillyTavern 主题）给 body 加了 transform/filter 时，
      position:fixed 的包含块会变成该祖先，left/top:50% 就不再是视口中心；
   2) 移动端 media query 的 !important 会覆盖 inline 的 left/top，
      却覆盖不了 inline transform → 面板先被钉到左上、再往左上平移一半而飞出屏幕。
   现在由 JS 按视口实测尺寸算出精确 px 的 left/top/width/height 并直接写入。 */
.hp-picker{
  position:fixed;
  transform:none;
  display:flex;flex-direction:column;
  background:var(--hp-panel,#151922);
  border:1px solid var(--hp-bd2,#2a3040);
  border-radius:14px;overflow:hidden;
  box-shadow:0 12px 40px rgba(0,0,0,.5);
  box-sizing:border-box;
}
.hp-picker-head{
  display:flex;align-items:center;gap:9px;flex:0 0 auto;
  padding:11px 14px;background:var(--hp-card2,#1b2029);
  border-bottom:1px solid var(--hp-bd,#232936);
}
.hp-picker-ic{color:var(--hp-acc,#4a9d7a);font-size:14px}
.hp-picker-title{font:600 14px Georgia,serif;color:var(--hp-tx,#e6e8ee)}
.hp-picker-count{font-size:11px;color:var(--hp-tx3,#7a8497)}
.hp-picker-sp{flex:1}
.hp-picker-x{
  width:28px;height:28px;line-height:26px;text-align:center;
  border:none;background:transparent;color:var(--hp-tx3,#7a8497);
  font-size:15px;cursor:pointer;border-radius:6px;
}
.hp-picker-x:hover{color:var(--hp-tx,#e6e8ee);background:rgba(255,255,255,.08)}
.hp-picker-body{
  display:flex;flex-direction:column;gap:10px;
  padding:12px 14px;min-height:0;flex:1;
}
.hp-picker-input{
  width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;
  border:1px solid var(--hp-bd2,#2a3040);background:var(--hp-card,#12161d);
  color:var(--hp-tx,#e6e8ee);font-size:13px;font-family:inherit;
}
.hp-picker-input:focus{outline:none;border-color:var(--hp-acc,#4a9d7a)}
.hp-picker-list{
  flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain;
  border:1px solid var(--hp-bd,#232936);border-radius:8px;
  background:var(--hp-card,#12161d);
}
.hp-picker-item{
  padding:9px 12px;font-size:12.5px;cursor:pointer;
  border-bottom:1px solid var(--hp-bd,#232936);color:var(--hp-tx,#e6e8ee);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:.12s;
}
.hp-picker-item:last-child{border-bottom:none}
.hp-picker-item:hover{background:var(--hp-accd,rgba(74,157,122,.12));color:var(--hp-acc,#4a9d7a)}
.hp-picker-item.on{
  background:var(--hp-accd,rgba(74,157,122,.12));color:var(--hp-acc,#4a9d7a);
  font-weight:600;border-left:2px solid var(--hp-acc,#4a9d7a);
}
.hp-picker-foot{display:flex;gap:8px;align-items:center;flex:0 0 auto}
.hp-picker-btn{
  padding:9px 16px;border-radius:8px;cursor:pointer;white-space:nowrap;
  border:1px solid var(--hp-acc,#4a9d7a);background:var(--hp-accd,rgba(74,157,122,.12));
  color:var(--hp-acc,#4a9d7a);font-size:12.5px;font-family:inherit;
}
.hp-picker-empty{padding:14px;color:var(--hp-tx3,#7a8497);font-size:12.5px;text-align:center}

@media (max-width:720px){
  .hp-picker-item{padding:13px 12px;font-size:13.5px}
  .hp-picker-input{font-size:15px;padding:11px}
  .hp-picker-btn{padding:11px 18px;font-size:13.5px}
  .hp-picker-x{width:34px;height:34px;line-height:32px;font-size:17px}
}

@media (prefers-reduced-motion:no-preference){
  .hp-picker{animation:hp-picker-in .15s ease-out}
}
@keyframes hp-picker-in{from{opacity:0}to{opacity:1}}
`;
  document.head.appendChild(st);
}


/* --------------------------------------------------------------------------
 * 弹层精确定位：写入 px 级 left/top/width/height，保证居中且完整可见
 * -------------------------------------------------------------------------- */
function placePicker(box) {
  if (!box) return;
  try {
    const vv = window.visualViewport;
    // 优先用 visualViewport：手机地址栏收放时它才是真实可视区
    const vw = Math.round((vv && vv.width) || window.innerWidth || document.documentElement.clientWidth);
    const vh = Math.round((vv && vv.height) || window.innerHeight || document.documentElement.clientHeight);
    const margin = vw < 560 ? 12 : 16;

    // 先量一次自然高度（未限高时），决定最终高度
    box.style.position = 'fixed';
    box.style.left = '0px';
    box.style.top = '0px';
    box.style.width = Math.min(560, vw - margin * 2) + 'px';
    const natural = box.scrollHeight || box.offsetHeight || 0;

    const maxH = vh - margin * 2;
    const wantH = Math.min(Math.round(vh * 0.82), natural || Math.round(vh * 0.82));
    const h = Math.max(220, Math.min(wantH, maxH));
    const w = Math.min(560, vw - margin * 2);

    let left = Math.round((vw - w) / 2);
    let top = Math.round((vh - h) / 2);
    left = Math.max(margin, Math.min(left, vw - w - margin));
    top = Math.max(margin, Math.min(top, vh - h - margin));

    box.style.width = w + 'px';
    box.style.height = h + 'px';
    box.style.maxWidth = w + 'px';
    box.style.maxHeight = h + 'px';
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.right = 'auto';
    box.style.bottom = 'auto';
    box.style.transform = 'none';

    // 【修 v1.12】收敛补偿：无论 fixed 的包含块被哪个祖先改写，
    // 直接按"实测位置 vs 期望位置"的差值反复校正，最多 3 轮。
    // 这样即使宿主给 html/body/祖先加了 transform、zoom、filter 也能居中。
    for (let k = 0; k < 3; k++) {
      const r = box.getBoundingClientRect();
      const dx = Math.round(r.left - left);
      const dy = Math.round(r.top - top);
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return;
      box.style.left = (left - dx) + 'px';
      box.style.top = (top - dy) + 'px';
    }
    // 仍未对齐 → 退化为 absolute 并再补偿一轮
    box.style.position = 'absolute';
    box.style.left = (left + window.scrollX) + 'px';
    box.style.top = (top + window.scrollY) + 'px';
    for (let k = 0; k < 2; k++) {
      const r = box.getBoundingClientRect();
      const dx = Math.round(r.left - left);
      const dy = Math.round(r.top - top);
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) break;
      box.style.left = (parseFloat(box.style.left || '0') - dx) + 'px';
      box.style.top = (parseFloat(box.style.top || '0') - dy) + 'px';
    }
    console.warn('[HP-DeepLore] fixed 包含块异常，弹层已用 absolute 校正');
  } catch (e) {
    // 兜底：居中即可，不因定位失败而挡住内容
    box.style.position = 'fixed';
    box.style.left = '50%';
    box.style.top = '50%';
    box.style.transform = 'translate(-50%,-50%)';
  }
}

/* --------------------------------------------------------------------------
 * 模型选择器：拉取后弹出可点击列表，点一下即选中（不再手抄模型 ID）
 * -------------------------------------------------------------------------- */
function openModelPicker(list, current, onPick) {
  try {
    const old = document.getElementById('hp-model-picker');
    if (old) old.remove();
    ensurePickerStyle();
    const mask = document.createElement('div');
    // 【修 v1.11】此前复用 .hp-modal / .hp-mask：移动端 media query 里有
    //   .hp-modal{left:0!important;top:0!important;width:100vw!important...}
    // !important 会顶掉 inline 的 left/top，但 inline 的 transform:translate(-50%,-50%)
    // 没被覆盖 → 面板先被钉到左上、再往左上平移一半 → 整块飞出屏幕。
    // 改用独立类名，完全不继承主面板的任何规则。
    mask.className = 'hp-picker-mask on';
    mask.id = 'hp-model-picker';
    mask.innerHTML = `
      <div class="hp-picker" role="dialog" aria-label="选择模型">
        <div class="hp-picker-head">
          <span class="hp-picker-ic">◈</span>
          <span class="hp-picker-title">选择模型</span>
          <span class="hp-picker-count" id="hp-mp-count"></span>
          <span class="hp-picker-sp"></span>
          <button class="hp-picker-x" id="hp-mp-close" aria-label="关闭">✕</button>
        </div>
        <div class="hp-picker-body">
          <input class="hp-picker-input" id="hp-mp-search" placeholder="搜索模型名…" autocomplete="off">
          <div class="hp-picker-list" id="hp-mp-list"></div>
          <div class="hp-picker-foot">
            <input class="hp-picker-input" id="hp-mp-manual" placeholder="或手动输入模型 ID（确认无误再用）" autocomplete="off">
            <button class="hp-picker-btn" id="hp-mp-ok">确定</button>
          </div>
        </div>
      </div>`;
    // 【修 v1.12】挂到 html 而非 body：宿主主题常给 body 加 transform，
    // 那会把 fixed 的包含块改写成 body，导致居中失效。html 极少被加 transform。
    document.documentElement.appendChild(mask);

    const listEl = mask.querySelector('#hp-mp-list');
    const searchEl = mask.querySelector('#hp-mp-search');
    const manualEl = mask.querySelector('#hp-mp-manual');

    const render = (kw) => {
      const k = (kw || '').trim().toLowerCase();
      const shown = k ? list.filter(x => String(x).toLowerCase().includes(k)) : list;
      const cnt = mask.querySelector('#hp-mp-count');
      if (cnt) cnt.textContent = shown.length ? `${shown.length} 个${k ? `（共 ${list.length}）` : ''}` : '';
      listEl.innerHTML = shown.length
        ? shown.map(m => `<div class="hp-picker-item${m === current ? ' on' : ''}" data-m="${esc(m)}" title="${esc(m)}">${esc(m)}</div>`).join('')
        : '<div class="hp-picker-empty">没有匹配的模型</div>';
      listEl.querySelectorAll('.hp-picker-item').forEach(it => {
        it.onclick = () => {
          const v = it.dataset.m;
          mask.remove();
          onPick(v);
        };
      });
      if (!shown.length) return;
      // 未搜索且已选过 → 滚到选中项
      if (!k && current) {
        const hit = listEl.querySelector('.hp-picker-item.on');
        if (hit) hit.scrollIntoView({ block: 'center' });
      }
    };
    render('');
    searchEl.oninput = () => render(searchEl.value);

    const close = () => { try { mask.__cleanup && mask.__cleanup(); } catch (e) {} mask.remove(); };
    mask.querySelector('#hp-mp-close').onclick = close;
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    mask.querySelector('#hp-mp-ok').onclick = () => {
      const v = (manualEl.value || '').trim();
      if (!v) { toast('请输入模型 ID，或在上方列表中点击一个', 'err'); return; }
      mask.remove(); onPick(v);
    };
    const escHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);

    // 【修 v1.12】精确居中：按「视口实测尺寸」写死 px，并在祖先有 transform
    // （fixed 包含块被改写）时自动切换为 absolute + 滚动偏移，保证永远居中可见。
    const box = mask.querySelector('.hp-picker');
    placePicker(box);
    mask.__repos = () => placePicker(box);
    window.addEventListener('resize', mask.__repos);
    window.addEventListener('orientationchange', mask.__repos);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', mask.__repos);
      window.visualViewport.addEventListener('scroll', mask.__repos);
    }
    // 关闭时清理监听
    const origClose = close;
    mask.__cleanup = () => {
      window.removeEventListener('resize', mask.__repos);
      window.removeEventListener('orientationchange', mask.__repos);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', mask.__repos);
        window.visualViewport.removeEventListener('scroll', mask.__repos);
      }
    };
  } catch (e) {
    // 兜底：万一弹层失败，退回手填，避免功能完全不可用
    const v = prompt('无法弹出列表，请手动输入模型 ID：\n\n' + list.slice(0, 40).join('\n'), current || list[0] || '');
    if (v) onPick(v.trim());
  }
}

/* ==========================================================================
 * 设置页：8 面板
 * ========================================================================== */
const PANES = ['连接', 'API 池', '索引', '检索', '角色', '认知边界', '提示词', '记忆', '调试'];
const PRESETS = {
  siliconflow: { name: 'SiliconFlow', base: 'https://api.siliconflow.cn/v1' },
  openai: { name: 'OpenAI', base: 'https://api.openai.com/v1' },
  ollama: { name: '本地 Ollama', base: 'http://localhost:11434/v1' },
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1' },
  zhipu: { name: '智谱', base: 'https://open.bigmodel.cn/api/paas/v4' },
  moonshot: { name: 'Moonshot', base: 'https://api.moonshot.cn/v1' },
};

function esc(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function apiRowsHTML() {
  return settings.apis.map((a, i) => `
    <tr>
      <td><input class="hp-inp" data-api="${i}" data-f="name" value="${esc(a.name)}" placeholder="名称" style="min-width:90px"></td>
      <td><div class="hp-uses">
        ${API_USES.map(u => `<span class="hp-uchip${apiUses(a).includes(u.key) ? ' on' : ''}" data-use="${u.key}" data-i="${i}" title="${u.label}">${u.key}</span>`).join('')}
      </div></td>
      <td><input class="hp-inp" data-api="${i}" data-f="base" value="${esc(a.base)}" placeholder="https://..." style="min-width:150px"></td>
      <td><input class="hp-inp" type="password" data-api="${i}" data-f="key" value="${esc(a.key)}" placeholder="sk-..." style="min-width:110px"></td>
      <td><div class="hp-modelcell">
        <span class="hp-modelname${a.model ? '' : ' none'}">${a.model ? esc(a.model) : '未选择'}</span>
        <button class="hp-mini" data-act="fetch" data-i="${i}">${a.model ? '更换' : '拉取'}</button>
      </div></td>
      <td><div class="hp-rpmcell">
        <input class="hp-inp hp-mini2" data-api="${i}" data-f="rpm" value="${a.rpm ?? 60}" title="每分钟请求上限（RPM）。填 0 = 不限速（并发才能真正跑满）" style="width:46px"><button class="hp-mini hp-unrpm" data-unrpm="${i}" title="把 RPM 设为 0（不限速），让并发真正跑满">∞</button>
        <span class="hp-xlab">×</span>
        <input class="hp-inp hp-mini2" data-api="${i}" data-f="concurrency" value="${a.concurrency ?? 0}" title="额外并发路数：0=串行，1=2路同时，2=3路同时" style="width:38px">
      </div></td>
      <td style="white-space:nowrap">
        <button class="hp-mini" data-act="del" data-i="${i}">删</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" style="color:var(--hp-tx3);padding:12px">尚未配置 API。点下方「＋ 新增」开始。</td></tr>';
}

function promptRowsHTML() {
  return PROMPT_KEYS.map(p => `
    <div class="hp-fld"><label>${p.label}</label>
      <div class="hp-row" style="margin-bottom:6px">
        <select class="hp-inp hp-papi" data-pk="${p.key}" style="max-width:190px">
          <option value="">${p.apiOnly ? '— 按用途标签自动挑选 —' : '— 不调用（离线/降级）—'}</option>
          ${settings.apis.map(a => `<option value="${esc(a.name)}"${settings.prompts[p.key]?.api === a.name ? ' selected' : ''}>${esc(a.name || '(未命名)')}</option>`).join('')}
        </select>
        <span style="font-size:11px;color:var(--hp-tx3)">${p.apiOnly ? '留空则按 API 池用途标签自动挑' : '留空则该步自动降级'}</span>
      </div>
      ${p.apiOnly
        ? `<div style="font-size:11px;color:var(--hp-tx3);line-height:1.6;padding:6px 8px;background:var(--hp-bgc);border-radius:6px">${esc(p.def)}</div>`
        : `<textarea class="hp-inp hp-ptxt" data-pk="${p.key}" rows="6">${esc(settings.prompts[p.key]?.text || p.def)}</textarea>`}
      ${p.apiOnly ? '' : `<div class="hp-row" style="margin-top:5px">
        <button class="hp-mini" data-act="preset" data-pk="${p.key}">恢复默认</button>
        <span class="hp-pflag" data-pflag="${p.key}"></span>
      </div>`}
    </div>`).join('') + `
    <div class="hp-fld"><div class="hp-row">
      <button class="hp-mini" data-act="presetall">全部恢复默认</button>
      <span style="font-size:11px;color:var(--hp-tx3)">新版深化了 ④⑤⑥⑦ 四套提示词；本地改过的需要点一下才会换成新版</span>
    </div></div>`;
}


/* 标出与新版默认不一致的提示词，提醒用户点「恢复默认」换新版 */
function paintPFlags(pane) {
  if (!pane) return;
  pane.querySelectorAll('[data-pflag]').forEach(el => {
    const k = el.dataset.pflag;
    const def = PROMPT_KEYS.find(x => x.key === k);
    const cur = settings.prompts?.[k]?.text;
    if (!def) return;
    if (!cur || cur === def.def) { el.textContent = ''; el.className = 'hp-pflag'; return; }
    el.textContent = '本地已改过（点「恢复默认」换新版）';
    el.className = 'hp-pflag on';
  });
}

/* 别名输入框绑定：抽出为函数，加入新角色后可重新绑定 */
function bindAliasInputs(pane) {
  if (!pane) return;
  pane.querySelectorAll('#hp-alias [data-alias]').forEach(el => {
    el.onchange = () => {
      const id = el.dataset.alias;
      const f = el.dataset.f;
      settings.aliasMap = settings.aliasMap || {};
      settings.aliasMap[id] = settings.aliasMap[id] || {};
      settings.aliasMap[id][f] = f === 'alias' ? el.value.split(/[\/\u3001,\uff0c\s]+/).filter(Boolean) : el.value;
      saveSettings(); idbSet(STORE.alias, 'main', settings.aliasMap);
    };
  });
}

function aliasRowsHTML() {
  const m = settings.aliasMap || {};
  const ks = Object.keys(m);
  if (!ks.length) return '<div style="font-size:12px;color:var(--hp-tx3)">建索引后自动生成</div>';
  return `<table class="hp-tb"><tr><th>char_id</th><th>姓名</th><th>别名</th><th>命中</th><th>台词</th><th></th></tr>` +
    ks.map(id => `<tr>
      <td class="em">${esc(id)}</td>
      <td><input class="hp-inp" data-alias="${esc(id)}" data-f="name" value="${esc(m[id].name)}"></td>
      <td><div class="hp-alias-cell">
          ${(m[id].alias || []).map((a, ai) => `<span class="hp-alias-chip">${esc(a)}<button class="hp-chip-x" data-del-alias="${esc(id)}" data-ai="${ai}" title="删除这个别名">×</button></span>`).join('') || '<span style="color:var(--hp-tx3);font-size:11px">无（可下方扫描补充）</span>'}
          <input class="hp-inp" data-alias="${esc(id)}" data-f="alias" value="${esc((m[id].alias || []).join(' / '))}" placeholder="用 / 或空格分隔">
        </div></td>
      <td>${m[id].hits ?? 0}</td>
      <td>${(m[id].lines || []).length}</td>
      <td><button class="hp-mini danger" data-del-char="${esc(id)}">删</button></td>
    </tr>`).join('') + '</table>';
}

/* 【v1.17】角色可删除：此前只能加不能删，「我知」这类误捕的永远去不掉 */
function bindAliasDelete(pane) {
  if (!pane) return;
  pane.querySelectorAll('[data-del-char]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.delChar;
      const nm = settings.aliasMap?.[id]?.name || id;
      if (!confirm(`确定删除角色「${nm}」？\n其别名表与台词簇会一并移除，此操作不可撤销。`)) return;
      delete settings.aliasMap[id];
      saveSettings(); idbSet(STORE.alias, 'main', settings.aliasMap);
      refreshPane(); toast(`已删除角色「${nm}」`, 'ok');
    };
  });
  pane.querySelectorAll('[data-del-alias]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.delAlias;
      const ai = Number(btn.dataset.ai);
      const info = settings.aliasMap?.[id];
      if (!info || !Array.isArray(info.alias)) return;
      const gone = info.alias[ai];
      info.alias.splice(ai, 1);
      saveSettings(); idbSet(STORE.alias, 'main', settings.aliasMap);
      refreshPane(); toast(`已删除别名「${gone}」`, 'ok');
    };
  });
}

/* 【v1.18】记忆面板 */
/* 【v1.25】剧情面板：定位当前进度 + 控制世界书章节条目启停 */
function plotPaneHTML() {
  const s = settings;
  const p = __wbProbe;
  const last = s.plotLastCh
    ? `上次定位：<b style="color:var(--hp-ok,#5ecb8f)">第 ${s.plotLastCh} 章</b>`
      + (s.plotLastWhy ? `　<span style="color:var(--hp-tx3)">${esc(s.plotLastWhy)}</span>` : '')
      + (s.plotLastAt ? `<br><span style="color:var(--hp-tx3)">时间：${new Date(s.plotLastAt).toLocaleString()}</span>` : '')
    : '<span style="color:var(--hp-tx3)">尚未定位过</span>';
  const wb = p.ok
    ? `世界书：<b style="color:var(--hp-ok,#5ecb8f)">已读到 ${p.count} 条</b>，其中剧情条目 <b>${p.plotCount}</b> 条　<span style="color:var(--hp-tx3)">来源 ${esc(p.src)}</span>`
    : `世界书：<span style="color:var(--hp-err,#e06c75)">${esc(p.err || '未检测')}</span>`;
  const optApi = (sel) => `<option value="">— 按用途标签自动挑选 —</option>` +
    (s.apis || []).map(a => `<option value="${esc(a.name)}"${sel === a.name ? ' selected' : ''}>${esc(a.name || '(未命名)')}</option>`).join('');
  return `<h3>剧情进度控制</h3>
    <div class="ds">按「当前演到第几章」自动启用对应的世界书剧情条目，取代写死的触发器</div>
    <div class="hp-hint">
      定位顺序：<b>变量游戏内日期</b> → 章节索引 → <b>最近正文</b>（交给 LLM 判定）。
      判定完成后，启用「当前章 ±N 章」的剧情条目，其余一律禁用。<br>
      这套逻辑替代了原来那 5 条无条件注入的「斯科皮 N 年级节点总览」——它们每轮都塞两万多字，既卡又不准。
    </div>
    <div class="hp-sw"><div class="l">启用剧情条目控制<small>关闭则插件不再改动任何世界书条目</small></div>
      <div class="hp-tg${s.plotCtlOn ? ' on' : ''}" data-sw="plotCtlOn"></div></div>
    <div class="hp-sw"><div class="l">每轮结束后自动定位<small>默认关；开启后每次 AI 写完就重算一次</small></div>
      <div class="hp-tg${s.plotAutoRun ? ' on' : ''}" data-sw="plotAutoRun"></div></div>
    <div class="hp-sw"><div class="l">手动值优先<small>开了就以你填的章号为准，不再问 LLM</small></div>
      <div class="hp-tg${s.plotTrustManual ? ' on' : ''}" data-sw="plotTrustManual"></div></div>
    <div class="hp-fld"><label>启用范围（当前章 ±N 章）</label>
      <input class="hp-inp" data-num="plotRange" value="${s.plotRange ?? 1}" placeholder="1"></div>
    <div class="hp-fld"><label>手动指定章号（0 = 交给自动判定）</label>
      <input class="hp-inp" data-num="plotManualCh" value="${s.plotManualCh ?? 0}" placeholder="0"></div>
    <div class="hp-fld"><label>定位提示词用哪条 API<small>见「提示词」面板第 ⑩ 项，可单独配</small></label>
      <select class="hp-inp" data-ptapi="plot">${optApi(s.prompts?.plot?.api || '')}</select></div>
    <div class="hp-row" style="margin-top:10px">
      <button class="hp-mini p" id="hp-plot-run">现在定位一次</button>
      <button class="hp-mini" id="hp-plot-dry">只看不改（试算）</button>
      <button class="hp-mini" id="hp-plot-wb">检测世界书</button>
      <button class="hp-mini" id="hp-plot-off">全部禁用</button>
    </div>
    <pre id="hp-plot-out" style="margin-top:12px;background:var(--hp-card);border:1px solid var(--hp-bd);border-radius:8px;padding:12px;font-size:11.5px;color:var(--hp-tx2);max-height:320px;overflow:auto;white-space:pre-wrap">${last}\n${wb}</pre>`;
}

function memPaneHTML() {
  const s = settings;
  const optApi = (sel) => `<option value="">— 按用途标签自动挑选 —</option>` +
    (s.apis || []).map(a => `<option value="${esc(a.name)}"${sel === a.name ? ' selected' : ''}>${esc(a.name || '(未命名)')}</option>`).join('');
  return `<h3>永久记忆</h3><div class="ds">Termux 后端 SQLite · 插件负责抽取与向量，后端只存取</div>

    <div class="hp-fld"><label>状态</label>
      <div class="hp-row" style="align-items:center;gap:8px">
        <span class="hp-memlight big ${!s.memEnabled ? 'off' : (MEM_STATE.ok ? 'ok' : 'bad')}" id="hp-memlight-pane"><i></i><b>记忆</b></span>
        <span id="hp-mem-out" style="flex:1">${memStatusHTML()}</span>
        <button class="hp-mini" id="hp-mem-probe">检测</button>
      </div>
      <div class="hp-hint" style="margin-top:8px">
        绿灯＝后端已启动且连通；红灯＝未启用 / 后端没起 / 地址错 / 被浏览器拦。<br>
        数据存在后端 SQLite 文件里，进程重启不丢；换设备把那个 <code>.db</code> 文件拷走即可。
      </div></div>

    <div class="hp-sw"><div class="l">启用永久记忆<small>关掉时全程不请求后端</small></div><div class="hp-tg${s.memEnabled ? ' on' : ''}" data-sw="memEnabled"></div></div>
    <div class="hp-sw"><div class="l">面板打开时自动复检<small>每 ${s.memProbeSec || 20} 秒探一次，仅一个 GET</small></div><div class="hp-tg${s.memAutoProbe ? ' on' : ''}" data-sw="memAutoProbe"></div></div>

    <div class="hp-fld"><label>后端地址</label><input class="hp-inp" data-str="memBase" value="${esc(s.memBase || '')}" placeholder="http://127.0.0.1:8899"></div>
    <div class="hp-fld"><label>访问令牌（可留空）</label><input class="hp-inp" data-str="memToken" value="${esc(s.memToken || '')}" placeholder="后端设了 HP_MEM_TOKEN 才需要"></div>

    <div class="hp-sec-h">更新</div>
    <div class="hp-sw"><div class="l">生成结束后自动更新<small>默认关闭；失败也不影响聊天</small></div><div class="hp-tg${s.memAutoUpdate ? ' on' : ''}" data-sw="memAutoUpdate"></div></div>
    <div class="hp-fld"><label>每次扫描轮数</label><input class="hp-inp" data-num="memTurnsPerUpdate" value="${s.memTurnsPerUpdate}"></div>
    <div class="hp-fld"><label>单次最多入库</label><input class="hp-inp" data-num="memMaxPerTurn" value="${s.memMaxPerTurn}"></div>
    <div class="hp-fld"><label>最低重要度<small>低于此值不入库，防闲聊噪音</small></div><input class="hp-inp" data-num="memMinImportance" value="${s.memMinImportance}"></div>
    <div class="hp-fld"><label>抽取用 LLM</label><select class="hp-inp" data-sel="memExtractApi" style="max-width:240px">${optApi(s.memExtractApi)}</select></div>
    <div class="hp-fld"><label>记忆向量用 embedding</label><select class="hp-inp" data-sel="memEmbedApi" style="max-width:240px">${optApi(s.memEmbedApi)}</select></div>
    <div class="hp-row" style="margin-top:8px">
      <button class="hp-mini" id="hp-mem-sync">立即更新记忆库</button>
      <button class="hp-mini" id="hp-mem-reset">重置同步进度</button>
      <button class="hp-mini" id="hp-mem-stats">查看统计</button>
    </div>

    <div class="hp-sec-h">检索与注入</div>
    <div class="hp-sw"><div class="l">图扩散检索<small>多跳联想：场景词不在记忆里也能唤醒，如「夜晚」→雷雨→怕打雷</small></div><div class="hp-tg${s.memGraph ? ' on' : ''}" data-sw="memGraph"></div></div>
    <div class="hp-fld"><label>图谱可视节点上限</label><input class="hp-inp" data-num="memGraphLimit" value="${s.memGraphLimit}"></div>
    <div class="hp-fld"><label>检索条数</label><input class="hp-inp" data-num="memTopK" value="${s.memTopK}"></div>
    <div class="hp-fld"><label>记忆字符上限<small>独立预算，不挤占原文</small></label><input class="hp-inp" data-num="memCharCap" value="${s.memCharCap}"></div>
    <div class="hp-row" style="margin-top:8px">
      <button class="hp-mini" id="hp-mem-test">测试记忆检索</button>
      <button class="hp-mini" id="hp-mem-graph">记忆图谱</button>
      <button class="hp-mini" id="hp-mem-wipe">清空记忆库</button>
    </div>

    <div class="hp-fld" style="margin-top:12px"><label>抽取提示词</label>
      <textarea class="hp-inp" rows="10" data-txt="memExtractPrompt">${esc(s.memExtractPrompt || MEM_EXTRACT_DEF)}</textarea></div>

    <pre id="hp-mem-log" style="margin-top:12px;background:var(--hp-card);border:1px solid var(--hp-bd);border-radius:8px;padding:12px;font-size:11.5px;color:var(--hp-tx2);max-height:320px;overflow:auto;white-space:pre-wrap">点上方按钮查看结果</pre>`;
}

function paneHTML(i) {
  const s = settings;
  if (i === 0) return `<h3>连接</h3><div class="ds">总开关、拦截行为与外观</div>
    <div class="hp-sw"><div class="l">启用插件</div><div class="hp-tg${s.enabled ? ' on' : ''}" data-sw="enabled"></div></div>
    <div class="hp-sw"><div class="l">拦截模式<small>点发送后先分析，再连同注入一起放行</small></div><div class="hp-tg${s.intercept ? ' on' : ''}" data-sw="intercept"></div></div>
    <div class="hp-sw"><div class="l">重生成后重跑管线</div><div class="hp-tg${s.rerunOnRegenerate ? ' on' : ''}" data-sw="rerunOnRegenerate"></div></div>
    <div class="hp-sw"><div class="l">台词转英文交给 AI<small>插件只给中文示意，由 AI 按卡的规范转换</small></div><div class="hp-tg${s.aiTranslateLines ? ' on' : ''}" data-sw="aiTranslateLines"></div></div>
    <div class="hp-sw"><div class="l">注入预览<small>拦截后先弹窗确认再放行</small></div><div class="hp-tg${s.previewBeforeInject ? ' on' : ''}" data-sw="previewBeforeInject"></div></div>
    <div class="hp-fld"><label>超时（毫秒）</label><input class="hp-inp" data-num="timeoutMs" value="${s.timeoutMs}"></div>
    <div class="hp-fld"><label>失败重试次数</label><input class="hp-inp" data-num="maxRetry" value="${s.maxRetry}"></div>
    <div class="hp-fld"><label>主题</label><select class="hp-inp" data-sel="theme">
      <option value="slytherin"${s.theme === 'slytherin' ? ' selected' : ''}>斯莱特林（深绿 + 银）</option>
      <option value="night"${s.theme === 'night' ? ' selected' : ''}>夜幕（蓝 + 金）</option>
    </select></div>`;

  if (i === 1) return `<h3>API 池</h3><div class="ds">最多 10 条 · 填 Base URL → 填 Key → 点「拉取」→ 选模型 → 保存（Key 存浏览器本地）</div>
    <div class="hp-hint">
      <b>用途由你自己勾选</b>，插件不预设某条 API 是向量还是对话。<br>
      一条 API 可同时承担多种用途；若某用途没有任何勾选中的 API，插件会退而使用任意一条配置完整的，不会因为标签不对而静默失效。<br>
      各提示词还可以单独指定用哪条 API（见「提示词」面板）。<br>
      <b>RPM × 并发</b>：RPM＝每分钟请求上限（防限流）；并发＝额外同时发几路（<code>0</code> 串行，<code>1</code>＝2 路，<code>2</code>＝3 路）。
      建索引最慢，把并发调大能显著提速；并发受 RPM 约束，不会突破上限。
    </div>
    <div style="overflow-x:auto"><table class="hp-tb">
      <tr><th>名称</th><th>用途（可多选）</th><th>Base URL</th><th>Key</th><th>模型</th><th>RPM × 并发</th><th>操作</th></tr>
      <tbody id="hp-api-body">${apiRowsHTML()}</tbody></table></div>
    <div class="hp-row" style="margin-top:10px">
      <button class="hp-mini p" id="hp-api-add">＋ 新增</button>
      <button class="hp-mini" id="hp-api-save">保存全部</button>
      <button class="hp-mini" id="hp-api-export" title="把 API 配置导出成 JSON 文件，换设备/清缓存前先备份">⭳ 导出</button>
      <button class="hp-mini" id="hp-api-import" title="从导出的 JSON 恢复 API 配置">⭱ 导入</button>
      <span style="flex:1"></span>
      <span style="font-size:11.5px;color:var(--hp-tx3)">已配 ${settings.apis.length} / 10</span>
    </div>
    <div class="hp-row" style="margin-top:6px">
      <span id="hp-api-store" style="font-size:11.5px"></span>
    </div>
    <div class="ds" style="margin-top:2px">API 配置改动会<b>立即同步写入浏览器本地</b>，不依赖云端保存；刷新后从本地独立存档读回。
      若仍担心丢失，用「导出」存一份 JSON。</div>
    <div class="hp-fld" style="margin-top:14px"><label>常用预设（填入最后一条的 Base URL）</label><div class="hp-chips">
      ${Object.entries(PRESETS).map(([k, v]) => `<span class="hp-chip" data-preset="${k}">${v.name}</span>`).join('')}
    </div></div>
    <div class="hp-fld"><label>本月用量</label><div class="hp-st2">
      <div><b>${(settings.stats ? Object.values(settings.stats).reduce((a, b) => a + (b.req || 0), 0) : 0)}</b><span>累计请求</span></div>
      <div><b>${fmtTok(settings.stats ? Object.values(settings.stats).reduce((a, b) => a + (b.tok || 0), 0) : 0)}</b><span>累计 tokens</span></div>
      <div><b>${statGet().req}</b><span>本月请求</span></div>
    </div></div>`;

  if (i === 2) return `<h3>索引</h3><div class="ds">上传整理版 txt → 自动采样 → 推荐块大小 → 执行建索引（全部存本地，不上传）</div>

    <div class="hp-step">
      <div class="hp-stepn">第 1 步</div>
      <div class="hp-stept">选择小说 txt 文件</div>
    </div>
    <div class="hp-drop" id="hp-drop">
      <input type="file" id="hp-file" accept=".txt,.json,text/plain,application/json">
      <div class="hp-dropin">
        <div class="hp-dropi">📄</div>
        <div class="hp-dropt">点击这里选择 txt 文件</div>
        <div class="hp-dropd">也可以把文件拖进来（支持 .txt / 备份 .json）</div>
      </div>
      <div class="hp-dropsel" id="hp-dropsel"></div>
    </div>
    <div class="hp-row" style="margin-bottom:6px">
      <button class="hp-mini p" id="hp-save-txt">保存到本地</button>
      <button class="hp-mini" id="hp-del-txt">删除已保存的小说</button>
    </div>
    <div class="hp-hint">选好文件后要点「保存到本地」才会真正写入浏览器数据库；保存成功后下面第 2、3 步才能用。</div>

    <div class="hp-step">
      <div class="hp-stepn">第 2 步</div>
      <div class="hp-stept">自动分析章节、推荐切块参数</div>
    </div>
    <div class="hp-row" style="margin-bottom:14px">
      <button class="hp-mini" id="hp-sample">① 自动采样</button>
      <button class="hp-mini" id="hp-suggest">② 推荐块大小</button>
    </div>

    <div class="hp-step">
      <div class="hp-stepn">第 3 步</div>
      <div class="hp-stept">建立索引（切块 + 向量）</div>
    </div>
    <div class="hp-row" style="margin-bottom:8px">
      <button class="hp-mini p" id="hp-build">③ 执行建索引</button>
      <button class="hp-mini" id="hp-build-stop">中止</button>
      <button class="hp-mini" id="hp-idx-chk">索引体检</button>
    </div>
    <div class="hp-hint" style="margin-bottom:14px">
      建索引可<b>断点续建</b>：中途关页面或点「中止」都会存盘，下次点建索引只补未完成的块，不重切。
    </div>

    <div class="hp-fld"><label>建索引 / 向量检索 使用的 API</label>
      <select class="hp-inp" data-sel-api="embedApi">
        <option value="">自动选择（优先勾选了 embed 用途的）</option>
        ${(s.apis || []).map(a => `<option value="${esc(a.name)}"${s.embedApi === a.name ? ' selected' : ''}>${esc(a.name)}${a.model ? ' · ' + esc(a.model) : ''}</option>`).join('')}
      </select>
      <div class="hp-hint" style="margin-top:6px">
        建索引和每轮检索必须用<b>同一个</b> embedding 模型——换了模型要重建索引，
        否则向量空间不一致，检索结果全乱。
      </div>
    </div>
    <div class="hp-fld"><label>块大小（字）</label><input class="hp-inp" data-num="chunkSize" value="${s.chunkSize}"></div>
    <div class="hp-fld"><label>块重叠（字）</label><input class="hp-inp" data-num="chunkOverlap" value="${s.chunkOverlap}"></div>
    <div class="hp-hint">块大＝上下文完整但不够精确；块小＝精确但可能断在半句。整理版 txt 已按章节排好，一般 300～600 都合适，点「② 推荐块大小」可让 AI 给出建议值。</div>
    <div class="hp-row" style="margin-top:6px">
      <button class="hp-mini" id="hp-export">导出备份</button>
      <button class="hp-mini" id="hp-import">导入备份</button>
      <span style="flex:1"></span>
      <button class="hp-mini" id="hp-clear-idx">清空索引</button>
    </div>
    <pre id="hp-idx-status" style="margin-top:14px;background:var(--hp-card);border:1px solid var(--hp-bd);border-radius:8px;padding:12px;font-size:11.5px;color:var(--hp-tx2);white-space:pre-wrap">读取中…</pre>`;

  if (i === 3) return `<h3>检索</h3><div class="ds">原文通道参数与卡片外观</div>
    <div class="hp-sw"><div class="l">认知边界审查</div><div class="hp-tg${s.cognitionCheck ? ' on' : ''}" data-sw="cognitionCheck"></div></div>
    <div class="hp-sw"><div class="l">POV 二次过滤<small>注入前剥离斯科皮（{{user}}）的言行句，避免替玩家预设操作与发言。默认关</small></div><div class="hp-tg${s.povFilter ? ' on' : ''}" data-sw="povFilter"></div></div>
    <div class="hp-sw"><div class="l">显示「已审查」徽章</div><div class="hp-tg${s.showCognitionBadge ? ' on' : ''}" data-sw="showCognitionBadge"></div></div>
    <div class="hp-sw"><div class="l">卡片默认收起</div><div class="hp-tg${s.collapseByDefault ? ' on' : ''}" data-sw="collapseByDefault"></div></div>
    <div class="hp-sw"><div class="l">侧栏显示未解锁节点（置灰）</div><div class="hp-tg${s.showLockedNodes ? ' on' : ''}" data-sw="showLockedNodes"></div></div>
    <div class="hp-sw"><div class="l">角色出场过滤<small>只检索有主交互对象的段落</small></div><div class="hp-tg${s.charFilterEnabled ? ' on' : ''}" data-sw="charFilterEnabled"></div></div>
    <div class="hp-sw"><div class="l">缓存复用<small>相似场景复用上次结果，省 API</small></div><div class="hp-tg${s.cacheEnabled ? ' on' : ''}" data-sw="cacheEnabled"></div></div>
    <div class="hp-sw"><div class="l">剧情冲突检测</div><div class="hp-tg${s.conflictCheck ? ' on' : ''}" data-sw="conflictCheck"></div></div>
    <div class="hp-hint" style="margin-bottom:8px">
      <b>整章召回</b>：命中某章后把该章<b>全部块</b>拼回完整剧情再注入。<br>
      关闭则只注入命中的几个 400 字块（旧行为，剧情会是碎片）。
    </div>
    <div class="hp-sw"><div class="l">整章召回<small>推荐开启，避免注入一半就没了</small></div><div class="hp-tg${s.chapterRecall ? ' on' : ''}" data-sw="chapterRecall"></div></div>
    <div class="hp-fld"><label>单章字符上限<small>0 = 不限</small></label><input class="hp-inp" data-num="chapterMaxChars" value="${s.chapterMaxChars}"></div>
    <div class="hp-fld"><label>最多注入几章</label><input class="hp-inp" data-num="chapterMaxCount" value="${s.chapterMaxCount}"></div>
    <div class="hp-fld"><label>召回候选数（rerank 前）</label><input class="hp-inp" data-num="recallTop" value="${s.recallTop}"></div>
    <div class="hp-fld"><label>命中章线索块数 top-K<small>整章模式下用于判定命中哪几章</small></label><input class="hp-inp" data-num="topK" value="${s.topK}"></div>
    <div class="hp-fld"><label>最多注入角色数</label><input class="hp-inp" data-num="maxChars" value="${s.maxChars}"></div>
    <div class="hp-fld"><label>token 预算</label><input class="hp-inp" data-num="tokenBudget" value="${s.tokenBudget}"></div>
    <div class="hp-fld"><label>触发查询改写的最短输入（字）</label><input class="hp-inp" data-num="minQueryLen" value="${s.minQueryLen}"></div>
    <div class="hp-fld"><label>缓存有效期（毫秒）</label><input class="hp-inp" data-num="cacheTTL" value="${s.cacheTTL}"></div>
    <div class="hp-fld"><label>临时加权词（boost，逗号分隔）</label><input class="hp-inp" data-str="boostWords" value="${esc(s.boostWords)}"></div>
    <div class="hp-fld"><label>临时降权词（penalty，逗号分隔）</label><input class="hp-inp" data-str="penaltyWords" value="${esc(s.penaltyWords)}"></div>
    <h4 style="margin:14px 0 6px">上一轮正文（情绪推断的因果来源）</h4>
    <div class="hp-hint">
      拦截发生在 AI 生成之前，因此<b>本轮正文尚不存在</b>，插件只能读到上一轮及更早。<br>
      这段正文是情绪、预测动作、准备动作的<b>因果依据</b>——没有它，推断只能基于好感度数字，会显得接不上戏。<br>
      条数越多越连贯，但也会拖慢每一轮。
    </div>
    <div class="hp-fld"><label>读取最近几轮</label><input class="hp-inp" data-num="historyTurns" value="${s.historyTurns}"></div>
    <div class="hp-fld"><label>正文截断长度（字）</label><input class="hp-inp" data-num="historyChars" value="${s.historyChars}"></div>`;

  if (i === 4) return `<h3>角色</h3><div class="ds">档位阈值、台词条数、别名校对</div>
    <div class="hp-fld"><label>好感度档位切分（−100 ~ +100）</label>
      <div class="hp-hint">
        每个数字是<b>该档位的好感度上限</b>：好感度 ≤ 该数字就归到这一档。<br>
        例：敌视 −60、排斥 −20 → 好感 −80 判为<b>敌视</b>，−30 判为<b>排斥</b>。<br>
        档位决定注入给 AI 的<b>态度描述与台词示例</b>，不改写变量本身。
      </div>
      <div class="hp-tiers">
        ${TIERS.map((t, i) => `<label class="hp-tcell"><span class="hp-tk">${t.key}</span><input class="hp-inp hp-tier" data-i="${i}" value="${s.tiers[i]}" title="${t.key} 上限"><span class="hp-th">≤ 此值</span></label>`).join('')}
      </div>
      <div class="hp-tierdemo">
        <span>试算：</span>
        <input class="hp-inp" id="hp-aff-demo" type="number" value="-15" style="width:88px">
        <span class="hp-affres" id="hp-aff-res">排斥</span>
      </div>
      <div class="hp-chips">
        <span class="hp-chip${s.tierSource === 'affinity' ? ' on' : ''}" data-tier="affinity">好感度</span>
        <span class="hp-chip${s.tierSource === 'route' ? ' on' : ''}" data-tier="route">关系路线进程</span>
        <span class="hp-chip${s.tierSource === 'higher' ? ' on' : ''}" data-tier="higher">两者取高</span>
      </div></div>
    <div class="hp-fld"><label>每档台词示例条数</label><input class="hp-inp" data-num="lineCount" value="${s.lineCount}"></div>
    <div class="hp-sw"><div class="l">德拉科细化块<small>在场时注入情绪 / 预测动作 / 准备动作 / 吃醋风险</small></div><div class="hp-tg${s.dracoDetail ? ' on' : ''}" data-sw="dracoDetail"></div></div>
    <div class="hp-sw"><div class="l">离场时保留准备动作</div><div class="hp-tg${s.dracoOffstageKeepPrep ? ' on' : ''}" data-sw="dracoOffstageKeepPrep"></div></div>
    <div class="hp-fld"><label>角色别名校对</label>
      <div class="hp-hint">建索引后自动生成。可改姓名与别名（用 / 分隔），改动即时生效。</div>
      <div class="hp-row" style="margin:8px 0">
        <button class="hp-mini" id="hp-scan-chars">扫描全文补充角色</button>
        <input class="hp-inp" id="hp-scan-min" type="number" value="30" title="最小出现次数" style="width:76px">
        <span style="font-size:11.5px;color:var(--hp-tx3)">次以上</span>
      </div>
      <div id="hp-scan-out"></div>
      <div id="hp-alias">${aliasRowsHTML()}</div></div>`;

  if (i === 5) return `<h3>认知边界</h3><div class="ds">角色只能说自己知道的事</div>
    <div class="hp-fld"><label>越界处理</label><div class="hp-chips">
      <span class="hp-chip${s.cognitionMode === 'rewrite' ? ' on' : ''}" data-cog="rewrite">改写为可感知部分</span>
      <span class="hp-chip${s.cognitionMode === 'drop' ? ' on' : ''}" data-cog="drop">直接删除</span>
      <span class="hp-chip${s.cognitionMode === 'mark' ? ' on' : ''}" data-cog="mark">保留并打标记</span>
    </div></div>
    <div class="hp-fld"><label>审查提示词（元规则）</label>
      <textarea class="hp-inp" rows="14" data-txt="cognitionPromptText">${esc(s.cognitionPromptText || PROMPT_DEF.cognition)}</textarea></div>
    <div class="hp-warn" style="margin-top:10px">规则轨始终生效（剔除未来章节、剔除作者视角），LLM 轨需配置 API 后用于处理临时情况。</div>`;

  if (i === 6) return `<h3>提示词</h3><div class="ds">8 套 LLM 提示词 · 各自指定用 API 池里的哪个（离线三步仅在建索引时调用）</div>
    ${promptRowsHTML()}`;

  if (i === 7) return memPaneHTML();
  if (i === 8) return plotPaneHTML();

  return `<h3>调试</h3><div class="ds">变量快照、索引体检、注入效果与诊断</div>
    <div class="hp-row"><button class="hp-mini" id="hp-dbg">刷新快照</button>
      <button class="hp-mini" id="hp-chk">索引体检</button>
      <button class="hp-mini" id="hp-diag">复制诊断信息</button></div>
    <div class="hp-row" style="margin-top:6px"><button class="hp-mini" id="hp-eff">注入效果</button>
      <button class="hp-mini" id="hp-clear-cache">清空缓存</button>
      <button class="hp-mini" id="hp-test-ret">测试检索</button>
      <button class="hp-mini" id="hp-cmp">原文对比</button></div>
    <div class="hp-fld" style="margin-top:12px"><label>测试检索语句</label>
      <input class="hp-inp" id="hp-test-q" value="德拉科在休息室" placeholder="输入一句话测试召回"></div>
    <pre id="hp-dbg-out" style="margin-top:12px;background:var(--hp-card);border:1px solid var(--hp-bd);border-radius:8px;padding:12px;font-size:11.5px;color:var(--hp-tx2);max-height:360px;overflow:auto;white-space:pre-wrap">点上方任一按钮查看</pre>`;
}

function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

async function initUI() {
  const host = document.getElementById('hp_settings')
    || document.getElementById('hp-deeplore_settings');
  if (!host) return;
  host.innerHTML = `<div class="hp-set">
    <div class="hp-nav">
      <div class="hp-gt">基础</div>
      ${PANES.slice(0, 3).map((p, i) => `<div class="hp-nv${i === 0 ? ' on' : ''}" data-p="${i}"><span class="n">${i + 1}</span>${p}</div>`).join('')}
      <div class="hp-gt">核心</div>
      ${PANES.slice(3, 6).map((p, i) => `<div class="hp-nv" data-p="${i + 3}"><span class="n">${i + 4}</span>${p}</div>`).join('')}
      <div class="hp-gt">高级</div>
      ${PANES.slice(6).map((p, i) => `<div class="hp-nv" data-p="${i + 6}"><span class="n">${i + 7}</span>${p}${p === '提示词' ? '<span class="p">8</span>' : ''}</div>`).join('')}
    </div>
    <div class="hp-pane" id="hp-pane-host"></div>
  </div>`;
  host.querySelectorAll('.hp-nv').forEach(n => {
    n.onclick = () => {
      host.querySelectorAll('.hp-nv').forEach(x => x.classList.remove('on'));
      n.classList.add('on');
      host.querySelector('#hp-pane-host').innerHTML = paneHTML(Number(n.dataset.p));
      bindPane(host);
    };
  });
  host.querySelector('#hp-pane-host').innerHTML = paneHTML(0);
  bindPane(host);
}

/* 【修 v1.9】连点防护：同一按钮 400ms 内只响应一次 */
const __lastClick = Object.create(null);
function throttled(key, ms) {
  const now = Date.now();
  if (__lastClick[key] && now - __lastClick[key] < (ms || 400)) return false;
  __lastClick[key] = now;
  return true;
}

/* 【修 v1.9】绑定标记：同一个元素只绑一次，杜绝 bindPane 反复调用导致的叠加。
   pane 每次换面板会整体重绘，用 pane 上的版本号区分即可。 */
let __bindSeq = 0;

function bindPane(host) {
  const pane = host.querySelector('#hp-pane-host');
  if (!pane) return;
  // 面板内容换了 → 版本号+1，允许重新绑定
  if (pane.dataset.hpRenderId !== String(pane.dataset.hpPaneIdx || '0') + ':' + (pane.dataset.hpRenderSeq || '0')) {
    pane.dataset.hpRenderId = String(pane.dataset.hpPaneIdx || '0') + ':' + (pane.dataset.hpRenderSeq || '0');
  }

  pane.querySelectorAll('[data-sw]').forEach(el => {
    el.onclick = () => {
      el.classList.toggle('on'); settings[el.dataset.sw] = el.classList.contains('on'); saveSettings();
      // 【v1.18】记忆相关开关变了 → 立刻刷新指示灯与状态卡
      if (String(el.dataset.sw).startsWith('mem')) {
        memLightPaint();
        if (el.dataset.sw === 'memEnabled' && settings.memEnabled) memProbe(true).then(() => memPanePaint());
      }
    };
  });
  pane.querySelectorAll('[data-num]').forEach(el => {
    const commit = () => { settings[el.dataset.num] = Number(el.value) || 0; };
    onEv(el, 'input', () => { commit(); schedulePersist(); });
    onEv(el, 'change', () => { commit(); saveSettings(); });
  });
  pane.querySelectorAll('[data-str]').forEach(el => {
    const commit = () => {
      settings[el.dataset.str] = el.value;
      // 地址/令牌改了 → 重新检测
      if (el.dataset.str === 'memBase' || el.dataset.str === 'memToken') memProbe(true).then(() => memPanePaint());
    };
    onEv(el, 'input', () => { commit(); schedulePersist(); });
    onEv(el, 'change', () => { commit(); saveSettings(); });
  });
  pane.querySelectorAll('[data-sel]').forEach(el => {
    const k = el.dataset.sel;
    if (k === 'memExtractApi' || k === 'memEmbedApi') { /* 仅存值，无需额外动作 */ }
  });
  pane.querySelectorAll('[data-sel-api]').forEach(el => {
    el.onchange = () => { settings[el.dataset.selApi] = el.value; saveSettings(); };
  });
  pane.querySelectorAll('[data-sel]').forEach(el => {
    const commit = () => {
      settings[el.dataset.sel] = el.value;
      if (el.dataset.sel === 'theme') document.documentElement.dataset.hpTheme = el.value;
    };
    onEv(el, 'input', () => { commit(); schedulePersist(); });
    onEv(el, 'change', () => { commit(); saveSettings(); });
  });
  const demoAff = pane.querySelector('#hp-aff-demo');
  const demoRes = pane.querySelector('#hp-aff-res');
  const updDemo = () => {
    if (!demoAff || !demoRes) return;
    const v = Number(demoAff.value);
    demoRes.textContent = Number.isFinite(v) ? tierFromAff(v) : '—';
  };
  onEv(demoAff, 'input', updDemo);
  pane.querySelectorAll('.hp-tier').forEach(el => { onEv(el, 'input', updDemo); });
  updDemo();

  pane.querySelectorAll('.hp-tier').forEach(el => {
    const commit = () => {
      if (!Array.isArray(settings.tiers)) settings.tiers = TIERS.map(t => t.max);
      settings.tiers[Number(el.dataset.i)] = Number(el.value) || 0;
    };
    onEv(el, 'input', () => { commit(); schedulePersist(); });
    onEv(el, 'change', () => { commit(); saveSettings(); });
  });
  pane.querySelectorAll('[data-tier]').forEach(el => {
    el.onclick = () => {
      pane.querySelectorAll('[data-tier]').forEach(x => x.classList.remove('on'));
      el.classList.add('on'); settings.tierSource = el.dataset.tier; saveSettings();
    };
  });
  pane.querySelectorAll('[data-cog]').forEach(el => {
    el.onclick = () => {
      pane.querySelectorAll('[data-cog]').forEach(x => x.classList.remove('on'));
      el.classList.add('on'); settings.cognitionMode = el.dataset.cog; saveSettings();
    };
  });

  pane.querySelectorAll('[data-api]').forEach(el => {
    // 【修 v1.9】原用 addEventListener，bindPane 被反复调用时会层层叠加；
    // 改成 on<event> 赋值：重复绑定只会覆盖，不会累积。
    // 【修 v1.23】只绑 change 时，移动端填完直接刷新/切后台不会失焦 → 值进不了 settings
    // → 刷新后 API 全空。现在 input 即时写内存并防抖落盘，change 再兜一次。
    const commit = () => {
      const i = Number(el.dataset.api), f = el.dataset.f;
      settings.apis[i] = settings.apis[i] || {};
      settings.apis[i][f] = (f === 'rpm' || f === 'concurrency') ? Number(el.value) : el.value;
      schedulePersist();
      if (f === 'name') {
        const body = pane.querySelector('#hp-api-body');
        if (body) { body.innerHTML = apiRowsHTML(); bindPane(host); }
      }
    };
    onEv(el, 'input', commit);
    onEv(el, 'change', () => { commit(); saveSettings(); });
  });
  onEv(pane.querySelector('#hp-api-add'), 'click', () => {
    if (!throttled('api-add', 500)) return;
    // 【v1.21】一键解除限速：并发开了却被 RPM 卡住是最常见的"并发没用"错觉
    pane.querySelectorAll('[data-unrpm]').forEach(b => {
      b.onclick = () => {
        const i = Number(b.dataset.unrpm);
        const a = settings.apis[i];
        if (!a) return;
        a.rpm = 0;
        saveSettings(); refreshPane();
        toast(`「${a.name}」RPM 已设为 0（不限速），并发 ${(Number(a.concurrency) || 0) + 1} 路现在能真正跑满`, 'ok');
      };
    });
    if (settings.apis.length >= 10) { toast('最多 10 条 API', 'err'); return; }
    // 【修 v1.9】不再预设用途类型：由用户在下方「用途」里自己勾选
    settings.apis.push({ name: 'api' + (settings.apis.length + 1), uses: ['embed', 'rerank', 'llm'], base: '', key: '', model: '', rpm: 60, concurrency: 0 });
    saveSettings();
    pane.querySelector('#hp-api-body').innerHTML = apiRowsHTML();
    bindPane(host);
  });
  pane.querySelectorAll('[data-use]').forEach(el => {
    el.onclick = () => {
      const i = Number(el.dataset.i), u = el.dataset.use, a = settings.apis[i];
      if (!a) return;
      const cur = Array.isArray(a.uses) ? a.uses.slice() : apiUses(a);
      const at = cur.indexOf(u);
      if (at >= 0) cur.splice(at, 1); else cur.push(u);
      a.uses = cur; saveSettings();
      el.classList.toggle('on', cur.includes(u));
      toast(`「${a.name}」用途：${cur.length ? cur.join(' / ') : '未勾选（将作为通用备用）'}`, 'ok');
    };
  });
  /* 【v1.20】提示词恢复默认：新版深化了 ④⑤⑥⑦ 四套，本地改过的需手动点一下才换新版 */
  pane.querySelectorAll('[data-act="preset"]').forEach(el => {
    el.onclick = () => {
      const k = el.dataset.pk;
      const def = PROMPT_KEYS.find(x => x.key === k);
      if (!def) return;
      settings.prompts = settings.prompts || {};
      settings.prompts[k] = Object.assign({}, settings.prompts[k], { text: def.def });
      saveSettings();
      const ta = pane.querySelector(`textarea[data-pk="${k}"]`);
      if (ta) ta.value = def.def;
      toast(`「${def.label}」已恢复为新版默认`, 'ok');
      paintPFlags(pane);
    };
  });
  pane.querySelectorAll('[data-act="presetall"]').forEach(el => {
    el.onclick = () => {
      settings.prompts = settings.prompts || {};
      PROMPT_KEYS.forEach(p => {
        if (p.apiOnly) return;
        settings.prompts[p.key] = Object.assign({}, settings.prompts[p.key], { text: p.def });
        const ta = pane.querySelector(`textarea[data-pk="${p.key}"]`);
        if (ta) ta.value = p.def;
      });
      saveSettings();
      toast('全部提示词已恢复为新版默认', 'ok');
      paintPFlags(pane);
    };
  });
  paintPFlags(pane);

  pane.querySelectorAll('[data-act="del"]').forEach(el => {
    el.onclick = () => {
      const i = Number(el.dataset.i);
      const nm = settings.apis[i]?.name;
      const ref = PROMPT_KEYS.filter(p => settings.prompts[p.key]?.api === nm).map(p => p.label);
      if (ref.length && !confirm(`「${nm}」正被以下提示词引用：\n${ref.join('、')}\n确定删除？`)) return;
      settings.apis.splice(i, 1); saveSettings();
      pane.querySelector('#hp-api-body').innerHTML = apiRowsHTML();
      bindPane(host);
    };
  });
  pane.querySelectorAll('[data-act="fetch"]').forEach(el => {
    el.onclick = async () => {
      const i = Number(el.dataset.i), a = settings.apis[i];
      if (!a?.base || !a?.key) { toast('请先填写 Base URL 与 Key', 'err'); return; }
      el.textContent = '…'; el.disabled = true;
      try {
        const r = await fetch(String(a.base).replace(/\/+$/, '') + '/models', {
          headers: { Authorization: 'Bearer ' + a.key },
        });
        if (!r.ok) {
          const why = r.status === 401 ? 'Key 错误' : r.status === 404 ? 'Base URL 或路径错误' : '可能被 CORS 拦截（该 API 不支持浏览器直连）';
          toast(`拉取失败 ${r.status}：${why}`, 'err');
          return;
        }
        const j = await r.json();
        const list = (j.data || j.models || [])
          .map(m => (typeof m === 'string' ? m : (m.id || m.name)))
          .filter(Boolean);
        if (!list.length) { toast('拉取成功但模型列表为空', 'err'); return; }
        a.models = list; saveSettings();
        // 【修 v1.10】原用 prompt 让用户手抄模型 ID：易抄错、还能随便填个不存在的。
        // 改为弹出可点击的模型列表，点一下即选中；仍保留"手动输入"兜底。
        openModelPicker(list, a.model, (picked) => {
          if (!picked) return;
          a.model = picked; saveSettings();
          const b = pane.querySelector('#hp-api-body');
          if (b) { b.innerHTML = apiRowsHTML(); bindPane(host); }
          toast('已选择模型：' + picked, 'ok');
        });
        toast(`拉取到 ${list.length} 个模型，请在弹出列表中点击选择`, 'ok');
      } catch (e) {
        toast('拉取失败：' + e.message + '（多为 CORS，需该 API 支持浏览器直连）', 'err');
      } finally { el.textContent = '拉取'; el.disabled = false; }
    };
  });
  onEv(pane.querySelector('#hp-api-save'), 'click', () => {
    saveSettings();
    paintApiStore(pane);
    toast('已保存到浏览器本地（Key 存 localStorage）', 'ok');
  });
  /* 【修 v1.24】存储自检：把"到底存没存住"直接显示在面板上，不用靠猜 */
  paintApiStore(pane);
  onEv(pane.querySelector('#hp-api-export'), 'click', () => {
    try {
      const blob = new Blob([JSON.stringify({ __hpApis: 1, t: Date.now(), apis: settings.apis }, null, 2)],
        { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'HP-DeepLore-API配置.json';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('已导出 API 配置（含 Key，请妥善保管）', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  });
  onEv(pane.querySelector('#hp-api-import'), 'click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const j = JSON.parse(String(r.result));
          const arr = Array.isArray(j) ? j : j.apis;
          if (!Array.isArray(arr)) throw new Error('文件里没有 apis 数组');
          settings.apis = arr.slice(0, 10).map(a => Object.assign(
            { name: 'api', uses: ['llm'], base: '', key: '', model: '', rpm: 60, concurrency: 0 }, a));
          saveSettings(); refreshPane();
          toast(`已导入 ${settings.apis.length} 条 API`, 'ok');
        } catch (e) { toast('导入失败：' + e.message, 'err'); }
      };
      r.readAsText(f);
    };
    inp.click();
  });
  pane.querySelectorAll('[data-preset]').forEach(el => {
    el.onclick = () => {
      const p = PRESETS[el.dataset.preset];
      const i = settings.apis.length - 1;
      if (i < 0) { toast('请先点「＋ 新增」创建一条 API', 'err'); return; }
      settings.apis[i].base = p.base;
      if (!settings.apis[i].name || /^api\d+$/.test(settings.apis[i].name)) settings.apis[i].name = p.name;
      saveSettings(); pane.querySelector('#hp-api-body').innerHTML = apiRowsHTML(); bindPane(host);
    };
  });
  pane.querySelectorAll('.hp-papi').forEach(el => {
    const commit = () => {
      const k = el.dataset.pk;
      settings.prompts[k] = settings.prompts[k] || {};
      settings.prompts[k].api = el.value;
    };
    onEv(el, 'input', () => { commit(); schedulePersist(); });
    onEv(el, 'change', () => { commit(); saveSettings(); });
  });
  pane.querySelectorAll('.hp-ptxt').forEach(el => {
    const commit = () => {
      const k = el.dataset.pk;
      settings.prompts[k] = settings.prompts[k] || {};
      settings.prompts[k].text = el.value;
    };
    onEv(el, 'input', () => { commit(); schedulePersist(); });
    onEv(el, 'change', () => { commit(); saveSettings(); });
  });
  const txtEl = pane.querySelector('[data-txt]');
  if (txtEl) {
    const commit = () => { settings[txtEl.dataset.txt] = txtEl.value; };
    onEv(txtEl, 'input', () => { commit(); schedulePersist(); });
    onEv(txtEl, 'change', () => { commit(); saveSettings(); });
  }

  /* 【v1.18】记忆面板 */
  const memLog = () => pane.querySelector('#hp-mem-log');
  const memSay = (t) => { const el = memLog(); if (el) el.textContent = t; };
  const probeBtn = pane.querySelector('#hp-mem-probe');
  if (probeBtn) probeBtn.onclick = async () => {
    if (!throttled('memprobe', 600)) return;
    memSay('检测中…');
    await memProbe(true);
    memPanePaint();
    const s2 = MEM_STATE;
    memSay(s2.ok
      ? `✅ 已连接（${s2.ms}ms）\n` + JSON.stringify(s2.stats || {}, null, 2)
      : `❌ 未连接\n原因：${s2.err || '未知'}\n地址：${memBaseUrl()}\n\n排查：\n1. Termux 里 python3 hp_memory_server.py 8899 起了吗\n2. 地址对不对（本机的 127.0.0.1，不是电脑的）\n3. 浏览器能直连该端口吗（CORS）`);
  };
  const syncBtn = pane.querySelector('#hp-mem-sync');
  if (syncBtn) syncBtn.onclick = async () => {
    if (!throttled('memsync', 1500)) return;
    memSay('更新中…（抽取 → 向量 → 写入）');
    const r = await memUpdate();
    memSay(r.ok
      ? `✅ 完成\n新增事件 ${r.added || 0} 条${r.promises ? ` · 承诺 ${r.promises} 条` : ''}\n已同步到第 ${settings.memLastFloor} 楼`
      : `未更新\n原因：${r.reason || '未知'}`);
  };
  const resetBtn = pane.querySelector('#hp-mem-reset');
  if (resetBtn) resetBtn.onclick = () => {
    if (!throttled('memreset', 600)) return;
    settings.memLastFloor = 0; saveSettings();
    memSay('同步进度已重置为 0，下次更新会重新扫描全部消息。');
  };
  const statsBtn = pane.querySelector('#hp-mem-stats');
  if (statsBtn) statsBtn.onclick = async () => {
    if (!throttled('memstats', 800)) return;
    try {
      const j = await memFetch('/stats');
      memSay(JSON.stringify(j.stats || j, null, 2));
    } catch (e) { memSay('读取统计失败：' + e.message); }
  };
  const testBtn = pane.querySelector('#hp-mem-test');
  if (testBtn) testBtn.onclick = async () => {
    if (!throttled('memtest', 1200)) return;
    memSay('检索中…');
    try {
      const sd = getStatData();
      const q = pane.querySelector('#hp-test-q')?.value || '德拉科';
      const items = await memRetrieve(q, sd, currentGrade(sd));
      if (!items) { memSay('检索失败或记忆库未连接'); return; }
      memSay(`命中 ${items.length} 条\n\n` + items.slice(0, 12).map((it, i) =>
        `${i + 1}. [${it.ago || '—'}] ${it.text}\n   score=${it.score} bucket=${it.bucket}${it.reaction ? ' reaction=' + it.reaction : ''}`).join('\n'));
    } catch (e) { memSay('检索失败：' + e.message); }
  };
  const graphBtn = pane.querySelector('#hp-mem-graph');
  if (graphBtn) graphBtn.onclick = () => { if (throttled('memgraph', 800)) showMemoryGraph(); };
  const wipeBtn = pane.querySelector('#hp-mem-wipe');
  if (wipeBtn) wipeBtn.onclick = async () => {
    if (!throttled('memwipe', 3000)) return;
    if (!window.confirm('确定清空记忆库全部事件与承诺？此操作不可撤销。')) return;
    try {
      await memPost('/admin/clear', { confirm: true });
      settings.memLastFloor = 0; saveSettings();
      memSay('已清空。');
    } catch (e) { memSay('清空失败：' + e.message); }
  };
  /* 打开记忆面板即自动探一次；开启自动复检则周期性探测 */
  if (pane.querySelector('#hp-mem-out')) {
    memProbe(true).then(() => memPanePaint());
    if (UI.__memTimer) clearInterval(UI.__memTimer);
    if (settings.memEnabled && settings.memAutoProbe) {
      UI.__memTimer = setInterval(() => {
        if (!settings.memEnabled || !UI.modalOpen) return;
        memProbe(true).then(() => memPanePaint());
      }, Math.max(5, Number(settings.memProbeSec) || 20) * 1000);
    }
  }

  /* 索引面板 */
  /* ---- 文件选择区：拖拽 + 点击 + 选中后显示文件名 ---- */
  const fileInput = pane.querySelector('#hp-file');
  const drop = pane.querySelector('#hp-drop');
  const sel = pane.querySelector('#hp-dropsel');

  /* 【修 v1.10】切换面板 / 关闭重开 / 刷新后，从已保存的数据恢复显示。
     此前只在用户"刚选完文件"时才显示，其他情况一律空白，
     但下方状态区却写着有这本小说 → 用户以为没保存成功而重复上传。 */
  (async () => {
    try {
      const n = await idbGet(STORE.novel, 'main');
      if (!n || !drop || !sel) return;
      // 面板可能已被切走，元素不再存在
      if (!document.body.contains(drop)) return;
      const mb = (n.size / 1048576).toFixed(2);
      const kb = (n.size / 1024).toFixed(0);
      const sizeTxt = n.size >= 1048576 ? `${mb} MB` : `${kb} KB`;
      sel.innerHTML = `<b>${esc(n.name || '已保存的小说')}</b><span>${sizeTxt} · 已保存在本地（${(n.text || '').length} 字）· 可重新选择文件覆盖</span>`;
      sel.classList.add('on');
      drop.classList.add('has');
    } catch (e) { /* 忽略 */ }
  })();
  const showSel = (f) => {
    if (!sel) return;
    if (!f) { sel.classList.remove('on'); sel.textContent = ''; drop.classList.remove('has'); return; }
    const mb = (f.size / 1048576).toFixed(2);
    const isJson = /\.json$/i.test(f.name);
    sel.innerHTML = `<b>${esc(f.name)}</b><span>${mb} MB${isJson ? ' · 备份文件（点「导入备份」恢复）' : ' · 点「保存到本地」'}</span>`;
    sel.classList.add('on');
    drop.classList.add('has');
  };
  onEv(fileInput, 'change', () => {
    const f = fileInput.files?.[0];
    showSel(f);
    if (f && !/\.json$/i.test(f.name)) toast('已选中：' + f.name + '，点「保存到本地」写入', 'ok');
  });
  if (drop && fileInput) {
    onEv(drop, 'click', e => { if (e.target !== fileInput) fileInput.click(); });
    ['dragenter', 'dragover'].forEach(ev => onEv(drop, ev, e => {
      e.preventDefault(); e.stopPropagation(); drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(ev => onEv(drop, ev, e => {
      e.preventDefault(); e.stopPropagation(); drop.classList.remove('over');
    }));
    onEv(drop, 'drop', e => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      try { fileInput.files = e.dataTransfer.files; } catch (err) { /* 部分浏览器只读，用记忆值兜底 */ }
      window.__hp_pickedFile = f;
      showSel(f);
      if (!/\.json$/i.test(f.name)) toast('已拖入：' + f.name + '，点「保存到本地」写入', 'ok');
    });
  }

  onEv(pane.querySelector('#hp-save-txt'), 'click', async () => {
    const __b = pane.querySelector('#hp-save-txt'); const __d = markBusy(__b, '保存中…');
    try {
    const f = pane.querySelector('#hp-file')?.files?.[0] || window.__hp_pickedFile;
    if (!f) { toast('请先在上方选择 txt 文件（点击虚线框或把文件拖进去）', 'err'); return; }
    const txt = await f.text();
    await idbSet(STORE.novel, 'main', { name: f.name, text: txt, size: txt.length, at: Date.now() });
    settings.novelMeta = { name: f.name, size: txt.length, at: Date.now() }; saveSettings();
    // 【v1.16】保存后立刻诊断章节能否解析，别等到建索引才报"未识别到章节"
    const d = diagnoseNovel(txt);
    const stn = pane.querySelector('#hp-idx-status');
    if (d.strict > 0) {
      toast(`已保存：${f.name}（${txt.length} 字）· 检测到 ${d.strict} 章`, 'ok');
      if (stn) stn.innerHTML = `<div style="color:var(--hp-acc)">✓ 检测到 <b>${d.strict}</b> 章，可以建索引</div>`;
    } else if (d.loose > 0) {
      toast(`已保存，但检测到 ${d.loose} 章为宽松格式（无年级/日期）`, 'err');
      if (stn) stn.innerHTML = [
        '<div style="color:#d6a84a">⚠ 宽松格式：识别到 ' + d.loose + ' 章，但缺少年级与日期</div>',
        '这种格式没有真实时间轴，<b>防未来泄露</b>与「已亲历/世界历史」判定会失效。',
        '建议使用整理版 txt，格式应为：',
        '<code>一年级 | 阿兹卡班的囚徒 | 1993-09-01 | 第1章</code>',
        '',
        '你这份文件开头：',
        '<pre style="margin:6px 0;padding:8px;background:var(--hp-card);border-radius:6px;font-size:11px;white-space:pre-wrap">' + esc(d.sample) + '</pre>',
        (d.crlf ? '· 检测到 <b>CRLF 换行</b>（Windows 另存），已自动容错。' : ''),
      ].filter(Boolean).join('<br>');
    } else {
      toast('已保存，但一个章节都没识别到，无法建索引', 'err');
      if (stn) stn.innerHTML = [
        '<div style="color:#c85a5a">✕ 未识别到章节</div>',
        '期望格式（每行一章）：',
        '<code>一年级 | 阿兹卡班的囚徒 | 1993-09-01 | 第1章</code>',
        '',
        '你这份文件开头：',
        '<pre style="margin:6px 0;padding:8px;background:var(--hp-card);border-radius:6px;font-size:11px;white-space:pre-wrap">' + esc(d.sample) + '</pre>',
        (d.crlf ? '· 检测到 <b>CRLF 换行</b>（Windows 另存），已自动容错。' : ''),
        (d.bom ? '· 检测到 <b>BOM 头</b>，已自动容错。' : ''),
      ].filter(Boolean).join('<br>');
    }
    updateIdxStatus(pane);
    } finally { __d(); }
  });
  onEv(pane.querySelector('#hp-del-txt'), 'click', async () => {
    if (!confirm('删除本地保存的小说？索引仍在，可重新上传。')) return;
    await idbDel(STORE.novel, 'main'); settings.novelMeta = null; saveSettings(); updateIdxStatus(pane);
  });
  onEv(pane.querySelector('#hp-sample'), 'click', async () => {
    const __b = pane.querySelector('#hp-sample'); const __d = markBusy(__b, '采样中…');
    try {
    try {
      const s = await autoSample();
      toast(`自动采样完成，共 ${s.length} 段（见下方状态区）`, 'ok');
      const st = pane.querySelector('#hp-idx-status');
      if (st) st.textContent = s.map(x => `· 第${x.ch}章 ${x.date}（${x.text.length}字）`).join('\n');
    } catch (e) { toast('采样失败：' + e.message, 'err'); }
    } finally { __d(); }
  });
  onEv(pane.querySelector('#hp-suggest'), 'click', async () => {
    const __b = pane.querySelector('#hp-suggest'); const __d = markBusy(__b, '分析中…');
    try {
    try {
      const v = await suggestChunk();
      const el = pane.querySelector('[data-num="chunkSize"]');
      if (el) el.value = v;
      settings.chunkSize = v; saveSettings();
      toast(`推荐块大小：${v} 字（已填入，可自行修改）`, 'ok');
    } catch (e) { toast('推荐失败：' + e.message, 'err'); }
    } finally { __d(); }
  });
  onEv(pane.querySelector('#hp-build'), 'click', async () => {
    const __b = pane.querySelector('#hp-build'); const __d = markBusy(__b, '建索引中…');
    try {
    const st = pane.querySelector('#hp-idx-status');
    try {
      const meta = await buildIndex(t => { if (st) st.textContent = t; });
      // 【修】此前直接 dump JSON，手机上是一大坨看不懂的字符
      const vecTxt = meta.vec ? `有向量（${meta.vecModel}）` : '无向量（仅关键词检索）';
      if (st) st.textContent = [
        '✅ 索引已建立',
        `小说：${meta.novel}（${meta.novelSize} 字）`,
        `章节：${meta.chapters} 章 | 切块：${meta.chunks} 块`,
        `参数：块 ${meta.chunkSize} 字，重叠 ${meta.overlap} 字`,
        `向量：${vecTxt}`,
        `角色：${meta.chars} 人`,
        meta.pending ? `⚠ 未向量化：${meta.pending} 块（再点建索引可续建）` : '',
      ].filter(Boolean).join('\n');
      toast(`建索引完成：${meta.chunks} 块，${vecTxt}`, 'ok');
    } catch (e) { if (st) st.textContent = '失败：' + e.message; toast('建索引失败：' + e.message, 'err'); }
    } finally { __d(); }
  });
  onEv(pane.querySelector('#hp-build-stop'), 'click', () => {
    abortBuild();
    toast('已发出中止指令，正在保存已完成部分…', 'ok');
  });
  onEv(pane.querySelector('#hp-idx-chk'), 'click', async () => {
    const __b = pane.querySelector('#hp-idx-chk'); const __d = markBusy(__b, '体检中…');
    try {
    const r = await checkIndex();
    const st = pane.querySelector('#hp-idx-status');
    if (st) st.innerHTML = `<div style="font-weight:600;color:var(--hp-acc);margin-bottom:8px">${r.ok ? '✓ 索引健康' : '✕ 发现问题'}</div>` + checkIndexHTML(r);
    toast(r.ok ? '体检完成' : '体检发现问题，见状态区', r.ok ? 'ok' : 'err');
    } finally { __d(); }
  });
  onEv(pane.querySelector('#hp-export'), 'click', async () => {
    const btn = pane.querySelector('#hp-export');
    const done = markBusy(btn, '导出中…');
    try {
      const n = await idbGet(STORE.novel, 'main'), ix = await idbGet(STORE.index, 'main'), al = await idbGet(STORE.alias, 'main');
      // 【修】此前无论有没有数据都静默导出空文件，用户以为按钮坏了
      if (!n && !ix && !al) { toast('暂无可导出的内容：请先保存小说 txt 或建立索引', 'err'); return; }
      const parts = [n && '小说', ix && '索引', al && '别名'].filter(Boolean).join(' + ');
      const blob = new Blob([JSON.stringify({ novel: n, index: ix, alias: al, settings })], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hp-deeplore-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast('已导出备份（' + parts + '，' + (blob.size / 1048576).toFixed(2) + ' MB）', 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
    finally { done(); }
  });
  onEv(pane.querySelector('#hp-import'), 'click', async () => {
    const __b = pane.querySelector('#hp-import'); const __d = markBusy(__b, '导入中…');
    try {
    const f = pane.querySelector('#hp-file')?.files?.[0] || window.__hp_pickedFile;
    if (!f) { toast('请先选择备份 json 文件', 'err'); return; }
    try {
      const j = JSON.parse(await f.text());
      if (j.novel) await idbSet(STORE.novel, 'main', j.novel);
      if (j.index) await idbSet(STORE.index, 'main', j.index);
      if (j.alias) { await idbSet(STORE.alias, 'main', j.alias); settings.aliasMap = j.alias; }
      if (j.settings) settings = Object.assign(structuredClone(DEFAULTS), j.settings);
      saveSettings();
      toast('导入完成', 'ok');
      updateIdxStatus(pane);
    } catch (e) { toast('导入失败：' + e.message, 'err'); }
    } finally { __d(); }
  });
  onEv(pane.querySelector('#hp-clear-idx'), 'click', async () => {
    const __b = pane.querySelector('#hp-clear-idx'); const __d = markBusy(__b, '清空中…');
    try {
    if (!confirm('清空索引？需重新建索引才能检索。')) return;
    await idbDel(STORE.index, 'main'); settings.indexMeta = null; saveSettings(); updateIdxStatus(pane);
    } finally { __d(); }
  });

  /* 调试面板 */
  onEv(pane.querySelector('#hp-dbg'), 'click', () => {
    const sd = getStatData();
    const present = Object.keys(sd?.当前场景?.在场角色 || {});
    const out = {
      变量来源: sd && Object.keys(sd).length ? '已读到（' + Object.keys(sd).length + ' 个根键）' : '未读到 → 插件降级',
      当前时间: sd?.世界?.当前时间 ?? '(无)',
      事件年代: sd?.世界?.事件年代 ?? '(无)',
      当前地点: sd?.世界?.当前地点 ?? '(无)',
      判定年级: currentGrade(sd) + '（' + (LABEL_MAP[currentGrade(sd)] || '') + '，原著' + (ORIG_MAP[currentGrade(sd)] || '') + '）',
      在场角色: present.map(id => `${id}(${sd?.NPC档案?.[id]?.姓名 || '?'})`),
      离场关注: Object.keys(sd?.当前场景?.离场关注 || {}).length,
      已结算节点: Object.keys(sd?.世界线?.已结算节点 || {}).length,
      关系路线: sd?.世界线?.关系路线进程 ?? '(无)',
      NPC情绪字段: present.map(id => `${sd?.NPC档案?.[id]?.姓名 || id}: ${sd?.NPC档案?.[id]?.当前情绪 || '(空)'}`),
      API: settings.apis.map(a => `${a.name}[${a.type}]${a.model ? '=' + a.model : '(未选模型)'}`),
      本月用量: statGet(),
    };
    pane.querySelector('#hp-dbg-out').textContent = JSON.stringify(out, null, 2);
  });
  onEv(pane.querySelector('#hp-chk'), 'click', async () => {
    const __b = pane.querySelector('#hp-chk'); const __d = markBusy(__b, '体检中…');
    try {
    const r = await checkIndex();
    const out = pane.querySelector('#hp-dbg-out');
    if (out) out.innerHTML = `<div style="margin-bottom:8px;font-weight:600;color:var(--hp-acc)">${r.ok ? '✓ 索引健康' : '✕ 发现问题，需要重建'}</div>` + checkIndexHTML(r);
    toast(r.ok ? '体检完成，未发现严重问题' : '体检发现问题，见调试区', r.ok ? 'ok' : 'err');
    } finally { __d(); }
  });
  onEv(pane.querySelector('#hp-diag'), 'click', () => {
    const txt = diagText();
    const done = () => toast('诊断信息已复制，可直接发给我排查（不含任何 Key）', 'ok');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(() => {
        const out = pane.querySelector('#hp-dbg-out');
        if (out) out.textContent = txt;
        toast('自动复制失败，已显示在下方，请手动复制', 'err');
      });
    } else {
      const out = pane.querySelector('#hp-dbg-out');
      if (out) out.textContent = txt;
      toast('已显示在下方，请手动复制', 'ok');
    }
  });
  onEv(pane.querySelector('#hp-eff'), 'click', () => {
    const out = pane.querySelector('#hp-dbg-out');
    const L = INJECT_LOG;
    if (!L.length) { if (out) out.textContent = '尚无注入记录。发一条消息后即可看到。'; return; }
    const last = L[L.length - 1];
    const rows = L.slice(-8).reverse().map((r, i) => {
      const t = new Date(r.at).toLocaleTimeString('zh-CN');
      const ad = r.adoption != null ? `采信 ${r.adoption}% ${r.adoptionLabel || ''}` : '（未生成回复）';
      return `${i === 0 ? '▶' : '　'} ${t}　第${(r.chapters || []).join('、') || '—'}章　${r.chars}段/${r.blocks ? r.blocks.reduce((a, b) => a + b, 0) : 0}块　${r.tokens}tok　${ad}`;
    }).join('\n');
    const head = `最近注入 ${L.length} 轮（最多记 20）\n` +
      `本轮：${LABEL_MAP[last.grade] || last.grade} · 主交互 ${last.main || '—'} · 德拉科细化 ${last.draco ? '有' : '无'} · 台词 ${last.lines} 句\n` +
      `截断 ${last.truncated} 章 / 已亲历 ${last.lived} 章\n\n`;
    if (out) out.textContent = head + rows;
  });
  onEv(pane.querySelector('#hp-scan-chars'), 'click', async () => {
    const __b = pane.querySelector('#hp-scan-chars'); const __d = markBusy(__b, '扫描中…');
    try {
    const n = await idbGet(STORE.novel, 'main');
    const box = pane.querySelector('#hp-scan-out');
    if (!n?.text) { if (box) box.innerHTML = '<div style="color:#c85a5a">请先保存小说 txt</div>'; return; }
    const minHits = Number(pane.querySelector('#hp-scan-min')?.value) || 30;
    const cands = scanMoreChars(n.text, minHits);
    if (!box) return;
    if (!cands.length) {
      box.innerHTML = `<div style="font-size:12px;color:var(--hp-tx3)">未发现新角色（阈值 ${minHits} 次）。可调低阈值再试。</div>`;
      return;
    }
    box.innerHTML = `<div class="hp-hint" style="margin-bottom:6px">发现 ${cands.length} 个候选，点「加入」写进别名表：</div>
      <div class="hp-chips">${cands.map(c => `<span class="hp-chip" data-addchar="${esc(c.name)}" data-hits="${c.hits}" title="出现 ${c.hits} 次">${esc(c.name)} <b style="opacity:.6">${c.hits}</b></span>`).join('')}</div>`;
    box.querySelectorAll('[data-addchar]').forEach(el => {
      el.onclick = () => {
        const nm = el.dataset.addchar;
        addCharToAlias(nm, Number(el.dataset.hits) || 0);
        el.style.opacity = '.4'; el.textContent = nm + ' ✓';
        const host = pane.querySelector('#hp-alias');
        if (host) host.innerHTML = aliasRowsHTML();
        bindAliasInputs(pane); bindAliasDelete(pane);
        toast('已加入：' + nm, 'ok');
      };
    });
    } finally { __d(); }
  });
  bindAliasInputs(pane); bindAliasDelete(pane);
  onEv(pane.querySelector('#hp-clear-cache'), 'click', async () => {
    const __b = pane.querySelector('#hp-clear-cache'); const __d = markBusy(__b, '清空中…');
    try {
    const ks = await idbKeys(STORE.cache);
    for (const k of ks) await idbDel(STORE.cache, k);
    toast('已清空 ' + ks.length + ' 条缓存', 'ok');
    } finally { __d(); }
  });
  onEv(pane.querySelector('#hp-cmp'), 'click', async () => {
    const __b = pane.querySelector('#hp-cmp'); const __d = markBusy(__b, '对比中…');
    try {
    const q = String(pane.querySelector('#hp-test-q')?.value || '').trim() || '德拉科在休息室';
    const sd = getStatData();
    const g = currentGrade(sd);
    const r = await compareRetrieve(q, g, sd, {});
    const out = pane.querySelector('#hp-dbg-out');
    if (!out) return;
    const L = [];
    L.push(`查询：${r.query}　年级：${LABEL_MAP[g] || g}`);
    L.push('');
    L.push('■ 关键词检索（jaccard）');
    r.kw.forEach((x, i) => L.push(`  ${i + 1}. 第${x.chapter}章 ${x.date || ''} ${x.score}  ${x.text}`));
    L.push('');
    if (r.vec) {
      L.push('■ 向量检索（cosine）');
      r.vec.forEach((x, i) => L.push(`  ${i + 1}. 第${x.chapter}章 ${x.date || ''} ${x.score}  ${x.text}`));
      L.push('');
      L.push(`重合度：${r.overlap}%（共同命中 ${r.common.length} 章）`);
      L.push(r.overlap >= 70 ? '→ 关键词已够用，embedding 收益有限'
        : (r.overlap >= 40 ? '→ 有一定差异，配 embedding 会更准' : '→ 差异很大，建议配 embedding'));
    } else {
      L.push('■ 向量检索：' + (r.vecErr || '不可用'));
    }
    out.textContent = L.join('\n');
    toast(r.vec ? `对比完成，重合 ${r.overlap}%` : ('向量不可用：' + r.vecErr), r.vec ? 'ok' : 'err');
    } finally { __d(); }
  });
  onEv(pane.querySelector('#hp-test-ret'), 'click', async () => {
    const __b = pane.querySelector('#hp-test-ret'); const __d = markBusy(__b, '检索中…');
    try {
    const q = pane.querySelector('#hp-test-q')?.value || '';
    const outEl = pane.querySelector('#hp-dbg-out');
    outEl.textContent = '检索中…';
    try {
      const sd = getStatData();
      const g = currentGrade(sd);
      const q2 = await rewriteQuery(q, sd, g);
      const r = await retrieve(q2, g, sd, {});
      outEl.textContent = `查询改写：${q2}\n年级：${g}\n\n` +
        r.map((x, i) => `${i + 1}. 第${x.chapter}章 ${x.date}｜${x.lived ? '已亲历' : '世界历史'}｜相关度${x.score}｜精排${x.rr}\n${x.text.slice(0, 200)}…`).join('\n\n');
    } catch (e) { outEl.textContent = '检索失败：' + e.message; }
    } finally { __d(); }
  });

  /* 【v1.25】剧情进度控制：定位 + 启用/禁用世界书章节条目 */
  onEv(pane.querySelector('#hp-plot-wb'), 'click', async () => {
    const out = pane.querySelector('#hp-plot-out');
    try {
      const p = await wbProbe(true);
      const sp = wbSlashProbe();
      const slashInfo = sp.has
        ? `Slash 命令：可用（共 ${sp.total} 条）\n  相关命令：${sp.world.length ? sp.world.join('、') : '未能枚举'}\n  单条启停命令：${sp.entryCmd ? '有 ✓' : '未发现'}${sp.err ? '\n  （' + sp.err + '）' : ''}`
        : `Slash 命令：不可用（${sp.err}）`;
      const nm = wbCurrentName();
      const nameInfo = `世界书名：${nm || '拿不到 ← 这是读不通的主因'}`;
      out.textContent = p.ok
        ? `世界书检测成功\n来源：${p.src}\n${nameInfo}\n总条目：${p.count}\n剧情条目：${p.plotCount} 条${p.plotCount ? '（uid 900001 起，对应第 1 章）' : '（没找到 —— 确认 273 章剧情节点已导入世界书）'}\n\n${slashInfo}`
        : `检测失败：${p.err}\n\n${nameInfo}\n\n${slashInfo}\n\n排查顺序：\n1) 先在 ST 里打开一次世界书面板并选中一本（插件需要从下拉框读到名字）\n2) 确认世界书总开关是开着（可试 /world-on）\n3) 若条目能改但读不到列表，定位功能仍可用，只是无法自动启停`;
    } catch (e) { out.textContent = '检测出错：' + e.message; }
  });

  onEv(pane.querySelector('#hp-plot-dry'), 'click', async () => {
    const out = pane.querySelector('#hp-plot-out');
    out.textContent = '正在定位…';
    try {
      const sd = getStatData();
      const prev = recentContext(settings.historyTurns || 3).text;
      const r = await locateChapter(sd, prev, '');
      const n = Number(settings.plotRange) || 0;
      out.textContent = r.ok
        ? `试算结果：第 ${r.ch} 章（来源：${r.src}${r.guess ? '，日期法给的是第 ' + r.guess + ' 章' : ''}）\n理由：${r.why}\n\n将启用：第 ${Math.max(1, r.ch - n)} ~ ${r.ch + n} 章\n（本次只试算，未改动任何世界书条目）`
        : `定位失败：${r.why}`;
    } catch (e) { out.textContent = '定位出错：' + e.message; }
  });

  onEv(pane.querySelector('#hp-plot-run'), 'click', async () => {
    const out = pane.querySelector('#hp-plot-out');
    const btn = pane.querySelector('#hp-plot-run');
    btn.disabled = true; btn.textContent = '定位中…';
    try {
      const sd = getStatData();
      const prev = recentContext(settings.historyTurns || 3).text;
      const r = await locateChapter(sd, prev, '');
      if (!r.ok) { out.textContent = `定位失败：${r.why}`; return; }
      settings.plotLastCh = r.ch; settings.plotLastWhy = r.why; settings.plotLastAt = Date.now();
      saveSettings();
      if (!settings.plotCtlOn) {
        out.textContent = `已定位到第 ${r.ch} 章（${r.src}）\n理由：${r.why}\n\n但「启用剧情条目控制」是关的，所以没有改动世界书。\n打开上方开关后再点一次即可生效。`;
        return;
      }
      const a = await wbApplyChapter(r.ch, Number(settings.plotRange) || 0);
      const en = a.list.filter(x => !x.disable).map(x => '第' + x.ch + '章').join('、');
      const dis = a.list.filter(x => x.disable).length;
      out.textContent = `定位：第 ${r.ch} 章（${r.src}）\n理由：${r.why}\n\n`
        + (a.ok
          ? `已改动 ${a.changed} 条条目\n启用：${en || '（无需改动）'}\n禁用：${dis} 条\n写入方式：${a.src}`
          : `⚠ 世界书写入未成功：${a.err}\n\n应启用的章节：第 ${Math.max(1, r.ch - (Number(settings.plotRange) || 0))} ~ ${r.ch + (Number(settings.plotRange) || 0)} 章\n请在世界书里手动启用这些条目。`);
    } catch (e) { out.textContent = '执行出错：' + e.message; }
    finally { btn.disabled = false; btn.textContent = '现在定位一次'; }
  });

  onEv(pane.querySelector('#hp-plot-off'), 'click', async () => {
    const out = pane.querySelector('#hp-plot-out');
    try {
      const a = await wbApplyChapter(-999, 0);   // 范围不含任何章 → 全部禁用
      out.textContent = a.ok ? `已全部禁用（改动 ${a.changed} 条）\n写入方式：${a.src}` : `失败：${a.err}`;
    } catch (e) { out.textContent = '出错：' + e.message; }
  });
  pane.querySelectorAll('[data-ptapi]').forEach(el => {
    const commit = () => {
      const k = el.dataset.ptapi;
      settings.prompts[k] = settings.prompts[k] || {};
      settings.prompts[k].api = el.value;
    };
    onEv(el, 'input', () => { commit(); schedulePersist(); });
    onEv(el, 'change', () => { commit(); saveSettings(); });
  });

  updateIdxStatus(pane);
}

async function updateIdxStatus(pane) {
  const el = pane?.querySelector?.('#hp-idx-status');
  if (!el) return;
  const n = await idbGet(STORE.novel, 'main');
  const ix = await idbGet(STORE.index, 'main');
  const lines = [
    `小说：${n ? `${n.name}（${n.size} 字）` : '未保存 —— 请先在第 1 步选择 txt 并保存'}`,
    `索引：${ix ? `${ix.chunks.length} 块（${ix.meta?.chapters || '?'} 章）` : '未建立 —— 请先保存小说，再点第 3 步'}`,
  ];
  if (ix?.meta) lines.push(`向量：${ix.meta.vec ? '有（' + ix.meta.vecModel + '）' : '无（仅关键词检索，建议配置 embedding API 后重建）'}`);
  if (ix?.meta) lines.push(`参数：块 ${ix.meta.chunkSize} 字／重叠 ${ix.meta.overlap} 字｜角色 ${ix.meta.chars} 人`);
  el.textContent = lines.join('\n');
}


/* ==========================================================================
 * UI 层：魔法棒菜单入口 / 模态面板 / 浮动节点面板
 *  · 入口三处：魔法棒菜单（主）+ 浮动按钮（副）+ 降级齿轮
 *  · 模态：设置（8 面板）/ 节点进度 两个 tab，可拖拽、可缩放、ESC 关闭
 *  · 浮动节点面板：可拖拽、可折叠、可缩放，位置尺寸持久化
 * ========================================================================== */

const UI = {
  modal: null, mask: null, floating: null, fab: null,
  modalTab: 'set', modalOpen: false,
  panelTab: 0,
};

/* 双击标题栏复位：面板被拖到边角时一键拉回默认位置 */
function bindDblReset(box, handle, resetFn) {
  if (!handle) return;
  // 只跳过关闭/最小化/tab 这些有实际作用的按钮，
  // 标题文字与空白区都允许双击复位（否则很容易误判成"点在按钮上"而失效）
  const isFuncBtn = el => el && el.closest && el.closest('button.hp-x, .hp-tb-tab');
  handle.addEventListener('dblclick', e => {
    if (isFuncBtn(e.target)) return;
    e.preventDefault();
    resetFn();
  });
  // 移动端没有 dblclick：长按标题栏 0.5s 也复位
  let t = null;
  const start = e => {
    if (isFuncBtn(e.target)) return;
    t = setTimeout(() => { t = null; resetFn(); }, 500);
  };
  const end = () => { if (t) { clearTimeout(t); t = null; } };
  handle.addEventListener('touchstart', start, { passive: true });
  handle.addEventListener('touchend', end);
  handle.addEventListener('touchmove', end, { passive: true });
}

/* ---------------- 通用：拖拽 + 缩放 ---------------- */
function makeDraggable(box, handle, onMove) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  const down = e => {
    if (e.target.closest('.hp-nodrag')) return;
    if (e.target.closest('input,textarea,select,button,.hp-nv,.hp-ni,.hp-tg,.hp-chip,.hp-lore-head')) return;
    dragging = true;
    const p = e.touches ? e.touches[0] : e;
    sx = p.clientX; sy = p.clientY;
    const r = box.getBoundingClientRect();
    ox = r.left; oy = r.top;
    box.classList.add('hp-dragging');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up);
    e.preventDefault();
  };
  const move = e => {
    if (!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    let nx = ox + (p.clientX - sx);
    let ny = oy + (p.clientY - sy);
    nx = Math.max(4, Math.min(Math.max(4, window.innerWidth - box.offsetWidth - 8), nx));
    ny = Math.max(4, Math.min(Math.max(4, window.innerHeight - 40), ny));
    box.style.left = nx + 'px';
    box.style.top = ny + 'px';
    box.style.right = 'auto';
    box.style.bottom = 'auto';
    if (e.touches) e.preventDefault();
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    box.classList.remove('hp-dragging');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', up);
    // 松手后立刻归位：保证标题栏与关闭按钮始终在视口内
    clampIntoView(box === UI.modal ? 'modal' : (box === UI.floating ? 'float' : null));
    const r = box.getBoundingClientRect();
    if (onMove) onMove(Math.round(r.left), Math.round(r.top));
  };
  (handle || box).addEventListener('mousedown', down);
  (handle || box).addEventListener('touchstart', down, { passive: false });
}

function makeResizable(box, onResize) {
  const g = document.createElement('div');
  g.className = 'hp-resize';
  g.innerHTML = '<span></span>';
  box.appendChild(g);
  let sx = 0, sy = 0, ow = 0, oh = 0, sw = 0, sh = 0, resizing = false;
  const down = e => {
    resizing = true;
    const p = e.touches ? e.touches[0] : e;
    sx = p.clientX; sy = p.clientY;
    const r = box.getBoundingClientRect();
    ow = r.width; oh = r.height; sw = r.left; sh = r.top;
    box.classList.add('hp-dragging');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up);
    e.stopPropagation(); e.preventDefault();
  };
  const MINW = 360, MINH = 240;
  const move = e => {
    if (!resizing) return;
    const p = e.touches ? e.touches[0] : e;
    let w = ow + (p.clientX - sx);
    let h = oh + (p.clientY - sy);
    // 上限：不超出视口右/下边界（避免手柄跑到屏幕外导致无法继续操作）
    const maxW = Math.max(MINW, window.innerWidth - sw - 8);
    const maxH = Math.max(MINH, window.innerHeight - sh - 8);
    w = Math.max(MINW, Math.min(maxW, w));
    h = Math.max(MINH, Math.min(maxH, h));
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    if (e.touches) e.preventDefault();
  };
  const up = () => {
    if (!resizing) return;
    resizing = false;
    box.classList.remove('hp-dragging');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', up);
    // 缩放后同样归位，避免放大到屏幕外
    clampIntoView(box === UI.modal ? 'modal' : (box === UI.floating ? 'float' : null));
    const r = box.getBoundingClientRect();
    if (onResize) onResize(Math.round(r.width), Math.round(r.height));
  };
  g.addEventListener('mousedown', down);
  g.addEventListener('touchstart', down, { passive: false });
}

/* --------------------------------------------------------------------------
 * 幂等事件绑定
 * 【修 v1.9】此前 bindPane 内部大量使用 addEventListener，而它在多处被重复调用
 * （新增/删除 API、改设置后都会再调一次）。#hp-api-add 这类元素不在被 innerHTML
 * 重绘的容器里，所以每次 bindPane 都会往同一个元素上再叠一层监听器：
 *   第1次点 → 加1条（剩2个监听器）
 *   第2次点 → 加2条（剩3个）
 *   第3次点 → 加3条 …… 呈倍数暴涨，直到撞上 10 条上限。
 * 解决办法：一律用 on<event> 赋值（重复绑定会覆盖而非叠加）。
 * -------------------------------------------------------------------------- */
function onEv(el, ev, fn) {
  if (!el || typeof fn !== 'function') return;
  const key = 'on' + ev;
  try { el[key] = fn; } catch (e) { /* 只读元素忽略 */ }
}

/* --------------------------------------------------------------------------
 * 面板内状态提示：手机上 alert 体验差且可能被屏蔽，
 * 所有操作结果统一显示在面板底部状态条中。
 * -------------------------------------------------------------------------- */
let __toastTimer = null;
/* 提示自动消失时长（毫秒）。
   【v1.20】busy 由 60s 改为 20s：进度类消息本就该走面板状态区，
   万一走了 toast，也不该霸占屏幕一分钟。 */
const TOAST_MS = { ok: 3200, err: 8000, busy: 20000, warn: 6000 };
/* 用户手动关掉的消息文本：短时间内不再自动弹同样的，避免"关了又来" */
const __toastMuted = new Map();

function hideToast(silentAlso) {
  const el = document.getElementById('hp-toast');
  if (el) { el.classList.remove('on'); if (silentAlso) __toastMuted.set(el.dataset.sig || '', Date.now()); }
  clearTimeout(__toastTimer);
}

/* 【v1.20】状态条重写。此前的问题：
   ① 每次 toast() 都重建 innerHTML —— 正在读的消息会被下一条瞬间顶掉；
   ② busy 60s 且每次新消息都重置定时器 —— 实际上永远不消失；
   ③ 关闭叉太小、且被 innerHTML 重建打断，点了像没反应。
   现在：正文与关闭键只在文本真变化时才更新；
   手动关闭后 8 秒内不再弹同一条；关闭键独立、加大点按区。 */
function toast(msg, type) {
  try {
    const txt = String(msg == null ? '' : msg);
    const sig = (type || '') + '|' + txt;
    const mutedAt = __toastMuted.get(sig) || 0;
    if (Date.now() - mutedAt < 8000) { console.log('[HP-DeepLore] (已关闭，不再弹出) ' + txt); return; }
    // 【v1.21】全局静音：用户按了 🔕 之后，除错误外一律不再弹，彻底治"关了又来"
    if (settings.toastMuted && type !== 'err') { console.log('[HP-DeepLore] (已静音) ' + txt); return; }

    let el = document.getElementById('hp-toast');
    let fresh = false;
    if (!el) {
      el = document.createElement('div');
      el.id = 'hp-toast';
      const host = document.getElementById('hp-modal') || document.getElementById('hp_float') || document.body;
      host.appendChild(el);
      el.innerHTML = '<button class="hp-toast-m" type="button" aria-label="静音" title="静音：之后不再弹提示（错误除外）">\uD83D\uDD15</button>'
                   + '<button class="hp-toast-x" type="button" aria-label="关闭" title="关闭">\u00d7</button>'
                   + '<span class="hp-toast-t"></span>';
      fresh = true;
    }
    // 只在文本/类型真的变了才重写 DOM，避免闪烁与被顶掉
    if (fresh || el.dataset.sig !== sig) {
      if (!fresh) el.innerHTML = '<button class="hp-toast-m" type="button" aria-label="静音" title="静音：之后不再弹提示（错误除外）">\uD83D\uDD15</button>'
                               + '<button class="hp-toast-x" type="button" aria-label="关闭" title="关闭">\u00d7</button>'
                               + '<span class="hp-toast-t"></span>';
      el.querySelector('.hp-toast-t').textContent = txt;
      el.dataset.sig = sig;
    }
    el.className = 'hp-toast on' + (type ? ' ' + type : '');

    // 关闭按钮：独立绑定，stopPropagation 防止冒泡到整条
    const xbtn = el.querySelector('.hp-toast-x');
    if (xbtn && !xbtn.dataset.bound) {
      xbtn.dataset.bound = '1';
      xbtn.addEventListener('click', ev => { ev.stopPropagation(); hideToast(true); });
      xbtn.addEventListener('touchend', ev => { ev.stopPropagation(); ev.preventDefault(); hideToast(true); }, { passive: false });
    }
    // 静音键：一次点击，之后所有非错误提示都不再弹；再点一次恢复
    const mbtn = el.querySelector('.hp-toast-m');
    if (mbtn) {
      mbtn.textContent = settings.toastMuted ? '\uD83D\uDD15' : '\uD83D\uDD14';
      mbtn.title = settings.toastMuted ? '已静音，点击恢复提示' : '静音：之后不再弹提示（错误除外）';
      if (!mbtn.dataset.bound) {
        mbtn.dataset.bound = '1';
        const flip = ev => {
          ev.stopPropagation(); ev.preventDefault();
          settings.toastMuted = !settings.toastMuted;
          try { saveSettings(); } catch (e) { /* 忽略 */ }
          mbtn.textContent = settings.toastMuted ? '\uD83D\uDD15' : '\uD83D\uDD14';
          mbtn.title = settings.toastMuted ? '已静音，点击恢复提示' : '静音：之后不再弹提示（错误除外）';
          if (settings.toastMuted) hideToast(false);
        };
        mbtn.addEventListener('click', flip);
        mbtn.addEventListener('touchend', flip, { passive: false });
      }
    }

    clearTimeout(__toastTimer);
    const ms = TOAST_MS[type] != null ? TOAST_MS[type] : 6000;
    if (ms > 0) __toastTimer = setTimeout(() => { hideToast(false); }, ms);
  } catch (e) { /* 兜底 */ }
  console.log('[HP-DeepLore] ' + msg);
}
/* 按钮忙碌态：点击后立即给反馈，避免"点了没反应"的错觉 */
function markBusy(btn, text) {
  if (!btn) return () => {};
  const old = btn.textContent;
  btn.classList.add('hp-busy');
  btn.dataset.busy = '1';
  if (text) btn.textContent = text;
  btn.disabled = true;
  return () => {
    btn.classList.remove('hp-busy');
    delete btn.dataset.busy;
    btn.textContent = old;
    btn.disabled = false;
  };
}

/* ---------------- 模态面板 ---------------- */
function buildModal() {
  if (UI.modal) return UI.modal;
  const mask = document.createElement('div');
  mask.className = 'hp-mask';
  mask.id = 'hp-mask';
  mask.innerHTML = `
    <div class="hp-modal" id="hp-modal">
      <div class="hp-modal-head hp-drag-handle">
        <span class="hp-ic">◈</span>
        <span class="hp-title">HP DeepLore</span>
        <div class="hp-tabs">
          <button class="hp-tb-tab on" data-t="set">设置</button>
          <button class="hp-tb-tab" data-t="node">节点进度</button>
        </div>
        <span class="hp-sp"></span>
        ${memLightHTML()}
        <button class="hp-x" id="hp-modal-min">－</button>
        <button class="hp-x" id="hp-modal-close">✕</button>
      </div>
      <div class="hp-modal-body">
        <div class="hp-view on" id="hp-view-set"></div>
        <div class="hp-view" id="hp-view-node"></div>
      </div>
    </div>`;
  document.body.appendChild(mask);
  UI.mask = mask;
  UI.modal = mask.querySelector('#hp-modal');

  const w = settings.ui?.modalW || Math.min(1000, window.innerWidth - 40);
  const h = settings.ui?.modalH || Math.min(660, window.innerHeight - 60);
  const narrow = window.innerWidth < 721;
  if (!narrow) {
    UI.modal.style.width = w + 'px';
    UI.modal.style.height = h + 'px';
    if (settings.ui?.modalX != null) {
      UI.modal.style.left = Math.max(4, Math.min(Math.max(4, window.innerWidth - w - 8), settings.ui.modalX)) + 'px';
      UI.modal.style.top = Math.max(4, Math.min(Math.max(4, window.innerHeight - 40), settings.ui.modalY)) + 'px';
    } else {
      // fixed 定位后不再有 flex 居中，必须显式算一次
      UI.modal.style.left = Math.max(8, (window.innerWidth - w) / 2) + 'px';
      UI.modal.style.top = Math.max(8, (window.innerHeight - h) / 2) + 'px';
    }
    UI.modal.style.right = 'auto';
    UI.modal.style.bottom = 'auto';
  } else {
    // 窄屏交给 CSS 全屏
    UI.modal.style.width = ''; UI.modal.style.height = '';
    UI.modal.style.left = ''; UI.modal.style.top = '';
  }

  const mh = mask.querySelector('.hp-drag-handle');
  makeDraggable(UI.modal, mh, (x, y) => {
    if (window.innerWidth < 721) return;
    settings.ui = settings.ui || {}; settings.ui.modalX = x; settings.ui.modalY = y; saveSettings();
  });
  bindDblReset(UI.modal, mh, () => {
    // 复位：居中 + 默认尺寸，并清掉记忆
    settings.ui = settings.ui || {};
    delete settings.ui.modalX; delete settings.ui.modalY;
    delete settings.ui.modalW; delete settings.ui.modalH;
    saveSettings();
    UI.modal.style.width = Math.min(1000, window.innerWidth - 40) + 'px';
    UI.modal.style.height = Math.min(660, window.innerHeight - 60) + 'px';
    UI.modal.style.left = Math.max(8, (window.innerWidth - UI.modal.offsetWidth) / 2) + 'px';
    UI.modal.style.top = Math.max(8, (window.innerHeight - UI.modal.offsetHeight) / 2) + 'px';
    clampIntoView('modal');
  });
  makeResizable(UI.modal, (ww, hh) => {
    if (window.innerWidth < 721) return;
    settings.ui = settings.ui || {}; settings.ui.modalW = ww; settings.ui.modalH = hh; saveSettings();
  });

  mask.querySelectorAll('.hp-tb-tab').forEach(b => {
    b.onclick = () => {
      mask.querySelectorAll('.hp-tb-tab').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      const t = b.dataset.t;
      mask.querySelector('#hp-view-set').classList.toggle('on', t === 'set');
      mask.querySelector('#hp-view-node').classList.toggle('on', t === 'node');
      UI.modalTab = t;
      if (t === 'set') renderSettingsInto(mask.querySelector('#hp-view-set'));
      else renderSidebarInto(mask.querySelector('#hp-view-node'));
    };
  });
  mask.querySelector('#hp-modal-close').onclick = () => closeModal();
  mask.querySelector('#hp-modal-min').onclick = () => closeModal();
  mask.addEventListener('mousedown', e => { if (e.target === mask) closeModal(); });
  bindEscHandler();
  return UI.modal;
}

function openModal(tab) {
  buildModal();
  UI.mask.classList.add('on');
  UI.modalOpen = true;
  // toast 可能首次创建在 body 上，开面板后迁进来，保证不跑到面板外
  const t = document.getElementById('hp-toast');
  if (t && t.parentElement !== UI.modal) UI.modal.appendChild(t);
  // 展开前先保证面板完整落在视口内（含尺寸与位置双重修正）
  safeOpen(UI.modal);
  if (tab && tab !== UI.modalTab) {
    const b = UI.mask.querySelector(`.hp-tb-tab[data-t="${tab}"]`);
    if (b) b.click();
  }
  if (UI.modalTab === 'set') renderSettingsInto(UI.mask.querySelector('#hp-view-set'));
  else renderSidebarInto(UI.mask.querySelector('#hp-view-node'));
}
function closeModal() {
  hideToast();
  // 【修 v1.23】关面板前回收未失焦的输入并立即落盘，避免"配完一关就没了"
  try { persistNow(UI.mask || document); } catch (e) { /* 忽略 */ }
  if (UI.mask) UI.mask.classList.remove('on');
  UI.modalOpen = false;
}

/* 设置页渲染到指定容器 */
function renderSettingsInto(host) {
  if (!host) return;
  host.innerHTML = `<div class="hp-set">
    <div class="hp-nav">
      <div class="hp-gt">基础</div>
      ${PANES.slice(0, 3).map((p, i) => `<div class="hp-nv${i === UI.panelTab ? ' on' : ''}" data-p="${i}"><span class="n">${i + 1}</span>${p}</div>`).join('')}
      <div class="hp-gt">核心</div>
      ${PANES.slice(3, 6).map((p, i) => `<div class="hp-nv" data-p="${i + 3}"><span class="n">${i + 4}</span>${p}</div>`).join('')}
      <div class="hp-gt">高级</div>
      ${PANES.slice(6).map((p, i) => `<div class="hp-nv" data-p="${i + 6}"><span class="n">${i + 7}</span>${p}${p === '提示词' ? '<span class="p">8</span>' : ''}</div>`).join('')}
    </div>
    <div class="hp-pane" id="hp-pane-host"></div>
  </div>`;
  host.querySelectorAll('.hp-nv').forEach(n => {
    n.onclick = () => {
      // 【修 v1.23】切页会直接替换 DOM，未失焦的输入会被销毁且永不触发 change → 先回收
      persistNow(host);
      host.querySelectorAll('.hp-nv').forEach(x => x.classList.remove('on'));
      n.classList.add('on');
      UI.panelTab = Number(n.dataset.p);
      host.querySelector('#hp-pane-host').innerHTML = paneHTML(UI.panelTab);
      bindPane(host);
    };
  });
  const ph = host.querySelector('#hp-pane-host');
  ph.innerHTML = paneHTML(UI.panelTab);
  bindPane(host);
}

/* 节点面板渲染到指定容器 */
/* --------------------------------------------------------------------------
 * 【v1.16】章节阅读弹层：点节点旁的「阅」打开该章全文
 * -------------------------------------------------------------------------- */
function showChapterModal(c) {
  const old = document.getElementById('hp-chapter-modal');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'hp-chapter-modal';
  wrap.innerHTML = `<div class="hp-chmask"></div>
    <div class="hp-chbox">
      <div class="hp-chtop">
        <div class="hp-chtt">第 ${c.ch} 章${c.date ? ' · ' + c.date : ''}${c.vol ? ' · ' + c.vol : ''}</div>
        <button class="hp-chx">✕</button>
      </div>
      <div class="hp-chbody">${escapeHtml(c.text || '(空)')}</div>
    </div>`;
  document.documentElement.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('.hp-chx').onclick = close;
  wrap.querySelector('.hp-chmask').onclick = close;
  const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  // 定位（与模型选择弹层同样：JS 写死像素，避开 fixed 包含块问题）
  requestAnimationFrame(() => {
    const box = wrap.querySelector('.hp-chbox');
    const vv = window.visualViewport || window;
    const W = vv.width || window.innerWidth, H = vv.height || window.innerHeight;
    const w = Math.min(W - 24, 720), h = Math.min(H - 40, Math.round(H * 0.86));
    box.style.position = 'fixed';
    box.style.left = Math.round((W - w) / 2) + 'px';
    box.style.top = Math.round((H - h) / 2) + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
  });
}


/* ---------- 【v1.20】记忆图谱可视化（Canvas 力导向 · 常显 · 美化） ---------- */
async function memFetchGraph(limit) {
  try {
    const j = await memFetch('/graph?limit=' + (limit || 400));
    if (j && j.ok) return j;
    return { ok: false, err: (j && j.err) || '后端返回异常' };
  } catch (e) { return { ok: false, err: e.message }; }
}

/* 实体配色：有 type 用语义色，没有就按度数渐变 */
const G_COLOR = {
  人物: ['#f2c14e', '#8a5a12'], 角色: ['#f2c14e', '#8a5a12'],
  地点: ['#4fd0c0', '#136b62'], 场景: ['#4fd0c0', '#136b62'],
  物品: ['#b98bf0', '#4a2a78'], 道具: ['#b98bf0', '#4a2a78'],
  概念: ['#6fa8e8', '#1f3f6b'], 主题: ['#6fa8e8', '#1f3f6b'],
  情绪: ['#f08a8a', '#6b1f1f'],
};
function gColor(n, maxDeg) {
  const c = G_COLOR[n.type] || G_COLOR[String(n.type || '')];
  if (c) return c;
  const t = maxDeg > 1 ? (n.deg / maxDeg) : 0;
  return t > 0.55 ? ['#f2c14e', '#7a4b0d'] : (t > 0.28 ? ['#6fa8e8', '#1e3a63'] : ['#8195ab', '#27333f']);
}

function showMemoryGraph() {
  const old = document.getElementById('hp-graph-modal');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'hp-graph-modal';
  wrap.innerHTML = `<div class="hp-chmask"></div>
    <div class="hp-chbox hp-gbox">
      <div class="hp-chtop">
        <div class="hp-chtt">记忆图谱</div>
        <span id="hp-gstat" class="hp-gstat">连接中…</span>
        <span class="hp-sp"></span>
        <input id="hp-gfind" class="hp-inp hp-gfind" placeholder="找实体…">
        <button class="hp-mini" id="hp-gseed">场景扩散</button>
        <button class="hp-mini" id="hp-gretry">重连</button>
        <button class="hp-chx">✕</button>
      </div>
      <div class="hp-chbody" style="padding:0;position:relative;overflow:hidden">
        <canvas id="hp-gcanvas"></canvas>
        <div id="hp-gempty" class="hp-gempty" style="display:none"></div>
        <div id="hp-gtip" class="hp-gtip"></div>
        <div class="hp-glegend">
          <span><i style="background:#f2c14e"></i>人物</span>
          <span><i style="background:#4fd0c0"></i>地点</span>
          <span><i style="background:#b98bf0"></i>物品</span>
          <span><i style="background:#6fa8e8"></i>概念</span>
          <span class="hp-glegend-tip">滚轮缩放 · 拖拽平移 · 点节点检索</span>
        </div>
      </div>
    </div>`;
  document.documentElement.appendChild(wrap);

  const cv = wrap.querySelector('#hp-gcanvas');
  const tip = wrap.querySelector('#hp-gtip');
  const stat = wrap.querySelector('#hp-gstat');
  const empty = wrap.querySelector('#hp-gempty');
  let nodes = [], edges = [], raf = null, sel = null, selLinks = null;
  let byId = new Map(), adj = new Map();
  let view = { x: 0, y: 0, k: 1 };
  let W = 300, H = 300, dpr = 1, settled = false, steps = 0;

  const close = () => { if (raf) cancelAnimationFrame(raf); wrap.remove(); };
  wrap.querySelector('.hp-chx').onclick = close;
  wrap.querySelector('.hp-chmask').onclick = close;
  const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  /* ---- 尺寸：挂 html 上 + px 写死，绕开 body transform 导致的 fixed 错位 ---- */
  function layout() {
    const box = wrap.querySelector('.hp-chbox');
    const vv = window.visualViewport || window;
    const VW = vv.width || innerWidth, VH = vv.height || innerHeight;
    const w = Math.min(VW - 20, 780), h = Math.min(VH - 32, Math.round(VH * 0.88));
    box.style.position = 'fixed';
    box.style.left = Math.round((VW - w) / 2) + 'px';
    box.style.top = Math.round((VH - h) / 2) + 'px';
    box.style.width = w + 'px'; box.style.height = h + 'px';
    const r = cv.getBoundingClientRect();
    W = Math.max(120, r.width); H = Math.max(120, r.height);
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    if (nodes.length) { settled = false; steps = 0; }
  }
  requestAnimationFrame(layout);
  addEventListener('resize', () => { layout(); }, { passive: true });

  /* ---- 加载：区分「未连接 / 已连接但为空 / 有数据」三种状态 ---- */
  async function load(again) {
    stat.className = 'hp-gstat';
    stat.textContent = '连接中…';
    empty.style.display = 'none';
    if (again) await memProbe(true);

    if (!settings.memEnabled || !MEM_STATE.ok) {
      stat.className = 'hp-gstat bad';
      stat.textContent = '● 未连接：' + (settings.memEnabled ? (MEM_STATE.err || '未知') : '记忆库未启用');
      empty.style.display = 'flex';
      empty.innerHTML = `<div class="hp-ge-i">⚠</div>
        <div class="hp-ge-t">记忆库未连接</div>
        <div class="hp-ge-s">${settings.memEnabled ? escHtml(MEM_STATE.err || '') : '请先在「记忆」面板开启记忆库并填写后端地址'}</div>
        <div class="hp-ge-s">后端需在 Termux 运行：<code>python3 hp_memory_server.py 8899</code></div>`;
      nodes = []; edges = []; draw();
      return;
    }

    const g = await memFetchGraph(settings.memGraphLimit || 400);
    if (!g || !g.ok) {
      stat.className = 'hp-gstat bad';
      stat.textContent = '● 读取失败：' + ((g && g.err) || '未知');
      empty.style.display = 'flex';
      empty.innerHTML = `<div class="hp-ge-i">⚠</div><div class="hp-ge-t">读取图谱失败</div>
        <div class="hp-ge-s">${escHtml((g && g.err) || '')}</div>`;
      nodes = []; edges = []; draw();
      return;
    }
    if (!g.nodes || !g.nodes.length) {
      // 【v1.20】已连接但没数据 —— 明确区分，不再与"未连接"混为一谈
      const st = MEM_STATE.stats || {};
      stat.className = 'hp-gstat warn';
      stat.textContent = '● 已连接 · 图谱为空';
      empty.style.display = 'flex';
      empty.innerHTML = `<div class="hp-ge-i">◌</div>
        <div class="hp-ge-t">后端已连上 · 图谱暂时是空的</div>
        <div class="hp-ge-s" style="color:#7ec4a8">● 连接正常 ${MEM_STATE.ms || 0}ms</div>
        <div class="hp-ge-s">事件 ${st.events ?? 0} 条 · 承诺 ${st.promises ?? 0} 条 · 实体 ${st.entities ?? 0} 个${settings.memLastFloor ? ` · 已同步到第 ${settings.memLastFloor} 楼` : ''}</div>
        <div class="hp-ge-s" style="opacity:.8;margin-top:6px">图谱会在写入记忆后自动长出来。</div>
        <div class="hp-ge-s">开启「正文结束后自动更新」，或点「立即更新记忆库」写入第一批记忆。</div>`;
      nodes = []; edges = []; draw();
      return;
    }

    const maxDeg = Math.max(1, ...g.nodes.map(n => n.deg || 0));
    const R = Math.min(W, H) * 0.34;
    nodes = g.nodes.map((n, i) => {
      const a = (i / g.nodes.length) * Math.PI * 2;
      const col = gColor(n, maxDeg);
      return { id: n.id, name: n.name, deg: n.deg || 0, type: n.type || '',
               x: W / 2 + Math.cos(a) * R + (Math.random() - .5) * 8,
               y: H / 2 + Math.sin(a) * R + (Math.random() - .5) * 8,
               vx: 0, vy: 0, col,
               r: 4.5 + Math.sqrt((n.deg || 0) / maxDeg) * 15 };
    });
    byId = new Map(nodes.map(n => [n.id, n]));
    edges = (g.edges || []).filter(e => byId.has(e.a) && byId.has(e.b));
    adj = new Map(nodes.map(n => [n.id, new Set()]));
    for (const e of edges) { adj.get(e.a).add(e.b); adj.get(e.b).add(e.a); }

    stat.className = 'hp-gstat good';
    stat.textContent = `● 已连接 · ${nodes.length} 实体 · ${edges.length} 关系`
      + (g.truncated ? '（已截断，可调上限）' : '');
    settled = false; steps = 0; view = { x: 0, y: 0, k: 1 };
    loop();
  }

  /* ---- 力导向：空间网格加速斥力，收敛后自动停步 ---- */
  function step() {
    const K = 46, DAMP = 0.86, CELL = 90;
    const grid = new Map();
    const key = (cx, cy) => cx * 100000 + cy;
    for (const n of nodes) {
      const cx = Math.floor(n.x / CELL), cy = Math.floor(n.y / CELL);
      const k = key(cx, cy);
      let a = grid.get(k); if (!a) { a = []; grid.set(k, a); }
      a.push(n);
    }
    for (const n of nodes) {
      const cx = Math.floor(n.x / CELL), cy = Math.floor(n.y / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get(key(cx + dx, cy + dy));
        if (!arr) continue;
        for (const m of arr) {
          if (m === n || m.id < n.id) continue;
          let ex = m.x - n.x, ey = m.y - n.y;
          let d2 = ex * ex + ey * ey;
          if (d2 > CELL * CELL * 2.25) continue;
          if (d2 < 1) { d2 = 1; ex = (Math.random() - .5); ey = (Math.random() - .5); }
          const d = Math.sqrt(d2), f = (K * K) / d2;
          const fx = (ex / d) * f, fy = (ey / d) * f;
          n.vx -= fx; n.vy -= fy; m.vx += fx; m.vy += fy;
        }
      }
    }
    for (const e of edges) {
      const a = byId.get(e.a), b = byId.get(e.b);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - K) * 0.02 * Math.min(3, e.w || 1);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    let energy = 0;
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.004;
      n.vy += (H / 2 - n.y) * 0.004;
      n.vx *= DAMP; n.vy *= DAMP;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(n.r + 2, Math.min(W - n.r - 2, n.x));
      n.y = Math.max(n.r + 2, Math.min(H - n.r - 2, n.y));
      energy += Math.abs(n.vx) + Math.abs(n.vy);
    }
    steps++;
    if (steps > 12 && energy / Math.max(1, nodes.length) < 0.06) settled = true;
    if (steps > 400) settled = true;
  }

  function draw() {
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 背景：暗底 + 中心微光
    ctx.clearRect(0, 0, W, H);
    const rg = ctx.createRadialGradient(W / 2, H * 0.44, 0, W / 2, H * 0.44, Math.max(W, H) * 0.66);
    rg.addColorStop(0, 'rgba(126,196,168,.10)');
    rg.addColorStop(0.55, 'rgba(60,96,150,.05)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.scale(view.k, view.k); ctx.translate(-W / 2 + view.x, -H / 2 + view.y);

    // 边：曲线 + 权重决定亮度
    for (const e of edges) {
      const a = byId.get(e.a), b = byId.get(e.b);
      if (!a || !b) continue;
      const on = sel && (e.a === sel || e.b === sel);
      const w = Math.min(3, e.w || 1);
      ctx.strokeStyle = on ? 'rgba(242,193,78,.55)' : `rgba(120,160,210,${0.09 + w * 0.05})`;
      ctx.lineWidth = on ? 1.5 : 0.6 + w * 0.25;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const nx = -(b.y - a.y), ny = (b.x - a.x);
      const len = Math.hypot(nx, ny) || 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx + nx / len * 12, my + ny / len * 12, b.x, b.y);
      ctx.stroke();
    }

    // 节点：径向渐变 + 光晕；选中态放大并描边
    for (const n of nodes) {
      const hot = sel && (n.id === sel || (selLinks && selLinks.has(n.id)));
      const r = n.r * (hot ? 1.25 : 1);
      const [c1, c2] = n.col;
      if (hot) {
        ctx.shadowColor = c1; ctx.shadowBlur = 16;
      }
      const g = ctx.createRadialGradient(n.x - r * .35, n.y - r * .4, r * .1, n.x, n.y, r);
      g.addColorStop(0, c1); g.addColorStop(1, c2);
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = g; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = hot ? 1.6 : 0.8;
      ctx.strokeStyle = hot ? '#fff' : 'rgba(255,255,255,.22)';
      ctx.stroke();

      const showLabel = r > 8 || hot || view.k > 1.4;
      if (showLabel) {
        const fs = Math.max(9.5, Math.min(13, 9.5 + (n.deg ? Math.sqrt(n.deg) * 0.9 : 0)));
        ctx.font = `${hot ? 600 : 400} ${fs}px system-ui,-apple-system,sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,9,13,.92)';
        ctx.strokeText(n.name, n.x, n.y + r + 3);
        ctx.fillStyle = hot ? '#fff' : 'rgba(214,228,242,.82)';
        ctx.fillText(n.name, n.x, n.y + r + 3);
      }
    }
    ctx.restore();
  }

  function loop() {
    if (raf) cancelAnimationFrame(raf);
    const tick = () => {
      if (!settled) step();
      draw();
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  /* ---- 交互：悬停 / 点选 / 拖拽 / 滚轮缩放 / 平移 ---- */
  function toWorld(mx, my) {
    return { x: (mx - W / 2) / view.k + W / 2 - view.x, y: (my - H / 2) / view.k + H / 2 - view.y };
  }
  function pick(mx, my) {
    const p = toWorld(mx, my);
    let hit = null, best = 1e9;
    for (const n of nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < n.r + 7 && d < best) { best = d; hit = n; }
    }
    return hit;
  }
  let drag = null, panning = null;
  cv.addEventListener('mousemove', ev => {
    const r = cv.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    if (drag) { const p = toWorld(mx, my); drag.x = p.x; drag.y = p.y; drag.vx = drag.vy = 0; settled = false; steps = 0; return; }
    if (panning) { view.x += (mx - panning.x) / view.k; view.y += (my - panning.y) / view.k; panning = { x: mx, y: my }; return; }
    const hit = pick(mx, my);
    if (!hit) { tip.style.display = 'none'; sel = null; selLinks = null; return; }
    sel = hit.id; selLinks = adj.get(hit.id) || new Set();
    tip.style.display = 'block';
    tip.style.left = Math.min(r.width - 160, mx + 14) + 'px';
    tip.style.top = Math.min(r.height - 40, my + 14) + 'px';
    tip.innerHTML = `<b>${escHtml(hit.name)}</b>${hit.type ? ` · ${escHtml(hit.type)}` : ''}<br>关联 ${selLinks.size} · 权重 ${hit.deg}`;
  });
  cv.addEventListener('mousedown', ev => {
    const r = cv.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const hit = pick(mx, my);
    if (hit) { drag = hit; sel = hit.id; selLinks = adj.get(hit.id) || new Set(); }
    else panning = { x: mx, y: my };
  });
  addEventListener('mouseup', () => { drag = null; panning = null; });
  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    const k = Math.max(0.4, Math.min(4, view.k * (ev.deltaY > 0 ? 0.9 : 1.1)));
    view.k = k;
  }, { passive: false });
  cv.addEventListener('click', async () => {
    if (!sel) return;
    const sd = getStatData();
    try {
      const items = await memRetrieve(sel, sd, currentGrade(sd));
      stat.className = 'hp-gstat good';
      stat.textContent = `「${sel}」→ 命中 ${items ? items.length : 0} 条`;
    } catch (e) { stat.className = 'hp-gstat bad'; stat.textContent = '检索失败：' + e.message; }
  });

  const findEl = wrap.querySelector('#hp-gfind');
  if (findEl) findEl.oninput = () => {
    const q = String(findEl.value || '').trim();
    if (!q) { sel = null; selLinks = null; return; }
    const hit = nodes.find(n => String(n.name).includes(q));
    if (hit) { sel = hit.id; selLinks = adj.get(hit.id) || new Set(); }
  };
  const seedBtn = wrap.querySelector('#hp-gseed');
  if (seedBtn) seedBtn.onclick = async () => {
    const sd = getStatData();
    const loc = String(sd?.世界?.当前地点 || sd?.当前场景?.地点 || '');
    const who = Object.keys(sd?.当前场景?.在场角色 || {}).slice(0, 3);
    const seeds = [loc, ...who].filter(Boolean);
    if (!seeds.length) { stat.textContent = '当前没有可识别的场景实体'; return; }
    try {
      const j = await memPost('/graph/diffuse', { seeds });
      stat.className = 'hp-gstat good';
      stat.textContent = '扩散：' + ((j.top || []).slice(0, 5)
        .map(x => `${x.e} ${x.act.toFixed(3)}`).join(' · ') || '无结果');
    } catch (e) { stat.className = 'hp-gstat bad'; stat.textContent = '扩散失败：' + e.message; }
  };
  const retryBtn = wrap.querySelector('#hp-gretry');
  if (retryBtn) retryBtn.onclick = () => load(true);

  load(false);
}

function escHtml(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function renderSidebarInto(host) {
  if (!host) return;
  const sd = getStatData();
  const grade = currentGrade(sd);
  const idx = await idbGet(STORE.index, 'main');
  const done = sd?.世界线?.已结算节点 || {};
  const nodes = (idx?.nodes || []).filter(n => n.grade === grade);
  const doneN = nodes.filter(n => done[n.id]).length;
  const nowDate = String(sd?.世界?.当前时间 || '').slice(0, 10);
  const pct = nodes.length ? Math.round(doneN / nodes.length * 100) : 0;

  let h = `<div class="hp-side">
    <div class="hp-sh">
      <div class="hp-sht">斯科皮 · ${LABEL_MAP[grade] || grade}</div>
      <div class="hp-shs">${ORIG_MAP[grade] ? '原著' + ORIG_MAP[grade] + ' · ' : ''}${nodes.length} 节点</div>
      <div class="hp-pbar"><i style="width:${pct}%"></i></div>
      <div class="hp-pnum"><span>节点进度</span><span><b>${doneN}</b> / ${nodes.length}</span></div>
    </div><div class="hp-nlist">`;
  let curFound = false;
  for (const n of nodes) {
    const locked = n.date && nowDate && n.date > nowDate;
    if (locked && !settings.showLockedNodes) continue;
    const isDone = !!done[n.id];
    const isCur = !isDone && !locked && !curFound;
    if (isCur) curFound = true;
    const cls = isDone ? 'done' : (locked ? 'lock' : (isCur ? 'cur' : ''));
    const mk = isDone ? '✓' : (locked ? '🔒' : (isCur ? '▸' : '○'));
    h += `<div class="hp-ni ${cls}" data-id="${esc(n.id)}"><span class="hp-mk">${mk}</span>
      <div class="hp-nb"><div class="hp-nt">${esc(n.title)}</div>
      <div class="hp-nd">${esc(n.date || '—')}${locked ? ' · 未解锁' : ''}${isCur ? ' · 当前' : ''}</div></div>
      <span class="hp-rdbtn" data-rd="${esc(String(n.chapter))}" data-rdg="${esc(n.grade || '')}" title="阅读该章原文">阅</span>
      <span class="hp-ck"></span></div>`;
  }
  if (!nodes.length) h += `<div class="hp-empty">未建立索引<br><span>到「索引」面板上传 txt 并建索引</span></div>`;
  h += `</div><div class="hp-sf">
    <button class="hp-sbtn p" id="hp-sync2">同步变量</button>
    <button class="hp-sbtn" id="hp-jump2">跳章</button>
    <button class="hp-sbtn" id="hp-refresh2">刷新</button>
  </div></div>`;
  host.innerHTML = h;

  host.querySelectorAll('.hp-ni:not(.lock)').forEach(el => {
    el.onclick = async () => {
      const id = el.dataset.id;
      const sd2 = getStatData();
      const cur = !!sd2?.世界线?.已结算节点?.[id];
      const path = `stat_data.世界线.已结算节点.${id}`;
      try {
        const ctx = stGetContext();
        if (ctx?.variables?.stat_data) {
          if (!ctx.variables.stat_data.世界线) ctx.variables.stat_data.世界线 = {};
          if (!ctx.variables.stat_data.世界线.已结算节点) ctx.variables.stat_data.世界线.已结算节点 = {};
          if (cur) delete ctx.variables.stat_data.世界线.已结算节点[id];
          else ctx.variables.stat_data.世界线.已结算节点[id] = true;
        }
      } catch (e) { /* 忽略 */ }
      try {
        const Mvu = window.Mvu;
        if (Mvu?.setVariable) await Mvu.setVariable(path, !cur);
        else if (window.setvar) window.setvar(path, !cur);
      } catch (e) { /* 忽略 */ }
      el.classList.toggle('done');
    };
  });
  const sync = host.querySelector('#hp-sync2') || host.querySelector('#hp-sync');
  sync?.addEventListener('click', () => renderSidebarInto(host));
  const rf = host.querySelector('#hp-refresh2') || host.querySelector('#hp-refresh');
  rf?.addEventListener('click', () => renderSidebarInto(host));
  const jp = host.querySelector('#hp-jump2') || host.querySelector('#hp-jump');
  jp?.addEventListener('click', async () => {
    const idx2 = await idbGet(STORE.index, 'main');
    const all = idx2?.nodes || [];
    const pick = prompt('跳转到哪一章？（输入章号）\n可用：' + (all.length ? `${all[0].chapter} ~ ${all[all.length - 1].chapter}` : '无索引'), '');
    const n = Number(pick);
    if (!Number.isFinite(n)) return;
    const nd = all.find(x => x.chapter === n);
    if (!nd) { toast('未找到该章', 'err'); return; }
    toast(`第 ${nd.chapter} 章 · ${nd.date} · ${esc(nd.vol)} · ${LABEL_MAP[nd.grade]}`, 'ok');
  });
}

/* ---------------- 浮动节点面板 ---------------- */
function buildFloating() {
  if (UI.floating) return;
  const box = document.createElement('div');
  box.id = 'hp_float';
  box.className = 'hp-float';
  const w = settings.ui?.floatW || 320;
  const h = settings.ui?.floatH || 420;
  box.style.width = w + 'px';
  box.style.height = h + 'px';
  box.innerHTML = `
    <div class="hp-float-head hp-drag-handle">
      <span class="hp-ic">◈</span>
      <span class="hp-ft">节点进度</span>
      <span class="hp-sp"></span>
      <button class="hp-x" id="hp-float-set" title="打开完整设置">⚙</button>
      <button class="hp-x" id="hp-float-fold" title="折叠">－</button>
      <button class="hp-x" id="hp-float-close" title="关闭">✕</button>
    </div>
    <div class="hp-float-body" id="hp_float_body"></div>`;
  document.body.appendChild(box);
  UI.floating = box;

  const isNarrow = () => window.innerWidth < 721;
  if (settings.ui?.floatX != null && !isNarrow()) {
    box.style.left = Math.max(4, Math.min(Math.max(4, window.innerWidth - w - 8), settings.ui.floatX)) + 'px';
    box.style.top = Math.max(4, Math.min(Math.max(4, window.innerHeight - 40), settings.ui.floatY)) + 'px';
  } else if (!isNarrow()) {
    // 默认靠左上，避开右上角「◈ 设置」球与右下角「◈ 节点」按钮
    box.style.left = '20px';
    box.style.top = '96px';
    box.style.right = 'auto';
  } else {
    // 窄屏：交给 CSS media query，清空内联位置与尺寸
    box.style.left = ''; box.style.right = ''; box.style.top = '';
    box.style.width = ''; box.style.height = '';
  }

  const fh = box.querySelector('.hp-drag-handle');
  makeDraggable(box, fh, (x, y) => {
    if (window.innerWidth < 721) return;
    settings.ui = settings.ui || {}; settings.ui.floatX = x; settings.ui.floatY = y; saveSettings();
  });
  bindDblReset(box, fh, () => {
    settings.ui = settings.ui || {};
    delete settings.ui.floatX; delete settings.ui.floatY;
    delete settings.ui.floatW; delete settings.ui.floatH;
    saveSettings();
    box.style.width = '320px';
    box.style.height = '420px';
    box.style.left = '20px';
    box.style.top = '96px';
    box.style.right = 'auto';
    clampIntoView('float');
  });
  makeResizable(box, (ww, hh) => {
    if (window.innerWidth < 721) return;
    settings.ui = settings.ui || {}; settings.ui.floatW = ww; settings.ui.floatH = hh; saveSettings();
  });

  box.querySelector('#hp-float-close').onclick = () => { box.classList.remove('on'); settings.ui.floatOn = false; saveSettings(); };
  box.querySelector('#hp-float-fold').onclick = () => {
    box.classList.toggle('fold');
    settings.ui.floatFold = box.classList.contains('fold'); saveSettings();
  };
  box.querySelector('#hp-float-set').onclick = () => openModal('set');
  box.classList.toggle('fold', !!settings.ui?.floatFold);
}

/* --------------------------------------------------------------------------
 * 把面板拉回可视区
 * 关键的三个保证：
 *   ① 尺寸不超过视口（否则缩放/记忆尺寸在换设备后溢出）
 *   ② 位置不超出视口（否则标题栏与关闭按钮跑到屏幕外点不到）
 *   ③ 标题栏（拖拽手柄）必定留在视口内
 * 打开面板、切换 tab、视口变化都会调一次。
 * -------------------------------------------------------------------------- */
function clampIntoView(which) {
  const fix = (el) => {
    if (!el) return;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const narrow = vw < 721;
    const r = el.getBoundingClientRect();

    let w = r.width, h = r.height;
    if (!narrow) {
      // ① 尺寸上限：视口 96%
      const maxW = Math.floor(vw * 0.96), maxH = Math.floor(vh * 0.94);
      if (w > maxW) { w = maxW; el.style.width = w + 'px'; }
      if (h > maxH) { h = maxH; el.style.height = h + 'px'; }
    } else {
      // 窄屏交给 CSS，清内联尺寸
      el.style.width = ''; el.style.height = '';
      w = el.getBoundingClientRect().width;
      h = el.getBoundingClientRect().height;
    }

    // ② 位置收紧：留 8px 边距，且至少让标题栏露出 44px
    let nx = r.left, ny = r.top;
    if (el.style.left) nx = parseFloat(el.style.left) || nx;
    if (el.style.top) ny = parseFloat(el.style.top) || ny;
    nx = Math.min(nx, Math.max(4, vw - w - 8));
    ny = Math.min(ny, Math.max(4, vh - 44));
    nx = Math.max(4, nx);
    ny = Math.max(4, ny);

    if (Math.abs(nx - r.left) > 1 || Math.abs(ny - r.top) > 1) {
      el.style.left = nx + 'px';
      el.style.top = ny + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    }
    return true;
  };
  if (!which || which === 'modal') fix(UI.modal);
  if (!which || which === 'float') fix(UI.floating);
}

/* ESC：优先关模态，其次关浮动面板。独立于 buildModal，任何情况下都生效 */
let __escBound = false;
function bindEscHandler() {
  if (__escBound) return;
  __escBound = true;
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (UI.modalOpen) { e.stopPropagation(); closeModal(); return; }
    if (UI.floating?.classList.contains('on')) {
      UI.floating.classList.remove('on');
      settings.ui = settings.ui || {}; settings.ui.floatOn = false; saveSettings();
    }
  });
}

/* 打开面板时必定先归位，避免"展开后超出屏幕点不到关闭" */
function safeOpen(el) {
  if (!el) return;
  // 先显示再测量，否则 getBoundingClientRect 全 0
  clampIntoView(el === UI.modal ? 'modal' : 'float');
  requestAnimationFrame(() => clampIntoView(el === UI.modal ? 'modal' : 'float'));
}

window.addEventListener('resize', () => { clampIntoView(); });
window.addEventListener('orientationchange', () => { setTimeout(() => clampIntoView(), 260); });

function toggleFloating(force) {
  buildFloating();
  const on = force != null ? force : !UI.floating.classList.contains('on');
  UI.floating.classList.toggle('on', on);
  settings.ui = settings.ui || {};
  settings.ui.floatOn = on;
  saveSettings();
  if (on) {
    renderSidebarInto(UI.floating.querySelector('#hp_float_body'));
    // 展开后立刻归位，防止超出屏幕后关不掉
    safeOpen(UI.floating);
  }
}

/* ---------------- 入口：魔法棒菜单 ---------------- */
/* 菜单容器候选：不同 ST 版本/主题 DOM 结构不同，全部试一遍 */
function findMenuContainers() {
  const sels = [
    '#extensionsMenu',
    '#extensions_menu',
    '#extensionsMenuButton + .popup-menu',
    '#extensionsMenuButton + ul',
    '.popup-menu[aria-labelledby="extensionsMenuButton"]',
    '#magic_popup',
    '#magicMenu',
    '.magic_popup',
    '#wandMenu',
  ];
  const found = [];
  for (const sel of sels) {
    try { document.querySelectorAll(sel).forEach(el => { if (el && !found.includes(el)) found.push(el); }); }
    catch (e) { /* 忽略无效选择器 */ }
  }
  // 兜底：找"打开数据库/词汇映射"这类 ST 菜单项所在的容器（照用户截图定位）
  try {
    document.querySelectorAll('a.menu_button, .menu_button, .popup-menu a').forEach(a => {
      const t = (a.textContent || '').trim();
      if (/打开数据库|词汇映射|附加文件|生成图片|Token计数器|翻译聊天|变量管理器/.test(t)) {
        const p = a.parentElement;
        if (p && !found.includes(p)) found.push(p);
      }
    });
  } catch (e) { /* 忽略 */ }
  return found;
}

function addMenuEntry() {
  let added = false;
  const menus = findMenuContainers();
  for (const m of menus) {
    if (m.querySelector('[data-hp-entry]')) { added = true; continue; }
    const a = document.createElement('a');
    a.className = 'menu_button';
    a.href = '#';
    a.dataset.hpEntry = '1';
    a.innerHTML = '<i class="fa-solid fa-book-open"></i><span>HP DeepLore</span>';
    a.onclick = e => { e.preventDefault(); e.stopPropagation(); openModal('set'); return false; };
    m.appendChild(a);
    added = true;
  }
  // 无论菜单是否挂上，兜底球必定存在（不依赖任何 ST 容器）
  ensureFab();
  return added;
}

/* 兜底悬浮球：菜单挂不上时照样能开面板 */
/* 让固定定位的小圆按钮可拖动，且不误伤点击 */
function makeFabDraggable(btn, key) {
  let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false;
  const down = e => {
    if (e.button != null && e.button !== 0) return;
    dragging = true; moved = false;
    const p = e.touches ? e.touches[0] : e;
    sx = p.clientX; sy = p.clientY;
    const r = btn.getBoundingClientRect();
    ox = r.left; oy = r.top;
    btn.classList.add('hp-dragging');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up);
  };
  const move = e => {
    if (!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    const dx = p.clientX - sx, dy = p.clientY - sy;
    if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return; // 小于阈值视为点击
    moved = true;
    let nx = Math.max(4, Math.min(window.innerWidth - btn.offsetWidth - 4, ox + dx));
    let ny = Math.max(4, Math.min(window.innerHeight - btn.offsetHeight - 4, oy + dy));
    btn.style.left = nx + 'px';
    btn.style.top = ny + 'px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    if (e.touches) e.preventDefault();
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    btn.classList.remove('hp-dragging');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', up);
    if (!moved) return; // 没移动 = 点击，交给 onclick
    const r = btn.getBoundingClientRect();
    settings.ui = settings.ui || {};
    settings.ui[key + 'X'] = Math.round(r.left);
    settings.ui[key + 'Y'] = Math.round(r.top);
    saveSettings();
  };
  btn.addEventListener('mousedown', down);
  btn.addEventListener('touchstart', down, { passive: false });
  // 复位记忆位置
  if (settings.ui?.[key + 'X'] != null) {
    btn.style.left = Math.max(4, Math.min(window.innerWidth - btn.offsetWidth - 4, settings.ui[key + 'X'])) + 'px';
    btn.style.top = Math.max(4, Math.min(window.innerHeight - btn.offsetHeight - 4, settings.ui[key + 'Y'])) + 'px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
  }
  // 双击复位到默认角
  btn.addEventListener('dblclick', () => {
    settings.ui = settings.ui || {};
    delete settings.ui[key + 'X']; delete settings.ui[key + 'Y'];
    saveSettings();
    btn.style.left = ''; btn.style.top = '';
    btn.style.right = (key === 'gear' ? '16px' : '16px');
    btn.style.bottom = (key === 'gear' ? '' : '92px');
    btn.style.top = (key === 'gear' ? '112px' : '');
  });
}

function ensureFab() {
  if (document.getElementById('hp_gear')) return;
  const g = document.createElement('button');
  g.id = 'hp_gear';
  g.className = 'hp-fab';
  g.innerHTML = '◈';
  g.title = 'HP DeepLore（设置 / 节点进度）· 可拖动，双击复位';
  g.onclick = e => { e.stopPropagation(); openModal('set'); };
  document.body.appendChild(g);
  makeFabDraggable(g, 'gear');
}

function addFab() {
  if (document.getElementById('hp_fab')) return;
  const f = document.createElement('button');
  f.id = 'hp_fab';
  f.className = 'hp-fab2';
  f.innerHTML = '◈ 节点';
  f.title = 'HP DeepLore 节点进度 · 可拖动，双击复位';
  f.onclick = () => toggleFloating();
  document.body.appendChild(f);
  makeFabDraggable(f, 'node');
}

/* ==========================================================================
 * 启动
 * ========================================================================== */
function loadSettings() {
  const saved = restoreFromBackup();
  settings = Object.assign(structuredClone(DEFAULTS), saved || {});
  stExtensionSettings()[EXT_ID] = settings;
  if (!Array.isArray(settings.tiers) || settings.tiers.length !== 6) settings.tiers = TIERS.map(t => t.max);

  /* 【修 v1.24】API 以独立存储为准。
     三方优先级：独立存储（同步写，最可靠）> 本地全量备份 > ST 存档。
     ST 存档里的 apis 常常是 []（扩展设置被异步覆盖/防抖未落盘的残留），
     若不加分辨地采信，就会用空数组压掉真实配置 —— 这正是"刷新后 API 全没"的直接现象。 */
  settings.apis = Array.isArray(settings.apis) ? settings.apis.slice(0, 10) : [];
  const solo = loadApisStandalone();
  if (solo && Array.isArray(solo.apis) && solo.apis.length && !settings.apis.length) {
    settings.apis = solo.apis.slice(0, 10).map(a => Object.assign(
      { name: 'api', uses: ['llm'], base: '', key: '', model: '', rpm: 60, concurrency: 0 }, a));
  }
  settings.prompts = settings.prompts || {};
  settings.aliasMap = settings.aliasMap || {};
  settings.nodeMap = settings.nodeMap || {};

  /* 【修 v1.24】ST 覆盖保护。
     ST 有可能在扩展启动后异步填充 window.extension_settings，把我们挂载的 settings
     整个冲掉。这里持续巡检：一旦发现 [EXT_ID] 不再是 settings，就重新挂回去。
     定时器在 10 秒后自停，不长期占用。 */
  let guard = 0;
  const guardTimer = setInterval(() => {
    try {
      const box = stExtensionSettings();
      if (box && box[EXT_ID] !== settings) {
        box[EXT_ID] = settings;
        writeLocalBackup();
        const S = ST();
        if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
        else if (typeof S.saveSettingsDebounced === 'function') S.saveSettingsDebounced();
      }
    } catch (e) { /* 忽略 */ }
    if (++guard > 20) clearInterval(guardTimer);
  }, 500);
}
/* 【修 v1.24】把 API 的实际落盘情况画出来：三处存储各有多少条、谁是最新的。
   以前只能靠"刷新看还在不在"来验证，现在面板上直接可读。 */
function paintApiStore(pane) {
  const box = pane && pane.querySelector('#hp-api-store');
  if (!box) return;
  const solo = loadApisStandalone();
  const nSolo = solo ? solo.apis.length : -1;
  const st = stExtensionSettings()[EXT_ID];
  const nSt = st && Array.isArray(st.apis) ? st.apis.length : -1;
  const nMem = Array.isArray(settings.apis) ? settings.apis.length : 0;
  const okSolo = nSolo === nMem && nMem > 0;
  const time = solo && solo.t ? new Date(solo.t).toLocaleTimeString() : '—';
  const color = okSolo ? 'var(--hp-ok,#5ecb8f)' : (nSolo === 0 ? 'var(--hp-tx3)' : 'var(--hp-err,#e06c75)');
  box.innerHTML = `存档自检：<b style="color:${color}">${okSolo ? '独立存档已写入 ✓' : (nSolo === 0 ? '独立存档为空' : '独立存档与当前不一致 ⚠')}</b>`
    + ` <span style="color:var(--hp-tx3)">· 独立 ${nSolo < 0 ? '无' : nSolo} 条（${time}）｜ST 设置 ${nSt < 0 ? '无' : nSt} 条｜当前 ${nMem} 条</span>`;
}

function saveSettings() {
  settings.__savedAt = Date.now();
  stExtensionSettings()[EXT_ID] = settings;
  saveApisNow();          /* 【修 v1.24】同步立即写独立存储，不等防抖 */
  stSaveSettings();
}

/* 入口：优先 jQuery（ST 环境必有），否则用原生 DOMContentLoaded 兜底 */
function boot() {
  (async () => {
  loadSettings();
  document.documentElement.dataset.hpTheme = settings.theme || 'slytherin';

  // ---- 入口 1：魔法棒菜单（主） ----
  // ST 菜单多为异步构建，持续重试直到挂上；期间兜底球已确保存在
  addMenuEntry();
  let tries = 0;
  const menuTimer = setInterval(() => {
    if (addMenuEntry() || ++tries > 60) clearInterval(menuTimer);
  }, 500);

  // ---- 入口 2：浮动节点面板 + 悬浮按钮 ----
  addFab();
  buildFloating();
  bindEscHandler();
  if (settings.ui?.floatOn) {
    UI.floating.classList.add('on');
    renderSidebarInto(UI.floating.querySelector('#hp_float_body'));
  }

  // ---- ST 自带设置容器（若存在则同步渲染一份） ----
  const stHost = document.getElementById('hp_settings')
    || document.getElementById('hp-deeplore_settings');
  if (stHost) renderSettingsInto(stHost);

  hookSend();
  await renderSidebar();

  /* 【v1.18】启动时探一次记忆库，让指示灯一上来就是真实状态 */
  if (settings.memEnabled) {
    memProbe(true).catch(() => {});
    // 低频复检：只在插件启用时跑，一次 GET，开销可忽略
    setInterval(() => {
      if (!settings.memEnabled || !settings.memAutoProbe) return;
      memProbe(true).catch(() => {});
    }, Math.max(5, Number(settings.memProbeSec) || 20) * 1000);
  }

  const on = (evt, fn) => { try { stEventSource().on(evt, fn); } catch (e) { /* 忽略 */ } };
  on(stEventTypes().GENERATE_AFTER_DATA, () => { if (settings.enabled) injectNow(); });
  on(stEventTypes().GENERATION_ENDED, () => {
    // 【v1.15】生成结束时估算 AI 对注入原文的采信度，记入 INJECT_LOG
    try {
      const last = lastInject();
      if (last && last.sources && last.sources.length) {
        const ctx = stGetContext();
        const chat = ctx?.chat || [];
        const msg = chat.length ? String(chat[chat.length - 1]?.mes || '') : '';
        if (msg) {
          const sc = scoreAdoption(msg, last.sources);
          last.adoption = sc.pct;
          last.adoptionLabel = adoptionLabel(sc.pct);
        }
      }
    } catch (e) { /* 忽略 */ }
    clearInject(); renderCardIntoChat(); refreshFloating();
    /* 【v1.18】生成结束后异步更新记忆库。
       默认关闭；即便开启也全程 try/catch + 延迟，绝不影响聊天。 */
    if (settings.enabled && settings.memEnabled && settings.memAutoUpdate) {
      setTimeout(() => {
        memUpdate({ silent: true }).catch(e => console.warn('[HP-DeepLore] 记忆自动更新失败：', e?.message || e));
      }, 900);
    }
    /* 【v1.25】生成结束后异步重定位剧情进度并同步世界书条目。
       同样默认关闭，且全程 try/catch，绝不影响聊天。 */
    if (settings.enabled && settings.plotCtlOn && settings.plotAutoRun) {
      setTimeout(() => { runPlotCtl({ silent: true }); }, 1500);
    }
  });
  on(stEventTypes().CHAT_CHANGED, () => { renderSidebar(); refreshFloating(); });
  on(stEventTypes().MESSAGE_RECEIVED, () => { renderSidebar(); refreshFloating(); });
  on(stEventTypes().MESSAGE_SENT, () => { renderSidebar(); refreshFloating(); });
  on(stEventTypes().GENERATE_CLICKED, () => {
    if (!settings.rerunOnRegenerate || !lastUserText) return;
    window.__hp_lore = null;
    window.__hp_lore_html = null;
    runPipeline(lastUserText).catch(() => {});
  });

  // 菜单被 ST 重绘时重新挂入口
  const mo = new MutationObserver(() => {
    if (!document.querySelector('[data-hp-entry]')) addMenuEntry();
  });
  try {
    const menuHost = document.querySelector('#extensionsMenu') || document.body;
    mo.observe(menuHost, { childList: true, subtree: true });
  } catch (e) { /* 忽略 */ }

    /* 【修 v1.23】页面隐藏/卸载前强制回收 + 立即落盘。
     手机上"切后台→被系统回收→回来页面重载"极常见，此时输入框从未失焦，
     change 永远不会触发，配好的 API 就整条不见了。 */
  /* 【修 v1.23】任何输入框只要真的被敲过，就打上 data-dirty 标记。
     卸载/切页回收时只认这些字段，避免用陈旧 DOM 覆盖程序刚写入的配置。 */
  try {
    document.addEventListener('input', e => {
      try { const t = e.target; if (t && t.dataset) t.dataset.dirty = '1'; } catch (_) { /* 忽略 */ }
    }, true);
  } catch (e) { /* 忽略 */ }

  const __persistHook = () => { try { persistNow(document); } catch (e) { /* 忽略 */ } };
  try {
    window.addEventListener('pagehide', __persistHook);
    window.addEventListener('beforeunload', __persistHook);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') __persistHook();
    });
  } catch (e) { /* 忽略 */ }

  const inMenu = !!document.querySelector('[data-hp-entry]');
    console.log('%c[HP-DeepLore] ' + EXT_VER + ' 已就绪', 'color:#4a9d7a;font-weight:bold');
    // 暴露只读调试接口，方便在控制台排查 API 选择等问题
    try {
      window.__hp = {
        ver: EXT_VER, get settings(){return settings;},
        idbGet, idbSet, save: () => { saveSettings(); },
        retrieve, splitNovel, runPool, apiPar, checkIndex, buildIndex, abortBuild, diagText,
        INJECT_LOG, lastInject, scoreAdoption,
        povStrip, scanMoreChars, addCharToAlias, diagnoseNovel, parseChaptersLoose, chapterText,
        compareRetrieve, cn2num, showChapterModal, parseChapters,
        openModelPicker,
        pickApi, apiUses, apiReady, tierFromAff,
        toast, hideToast, openModal,
        // v1.17
        recentContext, looksLikeName, PROMPT_DEF, PROMPT_KEYS, promptApi, promptText,
        aliasRowsHTML, rerank,
        // v1.18 永久记忆
        MEM_STATE, memProbe, memUpdate, memRetrieve, memToPlain, memPromptText, memParseJSON,
        memPost, memFetch, memBaseUrl,
        memPaneHTML, memStatusHTML, memLightPaint, memPanePaint,
        // v1.19 记忆图谱
        showMemoryGraph, memFetchGraph,
        // v1.25 剧情进度控制
        wbProbe, wbApplyChapter, chapterIndexList, locateChapter, runPlotCtl,
        plotPaneHTML, isPlotEntry, entryChapter,
        // v1.26 Slash 命令通道
        wbSlashProbe, wbSlashRun, wbSlashSetEntry, wbCurrentName, entryName, wbReadLive,
      };
    } catch (e) { /* 忽略 */ }
    console.log('  · 菜单入口 : ' + (inMenu ? '✓ 已挂到魔法棒菜单' : '✗ 未找到菜单容器（已用悬浮球 ◈ 兜底）'));
    console.log('  · 悬浮球   : ' + (document.getElementById('hp_gear') ? '✓ 右上角 ◈' : '✗'));
    console.log('  · 节点按钮 : ' + (document.getElementById('hp_fab') ? '✓ 右下角 ◈ 节点' : '✗'));
    console.log('  · ST API   : ' + (Object.keys(ST()).length ? '✓ SillyTavern 全局可用' : '✗ 未取到，使用降级'));
    console.log('  · 打开方式 : 魔法棒菜单 → HP DeepLore，或点右上角 ◈');
  })().catch(e => console.error('[HP-DeepLore] 启动失败：', e));
}
if (typeof jQuery === 'function') jQuery(boot);
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* 浮动面板刷新（若可见） */
function refreshFloating() {
  if (UI.floating?.classList.contains('on')) {
    renderSidebarInto(UI.floating.querySelector('#hp_float_body'));
  }
  if (UI.modalOpen && UI.modalTab === 'node') {
    renderSidebarInto(UI.mask.querySelector('#hp-view-node'));
  }
}
