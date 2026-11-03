# Замер для квадрата на пульте: скорость загрузки, печатает JSON.
# Загружается пробный файл, сначала маленький, большой только на быстрой линии,
# чтобы не тратить трафик зря
import json
import time
import urllib.request

DOWN = "https://speed.cloudflare.com/__down?bytes={}"
SIZES = (2_000_000, 10_000_000)
ENOUGH_SEC = 1.0  # столько должна длиться загрузка, чтобы замеру можно было верить
LIMIT_SEC = 6
CHUNK = 65536
HEADERS = {"User-Agent": "session-pult"}


def download(size):
    """Читает файл, но не дольше LIMIT_SEC; возвращает байты и секунды от первого куска данных."""
    req = urllib.request.Request(DOWN.format(size), headers=HEADERS)
    with urllib.request.urlopen(req, timeout=8) as res:
        first = res.read(CHUNK)
        start = time.perf_counter()
        got = 0
        while first:
            chunk = res.read(CHUNK)
            if not chunk:
                break
            got += len(chunk)
            if time.perf_counter() - start > LIMIT_SEC:
                break
    return got, time.perf_counter() - start


def speed():
    mbit = None
    for size in SIZES:
        got, sec = download(size)
        if sec > 0 and got:
            mbit = got * 8 / sec / 1_000_000
        if sec >= ENOUGH_SEC:
            break
    return mbit


def main():
    out = {"mbit": None}
    try:
        out["mbit"] = speed()
    except OSError:
        pass
    print(json.dumps(out, ensure_ascii=True))


if __name__ == "__main__":
    main()
