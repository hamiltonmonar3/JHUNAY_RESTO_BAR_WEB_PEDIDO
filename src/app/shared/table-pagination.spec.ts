import { TablePaginationState } from './table-pagination';

describe('TablePaginationState', () => {
  it('starts with 20 rows and returns only the current page', () => {
    const pagination = new TablePaginationState();
    const items = Array.from({ length: 45 }, (_, index) => index + 1);

    expect(pagination.pageSize()).toBe(20);
    expect(pagination.visible(items)).toEqual(items.slice(0, 20));
    pagination.setPage(2, items.length);
    expect(pagination.visible(items)).toEqual(items.slice(20, 40));
  });

  it('resets to the first page when the page size changes', () => {
    const pagination = new TablePaginationState();
    pagination.setPage(3, 100);

    pagination.setPageSize(50);

    expect(pagination.page()).toBe(1);
    expect(pagination.visible(Array.from({ length: 60 }, (_, index) => index)).length).toBe(50);
  });

  it('clamps the selected page when the available items decrease', () => {
    const pagination = new TablePaginationState();
    pagination.setPage(3, 100);

    expect(pagination.currentPage(25)).toBe(2);
    pagination.setPage(8, 25);
    expect(pagination.page()).toBe(2);
  });
});
