import {
  Component,
  OnDestroy,
  OnInit,
  ViewEncapsulation,
  inject,
} from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import { CommonModule } from '@angular/common';
import { ColDef, GridReadyEvent } from 'ag-grid-community';
import {
  IServerSideDatasource,
  IServerSideGetRowsParams,
} from 'ag-grid-enterprise';
import { finalize, takeUntil } from 'rxjs';
import { GridEventModel, GridEventType } from '../grid-events.model';
import { GridDataService } from '../grid-data.service';
import { BeamBaseGridComponent } from './beam-base-grid.component';

/**
 * BeamServerSideGridComponent — AG Grid server-side row model
 *
 * Extends BeamBaseGridComponent for all shared concerns.
 *
 * Key difference from BeamAgGridComponent:
 *
 *   Client-side:   data arrives → generate colDefs from data[0] → set rowData
 *   Server-side:   colDefs must exist FIRST → register datasource → AG Grid
 *                  calls getRows() → server returns page/block of data
 *
 * ColDef resolution order (handleGridReady):
 *   1. gridSettings.serverSideSchemaUrl  — fetch schema from endpoint at runtime
 *   2. gridSettings.serverSideColDefs    — consumer-declared static colDefs
 *   3. Error logged — grid will not render without one of the above
 *
 * In both cases, enrichColDefs() (base class) is applied before the datasource
 * is registered so width + defaultVisible are always normalised.
 *
 * What this component does NOT own:
 *   - rowData / applyTransaction — server owns all data; we never set rowData
 *   - generateColumnDefs from data[0] — not applicable, no client-side data
 *   - WebSocket streaming — can be added later via applyServerSideTransaction
 *   - NDJSON preload — server-side datasource is the data transport
 */
@Component({
  selector: 'beam-server-side-grid',
  templateUrl: './beam-server-side-grid.component.html',
  styleUrl: './beam-server-side-grid.component.scss',
  encapsulation: ViewEncapsulation.None,
  imports: [AgGridAngular, CommonModule],
})
export class BeamServerSideGridComponent extends BeamBaseGridComponent implements OnInit, OnDestroy {

  // ============================================================================
  // ADDITIONAL INJECTION (server-side specific)
  // ============================================================================
  private readonly gridDataService = inject(GridDataService);

  // ============================================================================
  // BASE CLASS CONTRACT IMPLEMENTATIONS
  // ============================================================================

  /**
   * Server-side grids do not use the gridEvents input for data loading —
   * the datasource drives all data fetching. However we still support
   * CLEAR and REFRESH events which are UI-driven, not data-driven.
   */
  protected override onGridEvent(event: GridEventModel): void {
    if (!this.gridApi) return;

    switch (event.type) {
      case GridEventType.CLEAR:
        this.handleClearEvent();
        break;

      case GridEventType.REFRESH:
        // For server-side, refresh means re-fetch all blocks from the server
        this.handleServerRefresh();
        break;

      default:
        // LOAD / ADD_UPDATE / REMOVE / RENDER are not applicable to server-side model.
        // The server owns the data; external events should trigger a server refresh instead.
        console.warn(
          `[BeamServerSideGrid] Event type "${event.type}" is not supported in server-side row model. ` +
          `Use GridEventType.REFRESH to trigger a server-side data reload.`,
        );
    }
  }

  /**
   * handleGridReady — server-side entry point.
   *
   * Sequence:
   *   1. Store gridApi reference
   *   2. Resolve colDefs (schema endpoint OR static declaration)
   *   3. enrichColDefs (width + defaultVisible normalisation)
   *   4. Apply persisted state if enabled
   *   5. Register IServerSideDatasource — AG Grid will call getRows() immediately
   *
   * The datasource is ALWAYS registered last. Registering it before colDefs
   * are set causes AG Grid to request rows before columns exist, resulting in
   * a broken grid with no headers.
   */
  protected override handleGridReady(params: GridReadyEvent): void {
    this.gridLogger.onGridReady(params, 'BeamServerSideGridComponent');
    this.gridApi = params.api;
    this.setLoadingState(true);

    const schemaUrl    = this.gridSettings?.serverSideSchemaUrl;
    const staticColDefs = this.gridSettings?.serverSideColDefs;

    if (schemaUrl) {
      // ── Path A: runtime schema from endpoint ──────────────────────────────
      this.resolveSchemaAndRegister(schemaUrl);
    } else if (staticColDefs?.length) {
      // ── Path B: consumer-declared static colDefs ──────────────────────────
      this.applyColDefsAndRegister(staticColDefs);
    } else {
      // ── Path C: misconfigured — fail loudly ───────────────────────────────
      this.logger.error(
        '[BeamServerSideGrid] No colDefs available. ' +
        'Provide gridSettings.serverSideColDefs or gridSettings.serverSideSchemaUrl. ' +
        'Server-side grids cannot derive columns from data — columns must be declared before the datasource is registered.',
        { component: this.gridSettings?.gridIdentifier },
      );
      this.setLoadingState(false);
    }

    this.gridReady.emit(params);
  }

  // ============================================================================
  // COLUMN RESOLUTION
  // ============================================================================

