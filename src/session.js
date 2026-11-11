// Состояние, которое переживает перезагрузку страницы и уход в фон (C7): этаж, вид карты, выбранные места, запрос в поиске.
// Лежит в sessionStorage: живёт, пока открыта вкладка, и не мешает новой вкладке начинать с чистого экрана.
// Без DOM, поэтому тестируется в Node: хранилище передаётся параметром.

export const SESSION_KEY = 'navigator.session';

export function saveSession(storage, state) {
    try {
        storage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch { /* хранилище недоступно (приватный режим, переполнение) — приложение работает и так */ }
}

const isNum = x => typeof x === 'number' && Number.isFinite(x);

// Читаем и проверяем: из хранилища может прийти что угодно (старая версия, ручная правка, мусор).
// Берём только то, что прошло проверку; floors — допустимые этажи, isPlace(id) — есть ли такое место в графе.
export function loadSession(storage, { floors, isPlace }) {
    let raw;
    try {
        raw = JSON.parse(storage.getItem(SESSION_KEY));
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;

    const out = {};
    if (floors.includes(raw.floor)) out.floor = raw.floor;
    const v = raw.view;
    if (v && typeof v === 'object' && [v.s, v.r, v.tx, v.ty].every(isNum) && v.s > 0) {
        out.view = { s: v.s, r: v.r, tx: v.tx, ty: v.ty };
    }
    if (typeof raw.start === 'string' && isPlace(raw.start)) out.start = raw.start;
    if (out.start && typeof raw.end === 'string' && raw.end !== out.start && isPlace(raw.end)) out.end = raw.end;
    if (typeof raw.query === 'string') out.query = raw.query.slice(0, 100);
    return out;
}
