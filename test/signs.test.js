import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toGray, binarize, stretchContrast, findTextLines, darkMask, components, looksLikeDigit, groupDigits, findNumberRegions, numbersIn, roomNumberIndex, pickRoomNumber } from '../src/signs.js';

const graph = JSON.parse(readFileSync(new URL('../data/data.json', import.meta.url), 'utf8'));
const rooms = roomNumberIndex(graph.nodes);

// Искусственное «фото»: светлый фон и тёмные прямоугольники-«цифры» (контур с дыркой, как у настоящей цифры)
function photo(width, height, glyphs) {
    const gray = new Uint8Array(width * height).fill(200);
    for (const { x, y, w, h } of glyphs) {
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
            const edge = i < 4 || j < 4 || i >= w - 4 || j >= h - 4;
            if (edge) gray[(y + j) * width + x + i] = 20;
        }
    }
    return gray;
}
const row = (x, y, count, w = 22, h = 34, gap = 8) =>
    Array.from({ length: count }, (_, k) => ({ x: x + k * (w + gap), y, w, h }));

test('toGray: белое остаётся светлым, чёрное тёмным', () => {
    const g = toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1);
    assert.ok(g[0] > 250);
    assert.equal(g[1], 0);
});

test('darkMask: помечает только тёмное на светлом, ровный фон — нет', () => {
    const flat = new Uint8Array(50 * 50).fill(180);
    assert.equal(darkMask(flat, 50, 50).reduce((a, b) => a + b, 0), 0);
    const img = photo(100, 100, [{ x: 40, y: 40, w: 20, h: 30 }]);
    assert.ok(darkMask(img, 100, 100).reduce((a, b) => a + b, 0) > 50);
});

test('components: две отдельные фигуры — две области с верными рамками', () => {
    const img = photo(120, 60, [{ x: 5, y: 5, w: 20, h: 30 }, { x: 60, y: 10, w: 20, h: 30 }]);
    const found = components(darkMask(img, 120, 60), 120, 60).filter(c => c.h > 20);
    assert.equal(found.length, 2);
    assert.deepEqual([found[0].x0, found[0].y0], [5, 5]);
});

test('looksLikeDigit: слишком мелкое, слишком широкое и тонкая линия не подходят', () => {
    const c = (w, h, area) => ({ w, h, area });
    assert.equal(looksLikeDigit(c(20, 30, 300), 720), true);
    assert.equal(looksLikeDigit(c(3, 4, 12), 720), false);          // пыль
    assert.equal(looksLikeDigit(c(80, 30, 900), 720), false);       // широкая надпись
    assert.equal(looksLikeDigit(c(2, 30, 60), 720), false);         // рамка таблички
    assert.equal(looksLikeDigit(c(20, 200, 300), 720), false);      // слишком высокое
});

test('findNumberRegions: находит ряд из трёх цифр и игнорирует одиночные пятна', () => {
    const img = photo(400, 300, [...row(100, 50, 3), { x: 300, y: 200, w: 22, h: 34 }]);
    const regions = findNumberRegions(img, 400, 300);
    assert.equal(regions.length, 1);
    assert.equal(regions[0].count, 3);
    assert.ok(regions[0].x0 <= 101 && regions[0].x1 >= 150);
});

test('findNumberRegions: цифры в разных строках или разной высоты не склеиваются', () => {
    const stairs = [{ x: 100, y: 50, w: 22, h: 34 }, { x: 130, y: 80, w: 22, h: 34 }, { x: 160, y: 110, w: 22, h: 34 }];
    assert.equal(findNumberRegions(photo(400, 300, stairs), 400, 300).length, 0);
    const mixed = [{ x: 100, y: 50, w: 22, h: 34 }, { x: 130, y: 50, w: 22, h: 20 }, { x: 160, y: 50, w: 22, h: 34 }];
    assert.equal(findNumberRegions(photo(400, 300, mixed), 400, 300).length, 0);
});

test('findNumberRegions: крупный номер идёт раньше мелкого', () => {
    const img = photo(600, 400, [...row(20, 20, 3, 14, 22, 6), ...row(250, 200, 3, 30, 48, 10)]);
    const regions = findNumberRegions(img, 600, 400);
    assert.equal(regions.length, 2);
    assert.ok(regions[0].h > regions[1].h);
});

test('groupDigits: слишком длинный ряд (телефон, год) не считается номером', () => {
    const digits = row(10, 10, 7).map(g => ({ x0: g.x, y0: g.y, x1: g.x + g.w - 1, y1: g.y + g.h - 1, w: g.w, h: g.h }));
    assert.equal(groupDigits(digits).length, 0);
});

