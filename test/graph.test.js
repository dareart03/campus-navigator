import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateGraph, assertValidGraph, createGraphIndex, findShortestPath, GraphError } from '../src/graph.js';

const node = (id, type, floor = 3, x = 0, y = 0) => ({ id, type, floor, x, y });
const edge = (from, to, weight = 1) => ({ from, to, weight, type: 'corridor' });

// Маленькое здание из двух этажей: комнаты A и B на 3-м, C на 2-м, лестница между этажами.
function twoFloorGraph() {
    return {
        nodes: [
            node('room-A', 'room', 3), node('door-A', 'door', 3), node('c3', 'corridor', 3),
            node('room-B', 'room', 3), node('door-B', 'door', 3),
            node('st3', 'stairs', 3), node('st2', 'stairs', 2),
            node('c2', 'corridor', 2), node('door-C', 'door', 2), node('room-C', 'room', 2),
            node('room-X', 'room', 3), // нет ни одного ребра: недостижимая аудитория
        ],
        edges: [
            edge('room-A', 'door-A'), edge('door-A', 'c3', 4),
            edge('c3', 'door-B', 4), edge('door-B', 'room-B'),
            edge('c3', 'st3', 5), edge('st3', 'st2', 10), edge('st2', 'c2', 5),
            edge('c2', 'door-C', 3), edge('door-C', 'room-C'),
        ],
    };
}

// --- T2: маршруты ---

test('маршрут между этажами проходит по лестнице', () => {
    const idx = createGraphIndex(twoFloorGraph());
    const { path, distance } = findShortestPath(idx, 'room-A', 'room-C');
    assert.deepEqual(path, ['room-A', 'door-A', 'c3', 'st3', 'st2', 'c2', 'door-C', 'room-C']);
    assert.equal(distance, 1 + 4 + 5 + 10 + 5 + 3 + 1);
});

test('маршрут в обратную сторону имеет ту же длину', () => {
    const idx = createGraphIndex(twoFloorGraph());
    const there = findShortestPath(idx, 'room-A', 'room-C');
    const back = findShortestPath(idx, 'room-C', 'room-A');
    assert.equal(back.distance, there.distance);
    assert.deepEqual(back.path, [...there.path].reverse());
});

test('недостижимая аудитория: маршрута нет (null), а не ошибка и не бесконечный цикл', () => {
    const idx = createGraphIndex(twoFloorGraph());
    assert.equal(findShortestPath(idx, 'room-A', 'room-X'), null);
    assert.equal(findShortestPath(idx, 'room-X', 'room-A'), null);
});

test('выбирается кратчайший по весу путь, а не с наименьшим числом рёбер', () => {
    const g = {
        nodes: [node('room-S', 'room'), node('room-E', 'room'), node('a', 'corridor'), node('b', 'corridor'), node('c', 'corridor')],
        edges: [edge('room-S', 'a', 1), edge('a', 'room-E', 100), // 2 ребра, длина 101
                edge('a', 'b', 1), edge('b', 'c', 1), edge('c', 'room-E', 1)], // 4 ребра, длина 4
    };
    const r = findShortestPath(createGraphIndex(g), 'room-S', 'room-E');
    assert.equal(r.distance, 4);
    assert.deepEqual(r.path, ['room-S', 'a', 'b', 'c', 'room-E']);
});

test('сквозь промежуточную комнату маршрут не идёт, даже если так короче', () => {
    const g = {
        nodes: [node('room-S', 'room'), node('room-E', 'room'), node('room-M', 'room'), node('d1', 'door'), node('d2', 'door'), node('long', 'corridor')],
        edges: [edge('room-S', 'd1'), edge('d1', 'room-M', 1), edge('room-M', 'd2', 1), edge('d2', 'room-E'),
                edge('d1', 'long', 50), edge('long', 'd2', 50)],
    };
    const r = findShortestPath(createGraphIndex(g), 'room-S', 'room-E');
    assert.ok(!r.path.includes('room-M'));
    assert.equal(r.distance, 1 + 50 + 50 + 1);
});

