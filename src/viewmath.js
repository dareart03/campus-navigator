// Математика вида карты (масштаб, поворот, сдвиг). Без DOM, поэтому тестируется в Node.
//
// Вид v = { s, r, tx, ty }: точка карты p попадает на экран в
//     screen = (tx, ty) + s · R(r) · p        (R — поворот на угол r, радианы)
// Координаты карты и экрана — в пикселях контейнера: (0,0) — левый верхний угол.

export const LIMITS = { minScale: 1, maxScale: 8 };
export const IDENTITY = Object.freeze({ s: 1, r: 0, tx: 0, ty: 0 });

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function toScreen(v, p) {
    const c = Math.cos(v.r), s = Math.sin(v.r);
    return { x: v.tx + v.s * (c * p.x - s * p.y), y: v.ty + v.s * (s * p.x + c * p.y) };
}

export function toMap(v, q) {
    const c = Math.cos(v.r), s = Math.sin(v.r);
    const x = (q.x - v.tx) / v.s, y = (q.y - v.ty) / v.s;
    return { x: c * x + s * y, y: -s * x + c * y };
}

// Новый вид так, чтобы точка карты под `anchor` (экранная точка) осталась под ней же.
function keepUnder(v, anchor, s, r) {
    const p = toMap(v, anchor);
    const c = Math.cos(r), sn = Math.sin(r);
    return { s, r, tx: anchor.x - s * (c * p.x - sn * p.y), ty: anchor.y - s * (sn * p.x + c * p.y) };
}

// Масштабирование в `factor` раз вокруг экранной точки (колесо, двойное нажатие).
export function zoomAbout(v, anchor, factor) {
    return keepUnder(v, anchor, clamp(v.s * factor, LIMITS.minScale, LIMITS.maxScale), v.r);
}

// Поворот на `dr` радиан вокруг экранной точки.
export function rotateAbout(v, anchor, dr) {
    return keepUnder(v, anchor, v.s, v.r + dr);
}

// Жест двумя пальцами. a, b — предыдущее и текущее состояние пальцев:
// { x, y } — середина между пальцами, d — расстояние, ang — угол линии между ними.
// Масштаб — по отношению расстояний, поворот — по разнице углов, сдвиг — по движению середины.
export function pinch(v, a, b) {
    if (a.d < 1) return v;
    const s = clamp(v.s * (b.d / a.d), LIMITS.minScale, LIMITS.maxScale);
    const p = toMap(v, a);
    const r = v.r + (b.ang - a.ang);
    const c = Math.cos(r), sn = Math.sin(r);
    return { s, r, tx: b.x - s * (c * p.x - sn * p.y), ty: b.y - s * (sn * p.x + c * p.y) };
}

export function pan(v, dx, dy) {
    return { ...v, tx: v.tx + dx, ty: v.ty + dy };
}

// Карту нельзя «потерять». Центр карты может уйти от центра экрана не дальше, чем нужно, чтобы доехать
// до её краёв: (s·ширина_карты − ширина_экрана)/2 по x (и так же по y), плюс небольшой запас.
// cw, ch — размер самой карты на экране при масштабе 1 (она вписана в контейнер с полями, поэтому может быть меньше W×H).
export function clampView(v, W, H, { cw = W, ch = H, slack = 24 } = {}) {
    const s = clamp(v.s, LIMITS.minScale, LIMITS.maxScale);
    const centre = toScreen({ ...v, s }, { x: W / 2, y: H / 2 });
    const rx = Math.max(0, (s * cw - W) / 2) + slack, ry = Math.max(0, (s * ch - H) / 2) + slack;
    const cx = clamp(centre.x, W / 2 - rx, W / 2 + rx);
    const cy = clamp(centre.y, H / 2 - ry, H / 2 + ry);
    return { s, r: v.r, tx: v.tx + (cx - centre.x), ty: v.ty + (cy - centre.y) };
}

// Множитель размера подписей, чтобы цифры были читаемы при любом масштабе.
// fit — во сколько раз карта вписана в экран (px на единицу SVG), glyph — высота цифр в единицах SVG.
// Подпись на экране держим в пределах [minPx, maxPx] пикселей (но не увеличиваем больше чем в maxGrow раз).
export function labelScale(zoom, fit, { glyph = 15, minPx = 12, maxPx = 22, maxGrow = 2 } = {}) {
    const px = glyph * fit * zoom;
    if (px < minPx) return Math.min(minPx / px, maxGrow);
    if (px > maxPx) return Math.max(maxPx / px, 0.4);
    return 1;
}
