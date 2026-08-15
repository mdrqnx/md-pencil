/* ── md pencil ──────────────────────────────────────────────────────────
 *
 * 설계의 전제: 마크다운은 편집하지 않는다.
 *
 * 그래서 페이지 폭을 PAGE_W 로 고정하고, 화면 크기에 맞추는 일은
 * CSS transform: scale() 로만 합니다. 화면을 회전하든 확대하든 문서가
 * 다시 흐르지 않으므로, 필기 좌표는 한 번 정해지면 영원히 유효합니다.
 * (문서가 리플로우되면 필기가 통째로 어긋납니다. 그게 이런 앱의 유일한 난제인데,
 *  "수정 안 한다"는 전제 하나로 사라집니다.)
 *
 * 좌표계
 *   페이지 좌표 : PAGE_W × pageH 의 논리 픽셀. 스트로크는 전부 이 좌표로 저장.
 *   화면 좌표   : 페이지 좌표 × zoom.
 *   백킹스토어  : 페이지 좌표 × R,  R = clamp(devicePixelRatio × zoom, 1, 3)
 *
 * 입력
 *   애플펜슬은 touch.touchType === 'stylus' 로 구분해 preventDefault() 하고,
 *   손가락은 건드리지 않아 네이티브 스크롤(관성 포함)이 그대로 살아 있습니다.
 * ───────────────────────────────────────────────────────────────────── */

(() => {
'use strict';

// ── 상수 ────────────────────────────────────────────────────────────────

const PAGE_W    = 900;    // 페이지 논리 폭. 이 값은 절대 바뀌지 않습니다.
const TILE_H    = 1024;   // 잉크 타일 하나의 높이 (페이지 좌표)
const TAIL_H    = 360;    // 문서 끝 아래에 남겨두는 필기 여백
const MAX_R     = 3;      // 백킹스토어 배율 상한
const ZOOM_MIN  = 0.4;
const ZOOM_MAX  = 2.5;

const PEN_BASE  = 5.0;    // 펜 기준 두께 (필압 1.0 기준)
const PEN_SIZES = [0.85, 1.3, 2.1];   // 가늘게 / 보통 / 굵게
const HI_BASE   = 17;     // 형광펜 두께
const HI_ALPHA  = 0.32;
const ERASE_R   = 13;     // 지우개 반경 (페이지 좌표)

const PEN_COLORS = ['#1c1c1e', '#d1372e', '#2f6fd0', '#1f9254', '#b45309'];
const HI_COLORS  = ['#ffd84d', '#8ce99a', '#ffa8d2', '#8fd6ff', '#c9b6ff'];

// ── 상태 ────────────────────────────────────────────────────────────────

const state = {
  doc:      null,   // {id, name, md}
  strokes:  [],
  undo:     [],
  redo:     [],
  tool:     'pen',
  penColor: PEN_COLORS[0],
  hiColor:  HI_COLORS[0],
  sizeMul:  PEN_SIZES[1],
  zoom:     1,
  pageH:    0,
};

const el = {};
[ 'toolbar','scroller','canvasWrap','page','doc','ink','empty','emptyOpen','emptyRecent',
  'btnLibrary','btnUndo','btnRedo','btnZoomIn','btnZoomOut','btnZoomFit',
  'toolGroup','swatches','sizes','sheet','tabs','recentList','recentEmpty',
  'fileInput','filedrop','pasteName','pasteArea','pasteGo','urlInput','urlGo','urlErr','toast',
  'btnExport','btnImport','importInput','backupStat'
].forEach(id => el[id] = document.getElementById(id));


// ── 저장소 (IndexedDB) ──────────────────────────────────────────────────

const DB_NAME = 'mdpencil', DB_VER = 1;
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('ink'))  d.createObjectStore('ink',  { keyPath: 'id' });
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror   = () => rej(rq.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const rq = fn(t.objectStore(store));
    t.oncomplete = () => res(rq && rq.result);
    t.onerror    = () => rej(t.error);
    t.onabort    = () => rej(t.error);
  });
}

const putDoc     = doc => tx('docs', 'readwrite', s => s.put(doc));
const getDoc     = id  => tx('docs', 'readonly',  s => s.get(id));
const allDocs    = ()  => tx('docs', 'readonly',  s => s.getAll());
const delDoc     = id  => tx('docs', 'readwrite', s => s.delete(id));
const putInk     = rec => tx('ink',  'readwrite', s => s.put(rec));
const getInk     = id  => tx('ink',  'readonly',  s => s.get(id));
const allInk     = ()  => tx('ink',  'readonly',  s => s.getAll());
const delInk     = id  => tx('ink',  'readwrite', s => s.delete(id));

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
                                     : 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

let saveTimer = null;
function saveInkSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveInkNow, 700);
}
async function saveInkNow() {
  clearTimeout(saveTimer);
  if (!state.doc) return;
  // 좌표는 소수 1자리면 충분합니다 (0.1px). 저장 크기가 절반 아래로 줄어듭니다.
  const strokes = state.strokes.map(s => ({
    t: s.t, c: s.c, w: s.w,
    p: Array.from(s.p, v => Math.round(v * 10) / 10),
    bb: s.bb.map(v => Math.round(v * 10) / 10),
  }));
  try {
    await putInk({ id: state.doc.id, strokes });
    await putDoc({ ...state.doc, updatedAt: Date.now(), pageH: state.pageH, inkCount: strokes.length });
  } catch (e) { console.warn('저장 실패', e); }
}


