// Замер поиска пути на синтетическом здании. Запуск:  node tools/bench.mjs [число_аудиторий ...]
// Сравнивает прежний Дейкстру (поиск минимума перебором, O(V²)) и текущий (бинарная куча) и проверяет, что ответы совпадают.
import { createGraphIndex, findShortestPath, validateGraph } from '../src/graph.js';
import { makeBuilding } from '../bench/synthetic.mjs';

// Прежняя версия, оставлена только как точка сравнения
function naive(index, startId, endId) {
    const { adj, rooms } = index;
    const dist = new Map(), prev = new Map(), open = new Set(adj.keys());
    open.forEach(id => dist.set(id, Infinity));
    dist.set(startId, 0);
    while (open.size) {
        let cur = null, best = Infinity;
        open.forEach(id => { if (dist.get(id) < best) { best = dist.get(id); cur = id; } });
        if (cur === null || cur === endId) break;
        open.delete(cur);
        adj.get(cur).forEach(({ to, weight }) => {
            if (rooms.has(to) && to !== endId) return;
            const nd = dist.get(cur) + weight;
            if (open.has(to) && nd < dist.get(to)) { dist.set(to, nd); prev.set(to, cur); }
        });
    }
    return dist.get(endId) === Infinity ? null : dist.get(endId);
}

const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];
function time(fn, runs = 15) {
    fn();                                                // прогрев
    const t = [];
    for (let i = 0; i < runs; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); }
    return median(t);
}

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
console.log('аудиторий | узлов | проверка данных | старый поиск | поиск с кучей | ускорение');
for (const rooms of sizes.length ? sizes : [50, 200, 500, 2000]) {
    const { graph } = makeBuilding(rooms);
    const ids = graph.nodes.filter(n => n.type === 'room').map(n => n.id);
    const idx = createGraphIndex(graph);
    const a = ids[0], b = ids[ids.length - 1];
    const heapRes = findShortestPath(idx, a, b), naiveDist = naive(idx, a, b);
    if (!heapRes || Math.abs(heapRes.distance - naiveDist) > 1e-9) throw new Error(`Ответы не совпали на ${rooms}: ${heapRes?.distance} vs ${naiveDist}`);
    const tv = time(() => validateGraph(graph, ids));
    const tn = time(() => naive(idx, a, b));
    const th = time(() => findShortestPath(idx, a, b));
    console.log(`${String(rooms).padStart(9)} | ${String(graph.nodes.length).padStart(5)} | ${tv.toFixed(2).padStart(11)} мс | ${tn.toFixed(2).padStart(9)} мс | ${th.toFixed(2).padStart(10)} мс | ×${(tn / th).toFixed(1)}`);
}
