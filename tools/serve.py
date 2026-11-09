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


def lan_ip():
    """Адрес компьютера в локальной сети (его вводят на телефоне)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))      # пакеты не отправляются, нужно только выбрать интерфейс
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(('0.0.0.0', port), handler) as server:
        print(f'Компьютер:  http://localhost:{port}')
        print(f'Телефон:    http://{lan_ip()}:{port}   (та же Wi-Fi сеть)')
        print('Остановить: Ctrl+C')
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print('\nОстановлено')
