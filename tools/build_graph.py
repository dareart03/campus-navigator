#!/usr/bin/env python3
"""
Собирает граф здания (data.json) из SVG-планов этажей.

    python tools/build_graph.py                       # map1.svg, map2.svg, ... из текущей папки
    python tools/build_graph.py --debug-dir debug
    python tools/build_graph.py --check f3-room-311 f1-room-103   # проверить маршрут

Соглашения о структуре SVG (скрипт ищет группы по их id):
  corridor  — закрашенные фигуры = проходимая область (коридоры, проходы, холлы)
  Rooms     — всё, что НЕ проходимо: комнаты (id="room-NNN"), туалеты (id="man-WC-1"),
              безымянные ячейки (любой другой id). Только room-* и *-WC-* становятся целями маршрута.
  Ladders   — лестницы (id="ladder-1" ...). Одноимённые лестницы соседних этажей соединяются.
  Doors     — отрезки (id="door-…"). Дверь принадлежит ближайшей комнате/лестнице.
  Hall, obstacle* — (необязательно) верхнеуровневые фигуры, которые тоже непроходимы.
Номер этажа берётся из имени файла (map3.svg -> 3).

Как строится граф: проходимая область = corridor − (Rooms + Ladders + Hall), сжатая на --margin px от стен.
Узлы — «подходы» к дверям и выпуклые внутрь области углы; рёбра — все пары узлов, видимые друг
из друга. Кратчайший путь по такому графу — это реальный кратчайший путь по коридору.
"""
import argparse, glob, json, math, os, re, sys
from collections import defaultdict
import heapq

try:
    from shapely.geometry import Point, LineString, Polygon, MultiPolygon
    from shapely.geometry.polygon import orient
    from shapely.ops import unary_union, nearest_points
    from shapely.prepared import prep
    from svgelements import SVG, Group, Shape, Path, Move, Close, Line
except ImportError:
    sys.exit('Не хватает пакетов. Установи: pip install -r tools/requirements.txt')

WC_RE = re.compile(r'^(man|woman|special)[-_]wc[-_]?\d*$', re.I)


DIGITS = {
    '0': ('M690 -20C1068 -20 1287 261 1287 744C1287 1226 1066 1510 690 1510C315 1510 94 1226 94 744C94 261 314 -20 690 -20ZM690 233C506 233 405 417 405 744C405 1071 507 1258 690 1258C874 1258 976 1072 976 744C976 417 874 233 690 233Z', 1381),
    '1': ('M749 1490H422L93 1259V980L434 1221H444V0H749Z', 883),
    '2': ('M124 0H1178V251H548V262L773 484C1078 765 1158 903 1158 1070C1158 1328 948 1510 633 1510C324 1510 110 1323 110 1033H402C402 1178 492 1266 631 1266C764 1266 862 1184 862 1051C862 931 787 847 652 715L124 220Z', 1290),
    '3': ('M659 -20C991 -20 1228 163 1228 417C1228 602 1112 735 895 764V775C1060 807 1174 925 1174 1092C1174 1325 970 1510 664 1510C361 1510 132 1332 128 1077H422C425 1193 532 1266 662 1266C791 1266 878 1188 878 1073C878 954 777 873 632 873H494V646H632C805 646 910 560 910 437C910 316 807 233 660 233C519 233 411 306 406 418H99C103 159 335 -20 659 -20Z', 1322),
    '4': ('M101 265H814V0H1107V265H1293V511H1107V1490H724L101 506ZM820 511H409V523L808 1154H820Z', 1385),
    '5': ('M664 -20C991 -20 1215 195 1215 495C1215 781 1017 985 748 985C619 985 507 933 454 861H446L485 1238H1133V1490H232L160 708L434 660C480 719 569 758 658 758C811 758 919 647 919 488C919 330 813 222 664 222C536 222 432 301 426 418H129C135 163 358 -20 664 -20Z', 1309),
    '6': ('M684 -20C1013 -20 1237 197 1237 498C1237 778 1041 979 778 979C615 979 471 901 404 771H394C394 1065 498 1247 695 1247C813 1247 896 1182 921 1077H1221C1191 1322 988 1510 695 1510C329 1510 94 1211 94 710C94 164 381 -20 684 -20ZM682 222C534 222 425 342 425 489C425 635 538 756 684 756C832 756 940 640 940 490C940 338 829 222 682 222Z', 1330),
    '7': ('M177 0H494L1116 1234V1490H75V1238H797V1228Z', 1191),
    '8': ('M666 -20C999 -20 1240 158 1240 400C1240 586 1096 740 919 770V779C1074 812 1185 947 1185 1110C1185 1339 964 1510 666 1510C367 1510 148 1340 148 1110C148 947 256 812 415 779V770C233 740 94 586 94 400C94 158 332 -20 666 -20ZM666 206C512 206 411 296 411 424C411 556 518 650 666 650C813 650 921 555 921 424C921 295 819 206 666 206ZM666 874C538 874 446 958 446 1077C446 1197 536 1277 666 1277C796 1277 886 1196 886 1077C886 958 793 874 666 874Z', 1333),
    '9': ('M636 -22C1002 -22 1237 279 1237 781C1237 1326 949 1510 649 1512C318 1514 94 1294 94 993C94 713 289 511 554 511C717 511 860 591 928 720H938C938 425 832 241 636 241C518 241 435 309 411 415H109C139 168 342 -22 636 -22ZM647 735C499 735 391 850 391 1001C391 1151 502 1268 649 1268C798 1268 907 1147 907 1003C907 856 794 735 647 735Z', 1330),
}  # контуры цифр шрифта Inter Bold (единицы шрифта, y вверх) — для распознавания номеров комнат

