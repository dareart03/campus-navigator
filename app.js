// --- 1. ЗАГРУЗКА КАРТЫ (SVG) ---
async function loadMap() {
    const response = await fetch('map3.svg');
    const svgText = await response.text();
    document.getElementById('map-wrapper').innerHTML = svgText;
}

// --- 2. ЗАГРУЗКА ГРАФА (JSON) ---
async function loadGraph() {
    const response = await fetch('data.json');
    return await response.json();
}

// --- 3. АЛГОРИТМ ДЕЙКСТРЫ ---
// Список смежности: id узла -> [{ to, weight }]. Строится один раз после загрузки графа.
function buildAdjacency(graph) {
    const adj = new Map(graph.nodes.map(n => [n.id, []]));
    graph.edges.forEach(e => {
        adj.get(e.from).push({ to: e.to, weight: e.weight });
        adj.get(e.to).push({ to: e.from, weight: e.weight });
    });
    const rooms = new Set(graph.nodes.filter(n => n.type === 'room').map(n => n.id));
    return { adj, rooms };
}

// Комнаты — только начало и конец маршрута, сквозь них ходить нельзя
// (иначе у комнаты с двумя дверями получается «короткий путь» через неё).
function findShortestPath(adj, rooms, startId, endId) {
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
            const newDist = distances.get(current) + weight;
            if (rooms.has(to) && to !== endId) return;
            if (unvisited.has(to) && newDist < distances.get(to)) {
                distances.set(to, newDist);
                previous.set(to, current);
            }
        });
    }

    if (distances.get(endId) === Infinity) return null;

    const path = [];
    for (let id = endId; id !== undefined; id = previous.get(id)) path.unshift(id);
    return path;
}

// --- ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ДЛЯ ВЫБОРА ---
let currentStart = null;
let currentEnd = null;
let currentGraph = null; // Граф из data.json
let currentAdj = null;   // { adj, rooms } для Дейкстры

// --- 4. ОБРАБОТКА КЛИКОВ ПО КОМНАТАМ ---
function clearSelection() {
    document.querySelectorAll('.start-room, .end-room').forEach(el => el.classList.remove('start-room', 'end-room'));
    const oldLine = document.querySelector('.route-line');
    if (oldLine) oldLine.remove();
}

function handleRoomClick(event) {
    const room = event.currentTarget;
    const roomId = room.id;
    if (!currentGraph) return; // граф ещё не загружен

    if (!currentStart || currentEnd) {
        // Первый клик или новый выбор после готового маршрута: сбрасываем всё и ставим старт
        clearSelection();
        currentStart = roomId;
        currentEnd = null;
        room.classList.add('start-room');
    } else if (roomId !== currentStart) {
        // Есть старт, кликнули по другой комнате: это финиш, строим маршрут
        currentEnd = roomId;
        room.classList.add('end-room');
        drawRouteBetween(currentStart, currentEnd);
    }
}

// --- 5. ОТРИСОВКА МАРШРУТА МЕЖДУ ЛЮБЫМИ КОМНАТАМИ ---
function drawRouteBetween(startId, endId) {
    // Ищем путь от узла комнаты до узла комнаты: рёбра комната—дверь есть в графе,
    // поэтому Дейкстра сама выберет лучшую из нескольких дверей (325, 322 и т.д.).
    const pathIds = findShortestPath(currentAdj.adj, currentAdj.rooms, startId, endId);

    if (!pathIds) {
        alert('Маршрут не найден');
        return;
    }

    // Удаляем старую линию, если есть
    const oldLine = document.querySelector('.route-line');
    if (oldLine) oldLine.remove();

    // Линию начинаем с двери и заканчиваем дверью: центр комнаты в маршрут не берём,
    // иначе от двери до центра получается косой отрезок внутри комнаты.
    const points = pathIds
        .slice(1, -1)
        .map(id => currentGraph.nodes.find(n => n.id === id))
        .map(node => `${node.x},${node.y}`)
        .join(' ');

    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', points);
    polyline.setAttribute('class', 'route-line');

    const svg = document.querySelector('#map-wrapper svg');
    if (svg) svg.appendChild(polyline);
}

// --- 6. СТАРТ ---
window.onload = async () => {
    await loadMap();
    currentGraph = await loadGraph();
    currentAdj = buildAdjacency(currentGraph);

    // Вешаем обработчик клика на все комнаты (в SVG это и <rect>, и <path>, например 318)
    const rooms = document.querySelectorAll('#Rooms [id^="room-"]');
    rooms.forEach(room => {
        room.addEventListener('click', handleRoomClick);
    });
    
    console.log('Карта загружена. Нажми на две комнаты, чтобы проложить маршрут.');
};