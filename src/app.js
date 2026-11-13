import { assertValidGraph, createGraphIndex, findShortestPath, findNearest, GraphError } from './graph.js';
import { buildShareUrl, parseShareParams } from './share.js';
import qrcode from './vendor/qrcode.js';
import { attachGestures } from './gestures.js';
import { labelScale, rotateAbout } from './viewmath.js';
import { NORTH_KEY, approachHeading, angleDiff, headingFromEvent, mapRotation, wrapPi, sanitizeOffset } from './compass.js';
import { invertMatrix, visibleRect, updateVisibility } from './culling.js';
import { hashFor, screenFromHash, backAction } from './nav.js';
import { saveSession, loadSession } from './session.js';
import { roomNumberIndex, pickRoomNumber, numbersIn } from './signs.js';
import { buildNameIndex, matchNames } from './names.js';
import { hasPrev, hasNext, clampStep, visibleSteps, swipeDirection, stepForFloor } from './steps.js';
import {
    buildSearchIndex, searchPlaces, toggleFavorite, pushRecent, sanitizeFavorites, sanitizeRecents,
    loadJSON, saveJSON, FAVORITES_KEY, RECENTS_KEY,
} from './search.js';

// Список этажей берётся из графа (meta.floors, его записывает build_graph.py), поэтому здание может быть с любым числом этажей.
let FLOORS = [];
let START_FLOOR = 1;
const NS = 'http://www.w3.org/2000/svg';

// На что можно нажать на карте: аудитории (room-…) и туалеты (man-WC, woman-WC-1, special-WC …)
const PLACE_SELECTOR = '#Rooms [id^="room-"], #Rooms [id^="man-WC"], #Rooms [id^="woman-WC"], #Rooms [id^="special-WC"]';

// Размер подписей на карте: желаемая высота цифр на экране в пикселях (мин/макс).
// На телефоне (сенсорный экран или узкое окно) подписи вдвое мельче, чем на компьютере.
const LABEL_SIZE_DESKTOP = { minPx: 12, maxPx: 22 };
const LABEL_SIZE_PHONE = { minPx: 6.5, maxPx: 11 };
const isPhone = () => matchMedia('(pointer: coarse)').matches || window.innerWidth < 700;

// --- ЗАГРУЗКА ФАЙЛОВ: сеть может пропасть (авиарежим) ---
// Любая неудача загрузки — понятное сообщение с кнопкой «Повторить», а не пустой экран.
function loadError(message, problems = []) {
    const err = new GraphError(message, problems);
    err.retryable = true;
    return err;
}

async function fetchFile(url, what) {
    let response;
    try {
        response = await fetch(url, { cache: 'no-cache' });
    } catch {                                           // fetch отклоняется, когда связи нет совсем
        throw loadError(navigator.onLine === false ? 'Нет сети: не удалось загрузить план здания' : 'Нет связи с сервером: не удалось загрузить план здания',
            [`Не загрузился файл: ${what}`, 'Проверьте интернет (возможно, включён авиарежим) и нажмите «Повторить».']);
    }
    if (!response.ok) throw loadError(`Не удалось загрузить ${what}: ${response.status}`, ['Нажмите «Повторить» или обновите страницу.']);
    return response;
}

// --- 1. ЗАГРУЗКА КАРТ (по одному SVG на этаж) ---
function floorsOf(graph) {
    const listed = graph?.meta?.floors;
    const floors = Array.isArray(listed) && listed.length ? listed : [...new Set((graph?.nodes ?? []).map(n => n.floor))];
    return floors.filter(Number.isInteger).sort((a, b) => a - b);
}