# ------------------------------------------------------------------ названия для людей
# Имя в SVG (то, что после «room-») -> как показывать пользователю. Можно дополнять в tools/names.json
# (формат: {"dining room": "Столовая"}); значения из файла важнее встроенных.
DEFAULT_NAMES = {
    'dining room': 'Столовая', "dean's office": 'Кабинет декана', 'wardrobe': 'Гардероб', 'Gym': 'Спортзал',
    'for-staff': 'Служебное помещение', 'for-stuff': 'Служебное помещение',
}
WC_NAMES = {'man': 'Мужской туалет', 'woman': 'Женский туалет', 'special': 'Специальный туалет'}
CHANGING_RE = re.compile(r"^(men|women)'s[-_ ]changing[-_ ]room[-_ ]?(\d*)$", re.I)
CHANGING_NAMES = {'men': 'Мужская раздевалка', 'women': 'Женская раздевалка'}


def load_names():
    names = dict(DEFAULT_NAMES)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'names.json')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            names.update(json.load(f))
    return names


def display_name(label, names):
    """'311' -> '311'; 'dining room' -> 'Столовая'; 'woman-WC-2' -> 'Женский туалет 2'."""
    if label in names:                                   # явное имя из names.json важнее правил
        value = names[label]
        return value[0] if isinstance(value, list) else value
    m = re.match(r'^(man|woman|special)[-_]wc[-_]?(\d*)$', label, re.I)
    if m:
        return (WC_NAMES[m.group(1).lower()] + (' ' + m.group(2) if m.group(2) else '')).strip()
    m = CHANGING_RE.match(label)
    if m:
        return (CHANGING_NAMES[m.group(1).lower()] + (' ' + m.group(2) if m.group(2) else '')).strip()
    value = names.get(label, label)
    return value[0] if isinstance(value, list) else value      # список: первое — основное название


def aliases_of(label, names):
    """Остальные названия из списка (для поиска): "303": ["Кафедра …", "Отдел …"] -> ['Отдел …']."""
    value = names.get(label)
    return list(value[1:]) if isinstance(value, list) else []


# ------------------------------------------------------------------ SVG -> shapely
def walk(node, groups=()):
    for child in node:
        if isinstance(child, Group):
            yield from walk(child, groups + (str(child.id),))
        else:
            yield child, groups


def shape_points(el):
    """Контур элемента как список точек (с учётом transform); кривые — ломаной."""
    p = Path(el)
    p.reify()
    pts = []
    for seg in p.segments(transformed=True):
        if isinstance(seg, Move):
            pts.append((seg.end.x, seg.end.y))
        elif isinstance(seg, Close):
            pass
        elif isinstance(seg, Line):
            if not pts:
                pts.append((seg.start.x, seg.start.y))
            pts.append((seg.end.x, seg.end.y))
        else:  # кривые и дуги
            if not pts:
                pts.append((seg.start.x, seg.start.y))
            for i in range(1, 9):
                q = seg.npoint([i / 8])[0]
                pts.append((q[0], q[1]))
    return pts


def to_polygon(el):
    pts = shape_points(el)
    if len(pts) < 3:
        return None
    poly = Polygon(pts)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly if not poly.is_empty else None


def to_line(el):
    pts = shape_points(el)
    return LineString(pts) if len(pts) >= 2 else None



