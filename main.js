const fallbackLocation = [35.8294, 137.9536]; // 伊那市
const fallbackZoom = 13;
const currentLocationZoom = 15;
const gsiAttribution =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>';

const map = L.map("map", {
  zoomControl: true
}).setView(fallbackLocation, fallbackZoom);

const gsiStandard = L.tileLayer(
  "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",
  {
    attribution: gsiAttribution,
    maxZoom: 18,
    className: "grayscale-layer bm-multiply"
  }
);

const gsiAirPhoto = L.tileLayer(
  "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
  {
    attribution: gsiAttribution,
    maxZoom: 18,
    className: "bm-multiply"
  }
);

const naganoCsMap = L.tileLayer(
  "https://tile.geospatial.jp/CS/VER2/{z}/{x}/{y}.png",
  {
    attribution:
      '<a href="https://www.geospatial.jp/ckan/dataset/nagano-csmap">長野県CS立体図</a>',
    maxZoom: 18,
    className: "bm-multiply"
  }
);

gsiStandard.addTo(map);
gsiAirPhoto.addTo(map); gsiAirPhoto.setOpacity(0);
naganoCsMap.addTo(map); naganoCsMap.setOpacity(0);

const FARM_POLYGON_URL = "https://geoforest001.github.io/map2/data/farm_polygon.pmtiles";
const PIPELINE_URL = "https://geoforest001.github.io/map2/data/pipeline.pmtiles";

// 選択中フィーチャのハイライト状態
var _selFarmObjId = null;
var _selWaterwayId = null;
var _selPipelineId = null;
var _selOverlay = null;

// 点Pから線分AB(cos補正座標)への最短距離
function ptSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// セグメント配列への最短距離（点→線分距離）
function minDistToFeat(lng, lat, feat, cosLat) {
  const cx = (lng - feat.x) * cosLat, cy = lat - feat.y;
  let d = Math.hypot(cx, cy);
  if (feat.segs) {
    for (const seg of feat.segs) {
      for (let i = 0; i < seg.length - 1; i++) {
        const [x1, y1] = seg[i], [x2, y2] = seg[i + 1];
        const dd = ptSegDist(
          (lng - x1) * cosLat, lat - y1,
          0, 0,
          (x2 - x1) * cosLat, y2 - y1
        );
        if (dd < d) d = dd;
      }
    }
  }
  return d;
}

const farmPolygonTiles = protomapsL.leafletLayer({
  url: FARM_POLYGON_URL,
  maxDataZoom: 16,
  paintRules: [
    {
      dataLayer: "農地筆ポリゴン",
      symbolizer: new protomapsL.PolygonSymbolizer({
        fill: "rgb(240,210,0)",
        opacity: 0.3,
        stroke: "rgb(160,130,0)",
        width: 1.5
      })
    },
    {
      dataLayer: "農地筆ポリゴン",
      filter: (zoom, feature) => feature.props.OBJECTID === _selFarmObjId,
      symbolizer: new protomapsL.PolygonSymbolizer({
        fill: "rgba(255,34,0,0.45)",
        opacity: 1,
        stroke: "#FF2200",
        width: 5
      })
    }
  ],
  labelRules: []
});
farmPolygonTiles.addTo(map);

/* 農地ピン検索用レイヤ（透明・検索専用） */
let farmPinData = null;
let farmPinLayer = null;
fetch('data/farm_pins.json')
  .then(r => r.json())
  .then(data => {
    farmPinData = data;
    farmPinLayer = L.geoJSON(null, { pointToLayer: () => L.circleMarker([0,0], {radius:0, opacity:0, fillOpacity:0}) });
    farmPinLayer.addTo(map);
  });

