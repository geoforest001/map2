/* ============================================================
   weather.js  — 気象情報ダッシュボード + 気象レイヤ (geoforest001/map2)
   気象庁 API + AMeDAS  ©  akahanenoriaki
   ============================================================ */

/* ─── 定数・状態 ─────────────────────────────── */
const PREF_TO_JMA = {
  '01':'016000','02':'020000','03':'030000','04':'040000','05':'050000',
  '06':'060000','07':'070000','08':'080000','09':'090000','10':'100000',
  '11':'110000','12':'120000','13':'130000','14':'140000','15':'150000',
  '16':'160000','17':'170000','18':'180000','19':'190000','20':'200000',
  '21':'210000','22':'220000','23':'230000','24':'240000','25':'250000',
  '26':'260000','27':'270000','28':'280000','29':'290000','30':'300000',
  '31':'310000','32':'320000','33':'330000','34':'340000','35':'350000',
  '36':'360000','37':'370000','38':'380000','39':'390000','40':'400000',
  '41':'410000','42':'420000','43':'430000','44':'440000','45':'450000',
  '46':'460100','47':'471000'
};
const WIND_DIR = ['静穏','北北東','北東','東北東','東','東南東','南東','南南東',
                  '南','南南西','南西','西南西','西','西北西','北西','北北西','北'];
const AM_CHART_VARS = {
  rain1h:  {field:'precipitation10m',agg:'hourly', idx:0,col:'rgba(0,102,255,0.55)',type:'bar', files:8},
  rain10m: {field:'precipitation10m',agg:'raw10m', idx:0,col:'rgba(0,160,200,0.7)', type:'bar', files:2},
  rain24h: {field:'precipitation10m',agg:'cumsum', idx:0,col:'rgba(0,60,180,0.75)', type:'line',files:8},
  temp:    {field:'temp',            agg:'last',   idx:0,col:'rgba(255,100,0,0.8)', type:'line',files:8},
  humid:   {field:'humidity',        agg:'last',   idx:0,col:'rgba(0,160,200,0.8)', type:'line',files:8},
  wind:    {field:'wind',            agg:'avg',    idx:0,col:'rgba(80,180,0,0.8)',  type:'line',files:8},
  winddir: {field:'windDirection',    agg:'dir_hist',idx:0,col:'rgba(150,100,220,0.7)',type:'bar',files:8},
  snow:    {field:'snow',            agg:'last',   idx:0,col:'rgba(150,200,255,0.7)',type:'bar',files:8},
};

/* 気象レイヤ定義 */
const WX_LAYER_DEFS = {
  rain: {type:'nowc', zoom:10, tf:['targetTimes_N1.json'], url:(bt,vt,mb)=>`https://www.jma.go.jp/bosai/jmatile/data/nowc/${bt}/none/${vt}/surf/hrpns/{z}/{x}/{y}.png`},
};
const wxLayerState = {};
Object.keys(WX_LAYER_DEFS).forEach(k => { wxLayerState[k] = {on:false, layer:null, timer:null, errCount:0}; });
const WX_CHK_MAP = {rain:'chkLRain'};
const WX_LBL_MAP = {rain:'lblLRain'};

/* 長野県 河川砂防情報ステーション */
const SABO_GIS  = 'https://www.gis.sabo-nagano.jp';
const SABO_BASE = 'https://www.sabo-nagano.jp';
const STAGE_COL = {'-3':'#888','-2':'#888','-1':'#888','0':'#2e7d32','1':'#f9a825','2':'#e65100','3':'#c62828','4':'#6a0080'};

let _jmaForecast = null;
let _amedasCurrentTemp = null, _amedasCurrentTime = null;
let _amedasTable = null;
let _currentAmedasStation = null;
let wxChart = null;
let wxOpen = false;
let _cwCounter = 0;
const _charts = new Map();
let _activeChartId = null, _sheetChart = null;
let amedasOn = false, amedasMarkers = [], amedasTimer = null;
let weatherTimer = null;
const _rainAnim = {on:false, frames:[], idx:0, layer:null, frameTimer:null, refreshTimer:null};
let _kikendoOn = false, _kikendoOverlays = [], _kikendoTimer = null;
let riverOn = false, riverMarkers = [], riverTimer = null;

/* ─── ユーティリティ ─────────────────────────── */
function jmaCodeIcon(code) {
  const n = parseInt(code) || 0;
  if (n >= 100 && n < 200) return '☀️';
  if (n >= 200 && n < 300) return '⛅';
  if (n >= 300 && n < 400) return '🌧';
  if (n >= 400 && n < 500) return '🌧';
  if (n >= 500 && n < 600) return '❄️';
  if (n >= 600 && n < 700) return '🌧';
  if (n >= 700 && n < 800) return '🌨';
  return '🌡';
}

function jmaTime(intervalMin = 5, lagMin = 5) {
  const now = new Date();
  const totalMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const floored = Math.floor(totalMin / intervalMin) * intervalMin - lagMin;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, floored, 0));
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`;
}

async function getJmaValidTime(type, candidates) {
  for (const file of (candidates || ['targetTimes_N1.json'])) {
    try {
      const res = await fetch(`https://www.jma.go.jp/bosai/jmatile/data/${type}/${file}`);
      if (!res.ok) continue;
      const arr = await res.json();
      if (!Array.isArray(arr) || !arr.length) continue;
      const first = arr[0];
      if (typeof first === 'string') return {basetime: first, validtime: first, member: 'none'};
      const bt = first.basetime || first.time || '';
      const vt = first.validtime || bt;
      const member = first.member || 'none';
      if (bt) return {basetime: bt, validtime: vt, member};
    } catch(e) { console.warn('[getJmaValidTime]', e); }
  }
  return null;
}

