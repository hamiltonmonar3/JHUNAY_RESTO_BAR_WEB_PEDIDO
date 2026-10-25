CREATE OR REPLACE FUNCTION public.get_order_waiter_names(
  p_order_ids integer[]
)
RETURNS TABLE(order_id integer, full_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.current_staff_id() IS NULL
    OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT order_row.id, staff.full_name::text
  FROM public.orders AS order_row
  JOIN public.users AS staff ON staff.id = order_row.user_id
  WHERE order_row.id = ANY(COALESCE(p_order_ids, ARRAY[]::integer[]));
END;
$$;

REVOKE ALL ON FUNCTION public.get_order_waiter_names(integer[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_order_waiter_names(integer[]) TO authenticated;
