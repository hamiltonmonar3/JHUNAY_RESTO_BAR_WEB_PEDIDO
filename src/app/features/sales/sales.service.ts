import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../../core/supabase/supabase.service';

export interface SaleRecord {
  id: number;
  total_amount: number;
  payment_method: string | null;
  paid_at: string;
  created_at: string;
  customer_name: string | null;
  restaurant_tables: { table_number: number } | { table_number: number }[] | null;
  users: { full_name: string } | { full_name: string }[] | null;
}

export interface ServedOrder {
  id: number;
  total_amount: number;
  created_at: string;
  table_id: number | null;
  restaurant_tables: { table_number: number } | { table_number: number }[] | null;
  users: { full_name: string } | { full_name: string }[] | null;
}

export interface DailyOrderNumberRecord {
  id: number;
  created_at: string;
}

export interface ExpenseRecord {
  id: number;
  amount: number;
  description: string;
  category: string;
  expense_period: 'day' | 'week' | 'month';
  created_at: string;
  user_id: number | null;
  users?: { full_name: string } | { full_name: string }[] | null;
}

export interface CashClosure {
  id: number;
  user_id: number | null;
  opening_amount: number;
  total_cash_sales: number;
  total_card_sales: number;
  total_other_sales: number;
  total_expenses: number;
  additional_cash_income: number;
  additional_transfer_income: number;
  expected_cash: number;
  counted_cash: number;
  difference: number;
  notes: string | null;
  status: 'abierta' | 'cerrada';
  opened_at: string;
  closed_at: string | null;
  users?: { full_name: string } | { full_name: string }[] | null;
}

export type SalePaymentMethod = 'efectivo' | 'tarjeta' | 'transferencia';

export interface SplitPaymentInput {
  payer_name: string | null;
  items: { order_item_id: number; quantity: number }[];
  tenders: { payment_method: SalePaymentMethod; amount: number }[];
}

export interface OrderPaymentGroup {
  id: number;
  payer_name: string | null;
  group_amount: number;
  order_payment_group_items: {
    order_item_id: number;
    quantity: number;
    unit_price: number;
    subtotal: number;
    order_items: { products: { name: string } | { name: string }[] | null } | { products: { name: string } | { name: string }[] | null }[] | null;
  }[];
  order_payment_tenders: { payment_method: SalePaymentMethod; amount: number }[];
}

export interface SplitTenderSale {
  order_id: number;
  payment_method: SalePaymentMethod;
  amount: number;
}

export interface PaymentCorrectionTender {
  payment_method: SalePaymentMethod;
  amount: number;
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
        .select('id, total_amount, payment_method, paid_at, created_at, customer_name, restaurant_tables(table_number), users(full_name)')
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

  async listSplitPaymentTenders(startIso: string, endIso: string): Promise<SplitTenderSale[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar los medios de pago.');

    const { data, error } = await client
      .from('order_payment_tenders')
      .select('payment_method, amount, order_payment_groups!inner(order_id, orders!inner(status, paid_at, payment_method))')
      .eq('order_payment_groups.orders.status', 'pagado')
      .eq('order_payment_groups.orders.payment_method', 'mixto')
      .gte('order_payment_groups.orders.paid_at', startIso)
      .lt('order_payment_groups.orders.paid_at', endIso);
    if (error) throw error;

    const records = data as unknown as {
      payment_method: SalePaymentMethod;
      amount: number | string;
      order_payment_groups: { order_id: number } | { order_id: number }[];
    }[];
    return (records ?? []).map((record) => {
      const group = Array.isArray(record.order_payment_groups)
        ? record.order_payment_groups[0]
        : record.order_payment_groups;
      return {
        order_id: group.order_id,
        payment_method: record.payment_method,
        amount: Number(record.amount),
      };
    });
  }

  async listServedOrders(): Promise<ServedOrder[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar pedidos por cobrar.');

    const orders: ServedOrder[] = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const { data, error } = await client
        .from('orders')
        .select('id, total_amount, created_at, table_id, restaurant_tables(table_number), users(full_name)')
        .eq('status', 'servido')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + this.pageSize - 1);

