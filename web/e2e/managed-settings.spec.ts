import { test, expect } from '@playwright/test';
import type { CreateTaskRequestDto, TaskSummaryDto } from '../src/app/models/human-api.dto';
import type { ProjectCatalogEntry, ProjectDefinitionDto, SettingsViewDto } from '../src/app/models/settings.dto';
const session = { user: { id: 'admin', service: 'human' }, role: 'admin', authMode: 'trusted_proxy', apiPath: '/api', uiPath: '/tasks', generatedAt: '2026-11-11T00:00:00Z', capabilities: { canManageSettings: true, managedProjects: true, canReadTasks: true, canCreateTask: true } };
const catalog = [
  { id: 'p1', name: 'Сервис', repositoryPath: 'platform/billing', baseBranch: 'main' },
  { id: 'p2', name: 'Сервис', repositoryPath: 'platform/shipment', baseBranch: 'release' },
].map((item): ProjectCatalogEntry => ({
  ...item, gitlabHost: 'gitlab.test', repositoryName: item.id, repoPathKey: item.id, queue: 'MANAGED', tags: ['ai_dev'],
}));

test('empty setup → applied repository → create from project settings → pause', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().setExtraHTTPHeaders({ 'x-task-tracker-role': 'developer' });
  let state: SettingsViewDto = { revision: 0, connections: [], projects: [], workers: [], allowedOrigins: ['https://gitlab.test'] };
  let queueTasks: TaskSummaryDto[] = [];
  await page.route('**/api/session', route => route.fulfill({
    json: { ...session, capabilities: { ...session.capabilities, canUpdateTask: true, canReadRepositoryDirectory: true } },
  }));
  await page.route('**/api/repository-directory', route => route.fulfill({
    json: { repositories: state.projects.map((item) => ({
      id: item.id, name: item.desired.name, repositoryPath: 'team/demo', gitlabHost: 'gitlab.test',
    })) },
  }));
  await page.route('**/api/project-catalog', route => route.fulfill({
    json: {
      managed: true,
      projects: state.projects.flatMap((item) =>
        item.enabled && item.active ? [{
          ...catalog[0], id: item.id, repositoryName: item.id, repoPathKey: item.id,
          name: item.desired.name, repositoryPath: 'team/demo', baseBranch: item.active.definition.baseBranch,
        }] : [],
      ),
    },
  }));
  await page.route('**/api/tasks**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== '/api/tasks') return route.continue();
    if (request.method() === 'GET' && queueTasks.length) {
      const search = url.searchParams.get('search');
      const tasks = search === 'team/demo'
        ? queueTasks.filter(({ repositoryName }) => repositoryName === state.projects[0].id)
        : queueTasks;
      const start = url.searchParams.get('cursor') === 'fixture-next' ? 100 : 0;
      return route.fulfill({
        json: {
          tasks: tasks.slice(start, start + 100), role: 'admin',
          nextCursor: tasks.length > start + 100 ? 'fixture-next' : undefined,
        },
      });
    }
    if (request.method() !== 'POST') return route.continue();
    const payload = request.postDataJSON() as CreateTaskRequestDto;
    const project = state.projects[0];
    expect(payload.repositoryName).toBe(project.id);
    expect(payload).not.toHaveProperty('repoPathKey');
    expect(payload).not.toHaveProperty('baseBranch');
    expect(payload).not.toHaveProperty('queue');
    return route.continue({
      postData: { ...payload, repoPathKey: project.id, baseBranch: project.active?.definition.baseBranch, queue: 'MANAGED' },
    });
  });
  await page.route('**/api/settings**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/repositories')) return route.fulfill({ json: { repositories: [{ id: '42', name: 'team/demo', cloneUrl: 'https://gitlab.test/team/demo.git', defaultBranch: 'main' }], nextPage: null } });
    if (request.method() !== 'GET') {
      const body = request.postDataJSON();
      if (body.expectedRevision !== state.revision) return route.fulfill({ status: 409, json: { error: 'Версия изменилась' } });
      state.revision++;
      if (url.pathname.endsWith('/connections')) {
        expect(body.token).toBe('fixture-token');
        state.connections.push({ id: 'c1', name: body.name, origin: body.origin, revision: 1, credentialConfigured: true });
      } else if (url.pathname.endsWith('/projects')) {
        state.projects.push({ id: 'project-1', revision: 1, desired: body.definition, enabled: false, status: 'draft' });
      } else if (url.pathname.endsWith('/state')) {
        state.projects[0].enabled = body.enabled; state.projects[0].status = body.enabled ? 'pending' : 'paused';
      }
    }
    return route.fulfill({ json: state });
  });
  await page.goto('/tasks/settings');
  await expect(page.getByTestId('setup-empty')).toBeVisible();
  await page.locator('[name=connectionName]').fill('Our GitLab');
  await page.locator('[name=connectionToken]').fill('fixture-token');
  await page.getByTestId('connect-gitlab').click();
  await expect(page.getByTestId('connection-card')).toContainText('Our GitLab');
  await expect(page.locator('[name=connectionToken]')).toHaveValue('');
  await page.getByTestId('add-project').click();
  await expect(page.locator('#settings-editor-heading')).toBeFocused();
  await page.locator('[name=projectConnection]').selectOption('c1');
  await page.locator('[name=projectRepository]').selectOption('42');
  await expect(page.locator('[name=projectName]')).toHaveValue('team/demo');
  await page.locator('[name=projectName]').fill('Демо');
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('project-card')).toContainText('Не включён');
  const createForProject = page.getByTestId('create-for-project');
  await expect(createForProject).toHaveCount(0);
  await page.getByTestId('enable-project').click();
  await expect(page.getByTestId('project-card')).toContainText('Ожидает применения');
  await expect(createForProject).toHaveCount(0);
  state.projects[0].active = { revision: 1, definition: state.projects[0].desired, cloneUrl: 'https://gitlab.test/team/demo.git' };
  state.projects[0].status = 'ready'; state.revision++;
  await page.getByRole('button', { name: 'Обновить состояние' }).click();
  await expect(page.getByTestId('project-card')).toContainText('Применено');
  state.projects[0].desired = { ...state.projects[0].desired, baseBranch: 'release' };
  state.projects[0].revision = 2;
  state.projects[0].status = 'pending';
  state.revision++;
  await page.getByRole('button', { name: 'Обновить состояние' }).click();
  await expect(page.getByTestId('settings-saved-branch')).toHaveText('release');
  await expect(page.getByTestId('settings-active-branch')).toHaveText('main');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-settings.png'), fullPage: true, animations: 'disabled' });
  await createForProject.click();
  await expect(page).toHaveURL(/\/tasks\/new\?project=project-1/);
  await expect(page.getByTestId('managed-project-select')).toContainText('Демо');
  await expect(page.getByText('gitlab.test/team/demo', { exact: true })).toBeVisible();
  await expect(page.getByText('Базовая ветка main', { exact: true })).toBeVisible();
  await page.getByTestId('create-title').fill('Task for the managed repository');
  await page.getByTestId('create-description').fill('The selected project routes the task.');
  await page.getByTestId('create-draft').click();
  await expect(page.getByTestId('task-detail')).toContainText('Task for the managed repository');
  await expect(page.getByTestId('task-detail')).toContainText('MANAGED');
  const taskId = new URL(page.url()).pathname.split('/').at(-1);
  const taskDetail = await (await page.request.get(`/api/tasks/${taskId}`)).json();
  queueTasks = [
    ...Array.from({ length: 102 }, (_, index): TaskSummaryDto => ({
      id: `newer-${index}`, title: `Other work ${index}`, repositoryName: 'other-project',
      status: 'ready', updatedAt: '2099-01-01T00:00:00.000Z',
    })),
    taskDetail.summary,
  ];
  await page.getByTestId('task-back-to-queue').click();
  const found = page.getByTestId(`task-row-${taskId}`);
  await expect(page.getByTestId('queue-more-tasks')).toBeVisible();
  await expect(found).toHaveCount(0);
  await page.getByTestId('queue-more-tasks').click();
  await expect(found).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('queue-more-tasks')).toBeVisible();
  await expect(found).toHaveCount(0);
  await page.getByTestId('queue-search').fill('team/demo');
  await expect(found).toContainText('gitlab.test/team/demo');
  await found.click();
  await page.getByTestId('edit-task-draft').click();
  await page.getByTestId('draft-criteria').fill('Критерий для выбранного репозитория.');
  await page.getByTestId('draft-save').click();
  await expect(page.getByTestId('task-detail')).toContainText('Критерий для выбранного репозитория.');
  await page.getByTestId('command-mark-ready').click();
  await page.getByTestId('command-confirm').click();
  await expect(page.getByTestId('task-detail')).toContainText('Готова');
  await expect(page.getByTestId('edit-task-draft')).toHaveCount(0);

  await page.goto('/tasks/settings');
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect(page.getByTestId('project-card')).toContainText('На паузе');
  await expect(createForProject).toHaveCount(0);
  await page.goto('/tasks/new?project=project-1');
  await expect(page.getByText('Репозиторий из ссылки недоступен.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('create-ready')).toBeDisabled();
});
test('round-trips optional project checks and clears dependent settings', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const definition: ProjectDefinitionDto = {
    name: 'Demo',
    connectionId: 'c1',
    gitlabProjectId: '42',
    baseBranch: 'main',
    testCommand: 'npm test',
    lintCommand: 'npm run lint',
    timeoutSeconds: 1800,
    maxFixAttempts: 2,
  };
  const state: SettingsViewDto = {
    revision: 3,
    connections: [{ id: 'c1', name: 'GitLab', origin: 'https://gitlab.test', revision: 1, credentialConfigured: true }],
    projects: [{
      id: 'project-1', revision: 1, desired: definition, enabled: true, status: 'ready',
      active: { revision: 1, definition, cloneUrl: 'https://gitlab.test/team/demo.git' },
    }],
    workers: [],
    allowedOrigins: ['https://gitlab.test'],
  };
  const updates: { definition: ProjectDefinitionDto; expectedRevision: number }[] = [];
  await page.route('**/api/session', route => route.fulfill({ json: session }));
  await page.route('**/api/settings**', route => {
    const request = route.request();
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings/projects/project-1') {
      const update = request.postDataJSON() as (typeof updates)[number];
      updates.push(update);
      expect(update.expectedRevision).toBe(state.revision);
      state.revision++;
      const project = state.projects[0];
      project.desired = update.definition;
      project.revision++;
      project.status = 'pending';
    }
    return route.fulfill({ json: state });
  });

  await page.goto('/tasks/settings');
  const openEditor = page.getByRole('button', { name: 'Изменить', exact: true });
  const editor = page.getByTestId('project-editor');
  const checks = page.getByTestId('project-optional-checks').locator('summary');
  const runner = page.getByTestId('project-runner-settings').locator('summary');
  const field = (name: string) => editor.locator(`[name="${name}"]`);
  const save = page.getByTestId('save-project');

  await openEditor.click();
  await expect(field('testCommand')).toBeVisible();
  await expect(field('lintCommand')).toBeVisible();
  await checks.click();
  await runner.click();
  await field('securityScanCommand').fill('npm run security-check');
  await field('sastCommand').fill('npm run static-check');
  await field('visualRegressionCommand').fill('npm run visual-check');
  await field('coverageCommand').fill('npm run coverage');
  await field('coverageReportFile').fill('coverage/coverage-summary.json');
  await field('minCoveragePercent').fill('100.1');
  await field('maxReviewFixAttempts').fill('0');
  await checks.click();
  await save.click();
  await expect(field('minCoveragePercent')).toBeFocused();
  expect(updates).toHaveLength(0);

  await field('minCoveragePercent').fill('92.5');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-project-config.png'), fullPage: true, animations: 'disabled' });
  await save.click();
  await expect(editor).toHaveCount(0);
  expect(updates[0]).toMatchObject({
    expectedRevision: 3,
    definition: {
      ...definition,
      securityScanCommand: 'npm run security-check',
      sastCommand: 'npm run static-check',
      visualRegressionCommand: 'npm run visual-check',
      coverageCommand: 'npm run coverage',
      coverageReportFile: 'coverage/coverage-summary.json',
      minCoveragePercent: 92.5,
      maxReviewFixAttempts: 0,
    },
  });
  await expect(page.getByTestId('project-card')).toContainText('До применения сохранённых настроек новые запуски используют версию v1.');

  await openEditor.click();
  await checks.click();
  await runner.click();
  await expect(field('coverageReportFile')).toHaveValue('coverage/coverage-summary.json');
  await expect(field('minCoveragePercent')).toHaveValue('92.5');
  await expect(field('maxReviewFixAttempts')).toHaveValue('0');
  await field('coverageCommand').fill('');
  await expect(field('minCoveragePercent')).toHaveCount(0);
  await field('maxReviewFixAttempts').fill('');
  await save.click();
  await expect(editor).toHaveCount(0);
  expect(updates[1].expectedRevision).toBe(4);
  expect(updates[1].definition).not.toHaveProperty('coverageCommand');
  expect(updates[1].definition).not.toHaveProperty('coverageReportFile');
  expect(updates[1].definition).not.toHaveProperty('minCoveragePercent');
  expect(updates[1].definition).not.toHaveProperty('maxReviewFixAttempts');
  expect(updates[1].definition).toMatchObject({ maxFixAttempts: 2, sastCommand: 'npm run static-check' });
});

