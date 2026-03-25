-- Companies table — one row per organization
create table if not exists companies (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  name_lower text generated always as (lower(trim(name))) stored,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- Unique on lowercased name so "IVC Auto Tech" and "ivc auto tech" can't both exist
create unique index if not exists companies_name_lower_idx on companies(name_lower);

-- Add company_id to profiles (nullable — not everyone belongs to a company)
alter table profiles add column if not exists company_id uuid references companies(id);

-- Company templates — templates shared across all members of a company
create table if not exists company_templates (
  id uuid default gen_random_uuid() primary key,
  company_id uuid not null references companies(id) on delete cascade,
  template_name text not null,
  file_name text,
  file_type text,
  storage_path text,
  field_config jsonb,
  mode text default 'template',
  created_at timestamptz default now()
);

create index if not exists company_templates_company_idx on company_templates(company_id);

-- RLS policies

-- Companies: anyone can read (for lookup during signup), only authenticated users can insert
alter table companies enable row level security;

create policy "Companies are viewable by everyone"
  on companies for select
  using (true);

create policy "Authenticated users can create companies"
  on companies for insert
  with check (auth.role() = 'authenticated');

-- Company templates: members of the company can read, admins (created_by) can manage
alter table company_templates enable row level security;

create policy "Company members can view templates"
  on company_templates for select
  using (
    company_id in (
      select company_id from profiles where id = auth.uid() and company_id is not null
    )
  );

create policy "Company creator can manage templates"
  on company_templates for all
  using (
    company_id in (
      select id from companies where created_by = auth.uid()
    )
  );

-- Add job_type column to jobs table (defaults to 'template' for existing jobs)
alter table jobs add column if not exists job_type text default 'template';

-- Allow anon key to search companies by name (for signup flow)
-- This uses the existing anon role through Supabase's API