      if (error) throw error;
      const page = data as unknown as ServedOrder[];
      orders.push(...(page ?? []).map((order) => ({ ...order, total_amount: Number(order.total_amount) })));
      if (!page || page.length < this.pageSize) break;
    }
    return orders;
  }

  async listDailyOrderNumbers(startIso: string, endIso: string): Promise<DailyOrderNumberRecord[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar la numeración diaria.');

    const orders: DailyOrderNumberRecord[] = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const { data, error } = await client
        .from('orders')
        .select('id, created_at')
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + this.pageSize - 1);

      if (error) throw error;
      const page = data as DailyOrderNumberRecord[];
      orders.push(...(page ?? []));
      if (!page || page.length < this.pageSize) break;
    }
    return orders;
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

  async recordSplitPayment(orderId: number, groups: SplitPaymentInput[]): Promise<boolean> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de registrar el cobro.');

    const { data, error } = await client.rpc('record_order_split_payment', {
      p_order_id: orderId,
      p_groups: groups,
    });
    if (error) throw error;
    return data === true;
  }

  async listPaymentGroups(orderId: number): Promise<OrderPaymentGroup[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar el detalle del pago.');

    const { data, error } = await client
      .from('order_payment_groups')
      .select('id, payer_name, group_amount, order_payment_group_items(order_item_id, quantity, unit_price, subtotal, order_items(products(name))), order_payment_tenders(payment_method, amount)')
      .eq('order_id', orderId)
      .order('id');
    if (error) throw error;
    const groups = data as unknown as OrderPaymentGroup[];
    return (groups ?? []).map((group) => ({
      ...group,
      group_amount: Number(group.group_amount),
      order_payment_group_items: group.order_payment_group_items.map((item) => ({
        ...item,
        unit_price: Number(item.unit_price),
        subtotal: Number(item.subtotal),
      })),
      order_payment_tenders: group.order_payment_tenders.map((tender) => ({
        ...tender,
        amount: Number(tender.amount),
      })),
    }));
  }

  async correctPaidOrderPayment(orderId: number, tenders: PaymentCorrectionTender[], reason: string): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase para corregir el cobro.');

    const { error } = await client.rpc('correct_paid_order_payment', {
      p_order_id: orderId,
      p_tenders: tenders,
      p_reason: reason.trim(),
    });
    if (error) throw error;
  }

  async listExpenses(
    startIso: string,
    endIso: string,
    periods?: ExpenseRecord['expense_period'][],
  ): Promise<ExpenseRecord[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar egresos.');

    let query = client
      .from('expenses')
      .select('id, amount, description, category, expense_period, created_at, user_id, users(full_name)')
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .order('created_at', { ascending: false });
    if (periods) query = query.in('expense_period', periods);

    const { data, error } = await query;
    if (error) throw error;
    const expenses = data as unknown as ExpenseRecord[];
    return (expenses ?? []).map((expense) => ({ ...expense, amount: Number(expense.amount) }));
  }

  async recordExpense(
    amount: number,
    description: string,
    category: string,
    expenseDate: string,
    period: ExpenseRecord['expense_period'],
  ): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de registrar egresos.');

    const { error } = await client.rpc('record_expense', {
      p_amount: amount,
      p_description: description,
      p_category: category,
      p_expense_date: expenseDate,
      p_expense_period: period,
    });
    if (error) throw error;
  }

  async deleteExpense(id: number): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de eliminar egresos.');

    const { error } = await client.rpc('delete_expense', { p_expense_id: id });
    if (error) throw error;
  }

  async updateExpense(
    id: number,
    amount: number,
    description: string,
    category: string,
    expenseDate: string,
    period: ExpenseRecord['expense_period'],
  ): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de actualizar egresos.');

    const { error } = await client.rpc('update_expense_details', {
      p_expense_id: id,
      p_amount: amount,
      p_description: description,
      p_category: category,
      p_expense_date: expenseDate,
      p_expense_period: period,
    });
    if (error) throw error;
  }

  async getOpenClosure(): Promise<CashClosure | null> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar la caja.');

    const { data, error } = await client
      .from('cash_closures')
      .select('id, user_id, opening_amount, total_cash_sales, total_card_sales, total_other_sales, total_expenses, additional_cash_income, additional_transfer_income, expected_cash, counted_cash, difference, notes, status, opened_at, closed_at, users(full_name)')
      .eq('status', 'abierta')
      .maybeSingle();

    if (error) throw error;
    return data ? this.normalizeClosure(data as unknown as CashClosure) : null;
  }

  async listClosureHistory(limit = 20): Promise<CashClosure[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar la caja.');

    const { data, error } = await client
      .from('cash_closures')
      .select('id, user_id, opening_amount, total_cash_sales, total_card_sales, total_other_sales, total_expenses, additional_cash_income, additional_transfer_income, expected_cash, counted_cash, difference, notes, status, opened_at, closed_at, users(full_name)')
      .eq('status', 'cerrada')
      .order('closed_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    const closures = data as unknown as CashClosure[];
    return (closures ?? []).map((closure) => this.normalizeClosure(closure));
  }

  async openClosure(openingAmount: number): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de abrir la caja.');

    const { error } = await client.rpc('open_cash_closure', { p_opening_amount: openingAmount });
    if (error) throw error;
  }

  async closeClosure(
    countedCash: number,
    notes: string | null,
    additionalCashIncome: number,
    additionalTransferIncome: number,
  ): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de cerrar la caja.');

    const { error } = await client.rpc('close_cash_closure', {
      p_counted_cash: countedCash,
      p_notes: notes,
      p_additional_cash_income: additionalCashIncome,
      p_additional_transfer_income: additionalTransferIncome,
    });
    if (error) throw error;
  }

  async recordAdditionalClosureIncome(
    additionalCashIncome: number,
    additionalTransferIncome: number,
  ): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de registrar ingresos de caja.');

    const { error } = await client.rpc('record_cash_closure_additional_income', {
      p_additional_cash_income: additionalCashIncome,
      p_additional_transfer_income: additionalTransferIncome,
    });
    if (error) throw error;
  }

  private normalizeClosure(closure: CashClosure): CashClosure {
    return {
      ...closure,
      opening_amount: Number(closure.opening_amount),
      total_cash_sales: Number(closure.total_cash_sales),
      total_card_sales: Number(closure.total_card_sales),
      total_other_sales: Number(closure.total_other_sales),
      total_expenses: Number(closure.total_expenses),
      additional_cash_income: Number(closure.additional_cash_income),
      additional_transfer_income: Number(closure.additional_transfer_income),
      expected_cash: Number(closure.expected_cash),
      counted_cash: Number(closure.counted_cash),
      difference: Number(closure.difference),
    };
  }
}