// ── 마크다운 ────────────────────────────────────────────────────────────

const mdit = window.markdownit({ html: false, linkify: true, breaks: false, typographer: false });

function renderMarkdown(src) {
  el.doc.innerHTML = mdit.render(src);

  // 외부 링크는 새 탭으로 (홈 화면 앱이 브라우저로 튕겨나가지 않게)
  el.doc.querySelectorAll('a[href^="http"]').forEach(a => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });

  // - [ ] / - [x] 를 체크박스로
  el.doc.querySelectorAll('li').forEach(li => {
    let node = li.firstChild;
    if (node && node.nodeType === 1 && node.tagName === 'P') node = node.firstChild;
    if (!node || node.nodeType !== 3) return;
    const m = /^\[([ xX])\]\s+/.exec(node.nodeValue);
    if (!m) return;
    node.nodeValue = node.nodeValue.slice(m[0].length);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = true;
    cb.checked = m[1] !== ' ';
    node.parentNode.insertBefore(cb, node);
    li.classList.add('task-list-item');
  });
}


// ── 레이아웃 ────────────────────────────────────────────────────────────

function fitZoom() {
  const avail = el.scroller.clientWidth - 24;
  return clamp(avail / PAGE_W, ZOOM_MIN, ZOOM_MAX);
}

function relayout() {
  const z = state.zoom;

  el.page.style.width = PAGE_W + 'px';
  el.page.style.height = 'auto';
  const docH = el.doc.offsetHeight;
  const pageH = Math.max(docH + TAIL_H, Math.ceil(el.scroller.clientHeight / z));

  state.pageH = pageH;
  el.page.style.height = pageH + 'px';
  el.page.style.transform = `scale(${z})`;

  el.canvasWrap.style.width  = Math.round(PAGE_W * z) + 'px';
  el.canvasWrap.style.height = Math.round(pageH * z) + 'px';

  el.btnZoomFit.textContent = Math.round(z * 100) + '%';

  buildTiles();
}

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

// 화면의 한 점을 붙잡은 채 배율만 바꿉니다. 타일은 건드리지 않으므로 핀치
// 도중에도 부드럽습니다. 손을 떼면 relayout() 이 해상도를 다시 맞춥니다.
function applyZoomVisual(z, cx, cy) {
  const rect = el.page.getBoundingClientRect();
  const s0 = rect.width / PAGE_W;
  const px = (cx - rect.left) / s0;      // 붙잡을 지점의 페이지 좌표
  const py = (cy - rect.top) / s0;

  state.zoom = z;
  el.page.style.transform = `scale(${z})`;
  el.canvasWrap.style.width  = Math.round(PAGE_W * z) + 'px';
  el.canvasWrap.style.height = Math.round(state.pageH * z) + 'px';
  el.btnZoomFit.textContent = Math.round(z * 100) + '%';

  const sr = el.scroller.getBoundingClientRect();
  el.scroller.scrollLeft = px * z + el.canvasWrap.offsetLeft - (cx - sr.left);
  el.scroller.scrollTop  = py * z + el.canvasWrap.offsetTop  - (cy - sr.top);
}

function setZoom(z) {
  z = clamp(z, ZOOM_MIN, ZOOM_MAX);
  if (Math.abs(z - state.zoom) < 0.001) return;
  const sr = el.scroller.getBoundingClientRect();
  applyZoomVisual(z, sr.left + sr.width / 2, sr.top + sr.height / 2);
  relayout();
  updatePageRect();
}


// ── 잉크 타일 ───────────────────────────────────────────────────────────
//
// 문서 전체를 canvas 한 장으로 덮으면 iOS 의 canvas 크기 한계에 걸리고
// 메모리도 감당이 안 됩니다. TILE_H 단위로 잘라 두고, 화면에 보이는 것
// ±1장만 백킹스토어를 잡습니다. 나머지는 width=0 으로 메모리를 반납하고,
// 필요해지면 스트로크 벡터에서 다시 그립니다.

let tiles = [];

function backingRatio() {
  return clamp((window.devicePixelRatio || 1) * state.zoom, 1, MAX_R);
}

function buildTiles() {
  const n = Math.max(1, Math.ceil(state.pageH / TILE_H));

  while (tiles.length > n) {
    const t = tiles.pop();
    t.cv.remove();
  }
  while (tiles.length < n) {
    const cv = document.createElement('canvas');
    cv.width = 0; cv.height = 0;      // 화면에 들어올 때 비로소 백킹스토어를 잡습니다
    cv.style.width = PAGE_W + 'px';
    el.ink.appendChild(cv);
    tiles.push({ cv, ctx: cv.getContext('2d'), top: 0, h: 0, mounted: false, dirty: true });
  }

  for (let i = 0; i < n; i++) {
    const t = tiles[i];
    t.top = i * TILE_H;
    t.h = Math.min(TILE_H, state.pageH - t.top);
    t.cv.style.top = t.top + 'px';
    t.cv.style.height = t.h + 'px';
    t.mounted = false;         // 배율이 바뀌었을 수 있으므로 전부 다시 잡습니다
    t.dirty = true;
  }
  updateTileMounts(true);
}

