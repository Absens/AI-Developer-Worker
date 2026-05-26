import { mkdir } from 'node:fs/promises';
import { test, expect, type Browser, type Page } from '@playwright/test';

const roleHeaders = (role: 'viewer' | 'developer' | 'operator') => ({
  'x-task-tracker-user': `${role}-1`,
  'x-task-tracker-role': role,
});

const newRolePage = async (
  browser: Browser,
  role: 'viewer' | 'developer' | 'operator',
): Promise<{ page: Page; close: () => Promise<void> }> => {
  const context = await browser.newContext({ extraHTTPHeaders: roleHeaders(role) });
  const page = await context.newPage();
  return { page, close: () => context.close() };
};

const fillCreateForm = async (page: Page, title: string): Promise<void> => {
  await page.getByTestId('create-title').fill(title);
  await page.getByTestId('create-description').fill(`${title} description.`);
  await page.getByTestId('create-acceptance').fill('Task is visible in the console.');
};

test.describe.serial('task tracker console production flows', () => {
  test('reviews a project goal and promotes generated work through proposal approval', async ({
    browser,
  }) => {
    const operator = await newRolePage(browser, 'operator');
    const page = operator.page;
    const createTaskCalls: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === '/api/tasks') {
        createTaskCalls.push(request.url());
      }
    });

    await page.goto('/tasks/goals');
    await expect(page.getByTestId('goals-page')).toBeVisible();
    await expect(page.getByTestId('goal-row-pm-goal-low-risk')).toContainText('Stabilize task intake');

    await page.getByTestId('goal-row-pm-goal-low-risk').getByRole('link').click();
    await expect(page).toHaveURL(/\/tasks\/goals\/pm-goal-low-risk/);
    await expect(page.getByTestId('goal-detail-page')).toContainText('Stabilize task intake');
    await expect(page.getByTestId('goal-approve')).toBeVisible();
    await page.getByTestId('goal-approve').click();
    await expect(page.getByTestId('goal-propose-tasks')).toBeVisible();

    await page.getByTestId('goal-propose-tasks').click();
    await expect(page.getByTestId('goal-detail-page')).toContainText('Goal-derived intake guardrails task');
    expect(createTaskCalls).toEqual([]);

    await page.goto('/tasks/proposals');
    await expect(page.getByTestId('proposals-page')).toBeVisible();
    await expect(page.getByTestId('proposal-row-pm-goal-task-pm-goal-low-risk-1')).toBeVisible();
    await expect(page.getByTestId('proposal-project-goals')).toContainText('Stabilize task intake');
    await page.getByTestId('proposal-approve-pm-goal-task-pm-goal-low-risk-1').click();
    await expect(page.getByTestId('proposal-reason')).toBeFocused();
    await page.getByTestId('proposal-reason').fill('Goal work is scoped and low risk.');
    await page.getByTestId('proposal-confirm').click();
    await expect(page.getByTestId('proposal-row-pm-goal-task-pm-goal-low-risk-1')).toBeHidden();

    await page.goto('/tasks');
    await expect(page.getByTestId('task-row-pm-goal-task-pm-goal-low-risk-1')).toBeVisible();
    await page.getByTestId('task-row-pm-goal-task-pm-goal-low-risk-1').click();
    await expect(page.getByTestId('task-detail')).toContainText('Goal-derived intake guardrails task');
    await expect(page.getByTestId('task-project-goals')).toContainText('Stabilize task intake');

    await operator.close();
  });

  test('runs developer and operator critical workflows', async ({ browser }) => {
    const developer = await newRolePage(browser, 'developer');
    const page = developer.page;

    await page.goto('/tasks');
    await expect(page.getByTestId('queue-page')).toBeVisible();
    await expect(page.getByTestId('task-row-ready-task')).toBeVisible();
    await page.getByTestId('task-row-ready-task').click();
    await expect(page.getByTestId('task-detail')).toContainText('Implement ready queue item');

    await page.getByTestId('preview-context-button').click();
    await expect(page.getByTestId('context-dialog')).toContainText('ID задачи');
    await expect(page.getByTestId('context-dialog')).toContainText('ready-task');
    await page.keyboard.press('Escape');

    await page.getByTestId('nav-create').click();
    await expect(page.getByTestId('create-page')).toBeVisible();
    await fillCreateForm(page, 'Draft task from Playwright');
    await page.getByTestId('create-draft').click();
    await expect(page).toHaveURL(/\/tasks\/created-draft-/);
    await expect(page.getByTestId('task-detail')).toContainText('Draft task from Playwright');

    await page.getByTestId('nav-create').click();
    await fillCreateForm(page, 'Ready task from Playwright');
    await page.getByTestId('create-ready').click();
    await expect(page).toHaveURL(/\/tasks\/created-ready-/);
    await expect(page.getByTestId('task-detail')).toContainText('Ready task from Playwright');

    await page.goto('/tasks/awaiting-task');
    await expect(page.getByTestId('task-detail')).toContainText('Use v1 or v2?');
    await page.getByTestId('answer-textarea').fill('Use v2.');
    await page.getByTestId('answer-resume-button').click();
    await expect(page.getByTestId('command-reason')).toBeFocused();
    await page.getByTestId('command-reason').fill('Answer supplied.');
    await page.getByTestId('command-confirm').click();
    await expect(page.getByTestId('task-detail')).toContainText('Готова');

    await page.goto('/tasks/proposals');
    await expect(page.getByTestId('proposals-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Предложения' })).toBeVisible();
    await expect(page.getByText('Статус супервизора')).toBeVisible();
    await page.getByTestId('proposal-approve-proposal-approve-task').click();
    await expect(page.getByTestId('proposal-reason')).toBeFocused();
    await page.getByTestId('proposal-reason').fill('Safe documentation task.');
    await page.getByTestId('proposal-confirm').click();
    await expect(page.getByTestId('proposal-row-proposal-approve-task')).toBeHidden();

    await page.getByTestId('proposal-reject-proposal-reject-task').click();
    await page.getByTestId('proposal-reason').fill('Missing migration safety.');
    await page.getByTestId('proposal-confirm').click();
    await expect(page.getByTestId('proposal-row-proposal-reject-task')).toBeHidden();

    await developer.close();

    const operator = await newRolePage(browser, 'operator');
    const opsPage = operator.page;
    await opsPage.goto('/tasks/operations');
    await expect(opsPage.getByTestId('operations-page')).toBeVisible();
    await expect(opsPage.getByText('Пульс воркеров')).toBeVisible();
    await opsPage.getByTestId('operation-retry-failed-task').first().click();
    await expect(opsPage.getByTestId('operation-reason')).toBeFocused();
    await opsPage.getByTestId('operation-reason').fill('Retry after validation fix.');
    await opsPage.getByTestId('operation-confirm').click();
    await expect(opsPage.getByTestId('operation-retry-failed-task')).toHaveCount(0);
    await operator.close();
  });

  test('keeps viewer sessions read-only in navigation and workflows', async ({ browser }) => {
    const viewer = await newRolePage(browser, 'viewer');
    const page = viewer.page;

    await page.goto('/tasks');
    await expect(page.getByTestId('nav-create')).toHaveCount(0);
    await expect(page.getByTestId('queue-create-task')).toHaveCount(0);
    await page.getByTestId('task-row-ready-task').click();
    await expect(page.getByTestId('preview-context-button')).toBeVisible();
    await expect(page.getByTestId('command-cancel')).toHaveCount(0);
    await expect(page.getByTestId('command-hold')).toHaveCount(0);

    await page.goto('/tasks/new');
    await expect(page.getByTestId('create-unauthorized')).toBeVisible();
    await expect(page.getByTestId('create-draft')).toBeDisabled();
    await expect(page.getByTestId('create-ready')).toBeDisabled();

    await page.goto('/tasks/operations');
    await expect(page.getByTestId('operations-page')).toBeVisible();
    await expect(page.getByTestId('operation-retry-failed-task')).toHaveCount(0);
    await expect(page.getByTestId('operation-hold-awaiting-task')).toHaveCount(0);

    await page.goto('/tasks/goals');
    await expect(page.getByTestId('goals-page')).toBeVisible();
    await page.goto('/tasks/goals/pm-goal-low-risk');
    await expect(page.getByTestId('goal-detail-page')).toBeVisible();
    await expect(page.getByTestId('goal-approve')).toHaveCount(0);
    await expect(page.getByTestId('goal-reject')).toHaveCount(0);
    await expect(page.getByTestId('goal-propose-tasks')).toHaveCount(0);
    await expect(page.getByTestId('goal-complete')).toHaveCount(0);
    await expect(page.getByTestId('goal-stale')).toHaveCount(0);
    await expect(page.getByTestId('goal-run-analysis')).toHaveCount(0);

    await viewer.close();
  });

  test('keeps developer sessions from fanning out project goal tasks', async ({ browser }) => {
    const developer = await newRolePage(browser, 'developer');
    const page = developer.page;

    await page.goto('/tasks/goals/pm-goal-low-risk');
    await expect(page.getByTestId('goal-detail-page')).toBeVisible();
    await expect(page.getByTestId('goal-propose-tasks')).toHaveCount(0);

    await developer.close();
  });

  test('covers accessibility, responsive, and visual smoke baselines', async ({
    browser,
    request,
  }, testInfo) => {
    const developer = await newRolePage(browser, 'developer');
    const page = developer.page;

    await page.goto('/tasks/new');
    await expect(page.getByLabel('Название *')).toBeVisible();
    await page.getByTestId('nav-queue').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('nav-create')).toBeFocused();

    const contrast = await page.locator('.console-title').evaluate((element) => {
      const parseRgb = (value: string): [number, number, number] => {
        const match = value.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0];
        return [match[0] ?? 0, match[1] ?? 0, match[2] ?? 0];
      };
      const channel = (value: number): number => {
        const normalized = value / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : Math.pow((normalized + 0.055) / 1.055, 2.4);
      };
      const luminance = ([red, green, blue]: [number, number, number]): number =>
        0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
      const foreground = luminance(parseRgb(getComputedStyle(element).color));
      const toolbar = element.closest('.console-toolbar') ?? document.body;
      const background = luminance(parseRgb(getComputedStyle(toolbar).backgroundColor));
      const light = Math.max(foreground, background);
      const dark = Math.min(foreground, background);
      return (light + 0.05) / (dark + 0.05);
    });
    expect(contrast).toBeGreaterThan(4.5);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/tasks/operations');
    const desktop = await page.screenshot({
      path: testInfo.outputPath('desktop-operations.png'),
      fullPage: true,
    });
    expect(desktop.byteLength).toBeGreaterThan(1000);

    await page.setViewportSize({ width: 760, height: 860 });
    await page.goto('/tasks');
    const narrow = await page.screenshot({
      path: testInfo.outputPath('narrow-queue.png'),
      fullPage: true,
    });
    expect(narrow.byteLength).toBeGreaterThan(1000);

    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto('/tasks/long-title-task');
    await expect(page.getByTestId('task-detail')).toContainText('very long task title');
    const detail = await page.screenshot({
      path: testInfo.outputPath('long-title-detail.png'),
      fullPage: true,
    });
    expect(detail.byteLength).toBeGreaterThan(1000);

    await page.getByTestId('command-cancel').click();
    await page
      .getByTestId('command-reason')
      .fill('This is a long operational reason that must remain readable inside the confirmation dialog without overflowing the viewport or hiding the confirmation buttons.');
    const dialog = await page.screenshot({
      path: testInfo.outputPath('confirm-dialog-long-reason.png'),
      fullPage: true,
    });
    expect(dialog.byteLength).toBeGreaterThan(1000);
    await page.keyboard.press('Escape');

    await page.goto('/tasks/operations');
    await request.post('/api/e2e/fail-next-operations');
    await page.getByTestId('operations-refresh').click();
    await expect(page.getByText('Показан последний успешный снимок')).toBeVisible();
    const stale = await page.screenshot({
      path: testInfo.outputPath('operations-stale-refresh.png'),
      fullPage: true,
    });
    expect(stale.byteLength).toBeGreaterThan(1000);

    await mkdir(testInfo.outputDir, { recursive: true });
    await developer.close();
  });
});
