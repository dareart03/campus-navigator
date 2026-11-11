// Чистая логика графа: валидация и поиск пути. Без DOM, поэтому тестируется в Node.
import { MinHeap } from './heap.js';

const NODE_TYPES = new Set(['room', 'door', 'corridor', 'stairs', 'wc', 'exit']);

export class GraphError extends Error {
    constructor(message, problems = []) {
        super(message);
        this.name = 'GraphError';
        this.problems = problems; // список понятных строк для показа пользователю
    }
}

// --- ВАЛИДАЦИЯ ---------------------------------------------------------------

// 'f3-room-311' -> '311 (3 этаж)'; 'room-311' -> '311'
function roomName(id) {
    const m = /^f(\d+)-room-(.+)$/.exec(id);
    return m ? `${m[2]} (${m[1]} этаж)` : id.replace('room-', '');
}

// svgRoomIds — (необязательно) id комнат, найденных на карте; тогда сверяем граф и SVG.
// Возвращает { errors, warnings }. errors — граф использовать нельзя, warnings — можно.
export function validateGraph(graph, svgRoomIds = null) {
    const errors = [];
    const warnings = [];

    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        return { errors: ['Файл данных должен содержать массивы nodes и edges'], warnings };
    }

    const ids = new Set();
    graph.nodes.forEach((n, i) => {
        if (typeof n.id !== 'string' || n.id === '') {
            errors.push(`Узел №${i + 1}: не задан id`);
            return;
        }
        if (ids.has(n.id)) errors.push(`Узел «${n.id}» описан дважды`);
        ids.add(n.id);
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) errors.push(`Узел «${n.id}»: некорректные координаты`);
        if (!Number.isInteger(n.floor)) errors.push(`Узел «${n.id}»: не задан этаж`);
        if (!NODE_TYPES.has(n.type)) errors.push(`Узел «${n.id}»: неизвестный тип «${n.type}»`);
    });

    graph.edges.forEach((e, i) => {
        const name = `Ребро №${i + 1} («${e.from}» — «${e.to}»)`;
        if (!ids.has(e.from)) errors.push(`${name}: узел «${e.from}» не найден (висячее ребро)`);
        if (!ids.has(e.to)) errors.push(`${name}: узел «${e.to}» не найден (висячее ребро)`);
        if (e.from === e.to) errors.push(`${name}: ребро ведёт из узла в него же`);
        if (!Number.isFinite(e.weight) || e.weight <= 0) errors.push(`${name}: вес должен быть положительным числом`);
    });

    const graphRooms = graph.nodes.filter(n => n.type === 'room').map(n => n.id);
    if (svgRoomIds) {
        const svg = new Set(svgRoomIds);
        graphRooms.filter(id => !svg.has(id))
            .forEach(id => errors.push(`Аудитория «${roomName(id)}» есть в графе, но её нет на карте`));
        [...svg].filter(id => !ids.has(id))
            .forEach(id => errors.push(`Аудитория «${roomName(id)}» нарисована на карте, но её нет в графе`));
    }

    // Недостижимые аудитории — не ошибка данных, но пользователю про них стоит знать.
    if (errors.length === 0) {
        const { adj } = createGraphIndex(graph);
        const comp = reachableFrom(adj, graph.nodes[0]?.id);
        graphRooms.filter(id => !comp.has(id))
            .forEach(id => warnings.push(`Аудитория «${roomName(id)}» не связана с остальным зданием`));
    }

    return { errors, warnings };
}

export function assertValidGraph(graph, svgRoomIds = null) {
    const { errors, warnings } = validateGraph(graph, svgRoomIds);
    if (errors.length > 0) {
        throw new GraphError(`Данные карты содержат ошибки (${errors.length})`, errors);
    }
    return warnings;
}

function reachableFrom(adj, startId) {
    const seen = new Set();
    const stack = startId ? [startId] : [];
    while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        adj.get(id).forEach(({ to }) => stack.push(to));
    }
    return seen;
}

// --- ПОИСК ПУТИ --------------------------------------------------------------

// Список смежности: id узла -> [{ to, weight }]. Строится один раз после загрузки графа.
export function createGraphIndex(graph) {
    const adj = new Map(graph.nodes.map(n => [n.id, []]));
    graph.edges.forEach(e => {
        adj.get(e.from).push({ to: e.to, weight: e.weight });
        adj.get(e.to).push({ to: e.from, weight: e.weight });
    });
    const rooms = new Set(graph.nodes.filter(n => n.type === 'room').map(n => n.id));
    const nodes = new Map(graph.nodes.map(n => [n.id, n]));
    return { adj, rooms, nodes };
}

// Общий обход Дейкстры с бинарной кучей: O((V + E) log V) вместо O(V²) при поиске минимума перебором.
// isGoal(id) — узел, на котором останавливаемся; canEnter(id) — можно ли входить в узел (комнаты только как цель).
// Возвращает { id, path, distance } или null. Куча хранит записи [расстояние, id]; устаревшие записи пропускаем.
function dijkstra(index, startId, isGoal, canEnter) {
    const { adj } = index;
    const distances = new Map([[startId, 0]]);
    const previous = new Map();
    const done = new Set();
    const heap = new MinHeap();
    heap.push(0, startId);

    while (heap.size > 0) {
        const [dist, current] = heap.pop();
        if (done.has(current)) continue;
        if (isGoal(current)) {
            const path = [];
            for (let id = current; id !== undefined; id = previous.get(id)) path.unshift(id);
            return { id: current, path, distance: dist };
        }
        done.add(current);

        for (const { to, weight } of adj.get(current)) {
            if (done.has(to) || !canEnter(to)) continue;
            const nd = dist + weight;
            if (nd < (distances.get(to) ?? Infinity)) {
                distances.set(to, nd);
                previous.set(to, current);
                heap.push(nd, to);
            }
        }
    }
    return null;
}

// Кратчайший путь. Комнаты — только начало и конец маршрута, сквозь них ходить нельзя
// (иначе у комнаты с двумя дверями получается «короткий путь» через неё).
// Возвращает { path, distance } или null, если пути нет.
export function findShortestPath(index, startId, endId) {
    const { adj, rooms } = index;
    [startId, endId].forEach(id => {
        if (!adj.has(id)) throw new GraphError(`Неизвестная точка маршрута «${id}»`, [id]);
    });
    const found = dijkstra(index, startId, id => id === endId, id => !rooms.has(id) || id === endId);
    return found && { path: found.path, distance: found.distance };
}

// Ближайшее место заданной категории (poi: 'wc-man', 'exit', 'dining' …) от точки startId.
// Один обход от старта: первое подходящее место, до которого дошли, и есть ближайшее по длине пути.
// Комнаты, как и раньше, только конец маршрута: заходим в них лишь если они сами и есть искомое место.
// Возвращает { id, path, distance } или null, если такого места нет или до него не дойти.
export function findNearest(index, startId, poi) {
    const { adj, rooms, nodes } = index;
    if (!adj.has(startId)) throw new GraphError(`Неизвестная точка маршрута «${startId}»`, [startId]);
    const isGoal = id => id !== startId && nodes.get(id).poi === poi;
    return dijkstra(index, startId, isGoal, id => !rooms.has(id) || isGoal(id));
}