function updateTileMounts(immediate) {
  if (!tiles.length) return;
  const z = state.zoom;
  const top    = el.scroller.scrollTop / z;
  const bottom = (el.scroller.scrollTop + el.scroller.clientHeight) / z;
  const first = Math.max(0, Math.floor(top / TILE_H) - 1);
  const last  = Math.min(tiles.length - 1, Math.floor(bottom / TILE_H) + 1);
  const R = backingRatio();

  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const want = i >= first && i <= last;
    if (want && !t.mounted) {
      t.cv.width  = Math.round(PAGE_W * R);
      t.cv.height = Math.round(t.h * R);
      t.ctx = t.cv.getContext('2d');
      t.R = R;
      t.mounted = true;
      t.dirty = true;
    } else if (!want && t.mounted) {
      t.cv.width = 0; t.cv.height = 0;
      t.mounted = false;
    }
  }
  scheduleRepaint(immediate);
}

let repaintQueued = false;

function repaintNow() {
  repaintQueued = false;
  for (const t of tiles) if (t.mounted && t.dirty) paintTile(t);
}

// 문서를 열거나 배율을 바꿀 때는 즉시 그립니다. rAF 는 탭이 아직 화면에
// 올라오지 않았으면 실행되지 않아서, 그때 맡겨두면 필기가 빠진 화면이 남습니다.
function scheduleRepaint(immediate) {
  if (immediate) { repaintNow(); return; }
  if (repaintQueued) return;
  repaintQueued = true;
  requestAnimationFrame(repaintNow);
}

function markDirty(bb) {
  const y0 = bb[1], y1 = bb[3];
  for (const t of tiles) {
    if (y1 < t.top || y0 > t.top + t.h) continue;
    t.dirty = true;
  }
  scheduleRepaint();
}

function paintTile(t) {
  const ctx = t.ctx, R = t.R;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, t.cv.width, t.cv.height);
  // 페이지 좌표로 그릴 수 있도록: 배율 R, 타일 상단만큼 위로 이동
  ctx.setTransform(R, 0, 0, R, 0, -t.top * R);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const top = t.top, bot = t.top + t.h;
  for (const s of state.strokes) {
    if (s.bb[3] < top || s.bb[1] > bot) continue;
    drawStroke(ctx, s);
  }
  t.dirty = false;
}


// ── 스트로크 그리기 ─────────────────────────────────────────────────────

function drawStroke(ctx, s) {
  const p = s.p, n = p.length / 3;
  if (n === 0) return;

  if (s.t === 'hi') {
    // 형광펜: 고정 두께 · 반투명. 한 번에 한 path 로 그려야 자기 자신과
    // 겹치는 부분이 진해지지 않습니다.
    ctx.save();
    ctx.globalAlpha = HI_ALPHA;
    ctx.strokeStyle = s.c;
    ctx.lineWidth = s.w;
    ctx.beginPath();
    if (n === 1) {
      ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + 0.01, p[1]);
    } else {
      ctx.moveTo(p[0], p[1]);
      let mx = p[0], my = p[1];
      for (let i = 1; i < n - 1; i++) {
        const x = p[i * 3], y = p[i * 3 + 1];
        mx = (x + p[(i + 1) * 3]) / 2;
        my = (y + p[(i + 1) * 3 + 1]) / 2;
        ctx.quadraticCurveTo(x, y, mx, my);
      }
      ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  // 펜: 필압에 따라 조각마다 두께가 달라지므로 조각 단위로 그립니다.
  ctx.strokeStyle = s.c;
  ctx.globalAlpha = 1;

  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], widthAt(s, p[2]) / 2, 0, Math.PI * 2);
    ctx.fillStyle = s.c;
    ctx.fill();
    return;
  }

  let px = p[0], py = p[1];
  let mx = (p[0] + p[3]) / 2, my = (p[1] + p[4]) / 2;

  ctx.beginPath();
  ctx.moveTo(px, py); ctx.lineTo(mx, my);
  ctx.lineWidth = widthAt(s, (p[2] + p[5]) / 2);
  ctx.stroke();

  for (let i = 1; i < n - 1; i++) {
    const x = p[i * 3], y = p[i * 3 + 1];
    const nx = (x + p[(i + 1) * 3]) / 2, ny = (y + p[(i + 1) * 3 + 1]) / 2;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.quadraticCurveTo(x, y, nx, ny);
    ctx.lineWidth = widthAt(s, (p[i * 3 + 2] + p[(i + 1) * 3 + 2]) / 2);
    ctx.stroke();
    mx = nx; my = ny;
  }

  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
  ctx.lineWidth = widthAt(s, p[(n - 1) * 3 + 2]);
  ctx.stroke();
}

// 필압 → 두께. 절반을 바닥에 깔아, 가볍게 스쳐도 선이 실처럼 가늘어지지 않습니다.
const widthAt = (s, pr) => s.w * (0.5 + 0.5 * clamp(pr, 0, 1));

