// Поиск номера аудитории на фото таблички (S1). Без DOM и без OCR-библиотеки: работает с массивом яркости,
// поэтому тестируется в Node. Распознавание цифр (tesseract.js) подключается отдельно, в ocr.js.
//
// Идея: целиком фото распознаётся плохо (мелкий номер тонет в объявлениях и расписаниях),
// поэтому сначала находим «похожие на номер» места, а OCR запускаем только на них:
//   1. тёмные пятна на светлом фоне (адаптивный порог по интегральному изображению);
//   2. связные области — кандидаты в цифры (подходящие размер и пропорции);
//   3. цифры одной высоты, стоящие в ряд, объединяются в рамку номера.

export const WORK_WIDTH = 960;   // ширина, к которой приводится фото перед поиском номера
export const NAME_WIDTH = 1600;  // ширина для поиска строк текста: мелкие надписи (~10 px) ещё находятся, а кадр не слишком тяжёлый

// Яркость из RGBA (как у canvas.getImageData)
export function toGray(rgba, width, height) {
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4)
        gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    return gray;
}

// Растянуть яркость на весь диапазон (1% самых тёмных и светлых пикселей отбрасываются)
export function stretchContrast(gray) {
    const hist = new Uint32Array(256);
    for (const v of gray) hist[v]++;
    const cut = gray.length * 0.01;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += hist[lo]; if (acc > cut) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += hist[hi]; if (acc > cut) break; }
    if (hi - lo < 16) return Uint8Array.from(gray);                // почти ровный кадр: растягивать нечего
    const out = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((gray[i] - lo) * 255 / (hi - lo))));
    return out;
}

// Тёмное на светлом: пиксель «чернила», если заметно темнее среднего в окрестности.
// Среднее считается по интегральному изображению, поэтому работает за O(w·h).
export function darkMask(gray, w, h, { radius = 20, offset = 28 } = {}) {
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) {
            row += gray[y * w + x];
            integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
        }
    }
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
        for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
            const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1]
                - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
            const mean = sum / ((x1 - x0) * (y1 - y0));
            if (gray[y * w + x] < mean - offset) mask[y * w + x] = 1;
        }
    }
    return mask;
}

// Чёрно-белая копия для чтения надписей: чернила — 0, всё остальное — 255. Убирает текстуру (дерево, блики) и выравнивает яркость.
export function binarize(gray, w, h, { radius = Math.round(w * 0.02), offset = 25 } = {}) {
    const mask = darkMask(gray, w, h, { radius, offset });
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 0 : 255;
    return out;
}

// Связные области маски (8 соседей). Возвращает рамки с площадью.
export function components(mask, w, h) {
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    const found = [];
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || seen[start]) continue;
        let top = 0, area = 0;
        let x0 = w, y0 = h, x1 = 0, y1 = 0;
        stack[top++] = start; seen[start] = 1;
        while (top) {
            const p = stack[--top];
            const x = p % w, y = (p - x) / w;
            area++;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const q = ny * w + nx;
                if (mask[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; }
            }
        }
        found.push({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
    }
    return found;
}

// Подходит ли область на роль цифры: размер, пропорции, «плотность» чернил
export function looksLikeDigit(c, imgH) {
    const minH = imgH * 0.018, maxH = imgH * 0.2;
    if (c.h < minH || c.h > maxH) return false;
    const ratio = c.w / c.h;                    // «1» узкая, «0» широкая
    if (ratio < 0.2 || ratio > 1.0) return false;
    const fill = c.area / (c.w * c.h);
    return fill > 0.18 && fill < 0.95;
}

// Склеить цифры в ряды: одинаковая высота, одна строка, небольшие промежутки
export function groupDigits(digits, { minLen = 3, maxLen = 4 } = {}) {
    const sorted = [...digits].sort((a, b) => a.x0 - b.x0);
    const used = new Set();
    const runs = [];
    for (let i = 0; i < sorted.length; i++) {
        if (used.has(i)) continue;
        const run = [sorted[i]];
        let last = sorted[i];
        for (let j = i + 1; j < sorted.length; j++) {
            const c = sorted[j];
            if (used.has(j)) continue;
            const hMax = Math.max(last.h, c.h), hMin = Math.min(last.h, c.h);
            const gap = c.x0 - last.x1;
            const dy = Math.abs((c.y0 + c.y1) / 2 - (last.y0 + last.y1) / 2);
            if (gap < -2 || gap > hMax * 1.0) { if (gap > hMax * 1.0) break; else continue; }
            if (hMin / hMax < 0.75 || dy > hMax * 0.25) continue;
            run.push(c); used.add(j); last = c;
        }
        if (run.length >= minLen && run.length <= maxLen) {
            used.add(i);
            const x0 = Math.min(...run.map(c => c.x0)), x1 = Math.max(...run.map(c => c.x1));
            const y0 = Math.min(...run.map(c => c.y0)), y1 = Math.max(...run.map(c => c.y1));
            runs.push({ x0, y0, x1, y1, h: y1 - y0 + 1, count: run.length });
        }
    }
    return runs;
}