# ---- режим «по цветам»: нужен, когда в SVG нет групп/id (например, после экспорта из Figma) ----
# Цвета можно править под свои. Сравнение без учёта регистра.
COLOR_ROLES = {
    'walkable':    {'#ffe6cc'},                 # коридоры, проходы (и закрашенные линии stroke этого цвета)
    'ladder':      {'#b4b4b4'},                 # лестницы
    'room':        {'#ffb67e'},                 # комнаты
    'poi':         {'#c79595'},                 # особые помещения (столовая, гардероб…) — тоже комнаты
    'other':       {'#d9d9d9'},                 # прочее непроходимое (ступени, подсобки); целью не становятся
    'wc_woman':    {'#ffb5ff'},
    'wc_man':      {'#a6dd ff'.replace(' ', '')},
    'door':        {'#be6e30', '#834d4d', '#a6a6a6', '#e03de0', '#3795cf'},
    'ladder_door': {'#5e5e5e'},
    'text':        {'#000000'},                 # подписи (глифы), стены (stroke) игнорируются
}
LABEL_MIN_IOU = 0.72


def role_of(hexcolor):
    for role, cols in COLOR_ROLES.items():
        if hexcolor in cols: return role
    return None


def color_hex(c):
    try:
        if c is None or c.value is None: return None
        return c.hex.lower()[:7]
    except Exception:
        return None


def subpath_polys(el):
    """Каждый подконтур элемента — отдельным полигоном (в глифе: внешний контур и дырки)."""
    p = Path(el); p.reify()
    out, cur = [], []
    for seg in p.segments(transformed=True):
        if isinstance(seg, Move):
            if len(cur) >= 3: out.append(cur)
            cur = [(seg.end.x, seg.end.y)]
        elif isinstance(seg, Close):
            if len(cur) >= 3: out.append(cur)
            cur = []
        elif isinstance(seg, Line):
            cur.append((seg.end.x, seg.end.y))
        else:
            for i in range(1, 9):
                q = seg.npoint([i / 8])[0]; cur.append((q[0], q[1]))
    if len(cur) >= 3: out.append(cur)
    return out


def subpath_lines(el):
    """Каждый подконтур (M…) — отдельной линией. Нужно для дверей: в одном <path> бывает несколько отрезков."""
    p = Path(el); p.reify()
    out, cur = [], []
    for seg in p.segments(transformed=True):
        if isinstance(seg, Move):
            if len(cur) >= 2: out.append(LineString(cur))
            cur = [(seg.end.x, seg.end.y)]
        elif isinstance(seg, Close):
            pass
        else:
            cur.append((seg.end.x, seg.end.y))
    if len(cur) >= 2: out.append(LineString(cur))
    return [l for l in out if l.length > 0.5]


def evenodd(polys):
    res = None
    for pts in polys:
        g = Polygon(pts).buffer(0)
        res = g if res is None else res.symmetric_difference(g)
    return res


_glyph_cache = {}
def candidate_polygon(text):
    """Как выглядит строка text, набранная шрифтом подписей (нормирована в единичный квадрат)."""
    if text in _glyph_cache: return _glyph_cache[text]
    polys, x = [], 0
    for ch in text:
        d, adv = DIGITS[ch]
        for sub in subpath_polys(Path(d)):
            polys.append([(px + x, -py) for px, py in sub])
        x += adv
    g = evenodd(polys)
    _glyph_cache[text] = normalize(g)
    return _glyph_cache[text]


def normalize(g):
    x0, y0, x1, y1 = g.bounds
    from shapely import affinity
    return affinity.affine_transform(g, [1 / (x1 - x0), 0, 0, 1 / (y1 - y0), -x0 / (x1 - x0), -y0 / (y1 - y0)])


def recognize_number(label_geom, candidates):
    g = normalize(label_geom)
    best, score = None, 0
    for text, cand in candidates.items():
        inter = g.intersection(cand).area
        if inter <= score * 0.5: continue          # быстрый отсев
        iou = inter / (g.union(cand).area or 1)
        if iou > score: best, score = text, iou
    return (best, score) if score >= LABEL_MIN_IOU else (None, score)


