-- Ejecutar esto en Supabase → SQL Editor

create table if not exists profiles (
  id uuid references auth.users on delete cascade,
  email text,
  nombre text,
  plan text default 'free',
  analisis_hoy integer default 0,
  fecha_reset timestamptz default now(),
  primary key (id)
);

alter table profiles enable row level security;

create policy "Users can read own profile"
  on profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id);
