import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../../core/supabase/supabase.service';

export type OrderStatus = 'armado' | 'en_preparacion' | 'servido' | 'pagado' | 'cancelado';

export interface OrderSummary {
  id: number;
  status: OrderStatus;
  total_amount: number;
  payment_method: string | null;
  customer_name: string | null;
  created_at: string;
  table_id: number | null;
  restaurant_tables: { table_number: number } | { table_number: number }[] | null;
}

export interface OrderItemDetail {
  id: number;
  product_id: number;
  quantity: number;
  unit_price: number;
  subtotal: number;
  notes: string | null;
  products: { name: string } | { name: string }[] | null;
}

export interface NewOrderItem {
  product_id: number;
  quantity: number;
  notes: string | null;
}

@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly supabase = inject(SupabaseService);

  async countActive(): Promise<number> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar pedidos.');

    const { count, error } = await client
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .in('status', ['armado', 'en_preparacion', 'servido']);
    if (error) throw error;
    return count ?? 0;
  }

  async listRecent(): Promise<OrderSummary[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura la publishable key de Supabase antes de consultar pedidos.');

    const { data, error } = await client
      .from('orders')
      .select('id, status, total_amount, payment_method, customer_name, created_at, table_id, restaurant_tables(table_number)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    const orders = data as unknown as OrderSummary[];
    return (orders ?? []).map((order) => ({ ...order, total_amount: Number(order.total_amount) }));
  }

  async listItems(orderId: number): Promise<OrderItemDetail[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar el detalle del pedido.');

    const { data, error } = await client
      .from('order_items')
      .select('id, product_id, quantity, unit_price, subtotal, notes, products(name)')
      .eq('order_id', orderId)
      .order('id');

    if (error) throw error;
    const items = data as unknown as OrderItemDetail[];
    return (items ?? []).map((item) => ({
      ...item,
      unit_price: Number(item.unit_price),
      subtotal: Number(item.subtotal),
    }));
  }

  async createOrder(input: {
    tableId: number | null;
    customerName: string;
    items: NewOrderItem[];
  }): Promise<number> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de crear pedidos.');

    const { data, error } = await client.rpc('create_order', {
      p_table_id: input.tableId,
      p_customer_name: input.customerName.trim() || null,
      p_items: input.items,
    });
    if (error) throw error;
    return Number(data);
  }

  async advanceStatus(orderId: number, status: 'en_preparacion' | 'servido'): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de cambiar pedidos.');

    const { error } = await client.rpc('advance_order_status', {
      p_order_id: orderId,
      p_status: status,
    });
    if (error) throw error;
  }

async cancelOrder(orderId: number): Promise<void> {
  const client = this.supabase.client;
  if (!client) throw new Error('Configura Supabase antes de cancelar pedidos.');

  const { data, error } = await client
    .from('orders')
    .update({ status: 'cancelado' })
    .eq('id', orderId)
    .eq('status', 'armado')   // ← solo si sigue en armado
    .select('id, status')
    .maybeSingle();

  if (error) {
    console.error('Error al cancelar pedido:', error);
    throw new Error(error.message || 'No se pudo cancelar el pedido.');
  }

  if (!data) {
    throw new Error('El pedido no se puede cancelar porque ya no está en estado Armado.');
  }
}
}