// Ссылка на маршрут: ?from=f3-room-311&to=f1-exit-1. Без DOM, поэтому тестируется в Node.

// Ссылка, которая открывает приложение сразу с построенным маршрутом
export function buildShareUrl(base, from, to) {
    const params = new URLSearchParams({ from, to });
    return `${base}?${params}`;
}

// Разбор адресной строки (location.search).
//   null                — в адресе нет маршрута (обычное открытие приложения);
//   { from, to }        — ссылка корректна, оба места есть в графе;
//   { error: '…' }      — ссылка битая или устарела (места нет в графе).
// isPlace(id) — проверка, что такая точка есть в графе и до неё можно проложить маршрут.
export function parseShareParams(search, isPlace) {
    const params = new URLSearchParams(search);
    const from = params.get('from');
    const to = params.get('to');
    if (from === null && to === null) return null;
    if (!from || !to) return { error: 'В ссылке указана только одна точка маршрута' };
    if (from === to) return { error: 'В ссылке начало и конец маршрута совпадают' };
    for (const id of [from, to]) {
        if (!isPlace(id)) return { error: `В ссылке неизвестное место «${id}» (возможно, карта обновилась)` };
    }
    return { from, to };
}
