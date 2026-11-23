import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ManagedSettingsService } from '../../src/domain/settings/service.ts';
import { MemorySettingsStore } from '../../src/domain/settings/store.ts';
import { TokenCipher } from '../../src/domain/settings/tokenCipher.ts';
import { InMemoryTaskTrackerClient } from '../../src/domain/taskTracker/index.ts';
import { defaultObservabilityConfig } from '../../src/observability/config.ts';
import { InMemoryMetricsRegistry } from '../../src/observability/metrics.ts';
import { ObservabilityHttpServer } from '../../src/observability/server.ts';
import { InMemoryWorkerStateRegistry } from '../../src/observability/state.ts';

const origin = 'https://gitlab.example';
const repositories = [
  { id: '101', name: 'demo/console', defaultBranch: 'main' },
  { id: '102', name: 'demo/services/api', defaultBranch: 'develop' },
  { id: '103', name: 'demo/services/notifications', defaultBranch: 'main' },
].map((repository) => ({ ...repository, cloneUrl: `${origin}/${repository.name}.git` }));
const staticDir = process.env.TASK_TRACKER_UI_STATIC_DIR ?? fileURLToPath(new URL('../dist/task-tracker-console/browser/', import.meta.url));
await access(join(staticDir, 'index.html'));

const store = new MemorySettingsStore();
const settings = new ManagedSettingsService(
  store,
  new TokenCipher(randomBytes(32).toString('base64')),
  {
    checkConnection: async () => {},
    repositories: async (_origin, _token, page) => ({ repositories: page === 1 ? repositories : [], nextPage: null }),
    project: async (_origin, _token, id) => {
      const repository = repositories.find((entry) => entry.id === id);
      if (!repository) throw new Error('Демонстрационный репозиторий не найден.');
      return repository;
    },
  },
  {
    prepare: async () => {},
    pathFor: (id) => join(tmpdir(), 'developer-console-preview', id),
  },
  [origin],
);

const actor = 'demo-admin';
await settings.addConnection({ origin, name: 'Тестовый GitLab', token: 'demo-token' }, 0, actor);
const { connections } = await store.read();
await settings.saveProject(undefined, {
  name: 'Интерфейс',
  connectionId: connections[0].id,
  gitlabProjectId: repositories[0].id,
  baseBranch: repositories[0].defaultBranch,
  testCommand: 'npm test',
  lintCommand: 'npm run lint',
}, 1, actor);
const { projects: [firstProject] } = await store.read();
await settings.setEnabled(firstProject.id, true, 2, actor);
await settings.applyPending(firstProject.id);

const config = defaultObservabilityConfig();
config.host = '127.0.0.1';
config.port = Number(process.env.E2E_PORT ?? 4347);
config.taskTrackerUi = { ...config.taskTrackerUi, enabled: true, authMode: 'localhost', staticDir };
const server = new ObservabilityHttpServer({
  config,
  settings,
  metrics: new InMemoryMetricsRegistry(),
  state: new InMemoryWorkerStateRegistry(),
  readiness: () => ({ ready: true }),
  repositories: () => [],
  taskTracker: new InMemoryTaskTrackerClient(),
});

await server.start();
console.log(`Managed demo: http://127.0.0.1:${server.address().port}/tasks/settings`);

const applyChanges = async () => {
  const { projects } = await store.read();
  for (const project of projects) {
    if (project.enabled && project.status === 'pending') {
      await store.withProjectLock(project.id, () => settings.applyPending(project.id));
    }
  }
};

setInterval(() => {
  applyChanges().catch((error) => console.error('Не удалось применить тестовые настройки:', error));
}, 1000).unref();
