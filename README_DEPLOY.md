# Развёртывание сайта «УЧАСТНИКИ» на VPS

## Что добавлено

- всплывающая анкета по кнопкам «Стать участником»;
- серверная проверка данных;
- единая SQLite-база `data/applications.sqlite`;
- защита от массовой отправки и скрытое антиспам-поле;
- экран благодарности после успешной записи;
- CSV-экспорт анкет;
- Docker-конфигурация для VPS;
- надёжные Telegram-уведомления о каждой заявке с очередью и повторными попытками.

## 1. Подготовка

Установите Docker и Docker Compose. Скопируйте папку проекта на VPS, например в `/opt/uchastniki`.

В `docker-compose.yml` обязательно замените:

```yaml
ALLOWED_ORIGIN: https://example.ru
```

на реальный адрес сайта без завершающего `/`.


## 2. Telegram-уведомления

Токен бота хранится только на сервере и не попадает в HTML или клиентский JavaScript.

1. Создайте бота через `@BotFather` и получите токен.
2. Напишите боту любое сообщение. Если уведомления должны приходить в группу, добавьте бота в группу и отправьте там сообщение.
3. Узнайте `chat_id` командой на своём компьютере:

```bash
export TELEGRAM_BOT_TOKEN='ваш_токен'
export TELEGRAM_API='https://api.telegram.org'
curl "${TELEGRAM_API}/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
```

Значение находится в `result[].message.chat.id`. Для группы оно обычно отрицательное.

4. На VPS создайте `.env` рядом с `docker-compose.yml`:

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

Заполните:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:секретный_токен
TELEGRAM_CHAT_ID=-1001234567890
```

Не отправляйте токен в переписке, не добавляйте `.env` в Git и не размещайте его в публичной папке сайта.

Если Telegram временно недоступен, заявка всё равно сохраняется в SQLite. Уведомление остаётся в таблице `telegram_outbox` и отправляется повторно автоматически. Статус настройки можно проверить:

```bash
curl http://127.0.0.1:3000/healthz
```

В ответе должно быть `"telegramConfigured": true`.

## 3. Запуск

```bash
cd /opt/uchastniki
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/healthz
```

Файл базы хранится на VPS в `./data/applications.sqlite`. Папку `data` нельзя публиковать через веб-сервер.

## 4. Nginx

Пример виртуального хоста:

```nginx
server {
    listen 80;
    server_name example.ru www.example.ru;

    client_max_body_size 32k;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

После проверки подключите HTTPS через Certbot. Анкету нельзя запускать без HTTPS.

## 5. Выгрузка заявок в Excel-совместимый CSV


```bash
docker compose exec site node export-membership-applications.mjs /app/data/membership-applications.csv
docker cp uchastniki-site:/app/data/membership-applications.csv ./membership-applications.csv
```

CSV сохраняется в UTF-8 с BOM и разделителем `;`, поэтому корректно открывается в Excel.

## 6. Резервное копирование

Остановите запись на несколько секунд и скопируйте SQLite-файлы:

```bash
docker compose stop site
tar -czf applications-backup-$(date +%F).tar.gz data/
docker compose start site
```

Храните резервные копии отдельно от VPS.

## Безопасность

- не публикуйте папку `data`;
- ограничьте доступ к VPS по SSH-ключам;
- регулярно обновляйте Docker-образы;
- используйте HTTPS;
- не добавляйте в клиентский JavaScript пароли и секреты;
- назначьте срок хранения заявок и удаляйте устаревшие данные согласно политике обработки персональных данных.

## Cloudflare Relay для серверов без доступа к Telegram

Если VPS не подключается к `api.telegram.org`, используйте приватный Worker из файла `cloudflare-telegram-relay.js`. В Cloudflare добавьте три значения типа Secret: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` и `RELAY_SECRET`.

На VPS оставьте только адрес Worker и тот же секрет связи:

```dotenv
TELEGRAM_RELAY_URL=https://your-worker.workers.dev/notify
TELEGRAM_RELAY_SECRET=случайная_строка_из_64_символов
```

После проверки релея удалите с VPS строки `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`: они хранятся только в Cloudflare. Перезапустите службу и проверьте режим:

```bash
systemctl restart uchastniki
curl http://127.0.0.1:3000/healthz
```

Ожидается `"telegramMode":"relay"`. Worker принимает только `POST /notify` с заголовком `Authorization: Bearer ...`; секреты нельзя добавлять в Git или клиентский JavaScript.