async function loadMaps() {
    const stage = document.getElementById('map-stage');
    const tabs = document.getElementById('floor-tabs');
    stage.replaceChildren();          // повторная попытка после ошибки начинает с чистого места
    tabs.replaceChildren();

    for (const floor of FLOORS) {
        const response = await fetchFile(`maps/map${floor}.svg`, `карта этажа ${floor} (maps/map${floor}.svg)`);

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

    // Область карты подгоняем под пропорции планов: без пустых полей сверху и снизу,
    // тогда блок с указаниями оказывается сразу под картой. Берём самый большой из этажей и 8% запаса.
    const boxes = FLOORS.map(f => stage.querySelector(`#floor-${f} svg`)?.viewBox.baseVal).filter(vb => vb?.width);
    if (boxes.length) {
        const w = Math.max(...boxes.map(vb => vb.width));
        const h = Math.max(...boxes.map(vb => vb.height));
        document.getElementById('map-container').style.setProperty('--map-aspect', `${w} / ${(h * 1.08).toFixed(1)}`);
    }
}

// --- 2. ЗАГРУЗКА ГРАФА (JSON) ---
async function loadGraph() {
    const response = await fetchFile('data/data.json', 'данные здания (data/data.json)');
    try {
        return await response.json();
    } catch {
        throw new GraphError('Файл data.json повреждён: это не корректный JSON');
    }
}

// --- СООБЩЕНИЯ ПОЛЬЗОВАТЕЛЮ ---
function showStatus(kind, title, lines = [], { onRetry } = {}) {
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
    if (onRetry) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Повторить';
        b.addEventListener('click', onRetry);
        box.append(b);
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

// Во сколько раз системный размер шрифта больше обычного (16 px): 1 по умолчанию, 1,3 при крупном шрифте
const fontScale = () => parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1;

function applyView(v) {
    const stage = document.getElementById('map-stage');
    const k = fitScale();
    stage.style.transform = `translate(${v.tx}px, ${v.ty}px) rotate(${v.r}rad) scale(${v.s})`;
    const base = isPhone() ? LABEL_SIZE_PHONE : LABEL_SIZE_DESKTOP;
    const f = fontScale();     // системный размер шрифта 1,3× делает подписи на карте тоже крупнее
    stage.style.setProperty('--ls', labelScale(v.s, k, { minPx: base.minPx * f, maxPx: base.maxPx * f }).toFixed(3));
    stage.style.setProperty('--rot', (v.r * 180 / Math.PI).toFixed(2));
    stage.style.setProperty('--inv', (1 / (k * v.s)).toFixed(4));
    cullOffscreen();
}

// --- ОТСЕЧЕНИЕ ЗА ЭКРАНОМ (T3) ---
// Для каждого этажа один раз запоминаем рамки комнат, подписей и дверей; на каждом изменении вида
// убираем из DOM те, что не попали в видимый прямоугольник, и возвращаем, когда они снова на экране.
// Замеры (bench/render.html) показали: display:none почти не помогает — браузер всё равно пересчитывает
// стили у скрытых элементов при смене --ls. А удаление из DOM даёт выигрыш в 3–4 раза.
// На месте убранного элемента остаётся пустой комментарий, поэтому порядок в SVG не меняется.
// Отключается параметром ?cull=0 (для сравнения на защите).
const CULL_SELECTOR = '#Rooms > *, #Texts > *, #Doors > *';
const CULL_PAD = 30;           // запас в единицах SVG: подписи вырастают из рамки за счёт --ls
const cullEnabled = new URLSearchParams(location.search).get('cull') !== '0';
const cullIndex = new Map();   // этаж -> { items: [{ el, slot, box, visible }], byId: Map }
const statsEnabled = new URLSearchParams(location.search).has('stats');   // читаем один раз: ссылка маршрута потом перезапишет адрес
const stats = { total: 0, visible: 0, ms: 0 };
const isPinned = it => it.el.classList.contains('pin-start') || it.el.classList.contains('pin-end');

function buildCullIndex(floor) {
    const items = [], byId = new Map();
    floorEl(floor).querySelectorAll(CULL_SELECTOR).forEach(el => {
        try {
            const b = el.getBBox();
            const it = { el, slot: null, box: { x: b.x, y: b.y, width: b.width, height: b.height }, visible: true };
            items.push(it);
            if (el.id) byId.set(el.id, el);
        } catch { /* элемент без геометрии: не трогаем */ }
    });
    const index = { items, byId };
    cullIndex.set(floor, index);
    return index;
}

function setAttached(it, attached) {
    if (attached) {
        if (it.slot?.parentNode) it.slot.replaceWith(it.el);
    } else if (it.el.parentNode) {
        it.slot ??= document.createComment('');
        it.el.replaceWith(it.slot);
    }
}

function cullOffscreen() {
    const holder = floorEl(currentFloor);
    const svg = holder?.querySelector('svg');
    if (!cullEnabled || !svg || holder.hidden) return;
    const t0 = performance.now();
    const { items } = cullIndex.get(currentFloor) ?? buildCullIndex(currentFloor);
    const ctm = svg.getScreenCTM();
    const inv = ctm && invertMatrix(ctm);
    if (!inv) return;
    const r = document.getElementById('map-container').getBoundingClientRect();
    const rect = visibleRect(inv, { left: r.left, top: r.top, width: r.width, height: r.height }, CULL_PAD);
    updateVisibility(items, rect, isPinned).forEach(it => setAttached(it, it.visible));
    stats.total = items.length;
    stats.visible = items.reduce((n, it) => n + (it.visible ? 1 : 0), 0);
    stats.ms = performance.now() - t0;
    renderStats();
}

// Счётчик для защиты: открыть сайт с ?stats=1 — в углу карты видно, сколько элементов нарисовано
function renderStats() {
    if (!statsEnabled) return;
    let box = document.getElementById('stats');
    if (!box) {
        box = document.createElement('div');
        box.id = 'stats';
        box.style.cssText = 'position:absolute;left:6px;top:6px;z-index:5;background:#000a;color:#fff;font:11px monospace;padding:3px 6px;border-radius:4px;pointer-events:none';
        document.getElementById('map-container').append(box);
    }
    box.textContent = `рисуется ${stats.visible} из ${stats.total} · отсечение ${stats.ms.toFixed(2)} мс`;
}

// --- 3. ЭТАЖИ ---
const floorEl = floor => document.getElementById(`floor-${floor}`);

// id узла графа для элемента карты: "room-311" на 3 этаже -> "f3-room-311"
const graphId = (floor, svgId) => `f${floor}-${svgId}`;

// Элемент комнаты по id узла. Ищем перебором: в id бывают пробелы и апострофы.
function roomElement(nodeId) {
    const node = currentIndex.nodes.get(nodeId);
    const svgId = nodeId.replace(/^f\d+-/, '');
    return cullIndex.get(node.floor)?.byId.get(svgId)      // элемент мог быть убран отсечением — берём из индекса
        ?? [...floorEl(node.floor).querySelectorAll('[id]')].find(el => el.id === svgId);
}

function showFloor(floor) {
    currentFloor = floor;
    FLOORS.forEach(f => {
        floorEl(f).hidden = f !== floor;
        document.getElementById(`tab-${f}`).classList.toggle('active', f === floor);
    });
    // Нажали вкладку этажа при готовом маршруте: показываем ближайший шаг на этом этаже
    const near = stepForFloor(routeSteps, floor, stepIndex);
    if (near !== -1 && near !== stepIndex) { stepIndex = near; renderStepWindow(); }
    cullOffscreen();
    gestures?.refresh(); // у этажей может быть чуть другой размер SVG — пересчитать подписи
}

// --- 4. ОБРАБОТКА КЛИКОВ ПО КОМНАТАМ ---
function clearSelection() {
    const marks = ['pin-start', 'pin-end'];
    cullIndex.forEach(({ items }) => items.forEach(it => it.el.classList.remove(...marks)));   // в т.ч. убранные из DOM
    document.querySelectorAll('.room-outline').forEach(el => el.remove());                    // обводки выбранных мест
    document.querySelectorAll('.pin-start, .pin-end').forEach(el => el.classList.remove(...marks));
    document.querySelectorAll('.route-line, .route-stairs').forEach(el => el.remove());
    document.querySelectorAll('.floor-tabs button').forEach(b => b.classList.remove('has-route'));
    routeSteps = []; stepIndex = 0;
    const info = document.getElementById('route-info');
    info.className = 'route-info hidden';
    info.replaceChildren();
    syncUrl(null);
}

// Полный сброс: выбранные аудитории, линия маршрута, список шагов, сообщения
function resetRoute() {
    clearSelection();
    currentStart = null;
    currentEnd = null;
    clearStatus();
    updateTools();
}

// Пустое состояние блока шагов: подсказка вместо пустого места
function showRouteHint() {
    const info = document.getElementById('route-info');
    info.className = 'route-info empty';
    info.replaceChildren(document.createTextNode(currentStart
        ? `Старт: ${shortLabelSafe(currentStart)}. Теперь выберите, куда идти: нажмите на аудиторию или найдите её в поиске.`
        : 'Маршрут не выбран. Нажмите на аудиторию на карте или откройте поиск, затем выберите вторую точку. Туалеты, выходы и столовую можно найти кнопками выше.'));
}
const shortLabelSafe = id => { try { return shortLabel(id); } catch { return id; } };

function updateTools() {
    document.getElementById('btn-clear').hidden = !currentStart;
    document.getElementById('btn-share').hidden = !currentEnd;     // «поделиться» есть, только когда есть готовый маршрут
    if (!currentEnd) showRouteHint();
    // Подсказка в поле поиска зависит от того, что выбрано
    const hint = (!currentStart || currentEnd) ? 'Откуда? Номер или название' : 'Куда? Номер или название';
    document.getElementById('search').placeholder = hint;
    document.getElementById('search-open').textContent = hint;
    scheduleSave();
}

// Обычное нажатие на карту (приходит из gestures.js, уже отличённое от жестов и двойного нажатия)
function handleTap(target) {
    const room = target?.closest?.(PLACE_SELECTOR);
    if (!room) return;
    const floor = Number(room.closest('.floor-map').dataset.floor);
    selectNode(graphId(floor, room.id));
}

// Подсветка выбранного места (kind: 'start' или 'end'): обводка только по внешнему краю.
// Простое «stroke» на фигуре не годится: у места из нескольких фигур (столовая, спортзал) обвелась бы каждая фигура внутри,
// а стены карты лежат выше комнат и закрывают половину обводки. Поэтому рисуем отдельный слой поверх карты:
// копии фигур с толстой обводкой и маска, которая вырезает внутренность самих фигур. Остаётся только внешнее кольцо.
const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPES = 'path, rect, polygon, ellipse, circle';

function markRoom(el, kind) {
    if (!el) return;
    el.classList.add(`pin-${kind}`);                                  // метка для отсечения (выбранное не убираем из DOM) и сброса
    const svg = el.ownerSVGElement;
    const shapes = el.matches(SHAPES) ? [el] : [...el.querySelectorAll(SHAPES)];
    if (!svg || !shapes.length) return;

    const layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute('class', `room-outline outline-${kind}`);
    layer.setAttribute('aria-hidden', 'true');
    const maskId = `outline-mask-${kind}`;
    const mask = document.createElementNS(SVG_NS, 'mask');
    mask.setAttribute('id', maskId);
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    for (const [k, v] of Object.entries({ x: -5000, y: -5000, width: 10000, height: 10000 })) mask.setAttribute(k, v);
    const everything = document.createElementNS(SVG_NS, 'rect');     // белое — видно, чёрное (фигуры места) — вырезано
    for (const [k, v] of Object.entries({ x: -5000, y: -5000, width: 10000, height: 10000, fill: '#fff' })) everything.setAttribute(k, v);
    mask.append(everything);
    const ring = document.createElementNS(SVG_NS, 'g');
    ring.setAttribute('mask', `url(#${maskId})`);
    for (const shape of shapes) {
        const hole = shape.cloneNode(false);
        const line = shape.cloneNode(false);
        for (const copy of [hole, line]) copy.removeAttribute('id');
        hole.setAttribute('fill', '#000'); hole.setAttribute('stroke', 'none');
        mask.append(hole);
        ring.append(line);
    }
    layer.append(mask, ring);
    svg.append(layer);
}

// Выбор места: и нажатием на карту, и из поиска. Первый выбор — старт, второй — финиш (строим маршрут).
function selectNode(nodeId) {
    if (!currentGraph) return; // граф не загружен или не прошёл проверку

    clearStatus();

    if (!currentIndex.adj.has(nodeId)) {
        showStatus('error', `Для ${nodeId} нет данных в графе`);
        return;
    }

    const node = currentIndex.nodes.get(nodeId);
    const el = roomElement(nodeId);     // у места может не быть фигуры на карте — тогда подсветки нет, маршрут всё равно строится

    if (nodeId === currentStart && !currentEnd) {
        // Повторный выбор старта — отмена
        resetRoute();
        return;
    }

    if (!currentStart || currentEnd) {
        // Первый выбор или новый после готового маршрута: сбрасываем всё и ставим старт
        clearSelection();
        currentStart = nodeId;
        currentEnd = null;
        markRoom(el, 'start');
        showFloor(node.floor);
    } else if (nodeId !== currentStart) {
        // Есть старт, выбрали другое место: это финиш, строим маршрут
        currentEnd = nodeId;
        markRoom(el, 'end');
        if (drawRouteBetween(currentStart, currentEnd)) {
            rememberRoute(currentStart, currentEnd);
            syncUrl(currentStart, currentEnd);
        }
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

// Шаги маршрута показываются по одному-два за раз: текущий (на карте открыт его этаж) и следующий.
let routeSteps = [];
let stepIndex = 0;

function renderRouteInfo(steps) {
    routeSteps = steps;
    stepIndex = 0;
    const info = document.getElementById('route-info');
    info.className = 'route-info';
    const head = el('div', 'route-head');
    head.append(Object.assign(document.createElement('strong'), { textContent: 'Маршрут' }),
        Object.assign(el('span', 'route-count'), { id: 'route-count' }));
    const nav = el('div', 'route-nav');
    const prev = Object.assign(el('button', 'route-arrow', '‹'), { id: 'step-prev', type: 'button' });
    const next = Object.assign(el('button', 'route-arrow', '›'), { id: 'step-next', type: 'button' });
    prev.setAttribute('aria-label', 'Предыдущий шаг');
    next.setAttribute('aria-label', 'Следующий шаг');
    prev.addEventListener('click', () => goToStep(stepIndex - 1));
    next.addEventListener('click', () => goToStep(stepIndex + 1));
    const list = Object.assign(document.createElement('ol'), { id: 'route-steps' });
    nav.append(prev, list, next);
    attachSwipe(nav);
    info.replaceChildren(head, nav);
    renderStepWindow();
}

function renderStepWindow() {
    const list = document.getElementById('route-steps');
    if (!list) return;
    list.start = stepIndex + 1;
    list.replaceChildren(...visibleSteps(routeSteps, stepIndex).map(({ step, index, current }) => {
        const li = Object.assign(document.createElement('li'), { textContent: step.text });
        li.dataset.floor = step.floor;
        if (current) li.classList.add('current');
        li.addEventListener('click', () => (current ? showFloor(step.floor) : goToStep(index)));    // следующий шаг — перейти к нему
        return li;
    }));
    document.getElementById('route-count').textContent = `Шаг ${stepIndex + 1} из ${routeSteps.length}`;
    // Нет шага слева/справа — нет и стрелки (место под неё остаётся, текст не прыгает)
    document.getElementById('step-prev').classList.toggle('invisible', !hasPrev(stepIndex));
    document.getElementById('step-next').classList.toggle('invisible', !hasNext(stepIndex, routeSteps.length));
}

function goToStep(index) {
    const next = clampStep(index, routeSteps.length);
    if (!routeSteps.length || next === stepIndex) return;
    stepIndex = next;
    renderStepWindow();
    showFloor(routeSteps[stepIndex].floor);       // на карте — этаж текущего шага
}

// Свайп по шагам: влево — дальше, вправо — назад. Вертикальная прокрутка страницы (touch-action: pan-y) не мешает.
function attachSwipe(target) {
    let start = null;
    let swiped = false;
    target.addEventListener('pointerdown', e => {
        if (e.target.closest('button')) return;
        start = { x: e.clientX, y: e.clientY, t: performance.now() };
        swiped = false;
    });
    target.addEventListener('pointerup', e => {
        if (!start) return;
        const dir = swipeDirection(e.clientX - start.x, e.clientY - start.y, performance.now() - start.t);
        start = null;
        if (dir) { swiped = true; goToStep(stepIndex + dir); }
    });
    target.addEventListener('pointercancel', () => { start = null; });
    // после свайпа браузер может прислать «click» по шагу: он не должен переключать шаг второй раз
    target.addEventListener('click', e => { if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; } }, true);
}

function drawRouteBetween(startId, endId) {
    const result = findShortestPath(currentIndex, startId, endId);

    if (!result) {
        showStatus('error', `Маршрут из ${roomLabel(startId)} в ${roomLabel(endId)} не найден`,
            ['Одна из аудиторий не связана с остальным зданием']);
        return false;
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
    return true;
}

// --- 6. ПОИСК, ИЗБРАННОЕ, НЕДАВНИЕ (F2) ---
let searchIndex = [];
let favorites = [];       // id мест
let recents = [];         // [{ from, to }]

const shortLabel = id => String(roomLabel(id)).split(' — ')[0];

function rememberRoute(from, to) {
    recents = pushRecent(recents, { from, to });
    saveJSON(RECENTS_KEY, recents);
}

// --- ЭКРАНЫ И НАВИГАЦИЯ (C4) ---
// Три экрана: карта (она всегда под остальными), поиск и «поделиться». Поиск и «поделиться» открываются поверх карты
// и кладут запись в историю браузера, поэтому «Назад» (кнопка ←, кнопка браузера, жест на телефоне) возвращает на карту.
// Пока открыт поиск, карта закрыта целиком — случайные касания по ней невозможны.
let screen = 'map';
const canShare = () => !!currentEnd;

function renderScreen(name) {
    screen = name;
    const input = document.getElementById('search');
    document.getElementById('screen-search').hidden = name !== 'search';
    document.getElementById('screen-share').hidden = name !== 'share';
    document.getElementById('screen-scan').hidden = name !== 'scan';
    if (name !== 'scan') clearScan();
    if (name === 'search') {
        renderSuggestions();
        input.focus();
    } else {
        input.value = '';
        input.blur();
    }
    if (name === 'share') renderShareScreen();
    scheduleSave();
}

function openScreen(name) {
    if (name === screen) return;
    const depth = (history.state?.depth ?? 0) + 1;
    try {
        history.pushState({ screen: name, depth }, '', location.pathname + location.search + hashFor(name));
    } catch { /* без истории экран всё равно откроется, но «Назад» браузера не сработает */ }
    renderScreen(name);
}

// Назад: есть наша запись в истории — идём по ней (дальше сработает popstate); нет — подменяем адрес на карту.
// Возвращает Promise, который выполняется, когда переход закончился: адрес меняет только после этого,
// иначе replaceState (ссылка маршрута) попал бы в запись, которую мы как раз закрываем, и ссылка потерялась бы.
function goBack() {
    if (backAction(history.state?.depth) === 'history-back') {
        return new Promise(resolve => {
            window.addEventListener('popstate', () => setTimeout(resolve), { once: true });
            setTimeout(resolve, 500);                       // запасной выход, если popstate не пришёл
            history.back();
        });
    }
    try {
        history.replaceState({ screen: 'map', depth: 0 }, '', location.pathname + location.search);
    } catch { /* адрес не меняем */ }
    renderScreen('map');
    return Promise.resolve();
}

const closeSearch = goBack;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function placeRow(entry) {
    const li = el('li', 'sug');
    li.dataset.place = entry.id;
    const main = el('div', 'sug-text');
    main.append(el('div', 'sug-main', entry.label), el('div', 'sug-sub', `${entry.floor} этаж`));
    const star = el('button', 'fav', favorites.includes(entry.id) ? '★' : '☆');
    star.type = 'button';
    star.dataset.fav = entry.id;
    star.setAttribute('aria-label', favorites.includes(entry.id) ? 'Убрать из избранного' : 'В избранное');
    li.append(main, star);
    return li;
}

function renderSuggestions() {
    const list = document.getElementById('suggestions');
    const query = document.getElementById('search').value;
    list.replaceChildren();

    if (query.trim()) {
        const found = searchPlaces(searchIndex, query);
        if (!found.length) list.append(el('li', 'sug-empty', 'Ничего не найдено'));
        found.forEach(e => list.append(placeRow(e)));
        return;
    }

    // Пустой запрос: избранное и недавние маршруты
    const byId = new Map(searchIndex.map(e => [e.id, e]));
    if (favorites.length) {
        list.append(el('li', 'sug-heading', 'Избранное'));
        favorites.forEach(id => byId.has(id) && list.append(placeRow(byId.get(id))));
    }
    if (recents.length) {
        list.append(el('li', 'sug-heading', 'Недавние маршруты'));
        recents.forEach((r, i) => {
            const li = el('li', 'sug');
            li.dataset.recent = i;
            li.append(el('div', 'sug-main', `${shortLabel(r.from)} → ${shortLabel(r.to)}`));
            list.append(li);
        });
    }
    if (!favorites.length) list.append(el('li', 'sug-heading', 'Избранное'), el('li', 'sug-empty', 'Пока пусто: нажмите ☆ рядом с местом в результатах поиска'));
    if (!recents.length) list.append(el('li', 'sug-heading', 'Недавние маршруты'), el('li', 'sug-empty', 'Пока пусто: здесь появятся построенные маршруты'));
}

function onSuggestionClick(event) {
    const star = event.target.closest('[data-fav]');
    if (star) {                                   // звёздочка: только избранное, поле остаётся открытым
        favorites = toggleFavorite(favorites, star.dataset.fav);
        saveJSON(FAVORITES_KEY, favorites);
        renderSuggestions();
        return;
    }
    const place = event.target.closest('[data-place]');
    if (place) {
        closeSearch().then(() => selectNode(place.dataset.place));
        return;
    }
    const recent = event.target.closest('[data-recent]');
    if (recent) {                                 // недавний маршрут: строим сразу
        const { from, to } = recents[Number(recent.dataset.recent)];
        closeSearch().then(() => { resetRoute(); selectNode(from); selectNode(to); });
    }
}

function setupSearch() {
    const input = document.getElementById('search');
    const list = document.getElementById('suggestions');
    const valid = new Set(currentGraph.nodes.map(n => n.id));

    searchIndex = buildSearchIndex(currentGraph.nodes);
    favorites = sanitizeFavorites(loadJSON(FAVORITES_KEY, []), valid);
    recents = sanitizeRecents(loadJSON(RECENTS_KEY, []), valid);

    input.addEventListener('input', renderSuggestions);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            const first = list.querySelector('[data-place]');
            if (first) closeSearch().then(() => selectNode(first.dataset.place));
        }
    });
    // Не даём списку отобрать фокус у поля до того, как сработает нажатие на строку
    list.addEventListener('mousedown', e => e.preventDefault());
    list.addEventListener('click', onSuggestionClick);

    document.getElementById('search-open').addEventListener('click', () => openScreen('search'));
    document.getElementById('btn-share').addEventListener('click', () => openScreen('share'));
    document.getElementById('scan-open').addEventListener('click', () => openScreen('scan'));
    document.getElementById('scan-camera').addEventListener('change', onScanFile);
    document.getElementById('scan-gallery').addEventListener('change', onScanFile);
    document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', goBack));
    // Кнопка «Назад» браузера или жест на телефоне: экран берём из адреса
    window.addEventListener('popstate', () => renderScreen(screenFromHash(location.hash, { canShare: canShare() })));
}

// --- S1. СТАРТ ПО ФОТО ТАБЛИЧКИ ---
// Фото -> рамки с цифрами (signs.js) -> OCR только по ним (ocr.js) -> номер, который есть в здании -> старт маршрута.
// Распознанное предлагаем как кнопку, а не принимаем молча: ошибка распознавания не должна ставить старт не туда.
let nameIndex = null;       // индекс названий для поиска по надписи (строится один раз)
let scanRun = 0;            // номер последнего запуска: устаревший результат (после «Назад» или нового фото) не показываем
let scanUrl = null;

function clearScan() {
    scanRun++;
    if (scanUrl) { URL.revokeObjectURL(scanUrl); scanUrl = null; }
    const preview = document.getElementById('scan-preview');
    preview.hidden = true; preview.removeAttribute('src');
    document.getElementById('scan-result').replaceChildren();
    for (const id of ['scan-camera', 'scan-gallery']) document.getElementById(id).value = '';     // чтобы то же фото можно было выбрать ещё раз
}

function startFromScan(nodeId) {
    goBack().then(() => { resetRoute(); selectNode(nodeId); });
}

function showScanPicks(ids, title) {
    const buttons = ids.map((id, i) => {
        const b = el('button', i === 0 ? 'primary' : '', `${i === 0 ? 'Начать отсюда: ' : ''}${shortLabelSafe(id)} (${currentIndex.nodes.get(id).floor} этаж)`);
        b.addEventListener('click', () => startFromScan(id));
        return b;
    });
    showScanMessage(el('p', '', title), ...buttons);
}

function showScanMessage(...parts) {
    document.getElementById('scan-result').replaceChildren(...parts);
}

async function onScanFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const run = ++scanRun;
    if (scanUrl) URL.revokeObjectURL(scanUrl);
    scanUrl = URL.createObjectURL(file);
    const preview = document.getElementById('scan-preview');
    preview.src = scanUrl; preview.hidden = false;
    const say = text => run === scanRun && showScanMessage(el('p', '', text));
    say('Распознаю…');
    try {
        const { readPhoto } = await import('./ocr.js');           // тяжёлая часть грузится только здесь
        const reads = await readPhoto(file, say);
        if (run !== scanRun) return;
        const rooms = roomNumberIndex(currentGraph.nodes);
        const picks = pickRoomNumber(reads, rooms).slice(0, 3);
        if (picks.length) {
            showScanPicks(picks.map(p => p.id), picks.length > 1 ? 'Нашла несколько номеров. Выберите свой:' : 'Номер на двери:');
            return;
        }
        // Номера нет (кафедра, «Серверная», «Спортивный зал»): читаем надписи и сверяем с названиями мест
        const { readLabels } = await import('./ocr.js');
        const lines = await readLabels(file, say);
        if (run !== scanRun) return;
        nameIndex ??= buildNameIndex(currentGraph.nodes);
        const byName = matchNames(nameIndex, lines);
        if (byName.length) {
            showScanPicks(byName.map(m => m.id), byName.length > 1 ? 'По надписи подходят несколько мест. Выберите своё:' : 'Нашла по надписи:');
            return;
        }
        const seen = [...new Set(reads.flatMap(r => numbersIn(r.text)))];
        const search = el('button', '', '🔍 Найти аудиторию в поиске');
        search.addEventListener('click', () => goBack().then(() => openScreen('search')));
        showScanMessage(
            el('p', '', 'Номер и надпись не распознаны.'),
            el('p', 'scan-note', seen.length
                ? `Нашла только ${seen.join(', ')}: такой аудитории нет в здании. `
                : 'Попробуйте снять ближе и ровнее: чтобы номер или надпись были крупными и без бликов.'),
            search);
    } catch (err) {
        if (run !== scanRun) return;
        const retry = el('button', '', 'Повторить');
        retry.addEventListener('click', () => onScanFile({ target: event.target }));
        showScanMessage(el('p', '', 'Не удалось распознать фото.'),
            el('p', 'scan-note', 'Распознавание грузится один раз и потом работает без сети. Проверьте соединение и повторите, либо найдите аудиторию в поиске.'),
            retry);
        console.error(err);
    }
}