// Места, где может быть номер: самые крупные ряды цифр первыми
export function findNumberRegions(gray, w, h, { limit = 6 } = {}) {
    const mask = darkMask(gray, w, h);
    const digits = components(mask, w, h).filter(c => looksLikeDigit(c, h));
    return groupDigits(digits).sort((a, b) => b.h - a.h).slice(0, limit);
}

// --- Строки текста (для надписей) ---
// Целиком фото с надписями Tesseract читает плохо: разбираться в раскладке страницы на фоне дерева и бумажек он не умеет.
// Поэтому, как и с номером, сначала находим строки, а читаем каждую отдельно (режим «одна строка»).

// Буква-кандидат: размер в пределах «текста», не слишком длинная и не пятно
export function looksLikeLetter(c, imgH) {
    if (c.h < 8 || c.h > imgH * 0.12) return false;
    if (c.w > c.h * 8) return false;                  // длинная линия (рамка, подчёркивание)
    if (c.w < c.h * 0.12) return false;
    const fill = c.area / (c.w * c.h);
    return fill > 0.12 && fill < 0.97;
}

// Склеить буквы в строки: одна высота, общая линия, промежуток не больше пробела между словами.
// Возвращает рамки строк {x0,y0,x1,y1,h,count}; h — высота рамки строки.
export function groupLines(letters, { minCount = 3 } = {}) {
    const sorted = [...letters].sort((a, b) => a.x0 - b.x0);
    const parent = sorted.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i];
        for (let j = i + 1; j < sorted.length; j++) {
            const b = sorted[j];
            const maxH = Math.max(a.h, b.h);
            if (b.x0 - a.x1 > maxH * 1.3) { if (b.x0 - a.x0 > maxH * 14) break; else continue; }
            const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
            const minH = Math.min(a.h, b.h);
            if (overlap < minH * 0.5) continue;       // не на одной линии
            if (maxH / minH > 2.6) continue;          // разный размер: это другой текст
            parent[find(i)] = find(j);
        }
    }
    const groups = new Map();
    sorted.forEach((c, i) => { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)).push(c); });
    const lines = [];
    for (const g of groups.values()) {
        if (g.length < minCount) continue;
        const x0 = Math.min(...g.map(c => c.x0)), x1 = Math.max(...g.map(c => c.x1));
        const y0 = Math.min(...g.map(c => c.y0)), y1 = Math.max(...g.map(c => c.y1));
        if ((x1 - x0 + 1) < (y1 - y0 + 1) * 1.8) continue;      // строка длиннее своей высоты
        lines.push({ x0, y0, x1, y1, h: y1 - y0 + 1, count: g.length });
    }
    return lines;
}

// Строки текста на снимке: самые крупные первыми (заголовки и таблички несут больше всего смысла)
export function findTextLines(gray, w, h, { limit = 30 } = {}) {
    const mask = darkMask(gray, w, h, { radius: Math.round(w * 0.015), offset: 22 });
    const letters = components(mask, w, h).filter(c => looksLikeLetter(c, h));
    return groupLines(letters).sort((a, b) => b.h * b.count - a.h * a.count).slice(0, limit);
}

// --- Выбор номера по результатам OCR ---

// Из текста — подходящие числа (2–4 цифры), без нулей в начале
export const numbersIn = text => [...String(text).matchAll(/\d{2,4}/g)].map(m => m[0]).filter(n => n[0] !== '0');

// Какие аудитории и номера есть в графе: «311» → id узла
export function roomNumberIndex(nodes) {
    const index = new Map();
    for (const n of nodes) {
        if (n.type !== 'room') continue;
        const m = /^f\d+-room-(\d{3})$/.exec(n.id);
        if (m) index.set(m[1], n.id);
    }
    return index;
}

// Выбрать лучшего кандидата. reads: [{ text, confidence, h }] — что прочитано в каждой рамке.
// Побеждает номер, который есть в здании; голоса суммируются (на двери часто две таблички с одним номером),
// крупная и уверенно прочитанная рамка весит больше. Возвращает отсортированный список {number, id, score}.
export function pickRoomNumber(reads, roomIndex) {
    const votes = new Map();
    for (const r of reads) {
        for (const n of numbersIn(r.text)) {
            if (!roomIndex.has(n)) continue;
            const weight = (0.4 + Math.min(r.confidence ?? 50, 100) / 100) * (r.h ?? 30);
            votes.set(n, (votes.get(n) ?? 0) + weight);
        }
    }
    return [...votes].map(([number, score]) => ({ number, id: roomIndex.get(number), score }))
        .sort((a, b) => b.score - a.score);
}