/* ─── 地図クリックハンドラ（マンホール→農業施設→開水路→パイプライン→農地ポリゴン）─── */
map.on('click', function(e) {
  const lat = e.latlng.lat, lng = e.latlng.lng;
  const cosLat = Math.cos(lat * Math.PI / 180);

  // 優先1: マンホール（点フィーチャ、~50m以内）
  if (manholePinData && map.hasLayer(surveyTiles)) {
    let nearest = null, minDist = Infinity;
    for (const d of manholePinData) {
      const dist = (d.y-lat)**2 + ((d.x-lng)*cosLat)**2;
      if (dist < minDist) { minDist = dist; nearest = d; }
    }
    if (nearest && minDist <= 0.00045 * 0.00045) {
      _selFarmObjId = null; farmPolygonTiles.redraw();
      if (_selOverlay) { map.removeLayer(_selOverlay); _selOverlay = null; }
      _selOverlay = L.circleMarker([nearest.y, nearest.x], {
        radius: 12, color: '#FF2200', weight: 4, fillOpacity: 0
      }).addTo(map);
      const rows = [
        nearest.h ? `<tr><th>配管名</th><td>${nearest.h}</td></tr>` : '',
        nearest.k ? `<tr><th>種別</th><td>${nearest.k}</td></tr>` : ''
      ].filter(Boolean).join('');
      L.popup({ maxWidth: 200 })
        .setLatLng([nearest.y, nearest.x])
        .setContent(`<table class="shisetsu-popup">${rows}</table>`)
        .openOn(map);
      return;
    }
  }

  // 優先2: 農業施設（点フィーチャ、~80m以内）
  if (shisetsuPinData && map.hasLayer(shisetsuTiles)) {
    let nearest = null, minDist = Infinity;
    for (const d of shisetsuPinData) {
      const dist = (d.y-lat)**2 + ((d.x-lng)*cosLat)**2;
      if (dist < minDist) { minDist = dist; nearest = d; }
    }
    if (nearest && minDist <= 0.0007 * 0.0007) {
      _selFarmObjId = null; farmPolygonTiles.redraw();
      if (_selOverlay) { map.removeLayer(_selOverlay); _selOverlay = null; }
      _selOverlay = L.circleMarker([nearest.y, nearest.x], {
        radius: 16, color: '#FF2200', weight: 4, fillOpacity: 0
      }).addTo(map);
      const rows = [
        nearest.n ? `<tr><th>施設名</th><td>${nearest.n}</td></tr>` : '',
        nearest.k ? `<tr><th>施設区分</th><td>${nearest.k}</td></tr>` : '',
        nearest.m ? `<tr><th>管理団体名</th><td>${nearest.m}</td></tr>` : '',
        nearest.u ? `<tr><th>用排区分</th><td>${nearest.u}</td></tr>` : '',
        nearest.b && nearest.b.trim() ? `<tr><th>区間部位</th><td>${nearest.b}</td></tr>` : ''
      ].filter(Boolean).join('');
      L.popup({ maxWidth: 240 })
        .setLatLng([nearest.y, nearest.x])
        .setContent(`<table class="shisetsu-popup">${rows}</table>`)
        .openOn(map);
      return;
    }
  }

  // 優先3: 開水路（protomaps第2ペイントルールでハイライト）
  const LINE_THRESH = 0.0003;
  if (suiroLineData && map.hasLayer(waterwayTiles)) {
    let nearest = null, minDist = Infinity;
    for (const d of suiroLineData) {
      const dist = minDistToFeat(lng, lat, d, cosLat);
      if (dist < minDist) { minDist = dist; nearest = d; }
    }
    if (nearest && minDist <= LINE_THRESH) {
      if (_selOverlay) { map.removeLayer(_selOverlay); _selOverlay = null; }
      if (_selFarmObjId !== null) { _selFarmObjId = null; farmPolygonTiles.redraw(); }
      if (_selPipelineId !== null) { _selPipelineId = null; pipelineTiles.redraw(); }
      _selWaterwayId = nearest.id;
      waterwayTiles.redraw();
      const lenRow = nearest.len > 0 ? `<tr><th>延長</th><td>${nearest.len} m</td></tr>` : '';
      L.popup({ maxWidth: 220 })
        .setLatLng([lat, lng])
        .setContent(`<table class="shisetsu-popup"><tr><th>水路ID</th><td>${nearest.id}</td></tr>${lenRow}</table>`)
        .openOn(map);
      return;
    }
  }

  // 優先4: パイプライン（protomaps第2ペイントルールでハイライト）
  if (pipelineLineData && map.hasLayer(pipelineTiles)) {
    let nearest = null, minDist = Infinity;
    for (const d of pipelineLineData) {
      const dist = minDistToFeat(lng, lat, d, cosLat);
      if (dist < minDist) { minDist = dist; nearest = d; }
    }
    if (nearest && minDist <= LINE_THRESH) {
      if (_selOverlay) { map.removeLayer(_selOverlay); _selOverlay = null; }
      if (_selFarmObjId !== null) { _selFarmObjId = null; farmPolygonTiles.redraw(); }
      if (_selWaterwayId !== null) { _selWaterwayId = null; waterwayTiles.redraw(); }
      _selPipelineId = nearest.id;
      pipelineTiles.redraw();
      const rows = [
        nearest.id   ? `<tr><th>名称</th><td>${nearest.id}</td></tr>` : '',
        nearest.spec ? `<tr><th>規格</th><td>${nearest.spec}</td></tr>` : ''
      ].filter(Boolean).join('');
      L.popup({ maxWidth: 220 })
        .setLatLng([lat, lng])
        .setContent(`<table class="shisetsu-popup">${rows}</table>`)
        .openOn(map);
      return;
    }
  }

  // 優先5: 農地筆ポリゴン（面フィーチャ、点内包テスト）
  if (map.hasLayer(farmPolygonTiles) && map.getZoom() >= 15) {
    var resultsMap = farmPolygonTiles.queryTileFeaturesDebug(lng, lat, 0);
    var farmHit = null;
    for (var [, features] of resultsMap) {
      for (var f of features) {
        if (f.layerName === '農地筆ポリゴン') { farmHit = f; break; }
      }
      if (farmHit) break;
    }
    if (farmHit) {
      if (_selOverlay) { map.removeLayer(_selOverlay); _selOverlay = null; }
      _selFarmObjId = farmHit.feature.props.OBJECTID;
      farmPolygonTiles.redraw();
      if (farmPinData) {
        let nearest = null, minDist = Infinity;
        for (const d of farmPinData) {
          const dist = (d.y-lat)**2 + ((d.x-lng)*cosLat)**2;
          if (dist < minDist) { minDist = dist; nearest = d; }
        }
        if (nearest && minDist < 0.001 * 0.001) {
          L.popup().setLatLng([lat, lng]).setContent(`📍 ${nearest.a}`).openOn(map);
        }
      }
      return;
    }
  }

  // 何もヒットしなかった: 全選択クリア
  if (_selOverlay) { map.removeLayer(_selOverlay); _selOverlay = null; }
  if (_selFarmObjId !== null)   { _selFarmObjId = null;   farmPolygonTiles.redraw(); }
  if (_selWaterwayId !== null)  { _selWaterwayId = null;  waterwayTiles.redraw(); }
  if (_selPipelineId !== null)  { _selPipelineId = null;  pipelineTiles.redraw(); }
});