def parse_floor_colors(path):
    svg = SVG.parse(path)
    vb = svg.viewbox
    cx, cy = (vb.x + vb.width / 2, vb.y + vb.height / 2) if vb else (357, 233)
    info = dict(corridor=[], obstacles=[], rooms={}, ladders={}, doors={}, notes=[])
    roomlike, wcs, ladders, labels, doors, ladder_doors = [], [], [], [], [], []
    for el, groups in walk(svg):
        if not isinstance(el, Shape): continue
        fill, stroke = color_hex(el.fill), color_hex(el.stroke)
        frole, srole = role_of(fill), role_of(stroke)
        if frole == 'walkable':
            poly = to_polygon(el)
            if poly: info['corridor'].append(poly)
        elif srole == 'walkable' and (el.stroke_width or 0) > 0 and frole is None:
            line = to_line(el)
            if line: info['corridor'].append(line.buffer(el.stroke_width / 2, cap_style=2))
        elif frole == 'ladder':
            poly = to_polygon(el)
            if poly: ladders.append(poly)
        elif frole in ('room', 'poi', 'other'):
            poly = to_polygon(el)
            if poly: roomlike.append((poly, frole))
        elif frole in ('wc_woman', 'wc_man'):
            poly = to_polygon(el)
            if poly: wcs.append((poly, frole))
        elif frole == 'text' and stroke is None:
            subs = subpath_polys(el)
            if subs: labels.append(evenodd(subs))
        elif srole == 'door':
            doors.extend(subpath_lines(el))
        elif srole == 'ladder_door':
            ladder_doors.extend(subpath_lines(el))

    # номера комнат: подпись, центр которой лежит внутри комнаты, распознаётся по форме цифр
    cands = {str(n): candidate_polygon(str(n)) for n in range(1, 400)}
    recognized, unknown = [], 0
    for g in labels:
        num, score = recognize_number(g, cands)
        if num: recognized.append((num, g.centroid))
        else: unknown += 1
    named, used = {}, set()
    for poly, role in roomlike:
        info['obstacles'].append(poly)
        hits = [n for n, c in recognized if poly.contains(c)]
        if hits:
            n = hits[0]
            if n in used: info['notes'].append(f'номер {n} встретился у двух комнат — вторая считается безымянной')
            else:
                used.add(n); info['rooms'][f'room-{n}'] = (poly, 'room', n); named[id(poly)] = f'room-{n}'
    # безымянная комната, примыкающая к именованной, — её часть (комнату бывает проще нарисовать двумя прямоугольниками)
    for poly, role in roomlike:
        if id(poly) in named or role != 'room': continue
        for rid, (rp, t, lab) in list(info['rooms'].items()):
            if t == 'room' and rp.distance(poly) < 0.6:
                info['rooms'][rid] = (unary_union([rp, poly]).buffer(0), t, lab); named[id(poly)] = rid
                info['notes'].append(f'безымянная фигура присоединена к {rid}')
                break
    for k, (poly, role) in enumerate(sorted(wcs, key=lambda t: (t[0].centroid.x, t[0].centroid.y)), 1):
        info['obstacles'].append(poly)
        wid = ('woman' if role == 'wc_woman' else 'man') + f'-WC-{sum(1 for _, r in wcs[:k] if r == role)}'
        wid = f"{'woman' if role == 'wc_woman' else 'man'}-WC-{k}"
        info['rooms'][wid] = (poly, 'wc', wid)
    # лестницы нумеруем по углам: 1 — низ-лево, 2 — верх-лево, 3 — верх-право, 4 — низ-право
    for poly in ladders:
        c = poly.centroid
        num = {(False, True): 1, (False, False): 2, (True, False): 3, (True, True): 4}[(c.x > cx, c.y > cy)]
        lid = f'ladder-{num}'
        if lid in info['ladders']: lid = f'ladder-{len(info["ladders"]) + 1}'; info['notes'].append(f'две лестницы в одном углу, одна названа {lid}')
        info['ladders'][lid] = poly; info['obstacles'].append(poly)
    targets = {**{k: v[0] for k, v in info['rooms'].items()}, **info['ladders']}
    unnamed_poly = [p for p, _ in roomlike if id(p) not in named]
    count = defaultdict(int)
    skipped = 0
    for line in doors + ladder_doors:
        mid = line.interpolate(0.5, normalized=True)
        cand = [(p.distance(mid), k) for k, p in targets.items()]
        near_unnamed = min((p.distance(mid) for p in unnamed_poly), default=1e9)
        d, owner = min(cand, default=(1e9, None))
        if d > 6 or near_unnamed + 0.01 < d:           # дверь безымянного помещения (актовый зал, подсобка…)
            skipped += 1; continue
        base = 'door-' + (owner[5:] if owner.startswith('room-') else owner if not owner.startswith('ladder') else owner)
        if owner.startswith('ladder'): base = 'door-' + owner
        count[base] += 1
        info['doors'][base if count[base] == 1 else f'{base}-{count[base]}'] = line
    info['summary'] = dict(rooms=len([r for r in info['rooms'] if r.startswith('room-')]), wc=len(wcs), ladders=len(ladders),
                           doors=len(info['doors']), skipped_doors=skipped,
                           unnamed=len(unnamed_poly), labels_unknown=unknown)
    info['unnamed_polys'] = unnamed_poly
    return info


def _canon(name):
    """Для сравнения имён двери и комнаты: регистр, men/man, women/woman, stuff/staff, разделители."""
    n = name.lower().replace('&#39;', "'")
    n = re.sub(r"[\s_-]+", '-', n)
    for a, b in (('women', 'woman'), ('men', 'man'), ('stuff', 'staff')):
        n = n.replace(a, b)
    return n


