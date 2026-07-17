import {
  computed,
  Directive,
  effect,
  EventEmitter,
  inject,
  Input,
  input,
  OnDestroy,
  OnInit,
  Output,
  signal,
} from '@angular/core';
import { ColDef, GridOptions, GridReadyEvent, SelectionChangedEvent } from 'ag-grid-community';
import { FirstDataRenderedEvent, GridApi } from 'ag-grid-enterprise';
import { debounceTime, Subject, takeUntil } from 'rxjs';
import { GridSettingModel } from '../grid-settings.model';
import { GridEventModel, GridEventType } from '../grid-events.model';
import { GridConfigService } from '../grid-config.service';
import { GridStateService } from '../grid-state.service';
import { GridColDef, GridSchema } from '../grid-state.models';
import { CoreData } from '../../../services/common/core-data.service';
import { GridLoggerService, LoggerService } from '@barclays/beam-ui-logger';

// ─── Shared across both grid implementations ──────────────────────────────────
export enum GridClassName {
  HAS_DATA = 'ag-theme-alpine',
  NO_DATA  = 'ag-theme-alpine ag-grid-no-data',
}

/**
 * BeamBaseGridComponent
 *
 * Abstract base class shared by:
 *   BeamAgGridComponent        — client-side row model
 *   BeamServerSideGridComponent — server-side row model
 *
 * Owns everything that is identical between the two:
 *   - All @Input / @Output declarations
 *   - Grid options initialisation and column callbacks
 *   - enrichColDefs() — width measurement + defaultVisible normalisation
 *   - generateColumnDefs() — dynamic colDef generation from data[0] keys
 *   - setGridConfiguration() — first-time vs. update column/row set logic
 *   - State persistence (save$ debounce pipe, scheduleStateSave, resetLayout)
 *   - gridCssClass, hasData, isLoading signals
 *   - handleClearEvent, handleRefreshEvent
 *   - setLoadingState, getAllRows, toPascalHeader, calcColumnWidth
 *   - ngOnDestroy teardown (destroy$, canvas GC, gridApi.destroy)
 *
 * Each subclass implements:
 *   - handleGridReady()    — registers its specific data loading strategy
 *   - handleGridEvent()    — routes external GridEventModel to its own handlers
 *   - Any method touching rowData, transactions, datasource, or streaming
 *
 * NOTE: @Directive decorator is used instead of @Component because this class
 * has no template of its own.  Angular requires a decorator for DI and
 * lifecycle hook detection to work on abstract classes.
 */
@Directive()
export abstract class BeamBaseGridComponent implements OnInit, OnDestroy {

  // ============================================================================
  // DEPENDENCY INJECTION
  // ============================================================================
  protected readonly gridLogger        = inject(GridLoggerService);
  protected readonly logger            = inject(LoggerService);
  protected readonly gridConfigService = inject(GridConfigService);
  protected readonly gridStateService  = inject(GridStateService);

  // ============================================================================
  // INPUTS / OUTPUTS
  // ============================================================================
  // Mixed @Input() / input() pattern intentionally preserved (excluded #9)
  @Input() customGridOptions?: GridOptions;
  @Input() gridSettings?: GridSettingModel;

  readonly gridEvents = input<GridEventModel | null>(null);

  @Output() readonly gridReady         = new EventEmitter<GridReadyEvent>();
  @Output() readonly firstDataRendered = new EventEmitter<FirstDataRenderedEvent>();
  @Output() readonly rowSelected       = new EventEmitter<any[]>();

  // ============================================================================
  // SHARED PROTECTED STATE
  // Accessible to subclass and template; not public API.
  // ============================================================================
  protected gridApi!: GridApi;
  protected gridOptions!: GridOptions;
  protected colDefs: GridColDef[] = [];
  protected schema: GridSchema | null = null;

  protected readonly hasData   = signal(false);
  protected readonly isLoading = signal(false);

  // ============================================================================
  // SHARED PRIVATE STATE
  // ============================================================================
  protected canvasCtx: CanvasRenderingContext2D | null = null;

  protected readonly save$    = new Subject<void>();
  protected readonly destroy$ = new Subject<void>();

  // ============================================================================
  // COMPUTED
  // ============================================================================
  readonly gridCssClass = computed(() =>
    this.hasData() ? GridClassName.HAS_DATA : GridClassName.NO_DATA,
  );

  // ============================================================================
  // CONSTRUCTOR
  // Wire gridEvents signal → subclass handleGridEvent
  // ============================================================================
  constructor() {
    effect(() => {
      const event = this.gridEvents();
      if (!event) return;
      this.onGridEvent(event);
    });
  }

