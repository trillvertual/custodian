# Скриншоты Custodian

PNG 2560×1440, desktop viewport 1600×900 с масштабом 1.6×. Скриншоты сняты непосредственно в Chromium, без изменения размера и ретуши. Используются изолированная база в памяти и синтетические данные из `tests/dev-server.ts`. Пароли, токены и TOTP-коды скрыты.

| Файл                                 | Экран                            |
| ------------------------------------ | -------------------------------- |
| [vault-light.png](vault-light.png)   | Все записи, светлая тема         |
| [vault-dark.png](vault-dark.png)     | Все записи, тёмная тема          |
| [record-light.png](record-light.png) | Карточка записи, скрытые секреты |
| [search-dark.png](search-dark.png)   | Быстрый поиск                    |

Для повторной съёмки:

```bash
npm ci
npx playwright install --with-deps chromium
npm run screenshots
```

Команда собирает frontend, запускает временный демонстрационный сервер на `127.0.0.1:3110`, сохраняет четыре PNG и завершает сервер. `CUSTODIAN_SCREENSHOT_PORT` задаёт другой порт, `CUSTODIAN_CHROMIUM_EXECUTABLE` позволяет использовать установленный Chromium.
