import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { ApiClient } from './api-client.service';
import { SessionService } from './session.service';

interface RepositoryEntry {
  id: string;
  name: string;
  gitlabHost?: string;
  repositoryPath?: string;
}

@Injectable({ providedIn: 'root' })
export class RepositoryDirectoryService {
  private readonly api = inject(ApiClient);
  private readonly session = inject(SessionService);
  private readonly entries = signal<RepositoryEntry[]>([]);

  readonly options = computed(() => this.entries().map(({ id, name, gitlabHost, repositoryPath }) => {
    const address = [gitlabHost, repositoryPath].filter(Boolean).join('/');
    return { id, label: address && address !== name ? `${name} · ${address}` : name };
  }).sort((left, right) => left.label.localeCompare(right.label, 'ru')));

  private readonly labels = computed(() => new Map(this.options().map(({ id, label }) => [id, label])));

  constructor() {
    effect((onCleanup) => {
      this.entries.set([]);
      if (!this.session.session()?.capabilities['canReadRepositoryDirectory']) return;

      const subscription = this.api.get<{ repositories: RepositoryEntry[] }>('/repository-directory').subscribe({
        next: ({ repositories }) => this.entries.set(repositories),
        error: () => this.entries.set([]),
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }

  repoLabel(id?: string): string {
    return id ? this.labels().get(id) ?? id : '';
  }
}