  // ============================================================================
  // LIFECYCLE HOOKS
  // ============================================================================
  ngOnInit(): void {
    if (!this.gridSettings?.gridIdentifier) {
      this.logger.error('[BeamBaseGrid] gridSettings.gridIdentifier is required', {});
      return;
    }

    this.initializeGridOptions();
    this.wireStatePersistence();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.canvasCtx = null;
    this.cleanupGridApi();
  }

  // ============================================================================
  // ABSTRACT — subclasses must implement
  // ============================================================================

  /**
   * Called by the gridEvents effect whenever a new GridEventModel arrives.
   * Subclasses decide how to handle pending events (pre-gridApi) and routing.
   */
  protected abstract onGridEvent(event: GridEventModel): void;

  /**
   * AG Grid onGridReady callback.
   * Subclasses register their specific data loading strategy here
   * (preload HTTP GET, register SSRM datasource, etc.)
   */
  protected abstract handleGridReady(params: GridReadyEvent): void;

  // ============================================================================
  // GRID OPTION INITIALISATION — shared
  // ============================================================================
  protected initializeGridOptions(): void {
    this.gridOptions = {
      ...this.gridConfigService.getGridOptions(this.customGridOptions),
      gridId:        this.gridSettings!.gridIdentifier,
      defaultColDef: this.gridConfigService.getColDef(this.customGridOptions?.defaultColDef),

      onGridReady:         (e: GridReadyEvent)         => this.handleGridReady(e),
      onFirstDataRendered: (e: FirstDataRenderedEvent) => this.handleFirstDataRendered(e),

      onSelectionChanged: (e: SelectionChangedEvent) => {
        this.rowSelected.emit(e.api.getSelectedRows());
      },

      onColumnMoved:           () => this.scheduleStateSave(),
      onColumnResized:         () => this.scheduleStateSave(),
      onColumnVisible:         () => this.scheduleStateSave(),
      onColumnPinned:          () => this.scheduleStateSave(),
      onColumnRowGroupChanged: () => this.scheduleStateSave(),
      onSortChanged:           () => this.scheduleStateSave(),
      onFilterChanged:         () => this.scheduleStateSave(),
    };
  }

  // ============================================================================
  // AG-GRID LIFECYCLE — shared
  // ============================================================================

  /**
   * Default onFirstDataRendered handler.
   * Client-side subclass overrides this to also gate streaming start.
   * Server-side subclass uses it as-is (no streaming gate needed there).
   */
  protected handleFirstDataRendered(event: FirstDataRenderedEvent): void {
    this.gridApi = event.api;
    this.firstDataRendered.emit(event);
    this.setLoadingState(false);
  }

  // ============================================================================
  // COLUMN DEFINITION HELPERS — shared by both subclasses
  // ============================================================================

  /**
   * enrichColDefs — the single normalisation point for both grid types.
   *
   * Client-side: called inside processGridData after generateColumnDefs()
   *              produces raw ColDef[] from data[0] keys.
   * Server-side: called directly on consumer-declared serverSideColDefs
   *              before the datasource is registered.
   *
   * Responsibilities:
   *   width         — auto-measured via Canvas if consumer did not provide one
   *   defaultWidth  — snapshot of the original width for resetLayout()
   *   defaultVisible — normalised from col.hide (undefined → true, as expected)
   */
  protected enrichColDefs(colDefs: ColDef[]): GridColDef[] {
    return colDefs.map((col) => ({
      ...col,
      width:          col.width ?? this.calcColumnWidth((col.headerName ?? col.field) || ''),
      defaultWidth:   col.width ?? this.calcColumnWidth((col.headerName ?? col.field) || ''),
      defaultVisible: col.hide !== true,   // safer than !col.hide — handles undefined correctly
    })) as GridColDef[];
  }

  /**
   * generateColumnDefs — client-side only (called from BeamAgGridComponent).
   * Lives here in the base because it uses toPascalHeader and calcColumnWidth
   * which are base utilities. Server-side subclass never calls this.
   */
  protected generateColumnDefs(firstItem: any): GridColDef[] {
    if (!firstItem || typeof firstItem !== 'object') return [];

    const autoGeneratedCols: ColDef[] = Object.keys(firstItem).map((key) => {
      const base: ColDef = {
        field:      key,
        colId:      key,
        headerName: this.toPascalHeader(key),
        hide:       key === this.gridSettings?.primaryColumnName,
      };
      const custom = this.gridSettings?.getCustomColDefFunc?.(key) ?? {};
      return { ...base, ...custom };
    });

    const toArray = (val: any): any[] => {
      if (!val) return [];
      return Array.isArray(val) ? val : [val];
    };

    const leftCols  = toArray(this.gridSettings?.getCustomColDefFunc?.('LEFT'));
    const rightCols = toArray(this.gridSettings?.getCustomColDefFunc?.('RIGHT'));

    const raw = [...leftCols, ...autoGeneratedCols, ...rightCols];

    // enrichColDefs handles width + defaultWidth + defaultVisible
    return this.enrichColDefs(raw);
  }

