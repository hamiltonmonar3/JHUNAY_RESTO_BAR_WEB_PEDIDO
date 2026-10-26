import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MenuCategory, MenuProduct, MenuPromotion, MenuService, PromotionDiscountType } from './menu.service';
import { TablePaginationComponent, TablePaginationState } from '../../shared/table-pagination';
import { roundCurrencyForDisplay } from '../../shared/currency';

type MenuTab = 'products' | 'categories' | 'promotions';

@Component({
  imports: [FormsModule, TablePaginationComponent],
  selector: 'app-menu-page',
  styleUrl: './menu.page.scss',
  templateUrl: './menu.page.html',
})
export class MenuPage implements OnInit {
  private readonly menuService = inject(MenuService);
  private readonly money = new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' });

  protected readonly activeTab = signal<MenuTab>('products');
  protected readonly categories = signal<MenuCategory[]>([]);
  protected readonly products = signal<MenuProduct[]>([]);
  protected readonly promotions = signal<MenuPromotion[]>([]);
  protected readonly productsPagination = new TablePaginationState();
  protected readonly categoriesPagination = new TablePaginationState();
  protected readonly promotionsPagination = new TablePaginationState();
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly showProductForm = signal(false);
  protected readonly showCategoryForm = signal(false);
  protected readonly showPromotionForm = signal(false);
  protected readonly search = signal('');
  protected readonly categoryFilter = signal('');
  protected readonly filteredProducts = computed(() => {
    const query = this.search().trim().toLocaleLowerCase('es');
    const categoryId = this.categoryFilter();
    return this.products().filter((product) =>
      (!categoryId || product.category_id === Number(categoryId))
      && (!query || `${product.name} ${product.description ?? ''}`.toLocaleLowerCase('es').includes(query)),
    );
  });

  protected productId: number | null = null;
  protected productName = '';
  protected productCategoryId = '';
  protected productDescription = '';
  protected productPrice = 0;
  protected productImage = '';
  protected productAvailable = true;
  protected productTopViewer = true;
  protected productTracksStock = false;
  protected productStock = 0;
  protected productMinStock = 0;
  protected categoryId: number | null = null;
  protected categoryName = '';
  protected categoryDescription = '';

  protected onSearchChange(value: string): void {
    this.search.set(value);
    this.productsPagination.page.set(1);
  }

  protected onCategoryFilterChange(value: string): void {
    this.categoryFilter.set(value);
    this.productsPagination.page.set(1);
  }

  protected promotionId: number | null = null;
  protected promotionName = '';
  protected promotionDescription = '';
  protected promotionDiscountType: PromotionDiscountType = 'percentage';
  protected promotionDiscountValue = 0;
  protected promotionProductId = '';
  protected promotionCategoryId = '';
  protected promotionStartDate = '';
  protected promotionEndDate = '';
  protected promotionActive = true;

  ngOnInit(): void {
    void this.loadMenu();
  }

