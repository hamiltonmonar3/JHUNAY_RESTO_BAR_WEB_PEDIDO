ALTER TABLE public.cash_closures
  ADD COLUMN additional_cash_income numeric(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN additional_transfer_income numeric(10, 2) NOT NULL DEFAULT 0;

DROP FUNCTION public.close_cash_closure(numeric, text);

CREATE FUNCTION public.close_cash_closure(
  p_counted_cash numeric,
  p_notes text DEFAULT NULL,
  p_additional_cash_income numeric DEFAULT 0,
  p_additional_transfer_income numeric DEFAULT 0
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_closure record;
  v_cash_sales numeric(10, 2) := 0;
  v_card_sales numeric(10, 2) := 0;
  v_other_sales numeric(10, 2) := 0;
  v_mixed_cash_sales numeric(10, 2) := 0;
  v_mixed_card_sales numeric(10, 2) := 0;
  v_mixed_other_sales numeric(10, 2) := 0;
  v_total_expenses numeric(10, 2) := 0;
  v_expected_cash numeric(10, 2);
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_counted_cash IS NULL OR p_counted_cash < 0 THEN
    RAISE EXCEPTION 'Counted cash must be zero or greater';
  END IF;
  IF p_additional_cash_income IS NULL OR p_additional_cash_income < 0
    OR p_additional_transfer_income IS NULL OR p_additional_transfer_income < 0 THEN
    RAISE EXCEPTION 'Additional income must be zero or greater';
  END IF;

  SELECT * INTO v_closure
  FROM public.cash_closures
  WHERE status = 'abierta'
  ORDER BY opened_at
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no open cash register';
  END IF;

  SELECT COALESCE(SUM(total_amount), 0) INTO v_cash_sales
  FROM public.orders
  WHERE status = 'pagado' AND payment_method = 'efectivo'
    AND paid_at >= v_closure.opened_at AND paid_at <= CURRENT_TIMESTAMP;

  SELECT COALESCE(SUM(total_amount), 0) INTO v_card_sales
  FROM public.orders
  WHERE status = 'pagado' AND payment_method = 'tarjeta'
    AND paid_at >= v_closure.opened_at AND paid_at <= CURRENT_TIMESTAMP;

  SELECT COALESCE(SUM(total_amount), 0) INTO v_other_sales
  FROM public.orders
  WHERE status = 'pagado'
    AND payment_method NOT IN ('efectivo', 'tarjeta', 'mixto')
    AND paid_at >= v_closure.opened_at AND paid_at <= CURRENT_TIMESTAMP;

  SELECT
    COALESCE(SUM(payment_tender.amount) FILTER (WHERE payment_tender.payment_method = 'efectivo'), 0),
    COALESCE(SUM(payment_tender.amount) FILTER (WHERE payment_tender.payment_method = 'tarjeta'), 0),
    COALESCE(SUM(payment_tender.amount) FILTER (WHERE payment_tender.payment_method = 'transferencia'), 0)
  INTO v_mixed_cash_sales, v_mixed_card_sales, v_mixed_other_sales
  FROM public.order_payment_tenders AS payment_tender
  JOIN public.order_payment_groups AS payment_group
    ON payment_group.id = payment_tender.payment_group_id
  JOIN public.orders AS payment_order
    ON payment_order.id = payment_group.order_id
  WHERE payment_order.status = 'pagado'
    AND payment_order.payment_method = 'mixto'
    AND payment_order.paid_at >= v_closure.opened_at
    AND payment_order.paid_at <= CURRENT_TIMESTAMP;

  v_cash_sales := v_cash_sales + v_mixed_cash_sales;
  v_card_sales := v_card_sales + v_mixed_card_sales;
  v_other_sales := v_other_sales + v_mixed_other_sales;

  SELECT COALESCE(SUM(amount), 0) INTO v_total_expenses
  FROM public.expenses
  WHERE created_at >= v_closure.opened_at AND created_at <= CURRENT_TIMESTAMP;

  v_expected_cash := v_closure.opening_amount + v_cash_sales
    + p_additional_cash_income - v_total_expenses;

  UPDATE public.cash_closures
  SET total_cash_sales = v_cash_sales,
      total_card_sales = v_card_sales,
      total_other_sales = v_other_sales + p_additional_transfer_income,
      total_expenses = v_total_expenses,
      additional_cash_income = p_additional_cash_income,
      additional_transfer_income = p_additional_transfer_income,
      expected_cash = v_expected_cash,
      counted_cash = p_counted_cash,
      difference = p_counted_cash - v_expected_cash,
      notes = NULLIF(btrim(p_notes), ''),
      status = 'cerrada',
      closed_at = CURRENT_TIMESTAMP
  WHERE id = v_closure.id;

  RETURN v_closure.id;
END;
$$;

REVOKE ALL ON FUNCTION public.close_cash_closure(numeric, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_cash_closure(numeric, text, numeric, numeric) TO authenticated;