async function getJMAAreaCode(lat, lng) {
  const res = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`);
  const data = await res.json();
  const muniCd = data.results?.muniCd;
  if (!muniCd) throw new Error('地域コード取得失敗');
  return PREF_TO_JMA[String(muniCd).padStart(5, '0').slice(0, 2)] || '130000';
}

function getFileList(count = 8) {
  const now = new Date(), jst = new Date(now.getTime() + 9 * 3600000);
  const latestH3 = Math.floor(jst.getUTCHours() / 3) * 3, files = [];
  const p = n => String(n).padStart(2, '0');
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), latestH3 - i * 3, 0, 0));
    files.push({ ymd: `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`, hh: p(d.getUTCHours()) });
  }
  return files;
}

function _jmaTempLabels(timeDefines) {
  const DOW = ['日','月','火','水','木','金','土'];
  return timeDefines.map(t => {
    const jd = new Date(new Date(t).getTime() + 9 * 3600000);
    const h = jd.getUTCHours();
    return `${jd.getUTCMonth()+1}/${jd.getUTCDate()}(${DOW[jd.getUTCDay()]})${h > 0 ? ' ' + h + '時' : ''}`;
  });
}

function _compColors(arr, upCol, downCol, baseCol) {
  return arr.map((v, i) => {
    if (v === null) return 'rgba(200,200,200,0.3)';
    if (i === 0) return baseCol;
    const prev = arr.slice(0, i).reverse().find(x => x !== null);
    return prev === undefined ? baseCol : v > prev ? upCol : v < prev ? downCol : baseCol;
  });
}

function _prependCurrent(labels, data) {
  if (_amedasCurrentTemp === null) return { labels, data };
  const now = _amedasCurrentTime || new Date();
  const p = n => String(n).padStart(2, '0');
  return { labels: [`現在\n${p(now.getHours())}:${p(now.getMinutes())}`, ...labels], data: [_amedasCurrentTemp, ...data] };
}

/* ─── 気象タイルレイヤ ───────────────────────── */
async function wxUpdateLayer(key) {
  const def = WX_LAYER_DEFS[key], st = wxLayerState[key];
  if (!st.on) return;
  try {
    const times = await getJmaValidTime(def.type, def.tf);
    const t = jmaTime(5, 10);
    const mb = times?.member || 'none';
    const urlTpl = times ? def.url(times.basetime, times.validtime, mb) : def.url(t, t, 'none');
    if (st.layer) map.removeLayer(st.layer);
    st.errCount = 0;
    const lbl = document.getElementById(WX_LBL_MAP[key]);
    const lyr = L.tileLayer(urlTpl, {opacity:0.7, maxNativeZoom:def.zoom, maxZoom:22, attribution:'© 気象庁'});
    lyr.on('tileerror', () => {
      st.errCount++;
      if (st.errCount === 3 && lbl) lbl.style.borderColor = '#ff3b30';
    });
    lyr.on('tileload', () => { st.errCount = 0; if (lbl) lbl.style.borderColor = ''; });
    st.layer = lyr.addTo(map);
  } catch(e) {
    console.error('[wxUpdateLayer]', key, e);
  }
}

async function wxApplyLayerState(key) {
  try {
    const st = wxLayerState[key];
    const lbl = document.getElementById(WX_LBL_MAP[key]);
    if (lbl) lbl.classList.toggle('active', st.on);
    if (st.on) {
      await wxUpdateLayer(key);
      if (!st.timer) st.timer = setInterval(() => wxUpdateLayer(key), 5 * 60 * 1000);
    } else {
      clearInterval(st.timer); st.timer = null;
      if (st.layer) { map.removeLayer(st.layer); st.layer = null; }
    }
  } catch(e) {
    console.error('[wxApplyLayerState]', key, e);
  }
}

/* ─── AMeDASマーカーレイヤ ──────────────────── */
async function fetchAmedasMarkers() {
  try {
    const timeRes = await fetch('https://www.jma.go.jp/bosai/amedas/data/latest_time.txt');
    if (!timeRes.ok) throw new Error(`latest_time HTTP ${timeRes.status}`);
    const rawTime = (await timeRes.text()).trim();
    const m = rawTime.match(/(\d{4})\D(\d{2})\D(\d{2})\D(\d{2}):(\d{2}):(\d{2})/);
    if (!m) throw new Error('time parse failed');
    const timeStr = `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}`;
    if (!_amedasTable) {
      const tRes = await fetch('https://www.jma.go.jp/bosai/amedas/const/amedastable.json');
      if (!tRes.ok) throw new Error(`amedastable HTTP ${tRes.status}`);
      _amedasTable = await tRes.json();
    }
    const dataRes = await fetch(`https://www.jma.go.jp/bosai/amedas/data/map/${timeStr}.json`);
    if (!dataRes.ok) throw new Error(`map data HTTP ${dataRes.status}`);
    const data = await dataRes.json();
    amedasMarkers.forEach(mk => map.removeLayer(mk)); amedasMarkers = [];
    const center = map.getCenter();
    const stations = Object.entries(data).map(([code, d]) => {
      const info = _amedasTable[code];
      if (!info || !info.lat || !info.lon || !Array.isArray(info.lat)) return null;
      const lat = info.lat[0] + info.lat[1] / 60, lng = info.lon[0] + info.lon[1] / 60;
      if (isNaN(lat) || isNaN(lng)) return null;
      return {code, info, d, lat, lng, dist: map.distance(center, L.latLng(lat, lng))};
    }).filter(s => s && s.dist < 60000).sort((a, b) => a.dist - b.dist).slice(0, 20);
    stations.forEach(s => {
      const tv = s.d.temp ? s.d.temp[0] : null;
      const temp = tv !== null ? `${tv}°C` : '--';
      const rain = s.d.precipitation1h ? `${s.d.precipitation1h[0]}mm/h` : (s.d.precipitation10m ? `${s.d.precipitation10m[0]}mm/10m` : '--');
      const wind = s.d.wind ? `${s.d.wind[0]}m/s` : '--';
      const col = tv === null ? '#888' : tv >= 30 ? '#c62828' : tv >= 25 ? '#e65100' : tv >= 15 ? '#1565c0' : tv >= 5 ? '#0277bd' : '#4a148c';
      const mk = L.marker([s.lat, s.lng], {
        icon: L.divIcon({
          html: `<div style="background:#fff;color:${col};border:2px solid ${col};border-radius:6px;padding:2px 7px;font-size:13px;font-family:sans-serif;font-weight:bold;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.25)">${temp}</div>`,
          className: '', iconAnchor: [22, 12]
        })
      }).addTo(map);
      mk.bindPopup(`<div style="font-size:12px;font-family:sans-serif"><b>📡 ${s.info.kjName || s.code}</b><br>🌡 ${temp}　🌧 ${rain}　💨 ${wind}</div>`);
      amedasMarkers.push(mk);
    });
    document.getElementById('lblLAmedas').style.borderColor = '';
  } catch(e) {
    console.error('[AMeDAS marker]', e);
    document.getElementById('lblLAmedas').style.borderColor = '#ff3b30';
  }
}

