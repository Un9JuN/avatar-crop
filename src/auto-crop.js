/*!
 * auto-crop.js — 截图自动去边 + 头像方形裁剪（纯 JS，无依赖）
 *
 * 思路（不依赖人脸）：
 *   1. 分别取四条边的底色（中位数颜色）；
 *   2. 从每条边往里扫，只要整行/整列"与底色一致"的像素占比低于阈值，就认为这一行/列是空白/黑边/UI 条，裁掉；
 *      遇到"内容占比"足够的行/列就停（照片、人、文字主体都会停）。
 *   3. 去掉四周后再给头像用的方形裁剪框：默认智能构图（按边缘能量找主体），可切换居中。
 *
 * 输入：ImageData 或 { data, width, height }（RGBA）
 * 输出：{ box, crop, trimmed, trimmedRatio, detected, ... }
 */
(function (root) {
  'use strict';

  const DEFAULTS = { sensitivity: 'standard', square: true, mode: 'smart' };

  // fracTol: 一行里“内容像素”占比低于它 → 视为边框
  // colorTol: 与边框底色的 RGB 距离阈值
  // maxTrim: 单侧最多裁掉的比例（防止误判把图裁没）
  const SENSITIVITY = {
    conservative: { fracTol: 0.10, colorTol: 24, maxTrim: 0.40 },
    standard:     { fracTol: 0.20, colorTol: 32, maxTrim: 0.45 },
    aggressive:   { fracTol: 0.34, colorTol: 44, maxTrim: 0.52 }
  };

  const MIN_EDGE = 12;
  const MIN_AREA_RATIO = 0.05;
  const ALPHA_MIN = 16;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function median(values) {
    const a = values.slice().sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  function lumOf(d, i) {
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }

  function distTo(d, i, bg) {
    const dr = d[i] - bg[0], dg = d[i + 1] - bg[1], db = d[i + 2] - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  const EDGE_INSET_RATIO = 0.006;

  /** 取 box 某条边内侧的底色（中位色），自动跳过外圈 0.6% 的细边框 */
  function sampleEdge(img, box, side) {
    const w = img.width;
    const d = img.data;
    const along = (side === 'top' || side === 'bottom') ? box.w : box.h;
    const inset = Math.min(
      Math.max(1, Math.round(Math.min(img.width, img.height) * EDGE_INSET_RATIO)),
      Math.max(0, Math.floor(along / 4))
    );
    const rs = [], gs = [], bs = [];
    for (let k = 0; k < 2; k++) {
      const off = Math.min(inset + k, Math.max(0, along - 1));
      const line = edgeLine(img, box, side, off);
      for (let p = line.from; p < line.to; p++) {
        const i = (line.horizontal ? line.fixed * w + p : p * w + line.fixed) * 4;
        if (d[i + 3] < ALPHA_MIN) continue;
        rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
      }
    }
    if (!rs.length) return [0, 0, 0];
    return [median(rs), median(gs), median(bs)];
  }

  /** 一条“边线”（行或列）在 box 内的坐标信息 */
  function edgeLine(img, box, side, offset) {
    if (side === 'top' || side === 'bottom') {
      const y = side === 'top' ? box.y + offset : box.y + box.h - 1 - offset;
      return { horizontal: true, fixed: y, from: box.x, to: box.x + box.w };
    }
    const x = side === 'left' ? box.x + offset : box.x + box.w - 1 - offset;
    return { horizontal: false, fixed: x, from: box.y, to: box.y + box.h };
  }

  /** 某一行/列里，与底色差异足够大的像素占比 */
  function edgeFraction(img, box, side, offset, bg, tol) {
    const w = img.width, d = img.data;
    const line = edgeLine(img, box, side, offset);
    let content = 0, total = 0;
    for (let p = line.from; p < line.to; p++) {
      const i = (line.horizontal ? line.fixed * w + p : p * w + line.fixed) * 4;
      if (d[i + 3] >= ALPHA_MIN && distTo(d, i, bg) > tol) content++;
      total++;
    }
    return total ? content / total : 0;
  }

  /**
   * 一行的统计：均值、中位亮度，以及“接近该行主色”的像素比例。
   * 后者用于区分「纯色带（黑边、灰底、白边）」和「有颜色渐变的照片」：
   * 平滑渐变的亮度可能很均匀，但颜色在横向上是变化的。
   */
  function lineStats(img, box, side, offset) {
    const w = img.width, d = img.data;
    const line = edgeLine(img, box, side, offset);
    const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
    let sum = 0, n = 0;
    for (let p = line.from; p < line.to; p++) {
      const i = (line.horizontal ? line.fixed * w + p : p * w + line.fixed) * 4;
      if (d[i + 3] < ALPHA_MIN) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      hr[r]++; hg[g]++; hb[b]++;
      sum += lumOf(d, i);
      n++;
    }
    if (!n) return { mean: 0, colorFlat: 1 };
    const mean = sum / n;
    const med = (hist) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc * 2 >= n) return v;
      }
      return 128;
    };
    const mr = med(hr), mg = med(hg), mb = med(hb);
    let flat = 0;
    for (let p = line.from; p < line.to; p++) {
      const i = (line.horizontal ? line.fixed * w + p : p * w + line.fixed) * 4;
      if (d[i + 3] < ALPHA_MIN) continue;
      const dr = d[i] - mr, dg = d[i + 1] - mg, db = d[i + 2] - mb;
      if (dr * dr + dg * dg + db * db <= 144) flat++; // 距离 <= 12
    }
    return { mean, colorFlat: flat / n };
  }

  /**
   * 从某条边往里裁：
   *  - 与底色一致的像素占比不足 → 空白/黑边；
   *  - 或者整行是“纯黑/纯白 + 几乎无纹理”的均匀条 → 也算边框
   *    （这样即使截图外面还套了白色边框 / 多层截图，也能一层层剥掉）
   */
  /**
   * 从某条边往里裁。mode 决定“空白”的颜色取向：
   *  - dark：截图查看器的黑/深灰底（最常见），只把暗色区域当空白，亮色区域直接停；
   *  - light：白底页面/白边，亮暗都可能是空白。
   * 这样白底插画（画面本身大面积白色）不会被当成白边裁掉。
   */
  function trimEdge(img, box, side, bg, cfg, mode) {
    const dim = (side === 'top' || side === 'bottom') ? box.h : box.w;
    const maxTrim = Math.floor(dim * cfg.maxTrim);
    const lightMode = mode === 'light';
    let t = 0;
    while (t < maxTrim) {
      const frac = edgeFraction(img, box, side, t, bg, cfg.colorTol);
      const st = lineStats(img, box, side, t);
      if (frac >= cfg.fracTol) {
        const uniformBand = st.colorFlat >= 0.88 &&
          (lightMode ? (st.mean < 130 || st.mean > 180) : st.mean < 130);
        if (!uniformBand) break;
      } else if (!lightMode && st.mean > 160) {
        // 暗背景模式下，亮色区域是画面，不是空白
        break;
      }
      t++;
    }
    return t;
  }

  /** 取某一整行的中位色（用于清 UI 条时确定底色） */
  function lineColor(img, y, x0, x1) {
    const w = img.width, d = img.data;
    const rs = [], gs = [], bs = [];
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < ALPHA_MIN) continue;
      rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
    }
    return rs.length ? [median(rs), median(gs), median(bs)] : [0, 0, 0];
  }

  function colColor(img, x, y0, y1) {
    const w = img.width, d = img.data;
    const rs = [], gs = [], bs = [];
    for (let y = y0; y < y1; y++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < ALPHA_MIN) continue;
      rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
    }
    return rs.length ? [median(rs), median(gs), median(bs)] : [0, 0, 0];
  }

  /** 行内与底色几乎一致的像素占比（严格阈值，用来辨认“纯色底 + 少量文字”的 UI 条） */
  function bgFractionRow(img, y, x0, x1, bg, tol) {
    const d = img.data, w = img.width;
    let same = 0, total = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < ALPHA_MIN || distTo(d, i, bg) <= tol) same++;
      total++;
    }
    return total ? same / total : 0;
  }

  /** 列内与底色几乎一致的像素占比 */
  function bgFractionCol(img, x, y0, y1, bg, tol) {
    const d = img.data, w = img.width;
    let same = 0, total = 0;
    for (let y = y0; y < y1; y++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < ALPHA_MIN || distTo(d, i, bg) <= tol) same++;
      total++;
    }
    return total ? same / total : 0;
  }

  /**
   * 第二阶段：截图里的状态栏、底部字幕是「纯色底 + 稀疏文字」，
   * 第一阶段阈值会把它们当成内容而停下。仅当第一阶段已经判定出边框（说明是截图）时，
   * 继续清掉紧贴四边、且大半像素仍是底色的窄条，每侧最多再清 15%。
   *
   * 判定用「严格等于底色的像素占比」而不是「内容占比」：平滑渐变照片的相邻像素
   * 颜色几乎一样，用宽松阈值会被误判成边框；严格阈值下渐变不会被裁。
   */
  function extendSparse(img, box, bg, cfg) {
    const w = img.width, h = img.height;
    const LIMIT = 0.15;
    const BG_TOL = 12;
    const BG_MIN = 0.5;
    let top = box.y, bottom = box.y + box.h;
    let left = box.x, right = box.x + box.w;

    const maxTop = Math.min(box.y + Math.floor(h * LIMIT), bottom - MIN_EDGE);
    while (top < maxTop && bg.top && bgFractionRow(img, top, left, right, bg.top, BG_TOL) >= BG_MIN) top++;

    const maxBottomTrim = Math.min(Math.floor(h * LIMIT), bottom - top - MIN_EDGE);
    let moved = 0;
    while (moved < maxBottomTrim && bg.bottom) {
      const y = bottom - 1;
      if (y <= top) break;
      if (bgFractionRow(img, y, left, right, bg.bottom, BG_TOL) < BG_MIN) break;
      bottom = y;
      moved++;
    }

    const maxLeft = Math.min(box.x + Math.floor(w * LIMIT), right - MIN_EDGE);
    while (left < maxLeft && bg.left && bgFractionCol(img, left, top, bottom, bg.left, BG_TOL) >= BG_MIN) left++;

    const maxRightTrim = Math.min(Math.floor(w * LIMIT), right - left - MIN_EDGE);
    moved = 0;
    while (moved < maxRightTrim && bg.right) {
      const x = right - 1;
      if (x <= left) break;
      if (bgFractionCol(img, x, top, bottom, bg.right, BG_TOL) < BG_MIN) break;
      right = x;
      moved++;
    }

    return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  }

  function isSaneBox(box, w, h) {
    const areaRatio = (box.w * box.h) / (w * h);
    return box.w >= MIN_EDGE && box.h >= MIN_EDGE && areaRatio >= MIN_AREA_RATIO;
  }

  /** 某一行/列是否像“截图查看器的深色底”：颜色几乎一致、且偏暗 */
  function isDarkBandLine(img, box, side, offset) {
    const vertical = side === 'top' || side === 'bottom';
    const dim = vertical ? box.h : box.w;
    if (offset < 0 || offset >= dim) return false;
    const st = lineStats(img, box, side, offset);
    return st.colorFlat >= 0.97 && st.mean < 95;
  }

  /**
   * 从一条边往里扫掉「深色均匀带」。
   * 允许跨过很窄的非深色条（进度条、图标），只要后面仍然是连续深色带——
   * 这样能去掉查看器底/工具栏，又不会把画面里带纹理的深色区域（雪地、黑衣服）裁掉。
   */
  function trimDarkBandsSide(img, box, side) {
    const vertical = side === 'top' || side === 'bottom';
    const dim = vertical ? box.h : box.w;
    const maxTrim = Math.floor(dim * 0.45);
    const gapTol = Math.max(3, Math.round(dim * 0.01));
    const minRun = Math.max(4, Math.round(dim * 0.008));
    let pos = 0;
    while (pos < maxTrim) {
      if (isDarkBandLine(img, box, side, pos)) { pos++; continue; }
      let found = -1;
      for (let g = 1; g <= gapTol; g++) {
        if (!isDarkBandLine(img, box, side, pos + g)) continue;
        let ok = true;
        for (let k = 0; k < minRun; k++) {
          if (!isDarkBandLine(img, box, side, pos + g + k)) { ok = false; break; }
        }
        if (ok) { found = pos + g; break; }
      }
      if (found < 0) break;
      pos = found;
    }
    // 边界处常有 1~4 行“半过渡”的深色行（压缩/抗锯齿造成），一起去掉
    let extra = 0;
    while (pos < maxTrim && extra < 4) {
      const st = lineStats(img, box, side, pos);
      if (st.mean < 35 && st.colorFlat >= 0.6) { pos++; extra++; } else break;
    }
    // 再削掉 1~3 行“明显比画面内部暗”的反锯齿过渡行
    const refOffset = Math.min(maxTrim, pos + 6);
    const refSt = lineStats(img, box, side, refOffset);
    let extra2 = 0;
    while (pos < maxTrim && extra2 < 3) {
      const st = lineStats(img, box, side, pos);
      if (st.mean < refSt.mean * 0.9 && st.mean < 200) { pos++; extra2++; } else break;
    }
    return Math.min(pos, maxTrim);
  }

  function medianColorOfLine(img, axis, fixed, from, to) {
    const w = img.width, d = img.data;
    const step = Math.max(1, Math.floor((to - from) / 120));
    const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
    let n = 0;
    for (let p = from; p < to; p += step) {
      const i = (axis === 'row' ? fixed * w + p : p * w + fixed) * 4;
      if (d[i + 3] < ALPHA_MIN) continue;
      hr[d[i]]++; hg[d[i + 1]]++; hb[d[i + 2]]++;
      n++;
    }
    if (!n) return [0, 0, 0];
    const med = (hist) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc * 2 >= n) return v;
      }
      return 128;
    };
    return [med(hr), med(hg), med(hb)];
  }

  function segmentFlatness(img, axis, start, end, base, crossFrom, crossTo) {
    const w = img.width, d = img.data;
    const alongStep = Math.max(1, Math.floor((end - start) / 40));
    const crossStep = Math.max(1, Math.floor((crossTo - crossFrom) / 80));
    let sum = 0, n = 0;
    for (let a = start; a < end; a += alongStep) {
      for (let c = crossFrom; c < crossTo; c += crossStep) {
        const i = (axis === 'row' ? a * w + c : c * w + a) * 4;
        const dr = d[i] - base[0], dg = d[i + 1] - base[1], db = d[i + 2] - base[2];
        sum += Math.sqrt(dr * dr + dg * dg + db * db);
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  function colorDist(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  /**
   * 把 box 在某个方向上按“主色跳变”切成段，再从两端剥掉“不像画面”的段：
   * 高度很小（工具条）、颜色平坦（黑边/灰底）、或接近纯黑/纯白且纹理少（状态栏/工具栏）。
   * 一旦遇到平坦度高的段落（照片），就停止。
   */
  function trimBySegments(img, box) {
    const w = img.width, h = img.height;
    let top = box.y, bottom = box.y + box.h;
    let left = box.x, right = box.x + box.w;

    // 纵向
    const minSegY = Math.max(6, Math.round((bottom - top) * 0.015));
    const rowMed = [];
    for (let y = top; y < bottom; y++) rowMed.push(medianColorOfLine(img, 'row', y, left, right));
    const rowBounds = [0];
    for (let i = 1; i < rowMed.length; i++) {
      if (colorDist(rowMed[i], rowMed[i - 1]) > 16 && i - rowBounds[rowBounds.length - 1] >= minSegY) {
        rowBounds.push(i);
      }
    }
    rowBounds.push(rowMed.length);
    while (rowBounds.length > 2 && rowBounds[rowBounds.length - 1] - rowBounds[rowBounds.length - 2] < minSegY) {
      rowBounds.splice(rowBounds.length - 2, 1);
    }
    const rowSegs = [];
    for (let i = 0; i < rowBounds.length - 1; i++) {
      const s = rowBounds[i], e = rowBounds[i + 1];
      if (e - s < 2) continue;
      const base = rowMed[Math.min(rowMed.length - 1, Math.floor((s + e) / 2))];
      rowSegs.push({ start: top + s, end: top + e, base, flat: segmentFlatness(img, 'row', top + s, top + e, base, left, right) });
    }
    const dimY = bottom - top;
    // 只把“颜色非常平坦”的段当背景带：画面里的深色区域（雪地、黑衣服）纹理更多，
    // 不能被误当成边框，否则会把画面下半截也裁掉。
    const removableY = (seg) => seg.flat < 5;
    let a = 0, b = rowSegs.length;
    while (b - a > 1 && removableY(rowSegs[b - 1])) b--;
    while (b - a > 1 && removableY(rowSegs[a])) a++;
    if (b > a && rowSegs[b - 1].end - rowSegs[a].start >= dimY * 0.2) {
      top = rowSegs[a].start;
      bottom = rowSegs[b - 1].end;
    }

    // 横向
    const minSegX = Math.max(6, Math.round((right - left) * 0.015));
    const colMed = [];
    for (let x = left; x < right; x++) colMed.push(medianColorOfLine(img, 'col', x, top, bottom));
    const colBounds = [0];
    for (let i = 1; i < colMed.length; i++) {
      if (colorDist(colMed[i], colMed[i - 1]) > 16 && i - colBounds[colBounds.length - 1] >= minSegX) {
        colBounds.push(i);
      }
    }
    colBounds.push(colMed.length);
    while (colBounds.length > 2 && colBounds[colBounds.length - 1] - colBounds[colBounds.length - 2] < minSegX) {
      colBounds.splice(colBounds.length - 2, 1);
    }
    const colSegs = [];
    for (let i = 0; i < colBounds.length - 1; i++) {
      const s = colBounds[i], e = colBounds[i + 1];
      if (e - s < 2) continue;
      const base = colMed[Math.min(colMed.length - 1, Math.floor((s + e) / 2))];
      colSegs.push({ start: left + s, end: left + e, base, flat: segmentFlatness(img, 'col', left + s, left + e, base, top, bottom) });
    }
    const dimX = right - left;
    const removableX = (seg) => seg.flat < 5;
    let c = 0, d2 = colSegs.length;
    while (d2 - c > 1 && removableX(colSegs[d2 - 1])) d2--;
    while (d2 - c > 1 && removableX(colSegs[c])) c++;
    if (d2 > c && colSegs[d2 - 1].end - colSegs[c].start >= dimX * 0.2) {
      left = colSegs[c].start;
      right = colSegs[d2 - 1].end;
    }

    return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  }


  /** 整图内容占比：用来识别“几乎纯色的图”，避免把纯色图裁成小块 */
  function overallContentFraction(img, bg, tol) {
    const w = img.width, h = img.height, d = img.data;
    const stepX = Math.max(1, Math.floor(w / 120));
    const stepY = Math.max(1, Math.floor(h / 120));
    let content = 0, total = 0;
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < ALPHA_MIN) continue;
        total++;
        if (distTo(d, i, bg) > tol) content++;
      }
    }
    return total ? content / total : 0;
  }

  /** 边缘能量加权重心：粗略判断“画面主体在哪” */
  function energyCentroid(img, box) {
    const w = img.width, d = img.data;
    const step = Math.max(1, Math.round(Math.sqrt((box.w * box.h) / 60000)));
    let sx = 0, sy = 0, total = 0;

    for (let y = box.y + step; y < box.y + box.h - step; y += step) {
      for (let x = box.x + step; x < box.x + box.w - step; x += step) {
        const i = (y * w + x) * 4;
        const ir = (y * w + x + step) * 4;
        const il = (y * w + x - step) * 4;
        const iu = ((y - step) * w + x) * 4;
        const id = ((y + step) * w + x) * 4;
        const gx = Math.abs(lumOf(d, ir) - lumOf(d, il));
        const gy = Math.abs(lumOf(d, id) - lumOf(d, iu));
        const e = gx + gy + 1; // +1 防止纯色区域权重为 0
        sx += x * e;
        sy += y * e;
        total += e;
      }
    }
    return total > 0 ? { x: sx / total, y: sy / total } : null;
  }

  /** 在 box 内给出方形裁剪框；smart 会把主体往中心方向拉一点 */
  function squareCrop(box, opts, img) {
    if (!opts.square) return { x: box.x, y: box.y, w: box.w, h: box.h };

    const side = Math.min(box.w, box.h);
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let tx = cx, ty = cy;

    if (opts.mode === 'smart' && img && side > 8) {
      const c = energyCentroid(img, box);
      if (c) {
        // 限制智能构图的最大偏移：宁可接近居中，也不要为了“主体”把画面甩到边角
        const maxShift = side * 0.12;
        tx = cx + clamp((c.x - cx) * 0.6, -maxShift, maxShift);
        ty = cy + clamp((c.y - cy) * 0.6, -maxShift, maxShift);
      }
    }
    const left = clamp(tx - side / 2, box.x, box.x + box.w - side);
    // 0.46：头像构图让主体略偏上，头顶留一点空间
    const top = clamp(ty - side * 0.46, box.y, box.y + box.h - side);
    return { x: Math.round(left), y: Math.round(top), w: side, h: side };
  }

  function detect(img, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const cfg = SENSITIVITY[opts.sensitivity] || SENSITIVITY.standard;
    const w = img.width, h = img.height;

    const result = {
      detected: false,
      trimmed: false,
      trimmedRatio: 0,
      sensitivity: opts.sensitivity,
      square: !!opts.square,
      mode: opts.mode,
      box: { x: 0, y: 0, w: w, h: h },
      crop: null
    };

    if (!w || !h) {
      result.crop = { x: 0, y: 0, w: 0, h: 0 };
      return result;
    }

    let box = { x: 0, y: 0, w, h };
    let hasTrim = false;

    // 纯色图/极简图保护：整张图几乎没有“非底色”内容 → 不裁
    const fullBg = sampleEdge(img, box, 'top');
    if (overallContentFraction(img, fullBg, cfg.colorTol) < 0.015) {
      result.box = box;
      result.crop = squareCrop(box, opts, img);
      return result;
    }

    // 每一侧的模式由整图边缘底色决定：深色（查看器黑/灰底）还是浅色（白底页面）
    const lumOfColor = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const edgeBgs = {
      top: fullBg,
      bottom: sampleEdge(img, box, 'bottom'),
      left: sampleEdge(img, box, 'left'),
      right: sampleEdge(img, box, 'right')
    };
    const modes = {
      top: lumOfColor(edgeBgs.top) > 180 ? 'light' : 'dark',
      bottom: lumOfColor(edgeBgs.bottom) > 180 ? 'light' : 'dark',
      left: lumOfColor(edgeBgs.left) > 180 ? 'light' : 'dark',
      right: lumOfColor(edgeBgs.right) > 180 ? 'light' : 'dark'
    };

    // 逐层去边：第一轮用整图边缘底色；之后如果当前边缘是「纯色带」（黑边/灰底/白边），
    // 就按它重新取底色继续往里裁。这样能处理“状态栏 → 深灰底 → 照片”这种多层结构。
    for (let iter = 0; iter < 4; iter++) {
      const bgs = {};
      let active = false;
      for (const side of ['top', 'bottom', 'left', 'right']) {
        if (iter === 0) {
          bgs[side] = sampleEdge(img, box, side);
          active = true;
        } else {
          const st = lineStats(img, box, side, 0);
          const flatBand = st.colorFlat >= 0.85 &&
            (modes[side] === 'light' ? (st.mean < 130 || st.mean > 180) : st.mean < 130);
          bgs[side] = flatBand ? sampleEdge(img, box, side) : null;
          active = active || flatBand;
        }
      }
      if (iter > 0 && !active) break;

      const t = bgs.top ? trimEdge(img, box, 'top', bgs.top, cfg, modes.top) : 0;
      const b = bgs.bottom ? trimEdge(img, box, 'bottom', bgs.bottom, cfg, modes.bottom) : 0;
      const l = bgs.left ? trimEdge(img, box, 'left', bgs.left, cfg, modes.left) : 0;
      const r = bgs.right ? trimEdge(img, box, 'right', bgs.right, cfg, modes.right) : 0;
      if (iter > 0 && t + b + l + r === 0) break;

      const next = { x: box.x + l, y: box.y + t, w: box.w - l - r, h: box.h - t - b };
      if (!isSaneBox(next, w, h)) break;
      box = next;
      if (t + b + l + r > 0) hasTrim = true;

      // 清掉紧贴边缘的稀疏 UI 条（状态栏/字幕）：底色取被裁掉的那一圈
      if (hasTrim) {
        const extBg = {
          top: box.y > 0 ? lineColor(img, Math.max(0, box.y - 2), 0, w) : null,
          bottom: box.y + box.h < h ? lineColor(img, Math.min(h - 1, box.y + box.h + 1), 0, w) : null,
          left: box.x > 0 ? colColor(img, Math.max(0, box.x - 2), 0, h) : null,
          right: box.x + box.w < w ? colColor(img, Math.min(w - 1, box.x + box.w + 1), 0, h) : null
        };
        const before = { x: box.x, y: box.y, w: box.w, h: box.h };
        box = extendSparse(img, box, extBg, cfg);
        if (box.x !== before.x || box.y !== before.y || box.w !== before.w || box.h !== before.h) {
          hasTrim = true;
        }
      }
    }

    // 收尾：从四边扫掉深色均匀带（查看器的黑/深灰底），允许跨过细进度条
    if (hasTrim && isSaneBox(box, w, h)) {
      const t = trimDarkBandsSide(img, box, 'top');
      const b = trimDarkBandsSide(img, box, 'bottom');
      const l = trimDarkBandsSide(img, box, 'left');
      const r = trimDarkBandsSide(img, box, 'right');
      const tb = { x: box.x + l, y: box.y + t, w: box.w - l - r, h: box.h - t - b };
      if (isSaneBox(tb, w, h)) box = tb;
    }

    if (isSaneBox(box, w, h)) {
      result.detected = true;
      result.trimmed = hasTrim;
      result.trimmedRatio = 1 - (box.w * box.h) / (w * h);
    } else {
      // 误判（裁得太狠）→ 退回整图
      box = { x: 0, y: 0, w: w, h: h };
    }

    result.box = box;
    result.crop = squareCrop(box, opts, img);
    return result;
  }

  root.AutoCrop = {
    version: '0.1.0',
    detect,
    // 方便单测/调试
    _internal: { sampleEdge, edgeFraction, lineStats, trimEdge, energyCentroid, squareCrop, SENSITIVITY }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
