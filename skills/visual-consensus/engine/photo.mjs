import { richHtml } from 'review-kit/editor';
import { fraction, isRange, markName, MAX_PINS } from 'review-kit/model';

const make = (tag,cls) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
};
const pct = value => (value*100)+'%';

// ビューアの青い番号札と半透明の枠を、原画像の座標系で描く。
function drawMarks(ctx, marks) {
  const {width, height} = ctx.canvas;
  const theme = getComputedStyle(document.documentElement);
  const blue = theme.getPropertyValue('--mark').trim();
  // 大きい原画像はビューアの表示寸法に換算する。小さい原画像にも22pxの番号札を確保する。
  const unit = Math.min(Math.max(1, width / 860, height / 480), Math.min(width, height) / 22);
  const radius = 11 * unit;
  ctx.font = '600 ' + (11 * unit) + 'px ' + theme.getPropertyValue('--font').trim();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const mark of marks) {
    const x = mark.x * width, y = mark.y * height;
    if (isRange(mark)) {
      ctx.beginPath();
      ctx.roundRect(x, y, mark.w * width, mark.h * height, 3 * unit);
      ctx.fillStyle = theme.getPropertyValue('--mark-tint');
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.lineWidth = 4 * unit; // 内側の2pxだけを残し、枠の外辺を元の範囲に一致させる。
      ctx.strokeStyle = blue;
      ctx.stroke();
      ctx.restore();
    }

    // 端の印も番号が読めるように収める。番号札を寄せたときは元の点まで線を引く。
    const cx = Math.min(width - radius, Math.max(radius, x));
    const cy = Math.min(height - radius, Math.max(radius, y));
    ctx.lineWidth = 2 * unit;
    if (cx !== x || cy !== y) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(cx, cy);
      ctx.strokeStyle = blue;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, radius - unit, 0, 2 * Math.PI);
    ctx.fillStyle = blue;
    ctx.fill();
    ctx.strokeStyle = theme.getPropertyValue('--sheet');
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(String(mark.number), cx, cy, 16 * unit);
  }
}

/** 原画像の実寸で PNG の Blob を返す。原本を取り込むときは印を省略し、回答用には確定した印を渡す。 */
export async function photoPng(source, marks = []) {
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  if (marks.length) drawMarks(ctx, marks);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw Error('画像を PNG に変換できません');
  return blob;
}

/** ピンは点、範囲は四角と左上の番号で描く。どちらも .rv-mark を最上位に持つ。 */
function marker(mark, interactive) {
  const badge = make(interactive ? 'button' : 'span','rv-pin rv-ui');
  if (interactive) { badge.type = 'button'; badge.setAttribute('aria-label',markName(mark)+'を編集'); }
  else badge.setAttribute('aria-hidden','true');
  badge.textContent = mark.number;
  if (!isRange(mark)) {
    badge.classList.add('rv-mark');
    badge.style.left = pct(mark.x); badge.style.top = pct(mark.y);
    return badge;
  }
  const box = make('span','rv-mark rv-range rv-ui');
  box.style.left = pct(mark.x); box.style.top = pct(mark.y);
  box.style.width = pct(mark.w); box.style.height = pct(mark.h);
  box.append(badge);
  return box;
}

export function drawThumbs(answers, visible, page = document) {
  for (const frame of page.querySelectorAll('[data-thumb]')) {
    frame.querySelectorAll('.rv-mark').forEach(el => el.remove());
    for (const mark of answers.pins[frame.dataset.thumb]?.items ?? []) {
      if (visible(frame.dataset.thumb, mark)) frame.append(marker(mark,false));
    }
  }
}

const MIN_SCALE = 0.25, MAX_SCALE = 8;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

