# Сторонние файлы (распознавание номера по фото, S1)

Лежат в репозитории целиком, чтобы приложение не зависело от внешних серверов и работало офлайн.

| Файл | Что это | Версия | Лицензия |
|---|---|---|---|
| `tesseract.esm.min.js`, `worker.min.js` | tesseract.js: запуск OCR в веб-воркере | 5.1.1 | Apache-2.0 (`LICENSE-tesseract.js.md`) |
| `tesseract-core-simd-lstm.wasm.js` | tesseract.js-core: движок Tesseract, собранный в WebAssembly | 5.1.1 | Apache-2.0 (`LICENSE-tesseract.js-core.txt`) |
| `rus.traineddata.gz` | обученная модель (русский, для чтения надписей), `@tesseract.js-data/rus` 4.0.0_best_int | 1.0.0 | Apache-2.0 / MIT (по пакету) |
| `eng.traineddata.gz` | обученная модель (английский, цифры), `@tesseract.js-data/eng` 4.0.0_best_int | 1.0.0 | Apache-2.0 / MIT (по пакету) |

Файлы не изменялись. Версия core без SIMD не включена: SIMD поддерживают все браузеры телефонов с 2021 года.
