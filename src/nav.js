// Экраны и навигация (C4). Без DOM, поэтому тестируется в Node.
// Четыре экрана: map (карта и шаги маршрута), search (поиск, избранное, недавние), share (ссылка и QR), scan (старт по фото двери).
// Экран хранится в адресе (#/search, #/share), поэтому кнопка «Назад» браузера, жест «назад» на телефоне
// и наша кнопка «←» работают одинаково, а перезагрузка возвращает на тот же экран.

export const SCREENS = ['map', 'search', 'share', 'scan'];

// map — главный экран, у него пустой хеш
export const hashFor = screen => (screen === 'map' ? '' : `#/${screen}`);

// Экран по хешу из адреса. Неизвестный хеш или «share» без готового маршрута — просто карта.
export function screenFromHash(hash, { canShare }) {
    const name = String(hash ?? '').replace(/^#\/?/, '');
    if (!SCREENS.includes(name)) return 'map';
    if (name === 'share' && !canShare) return 'map';
    return name;
}

// Что делать по кнопке «←»: depth — сколько экранов мы сами положили в историю над стартовой страницей.
// Есть куда вернуться — идём назад по истории; иначе (страницу открыли сразу на этом экране) подменяем на карту.
export const backAction = depth => (depth > 0 ? 'history-back' : 'replace-with-map');
