# md pencil — 개발 문서

아이패드용 필기 웹앱. 마크다운·PDF를 읽고 애플펜슬로 그 위에 긋는다.
빌드 없음, 프레임워크 없음, 외부 CDN 없음. 파일 넷이 전부다.

```
index.html   화면 뼈대
style.css    본문 타이포그래피와 UI (필기 좌표에 영향을 주는 값은 없다)
app.js       전부 — 렌더 · 타일 · 입력 · 저장. IIFE 하나
sw.js        오프라인 캐시. 파일을 추가하면 SHELL 에 넣고 CACHE 버전을 올린다
lib/         markdown-it · pdf.js legacy (+cmaps, standard_fonts) — 전부 번들
```

## 단 하나의 불변 조건

**한 번 그어진 필기 좌표는 영원히 유효해야 한다.** 이 앱의 모든 설계가 이 문장에서
나온다. 문서가 리플로우되면 필기가 통째로 어긋나고, 그 순간 앱은 끝이다.

그래서:

- 페이지 논리 폭은 문서 종류마다 상수다 — 마크다운 `PAGE_W = 900`,
  PDF `PDF_PAGE_W = 1400` (`PDF_SLIDE_W/NOTE_W/PAD/ROW_PAD` 에서 계산).
  **이 상수들은 절대 바꾸면 안 된다.** 바꾸면 기존 필기가 전부 어긋난다.
- 화면 맞춤은 오직 CSS `transform: scale()`. 문서는 다시 흐르지 않는다.
- 마크다운의 글자 크기(`fs`)·본문 폭(`cw`)·글꼴(`ff`)·홑줄바꿈(`brk`)은 문서
  레코드에 굳혀 두고, 필기가 한 획이라도 생기면 잠근다. 값이 없던 옛 문서를
  여는 규칙(`layoutOf`, `brk == null` 분기)은 **그 시절의 렌더를 픽셀 단위로
  재현하기 위한 것**이므로 손대면 안 된다.
- PDF 는 리플로우가 없어 이 문제가 저절로 사라진다. 행 높이는 넣을 때 저장한
  페이지 크기(`dims`)와 `PDF_*` 상수에서만 나온다.

## 좌표계

- **페이지 좌표**: `state.pageW × state.pageH` 논리 px. 스트로크는 전부 이 좌표로 저장.
- **화면 좌표**: 페이지 좌표 × `state.zoom`.
- **백킹스토어**: 페이지 좌표 × R, `R = clamp(devicePixelRatio × zoom, 1, 3)`.

`toPage()` 가 실측 rect 로 변환하므로 브라우저 자체 확대도 흡수된다.

## 잉크 타일

문서 전체를 canvas 한 장으로 덮으면 iOS 한계에 걸린다. `TILE_H = 1024` 단위로
잘라 화면 ±1장만 백킹스토어를 잡고, 나머지는 `width = 0` 으로 반납했다가
스트로크 벡터에서 다시 그린다. 타일 DOM 은 문서를 건너 재사용되므로 `buildTiles`
가 매번 `style.width` 를 현재 `state.pageW` 로 다시 놓는다.

층은 둘 — 형광펜 `#inkUnder`, 펜 `#ink`.

- 마크다운: 형광펜이 글자 **뒤**(z-index 0). 반투명을 글자 위에 얹으면 글자가
  뿌옇게 뜨기 때문. under 층은 형광펜이 실제로 지나가는 타일에만 백킹스토어를
  잡는다 (`tileHasLayer`, 첫 획은 `forceLayer`).
- PDF: 슬라이드가 불투명 비트맵이라 뒤에 깔 수 없다. `body.pdf-mode` 에서
  `#inkUnder` 를 위로 올리고 `mix-blend-mode: multiply` 로 얹는다. multiply 는
  어두운 바탕에서 안 보이므로 **PDF 종이는 다크 모드에서도 흰색**이다
  (`body.pdf-mode #page { background: #fff }`).

## PDF 모드

페이지마다 `[슬라이드 | 필기 공간]` 이 한 행. 같은 종이 위의 행이라 원본과
필기가 항상 같이 스크롤된다. 흐름:

1. **넣기** (`importPdf`): pdf.js 로 한 번 열어 `pageCount` 와 페이지별 크기
   `dims`(회전 반영, viewport scale 1)를 문서 레코드에 굳힌다. 원본
   ArrayBuffer 는 `files` 스토어에 저장. `getDocument` 는 넘긴 버퍼를 워커로
   이관(detach)하므로 저장할 원본은 **사본을 넘겨** 지킨다.