def door_matches(door_id, owner):
    """door-325-1 / door-324_2 / door-man-WC-2 -> относится ли к комнате owner (room-325, man-WC-2)?"""
    base = door_id[5:] if door_id.startswith('door-') else door_id
    target = owner[5:] if owner.startswith('room-') else owner
    candidates = {base, re.sub(r'[-_]\d+$', '', base)}           # с хвостом-номером двери и без него
    return _canon(target) in {_canon(c) for c in candidates}


def parse_floor(path):
    svg = SVG.parse(path)
    if not any(g.lower() == "corridor" for _, gs in walk(svg) for g in gs):
        return parse_floor_colors(path)         # плоский SVG без групп (Figma) — работаем по цветам
    info = dict(corridor=[], obstacles=[], rooms={}, ladders={}, doors={})
    parts = defaultdict(list)                   # комната из нескольких фигур (группа room-… ) -> список полигонов
    for el, groups in walk(svg):
        if not isinstance(el, Shape):
            continue
        eid = str(el.id) if el.id else ''
        low = [g.lower() for g in groups]
        if 'corridor' in low:
            if el.fill is not None and el.fill.value is not None:
                poly = to_polygon(el)
                if poly: info['corridor'].append(poly)
            elif el.stroke is not None and el.stroke.value is not None and (el.stroke_width or 0) > 0:
                line = to_line(el)               # проход, нарисованный толстой линией
                if line: info['corridor'].append(line.buffer(el.stroke_width / 2, cap_style=2))
        elif 'rooms' in low:
            poly = to_polygon(el)
            if not poly: continue
            info['obstacles'].append(poly)
            # имя комнаты: ближайшая группа room-… / *-WC-… над фигурой, иначе id самой фигуры
            name = next((g for g in reversed(groups) if g.startswith('room-') or WC_RE.match(g)), eid)
            if name.startswith('room-') or WC_RE.match(name):
                parts[name].append(poly)
        elif 'ladders' in low:
            poly = to_polygon(el)
            if poly:
                info['obstacles'].append(poly)
                if eid: info['ladders'][eid] = poly
        elif any(g.endswith('doors') for g in low):
            if eid:
                lines = subpath_lines(el)          # в одном <path> может быть несколько дверей
                for k, ln in enumerate(lines):
                    info['doors'][eid if len(lines) == 1 else f'{eid}~{k + 1}'] = ln
        elif not groups and (eid == 'Hall' or eid.startswith('obstacle')):
            poly = to_polygon(el)
            if poly: info['obstacles'].append(poly)
    for name, polys in parts.items():
        poly = unary_union([q.buffer(0.3) for q in polys]).buffer(-0.3) if len(polys) > 1 else polys[0]
        if name.startswith('room-'):
            info['rooms'][name] = (poly, 'room', name[5:])
        else:
            info['rooms'][name] = (poly, 'wc', name)
    return info


# ------------------------------------------------------------------ geometry
def reflex_vertices(area):
    """Вершины, выступающие внутрь проходимой области (по ним огибают углы)."""
    out = []
    polys = area.geoms if isinstance(area, MultiPolygon) else [area]
    for poly in polys:
        poly = orient(poly, 1.0)  # внутренность слева у всех колец
        for ring in [poly.exterior, *poly.interiors]:
            c = list(ring.coords)[:-1]
            n = len(c)
            for i in range(n):
                a, b, d = c[i - 1], c[i], c[(i + 1) % n]
                cross = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0])
                if cross < -1e-6:
                    out.append(b)
    return out


