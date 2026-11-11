// Синтетическое здание для замеров: длинные коридоры по сетке, по обе стороны — аудитории.
// rooms — сколько аудиторий; возвращает { graph, svgSize, boxes } (boxes — рамки комнат для SVG).
export function makeBuilding(rooms) {
    const perCorridor = 20, roomW = 30, roomH = 24, gap = 40;
    const nodes = [], edges = [], boxes = [];
    const corridors = Math.ceil(rooms / (perCorridor * 2));
    const e = (from, to, weight) => edges.push({ from, to, weight, type: 'corridor' });
    let n = 0, prevRow = null;
    for (let c = 0; c < corridors; c++) {
        const cy = 60 + c * (2 * roomH + gap);
        const row = [];
        for (let i = 0; i < perCorridor; i++) {
            const x = 20 + i * roomW + roomW / 2;
            const id = `c-${c}-${i}`;
            nodes.push({ id, type: 'corridor', floor: 1, x, y: cy });
            if (i) e(row[i - 1], id, roomW);
            row.push(id);
            for (const side of [-1, 1]) {
                if (n >= rooms) continue;
                const rid = `room-${++n}`, did = `door-${n}`;
                const ry = cy + side * (gap / 2 + roomH / 2);
                nodes.push({ id: rid, type: 'room', floor: 1, x, y: ry });
                nodes.push({ id: did, type: 'door', floor: 1, x, y: cy + side * gap / 2 });
                e(rid, did, 1); e(did, id, gap / 2);
                boxes.push({ id: rid, x: x - roomW / 2 + 1, y: ry - roomH / 2, width: roomW - 2, height: roomH, label: String(n) });
            }
        }
        if (prevRow) e(prevRow[0], row[0], 2 * roomH + gap);   // связь коридоров
        prevRow = row;
    }
    return { graph: { nodes, edges }, svgSize: { w: 20 + perCorridor * roomW + 20, h: 60 + corridors * (2 * roomH + gap) }, boxes };
}
