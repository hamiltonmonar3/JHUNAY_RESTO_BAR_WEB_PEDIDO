ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS expense_period text NOT NULL DEFAULT 'day';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'expenses_expense_period_check'
      AND conrelid = 'public.expenses'::regclass
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_expense_period_check
      CHECK (expense_period IN ('day', 'week', 'month'));
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.record_expense(numeric, text, text);
DROP FUNCTION IF EXISTS public.record_expense(numeric, text, text, date);

CREATE OR REPLACE FUNCTION public.record_expense(
  p_amount numeric,
  p_description text,
  p_category text,
  p_expense_date date,
  p_expense_period text
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
  IF p_expense_period IS NULL OR p_expense_period NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION 'Invalid expense period';
  END IF;

  INSERT INTO public.expenses (user_id, amount, description, category, created_at, expense_period)
  VALUES (
    v_staff_id,
    p_amount,
    btrim(p_description),
    COALESCE(NULLIF(btrim(p_category), ''), 'general'),
    (p_expense_date::timestamp + interval '12 hours') AT TIME ZONE 'America/Guayaquil',
    p_expense_period
  )
  RETURNING id INTO v_expense_id;

  RETURN v_expense_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_expense(numeric, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_expense(numeric, text, text, date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_expense_period(
  p_expense_id integer,
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
  IF p_expense_period IS NULL OR p_expense_period NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION 'Invalid expense period';
  END IF;

  UPDATE public.expenses
  SET expense_period = p_expense_period
  WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_expense_period(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_expense_period(integer, text) TO authenticated;