test('неизвестный id аудитории даёт понятную ошибку', () => {
    const idx = createGraphIndex(twoFloorGraph());
    assert.throws(() => findShortestPath(idx, 'room-A', 'room-999'), err => err instanceof GraphError && /room-999/.test(err.message));
});

test('маршрут из аудитории в саму себя состоит из одного узла', () => {
    const r = findShortestPath(createGraphIndex(twoFloorGraph()), 'room-A', 'room-A');
    assert.deepEqual(r, { path: ['room-A'], distance: 0 });
});

// --- T3: валидация ---

test('корректный граф проходит проверку, недостижимая аудитория — предупреждение', () => {
    const { errors, warnings } = validateGraph(twoFloorGraph());
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /X/);
});

test('висячее ребро: сообщение называет узел, которого нет', () => {
    const g = twoFloorGraph();
    g.edges.push(edge('c3', 'ghost'));
    const { errors } = validateGraph(g);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /ghost/);
    assert.match(errors[0], /висячее/);
});

test('дубликат id, плохой вес и петля обнаруживаются', () => {
    const g = twoFloorGraph();
    g.nodes.push(node('c3', 'corridor'));
    g.edges.push(edge('c3', 'c2', -1), edge('c3', 'c3'));
    const text = validateGraph(g).errors.join('\n');
    assert.match(text, /описан дважды/);
    assert.match(text, /вес должен быть положительным/);
    assert.match(text, /в него же/);
});

test('аудитория есть в графе, но нет на карте — и наоборот', () => {
    const g = twoFloorGraph();
    const svgRooms = ['room-A', 'room-B', 'room-C', 'room-X', 'room-Z'];
    let { errors } = validateGraph(g, svgRooms);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Z.*нет в графе/);

    ({ errors } = validateGraph(g, ['room-A', 'room-B', 'room-C']));
    assert.match(errors.join('\n'), /X.*нет на карте/);
});

test('assertValidGraph бросает GraphError со списком проблем', () => {
    const g = twoFloorGraph();
    g.edges.push(edge('nope', 'c3'));
    try {
        assertValidGraph(g);
        assert.fail('ожидалась ошибка');
    } catch (e) {
        assert.ok(e instanceof GraphError);
        assert.equal(e.problems.length, 1);
    }
});

test('мусор вместо графа не роняет проверку', () => {
    assert.equal(validateGraph(null).errors.length, 1);
    assert.equal(validateGraph({ nodes: [] }).errors.length, 1);
});

// --- Несколько этажей: синтетический пример ---

test('разрезанная лестница: между этажами маршрута нет, внутри этажа — есть', () => {
    const g = twoFloorGraph();
    g.edges = g.edges.filter(e => !(e.from === 'st3' && e.to === 'st2'));
    const idx = createGraphIndex(g);
    assert.equal(findShortestPath(idx, 'room-A', 'room-C'), null);
    assert.ok(findShortestPath(idx, 'room-A', 'room-B'));
});

// --- Реальные данные здания (data.json + map1/2/3.svg) ---

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const data = JSON.parse(read('data/data.json'));
const FLOORS = [1, 2, 3];

// Комнаты с каждой карты: <path|rect|g id="room-…">; &#39; -> '
const svgRooms = FLOORS.flatMap(f =>
    [...read(`maps/map${f}.svg`).matchAll(/<(?:rect|path|g) id="(room-[^"]+)"/g)]
        .map(m => `f${f}-${m[1].replaceAll('&#39;', "'")}`));

const idx = createGraphIndex(data);
const floorOf = id => idx.nodes.get(id).floor;

test('data.json согласован с картами трёх этажей и не содержит ошибок', () => {
    assert.ok(svgRooms.length >= 70, `на картах найдено только ${svgRooms.length} аудиторий`);
    const { errors, warnings } = validateGraph(data, svgRooms);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
});

test('есть узлы всех трёх этажей', () => {
    assert.deepEqual([...new Set(data.nodes.map(n => n.floor))].sort(), FLOORS);
});

