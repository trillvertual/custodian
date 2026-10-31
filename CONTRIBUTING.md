# Работа над Custodian

Изменения предлагайте через отдельную ветку и PR с описанием проблемы, результата и проверки. Ответственный за review указан в `.github/CODEOWNERS`. Для merge требуются review и зелёный CI.

## Подготовка

Используйте Node из `.node-version` и `npm ci`. Lockfile коммитится, зависимости не обновляются попутно с исправлениями. Для локального интерфейса с вымышленными данными: `npm run preview:demo`.

```bash
npm run release:check
npm run format:check
npm run secrets:check
npm run typecheck
npm test
npm run build
npx playwright install --with-deps chromium
npx playwright test
```

Docker/PostgreSQL проверяется CI в отдельной временной базе. Не запускайте destructive cleanup на production. Не добавляйте реальные секреты в тесты, скриншоты, логи и git.

## Review

Для UI проверяйте desktop/mobile, темы, клавиатуру, загрузку, ошибки и reduced motion. Сохраняйте дизайн и происхождение компонентов из `docs/FRONTEND-SOURCE.md`.

Изменения криптографии, форматов ключей, входа, rescue и миграций требуют отдельного review совместимости и содержательных тестов на старые данные и отказы. Уже опубликованные миграции и cryptographic contexts не переписывайте. Старые rescue-ключи могут быть нужны для старых backup.

Dependabot создаёт PR раз в неделю. Шаги `github/codeql-action/init` и `analyze` объединены в одну группу: обе ссылки должны указывать на один SHA версии CodeQL. Автоматического merge нет; обновления libsodium, Argon2, WebAuthn и major-версий проверяются вручную.

## Транзитивные зависимости

В root `package.json` временно задан scoped override `@fastify/static → glob ^14.0.2`. Поддерживаемая ветка `@fastify/static` пока требует `glob ^13`, а [исправление отмены обхода файлов](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) опубликовано начиная с 14.0.2. Новая ветка также использует исправленный [minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249). Не применяйте предложенный `npm audit fix --force` откат static до 6.x – он несовместим с Fastify 5.

Override касается только этой зависимости; Node 22 и CommonJS API поддерживаются. При обновлении проверяйте выдачу вложенных файлов, предварительно сжатых ресурсов и обход каталога с `wildcard: false`. Удалите override, когда `@fastify/static` сам перейдёт на исправленную совместимую ветку; повторите `npm ci`, `npm audit` и проверки контейнера.

## Выпуск

1. Обновите версию root и всех четырёх workspace-пакетов, затем `npm install --package-lock-only --ignore-scripts`. UI получает версию из root manifest.
2. Добавьте запись в `CHANGELOG.md` и `docs/releases/vX.Y.Z.md`. Укажите миграции, несовместимость и действия для оператора. Обновите default image в `compose.yaml`.
3. Проверьте diff, закоммитьте и отправьте `main`; дождитесь зелёного CI для этого commit.
4. Создайте annotated tag `git tag -a vX.Y.Z -m "Custodian vX.Y.Z"` и отправьте `git push origin vX.Y.Z`.
5. Release workflow заново проверит этот commit, опубликует публичный образ, загрузит архивы/checksums и опубликует release. Проверьте Actions, assets, digest и установку.

Workflow не развёртывает production автоматически. Теги не force-push; существующий release не перезаписывается. Если публикация прервалась, выясните этап и существующие draft/assets перед повтором; не создавайте другой build под уже использованной версией.
