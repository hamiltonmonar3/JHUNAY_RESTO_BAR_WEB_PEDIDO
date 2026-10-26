ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS top_viewer boolean NOT NULL DEFAULT true;

GRANT INSERT (top_viewer) ON TABLE public.products TO authenticated;
GRANT UPDATE (top_viewer) ON TABLE public.products TO authenticated;
