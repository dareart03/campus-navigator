// Пошаговый показ маршрута: за раз видно текущий шаг и следующий; переключение стрелками и свайпом.
// Логика без DOM, чтобы проверяться тестами (test/steps.test.js); разметка и события — в app.js.

export const SWIPE_MIN_PX = 40;       // короче — это не свайп, а дрожание пальца
export const SWIPE_MAX_MS = 700;      // медленное перетаскивание — не свайп
export const SWIPE_AXIS_RATIO = 1.5;  // свайп должен быть заметно горизонтальным, иначе это прокрутка страницы

export const hasPrev = index => index > 0;
export const hasNext = (index, count) => index < count - 1;
export const clampStep = (index, count) => Math.max(0, Math.min(count - 1, index));

// Что показывать: текущий шаг и, если он есть, следующий. Возвращает [{ step, index, current }].
export function visibleSteps(steps, index) {
    return steps.slice(index, index + 2).map((step, k) => ({ step, index: index + k, current: k === 0 }));
}

// Куда свайп: 1 — вперёд (палец влево), -1 — назад (палец вправо), 0 — не свайп.
export function swipeDirection(dx, dy, ms) {
    if (ms > SWIPE_MAX_MS) return 0;
    if (Math.abs(dx) < SWIPE_MIN_PX) return 0;
    if (Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return 0;
    return dx < 0 ? 1 : -1;
}

// Нажали вкладку этажа: какой шаг показать. Если текущий шаг уже на этом этаже — остаёмся на нём,
// иначе берём ближайший шаг с этим этажом (при равном расстоянии — следующий). -1, если на этаже шагов нет.
export function stepForFloor(steps, floor, index) {
    if (steps[index]?.floor === floor) return index;
    let best = -1;
    steps.forEach((s, i) => {
        if (s.floor !== floor) return;
        if (best === -1 || Math.abs(i - index) < Math.abs(best - index)
            || (Math.abs(i - index) === Math.abs(best - index) && i > best)) best = i;
    });
    return best;
}