// --- 7. БЛИЖАЙШЕЕ МЕСТО (F3) ---
const POI_TITLES = {
    'wc-man': 'мужской туалет',
    'wc-woman': 'женский туалет',
    'wc-special': 'специальный туалет',
    'exit': 'выход',
    'dining': 'столовая',
};

// От выбранного старта ищем ближайшее место категории poi и сразу строим маршрут до него
function routeToNearest(poi) {
    const title = POI_TITLES[poi] ?? poi;
    if (!currentStart) {
        showStatus('warning', 'Сначала выберите, откуда идти',
            [`Нажмите на аудиторию на карте или найдите её в поиске, затем выберите «${title}».`]);
        return;
    }
    const from = currentStart;
    const found = findNearest(currentIndex, from, poi);
    if (!found) {
        showStatus('error', `Не нашла: ${title}`, ['Такого места нет в данных или до него нет пути']);
        return;
    }
    resetRoute();            // убираем прежний маршрут, старт ставим заново
    selectNode(from);
    selectNode(found.id);          // без плашки «Ближайшее: …»: маршрут и шаги под картой уже говорят, куда идти
}

function setupQuickButtons() {
    document.getElementById('quick').addEventListener('click', e => {
        const button = e.target.closest('[data-poi]');
        if (button) routeToNearest(button.dataset.poi);
    });
}

