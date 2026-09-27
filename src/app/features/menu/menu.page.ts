import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MenuCategory, MenuProduct, MenuService } from './menu.service';

type MenuTab = 'products' | 'categories';

@Component({
  imports: [FormsModule],
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
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly showProductForm = signal(false);
  protected readonly showCategoryForm = signal(false);
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
  protected productTracksStock = false;
  protected productStock = 0;
  protected productMinStock = 0;
  protected categoryId: number | null = null;
  protected categoryName = '';
  protected categoryDescription = '';

  ngOnInit(): void {
    void this.loadMenu();
  }

  protected async loadMenu(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const [categories, products] = await Promise.all([
        this.menuService.listCategories(),
        this.menuService.listProducts(),
      ]);
      this.categories.set(categories);
      this.products.set(products);
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

  protected categoryNameFor(categoryId: number | null): string {
    return this.categories().find((category) => category.id === categoryId)?.name ?? 'Sin categoría';
  }

  protected formatCurrency(value: number): string {
    return this.money.format(value);
  }

  protected closeForms(): void {
    if (this.saving()) return;
    this.showProductForm.set(false);
    this.showCategoryForm.set(false);
  }

  private readableError(error: unknown): string {
    return error instanceof Error ? error.message : 'No se pudo guardar el menú.';
  }
}