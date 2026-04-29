# Task Tracker Console

Angular/PrimeNG frontend foundation for the internal human task tracker console.

## Local Development

Run the Node.js observability server on `127.0.0.1:9464`, then start Angular:

```bash
npm run web:dev
```

The dev server is available at `http://127.0.0.1:4200/tasks` and proxies `/api`
to the Node.js server through `proxy.conf.json`.

## Build And Check

```bash
npm run web:typecheck
npm run web:test
npm run web:build
```

The production bundle is written to `web/dist/task-tracker-console/browser`.
Set `TASK_TRACKER_UI_STATIC_DIR=web/dist/task-tracker-console/browser` for the
Node.js server to serve it under `/tasks`.