// 그리는 중에는 방금 들어온 조각만 덧그립니다 (전체 재렌더 없이).
function drawLastSegment(s) {
  const p = s.p, n = p.length / 3;
  if (n < 2) return;
  const i = n - 2;
  const x0 = p[i * 3], y0 = p[i * 3 + 1], r0 = p[i * 3 + 2];
  const x1 = p[i * 3 + 3], y1 = p[i * 3 + 4], r1 = p[i * 3 + 5];
  const w = s.t === 'hi' ? s.w : widthAt(s, (r0 + r1) / 2);
  const yLo = Math.min(y0, y1) - w, yHi = Math.max(y0, y1) + w;

  for (const t of tiles) {
    if (!t.mounted || yHi < t.top || yLo > t.top + t.h) continue;
    const ctx = t.ctx;
    ctx.save();
    if (s.t === 'hi') { ctx.globalAlpha = HI_ALPHA; }
    ctx.strokeStyle = s.c;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
  }
}


// ── 입력 ────────────────────────────────────────────────────────────────

let pageRect = null;
function updatePageRect() { pageRect = el.page.getBoundingClientRect(); }

function toPage(clientX, clientY) {
  if (!pageRect) updatePageRect();
  // rect 는 transform 이 적용된 실측값이라, 브라우저 자체 확대까지 자동으로 흡수됩니다.
  const s = pageRect.width / PAGE_W;
  return { x: (clientX - pageRect.left) / s, y: (clientY - pageRect.top) / s };
}

let active = null;      // 그리는 중인 스트로크
let eraseSession = null;// 지우는 중 삭제된 항목들
let activeId = null;    // 터치 식별자 (마우스는 'mouse')
let sawTouch = false;   // 아이패드에서 뒤따라오는 가짜 마우스 이벤트를 무시하기 위한 플래그

function beginInput(id, cx, cy, force) {
  if (!state.doc) return;
  updatePageRect();
  const { x, y } = toPage(cx, cy);
  activeId = id;
  document.body.classList.add('drawing');

  if (state.tool === 'eraser') {
    eraseSession = [];
    eraseAt(x, y);
    return;
  }

  const isHi = state.tool === 'hi';
  active = {
    t: isHi ? 'hi' : 'pen',
    c: isHi ? state.hiColor : state.penColor,
    w: (isHi ? HI_BASE : PEN_BASE) * state.sizeMul,
    p: [x, y, force],
    bb: [x, y, x, y],
  };
}

function moveInput(cx, cy, force) {
  const { x, y } = toPage(cx, cy);

  if (state.tool === 'eraser') { if (eraseSession) eraseAt(x, y); return; }
  if (!active) return;

  const p = active.p, n = p.length;
  const dx = x - p[n - 3], dy = y - p[n - 2];
  if (dx * dx + dy * dy < 1.2) return;    // 너무 촘촘한 점은 버립니다

  // 필압을 살짝 뭉개면 선 굵기가 덜 떨립니다
  const smooth = p[n - 1] * 0.4 + force * 0.6;
  p.push(x, y, smooth);

  const bb = active.bb;
  if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y;
  if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y;

  drawLastSegment(active);
}

function endInput() {
  document.body.classList.remove('drawing');
  activeId = null;

  if (state.tool === 'eraser') {
    if (eraseSession && eraseSession.length) {
      state.undo.push({ k: 'del', items: eraseSession });
      state.redo.length = 0;
      saveInkSoon();
      refreshHistoryButtons();
    }
    eraseSession = null;
    return;
  }

  if (!active) return;
  const s = active;
  active = null;
  if (s.p.length < 3) return;

  const pad = s.w;
  s.bb = [s.bb[0] - pad, s.bb[1] - pad, s.bb[2] + pad, s.bb[3] + pad];
  state.strokes.push(s);
  state.undo.push({ k: 'add', s });
  state.redo.length = 0;

  markDirty(s.bb);   // 직선으로 그려둔 것을 부드러운 곡선으로 확정
  saveInkSoon();
  refreshHistoryButtons();
}

function eraseAt(x, y) {
  let removed = false;
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const s = state.strokes[i];
    if (!hitStroke(s, x, y, ERASE_R)) continue;
    state.strokes.splice(i, 1);
    eraseSession.push({ i, s });
    markDirty(s.bb);
    removed = true;
  }
  if (removed) saveInkSoon();
}

function hitStroke(s, x, y, r) {
  const bb = s.bb;
  if (x < bb[0] - r || x > bb[2] + r || y < bb[1] - r || y > bb[3] + r) return false;
  const p = s.p, n = p.length / 3;
  const rr = r + s.w * 0.5, rr2 = rr * rr;
  for (let i = 0; i < n; i++) {
    const dx = p[i * 3] - x, dy = p[i * 3 + 1] - y;
    if (dx * dx + dy * dy <= rr2) return true;
  }
  for (let i = 1; i < n; i++) {                 // 긴 직선 구간도 잡히게
    if (segDist2(p[(i - 1) * 3], p[(i - 1) * 3 + 1], p[i * 3], p[i * 3 + 1], x, y) <= rr2) return true;
  }
  return false;
}

