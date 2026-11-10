// Чистая логика графа: валидация и поиск пути. Без DOM, поэтому тестируется в Node.

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

// Дейкстра. Комнаты — только начало и конец маршрута, сквозь них ходить нельзя
// (иначе у комнаты с двумя дверями получается «короткий путь» через неё).
// Возвращает { path, distance } или null, если пути нет.
export function findShortestPath(index, startId, endId) {
    const { adj, rooms } = index;
    [startId, endId].forEach(id => {
        if (!adj.has(id)) throw new GraphError(`Неизвестная точка маршрута «${id}»`, [id]);
    });

    const distances = new Map();
    const previous = new Map();
    const unvisited = new Set(adj.keys());
    unvisited.forEach(id => distances.set(id, Infinity));
    distances.set(startId, 0);

    while (unvisited.size > 0) {
        let current = null;
        let minDistance = Infinity;
        unvisited.forEach(id => {
            if (distances.get(id) < minDistance) {
                minDistance = distances.get(id);
                current = id;
            }
        });

        if (current === null || current === endId) break;
        unvisited.delete(current);

        adj.get(current).forEach(({ to, weight }) => {
            if (rooms.has(to) && to !== endId) return;
            const newDist = distances.get(current) + weight;
            if (unvisited.has(to) && newDist < distances.get(to)) {
                distances.set(to, newDist);
                previous.set(to, current);
            }
        });
    }

    if (distances.get(endId) === Infinity) return null;

    const path = [];
    for (let id = endId; id !== undefined; id = previous.get(id)) path.unshift(id);
    return { path, distance: distances.get(endId) };
}

// Ближайшее место заданной категории (poi: 'wc-man', 'exit', 'dining' …) от точки startId.
// Один обход Дейкстры от старта: первое подходящее место, до которого дошли, и есть ближайшее по длине пути.
// Комнаты, как и раньше, только конец маршрута: заходим в них лишь если они сами и есть искомое место.
// Возвращает { id, path, distance } или null, если такого места нет или до него не дойти.
export function findNearest(index, startId, poi) {
    const { adj, rooms, nodes } = index;
    if (!adj.has(startId)) throw new GraphError(`Неизвестная точка маршрута «${startId}»`, [startId]);
    const isGoal = id => id !== startId && nodes.get(id).poi === poi;

    const distances = new Map();
    const previous = new Map();
    const unvisited = new Set(adj.keys());
    unvisited.forEach(id => distances.set(id, Infinity));
    distances.set(startId, 0);

    while (unvisited.size > 0) {
        let current = null;
        let minDistance = Infinity;
        unvisited.forEach(id => {
            if (distances.get(id) < minDistance) {
                minDistance = distances.get(id);
                current = id;
            }
        });
        if (current === null) return null;                 // дальше недостижимо

        if (isGoal(current)) {
            const path = [];
            for (let id = current; id !== undefined; id = previous.get(id)) path.unshift(id);
            return { id: current, path, distance: minDistance };
        }
        unvisited.delete(current);

        adj.get(current).forEach(({ to, weight }) => {
            if (rooms.has(to) && !isGoal(to)) return;      // сквозь чужие комнаты не ходим
            const newDist = distances.get(current) + weight;
            if (unvisited.has(to) && newDist < distances.get(to)) {
                distances.set(to, newDist);
                previous.set(to, current);
            }
        });
    }
    return null;
}
