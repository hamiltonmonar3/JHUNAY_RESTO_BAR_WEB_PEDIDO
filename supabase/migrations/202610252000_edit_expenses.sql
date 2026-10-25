CREATE OR REPLACE FUNCTION public.update_expense_details(
  p_expense_id integer,
  p_amount numeric,
  p_description text,
  p_category text,
  p_expense_date date,
  p_expense_period text
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
  IF p_expense_period IS NULL OR p_expense_period NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION 'Invalid expense period';
  END IF;

  UPDATE public.expenses
  SET amount = p_amount,
      description = btrim(p_description),
      category = btrim(p_category),
      created_at = (p_expense_date::timestamp + interval '12 hours') AT TIME ZONE 'America/Guayaquil',
      expense_period = p_expense_period
  WHERE id = p_expense_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_expense_details(integer, numeric, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_expense_details(integer, numeric, text, text, date, text) TO authenticated;
