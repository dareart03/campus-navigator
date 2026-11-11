// Отсечение того, что за экраном (T3). Без DOM, поэтому тестируется в Node.
// Идея: у каждого элемента карты один раз запоминаем рамку (bbox) в координатах SVG.
// При каждом изменении вида считаем, какой прямоугольник SVG сейчас виден, и прячем (display: none)
// элементы, чьи рамки в него не попали. Браузер не рисует и не пересчитывает скрытое.

// Матрица {a,b,c,d,e,f} как в SVG/CSS: x' = a·x + c·y + e,  y' = b·x + d·y + f
export function invertMatrix(m) {
    const det = m.a * m.d - m.b * m.c;
    if (!det) return null;
    return {
        a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det,
        e: (m.c * m.f - m.d * m.e) / det,
        f: (m.b * m.e - m.a * m.f) / det,
    };
}

const apply = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });

// Видимый прямоугольник в координатах SVG. screenToSvg — матрица «экран → SVG» (обратная к getScreenCTM),
// view — прямоугольник контейнера на экране {left, top, width, height}.
// При повороте берём рамку вокруг четырёх углов (с запасом, но никогда не меньше нужного); pad — запас в единицах SVG.
export function visibleRect(screenToSvg, view, pad = 0) {
    const pts = [
        apply(screenToSvg, view.left, view.top),
        apply(screenToSvg, view.left + view.width, view.top),
        apply(screenToSvg, view.left, view.top + view.height),
        apply(screenToSvg, view.left + view.width, view.top + view.height),
    ];
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
}

export function intersects(box, r) {
    return box.x < r.x1 && box.x + box.width > r.x0 && box.y < r.y1 && box.y + box.height > r.y0;
}

// items: [{ box, visible }]. Меняет только те, чей статус изменился, и возвращает их список —
// DOM трогаем лишь для них (а не для всех элементов на каждый кадр).
// keep(it) — необязательное «не отсекать»: например, подсвеченные старт и финиш остаются всегда.
export function updateVisibility(items, rect, keep = () => false) {
    const changed = [];
    for (const it of items) {
        const vis = keep(it) || intersects(it.box, rect);
        if (vis !== it.visible) { it.visible = vis; changed.push(it); }
    }
    return changed;
}
