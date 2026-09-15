create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null check (code ~ '^[0-9]{4}$'),
  host_token uuid not null default gen_random_uuid(),
  category text not null default 'SONG TITLE',
  phase text not null default 'ready' check (phase in ('ready', 'countdown', 'running', 'done')),
  remaining integer not null default 45 check (remaining between 0 and 90),
  created_at timestamptz not null default now()
);

-- Keep an existing Supabase project aligned with the four-digit room codes.
alter table public.rooms drop constraint if exists rooms_code_check;
alter table public.rooms add constraint rooms_code_check check (code ~ '^[0-9]{4}$');

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  board_colors jsonb not null,
  marked_cells integer[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (room_id, name)
);

create index if not exists teams_room_id_idx on public.teams(room_id);

alter table public.rooms enable row level security;
alter table public.teams enable row level security;

drop policy if exists "Anyone can read rooms by code" on public.rooms;
drop policy if exists "Anyone can create rooms" on public.rooms;
drop policy if exists "Hosts can update room state" on public.rooms;
drop policy if exists "Anyone can join a room" on public.teams;
drop policy if exists "Anyone can read teams in a room" on public.teams;
drop policy if exists "Teams can update their board marks" on public.teams;

create policy "Anyone can read rooms by code"
  on public.rooms for select
  using (true);

create policy "Anyone can create rooms"
  on public.rooms for insert
  with check (true);

create policy "Hosts can update room state"
  on public.rooms for update
  using (true)
  with check (true);

create policy "Anyone can join a room"
  on public.teams for insert
  with check (true);

create policy "Anyone can read teams in a room"
  on public.teams for select
  using (true);

create policy "Teams can update their board marks"
  on public.teams for update
  using (true)
  with check (true);

alter table public.rooms replica identity full;
alter table public.teams replica identity full;

-- Enable Realtime for cross-device room updates.
do $$
begin
  if not exists (
    select 1
    from pg_publication_rel as publication_relation
    join pg_publication as publication on publication.oid = publication_relation.prpubid
    where publication.pubname = 'supabase_realtime'
      and publication_relation.prrelid = 'public.rooms'::regclass
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
  if not exists (
    select 1
    from pg_publication_rel as publication_relation
    join pg_publication as publication on publication.oid = publication_relation.prpubid
    where publication.pubname = 'supabase_realtime'
      and publication_relation.prrelid = 'public.teams'::regclass
  ) then
    alter publication supabase_realtime add table public.teams;
  end if;
end $$;
