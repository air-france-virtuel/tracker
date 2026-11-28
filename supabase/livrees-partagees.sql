-- Livrées partagées par la direction : le fichier est rangé dans le stockage « livrees » (en morceaux de 40 Mo,
-- la limite du plan gratuit étant de 50 Mo par fichier), et la liste ci-dessous les fait apparaître chez tous les pilotes.
insert into storage.buckets (id, name, public, file_size_limit)
values ('livrees', 'livrees', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;

-- seule la direction écrit dans le stockage des livrées ; tout le monde peut télécharger (stockage public)
drop policy if exists livrees_admin_insert on storage.objects;
create policy livrees_admin_insert on storage.objects for insert to authenticated with check (bucket_id = 'livrees' and public.is_admin());
drop policy if exists livrees_admin_update on storage.objects;
create policy livrees_admin_update on storage.objects for update to authenticated using (bucket_id = 'livrees' and public.is_admin()) with check (bucket_id = 'livrees' and public.is_admin());
drop policy if exists livrees_admin_delete on storage.objects;
create policy livrees_admin_delete on storage.objects for delete to authenticated using (bucket_id = 'livrees' and public.is_admin());

create table if not exists public.shared_liveries (
  id text primary key check (id ~ '^partage-[a-z0-9-]{1,50}$'),
  name text not null check (char_length(name) between 1 and 80),
  type text not null default 'A320' check (type in ('A320', 'B77W', 'AUTRE')),
  creator text not null default '' check (char_length(creator) <= 60),
  folder text not null check (folder ~ '^[^/\\\\:*?"<>|]{1,80}$' and folder not in ('.', '..')),
  version text not null default '1' check (char_length(version) <= 20),
  parts smallint not null check (parts between 1 and 10),
  size bigint not null check (size between 1 and 400000000),
  image boolean not null default false,
  shared_by text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.shared_liveries enable row level security;
drop policy if exists sl_read on public.shared_liveries;
create policy sl_read on public.shared_liveries for select to authenticated using (active or public.is_admin());
drop policy if exists sl_write on public.shared_liveries;
create policy sl_write on public.shared_liveries for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.sl_touch() returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.shared_by := coalesce((select pseudo from public.pilots where id = auth.uid()), new.shared_by);
  return new;
end $$;
drop trigger if exists sl_touch on public.shared_liveries;
create trigger sl_touch before insert or update on public.shared_liveries for each row execute function public.sl_touch();
-- la direction doit aussi pouvoir lire le stockage (remplacer une livrée renvoyée, nettoyer une livrée retirée)
drop policy if exists livrees_admin_select on storage.objects;
create policy livrees_admin_select on storage.objects for select to authenticated using (bucket_id = 'livrees' and public.is_admin());