def build_floor(num, path, margin, prefix, log):
    info = parse_floor(path)
    if not info['corridor']:
        raise SystemExit(
            f'{path}: не нашла проходимую область (группа «corridor»), комнаты, двери и лестницы.\n'
            '  Скорее всего, SVG экспортирован без групп и id (в Figma: Export -> SVG -> включить «Include \'id\' attribute»,\n'
            '  слои и группы назвать corridor / Rooms / Ladders / Doors, а слои комнат и дверей — room-311, door-311 и т.д.).')
    walk_area = unary_union(info['corridor']).difference(unary_union(info['obstacles'])).buffer(0)
    shrunk = walk_area.buffer(-margin, join_style=2)
    if shrunk.is_empty:
        raise SystemExit(f'{path}: после отступа {margin}px проходимая область пуста — уменьши --margin')
    inside = prep(shrunk.buffer(0.05))

    pre = f'f{num}-' if prefix else ''
    nodes, edges, warnings = {}, [], []

    def add_node(i, x, y, t, label=None):
        nodes[i] = dict(id=i, x=round(x, 1), y=round(y, 1), floor=num, type=t)
        if label is not None: nodes[i]['label'] = label

    def dist(a, b): return math.hypot(nodes[a]['x'] - nodes[b]['x'], nodes[a]['y'] - nodes[b]['y'])
    def add_edge(a, b, t, w=None):
        edges.append(dict({'from': a, 'to': b, 'weight': round(w if w is not None else dist(a, b), 1), 'type': t}))

    # цели: комнаты, WC, лестницы
    targets = {}
    for rid, (poly, t, label) in info['rooms'].items():
        c = poly.centroid if poly.contains(poly.centroid) else poly.representative_point()
        add_node(pre + rid, c.x, c.y, t, display_name(label, NAMES)); targets[rid] = poly
        if aliases_of(label, NAMES): nodes[pre + rid]['aliases'] = aliases_of(label, NAMES)
    for lid, poly in info['ladders'].items():
        c = poly.centroid
        add_node(pre + lid, c.x, c.y, 'stairs', lid); targets[lid] = poly

    approaches = []
    owner_of = {}
    for did, line in info['doors'].items():
        mid = line.interpolate(0.5, normalized=True)
        # владелец двери — ближайшая цель, не дальше 6px
        best = min(targets.items(), key=lambda kv: kv[1].distance(mid), default=None)
        if not best or best[1].distance(mid) > 6:
            if any(o.distance(mid) <= 6 for o in info['obstacles']):
                continue                          # дверь служебной/безымянной ячейки — не цель маршрута
            warnings.append(f'{os.path.basename(path)}: дверь «{did}» не касается ни одной комнаты/лестницы — пропущена')
            continue
        owner = best[0]
        if did.startswith('door-') and not owner.startswith('ladder') and not door_matches(did, owner):
            warnings.append(f'{os.path.basename(path)}: дверь «{did}» стоит у «{owner}» — проверь имя')
        coords = list(line.coords)
        dx, dy = coords[-1][0] - coords[0][0], coords[-1][1] - coords[0][1]
        ln = math.hypot(dx, dy) or 1
        nx, ny = -dy / ln, dx / ln
        ap = None
        for s in [margin + k * 0.5 for k in range(1, 30)]:
            for sign in (1, -1):
                p = Point(mid.x + sign * nx * s, mid.y + sign * ny * s)
                if inside.contains(p):
                    ap = (p.x, p.y, s); break
            if ap: break
        if ap is None:
            near = nearest_points(shrunk, mid)[0]
            if near.distance(mid) <= margin + 15: ap = (near.x, near.y, near.distance(mid))
        if ap is None:
            warnings.append(f'{os.path.basename(path)}: у двери «{did}» нет выхода в проходимую область (corridor)')
            continue
        add_node(pre + did, mid.x, mid.y, 'door')
        apid = f'{pre}ap-{did}'
        add_node(apid, ap[0], ap[1], 'corridor')
        add_edge(pre + did, apid, 'door', ap[2])
        add_edge(pre + owner, pre + did, 'door' if not owner.startswith('ladder') else 'stairs', 1)
        approaches.append(apid)
        owner_of[did] = owner

    for rid in targets:
        if not any(pre + rid in (e['from'], e['to']) for e in edges):
            warnings.append(f'{os.path.basename(path)}: у «{rid}» нет ни одной двери — маршрут до неё не построить')

    # граф видимости
    wp = []
    for i, (x, y) in enumerate(reflex_vertices(shrunk)):
        wid = f'{pre}wp-{i}'; add_node(wid, x, y, 'corridor'); wp.append(wid)
    pool = approaches + wp
    for a in range(len(pool)):
        for b in range(a + 1, len(pool)):
            A, B = nodes[pool[a]], nodes[pool[b]]
            seg = LineString([(A['x'], A['y']), (B['x'], B['y'])])
            if seg.length < 0.05 or not inside.contains(seg):
                continue
            # лишнее ребро: на отрезке лежит другой узел — путь пойдёт через него
            blocked = False
            for c in pool:
                if c in (pool[a], pool[b]): continue
                C = nodes[c]
                if seg.distance(Point(C['x'], C['y'])) < 0.2 and \
                   dist(pool[a], c) < seg.length and dist(pool[b], c) < seg.length:
                    blocked = True; break
            if not blocked:
                add_edge(pool[a], pool[b], 'corridor')
    prune_visibility(nodes, edges, set(pool))
    log(f'  этаж {num}: комнат {sum(1 for n in nodes.values() if n["type"] in ("room","wc"))}, '
        f'дверей {len(owner_of)}, лестниц {len(info["ladders"])}, узлов {len(nodes)}, рёбер {len(edges)}')
    return nodes, edges, warnings, shrunk


