import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../../core/supabase/supabase.service';

export interface ProductOption {
  id: number;
  name: string;
  price: number;
}

@Injectable({ providedIn: 'root' })
export class ProductsService {
  private readonly supabase = inject(SupabaseService);

  async listAvailable(): Promise<ProductOption[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura la publishable key de Supabase antes de consultar productos.');

    const { data, error } = await client
      .from('products')
      .select('id, category_id, name, description, price, image_url, is_available')
      .eq('is_available', true)
      .order('name');

    if (error) throw error;
    const products = data as unknown as ProductOption[];
    return (products ?? []).map((product) => ({ ...product, price: Number(product.price) }));
  }
}