test('лестницы соединяют только соседние этажи и только одноимённые ladder-N', () => {
    const stairs = data.edges.filter(e => floorOf(e.from) !== floorOf(e.to));
    assert.ok(stairs.length >= 8, 'ожидалось по 4 лестницы между 1–2 и 2–3 этажами');
    stairs.forEach(e => {
        assert.equal(e.type, 'stairs');
        assert.equal(Math.abs(floorOf(e.from) - floorOf(e.to)), 1, `${e.from} — ${e.to} перескакивает этаж`);
        assert.equal(e.from.replace(/^f\d+-/, ''), e.to.replace(/^f\d+-/, ''), `${e.from} — ${e.to}: разные лестницы`);
    });
});

test('из аудитории 311 достижима каждая аудитория на каждом этаже', () => {
    for (const target of idx.rooms) {
        assert.ok(findShortestPath(idx, 'f3-room-311', target), `нет маршрута f3-room-311 → ${target}`);
    }
});

test('маршрут 3 → 1 этаж: этажи идут по порядку 3, 2, 1 и не перескакивают', () => {
    const { path } = findShortestPath(idx, 'f3-room-311', 'f1-room-103');
    const floors = path.map(floorOf).filter((f, i, a) => i === 0 || f !== a[i - 1]);
    assert.deepEqual(floors, [3, 2, 1]);
});

test('на промежуточном 2 этаже маршрут 3 → 1 состоит из одного узла лестницы', () => {
    const { path } = findShortestPath(idx, 'f3-room-311', 'f1-room-103');
    const onSecond = path.filter(id => floorOf(id) === 2);
    assert.equal(onSecond.length, 1);
    assert.equal(idx.nodes.get(onSecond[0]).type, 'stairs');
});

test('маршрут между этажами длиннее двух лестничных рёбер и симметричен', () => {
    const there = findShortestPath(idx, 'f3-room-311', 'f1-room-103');
    const back = findShortestPath(idx, 'f1-room-103', 'f3-room-311');
    assert.ok(there.distance > 2 * 40);
    assert.ok(Math.abs(there.distance - back.distance) < 1e-6);
});

test('маршрут 2 → 3 этаж использует ровно одну лестницу', () => {
    const { path } = findShortestPath(idx, 'f2-room-201', 'f3-room-311');
    const changes = path.filter((id, i) => i > 0 && floorOf(id) !== floorOf(path[i - 1]));
    assert.equal(changes.length, 1);
});

test('маршрут в аудиторию со сложным названием (с пробелом) строится', () => {
    const r = findShortestPath(idx, 'f3-room-311', "f1-room-dean's office");
    assert.ok(r);
    assert.ok(r.path.some(id => id.startsWith('f1-')));
});

test('маршрут начинается и кончается на дверях своих аудиторий', () => {
    const { path } = findShortestPath(idx, 'f3-room-311', 'f3-room-301');
    assert.equal(path[1], 'f3-door-311');
    assert.equal(path.at(-2), 'f3-door-301');
});

test('у комнаты с двумя дверями выбирается ближайшая (325 → 326 через верхнюю)', () => {
    const { path } = findShortestPath(idx, 'f3-room-325', 'f3-room-326');
    assert.ok(path.includes('f3-door-325-2'));
    assert.ok(!path.includes('f3-door-325-1'));
});

test('промежуточные комнаты в реальных маршрутах не встречаются (кроме начала и конца)', () => {
    const pairs = [['f3-room-311', 'f1-room-103'], ['f2-room-201', 'f2-room-224'], ['f1-room-113', 'f1-room-103'], ['f3-room-322', 'f3-room-312']];
    for (const [a, b] of pairs) {
        const { path } = findShortestPath(idx, a, b);
        path.slice(1, -1).forEach(id => assert.ok(!idx.rooms.has(id), `${a} → ${b} идёт сквозь ${id}`));
    }
});

test('валидация ловит неизвестную аудиторию на карте нужного этажа', () => {
    const { errors } = validateGraph(data, [...svgRooms, 'f2-room-999']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /999/);
});
