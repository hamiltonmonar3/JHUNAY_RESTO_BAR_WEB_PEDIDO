ALTER TABLE public.reservations
  ADD COLUMN table_id integer REFERENCES public.restaurant_tables(id) ON DELETE RESTRICT;

CREATE INDEX reservations_table_id_idx ON public.reservations (table_id);

DROP POLICY IF EXISTS reservations_staff_manage ON public.reservations;
CREATE POLICY reservations_staff_read
  ON public.reservations FOR SELECT TO authenticated
  USING (public.current_staff_role() IN ('Administrador', 'Operador'));

REVOKE INSERT, UPDATE, DELETE ON public.reservations FROM authenticated;

CREATE OR REPLACE FUNCTION public.save_reservation(
  p_reservation_id bigint,
  p_table_id integer,
  p_customer_name text,
  p_phone text,
  p_reservation_date date,
  p_reservation_time time,
  p_people_count integer,
  p_deposit numeric,
  p_notes text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_old_table_id integer;
  v_table_status text;
  v_reservation_id bigint;
BEGIN
  IF COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Administrator or operator role is required' USING ERRCODE = '42501';
  END IF;
  IF p_table_id IS NULL OR p_customer_name IS NULL OR btrim(p_customer_name) = ''
    OR p_reservation_date IS NULL OR p_reservation_time IS NULL
    OR p_people_count IS NULL OR p_people_count < 1
    OR p_deposit IS NULL OR p_deposit < 0 THEN
    RAISE EXCEPTION 'Invalid reservation details';
  END IF;

  IF p_reservation_id IS NOT NULL THEN
    SELECT table_id INTO v_old_table_id
    FROM public.reservations
    WHERE id = p_reservation_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reservation not found';
    END IF;
  END IF;

  SELECT status INTO v_table_status
  FROM public.restaurant_tables
  WHERE id = p_table_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Table not found';
  END IF;
  IF v_table_status <> 'disponible'
    AND NOT (v_table_status = 'reservada' AND v_old_table_id = p_table_id) THEN
    RAISE EXCEPTION 'The selected table is not available';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.reservations
    WHERE table_id = p_table_id
      AND id IS DISTINCT FROM p_reservation_id
  ) THEN
    RAISE EXCEPTION 'The selected table already has a reservation';
  END IF;

  IF p_reservation_id IS NULL THEN
    INSERT INTO public.reservations (
      table_id, customer_name, phone, reservation_date, reservation_time,
      people_count, deposit, notes
    )
    VALUES (
      p_table_id, btrim(p_customer_name), NULLIF(btrim(p_phone), ''),
      p_reservation_date, p_reservation_time, p_people_count, p_deposit,
      NULLIF(btrim(p_notes), '')
    )
    RETURNING id INTO v_reservation_id;
  ELSE
    UPDATE public.reservations
    SET table_id = p_table_id,
        customer_name = btrim(p_customer_name),
        phone = NULLIF(btrim(p_phone), ''),
        reservation_date = p_reservation_date,
        reservation_time = p_reservation_time,
        people_count = p_people_count,
        deposit = p_deposit,
        notes = NULLIF(btrim(p_notes), '')
    WHERE id = p_reservation_id
    RETURNING id INTO v_reservation_id;
  END IF;

  UPDATE public.restaurant_tables
  SET status = 'reservada'
  WHERE id = p_table_id;

  IF v_old_table_id IS NOT NULL AND v_old_table_id <> p_table_id THEN
    UPDATE public.restaurant_tables
    SET status = 'disponible'
    WHERE id = v_old_table_id
      AND status = 'reservada'
      AND NOT EXISTS (
        SELECT 1 FROM public.reservations
        WHERE table_id = v_old_table_id
      );
  END IF;

  RETURN v_reservation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_reservation(p_reservation_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_table_id integer;
BEGIN
  IF COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Administrator or operator role is required' USING ERRCODE = '42501';
  END IF;

  SELECT table_id INTO v_table_id
  FROM public.reservations
  WHERE id = p_reservation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation not found';
  END IF;

  DELETE FROM public.reservations WHERE id = p_reservation_id;

  IF v_table_id IS NOT NULL THEN
    UPDATE public.restaurant_tables
    SET status = 'disponible'
    WHERE id = v_table_id
      AND status = 'reservada'
      AND NOT EXISTS (
        SELECT 1 FROM public.reservations
        WHERE table_id = v_table_id
      );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.save_reservation(bigint, integer, text, text, date, time, integer, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_reservation(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_reservation(bigint, integer, text, text, date, time, integer, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_reservation(bigint) TO authenticated;
