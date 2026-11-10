import { assertValidGraph, createGraphIndex, findShortestPath, findNearest, GraphError } from './graph.js';
import { buildShareUrl, parseShareParams } from './share.js';
import qrcode from './vendor/qrcode.mjs';
import { attachGestures } from './gestures.js';
import { labelScale } from './viewmath.js';
import {
    buildSearchIndex, searchPlaces, toggleFavorite, pushRecent, sanitizeFavorites, sanitizeRecents,
    loadJSON, saveJSON, FAVORITES_KEY, RECENTS_KEY,
} from './search.js';

const FLOORS = [1, 2, 3];
const START_FLOOR = 3;
const NS = 'http://www.w3.org/2000/svg';

// На что можно нажать на карте: аудитории (room-…) и туалеты (man-WC, woman-WC-1, special-WC …)
const PLACE_SELECTOR = '#Rooms [id^="room-"], #Rooms [id^="man-WC"], #Rooms [id^="woman-WC"], #Rooms [id^="special-WC"]';

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
        const response = await fetch(`maps/map${floor}.svg`, { cache: 'no-cache' });
        if (!response.ok) throw new GraphError(`Не удалось загрузить карту этажа ${floor} (maps/map${floor}.svg): ${response.status}`);

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
    const response = await fetch('data/data.json', { cache: 'no-cache' });
    if (!response.ok) throw new GraphError(`Не удалось загрузить данные здания (data/data.json): ${response.status}`);
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
    return [...floorEl(node.floor).querySelectorAll('[id]')].find(el => el.id === svgId);
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

function updateTools() {
    document.getElementById('btn-clear').hidden = !currentStart;
    // Подсказка в поле поиска зависит от того, что выбрано
    document.getElementById('search').placeholder =
        (!currentStart || currentEnd) ? 'Откуда? Номер или название' : 'Куда? Номер или название';
}

// Обычное нажатие на карту (приходит из gestures.js, уже отличённое от жестов и двойного нажатия)
function handleTap(target) {
    const room = target?.closest?.(PLACE_SELECTOR);
    if (!room) return;
    const floor = Number(room.closest('.floor-map').dataset.floor);
    selectNode(graphId(floor, room.id));
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
        el?.classList.add('start-room');
        showFloor(node.floor);
    } else if (nodeId !== currentStart) {
        // Есть старт, выбрали другое место: это финиш, строим маршрут
        currentEnd = nodeId;
        el?.classList.add('end-room');
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

function renderRouteInfo(steps, startId, endId) {
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
    info.append(ol, shareBlock(startId, endId));
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

    renderRouteInfo(describeSteps(segments, startId, endId), startId, endId);
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

// Пока человек печатает, карта закрыта «щитом»: случайные касания не выберут аудиторию и не сдвинут карту
function setTyping(on) {
    document.getElementById('map-wrap').classList.toggle('typing', on);
    document.getElementById('map-shield').hidden = !on;
    document.getElementById('suggestions').hidden = !on;
}

function closeSearch() {
    const input = document.getElementById('search');
    input.value = '';
    input.blur();
    setTyping(false);
}

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
    if (!favorites.length && !recents.length) list.append(el('li', 'sug-empty', 'Введите номер аудитории или название'));
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
        closeSearch();
        selectNode(place.dataset.place);
        return;
    }
    const recent = event.target.closest('[data-recent]');
    if (recent) {                                 // недавний маршрут: строим сразу
        const { from, to } = recents[Number(recent.dataset.recent)];
        closeSearch();
        resetRoute();
        selectNode(from);
        selectNode(to);
    }
}

function setupSearch() {
    const input = document.getElementById('search');
    const list = document.getElementById('suggestions');
    const valid = new Set(currentGraph.nodes.map(n => n.id));

    searchIndex = buildSearchIndex(currentGraph.nodes);
    favorites = sanitizeFavorites(loadJSON(FAVORITES_KEY, []), valid);
    recents = sanitizeRecents(loadJSON(RECENTS_KEY, []), valid);

    input.addEventListener('focus', () => { setTyping(true); renderSuggestions(); });
    input.addEventListener('input', renderSuggestions);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            const first = list.querySelector('[data-place]');
            if (first) { closeSearch(); selectNode(first.dataset.place); }
        } else if (e.key === 'Escape') {
            e.stopPropagation();                  // Esc закрывает поиск, а не сбрасывает маршрут
            closeSearch();
        }
    });
    // Не даём списку отобрать фокус у поля до того, как сработает нажатие на строку
    list.addEventListener('mousedown', e => e.preventDefault());
    list.addEventListener('click', onSuggestionClick);
    // Нажатие на затемнённую карту закрывает поиск (и клавиатуру)
    document.getElementById('map-shield').addEventListener('pointerdown', e => { e.preventDefault(); closeSearch(); });
}

// --- 7. БЛИЖАЙШЕЕ МЕСТО (F3) ---
const POI_TITLES = {
    'wc-man': 'мужской туалет',
    'wc-woman': 'женский туалет',
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
    selectNode(found.id);
    const node = currentIndex.nodes.get(found.id);
    showStatus('info', `Ближайшее: ${node.label} (${node.floor} этаж)`);
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
        history.replaceState(null, '', from && to ? buildShareUrl(baseUrl(), from, to) : baseUrl());
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

// --- 9. СТАРТ ---
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
        setupSearch();
        setupQuickButtons();
        updateTools();
        openSharedRoute();

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