// --- 8. ССЫЛКА И QR-КОД (F3) ---

// Адрес страницы без параметров маршрута
const baseUrl = () => location.origin + location.pathname;

// Держим адресную строку в актуальном состоянии: открытый маршрут — это ссылка, которой можно поделиться
function syncUrl(from, to) {
    try {
        history.replaceState(history.state, '', (from && to ? buildShareUrl(baseUrl(), from, to) : baseUrl()) + location.hash);
    } catch { /* адрес не меняем, если браузер не разрешает */ }
}

function shareBlock(startId, endId) {
    const url = buildShareUrl(baseUrl(), startId, endId);
    const box = el('div', 'share');

    const buttons = el('div', 'share-buttons');
    const qrButton = el('button', null, 'QR-код');
    const copyButton = el('button', null, 'Копировать ссылку');
    [qrButton, copyButton].forEach(b => b.type = 'button');
    buttons.append(qrButton, copyButton);
    if (navigator.share) {                                   // системное меню «Поделиться» (на телефоне по https)
        const shareButton = el('button', null, 'Поделиться');
        shareButton.type = 'button';
        shareButton.addEventListener('click', () =>
            navigator.share({ title: 'Маршрут по корпусу', url }).catch(() => {}));
        buttons.prepend(shareButton);
    }

    const field = el('input', 'share-url');
    field.readOnly = true;
    field.value = url;
    field.addEventListener('focus', () => field.select());

    const qrBox = el('div', 'qr');
    qrBox.hidden = true;
    qrButton.addEventListener('click', () => {
        if (!qrBox.childElementCount) {
            const qr = qrcode(0, 'M');                       // размер подбирается автоматически
            qr.addData(url);
            qr.make();
            qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        }
        qrBox.hidden = !qrBox.hidden;
    });

    copyButton.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(url);        // работает только по https или localhost
        } catch {
            field.select();                                  // запасной вариант для http по IP
            document.execCommand('copy');
        }
        copyButton.textContent = 'Скопировано';
        setTimeout(() => { copyButton.textContent = 'Копировать ссылку'; }, 1500);
    });

    box.append(buttons, field, qrBox);
    return box;
}

