import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../../core/supabase/supabase.service';

export interface InventoryProduct {
  id: number;
  name: string;
  track_stock: boolean;
  current_stock: number;
  min_stock: number;
}

export interface InventoryMovement {
  id: number;
  product_id: number;
  movement_type: 'entrada' | 'salida' | 'ajuste';
  quantity: number;
  reason: string | null;
  created_at: string;
  products: { name: string } | { name: string }[] | null;
  users: { full_name: string } | { full_name: string }[] | null;
}

@Injectable({ providedIn: 'root' })
export class InventoryService {
  private readonly supabase = inject(SupabaseService);

  async listProducts(): Promise<InventoryProduct[]> {
    const { data, error } = await this.requireClient()
      .from('products')
      .select('id, name, track_stock, current_stock, min_stock')
      .eq('track_stock', true)
      .order('name');
    if (error) throw error;
    const products = data as unknown as InventoryProduct[];
    return (products ?? []).map((product) => ({
      ...product,
      current_stock: Number(product.current_stock ?? 0),
      min_stock: Number(product.min_stock ?? 0),
    }));
  }

  async listMovements(): Promise<InventoryMovement[]> {
    const { data, error } = await this.requireClient()
      .from('inventory_movements')
      .select('id, product_id, movement_type, quantity, reason, created_at, products(name), users(full_name)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    return data as unknown as InventoryMovement[];
  }

  async recordMovement(input: {
    productId: number;
    movementType: InventoryMovement['movement_type'];
    quantity: number;
    reason: string;
  }): Promise<void> {
    const { error } = await this.requireClient().rpc('record_inventory_movement', {
      p_product_id: input.productId,
      p_movement_type: input.movementType,
      p_quantity: input.quantity,
      p_reason: input.reason.trim() || null,
    });
    if (error) throw error;
  }

  private requireClient() {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase para administrar el inventario.');
    return client;
  }
}