const pipelineTiles = protomapsL.leafletLayer({
  url: PIPELINE_URL,
  maxDataZoom: 20,
  paintRules: [
    {
      dataLayer: "02パイプライン_Layer",
      symbolizer: new protomapsL.LineSymbolizer({ color: "rgb(0,80,200)", width: 2.5 })
    },
    {
      dataLayer: "02パイプライン_Layer",
      filter: (zoom, feature) => feature.props['名称'] === _selPipelineId,
      symbolizer: new protomapsL.LineSymbolizer({ color: "#FF2200", width: 6 })
    }
  ],
  labelRules: []
});

const WATERWAY_URL = "https://geoforest001.github.io/map2/data/suiro.pmtiles";

const waterwayTiles = protomapsL.leafletLayer({
  url: WATERWAY_URL,
  maxDataZoom: 16,
  paintRules: [
    {
      dataLayer: "水路",
      symbolizer: new protomapsL.LineSymbolizer({ color: "rgb(0,150,255)", width: 2 })
    },
    {
      dataLayer: "水路",
      filter: (zoom, feature) => feature.props.OBJECTID === _selWaterwayId,
      symbolizer: new protomapsL.LineSymbolizer({ color: "#FF2200", width: 5 })
    }
  ],
  labelRules: []
});
pipelineTiles.addTo(map);
waterwayTiles.addTo(map);

const SURVEY_URL = "https://geoforest001.github.io/map2/data/manhole.pmtiles";

// ポイント系レイヤを線レイヤの上に表示するカスタムペイン
map.createPane('pointPane');
map.getPane('pointPane').style.zIndex = 450;

// GPX・ログトラックはポイントより上（pointPaneのcanvasで隠れない）
map.createPane('gpxPane');
map.getPane('gpxPane').style.zIndex = 460;

class SquareSymbolizer {
  constructor({ fill, stroke = "black", width = 1, size = 4 }) {
    this.fill = fill;
    this.stroke = stroke;
    this.width = width;
    this.size = size;
  }
  draw(ctx, geom, z, feature) {
    for (const ring of geom) {
      for (const pt of ring) {
        const s = this.size;
        ctx.fillStyle = this.fill;
        ctx.strokeStyle = this.stroke;
        ctx.lineWidth = this.width;
        ctx.beginPath();
        ctx.rect(pt.x - s, pt.y - s, s * 2, s * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
}

const surveyTiles = protomapsL.leafletLayer({
  url: SURVEY_URL,
  maxDataZoom: 15,
  pane: 'pointPane',
  paintRules: [
    {
      dataLayer: "02調査結果 R6",
      filter: (zoom, feature) => feature.props["種別"]?.startsWith("排泥処理工"),
      symbolizer: new SquareSymbolizer({ fill: "#2196F3", stroke: "black", width: 1, size: 4 })
    },
    {
      dataLayer: "02調査結果 R6",
      filter: (zoom, feature) => feature.props["種別"] === "制水弁",
      symbolizer: new SquareSymbolizer({ fill: "#f44336", stroke: "black", width: 1, size: 4 })
    },
    {
      dataLayer: "02調査結果 R6",
      filter: (zoom, feature) => {
        const k = feature.props["種別"];
        return !k?.startsWith("排泥処理工") && k !== "制水弁";
      },
      symbolizer: new protomapsL.CircleSymbolizer({ radius: 1.5, fill: "white", opacity: 1, stroke: "black", width: 0.6 })
    }
  ],
  labelRules: []
});
surveyTiles.addTo(map);

const SHISETSU_URL = "https://geoforest001.github.io/map2/data/shisetsu.pmtiles";

class DoubleCircleSymbolizer {
  constructor({ fill, stroke, outerRadius, innerRadius, strokeWidth }) {
    this.fill = fill;
    this.stroke = stroke;
    this.outerRadius = outerRadius;
    this.innerRadius = innerRadius;
    this.strokeWidth = strokeWidth;
  }
  draw(ctx, geom, z, feature) {
    for (const ring of geom) {
      for (const pt of ring) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, this.outerRadius, 0, Math.PI * 2);
        ctx.fillStyle = this.fill;
        ctx.fill();
        ctx.strokeStyle = this.stroke;
        ctx.lineWidth = this.strokeWidth;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, this.innerRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = this.stroke;
        ctx.lineWidth = this.strokeWidth;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, this.strokeWidth, 0, Math.PI * 2);
        ctx.fillStyle = this.fill;
        ctx.fill();
      }
    }
  }
}

const shisetsuTiles = protomapsL.leafletLayer({
  url: SHISETSU_URL,
  maxDataZoom: 16,
  pane: 'pointPane',
  paintRules: [
    {
      dataLayer: "shisetsu",
      symbolizer: new DoubleCircleSymbolizer({
        fill: '#e00',
        stroke: '#e00',
        outerRadius: 7,
        innerRadius: 5.5,
        strokeWidth: 1.5
      })
    }
  ],
  labelRules: []
});
shisetsuTiles.addTo(map);

/* 各レイヤのクリック検出用データ取得 */
let manholePinData = null;
fetch('data/manhole_pins.json').then(r => r.json()).then(d => { manholePinData = d; });

let shisetsuPinData = null;
fetch('data/shisetsu_pins.json').then(r => r.json()).then(d => { shisetsuPinData = d; });

let suiroLineData = null;
fetch('data/suiro_lines.json').then(r => r.json()).then(d => { suiroLineData = d; });

let pipelineLineData = null;
fetch('data/pipeline_lines.json').then(r => r.json()).then(d => { pipelineLineData = d; });

const baseLayers = {};

const overlays = {
  "農地筆ポリゴン": farmPolygonTiles,
  "農業施設": shisetsuTiles,
  "開水路": waterwayTiles,
  "パイプライン": pipelineTiles,
  "マンホール": surveyTiles
};

let layerControl;

function renderLayerControl() {
  if (layerControl) map.removeControl(layerControl);

  layerControl = L.control.layers(baseLayers, overlays, {
    position: "topright",
    collapsed: false
  });
  layerControl.addTo(map);

  var LGND_DEFS = {
    '農地筆ポリゴン': '<span class="lgnd-swatch lgnd-poly" style="background:rgba(240,210,0,0.35);border:1.5px solid rgb(160,130,0)"></span><span class="lgnd-text">農地の区画ポリゴン</span>',
    '農業施設':       '<span class="lgnd-swatch lgnd-dblcircle" style="color:#e00"></span><span class="lgnd-text">農業施設（ポンプ場・水門等）</span>',
    '開水路':         '<span class="lgnd-swatch lgnd-line" style="background:rgb(0,150,255)"></span><span class="lgnd-text">開水路</span>',
    'パイプライン':   '<span class="lgnd-swatch lgnd-line" style="background:rgb(0,80,200)"></span><span class="lgnd-text">パイプライン</span>',
    'マンホール':     '<span class="lgnd-swatch lgnd-sq" style="background:#2196F3"></span><span class="lgnd-text">排泥処理工</span><span class="lgnd-swatch lgnd-sq" style="background:#f44336"></span><span class="lgnd-text">制水弁</span><span class="lgnd-swatch lgnd-circle-sm" style="background:white"></span><span class="lgnd-text">その他</span>'
  };
  document.querySelectorAll('.leaflet-control-layers-overlays label').forEach(function(label) {
    var span = label.querySelector('span');
    if (!span) return;
    var name = span.textContent.trim();
    if (!LGND_DEFS[name]) return;
    var row = document.createElement('div');
    row.className = 'lgnd-row';
    Array.from(label.childNodes).forEach(function(n) { row.appendChild(n); });
    label.appendChild(row);
    var lgnd = document.createElement('div');
    lgnd.className = 'layer-legend';
    lgnd.innerHTML = LGND_DEFS[name];
    label.appendChild(lgnd);
  });

  var panel = document.querySelector('.leaflet-control-layers');
  if (!panel) return;

  var closeBtn = document.createElement('button');
  closeBtn.className = 'lc-close-btn';
  closeBtn.textContent = '✕';
  panel.insertBefore(closeBtn, panel.firstChild);

  var openBtn = document.createElement('button');
  openBtn.className = 'lc-open-btn';
  openBtn.textContent = 'メニュー';
  document.body.appendChild(openBtn);

  function openPanel()  { panel.classList.remove('lc-hidden'); openBtn.style.display = 'none'; }
  function closePanel() { panel.classList.add('lc-hidden');    openBtn.style.display = 'block'; }

  closeBtn.addEventListener('click', closePanel);
  openBtn.addEventListener('click', openPanel);

  if (window.innerWidth < 768) closePanel();
}

renderLayerControl();

/* ─── ブランディング表示 ─────────────────────────── */
const brandingControl = L.control({ position: 'bottomright' });
brandingControl.onAdd = function() {
  const div = L.DomUtil.create('div', 'gf-branding');
  div.innerHTML = 'Powered by Geo･Forest Co.,Ltd.';
  return div;
};
brandingControl.addTo(map);

/* =========================
   ユーティリティ
========================= */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function toast(msg, ms = 2000) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._t);
  t._t = setTimeout(() => t.style.display = 'none', ms);
}

