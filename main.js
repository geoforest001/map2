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
// ★ geoforest001/map2 への書き込み権限を持つ PAT に置き換えてください
const _GH_PAT = ['github_pat_11CEFRMRY0','mquikxruRiN4_ukRsAYZ7rWdrFuv3aYpWk00WJROhS','GF747tXbXCPF5zFI2HJIYA1VDRjLVB'].join('');
const _GH_FILE_URL = 'https://api.github.com/repos/geoforest001/map2/contents/data/posts.json';

let _bbsPosts = [], _bbsSha = null, _bbsMarkers = [], _bbsTimer = null;
let _bbsPhotoB64 = null, _bbsLat = null, _bbsLng = null;
let _bbsPhotoMap = {};

async function _bbsFetchPosts() {
  try {
    const res = await fetch(_GH_FILE_URL, {
      headers: { 'Authorization': 'Bearer ' + _GH_PAT, 'Accept': 'application/vnd.github+json' }
    });
    if (res.status === 404) { _bbsPosts = []; _bbsSha = null; return; }
    if (!res.ok) throw new Error('GitHub API ' + res.status);
    const data = await res.json();
    _bbsSha = data.sha;
    _bbsPosts = JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))))) || [];
  } catch(e) { console.error('[BBS fetch]', e); toast('掲示板の読込失敗', 2500); }
  _bbsCheckNew();
}

async function _bbsSavePosts(posts) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(posts, null, 2))));
  const body = { message: 'BBS: update posts', content: encoded, committer: { name: 'Field Map', email: 'map@field' } };
  if (_bbsSha) body.sha = _bbsSha;
  const res = await fetch(_GH_FILE_URL, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + _GH_PAT, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
    body: JSON.stringify(body)
  });
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
  await _bbsFetchPosts();
  _bbsRenderMarkers();
  _bbsRenderList();
  if (!_bbsTimer) _bbsTimer = setInterval(async () => {
    await _bbsFetchPosts(); _bbsRenderMarkers(); _bbsRenderList();
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
  await _bbsFetchPosts();
  setInterval(async () => {
    if (bbsPanel.style.display !== 'flex') await _bbsFetchPosts();
  }, 60000);
})();

document.getElementById('bbsClose').addEventListener('click', closeBbsPanel);
document.getElementById('bbsCollapseBtn').addEventListener('click', () => { bbsPanel.classList.toggle('collapsed'); });
document.getElementById('bbsRefreshBtn').addEventListener('click', async () => {
  document.getElementById('bbsLoadingMsg').style.display = 'block';
  document.getElementById('bbsList').innerHTML = '';
  await _bbsFetchPosts(); _bbsRenderMarkers(); _bbsRenderList();
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

document.getElementById('bbsPickPhotoBtn').addEventListener('click', () => document.getElementById('bbsPhotoInput').click());
document.getElementById('bbsPhotoInput').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  document.getElementById('bbsPickPhotoBtn').textContent = '圧縮中...';
  _bbsPhotoB64 = await _bbsCompressPhoto(f);
  if (_bbsPhotoB64) {
    const prev = document.getElementById('bbsPhotoPreview');
    prev.src = _bbsPhotoB64; prev.style.display = 'block';
  }
  document.getElementById('bbsPickPhotoBtn').textContent = '📷 写真を変更';
  e.target.value = '';
});
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
    document.getElementById('bbsPickPhotoBtn').textContent = '📷 写真を選択';
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

const fallbackLocation = [36.648526, 138.194243];
const fallbackZoom = 11;
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
    className: "grayscale-layer"
  }
);

const gsiAirPhoto = L.tileLayer(
  "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
  {
    attribution: gsiAttribution,
    maxZoom: 18
  }
);

const naganoCsMap = L.tileLayer(
  "https://tile.geospatial.jp/CS/VER2/{z}/{x}/{y}.png",
  {
    attribution:
      '<a href="https://www.geospatial.jp/ckan/dataset/nagano-csmap">長野県CS立体図</a>',
    maxZoom: 18
  }
);

gsiStandard.addTo(map);

const FARM_POLYGON_URL = "https://geoforest001.github.io/ina_farm_test/data/%E8%BE%B2%E5%9C%B0%E7%AD%86%E3%83%9D%E3%83%AA%E3%82%B4%E3%83%B3.pmtiles";
const PIPELINE_URL = "https://geoforest001.github.io/ina_farm_test/data/%E3%83%91%E3%82%A4%E3%83%97%E3%83%A9%E3%82%A4%E3%83%B3.pmtiles";

