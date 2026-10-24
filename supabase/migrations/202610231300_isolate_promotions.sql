-- Keep promotions available as an independent catalog, without changing order prices.
-- Existing order RPCs call this function, so retain it as a base-price compatibility shim.
CREATE OR REPLACE FUNCTION public.compute_discounted_price(
  p_product_id integer,
  p_base_price numeric
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN p_base_price;
END;
$$;
