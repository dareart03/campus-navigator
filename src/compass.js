// Компас (S2): карта поворачивается так, чтобы «вверх» на экране совпадало с направлением, куда смотрит человек.
// Здесь только математика, без DOM и датчиков, поэтому тестируется в Node. Датчик подключает app.js.
//
// Направление (heading) — угол по часовой стрелке от севера, в градусах: 0 — север, 90 — восток.
// northOffset — направление, в которое на плане смотрит «вверх» (у каждого здания своё, задаётся калибровкой).

export const NORTH_KEY = 'navigator.north';

export const normalize360 = a => ((a % 360) + 360) % 360;

// Кратчайшая разница углов to − from в диапазоне (−180, 180]: через 0°/360° идём короткой дорогой
export const angleDiff = (to, from) => {
    const d = ((to - from + 540) % 360 + 360) % 360 - 180;
    return d === -180 ? 180 : d;
};

// Сглаживание: датчик дрожит, поэтому берём долю нового значения. Считаем по кругу, а не по числам:
// среднее между 359° и 1° — это 0°, а не 180°.
export function smoothHeading(prev, next, alpha = 0.2) {
    if (prev == null) return normalize360(next);
    return normalize360(prev + alpha * angleDiff(next, prev));
}

// Плавное приближение к цели за время dtMs (мс): за каждые tauMs остаётся доля 1/e расстояния.
// Сглаживание по времени, а не по числу событий: у телефона событий десятки в секунду, а у эмуляции датчика в DevTools —
// по одному на каждое изменение, и результат должен быть один и тот же.
export function approachHeading(prev, target, dtMs, tauMs = 120) {
    if (prev == null) return normalize360(target);
    return smoothHeading(prev, target, 1 - Math.exp(-Math.max(0, dtMs) / tauMs));
}

// Направление «куда смотрит телефон» по углам датчика (порядок поворотов — как в спецификации W3C DeviceOrientation:
// сначала вокруг вертикали на alpha, затем наклон вперёд-назад на beta и вбок на gamma; углы в градусах).
// Считаем, куда в пространстве направлены оси телефона, и берём направление на горизонтальной плоскости:
//  - телефон держат вертикально перед собой — куда смотрит задняя камера (так человек и ходит с телефоном);
//  - телефон лежит или почти лежит на ладони — куда направлен его верхний край.
// Между ними нет скачка: при наклоне вперёд оба направления совпадают.
export function compassHeading(alpha, beta, gamma) {
    const rad = Math.PI / 180;
    const a = (alpha ?? 0) * rad, b = (beta ?? 0) * rad, g = (gamma ?? 0) * rad;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    // верхний край телефона (ось y) и задняя сторона (минус ось z) в системе «восток, север, вверх»
    const top = { e: -sa * cb, n: ca * cb };
    const back = { e: -(ca * sg + sa * sb * cg), n: -(sa * sg - ca * sb * cg), up: -cb * cg };
    const v = Math.abs(back.up) < 0.8 ? back : top;           // лежит (back.up близко к −1) — берём верхний край
    if (Math.hypot(v.e, v.n) < 1e-9) return null;
    return normalize360(Math.atan2(v.e, v.n) / rad);
}

// Направление из события датчика. null — в событии нет данных (бывает у первого события или на компьютере).
// iOS сам присылает готовое направление (webkitCompassHeading), у Android берём его из углов.
export function headingFromEvent(e) {
    if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) return normalize360(e.webkitCompassHeading);
    if (typeof e.alpha !== 'number' || !Number.isFinite(e.alpha)) return null;
    return compassHeading(e.alpha, e.beta, e.gamma);          // может вернуть null, если направление не определить
}

// Угол поворота вида карты (радианы, как поле r в viewmath.js), при котором человек, смотрящий в направлении heading,
// видит перед собой «верх» экрана. Повернулся по часовой на d — карта поворачивается против часовой на d.
export function mapRotation(heading, northOffset) {
    return -angleDiff(heading, northOffset) * Math.PI / 180;
}

// Приведение радиан к (−π, π]: чтобы поворачивать карту кратчайшим путём
export function wrapPi(r) {
    const d = ((r + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return d === -Math.PI ? Math.PI : d;
}

// Сохранённая калибровка из хранилища: что угодно, кроме числа, — это «нет калибровки» (0°)
export function sanitizeOffset(x) {
    const n = typeof x === 'string' ? Number(x) : x;
    return typeof n === 'number' && Number.isFinite(n) ? normalize360(n) : 0;
}
