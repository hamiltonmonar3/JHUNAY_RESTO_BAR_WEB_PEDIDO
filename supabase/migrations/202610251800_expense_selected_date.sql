CREATE OR REPLACE FUNCTION public.record_expense(
  p_amount numeric,
  p_description text,
  p_category text,
  p_expense_date date
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

  INSERT INTO public.expenses (user_id, amount, description, category, created_at)
  VALUES (
    v_staff_id,
    p_amount,
    btrim(p_description),
    COALESCE(NULLIF(btrim(p_category), ''), 'general'),
    (p_expense_date::timestamp + interval '12 hours') AT TIME ZONE 'America/Guayaquil'
  )
  RETURNING id INTO v_expense_id;

  RETURN v_expense_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_expense(numeric, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_expense(numeric, text, text, date) TO authenticated;
