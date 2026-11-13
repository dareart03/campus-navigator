// Поиск места по тексту надписей (S1, второй способ): «Кафедра математического анализа и геометрии», «Серверная», «Спортивный зал».
// Без DOM и без OCR: на вход — текст, который OCR прочитал с фото (с ошибками и мусором), на выход — кандидаты из графа.
//
// Как отличить нужное место от случайных совпадений:
//   - сравниваем слова по первым 6 буквам (падежи и окончания не мешают) и допускаем одну ошибку OCR в длинных словах;
//   - редкие слова весят больше частых: «кафедра» есть у десятка мест, «серверная» — у одного;
//   - место подходит, если найдено не меньше 60% веса слов его названия; цифры в названии («раздевалка 3») обязаны совпасть.

const MIN_SCORE = 0.6;
const STEM = 6;

export const tokens = text => String(text).toLowerCase().replaceAll('ё', 'е').split(/[^a-zа-я0-9]+/).filter(Boolean);
const isWord = t => t.length >= 4 && /^[а-я]+$/.test(t);          // значимое слово: кириллица, от 4 букв
const isNumeral = t => /^\d{1,3}$/.test(t);
const stemOf = w => w.slice(0, STEM);

// Расстояние Левенштейна (строки короткие, поэтому обычная таблица)
function distance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++)
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[b.length];
}

// Прочитано ли слово места в слове OCR: то же слово по началу (падеж), до двух ошибок OCR в длинном слове
// или обрывок слова («хранен» вместо «хранения»)
function sameWord(read, word) {
    if (read.slice(0, STEM) === word.slice(0, STEM) && Math.min(read.length, word.length) >= STEM) return true;
    if (read.length >= STEM && word.startsWith(read)) return true;
    const tolerance = word.length >= 9 ? 2 : word.length >= 6 ? 1 : 0;
    return tolerance > 0 && Math.abs(read.length - word.length) <= tolerance && distance(read, word) <= tolerance;
}

// Названия места: основное и синонимы, без номера в начале («303 — Кафедра …» → «Кафедра …»)
const phrasesOf = node => [node.label, ...(node.aliases ?? [])]
    .filter(Boolean)
    .map(p => String(p).replace(/^\s*\d+\s*[—–-]\s*/, ''))
    .filter(p => tokens(p).some(isWord));

// Индекс по графу. Туалеты и выходы не берём: их находят кнопки «ближайшее» и поиск.
export function buildNameIndex(nodes) {
    const places = [];
    for (const node of nodes) {
        if (node.type !== 'room') continue;
        const phrases = phrasesOf(node).map(text => {
            const ts = tokens(text);
            return { words: ts.filter(isWord), numerals: ts.filter(isNumeral) };
        });
        if (phrases.length) places.push({ id: node.id, phrases });
    }
    const df = new Map();
    for (const p of places) {
        const keys = new Set(p.phrases.flatMap(ph => ph.words.map(stemOf)));
        for (const k of keys) df.set(k, (df.get(k) ?? 0) + 1);
    }
    const weight = word => Math.log(places.length / (df.get(stemOf(word)) ?? 1)) + 0.5;
    return { places, weight };
}

// Найти места по тексту. text — строка или список строк { text, h } (h — высота строки на снимке: крупные надписи
// на двери важнее мелких бумажек рядом). Возвращает [{ id, score, evidence }], лучшие первыми.
export function matchNames(index, text, limit = 3) {
    const segments = typeof text === 'string' ? [{ text, h: 1 }] : text;
    const reads = [];                                          // слова, прочитанные OCR, с размером
    const numerals = new Set();
    for (const { text: t, h } of segments) {
        for (const tok of tokens(t)) {
            if (isWord(tok)) reads.push({ tok, h });
            else if (isNumeral(tok)) numerals.add(tok);
        }
    }
    // Слово места -> размер самой крупной надписи, где оно прочитано (0 — не найдено). Считаем один раз на слово.
    const sizeOf = new Map();
    const found = word => {
        if (!sizeOf.has(word)) {
            let size = 0;
            for (const r of reads) if (r.h > size && sameWord(r.tok, word)) size = r.h;
            sizeOf.set(word, size);
        }
        return sizeOf.get(word);
    };

    const results = [];
    for (const place of index.places) {
        let best = 0, evidence = 0;
        for (const { words: ws, numerals: ns } of place.phrases) {
            if (!ws.length) continue;
            let total = 0, matched = 0, sized = 0;
            for (const w of ws) {
                const wt = index.weight(w), size = found(w);
                total += wt;
                if (size) { matched += wt; sized += wt * size; }
            }
            // Цифра в названии («раздевалка 3») не прочиталась — это не отказ (мелкая цифра часто не читается), но минус
            const missing = ns.filter(n => !numerals.has(n)).length;
            const score = (matched / total) * Math.pow(0.7, missing);
            if (score >= MIN_SCORE) { best = Math.max(best, score); evidence += sized; }
        }
        if (best) results.push({ id: place.id, score: best, evidence });
    }
    return results.sort((a, b) => b.score - a.score || b.evidence - a.evidence).slice(0, limit);
}
