import { Component, effect, inject, signal, computed } from '@angular/core';
import { NgFor, NgIf, NgSwitch, NgSwitchCase } from '@angular/common';
import { TabConfigService, TabId, Tab } from './tab-config.service';

@Component({
  selector: 'app-order-tabs',
  standalone: true,
  imports: [NgFor, NgIf, NgSwitch, NgSwitchCase],
  template: `
    <nav class="tab-bar">
      <ng-container *ngFor="let tab of svc.tabs()">

        <button *ngIf="!tab.children"
          class="tab-btn"
          [class.active]="activeTab() === tab.id"
          (click)="activeTab.set(tab.id)">
          {{ tab.label }}
        </button>

        <div *ngIf="tab.children" class="tab-dropdown">
          <button class="tab-btn"
            [class.active]="isGroupActive(tab)"
            (click)="toggleDropdown(tab.id)">
            {{ activeChildLabel(tab) }} ▾
          </button>
          <ul *ngIf="openDropdown() === tab.id" class="dropdown-menu">
            <li *ngFor="let child of tab.children">
              <button (click)="select(child.id)">{{ child.label }}</button>
            </li>
          </ul>
        </div>

      </ng-container>
    </nav>

    <div class="tab-content" [ngSwitch]="activeTab()">
      <div *ngSwitchCase="TabId.SliceOrders">Slice Orders content</div>
      <div *ngSwitchCase="TabId.Tickets">Tickets content</div>
      <div *ngSwitchCase="TabId.Execute">Execute content</div>
      <div *ngSwitchCase="TabId.Amend">Amend content</div>
      <div *ngSwitchCase="TabId.Copy">Copy content</div>
      <div *ngSwitchCase="TabId.AmendSlice">Amend Slice content</div>
      <div *ngSwitchCase="TabId.TargetStrategyParams">Target Strategy Params content</div>
      <div *ngSwitchCase="TabId.AuditTrail">Audit Trail content</div>
    </div>
  `,
})
export class OrderTabsComponent {
  readonly svc         = inject(TabConfigService);
  readonly TabId       = TabId; // expose enum to template
  readonly activeTab   = signal<TabId>(TabId.AuditTrail);
  readonly openDropdown = signal<TabId | null>(null);

  // Reset active tab whenever the node (and thus defaultTab) changes
  private _ = effect(() => {
    this.activeTab.set(this.svc.defaultTab());
    this.openDropdown.set(null);
  });

  select(id: TabId) {
    this.activeTab.set(id);
    this.openDropdown.set(null);
  }

  toggleDropdown(id: TabId) {
    this.openDropdown.update(v => v === id ? null : id);
  }

  isGroupActive(tab: Tab) {
    return tab.children?.some(c => c.id === this.activeTab()) ?? false;
  }

  activeChildLabel(tab: Tab) {
    return tab.children?.find(c => c.id === this.activeTab())?.label ?? tab.label;
  }
}
