DROP FUNCTION IF EXISTS public.record_expense(numeric, text, text, date, text);
DROP FUNCTION IF EXISTS public.update_expense_details(integer, numeric, text, text, date, text);

CREATE OR REPLACE FUNCTION public.record_expense(
  p_amount numeric,
  p_description text,
  p_category text,
  p_expense_date date,
  p_payment_method text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_expense_id integer;
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Expense amount must be greater than zero';
  END IF;
  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'Expense description is required';
  END IF;
  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'Expense date is required';
  END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('efectivo', 'transferencia') THEN
    RAISE EXCEPTION 'Invalid expense payment method';
  END IF;

  INSERT INTO public.expenses (user_id, amount, description, category, created_at, expense_period, payment_method)
  VALUES (
    v_staff_id,
    p_amount,
    btrim(p_description),
    COALESCE(NULLIF(btrim(p_category), ''), 'general'),
    (p_expense_date::timestamp + interval '12 hours') AT TIME ZONE 'America/Guayaquil',
    'day',
    p_payment_method
  )
  RETURNING id INTO v_expense_id;

  RETURN v_expense_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_expense(numeric, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_expense(numeric, text, text, date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_expense_details(
  p_expense_id integer,
  p_amount numeric,
  p_description text,
  p_category text,
  p_expense_date date,
  p_payment_method text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.current_staff_role() IS DISTINCT FROM 'Administrador' THEN
    RAISE EXCEPTION 'Administrator role is required' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Expense amount must be greater than zero';
  END IF;
  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'Expense description is required';
  END IF;
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RAISE EXCEPTION 'Expense category is required';
  END IF;
  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'Expense date is required';
  END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('efectivo', 'transferencia') THEN
    RAISE EXCEPTION 'Invalid expense payment method';
  END IF;

  UPDATE public.expenses
  SET amount = p_amount,
      description = btrim(p_description),
      category = btrim(p_category),
      created_at = (p_expense_date::timestamp + interval '12 hours') AT TIME ZONE 'America/Guayaquil',
      expense_period = 'day',
      payment_method = p_payment_method
  WHERE id = p_expense_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_expense_details(integer, numeric, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_expense_details(integer, numeric, text, text, date, text) TO authenticated;
