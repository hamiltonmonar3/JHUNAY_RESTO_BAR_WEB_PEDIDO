CREATE OR REPLACE FUNCTION public.open_cash_closure(
  p_opening_amount numeric
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_closure_id integer;
  v_business_date date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Guayaquil')::date;
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_opening_amount IS NULL OR p_opening_amount < 0 THEN
    RAISE EXCEPTION 'Opening amount must be zero or greater';
  END IF;

  PERFORM pg_advisory_xact_lock(74123019, 1);

  IF EXISTS (SELECT 1 FROM public.cash_closures WHERE status = 'abierta') THEN
    RAISE EXCEPTION 'Previous cash register must be closed before opening today';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.cash_closures
    WHERE (opened_at AT TIME ZONE 'America/Guayaquil')::date = v_business_date
  ) THEN
    RAISE EXCEPTION 'Cash register has already been opened today';
  END IF;

  INSERT INTO public.cash_closures (user_id, opening_amount, status, opened_at)
  VALUES (v_staff_id, p_opening_amount, 'abierta', CURRENT_TIMESTAMP)
  RETURNING id INTO v_closure_id;

  RETURN v_closure_id;
END;
$$;

REVOKE ALL ON FUNCTION public.open_cash_closure(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_cash_closure(numeric) TO authenticated;
