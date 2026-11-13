#!/usr/bin/env python3
"""Запуск «Навигатора по корпусу» одной командой.

    python run.py

Что делает (каждый шаг можно отключить, см. `python run.py --help`):
  1. создаёт папку .venv и ставит туда зависимости генератора графа (один раз; в следующие запуски пропускается);
  2. находит планы этажей maps/map1.svg, map2.svg, ...;
  3. строит граф здания data/data.json и картинки для проверки глазами в папке debug/;
  4. запускает тесты (нужен Node.js 20+; если его нет, шаг пропускается);
  5. запускает локальный сервер и открывает приложение в браузере.

Новые карты: положите свои SVG в maps/ как map1.svg, map2.svg, ... (правила id в README) и запустите ту же команду.
Нужен только Python 3.9+. Скрипт использует лишь стандартную библиотеку.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import time
import venv
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / '.venv'
MAPS = ROOT / 'maps'
DEBUG = ROOT / 'debug'
REQUIREMENTS = ROOT / 'tools' / 'requirements.txt'
IMPORTS = 'import shapely, svgelements'            # то, что нужно build_graph.py


def say(text=''):
    print(text, flush=True)


def step(number, title):
    say(f'\n[{number}] {title}')


def ok(text):
    say(f'    [ok] {text}')


def warn(text):
    say(f'    [!]  {text}')


def fail(text, hint=None):
    say(f'    [ОШИБКА] {text}')
    if hint:
        for line in hint.splitlines():
            say(f'             {line}')
    sys.exit(1)


def venv_python():
    return VENV / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def run(cmd, **kwargs):
    # UTF-8 для вывода дочерних программ: иначе русский текст в консоли Windows может упасть с ошибкой кодировки
    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1'}
    return subprocess.run([str(c) for c in cmd], cwd=ROOT, env=env, **kwargs)


def deps_ready(python):
    return run([python, '-c', IMPORTS], capture_output=True).returncode == 0


# --- шаги ---

def setup_environment():
    step(1, 'Окружение Python и зависимости')
    if sys.version_info < (3, 9):
        fail(f'Нужен Python 3.9 или новее, а запущен {sys.version.split()[0]}.', 'Скачайте свежий Python: https://www.python.org/downloads/')
    python = venv_python()
    first_run = not python.exists()
    if first_run:
        say('    Первый запуск: создаю .venv (занимает около минуты)…')
        try:
            venv.create(VENV, with_pip=True, clear=False)
        except Exception as err:                                   # на некоторых Linux venv ставится отдельным пакетом
            warn(f'не удалось создать .venv ({err}); использую текущий Python')
            python = Path(sys.executable)
    if deps_ready(python):
        ok(f'зависимости установлены ({python})')
        return python
    say('    Ставлю зависимости: ' + ', '.join(line.strip() for line in REQUIREMENTS.read_text().splitlines() if line.strip()))
    result = run([python, '-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', REQUIREMENTS])
    if result.returncode != 0 or not deps_ready(python):
        fail('не удалось установить зависимости.',
             'Проверьте подключение к интернету (pip скачивает пакеты) и повторите запуск.\n'
             f'Вручную: {python} -m pip install -r tools/requirements.txt')
    ok('зависимости установлены')
    return python


def find_maps():
    step(2, 'Планы этажей')
    files = sorted(MAPS.glob('map[0-9]*.svg'), key=lambda p: int(re.search(r'(\d+)', p.stem).group(1)))
    if not files:
        fail('в папке maps/ нет планов этажей.',
             'Положите туда SVG с именами map1.svg, map2.svg, ... (по файлу на этаж).\n'
             'Как подписать комнаты, двери и лестницы в SVG: раздел «Как обновить карту» в README.md.')
    for f in files:
        ok(f'{f.relative_to(ROOT)} ({f.stat().st_size // 1024} КБ)')
    return files


def build_graph(python, stairs_weight):
    step(3, 'Граф здания (data/data.json) и картинки для проверки (debug/)')
    cmd = [python, 'tools/build_graph.py', '--debug-dir', DEBUG]
    if stairs_weight is not None:
        cmd += ['--stairs-weight', stairs_weight]
    started = time.time()
    if run(cmd).returncode != 0:
        fail('граф не построился: причина выше.',
             'Самые частые причины: у комнаты в SVG нет id вида room-311, у двери нет пары door-311, нет лестниц ladder-N.\n'
             'Картинки в debug/ помогают увидеть, что именно не распозналось.')
    ok(f'data/data.json готов за {time.time() - started:.0f} с')
    pictures = sorted(DEBUG.glob('*.svg')) if DEBUG.exists() else []
    if pictures:
        ok(f'для проверки глазами откройте в браузере: {", ".join(str(p.relative_to(ROOT)) for p in pictures)}')


def run_tests():
    step(4, 'Тесты')
    node = shutil.which('node')
    if not node:
        warn('Node.js не найден, тесты пропущены. Нужен Node 20+: https://nodejs.org (потом запустите: node --test)')
        return
    result = run([node, '--test'], capture_output=True, text=True, encoding='utf-8', errors='replace')
    summary = {k: re.search(rf'^# {k} (\d+)', result.stdout, re.M) for k in ('tests', 'pass', 'fail')}
    nums = {k: int(m.group(1)) if m else None for k, m in summary.items()}
    if result.returncode == 0:
        ok(f'все тесты прошли ({nums["pass"]} из {nums["tests"]})')
        return
    failed = [l.split(' - ', 1)[-1] for l in result.stdout.splitlines() if l.startswith('not ok')]
    for name in failed[:15]:
        say(f'    - не прошёл: {name}')
    warn(f'тестов не прошло: {nums["fail"]}.')
    warn('Часть тестов проверяет данные именно этого здания (аудитории 311, 118 и т. д.). Если вы подставили свои карты, '
         'такие тесты могут падать: это ожидаемо. Тесты кода (поиск, жесты, шаги маршрута) от карт не зависят.')


def serve(python, port, open_browser):
    step(5, 'Сервер')
    url = f'http://localhost:{port}'
    say(f'    Приложение: {url}')
    say('    Телефон: адрес печатает сервер ниже (телефон и компьютер в одной Wi-Fi сети).')
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    say('    Остановить: Ctrl+C\n')
    try:
        run([python, 'tools/serve.py', port])
    except KeyboardInterrupt:
        say('\nОстановлено.')


def main():
    ap = argparse.ArgumentParser(description='Запуск «Навигатора по корпусу»: окружение, граф, тесты, сервер.')
    ap.add_argument('--port', default='8000', help='порт сервера (по умолчанию 8000)')
    ap.add_argument('--stairs-weight', default=None, help='вес этажа в графе (по умолчанию 200, см. README)')
    ap.add_argument('--skip-build', action='store_true', help='не пересобирать граф (взять готовый data/data.json)')
    ap.add_argument('--skip-tests', action='store_true', help='не запускать тесты')
    ap.add_argument('--no-serve', action='store_true', help='только подготовка: без сервера')
    ap.add_argument('--no-browser', action='store_true', help='не открывать браузер')
    args = ap.parse_args()

    try:                                                   # кириллица в консоли Windows
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

    say('Навигатор по корпусу: запуск')
    if args.skip_build and not (ROOT / 'data' / 'data.json').exists():
        fail('нет data/data.json, а сборка отключена (--skip-build).', 'Запустите без --skip-build.')
    python = setup_environment()
    if not args.skip_build:
        find_maps()
        build_graph(python, args.stairs_weight)
    if not args.skip_tests:
        run_tests()
    if args.no_serve:
        say('\nГотово. Запуск сервера: python run.py --skip-build --skip-tests')
        return
    serve(python, args.port, not args.no_browser)


if __name__ == '__main__':
    main()