test('server denial does not expose settings to a viewer', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { ...session, role: 'viewer', capabilities: { canReadTasks: true, managedProjects: true } } }));
  await page.route('**/api/settings', route => route.fulfill({ status: 403, json: { error: 'forbidden' } }));
  await page.goto('/tasks/settings');
  await expect(page.getByTestId('settings-error')).toContainText('forbidden');
  await expect(page.getByTestId('connection-form')).toHaveCount(0);
  await expect(page.getByTestId('nav-settings')).toHaveCount(0);
});
test('finds the intended repository by GitLab path when project names match', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route('**/api/session', route => route.fulfill({ json: session }));
  await page.route('**/api/project-catalog', route => route.fulfill({ json: { managed: true, projects: catalog } }));
  const attempts: CreateTaskRequestDto[] = [];
  await page.route('**/api/tasks', async (route) => {
    attempts.push(route.request().postDataJSON() as CreateTaskRequestDto);
    await route.fulfill({ status: 503, json: { error: 'Тестовый отказ' } });
  });
  await page.goto('/tasks/new?project=missing');
  await expect(page.getByTestId('managed-project-select')).toBeVisible();
  await expect(page.getByTestId('create-unauthorized')).toHaveCount(0);
  await expect(page.getByTestId('create-repo-path-key')).toHaveCount(0);
  await expect(page.getByText('Репозиторий из ссылки недоступен. Выберите другой.')).toBeVisible();
  await page.getByTestId('create-title').fill('Check destination');
  await page.getByTestId('create-description').fill('Send only to the selected repository.');
  await page.getByTestId('create-ready').click();
  await expect(page.getByRole('combobox', { name: /Репозиторий/ })).toBeFocused();
  expect(attempts).toHaveLength(0);
  await page.getByTestId('managed-project-select').click();
  const search = page.getByLabel('Поиск репозитория');
  await search.fill('platform/shipment');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('option').click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(page.getByText('gitlab.test/platform/shipment', { exact: true })).toBeVisible();
  await expect(page.getByText(/Базовая ветка release/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-create.png'), fullPage: true, animations: 'disabled' });
  await page.getByTestId('create-ready').click();
  await expect(page.getByTestId('create-error')).toContainText('Тестовый отказ');
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ repositoryName: 'p2', status: 'ready' });
  expect(attempts[0]).not.toHaveProperty('idempotencyKey');
});

