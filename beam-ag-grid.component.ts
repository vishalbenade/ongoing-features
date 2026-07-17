import {
  Component,
  inject,
  OnDestroy,
  OnInit,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import { CommonModule } from '@angular/common';
import { GridReadyEvent } from 'ag-grid-community';
import { FirstDataRenderedEvent } from 'ag-grid-enterprise';
import {
  bufferTime,
  filter,
  finalize,
  Subscription,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs';
import { GridEventModel, GridEventType } from '../grid-events.model';
import { GridSocketService } from '../grid-socket.service';
import { GridDataService } from '../grid-data.service';
import { BeamBaseGridComponent } from './beam-base-grid.component';

/**
 * BeamAgGridComponent — client-side row model
 *
 * Extends BeamBaseGridComponent for all shared concerns.
 *
 * Owns exclusively:
 *   - HTTP GET preload (getInitialData)
 *   - processGridData — column generation from data[0] + setGridConfiguration
 *   - Client-side event handlers (LOAD, ADD_UPDATE, REMOVE, RENDER)
 *   - WebSocket / RSocket real-time streaming
 *   - Transaction helpers (keepLatestVersions, categorizeGridUpdates, applyGridTransactions)
 *   - initialLoadComplete gate — ensures streaming starts only after first render
 *
 * Does NOT own:
 *   - NDJSON streaming (excluded per architecture decision)
 *   - Column enrichment (enrichColDefs lives in base)
 *   - State persistence wiring (wireStatePersistence lives in base)
 */
@Component({
  selector: 'beam-ag-grid',
  templateUrl: './beam-ag-grid.component.html',
  styleUrl: './beam-ag-grid.component.scss',
  encapsulation: ViewEncapsulation.None,
  imports: [AgGridAngular, CommonModule],
})
export class BeamAgGridComponent extends BeamBaseGridComponent implements OnInit, OnDestroy {

  // ============================================================================
  // ADDITIONAL INJECTIONS (client-side specific)
  // ============================================================================
  private readonly gridSocketService = inject(GridSocketService);
  private readonly gridDataService   = inject(GridDataService);

  // ============================================================================
  // CLIENT-SIDE PRIVATE STATE
  // ============================================================================

  /** Streaming RxJS subscription — kept so it can be unsubscribed on destroy. */
  private streamingSubscription: Subscription | null = null;

  /**
   * Gate that ensures streaming only starts after the first render pass.
   * Set true in handleFirstDataRendered (rows visible) or
   * tryStartStreamingAfterEmptyLoad (empty / error response).
   */
  private readonly initialLoadComplete = signal(false);

  /** Holds an event that arrived before gridApi was ready — replayed once on gridReady. */
  private pendingEvent: GridEventModel | null = null;

  // ============================================================================
  // LIFECYCLE HOOKS
  // ============================================================================
  override ngOnDestroy(): void {
    super.ngOnDestroy();
    this.cleanupStreamingSubscription();
  }

  // ============================================================================
  // BASE CLASS CONTRACT IMPLEMENTATIONS
  // ============================================================================

  /**
   * Receives every GridEventModel emitted via the gridEvents signal input.
   * If gridApi is not ready yet, stores the event for replay in handleGridReady.
   */
  protected override onGridEvent(event: GridEventModel): void {
    if (!this.gridApi) {
      this.pendingEvent = event;
    } else {
      this.handleGridEvent(event);
    }
  }

  protected override handleGridReady(params: GridReadyEvent): void {
    this.gridLogger.onGridReady(params, 'BeamAgGridComponent');
    this.gridApi = params.api;

    // Replay any event that arrived before gridApi was ready
    if (this.pendingEvent) {
      this.handleGridEvent(this.pendingEvent);
      this.pendingEvent = null;
    }

    if (this.gridSettings?.shouldPreloadData) {
      this.getInitialData();
    } else {
      this.setLoadingState(false);
      this.tryStartStreamingAfterEmptyLoad();
    }

    this.gridReady.emit(params);
  }

  /**
   * Overrides base to add the streaming gate:
   * streaming must only start after rows are visible in the DOM.
   */
  protected override handleFirstDataRendered(event: FirstDataRenderedEvent): void {
    super.handleFirstDataRendered(event);

    if (!this.initialLoadComplete()) {
      this.initialLoadComplete.set(true);
      this.setupStreamingIfEnabled();
    }
  }

  // ============================================================================
  // EXTERNAL GRID EVENT PROCESSING
  // ============================================================================
  private handleGridEvent(event: GridEventModel): void {
    const requiresGridApi =
      event.type !== GridEventType.CLEAR &&
      event.type !== GridEventType.REFRESH &&
      event.type !== GridEventType.INIT;

    if (requiresGridApi && !this.gridApi) {
      console.warn(`[BeamAgGrid] gridApi not ready — event stored for replay: ${event.type}`);
      this.pendingEvent = event;
      return;
    }

    switch (event.type) {
      case GridEventType.LOAD:       this.handleLoadEvent(event.payload);      break;
      case GridEventType.ADD_UPDATE: this.handleAddUpdateEvent(event.payload); break;
      case GridEventType.REMOVE:     this.handleRemoveEvent(event.payload);    break;
      case GridEventType.CLEAR:      this.handleClearEvent();                  break;
      case GridEventType.REFRESH:    this.handleRefreshEvent();                break;
      case GridEventType.RENDER:     this.handleRenderEvent(event.payload);    break;
      case GridEventType.INIT:       this.hasData.set(true);                   break;
      default:
        console.warn(`[BeamAgGrid] Unknown event type: ${(event as any).type}`);
    }
  }

  private handleLoadEvent(payload: any[]): void {
    if (!this.gridApi || this.gridApi.isDestroyed()) return;

    if (payload?.length) {
      this.gridApi.deselectAll();
      if (this.gridApi.getColumnDefs()?.length > 0) {
        this.gridApi.setGridOption('rowData', payload);
        this.hasData.set(true);
      } else {
        this.processGridData(payload);
      }
    } else {
      this.handleClearEvent();
    }
  }

  private handleAddUpdateEvent(payload: any[]): void {
    if (!this.gridApi || this.gridApi.isDestroyed()) return;

    if (payload?.length) {
      if (this.gridApi.getColumnDefs()?.length > 0) {
        const { adds, updates, removes } = this.categorizeGridUpdates(payload);
        this.applyGridTransactions(adds, updates, removes);
      } else {
        this.processGridData(payload);
      }
    } else {
      this.handleClearEvent();
    }
  }

  private handleRemoveEvent(payload: any[]): void {
    if (!this.gridApi || this.gridApi.isDestroyed()) return;

    if (
      payload?.length &&
      this.gridApi.getColumnDefs()?.length > 0 &&
      this.getAllRows().length > 0
    ) {
      this.gridApi.applyTransaction({ remove: payload });
      this.hasData.set(this.getAllRows().length > 0);
    }
  }

  private handleRenderEvent(payload: any[]): void {
    if (payload?.length) {
      this.setLoadingState(true);
      this.processGridData(payload);
    } else {
      this.handleClearEvent();
    }
  }

  // ============================================================================
  // DATA MANAGEMENT
  // ============================================================================
  private getInitialData(): void {
    this.setLoadingState(true);
    const startMark = this.gridLogger.markFetchStart();

    this.gridDataService
      .fetchInitialData(this.gridSettings?.dataSourceUrl)
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => {
          if (this.gridApi && !this.gridApi.isDestroyed()) {
            this.setLoadingState(false);
          }
        }),
      )
      .subscribe({
        next: (data) => {
          if (!data?.length) {
            this.gridApi?.setGridOption('rowData', []);
            this.hasData.set(false);
            this.tryStartStreamingAfterEmptyLoad();
            return;
          }
          this.processGridData(data);
          this.gridLogger.measureFetch(startMark);
        },
        error: (err) => {
          this.logger.error('[BeamAgGrid] Failed to load initial data', {
            component: this.gridSettings?.gridIdentifier,
            error: { name: err.name, message: err.message, stack: err.stack ?? '' },
          });
          this.gridApi?.setGridOption('rowData', []);
          this.hasData.set(false);
          this.tryStartStreamingAfterEmptyLoad();
        },
      });
  }

  private tryStartStreamingAfterEmptyLoad(): void {
    if (!this.initialLoadComplete()) {
      this.initialLoadComplete.set(true);
      this.setupStreamingIfEnabled();
    }
  }

  private processGridData(data: any[]): void {
    try {
      const hasValidData = Array.isArray(data) && data.length > 0;

      // generateColumnDefs lives in base — uses toPascalHeader + enrichColDefs
      const rawColDefs  = hasValidData ? this.generateColumnDefs(data[0]) : [];

      if (rawColDefs.length === 0) {
        console.warn('[BeamAgGrid] No valid columns found in data');
      }

      // setGridConfiguration lives in base — handles first-set vs. update paths
      const finalColDefs = this.setGridConfiguration(rawColDefs, data ?? []);

      this.hasData.set(hasValidData && finalColDefs.length > 0);

      // buildSchema lives in base
      this.schema = this.buildSchema(finalColDefs);

      if (this.gridSettings?.shouldPersistState && this.gridSettings?.stateIdentifier) {
        this.gridStateService.init(this.gridApi, this.schema);
      }

      this.setLoadingState(false);
    } catch (error) {
      console.error('[BeamAgGrid] Error processing grid data:', error);
      this.hasData.set(false);
      this.setLoadingState(false);
    }
  }

  private updateGridData(newDataArray: any | any[]): void {
    if (!this.gridApi || this.gridApi.isDestroyed()) return;

    const items       = Array.isArray(newDataArray) ? newDataArray : [newDataArray];
    const uniqueItems = this.keepLatestVersions(items);
    const { adds, updates, removes } = this.categorizeGridUpdates(uniqueItems);
    this.applyGridTransactions(adds, updates, removes);
  }

  // ============================================================================
  // STREAMING
  // ============================================================================
  private setupStreamingIfEnabled(): void {
    if (!this.gridSettings?.shouldStreamUpdates) return;

    if (this.gridSettings.streamingHost?.trim()) {
      this.gridSocketService.connect(this.gridSettings.streamingHost);
    }

    this.setupRealTimeUpdates();
  }

  private setupRealTimeUpdates(): void {
    this.streamingSubscription = this.gridSocketService.connectionStatus$
      .pipe(
        filter((isConnected) => isConnected),
        switchMap(() =>
          this.gridSocketService
            .subscribeToDataStream(
              this.gridSettings?.streamingRoute,
              this.gridSettings?.streamingPayload,
            )
            .pipe(
              bufferTime(100),
              filter((batch) => batch.length > 0),
              tap((batch) =>
                this.gridLogger.debug(
                  `[BeamAgGrid] Streaming batch: ${batch.length} items`,
                  { component: this.gridSettings?.gridIdentifier },
                ),
              ),
            ),
        ),
        takeUntil(this.destroy$),
      )
      .subscribe({
        next: (data: any[]) => {
          if (!this.gridApi || this.gridApi.isDestroyed()) return;

          if (this.gridApi.getColumnDefs()?.length > 0) {
            this.updateGridData(data);
          } else {
            const uniqueItems = this.keepLatestVersions(data);
            this.processGridData(uniqueItems);
          }
        },
        error: (err) => {
          this.logger.error('[BeamAgGrid] Streaming error', {
            component: this.gridSettings?.gridIdentifier,
            error: { name: err.name, message: err.message },
          });
        },
      });
  }

  // ============================================================================
  // TRANSACTION HELPERS
  // ============================================================================
  private keepLatestVersions(items: any[]): any[] {
    const pk  = this.gridSettings?.primaryColumnName;
    const ver = this.gridSettings?.versionColumnName;
    if (!pk) return items;

    const map = new Map<string, any>();
    for (const item of items) {
      const id = item[pk];
      if (!id) continue;
      const existing = map.get(id);
      const itemV    = item[ver]       ?? 0;
      const existV   = existing?.[ver] ?? 0;
      if (!existing || itemV > existV) {
        map.set(id, item);
      }
    }
    return Array.from(map.values());
  }

  private categorizeGridUpdates(
    items: any[],
  ): { adds: any[]; updates: any[]; removes: any[] } {
    const adds:    any[] = [];
    const updates: any[] = [];
    const removes: any[] = [];
    const pk = this.gridSettings?.primaryColumnName;

    for (const item of items) {
      const id = pk ? item[pk] : null;

      if (this.gridSettings?.removalPredicateFunc?.(item)) {
        if (id && this.gridApi?.getRowNode(id)) removes.push(item);
        continue;
      }

      if (id && this.gridApi?.getRowNode(id)) {
        updates.push(item);
      } else {
        adds.push(item);
      }
    }

    return { adds, updates, removes };
  }

  private applyGridTransactions(adds: any[], updates: any[], removes: any[]): void {
    if (!this.gridApi || this.gridApi.isDestroyed()) return;

    const transaction: any = {};
    if (adds.length    > 0) { transaction.add = adds; transaction.addIndex = 0; }
    if (updates.length > 0) { transaction.update = updates; }
    if (removes.length > 0) { transaction.remove = removes; }

    if (!transaction.add && !transaction.update && !transaction.remove) return;

    const result = this.gridApi.applyTransaction(transaction);

    if (result?.add?.length > 0) {
      this.gridApi.flashCells({ rowNodes: result.add });
    }

    this.hasData.set(this.getAllRows().length > 0);
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================
  private cleanupStreamingSubscription(): void {
    this.streamingSubscription?.unsubscribe();
    this.streamingSubscription = null;
  }
}
