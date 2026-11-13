import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPrev, hasNext, clampStep, visibleSteps, swipeDirection, stepForFloor } from '../src/steps.js';

const steps = [{ floor: 2, text: 'a' }, { floor: 2, text: 'b' }, { floor: 1, text: 'c' }, { floor: 1, text: 'd' }];

test('стрелки: на первом шаге нет «назад», на последнем нет «вперёд»', () => {
    assert.equal(hasPrev(0), false);
    assert.equal(hasPrev(1), true);
    assert.equal(hasNext(3, 4), false);
    assert.equal(hasNext(2, 4), true);
    assert.equal(hasNext(0, 1), false);      // единственный шаг: стрелок нет совсем
    assert.equal(hasPrev(0), false);
});

test('clampStep не выходит за границы', () => {
    assert.equal(clampStep(-1, 4), 0);
    assert.equal(clampStep(9, 4), 3);
    assert.equal(clampStep(2, 4), 2);
});

test('visibleSteps: текущий и следующий; на последнем шаге — только он', () => {
    assert.deepEqual(visibleSteps(steps, 0).map(v => [v.step.text, v.current]), [['a', true], ['b', false]]);
    assert.deepEqual(visibleSteps(steps, 3).map(v => [v.step.text, v.current, v.index]), [['d', true, 3]]);
    assert.deepEqual(visibleSteps([], 0), []);
});

test('swipeDirection: влево — вперёд, вправо — назад', () => {
    assert.equal(swipeDirection(-80, 5, 200), 1);
    assert.equal(swipeDirection(80, -5, 200), -1);
});

test('swipeDirection: короткое движение, медленное и вертикальное — не свайп', () => {
    assert.equal(swipeDirection(-20, 0, 100), 0);        // дрожание
    assert.equal(swipeDirection(-100, 0, 1200), 0);      // слишком медленно
    assert.equal(swipeDirection(-60, 70, 200), 0);       // это прокрутка вниз
    assert.equal(swipeDirection(-60, 30, 200), 1);       // немного наискосок — ещё свайп
});

test('stepForFloor: остаёмся, если уже на этом этаже; иначе ближайший шаг; нет этажа — -1', () => {
    assert.equal(stepForFloor(steps, 2, 1), 1);
    assert.equal(stepForFloor(steps, 1, 0), 2);
    assert.equal(stepForFloor(steps, 2, 3), 1);
    assert.equal(stepForFloor(steps, 3, 0), -1);
    assert.equal(stepForFloor([], 1, 0), -1);
});

test('stepForFloor: при равном расстоянии берём следующий шаг', () => {
    const s = [{ floor: 1 }, { floor: 2 }, { floor: 1 }];
    assert.equal(stepForFloor(s, 1, 1), 2);
});