/* ─── 予報取得 ───────────────────────────────── */
async function fetchWeather(lat, lng) {
  document.getElementById('wxLoading').style.display = 'block';
  document.getElementById('wxLoading').textContent = '取得中...';
  document.getElementById('wxContent').style.display = 'none';
  try {
    const officeCode = await getJMAAreaCode(lat, lng);
    const res = await fetch(`https://www.jma.go.jp/bosai/forecast/data/forecast/${officeCode}.json`);
    if (!res.ok) throw new Error(`気象庁API HTTP ${res.status}`);
    const fc = await res.json();
    _jmaForecast = fc;
    const shortTerm = fc[0];
    const ts0 = shortTerm.timeSeries[0], ts1 = shortTerm.timeSeries[1], ts2 = shortTerm.timeSeries[2];
    const area0 = ts0.areas[0];
    const todayCode = area0.weatherCodes?.[0] || '100';
    const _wx = (area0.weathers?.[0] || '').replace(/\s+/g, ' ').trim();
    const todayWeather = _wx.length > 12 ? _wx.slice(0, 12) + '…' : _wx;
    const pops = ts1.areas[0].pops || [];
    const maxPop = pops.filter(p => p !== '').map(Number).reduce((m, v) => Math.max(m, v), -1);
    const tempArea = ts2.areas[0];
    const maxArr = tempArea.tempsMax || tempArea.temps || [], minArr = tempArea.tempsMin || [];
    const todayMax = maxArr.find(v => v !== '') || null, todayMin = minArr.find(v => v !== '') || null;
    document.getElementById('wxIcon').textContent = jmaCodeIcon(todayCode);
    document.getElementById('wxDesc').textContent = todayWeather || '--';
    document.getElementById('wxTemp').textContent = `↑${todayMax || '--'}° / ↓${todayMin || '--'}°`;
    document.getElementById('wxRain').textContent = maxPop >= 0 ? `${maxPop}%` : '--';
    document.getElementById('wxWind').textContent = todayMax ? `${todayMax}°C` : '--';
    document.getElementById('wxHumid').textContent = todayMin ? `${todayMin}°C` : '--';
    const dayCards = document.getElementById('wxDayCards'); dayCards.innerHTML = '';
    ['今日', '明日', '明後日'].forEach((name, i) => {
      if (i >= (area0.weatherCodes || []).length) return;
      const code = area0.weatherCodes[i] || '';
      const pop = pops.filter((_, j) => Math.floor(j / 2) === i).filter(p => p !== '').map(Number);
      const dayMaxPop = pop.length ? Math.max(...pop) : -1;
      const dMax = maxArr[i] || '', dMin = minArr[i] || '';
      const card = document.createElement('div'); card.className = 'wx-day-card';
      card.innerHTML = `<div class="dc-day">${name}</div><div class="dc-ico">${jmaCodeIcon(code)}</div>`
        + (dayMaxPop >= 0 ? `<div class="dc-pop">☔${dayMaxPop}%</div>` : '')
        + ((dMax || dMin) ? `<div class="dc-tmp">${dMax ? dMax + '°' : ''} / ${dMin ? dMin + '°' : ''}</div>` : '');
      dayCards.appendChild(card);
    });
    document.getElementById('wxMain').onclick = () => { showJmaMaxTempChart(); showJmaMinTempChart(); };
    document.getElementById('wxCellRain').onclick = () => showJmaPOPChart('降水確率（3日間）');
    document.getElementById('wxCellWind').onclick = () => showJmaMaxTempChart();
    document.getElementById('wxCellHumid').onclick = () => showJmaMinTempChart();
    const labels = ts1.timeDefines.map(t => {
      const d = new Date(t); return `${String((d.getUTCHours() + 9) % 24).padStart(2, '0')}時`;
    });
    if (wxChart) wxChart.destroy();
    wxChart = new Chart(document.getElementById('wxChart'), {
      type: 'bar',
      data: { labels, datasets: [{ label: '降水確率(%)', data: pops.map(p => p === '' ? null : Number(p)), backgroundColor: 'rgba(0,102,255,0.5)', borderColor: 'rgba(0,102,255,0.8)', borderWidth: 1 }] },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { font: { size: 8 }, maxTicksLimit: 8 }, grid: { display: false } }, y: { beginAtZero: true, max: 100, ticks: { font: { size: 9 }, maxTicksLimit: 4, callback: v => v + '%' }, grid: { color: 'rgba(0,0,0,0.06)' } } } }
    });
    const now = new Date(), p = n => String(n).padStart(2, '0');
    document.getElementById('wxUpdated').textContent = `${p(now.getHours())}:${p(now.getMinutes())} 更新`;
    document.getElementById('wxLoading').style.display = 'none';
    document.getElementById('wxContent').style.display = 'flex';
    fetchAmedasForLocation(lat, lng);
  } catch (e) {
    console.error('[fetchWeather]', e);
    document.getElementById('wxLoading').textContent = '取得に失敗しました';
  }
}

/* ─── AMeDAS最寄り ───────────────────────────── */
async function fetchAmedasForLocation(lat, lng) {
  document.getElementById('wxAmedasLoading').style.display = 'block';
  document.getElementById('wxAmedasSection').style.display = 'none';
  try {
    const timeRes = await fetch('https://www.jma.go.jp/bosai/amedas/data/latest_time.txt');
    if (!timeRes.ok) throw new Error(`latest_time HTTP ${timeRes.status}`);
    const rawTime = (await timeRes.text()).trim();
    const tm = rawTime.match(/(\d{4})\D(\d{2})\D(\d{2})\D(\d{2}):(\d{2}):(\d{2})/);
    if (!tm) throw new Error('time parse failed');
    const timeStr = `${tm[1]}${tm[2]}${tm[3]}${tm[4]}${tm[5]}${tm[6]}`;
    if (!_amedasTable) {
      const tRes = await fetch('https://www.jma.go.jp/bosai/amedas/const/amedastable.json');
      _amedasTable = await tRes.json();
    }
    const dataRes = await fetch(`https://www.jma.go.jp/bosai/amedas/data/map/${timeStr}.json`);
    if (!dataRes.ok) throw new Error(`map data HTTP ${dataRes.status}`);
    const data = await dataRes.json();
    const ref = L.latLng(lat, lng);
    const nearest = Object.entries(data).map(([code, d]) => {
      const info = _amedasTable[code];
      if (!info || !Array.isArray(info.lat)) return null;
      const slat = info.lat[0] + info.lat[1] / 60, slng = info.lon[0] + info.lon[1] / 60;
      if (isNaN(slat) || isNaN(slng)) return null;
      return { code, info, d, lat: slat, lng: slng, dist: map.distance(ref, L.latLng(slat, slng)) };
    }).filter(s => s).sort((a, b) => a.dist - b.dist)[0];
    if (nearest) showAmedasDetail(nearest);
    else throw new Error('観測点が見つかりません');
  } catch (e) {
    console.error('[AMeDAS loc]', e);
    document.getElementById('wxAmedasLoading').textContent = `❌ AMeDAS: ${e.message}`;
  }
}

function showAmedasDetail(s) {
  _currentAmedasStation = s;
  document.getElementById('wxAmedasLoading').style.display = 'none';
  const sec = document.getElementById('wxAmedasSection'); sec.style.display = 'flex';
  document.getElementById('amStationName').textContent = s.info.kjName || s.code;
  const dist = s.dist >= 1000 ? `${(s.dist / 1000).toFixed(1)}km` : `${Math.round(s.dist)}m`;
  document.getElementById('amDistBadge').textContent = `現在地から約 ${dist}`;
  const tv = s.d.temp ? s.d.temp[0] : null;
  _amedasCurrentTemp = tv; _amedasCurrentTime = new Date();
  const tempEl = document.getElementById('amTemp');
  tempEl.textContent = tv !== null ? `${tv}°C` : '--';
  tempEl.className = 'val' + (tv === null ? '' : tv >= 30 ? ' t-hot' : tv >= 25 ? ' t-warm' : tv <= 5 ? ' t-cold' : tv <= 15 ? ' t-cool' : '');
  document.getElementById('amHumid').textContent = s.d.humidity ? `${s.d.humidity[0]}%` : '--';
  const r1h = s.d.precipitation1h ? s.d.precipitation1h[0] : null;
  const rain1El = document.getElementById('amCellRain1h');
  document.getElementById('amRain1h').textContent = r1h !== null ? `${r1h}mm` : '--';
  rain1El.className = 'am-cell' + (r1h !== null && r1h >= 10 ? ' rain-alert' : '');
  document.getElementById('amRain10m').textContent = s.d.precipitation10m ? `${s.d.precipitation10m[0]}mm` : '--';
  document.getElementById('amRain24h').textContent = s.d.precipitation24h ? `${s.d.precipitation24h[0]}mm` : '--';
  document.getElementById('amWind').textContent = s.d.wind ? `${s.d.wind[0]}m/s` : '--';
  document.getElementById('amWindDir').textContent = s.d.windDirection ? (WIND_DIR[s.d.windDirection[0]] || '--') : '--';
  document.getElementById('amSnow').textContent = s.d.snow ? `${s.d.snow[0]}cm` : '--';
  document.getElementById('amCellTemp').onclick = () => fetchAmedasChart('temp', '過去24時間の気温');
  document.getElementById('amCellHumid').onclick = () => fetchAmedasChart('humid', '過去24時間の湿度');
  document.getElementById('amCellRain1h').onclick = () => fetchAmedasChart('rain1h', '過去24時間の時間雨量');
  document.getElementById('amCellRain10m').onclick = () => fetchAmedasChart('rain10m', '直近6時間の10分雨量');
  document.getElementById('amCellRain24h').onclick = () => fetchAmedasChart('rain24h', '過去24時間の累積雨量');
  document.getElementById('amCellWind').onclick = () => fetchAmedasChart('wind', '過去24時間の風速');
  document.getElementById('amCellWindDir').onclick = () => fetchAmedasChart('winddir', '過去24時間の風向（頻度）');
  document.getElementById('amCellSnow').onclick = () => fetchAmedasChart('snow', '過去24時間の積雪深');
  (async () => {
    const jst = new Date(new Date().getTime() + 9 * 3600000);
    const p = n => String(n).padStart(2, '0');
    const ymd = `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}`;
    try {
      const r = await fetch(`https://www.jma.go.jp/bosai/amedas/data/point/${s.code}/${ymd}_06.json`);
      if (!r.ok) return;
      const data = await r.json();
      const key = Object.keys(data).sort().find(k => k.slice(8, 10) === '06' && parseInt(k.slice(10, 12)) <= 10);
      const t = key && data[key].temp ? data[key].temp[0] : null;
      if (t === null) return;
      const humEl = document.getElementById('wxHumid');
      if (humEl && humEl.textContent === '--') {
        humEl.textContent = `${t}°C`;
        const lbl = document.getElementById('wxCellHumid').querySelector('.lbl');
        if (lbl) lbl.textContent = '🌅 今朝6時';
      }
    } catch {}
  })();
}

