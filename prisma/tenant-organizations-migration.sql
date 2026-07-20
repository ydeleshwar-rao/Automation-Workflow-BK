-- Enterprise tenant support
-- Run this once in Supabase SQL Editor before using organization-scoped auth.

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists organization_id uuid;

create index if not exists idx_profiles_organization_id
  on public.profiles (organization_id);

-- Backfill existing profiles into one initial organization so the new column
-- can be enforced as NOT NULL. New company admins created through /auth/setup
-- get their own organization automatically.
insert into public.organizations (name, owner_id)
select
  'Default Organization',
  (select id from public.profiles where role = 'admin' order by created_at asc limit 1)
where not exists (select 1 from public.organizations);

update public.profiles
set organization_id = (select id from public.organizations order by created_at asc limit 1)
where organization_id is null;

alter table public.profiles
  alter column organization_id set not null;

alter table public.profiles
  drop constraint if exists profiles_organization_id_fkey;

alter table public.profiles
  add constraint profiles_organization_id_fkey
  foreign key (organization_id)
  references public.organizations(id)
  on delete cascade;

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function public.set_updated_at();

-- Update the auth.users trigger so future Supabase users are created with an
-- organization_id. This is required because profiles.organization_id is NOT NULL.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  org_id uuid;
begin
  org_id := nullif(new.raw_user_meta_data->>'organization_id', '')::uuid;

  if org_id is null then
    insert into public.organizations (name, owner_id)
    values (
      coalesce(new.raw_user_meta_data->>'organization_name', split_part(new.email, '@', 1) || '''s Organization'),
      new.id
    )
    returning id into org_id;
  end if;

  insert into public.profiles (id, email, full_name, role, organization_id, is_active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'role', 'developer'),
    org_id,
    true
  )
  on conflict (id) do update
  set
    email = excluded.email,
    full_name = excluded.full_name,
    role = excluded.role,
    organization_id = excluded.organization_id,
    is_active = excluded.is_active;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
