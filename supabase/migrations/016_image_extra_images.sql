-- Image sets: one gallery entry can carry several images that share its
-- prompt and metadata. The row's own url stays the cover; extra_images holds
-- the rest in display order as [{ "url": text, "width": int, "height": int }].

alter table public.images
  add column if not exists extra_images jsonb not null default '[]'::jsonb;

alter table public.images
  drop constraint if exists images_extra_images_is_array;

alter table public.images
  add constraint images_extra_images_is_array
  check (jsonb_typeof(extra_images) = 'array');
