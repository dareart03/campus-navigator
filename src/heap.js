// Бинарная мин-куча для Дейкстры: push/pop за O(log n). Хранит пары [приоритет, значение].
export class MinHeap {
    constructor() { this.keys = []; this.vals = []; }
    get size() { return this.keys.length; }

    push(key, val) {
        const { keys, vals } = this;
        let i = keys.length;
        keys.push(key); vals.push(val);
        while (i > 0) {                       // поднимаем, пока родитель больше
            const p = (i - 1) >> 1;
            if (keys[p] <= key) break;
            keys[i] = keys[p]; vals[i] = vals[p];
            i = p;
        }
        keys[i] = key; vals[i] = val;
    }

    pop() {
        const { keys, vals } = this;
        const topKey = keys[0], topVal = vals[0];
        const key = keys.pop(), val = vals.pop();
        const n = keys.length;
        if (n > 0) {                          // последний элемент опускаем с корня
            let i = 0;
            for (;;) {
                let c = 2 * i + 1;
                if (c >= n) break;
                if (c + 1 < n && keys[c + 1] < keys[c]) c++;
                if (keys[c] >= key) break;
                keys[i] = keys[c]; vals[i] = vals[c];
                i = c;
            }
            keys[i] = key; vals[i] = val;
        }
        return [topKey, topVal];
    }
}
