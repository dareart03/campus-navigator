// Поиск мест, избранное и недавние маршруты. Без DOM, поэтому тестируется в Node.

export const FAVORITES_KEY = 'navigator.favorites';
export const RECENTS_KEY = 'navigator.recents';
export const MAX_RECENTS = 5;

// Приведение к виду для сравнения: регистр, «ё», тире и лишние пробелы не мешают
export const normalize = s =>
    String(s).toLowerCase().replaceAll('ё', 'е').replace(/[—–-]/g, ' ').replace(/\s+/g, ' ').trim();

// Что можно найти: аудитории, туалеты и выходы. Для каждого — название, синонимы (aliases) и имя из SVG.
export function buildSearchIndex(nodes) {
    return [...nodes]
        .filter(n => n.type === 'room' || n.type === 'wc' || n.type === 'exit')
        .map(n => {
            const label = n.label ?? n.id;
            const svgName = n.id.replace(/^f\d+-(room-)?/, '');
            return {
                id: n.id,
                label,
                floor: n.floor,
                // fields[0] — основное название, остальное (синонимы, имя из SVG) весит чуть меньше
                fields: [label, ...(n.aliases ?? []), svgName].map(normalize),
            };
        });
}

// Оценка совпадения одного слова запроса с одним полем: меньше — лучше, Infinity — нет совпадения
function tokenScore(field, token) {
    if (field === token) return 0;
    if (field.startsWith(token)) return 1;
    if (` ${field}`.includes(` ${token}`)) return 2;      // начало любого слова
    if (field.includes(token)) return 3;
    return Infinity;
}

// Найти места по запросу. Все слова запроса должны найтись (в любом порядке): «каф матем» найдёт кафедру.
export function searchPlaces(index, query, limit = 8) {
    const tokens = normalize(query).split(' ').filter(Boolean);
    if (!tokens.length) return [];

    const scored = [];
    for (const entry of index) {
        let total = 0;
        for (const token of tokens) {
            let best = Infinity;
            entry.fields.forEach((field, i) => { best = Math.min(best, tokenScore(field, token) + (i === 0 ? 0 : 0.5)); });
            total += best;
            if (best === Infinity) break;
        }
        if (Number.isFinite(total)) scored.push({ entry, total });
    }
    scored.sort((a, b) => a.total - b.total || b.entry.floor - a.entry.floor
        || a.entry.label.localeCompare(b.entry.label, 'ru', { numeric: true }));
    return scored.slice(0, limit).map(s => s.entry);
}

// --- Избранное и недавние: чистые функции над списками ---

export function toggleFavorite(list, id) {
    return list.includes(id) ? list.filter(x => x !== id) : [id, ...list];
}

// Новый маршрут — в начало; такой же старый убираем; хранится не больше `max`
export function pushRecent(list, { from, to }, max = MAX_RECENTS) {
    return [{ from, to }, ...list.filter(r => !(r.from === from && r.to === to))].slice(0, max);
}

// Данные из localStorage могли устареть (аудиторию убрали из data.json) или быть испорчены — оставляем только валидное
export const sanitizeFavorites = (list, validIds) =>
    Array.isArray(list) ? list.filter(id => typeof id === 'string' && validIds.has(id)) : [];

export const sanitizeRecents = (list, validIds) =>
    Array.isArray(list)
        ? list.filter(r => r && validIds.has(r.from) && validIds.has(r.to) && r.from !== r.to).slice(0, MAX_RECENTS)
        : [];

// --- localStorage: может быть недоступен (приватный режим, запрет) — тогда приложение работает без сохранения ---
export function loadJSON(key, fallback) {
    try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export function saveJSON(key, value) {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch { /* нет места или запрещено — не страшно */ }
}
