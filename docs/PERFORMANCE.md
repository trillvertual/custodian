# Измерение производительности

13 октября 2026 года выполнены две ограниченные пары лабораторных запусков [Lighthouse 13.5.0](https://github.com/GoogleChrome/lighthouse): baseline и confirmation после исправлений, по одному mobile и desktop запуску на этапе. Использована собранная страница входа кандидата v0.2.0 с изолированным API и синтетическими данными. Замеры не повторялись для выбора лучших scores.

## Результаты baseline

| Профиль | Performance | Accessibility | Best practices |     LCP |    TBT |      CLS |
| ------- | ----------: | ------------: | -------------: | ------: | -----: | -------: |
| Mobile  |          56 |           100 |             92 | 11,17 с | 163 мс | 0,000076 |
| Desktop |          86 |           100 |             92 |  1,98 с |   0 мс | 0,000013 |

First Contentful Paint: 7,26 с mobile и 1,32 с desktop. Baseline отчёты не содержат runtime error или предупреждений о недостоверном запуске.

## Confirmation после исправлений

| Профиль | Performance | Accessibility | Best practices |    LCP |      TBT |      CLS |
| ------- | ----------: | ------------: | -------------: | -----: | -------: | -------: |
| Mobile  |          75 |           100 |             96 | 3,51 с | 422,5 мс |        0 |
| Desktop |         100 |           100 |             96 | 0,73 с |     0 мс | 0,000013 |

First Contentful Paint: 2,82 с mobile и 0,64 с desktop. В обоих профилях фактически передано 374 734 байта вместо 1 959 754 байт baseline, примерно на 80,9% меньше.

Мобильный confirmation выдал предупреждение Lighthouse о более медленном CPU, чем ожидает профиль. Host benchmark index составил 945,5 против 2652 в baseline; desktop - 2213 против 2666,5. Поэтому scores и TBT не являются сравнением при одинаковой производительности CPU. Рост mobile TBT нельзя уверенно приписать изменению приложения по этим двум единичным запускам. Desktop confirmation предупреждений не содержит. Runtime error нет в обоих финальных отчётах.

## Условия и область проверки

Использован Chrome for Testing 153.0.8010.12 в headless режиме. Mobile: viewport 412×823, DPR 1,75, simulated network RTT 150 мс, throughput 1638,4 Кбит/с, CPU multiplier 4. Desktop preset: viewport 1350×940, DPR 1, RTT 40 мс, throughput 10240 Кбит/с, CPU multiplier 1. [Lighthouse эмулирует устройство и рассчитывает показатели для выбранного профиля](https://github.com/GoogleChrome/lighthouse/blob/main/docs/emulation.md); это не измерения на физическом телефоне.

Проверена только навигация на страницу входа через localhost с пустой сессией. Не измерялись вход по паролю, Passkey, разблокировка, работа со списком записей или сетевые условия реальной установки. Парольный вход выполняет Argon2id с 64 МиБ памяти и тремя проходами; его стоимость не входит в эти navigation results. Настройки HTTPS reverse proxy также не участвовали в измерении.

## Изменения и оставшиеся ограничения

- В baseline статические файлы передавались без сжатия. Основной JavaScript передал 1 165 257 байт; Lighthouse оценил неиспользованный на странице входа JavaScript в 472 КиБ. На других экранах этот код может использоваться.
- После исправлений JavaScript передал 313 910 байт, CSS - 12 973 байта, включая HTTP headers. HEAD проверки подтвердили `Content-Encoding: br` и `gzip`, `Vary: accept-encoding` и правильные MIME types. Тела JS занимают 312 823 байта в Brotli, 381 672 байта в gzip и 1 165 379 байт без сжатия; CSS - 11 902, 13 451 и 67 547 байт соответственно. HTML `/` остаётся небольшим несжатым ответом на 741 байт.
- PNG favicon добавлял 678 205 байт, несмотря на наличие компактного SVG. В confirmation PNG не запрашивается. Исходный PNG сохранён как бренд-ассет и Apple touch icon; обычная страница использует SVG favicon.
- Layout shifts были малы во всех четырёх запусках. Mobile confirmation всё ещё показывает LCP 3,51 с и TBT 422,5 мс с указанной выше границей измерения CPU. Базовый объём исполняемого JS остаётся около 1,2 МБ; сжатие уменьшает передачу, но не отменяет его загрузку и обработку браузером.
- Best practices учитывает ожидаемый HTTP 401 от `/api/auth/session` у пользователя без сессии. Это штатный ответ API, обработанный интерфейсом, а не необработанная ошибка JavaScript.
- В baseline Chrome сообщал о блокировании Zod JIT capability probe директивой `script-src`: библиотека пробовала `Function('')`, ловила исключение и использовала fallback. После явного отключения Zod JIT оба confirmation отчёта показывают пустой список DevTools Issues. Политика CSP сохранена без разрешения `unsafe-eval`.
- В baseline найдено несовпадение доступного имени кнопки RWP с видимым текстом `RWP Shop -10%`. После исправления audit `label-content-name-mismatch` проходит в обоих профилях. В baseline он не уменьшал Accessibility score, поэтому значение 100 не заменяет проверку отдельных находок и остальных экранов.

Четыре сырых отчёта и отдельная проверка encoding сохранены локально в `.impeccable/review`, исключённом из Git. Заявленные показатели относятся к этой странице входа и описанным профилям, а не ко всему приложению или реальным устройствам.

## Воспроизведение

Соберите приложение и запустите изолированный сервер в отдельном терминале. Команда использует тестовую базу и синтетические записи, не production `.env`.

```bash
npm ci
npm run build
APP_URL=http://127.0.0.1:3112 PORT=3112 npx tsx tests/dev-server.ts
```

В другом терминале:

```bash
mkdir -p .impeccable/review
npm exec --yes --package=lighthouse@13.5.0 -- lighthouse http://127.0.0.1:3112/ --only-categories=performance,accessibility,best-practices --chrome-flags="--headless --no-sandbox --disable-dev-shm-usage" --no-enable-error-reporting --output=json --output-path=.impeccable/review/lighthouse-auth-mobile-final.json
npm exec --yes --package=lighthouse@13.5.0 -- lighthouse http://127.0.0.1:3112/ --preset=desktop --only-categories=performance,accessibility,best-practices --chrome-flags="--headless --no-sandbox --disable-dev-shm-usage" --no-enable-error-reporting --output=json --output-path=.impeccable/review/lighthouse-auth-desktop-final.json
```

Установленный Chrome определяется автоматически; при необходимости задайте `CHROME_PATH` к своему исполняемому файлу. Не запускайте замеры одновременно с криптографическими тестами или другой нагрузкой CPU. Сырые JSON остаются в исключённом из Git каталоге `.impeccable/review`. Повторный запуск на текущем коде оценивает текущую сборку, а не исторический baseline из таблицы.
