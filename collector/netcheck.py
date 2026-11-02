# Замер для квадрата на пульте: страна выхода в интернет и скорость загрузки, печатает JSON.
# Страну даёт Cloudflare: при VPN это страна выхода, та, что видят сайты. Скорость: загрузка пробного
# файла, сначала маленького, большой только на быстрой линии, чтобы не тратить трафик зря
import json
import time
import urllib.request

TRACE = "https://www.cloudflare.com/cdn-cgi/trace"
DOWN = "https://speed.cloudflare.com/__down?bytes={}"
SIZES = (2_000_000, 10_000_000)
ENOUGH_SEC = 1.0  # столько должна длиться загрузка, чтобы замеру можно было верить
LIMIT_SEC = 6
CHUNK = 65536
HEADERS = {"User-Agent": "session-pult"}

COUNTRIES = {
    "AE": "ОАЭ", "AL": "Албания", "AM": "Армения", "AT": "Австрия", "AU": "Австралия", "AZ": "Азербайджан",
    "BE": "Бельгия", "BG": "Болгария", "BR": "Бразилия", "BY": "Беларусь", "CA": "Канада", "CH": "Швейцария",
    "CN": "Китай", "CY": "Кипр", "CZ": "Чехия", "DE": "Германия", "DK": "Дания", "EE": "Эстония", "EG": "Египет",
    "ES": "Испания", "FI": "Финляндия", "FR": "Франция", "GB": "Британия", "GE": "Грузия", "GR": "Греция",
    "HK": "Гонконг", "HR": "Хорватия", "HU": "Венгрия", "ID": "Индонезия", "IE": "Ирландия", "IL": "Израиль",
    "IN": "Индия", "IS": "Исландия", "IT": "Италия", "JP": "Япония", "KG": "Киргизия", "KR": "Корея", "KZ": "Казахстан",
    "LT": "Литва", "LU": "Люксембург", "LV": "Латвия", "MD": "Молдова", "ME": "Черногория", "MT": "Мальта", "MX": "Мексика",
    "MY": "Малайзия", "NL": "Нидерланды", "NO": "Норвегия", "PL": "Польша", "PT": "Португалия", "RO": "Румыния", "RS": "Сербия",
    "RU": "Россия", "SA": "Саудовская Аравия", "SE": "Швеция", "SG": "Сингапур", "SI": "Словения", "SK": "Словакия",
    "TH": "Таиланд", "TR": "Турция", "TW": "Тайвань", "UA": "Украина", "US": "США", "UZ": "Узбекистан", "VN": "Вьетнам",
    "ZA": "ЮАР",
}


def country():
    req = urllib.request.Request(TRACE, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=8) as res:
        text = res.read().decode("ascii", "replace")
    code = dict(line.split("=", 1) for line in text.splitlines() if "=" in line).get("loc", "")
    return code, COUNTRIES.get(code, code or "неизвестно")


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
    out = {"code": "", "country": None, "mbit": None}
    try:
        out["code"], out["country"] = country()
    except OSError:
        pass
    try:
        out["mbit"] = speed()
    except OSError:
        pass
    print(json.dumps(out, ensure_ascii=True))


if __name__ == "__main__":
    main()