def prune_visibility(nodes, edges, pool):
    """Убирает рёбра видимости, которые не нужны ни одному кратчайшему пути (длины путей не меняются)."""
    adj = defaultdict(list)
    for e in edges:
        adj[e['from']].append((e['to'], e['weight'])); adj[e['to']].append((e['from'], e['weight']))
    def dijkstra(src):
        d, pq = {src: 0}, [(0, src)]
        while pq:
            du, u = heapq.heappop(pq)
            if du > d.get(u, 1e18): continue
            for v, w in adj[u]:
                nd = du + w
                if nd < d.get(v, 1e18): d[v] = nd; heapq.heappush(pq, (nd, v))
        return d
    dist = {i: dijkstra(i) for i in pool}
    keep = []
    for e in edges:
        if e['type'] == 'corridor' and e['from'] in pool and e['to'] in pool:
            # есть путь не длиннее обходом через другие узлы? тогда прямое ребро лишнее
            others = min((dist[e['from']].get(c, 1e18) + dist[c].get(e['to'], 1e18)
                          for c in pool if c not in (e['from'], e['to'])), default=1e18)
            if others <= e['weight'] + 0.05: continue
        keep.append(e)
    edges[:] = keep


# ------------------------------------------------------------------ отладочный SVG
def write_debug(path, out, nodes, edges, shrunk):
    svg = open(path, encoding='utf-8').read()
    col = {'door': '#00aaff', 'corridor': '#ff00ff', 'stairs': '#ffd400', 'room': '#00dd44', 'wc': '#ffffff'}
    o = ['<g id="debug-graph" opacity="0.9">']
    polys = shrunk.geoms if isinstance(shrunk, MultiPolygon) else [shrunk]
    for p in polys:
        for ring in [p.exterior, *p.interiors]:
            o.append('<polyline fill="none" stroke="#2aa" stroke-width="0.8" stroke-dasharray="3 2" points="%s"/>'
                     % ' '.join(f'{x:.1f},{y:.1f}' for x, y in ring.coords))
    for e in edges:
        a, b = nodes.get(e['from']), nodes.get(e['to'])
        if a and b:
            o.append(f'<line x1="{a["x"]}" y1="{a["y"]}" x2="{b["x"]}" y2="{b["y"]}" stroke="red" stroke-width="1"/>')
    for n in nodes.values():
        o.append(f'<circle cx="{n["x"]}" cy="{n["y"]}" r="2.2" fill="{col.get(n["type"], "#fff")}"/>')
    o.append('</g>')
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    open(out, 'w', encoding='utf-8').write(svg.replace('</svg>', '\n'.join(o) + '\n</svg>'))


# ------------------------------------------------------------------ Дейкстра (для --check и самопроверки)
def shortest(graph, a, b):
    adj = defaultdict(list)
    ids = {n['id']: n for n in graph['nodes']}
    for e in graph['edges']:
        adj[e['from']].append((e['to'], e['weight'])); adj[e['to']].append((e['from'], e['weight']))
    dist, prev, pq = {a: 0}, {}, [(0, a)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e18): continue
        if u == b: break
        for v, w in adj[u]:
            if ids[v]['type'] == 'room' and v != b: continue   # сквозь комнаты не ходим
            nd = d + w
            if nd < dist.get(v, 1e18): dist[v] = nd; prev[v] = u; heapq.heappush(pq, (nd, v))
    if b not in dist: return None
    path = [b]
    while path[-1] != a: path.append(prev[path[-1]])
    return dist[b], path[::-1]


# ------------------------------------------------------------------ main
NAMES = load_names()


