create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null check (code ~ '^[0-9]{4}$'),
  host_token uuid not null default gen_random_uuid(),
  host_user_id uuid,
  category text not null default 'SONG TITLE',
  phase text not null default 'ready' check (phase in ('ready', 'countdown', 'running', 'done')),
  remaining integer not null default 45 check (remaining between 0 and 90),
  duration integer not null default 45 check (duration in (15, 30, 45, 60)),
  created_at timestamptz not null default now()
);

-- Keep an existing Supabase project aligned with the four-digit room codes.
alter table public.rooms drop constraint if exists rooms_code_check;

do $$
declare
  room_record record;
  next_code text;
begin
  for room_record in select id from public.rooms where code !~ '^[0-9]{4}$' loop
    loop
      next_code := floor(1000 + random() * 9000)::int::text;
      exit when not exists (select 1 from public.rooms where code = next_code);
    end loop;
    update public.rooms set code = next_code where id = room_record.id;
  end loop;
end $$;

alter table public.rooms add constraint rooms_code_check check (code ~ '^[0-9]{4}$');
alter table public.rooms add column if not exists host_user_id uuid;
alter table public.rooms add column if not exists duration integer not null default 45;
alter table public.rooms drop constraint if exists rooms_duration_check;
alter table public.rooms add constraint rooms_duration_check check (duration in (15, 30, 45, 60));

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid,
  name text not null check (char_length(name) between 1 and 24),
  board_colors jsonb not null,
  marked_cells integer[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (room_id, name)
);

create index if not exists teams_room_id_idx on public.teams(room_id);

alter table public.teams add column if not exists user_id uuid;
alter table public.teams add column if not exists bingo_rank integer;

create or replace function public.update_team_marks(target_team_id uuid, next_marked_cells integer[])
returns table (id uuid, name text, marked_cells integer[], bingo_rank integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_room_id uuid;
  current_bingo_rank integer;
  next_bingo_rank integer;
  has_bingo boolean;
begin
  select teams.room_id, teams.bingo_rank
    into target_room_id, current_bingo_rank
    from public.teams
   where teams.id = target_team_id
     and teams.user_id = auth.uid();

  if target_room_id is null then
    raise exception 'Team not found or access denied';
  end if;

  has_bingo := next_marked_cells @> array[0, 1, 2, 3, 4]
    or next_marked_cells @> array[5, 6, 7, 8, 9]
    or next_marked_cells @> array[10, 11, 12, 13, 14]
    or next_marked_cells @> array[15, 16, 17, 18, 19]
    or next_marked_cells @> array[20, 21, 22, 23, 24]
    or next_marked_cells @> array[0, 5, 10, 15, 20]
    or next_marked_cells @> array[1, 6, 11, 16, 21]
    or next_marked_cells @> array[2, 7, 12, 17, 22]
    or next_marked_cells @> array[3, 8, 13, 18, 23]
    or next_marked_cells @> array[4, 9, 14, 19, 24]
    or next_marked_cells @> array[0, 6, 12, 18, 24]
    or next_marked_cells @> array[4, 8, 12, 16, 20];

  if current_bingo_rank is null and has_bingo then
    perform pg_advisory_xact_lock(hashtextextended(target_room_id::text, 0));
    select coalesce(max(teams.bingo_rank), 0) + 1
      into next_bingo_rank
      from public.teams
     where teams.room_id = target_room_id;
  end if;

  update public.teams
     set marked_cells = next_marked_cells,
         bingo_rank = case
           when cardinality(next_marked_cells) = 0 then null
           else coalesce(current_bingo_rank, next_bingo_rank)
         end
   where teams.id = target_team_id;

  return query
  select teams.id, teams.name, teams.marked_cells, teams.bingo_rank
    from public.teams
   where teams.id = target_team_id;
end;
$$;

grant execute on function public.update_team_marks(uuid, integer[]) to authenticated;

alter table public.rooms enable row level security;
alter table public.teams enable row level security;

drop policy if exists "Anyone can read rooms by code" on public.rooms;
drop policy if exists "Anyone can create rooms" on public.rooms;
drop policy if exists "Hosts can update room state" on public.rooms;
drop policy if exists "Anyone can join a room" on public.teams;
drop policy if exists "Anyone can read teams in a room" on public.teams;
drop policy if exists "Teams can update their board marks" on public.teams;
drop policy if exists "Hosts can read teams in their rooms" on public.teams;
drop policy if exists "Teams can read their own row" on public.teams;
drop policy if exists "Authenticated users can create rooms" on public.rooms;
drop policy if exists "Hosts can update their own room" on public.rooms;
drop policy if exists "Authenticated users can join rooms" on public.teams;
drop policy if exists "Teams can update their own board marks" on public.teams;

create policy "Anyone can read rooms by code"
  on public.rooms for select
  using (true);

create policy "Anyone can create rooms"
  on public.rooms for insert
  with check (host_user_id = auth.uid());

create policy "Hosts can update room state"
  on public.rooms for update
  using (host_user_id = auth.uid())
  with check (host_user_id = auth.uid());

create policy "Anyone can join a room"
  on public.teams for insert
  with check (user_id = auth.uid() and exists (select 1 from public.rooms where rooms.id = room_id));

create policy "Anyone can read teams in a room"
  on public.teams for select
  using (user_id = auth.uid() or exists (select 1 from public.rooms where rooms.id = room_id and rooms.host_user_id = auth.uid()));

create policy "Teams can update their board marks"
  on public.teams for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

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