// Экран «поделиться»: что за маршрут и блок со ссылкой и QR-кодом
function renderShareScreen() {
    const body = document.getElementById('share-body');
    body.replaceChildren();
    if (!currentStart || !currentEnd) {
        body.append(el('p', 'share-empty', 'Сначала постройте маршрут: выберите, откуда и куда идти.'));
        return;
    }
    body.append(el('p', 'share-route', `${shortLabel(currentStart)} → ${shortLabel(currentEnd)}`), shareBlock(currentStart, currentEnd));
}

// Если страницу открыли по ссылке с маршрутом — строим его сразу
function openSharedRoute() {
    const isPlace = id => {
        const node = currentIndex.nodes.get(id);
        return !!node && ['room', 'wc', 'exit'].includes(node.type);
    };
    const shared = parseShareParams(location.search, isPlace);
    if (!shared) return;
    if (shared.error) {
        showStatus('warning', 'Ссылку не удалось открыть', [shared.error]);
        syncUrl(null);
        return;
    }
    selectNode(shared.from);
    selectNode(shared.to);
}

// --- КОМПАС (S2) ---
// Кнопка «Компас» включает датчик ориентации телефона: карта поворачивается так, чтобы «вверх» экрана было там, куда
// смотрит человек. Математика — в compass.js. «Вверх» плана у каждого здания смотрит в свою сторону света, поэтому
// есть калибровка: встать лицом туда, куда направлено «вверх» плана, и нажать «Задать «вверх»» — угол запоминается.
// Позицию человека по датчикам определить нельзя (GPS в помещении не работает), поэтому поворачивается только карта.
const compass = { on: false, heading: null, offset: 0, gotAbsolute: false, sawData: false, pendingPlain: null, fallbackTimer: null, target: null, frameAt: 0, startedAt: 0, lastEventAt: 0, manualUntil: 0, raf: null, watchdog: null };
const MANUAL_PAUSE_MS = 3000;        // после прикосновения к карте (сдвиг, щипок) компас не мешает три секунды
const NO_SENSOR_MS = 2000;           // столько ждём первое событие датчика, потом считаем, что датчика нет
const RELATIVE_FALLBACK_MS = 1000;   // «абсолютных» событий нет — берём обычные (в эмуляции DevTools и на части устройств)

