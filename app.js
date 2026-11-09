import { assertValidGraph, createGraphIndex, findShortestPath, GraphError } from './graph.js';
import { attachGestures } from './gestures.js';
import { labelScale } from './viewmath.js';

const FLOORS = [1, 2, 3];
const START_FLOOR = 3;
const NS = 'http://www.w3.org/2000/svg';

// Размер подписей на карте: желаемая высота цифр на экране в пикселях (мин/макс).
// На телефоне (сенсорный экран или узкое окно) подписи вдвое мельче, чем на компьютере.
const LABEL_SIZE_DESKTOP = { minPx: 12, maxPx: 22 };
const LABEL_SIZE_PHONE = { minPx: 6.5, maxPx: 11 };
const isPhone = () => matchMedia('(pointer: coarse)').matches || window.innerWidth < 700;

// --- 1. ЗАГРУЗКА КАРТ (по одному SVG на этаж) ---
async function loadMaps() {
    const stage = document.getElementById('map-stage');
    const tabs = document.getElementById('floor-tabs');

    for (const floor of FLOORS) {
        const response = await fetch(`map${floor}.svg`);
        if (!response.ok) throw new GraphError(`Не удалось загрузить карту этажа ${floor} (map${floor}.svg): ${response.status}`);

        const holder = document.createElement('div');
        holder.className = 'floor-map';
        holder.id = `floor-${floor}`;
        holder.dataset.floor = floor;
        holder.hidden = true;
        holder.innerHTML = await response.text();
        stage.append(holder);

        const tab = document.createElement('button');
        tab.type = 'button';
        tab.id = `tab-${floor}`;
        tab.textContent = `${floor} этаж`;
        tab.addEventListener('click', () => showFloor(floor));
        tabs.append(tab);
    }
}

// --- 2. ЗАГРУЗКА ГРАФА (JSON) ---
async function loadGraph() {
    const response = await fetch('data.json');
    if (!response.ok) throw new GraphError(`Не удалось загрузить данные здания (data.json): ${response.status}`);
    try {
        return await response.json();
    } catch {
        throw new GraphError('Файл data.json повреждён: это не корректный JSON');
    }
}

// --- СООБЩЕНИЯ ПОЛЬЗОВАТЕЛЮ ---
function showStatus(kind, title, lines = []) {
    const box = document.getElementById('status');
    box.className = `status ${kind}`;
    box.replaceChildren();
    const h = document.createElement('strong');
    h.textContent = title;
    box.append(h);
    if (lines.length) {
        const ul = document.createElement('ul');
        lines.forEach(l => ul.append(Object.assign(document.createElement('li'), { textContent: l })));
        box.append(ul);
    }
}

function clearStatus() {
    const box = document.getElementById('status');
    box.className = 'status hidden';
    box.replaceChildren();
}

// --- СОСТОЯНИЕ ---
let currentStart = null;   // id узла графа, например "f3-room-311"
let currentEnd = null;
let currentGraph = null;
let currentIndex = null;   // { adj, rooms, nodes } для Дейкстры
let currentFloor = START_FLOOR;
let gestures = null;       // управление видом карты (масштаб, сдвиг, поворот)

// --- ВИД КАРТЫ ---
// Применяем вид к «сцене» с картами и пересчитываем три CSS-переменные:
//   --ls  — множитель подписей (чтобы цифры читались при любом масштабе),
//   --rot — поворот карты в градусах (подписи поворачиваем обратно, чтобы они не были вверх ногами),
//   --inv — 1 / (масштаб на экране): линии маршрута и обводка комнат остаются одной толщины на экране.
function fitScale() {
    const container = document.getElementById('map-container');
    const vb = floorEl(currentFloor).querySelector('svg')?.viewBox.baseVal;
    if (!vb || !vb.width) return 1;
    return Math.min(container.clientWidth / vb.width, container.clientHeight / vb.height);
}

// Размер самой карты на экране при масштабе 1 (карта вписана в контейнер с сохранением пропорций)
function contentSize() {
    const container = document.getElementById('map-container');
    const vb = floorEl(currentFloor).querySelector('svg')?.viewBox.baseVal;
    const k = fitScale();
    return vb && vb.width ? { w: vb.width * k, h: vb.height * k } : { w: container.clientWidth, h: container.clientHeight };
}