function segDist2(x0, y0, x1, y1, px, py) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const ex = x0 + t * dx - px, ey = y0 + t * dy - py;
  return ex * ex + ey * ey;
}

// ── 터치 (애플펜슬) ─────────────────────────────────────────────────────

const isStylus = t => t.touchType === 'stylus';
function forceOf(t) {
  let f = t.force;
  if (!(f > 0)) return 0.5;              // 미지원이거나 아직 값이 안 실린 경우
  const max = t.maximumPossibleForce || 1;
  return clamp(max > 0 ? f / max : f, 0.02, 1);
}

// 손가락 두 개: 벌리면 확대, 움직이지 않고 톡 치면 펜↔지우개.
// (애플펜슬 더블탭은 UIPencilInteraction 으로만 오고 웹에는 전달되지 않습니다.)
let pinch = null;

const fingersOf = e => Array.prototype.filter.call(e.touches, t => !isStylus(t));
const distOf = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const TAP_SLOP = 12, TAP_MS = 320;

el.scroller.addEventListener('touchstart', e => {
  sawTouch = true;
  if (!state.doc) return;

  if (!pinch && !active && !eraseSession) {
    for (const t of e.changedTouches) {
      if (!isStylus(t)) continue;
      e.preventDefault();                 // 펜일 때만 스크롤을 막습니다
      beginInput(t.identifier, t.clientX, t.clientY, forceOf(t));
      return;
    }
  }

  const f = fingersOf(e);
  if (f.length === 2 && activeId === null) {
    e.preventDefault();
    pinch = {
      d0: distOf(f[0], f[1]),
      z0: state.zoom,
      cx: (f[0].clientX + f[1].clientX) / 2,
      cy: (f[0].clientY + f[1].clientY) / 2,
      moved: false,
      t0: performance.now(),
    };
  }
}, { passive: false });

el.scroller.addEventListener('touchmove', e => {
  if (pinch) {
    const f = fingersOf(e);
    if (f.length < 2) return;
    e.preventDefault();
    const d = distOf(f[0], f[1]);
    if (!pinch.moved && Math.abs(d - pinch.d0) > TAP_SLOP) pinch.moved = true;
    if (pinch.moved && pinch.d0 > 0) {
      applyZoomVisual(clamp(pinch.z0 * (d / pinch.d0), ZOOM_MIN, ZOOM_MAX), pinch.cx, pinch.cy);
    }
    return;
  }

  if (activeId === null || activeId === 'mouse') return;
  for (const t of e.changedTouches) {
    if (t.identifier !== activeId) continue;
    e.preventDefault();
    moveInput(t.clientX, t.clientY, forceOf(t));
    return;
  }
}, { passive: false });

function onTouchEnd(e) {
  if (pinch && fingersOf(e).length < 2) {
    const tapped = !pinch.moved && (performance.now() - pinch.t0) < TAP_MS;
    pinch = null;
    if (tapped) toggleEraser();
    else { relayout(); updatePageRect(); }   // 새 배율에 맞춰 잉크 해상도를 다시 잡습니다
    return;
  }

  if (activeId === null || activeId === 'mouse') return;
  for (const t of e.changedTouches) {
    if (t.identifier !== activeId) continue;
    endInput();
    return;
  }
}
el.scroller.addEventListener('touchend', onTouchEnd);
el.scroller.addEventListener('touchcancel', onTouchEnd);

// Safari 가 페이지 전체를 확대해버리지 않도록 막습니다
['gesturestart', 'gesturechange', 'gestureend'].forEach(t =>
  document.addEventListener(t, e => e.preventDefault(), { passive: false }));

// ── 마우스 (PC 에서 확인할 때만) ────────────────────────────────────────

el.scroller.addEventListener('mousedown', e => {
  if (sawTouch || e.button !== 0 || !state.doc) return;
  if (e.target.closest('a')) return;
  e.preventDefault();
  beginInput('mouse', e.clientX, e.clientY, 0.55);
});
window.addEventListener('mousemove', e => {
  if (activeId !== 'mouse') return;
  moveInput(e.clientX, e.clientY, 0.55);
});
window.addEventListener('mouseup', () => { if (activeId === 'mouse') endInput(); });


// ── 되돌리기 ────────────────────────────────────────────────────────────

function undo() {
  const op = state.undo.pop();
  if (!op) return;
  if (op.k === 'add') {
    const i = state.strokes.lastIndexOf(op.s);
    if (i >= 0) state.strokes.splice(i, 1);
    markDirty(op.s.bb);
  } else {
    for (const it of op.items.slice().sort((a, b) => a.i - b.i)) {
      state.strokes.splice(Math.min(it.i, state.strokes.length), 0, it.s);
      markDirty(it.s.bb);
    }
  }
  state.redo.push(op);
  saveInkSoon();
  refreshHistoryButtons();
}

function redo() {
  const op = state.redo.pop();
  if (!op) return;
  if (op.k === 'add') {
    state.strokes.push(op.s);
    markDirty(op.s.bb);
  } else {
    for (const it of op.items.slice().sort((a, b) => b.i - a.i)) {
      const i = state.strokes.lastIndexOf(it.s);
      if (i >= 0) state.strokes.splice(i, 1);
      markDirty(it.s.bb);
    }
  }
  state.undo.push(op);
  saveInkSoon();
  refreshHistoryButtons();
}

