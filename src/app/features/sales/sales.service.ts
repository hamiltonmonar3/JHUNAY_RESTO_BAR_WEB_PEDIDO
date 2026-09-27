import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../../core/supabase/supabase.service';

export interface SaleRecord {
  id: number;
  total_amount: number;
  payment_method: string | null;
  paid_at: string;
}

export interface ServedOrder {
  id: number;
  total_amount: number;
  created_at: string;
  table_id: number | null;
  restaurant_tables: { table_number: number } | { table_number: number }[] | null;
}

@Injectable({ providedIn: 'root' })
export class SalesService {
  private readonly supabase = inject(SupabaseService);
  private readonly pageSize = 1000;

  async listPaidOrders(startIso: string, endIso: string): Promise<SaleRecord[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar ventas.');

    const sales: SaleRecord[] = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const { data, error } = await client
        .from('orders')
        .select('id, total_amount, payment_method, paid_at')
        .eq('status', 'pagado')
        .gte('paid_at', startIso)
        .lt('paid_at', endIso)
        .order('paid_at', { ascending: false })
        .range(offset, offset + this.pageSize - 1);

      if (error) throw error;
      const page = data as unknown as SaleRecord[];
      sales.push(...(page ?? []).map((sale) => ({ ...sale, total_amount: Number(sale.total_amount) })));
      if (!page || page.length < this.pageSize) break;
    }
    return sales;
  }

  async listServedOrders(): Promise<ServedOrder[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar pedidos por cobrar.');

    const { data, error } = await client
      .from('orders')
      .select('id, total_amount, created_at, table_id, restaurant_tables(table_number)')
      .eq('status', 'servido')
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) throw error;
    const orders = data as unknown as ServedOrder[];
    return (orders ?? []).map((order) => ({ ...order, total_amount: Number(order.total_amount) }));
  }

  async recordPayment(orderId: number, method: 'efectivo' | 'tarjeta' | 'transferencia'): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de registrar cobros.');

    const { error } = await client.rpc('record_order_payment', {
      p_order_id: orderId,
      p_payment_method: method,
    });
    if (error) throw error;
  }
}