function applyView(v) {
    const stage = document.getElementById('map-stage');
    const k = fitScale();
    stage.style.transform = `translate(${v.tx}px, ${v.ty}px) rotate(${v.r}rad) scale(${v.s})`;
    stage.style.setProperty('--ls', labelScale(v.s, k, isPhone() ? LABEL_SIZE_PHONE : LABEL_SIZE_DESKTOP).toFixed(3));
    stage.style.setProperty('--rot', (v.r * 180 / Math.PI).toFixed(2));
    stage.style.setProperty('--inv', (1 / (k * v.s)).toFixed(4));
}

// --- 3. ЭТАЖИ ---
const floorEl = floor => document.getElementById(`floor-${floor}`);

// id узла графа для элемента карты: "room-311" на 3 этаже -> "f3-room-311"
const graphId = (floor, svgId) => `f${floor}-${svgId}`;

// Элемент комнаты по id узла. Ищем перебором: в id бывают пробелы и апострофы.
function roomElement(nodeId) {
    const node = currentIndex.nodes.get(nodeId);
    const svgId = nodeId.replace(/^f\d+-/, '');
    return [...floorEl(node.floor).querySelectorAll('[id^="room-"]')].find(el => el.id === svgId);
}

function showFloor(floor) {
    currentFloor = floor;
    FLOORS.forEach(f => {
        floorEl(f).hidden = f !== floor;
        document.getElementById(`tab-${f}`).classList.toggle('active', f === floor);
    });
    document.querySelectorAll('#route-info li').forEach(li =>
        li.classList.toggle('current', Number(li.dataset.floor) === floor));
    gestures?.refresh(); // у этажей может быть чуть другой размер SVG — пересчитать подписи
}

// --- 4. ОБРАБОТКА КЛИКОВ ПО КОМНАТАМ ---
function clearSelection() {
    document.querySelectorAll('.start-room, .end-room').forEach(el => el.classList.remove('start-room', 'end-room'));
    document.querySelectorAll('.route-line, .route-stairs').forEach(el => el.remove());
    document.querySelectorAll('.floor-tabs button').forEach(b => b.classList.remove('has-route'));
    const info = document.getElementById('route-info');
    info.className = 'route-info hidden';
    info.replaceChildren();
}

// Полный сброс: выбранные аудитории, линия маршрута, список шагов, сообщения
function resetRoute() {
    clearSelection();
    currentStart = null;
    currentEnd = null;
    clearStatus();
    updateTools();
}

function updateTools() {
    document.getElementById('btn-clear').hidden = !currentStart;
}

// Обычное нажатие на карту (приходит из gestures.js, уже отличённое от жестов и двойного нажатия)
function handleTap(target) {
    const room = target?.closest?.('#Rooms [id^="room-"]');
    if (room) selectRoom(room);
}

function selectRoom(room) {
    if (!currentGraph) return; // граф не загружен или не прошёл проверку

    const floor = Number(room.closest('.floor-map').dataset.floor);
    const nodeId = graphId(floor, room.id);

    clearStatus();

    if (!currentIndex.adj.has(nodeId)) {
        showStatus('error', `Для аудитории ${room.id.replace('room-', '')} (${floor} этаж) нет данных в графе`);
        return;
    }

    if (nodeId === currentStart && !currentEnd) {
        // Повторное нажатие на выбранный старт — отмена выбора
        resetRoute();
        return;
    }

    if (!currentStart || currentEnd) {
        // Первый клик или новый выбор после готового маршрута: сбрасываем всё и ставим старт
        clearSelection();
        currentStart = nodeId;
        currentEnd = null;
        room.classList.add('start-room');
    } else if (nodeId !== currentStart) {
        // Есть старт, кликнули по другой комнате: это финиш, строим маршрут
        currentEnd = nodeId;
        room.classList.add('end-room');
        drawRouteBetween(currentStart, currentEnd);
    }
    updateTools();
}

// --- 5. МАРШРУТ МЕЖДУ ЛЮБЫМИ КОМНАТАМИ (в том числе на разных этажах) ---

// Режем путь на куски по этажам. Центры комнат (первый и последний узлы) не берём:
// иначе от двери до центра получается косой отрезок внутри комнаты.
function splitByFloor(path) {
    const segments = [];
    path.slice(1, -1).forEach(id => {
        const node = currentIndex.nodes.get(id);
        const last = segments[segments.length - 1];
        if (last && last.floor === node.floor) last.points.push(node);
        else segments.push({ floor: node.floor, points: [node] });
    });
    return segments;
}