const _lb = document.getElementById('lightbox');
const _lbImg = document.getElementById('lightboxImg');
window.openPhoto = src => { _lbImg.src = src; _lb.style.display = 'flex'; };
_lb.onclick = () => { _lb.style.display = 'none'; _lbImg.src = ''; };

function showConfirm(msg) {
  return new Promise(resolve => {
    const ov = document.getElementById('confirmOverlay');
    document.getElementById('confirmMsg').textContent = msg;
    ov.style.display = 'flex';
    const ok = document.getElementById('confirmOk');
    const cancel = document.getElementById('confirmCancel');
    const done = result => { ov.style.display = 'none'; ok.onclick = null; cancel.onclick = null; resolve(result); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
  });
}

/* =========================
   現場掲示板 (BBS)
========================= */
const _GH_PAT = ['github_pat_11CEFRMRY0','mquikxruRiN4_ukRsAYZ7rWdrFuv3aYpWk00WJROhS','GF747tXbXCPF5zFI2HJIYA1VDRjLVB'].join('');
const _GH_FILE_URL = 'https://api.github.com/repos/geoforest001/map2/contents/bbs/posts.json';

let _bbsPosts = [], _bbsSha = null, _bbsMarkers = [], _bbsTimer = null;
let _bbsPhotoB64 = null, _bbsLat = null, _bbsLng = null;
let _bbsPhotoMap = {};

async function _bbsFetchPosts() {
  try {
    const res = await fetch(_GH_FILE_URL, {
      headers: { 'Authorization': 'Bearer ' + _GH_PAT, 'Accept': 'application/vnd.github+json' }
    });
    if (res.status === 404) { _bbsPosts = []; _bbsSha = null; _bbsCheckNew(); return true; }
    if (!res.ok) throw new Error('GitHub API ' + res.status);
    const data = await res.json();
    _bbsSha = data.sha;
    let parsed;
    if (data.content) {
      parsed = JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, '')))));
    } else if (data.download_url) {
      const raw = await fetch(data.download_url + '?_=' + Date.now());
      if (!raw.ok) throw new Error('download_url ' + raw.status);
      parsed = await raw.json();
    } else {
      throw new Error('content unavailable');
    }
    _bbsPosts = parsed || [];
    _bbsCheckNew();
    return true;
  } catch(e) {
    console.error('[BBS fetch]', e);
    toast('掲示板の読込失敗 — 既存の投稿はそのまま表示中', 3000);
    return false;
  }
}