test('numbersIn: достаёт 2–4 цифры, ноль в начале и одиночные цифры отбрасывает', () => {
    assert.deepEqual(numbersIn('116'), ['116']);
    assert.deepEqual(numbersIn('ауд. 117, 3 этаж, 0123'), ['117']);
    assert.deepEqual(numbersIn(''), []);
});

test('roomNumberIndex: в графе есть реальные номера, а названия без номера — нет', () => {
    for (const n of ['101', '118', '201', '218', '311', '326']) assert.ok(rooms.has(n), n);
    assert.equal(rooms.get('311'), 'f3-room-311');
    assert.ok(![...rooms.keys()].some(k => !/^\d{3}$/.test(k)));
});

test('pickRoomNumber: берёт номер, который есть в здании; несуществующие числа отбрасывает', () => {
    const picks = pickRoomNumber([{ text: '1109', confidence: 40, h: 30 }, { text: '109', confidence: 96, h: 30 }], rooms);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].number, '109');
    assert.equal(picks[0].id, 'f1-room-109');
    assert.deepEqual(pickRoomNumber([{ text: '999', confidence: 90, h: 30 }], rooms), []);
    assert.deepEqual(pickRoomNumber([], rooms), []);
});

test('pickRoomNumber: две таблички с одним номером усиливают друг друга, крупная уверенная рамка весит больше', () => {
    const twoSigns = pickRoomNumber([
        { text: '116', confidence: 95, h: 39 }, { text: '116', confidence: 80, h: 37 }, { text: '117', confidence: 90, h: 39 },
    ], rooms);
    assert.equal(twoSigns[0].number, '116');
    const bigWins = pickRoomNumber([{ text: '118', confidence: 95, h: 67 }, { text: '117', confidence: 60, h: 17 }], rooms);
    assert.equal(bigWins[0].number, '118');
});

test('binarize: чернила — 0, фон — 255, ровный фон не даёт чернил', () => {
    const img = photo(100, 100, [{ x: 40, y: 40, w: 20, h: 30 }]);
    const bw = binarize(img, 100, 100);
    assert.ok(bw.includes(0) && bw.includes(255));
    assert.ok(bw.every(v => v === 0 || v === 255));
    assert.ok(binarize(new Uint8Array(2500).fill(120), 50, 50).every(v => v === 255));
});

test('stretchContrast: тусклый кадр растягивается на весь диапазон, ровный не портится', () => {
    const dim = Uint8Array.from({ length: 1000 }, (_, i) => 100 + (i % 50));
    const out = stretchContrast(dim);
    assert.ok(Math.min(...out) <= 5 && Math.max(...out) >= 250);
    const flat = new Uint8Array(100).fill(90);
    assert.deepEqual([...stretchContrast(flat)], [...flat]);
});

// Строки текста: «буквы» — маленькие тёмные пятна в ряд
const letters = (x, y, count, w = 10, h = 18, gap = 4) =>
    Array.from({ length: count }, (_, k) => ({ x: x + k * (w + gap), y, w, h }));

test('findTextLines: слово из нескольких букв — это строка, одиночная буква и столбик — нет', () => {
    const img = photo(500, 300, [...letters(50, 50, 8), { x: 400, y: 200, w: 10, h: 18 },
        { x: 300, y: 60, w: 10, h: 18 }, { x: 300, y: 90, w: 10, h: 18 }, { x: 300, y: 120, w: 10, h: 18 }]);
    const lines = findTextLines(img, 500, 300);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].count, 8);
});

test('findTextLines: две строки одна под другой не склеиваются; крупная идёт раньше мелкой', () => {
    const img = photo(600, 300, [...letters(40, 40, 6, 14, 28, 6), ...letters(40, 150, 6, 10, 16, 4)]);
    const lines = findTextLines(img, 600, 300);
    assert.equal(lines.length, 2);
    assert.ok(lines[0].h > lines[1].h);
});

test('findTextLines: буквы разного размера рядом (заголовок и мелкий текст) не склеиваются', () => {
    const img = photo(600, 400, [...letters(40, 40, 4, 16, 40, 8), ...letters(150, 50, 4, 10, 14, 4)]);
    const lines = findTextLines(img, 600, 400);
    assert.equal(lines.length, 2);
    assert.ok(lines.every(l => l.count === 4));
});
