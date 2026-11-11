import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invertMatrix, visibleRect, intersects, updateVisibility } from '../src/culling.js';
import { MinHeap } from '../src/heap.js';

const IDM = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

test('invertMatrix: обратная матрица возвращает точку на место', () => {
    const m = { a: 2, b: 0.5, c: -0.5, d: 2, e: 10, f: -4 };
    const inv = invertMatrix(m);
    const x = m.a * 3 + m.c * 7 + m.e, y = m.b * 3 + m.d * 7 + m.f;
    assert.ok(Math.abs(inv.a * x + inv.c * y + inv.e - 3) < 1e-9);
    assert.ok(Math.abs(inv.b * x + inv.d * y + inv.f - 7) < 1e-9);
    assert.equal(invertMatrix({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }), null);
});

test('visibleRect: масштаб 2 и сдвиг — видна половина карты', () => {
    const screenToSvg = invertMatrix({ a: 2, b: 0, c: 0, d: 2, e: -100, f: 0 });
    const r = visibleRect(screenToSvg, { left: 0, top: 0, width: 200, height: 100 });
    assert.deepEqual(r, { x0: 50, y0: 0, x1: 150, y1: 50 });
});

test('visibleRect: поворот на 90° даёт рамку вокруг повёрнутого окна, pad расширяет', () => {
    const rot90 = invertMatrix({ a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 });
    const r = visibleRect(rot90, { left: 0, top: 0, width: 100, height: 50 }, 5);
    assert.deepEqual(r, { x0: -5, y0: -105, x1: 55, y1: 5 });
});

test('intersects: пересечение, касание не считается', () => {
    const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
    assert.ok(intersects({ x: 5, y: 5, width: 10, height: 10 }, r));
    assert.ok(!intersects({ x: 10, y: 0, width: 5, height: 5 }, r));
    assert.ok(!intersects({ x: -20, y: 0, width: 5, height: 5 }, r));
});

test('updateVisibility: возвращает только изменившиеся элементы', () => {
    const items = [
        { box: { x: 0, y: 0, width: 5, height: 5 }, visible: true },
        { box: { x: 50, y: 0, width: 5, height: 5 }, visible: true },
        { box: { x: 2, y: 2, width: 1, height: 1 }, visible: false },
    ];
    const rect = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const changed = updateVisibility(items, rect);
    assert.deepEqual(changed, [items[1], items[2]]);
    assert.deepEqual(items.map(i => i.visible), [true, false, true]);
    assert.equal(updateVisibility(items, rect).length, 0);
});

test('MinHeap: выдаёт по возрастанию, как сортировка', () => {
    const h = new MinHeap();
    const data = Array.from({ length: 500 }, (_, i) => (i * 7919) % 1009);
    data.forEach(x => h.push(x, `v${x}`));
    const out = [];
    while (h.size) out.push(h.pop()[0]);
    assert.deepEqual(out, [...data].sort((a, b) => a - b));
});