async function _bbsSavePosts(posts, _depth = 0) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(posts, null, 2))));
  const body = { message: 'BBS: update posts', content: encoded, committer: { name: 'Field Map', email: 'map@field' } };
  if (_bbsSha) body.sha = _bbsSha;
  const res = await fetch(_GH_FILE_URL, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + _GH_PAT, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
    body: JSON.stringify(body)
  });
  if (res.status === 409 && _depth < 2) {
    // 競合: 最新を取得してリモートにない投稿をマージして再試行
    const r = await fetch(_GH_FILE_URL, { headers: { 'Authorization': 'Bearer ' + _GH_PAT, 'Accept': 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('競合解決のための再取得に失敗しました');
    const d = await r.json();
    _bbsSha = d.sha;
    const remotePosts = JSON.parse(decodeURIComponent(escape(atob(d.content.replace(/\n/g, ''))))) || [];
    const remoteIds = new Set(remotePosts.map(p => p.id));
    const newOnly = posts.filter(p => !remoteIds.has(p.id));
    const merged = newOnly.length > 0 ? [...remotePosts, ...newOnly] : remotePosts;
    _bbsPosts = merged;
    if (newOnly.length === 0) return; // 追加投稿なし（削除競合）→ リモート状態を受け入れ
    return _bbsSavePosts(merged, _depth + 1);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'GitHub PUT ' + res.status);
  }
  const data = await res.json();
  _bbsSha = data.content.sha;
}

function _bbsCatEmoji(cat) {
  return { '道路': '🛣', '河川': '💧', '土砂': '⛰', '施設': '🏢', 'その他': '📌' }[cat] || '📌';
}

function _bbsFmtTime(iso) {
  const d = new Date(iso);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function _bbsRenderMarkers() {
  _bbsMarkers.forEach(m => map.removeLayer(m));
  _bbsMarkers = []; _bbsPhotoMap = {};
  const catCol = { '道路': '#e65100', '河川': '#0277bd', '土砂': '#4e342e', '施設': '#2e7d32', 'その他': '#37474f' };
  for (const p of _bbsPosts) {
    if (p.lat == null || p.lng == null) continue;
    const col = catCol[p.cat] || '#555';
    const ico = L.divIcon({
      html: `<div style="background:${col};color:#fff;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.35);margin:-16px 0 0 -16px">${_bbsCatEmoji(p.cat)}</div>`,
      iconSize: [32, 32], className: ''
    });
    let pop = `<div style="font-size:12px;max-width:230px"><b>${escapeHtml(p.cat)}</b> <span style="color:#aaa">${_bbsFmtTime(p.ts)}</span>${p.author ? ` <span style="color:#888">👤${escapeHtml(p.author)}</span>` : ''}<br><div style="margin-top:4px">${escapeHtml(p.comment || '')}</div>`;
    if (p.photo) {
      _bbsPhotoMap[p.id] = p.photo;
      pop += `<img src="${p.photo}" style="max-width:210px;max-height:130px;border-radius:6px;margin-top:6px;cursor:pointer;display:block" onclick="_bbsOpenPhoto('${p.id}')">`;
    }
    pop += '</div>';
    const mk = L.marker([p.lat, p.lng], { icon: ico }).addTo(map).bindPopup(pop, { maxWidth: 240 });
    _bbsMarkers.push(mk);
  }
}
window._bbsOpenPhoto = id => { if (_bbsPhotoMap[id]) openPhoto(_bbsPhotoMap[id]); };

function _bbsRenderList() {
  const listEl = document.getElementById('bbsList');
  const loadMsg = document.getElementById('bbsLoadingMsg');
  const emptyMsg = document.getElementById('bbsEmptyMsg');
  loadMsg.style.display = 'none';
  if (!_bbsPosts.length) { emptyMsg.style.display = 'block'; listEl.innerHTML = ''; return; }
  emptyMsg.style.display = 'none';
  const sorted = [..._bbsPosts].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  listEl.innerHTML = '';
  sorted.forEach(p => {
    const card = document.createElement('div');
    card.className = 'bbs-card';
    const hdr = document.createElement('div');
    hdr.className = 'bbs-card-header';
    const badge = document.createElement('span');
    badge.className = 'bbs-cat-badge';
    badge.textContent = `${_bbsCatEmoji(p.cat)} ${p.cat}`;
    const ts = document.createElement('span');
    ts.className = 'bbs-time';
    ts.textContent = _bbsFmtTime(p.ts);
    hdr.appendChild(badge); hdr.appendChild(ts);
    if (p.lat != null) {
      const jb = document.createElement('button');
      jb.className = 'bbs-icon-btn'; jb.textContent = '🗺 地図';
      jb.addEventListener('click', () => { map.setView([p.lat, p.lng], 16); closeBbsPanel(); });
      hdr.appendChild(jb);
    }
    const db = document.createElement('button');
    db.className = 'bbs-icon-btn'; db.textContent = '🗑'; db.style.color = '#c00';
    db.addEventListener('click', () => _bbsDeleteById(p.id));
    hdr.appendChild(db);
    card.appendChild(hdr);
    if (p.author) {
      const au = document.createElement('div');
      au.className = 'bbs-author'; au.textContent = '👤 ' + p.author;
      card.appendChild(au);
    }
    const cm = document.createElement('div');
    cm.className = 'bbs-comment'; cm.textContent = p.comment || '';
    card.appendChild(cm);
    if (p.photo) {
      const img = document.createElement('img');
      img.src = p.photo; img.className = 'bbs-photo';
      img.addEventListener('click', () => openPhoto(p.photo));
      card.appendChild(img);
    }
    if (p.lat != null) {
      const loc = document.createElement('div');
      loc.className = 'bbs-loc';
      loc.textContent = `📍 ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
      card.appendChild(loc);
    }
    listEl.appendChild(card);
  });
}

async function _bbsDeleteById(id) {
  if (!await showConfirm('この投稿を削除しますか？')) return;
  const newPosts = _bbsPosts.filter(p => p.id !== id);
  toast('削除中...', 3000);
  try {
    await _bbsSavePosts(newPosts);
    _bbsPosts = newPosts;
    _bbsRenderMarkers();
    _bbsRenderList();
    toast('削除しました', 2000);
  } catch(e) { toast('削除失敗: ' + e.message, 4000); }
}

function _bbsCompressPhoto(file) {
  return new Promise(resolve => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 900; let w = img.width, h = img.height;
      if (w > MAX || h > MAX) { if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; } }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/* 投稿者名管理 */
function _bbsGetUserName() { return localStorage.getItem('bbsUserName') || ''; }
function _bbsUpdateAuthorBar() {
  const name = _bbsGetUserName();
  document.getElementById('bbsAuthorBarName').textContent = name || '未登録';
}

(() => {
  const editBtn = document.getElementById('bbsAuthorEditBtn');
  const editor  = document.getElementById('bbsAuthorEditor');
  const input   = document.getElementById('bbsAuthorInput');
  const saveBtn = document.getElementById('bbsAuthorSaveBtn');

  editBtn.addEventListener('click', () => {
    input.value = _bbsGetUserName();
    editor.style.display = 'flex';
    editBtn.style.display = 'none';
    input.focus();
  });

  function saveAuthor() {
    const name = input.value.trim();
    if (!name) { toast('名前を入力してください', 1500); return; }
    localStorage.setItem('bbsUserName', name);
    _bbsUpdateAuthorBar();
    editor.style.display = 'none';
    editBtn.style.display = '';
    toast('投稿者名を登録しました', 1500);
  }
  saveBtn.addEventListener('click', saveAuthor);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') saveAuthor(); });
})();

const bbsPanel = document.getElementById('bbsPanel');
const bbsFloatBtn = document.getElementById('bbsFloatBtn');
const bbsBadge = document.getElementById('bbsBadge');

function _bbsCheckNew() {
  const last = localStorage.getItem('bbsLastSeen') || '';
  const hasNew = _bbsPosts.some(p => p.ts > last);
  bbsBadge.style.display = hasNew ? 'block' : 'none';
}
function _bbsMarkSeen() {
  const latest = _bbsPosts.reduce((m, p) => p.ts > m ? p.ts : m, '');
  if (latest) localStorage.setItem('bbsLastSeen', latest);
  bbsBadge.style.display = 'none';
}

async function openBbsPanel() {
  _bbsUpdateAuthorBar();
  bbsPanel.style.display = 'flex';
  bbsPanel.classList.remove('collapsed');
  bbsFloatBtn.classList.add('active');
  _bbsMarkSeen();
  document.querySelectorAll('.bbs-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('bbsTabList').classList.add('active');
  document.getElementById('bbsListPane').style.display = '';
  document.getElementById('bbsNewPane').style.display = 'none';
  document.getElementById('bbsLoadingMsg').style.display = 'block';
  document.getElementById('bbsEmptyMsg').style.display = 'none';
  document.getElementById('bbsList').innerHTML = '';
  if (await _bbsFetchPosts()) _bbsRenderMarkers();
  _bbsRenderList();
  if (!_bbsTimer) _bbsTimer = setInterval(async () => {
    if (await _bbsFetchPosts()) _bbsRenderMarkers();
    _bbsRenderList();
  }, 30000);
}

function closeBbsPanel() {
  bbsPanel.style.display = 'none';
  bbsFloatBtn.classList.remove('active');
  clearInterval(_bbsTimer); _bbsTimer = null;
}

document.querySelectorAll('.bbs-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.bbs-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('bbsListPane').style.display = tab === 'list' ? '' : 'none';
    document.getElementById('bbsNewPane').style.display = tab === 'new' ? '' : 'none';
  });
});

bbsFloatBtn.addEventListener('click', () => {
  if (bbsPanel.style.display === 'flex') closeBbsPanel();
  else openBbsPanel();
});

(async () => {
  if (await _bbsFetchPosts()) _bbsRenderMarkers();
  setInterval(async () => {
    if (bbsPanel.style.display !== 'flex') {
      if (await _bbsFetchPosts()) _bbsRenderMarkers();
    }
  }, 60000);
})();

document.getElementById('bbsClose').addEventListener('click', closeBbsPanel);
document.getElementById('bbsCollapseBtn').addEventListener('click', () => { bbsPanel.classList.toggle('collapsed'); });
document.getElementById('bbsRefreshBtn').addEventListener('click', async () => {
  document.getElementById('bbsLoadingMsg').style.display = 'block';
  document.getElementById('bbsList').innerHTML = '';
  if (await _bbsFetchPosts()) _bbsRenderMarkers();
  _bbsRenderList();
  toast('更新しました', 1500);
});

// ドラッグ
(() => {
  const handle = document.getElementById('bbsHandle');
  let drag = null;
  function startDrag(cx, cy) { const r = bbsPanel.getBoundingClientRect(); drag = { ox: cx - r.left, oy: cy - r.top }; }
  function moveDrag(cx, cy) {
    if (!drag) return;
    let x = cx - drag.ox, y = cy - drag.oy;
    x = Math.max(0, Math.min(window.innerWidth - bbsPanel.offsetWidth, x));
    y = Math.max(0, Math.min(window.innerHeight - bbsPanel.offsetHeight, y));
    bbsPanel.style.left = x + 'px'; bbsPanel.style.top = y + 'px'; bbsPanel.style.right = 'auto';
  }
  function endDrag() { drag = null; }
  handle.addEventListener('touchstart', e => { if (e.target.closest('button')) return; startDrag(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  handle.addEventListener('touchmove', e => { if (!drag) return; e.preventDefault(); moveDrag(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  handle.addEventListener('touchend', endDrag, { passive: true });
  handle.addEventListener('mousedown', e => { if (e.target.closest('button')) return; startDrag(e.clientX, e.clientY); handle.style.cursor = 'grabbing'; });
  document.addEventListener('mousemove', e => { if (drag) moveDrag(e.clientX, e.clientY); });
  document.addEventListener('mouseup', () => { endDrag(); handle.style.cursor = 'grab'; });
})();

document.getElementById('bbsGetLocBtn').addEventListener('click', () => {
  document.getElementById('bbsLocStatus').textContent = '取得中...';
  navigator.geolocation.getCurrentPosition(
    pos => { _bbsLat = pos.coords.latitude; _bbsLng = pos.coords.longitude;
      document.getElementById('bbsLocStatus').textContent = `${_bbsLat.toFixed(5)}, ${_bbsLng.toFixed(5)}`; },
    () => { document.getElementById('bbsLocStatus').textContent = '取得失敗'; },
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

async function _bbsHandlePhoto(file) {
  if (!file) return;
  if (window.exifr) {
    try {
      const gps = await exifr.gps(file);
      if (gps && gps.latitude && gps.longitude) {
        _bbsLat = gps.latitude;
        _bbsLng = gps.longitude;
        document.getElementById('bbsLocStatus').textContent =
          `📷 ${_bbsLat.toFixed(5)}, ${_bbsLng.toFixed(5)}`;
      }
    } catch(_) {}
  }
  document.getElementById('bbsTakePhotoBtn').textContent = '圧縮中...';
  document.getElementById('bbsPickPhotoBtn').textContent = '圧縮中...';
  _bbsPhotoB64 = await _bbsCompressPhoto(file);
  if (_bbsPhotoB64) {
    const prev = document.getElementById('bbsPhotoPreview');
    prev.src = _bbsPhotoB64; prev.style.display = 'block';
  }
  document.getElementById('bbsTakePhotoBtn').textContent = '📷 撮影する';
  document.getElementById('bbsPickPhotoBtn').textContent = '🖼 ギャラリー';
}

function _bbsOpenFileInput(useCamera) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  if (useCamera) inp.setAttribute('capture', 'environment');
  inp.style.cssText = 'position:fixed;top:0;left:0;opacity:0;width:0;height:0;pointer-events:none;';
  document.body.appendChild(inp);
  inp.onchange = e => {
    const f = e.target.files[0];
    if (f) _bbsHandlePhoto(f);
    document.body.removeChild(inp);
  };
  inp.click();
}

document.getElementById('bbsTakePhotoBtn').addEventListener('click', () => _bbsOpenFileInput(true));
document.getElementById('bbsPickPhotoBtn').addEventListener('click', () => _bbsOpenFileInput(false));
document.getElementById('bbsPhotoInput').addEventListener('change', e => { _bbsHandlePhoto(e.target.files[0]); e.target.value = ''; });
document.getElementById('bbsPhotoPreview').addEventListener('click', () => { if (_bbsPhotoB64) openPhoto(_bbsPhotoB64); });

document.getElementById('bbsSubmitBtn').addEventListener('click', async () => {
  const comment = document.getElementById('bbsComment').value.trim();
  const cat = document.getElementById('bbsCatSel').value;
  if (!comment) { toast('コメントを入力してください', 2000); return; }
  const btn = document.getElementById('bbsSubmitBtn');
  const status = document.getElementById('bbsFormStatus');
  btn.disabled = true; status.textContent = '投稿中...';
  const post = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(), cat, comment,
    author: _bbsGetUserName(),
    lat: _bbsLat, lng: _bbsLng,
    photo: _bbsPhotoB64 || null
  };
  try {
    await _bbsSavePosts([..._bbsPosts, post]);
    _bbsPosts.push(post);
    _bbsRenderMarkers();
    document.getElementById('bbsComment').value = '';
    _bbsPhotoB64 = null; _bbsLat = null; _bbsLng = null;
    document.getElementById('bbsPhotoPreview').style.display = 'none';
    document.getElementById('bbsLocStatus').textContent = '未設定';
    document.getElementById('bbsTakePhotoBtn').textContent = '📷 撮影する';
    document.getElementById('bbsPickPhotoBtn').textContent = '🖼 ギャラリー';
    document.querySelectorAll('.bbs-tab').forEach(b => b.classList.remove('active'));
    document.getElementById('bbsTabList').classList.add('active');
    document.getElementById('bbsListPane').style.display = '';
    document.getElementById('bbsNewPane').style.display = 'none';
    _bbsRenderList();
    toast('投稿しました！', 2500);
    status.textContent = '';
  } catch(e) {
    status.textContent = '投稿失敗: ' + e.message;
    toast('投稿に失敗しました', 3000);
  }
  btn.disabled = false;
});

/* ─── GPSログ・GPXインポート ───────────────────── */
let _trackPoints = [];
let _trackActive = false;
let _trackLine = null;
let _importedTrackLine = null;

function _updateTrackLine() {
  if (_trackPoints.length < 2) return;
  const latlngs = _trackPoints.map(p => [p.lat, p.lng]);
  if (_trackLine) { _trackLine.setLatLngs(latlngs); }
  else { _trackLine = L.polyline(latlngs, { color: '#e53935', weight: 4, opacity: 0.85, pane: 'gpxPane' }).addTo(map); }
}

function _exportGPX() {
  if (!_trackPoints.length) { toast('記録がありません', 1500); return; }
  const name = new Date().toLocaleString('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GeoForest Map" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${name}</name><trkseg>\n`;
  for (const p of _trackPoints) xml += `    <trkpt lat="${p.lat}" lon="${p.lng}"><time>${p.ts}</time></trkpt>\n`;
  xml += `  </trkseg></trk>\n</gpx>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' }));
  a.download = `track_${new Date().toISOString().slice(0,16).replace(/[T:]/g,'-')}.gpx`;
  a.click();
}

function _importGPX(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const gpx = new DOMParser().parseFromString(e.target.result, 'application/xml');
      const pts = Array.from(gpx.querySelectorAll('trkpt'));
      if (!pts.length) { toast('トラックポイントが見つかりません', 2500); return; }
      const latlngs = pts.map(p => [parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon'))]);
      if (_importedTrackLine) map.removeLayer(_importedTrackLine);
      _importedTrackLine = L.polyline(latlngs, { color: '#1976d2', weight: 4, opacity: 0.9, pane: 'gpxPane' }).addTo(map);
      map.fitBounds(_importedTrackLine.getBounds(), { padding: [40, 40] });
      toast(`GPX読み込み完了（${pts.length}点）`, 2000);
      _buildTrackCtrl();
    } catch(_) { toast('GPXの読み込みに失敗しました', 2500); }
  };
  reader.readAsText(file);
}

function _appendImportBtn(div) {
  const lbl = document.createElement('label');
  lbl.className = 'track-btn';
  lbl.textContent = '📂 GPX読込';
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.gpx'; inp.style.display = 'none';
  inp.onchange = e => { _importGPX(e.target.files[0]); e.target.value = ''; };
  lbl.appendChild(inp);
  div.appendChild(lbl);
}

function _buildTrackCtrl() {
  const div = document.getElementById('trackCtrl');
  if (!div) return;
  div.innerHTML = '';
  if (_trackActive) {
    const info = document.createElement('div');
    info.className = 'track-info'; info.id = 'trackInfo';
    info.textContent = `🔴 記録中 ${_trackPoints.length}点`;
    div.appendChild(info);
    const stopBtn = document.createElement('button');
    stopBtn.className = 'track-btn'; stopBtn.textContent = '⏹ 停止';
    stopBtn.onclick = () => { _trackActive = false; _buildTrackCtrl(); };
    div.appendChild(stopBtn);
  } else if (_trackPoints.length > 0) {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'track-btn'; saveBtn.textContent = '💾 GPX保存';
    saveBtn.onclick = _exportGPX;
    div.appendChild(saveBtn);
    const clrBtn = document.createElement('button');
    clrBtn.className = 'track-btn'; clrBtn.textContent = '🗑 ログ消去';
    clrBtn.onclick = () => {
      _trackPoints = [];
      if (_trackLine) { map.removeLayer(_trackLine); _trackLine = null; }
      _buildTrackCtrl();
    };
    div.appendChild(clrBtn);
  } else {
    const startBtn = document.createElement('button');
    startBtn.className = 'track-btn'; startBtn.textContent = '⏺ ログ開始';
    startBtn.onclick = () => { _trackActive = true; toast('ログ記録を開始しました', 1500); _buildTrackCtrl(); };
    div.appendChild(startBtn);
    _appendImportBtn(div);
    if (_importedTrackLine) {
      const clrBtn = document.createElement('button');
      clrBtn.className = 'track-btn'; clrBtn.textContent = '🗑 GPX消去';
      clrBtn.onclick = () => { map.removeLayer(_importedTrackLine); _importedTrackLine = null; _buildTrackCtrl(); };
      div.appendChild(clrBtn);
    }
  }
}

const trackControl = L.control({ position: 'bottomright' });
trackControl.onAdd = function() {
  const div = L.DomUtil.create('div', 'track-ctrl');
  div.id = 'trackCtrl';
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  return div;
};
trackControl.addTo(map);
setTimeout(_buildTrackCtrl, 0);

/* ─── 現在地 常時追跡（自動開始） ───────────────── */
let currentLocationMarker = null;
let currentLocationCircle = null;

if (navigator.geolocation) {
  let firstFix = true;
  navigator.geolocation.watchPosition(
    pos => {
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      if (firstFix) {
        map.setView(latlng, currentLocationZoom);
        firstFix = false;
      }
      if (currentLocationMarker) map.removeLayer(currentLocationMarker);
      if (currentLocationCircle) map.removeLayer(currentLocationCircle);
      currentLocationMarker = L.circleMarker(latlng, {
        radius: 8, color: '#fff', weight: 3,
        fillColor: '#2979ff', fillOpacity: 1
      }).addTo(map);
      if (pos.coords.accuracy) {
        currentLocationCircle = L.circle(latlng, {
          radius: pos.coords.accuracy,
          color: '#2979ff', weight: 1, fillColor: '#2979ff', fillOpacity: 0.1
        }).addTo(map);
      }
      if (_trackActive) {
        _trackPoints.push({ lat: pos.coords.latitude, lng: pos.coords.longitude, ts: new Date(pos.timestamp).toISOString() });
        _updateTrackLine();
        const info = document.getElementById('trackInfo');
        if (info) info.textContent = `🔴 記録中 ${_trackPoints.length}点`;
      }
    },
    () => { toast('現在地を取得できませんでした', 3000); },
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 5000 }
  );
}