const roomLabel = id => currentIndex.nodes.get(id).label ?? id;

// Как назвать место в тексте: «аудитории 311», но «Столовая» (у особых зон есть своё название)
const placeName = id => {
    const label = roomLabel(id);
    return /^\d+/.test(label) ? `аудитории ${label}` : `«${label}»`;
};

function describeSteps(segments, startId, endId) {
    const steps = [];
    segments.forEach((seg, i) => {
        const first = i === 0, last = i === segments.length - 1;
        const next = segments[i + 1];
        let text;
        if (first && last) text = `Этаж ${seg.floor}: от ${placeName(startId)} до ${placeName(endId)}`;
        else if (first) text = `Этаж ${seg.floor}: от ${placeName(startId)} до лестницы`;
        else if (last) text = `Этаж ${seg.floor}: от лестницы до ${placeName(endId)}`;
        else text = `Этаж ${seg.floor}: пройдите по лестнице`;
        steps.push({ floor: seg.floor, text });
        if (next) {
            const verb = next.floor > seg.floor ? 'Поднимитесь' : 'Спуститесь';
            steps.push({ floor: next.floor, text: `${verb} на ${next.floor} этаж` });
        }
    });
    return steps;
}

function renderRouteInfo(steps) {
    const info = document.getElementById('route-info');
    info.className = 'route-info';
    info.replaceChildren(Object.assign(document.createElement('strong'), { textContent: 'Маршрут' }));
    const ol = document.createElement('ol');
    steps.forEach(s => {
        const li = Object.assign(document.createElement('li'), { textContent: s.text });
        li.dataset.floor = s.floor;
        li.addEventListener('click', () => showFloor(s.floor));
        ol.append(li);
    });
    info.append(ol);
}

function drawRouteBetween(startId, endId) {
    const result = findShortestPath(currentIndex, startId, endId);

    if (!result) {
        showStatus('error', `Маршрут из ${roomLabel(startId)} в ${roomLabel(endId)} не найден`,
            ['Одна из аудиторий не связана с остальным зданием']);
        return;
    }

    const segments = splitByFloor(result.path);

    segments.forEach(seg => {
        const svg = floorEl(seg.floor).querySelector('svg');
        if (seg.points.length >= 2) {
            const polyline = document.createElementNS(NS, 'polyline');
            polyline.setAttribute('points', seg.points.map(p => `${p.x},${p.y}`).join(' '));
            polyline.setAttribute('class', 'route-line');
            svg.appendChild(polyline);
        }
        // На лестнице (начало/конец куска на другом этаже) ставим точку-маркер
        seg.points.filter(p => p.type === 'stairs').forEach(p => {
            const dot = document.createElementNS(NS, 'circle');
            dot.setAttribute('cx', p.x);
            dot.setAttribute('cy', p.y);
            dot.setAttribute('r', 8);
            dot.setAttribute('class', 'route-stairs');
            svg.appendChild(dot);
        });
        document.getElementById(`tab-${seg.floor}`).classList.add('has-route');
    });

    renderRouteInfo(describeSteps(segments, startId, endId));
    showFloor(segments[0].floor); // показываем этаж, с которого начинается путь
}

// --- 6. СТАРТ ---
window.onload = async () => {
    try {
        await loadMaps();
        const graph = await loadGraph();

        // Сверяем граф с тем, что нарисовано на картах всех этажей
        const rooms = FLOORS.flatMap(f =>
            [...floorEl(f).querySelectorAll('#Rooms [id^="room-"]')].map(el => ({ el, floor: f })));
        const warnings = assertValidGraph(graph, rooms.map(({ el, floor }) => graphId(floor, el.id)));

        currentGraph = graph;
        currentIndex = createGraphIndex(graph);

        gestures = attachGestures(document.getElementById('map-container'), { onChange: applyView, onTap: handleTap, contentSize });
        document.getElementById('btn-view').addEventListener('click', () => gestures.reset());
        document.getElementById('btn-clear').addEventListener('click', resetRoute);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') resetRoute(); });

        showFloor(START_FLOOR);
        if (warnings.length) showStatus('warning', 'Данные карты загружены с замечаниями', warnings);
    } catch (err) {
        if (err instanceof GraphError) {
            showStatus('error', err.message, err.problems);
        } else {
            showStatus('error', 'Не удалось запустить приложение', [String(err.message ?? err)]);
            console.error(err);
        }
    }
};