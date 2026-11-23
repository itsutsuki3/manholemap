(() => {
  'use strict';
  const STORAGE_KEY = 'manholeMap.collected.v1';
  const CSV_PATHS = ["data/cards.csv","data/cards-02.csv","data/cards-03.csv","data/cards-04.csv","data/cards-05.csv","data/cards-06.csv","data/cards-07.csv","data/cards-08.csv","data/cards-09.csv","data/cards-10.csv","data/cards-11.csv","data/cards-12.csv","data/cards-13.csv","data/cards-14.csv"];
  // OpenStreetMapデータのベクタ地図（OpenFreeMap、APIキー不要）。bright以外に liberty / positron も指定できる
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';
  const KIND = { dist: 'カード配布場所', lid: 'マンホール蓋の設置場所' };
  const FIELD = { dist: 'distribution', lid: 'lid' };
  const STATUS = { verified: '確認済み', unverified: '未確認', sample: '架空（サンプル）' };
  const $ = (s) => document.querySelector(s);
  const state = { mode: 'dist', cards: [], csv: null, collected: new Set(), pins: { dist: [], lid: [] }, selected: null,
    me: null, watching: false, location: null };
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

  async function loadCsv() {
    const parts = await Promise.all(CSV_PATHS.map(async (path) => {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) throw new Error(path + ': HTTP ' + res.status);
      return parseToCsv(decodeBytes(new Uint8Array(await res.arrayBuffer())));
    }));
    return { head: parts[0].head, rows: parts.flatMap((part) => part.rows) };
  }

  function loadImg(img, card, done) {
    const url = safeUrl(card.imageUrl);
    if (!url) { img.style.display = 'none'; if (done) done(true); return; }
    img.style.display = '';
    img.loading = 'lazy';
    img.fetchPriority = 'low';
    img.onload = () => { if (done) done(false); };
    img.onerror = () => { img.style.display = 'none'; if (done) done(true); };
    img.src = url;
  }

  /* ---------- ピン ---------- */
  const REGION_COLORS = {北海道:'#28a745',東北:'#9acd32',関東:'#55c7e8',北陸:'#2468d8',中国:'#e53935',四国:'#8e44ad',近畿:'#f39c12',九州:'#ec78b5',沖縄:'#ec78b5',中部:'#f1c40f'};
  const PREF_REGION = {
    北海道:'北海道',青森県:'東北',岩手県:'東北',宮城県:'東北',秋田県:'東北',山形県:'東北',福島県:'東北',
    茨城県:'関東',栃木県:'関東',群馬県:'関東',埼玉県:'関東',千葉県:'関東',東京都:'関東',神奈川県:'関東',
    新潟県:'北陸',富山県:'北陸',石川県:'北陸',福井県:'北陸',
    山梨県:'中部',長野県:'中部',岐阜県:'中部',静岡県:'中部',愛知県:'中部',
    三重県:'近畿',滋賀県:'近畿',京都府:'近畿',大阪府:'近畿',兵庫県:'近畿',奈良県:'近畿',和歌山県:'近畿',
    鳥取県:'中国',島根県:'中国',岡山県:'中国',広島県:'中国',山口県:'中国',
    徳島県:'四国',香川県:'四国',愛媛県:'四国',高知県:'四国',
    福岡県:'九州',佐賀県:'九州',長崎県:'九州',熊本県:'九州',大分県:'九州',宮崎県:'九州',鹿児島県:'九州',沖縄県:'沖縄'
  };
  function addPin(kind, card) {
    const place = card[FIELD[kind]];
    if (!validPlace(place)) return;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pin pin-' + kind;
    const region = PREF_REGION[card.prefecture] || '中部';
    el.style.setProperty('--region', REGION_COLORS[region] || REGION_COLORS['中部']);
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

  function setMode() {
    state.mode = 'dist';
    state.pins.lid.forEach((p) => p.marker.remove());
    state.pins.dist.forEach((p) => p.marker.addTo(map));
  }

  function renderPins() {
    ['dist', 'lid'].forEach((k) => state.pins[k].forEach((p) => p.marker.remove()));
    state.pins = { dist: [], lid: [] };
    state.cards.forEach((c) => { addPin('dist', c); addPin('lid', c); });
    setMode(state.mode);
    prioritizeNearbyPins();
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
    const src = $('#d-src');
    src.textContent = '配布状況など：';
    const url = safeUrl(card.sourceUrl);
    if (url) {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '詳細';
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

  function prioritizeNearbyPins() {
    if (!state.location) return;
    const origin = state.location;
    state.pins.dist.forEach((p) => {
      if (!p.img || p.img.style.display === 'none') return;
      const ll = p.marker.getLngLat();
      const dy = (ll.lat - origin.lat) * 111;
      const dx = (ll.lng - origin.lng) * 111 * Math.cos(origin.lat * Math.PI / 180);
      if (Math.hypot(dx, dy) <= 12) {
        p.img.loading = 'eager';
        p.img.fetchPriority = 'high';
      }
    });
  }

  /* ---------- 現在地 ---------- */
  function showMe(pos) {
    const ll = [pos.coords.longitude, pos.coords.latitude];
    state.location = { lng: ll[0], lat: ll[1] };
    prioritizeNearbyPins();
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

  /* ---------- 初期化 ---------- */  /* ---------- 初期化 ---------- */
  async function init() {
    if (typeof maplibregl === 'undefined') {
      toast('地図ライブラリを読み込めませんでした。通信状況を確認して再読み込みしてください。', true);
      return;
    }
    loadCollected();
    map = new maplibregl.Map({
      container: 'map', style: STYLE_URL,
      center: [139.7528, 35.6852], zoom: 13.5, minZoom: 3, maxZoom: 18, attributionControl: false
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

    $('#locate').addEventListener('click', locate);
    $('#close').addEventListener('click', closeSheet);
    $('#d-check').addEventListener('change', (e) => {
      const id = String(state.selected.id);
      if (e.target.checked) state.collected.add(id); else state.collected.delete(id);
      saveCollected();
      refreshPins();
    });
    window.addEventListener('resize', setSheetHeight);

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
    renderPins();


  }
  init();
})();
