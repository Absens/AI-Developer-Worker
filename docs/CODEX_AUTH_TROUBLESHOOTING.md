# Ошибки авторизации Codex в Docker

Этот runbook помогает устранить ошибку:

```text
Your access token could not be refreshed because your refresh token was already used.
code: refresh_token_reused
```

## Почему так происходит

OAuth refresh-токены Codex ротируются: использованный токен заменяется новым. Если хостовый Codex и контейнер скопировали одинаковое состояние `auth.json`, одна из сред может попытаться повторно применить уже использованный refresh-токен.

**Правило:** у каждого постоянно работающего Codex-окружения должен быть свой `CODEX_HOME` и собственный вход. Не используйте общий `auth.json` между параллельно работающими средами.

## Исправление для Docker Compose

1. Остановите воркер, **не удаляя тома PostgreSQL**:

```powershell
docker compose down
docker volume ls
```

2. Определите том для `codex-home`. Имя зависит от каталога Compose (например, `developer_codex-home`). Удалять том можно только если вы готовы повторно авторизовать Codex и убедились, что в нём нет нужных данных. Не запускайте `docker compose down -v`: это затронет и базу задач.

3. Предпочтительный вариант — выполнить вход непосредственно в выделенном Docker volume:

```powershell
docker compose build worker
docker compose run --rm --entrypoint codex worker login --device-auth
docker compose run --rm --entrypoint codex worker login status
```

`--entrypoint codex` предотвращает повторное копирование авторизации хоста при входе. Если в томе сохранился конфликтующий `auth.json`, удалите **только соответствующий auth-файл или выделенный том Codex** после остановки воркера и повторите вход.

4. После успешного `login status`:

```powershell
docker compose up --build
```

## Отдельный том при использовании docker run

```powershell
docker volume create codex-home
docker run --rm -it --entrypoint codex -e CODEX_HOME=/codex-home -v "codex-home:/codex-home" ai-developer-worker login --device-auth
docker run --rm --entrypoint codex -e CODEX_HOME=/codex-home -v "codex-home:/codex-home" ai-developer-worker login status
```

Воркер необходимо запускать с **тем же** томом `codex-home`. Не запускайте две конкурирующие сессии Codex с одним томом.

## Что не рекомендуется

Постоянный прямой mount хостового `~/.codex` в контейнер и однократное копирование хостового `auth.json` при продолжающемся использовании Codex на хосте могут вызывать повторное использование refresh-токена.

Для диагностики проверьте `docker ps`, `docker volume ls`, актуальное значение `CODEX_HOME` и отсутствие параллельных воркеров, делящих один auth state.

Альтернативный вариант — авторизация через API-ключ согласно поддерживаемому контракту установленной версии CLI:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

Не публикуйте значение ключа в логах, документации и MR. Подробнее о запуске — [Docker](LOCAL_DOCKER_RUN.md).