function loadNorthOffset() {
    try { compass.offset = sanitizeOffset(localStorage.getItem(NORTH_KEY)); } catch { compass.offset = 0; }
}

function setCompassButtons(on) {
    const b = document.getElementById('btn-compass');
    b.setAttribute('aria-pressed', String(on));
    document.getElementById('btn-north').hidden = !on;
}

// Каждый кадр приближаем сглаженное направление к последнему показанию датчика и поворачиваем карту.
// Цикл идёт, пока не дошли до цели (или пока карту держат пальцами), потом останавливается и ждёт новых событий.
function applyCompass(now = performance.now()) {
    compass.raf = null;
    if (!compass.on || compass.target == null || !gestures) return;
    const dt = compass.frameAt ? now - compass.frameAt : 0;
    compass.frameAt = now;
    compass.heading = approachHeading(compass.heading, compass.target, dt);

    let settled = true;
    if (now >= compass.manualUntil) {
        const { W, H } = gestures.size;
        const view = gestures.view;
        const dr = wrapPi(mapRotation(compass.heading, compass.offset) - view.r);
        if (Math.abs(dr) > 0.002) gestures.setView(rotateAbout(view, { x: W / 2, y: H / 2 }, dr));
        settled = Math.abs(dr) < 0.004 && Math.abs(angleDiff(compass.target, compass.heading)) < 0.3;
    } else {
        settled = false;                                    // карту держат — подождём
    }
    if (settled) compass.frameAt = 0;
    else compass.raf = requestAnimationFrame(applyCompass);
}

