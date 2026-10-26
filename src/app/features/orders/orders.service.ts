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
  user_id: number | null;
  restaurant_tables: { table_number: number } | { table_number: number }[] | null;
  users: { full_name: string } | { full_name: string }[] | null;
}

export interface OrderItemDetail {
  id: number;
  product_id: number;
  quantity: number;
  unit_price: number;
  subtotal: number;
  notes: string | null;
  added_after_served: boolean;
  products: { name: string } | { name: string }[] | null;
}

export interface ProductSalesSummary {
  product_id: number;
  name: string;
  quantity: number;
  total: number;
}

export interface NewOrderItem {
  product_id: number;
  quantity: number;
  notes: string | null;
}

const ORDER_PAGE_SIZE = 1000;

export class OrderWaiterNamesUnavailableError extends Error {
  constructor(readonly orders: OrderSummary[]) {
    super('No se pudo consultar el nombre de los meseros.');
    this.name = 'OrderWaiterNamesUnavailableError';
  }
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

  async countToday(): Promise<number> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar pedidos.');

    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const { count, error } = await client
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString());

    if (error) throw error;
    return count ?? 0;
  }

  async listRecent(): Promise<OrderSummary[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura la publishable key de Supabase antes de consultar pedidos.');

    const { data, error } = await client
      .from('orders')
      .select('id, status, total_amount, payment_method, customer_name, created_at, table_id, user_id, restaurant_tables(table_number), users(full_name)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    const orders = data as unknown as OrderSummary[];
    return this.attachOrderWaiterNames(
      (orders ?? []).map((order) => ({ ...order, total_amount: Number(order.total_amount) })),
    );
  }

  async listForDay(startIso: string, endIso: string): Promise<OrderSummary[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura la publishable key de Supabase antes de consultar pedidos.');

    const orders: OrderSummary[] = [];
    for (let offset = 0; ; offset += ORDER_PAGE_SIZE) {
      const { data, error } = await client
        .from('orders')
        .select('id, status, total_amount, payment_method, customer_name, created_at, table_id, user_id, restaurant_tables(table_number), users(full_name)')
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + ORDER_PAGE_SIZE - 1);

      if (error) throw error;
      const page = data as unknown as OrderSummary[];
      orders.push(...(page ?? []).map((order) => ({ ...order, total_amount: Number(order.total_amount) })));
      if (!page || page.length < ORDER_PAGE_SIZE) break;
    }
    return this.attachOrderWaiterNames(orders);
  }

  private async attachOrderWaiterNames(orders: OrderSummary[]): Promise<OrderSummary[]> {
    if (orders.length === 0) return orders;

    const client = this.supabase.client;
    if (!client) throw new Error('Configura la publishable key de Supabase antes de consultar pedidos.');

    const { data, error } = await client.rpc('get_order_waiter_names', {
      p_order_ids: orders.map((order) => order.id),
    });
    if (error) {
      if (['PGRST202', '42883', '404'].includes(error.code)) {
        throw new OrderWaiterNamesUnavailableError(orders);
      }
      throw error;
    }

    const waiterNames = new Map(
      ((data ?? []) as { order_id: number; full_name: string }[])
        .map(({ order_id, full_name }) => [order_id, full_name]),
    );
    return orders.map((order) => {
      const fullName = waiterNames.get(order.id);
      return fullName
        ? { ...order, users: { full_name: fullName } }
        : order;
    });
  }

  async listItems(orderId: number): Promise<OrderItemDetail[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar el detalle del pedido.');

    const { data, error } = await client
      .from('order_items')
      .select('id, product_id, quantity, unit_price, subtotal, notes, added_after_served, products(name)')
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

  async listTopProducts(startIso: string, endIso: string): Promise<ProductSalesSummary[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar los productos más vendidos.');

    const pageSize = 1000;
    const items: {
      id: number;
      product_id: number;
      quantity: number;
      subtotal: number | string;
      products: { name: string; top_viewer: boolean } | { name: string; top_viewer: boolean }[] | null;
    }[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await client
        .from('order_items')
        .select('id, product_id, quantity, subtotal, products!inner(name, top_viewer), orders!inner(status, paid_at)')
        .eq('products.top_viewer', true)
        .eq('orders.status', 'pagado')
        .gte('orders.paid_at', startIso)
        .lt('orders.paid_at', endIso)
        .order('id')
        .range(offset, offset + pageSize - 1);

      if (error) throw error;
      const page = data as unknown as typeof items;
      items.push(...(page ?? []));
      if (!page || page.length < pageSize) break;
    }

    const totals = new Map<number, ProductSalesSummary>();
    for (const item of items) {
      const product = Array.isArray(item.products) ? item.products[0] : item.products;
      const summary = totals.get(item.product_id) ?? {
        product_id: item.product_id,
        name: product?.name ?? 'Producto eliminado',
        quantity: 0,
        total: 0,
      };
      summary.quantity += Number(item.quantity);
      summary.total += Number(item.subtotal);
      totals.set(item.product_id, summary);
    }

    return [...totals.values()]
      .sort((first, second) => second.quantity - first.quantity || second.total - first.total)
      .slice(0, 5);
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

  async addItem(orderId: number, productId: number, quantity: number, notes: string | null): Promise<number> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de modificar pedidos.');

    const { data, error } = await client.rpc('add_order_item', {
      p_order_id: orderId,
      p_product_id: productId,
      p_quantity: quantity,
      p_notes: notes,
    });
    if (error) throw error;
    return Number(data);
  }

  async updateItemQuantity(orderItemId: number, quantity: number): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de modificar pedidos.');

    const { error } = await client.rpc('update_order_item_quantity', {
      p_order_item_id: orderItemId,
      p_quantity: quantity,
    });
    if (error) throw error;
  }

  async removeItem(orderItemId: number): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de modificar pedidos.');

    const { error } = await client.rpc('remove_order_item', {
      p_order_item_id: orderItemId,
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