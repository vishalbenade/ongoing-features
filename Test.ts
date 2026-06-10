// grid-state.service.ts

import { Injectable } from '@angular/core';
import { GridApi, FirstDataRenderedEvent } from 'ag-grid-community';
import { GridSchema, GridPersistedState } from './grid-state.models';
import { mergeColumnState } from './grid-state.merger';

const LS_PREFIX = 'grid_state__';

@Injectable({ providedIn: 'root' })
export class GridStateService {

  // ── Init ─────────────────────────────────────────────────────────────────
  // Split into two steps:
  //   1. Apply columns + filters immediately on gridReady
  //   2. Restore scroll only after firstDataRendered fires
  //   3. Never save scroll inside init — only save it on bodyScroll

  init(api: GridApi, schema: GridSchema): void {
    const persisted = this.load(schema.gridId);

    // Columns: order, sizing, visibility, pinning, sort, row group
    const mergedColumns = mergeColumnState(schema.columns, persisted);
    api.applyColumnState({ state: mergedColumns, applyOrder: true });

    // Filters
    const userFilters = this.resolveUserFilters(persisted, schema);
    api.setFilterModel(Object.keys(userFilters).length ? userFilters : null);

    // Row selection
    if (persisted?.selectedRowIds?.length && schema.rowIdField) {
      const savedIds = new Set(persisted.selectedRowIds);
      api.forEachNode(node => {
        if (node.data && savedIds.has(String(node.data[schema.rowIdField!]))) {
          node.setSelected(true);
        }
      });
    }

    // Save columns + filters immediately — but keep the saved scrollPosition
    // intact by reading it back from storage rather than from the live grid
    const stateToSave = this.snapshot(api, schema);
    stateToSave.scrollPosition = persisted?.scrollPosition ?? null; // preserve!
    this.save(schema.gridId, stateToSave);
  }

  // ── Restore scroll — call this from (firstDataRendered) event ────────────
  // firstDataRendered fires after rows are in the DOM, so scrollTo works.
// grid-state.service.ts

// Add this private method
private sanitizeFilterModel(
  filterModel: Record<string, any>
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [colId, model] of Object.entries(filterModel)) {
    if (!model) continue;                          // skip null/undefined

    // Multi-filter — AG Grid wraps sub-filters in filterModels array
    if (model.filterType === 'multi') {
      const activeSubFilters = (model.filterModels as any[])
        .filter(sub => {
          if (!sub) return false;                  // strip null sub-filters
          if (sub.filterType === 'set' &&
             Array.isArray(sub.values) &&
             sub.values.length === 0) return false; // strip empty set
          return true;
        });

      if (activeSubFilters.length === 0) continue; // whole filter is empty — skip

      result[colId] = { ...model, filterModels: activeSubFilters };
      continue;
    }

    // Set filter — skip if values array is empty
    if (model.filterType === 'set') {
      if (Array.isArray(model.values) && model.values.length === 0) continue;
    }

    result[colId] = model;
  }

