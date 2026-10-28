ALTER TABLE public.cash_closure_income_entries
  ALTER COLUMN cash_closure_id DROP NOT NULL,
  ADD COLUMN expense_period text NOT NULL DEFAULT 'day'
    CHECK (expense_period IN ('day', 'week', 'month'));

CREATE INDEX cash_closure_income_entries_period_created_at_idx
  ON public.cash_closure_income_entries (expense_period, created_at DESC);

DROP FUNCTION public.record_cash_closure_additional_income(numeric, numeric);

CREATE OR REPLACE FUNCTION public.record_cash_closure_additional_income(
  p_additional_cash_income numeric,
  p_additional_transfer_income numeric,
  p_description text,
  p_income_date date,
  p_expense_period text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_closure_id integer;
  v_created_at timestamptz;
  v_business_date date;
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_additional_cash_income IS NULL OR p_additional_cash_income < 0
    OR p_additional_transfer_income IS NULL OR p_additional_transfer_income < 0 THEN
    RAISE EXCEPTION 'Additional income must be zero or greater';
  END IF;
  IF p_additional_cash_income = 0 AND p_additional_transfer_income = 0 THEN
    RAISE EXCEPTION 'At least one additional income amount must be greater than zero';
  END IF;
  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'Income description is required';
  END IF;
  IF p_income_date IS NULL THEN
    RAISE EXCEPTION 'Income date is required';
  END IF;
  IF p_expense_period IS NULL OR p_expense_period NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION 'Invalid income period';
  END IF;

  v_created_at := (p_income_date::timestamp + interval '12 hours') AT TIME ZONE 'America/Guayaquil';

  v_business_date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Guayaquil')::date;
  IF p_income_date > v_business_date THEN
    RAISE EXCEPTION 'Income date cannot be in the future';
  END IF;

  IF p_expense_period = 'day' THEN
    IF p_income_date = v_business_date THEN
      SELECT id INTO v_closure_id
      FROM public.cash_closures
      WHERE status = 'abierta'
      ORDER BY opened_at
      LIMIT 1
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'There is no open cash register';
      END IF;
    END IF;
  END IF;

  IF p_additional_cash_income > 0 THEN
    INSERT INTO public.cash_closure_income_entries (
      cash_closure_id, user_id, source, payment_method, expense_period,
      amount, description, created_at
    )
    VALUES (
      v_closure_id, v_staff_id, 'manual', 'efectivo', p_expense_period,
      p_additional_cash_income, btrim(p_description), v_created_at
    );
  END IF;
  IF p_additional_transfer_income > 0 THEN
    INSERT INTO public.cash_closure_income_entries (
      cash_closure_id, user_id, source, payment_method, expense_period,
      amount, description, created_at
    )
    VALUES (
      v_closure_id, v_staff_id, 'manual', 'transferencia', p_expense_period,
      p_additional_transfer_income, btrim(p_description), v_created_at
    );
  END IF;

  IF p_expense_period = 'day' AND p_income_date = v_business_date THEN
    UPDATE public.cash_closures
    SET additional_cash_income = additional_cash_income + p_additional_cash_income,
        additional_transfer_income = additional_transfer_income + p_additional_transfer_income
    WHERE id = v_closure_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_cash_closure_additional_income(numeric, numeric, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_cash_closure_additional_income(numeric, numeric, text, date, text) TO authenticated;