function refreshHistoryButtons() {
  el.btnUndo.disabled = !state.undo.length;
  el.btnRedo.disabled = !state.redo.length;
}


// ── 문서 열기 ───────────────────────────────────────────────────────────

async function openDoc(doc) {
  await saveInkNow();

  state.doc = doc;
  state.undo.length = 0;
  state.redo.length = 0;
  refreshHistoryButtons();

  renderMarkdown(doc.md);
  el.empty.hidden = true;

  const rec = await getInk(doc.id).catch(() => null);
  state.strokes = (rec && rec.strokes ? rec.strokes : []).map(s => ({
    t: s.t, c: s.c, w: s.w, p: s.p, bb: s.bb,
  }));

  state.zoom = fitZoom();
  el.scroller.scrollTop = 0;
  relayout();
  updatePageRect();
  document.title = doc.name + ' — md pencil';

  await putDoc({ ...doc, updatedAt: Date.now(), pageH: state.pageH });
}

async function addDoc(name, md, { open = true } = {}) {
  const doc = { id: uid(), name: name || '제목 없음', md, createdAt: Date.now(), updatedAt: Date.now() };
  await putDoc(doc);
  if (open) { closeSheet(); await openDoc(doc); }
  return doc;
}

const TEXT_EXT = /\.(md|markdown|mdown|mkd|mdx|txt|text)$/i;
const stripExt = n => n.replace(TEXT_EXT, '');

const readText = f => (f.text ? f.text() : new Promise((res, rej) => {
  const r = new FileReader();
  r.onload  = () => res(r.result);
  r.onerror = () => rej(r.error || new Error('읽기 실패'));
  r.readAsText(f);
}));