/* ─── AMeDASチャート ─────────────────────────── */
async function fetchAmedasChart(varKey, title) {
  const cfg = AM_CHART_VARS[varKey];
  if (!cfg || !_currentAmedasStation) return;
  const w = openChartWindow(title);
  try {
    const code = _currentAmedasStation.code;
    const results = await Promise.all(getFileList(cfg.files).map(async ({ ymd, hh }) => {
      try { const r = await fetch(`https://www.jma.go.jp/bosai/amedas/data/point/${code}/${ymd}_${hh}.json`); return r.ok ? await r.json() : null; } catch { return null; }
    }));
    if (cfg.agg === 'dir_hist') {
      const freq = new Array(17).fill(0);
      results.forEach(data => { if (!data) return; Object.values(data).forEach(d => { const raw = d[cfg.field]; const v = raw ? raw[cfg.idx] : null; if (v !== null && v !== undefined) freq[v] = (freq[v] || 0) + 1; }); });
      w.setChart(WIND_DIR.slice(1).concat(['静穏']), [{ data: freq.slice(1).concat([freq[0]]), type: 'bar', backgroundColor: cfg.col, borderColor: cfg.col, borderWidth: 1 }], '気象庁 AMeDAS');
      return;
    }
    if (cfg.agg === 'raw10m') {
      const entries = [];
      results.forEach(data => { if (!data) return; Object.entries(data).sort((a, b) => a[0].localeCompare(b[0])).forEach(([ts, d]) => { const raw = d[cfg.field]; const v = raw ? raw[cfg.idx] : null; if (v === null || v === undefined || v < 0) return; entries.push({ label: `${ts.slice(8, 10)}:${ts.slice(10, 12)}`, v: Math.round(v * 10) / 10 }); }); });
      w.setChart(entries.map(e => e.label), [{ data: entries.map(e => e.v), type: 'bar', backgroundColor: cfg.col, borderColor: cfg.col, borderWidth: 1 }], '気象庁 AMeDAS');
      return;
    }
    const hourly = {}, cnt = {};
    results.forEach(data => { if (!data) return; Object.entries(data).forEach(([ts, d]) => { const raw = d[cfg.field]; const v = raw ? raw[cfg.idx] : null; if (v === null || v === undefined || v < 0) return; const hh = ts.slice(8, 10); if (cfg.agg === 'hourly' || cfg.agg === 'cumsum') { hourly[hh] = (hourly[hh] || 0) + v; } else if (cfg.agg === 'avg') { hourly[hh] = (hourly[hh] || 0) + v; cnt[hh] = (cnt[hh] || 0) + 1; } else { hourly[hh] = v; } }); });
    if (cfg.agg === 'avg') Object.keys(hourly).forEach(h => { if (cnt[h]) hourly[h] = Math.round(hourly[h] / cnt[h] * 10) / 10; });
    const jst = new Date(new Date().getTime() + 9 * 3600000), curH = jst.getUTCHours();
    const labels = [], vals = []; let cumul = 0;
    for (let i = 23; i >= 0; i--) {
      const h = ((curH - i) + 24) % 24; labels.push(`${h}時`);
      const v = hourly[String(h).padStart(2, '0')]; const rounded = v !== undefined ? Math.round(v * 10) / 10 : null;
      if (cfg.agg === 'cumsum') { if (rounded !== null) cumul = Math.round((cumul + rounded) * 10) / 10; vals.push(cumul); } else { vals.push(rounded); }
    }
    w.setChart(labels, [{ data: vals, type: cfg.type, backgroundColor: cfg.col, borderColor: cfg.col, borderWidth: 2, fill: cfg.agg === 'cumsum', tension: 0.3, pointRadius: 2, spanGaps: true }], '気象庁 AMeDAS');
  } catch (e) { console.error('[AmedasChart]', e); w.setError(e.message); }
}

/* ─── 予報チャート ───────────────────────────── */
function showJmaPOPChart(title) {
  const w = openChartWindow(title || '降水確率');
  if (!_jmaForecast) { w.setError('データなし'); return; }
  try {
    const ts1 = _jmaForecast[0].timeSeries[1];
    const labels = ts1.timeDefines.map(t => { const d = new Date(t); const jh = d.getUTCHours() + 9; const jd = new Date(d.getTime() + 9 * 3600000); return `${jd.getUTCMonth()+1}/${jd.getUTCDate()} ${String(jh % 24).padStart(2, '0')}時`; });
    w.setChart(labels, [{ data: ts1.areas[0].pops.map(p => p === '' ? null : Number(p)), type: 'bar', backgroundColor: 'rgba(0,102,255,0.55)', borderColor: 'rgba(0,102,255,0.8)', borderWidth: 1 }], '気象庁');
  } catch (e) { w.setError(e.message); }
}

function showJmaMaxTempChart() {
  const w = openChartWindow('最高気温の今後の推移');
  if (!_jmaForecast) { w.setError('データなし'); return; }
  try {
    const ts2 = _jmaForecast[0].timeSeries[2], area = ts2.areas[0];
    const r = _prependCurrent(_jmaTempLabels(ts2.timeDefines), (area.tempsMax || area.temps || []).map(v => v === '' ? null : Number(v)));
    const bg = _compColors(r.data, 'rgba(220,50,0,0.7)', 'rgba(0,80,220,0.7)', 'rgba(180,100,0,0.6)');
    const bd = _compColors(r.data, 'rgba(220,50,0,1)', 'rgba(0,80,220,1)', 'rgba(180,100,0,1)');
    w.setChart(r.labels, [{ label: '最高気温(°C)', data: r.data, type: 'bar', backgroundColor: bg, borderColor: bd, borderWidth: 1 }], '気象庁', { beginAtZero: false });
  } catch (e) { w.setError(e.message); }
}