test('recovers a failed project catalog and explains an empty catalog', async ({ page }) => {
  let failure = true;
  await page.route('**/api/session', route => route.fulfill({ json: session }));
  await page.route('**/api/project-catalog', route =>
    failure
      ? route.fulfill({ status: 503, json: { error: 'catalog unavailable' } })
      : route.fulfill({ json: { managed: true, projects: [] } }),
  );
  await page.goto('/tasks/new');
  const retry = page.getByTestId('create-retry-catalog');
  await expect(retry).toBeVisible();
  await expect(page.getByTestId('create-ready')).toBeDisabled();
  failure = false;
  await retry.click();
  await expect(page.getByRole('link', { name: 'Открыть настройки проектов' })).toBeVisible();
  await expect(page.getByTestId('create-unauthorized')).toHaveCount(0);
  await expect(page.getByTestId('create-ready')).toBeDisabled();
});

test('uses a stable system key when retrying unchanged task creation', async ({ page }) => {
  const attempts: CreateTaskRequestDto[] = [];
  await page.route('**/api/session', route => route.fulfill({
    json: { ...session, user: { ...session.user, service: 'system' }, authMode: 'bearer' },
  }));
  await page.route('**/api/project-catalog', route => route.fulfill({ json: { managed: true, projects: catalog } }));
  await page.route('**/api/tasks', async (route) => {
    const payload = route.request().postDataJSON() as CreateTaskRequestDto;
    attempts.push(payload);
    const error = payload.idempotencyKey ? 'Тестовый отказ' : 'idempotencyKey is required for system tasks.';
    await route.fulfill({ status: 503, json: { error } });
  });
  await page.goto('/tasks/new?project=p1');
  const draft = page.getByTestId('create-draft');
  const title = page.getByTestId('create-title');
  await title.fill('Initial request');
  await page.getByTestId('create-description').fill('Write the draft to the selected project.');
  await expect(page.getByTestId('managed-project-select')).toContainText('Сервис');

  for (const expectedCount of [1, 2, 3]) {
    if (expectedCount === 3) await title.fill('Updated request');
    await draft.click();
    await expect(page.getByTestId('create-error')).toContainText('Тестовый отказ');
    expect(attempts).toHaveLength(expectedCount);
  }
  expect(attempts[0].idempotencyKey).toBeTruthy();
  expect(attempts[1].idempotencyKey).toBe(attempts[0].idempotencyKey);
  expect(attempts[2].idempotencyKey).not.toBe(attempts[0].idempotencyKey);
  expect(attempts.every(({ repositoryName }) => repositoryName === 'p1')).toBe(true);
});
