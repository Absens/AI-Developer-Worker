import { test, expect } from '@playwright/test';
import type { SettingsViewDto } from '../src/app/models/settings.dto';
const session = { user: { id: 'admin', service: 'human' }, role: 'admin', authMode: 'trusted_proxy', apiPath: '/api', uiPath: '/tasks', generatedAt: '2026-11-11T00:00:00Z', capabilities: { canManageSettings: true, managedProjects: true, canReadTasks: true, canCreateTask: true } };
test('empty setup → connection → project → activation and version status', async ({ page }) => {
  let state: SettingsViewDto = { revision: 0, connections: [], projects: [], workers: [], allowedOrigins: ['https://gitlab.test'] };
  await page.route('**/api/session', route => route.fulfill({ json: session }));
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
  await page.locator('[name=projectConnection]').selectOption('c1');
  await page.locator('[name=projectRepository]').selectOption('42');
  await expect(page.locator('[name=projectName]')).toHaveValue('team/demo');
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('project-card')).toContainText('Не включён');
  await page.getByTestId('enable-project').click();
  await expect(page.getByTestId('project-card')).toContainText('Ожидает применения');
  state.projects[0].active = { revision: 1, definition: state.projects[0].desired, cloneUrl: 'https://gitlab.test/team/demo.git' };
  state.projects[0].status = 'ready'; state.revision++;
  await page.getByRole('button', { name: 'Обновить состояние' }).click();
  await expect(page.getByTestId('project-card')).toContainText('Применено');
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect(page.getByTestId('project-card')).toContainText('На паузе');
});
test('server denial does not expose settings to a viewer', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { ...session, role: 'viewer', capabilities: { canReadTasks: true, managedProjects: true } } }));
  await page.route('**/api/settings', route => route.fulfill({ status: 403, json: { error: 'forbidden' } }));
  await page.goto('/tasks/settings');
  await expect(page.getByTestId('settings-error')).toContainText('forbidden');
  await expect(page.getByTestId('connection-form')).toHaveCount(0);
  await expect(page.getByTestId('nav-settings')).toHaveCount(0);
});
test('managed task creation selects a project instead of accepting a filesystem path', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: session }));
  await page.route('**/api/project-catalog', route => route.fulfill({ json: { managed: true, projects: [{ id: 'p1', name: 'Ready project', repositoryName: 'p1', repoPathKey: 'p1', baseBranch: 'main', queue: 'MANAGED', tags: ['ai_dev'] }] } }));
  await page.goto('/tasks/new');
  await expect(page.getByTestId('managed-project-select')).toBeVisible();
  await expect(page.getByTestId('create-repo-path-key')).toHaveCount(0);
  await page.getByTestId('managed-project-select').click();
  await page.getByRole('option', { name: 'Ready project' }).click();
  await expect(page.getByTestId('managed-project-select')).toContainText('Ready project');
});
