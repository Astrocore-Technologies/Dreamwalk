# Project-scoped development storage

Use the optional scoped launcher from the checkout:

```sh
npm run local -- --show-paths
npm run local -- npm run typecheck
npm run local -- npm run build
npm run local -- npm run test:game:integration
npm run dev:local
```

The launcher directs process temporary files, npm and Playwright caches, and test
artifacts into ignored `.local/workflow` directories beneath this checkout.
`DREAMWALK_DEV_STORAGE_ROOT` can select a different absolute storage directory.
The settings are inherited only by the launched process and its children; they do
not change system-wide settings or migrate existing databases, authentication,
configuration, uploaded assets, or another checkout's data.

Keep generated files and local configuration out of Git. Preserve existing local
data when updating the source, and inspect `--show-paths` before cleanup.