function showJmaMinTempChart() {
  const hasMin = _jmaForecast && (_jmaForecast[0].timeSeries[2].areas[0].tempsMin || []).some(v => v !== '');
  const w = openChartWindow('最低気温の今後の推移');
  if (!_jmaForecast) { w.setError('データなし'); return; }
  try {
    const ts2 = _jmaForecast[0].timeSeries[2], area = ts2.areas[0];
    const temps = hasMin ? (area.tempsMin || []) : (area.tempsMax || area.temps || []);
    const r = _prependCurrent(_jmaTempLabels(ts2.timeDefines), temps.map(v => v === '' ? null : Number(v)));
    const bg = _compColors(r.data, 'rgba(220,50,0,0.7)', 'rgba(0,80,220,0.7)', 'rgba(0,100,200,0.6)');
    const bd = _compColors(r.data, 'rgba(220,50,0,1)', 'rgba(0,80,220,1)', 'rgba(0,100,200,1)');
    w.setChart(r.labels, [{ label: '最低気温(°C)', data: r.data, type: 'bar', backgroundColor: bg, borderColor: bd, borderWidth: 1 }], '気象庁', { beginAtZero: false });
  } catch (e) { w.setError(e.message); }
}

/* ─── チャートウィンドウ ─────────────────────── */
function openChartWindow(title) {
  return window.innerWidth < 768 ? _openChartSheet(title) : _openChartFloat(title);
}

function _openChartSheet(title) {
  _cwCounter++;
  const id = `c${_cwCounter}`;
  _charts.set(id, { title, labels: null, datasets: null, source: null, error: null });
  const chips = document.getElementById('chartChips');
  const chip = document.createElement('div');
  chip.className = 'chart-chip'; chip.id = `chip-${id}`;
  chip.innerHTML = `<span class="chip-lbl">${title}</span><button class="chip-cls">✕</button>`;
  chip.querySelector('.chip-lbl').onclick = () => activateChart(id);
  chip.querySelector('.chip-cls').onclick = e => { e.stopPropagation(); removeChart(id); };
  chips.appendChild(chip); chips.style.display = 'flex';
  setTimeout(() => chip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'end' }), 50);
  activateChart(id);
  return {
    setChart(labels, datasets, source, yOpts = {}) { const c = _charts.get(id); if (!c) return; Object.assign(c, { labels, datasets, source, yOpts }); if (_activeChartId === id) renderSheet(); },
    setError(msg) { const c = _charts.get(id); if (!c) return; c.error = msg; if (_activeChartId === id) renderSheet(); }
  };
}

function _openChartFloat(title) {
  _cwCounter++;
  const offset = (_cwCounter - 1) % 6;
  const win = document.createElement('div');
  win.className = 'cw-win';
  const wxPanel = document.getElementById('wxPanel');
  const pr = wxPanel.getBoundingClientRect();
  const cx = Math.min(pr.right + 10 + offset * 16, window.innerWidth - 310);
  const cy = Math.max(pr.top + offset * 26, 10);
  win.style.cssText = `top:${cy}px;left:${cx}px;z-index:${9200 + _cwCounter};`;
  win.innerHTML = `<div class="cw-handle"><span class="cw-title">${title}</span><button class="cw-close">✕</button></div>`
    + `<div class="cw-body"><div class="cw-loading">取得中...</div><canvas class="cw-canvas" height="110" style="display:none;"></canvas><div class="cw-source"></div></div>`;
  document.body.appendChild(win);
  win.addEventListener('pointerdown', () => { win.style.zIndex = 9200 + (++_cwCounter); });
  win.querySelector('.cw-close').addEventListener('click', e => { e.stopPropagation(); if (chart) chart.destroy(); win.remove(); });
  let chart = null, drag = null;
  const handle = win.querySelector('.cw-handle');
  handle.addEventListener('mousedown', e => {
    if (e.target === win.querySelector('.cw-close')) return;
    const r = win.getBoundingClientRect(); drag = { ox: e.clientX - r.left, oy: e.clientY - r.top }; handle.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    let x = e.clientX - drag.ox, y = e.clientY - drag.oy;
    x = Math.max(0, Math.min(window.innerWidth - win.offsetWidth, x));
    y = Math.max(0, Math.min(window.innerHeight - win.offsetHeight, y));
    win.style.left = x + 'px'; win.style.top = y + 'px';
  });
  document.addEventListener('mouseup', () => { drag = null; handle.style.cursor = ''; });
  const canvas = win.querySelector('.cw-canvas'), loading = win.querySelector('.cw-loading'), src = win.querySelector('.cw-source');
  return {
    setChart(labels, datasets, source, yOpts = {}) {
      loading.style.display = 'none'; canvas.style.display = 'block'; src.textContent = source ? `出典: ${source}` : '';
      if (chart) chart.destroy();
      const type = datasets[0].type || 'bar';
      const yo = yOpts || {}; const yAxis = { beginAtZero: yo.beginAtZero !== false, ticks: { font: { size: 10 }, maxTicksLimit: 5 }, grid: { color: 'rgba(0,0,0,0.06)' } };
      if (yo.min !== undefined) yAxis.min = yo.min; if (yo.max !== undefined) yAxis.max = yo.max;
      chart = new Chart(canvas, { type, data: { labels, datasets }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: datasets.length > 1, labels: { font: { size: 10 } } } }, scales: { x: { ticks: { font: { size: 9 }, maxTicksLimit: 12 }, grid: { display: false } }, y: yAxis } } });
    },
    setError(msg) { loading.textContent = `❌ ${msg}`; loading.style.display = 'block'; canvas.style.display = 'none'; }
  };
}

function activateChart(id) {
  _activeChartId = id;
  document.querySelectorAll('.chart-chip').forEach(c => c.classList.remove('active'));
  const chip = document.getElementById(`chip-${id}`); if (chip) chip.classList.add('active');
  document.getElementById('chartSheet').classList.add('open');
  renderSheet();
}

function renderSheet() {
  const c = _charts.get(_activeChartId); if (!c) return;
  document.getElementById('chartSheetTitle').textContent = c.title;
  const loading = document.getElementById('chartSheetLoading'), canvas = document.getElementById('chartSheetCanvas'), src = document.getElementById('chartSheetSrc');
  if (c.error) { loading.textContent = `❌ ${c.error}`; loading.style.display = 'block'; canvas.style.display = 'none'; }
  else if (!c.labels) { loading.textContent = '取得中...'; loading.style.display = 'block'; canvas.style.display = 'none'; }
  else {
    loading.style.display = 'none'; canvas.style.display = 'block';
    src.textContent = c.source ? `出典: ${c.source}` : '';
    if (_sheetChart) { _sheetChart.destroy(); _sheetChart = null; }
    const type = c.datasets[0].type || 'bar';
    const yo = c.yOpts || {}; const yAxis = { beginAtZero: yo.beginAtZero !== false, ticks: { font: { size: 10 }, maxTicksLimit: 5 }, grid: { color: 'rgba(0,0,0,0.06)' } };
    if (yo.min !== undefined) yAxis.min = yo.min; if (yo.max !== undefined) yAxis.max = yo.max;
    _sheetChart = new Chart(canvas, { type, data: { labels: c.labels, datasets: c.datasets }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: c.datasets.length > 1, labels: { font: { size: 10 } } } }, scales: { x: { ticks: { font: { size: 9 }, maxTicksLimit: 12 }, grid: { display: false } }, y: yAxis } } });
  }
}

function removeChart(id) {
  if (_sheetChart && _activeChartId === id) { _sheetChart.destroy(); _sheetChart = null; }
  _charts.delete(id);
  const chip = document.getElementById(`chip-${id}`); if (chip) chip.remove();
  if (_activeChartId === id) {
    const r = [..._charts.keys()];
    if (r.length > 0) activateChart(r[r.length - 1]);
    else { document.getElementById('chartSheet').classList.remove('open'); _activeChartId = null; }
  }
  if (_charts.size === 0) { const ch = document.getElementById('chartChips'); ch.style.display = 'none'; }
}

