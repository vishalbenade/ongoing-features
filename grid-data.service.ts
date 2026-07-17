import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';

export interface ServerSideRowResponse {
  rowData:   any[];
  rowCount?: number;   // total rows — omit for infinite scroll
}

/**
 * GridDataService
 *
 * Owns all HTTP transport for both grid types.
 *
 *   fetchInitialData()      — buffered GET, used by client-side preload
 *                             and by server-side schema endpoint resolution
 *   fetchServerSideRows()   — POST with AG Grid request params, used by
 *                             BeamServerSideGridComponent.getRows()
 */
@Injectable({ providedIn: 'root' })
export class GridDataService {

  private readonly http = inject(HttpClient);

  // ── Client-side preload / schema endpoint ────────────────────────────────

  /**
   * Standard buffered HTTP GET.
   * Used by:
   *   - BeamAgGridComponent: initial data snapshot
   *   - BeamServerSideGridComponent: schema resolution via serverSideSchemaUrl
   */
  fetchInitialData(url: string | undefined): Observable<any[]> {
    if (!url?.trim()) return of([]);
    return this.http.get<any[]>(url);
  }

  // ── Server-side datasource rows ──────────────────────────────────────────

  /**
   * POST request used by BeamServerSideGridComponent.getRows().
   *
   * The requestBody is either:
   *   - The raw IServerSideGetRowsRequest (if no buildServerSideRequest transform)
   *   - The consumer-transformed query object (if buildServerSideRequest is set)
   *
   * Response must conform to ServerSideRowResponse:
   *   { rowData: any[], rowCount?: number }
   *
   * rowCount (total matching rows on server) enables AG Grid to:
   *   - Render accurate pagination controls
   *   - Know when the last block has been reached in infinite scroll
   * Omit rowCount if total is unknown or for pure infinite scroll.
   */
  fetchServerSideRows(url: string, requestBody: any): Observable<ServerSideRowResponse> {
    return this.http.post<ServerSideRowResponse>(url, requestBody);
  }
}