async function readFiles(fileList) {
  const all = Array.from(fileList || []);
  if (!all.length) return;

  const files = all.filter(f => TEXT_EXT.test(f.name || '') || /^text\//.test(f.type || ''));
  if (!files.length) {
    toast(`읽을 수 없는 형식입니다: ${all[0].name || '이름 없는 파일'}`);
    return;
  }

  let last = null, failed = 0;
  for (const f of files) {
    try {
      const md = await readText(f);
      last = await addDoc(stripExt(f.name), md, { open: false });
    } catch (e) {
      failed++;
      console.warn('파일을 읽지 못했습니다:', f.name, e);
    }
  }

  if (!last) { toast(`파일을 읽지 못했습니다 (${failed}개 실패)`); return; }

  closeSheet();
  await openDoc(last);
  if (files.length > 1) toast(`${files.length - failed}개를 넣었습니다`);
}

function toRawUrl(u) {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  return u;
}

async function fetchUrl(u) {
  el.urlErr.hidden = true;
  const raw = toRawUrl(u.trim());
  if (!/^https?:\/\//.test(raw)) { showUrlErr('http 나 https 로 시작하는 주소를 넣어주세요'); return; }
  el.urlGo.disabled = true;
  el.urlGo.textContent = '가져오는 중…';
  try {
    const r = await fetch(raw, { redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const md = await r.text();
    const name = stripExt(decodeURIComponent(raw.split('/').pop() || '문서'));
    el.urlInput.value = '';
    await addDoc(name, md);
  } catch (e) {
    showUrlErr('가져오지 못했습니다: ' + e.message +
               '\n비공개 저장소이거나, 그 서버가 외부 접근을 막고 있을 수 있습니다.');
  } finally {
    el.urlGo.disabled = false;
    el.urlGo.textContent = '가져오기';
  }
}
function showUrlErr(m) { el.urlErr.textContent = m; el.urlErr.hidden = false; }


// ── 최근 문서 목록 ──────────────────────────────────────────────────────

async function loadRecent() {
  let docs = [];
  try { docs = (await allDocs()) || []; } catch { /* 저장소를 못 쓰는 상황 */ }
  docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  renderRecent(el.recentList, docs);
  renderRecent(el.emptyRecent, docs.slice(0, 5));
  el.recentEmpty.hidden = docs.length > 0;

  const ink = docs.reduce((n, d) => n + (d.inkCount || 0), 0);
  el.backupStat.textContent = docs.length ? `문서 ${docs.length}개 · 필기 ${ink}획` : '';
  return docs;
}

function renderRecent(ul, docs) {
  ul.innerHTML = '';
  for (const d of docs) {
    const li = document.createElement('li');

    const main = document.createElement('div');
    main.className = 'rc-main';
    const nm = document.createElement('span');
    nm.className = 'rc-name';
    nm.textContent = d.name;
    const meta = document.createElement('span');
    meta.className = 'rc-meta';
    meta.textContent = [fmtDate(d.updatedAt), d.inkCount ? `필기 ${d.inkCount}` : null]
                       .filter(Boolean).join(' · ');
    main.append(nm, meta);
    main.addEventListener('click', async () => {
      const full = await getDoc(d.id);
      if (!full) { toast('문서를 찾지 못했습니다'); return; }
      closeSheet();
      await openDoc(full);
    });

    const del = document.createElement('button');
    del.className = 'rc-del';
    del.textContent = '×';
    del.title = '삭제';
    del.addEventListener('click', async ev => {
      ev.stopPropagation();
      await delDoc(d.id); await delInk(d.id).catch(() => {});
      if (state.doc && state.doc.id === d.id) {
        state.doc = null; state.strokes = []; el.doc.innerHTML = '';
        el.empty.hidden = false; document.title = 'md pencil';
        relayout();
      }
      loadRecent();
      toast('삭제했습니다');
    });

    li.append(main, del);
    ul.appendChild(li);
  }
}

// ── 백업 ────────────────────────────────────────────────────────────────
//
// 문서와 필기는 이 기기의 IndexedDB 에만 있습니다. 기기를 초기화하면 그대로
// 사라지므로, 통째로 파일 하나에 담아 밖으로 빼낼 길이 필요합니다.

const BACKUP_FORMAT = 'md-pencil-backup';

async function collectBackup() {
  await saveInkNow();
  const docs = (await allDocs()) || [];
  const ink  = (await allInk())  || [];
  const inkMap = new Map(ink.map(r => [r.id, r.strokes || []]));
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    docs: docs.map(d => ({ ...d, strokes: inkMap.get(d.id) || [] })),
  };
}

function backupFileName() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `md-pencil-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

async function exportAll() {
  el.btnExport.disabled = true;
  const label = el.btnExport.textContent;
  el.btnExport.textContent = '준비 중…';
  try {
    const payload = await collectBackup();
    if (!payload.docs.length) { toast('내보낼 문서가 없습니다'); return; }

    const json = JSON.stringify(payload);
    const name = backupFileName();
    const blob = new Blob([json], { type: 'application/json' });

    // 아이패드에서는 공유 시트가 자연스럽습니다 — "파일에 저장" 으로 iCloud Drive 에 넣을 수 있습니다.
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'md pencil 백업' });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // 사용자가 취소한 것이므로 조용히 물러납니다
        // 공유가 안 되는 상황이면 아래 내려받기로 넘어갑니다
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`${payload.docs.length}개 문서를 내보냈습니다`);
  } catch (e) {
    toast('내보내기에 실패했습니다: ' + e.message);
  } finally {
    el.btnExport.disabled = false;
    el.btnExport.textContent = label;
  }
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.docs)) {
      toast('md pencil 백업 파일이 아닙니다');
      return;
    }

    await saveInkNow();

    let added = 0, replaced = 0;
    for (const entry of data.docs) {
      if (!entry || !entry.id || typeof entry.md !== 'string') continue;
      const { strokes, ...doc } = entry;
      const exists = await getDoc(doc.id);
      await putDoc(doc);
      await putInk({ id: doc.id, strokes: Array.isArray(strokes) ? strokes : [] });
      exists ? replaced++ : added++;
    }

    const docs = await loadRecent();

    if (state.doc) {
      // 지금 보고 있는 문서를 백업이 덮어썼다면 화면도 새 내용으로 맞춥니다
      const fresh = await getDoc(state.doc.id);
      if (fresh) await openDoc(fresh);
    } else if (docs.length) {
      // 빈 화면이었다면 가져온 것 중 가장 최근 문서를 바로 열어줍니다
      const full = await getDoc(docs[0].id);
      if (full) { closeSheet(); await openDoc(full); }
    }

    toast(added || replaced ? `새 문서 ${added}개, 덮어쓴 문서 ${replaced}개` : '가져올 문서가 없습니다');
  } catch (e) {
    toast('가져오기에 실패했습니다: ' + e.message);
  }
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric' });
}


// ── UI 배선 ─────────────────────────────────────────────────────────────

function buildSwatches() {
  el.swatches.innerHTML = '';
  const colors = state.tool === 'hi' ? HI_COLORS : PEN_COLORS;
  const cur = state.tool === 'hi' ? state.hiColor : state.penColor;
  const disabled = state.tool === 'eraser';
  el.swatches.style.display = disabled ? 'none' : '';
  el.sizes.style.display = disabled ? 'none' : '';
  if (disabled) return;

  for (const c of colors) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === cur ? ' on' : '');
    b.style.setProperty('--sw', c);
    b.addEventListener('click', () => {
      if (state.tool === 'hi') state.hiColor = c; else state.penColor = c;
      buildSwatches();
    });
    el.swatches.appendChild(b);
  }
}

let lastDrawTool = 'pen';

function setTool(t) {
  if (t !== 'eraser') lastDrawTool = t;
  state.tool = t;
  el.toolGroup.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  buildSwatches();
}

// 두 손가락 탭으로 부르는 토글. 지우개에서 돌아올 때는 직전에 쓰던 펜으로 갑니다.
function toggleEraser() {
  const next = state.tool === 'eraser' ? lastDrawTool : 'eraser';
  setTool(next);
  toast({ eraser: '지우개', hi: '형광펜', pen: '펜' }[next]);
}

el.toolGroup.querySelectorAll('.tool').forEach(b => {
  b.addEventListener('click', () => setTool(b.dataset.tool));
});

el.sizes.querySelectorAll('.size').forEach(b => {
  b.addEventListener('click', () => {
    state.sizeMul = parseFloat(b.dataset.size);
    el.sizes.querySelectorAll('.size').forEach(x => x.classList.toggle('on', x === b));
  });
});

el.btnUndo.addEventListener('click', undo);
el.btnRedo.addEventListener('click', redo);
el.btnZoomIn .addEventListener('click', () => setZoom(state.zoom * 1.15));
el.btnZoomOut.addEventListener('click', () => setZoom(state.zoom / 1.15));
el.btnZoomFit.addEventListener('click', () => setZoom(fitZoom()));

el.scroller.addEventListener('scroll', () => {
  updatePageRect();
  updateTileMounts();
}, { passive: true });

window.addEventListener('resize', () => {
  // 폭에 맞춰 배율만 다시 잡습니다. 문서는 다시 흐르지 않습니다.
  if (!state.doc) { relayout(); return; }
  state.zoom = fitZoom();
  relayout();
  updatePageRect();
});

// ── 시트 ────────────────────────────────────────────────────────────────

function openSheet(tab) {
  el.sheet.hidden = false;
  selectTab(tab || 'recent');
  loadRecent();
}
function closeSheet() { el.sheet.hidden = true; }

function selectTab(name) {
  el.tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach(p => p.hidden = p.dataset.pane !== name);
}

el.tabs.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheet));
el.btnLibrary.addEventListener('click', () => openSheet());
el.emptyOpen.addEventListener('click', () => openSheet('file'));

el.filedrop.addEventListener('click', () => el.fileInput.click());

// value 비우기는 반드시 읽기가 끝난 다음에. 먼저 비우면 iOS 에서 파일 핸들이
// 무효가 되어 읽는 도중 실패합니다.
el.fileInput.addEventListener('change', async e => {
  const files = e.target.files;
  try { if (files && files.length) await readFiles(files); }
  finally { e.target.value = ''; }
});

['dragenter', 'dragover'].forEach(t => el.filedrop.addEventListener(t, e => {
  e.preventDefault(); el.filedrop.classList.add('over');
}));
['dragleave', 'drop'].forEach(t => el.filedrop.addEventListener(t, e => {
  e.preventDefault(); el.filedrop.classList.remove('over');
}));
el.filedrop.addEventListener('drop', e => { if (e.dataTransfer) readFiles(e.dataTransfer.files); });

el.pasteGo.addEventListener('click', () => {
  const md = el.pasteArea.value;
  if (!md.trim()) { toast('내용이 비어 있습니다'); return; }
  const guess = (md.match(/^#\s+(.+)$/m) || [])[1];
  addDoc(el.pasteName.value.trim() || guess || '붙여넣은 문서', md);
  el.pasteArea.value = ''; el.pasteName.value = '';
});

el.btnExport.addEventListener('click', exportAll);
el.btnImport.addEventListener('click', () => el.importInput.click());
el.importInput.addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) importBackup(f);
});

el.urlGo.addEventListener('click', () => fetchUrl(el.urlInput.value));
el.urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchUrl(el.urlInput.value); });

// 앱 어디서든 md 파일을 떨어뜨리면 받습니다
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length) readFiles(e.dataTransfer.files);
});

// ── 키보드 (외장 키보드용) ──────────────────────────────────────────────

window.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openSheet(); }
  else if (!mod && e.key === 'Escape') closeSheet();
  else if (!mod && (e.key === '1' || e.key === '2' || e.key === '3')) {
    setTool({ '1': 'pen', '2': 'hi', '3': 'eraser' }[e.key]);
  }
});

// ── 토스트 ──────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

// 나가기 전에 저장을 확정
window.addEventListener('pagehide', saveInkNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveInkNow(); });


// ── 부팅 ────────────────────────────────────────────────────────────────

(async function boot() {
  setTool('pen');
  el.sizes.querySelectorAll('.size')[1].classList.add('on');
  state.zoom = fitZoom();
  relayout();

  const docs = await loadRecent();
  if (docs.length) {
    const full = await getDoc(docs[0].id);
    if (full) { await openDoc(full); return; }
  }
  el.empty.hidden = false;
})();

// 오프라인 캐시는 실제 배포에서만 켭니다. 개발 중에 켜 두면 고친 파일 대신
// 캐시가 계속 나와서 왜 안 바뀌는지 한참 헤매게 됩니다.
const isLocal = location.hostname === 'localhost'
             || location.hostname === '127.0.0.1'
             || /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname);

if ('serviceWorker' in navigator && !isLocal) {
  window.addEventListener('load', async () => {
    // 이미 제어 중인 워커가 있었다면, 이번에 올라오는 것은 "갱신" 입니다.
    const hadController = !!navigator.serviceWorker.controller;
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'activated' && hadController) {
            toast('새 버전이 준비됐습니다. 앱을 다시 열면 적용됩니다');
          }
        });
      });
    } catch { /* 등록에 실패해도 앱은 그대로 동작합니다 */ }
  });
} else if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then(rs => rs.forEach(r => r.unregister()))
    .catch(() => {});
}

})();