const farmPolygonTiles = protomapsL.leafletLayer({
  url: FARM_POLYGON_URL,
  maxDataZoom: 13,
  paintRules: [
    {
      dataLayer: "農地筆ポリゴン2025",
      symbolizer: new protomapsL.PolygonSymbolizer({
        fill: "rgb(240,210,0)",
        opacity: 0.3,
        stroke: "rgb(160,130,0)",
        width: 1.5
      })
    }
  ],
  labelRules: []
});
farmPolygonTiles.addTo(map);

const pipelineTiles = protomapsL.leafletLayer({
  url: PIPELINE_URL,
  maxDataZoom: 15,
  paintRules: [
    {
      dataLayer: "02パイプライン_Layer",
      symbolizer: new protomapsL.LineSymbolizer({
        color: "rgb(0,80,200)",
        width: 4
      })
    }
  ],
  labelRules: []
});
pipelineTiles.addTo(map);

const WATERWAY_URL = "https://geoforest001.github.io/ina_farm_test/data/%E6%B0%B4%E8%B7%AF.pmtiles";

const waterwayTiles = protomapsL.leafletLayer({
  url: WATERWAY_URL,
  maxDataZoom: 15,
  paintRules: [
    {
      dataLayer: "水路",
      symbolizer: new protomapsL.LineSymbolizer({
        color: "rgb(0,150,255)",
        width: 2
      })
    }
  ],
  labelRules: []
});
waterwayTiles.addTo(map);

const SURVEY_URL = "https://geoforest001.github.io/map2/data/manhole.pmtiles";

const surveyTiles = protomapsL.leafletLayer({
  url: SURVEY_URL,
  maxDataZoom: 15,
  paintRules: [
    {
      dataLayer: "02調査結果 R6",
      filter: (zoom, feature) => feature.props["結合用_表示"] === "発見",
      symbolizer: new protomapsL.CircleSymbolizer({ radius: 3, fill: "rgb(240,200,0)", opacity: 1, stroke: "black", width: 1 })
    },
    {
      dataLayer: "02調査結果 R6",
      filter: (zoom, feature) => feature.props["結合用_表示"] === "不明",
      symbolizer: new protomapsL.CircleSymbolizer({ radius: 3, fill: "rgb(220,120,0)", opacity: 1, stroke: "black", width: 1 })
    },
    {
      dataLayer: "02調査結果 R6",
      filter: (zoom, feature) => feature.props["結合用_表示"] === "未",
      symbolizer: new protomapsL.CircleSymbolizer({ radius: 3, fill: "rgb(180,180,180)", opacity: 1, stroke: "black", width: 1 })
    },
    {
      dataLayer: "02調査結果 R6",
      filter: (zoom, feature) => feature.props["結合用_表示"] === "GF",
      symbolizer: new protomapsL.CircleSymbolizer({ radius: 3, fill: "rgb(150,50,180)", opacity: 1, stroke: "black", width: 1 })
    },
    {
      dataLayer: "02調査結果 R6",
      filter: (zoom, feature) => feature.props["結合用_表示"] === "新",
      symbolizer: new protomapsL.CircleSymbolizer({ radius: 3, fill: "rgb(220,20,20)", opacity: 1, stroke: "black", width: 1 })
    }
  ],
  labelRules: []
});
surveyTiles.addTo(map);

const baseLayers = {
  "地理院標準地図": gsiStandard,
  "地理院航空写真": gsiAirPhoto,
  "長野県CS立体図": naganoCsMap
};

const overlays = {
  "農地筆ポリゴン": farmPolygonTiles,
  "パイプライン": pipelineTiles,
  "水路": waterwayTiles,
  "マンホール": surveyTiles
};

let layerControl;

function renderLayerControl() {
  if (layerControl) {
    map.removeControl(layerControl);
  }

  layerControl = L.control.layers(baseLayers, overlays, {
    position: "topright",
    collapsed: false
  });

  layerControl.addTo(map);
}

renderLayerControl();

const marker = L.marker(fallbackLocation)
  .addTo(map)
  .bindPopup("長野市")
  .openPopup();

if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const currentLocation = [coords.latitude, coords.longitude];

      map.setView(currentLocation, currentLocationZoom);
      marker
        .setLatLng(currentLocation)
        .setPopupContent("現在地")
        .openPopup();
    },
    () => {
      map.setView(fallbackLocation, fallbackZoom);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000
    }
  );
}