// absoluteEvent: событие deviceorientationabsolute (направление относительно севера).
// Обычные события (deviceorientation) считаются запасным вариантом: берём их, если за секунду «абсолютных» не было.
// Эмуляция датчика в DevTools присылает событие один раз при смене значений, поэтому последнее обычное запоминаем
// и применяем, когда секунда ожидания закончилась, даже если новых событий уже не будет.
function acceptHeading(h) {
    compass.lastEventAt = performance.now();
    compass.target = h;
    if (compass.heading == null) compass.heading = h;         // первое показание — сразу, без разгона
    if (compass.raf === null) compass.raf = requestAnimationFrame(applyCompass);
}

function onOrientation(e, absoluteEvent) {
    if (!compass.on) return;
    const h = headingFromEvent(e);
    if (h == null) return;                  // Chrome без датчика присылает пустые события — они не считаются
    compass.sawData = true;                 // датчик жив, даже если пока не берём его данные
    if (absoluteEvent) compass.gotAbsolute = true;
    const trusted = absoluteEvent || typeof e.webkitCompassHeading === 'number' || e.absolute === true;
    if (trusted) {
        acceptHeading(h);
    } else if (!compass.gotAbsolute) {
        compass.pendingPlain = h;
        if (performance.now() - compass.startedAt > RELATIVE_FALLBACK_MS) acceptHeading(h);
    }
}

const onAbsolute = e => onOrientation(e, true);
const onPlain = e => onOrientation(e, false);

function stopCompass() {
    window.removeEventListener('deviceorientationabsolute', onAbsolute);
    window.removeEventListener('deviceorientation', onPlain);
    clearTimeout(compass.watchdog);
    clearTimeout(compass.fallbackTimer);
    cancelAnimationFrame(compass.raf);
    Object.assign(compass, { on: false, heading: null, target: null, frameAt: 0, gotAbsolute: false, sawData: false, pendingPlain: null, raf: null, watchdog: null, fallbackTimer: null });
    setCompassButtons(false);
}

async function startCompass() {
    if (!window.isSecureContext || !('DeviceOrientationEvent' in window)) {
        showStatus('warning', 'Компас здесь недоступен', ['Датчик ориентации работает на телефоне и только по https (например, на GitHub Pages).']);
        return;
    }
    // iOS спрашивает разрешение; вызывать нужно прямо из нажатия на кнопку
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
            if (await DeviceOrientationEvent.requestPermission() !== 'granted') throw new Error('denied');
        } catch {
            showStatus('warning', 'Нет доступа к датчикам', ['Разрешите доступ к движению и ориентации в настройках браузера и включите компас снова.']);
            return;
        }
    }
    compass.on = true;
    compass.startedAt = performance.now();
    compass.lastEventAt = 0;
    compass.sawData = false;
    compass.pendingPlain = null;
    setCompassButtons(true);
    window.addEventListener('deviceorientationabsolute', onAbsolute);
    window.addEventListener('deviceorientation', onPlain);
    showStatus('info', 'Компас включён: карта поворачивается вслед за вами', [
        'Если направление не совпало с планом: встаньте лицом туда, куда на карте направлено «вверх», и нажмите «Задать «вверх»». Это нужно один раз, значение запомнится.',
        'Телефон лучше держать вертикально перед собой.',
    ]);
    // Если за секунду «абсолютных» событий не было, а обычное пришло — применяем его (новых может и не быть)
    compass.fallbackTimer = setTimeout(() => {
        if (compass.on && !compass.gotAbsolute && compass.pendingPlain != null) acceptHeading(compass.pendingPlain);
    }, RELATIVE_FALLBACK_MS + 50);
    compass.watchdog = setTimeout(() => {
        if (compass.on && !compass.sawData) {
            stopCompass();
            showStatus('warning', 'Компас не отвечает', ['Датчик ориентации не присылает данные. На компьютере его обычно нет; попробуйте на телефоне.']);
        }
    }, NO_SENSOR_MS);
}

function toggleCompass() {
    if (compass.on) {
        stopCompass();
        clearStatus();
    } else {
        startCompass();
    }
}

function calibrateNorth() {
    if (!compass.on || compass.heading == null) return;
    compass.offset = compass.target ?? compass.heading;     // берём последнее показание датчика, а не сглаженное
    compass.heading = compass.offset;
    try { localStorage.setItem(NORTH_KEY, String(Math.round(compass.offset * 10) / 10)); } catch { /* без хранилища калибровка живёт до перезагрузки */ }
    compass.manualUntil = 0;
    applyCompass();                                          // карта сразу встаёт «вверх» плана
    showStatus('info', `«Вверх» на плане задано: ${Math.round(compass.offset)}°`, ['Теперь карта совпадает с тем, что перед вами.']);
}

