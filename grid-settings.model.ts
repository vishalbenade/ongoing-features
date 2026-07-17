import { ColDef } from 'ag-grid-community';
import { IServerSideGetRowsRequest } from 'ag-grid-enterprise';

/**
 * GridSettingModel
 *
 * Unified configuration contract for both:
 *   BeamAgGridComponent         — client-side row model
 *   BeamServerSideGridComponent — server-side row model
 *
 * Fields are grouped by which grid type uses them.
 * Fields marked [SHARED] apply to both.
 * Fields marked [CLIENT-SIDE] apply only to BeamAgGridComponent.
 * Fields marked [SERVER-SIDE] apply only to BeamServerSideGridComponent.
 */
export interface GridSettingModel {

  // ── Identity [SHARED] ──────────────────────────────────────────────────────

  /** Unique identifier for this grid instance. Required. */
  gridIdentifier: string;

  /** Key used to persist column/sort/filter layout in localStorage. [SHARED] */
  stateIdentifier?: string;

  /** Schema version — used by GridStateService to invalidate stale persisted state. [SHARED] */
  schemaVersion?: number;

  // ── Data source [SHARED] ───────────────────────────────────────────────────

  /**
   * REST endpoint URL.
   *
   * CLIENT-SIDE: preload snapshot GET endpoint
   * SERVER-SIDE: paginated/sorted/filtered row endpoint (called per block by getRows)
   *              and optionally also the schema endpoint if serverSideSchemaUrl is
   *              not separately declared.
   */
  dataSourceUrl?: string;

  // ── Client-side preload flags [CLIENT-SIDE] ────────────────────────────────

  /**
   * When true, BeamAgGridComponent issues a GET to dataSourceUrl on gridReady
   * to preload an initial data snapshot before live streaming begins.
   */
  shouldPreloadData?: boolean;

  // ── Column configuration [CLIENT-SIDE] ────────────────────────────────────

  /**
   * Auto-generates colDefs from the keys of the first row of the response.
   * For each field key, this function may return a partial ColDef override.
   * For the special sentinels 'LEFT' and 'RIGHT', it may return a ColDef[]
   * that is prepended / appended to the auto-generated columns.
   *
   * Not used in server-side model — use serverSideColDefs instead.
   */
  getCustomColDefFunc?: (key: string) => any;

  // ── Server-side column configuration [SERVER-SIDE] ────────────────────────

  /**
   * Explicitly declared ColDef[] for server-side grids.
   *
   * WHY REQUIRED: Server-side row model registers the datasource before any
   * data arrives. ColDefs must exist before the datasource is registered so
   * AG Grid can render column headers and configure sort/filter params.
   * Dynamic generation from data[0] is not possible in this model.
   *
   * enrichColDefs() in BeamBaseGridComponent will normalise:
   *   width         — auto-measured via Canvas if not provided
   *   defaultWidth  — snapshot of original width for resetLayout()
   *   defaultVisible — derived from col.hide (undefined → visible)
   *
   * Takes lower priority than serverSideSchemaUrl if both are provided.
   */
  serverSideColDefs?: ColDef[];

  /**
   * URL of a lightweight schema endpoint that returns ColDef[].
   * Resolved at runtime before the datasource is registered.
   *
   * Use this when column shape is user/role/permission-driven and cannot
   * be known at build time.
   *
   * Takes precedence over serverSideColDefs if both are provided.
   * Expected response: ColDef[]
   */
  serverSideSchemaUrl?: string;

  /**
   * Consumer-provided transform that maps AG Grid's IServerSideGetRowsRequest
   * to your backend's query contract.
   *
   * AG Grid sends its own request shape (startRow, endRow, sortModel,
   * filterModel, groupKeys). Most backends do not speak this directly.
   * Provide this function to translate to your own query DSL.
   *
   * If omitted, the raw IServerSideGetRowsRequest is POST-ed as-is.
   *
   * Example:
   *   buildServerSideRequest: (req) => ({
   *     page:    Math.floor(req.startRow / PAGE_SIZE),
   *     size:    PAGE_SIZE,
   *     sort:    req.sortModel.map(s => `${s.colId},${s.sort}`).join(';'),
   *     filters: mapAgFilterModelToQueryParams(req.filterModel),
   *   })
   */
  buildServerSideRequest?: (request: IServerSideGetRowsRequest) => any;

  // ── Row identity [SHARED] ──────────────────────────────────────────────────

  /** Primary key field — used for row identity in client-side transactions
   *  and for getRowId in server-side model. */
  primaryColumnName?: string;

  /** Version field — used by client-side model to reject stale streaming updates. [CLIENT-SIDE] */
  versionColumnName?: string;

  /**
   * Predicate that returns true when a streaming item should be treated
   * as a removal. [CLIENT-SIDE]
   */
  removalPredicateFunc?: (item: any) => boolean;

  // ── State persistence [SHARED] ────────────────────────────────────────────

  /** When true, column/sort/filter layout changes are persisted to localStorage. */
  shouldPersistState?: boolean;

  /** Column IDs whose filter state is managed by a parent grid. [CLIENT-SIDE] */
  parentDrivenFilterColIds?: string[];

  // ── WebSocket / RSocket streaming [CLIENT-SIDE] ───────────────────────────

  /** When true, live WebSocket/RSocket updates are applied after initial load. */
  shouldStreamUpdates?: boolean;

  /** WebSocket host URL. */
  streamingHost?: string;

  /** Route identifier within the WebSocket connection. */
  streamingRoute?: string;

  /** Subscription payload sent when opening the stream route. */
  streamingPayload?: any;
}