  /**
   * setGridConfiguration — client-side data path only.
   * Server-side never calls this; it sets columnDefs independently before
   * registering the datasource.
   */
  protected setGridConfiguration(columnDefs: GridColDef[], data: any[]): GridColDef[] {
    const columnsAlreadySet =
      this.gridOptions.columnDefs != null &&
      (this.gridOptions.columnDefs as GridColDef[]).length > 0;

    if (!columnsAlreadySet) {
      if (this.gridApi && !this.gridApi.isDestroyed()) {
        this.gridApi.setGridOption('columnDefs', columnDefs);
        this.gridApi.setGridOption('rowData', data);
      } else {
        this.gridOptions.columnDefs = columnDefs;
        this.gridOptions.rowData    = data;
      }
      this.colDefs = columnDefs;
    } else {
      this.gridApi?.setGridOption('rowData', data);
      // Re-enrich in case widths need updating after a data reload
      this.colDefs = this.enrichColDefs(this.gridOptions.columnDefs as ColDef[]);
    }

    return this.colDefs;
  }

  /**
   * buildSchema — shared schema construction.
   * Called by both subclasses after colDefs are finalised.
   */
  protected buildSchema(finalColDefs: GridColDef[]): GridSchema {
    return {
      gridId:        this.gridSettings?.gridIdentifier,
      stateId:       this.gridSettings?.stateIdentifier,
      schemaVersion: CoreData.getSchemaVersion(),
      columns:       finalColDefs,
      rowIdField:    this.gridSettings?.primaryColumnName,
    };
  }

  // ============================================================================
  // SHARED EVENT HANDLERS
  // ============================================================================
  protected handleClearEvent(): void {
    this.gridApi?.setGridOption('rowData', []);
    this.gridOptions.loading = false;  // intentionally preserved (excluded #9)
    this.setLoadingState(false);
    this.hasData.set(false);
  }

  protected handleRefreshEvent(): void {
    this.gridApi?.refreshCells();
    this.gridApi?.redrawRows();
  }

  // ============================================================================
  // STATE PERSISTENCE — shared
  // ============================================================================
  private wireStatePersistence(): void {
    if (!this.gridSettings?.shouldPersistState || !this.gridSettings?.stateIdentifier) return;

    this.save$
      .pipe(debounceTime(600), takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.gridApi && !this.gridApi.isDestroyed() && this.schema) {
          this.gridStateService.save(
            this.schema.stateId,
            this.gridStateService.snapshot(this.gridApi, this.schema),
          );
        }
      });
  }

  protected scheduleStateSave(): void {
    this.save$.next();
  }

  resetLayout(): void {
    if (!this.gridApi || this.gridApi.isDestroyed() || !this.schema) return;
    this.gridStateService.clear(this.schema.stateId);
    this.gridStateService.init(this.gridApi, this.schema);
  }

  // ============================================================================
  // SHARED UTILITIES
  // ============================================================================
  protected setLoadingState(loading: boolean): void {
    this.isLoading.set(loading);
    if (this.gridApi && !this.gridApi.isDestroyed()) {
      this.gridApi.setGridOption('loading', loading);
    } else {
      this.gridOptions.loading = loading;
    }
  }

  protected getAllRows(): any[] {
    const rows: any[] = [];
    this.gridApi?.forEachNode((node) => rows.push(node.data));
    return rows;
  }

  protected toPascalHeader(key: string): string {
    // join('') intentionally preserved (excluded #5)
    return (key ?? '')
      .trim()
      .replace(/[_\-\s]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(' ')
      .filter(Boolean)
      .map((w) => (/^[A-Z0-9]+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join('');
  }

  protected calcColumnWidth(field: string): number {
    if (!this.canvasCtx) {
      this.canvasCtx      = document.createElement('canvas').getContext('2d')!;
      this.canvasCtx.font = 'bold 11px Inter';
    }
    return Math.ceil(this.canvasCtx.measureText(field ?? '').width) + 42;
  }

  // ============================================================================
  // CLEANUP — shared
  // ============================================================================
  protected cleanupGridApi(): void {
    if (this.gridApi && !this.gridApi.isDestroyed()) {
      this.gridApi.destroy();
    }
  }
}
