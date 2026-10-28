CREATE OR REPLACE FUNCTION public.require_open_cash_register_for_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_business_date date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Guayaquil')::date;
  v_order_status text;
  v_closure_id integer;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    IF NEW.status IS DISTINCT FROM 'pagado'
      OR (TG_OP = 'UPDATE' AND OLD.status = 'pagado') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'order_payment_tenders' THEN
    SELECT orders.status
    INTO v_order_status
    FROM public.order_payment_groups AS payment_group
    JOIN public.orders
      ON orders.id = payment_group.order_id
    WHERE payment_group.id = NEW.payment_group_id;

    IF v_order_status IS DISTINCT FROM 'servido' THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME NOT IN ('expenses', 'cash_closure_income_entries') THEN
    RETURN NEW;
  END IF;

  SELECT id
  INTO v_closure_id
  FROM public.cash_closures
  WHERE status = 'abierta'
    AND (opened_at AT TIME ZONE 'America/Guayaquil')::date = v_business_date
  ORDER BY opened_at
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Open today''s cash register before recording transactions';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER require_open_cash_register_for_paid_orders
  BEFORE INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.require_open_cash_register_for_transaction();

CREATE TRIGGER require_open_cash_register_for_order_tenders
  BEFORE INSERT ON public.order_payment_tenders
  FOR EACH ROW
  EXECUTE FUNCTION public.require_open_cash_register_for_transaction();

CREATE TRIGGER require_open_cash_register_for_expenses
  BEFORE INSERT ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.require_open_cash_register_for_transaction();

CREATE TRIGGER require_open_cash_register_for_income_entries
  BEFORE INSERT ON public.cash_closure_income_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.require_open_cash_register_for_transaction();

REVOKE ALL ON FUNCTION public.require_open_cash_register_for_transaction() FROM PUBLIC, anon, authenticated;