def main():
    ap = argparse.ArgumentParser(description='SVG этажей -> data.json (граф здания)')
    ap.add_argument('--svg-dir', default='maps', help='папка с SVG планами этажей')
    ap.add_argument('--pattern', default='map[0-9]*.svg', help='маска имён файлов этажей')
    ap.add_argument('--out', default='data/data.json')
    ap.add_argument('--margin', type=float, default=6, help='отступ маршрута от стен, px (меньше — если коридоры узкие)')
    ap.add_argument('--stairs-weight', type=float, default=40, help='вес подъёма на один этаж (в px-эквиваленте)')
    ap.add_argument('--debug-dir', default=None, help='куда писать SVG с нарисованным графом для проверки глазами')
    ap.add_argument('--no-prefix', action='store_true', help='без префиксов f<N>- у id (только для одного этажа)')
    ap.add_argument('--check', nargs=2, metavar=('A', 'B'), help='после сборки показать маршрут между двумя узлами')
    args = ap.parse_args()
    log = print

    files = sorted(glob.glob(os.path.join(args.svg_dir, args.pattern)))
    floors = {}
    for f in files:
        m = re.search(r'(\d+)\.svg$', os.path.basename(f))
        if m: floors[int(m.group(1))] = f
    if not floors:
        sys.exit(f'Не найдено файлов по маске {args.pattern} в «{args.svg_dir}»')
    if args.no_prefix and len(floors) > 1:
        sys.exit('--no-prefix можно использовать только когда этаж один')

    log('Этажи: ' + ', '.join(f'{n} ({os.path.basename(p)})' for n, p in sorted(floors.items())))
    all_nodes, all_edges, warnings = {}, [], []
    for num, path in sorted(floors.items()):
        nodes, edges, w, shrunk = build_floor(num, path, args.margin, not args.no_prefix, log)
        all_nodes.update(nodes); all_edges += edges; warnings += w
        if args.debug_dir:
            write_debug(path, os.path.join(args.debug_dir, f'floor{num}.graph.svg'), nodes, edges, shrunk)

    # межэтажные рёбра: ladder-k <-> ladder-k на соседних этажах
    nums = sorted(floors)
    for lo, hi in zip(nums, nums[1:]):
        pl, ph = ('' if args.no_prefix else f'f{lo}-'), ('' if args.no_prefix else f'f{hi}-')
        low = {i[len(pl):] for i, n in all_nodes.items() if n['floor'] == lo and n['type'] == 'stairs'}
        high = {i[len(ph):] for i, n in all_nodes.items() if n['floor'] == hi and n['type'] == 'stairs'}
        for lid in sorted(low & high):
            all_edges.append({'from': pl + lid, 'to': ph + lid, 'weight': args.stairs_weight, 'type': 'stairs'})
        for lid in sorted(low ^ high):
            warnings.append(f'лестница «{lid}» есть только на одном из этажей {lo} и {hi} — переход по ней не построится')

    graph = dict(
        meta=dict(floors=nums, margin=args.margin, stairsWeight=args.stairs_weight,
                  sources=[os.path.basename(floors[n]) for n in nums]),
        nodes=list(all_nodes.values()), edges=all_edges)

    # самопроверка: всё здание — одна связная часть (включая лестницы и все этажи)
    adj = defaultdict(set)
    for e in graph['edges']:
        adj[e['from']].add(e['to']); adj[e['to']].add(e['from'])
    seen, comps = set(), []
    for n in graph['nodes']:
        if n['id'] in seen: continue
        comp, st = set(), [n['id']]
        while st:
            u = st.pop()
            if u in comp: continue
            comp.add(u); st += adj[u]
        seen |= comp; comps.append(comp)
    comps.sort(key=len, reverse=True)
    for comp in comps[1:]:
        targets = sorted(i for i in comp if all_nodes[i]['type'] in ('room', 'wc', 'stairs'))
        if targets:
            warnings.append('не связаны с основной частью здания: ' + ', '.join(targets[:8]) + ('…' if len(targets) > 8 else ''))

    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(graph, fh, ensure_ascii=False, indent=1)
    log(f'Записано: {args.out} — узлов {len(graph["nodes"])}, рёбер {len(graph["edges"])}')
    for w in warnings: log('  ВНИМАНИЕ: ' + w)
    if not warnings: log('Замечаний нет.')

    if args.check:
        r = shortest(graph, *args.check)
        if not r: log(f'Маршрута {args.check[0]} -> {args.check[1]} нет')
        else:
            floors_path = []
            for i in r[1]:
                f = all_nodes[i]['floor']
                if not floors_path or floors_path[-1] != f: floors_path.append(f)
            log(f'Маршрут {args.check[0]} -> {args.check[1]}: длина {r[0]:.1f}, этажи {floors_path}, узлов {len(r[1])}')
            if args.debug_dir:
                for fl in floors_path:
                    pts = ' '.join(f'{all_nodes[i]["x"]},{all_nodes[i]["y"]}' for i in r[1]
                                   if all_nodes[i]['floor'] == fl and all_nodes[i]['type'] != 'room')
                    src = open(floors[fl], encoding='utf-8').read()
                    if ' ' not in pts.strip():   # на этаже один узел (проезд по лестнице насквозь) — рисуем точку
                        x, y = (pts.split(',') + ['0'])[:2] if pts else ('0', '0')
                        pts_svg = f'<circle cx="{x}" cy="{y}" r="6" fill="#1565ff"/>'
                    else:
                        pts_svg = f'<polyline points="{pts}" fill="none" stroke="#1565ff" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>'
                    out = os.path.join(args.debug_dir, f'route_floor{fl}.svg')
                    open(out, 'w', encoding='utf-8').write(src.replace('</svg>',
                        pts_svg + '</svg>'))
                log(f'  картинки маршрута: {args.debug_dir}/route_floor*.svg')


if __name__ == '__main__':
    main()