  return result;
}

  restoreScroll(api: GridApi, schema: GridSchema, hostElement: HTMLElement): void {
    const persisted = this.load(schema.gridId);
    if (!persisted?.scrollPosition) return;

    const { top, left } = persisted.scrollPosition;
    if (top === 0 && left === 0) return; // nothing to restore

    const viewport = hostElement.querySelector<HTMLElement>('.ag-body-viewport');
    if (!viewport) return;

    viewport.scrollTop  = top;
    viewport.scrollLeft = left;
  }

  // ── Snapshot — reads live grid state ─────────────────────────────────────
  // Does NOT read scroll from DOM — scroll is captured separately in
  // captureScroll() which is called only on (bodyScroll) event.

  snapshot(api: GridApi, schema: GridSchema): GridPersistedState {
    const selectedRowIds: string[] = schema.rowIdField
      ? api.getSelectedRows().map(row => String(row[schema.rowIdField!]))
      : [];

    const parentColIds = new Set(schema.parentDrivenFilterColIds ?? []);
    const userFilters = Object.fromEntries(
      Object.entries(api.getFilterModel() ?? {})
        .filter(([colId]) => !parentColIds.has(colId))
    );

    const columns = (api.getColumnState() as any[])
      .filter(c => !c.colId.startsWith('ag-Grid-AutoColumn'));

    // Read scroll from what's currently saved — don't touch the DOM here
    // Scroll position is written independently by captureScroll()
    const current = this.load(schema.gridId);

    return {
      schemaVersion: schema.schemaVersion,
      savedAt: new Date().toISOString(),
      columns,
      userFilters,
      scrollPosition: current?.scrollPosition ?? null,
      selectedRowIds,
    };
  }

  // ── Capture scroll — call this from (bodyScroll) event only ──────────────
  // Separated from snapshot() so scroll is never read at the wrong time.

  captureScroll(api: GridApi, schema: GridSchema, hostElement: HTMLElement): void {
    const viewport = hostElement.querySelector<HTMLElement>('.ag-body-viewport');
    if (!viewport) return;

    const current = this.load(schema.gridId);
    if (!current) return;

    const updated: GridPersistedState = {
      ...current,
      scrollPosition: {
        top:  viewport.scrollTop,
        left: viewport.scrollLeft,
      },
    };

    this.save(schema.gridId, updated);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  save(gridId: string, state: GridPersistedState): void {
    try {
      localStorage.setItem(`${LS_PREFIX}${gridId}`, JSON.stringify(state));
    } catch { /* quota exceeded */ }
  }

  clear(gridId: string): void {
    localStorage.removeItem(`${LS_PREFIX}${gridId}`);
  }

  load(gridId: string): GridPersistedState | null {
    const raw = localStorage.getItem(`${LS_PREFIX}${gridId}`);
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  }

  private resolveUserFilters(
    persisted: GridPersistedState | null,
    schema: GridSchema
  ): Record<string, any> {
    if (!persisted) return {};
    const raw = persisted.userFilters ?? (persisted as any).filters ?? {};
    const parentColIds = new Set(schema.parentDrivenFilterColIds ?? []);
    return Object.fromEntries(
      Object.entries(raw).filter(([colId]) => !parentColIds.has(colId))
    );
  }
}

// base-grid.component.ts

import { Directive, OnDestroy, inject, ElementRef } from '@angular/core';
import { GridApi, GridReadyEvent } from 'ag-grid-community';
import { Subject, debounceTime, takeUntil } from 'rxjs';
import { GridStateService } from './grid-state.service';
import { GridSchema } from './grid-state.models';

@Directive()
export abstract class BaseGridComponent implements OnDestroy {

  protected abstract readonly schema: GridSchema;

  protected gridApi?: GridApi;
  private readonly stateSvc  = inject(GridStateService);
  private readonly elRef     = inject(ElementRef);
  private readonly save$     = new Subject<void>();
  private readonly scroll$   = new Subject<void>(); // separate stream for scroll
  private readonly destroy$  = new Subject<void>();

  protected onGridReady(event: GridReadyEvent): void {
    this.gridApi = event.api;

    // Step 1 — apply columns, filters, selection immediately
    this.stateSvc.init(this.gridApi, this.schema);

    // Debounced save for column/filter/selection changes
    this.save$.pipe(debounceTime(600), takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.gridApi) {
          this.stateSvc.save(
            this.schema.gridId,
            this.stateSvc.snapshot(this.gridApi, this.schema)
          );
        }
      });

    // Scroll captured on a longer debounce — writes only scrollPosition
    this.scroll$.pipe(debounceTime(300), takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.gridApi) {
          this.stateSvc.captureScroll(
            this.gridApi,
            this.schema,
            this.elRef.nativeElement
          );
        }
      });
  }

  // Step 2 — restore scroll only after rows are in the DOM
  protected onFirstDataRendered(): void {
    if (this.gridApi) {
      this.stateSvc.restoreScroll(
        this.gridApi,
        this.schema,
        this.elRef.nativeElement
      );
    }
  }

  protected scheduleStateSave(): void  { this.save$.next(); }
  protected scheduleScrollSave(): void { this.scroll$.next(); }

  resetLayout(): void {
    if (!this.gridApi) return;
    this.stateSvc.clear(this.schema.gridId);
    this.stateSvc.init(this.gridApi, this.schema);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}


