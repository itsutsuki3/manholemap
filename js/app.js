(() => {
  'use strict';
  const STORAGE_KEY = 'manholeMap.collected.v1';
  // OpenStreetMapデータのベクタ地図（OpenFreeMap、APIキー不要）。bright以外に liberty / positron も指定できる
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';
  const KIND = { dist: 'カード配布場所', lid: 'マンホール蓋の設置場所' };
  const FIELD = { dist: 'distribution', lid: 'lid' };
  const STATUS = { verified: '確認済み', unverified: '未確認', sample: '架空（サンプル）' };
  const $ = (s) => document.querySelector(s);
  const state = { mode: 'dist', cards: [], collected: new Set(), pins: { dist: [], lid: [] }, selected: null, me: null, watching: false, photos: {}, blobs: {} };
  let map, toastTimer, tileErrorShown = false;

  function toast(msg, sticky) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

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

  async function fetchText(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, ''); }
    catch (e) { return new TextDecoder('shift_jis').decode(buf); } // Excelの通常CSV(Shift_JIS)対策
  }

  async function loadCards() {
    const rows = parseCsv(await fetchText('data/cards.csv')).filter((r) => r.some((c) => c.trim()));
    if (!rows.length) throw new Error('CSVが空です');
    const head = rows[0].map((h) => h.trim());
    const idx = {};
    Object.keys(COLS).forEach((k) => { idx[k] = head.indexOf(COLS[k]); });
    const missing = ['id', 'name', 'dLat', 'dLng'].filter((k) => idx[k] < 0).map((k) => COLS[k]);
    if (missing.length) throw new Error('必須の列がありません: ' + missing.join('、'));
    const num = (v) => parseFloat(v);
    const cards = [], bad = [], seen = new Set();
    rows.slice(1).forEach((r, n) => {
      const g = (k) => (idx[k] < 0 ? '' : String(r[idx[k]] || '').trim());
      const id = g('id');
      const dist = { name: g('dName'), address: g('dAddr'), lat: num(g('dLat')), lng: num(g('dLng')) };
      if (!id || seen.has(id) || !validPlace(dist)) { bad.push(n + 2); return; }
      seen.add(id);
      const lid = { name: g('lName'), address: g('lAddr'), lat: num(g('lLat')), lng: num(g('lLng')) };
      cards.push({
        id, name: g('name') || id, prefecture: g('pref'), city: g('city'), series: g('series'), imageUrl: g('img'),
        distribution: dist, lid: validPlace(lid) ? lid : null, sourceUrl: g('src'), checkedAt: g('checked'),
        coordinateStatus: { distribution: ST_MAP[g('dSt')] || 'unverified', lid: ST_MAP[g('lSt')] || 'unverified' },
        sample: !!g('sample')
      });
    });
    return { cards, bad };
  }

  /* ---- 写真（この端末のIndexedDBに保存） ---- */
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
  const safeName = (id) => String(id).replace(/[\\/:*?"<>|]/g, '_');
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(files) { // 無圧縮ZIP（JPEGは既に圧縮済みのため）
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
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }
  async function downloadPhotos() {
    const ids = Object.keys(state.blobs);
    if (!ids.length) return toast('保存した写真がありません。');
    try {
      const files = [];
      for (const id of ids) files.push({ name: 'images/cards/' + safeName(id) + '.jpg', data: new Uint8Array(await state.blobs[id].arrayBuffer()) });
      const url = URL.createObjectURL(makeZip(files));
      const d = new Date(), pad = (n) => String(n).padStart(2, '0');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'manhole-photos-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(ids.length + '枚の写真をZIPにしました。展開した images フォルダを、プロジェクトの images フォルダに入れて再アップロードしてください。');
    } catch (e) {
      toast('ダウンロード用ZIPの作成に失敗しました。');
    }
  }
  const cardImg = (c) => state.photos[String(c.id)] || c.imageUrl || 'images/cards/' + encodeURIComponent(c.id) + '.jpg';
  function setPhoto(id, blob) {
    id = String(id);
    if (state.photos[id]) URL.revokeObjectURL(state.photos[id]);
    const url = URL.createObjectURL(blob);
    state.photos[id] = url;
    state.blobs[id] = blob;
    $('#backup').hidden = false;
    $('#backup-n').textContent = Object.keys(state.blobs).length;
    state.pins.dist.forEach((p) => { if (String(p.id) === id) { p.img.style.display = ''; p.el.classList.remove('noimg'); p.img.src = url; } });
    if (state.selected && String(state.selected.id) === id) openSheet(state.selected.id, state.selected.kind, false);
  }

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
      img.src = cardImg(card);
      img.addEventListener('error', () => { img.style.display = 'none'; el.classList.add('noimg'); });
      el.appendChild(img);
    }
    el.addEventListener('click', (e) => { e.stopPropagation(); openSheet(card.id, kind, true); });
    const marker = new maplibregl.Marker({ element: el, anchor: kind === 'dist' ? 'bottom' : 'center' })
      .setLngLat([place.lng, place.lat]);
    state.pins[kind].push({ id: card.id, el, img, marker, lat: place.lat });
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

    const img = $('#d-img');
    img.src = cardImg(card);
    img.onerror = () => { img.removeAttribute('src'); };
    $('#d-kind').textContent = KIND[kind];
    $('#d-kind').className = 'kind ' + kind;
    $('#d-name').textContent = card.name || '';
    $('#d-meta').textContent = [card.prefecture, card.city, card.series ? '第' + card.series + '弾' : ''].filter(Boolean).join(' ／ ');
    $('#d-place').textContent = place.name || '';
    $('#d-addr').textContent = place.address || '住所は未登録です';
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
        zoom: Math.max(map.getZoom(), 15),
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
      map.flyTo({ center: showMe(pos), zoom: Math.max(map.getZoom(), 15) });
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

  async function init() {
    if (typeof maplibregl === 'undefined') {
      toast('地図ライブラリを読み込めませんでした。通信状況を確認して再読み込みしてください。', true);
      return;
    }
    loadCollected();
    map = new maplibregl.Map({
      container: 'map',
      style: STYLE_URL,
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
    $('#d-photo').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f || !state.selected) return;
      const id = state.selected.id;
      try {
        const blob = await shrink(f);
        await photoPut(String(id), blob);
        setPhoto(id, blob);
        toast('写真をこの端末に保存しました。');
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      } catch (err) {
        toast('写真を保存できませんでした。プライベートブラウズでないか確認してください。');
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
    window.addEventListener('resize', setSheetHeight);

    try {
      const r = await loadCards();
      state.cards = r.cards;
      if (r.bad.length) toast('CSVの ' + r.bad.slice(0, 5).join('・') + ' 行目を読み込めませんでした（ID重複・必須項目・座標を確認してください）。', true);
    } catch (e) {
      toast(location.protocol === 'file:'
        ? 'データを読み込めません。ファイルを直接開かず、README記載の方法でサーバー経由で開いてください。'
        : 'カードデータを読み込めませんでした（' + e.message + '）。', true);
    }
    try { const all = await photoAll(); Object.keys(all).forEach((id) => setPhoto(id, all[id])); } catch (e) { /* 写真保存が使えない環境 */ }
    state.cards.forEach((c) => { addPin('dist', c); addPin('lid', c); });
    setMode('dist');
    refreshPins();

    const pts = state.pins.dist.map((p) => p.marker.getLngLat());
    if (pts.length) {
      const b = pts.reduce((acc, ll) => acc.extend(ll), new maplibregl.LngLatBounds(pts[0], pts[0]));
      map.fitBounds(b, { padding: 80, maxZoom: 13, duration: 0 });
    }
  }
  init();
})();
