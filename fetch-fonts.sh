#!/usr/bin/env bash
# Скачивает Space Grotesk с Google Fonts и раскладывает локально в ./fonts.
# Запускать один раз на машине с доступом в интернет (например, на вашем Mac),
# затем закоммитить папку fonts/ в репозиторий.
#
# Использование:  bash fetch-fonts.sh

set -euo pipefail

UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
CSS_URL='https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&display=swap'

ROOT="$(cd "$(dirname "$0")" && pwd)"
FONT_DIR="$ROOT/fonts"
mkdir -p "$FONT_DIR"

echo "==> Запрашиваю CSS у Google Fonts"
# Современный User-Agent обязателен: иначе Google вернёт устаревший ttf/woff вместо woff2
curl -sSfL -A "$UA" "$CSS_URL" -o "$FONT_DIR/_google.css"

echo "==> Скачиваю woff2 и генерирую fonts/space-grotesk.css"
python3 - "$FONT_DIR" <<'PY'
import re, subprocess, sys, pathlib

font_dir = pathlib.Path(sys.argv[1])
css = (font_dir / '_google.css').read_text(encoding='utf-8')

# Google отдаёт блоки вида:  /* latin */  @font-face { ... }
blocks = re.findall(r'/\*\s*([a-z0-9-]+)\s*\*/\s*(@font-face\s*\{.*?\})', css, re.S)
if not blocks:
    sys.exit('Не удалось разобрать CSS от Google. Проверьте fonts/_google.css вручную.')

out = []
for subset, block in blocks:
    m = re.search(r'url\((https://[^)]+\.woff2)\)', block)
    if not m:
        print(f'  ! пропускаю {subset}: нет woff2')
        continue
    filename = f'space-grotesk-{subset}.woff2'
    subprocess.run(['curl', '-sSfL', m.group(1), '-o', str(font_dir / filename)], check=True)
    print(f'  + {filename}')
    out.append(f'/* {subset} */\n' + block.replace(m.group(1), f'/fonts/{filename}'))

(font_dir / 'space-grotesk.css').write_text('\n\n'.join(out) + '\n', encoding='utf-8')
print(f'  = fonts/space-grotesk.css ({len(out)} подмножеств)')
PY

rm -f "$FONT_DIR/_google.css"

echo
echo "==> Готово. Содержимое fonts/:"
ls -lh "$FONT_DIR"
echo
if [ ! -f "$FONT_DIR/space-grotesk-latin.woff2" ]; then
  echo "ВНИМАНИЕ: space-grotesk-latin.woff2 не создан — проверьте вывод выше,"
  echo "иначе <link rel=preload> в HTML будет ссылаться на несуществующий файл."
fi
