-- Migration for existing projects: adds the KYC Step 3 + Step 4 columns
-- without touching existing data. Safe to run multiple times.
alter table public.seniors add column if not exists health_condition text;
alter table public.seniors add column if not exists id_front_path text;
alter table public.seniors add column if not exists id_back_path text;
alter table public.seniors add column if not exists med_cert_path text;
alter table public.seniors add column if not exists med_cert_name text;
alter table public.seniors add column if not exists updated_at timestamptz not null default now();
