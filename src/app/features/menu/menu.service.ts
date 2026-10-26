import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../../core/supabase/supabase.service';

export interface MenuCategory {
  id: number;
  name: string;
  description: string | null;
}

export interface MenuProduct {
  id: number;
  category_id: number | null;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  is_available: boolean;
  top_viewer: boolean;
  track_stock: boolean;
  current_stock: number;
  min_stock: number;
}

export type PromotionDiscountType = 'percentage' | 'fixed';

export interface MenuPromotion {
  id: number;
  name: string;
  description: string | null;
  discount_type: PromotionDiscountType;
  discount_value: number;
  product_id: number | null;
  category_id: number | null;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
}

@Injectable({ providedIn: 'root' })
export class MenuService {
  private readonly supabase = inject(SupabaseService);

  async listCategories(): Promise<MenuCategory[]> {
    const client = this.requireClient();
    const { data, error } = await client.from('categories').select('id, name, description').order('name');
    if (error) throw error;
    return data as unknown as MenuCategory[];
  }

  async listProducts(): Promise<MenuProduct[]> {
    const client = this.requireClient();
    const { data, error } = await client
      .from('products')
      .select('id, category_id, name, description, price, image_url, is_available, top_viewer, track_stock, current_stock, min_stock')
      .order('name');
    if (error) throw error;
    const products = data as unknown as MenuProduct[];
    return (products ?? []).map((product) => ({
      ...product,
      price: Number(product.price),
      current_stock: Number(product.current_stock ?? 0),
      min_stock: Number(product.min_stock ?? 0),
    }));
  }

  async saveCategory(input: { id: number | null; name: string; description: string }): Promise<void> {
    const client = this.requireClient();
    const values = { name: input.name.trim(), description: input.description.trim() || null };
    const { error } = input.id
      ? await client.from('categories').update(values).eq('id', input.id)
      : await client.from('categories').insert(values);
    if (error) throw error;
  }

  async deleteCategory(id: number): Promise<void> {
    const { error } = await this.requireClient().from('categories').delete().eq('id', id);
    if (error) throw error;
  }

  async saveProduct(input: Omit<MenuProduct, 'id'> & { id: number | null }): Promise<void> {
    const client = this.requireClient();
    const values = {
      category_id: input.category_id,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      price: input.price,
      image_url: input.image_url?.trim() || null,
      is_available: input.is_available,
      top_viewer: input.top_viewer,
      track_stock: input.track_stock,
      min_stock: input.min_stock,
    };
    const { error } = input.id
      ? await client.from('products').update(values).eq('id', input.id)
      : await client.from('products').insert(values);
    if (error) throw error;
  }

  async deleteProduct(id: number): Promise<void> {
    const { error } = await this.requireClient().from('products').delete().eq('id', id);
    if (error) throw error;
  }

  async listPromotions(): Promise<MenuPromotion[]> {
    const client = this.requireClient();
    const { data, error } = await client
      .from('promotions')
      .select('id, name, description, discount_type, discount_value, product_id, category_id, start_date, end_date, is_active')
      .order('id', { ascending: false });
    if (error) throw error;
    const promotions = data as unknown as MenuPromotion[];
    return (promotions ?? []).map((promotion) => ({ ...promotion, discount_value: Number(promotion.discount_value) }));
  }

  async savePromotion(input: Omit<MenuPromotion, 'id'> & { id: number | null }): Promise<void> {
    const client = this.requireClient();
    const values = {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      discount_type: input.discount_type,
      discount_value: input.discount_value,
      product_id: input.product_id,
      category_id: input.category_id,
      start_date: input.start_date || null,
      end_date: input.end_date || null,
      is_active: input.is_active,
    };
    const { error } = input.id
      ? await client.from('promotions').update(values).eq('id', input.id)
      : await client.from('promotions').insert(values);
    if (error) throw error;
  }

  async deletePromotion(id: number): Promise<void> {
    const { error } = await this.requireClient().from('promotions').delete().eq('id', id);
    if (error) throw error;
  }

  private requireClient() {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase para administrar el menú.');
    return client;
  }
}