/* ─── パネル開閉 ─────────────────────────────── */
function openWxPanel() {
  wxOpen = true;
  document.getElementById('wxPanel').style.display = 'flex';
  const chk = document.getElementById('chkWeather');
  if (chk) chk.checked = true;
  const center = map.getCenter();
  fetchWeather(center.lat, center.lng);
  clearInterval(weatherTimer);
  weatherTimer = setInterval(() => {
    const c = map.getCenter();
    fetchWeather(c.lat, c.lng);
  }, 10 * 60 * 1000);
}

function closeWxPanel() {
  wxOpen = false;
  document.getElementById('wxPanel').style.display = 'none';
  const chk = document.getElementById('chkWeather');
  if (chk) chk.checked = false;
  clearInterval(weatherTimer); weatherTimer = null;
}

/* ─── 雨雲アニメーション ─────────────────────── */
function _parseJmaTime(t) {
  if (!t || t.length < 12) return 0;
  return Date.UTC(+t.slice(0,4),+t.slice(4,6)-1,+t.slice(6,8),+t.slice(8,10),+t.slice(10,12));
}
function _fmtJmaTime(ms) {
  const d = new Date(ms), p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`;
}

async function _startRainAnim() {
  const status = document.getElementById('rainAnimStatus');
  const lbl = document.getElementById('lblLRainAnim');
  if (status) { status.textContent = '🌀 取得中...'; status.style.display = 'block'; }
  try {
    const res = await fetch('https://www.jma.go.jp/bosai/jmatile/data/rasrf/targetTimes.json',{cache:'no-store'});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) throw new Error('フレームなし');
    const JST_OFFSET = 9 * 60 * 60 * 1000;
    const nowMs = Date.now() + JST_OFFSET;
    const minus3h = nowMs - 3 * 60 * 60 * 1000;
    const plus6h  = nowMs + 6 * 60 * 60 * 1000;
    const byVt = {};
    for (const e of arr) {
      const vtMs = _parseJmaTime(e.validtime);
      if (vtMs >= minus3h && vtMs <= plus6h) {
        if (!byVt[e.validtime] || e.basetime > byVt[e.validtime].basetime) {
          byVt[e.validtime] = e;
        }
      }
    }
    const frames = Object.values(byVt)
      .sort((a, b) => _parseJmaTime(a.validtime) - _parseJmaTime(b.validtime))
      .map(e => ({bt: e.basetime, vt: e.validtime}));
    if (!frames.length) throw new Error('フレームなし');
    _rainAnim.frames = frames;
    _rainAnim.nowMs = nowMs;
    _rainAnim.idx = 0;
    clearInterval(_rainAnim.frameTimer);
    _rainAnim.frameTimer = setInterval(_stepRainAnim, 1200);
    _stepRainAnim();
    if (lbl) lbl.style.borderColor = '';
  } catch(e) {
    console.error('[RainAnim]', e);
    if (status) status.textContent = '❌ 雨雲取得失敗';
    if (lbl) lbl.style.borderColor = '#ff3b30';
  }
}
function _stepRainAnim() {
  if (!_rainAnim.on || !_rainAnim.frames.length) return;
  const {bt, vt} = _rainAnim.frames[_rainAnim.idx];
  const url = `https://www.jma.go.jp/bosai/jmatile/data/rasrf/${bt}/none/${vt}/surf/rasrf/{z}/{x}/{y}.png`;
  const newLayer = L.tileLayer(url, {opacity:0.65, maxNativeZoom:10, maxZoom:22, attribution:'© 気象庁'});
  newLayer.addTo(map);
  if (_rainAnim.layer) map.removeLayer(_rainAnim.layer);
  _rainAnim.layer = newLayer;
  const status = document.getElementById('rainAnimStatus');
  if (status) {
    const vtMs = _parseJmaTime(vt);
    const nowMs = _rainAnim.nowMs || Date.now();
    const diffMin = Math.round((vtMs - nowMs) / 60000);
    const hhmm = `${vt.slice(8,10)}:${vt.slice(10,12)}`;
    if (diffMin <= 0) {
      status.textContent = `🌀 ${hhmm} (${Math.abs(diffMin)}分前)`;
      status.style.color = '#aaa';
    } else {
      status.textContent = `🌀 ${hhmm} (+${diffMin}分 予測)`;
      status.style.color = '#7ec8e3';
    }
  }
  _rainAnim.idx = (_rainAnim.idx + 1) % _rainAnim.frames.length;
}
function _stopRainAnim() {
  clearInterval(_rainAnim.frameTimer); _rainAnim.frameTimer = null;
  clearInterval(_rainAnim.refreshTimer); _rainAnim.refreshTimer = null;
  if (_rainAnim.layer) { map.removeLayer(_rainAnim.layer); _rainAnim.layer = null; }
  _rainAnim.frames = []; _rainAnim.idx = 0;
  const status = document.getElementById('rainAnimStatus');
  if (status) status.style.display = 'none';
}

/* ─── 危険度メッシュ（長野県 河川砂防情報ステーション） ── */
async function _loadKikendoMesh() {
  _kikendoOverlays.forEach(ov => map.removeLayer(ov)); _kikendoOverlays = [];
  const lbl = document.getElementById('lblLKikendo');
  const statusDiv = document.getElementById('wxKikendo');
  if (statusDiv) { statusDiv.style.display = 'block'; statusDiv.style.color = '#aaa'; statusDiv.textContent = '⚠ 危険度取得中...'; }
  try {
    const idx = await fetch(`${SABO_GIS}/gisdata/mesh/KikendoMesh.json`,{cache:'no-store'}).then(r=>r.json());
    const latest = idx.latest;
    const parts = latest.split('-');
    const ymd = parts[0]+parts[1]+parts[2];
    const hhmm = parts[3]+parts[4];
    const tilesRes = await fetch(`${SABO_GIS}/gisdata/mesh/kikendo/${ymd}/${hhmm}/mesh_tiles.json`,{cache:'no-store'});
    if (!tilesRes.ok) {
      if (statusDiv) statusDiv.textContent = '⚠ 危険域なし（平常）';
      if (lbl) lbl.style.borderColor = '';
      return;
    }
    const tilesJson = await tilesRes.json();
    const baseUrl = `${SABO_GIS}/gisdata/mesh/kikendo/${ymd}/${hhmm}/`;
    for (const tile of (tilesJson.tiles || [])) {
      const {north, south, east, west} = tile.latLon;
      const ov = L.imageOverlay(baseUrl+tile.file, [[south,west],[north,east]], {opacity:0.7, interactive:false});
      ov.addTo(map);
      _kikendoOverlays.push(ov);
    }
    if (statusDiv) statusDiv.textContent = `⚠ 危険度メッシュ ${parts[3]}:${parts[4]} 更新 (${_kikendoOverlays.length}タイル)`;
    if (lbl) lbl.style.borderColor = '';
  } catch(e) {
    console.error('[Kikendo]', e);
    if (statusDiv) { statusDiv.style.color = '#ff6b6b'; statusDiv.textContent = '❌ 危険度取得失敗'; }
    if (lbl) lbl.style.borderColor = '#ff3b30';
  }
}

/* ─── 水位観測（長野県 河川砂防情報ステーション） ─────── */
function _stageColor(level) { return STAGE_COL[String(level)] || '#888'; }
function _stageLabel(level) { return (['平水','待機','注意','避難','危険'][level] || ''); }

async function rpFetch(url, opts) {
  const proxies = [
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  ];
  for (const px of proxies) {
    try {
      const r = await fetch(px(url), opts || {});
      if (r.status !== 429 && r.status !== 403) return r;
    } catch {}
  }
  throw new Error('プロキシ接続失敗');
}

