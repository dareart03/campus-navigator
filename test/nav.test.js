import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCREENS, hashFor, screenFromHash, backAction } from '../src/nav.js';
import { saveSession, loadSession, SESSION_KEY } from '../src/session.js';

test('hashFor и screenFromHash: туда и обратно для всех экранов', () => {
    for (const s of SCREENS) assert.equal(screenFromHash(hashFor(s), { canShare: true }), s);
    assert.equal(hashFor('map'), '');
});

test('screenFromHash: мусор и неизвестные экраны дают карту', () => {
    for (const h of ['', '#', '#/', '#/nope', '#/../search?x', undefined, null]) {
        assert.equal(screenFromHash(h, { canShare: true }), 'map', String(h));
    }
});

test('screenFromHash: экран «поделиться» без готового маршрута недоступен', () => {
    assert.equal(screenFromHash('#/share', { canShare: false }), 'map');
    assert.equal(screenFromHash('#/share', { canShare: true }), 'share');
    assert.equal(screenFromHash('#/search', { canShare: false }), 'search');
});

test('экран «Фото двери» (scan) доступен всегда и по своему адресу', () => {
    assert.ok(SCREENS.includes('scan'));
    assert.equal(hashFor('scan'), '#/scan');
    assert.equal(screenFromHash('#/scan', { canShare: false }), 'scan');
});

test('backAction: есть что откатывать — назад по истории, иначе на карту', () => {
    assert.equal(backAction(2), 'history-back');
    assert.equal(backAction(1), 'history-back');
    assert.equal(backAction(0), 'replace-with-map');
    assert.equal(backAction(undefined), 'replace-with-map');
});

const fakeStorage = (initial = {}) => {
    const data = { ...initial };
    return { getItem: k => data[k] ?? null, setItem: (k, v) => { data[k] = v; }, data };
};
const ctx = { floors: [1, 2, 3], isPlace: id => id.startsWith('f') };

test('session: сохранённое состояние читается обратно', () => {
    const st = fakeStorage();
    const state = { floor: 2, view: { s: 2.5, r: 0.3, tx: -40, ty: 12 }, start: 'f3-room-311', end: 'f2-room-201', query: '30' };
    saveSession(st, state);
    assert.deepEqual(loadSession(st, ctx), state);
});

test('session: битые данные отбрасываются по частям, а не ломают запуск', () => {
    const st = fakeStorage({ [SESSION_KEY]: JSON.stringify({
        floor: 9, view: { s: 0, r: 0, tx: 0, ty: 0 }, start: 'room-X', end: 'f1-room-1', query: 5,
    }) });
    assert.deepEqual(loadSession(st, ctx), {});                       // этаж 9, масштаб 0, чужие id — всё мимо
    assert.equal(loadSession(fakeStorage({ [SESSION_KEY]: '{не json' }), ctx), null);
    assert.equal(loadSession(fakeStorage(), ctx), null);
    assert.equal(loadSession(fakeStorage({ [SESSION_KEY]: '42' }), ctx), null);
});

test('session: финиш без старта и совпадающий со стартом не берутся; длинный запрос обрезается', () => {
    const st = fakeStorage({ [SESSION_KEY]: JSON.stringify({ end: 'f1-room-1' }) });
    assert.deepEqual(loadSession(st, ctx), {});
    const same = fakeStorage({ [SESSION_KEY]: JSON.stringify({ start: 'f1-a', end: 'f1-a', query: 'x'.repeat(500) }) });
    const got = loadSession(same, ctx);
    assert.equal(got.end, undefined);
    assert.equal(got.query.length, 100);
});

test('session: недоступное хранилище не роняет приложение', () => {
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
    saveSession(broken, { floor: 1 });                                // не бросает
    assert.equal(loadSession(broken, ctx), null);
});
