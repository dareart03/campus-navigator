import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize360, angleDiff, smoothHeading, approachHeading, compassHeading, headingFromEvent, mapRotation, wrapPi, sanitizeOffset } from '../src/compass.js';
import { zoomAbout, rotateAbout, toScreen } from '../src/viewmath.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('normalize360 и angleDiff: переход через 0°/360° идёт короткой дорогой', () => {
    near(normalize360(-10), 350); near(normalize360(370), 10); near(normalize360(360), 0);
    near(angleDiff(1, 359), 2); near(angleDiff(359, 1), -2); near(angleDiff(90, 0), 90); near(angleDiff(180, 0), 180); near(angleDiff(0, 180), 180);
});

test('smoothHeading: сглаживает по кругу — между 359° и 1° получается около 0°, а не 180°', () => {
    near(smoothHeading(null, 123), 123);
    const h = smoothHeading(359, 1, 0.5);
    assert.ok(h < 1 || h > 359, `h=${h}`);
    near(smoothHeading(10, 30, 0.25), 15);
    let cur = 0; for (let i = 0; i < 60; i++) cur = smoothHeading(cur, 200);   // сходится к цели
    near(cur, 200, 0.5);
});

test('compassHeading: телефон лежит экраном вверх — направление верхнего края', () => {
    near(compassHeading(0, 0, 0), 0);
    near(compassHeading(90, 0, 0), 270);      // повернули против часовой на 90° → смотрим на запад
    near(compassHeading(270, 0, 0), 90);
    near(compassHeading(180, 0, 0), 180);
});

test('compassHeading: телефон держат вертикально — направление, куда смотрит задняя камера', () => {
    near(compassHeading(0, 90, 0), 0);
    near(compassHeading(90, 90, 0), 270);
    near(compassHeading(180, 90, 0), 180);
});

test('compassHeading: наклон между «лежит» и «вертикально» не даёт скачка направления', () => {
    let prev = null;
    for (let beta = 0; beta <= 90; beta += 5) {              // поднимаем телефон с ладони до вертикали, смотрим на 40°
        const h = compassHeading(320, beta, 0);               // alpha 320° = смотрим на 40°
        near(h, 40, 1e-6);
        if (prev !== null) near(h, prev, 1e-6);
        prev = h;
    }
});

test('headingFromEvent: iOS — готовое направление, Android — из углов, пустое событие — null', () => {
    near(headingFromEvent({ webkitCompassHeading: 45, alpha: 10 }), 45);
    near(headingFromEvent({ alpha: 270, beta: 0, gamma: 0 }), 90);
    assert.equal(headingFromEvent({ alpha: null, beta: null, gamma: null }), null);
    assert.equal(headingFromEvent({}), null);
});

test('mapRotation: смотрим туда же, куда «вверх» плана — поворота нет; повернулись по часовой — карта против часовой', () => {
    near(mapRotation(30, 30), 0);
    near(mapRotation(120, 30), -Math.PI / 2);
    near(mapRotation(0, 90), Math.PI / 2);
    near(mapRotation(359, 1), 2 * Math.PI / 180);
});

test('поворот карты по компасу действительно ставит направление взгляда «вверх» экрана', () => {
    // «Вверх» плана смотрит на 30°. Человек смотрит на 120° (на 90° правее). Точка плана, лежащая по ходу его взгляда
    // (на 90° по часовой от «вверх» плана, т. е. вправо от центра), должна оказаться на экране сверху от центра.
    const center = { x: 200, y: 150 };
    let v = { s: 1, r: 0, tx: 0, ty: 0 };
    v = rotateAbout(v, center, wrapPi(mapRotation(120, 30) - v.r));
    const ahead = toScreen(v, { x: center.x + 100, y: center.y });
    near(ahead.x, center.x, 1e-6);
    assert.ok(ahead.y < center.y - 99, `y=${ahead.y}`);
});

test('wrapPi: кратчайший путь поворота', () => {
    near(wrapPi(3 * Math.PI / 2), -Math.PI / 2); near(wrapPi(-3 * Math.PI / 2), Math.PI / 2); near(wrapPi(0.3), 0.3);
});

test('sanitizeOffset: мусор из хранилища — это «нет калибровки»', () => {
    near(sanitizeOffset(-30), 330); near(sanitizeOffset('45'), 45);
    for (const bad of [null, undefined, 'abc', NaN, Infinity, {}, []]) assert.equal(sanitizeOffset(bad), 0, String(bad));
});

test('approachHeading: результат зависит от прошедшего времени, а не от числа вызовов', () => {
    near(approachHeading(null, 77, 16), 77);
    // один шаг в 500 мс и 30 шагов по 16,7 мс приводят почти в одно место
    const once = approachHeading(0, 90, 500);
    let many = 0; for (let i = 0; i < 30; i++) many = approachHeading(many, 90, 500 / 30);
    near(once, many, 1e-6);
    assert.ok(once > 80 && once < 90, `once=${once}`);
    near(approachHeading(10, 90, 0), 10);                  // время не прошло — не сдвинулись
    near(approachHeading(350, 10, 1e6), 10, 1e-6);         // много времени — дошли, через 0°
});
