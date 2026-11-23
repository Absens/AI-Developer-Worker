import { SettingsPageComponent } from './pages/settings-page.component';
import { Routes } from '@angular/router';

import { CreateTaskPageComponent } from './pages/create-task-page.component';
import { GoalDetailPageComponent } from './pages/goal-detail-page.component';
import { GoalsPageComponent } from './pages/goals-page.component';
import { NotFoundPageComponent } from './pages/not-found-page.component';
import { OperationsPageComponent } from './pages/operations-page.component';
import { ProposalsPageComponent } from './pages/proposals-page.component';
import { QueuePageComponent } from './pages/queue-page.component';
import { TaskDetailPageComponent } from './pages/task-detail-page.component';

export const routes: Routes = [
  { path: '', component: QueuePageComponent, title: 'Очередь задач' },
  { path: 'new', component: CreateTaskPageComponent, title: 'Новая задача' },
  { path: 'proposals', component: ProposalsPageComponent, title: 'Предложения' },
  { path: 'operations', component: OperationsPageComponent, title: 'Операции' },
  { path: 'goals', component: GoalsPageComponent, title: 'Цели проекта' },
  { path: 'goals/:goalId', component: GoalDetailPageComponent, title: 'Цель проекта' },
  { path: 'settings', component: SettingsPageComponent, title: 'Настройки и проекты' },
  { path: ':taskId', component: TaskDetailPageComponent, title: 'Задача' },
  { path: '**', component: NotFoundPageComponent, title: 'Страница не найдена' },
];