  /**
   * Path A — fetch colDefs from a schema endpoint at runtime.
   * Useful when column shape is user/role-driven or must be resolved server-side.
   *
   * Expected response shape: ColDef[]
   * The datasource is registered only after the schema resolves successfully.
   */
  private resolveSchemaAndRegister(schemaUrl: string): void {
    this.gridDataService
      .fetchInitialData(schemaUrl)   // reuses the same HTTP GET — response is ColDef[]
      .pipe(
        takeUntil(this.destroy$),
        finalize(() => {
          if (this.gridApi && !this.gridApi.isDestroyed()) {
            this.setLoadingState(false);
          }
        }),
      )
      .subscribe({
        next: (colDefs: any[]) => {
          if (!colDefs?.length) {
            this.logger.error(
              '[BeamServerSideGrid] Schema endpoint returned empty colDefs — datasource will not be registered.',
              { component: this.gridSettings?.gridIdentifier, url: schemaUrl },
            );
            return;
          }
          this.applyColDefsAndRegister(colDefs as ColDef[]);
        },
        error: (err) => {
          this.logger.error('[BeamServerSideGrid] Failed to fetch schema', {
            component: this.gridSettings?.gridIdentifier,
            url:       schemaUrl,
            error:     { name: err.name, message: err.message },
          });
        },
      });
  }

  /**
   * Path B / final step for Path A.
   *
   * 1. enrichColDefs — normalises width + defaultVisible (base class method)
   * 2. Set colDefs on the grid
   * 3. Build + store schema (for state persistence and resetLayout)
   * 4. Apply persisted column state if enabled
   * 5. Register datasource — AG Grid calls getRows() immediately after this
   */
  private applyColDefsAndRegister(rawColDefs: ColDef[]): void {
    const enriched = this.enrichColDefs(rawColDefs);

    this.colDefs = enriched;
    this.gridApi.setGridOption('columnDefs', enriched);

    // Build schema before state init so stateId and columns are available
    this.schema = this.buildSchema(enriched);

    if (this.gridSettings?.shouldPersistState && this.gridSettings?.stateIdentifier) {
      this.gridStateService.init(this.gridApi, this.schema);
    }

    // Register datasource LAST — after colDefs and state are fully applied
    this.gridApi.setGridOption('serverSideDatasource', this.createDatasource());

    this.hasData.set(true);
    this.setLoadingState(false);
  }

  // ============================================================================
  // SERVER-SIDE DATASOURCE
  // ============================================================================

  /**
   * Creates the IServerSideDatasource that AG Grid calls for each block request.
   *
   * getRows() receives IServerSideGetRowsParams which includes:
   *   request.startRow / endRow   — block boundaries
   *   request.sortModel           — current sort state (applied by server)
   *   request.filterModel         — current filter state (applied by server)
   *   request.groupKeys           — for row grouping (if enabled)
   *
   * The datasource maps these params to your backend's query contract via
   * gridSettings.buildServerSideRequest (consumer-provided transform function).
   * This keeps the grid decoupled from any specific backend query DSL.
   *
   * Success path:  params.success({ rowData, rowCount })
   * Failure path:  params.fail() — AG Grid shows the "failed to load" overlay
   */
  private createDatasource(): IServerSideDatasource {
    return {
      getRows: (params: IServerSideGetRowsParams) => {
        const settings = this.gridSettings;

        if (!settings?.dataSourceUrl) {
          this.logger.error('[BeamServerSideGrid] dataSourceUrl is required for server-side datasource', {});
          params.fail();
          return;
        }

        // Consumer provides the transform from AG Grid request params → backend query.
        // If no transform is provided, the raw AG Grid request params are sent as-is.
        const requestBody = settings.buildServerSideRequest
          ? settings.buildServerSideRequest(params.request)
          : params.request;

        this.gridDataService
          .fetchServerSideRows(settings.dataSourceUrl, requestBody)
          .pipe(takeUntil(this.destroy$))
          .subscribe({
            next: (response) => {
              // response must conform to { rowData: any[], rowCount?: number }
              // rowCount (total rows) enables AG Grid to show accurate pagination.
              // Omit rowCount for infinite scroll (AG Grid infers from block size).
              params.success({
                rowData:  response.rowData,
                rowCount: response.rowCount,
              });
              this.hasData.set(response.rowData?.length > 0);
            },
            error: (err) => {
              this.logger.error('[BeamServerSideGrid] getRows failed', {
                component: settings?.gridIdentifier,
                error:     { name: err.name, message: err.message },
              });
              params.fail();
            },
          });
      },
    };
  }

  // ============================================================================
  // SERVER-SIDE EVENT HANDLERS
  // ============================================================================

  /**
   * Server-side refresh — clears all cached blocks and re-fetches from row 0.
   * Equivalent of "pull to refresh" for server-side grids.
   * Does NOT touch colDefs or schema.
   */
  private handleServerRefresh(): void {
    if (!this.gridApi || this.gridApi.isDestroyed()) return;
    this.gridApi.refreshServerSide({ purge: true });
  }

  /**
   * Server-side clear — purges all blocks and resets hasData.
   * Overrides base handleClearEvent because server-side cannot use setGridOption('rowData').
   */
  protected override handleClearEvent(): void {
    if (!this.gridApi || this.gridApi.isDestroyed()) return;
    this.gridApi.refreshServerSide({ purge: true });
    this.setLoadingState(false);
    this.hasData.set(false);
  }
}
