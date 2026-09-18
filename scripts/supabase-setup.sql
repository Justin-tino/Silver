-- ============================================================
-- scripts/supabase-setup.sql
-- SilverCare — Senior Data Mirror
-- ------------------------------------------------------------
-- Run ONCE in the Supabase SQL Editor:
--   Dashboard -> SQL Editor -> New query -> paste -> RUN
--
-- Creates the public.seniors table that lib/supabaseDatabase.js
-- mirrors senior data into:
--     username   = login email
--     senior_id  = OSCA senior citizen ID
--     id_number  = government / verification ID number
--     face_path  = face image inside the private "seniors" bucket
--
-- Firebase RTDB stays the source of truth; this table is a mirror.
-- Re-running is safe (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ============================================================

create table if not exists public.seniors (
    uid            text primary key,
    username       text,
    full_name      text not null default 'Unnamed Senior',
    senior_id      text,
    id_number      text,
    face_path      text,
    email          text,
    cp_number      text,
    address        text,
    barangay       text,
    city           text,
    province       text,
    dob            text,
    sex            text,
    civil_status   text,
    kyc_status     text default 'Pending',
    life_status    text default 'Active',
    registered_by  text,
    created_at     timestamptz not null default now(),
    synced_at      timestamptz not null default now()
);

alter table public.seniors add column if not exists health_condition text;
alter table public.seniors add column if not exists id_front_path text;
alter table public.seniors add column if not exists id_back_path text;
alter table public.seniors add column if not exists med_cert_path text;
alter table public.seniors add column if not exists med_cert_name text;
alter table public.seniors add column if not exists updated_at timestamptz not null default now();

create index if not exists seniors_senior_id_idx on public.seniors (senior_id);
create index if not exists seniors_username_idx  on public.seniors (username);

-- ------------------------------------------------------------
-- Row Level Security: the table is writable/readable ONLY through
-- the service-role key used by the SilverCare backend. No anon or
-- authenticated policies are created on purpose.
-- ------------------------------------------------------------
alter table public.seniors enable row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename  = 'seniors'
          and policyname = 'service role full access'
    ) then
        create policy "service role full access" on public.seniors
            for all to service_role
            using (true)
            with check (true);
    end if;
end $$;