// 印と画像を同じ座標系で拡大・縮小・移動する。タッチ2本指やデスクトップのズーム・パンを共通に扱う。
function photoViewport(stage, canvas, {cancelMark, placing, changed, positionPop}) {
  const fingers = new Map();
  let scale = 1, offsetX = 0, offsetY = 0;
  let panMode = false, spacePan = false, spaceDragged = false;
  let touchNavigating = false, suppressClick = false, pinchMinScale = 1;
  let dragPan = null;

  function stageCenter() {
    const r = stage.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  }

  function syncPanVisual() {
    const active = !placing() && scale > 1 && (panMode || spacePan);
    stage.classList.toggle('pan-mode', active);
    stage.classList.toggle('panning', Boolean(dragPan));
  }

  function transform(from, to, rawScale) {
    let nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, rawScale));
    // 100% に十分近いときは等倍へ揃えて浮動小数点の端数を残さない。
    if (Math.abs(nextScale - 1) < 0.005) nextScale = 1;

    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const ratio = nextScale / scale;
      // 縮小時は中央固定、拡大時は原画像が枠から離れない範囲に収める。
      const limitX = Math.max(0, rect.width / scale * (nextScale - 1) / 2);
      const limitY = Math.max(0, rect.height / scale * (nextScale - 1) / 2);
      offsetX = Math.max(-limitX, Math.min(limitX, offsetX + to.x - cx - (from.x - cx) * ratio));
      offsetY = Math.max(-limitY, Math.min(limitY, offsetY + to.y - cy - (from.y - cy) * ratio));
    } else {
      offsetX = 0;
      offsetY = 0;
    }

    scale = nextScale;
    if (scale <= 1) panMode = false;
    canvas.style.setProperty('--zoom', String(scale));
    canvas.style.transform = scale === 1 && offsetX === 0 && offsetY === 0
      ? '' : `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    stage.classList.toggle('zoomed', scale > 1);
    syncPanVisual();
    changed({scale, panMode, spacePan});
    positionPop();
  }

  function span() {
    const [a, b = a] = fingers.values();
    return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y)};
  }

  function consume(event) {
    event.preventDefault();
    event.stopPropagation();
    suppressClick = true;
  }

  stage.addEventListener('wheel', event => {
    event.preventDefault();
    const dy = event.deltaMode === 1 ? event.deltaY * 16
      : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
    const clamped = Math.max(-180, Math.min(180, dy));
    const factor = Math.exp(-clamped * (event.ctrlKey ? 0.01 : 0.0025));
    const pt = {x: event.clientX, y: event.clientY};
    transform(pt, pt, scale * factor);
  }, {passive: false});

  stage.addEventListener('auxclick', event => {
    if (event.button === 1) event.preventDefault();
  });

  stage.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch') {
      if (!fingers.size) suppressClick = false;
      fingers.set(event.pointerId, {x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY});
      if (fingers.size < 2) return;
      if (!touchNavigating) pinchMinScale = Math.min(1, scale);
      touchNavigating = true;
      cancelMark();
      for (const id of fingers.keys()) stage.setPointerCapture(id);
      consume(event);
      return;
    }

    // マウスは中ボタンドラッグ、または拡大中の移動モード／Space押下中の左ドラッグでパンする。
    const middlePan = event.button === 1 && scale > 1;
    const modePan = event.button === 0 && scale > 1 && (panMode || spacePan) && !placing();
    if (!middlePan && !modePan) return;

    cancelMark();
    dragPan = {pointerId: event.pointerId, x: event.clientX, y: event.clientY};
    if (spacePan) spaceDragged = true;
    stage.setPointerCapture(event.pointerId);
    syncPanVisual();
    event.preventDefault();
    event.stopPropagation();
  }, true);

  stage.addEventListener('pointermove', event => {
    if (dragPan && event.pointerId === dragPan.pointerId) {
      const from = {x: dragPan.x, y: dragPan.y};
      const to = {x: event.clientX, y: event.clientY};
      dragPan.x = to.x;
      dragPan.y = to.y;
      transform(from, to, scale);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const finger = fingers.get(event.pointerId);
    if (!finger) return;
    const before = span();
    finger.x = event.clientX; finger.y = event.clientY;
    if (!touchNavigating && scale > 1 && !placing() && Math.hypot(finger.x - finger.startX, finger.y - finger.startY) >= 6) {
      touchNavigating = true;
      cancelMark();
      stage.setPointerCapture(event.pointerId);
    }
    if (!touchNavigating) return;
    const after = span();
    const nextScale = before.distance && after.distance
      ? Math.max(pinchMinScale, Math.min(MAX_SCALE, scale * after.distance / before.distance)) : scale;
    transform(before, after, nextScale);
    consume(event);
  }, true);

  function release(event) {
    if (dragPan && event.pointerId === dragPan.pointerId) {
      dragPan = null;
      syncPanVisual();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!fingers.delete(event.pointerId)) return;
    if (touchNavigating) consume(event);
    if (!fingers.size) touchNavigating = false;
  }
  stage.addEventListener('pointerup', release, true);
  stage.addEventListener('pointercancel', release, true);
  stage.addEventListener('click', event => {
    if (suppressClick && event.pointerType === 'touch') consume(event);
  }, true);

  return {
    getScale: () => scale,
    isPanMode: () => panMode,
    setPanMode(on) {
      panMode = Boolean(on) && scale > 1;
      syncPanVisual();
      changed({scale, panMode, spacePan});
    },
    setSpacePan(on) {
      const next = Boolean(on);
      if (spacePan === next) return false;
      const dragged = spaceDragged;
      spacePan = next;
      if (next) spaceDragged = false;
      syncPanVisual();
      return dragged;
    },
    zoomByStep(direction) {
      const next = direction > 0
        ? ZOOM_STEPS.find(step => step > scale + 0.01) ?? MAX_SCALE
        : [...ZOOM_STEPS].reverse().find(step => step < scale - 0.01) ?? MIN_SCALE;
      const center = stageCenter();
      transform(center, center, next);
    },
    clamp() {
      const center = stageCenter();
      transform(center, center, scale);
    },
    reset() {
      fingers.clear();
      dragPan = null;
      panMode = spacePan = spaceDragged = touchNavigating = suppressClick = false;
      pinchMinScale = 1;
      offsetX = offsetY = 0;
      cancelMark();
      transform({x: 0, y: 0}, {x: 0, y: 0}, 1);
    },
  };
}

/** 画像だけを囲む枠を座標系とする。余白・見出し・縮尺を変えても同じ位置を指す。
 * 返した関数に印の番号を渡すと、その印の編集を開く。最後の edit を false にすると対応済みの要約から開く。 */
export function photoViewer(store, changed, describe, hooks) {
  const modal = make('dialog','photo-zoom rv-dialog rv-fullscreen rv-ui');
  modal.setAttribute('aria-labelledby','rv-photo-title');
  modal.innerHTML = '<header><h2 id="rv-photo-title"></h2>'
    +'<div class="rv-header-actions">'
    +'<div class="rv-zoom-controls" role="group" aria-label="表示倍率">'
    +'<button type="button" data-zoom-out aria-label="縮小" data-tip="縮小">−</button>'
    +'<button type="button" data-zoom-reset aria-label="表示倍率を100%に戻す" data-tip="100%に戻す">100%</button>'
    +'<button type="button" data-zoom-in aria-label="拡大" data-tip="拡大">＋</button>'
    +'</div>'
    +'<button type="button" data-pan-toggle aria-pressed="false" data-tip="拡大中にドラッグで画像を移動" disabled>移動</button>'
    +'<button type="button" data-fullscreen-toggle aria-pressed="true" data-tip="標準サイズに切り替える">標準サイズ</button>'
    +'<button type="button" data-close>閉じる</button></div></header>'
    +'<div class="rv-body"><div class="rv-workspace">'
    +'<div class="rv-stage"><div class="rv-canvas" tabindex="0"><img alt="" draggable="false"></div></div>'
    +'<div class="rv-pin-tools"><span class="rv-pin-hint" role="status"></span><button type="button" data-cancel hidden>取り消す</button></div>'
    +'</div><aside class="rv-side"><p class="rv-photo-caption"></p>'
    +'<div data-photo-description></div>'
    +'<ol class="rv-pin-list" aria-label="画像の印"></ol></aside></div>'
    +'<div class="rv-pop" role="group" hidden></div>';
  document.body.append(modal);
  const stage = modal.querySelector('.rv-stage');
  const canvas = modal.querySelector('.rv-canvas'), image = canvas.querySelector('img');
  const title = modal.querySelector('h2'), caption = modal.querySelector('.rv-photo-caption');
  const cancel = modal.querySelector('[data-cancel]'), hint = modal.querySelector('.rv-pin-hint'), list = modal.querySelector('ol');
  const pop = modal.querySelector('.rv-pop');
  const description = modal.querySelector('[data-photo-description]');
  const zoomOutBtn = modal.querySelector('[data-zoom-out]');
  const zoomResetBtn = modal.querySelector('[data-zoom-reset]');
  const zoomInBtn = modal.querySelector('[data-zoom-in]');
  const panToggle = modal.querySelector('[data-pan-toggle]');
  const fullscreenToggle = modal.querySelector('[data-fullscreen-toggle]');
  const touch = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
  const markHint = touch ? 'タップでピン、なぞると範囲を指定できます。' : 'クリックでピン、ドラッグで範囲を指定できます。';
  let idleHint;
  function updateViewportUI({scale, panMode}) {
    const zoomed = scale > 1;
    const percent = Math.round(scale * 100) + '%';
    zoomResetBtn.textContent = percent;
    zoomResetBtn.disabled = scale === 1;
    zoomOutBtn.disabled = scale <= MIN_SCALE;
    zoomInBtn.disabled = scale >= MAX_SCALE;
    panToggle.disabled = !zoomed;
    panToggle.setAttribute('aria-pressed', String(panMode));

    const instruction = touch && zoomed ? 'タップでピン、なぞると画像を移動できます。'
      : !touch && panMode ? 'ドラッグで画像を移動できます。' : markHint;
    const zoomNote = touch ? '2本指で広げる・縮めると倍率を変えられます。' : 'ホイールや右上のボタンで拡大・縮小できます。';
    idleHint = instruction + zoomNote + '印を押すと一言を書けます。移動と削除は一覧で行えます。';
    canvas.setAttribute('aria-label', '画像。' + instruction + 'Enterでキーボードからピンを立てる');
    if (!armed) hint.textContent = idleHint;
  }

  function setFullscreen(on) {
    modal.classList.toggle('rv-fullscreen', on);
    fullscreenToggle.setAttribute('aria-pressed', String(on));
    fullscreenToggle.textContent = on ? '標準サイズ' : '全画面';
    fullscreenToggle.dataset.tip = on ? '標準サイズに切り替える' : '全画面で広く表示する';
    if (modal.open) requestAnimationFrame(() => viewport.clamp());
  }

  let key, armed = false, moving = null, cursor = null, popMark = null, drag = null;
  const viewport = photoViewport(stage, canvas, {
    cancelMark() { drag?.box?.remove(); drag = null; },
    placing: () => armed,
    changed: updateViewportUI,
    positionPop,
  });
  updateViewportUI({scale: 1, panMode: false});
  zoomOutBtn.onclick = () => viewport.zoomByStep(-1);
  zoomInBtn.onclick = () => viewport.zoomByStep(1);
  zoomResetBtn.onclick = () => viewport.reset();
  panToggle.onclick = () => viewport.setPanMode(!viewport.isPanMode());
  fullscreenToggle.onclick = () => setFullscreen(!modal.classList.contains('rv-fullscreen'));
  const group = () => store.answers.pins[key];
  function summary(button,mark) {
    const badge=make('em'), words=make('span');
    badge.textContent=markName(mark);
    words.innerHTML=richHtml(mark.comment.trim() || '一言なし', id => store.media[id], id => store.answers.attachments[id]?.name ?? '');
    button.replaceChildren(badge,words);
  }
  const badgeOf = n => canvas.querySelector('button.rv-pin[data-n="'+n+'"]');


  function point(event) {
    const r = image.getBoundingClientRect();
    return {x:fraction((event.clientX-r.left)/r.width), y:fraction((event.clientY-r.top)/r.height), px:event.clientX, py:event.clientY};
  }

  /** 位置を変えるときと、キーボードで置くときだけ照準を出す。 */
  function arm(on, mark = null) {
    if (on) { closePop(); viewport.setPanMode(false); }
    armed = on; moving = mark; cursor?.remove(); cursor = null;
    modal.classList.toggle('rv-placing', on);
    cancel.hidden = !on;
    hint.textContent = !on ? idleHint
      : mark && isRange(mark) ? markName(mark) + (touch ? 'の新しい位置をタップ。なぞると範囲を描き直せます。' : 'の新しい位置をクリック。ドラッグすると範囲を描き直せます。')
      : mark ? markName(mark)+'の新しい位置を選んでください。'
      : 'ピンを置く位置を選んでください。';
    if (on) {
      cursor = marker({number:mark?.number ?? '+', x:mark?.x ?? 0.5, y:mark?.y ?? 0.5},false);
      cursor.classList.add('rv-cursor'); canvas.append(cursor);
      canvas.focus({preventScroll:true});
    }
  }

  /** 印の横に一言と操作を出す。画面の下の一覧まで移動せずに直せる。 */
  function openPop(mark, cursor, edit = false, fresh = false) {
    const badge = badgeOf(mark.number);
    if (!badge) return;
    if (popMark) closePop();
    popMark = mark; pop.hidden = false;
    list.querySelector(`[data-show-mark="${mark.number}"]`).closest('li').classList.add('editing-mark');
    const conversation = make('div', 'review-item');
    conversation.innerHTML = '<div data-pop-text></div>';
    pop.replaceChildren(conversation);
    pop.setAttribute('aria-label', markName(mark) + 'の一言');
    hooks.opened(key, mark.number, fresh);
    hooks.markThread(conversation, key, mark);

    const fold = conversation.querySelector('.resolved-item');
    function editComment() {
      hooks.editPin(conversation.querySelector('[data-pop-text]'), key, mark,
        () => { closePop(); hooks.refresh(); canvas.focus({preventScroll: true}); }, cursor,
        () => summary(list.querySelector(`[data-show-mark="${mark.number}"]`), mark), fresh ? () => remove(mark) : null);
    }
    // 印からは要約を開き、元のコメントや下書きから来た場合はそのまま編集を続ける。
    if (fold && !edit) {
      fold.querySelector('summary').focus({preventScroll: true});
      fold.addEventListener('toggle', function onOpen() {
        if (!fold.open || !conversation.isConnected) return;
        fold.removeEventListener('toggle', onOpen);
        editComment();
      });
    } else {
      if (fold) fold.open = true;
      editComment();
    }
    positionPop();
  }
  function positionPop() {
    if (!popMark || pop.hidden) return;
    const mark=popMark, badge=badgeOf(mark.number);
    if (!badge) return;
    const anchor = (isRange(mark) ? badge.parentElement : badge).getBoundingClientRect();
    const m = modal.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    const stageBox = stage.getBoundingClientRect();
    // 2カラム全画面ではステージ領域の幅内に優先配置し、右の一覧を隠さない。
    const areaRight = stageBox.right < m.right - 20 ? Math.max(stageBox.right - m.left, w + 16) : m.width;
    let left = anchor.left - m.left + anchor.width/2 - w/2;
    let top = anchor.bottom - m.top + modal.scrollTop + 8;
    left = Math.max(8, Math.min(left, areaRight - w - 8));
    if (anchor.bottom + h + 16 > Math.min(m.bottom, innerHeight)) top = anchor.top - m.top + modal.scrollTop - h - 8;
    const minTop = modal.scrollTop + 8;
    const maxTop = modal.scrollTop + Math.max(8, modal.clientHeight - h - 8);
    pop.style.left = left+'px'; pop.style.top = Math.max(minTop, Math.min(top, maxTop))+'px';
    canvas.querySelectorAll('.rv-mark').forEach(el => el.classList.toggle('rv-active', el.contains(badge)));

  }
  function closePop() {
    if (popMark) hooks.leavePin(key,popMark.number);
    list.querySelector('.editing-mark')?.classList.remove('editing-mark');
    popMark = null; pop.hidden = true;
    pop.replaceChildren();
    if (modal.open) hooks.opened(key,null);
    canvas.querySelectorAll('.rv-active').forEach(el => el.classList.remove('rv-active'));
  }
  function remove(mark) {
    arm(false); closePop();
    group().items = group().items.filter(p => p.number !== mark.number);
    changed(); render(); canvas.focus({preventScroll:true});
  }
  new ResizeObserver(positionPop).observe(pop);
  new ResizeObserver(() => { if (modal.open) viewport.clamp(); }).observe(stage);


  function render() {
    canvas.querySelectorAll('.rv-mark:not(.rv-cursor)').forEach(el => el.remove());
    list.replaceChildren();
    for (const mark of group()?.items ?? []) {
      if (!hooks.markVisible(key, mark)) continue;
      const el = marker(mark,true), badge = el.matches('button') ? el : el.querySelector('button');
      badge.dataset.n = mark.number;
      badge.onpointerdown = event => event.stopPropagation();
      badge.onclick = event => { event.stopPropagation(); popMark === mark ? closePop() : openPop(mark); };
      badge.onkeydown = event => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(mark); } };
      canvas.append(el);
      const item = make('li');
      const button = make('button', 'mk rv-pin-summary');
      button.type = 'button';
      button.dataset.showMark = mark.number;
      summary(button,mark);
      button.onclick = () => {
        arm(false);
        badge.scrollIntoView({block:'nearest'});
        openPop(mark, undefined, true);
      };
      const comment = make('div', 'review-comment');
      const actions = make('span', 'mark-actions');
      const move = make('button', 'text-button'), erase = make('button', 'text-button');
      move.type = erase.type = 'button';
      move.dataset.moveMark = erase.dataset.deleteMark = mark.number;
      move.textContent = '移動';
      erase.textContent = '削除';
      move.setAttribute('aria-label', markName(mark) + 'を移動');
      erase.setAttribute('aria-label', markName(mark) + 'を削除');
      move.onclick = () => { arm(true, mark); badge.scrollIntoView({block: 'nearest'}); };
      erase.onclick = () => remove(mark);
      actions.append(move, erase);
      comment.append(button, actions);
      item.append(comment);
      hooks.markThread(item, key, mark);
      list.append(item);
    }
  }

  /** 点を置く。range があれば範囲として置く。移動中の印は、点なら移し、範囲なら大きさを保って中心を移す。 */
  function put(x, y, range = null) {
    const g = store.answers.pins[key] ??= {next:1, items:[]};
    // 新しい印は、今ある印の最大の番号の次にする。末尾の印を消して置き直すと、同じ番号に戻る。
    let number = g.items.reduce((top, p) => Math.max(top, p.number), 0) + 1;
    // 返事が付いた番号は、新しい別の印にその会話を引き継がせない。
    while (hooks.hasMarkReply(key, number)) number++;
    if (!moving && number >= Number.MAX_SAFE_INTEGER) { arm(false); hint.textContent='この画像の印の番号を使い切りました。'; return; }
    if (!moving && g.items.length >= MAX_PINS) { arm(false); hint.textContent='この画像には100件まで印を置けます。'; return; }
    const fresh = !moving;
    let mark = moving;
    if (!mark) {
      mark = range ? {number, x:0, y:0, w:0, h:0, comment:''} : {number, x:0, y:0, comment:''};
      g.next = Math.max(g.next, number + 1);
      g.items.push(mark);
    }
    if (isRange(mark) && range) Object.assign(mark, range);
    else if (isRange(mark)) { mark.x = fraction(Math.min(1-mark.w, Math.max(0, x-mark.w/2))); mark.y = fraction(Math.min(1-mark.h, Math.max(0, y-mark.h/2))); }
    else { mark.x = x; mark.y = y; }
    arm(false); changed(); render(); openPop(mark, undefined, true, fresh);
  }

  cancel.onclick = () => arm(false);
  canvas.onpointerdown = event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault();
    drag = {start:point(event), box:null};
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = event => {
    if (!drag) return;
    const now = point(event), s = drag.start;
    if (!drag.box && Math.hypot(now.px-s.px, now.py-s.py) < 6) return;
    drag.range = {x:Math.min(s.x,now.x), y:Math.min(s.y,now.y), w:fraction(Math.abs(now.x-s.x)), h:fraction(Math.abs(now.y-s.y))};
    drag.box?.remove();
    drag.box = marker({number:'', ...drag.range}, false);
    drag.box.classList.add('rv-draft'); canvas.append(drag.box);
  };
  canvas.onpointerup = event => {
    if (!drag) return;
    const {start, box, range} = drag; drag = null;
    box?.remove();
    // 移動中のピンは点のまま扱う。小さすぎる四角はクリックとみなす。
    if (range && range.w > 0.01 && range.h > 0.01 && !(moving && !isRange(moving))) put(range.x, range.y, range);
    else { const end = point(event); put(range ? end.x : start.x, range ? end.y : start.y); }
  };
  canvas.onpointercancel = () => { drag?.box?.remove(); drag = null; };
  canvas.onkeydown = event => {
    if (!armed) {
      if (event.target === canvas && event.key === 'Enter') { event.preventDefault(); arm(true); }
      return;
    }
    let x=parseFloat(cursor.style.left)/100, y=parseFloat(cursor.style.top)/100;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (moving && isRange(moving)) put(x+moving.w/2, y+moving.h/2); else put(x,y);
      return;
    }
    const step = event.shiftKey ? 0.1 : 0.01;
    const dx = {ArrowLeft:-step,ArrowRight:step}, dy = {ArrowUp:-step,ArrowDown:step};
    if (!(event.key in dx || event.key in dy)) return;
    event.preventDefault();
    cursor.style.left = pct(fraction(x+(dx[event.key] ?? 0)));
    cursor.style.top = pct(fraction(y+(dy[event.key] ?? 0)));
  };
  modal.querySelector('[data-close]').onclick=()=>modal.close();
  modal.addEventListener('close',()=>{ viewport.setSpacePan(false); arm(false); closePop(); hooks.closed(); hooks.refresh(); });
  // Edge の連続した Escape は、取り消せない dialog.cancel になる場合がある。
  // 内側の編集を閉じるキーは dialog の既定動作より先に扱う。
  modal.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && (armed || popMark)) {
      event.preventDefault();
      if (armed) arm(false);
      else closePop();
      canvas.focus({preventScroll: true});
      return;
    }
    if (event.target.closest('input, textarea, [contenteditable]')) return;
    if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
      event.preventDefault(); viewport.zoomByStep(1);
    } else if (event.key === '-' || event.code === 'NumpadSubtract') {
      event.preventDefault(); viewport.zoomByStep(-1);
    } else if (event.key === '0' || event.code === 'Numpad0') {
      event.preventDefault(); viewport.reset();
    } else if (event.key === ' ' && !armed && !event.target.closest('button, a')) {
      event.preventDefault();
      if (!event.repeat) viewport.setSpacePan(true);
    }
  });
  modal.addEventListener('keyup', event => {
    if (event.key !== ' ') return;
    const dragged = viewport.setSpacePan(false);
    if (!dragged && !armed && event.target === canvas) arm(true);
  });
  modal.addEventListener('cancel',event=>{
    if (armed) { event.preventDefault(); arm(false); }
    else if (popMark) { event.preventDefault(); closePop(); canvas.focus({preventScroll:true}); }
  });
  modal.onclick=event=>{
    if (popMark && !event.target.closest('.rv-pop,.rv-mark,.rv-canvas,.rv-pin-summary')) closePop();
    if (event.target === modal) {
      const r=modal.getBoundingClientRect();
      if (event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom) modal.close();
    }
  };
  return (id,src,alt,number,cursor,edit = true,fresh = false) => {
    key=id;
    setFullscreen(true);
    viewport.reset();
    const picture = describe(store.answers,id);
    const isIssue=picture.issue===true;
    const attachment = store.answers.attachments[id];
    title.textContent = attachment ? attachment.name || '追加した画像' : isIssue ? '指摘 '+id : picture.title;
    const detail=isIssue ? picture.title : alt && alt!==title.textContent ? alt : '';
    caption.replaceChildren(detail);
    if (!isIssue && !attachment) {
      const tag = make('span','id'); tag.textContent = id;
      caption.prepend(tag);
    }
    image.alt=attachment ? title.textContent : alt || picture.title;
    hooks.description(description,id);
    image.onload=()=>{
      canvas.style.setProperty('--ratio',image.naturalWidth/image.naturalHeight);
      // 小さな切り抜きを引き伸ばしすぎない。2倍までにとどめる。
      canvas.style.setProperty('--max-w',image.naturalWidth*2+'px');
      const selected = group()?.items.find(item => item.number === number);
      if (selected) requestAnimationFrame(() => { if (modal.open && key === id) openPop(selected, cursor, edit, fresh); });
    };
    image.src=src;
    arm(false); closePop(); render(); modal.showModal(); hooks.opened(id,number || null,fresh); modal.querySelector('[data-close]').focus();
  };
}
