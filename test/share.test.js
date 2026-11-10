import { test } from 'node:test';
import assert from 'node:assert/strict';
import qrcode from '../src/vendor/qrcode.mjs';
import { buildShareUrl, parseShareParams } from '../src/share.js';

const known = new Set(['f3-room-311', 'f1-room-dining room', "f1-room-dean's office", 'f1-exit-1']);
const isPlace = id => known.has(id);

test('ссылка собирается и разбирается обратно, в том числе с пробелами и апострофами', () => {
    for (const [from, to] of [['f3-room-311', 'f1-exit-1'], ['f1-room-dining room', "f1-room-dean's office"]]) {
        const url = buildShareUrl('http://192.168.0.104:8000/index.html', from, to);
        assert.ok(url.startsWith('http://192.168.0.104:8000/index.html?'));
        assert.doesNotMatch(url.slice(url.indexOf('?')), /[ '"]/);        // в адресе нет пробелов и кавычек
        assert.deepEqual(parseShareParams(new URL(url).search, isPlace), { from, to });
    }
});

test('без параметров маршрута — null (обычное открытие)', () => {
    assert.equal(parseShareParams('', isPlace), null);
    assert.equal(parseShareParams('?lang=ru', isPlace), null);
});

test('битые ссылки дают понятную ошибку, а не падение', () => {
    assert.match(parseShareParams('?from=f3-room-311', isPlace).error, /только одна/);
    assert.match(parseShareParams('?from=f3-room-311&to=f3-room-311', isPlace).error, /совпадают/);
    assert.match(parseShareParams('?from=f3-room-311&to=f9-room-999', isPlace).error, /f9-room-999/);
    assert.match(parseShareParams('?from=&to=', isPlace).error, /только одна/);
});

test('QR-код для ссылки строится (SVG, ссылка с кириллицей в адресе не ломает)', () => {
    const url = buildShareUrl('http://192.168.0.104:8000/index.html', "f1-room-dean's office", 'f1-room-dining room');
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    assert.match(svg, /^<svg/);
    assert.ok(qr.getModuleCount() >= 21);
});
