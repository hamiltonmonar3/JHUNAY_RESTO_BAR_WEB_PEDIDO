import { Component, EventEmitter, Input, Output, signal } from '@angular/core';

export class TablePaginationState {
  readonly page = signal(1);
  readonly pageSize = signal(20);

  visible<T>(items: readonly T[]): T[] {
    const page = this.currentPage(items.length);
    const start = (page - 1) * this.pageSize();
    return items.slice(start, start + this.pageSize());
  }

  currentPage(totalItems: number): number {
    return Math.min(this.page(), Math.max(1, Math.ceil(totalItems / this.pageSize())));
  }

  setPage(page: number, totalItems: number): void {
    this.page.set(Math.max(1, Math.min(page, Math.max(1, Math.ceil(totalItems / this.pageSize())))));
  }

  setPageSize(pageSize: number): void {
    if (![10, 20, 50].includes(pageSize)) return;
    this.pageSize.set(pageSize);
    this.page.set(1);
  }
}

@Component({
  selector: 'app-table-pagination',
  standalone: true,
  template: `
    @if (totalItems > 0) {
      <nav class="table-pagination" aria-label="Paginación de tabla">
        <span class="pagination-summary">Mostrando {{ firstItem }}–{{ lastItem }} de {{ totalItems }}</span>
        <label>Filas
          <select [value]="pageSize" (change)="onPageSizeChange($event)" aria-label="Filas por página">
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
          </select>
        </label>
        <div class="pagination-actions">
          <button type="button" aria-label="Página anterior" [disabled]="page <= 1" (click)="pageChange.emit(page - 1)">‹</button>
          <span>Página {{ page }} de {{ totalPages }}</span>
          <button type="button" aria-label="Página siguiente" [disabled]="page >= totalPages" (click)="pageChange.emit(page + 1)">›</button>
        </div>
      </nav>
    }
  `,
  styles: [`
    :host { display: block; }
    .table-pagination {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      color: var(--muted, #75685f);
      font-size: 12px;
    }
    label, .pagination-actions { display: flex; align-items: center; gap: 8px; }
    select, button {
      min-height: 32px;
      border: 1px solid var(--line, #e7d8cb);
      border-radius: 7px;
      background: var(--paper, #fffaf5);
      color: var(--ink, #261b16);
      font: inherit;
    }
    select { padding: 0 8px; }
    button { width: 34px; cursor: pointer; font-size: 18px; }
    button:disabled { cursor: default; opacity: .45; }
    @media (max-width: 520px) {
      .table-pagination { flex-wrap: wrap; }
      .pagination-summary { flex: 1 0 100%; }
    }
  `],
})
export class TablePaginationComponent {
  @Input() totalItems = 0;
  @Input() page = 1;
  @Input() pageSize = 20;
  @Output() pageChange = new EventEmitter<number>();
  @Output() pageSizeChange = new EventEmitter<number>();

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.totalItems / this.pageSize));
  }

  get firstItem(): number {
    return this.totalItems === 0 ? 0 : (this.page - 1) * this.pageSize + 1;
  }

  get lastItem(): number {
    return Math.min(this.page * this.pageSize, this.totalItems);
  }

  onPageSizeChange(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);
    if ([10, 20, 50].includes(value)) this.pageSizeChange.emit(value);
  }
}
