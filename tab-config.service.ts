import { Injectable, signal, computed } from '@angular/core';

export enum TabId {
  SliceOrders           = 'slice-orders',
  Tickets               = 'tickets',
  Execute               = 'execute',
  Amend                 = 'amend',
  Copy                  = 'copy',
  AmendSlice            = 'amend-slice',
  TargetStrategyParams  = 'target-strategy-params',
  AuditTrail            = 'audit-trail',
}

export enum NodeLevel {
  Root  = 0,
  Slice = 1,
}

export enum OrderStatus {
  AtDesk    = 'at_desk',
  Working   = 'working',
  Pending   = 'pending',
  Filled    = 'filled',
  Cancelled = 'cancelled',
}

export interface SelectedNode {
  level: NodeLevel;
  status: OrderStatus;
  hasTargetStrategy?: boolean;
}

export interface Tab {
  id: TabId;
  label: string;
  children?: Tab[];
}

const ACTION_STATUSES = [OrderStatus.AtDesk, OrderStatus.Working];

const AUDIT_TRAIL: Tab = { id: TabId.AuditTrail, label: 'Audit Trail' };

const ACTIONS_DROPDOWN: Tab = {
  id: TabId.Execute,
  label: 'Actions',
  children: [
    { id: TabId.Execute, label: 'Execute' },
    { id: TabId.Amend,   label: 'Amend'   },
    { id: TabId.Copy,    label: 'Copy'    },
  ],
};

@Injectable({ providedIn: 'root' })
export class TabConfigService {

  readonly selectedNode = signal<SelectedNode | null>(null);

  readonly tabs = computed<Tab[]>(() => {
    const node = this.selectedNode();

    if (!node) return [AUDIT_TRAIL];

    if (node.level === NodeLevel.Root) {
      const canAct = ACTION_STATUSES.includes(node.status);
      return [
        { id: TabId.SliceOrders, label: 'Slice Orders' },
        { id: TabId.Tickets,     label: 'Tickets'      },
        ...(canAct ? [ACTIONS_DROPDOWN] : []),
        AUDIT_TRAIL,
      ];
    }

    // NodeLevel.Slice
    return [
      { id: TabId.AmendSlice, label: 'Amend Slice' },
      ...(node.hasTargetStrategy
        ? [{ id: TabId.TargetStrategyParams, label: 'Target Strategy Parameters' }]
        : []),
      AUDIT_TRAIL,
    ];
  });

  readonly defaultTab = computed<TabId>(() => {
    const node = this.selectedNode();
    if (!node)                          return TabId.AuditTrail;
    if (node.level === NodeLevel.Slice) return TabId.AmendSlice;
    return ACTION_STATUSES.includes(node.status) ? TabId.Execute : TabId.SliceOrders;
  });
}
