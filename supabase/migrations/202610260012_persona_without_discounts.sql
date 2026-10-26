CREATE OR REPLACE FUNCTION public.record_persona_financial_movement(
  p_persona_id integer,
  p_movement_type text,
  p_amount numeric,
  p_description text,
  p_movement_date date
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_created_by integer;
  v_movement_id bigint;
  v_is_active boolean;
  v_receivable numeric(10, 2);
  v_payable numeric(10, 2);
  v_collected numeric(10, 2);
  v_paid numeric(10, 2);
  v_available numeric(10, 2);
BEGIN
  IF public.current_staff_role() IS DISTINCT FROM 'Administrador' THEN
    RAISE EXCEPTION 'Administrator role is required' USING ERRCODE = '42501';
  END IF;
  IF p_persona_id IS NULL THEN
    RAISE EXCEPTION 'Active person not found';
  END IF;

  SELECT is_active INTO v_is_active
  FROM public.personas
  WHERE id = p_persona_id
  FOR UPDATE;
  IF NOT FOUND OR NOT v_is_active THEN
    RAISE EXCEPTION 'Active person not found';
  END IF;

  IF p_movement_type IS NULL OR p_movement_type NOT IN ('por_cobrar', 'por_pagar', 'cobrado', 'pagado') THEN
    RAISE EXCEPTION 'Unsupported person financial movement type';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Movement amount must be greater than zero';
  END IF;
  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'Movement description is required';
  END IF;
  IF p_movement_date IS NULL THEN
    RAISE EXCEPTION 'Movement date is required';
  END IF;

  IF p_movement_type IN ('cobrado', 'pagado') THEN
    SELECT
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'por_cobrar'), 0),
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'por_pagar'), 0),
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'cobrado'), 0),
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'pagado'), 0)
    INTO v_receivable, v_payable, v_collected, v_paid
    FROM public.persona_financial_movements
    WHERE persona_id = p_persona_id;

    v_available := CASE
      WHEN p_movement_type = 'cobrado' THEN v_receivable - v_collected
      ELSE v_payable - v_paid - v_receivable + v_collected
    END;
    IF p_amount > v_available THEN
      RAISE EXCEPTION 'Movement amount exceeds the pending balance of %', greatest(v_available, 0);
    END IF;
  END IF;

  v_created_by := public.current_staff_id();
  INSERT INTO public.persona_financial_movements (
    persona_id, movement_type, amount, description, movement_date, created_by
  )
  VALUES (
    p_persona_id, p_movement_type, p_amount, btrim(p_description), p_movement_date, v_created_by
  )
  RETURNING id INTO v_movement_id;

  RETURN v_movement_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_persona_financial_movement(
  p_movement_id bigint,
  p_movement_type text,
  p_amount numeric,
  p_description text,
  p_movement_date date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_persona_id integer;
  v_receivable numeric(10, 2);
  v_payable numeric(10, 2);
  v_collected numeric(10, 2);
  v_paid numeric(10, 2);
  v_available numeric(10, 2);
BEGIN
  IF COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Auditor') THEN
    RAISE EXCEPTION 'Administrator or Auditor role is required' USING ERRCODE = '42501';
  END IF;
  IF p_movement_id IS NULL THEN
    RAISE EXCEPTION 'Movement ID is required';
  END IF;
  IF p_movement_type IS NULL OR p_movement_type NOT IN ('por_cobrar', 'por_pagar', 'cobrado', 'pagado') THEN
    RAISE EXCEPTION 'Unsupported person financial movement type';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Movement amount must be greater than zero';
  END IF;
  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'Movement description is required';
  END IF;
  IF p_movement_date IS NULL THEN
    RAISE EXCEPTION 'Movement date is required';
  END IF;

  SELECT persona_id INTO v_persona_id
  FROM public.persona_financial_movements
  WHERE id = p_movement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial movement not found';
  END IF;

  PERFORM 1 FROM public.personas WHERE id = v_persona_id FOR UPDATE;

  IF p_movement_type IN ('cobrado', 'pagado') THEN
    SELECT
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'por_cobrar'), 0),
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'por_pagar'), 0),
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'cobrado'), 0),
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'pagado'), 0)
    INTO v_receivable, v_payable, v_collected, v_paid
    FROM public.persona_financial_movements
    WHERE persona_id = v_persona_id AND id <> p_movement_id;

    v_available := CASE
      WHEN p_movement_type = 'cobrado' THEN v_receivable - v_collected
      ELSE v_payable - v_paid - v_receivable + v_collected
    END;
    IF p_amount > v_available THEN
      RAISE EXCEPTION 'Movement amount exceeds the pending balance of %', greatest(v_available, 0);
    END IF;
  END IF;

  UPDATE public.persona_financial_movements
  SET movement_type = p_movement_type,
      amount = p_amount,
      description = btrim(p_description),
      movement_date = p_movement_date
  WHERE id = p_movement_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_persona_financial_movement(integer, text, numeric, text, date)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_persona_financial_movement(bigint, text, numeric, text, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_persona_financial_movement(integer, text, numeric, text, date)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_persona_financial_movement(bigint, text, numeric, text, date)
  TO authenticated;
