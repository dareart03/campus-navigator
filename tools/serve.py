#!/usr/bin/env python3
"""
Локальный сервер для разработки: как `python -m http.server`, но без кеширования в браузере,
чтобы телефон всегда получал свежие карты, граф и скрипты.

    python tools/serve.py            # порт 8000
    python tools/serve.py 8080       # другой порт

Сервер раздаёт папку проекта (корень, где лежит index.html), откуда бы ни был запущен.
"""
import functools
import http.server
import os
import socket
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def lan_ips():
    """Адреса компьютера в локальной сети, самые вероятные первыми.

    Один адрес надёжно определить нельзя: на Windows кроме Wi-Fi бывают виртуальные адаптеры (WSL, Docker, VPN),
    и «адрес по умолчанию» может оказаться виртуальным (172.19.0.1), недоступным с телефона. Поэтому собираем все
    IPv4 компьютера и сортируем: домашние сети (192.168.x.x), потом 10.x.x.x, потом 172.16–31.x.x, где обычно виртуалки.
    """
    found = set()
    try:                                       # все адреса по имени компьютера
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except OSError:
        pass
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:                                       # адрес интерфейса, через который идёт интернет
        s.connect(('10.255.255.255', 1))       # пакеты не отправляются, нужно только выбрать интерфейс
        found.add(s.getsockname()[0])
    except OSError:
        pass
    finally:
        s.close()

    def rank(ip):
        a, b = (int(x) for x in ip.split('.')[:2])
        if a == 192 and b == 168: return 0
        if a == 10: return 1
        if a == 172 and 16 <= b <= 31: return 2
        return 3

    usable = [ip for ip in found if not ip.startswith(('127.', '169.254.', '0.'))]
    return sorted(usable, key=lambda ip: (rank(ip), ip))


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(('0.0.0.0', port), handler) as server:
        print(f'Компьютер:  http://localhost:{port}')
        ips = lan_ips()
        if ips:
            print(f'Телефон:    http://{ips[0]}:{port}   (та же Wi-Fi сеть)')
            for ip in ips[1:]:
                print(f'            или http://{ip}:{port}   (если первый не открылся: это другой адаптер)')
        else:
            print('Телефон:    адрес не найден, посмотрите «IPv4-адрес» в `ipconfig` (адаптер Wi-Fi)')
        print('Остановить: Ctrl+C')
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print('\nОстановлено')