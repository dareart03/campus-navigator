import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY, LIMITS, toScreen, toMap, zoomAbout, rotateAbout, pinch, pan, clampView, labelScale } from '../viewmath.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const nearPt = (p, q) => { near(p.x, q.x); near(p.y, q.y); };

test('toMap — обратное к toScreen при любом масштабе и повороте', () => {
    const v = { s: 2.5, r: 0.7, tx: 30, ty: -12 };
    const p = { x: 123, y: 45 };
    nearPt(toMap(v, toScreen(v, p)), p);
});

test('масштабирование вокруг точки: точка под пальцем остаётся на месте', () => {
    const anchor = { x: 200, y: 150 };
    const v = { s: 1.5, r: 0.3, tx: 10, ty: 20 };
    const before = toMap(v, anchor);
    const z = zoomAbout(v, anchor, 2);
    near(z.s, 3);
    nearPt(toScreen(z, before), anchor);
});

test('масштаб ограничен пределами', () => {
    const a = { x: 0, y: 0 };
    assert.equal(zoomAbout(IDENTITY, a, 1000).s, LIMITS.maxScale);
    assert.equal(zoomAbout(IDENTITY, a, 0.001).s, LIMITS.minScale);
});

test('поворот вокруг точки: точка под пальцем остаётся на месте', () => {
    const anchor = { x: 100, y: 80 };
    const v = { s: 2, r: 0, tx: 5, ty: 5 };
    const before = toMap(v, anchor);
    const r = rotateAbout(v, anchor, Math.PI / 2);
    near(r.r, Math.PI / 2);
    nearPt(toScreen(r, before), anchor);
});

test('щипок: пальцы раздвинулись вдвое — масштаб ×2, точка между пальцами на месте', () => {
    const a = { x: 100, y: 100, d: 50, ang: 0 };
    const b = { x: 100, y: 100, d: 100, ang: 0 };
    const v = { s: 1, r: 0, tx: 0, ty: 0 };
    const p = toMap(v, a);
    const out = pinch(v, a, b);
    near(out.s, 2);
    nearPt(toScreen(out, p), b);
});

test('щипок: поворот линии между пальцами поворачивает карту на тот же угол', () => {
    const a = { x: 50, y: 50, d: 80, ang: 0 };
    const b = { x: 50, y: 50, d: 80, ang: 0.5 };
    const out = pinch(IDENTITY, a, b);
    near(out.r, 0.5);
    near(out.s, 1);
});

test('щипок: движение середины двигает карту (сдвиг двумя пальцами)', () => {
    const v = { s: 2, r: 0, tx: 0, ty: 0 };
    const a = { x: 100, y: 100, d: 60, ang: 0 };
    const b = { x: 130, y: 90, d: 60, ang: 0 };
    const p = toMap(v, a);
    nearPt(toScreen(pinch(v, a, b), p), b);
});

test('щипок с нулевым расстоянием между пальцами не ломает вид (нет деления на ноль)', () => {
    const v = { s: 2, r: 0, tx: 3, ty: 4 };
    assert.deepEqual(pinch(v, { x: 0, y: 0, d: 0, ang: 0 }, { x: 5, y: 5, d: 10, ang: 1 }), v);
});

test('при масштабе 1 карту почти нельзя унести за пределы экрана, при увеличении — можно двигать', () => {
    const W = 400, H = 500;
    const far = clampView(pan(IDENTITY, 1000, 1000), W, H);
    assert.ok(far.tx <= 24 && far.ty <= 24);

    const zoomed = clampView({ s: 4, r: 0, tx: -600, ty: -700 }, W, H);
    assert.equal(zoomed.tx, -600);          // в пределах допустимого — не трогаем
    assert.equal(zoomed.ty, -700);

    const lost = clampView({ s: 4, r: 0, tx: -5000, ty: 5000 }, W, H);
    const centre = toScreen(lost, { x: W / 2, y: H / 2 });
    assert.ok(centre.x >= W / 2 - 3 * W / 2 - 24 - 1e-6 && centre.y <= H / 2 + 3 * H / 2 + 24 + 1e-6);
});

test('карта меньше экрана по высоте: её нельзя утащить за пределы, но и не «приклеена» намертво', () => {
    const W = 400, H = 600, cw = 400, ch = 250;          // карта широкая и низкая
    const v = clampView({ s: 1, r: 0, tx: 0, ty: 500 }, W, H, { cw, ch });
    assert.ok(v.ty <= 24 + 1e-9);
    const zoomed = clampView({ s: 4, r: 0, tx: 0, ty: -5000 }, W, H, { cw, ch });
    // при s=4 высота карты 1000 > 600, значит можно доехать до её краёв, но не дальше
    assert.ok(Math.abs(toScreen(zoomed, { x: W / 2, y: H / 2 }).y - H / 2) <= (4 * ch - H) / 2 + 24 + 1e-6);
});

test('подписи: мелкие увеличиваются, но не больше чем вдвое; крупные уменьшаются; нормальные не трогаем', () => {
    near(labelScale(1, 0.6), 12 / 9);       // 9px -> до 12px
    assert.equal(labelScale(1, 0.1), 2);    // совсем мелкие: лимит ×2
    near(labelScale(4, 0.6), 22 / 36);      // 36px -> до 22px
    assert.equal(labelScale(1, 1), 1);      // 15px: уже читаются
    assert.ok(labelScale(8, 5) >= 0.4);     // нижняя граница
});