async function fetchRiverData() {
  riverMarkers.forEach(mk => map.removeLayer(mk)); riverMarkers = [];
  const div = document.getElementById('wxRiver');
  const lbl = document.getElementById('lblLRiverLevel');
  if (div) { div.style.color = '#aaa'; div.textContent = '💧 水位データ取得中...'; div.style.display = 'block'; }
  try {
    const r = await fetch(`${SABO_GIS}/gisdata/river/SuiiPoint.geo.json`,{cache:'no-store'});
    if (!r.ok) throw new Error(`GeoJSON HTTP ${r.status}`);
    const gj = await r.json();
    const b = map.getBounds();
    let count = 0;
    for (const feat of (gj.features || [])) {
      const c = feat.geometry?.coordinates;
      if (!c) continue;
      const lng = c[0], lat = c[1];
      if (!b.contains([lat, lng])) continue;
      const props = feat.properties || {};
      const key = props.id; if (!key) continue;
      const sd = props.data;
      const level = sd?.item_10?.level ?? -1;
      const value = sd?.item_10?.value;
      const obsTime = sd?.time;
      const col = _stageColor(level);
      const levelStr = value != null ? `${Number(value).toFixed(2)}m` : '--';
      const name = props.nm || key;
      const river = props.rv || '';
      const timeStr = obsTime ? `${obsTime.slice(11,13)}:${obsTime.slice(14,16)}` : '';
      const mk = L.marker([lat, lng], {icon: L.divIcon({
        html: `<div style="background:#fff;color:${col};border:2px solid ${col};border-radius:6px;padding:2px 6px;font-size:11px;font-family:sans-serif;font-weight:bold;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.25)">${levelStr}</div>`,
        className:'', iconAnchor:[20,12]
      })}).addTo(map);
      const pDiv = document.createElement('div');
      pDiv.style.cssText = 'font-size:12px;font-family:sans-serif;min-width:190px';
      const riverHtml = river ? `<span style="font-size:10px;color:#888"> (${river})</span>` : '';
      const timeHtml = timeStr ? `<span style="font-size:9px;color:#aaa"> (${timeStr}観測)</span>` : '';
      const lvLabel = level >= 0 ? `<span style="color:${col}"> ${_stageLabel(level)}</span>` : '';
      const encKey = encodeURIComponent(key), encName = encodeURIComponent(name);
      pDiv.innerHTML = `<b>💧 ${name}</b>${riverHtml}${timeHtml}<br><div style="font-size:14px;font-weight:bold;color:${col};margin:3px 0">水位: ${levelStr}${lvLabel}</div><div style="display:flex;gap:4px;margin-top:5px"><button data-key="${encKey}" data-nm="${encName}" data-h="6" class="rv-btn">📈 6時間</button><button data-key="${encKey}" data-nm="${encName}" data-h="24" class="rv-btn">📈 24時間</button></div><div style="font-size:9px;color:#aaa;margin-top:3px">出典: 長野県 河川砂防情報ステーション</div>`;
      pDiv.querySelectorAll('.rv-btn').forEach(btn => {
        btn.style.cssText = 'flex:1;padding:3px 5px;font-size:11px;border:1px solid #0066ff;background:#fff;border-radius:4px;cursor:pointer;color:#0066ff';
        btn.onclick = () => showRiverChart(decodeURIComponent(btn.dataset.key), Number(btn.dataset.h), decodeURIComponent(btn.dataset.nm));
      });
      mk.bindPopup(pDiv);
      riverMarkers.push(mk); count++;
    }
    const now = new Date(), pn = v => String(v).padStart(2,'0');
    if (div) {
      div.style.color = count ? '#aaa' : '#888';
      div.textContent = count
        ? `💧 水位観測 ${count}地点 (${pn(now.getHours())}:${pn(now.getMinutes())} 更新)`
        : '⚠ 表示エリアに水位観測所なし';
    }
    if (lbl) lbl.style.borderColor = '';
  } catch(e) {
    console.error('[River]', e);
    if (div) { div.style.color = '#ff6b6b'; div.innerHTML = `❌ 水位取得失敗: ${e.message}`; }
    if (document.getElementById('lblLRiverLevel')) document.getElementById('lblLRiverLevel').style.borderColor = '#ff3b30';
  }
}

async function showRiverChart(stationKey, hours, stationName) {
  const w = openChartWindow(`${stationName} 水位(過去${hours}h)`);
  try {
    const pad = n => String(n).padStart(2,'0');
    const nowMs = Date.now() + 9 * 3600000;
    const cutMs = nowMs - hours * 3600000;
    const blocks = new Set();
    for (let h = 0; h <= hours + 4; h += 4) {
      const t = new Date(nowMs - h * 3600000);
      const d = `${t.getUTCFullYear()}${pad(t.getUTCMonth()+1)}${pad(t.getUTCDate())}`;
      const n = Math.floor(t.getUTCHours() / 4) + 1;
      blocks.add(`${d}/${d}_${n}_stage_10.json`);
    }
    const responses = await Promise.allSettled([...blocks].map(bp =>
      rpFetch(`${SABO_BASE}/dyn/json/dat/pc/${bp}`, {cache:'no-store'})
    ));
    const pts = [];
    for (const res of responses) {
      if (res.status !== 'fulfilled') continue;
      const r = res.value; if (!r.ok) continue;
      const json = await r.json();
      const stn = json[stationKey]; if (!stn?.data10) continue;
      for (const pt of stn.data10) {
        const t = pt.time; if (!t || t.length < 16) continue;
        const ms = Date.UTC(+t.slice(0,4),+t.slice(5,7)-1,+t.slice(8,10),+t.slice(11,13),+t.slice(14,16));
        if (ms < cutMs) continue;
        pts.push({ms, label:`${t.slice(11,13)}:${t.slice(14,16)}`, value:pt.item_10?.value});
      }
    }
    pts.sort((a,b) => a.ms - b.ms);
    const seen = new Set(), uniq = [];
    for (const pt of pts) { if (!seen.has(pt.ms)) { seen.add(pt.ms); uniq.push(pt); } }
    if (!uniq.length) { w.setError('時系列データなし'); return; }
    w.setChart(
      uniq.map(pt => pt.label),
      [{label:'水位(m)', data:uniq.map(pt => pt.value!=null&&pt.value!==''?Number(pt.value):null),
        type:'line', backgroundColor:'rgba(0,102,255,0.12)', borderColor:'rgba(0,102,255,0.8)',
        borderWidth:2, fill:true, tension:0.3, pointRadius:2, spanGaps:true}],
      '長野県 河川砂防情報ステーション', {beginAtZero:false}
    );
  } catch(e) { w.setError(`取得失敗: ${e.message}`); }
}

