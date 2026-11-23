(() => {
  'use strict';
  const STORAGE_KEY = 'manholeMap.collected.v1';
  const ADMIN_KEY = 'manholeMap.admin';
  const GH_KEY = 'manholeMap.gh.v1';
  const CSV_PATH = 'data/cards.csv';
  // OpenStreetMapデータのベクタ地図（OpenFreeMap、APIキー不要）。bright以外に liberty / positron も指定できる
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';
  const KIND = { dist: 'カード配布場所', lid: 'マンホール蓋の設置場所' };
  const FIELD = { dist: 'distribution', lid: 'lid' };
  const STATUS = { verified: '確認済み', unverified: '未確認', sample: '架空（サンプル）' };
  const $ = (s) => document.querySelector(s);
  const state = { mode: 'dist', cards: [], csv: null, collected: new Set(), pins: { dist: [], lid: [] }, selected: null,
    me: null, watching: false, photos: {}, blobs: {}, admin: false, editId: null };
  let map, toastTimer, tileErrorShown = false;

  function toast(msg, sticky) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  /* ---------- 取得済み (LocalStorage) ---------- */
  function loadCollected() {
    try {
      const a = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(a)) state.collected = new Set(a.map(String));
    } catch (e) {
      toast('取得済みの情報を読み込めませんでした。この端末では保存できない可能性があります。');
    }
  }
  function saveCollected() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.collected]));
    } catch (e) {
      toast('取得済みの保存に失敗しました。プライベートブラウズなどの設定を確認してください。');
    }
  }

  const validPlace = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  const safeUrl = (u) => /^https?:\/\//i.test(u || '') ? u : '';
  const safeName = (id) => String(id).replace(/[\\/:*?"<>|]/g, '_');
  const today = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };

  /* ---------- CSV ---------- */
  const COLS = { id: 'カードID', name: 'カード名称', pref: '都道府県', city: '市区町村', series: '弾数', img: 'カード画像URL',
    dName: '配布場所名称', dAddr: '配布場所住所', dLat: '配布場所緯度', dLng: '配布場所経度',
    lName: '蓋設置場所名称', lAddr: '蓋設置場所住所', lLat: '蓋緯度', lLng: '蓋経度',
    src: '出典URL', checked: '情報確認日', dSt: '配布座標確認', lSt: '蓋座標確認', sample: '架空サンプル' };
  const ST_MAP = { '確認済み': 'verified', '未確認': 'unverified', '架空': 'sample' };

  function parseCsv(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
      else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  function decodeBytes(u8) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^\uFEFF/, ''); }
    catch (e) { return new TextDecoder('shift_jis').decode(u8); } // Excelの通常CSV(Shift_JIS)対策
  }
  function parseToCsv(text) {
    const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()));
    if (!rows.length) throw new Error('CSVが空です');
    return { head: rows[0].map((h) => h.trim()), rows: rows.slice(1) };
  }
  const colIdx = (head) => { const o = {}; Object.keys(COLS).forEach((k) => { o[k] = head.indexOf(COLS[k]); }); return o; };
  const newCsv = () => ({ head: Object.keys(COLS).map((k) => COLS[k]), rows: [] });
  function ensureColumns(csv) {
    Object.keys(COLS).forEach((k) => {
      if (csv.head.indexOf(COLS[k]) < 0) { csv.head.push(COLS[k]); csv.rows.forEach((r) => { while (r.length < csv.head.length) r.push(''); }); }
    });
  }
  const esc = (v) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const toCsv = (csv) => '\uFEFF' + [csv.head].concat(csv.rows)
    .map((r) => csv.head.map((_, i) => esc(String(r[i] === undefined ? '' : r[i]))).join(',')).join('\r\n') + '\r\n';

  function buildCards(csv) {
    const idx = colIdx(csv.head);
    const missing = ['id', 'name', 'dLat', 'dLng'].filter((k) => idx[k] < 0).map((k) => COLS[k]);
    if (missing.length) throw new Error('必須の列がありません: ' + missing.join('、'));
    const cards = [], bad = [], seen = new Set();
    csv.rows.forEach((r, n) => {
      const g = (k) => (idx[k] < 0 ? '' : String(r[idx[k]] || '').trim());
      const id = g('id');
      const dist = { name: g('dName'), address: g('dAddr'), lat: parseFloat(g('dLat')), lng: parseFloat(g('dLng')) };
      if (!id || seen.has(id) || !validPlace(dist)) { bad.push(n + 2); return; }
      seen.add(id);
      const lid = { name: g('lName'), address: g('lAddr'), lat: parseFloat(g('lLat')), lng: parseFloat(g('lLng')) };
      cards.push({
        id, name: g('name') || id, prefecture: g('pref'), city: g('city'), series: g('series'), imageUrl: g('img'),
        distribution: dist, lid: validPlace(lid) ? lid : null, sourceUrl: g('src'), checkedAt: g('checked'),
        coordinateStatus: { distribution: ST_MAP[g('dSt')] || 'unverified', lid: ST_MAP[g('lSt')] || 'unverified' },
        sample: !!g('sample')
      });
    });
    return { cards, bad };
  }

  /* ---------- GitHub（作成者モードのみ） ---------- */
  const getGh = () => {
    try { const g = JSON.parse(localStorage.getItem(GH_KEY) || 'null'); return g && g.owner && g.repo && g.token ? g : null; }
    catch (e) { return null; }
  };
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  const blobToB64 = (b) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
  const ghUrl = (g, path) => 'https://api.github.com/repos/' + encodeURIComponent(g.owner) + '/' + encodeURIComponent(g.repo) +
    '/contents/' + path.split('/').map(encodeURIComponent).join('/');
  const ghHeaders = (g) => ({ Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + g.token });
  function ghErr(res) {
    return res.status === 401 ? 'トークンが無効か期限切れです'
      : res.status === 403 ? '権限不足、またはアクセス制限です'
      : res.status === 404 ? 'リポジトリが見つかりません（名前・トークンの対象リポジトリ・権限を確認）'
      : res.status === 409 || res.status === 422 ? '更新が競合しました。もう一度お試しください'
      : 'GitHub エラー ' + res.status;
  }
  async function ghGet(g, path) {
    const res = await fetch(ghUrl(g, path) + '?ref=' + encodeURIComponent(g.branch || 'main'), { headers: ghHeaders(g), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(ghErr(res));
    return res.json();
  }
  async function ghPut(g, path, b64, sha, message) {
    const body = { message, content: b64, branch: g.branch || 'main' };
    if (sha) body.sha = sha;
    const res = await fetch(ghUrl(g, path), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(g)), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(ghErr(res));
    return res.json();
  }
  async function ghGetCsv(g) {
    const f = await ghGet(g, CSV_PATH);
    if (!f) return { csv: newCsv(), sha: null };
    if (!f.content) throw new Error('CSVが大きすぎてAPIで取得できません');
    return { csv: parseToCsv(decodeBytes(b64ToBytes(f.content))), sha: f.sha };
  }
  async function loadCsv() {
    const gh = state.admin ? getGh() : null;
    if (gh) {
      try { const r = await ghGetCsv(gh); if (r.sha) return r.csv; }
      catch (e) { toast('GitHubから最新データを取得できませんでした（' + e.message + '）。公開中のデータを表示します。'); }
    }
    const res = await fetch(CSV_PATH, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return parseToCsv(decodeBytes(new Uint8Array(await res.arrayBuffer())));
  }

  /* ---------- 写真 ---------- */
  let dbp;
  const idb = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('manholeMap', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  async function photoAll() {
    const db = await idb();
    return new Promise((res, rej) => {
      const out = {};
      const rq = db.transaction('photos').objectStore('photos').openCursor();
      rq.onsuccess = () => { const c = rq.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
      rq.onerror = () => rej(rq.error);
    });
  }
  async function photoPut(id, blob) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.objectStore('photos').put(blob, id);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }
  function shrink(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => {
        const k = Math.min(1, 720 / Math.max(im.naturalWidth, im.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? res(b) : rej(new Error('画像の変換に失敗'))), 'image/jpeg', 0.82);
      };
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('画像を読み込めません')); };
      im.src = url;
    });
  }
  // 画像の優先順位: この画面で撮った写真 → images/cards/<ID>.jpg → CSVのカード画像URL
  function loadImg(img, card, done) {
    const list = [state.photos[String(card.id)], 'images/cards/' + encodeURIComponent(safeName(card.id)) + '.jpg', card.imageUrl].filter(Boolean);
    let i = 0;
    img.style.display = '';
    img.onload = () => { if (done) done(false); };
    img.onerror = () => { i++; if (i < list.length) img.src = list[i]; else { img.style.display = 'none'; if (done) done(true); } };
    img.src = list[0];
  }
  function setPhoto(id, blob, track) {
    id = String(id);
    if (state.photos[id]) URL.revokeObjectURL(state.photos[id]);
    state.photos[id] = URL.createObjectURL(blob);
    if (track) {
      state.blobs[id] = blob;
      $('#backup').hidden = false;
      $('#backup-n').textContent = Object.keys(state.blobs).length;
    }
    state.pins.dist.forEach((p) => { if (String(p.id) === id) loadImg(p.img, p.card, (f) => p.el.classList.toggle('noimg', f)); });
    if (state.selected && String(state.selected.id) === id) openSheet(state.selected.id, state.selected.kind, false);
  }

  /* ---- 端末内の写真をZIPでダウンロード（GitHub未設定時の予備） ---- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    files.forEach((f) => {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + size;
    });
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }
  async function downloadPhotos() {
    const ids = Object.keys(state.blobs);
    if (!ids.length) return toast('端末に保存した写真がありません。');
    try {
      const files = [];
      for (const id of ids) files.push({ name: 'images/cards/' + safeName(id) + '.jpg', data: new Uint8Array(await state.blobs[id].arrayBuffer()) });
      const url = URL.createObjectURL(makeZip(files));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'manhole-photos-' + today().replace(/-/g, '') + '.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(ids.length + '枚の写真をZIPにしました。展開した images フォルダをリポジトリの images フォルダに追加してください。');
    } catch (e) {
      toast('ダウンロード用ZIPの作成に失敗しました。');
    }
  }

  /* ---------- ピン ---------- */
  function addPin(kind, card) {
    const place = card[FIELD[kind]];
    if (!validPlace(place)) return;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pin pin-' + kind;
    el.setAttribute('aria-label', card.name + '（' + KIND[kind] + '）');
    let img = null;
    if (kind === 'dist') {
      img = new Image();
      img.alt = '';
      loadImg(img, card, (f) => el.classList.toggle('noimg', f));
      el.appendChild(img);
    }
    el.addEventListener('click', (e) => { e.stopPropagation(); openSheet(card.id, kind, true); });
    const marker = new maplibregl.Marker({ element: el, anchor: kind === 'dist' ? 'bottom' : 'center' })
      .setLngLat([place.lng, place.lat]);
    state.pins[kind].push({ id: card.id, card, el, img, marker, lat: place.lat });
  }

  function refreshPins() {
    ['dist', 'lid'].forEach((k) => state.pins[k].forEach((p) => {
      p.el.classList.toggle('done', state.collected.has(String(p.id)));
      const sel = !!state.selected && state.selected.id === p.id && state.selected.kind === k;
      p.el.classList.toggle('sel', sel);
      // 重なったとき: 南のピンが手前、取得済みは奥、選択中は最前面
      p.el.style.zIndex = String((sel ? 400000 : state.collected.has(String(p.id)) ? 0 : 200000) + Math.round((90 - p.lat) * 1000));
    }));
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('#mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    const other = mode === 'dist' ? 'lid' : 'dist';
    state.pins[other].forEach((p) => p.marker.remove());
    state.pins[mode].forEach((p) => p.marker.addTo(map));
  }

  function renderPins() {
    ['dist', 'lid'].forEach((k) => state.pins[k].forEach((p) => p.marker.remove()));
    state.pins = { dist: [], lid: [] };
    state.cards.forEach((c) => { addPin('dist', c); addPin('lid', c); });
    setMode(state.mode);
    refreshPins();
  }

  /* ---------- 詳細パネル ---------- */
  const narrow = () => window.matchMedia('(max-width:759px)').matches;
  const setSheetHeight = () => {
    document.documentElement.style.setProperty('--sheet-h', narrow() && !$('#sheet').hidden ? $('#sheet').offsetHeight + 'px' : '0px');
  };

  function openSheet(id, kind, fly) {
    const card = state.cards.find((c) => c.id === id);
    const place = card && card[FIELD[kind]];
    if (!validPlace(place)) return;
    state.selected = { id, kind };
    if (state.mode !== kind) setMode(kind);

    loadImg($('#d-img'), card);
    $('#d-kind').textContent = KIND[kind];
    $('#d-kind').className = 'kind ' + kind;
    $('#d-name').textContent = card.name || '';
    $('#d-meta').textContent = [card.prefecture, card.city, card.series ? '第' + card.series + '弾' : ''].filter(Boolean).join(' ／ ');
    $('#d-place').textContent = place.name || place.address || '';
    $('#d-addr').textContent = place.name ? (place.address || '住所は未登録です') : '';
    $('#d-check').checked = state.collected.has(String(id));
    const dest = place.lat + ',' + place.lng;
    $('#d-gmaps').href = 'https://www.google.com/maps/dir/?api=1&destination=' + dest;
    $('#d-amaps').href = 'https://maps.apple.com/?daddr=' + dest;
    const other = kind === 'dist' ? 'lid' : 'dist';
    const swap = $('#d-swap');
    swap.hidden = !validPlace(card[FIELD[other]]);
    swap.textContent = other === 'lid' ? '蓋の場所を見る' : '配布場所を見る';
    $('#sample-note').hidden = !card.sample;
    const hasPhoto = !!state.photos[String(id)];
    $('#photo-label').textContent = hasPhoto ? '写真を撮り直す' : '写真を撮影';
    $('#d-export').hidden = !hasPhoto;

    const src = $('#d-src');
    src.textContent = '出典：';
    const url = safeUrl(card.sourceUrl);
    if (url) {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = url;
      src.appendChild(a);
    } else { src.append('未登録'); }
    const st = card.coordinateStatus && card.coordinateStatus[FIELD[kind]];
    $('#d-status').textContent = '情報確認日：' + (card.checkedAt || '未確認') + ' ／ 座標：' + (STATUS[st] || '未確認');

    $('#sheet').hidden = false;
    setSheetHeight();
    refreshPins();
    if (fly) {
      map.easeTo({
        center: [place.lng, place.lat],
        zoom: Math.max(map.getZoom(), 14),
        offset: narrow() ? [0, -Math.round(window.innerHeight * 0.2)] : [190, 0],
        duration: 500
      });
    }
  }

  function closeSheet() {
    state.selected = null;
    $('#sheet').hidden = true;
    setSheetHeight();
    refreshPins();
  }

  /* ---------- 現在地 ---------- */
  function showMe(pos) {
    const ll = [pos.coords.longitude, pos.coords.latitude];
    if (!state.me) {
      const el = document.createElement('div');
      el.className = 'me';
      state.me = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map);
    } else { state.me.setLngLat(ll); }
    return ll;
  }

  function locate() {
    if (!('geolocation' in navigator)) return toast('この端末・ブラウザでは現在地を取得できません。地図は通常どおり使えます。');
    if (!window.isSecureContext) return toast('現在地の取得にはHTTPS接続が必要です。');
    const btn = $('#locate');
    btn.classList.add('busy');
    navigator.geolocation.getCurrentPosition((pos) => {
      btn.classList.remove('busy');
      map.flyTo({ center: showMe(pos), zoom: Math.max(map.getZoom(), 14) });
      if (!state.watching) {
        state.watching = true;
        navigator.geolocation.watchPosition(showMe, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
      }
    }, (err) => {
      btn.classList.remove('busy');
      const msg = err.code === 1 ? '位置情報の利用が許可されていません。ブラウザの設定で許可してください。'
        : err.code === 3 ? '現在地の取得がタイムアウトしました。電波の良い場所でもう一度お試しください。'
        : '現在地を取得できませんでした。';
      toast(msg + '地図は通常どおり使えます。');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  }

  /* ---------- 作成者モード: カードの追加・編集 ---------- */
  const FORM = [
    { k: 'id', label: 'カードID *（半角英数字・ハイフン。後から変更不可）' },
    { k: 'name', label: 'カード名称 *' },
    { k: 'dAddr', label: '配布場所・住所 *（一括入力。入力すると座標を自動で取得します）', geo: 1 },
    { k: 'src', label: 'リンク（出典URL）' }
  ];
  const fEl = (k) => $('#ed-body [name="' + k + '"]');
  const fVal = (k) => fEl(k).value.trim();
  const fSet = (k, v) => { fEl(k).value = v; };

  // 国土地理院の住所検索API（キー不要）
  async function geocode(q) {
    const res = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!Array.isArray(j) || !j.length || !j[0].geometry) return null;
    return { lng: j[0].geometry.coordinates[0], lat: j[0].geometry.coordinates[1], title: j[0].properties && j[0].properties.title };
  }
  async function geocodeInto(addr) {
    const st = $('#ed-geo');
    st.textContent = '住所から座標を検索中…';
    try {
      const r = await geocode(addr);
      if (!r) { st.textContent = '住所が見つかりませんでした。都道府県から詳しく入力してください。'; return false; }
      fSet('dLat', r.lat.toFixed(6));
      fSet('dLng', r.lng.toFixed(6));
      state.geoFor = addr;
      st.textContent = '座標: ' + r.lat.toFixed(6) + ', ' + r.lng.toFixed(6) + (r.title ? '（' + r.title + ' 付近）' : '') + '。違う場所なら住所を詳しくしてください。';
      return true;
    } catch (e) {
      st.textContent = '座標を取得できませんでした（' + e.message + '）。';
      return false;
    }
  }
  function mkField(f, value, readonly) {
    const lab = document.createElement('label');
    lab.className = 'f';
    const sp = document.createElement('span');
    sp.textContent = f.label;
    lab.appendChild(sp);
    const inp = document.createElement('input');
    inp.type = 'text'; inp.autocomplete = 'off'; inp.name = f.k; inp.value = value || '';
    if (readonly) inp.readOnly = true;
    if (f.num) inp.inputMode = 'decimal';
    lab.appendChild(inp);
    return lab;
  }
  function buildForm(init) {
    const body = $('#ed-body');
    body.textContent = '';
    FORM.forEach((f) => {
      body.appendChild(mkField(f, init[f.k], f.k === 'id' && state.editId != null));
      if (!f.geo) return;
      const p = document.createElement('p');
      p.id = 'ed-geo'; p.className = 'small';
      p.textContent = validPlace({ lat: parseFloat(init.dLat), lng: parseFloat(init.dLng) }) ? '座標: ' + init.dLat + ', ' + init.dLng : '';
      body.appendChild(p);
      const d = document.createElement('details');
      d.id = 'ed-manual';
      const sm = document.createElement('summary');
      sm.textContent = '座標を手動で直す';
      d.appendChild(sm);
      d.appendChild(mkField({ k: 'dLat', label: '緯度', num: 1 }, init.dLat));
      d.appendChild(mkField({ k: 'dLng', label: '経度', num: 1 }, init.dLng));
      body.appendChild(d);
      fEl('dAddr').addEventListener('change', () => { const a = fVal('dAddr'); if (a) geocodeInto(a); });
      ['dLat', 'dLng'].forEach((k) => fEl(k).addEventListener('input', () => { state.geoFor = fVal('dAddr'); }));
    });
  }
  function openEditor(id) {
    if (!state.admin) return;
    const csv = state.csv || newCsv();
    const idx = colIdx(csv.head);
    state.editId = id == null ? null : String(id);
    let init = {};
    if (state.editId != null) {
      const row = csv.rows.find((r) => String(r[idx.id] || '').trim() === state.editId);
      Object.keys(COLS).forEach((k) => { init[k] = row && idx[k] >= 0 ? String(row[idx[k]] || '').trim() : ''; });
    } else {
      init = { id: 'card-' + Date.now().toString(36) };
    }
    state.geoFor = init.dAddr || '';
    state.initAddr = init.dAddr || '';
    $('#ed-title').textContent = state.editId != null ? 'カードを編集' : 'カードを追加';
    $('#ed-del').hidden = state.editId == null;
    $('#ed-err').textContent = '';
    buildForm(init);
    $('#editor').showModal();
  }
  function applyValues(csv, id, vals, remove) {
    ensureColumns(csv);
    const idx = colIdx(csv.head);
    let ri = csv.rows.findIndex((r) => String(r[idx.id] || '').trim() === id);
    if (remove) { if (ri >= 0) csv.rows.splice(ri, 1); return; }
    if (ri < 0) { csv.rows.push(csv.head.map(() => '')); ri = csv.rows.length - 1; }
    Object.keys(vals).forEach((k) => { csv.rows[ri][idx[k]] = vals[k]; });
  }
  async function saveCard(remove) {
    const err = $('#ed-err');
    err.textContent = '';
    const isNew = state.editId == null;
    const id = isNew ? fVal('id') : state.editId;
    if (remove) {
      if (!confirm('このカードをCSVから削除します。よろしいですか？')) return;
    } else {
      if (!id) { err.textContent = 'カードIDを入力してください。'; return; }
      if (isNew && !/^[\w.\-]+$/.test(id)) { err.textContent = 'カードIDは半角英数字・ハイフン・アンダースコア・ドットだけにしてください。'; return; }
      if (!fVal('name')) { err.textContent = 'カード名称を入力してください。'; return; }
      if (!fVal('dAddr')) { err.textContent = '配布場所・住所を入力してください。'; return; }
    }
    const gh = getGh();
    if (!gh) { err.textContent = '先に左上の ⚙ でGitHub連携を設定してください。'; return; }
    const btns = ['#ed-save', '#ed-del', '#ed-cancel'].map($);
    btns.forEach((b) => { b.disabled = true; });
    try {
      let vals = null;
      if (!remove) {
        const addr = fVal('dAddr');
        const coordOk = () => validPlace({ lat: parseFloat(fVal('dLat')), lng: parseFloat(fVal('dLng')) });
        if (addr !== state.geoFor || !coordOk()) {
          if (!(await geocodeInto(addr))) { $('#ed-manual').open = true; throw new Error('住所から座標を取得できませんでした。住所を詳しくするか、「座標を手動で直す」に入力してください'); }
        }
        if (!coordOk()) throw new Error('緯度・経度が正しくありません');
        vals = { id, name: fVal('name'), dAddr: addr, dLat: fVal('dLat'), dLng: fVal('dLng'), src: fVal('src') };
        if (isNew || addr !== state.initAddr) { vals.dSt = '未確認'; vals.checked = today(); }
      }
      const { csv, sha } = await ghGetCsv(gh);
      ensureColumns(csv);
      const idx = colIdx(csv.head);
      if (isNew && csv.rows.some((r) => String(r[idx.id] || '').trim() === id)) throw new Error('同じIDのカードが既にあります');
      applyValues(csv, id, vals, remove);
      await ghPut(gh, CSV_PATH, await blobToB64(new Blob([toCsv(csv)])), sha, (remove ? 'カード削除: ' : isNew ? 'カード追加: ' : 'カード更新: ') + id);
      state.csv = csv;
      state.cards = buildCards(csv).cards;
      closeSheet();
      renderPins();
      $('#editor').close();
      if (!remove) {
        const c = state.cards.find((x) => x.id === id);
        if (c) openSheet(id, state.mode === 'lid' && c.lid ? 'lid' : 'dist', true);
      }
      toast('保存しました。この画面にはすぐ反映され、公開サイトには1〜2分で反映されます。');
    } catch (e) {
      err.textContent = '保存に失敗しました: ' + e.message;
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  /* ---------- 作成者モード: GitHub設定 ---------- */
  function openSettings() {
    let g = {};
    try { g = JSON.parse(localStorage.getItem(GH_KEY) || '{}') || {}; } catch (e) { g = {}; }
    $('#gh-owner').value = g.owner || '';
    $('#gh-repo').value = g.repo || '';
    $('#gh-branch').value = g.branch || '';
    $('#gh-token').value = '';
    $('#gh-token').placeholder = g.token ? '（保存済み。変更するときだけ入力）' : 'github_pat_...';
    $('#gh-msg').textContent = '';
    $('#settings').showModal();
  }
  async function saveSettings() {
    const msg = $('#gh-msg');
    let old = {};
    try { old = JSON.parse(localStorage.getItem(GH_KEY) || '{}') || {}; } catch (e) { old = {}; }
    const g = { owner: $('#gh-owner').value.trim(), repo: $('#gh-repo').value.trim(), branch: $('#gh-branch').value.trim() || 'main',
      token: $('#gh-token').value.trim() || old.token || '' };
    if (!g.owner || !g.repo || !g.token) { msg.textContent = 'ユーザー名・リポジトリ名・トークンを入力してください。'; return; }
    msg.textContent = '接続を確認中…';
    try {
      const f = await ghGet(g, 'data');
      if (!f) throw new Error('リポジトリ内に data フォルダが見つかりません（ブランチ名・リポジトリ名を確認）');
      localStorage.setItem(GH_KEY, JSON.stringify(g));
      msg.textContent = '接続できました。再読み込みします…';
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      msg.textContent = '接続できませんでした: ' + e.message;
    }
  }

  /* ---------- 初期化 ---------- */
  async function init() {
    if (typeof maplibregl === 'undefined') {
      toast('地図ライブラリを読み込めませんでした。通信状況を確認して再読み込みしてください。', true);
      return;
    }
    try {
      const q = new URLSearchParams(location.search).get('admin');
      if (q === '1') localStorage.setItem(ADMIN_KEY, '1');
      if (q === '0') localStorage.removeItem(ADMIN_KEY);
      state.admin = localStorage.getItem(ADMIN_KEY) === '1';
    } catch (e) { state.admin = false; }
    loadCollected();
    map = new maplibregl.Map({
      container: 'map', style: STYLE_URL,
      center: [137.5, 36.5], zoom: 4.5, minZoom: 3, maxZoom: 18, attributionControl: false
    });
    map.touchZoomRotate.disableRotation();
    map.dragRotate.disable();
    map.touchPitch.disable();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('click', closeSheet);
    map.on('error', () => {
      if (tileErrorShown) return;
      tileErrorShown = true;
      toast('地図の一部を読み込めませんでした。通信状況を確認してください。');
    });

    document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); closeSheet(); }));
    $('#locate').addEventListener('click', locate);
    $('#backup').addEventListener('click', downloadPhotos);
    $('#close').addEventListener('click', closeSheet);
    $('#d-swap').addEventListener('click', () => {
      const s = state.selected;
      if (s) openSheet(s.id, s.kind === 'dist' ? 'lid' : 'dist', true);
    });
    $('#d-check').addEventListener('change', (e) => {
      const id = String(state.selected.id);
      if (e.target.checked) state.collected.add(id); else state.collected.delete(id);
      saveCollected();
      refreshPins();
    });
    window.addEventListener('resize', setSheetHeight);

    if (state.admin) {
      document.body.classList.add('admin');
      $('#gh-btn').hidden = false;
      $('#add-btn').hidden = false;
      $('#gh-btn').addEventListener('click', openSettings);
      $('#add-btn').addEventListener('click', () => openEditor(null));
      $('#d-edit').addEventListener('click', () => { if (state.selected) openEditor(state.selected.id); });
      $('#gh-save').addEventListener('click', saveSettings);
      $('#gh-close').addEventListener('click', () => $('#settings').close());
      $('#gh-clear').addEventListener('click', () => { localStorage.removeItem(GH_KEY); $('#gh-msg').textContent = '設定を消しました。'; });
      $('#ed-save').addEventListener('click', () => saveCard(false));
      $('#ed-del').addEventListener('click', () => saveCard(true));
      $('#ed-cancel').addEventListener('click', () => $('#editor').close());
      $('#d-photo').addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!f || !state.selected) return;
        const id = state.selected.id, gh = getGh();
        try {
          const blob = await shrink(f);
          if (gh) {
            toast('GitHubに写真をアップロード中…', true);
            const path = 'images/cards/' + safeName(id) + '.jpg';
            const ex = await ghGet(gh, path);
            await ghPut(gh, path, await blobToB64(blob), ex && ex.sha, '写真: ' + id);
            setPhoto(id, blob, false);
            toast('写真をアップロードしました。公開サイトには1〜2分で反映されます。');
          } else {
            await photoPut(String(id), blob);
            setPhoto(id, blob, true);
            toast('GitHub未設定のため、写真はこの端末にだけ保存しました。');
            if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
          }
        } catch (err) {
          toast('写真を保存できませんでした: ' + err.message);
        }
      });
      $('#d-export').addEventListener('click', () => {
        const id = state.selected && String(state.selected.id);
        if (!id || !state.photos[id]) return;
        const a = document.createElement('a');
        a.href = state.photos[id];
        a.download = safeName(id) + '.jpg';
        a.click();
      });
      if (!getGh()) toast('作成者モード: 左上の ⚙ でGitHub連携を設定すると、サイト上で編集・保存できます。');
    }

    try {
      state.csv = await loadCsv();
      const r = buildCards(state.csv);
      state.cards = r.cards;
      if (r.bad.length) toast('CSVの ' + r.bad.slice(0, 5).join('・') + ' 行目を読み込めませんでした（ID重複・必須項目・座標を確認してください）。', true);
    } catch (e) {
      toast(location.protocol === 'file:'
        ? 'データを読み込めません。ファイルを直接開かず、README記載の方法でサーバー経由で開いてください。'
        : 'カードデータを読み込めませんでした（' + e.message + '）。', true);
    }
    if (state.admin) {
      try { const all = await photoAll(); Object.keys(all).forEach((id) => setPhoto(id, all[id], true)); } catch (e) { /* 端末内保存が使えない環境 */ }
    }
    renderPins();

    const pts = state.pins.dist.map((p) => p.marker.getLngLat());
    if (pts.length) {
      const b = pts.reduce((acc, ll) => acc.extend(ll), new maplibregl.LngLatBounds(pts[0], pts[0]));
      map.fitBounds(b, { padding: 80, maxZoom: 13, duration: 0 });
    }
  }
  init();
})();
