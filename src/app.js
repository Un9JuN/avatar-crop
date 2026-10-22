/* 截图头像工坊 —— 前端逻辑（纯本地，无后端） */
(function () {
  'use strict';

  const APP_VERSION = '0.8.1';
  const $ = (id) => document.getElementById(id);
  // 截图通常不会超过 3000px：尽量按原分辨率分析，避免缩放取整带来 1px 黑边
  const ANALYSIS_MAX = 3000;
  const MIN_CROP = 24;
  const CORNERS = [
    ['nw', -1, -1],
    ['ne', 1, -1],
    ['sw', -1, 1],
    ['se', 1, 1]
  ];

  const state = {
    items: [],
    currentId: null,
    square: false,
    sensitivity: 'standard',
    size: 1080,
    format: 'jpeg'
  };

  let seq = 0;
  let editorView = null;
  let drag = null;
  let rafId = 0;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const cloneCrop = (c) => ({ x: c.x, y: c.y, w: c.w, h: c.h });
  const getItem = (id) => state.items.find((it) => it.id === id) || null;
  const editorOpen = () => !!state.currentId;

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function baseName(item) {
    const raw = (item.name || '头像').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim();
    return raw.slice(0, 60) || '头像';
  }

  /* ---------------- 图片载入 ---------------- */

  /**
   * 用 <img> + canvas 解码：兼容性最好（含 EXIF 方向），
   * 也不依赖 createImageBitmap 在某些环境下的行为差异。
   */
  function loadBitmap(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          canvas.getContext('2d').drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          resolve(canvas);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片解码失败'));
      };
      img.src = url;
    });
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.type && f.type.indexOf('image/') === 0);
    if (!files.length) return;
    for (const file of files) {
      await addOne(file, file.name);
    }
    render();
  }

  async function addOne(blob, name) {
    if (!blob) return null;
    let bitmap;
    try {
      bitmap = await loadBitmap(blob);
    } catch (err) {
      console.warn('图片读取失败', err);
      return null;
    }
    return addBitmap(bitmap, name);
  }

  function addBitmap(bitmap, name) {
    const item = {
      id: 'i' + (++seq),
      name: name || ('截图 ' + seq),
      bitmap,
      crop: null,
      auto: null,
      trimmed: false,
      trimmedRatio: 0
    };
    state.items.push(item);
    applyAuto(item);
    return item;
  }

  /**
   * 收尾保险：如果裁框最外圈和“框外背景色”几乎一样（说明缩图分析残留了 1~2px 背景），
   * 就往里收 1~2px，避免成品出现细黑边。画面里的黑色内容不会被误收，
   * 因为它和框外背景色的平均差异更大。
   */
  function shaveEdges(bitmap, crop) {
    if (!bitmap || typeof bitmap.getContext !== 'function') return crop;
    const ctx = bitmap.getContext('2d', { willReadFrequently: true });
    const W = bitmap.width, H = bitmap.height;
    let { x, y, w, h } = crop;

    const medianColor = (data) => {
      const rs = [], gs = [], bs = [];
      for (let i = 0; i < data.length; i += 4) {
        rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
      }
      const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
      return [med(rs), med(gs), med(bs)];
    };
    const dist = (data, bg) => {
      let sum = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const dr = data[i] - bg[0], dg = data[i + 1] - bg[1], db = data[i + 2] - bg[2];
        sum += Math.sqrt(dr * dr + dg * dg + db * db);
        n++;
      }
      return n ? sum / n : 999;
    };
    const readLine = (lx, ly, lw, lh) => {
      if (lw < 1 || lh < 1) return null;
      try { return ctx.getImageData(lx, ly, lw, lh).data; } catch (e) { return null; }
    };

    for (let k = 0; k < 2; k++) {
      // top
      if (y >= 3) {
        const outside = readLine(x, y - 2, w, 1);
        const edge = readLine(x, y, w, 1);
        if (outside && edge && dist(edge, medianColor(outside)) < 8) { y++; h--; continue; }
      }
      // bottom
      if (y + h + 2 < H) {
        const outside = readLine(x, y + h + 1, w, 1);
        const edge = readLine(x, y + h - 1, w, 1);
        if (outside && edge && dist(edge, medianColor(outside)) < 8) { h--; continue; }
      }
      // left
      if (x >= 3) {
        const outside = readLine(x - 2, y, 1, h);
        const edge = readLine(x, y, 1, h);
        if (outside && edge && dist(edge, medianColor(outside)) < 8) { x++; w--; continue; }
      }
      // right
      if (x + w + 2 < W) {
        const outside = readLine(x + w + 1, y, 1, h);
        const edge = readLine(x + w - 1, y, 1, h);
        if (outside && edge && dist(edge, medianColor(outside)) < 8) { w--; continue; }
      }
      break;
    }
    return { x, y, w, h };
  }

  /** 在缩小图上跑检测，再把裁剪框换算回原图坐标 */
  function applyAuto(item) {
    const bm = item.bitmap;
    const scale = Math.min(1, ANALYSIS_MAX / Math.max(bm.width, bm.height));
    const aw = Math.max(1, Math.round(bm.width * scale));
    const ah = Math.max(1, Math.round(bm.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = aw;
    canvas.height = ah;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bm, 0, 0, aw, ah);
    const imageData = ctx.getImageData(0, 0, aw, ah);

    let res;
    try {
      res = AutoCrop.detect(imageData, {
        sensitivity: state.sensitivity,
        square: state.square,
        mode: 'smart'
      });
    } catch (err) {
      console.error('自动裁剪失败', err);
      res = {
        box: { x: 0, y: 0, w: aw, h: ah },
        crop: { x: 0, y: 0, w: aw, h: ah },
        trimmed: false,
        trimmedRatio: 0
      };
    }

    const kx = bm.width / aw;
    const ky = bm.height / ah;
    item.auto = {
      box: scaleBox(res.box, kx, ky, bm.width, bm.height),
      crop: scaleBox(res.crop, kx, ky, bm.width, bm.height)
    };
    item.crop = cloneCrop(item.auto.crop);
    item.crop = shaveEdges(bm, item.crop);
    if (state.square) {
      // 缩放回原图坐标时取整可能差 1px，强制正方形
      const side = Math.min(item.crop.w, item.crop.h);
      item.crop.w = side;
      item.crop.h = side;
    }
    item.trimmed = !!res.trimmed;
    item.trimmedRatio = res.trimmedRatio || 0;
  }

  function scaleBox(box, kx, ky, W, H) {
    // 用 floor 映射两个端点：避免四舍五入把边缘外的一行黑边也算进来
    let x = Math.floor(box.x * kx);
    let y = Math.floor(box.y * ky);
    let x2 = Math.floor((box.x + box.w) * kx);
    let y2 = Math.floor((box.y + box.h) * ky);
    x = clamp(x, 0, Math.max(0, W - 1));
    y = clamp(y, 0, Math.max(0, H - 1));
    x2 = clamp(x2, x + 1, W);
    y2 = clamp(y2, y + 1, H);
    return { x, y, w: x2 - x, h: y2 - y };
  }

  function reprocessAll() {
    state.items.forEach(applyAuto);
    render();
    if (editorOpen()) {
      const item = getItem(state.currentId);
      if (item) {
        updateEditorMeta(item);
        drawPreview();
      }
    }
  }

  /* ---------------- 列表 ---------------- */

  function render() {
    document.body.classList.toggle('has-items', state.items.length > 0);
    const grid = $('grid');
    grid.innerHTML = '';
    state.items.forEach((item) => grid.appendChild(renderCard(item)));

    const allBtn = $('downloadAllBtn');
    allBtn.disabled = state.items.length === 0;
    allBtn.textContent = state.items.length > 1 ? ('全部下载 (' + state.items.length + ')') : '全部下载';
  }

  function renderCard(item) {
    const card = document.createElement('article');
    card.className = 'card';
    card.addEventListener('click', () => openEditor(item.id));

    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    const thumb = document.createElement('canvas');
    thumb.className = 'thumb';
    drawThumb(item, thumb);
    wrap.appendChild(thumb);

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.name;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const badge = document.createElement('span');
    badge.className = 'badge' + (item.trimmed ? '' : ' warn');
    badge.textContent = item.trimmed
      ? ('已裁掉 ' + Math.round(item.trimmedRatio * 100) + '% 边缘')
      : '几乎没有多余边缘';
    meta.appendChild(badge);

    const row = document.createElement('div');
    row.className = 'row';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn';
    editBtn.textContent = '编辑调整';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditor(item.id);
    });
    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn primary';
    dlBtn.textContent = '下载';
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadItem(item);
    });
    row.append(editBtn, dlBtn);

    card.append(wrap, name, meta, row);
    return card;
  }

  function drawThumb(item, canvas) {
    const c = item.crop;
    const k = Math.min(260 / c.w, 240 / c.h, 1);
    canvas.width = Math.max(1, Math.round(c.w * k));
    canvas.height = Math.max(1, Math.round(c.h * k));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(item.bitmap, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
  }

  /* ---------------- 编辑器 ---------------- */

  function openEditor(id) {
    const item = getItem(id);
    if (!item) return;
    state.currentId = id;
    $('editor').classList.remove('hidden');
    $('editor').setAttribute('aria-hidden', 'false');
    $('editorName').textContent = item.name;
    updateEditorMeta(item);
    requestAnimationFrame(() => drawPreview());
  }

  function closeEditor() {
    state.currentId = null;
    drag = null;
    editorView = null;
    $('editor').classList.add('hidden');
    $('editor').setAttribute('aria-hidden', 'true');
  }

  function updateEditorMeta(item) {
    if (!item) return;
    const c = item.crop;
    const bm = item.bitmap;
    const pct = Math.round(item.trimmedRatio * 100);
    const cover = Math.round((c.w * c.h) / (bm.width * bm.height) * 100);
    const base = Math.min(c.w, c.h);
    const k = state.size / Math.max(1, base);
    const outW = Math.round(c.w * k);
    const outH = Math.round(c.h * k);

    $('editorInfo').textContent = item.trimmed ? ('自动去边 ' + pct + '%') : '没检测到多余边缘';
    $('editorMeta').innerHTML = '';
    const rows = [
      ['原图', bm.width + ' × ' + bm.height],
      ['裁剪框', Math.round(c.w) + ' × ' + Math.round(c.h)],
      ['占原图', cover + '%'],
      ['输出', outW + ' × ' + outH + ' px · ' + (state.format === 'png' ? 'PNG' : 'JPG')]
    ];
    rows.forEach(([k2, v]) => {
      const div = document.createElement('div');
      div.innerHTML = k2 + '：<b>' + v + '</b>';
      $('editorMeta').appendChild(div);
    });
  }

  function computeView(item, cssW, cssH) {
    const bw = item.bitmap.width;
    const bh = item.bitmap.height;
    const scale = Math.min(cssW / bw, cssH / bh);
    return { scale, ox: (cssW - bw * scale) / 2, oy: (cssH - bh * scale) / 2, cssW, cssH };
  }

  /** 右侧“成品预览”：只画裁剪框内的内容，所见即下载所得 */
  function drawFinalPreview(item) {
    const canvas = $('finalPreview');
    if (!canvas || !item) return;
    const c = item.crop;
    const MAX = 220;
    const k = Math.min(MAX / c.w, MAX / c.h, 1);
    const w = Math.max(1, Math.round(c.w * k));
    const h = Math.max(1, Math.round(c.h * k));
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(item.bitmap, c.x, c.y, c.w, c.h, 0, 0, w, h);
  }

  function drawPreview() {
    const item = getItem(state.currentId);
    const wrap = $('canvasWrap');
    const canvas = $('preview');
    if (!item || !wrap || !canvas) return;

    const cs = getComputedStyle(wrap);
    const availW = Math.max(0, wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    const availH = Math.max(0, wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
    if (availW < 10 || availH < 10) return;

    const bw = item.bitmap.width;
    const bh = item.bitmap.height;
    const fit = Math.min(availW / bw, availH / bh);
    const dispW = Math.max(1, Math.round(bw * fit));
    const scale = dispW / bw;
    const dispH = Math.max(1, Math.round(bh * scale));

    // 画布按图片比例来，而不是撑满容器：避免预览被拉长/变形，也避免反复重绘越画越大
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(dispW * dpr);
    canvas.height = Math.round(dispH * dpr);
    canvas.style.width = dispW + 'px';
    canvas.style.height = dispH + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(item.bitmap, 0, 0, dispW, dispH);

    editorView = { scale, ox: 0, oy: 0, cssW: dispW, cssH: dispH };

    const c = item.crop;
    const rx = c.x * scale;
    const ry = c.y * scale;
    const rw = c.w * scale;
    const rh = c.h * scale;

    // 框外压暗 + 紫色斜纹：明确告诉用户“这里不会被导出”
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, dispW, dispH);
    ctx.rect(rx, ry, rw, rh);
    ctx.fillStyle = 'rgba(10, 9, 8, 0.55)';
    ctx.fill('evenodd');
    ctx.clip('evenodd');
    ctx.fillStyle = 'rgba(217, 165, 102, 0.14)';
    ctx.fillRect(0, 0, dispW, dispH);
    ctx.strokeStyle = 'rgba(236, 229, 216, 0.07)';
    ctx.lineWidth = 1;
    for (let i = -dispH; i < dispW; i += 18) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + dispH, dispH);
      ctx.stroke();
    }
    ctx.restore();

    // 裁剪框：琥珀虚线 + 骨白角标
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = 'rgba(232, 189, 136, 0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
    ctx.restore();

    // 三分线
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1;
    [1, 2].forEach((n) => {
      const gx = rx + (rw * n) / 3;
      const gy = ry + (rh * n) / 3;
      ctx.beginPath();
      ctx.moveTo(gx, ry);
      ctx.lineTo(gx, ry + rh);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(rx, gy);
      ctx.lineTo(rx + rw, gy);
      ctx.stroke();
    });
    ctx.restore();

    // 边框 + 四角手柄
    ctx.strokeStyle = 'rgba(239, 233, 221, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx + 0.75, ry + 0.75, rw - 1.5, rh - 1.5);

    drawFinalPreview(item);

    const hs = 9;
    CORNERS.forEach(([, dx, dy]) => {
      const hx = dx < 0 ? rx : rx + rw;
      const hy = dy < 0 ? ry : ry + rh;
      ctx.fillStyle = '#efe9dd';
      ctx.strokeStyle = 'rgba(15, 14, 13, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.fill();
      ctx.stroke();
    });
  }

  function hitTest(item, view, x, y) {
    const c = item.crop;
    const sx = view.ox + c.x * view.scale;
    const sy = view.oy + c.y * view.scale;
    const ex = view.ox + (c.x + c.w) * view.scale;
    const ey = view.oy + (c.y + c.h) * view.scale;
    const r = 22;
    const corners = [['nw', sx, sy], ['ne', ex, sy], ['sw', sx, ey], ['se', ex, ey]];
    for (const [name, cx, cy] of corners) {
      if (Math.abs(x - cx) <= r && Math.abs(y - cy) <= r) return name;
    }
    if (x > sx && x < ex && y > sy && y < ey) return 'move';
    return null;
  }

  function cursorAt(item, view, x, y) {
    const hit = hitTest(item, view, x, y);
    if (hit === 'nw' || hit === 'se') return 'nwse-resize';
    if (hit === 'ne' || hit === 'sw') return 'nesw-resize';
    if (hit === 'move') return 'grab';
    return 'default';
  }

  function applyResize(item, mode, start, px, py) {
    const W = item.bitmap.width;
    const H = item.bitmap.height;
    const west = mode.indexOf('w') >= 0;
    const north = mode.indexOf('n') >= 0;
    const anchorX = west ? start.x + start.w : start.x;
    const anchorY = north ? start.y + start.h : start.y;

    if (state.square) {
      const maxSide = Math.max(1, Math.min(west ? anchorX : W - anchorX, north ? anchorY : H - anchorY));
      const side = clamp(Math.max(Math.abs(px - anchorX), Math.abs(py - anchorY)), Math.min(MIN_CROP, maxSide), maxSide);
      item.crop = {
        x: Math.round(west ? anchorX - side : anchorX),
        y: Math.round(north ? anchorY - side : anchorY),
        w: Math.round(side),
        h: Math.round(side)
      };
    } else {
      const x0 = west ? clamp(px, 0, anchorX - MIN_CROP) : start.x;
      const y0 = north ? clamp(py, 0, anchorY - MIN_CROP) : start.y;
      const x1 = west ? start.x + start.w : clamp(px, start.x + MIN_CROP, W);
      const y1 = north ? start.y + start.h : clamp(py, start.y + MIN_CROP, H);
      item.crop = {
        x: Math.round(x0),
        y: Math.round(y0),
        w: Math.round(Math.max(MIN_CROP, x1 - x0)),
        h: Math.round(Math.max(MIN_CROP, y1 - y0))
      };
    }
  }

  function onPointerDown(e) {
    const item = getItem(state.currentId);
    if (!item || !editorView) return;
    const canvas = $('preview');
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = hitTest(item, editorView, x, y);
    if (!hit) return;

    const px = (x - editorView.ox) / editorView.scale;
    const py = (y - editorView.oy) / editorView.scale;
    drag = { mode: hit, crop: cloneCrop(item.crop), px0: px, py0: py };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    const item = getItem(state.currentId);
    if (!item || !editorView) return;
    const canvas = $('preview');
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (!drag) {
      canvas.style.cursor = cursorAt(item, editorView, x, y);
      return;
    }
    e.preventDefault();

    const px = (x - editorView.ox) / editorView.scale;
    const py = (y - editorView.oy) / editorView.scale;

    if (drag.mode === 'move') {
      item.crop = {
        x: Math.round(clamp(drag.crop.x + (px - drag.px0), 0, item.bitmap.width - drag.crop.w)),
        y: Math.round(clamp(drag.crop.y + (py - drag.py0), 0, item.bitmap.height - drag.crop.h)),
        w: drag.crop.w,
        h: drag.crop.h
      };
    } else {
      applyResize(item, drag.mode, drag.crop, px, py);
    }

    drawPreview();
    updateEditorMeta(item);
  }

  function onPointerUp(e) {
    drag = null;
    const canvas = $('preview');
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  }

  function centerCrop(item) {
    const base = item.auto && item.auto.box
      ? item.auto.box
      : { x: 0, y: 0, w: item.bitmap.width, h: item.bitmap.height };
    if (state.square) {
      const side = Math.min(base.w, base.h);
      item.crop = {
        x: Math.round(base.x + (base.w - side) / 2),
        y: Math.round(base.y + (base.h - side) / 2),
        w: Math.round(side),
        h: Math.round(side)
      };
    } else {
      item.crop = cloneCrop(base);
    }
    drawPreview();
    updateEditorMeta(item);
  }

  function autoAgain() {
    const item = getItem(state.currentId);
    if (!item) return;
    applyAuto(item);
    drawPreview();
    updateEditorMeta(item);
    render();
  }

  /* ---------------- 导出 ---------------- */

  function renderCropCanvas(item, size) {
    const c = item.crop;
    // 按“短边 = 输出尺寸”缩放：方形时正好是 size×size，非方形时保留完整画面比例
    const base = Math.max(1, Math.min(c.w, c.h));
    const k = Math.max(1, size) / base;
    const targetW = Math.max(1, Math.round(c.w * k));
    const targetH = Math.max(1, Math.round(c.h * k));
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    if (state.format === 'jpeg') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.drawImage(item.bitmap, c.x, c.y, c.w, c.h, 0, 0, targetW, targetH);
    return canvas;
  }

  function blobFromCanvas(canvas) {
    return new Promise((resolve) => {
      if (state.format === 'jpeg') canvas.toBlob(resolve, 'image/jpeg', 0.92);
      else canvas.toBlob(resolve, 'image/png');
    });
  }

  function ext() {
    return state.format === 'png' ? 'png' : 'jpg';
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1200);
  }

  async function downloadItem(item) {
    if (!item) return;
    const canvas = renderCropCanvas(item, state.size);
    const blob = await blobFromCanvas(canvas);
    if (!blob) return;
    saveBlob(blob, baseName(item) + '-头像.' + ext());
  }

  async function downloadAll() {
    if (!state.items.length) return;
    const btn = $('downloadAllBtn');
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '打包中…';
    try {
      const files = [];
      for (let i = 0; i < state.items.length; i++) {
        const item = state.items[i];
        const canvas = renderCropCanvas(item, state.size);
        const blob = await blobFromCanvas(canvas);
        if (!blob) continue;
        const buf = new Uint8Array(await blob.arrayBuffer());
        // ZIP 内用英文名：部分 Windows 解压工具对 UTF-8 中文文件名兼容不好
        files.push({ name: 'avatar-' + (i + 1) + '.' + ext(), data: buf });
      }
      if (!files.length) return;
      const zip = SimpleZip.build(files);
      saveBlob(new Blob([zip], { type: 'application/zip' }), '头像-' + stamp() + '.zip');
    } catch (err) {
      console.error(err);
      alert('打包失败：' + (err && err.message ? err.message : err));
    } finally {
      btn.disabled = state.items.length === 0;
      btn.textContent = oldText;
    }
  }

  /* ---------------- 示例截图 ---------------- */

  function buildSampleCanvas() {
    const W = 1080;
    const H = 1920;
    const PY = 285;
    const PH = 1350;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // 照片区域：斜向渐变
    const g = ctx.createLinearGradient(0, PY, W, PY + PH);
    g.addColorStop(0, '#ff7e5f');
    g.addColorStop(0.5, '#feb47b');
    g.addColorStop(1, '#6a5acd');
    ctx.fillStyle = g;
    ctx.fillRect(0, PY, W, PH);

    // 装饰圆
    const circles = ['rgba(255,255,255,0.22)', 'rgba(0,0,0,0.16)', 'rgba(255,255,255,0.12)'];
    for (let i = 0; i < 7; i++) {
      const cx = 120 + (i * 137) % 900;
      const cy = PY + 120 + (i * 211) % 1100;
      const r = 60 + (i * 37) % 130;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = circles[i % 3];
      ctx.fill();
    }

    // 照片上的标题
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.font = '700 68px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText('这是一张示例图片', W / 2, PY + 700);
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.font = '400 34px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText('上下黑边 + 底部字幕，模拟抖音截图', W / 2, PY + 760);

    // 状态栏
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = '600 34px "Segoe UI", sans-serif';
    ctx.fillText('9:41', 42, 58);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('5G', W - 210, 58);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(W - 118, 30, 70, 30);
    ctx.fillRect(W - 114, 34, 38, 22);

    // 右侧图标
    for (let k = 0; k < 4; k++) {
      const cy = PY + 640 + k * 150;
      ctx.beginPath();
      ctx.arc(W - 70, cy, 30, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(W - 70, cy, 18, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120,100,180,0.9)';
      ctx.fill();
    }

    // 底部字幕
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '400 36px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText('@示例账号 · 这是一段模拟的字幕文案', 42, H - 250);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '400 30px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText('还有一行小字 ✨ 自动裁掉它们', 42, H - 190);

    return canvas;
  }

  function makeSampleScreenshot() {
    return new Promise((resolve) => buildSampleCanvas().toBlob(resolve, 'image/png'));
  }

  /* ---------------- 选项 ---------------- */

  function syncOptUI() {
    document.querySelectorAll('[data-opt="size"]').forEach((el) => { el.value = String(state.size); });
    document.querySelectorAll('[data-opt="format"]').forEach((el) => { el.value = state.format; });
    document.querySelectorAll('[data-opt="sensitivity"]').forEach((el) => { el.value = state.sensitivity; });
    document.querySelectorAll('[data-opt="square"]').forEach((el) => { el.checked = !!state.square; });
  }

  function onOptionChange(e) {
    const el = e.target.closest ? e.target.closest('[data-opt]') : null;
    if (!el) return;
    const key = el.getAttribute('data-opt');
    if (key === 'square') state.square = !!el.checked;
    else if (key === 'size') state.size = parseInt(el.value, 10) || 512;
    else if (key === 'format' || key === 'sensitivity') state[key] = el.value;
    else return;

    syncOptUI();

    if (key === 'sensitivity' || key === 'square') {
      reprocessAll();
    }
    if (editorOpen()) {
      const item = getItem(state.currentId);
      if (item) {
        updateEditorMeta(item);
        drawPreview();
      }
    }
  }

  /* ---------------- 初始化 ---------------- */

  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  /** PWA：注册 Service Worker、安装按钮、离线能力 */
  function setupPWA() {
    const btn = $('installBtn');
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service Worker 注册失败', err));
    }

    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      if (btn && !standalone) btn.classList.remove('hidden');
    });
    window.addEventListener('appinstalled', () => {
      deferred = null;
      if (btn) btn.classList.add('hidden');
    });

    if (btn) {
      btn.addEventListener('click', async () => {
        if (deferred) {
          deferred.prompt();
          try { await deferred.userChoice; } catch (e) { /* ignore */ }
          deferred = null;
          btn.classList.add('hidden');
        } else if (isIOS() && !standalone) {
          alert('iPhone / iPad：点 Safari 底部的「分享」按钮，再选「添加到主屏幕」。');
        }
      });
    }
    if (!standalone && isIOS() && btn) btn.classList.remove('hidden');
    if (standalone && btn) btn.classList.add('hidden');
  }

  /** 处理 Android「分享到应用」传来的截图（由 Service Worker 暂存） */
  async function handleSharedImage() {
    const params = new URLSearchParams(location.search);
    const key = params.get('shared');
    if (!key) return;
    try {
      if ('caches' in window) {
        const cache = await caches.open('avatar-shared');
        const res = await cache.match(key);
        if (res) {
          const blob = await res.blob();
          const name = decodeURIComponent(res.headers.get('X-File-Name') || '分享的截图.jpg');
          const item = await addOne(blob, name);
          render();
          if (item) openEditor(item.id);
          await cache.delete(key);
        }
      }
    } catch (err) {
      console.warn('读取分享图片失败', err);
    }
    history.replaceState(null, '', location.pathname + location.hash);
  }

  function init() {
    setupPWA();
    const verEl = $('appVer');
    if (verEl) verEl.textContent = 'v' + APP_VERSION;
    syncOptUI();

    $('pickBtn').addEventListener('click', () => $('fileInput').click());
    $('pickBtn2').addEventListener('click', (e) => {
      e.stopPropagation();
      $('fileInput').click();
    });
    $('dropzone').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      $('fileInput').click();
    });

    $('fileInput').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length) await addFiles(files);
    });

    $('sampleBtn').addEventListener('click', async () => {
      const blob = await makeSampleScreenshot();
      if (!blob) return;
      const item = await addOne(blob, '示例截图.png');
      render();
      if (item) openEditor(item.id);
    });

    $('downloadAllBtn').addEventListener('click', downloadAll);

    $('backBtn').addEventListener('click', closeEditor);
    $('autoBtn').addEventListener('click', autoAgain);
    $('centerBtn').addEventListener('click', () => {
      const item = getItem(state.currentId);
      if (item) centerCrop(item);
    });
    $('downloadBtn').addEventListener('click', () => {
      const item = getItem(state.currentId);
      if (item) downloadItem(item);
    });
    $('deleteBtn').addEventListener('click', () => {
      const id = state.currentId;
      if (!id) return;
      state.items = state.items.filter((it) => it.id !== id);
      closeEditor();
      render();
    });

    const canvas = $('preview');
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    document.addEventListener('change', onOptionChange);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && editorOpen()) closeEditor();
    });

    document.addEventListener('paste', (e) => {
      const data = e.clipboardData || window.clipboardData;
      if (!data) return;
      const files = [];
      if (data.items) {
        Array.from(data.items).forEach((it) => {
          if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        });
      }
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });

    ['dragenter', 'dragover'].forEach((ev) => {
      document.addEventListener(ev, (e) => {
        e.preventDefault();
        document.body.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      document.addEventListener(ev, (e) => {
        e.preventDefault();
        document.body.classList.remove('dragging');
      });
    });
    document.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) addFiles(files);
    });

    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (!editorOpen()) return;
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(drawPreview);
      }).observe($('canvasWrap'));
    }

    window.addEventListener('resize', () => {
      if (editorOpen()) {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(drawPreview);
      }
    });

    // 便于自动截图/演示：打开 index.html#demo 时直接加载示例并进入编辑器
    if (location.hash === '#demo') {
      document.body.dataset.demo = 'start';
      try {
        const item = addBitmap(buildSampleCanvas(), '示例截图.png');
        render();
        openEditor(item.id);
        document.body.dataset.demo = 'open';
      } catch (err) {
        document.body.dataset.demo = 'err:' + (err && err.message);
      }
    }

    // 无头自检 2：走一遍「Blob → 解码 → 自动裁剪」的真实文件流程
    if (location.hash === '#filetest') {
      buildSampleCanvas().toBlob(async (blob) => {
        try {
          const item = await addOne(blob, 'filetest.png');
          document.body.dataset.filetest = item
            ? ('ok:' + item.bitmap.width + 'x' + item.bitmap.height + ':' + item.crop.w + 'x' + item.crop.h)
            : 'null';
        } catch (err) {
          document.body.dataset.filetest = 'err:' + (err && err.message);
        }
      }, 'image/png');
    }

    // 无头自检：打开 index.html#selftest 验证完整画面 / 方形两种导出与 ZIP
    if (location.hash === '#selftest') {
      try {
        const item = addBitmap(buildSampleCanvas(), 'selftest.png');

        // 默认模式：保留完整画面，短边 = 输出尺寸
        const full = renderCropCanvas(item, state.size);
        const fullOk = Math.min(full.width, full.height) === state.size && full.width !== full.height;

        // 方形模式：1:1
        state.square = true;
        applyAuto(item);
        const sq = renderCropCanvas(item, state.size);
        const sqOk = sq.width === state.size && sq.height === state.size;
        state.square = false;
        applyAuto(item);

        const ctx = full.getContext('2d');
        const px = ctx.getImageData(0, 0, full.width, full.height).data;
        let dark = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] + px[i + 1] + px[i + 2] < 60) dark++;
        }
        const ratio = dark / (px.length / 4);
        const zip = SimpleZip.build([{ name: 'a.jpg', data: new Uint8Array([1, 2, 3]) }]);
        const zipOk = zip[zip.length - 22] === 0x50 && zip[zip.length - 21] === 0x4b;
        const ok = fullOk && sqOk && state.size >= 1080 && ratio < 0.05 && zipOk;
        document.body.dataset.selftest = ok
          ? 'ok'
          : ('fail:' + [full.width, full.height, sq.width, sq.height, Math.round(ratio * 100)].join(','));
        render();
      } catch (err) {
        document.body.dataset.selftest = 'err:' + (err && err.message);
      }
    }
    // PWA 自检：确认 Service Worker 已激活、缓存已建立
    if (location.hash === '#pwatest') {
      (async () => {
        try {
          if (!('serviceWorker' in navigator)) {
            document.body.dataset.pwatest = 'unsupported';
            return;
          }
          const reg = await navigator.serviceWorker.ready;
          const keys = await caches.keys();
          document.body.dataset.pwatest = 'ok:' + (reg && reg.active ? 'active' : 'none') + ':' + keys.length;
        } catch (err) {
          document.body.dataset.pwatest = 'err:' + (err && err.message);
        }
      })();
    }

    // 从 Android 分享进来的图片
    handleSharedImage();
  }

  init();
})();