/* ─── 初期化 ─────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const wxPanel = document.getElementById('wxPanel');

  /* 天気ボタンをツールボックスに追加（map2 の renderLayerControl() で既存のtbLayersに追記） */
  const tbDiv = document.getElementById('tbLayers');
  if (tbDiv && !document.getElementById('btnWeather')) {
    const wxBtn = document.createElement('button');
    wxBtn.className = 'tb-btn'; wxBtn.id = 'btnWeather';
    wxBtn.innerHTML = '<span class="ico">🌤</span><span>天気</span>';
    wxBtn.addEventListener('click', () => { if (wxOpen) closeWxPanel(); else openWxPanel(); });
    tbDiv.appendChild(wxBtn);
  }

  /* 気象レイヤをオーバーレイリストに注入（ツールボックス・農地検索・ベースマップは renderLayerControl() 済み） */
  function injectWeatherCheckbox() {
    const overlays = document.querySelector('.leaflet-control-layers-overlays');
    if (!overlays) { setTimeout(injectWeatherCheckbox, 150); return; }

    if (!document.getElementById('wxLayerLabel')) {
      /* セパレータ */
      const sep1 = document.createElement('div');
      sep1.className = 'leaflet-control-layers-separator';
      overlays.appendChild(sep1);
      /* 気象レイヤ 見出し */
      const wxLayerLabel = document.createElement('div');
      wxLayerLabel.id = 'wxLayerLabel';
      wxLayerLabel.className = 'lc-section-label';
      wxLayerLabel.textContent = '気象レイヤ';
      overlays.appendChild(wxLayerLabel);
      /* チェックボックス群 */
      const wxLayersDiv = document.createElement('div');
      wxLayersDiv.id = 'wxLayers';
      wxLayersDiv.innerHTML = `
        <label class="wx-chk-item" id="lblLRain"><input type="checkbox" id="chkLRain"><span class="ico">🌧</span><span>レーダー雨量</span></label>
        <label class="wx-chk-item" id="lblLRainAnim"><input type="checkbox" id="chkLRainAnim"><span class="ico">🌀</span><span>雨雲の動き</span></label>
        <label class="wx-chk-item" id="lblLKikendo"><input type="checkbox" id="chkLKikendo"><span class="ico">⚠</span><span>危険度</span></label>
        <label class="wx-chk-item" id="lblLRiverLevel"><input type="checkbox" id="chkLRiverLevel"><span class="ico">💧</span><span>水位観測</span></label>
        <label class="wx-chk-item" id="lblLAmedas"><input type="checkbox" id="chkLAmedas"><span class="ico">📡</span><span>アメダス</span></label>
      `;
      overlays.appendChild(wxLayersDiv);

      /* ステータス表示エリア */
      const mkStatus = (id, style) => {
        const d = document.createElement('div');
        d.id = id;
        d.style.cssText = `display:none;font-size:10px;color:#aaa;padding:3px 6px;${style||''}`;
        overlays.appendChild(d);
      };
      mkStatus('wxRiver');
      mkStatus('wxKikendo');
      const wxAmedasDiv = document.createElement('div'); wxAmedasDiv.id = 'wxAmedas'; overlays.appendChild(wxAmedasDiv);

      /* 雨雲タイムスタンプ：地図上部中央に表示 */
      if (!document.getElementById('rainAnimStatus')) {
        const bar = document.createElement('div');
        bar.id = 'rainAnimStatus';
        bar.style.cssText = 'display:none;position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1000;background:rgba(0,0,0,0.65);color:#fff;padding:5px 16px;border-radius:20px;font-size:13px;pointer-events:none;white-space:nowrap;';
        map.getContainer().appendChild(bar);
      }

      /* イベントリスナー */
      document.getElementById('chkLRain').addEventListener('change', function() {
        wxLayerState['rain'].on = this.checked;
        wxApplyLayerState('rain');
      });
      document.getElementById('chkLRainAnim').addEventListener('change', function() {
        _rainAnim.on = this.checked;
        document.getElementById('lblLRainAnim').classList.toggle('active', _rainAnim.on);
        if (_rainAnim.on) {
          _startRainAnim();
          if (!_rainAnim.refreshTimer) _rainAnim.refreshTimer = setInterval(_startRainAnim, 10 * 60 * 1000);
        } else {
          _stopRainAnim();
        }
      });
      document.getElementById('chkLKikendo').addEventListener('change', function() {
        _kikendoOn = this.checked;
        document.getElementById('lblLKikendo').classList.toggle('active', _kikendoOn);
        if (_kikendoOn) {
          _loadKikendoMesh();
          if (!_kikendoTimer) _kikendoTimer = setInterval(_loadKikendoMesh, 10 * 60 * 1000);
        } else {
          clearInterval(_kikendoTimer); _kikendoTimer = null;
          _kikendoOverlays.forEach(ov => map.removeLayer(ov)); _kikendoOverlays = [];
          const s = document.getElementById('wxKikendo'); if (s) s.style.display = 'none';
          document.getElementById('lblLKikendo').style.borderColor = '';
        }
      });
      document.getElementById('chkLRiverLevel').addEventListener('change', function() {
        riverOn = this.checked;
        document.getElementById('lblLRiverLevel').classList.toggle('active', riverOn);
        if (riverOn) {
          fetchRiverData();
          if (!riverTimer) riverTimer = setInterval(fetchRiverData, 10 * 60 * 1000);
        } else {
          clearInterval(riverTimer); riverTimer = null;
          riverMarkers.forEach(mk => map.removeLayer(mk)); riverMarkers = [];
          const s = document.getElementById('wxRiver'); if (s) s.style.display = 'none';
        }
      });
      map.on('moveend', () => { if (riverOn) fetchRiverData(); });
      document.getElementById('chkLAmedas').addEventListener('change', function() {
        amedasOn = this.checked;
        document.getElementById('lblLAmedas').classList.toggle('active', amedasOn);
        if (amedasOn) {
          fetchAmedasMarkers();
          amedasTimer = setInterval(fetchAmedasMarkers, 10 * 60 * 1000);
        } else {
          clearInterval(amedasTimer); amedasTimer = null;
          amedasMarkers.forEach(mk => map.removeLayer(mk)); amedasMarkers = [];
        }
      });
    }
  }
  injectWeatherCheckbox();

  document.getElementById('wxClose').onclick = closeWxPanel;
  document.getElementById('wxRefresh').onclick = () => {
    const center = map.getCenter();
    fetchWeather(center.lat, center.lng);
    clearInterval(weatherTimer);
    weatherTimer = setInterval(() => {
      const c = map.getCenter();
      fetchWeather(c.lat, c.lng);
    }, 10 * 60 * 1000);
  };
  document.getElementById('wxCollapseBtn').onclick = () => wxPanel.classList.toggle('collapsed');
  document.getElementById('chartSheetClose').onclick = () => {
    document.getElementById('chartSheet').classList.remove('open');
    _activeChartId = null;
  };

  /* パネルドラッグ */
  const handle = document.getElementById('wxHandle');
  let drag = null;
  function startDrag(cx, cy) { const r = wxPanel.getBoundingClientRect(); drag = { ox: cx - r.left, oy: cy - r.top }; }
  function moveDrag(cx, cy) {
    if (!drag) return;
    let x = cx - drag.ox, y = cy - drag.oy;
    x = Math.max(0, Math.min(window.innerWidth - wxPanel.offsetWidth, x));
    y = Math.max(0, Math.min(window.innerHeight - wxPanel.offsetHeight, y));
    wxPanel.style.left = x + 'px'; wxPanel.style.top = y + 'px';
  }
  function endDrag() { drag = null; }
  handle.addEventListener('touchstart', e => { if (e.target.closest('button')) return; startDrag(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  handle.addEventListener('touchmove', e => { if (!drag) return; e.preventDefault(); moveDrag(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  handle.addEventListener('touchend', endDrag, { passive: true });
  handle.addEventListener('mousedown', e => { if (e.target.closest('button')) return; startDrag(e.clientX, e.clientY); handle.style.cursor = 'grabbing'; });
  document.addEventListener('mousemove', e => { if (!drag) return; moveDrag(e.clientX, e.clientY); });
  document.addEventListener('mouseup', () => { if (drag) { drag = null; handle.style.cursor = ''; } });
});
