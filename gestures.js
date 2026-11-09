// Жесты на карте: перемещение, щипок (масштаб + поворот), двойное нажатие, колесо мыши.
// Вся математика — в viewmath.js; здесь только события указателя (Pointer Events: мышь и касания одним кодом).
import { IDENTITY, LIMITS, zoomAbout, rotateAbout, pinch, pan, clampView } from './viewmath.js';

const DRAG_THRESHOLD = 6;      // px: меньше — это нажатие, а не перетаскивание
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_DIST = 30;    // px
const DOUBLE_TAP_ZOOM = 2.5;

// container — элемент, на котором ловим жесты; onChange(view) вызывается при каждом изменении вида
// (не чаще раза за кадр); onTap(target) — обычное нажатие (после паузы, в которую мог бы прийти второй тап).
export function attachGestures(container, { onChange, onTap, contentSize }) {
    let view = IDENTITY;
    let frame = null;
    let anim = null;

    const size = () => ({ W: container.clientWidth, H: container.clientHeight });
    const local = e => {
        const r = container.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    function setView(next, { immediate = false } = {}) {
        const { W, H } = size();
        const c = contentSize?.() ?? { w: W, h: H };
        view = clampView(next, W, H, { cw: c.w, ch: c.h });
        if (immediate) { cancelAnimationFrame(frame); frame = null; onChange(view); return; }
        if (frame === null) frame = requestAnimationFrame(() => { frame = null; onChange(view); });
    }

    // Плавный переход к виду: s — через логарифм (масштаб ощущается равномерно), остальное — линейно.
    function animateTo(target, ms = 220) {
        cancelAnimationFrame(anim);
        const from = view, t0 = performance.now();
        const step = now => {
            const k = Math.min(1, (now - t0) / ms);
            const e = 1 - Math.pow(1 - k, 3);                       // ease-out
            const s = from.s * Math.pow(target.s / from.s, e);
            setView({ s, r: from.r + (target.r - from.r) * e,
                      tx: from.tx + (target.tx - from.tx) * e, ty: from.ty + (target.ty - from.ty) * e });
            if (k < 1) anim = requestAnimationFrame(step);
        };
        anim = requestAnimationFrame(step);
    }

    // --- указатели ---
    const pointers = new Map();     // id -> {x, y}
    let down = null;                // {x, y, id}: где начали, чтобы отличить тап от перетаскивания
    let dragging = false;
    let gestured = false;           // был жест двумя пальцами — тапом это уже не считается
    let lastTap = null;             // {t, x, y}
    let tapTimer = null;

    const measure = () => {
        const [a, b] = [...pointers.values()];
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
    };
    let prev = null;

    container.addEventListener('pointerdown', e => {
        cancelAnimationFrame(anim);
        pointers.set(e.pointerId, local(e));
        if (pointers.size === 1) { down = { ...local(e), id: e.pointerId, target: e.target }; dragging = false; gestured = false; }
        if (pointers.size === 2) { gestured = true; prev = measure(); }
    });

    container.addEventListener('pointermove', e => {
        if (!pointers.has(e.pointerId)) return;
        const p = local(e);
        const before = pointers.get(e.pointerId);
        pointers.set(e.pointerId, p);

        if (pointers.size >= 2) {
            const now = measure();
            setView(pinch(view, prev, now));
            prev = now;
        } else if (down) {
            if (!dragging && Math.hypot(p.x - down.x, p.y - down.y) > DRAG_THRESHOLD) {
                dragging = true;
                container.setPointerCapture?.(e.pointerId);
            }
            if (dragging) setView(pan(view, p.x - before.x, p.y - before.y));
        }
    });

    function release(e) {
        if (!pointers.has(e.pointerId)) return;
        const p = local(e);
        pointers.delete(e.pointerId);
        if (pointers.size === 1) prev = null;
        if (pointers.size > 0) return;

        const wasTap = down && !dragging && !gestured && e.type === 'pointerup';
        const target = down?.target;
        down = null;
        if (!wasTap) return;

        const now = performance.now();
        if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < DOUBLE_TAP_DIST) {
            clearTimeout(tapTimer);                // второй тап: это зум, а не выбор комнаты
            lastTap = null;
            doubleTap(p);
        } else {
            lastTap = { t: now, ...p };
            clearTimeout(tapTimer);
            tapTimer = setTimeout(() => { lastTap = null; onTap?.(target); }, DOUBLE_TAP_MS);
        }
    }
    container.addEventListener('pointerup', release);
    container.addEventListener('pointercancel', release);

    function doubleTap(p) {
        if (view.s > 1.5) animateTo(IDENTITY);                                      // уже увеличено — вернуть исходный вид
        else animateTo(zoomAbout(view, p, DOUBLE_TAP_ZOOM / view.s));
    }

    // Колесо мыши: масштаб вокруг курсора; с Shift — поворот.
    container.addEventListener('wheel', e => {
        e.preventDefault();
        const p = local(e);
        if (e.shiftKey) setView(rotateAbout(view, p, e.deltaY * 0.002));
        else setView(zoomAbout(view, p, Math.exp(-e.deltaY * 0.0015)));
    }, { passive: false });

    new ResizeObserver(() => setView(view, { immediate: true })).observe(container);

    return {
        get view() { return view; },
        reset() { animateTo({ s: 1, r: 0, tx: 0, ty: 0 }); },
        zoomBy(factor) { const { W, H } = size(); setView(zoomAbout(view, { x: W / 2, y: H / 2 }, factor)); },
        refresh() { setView(view, { immediate: true }); },
    };
}

export { LIMITS };