2. **열기** (`openDoc` → `buildPdfHost`): `dims` 만으로 행 배치를 즉시 확정.
   PDF 본문은 그 뒤에 비동기로 (`openPdfData`). 큰 파일이라도 종이와 필기가
   먼저 뜬다.
3. **렌더** (`updateSlideMounts` / `renderSlide`): 잉크 타일과 같은 원리로 화면
   ±`TILE_H` 안의 페이지만 비트맵을 잡고, 멀어지면 반납. 배율이 바뀌면 같은
   페이지도 새 R 로 다시 그린다. 낡은 비동기 렌더는 `pdfEpoch`(문서 전환)와
   행별 `gen`(마운트 전환)으로 무효화하고, 진행 중인 task 는 `cancel()`.

pdf.js 는 1.5MB 라 지연 로드(`loadPdfJs`) — 마크다운만 쓰면 비용 0. 한글 PDF 의
CID 글꼴 때문에 `cMapUrl`/`standardFontDataUrl` 을 반드시 넘겨야 한다. cmaps 는
개수가 많아 sw.js SHELL 에는 안 넣는다 (fetch 핸들러가 쓰인 것만 캐시).

PPT/PPTX/Key 는 브라우저에 렌더러가 없다. 받지 않고, PDF 로 내보내라고 안내한다.

## 저장 (IndexedDB `mdpencil`, v2)

| 스토어 | 키 | 내용 |
|---|---|---|
| `docs` | id | 문서 메타. md: `{name, md, fs, cw, ff, brk, ...}` · pdf: `{name, kind:'pdf', pageCount, dims, ...}` |
| `ink` | id | `{strokes: [{t, c, w, p:[x,y,force,...], bb}]}` — 좌표는 0.1px 반올림 |
| `files` | id | PDF 원본 `{data: ArrayBuffer}`. docs 와 분리한 이유: 최근 목록을 읽을 때마다 수십 MB 가 딸려 나오면 안 된다 |

백업은 JSON 하나 (`md-pencil-backup`). PDF 원본은 base64(`pdf` 필드)로 실린다 —
파일이 커지지만 백업 하나로 전부 돌아온다는 약속이 우선.

## 입력

- 애플펜슬만 `touch.touchType === 'stylus'` 로 구분해 `preventDefault()`.
  손가락은 안 건드려 네이티브 스크롤이 관성까지 산다.
- 두 손가락: 벌리면 핀치 줌, 톡 치면 펜↔지우개. 핀치 **도중**에는 타일·슬라이드를
  다시 그리지 않는다 (`zooming` 플래그) — 손을 떼야 `relayout` 이 해상도를 잡는다.
  `applyZoomVisual` 이 옮긴 스크롤이 scroll 이벤트를 깨우는 것에 주의.
- 손떨림은 One Euro 필터(`OE_BETA` 가 손맛), 양 끝 삐침은 `trimSpur`,
  획 머리 필압은 `WARM_PTS` 소급.

## 개발·테스트

```bash
python3 -m http.server 8080   # 저장소 루트에서. 마우스로 그려볼 수 있다
```

- Node 문법 검사: `node --check app.js`
- 스모크 테스트는 Playwright(Chromium)로: `page.pdf()` 로 진짜 다중 페이지 PDF 를
  만들고(기본 body 마진 8px 이 넘쳐 빈 페이지가 생기니 `body{margin:0}` 필수),
  `#fileInput` 에 `setInputFiles` → pdf-mode 클래스·행 개수·`.pdf-slide` 의
  `canvas.width > 0`·픽셀 색·마우스 획 후 undo 활성·reload 후 IndexedDB 잔존을
  확인한다. 콘솔 에러와 4xx 응답도 같이 잡을 것.
- localhost 에서는 Service Worker 를 일부러 등록 해제한다 (캐시 때문에 고친
  파일이 안 나와 헤매게 되므로). 오프라인 검증은 배포本으로.

## 배포

GitHub Pages, `main` / (root). **정적 파일을 추가·변경하면 sw.js 의 SHELL 과
CACHE 버전(`mdpencil-vN`)을 같이 올려야** 기존 설치가 갱신된다. 새 버전은
"한 번 더 열면" 적용되는 stale-while-revalidate.
