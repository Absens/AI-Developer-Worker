import { Routes } from '@angular/router';

import { CreateTaskPageComponent } from './pages/create-task-page.component';
import { NotFoundPageComponent } from './pages/not-found-page.component';
import { OperationsPageComponent } from './pages/operations-page.component';
import { ProposalsPageComponent } from './pages/proposals-page.component';
import { QueuePageComponent } from './pages/queue-page.component';
import { TaskDetailPageComponent } from './pages/task-detail-page.component';

export const routes: Routes = [
  { path: '', component: QueuePageComponent, title: 'Task queue' },
  { path: 'new', component: CreateTaskPageComponent, title: 'Create task' },
  { path: 'proposals', component: ProposalsPageComponent, title: 'Proposals' },
  { path: 'operations', component: OperationsPageComponent, title: 'Operations' },
  { path: ':taskId', component: TaskDetailPageComponent, title: 'Task detail' },
  { path: '**', component: NotFoundPageComponent, title: 'Not found' },
];
