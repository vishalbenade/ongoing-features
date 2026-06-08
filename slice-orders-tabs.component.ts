import { Component, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';

export type TabState = 'active' | 'inactive' | 'disabled';

export interface Tab {
  id: string;
  label: string;
  icon: string;           // inline SVG path data
  viewBox: string;
  state: TabState;
}

@Component({
  selector: 'app-slice-orders-tabs',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './slice-orders-tabs.component.html',
  styleUrls: ['./slice-orders-tabs.component.scss'],
})
export class SliceOrdersTabsComponent {

  readonly tabs = signal<Tab[]>([
    {
      id: 'slice-orders',
      label: 'Slice Orders',
      viewBox: '0 0 16 16',
      icon: 'M1 2h14v2H1zm0 5h14v2H1zm0 5h14v2H1z',
      state: 'active',
    },
    {
      id: 'create',
      label: 'Create',
      viewBox: '0 0 16 16',
      icon: 'M7 1h2v14H7zm-6 6h14v2H1z',
      state: 'inactive',
    },
    {
      id: 'create-execute',
      label: 'Create & Execute',
      viewBox: '0 0 16 16',
      icon: 'M8 1L2 4v4c0 3.3 2.5 6.4 6 7 3.5-.6 6-3.7 6-7V4L8 1z',
      state: 'inactive',
    },
    {
      id: 'execute',
      label: 'Execute',
      viewBox: '0 0 16 16',
      icon: 'M4 2l10 6-10 6V2z',
      state: 'inactive',
    },
    {
      id: 'amend',
      label: 'Amend',
      viewBox: '0 0 16 16',
      icon: 'M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z',
      state: 'inactive',
    },
    {
      id: 'copy',
      label: 'Copy',
      viewBox: '0 0 16 16',
      // two-path copy icon kept as single path approximation
      icon: 'M5 5h9v10H5z M2 2h9v3H4v8H2z',
      state: 'inactive',
    },
    {
      id: 'audit-trail',
      label: 'Audit Trail',
      viewBox: '0 0 16 16',
      icon: 'M3 1h10a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1z M4 5h8 M4 8h8 M4 11h5',
      state: 'disabled',
    },
  ]);

  readonly activeTab = computed(() =>
    this.tabs().find(t => t.state === 'active') ?? null
  );

  activate(selectedId: string): void {
    this.tabs.update(tabs =>
      tabs.map(tab => {
        if (tab.state === 'disabled') return tab;
        return { ...tab, state: tab.id === selectedId ? 'active' : 'inactive' };
      })
    );
  }

  trackById(_: number, tab: Tab): string {
    return tab.id;
  }
}