function setupCompass() {
    loadNorthOffset();
    document.getElementById('btn-compass').addEventListener('click', toggleCompass);
    document.getElementById('btn-north').addEventListener('click', calibrateNorth);
    // Пока человек двигает карту пальцами, компас её не крутит
    document.getElementById('map-container').addEventListener('pointerdown', () => { compass.manualUntil = performance.now() + MANUAL_PAUSE_MS; });
}

// --- СОХРАНЕНИЕ СОСТОЯНИЯ (C7) ---
// Этаж, вид карты, старт/финиш и запрос в поиске пишем в sessionStorage — при перезагрузке страницы
// (в том числе когда телефон выгрузил вкладку в фоне) всё возвращается. Поворот экрана страницу не перезагружает:
// вид карты просто подгоняется под новый размер (ResizeObserver в gestures.js).
let saveTimer = null;
let restoring = true;          // пока запускаемся, не затираем сохранённое
const storage = (() => { try { return window.sessionStorage; } catch { return null; } })();

function saveNow() {
    if (!storage || restoring || !gestures) return;
    saveSession(storage, {
        floor: currentFloor, view: { ...gestures.view },
        start: currentStart, end: currentEnd, query: document.getElementById('search').value,
    });
}

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
}

function setupSessionSaving() {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
    window.addEventListener('pagehide', saveNow);
    document.getElementById('search').addEventListener('input', scheduleSave);
}

// Возвращаем сохранённое. Маршрут из адреса (?from=…&to=…) главнее сохранённого.
function restoreSession(hasSharedRoute) {
    const saved = storage && loadSession(storage, {
        floors: FLOORS,
        isPlace: id => ['room', 'wc', 'exit'].includes(currentIndex.nodes.get(id)?.type),
    });
    if (!saved) return null;
    if (!hasSharedRoute && saved.start) {
        selectNode(saved.start);
        if (saved.end) selectNode(saved.end);
    }
    return saved;
}

// --- 9. СТАРТ ---
// Состояния экрана карты: загрузка (индикатор), ошибка (сообщение и «Повторить»), готово.
// Запуск можно повторить после ошибки: повторять нечего, пока не прошла загрузка файлов, поэтому слушатели вешаются только после неё.
async function start() {
    const loading = document.getElementById('loading');
    loading.hidden = false;
    clearStatus();
    try {
        const graph = await loadGraph();
        FLOORS = floorsOf(graph);
        if (!FLOORS.length) throw new GraphError('В data.json не указаны этажи: пересоберите граф (python run.py)');
        START_FLOOR = FLOORS[FLOORS.length - 1];          // открываем верхний этаж, как и раньше
        currentFloor = START_FLOOR;
        await loadMaps();

        // Сверяем граф с тем, что нарисовано на картах всех этажей
        const rooms = FLOORS.flatMap(f =>
            [...floorEl(f).querySelectorAll('#Rooms [id^="room-"]')].map(el => ({ el, floor: f })));
        const warnings = assertValidGraph(graph, rooms.map(({ el, floor }) => graphId(floor, el.id)));

        currentGraph = graph;
        currentIndex = createGraphIndex(graph);

        gestures = attachGestures(document.getElementById('map-container'), { onChange: applyView, onTap: handleTap, contentSize });
        document.getElementById('btn-view').addEventListener('click', () => { stopCompass(); gestures.reset(); });
        document.getElementById('btn-clear').addEventListener('click', resetRoute);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (screen === 'map') resetRoute(); else goBack(); } });
        setupSearch();
        setupQuickButtons();
        setupCompass();
        setupSessionSaving();
        updateTools();
        openSharedRoute();
        const saved = restoreSession(!!currentStart);

        showFloor(saved?.floor ?? (currentStart ? currentFloor : START_FLOOR));
        if (saved?.view) gestures.setView(saved.view);

        // Экран берём из адреса: после перезагрузки на #/search или #/share возвращаемся туда же
        const startScreen = screenFromHash(location.hash, { canShare: canShare() });
        try { history.replaceState({ screen: startScreen, depth: 0 }, '', location.pathname + location.search + hashFor(startScreen)); } catch { /* адрес не трогаем */ }
        if (startScreen === 'search' && saved?.query) document.getElementById('search').value = saved.query;
        renderScreen(startScreen);
        restoring = false;
        saveNow();
        if (warnings.length) showStatus('warning', 'Данные карты загружены с замечаниями', warnings);
    } catch (err) {
        if (err instanceof GraphError) {
            showStatus('error', err.message, err.problems, err.retryable ? { onRetry: start } : {});
        } else {
            showStatus('error', 'Не удалось запустить приложение', [String(err.message ?? err)], { onRetry: start });
            console.error(err);
        }
    } finally {
        loading.hidden = true;
    }
}

// Полоса «нет сети»: показываем, пока связи нет. Приложение при этом работает: план и граф уже загружены,
// а при следующем запуске их отдаст service worker из кеша (sw.js).
// navigator.onLine врёт: на телефоне он остаётся true при Wi-Fi без интернета или выключенных данных. Поэтому кроме него
// проверяем связь запросом: HEAD к своему же файлу. Service worker обрабатывает только GET, значит, ответ из кеша
// не подменит настоящую проверку.
const PING_EVERY_MS = 15000, PING_TIMEOUT_MS = 4000;

async function isOnline() {
    if (navigator.onLine === false) return false;
    try {
        const res = await fetch(`sw.js?ping=${Date.now()}`, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
        return res.ok || res.status < 500;
    } catch {
        return false;
    }
}

function setupNetworkBanner() {
    const banner = document.getElementById('net');
    const update = async () => { banner.hidden = await isOnline(); };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
    setInterval(() => { if (!document.hidden) update(); }, PING_EVERY_MS);
    update();
}

function registerServiceWorker() {
    // Работает только по https и на localhost; в остальных случаях (http по IP в локальной сети) просто пропускаем
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker не зарегистрирован:', err));
    }
}

window.onload = () => {
    setupNetworkBanner();
    registerServiceWorker();
    start();
};
