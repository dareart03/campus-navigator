import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tokens, buildNameIndex, matchNames } from '../src/names.js';

const graph = JSON.parse(readFileSync(new URL('../data/data.json', import.meta.url), 'utf8'));
const index = buildNameIndex(graph.nodes);
const top = (text, n = 1) => matchNames(index, text, n).map(r => r.id.replace(/^f\d-room-/, ''));

// Тексты ниже — то, что OCR реально прочитал с фото дверей (с ошибками и лишними словами с бумажек)
const HEADER = 'южный федеральный университет Институт математики, механики и компьютерных наук им. И.И. Воровича';

test('tokens: регистр, «ё», знаки препинания', () => {
    assert.deepEqual(tokens('Ёлка, РАЗДЕВАЛКА № 3!'), ['елка', 'раздевалка', '3']);
});

test('надпись «Спортивный зал» находит спортзал, шапка университета ничего не добавляет', () => {
    assert.deepEqual(top(`${HEADER} Спортивный зал`), ['Gym']);
});

test('кафедра находится по названию даже с мусором и обрывками слов', () => {
    const text = 'КАФЕДРА ваук им. И.Н. Бероваче МАТЕМАТИЧЕСКОГО й АНАЛИЗА И ГЕОМЕТРИИ учебная аудитория для проведения групповых ОТДЕЛ ематического ана';
    assert.equal(top(text)[0], '303');
});

test('название лаборатории находится, ошибка в одной букве не мешает', () => {
    assert.deepEqual(top('Лаборатория вычислительной механики Сектор конечно-элементного моделирования'), ['201']);
    assert.deepEqual(top('Лаборатория вычислительнои механики'), ['201']);
});

test('«Серверная» — одно слово — находит именно серверную, общий текст — несколько вариантов', () => {
    assert.equal(top('Серверная Помещение для хранения и профилактического обслуживания учебного оборудования')[0], '321');
    const ambiguous = top('Помещение для хранения и профилактического обслуживания учебного оборудования', 5);
    assert.ok(ambiguous.includes('321') && ambiguous.length >= 2);
});

test('раздевалка: номер в названии обязан совпасть', () => {
    assert.deepEqual(top('РАЗДЕВАЛКА № 3 женская'), ["women's-changing-room-3"]);
    assert.deepEqual(top('РАЗДЕВАЛКА № 1 мужская'), ["men's-changing-room-1"]);
    assert.deepEqual(top('РАЗДЕВАЛКА женская'), []);                // без номера не угадываем
});

test('шапка с названием института, пустой текст и мусор не дают совпадений', () => {
    assert.deepEqual(top(HEADER), []);
    assert.deepEqual(top(''), []);
    assert.deepEqual(top('ЗЫИЯ И ой Не 1ЛоОНЦЫ АОИ 14 я МОДЫ'), []);
});

test('редкое слово весит больше частого: «кафедра» одна не находит ничего', () => {
    assert.deepEqual(top('кафедра'), []);
});

test('туалеты и выходы не ищутся по надписям, только аудитории', () => {
    assert.deepEqual(top('Женский туалет'), []);
    assert.deepEqual(top('Выход'), []);
});
