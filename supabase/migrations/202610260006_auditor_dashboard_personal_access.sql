DROP POLICY IF EXISTS personas_admin_read ON public.personas;
CREATE POLICY personas_admin_read
  ON public.personas FOR SELECT TO authenticated
  USING (public.current_staff_role() IN ('Administrador', 'Auditor'));

DROP POLICY IF EXISTS persona_financial_movements_admin_read ON public.persona_financial_movements;
CREATE POLICY persona_financial_movements_admin_read
  ON public.persona_financial_movements FOR SELECT TO authenticated
  USING (public.current_staff_role() IN ('Administrador', 'Auditor'));

CREATE OR REPLACE FUNCTION public.save_persona(
  p_persona_id integer,
  p_full_name text,
  p_identification text,
  p_is_active boolean
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_persona_id integer;
BEGIN
  IF COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Auditor') THEN
    RAISE EXCEPTION 'Administrator or Auditor role is required' USING ERRCODE = '42501';
  END IF;
  IF p_full_name IS NULL OR btrim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Person name is required';
  END IF;
  IF p_is_active IS NULL THEN
    RAISE EXCEPTION 'Person status is required';
  END IF;

  IF p_persona_id IS NULL THEN
    INSERT INTO public.personas (full_name, identification, is_active)
    VALUES (
      btrim(p_full_name),
      NULLIF(btrim(COALESCE(p_identification, '')), ''),
      p_is_active
    )
    RETURNING id INTO v_persona_id;
  ELSE
    UPDATE public.personas
    SET full_name = btrim(p_full_name),
        identification = NULLIF(btrim(COALESCE(p_identification, '')), ''),
        is_active = p_is_active
    WHERE id = p_persona_id
    RETURNING id INTO v_persona_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Person not found';
    END IF;
  END IF;

  RETURN v_persona_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_persona(p_persona_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Auditor') THEN
    RAISE EXCEPTION 'Administrator or Auditor role is required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.persona_financial_movements WHERE persona_id = p_persona_id
  ) THEN
    RAISE EXCEPTION 'Person has financial movements; deactivate the person instead';
  END IF;

  DELETE FROM public.personas WHERE id = p_persona_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Person not found';
  END IF;
END;
$$;

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
BEGIN
  IF COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Auditor') THEN
    RAISE EXCEPTION 'Administrator or Auditor role is required' USING ERRCODE = '42501';
  END IF;
  IF p_persona_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.personas WHERE id = p_persona_id AND is_active
  ) THEN
    RAISE EXCEPTION 'Active person not found';
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

DROP POLICY IF EXISTS orders_auditor_dashboard_read ON public.orders;
CREATE POLICY orders_auditor_dashboard_read
  ON public.orders FOR SELECT TO authenticated
  USING (public.current_staff_role() = 'Auditor' AND status = 'pagado');

DROP POLICY IF EXISTS expenses_auditor_dashboard_read ON public.expenses;
CREATE POLICY expenses_auditor_dashboard_read
  ON public.expenses FOR SELECT TO authenticated
  USING (public.current_staff_role() = 'Auditor');

DROP POLICY IF EXISTS order_payment_groups_auditor_read ON public.order_payment_groups;
CREATE POLICY order_payment_groups_auditor_read
  ON public.order_payment_groups FOR SELECT TO authenticated
  USING (
    public.current_staff_role() = 'Auditor'
    AND EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = order_id AND orders.status = 'pagado'
    )
  );

DROP POLICY IF EXISTS order_payment_tenders_auditor_read ON public.order_payment_tenders;
CREATE POLICY order_payment_tenders_auditor_read
  ON public.order_payment_tenders FOR SELECT TO authenticated
  USING (
    public.current_staff_role() = 'Auditor'
    AND EXISTS (
      SELECT 1
      FROM public.order_payment_groups AS payment_group
      JOIN public.orders ON orders.id = payment_group.order_id
      WHERE payment_group.id = payment_group_id AND orders.status = 'pagado'
    )
  );
