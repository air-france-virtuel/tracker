-- Chat des pilotes Air France Virtuel (Supabase)
-- À coller une seule fois dans Supabase > SQL Editor > Run.
-- Sécurité : chaque pilote a un compte anonyme ; tout est contrôlé ici, côté serveur,
-- même si quelqu'un modifie son tracker.

-- ---------- tables ----------
create table if not exists public.pilots (
  id uuid primary key references auth.users on delete cascade,
  pseudo text not null check (char_length(pseudo) between 2 and 32),
  grade text check (grade is null or char_length(grade) <= 40),
  banned boolean not null default false,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null default auth.uid() references public.pilots(id) on delete cascade,
  pseudo text not null,
  grade text,
  admin boolean not null default false,
  flight text check (flight is null or char_length(flight) <= 60),
  body text not null check (char_length(body) between 1 and 500),
  deleted boolean not null default false
);
create index if not exists messages_created_idx on public.messages (created_at desc);

create table if not exists public.reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  message_id bigint not null references public.messages(id) on delete cascade,
  reporter uuid not null default auth.uid(),
  reason text check (reason is null or char_length(reason) <= 200),
  unique (message_id, reporter)
);

alter table public.pilots enable row level security;
alter table public.messages enable row level security;
alter table public.reports enable row level security;

-- ---------- fonctions d'aide ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.pilots where id = auth.uid()), false)
$$;

-- ---------- droits ----------
revoke all on public.pilots, public.messages, public.reports from anon, authenticated;
grant select, insert on public.pilots to authenticated;
grant update (id, pseudo, grade) on public.pilots to authenticated; -- id : nécessaire à l’« upsert », protégé par pilots_update
grant select, insert on public.messages to authenticated;
grant select, insert on public.reports to authenticated;

drop policy if exists pilots_read on public.pilots;
create policy pilots_read on public.pilots for select to authenticated using (true);
drop policy if exists pilots_insert on public.pilots;
create policy pilots_insert on public.pilots for insert to authenticated
  with check (id = auth.uid() and banned = false and is_admin = false);
drop policy if exists pilots_update on public.pilots;
create policy pilots_update on public.pilots for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (true);
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert to authenticated with check (reporter = auth.uid());
drop policy if exists reports_read on public.reports;
create policy reports_read on public.reports for select to authenticated using (public.is_admin());

-- ---------- contrôle de chaque message (anti-usurpation, bannis, anti-spam) ----------
create or replace function public.messages_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare p public.pilots;
begin
  select * into p from public.pilots where id = auth.uid();
  if p.id is null then raise exception 'Profil pilote manquant'; end if;
  if p.banned then raise exception 'Tu as été exclu du chat par la direction.'; end if;
  if exists (select 1 from public.messages where user_id = p.id and created_at > now() - interval '3 seconds') then
    raise exception 'Doucement : attends quelques secondes entre deux messages.';
  end if;
  if (select count(*) from public.messages where user_id = p.id and created_at > now() - interval '1 minute') >= 12 then
    raise exception 'Trop de messages en une minute. Patiente un peu.';
  end if;
  new.user_id := p.id;            -- impossible d'écrire au nom d'un autre
  new.pseudo := p.pseudo;         -- le nom vient du profil, pas du message
  new.grade := p.grade;
  new.admin := p.is_admin;        -- badge « Direction » réservé aux admins
  new.deleted := false;
  new.created_at := now();
  new.body := btrim(new.body);
  return new;
end $$;
drop trigger if exists messages_before_insert on public.messages;
create trigger messages_before_insert before insert on public.messages
  for each row execute function public.messages_before_insert();

-- un pilote ne peut pas se donner lui-même les droits admin ni se débannir
create or replace function public.pilots_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and current_user = 'authenticated' then
    new.banned := old.banned; new.is_admin := old.is_admin;
  end if;
  return new;
end $$;
drop trigger if exists pilots_guard on public.pilots;
create trigger pilots_guard before update on public.pilots
  for each row execute function public.pilots_guard();

-- ---------- modération (réservée aux admins) ----------
create or replace function public.hide_message(mid bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à la direction'; end if;
  update public.messages set deleted = true where id = mid;
end $$;

create or replace function public.ban_pilot(target uuid, ban boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à la direction'; end if;
  update public.pilots set banned = ban where id = target and is_admin = false;
  if ban then update public.messages set deleted = true where user_id = target and created_at > now() - interval '1 day'; end if;
end $$;

revoke all on function public.hide_message(bigint), public.ban_pilot(uuid, boolean) from public, anon;
grant execute on function public.hide_message(bigint), public.ban_pilot(uuid, boolean) to authenticated;

-- ---------- temps réel ----------
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null; end $$;

-- ---------- ménage : messages de plus de 60 jours (lancé par le tracker d'un admin) ----------
create or replace function public.purge_old_messages() returns void
language sql security definer set search_path = public as $$
  delete from public.messages where created_at < now() - interval '60 days' and public.is_admin();
$$;
grant execute on function public.purge_old_messages() to authenticated;
