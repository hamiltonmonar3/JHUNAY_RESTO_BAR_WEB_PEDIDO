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
BEGIN
  IF COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Auditor') THEN
    RAISE EXCEPTION 'Administrator or Auditor role is required' USING ERRCODE = '42501';
  END IF;
  IF p_movement_id IS NULL THEN
    RAISE EXCEPTION 'Movement ID is required';
  END IF;
  IF p_movement_type IS NULL OR p_movement_type NOT IN ('por_cobrar', 'por_pagar', 'descuento') THEN
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

  UPDATE public.persona_financial_movements
  SET movement_type = p_movement_type,
      amount = p_amount,
      description = btrim(p_description),
      movement_date = p_movement_date
  WHERE id = p_movement_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial movement not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_persona_financial_movement(bigint, text, numeric, text, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_persona_financial_movement(bigint, text, numeric, text, date)
  TO authenticated;
