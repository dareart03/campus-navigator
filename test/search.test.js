import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    normalize, buildSearchIndex, searchPlaces, toggleFavorite, pushRecent,
    sanitizeFavorites, sanitizeRecents, loadJSON, saveJSON, MAX_RECENTS,
} from '../src/search.js';

const nodes = [
    { id: 'f3-room-311', type: 'room', floor: 3, label: '311' },
    { id: 'f3-room-303', type: 'room', floor: 3, label: '303 — Кафедра математического анализа и геометрии', aliases: ['Отдел математического анализа ЮМИ ВНЦ РАН'] },
    { id: 'f3-room-326', type: 'room', floor: 3, label: '326 — Студия самозаписи', aliases: ['Студия самозаписи научно-образовательной лаборатории математического онлайн-образования'] },
    { id: 'f1-room-dining room', type: 'room', floor: 1, label: 'Столовая' },
    { id: 'f2-woman-WC-1', type: 'wc', floor: 2, label: 'Женский туалет 1' },
    { id: 'f3-woman-WC-1', type: 'wc', floor: 3, label: 'Женский туалет 1' },
    { id: 'f3-door-311', type: 'door', floor: 3 },
    { id: 'f3-corridor-1', type: 'corridor', floor: 3 },
];
const index = buildSearchIndex(nodes);
const ids = res => res.map(e => e.id);

test('normalize: регистр, ё, тире и пробелы не мешают', () => {
    assert.equal(normalize('  Ёлка —  Тест '), 'елка тест');
});

test('в индекс попадают только аудитории и туалеты', () => {
    assert.equal(index.length, 6);
});

test('поиск по номеру: точное совпадение выше частичного', () => {
    assert.equal(searchPlaces(index, '311')[0].id, 'f3-room-311');
    assert.deepEqual(ids(searchPlaces(index, '3')).slice(0, 3).sort(), ['f3-room-303', 'f3-room-311', 'f3-room-326']);
});

test('поиск по названию без учёта регистра и ё', () => {
    assert.deepEqual(ids(searchPlaces(index, 'СТОЛОВАЯ')), ['f1-room-dining room']);
    assert.deepEqual(ids(searchPlaces(index, 'столов')), ['f1-room-dining room']);
});

test('поиск по синониму (aliases) находит ту же аудиторию', () => {
    assert.deepEqual(ids(searchPlaces(index, 'ЮМИ')), ['f3-room-303']);
    assert.deepEqual(ids(searchPlaces(index, 'онлайн образования')), ['f3-room-326']);
});

test('все слова запроса должны найтись, порядок не важен', () => {
    assert.deepEqual(ids(searchPlaces(index, 'математического каф')), ['f3-room-303']);
    assert.deepEqual(searchPlaces(index, 'кафедра столовая'), []);
});

test('поиск по имени из SVG (английское) тоже работает', () => {
    assert.deepEqual(ids(searchPlaces(index, 'dining')), ['f1-room-dining room']);
});

test('пустой запрос и запрос из пробелов ничего не находят', () => {
    assert.deepEqual(searchPlaces(index, ''), []);
    assert.deepEqual(searchPlaces(index, '   '), []);
});

test('одинаковые названия на разных этажах — оба в результатах, верхний этаж выше', () => {
    const res = searchPlaces(index, 'женский туалет');
    assert.deepEqual(ids(res), ['f3-woman-WC-1', 'f2-woman-WC-1']);
});

test('лимит результатов соблюдается', () => {
    assert.equal(searchPlaces(index, 'о', 2).length <= 2, true);
});

test('поиск на реальных данных: каждая комната находится по своему номеру', () => {
    const data = JSON.parse(readFileSync(new URL('../data/data.json', import.meta.url), 'utf8'));
    const real = buildSearchIndex(data.nodes);
    const numbered = real.filter(e => /^\d{3}/.test(e.label));
    assert.ok(numbered.length > 50);
    for (const e of numbered) {
        const num = e.label.slice(0, 3);
        assert.ok(searchPlaces(real, num, 50).some(r => r.id === e.id), `${num} не находится`);
    }
});

test('избранное: добавить и убрать', () => {
    let fav = toggleFavorite([], 'a');
    fav = toggleFavorite(fav, 'b');
    assert.deepEqual(fav, ['b', 'a']);
    assert.deepEqual(toggleFavorite(fav, 'a'), ['b']);
});

test('недавние: новый впереди, дубль не множится, не больше MAX_RECENTS', () => {
    let rec = [];
    for (let i = 0; i < 8; i++) rec = pushRecent(rec, { from: `a${i}`, to: 'z' });
    assert.equal(rec.length, MAX_RECENTS);
    assert.equal(rec[0].from, 'a7');
    rec = pushRecent(rec, { from: 'a5', to: 'z' });
    assert.equal(rec[0].from, 'a5');
    assert.equal(rec.filter(r => r.from === 'a5').length, 1);
});

test('сохранённое чистится: исчезнувшие аудитории и мусор отбрасываются', () => {
    const valid = new Set(['a', 'b']);
    assert.deepEqual(sanitizeFavorites(['a', 'x', 5, 'b'], valid), ['a', 'b']);
    assert.deepEqual(sanitizeFavorites('мусор', valid), []);
    assert.deepEqual(sanitizeRecents([{ from: 'a', to: 'b' }, { from: 'a', to: 'x' }, null, { from: 'a', to: 'a' }], valid), [{ from: 'a', to: 'b' }]);
    assert.deepEqual(sanitizeRecents({ not: 'list' }, valid), []);
});

test('без localStorage (Node, приватный режим) приложение не падает', () => {
    assert.deepEqual(loadJSON('k', ['запасное']), ['запасное']);
    assert.doesNotThrow(() => saveJSON('k', [1]));
});

test('с localStorage данные сохраняются и читаются; битый JSON даёт запасное значение', () => {
    const store = new Map();
    globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    try {
        saveJSON('k', { a: 1 });
        assert.deepEqual(loadJSON('k', null), { a: 1 });
        store.set('bad', '{не json');
        assert.deepEqual(loadJSON('bad', []), []);
    } finally {
        delete globalThis.localStorage;
    }
});
