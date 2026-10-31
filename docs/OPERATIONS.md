# Установка, backup и обновление

Одна установка Custodian обслуживает один VPN-сервис. Поддерживаемый образ релиза - linux/amd64; база PostgreSQL 18. Требуются HTTPS reverse proxy, Docker Engine с Compose v2 и Node.js из `.node-version` для первоначальной настройки.

## Первый запуск

Скачайте файлы релиза через GitHub или `gh`:

```bash
gh release download v0.5.1 --repo trillvertual/custodian --dir custodian-download
cd custodian-download
sha256sum --check SHA256SUMS
tar -xzf custodian-0.5.1-source.tar.gz
cd custodian-0.5.1
npm ci
npm run configure -- --url https://vault.example.com
```

Готовый образ доступен без входа в GHCR:

```bash
docker compose pull app db
docker compose up -d --no-build --wait --wait-timeout 180
```

Для сборки из исходников вместо загрузки образа выполните `docker compose up -d --build --wait --wait-timeout 180`.

Настройте reverse proxy на `127.0.0.1:8080`, откройте HTTPS домен, создайте владельца с setup-кодом из `.env` и сохраните rescue-ключ вне VPS. `APP_URL` должен быть точным HTTPS origin; изменение домена влияет на Passkey. База не публикует порт, app не публикуется напрямую в интернет.

Проверка запуска:

```bash
docker compose ps
curl --fail http://127.0.0.1:8080/api/health
docker compose exec -T app node packages/rescue/dist/index.js --help
```

## Резервная копия

Полный PostgreSQL dump содержит пользователей, wrapped keys, записи, историю, аудит и сессии. JSON-выгрузка из UI/rescue нужна для восстановления содержимого, но не заменяет полный backup установки. Rescue-ключ нужен для расшифровки и должен соответствовать epoch этой копии. Храните старые ключи для старых backup.

```bash
umask 077
mkdir -p backups
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T db pg_dump -U vault -d vault -Fc > "backups/vault-$backup_stamp.dump"
cp .env "backups/env-$backup_stamp"
cp compose.yaml "backups/compose-$backup_stamp.yaml"
docker inspect "$(docker compose ps -q app)" --format '{{.Image}}' > "backups/image-$backup_stamp.txt"
```

Проверьте exit code `pg_dump` и ненулевой размер файла. Сохраняйте backup с ограниченным доступом вне VPS и отдельно от rescue-ключа; конфигурация содержит пароль БД. Это point-in-time копия одной БД, без PITR и автоматического внешнего хранения. Периодически проверяйте восстановление в отдельной изолированной установке.

## Обновление

1. Прочитайте changelog/release notes выбранной версии. Сначала проверьте её на копии БД с отдельным доменом и без production-трафика.
2. Сохраните полный backup и конфигурацию предыдущей версии. Для точного rollback остановите app перед окончательным backup, чтобы после снимка не появились новые записи.
3. Скачайте новую версию, проверьте SHA-256. Перенесите только существующий `.env`, сохранив параметры БД, origin и Compose project name. Меняющийся каталог без фиксированного project name создаст другой Docker volume; предпочтительно обновлять в том же каталоге установки.
4. Укажите в `.env` `CUSTODIAN_IMAGE=ghcr.io/trillvertual/custodian-app:vX.Y.Z` или проверенный `ghcr.io/trillvertual/custodian-app@sha256:...` из `release.json`.
5. Выполните команды ниже. Startup применяет forward migrations автоматически. Не запускайте старую версию параллельно с новой на одной БД.

```bash
docker compose pull app
docker compose stop app
# Сделайте окончательный backup командами выше, пока app остановлен.
docker compose up -d --no-build --wait --wait-timeout 180
docker compose ps
curl --fail http://127.0.0.1:8080/api/health
```

После обновления проверьте вход, открытие записи, создание/редактирование и backup. Если healthcheck или миграция не прошли, оставьте app остановленным до выяснения причины. Production не обновляется автоматически при публикации GitHub Release. Обновление major-версии PostgreSQL выполняется отдельно; простой заменой тега образа оно не делается.

## Откат

После миграций просто запустить старый образ недостаточно. Для rollback нужны предыдущие image/config и **backup до обновления**. Восстановление заменяет текущие данные снимком; записи, добавленные после него, будут потеряны. Сохраните отдельный текущий dump перед восстановлением, если это возможно.

На той же базе и с тем же Compose project name:

```bash
docker compose stop app
docker compose exec -T db pg_restore -U vault -d vault --clean --if-exists --no-owner < backups/CHOSEN_PRE_UPDATE.dump
# Верните предыдущие .env/compose.yaml и точный образ.
docker compose up -d --no-build --wait --wait-timeout 180
curl --fail http://127.0.0.1:8080/api/health
```

Проверьте exit code восстановления и пользовательский доступ. `docker compose down --volumes` удаляет базу; на production эту команду не используйте. Rescue CLI и восстановление owner описаны в [README](../README.md#rescue-cli).

## Сопровождение

CI проверяет код и image на каждый PR/push, release workflow повторяет проверки перед публикацией. Actions закреплены полными commit SHA и обновляются через Dependabot; permissions минимальны. Проверки секретов и CodeQL выполняются в GitHub Actions. Изменения проходят review и CI перед merge.

SHA-256 выявляет повреждение assets, но не заменяет доверие к владельцу репозитория и pipeline. Образ содержит OCI source/revision/version, SBOM и BuildKit provenance. Release archive с исходниками строится через `git archive` commit тега; runtime и image строятся из того же checkout. Документировано происхождение сторонних исходников, авторский код Custodian доступен под MIT.

## Доверенные браузеры (v0.5.0)

Миграция 4 добавляет привязку Passkey к сессии, одноразовое право раскрытия оболочки и таблицу `trusted_devices`. Локальные ключи браузеров в резервную копию сервера не входят. После очистки профиля потребуется пароль и повторная настройка доверия; парольный вход автоматически не отключается. Отозвать конкретную запись доверенного браузера можно в настройках аккаунта. При откате на 0.4.0 новые таблицы сохраняются, но старый клиент не использует этот способ разблокировки.
