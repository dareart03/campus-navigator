// Распознавание номера на фото двери (S1): канвас + tesseract.js. Тяжёлую часть (OCR) выполняет веб-воркер,
// поэтому страница не зависает; библиотека подгружается только при первом открытии экрана «Фото двери».
// Все файлы библиотеки лежат в src/vendor/tesseract/ (без внешних серверов, работает офлайн после первой загрузки).
import { WORK_WIDTH, NAME_WIDTH, toGray, binarize, stretchContrast, findNumberRegions } from './signs.js';

const MAX_SIDE = 2400;
const VENDOR = new URL('./vendor/tesseract/', import.meta.url).href;
let workerPromise = null;
let ruWorkerPromise = null;

async function createWorker(lang, status, onStatus) {
    onStatus(status);
    const { default: Tesseract } = await import('./vendor/tesseract/tesseract.esm.min.js');
    return Tesseract.createWorker(lang, 1, {
        workerPath: VENDOR + 'worker.min.js',
        corePath: VENDOR,
        langPath: VENDOR,                    // ищет <язык>.traineddata.gz
        gzip: true,
    });
}

// Один воркер на всё время работы: модель загружается один раз
export function loadOcr(onStatus = () => {}) {
    workerPromise ??= (async () => {
        const worker = await createWorker('eng', 'Загружаю распознавание (один раз, около 7 МБ)…', onStatus);
        // Читаем только цифры и только одну строку: рамки уже вырезаны под номер
        await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
        return worker;
    })();
    // неудачную загрузку не запоминаем, чтобы «Повторить» сработало
    workerPromise.catch(() => { workerPromise = null; });
    return workerPromise;
}

// Русская модель нужна только для надписей и грузится, когда номера на фото не нашлось
export function loadRussianOcr(onStatus = () => {}) {
    ruWorkerPromise ??= createWorker('rus', 'Загружаю русский язык (один раз, около 3 МБ)…', onStatus);
    ruWorkerPromise.catch(() => { ruWorkerPromise = null; });
    return ruWorkerPromise;
}

// Фото -> канвас рабочей ширины. imageOrientation учитывает поворот из EXIF (снимки с телефона).
async function drawPhoto(file, targetWidth = WORK_WIDTH, upscale = false) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    let scale = targetWidth / bitmap.width;
    if (!upscale) scale = Math.min(1, scale);
    scale = Math.min(scale, MAX_SIDE / Math.max(bitmap.width, bitmap.height));    // очень большие снимки не раздуваем
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return { canvas, ctx };
}

// Вырезать рамку с полями (из чёрно-белой копии, как и при поиске) и привести к высоте 64 px:
// на таком размере цифры читаются лучше всего
function cropRegion(gray, W, H, r) {
    const m = Math.round(r.h * 0.2);
    const x = Math.max(0, r.x0 - m), y = Math.max(0, r.y0 - m);
    const w = Math.min(W - x, r.x1 - r.x0 + 1 + 2 * m), h = Math.min(H - y, r.h + 2 * m);
    const src = document.createElement('canvas');
    src.width = w; src.height = h;
    const image = new ImageData(w, h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const v = gray[(y + j) * W + x + i], p = (j * w + i) * 4;
        image.data[p] = image.data[p + 1] = image.data[p + 2] = v; image.data[p + 3] = 255;
    }
    src.getContext('2d').putImageData(image, 0, 0);
    const out = document.createElement('canvas');
    out.height = 64;
    out.width = Math.max(1, Math.round(w * 64 / h));
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, out.width, out.height);
    return out;
}

// Прочитать числа с фото. Возвращает [{ text, confidence, h }] — по одному на найденную рамку.
export async function readPhoto(file, onStatus = () => {}) {
    const worker = await loadOcr(onStatus);
    onStatus('Ищу номер на фото…');
    const { canvas, ctx } = await drawPhoto(file);
    const gray = toGray(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    const regions = findNumberRegions(gray, canvas.width, canvas.height);
    const reads = [];
    for (const r of regions) {
        const { data } = await worker.recognize(cropRegion(gray, canvas.width, canvas.height, r));
        reads.push({ text: data.text.trim(), confidence: data.confidence, h: r.h });
    }
    return reads;
}

// Прочитать надписи на двери (кафедра, «Серверная», «Спортивный зал»). Дольше, чем номер, поэтому зовём, когда номера нет.
// Читаем дважды: обычную копию с выровненной яркостью и чёрно-белую (она убирает текстуру дерева и блики);
// тексты склеиваем, а сопоставление с названиями (names.js) само отсеет мусор.
export async function readLabels(file, onStatus = () => {}) {
    const worker = await loadRussianOcr(onStatus);
    onStatus('Читаю надписи…');
    const { canvas, ctx } = await drawPhoto(file, NAME_WIDTH, true);
    const { width: w, height: h } = canvas;
    const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h);
    const texts = [];
    for (const pixels of [stretchContrast(gray), binarize(gray, w, h)]) {
        const { data } = await worker.recognize(grayCanvas(pixels, w, h));
        texts.push(data.text);
    }
    return texts.join('\n');
}

function grayCanvas(gray, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const image = new ImageData(w, h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
        image.data[p] = image.data[p + 1] = image.data[p + 2] = gray[i]; image.data[p + 3] = 255;
    }
    canvas.getContext('2d').putImageData(image, 0, 0);
    return canvas;
}
