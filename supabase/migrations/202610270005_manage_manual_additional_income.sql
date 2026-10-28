CREATE OR REPLACE FUNCTION public.update_additional_income_entry(
  p_entry_id bigint,
  p_amount numeric,
  p_description text,
  p_payment_method text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_entry public.cash_closure_income_entries%ROWTYPE;
  v_closure public.cash_closures%ROWTYPE;
  v_cash_delta numeric(10, 2) := 0;
  v_transfer_delta numeric(10, 2) := 0;
  v_expected_cash numeric(10, 2);
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Income amount must be greater than zero';
  END IF;
  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'Income description is required';
  END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('efectivo', 'transferencia') THEN
    RAISE EXCEPTION 'Invalid income payment method';
  END IF;

  SELECT * INTO v_entry
  FROM public.cash_closure_income_entries
  WHERE id = p_entry_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Additional income entry not found';
  END IF;
  IF v_entry.source <> 'manual' THEN
    RAISE EXCEPTION 'Reservation deposits cannot be edited here';
  END IF;

  IF v_entry.payment_method = 'efectivo' THEN
    v_cash_delta := v_cash_delta - v_entry.amount;
  ELSE
    v_transfer_delta := v_transfer_delta - v_entry.amount;
  END IF;
  IF p_payment_method = 'efectivo' THEN
    v_cash_delta := v_cash_delta + p_amount;
  ELSE
    v_transfer_delta := v_transfer_delta + p_amount;
  END IF;

  IF v_entry.cash_closure_id IS NOT NULL THEN
    SELECT * INTO v_closure
    FROM public.cash_closures
    WHERE id = v_entry.cash_closure_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Related cash closure not found';
    END IF;

    UPDATE public.cash_closures
    SET additional_cash_income = additional_cash_income + v_cash_delta,
        additional_transfer_income = additional_transfer_income + v_transfer_delta,
        total_other_sales = CASE WHEN status = 'cerrada'
          THEN total_other_sales + v_transfer_delta
          ELSE total_other_sales
        END
    WHERE id = v_entry.cash_closure_id;

    IF v_closure.status = 'cerrada' THEN
      v_expected_cash := v_closure.opening_amount + v_closure.total_cash_sales
        + v_closure.additional_cash_income + v_cash_delta - v_closure.total_expenses;
      UPDATE public.cash_closures
      SET expected_cash = v_expected_cash,
          difference = counted_cash - v_expected_cash
      WHERE id = v_entry.cash_closure_id;
    END IF;
  END IF;

  UPDATE public.cash_closure_income_entries
  SET amount = p_amount,
      description = btrim(p_description),
      payment_method = p_payment_method
  WHERE id = p_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_additional_income_entry(p_entry_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_entry public.cash_closure_income_entries%ROWTYPE;
  v_closure public.cash_closures%ROWTYPE;
  v_cash_delta numeric(10, 2) := 0;
  v_transfer_delta numeric(10, 2) := 0;
  v_expected_cash numeric(10, 2);
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_entry
  FROM public.cash_closure_income_entries
  WHERE id = p_entry_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Additional income entry not found';
  END IF;
  IF v_entry.source <> 'manual' THEN
    RAISE EXCEPTION 'Reservation deposits cannot be deleted here';
  END IF;

  IF v_entry.payment_method = 'efectivo' THEN
    v_cash_delta := -v_entry.amount;
  ELSE
    v_transfer_delta := -v_entry.amount;
  END IF;

  IF v_entry.cash_closure_id IS NOT NULL THEN
    SELECT * INTO v_closure
    FROM public.cash_closures
    WHERE id = v_entry.cash_closure_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Related cash closure not found';
    END IF;

    UPDATE public.cash_closures
    SET additional_cash_income = additional_cash_income + v_cash_delta,
        additional_transfer_income = additional_transfer_income + v_transfer_delta,
        total_other_sales = CASE WHEN status = 'cerrada'
          THEN total_other_sales + v_transfer_delta
          ELSE total_other_sales
        END
    WHERE id = v_entry.cash_closure_id;

    IF v_closure.status = 'cerrada' THEN
      v_expected_cash := v_closure.opening_amount + v_closure.total_cash_sales
        + v_closure.additional_cash_income + v_cash_delta - v_closure.total_expenses;
      UPDATE public.cash_closures
      SET expected_cash = v_expected_cash,
          difference = counted_cash - v_expected_cash
      WHERE id = v_entry.cash_closure_id;
    END IF;
  END IF;

  DELETE FROM public.cash_closure_income_entries WHERE id = p_entry_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_additional_income_entry(bigint, numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_additional_income_entry(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_additional_income_entry(bigint, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_additional_income_entry(bigint) TO authenticated;
