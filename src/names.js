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

// Расстояние Левенштейна не больше 1 (для устойчивости к одной ошибке OCR)
function withinOneEdit(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i === a.length && i === b.length) return true;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    const [long, short] = a.length > b.length ? [a, b] : [b, a];
    return long.slice(i + 1) === short.slice(i);
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

// Найти места по тексту. Возвращает [{ id, score, evidence }], лучшие первыми.
export function matchNames(index, text, limit = 3) {
    const seen = tokens(text);
    const words = [...new Set(seen.filter(isWord))];
    const stems = new Set(words.map(stemOf));
    const numerals = new Set(seen.filter(isNumeral));
    const long = words.filter(w => w.length >= 7);
    const found = word => stems.has(stemOf(word)) || (word.length >= 7 && long.some(w => withinOneEdit(w, word)));

    const results = [];
    for (const place of index.places) {
        let best = 0, evidence = 0;
        for (const { words: ws, numerals: ns } of place.phrases) {
            if (!ws.length || !ns.every(n => numerals.has(n))) continue;      // «раздевалка 3» без «3» не подходит
            let total = 0, matched = 0;
            for (const w of ws) {
                const wt = index.weight(w);
                total += wt;
                if (found(w)) matched += wt;
            }
            const score = matched / total;
            if (score >= MIN_SCORE) { best = Math.max(best, score); evidence += matched; }
        }
        if (best) results.push({ id: place.id, score: best, evidence });
    }
    return results.sort((a, b) => b.score - a.score || b.evidence - a.evidence).slice(0, limit);
}
