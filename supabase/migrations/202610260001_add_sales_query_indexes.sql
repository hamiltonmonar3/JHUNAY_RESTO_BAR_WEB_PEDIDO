CREATE INDEX IF NOT EXISTS orders_paid_at_sales_idx
  ON public.orders (paid_at DESC)
  WHERE status = 'pagado';

CREATE INDEX IF NOT EXISTS orders_served_created_at_idx
  ON public.orders (created_at, id)
  WHERE status = 'servido';

CREATE INDEX IF NOT EXISTS orders_created_at_id_idx
  ON public.orders (created_at, id);