  protected async loadMenu(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const [categories, products, promotions] = await Promise.all([
        this.menuService.listCategories(),
        this.menuService.listProducts(),
        this.menuService.listPromotions(),
      ]);
      this.categories.set(categories);
      this.products.set(products);
      this.promotions.set(promotions);
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected openProductForm(product?: MenuProduct): void {
    this.productId = product?.id ?? null;
    this.productName = product?.name ?? '';
    this.productCategoryId = product?.category_id ? String(product.category_id) : '';
    this.productDescription = product?.description ?? '';
    this.productPrice = product?.price ?? 0;
    this.productImage = product?.image_url ?? '';
    this.productAvailable = product?.is_available ?? true;
    this.productTopViewer = product?.top_viewer ?? true;
    this.productTracksStock = product?.track_stock ?? false;
    this.productStock = product?.current_stock ?? 0;
    this.productMinStock = product?.min_stock ?? 0;
    this.showProductForm.set(true);
    this.errorMessage.set('');
  }

  protected async saveProduct(): Promise<void> {
    this.saving.set(true);
    this.errorMessage.set('');
    try {
      await this.menuService.saveProduct({
        id: this.productId,
        category_id: this.productCategoryId ? Number(this.productCategoryId) : null,
        name: this.productName,
        description: this.productDescription,
        price: Number(this.productPrice),
        image_url: this.productImage,
        is_available: this.productAvailable,
        top_viewer: this.productTopViewer,
        track_stock: this.productTracksStock,
        current_stock: Number(this.productStock),
        min_stock: Number(this.productMinStock),
      });
      this.showProductForm.set(false);
      await this.loadMenu();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected openCategoryForm(category?: MenuCategory): void {
    this.categoryId = category?.id ?? null;
    this.categoryName = category?.name ?? '';
    this.categoryDescription = category?.description ?? '';
    this.showCategoryForm.set(true);
    this.errorMessage.set('');
  }

  protected async saveCategory(): Promise<void> {
    this.saving.set(true);
    this.errorMessage.set('');
    try {
      await this.menuService.saveCategory({ id: this.categoryId, name: this.categoryName, description: this.categoryDescription });
      this.showCategoryForm.set(false);
      await this.loadMenu();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async deleteCategory(category: MenuCategory): Promise<void> {
    if (!window.confirm(`¿Eliminar la categoría “${category.name}”?`)) return;
    try {
      await this.menuService.deleteCategory(category.id);
      await this.loadMenu();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    }
  }

  protected async deleteProduct(product: MenuProduct): Promise<void> {
    if (!window.confirm(`¿Eliminar “${product.name}”? Los productos incluidos en pedidos no se pueden borrar.`)) return;
    try {
      await this.menuService.deleteProduct(product.id);
      await this.loadMenu();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    }
  }

  protected openPromotionForm(promotion?: MenuPromotion): void {
    this.promotionId = promotion?.id ?? null;
    this.promotionName = promotion?.name ?? '';
    this.promotionDescription = promotion?.description ?? '';
    this.promotionDiscountType = promotion?.discount_type ?? 'percentage';
    this.promotionDiscountValue = promotion?.discount_value ?? 0;
    this.promotionProductId = promotion?.product_id ? String(promotion.product_id) : '';
    this.promotionCategoryId = promotion?.category_id ? String(promotion.category_id) : '';
    this.promotionStartDate = promotion?.start_date ? promotion.start_date.slice(0, 10) : '';
    this.promotionEndDate = promotion?.end_date ? promotion.end_date.slice(0, 10) : '';
    this.promotionActive = promotion?.is_active ?? true;
    this.showPromotionForm.set(true);
    this.errorMessage.set('');
  }

  protected async savePromotion(): Promise<void> {
    if (!this.promotionProductId && !this.promotionCategoryId) {
      this.errorMessage.set('Selecciona un producto o una categoría para la promoción.');
      return;
    }
    this.saving.set(true);
    this.errorMessage.set('');
    try {
      await this.menuService.savePromotion({
        id: this.promotionId,
        name: this.promotionName,
        description: this.promotionDescription,
        discount_type: this.promotionDiscountType,
        discount_value: Number(this.promotionDiscountValue),
        product_id: this.promotionProductId ? Number(this.promotionProductId) : null,
        category_id: this.promotionCategoryId ? Number(this.promotionCategoryId) : null,
        start_date: this.promotionStartDate || null,
        end_date: this.promotionEndDate || null,
        is_active: this.promotionActive,
      });
      this.showPromotionForm.set(false);
      await this.loadMenu();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async deletePromotion(promotion: MenuPromotion): Promise<void> {
    if (!window.confirm(`¿Eliminar la promoción “${promotion.name}”?`)) return;
    try {
      await this.menuService.deletePromotion(promotion.id);
      await this.loadMenu();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    }
  }

  protected promotionTargetLabel(promotion: MenuPromotion): string {
    if (promotion.product_id) {
      return this.products().find((product) => product.id === promotion.product_id)?.name ?? `Producto #${promotion.product_id}`;
    }
    if (promotion.category_id) {
      return `Categoría: ${this.categoryNameFor(promotion.category_id)}`;
    }
    return '—';
  }

  protected promotionDiscountLabel(promotion: MenuPromotion): string {
    return promotion.discount_type === 'percentage'
      ? `${promotion.discount_value}%`
      : this.formatCurrency(promotion.discount_value);
  }

  protected categoryNameFor(categoryId: number | null): string {
    return this.categories().find((category) => category.id === categoryId)?.name ?? 'Sin categoría';
  }

  protected formatCurrency(value: number): string {
    return this.money.format(roundCurrencyForDisplay(value));
  }

  protected closeForms(): void {
    if (this.saving()) return;
    this.showProductForm.set(false);
    this.showCategoryForm.set(false);
    this.showPromotionForm.set(false);
  }

  private readableError(error: unknown): string {
    return error instanceof Error ? error.message : 'No se pudo guardar el menú.';
  }
}