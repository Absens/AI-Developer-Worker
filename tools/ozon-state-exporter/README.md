# Ozon Anonymous State Exporter

Unpacked Chrome extension that exports only bounded `*.ozon.ru` cookies and
`https://www.ozon.ru` local storage. It makes no network requests and rejects
state names that look authenticated.

1. Open `chrome://extensions`, enable Developer mode and choose **Load unpacked**.
2. Select this directory.
3. In the normal Chrome profile, sign out of Ozon and open a canonical product card.
4. Open the extension and export the anonymous candidate JSON.
5. Set `OZON_STATE_CANDIDATE_FILE`, `OZON_STORAGE_STATE_HOST_DIR` and
   `OZON_BOOTSTRAP_CANARY_URL` to absolute paths/canonical URL, then run the
   repository's `npm run ozon:import-state` command.

Do not send the candidate file to another person or commit it. The importer
revalidates every field and does not activate it unless the real card canary passes.
