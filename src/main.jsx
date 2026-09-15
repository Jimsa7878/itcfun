import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { supabase } from './lib/supabase';

const CATEGORIES = [
  { name: 'SONG TITLE', color: 'green', icon: '♫', rule: 'Name the song.' },
  { name: 'EXACT YEAR', color: 'pink', icon: '#', rule: 'Name the release year.' },
  { name: 'ARTIST / BAND', color: 'yellow', icon: '★', rule: 'Name the artist or band.' },
  { name: 'DECADE', color: 'purple', icon: '◉', rule: 'Name the release decade.' },
  { name: 'YEAR +/- 3', color: 'blue', icon: '±', rule: 'Within 3 years is correct.' }
];
const BOARD_SIZE = 25;
const STORAGE_KEY = 'itcfun-local-state';

function hashSeed(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed || 1;
  return () => {
    value = Math.imul(1664525, value) + 1013904223;
    return (value >>> 0) / 4294967296;
  };
}

function createBoard(roomCode, teamName) {
  const random = seededRandom(hashSeed(`${roomCode}:${teamName.trim().toLowerCase()}`));
  const colors = Array.from({ length: BOARD_SIZE }, (_, index) => CATEGORIES[index % CATEGORIES.length].color);
  for (let index = colors.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [colors[index], colors[swapIndex]] = [colors[swapIndex], colors[index]];
  }
  return colors.map((color, index) => ({ id: index, color, marked: false }));
}

function createRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getStoredState() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function App() {
  const [view, setView] = useState('landing');
  const [roomCode, setRoomCode] = useState('');
  const [hostRoomId, setHostRoomId] = useState(null);
  const [teams, setTeams] = useState([]);
  const [teamName, setTeamName] = useState('');
  const [teamId, setTeamId] = useState(null);
  const [board, setBoard] = useState([]);
  const [marked, setMarked] = useState([]);
  const [message, setMessage] = useState('');
  const [hostRound, setHostRound] = useState({ category: CATEGORIES[0], phase: 'ready', remaining: 45 });
  const [remoteRound, setRemoteRound] = useState({ category: CATEGORIES[0], phase: 'ready', remaining: 45 });

  const bingoLines = useMemo(() => {
    const lines = [];
    for (let index = 0; index < 5; index += 1) {
      lines.push([0, 1, 2, 3, 4].map((offset) => index * 5 + offset));
      lines.push([0, 1, 2, 3, 4].map((offset) => offset * 5 + index));
    }
    lines.push([0, 6, 12, 18, 24]);
    lines.push([4, 8, 12, 16, 20]);
    return lines;
  }, []);

  const completedLines = useMemo(() => bingoLines.filter((line) => line.every((index) => marked.includes(index))), [bingoLines, marked]);
  const hasBingo = completedLines.length > 0;

  useEffect(() => {
    const saved = getStoredState();
    if (saved.view === 'team' && saved.roomCode && saved.teamName) {
      setView('team');
      setRoomCode(saved.roomCode);
      setTeamName(saved.teamName);
      setBoard(createBoard(saved.roomCode, saved.teamName));
      setMarked(saved.marked || []);
    }
  }, []);

  useEffect(() => {
    if (view === 'team' && roomCode && teamName) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ view, roomCode, teamName, marked }));
    }
  }, [view, roomCode, teamName, marked]);

  const saveRound = async (nextRound) => {
    if (!hostRoomId) return;
    await supabase.from('rooms').update({ category: nextRound.category.name, phase: nextRound.phase, remaining: nextRound.remaining }).eq('id', hostRoomId);
  };

  useEffect(() => {
    if (view !== 'host' || !hostRoomId || !['countdown', 'running'].includes(hostRound.phase)) return undefined;
    const timer = window.setInterval(() => {
      setHostRound((current) => {
        const nextRound = current.remaining <= 1
          ? { ...current, phase: current.phase === 'countdown' ? 'running' : 'done', remaining: current.phase === 'countdown' ? 45 : 0 }
          : { ...current, remaining: current.remaining - 1 };
        saveRound(nextRound);
        return nextRound;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [view, hostRoomId, hostRound.phase]);

  useEffect(() => {
    if (view !== 'team' || !roomCode) return undefined;
    let active = true;
    const loadRound = async () => {
      const { data } = await supabase.from('rooms').select('id, category, phase, remaining').eq('code', roomCode).maybeSingle();
      if (active && data) setRemoteRound({ category: CATEGORIES.find((item) => item.name === data.category) || CATEGORIES[0], phase: data.phase, remaining: data.remaining });
    };
    loadRound();
    const channel = supabase.channel(`team-round-${roomCode}`).on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${roomCode}` }, (payload) => {
      const next = payload.new;
      setRemoteRound({ category: CATEGORIES.find((item) => item.name === next.category) || CATEGORIES[0], phase: next.phase, remaining: next.remaining });
    }).subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [view, roomCode]);

  useEffect(() => {
    if (view !== 'host' || !hostRoomId) return undefined;
    let active = true;
    const loadTeams = async () => {
      const { data } = await supabase.from('teams').select('id, name, marked_cells').eq('room_id', hostRoomId).order('created_at');
      if (active) setTeams(data || []);
    };
    loadTeams();
    const channel = supabase.channel(`host-teams-${hostRoomId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: `room_id=eq.${hostRoomId}` }, loadTeams).subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [view, hostRoomId]);

  const enterTeam = async (event) => {
    event.preventDefault();
    const cleanRoom = roomCode.trim().toUpperCase();
    const cleanTeam = teamName.trim();
    if (!cleanRoom || !cleanTeam) {
      setMessage('Enter a room code and team name first.');
      return;
    }
    setMessage('Connecting to room...');
    const { data: room, error: roomError } = await supabase.from('rooms').select('id, code, category, phase, remaining').eq('code', cleanRoom).maybeSingle();
    if (roomError || !room) {
      setMessage(roomError?.message || 'Room not found. Check the code and try again.');
      return;
    }
    const nextBoard = createBoard(cleanRoom, cleanTeam);
    const { data: team, error: teamError } = await supabase.from('teams').upsert({ room_id: room.id, name: cleanTeam, board_colors: nextBoard.map((cell) => cell.color) }, { onConflict: 'room_id,name' }).select('id, marked_cells').single();
    if (teamError) {
      setMessage(teamError.message);
      return;
    }
    setRoomCode(cleanRoom);
    setTeamName(cleanTeam);
    setTeamId(team.id);
    setBoard(nextBoard);
    setMarked(team.marked_cells || []);
    setRemoteRound({ category: CATEGORIES.find((item) => item.name === room.category) || CATEGORIES[0], phase: room.phase, remaining: room.remaining });
    setMessage('');
    setView('team');
  };

  const createHostRoom = async () => {
    const nextRoomCode = createRoomCode();
    const nextRound = { category: CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)], phase: 'ready', remaining: 45 };
    setMessage('Creating room...');
    const { data: room, error } = await supabase.from('rooms').insert({ code: nextRoomCode, category: nextRound.category.name, phase: nextRound.phase, remaining: nextRound.remaining }).select('id').single();
    if (error) {
      setMessage(error.message);
      return;
    }
    setRoomCode(nextRoomCode);
    setHostRoomId(room.id);
    setTeams([]);
    setHostRound(nextRound);
    setMessage('');
    setView('host');
  };

  const startHostRound = () => {
    const nextRound = { ...hostRound, phase: 'countdown', remaining: 3 };
    setHostRound(nextRound);
    saveRound(nextRound);
  };

  const newHostRound = async () => {
    const nextRound = { category: CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)], phase: 'ready', remaining: 45 };
    setHostRound(nextRound);
    await saveRound(nextRound);
  };

  const toggleCell = async (cellId) => {
    const nextMarked = marked.includes(cellId) ? marked.filter((id) => id !== cellId) : [...marked, cellId];
    setMarked(nextMarked);
    if (teamId) await supabase.from('teams').update({ marked_cells: nextMarked }).eq('id', teamId);
  };

  const resetBoard = async () => {
    setMarked([]);
    if (teamId) await supabase.from('teams').update({ marked_cells: [] }).eq('id', teamId);
  };
  const leaveTeam = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setView('landing');
    setMarked([]);
    setBoard([]);
    setTeamId(null);
  };

  if (view === 'landing') {
    return (
      <main className="shell shell--landing">
        <header className="brand"><span className="brand-dot">ITC</span><span>ITCFun</span></header>
        <section className="hero">
          <img className="disco-ball disco-ball--landing" src="/discoball.gif" alt="" aria-hidden="true" />
          <p className="eyebrow">Digital team bingo</p>
          <h1>Play the room.<br /><em>Own the board.</em></h1>
          <p className="hero-copy">Create a room for your teams or join with a code. Every team gets its own randomized Hitster Bingo board.</p>
          <div className="landing-actions">
            <button className="button button--primary" onClick={createHostRoom}>CREATE HOST ROOM</button>
            <button className="button button--secondary" onClick={() => setView('join')}>JOIN A ROOM</button>
          </div>
          {message && <p className="form-message">{message}</p>}
        </section>
        <footer className="micro-copy">Five PDF categories · Randomized team boards · Instant bingo</footer>
      </main>
    );
  }

  if (view === 'join') {
    return (
      <main className="shell shell--centered">
        <header className="brand"><span className="brand-dot">ITC</span><span>ITCFun</span></header>
        <form className="join-card" onSubmit={enterTeam}>
          <p className="eyebrow">Join the game</p>
          <h1>Find your team board.</h1>
          <label>Room code<input value={roomCode} onChange={(event) => setRoomCode(event.target.value)} placeholder="ABC123" maxLength="6" /></label>
          <label>Team name<input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="The Vinyl Squad" maxLength="24" /></label>
          {message && <p className="form-message">{message}</p>}
          <button className="button button--primary" type="submit">OPEN MY BOARD</button>
          <button className="text-button" type="button" onClick={() => setView('landing')}>Back</button>
        </form>
      </main>
    );
  }

  if (view === 'host') {
    const countdownText = hostRound.phase === 'countdown' ? hostRound.remaining : hostRound.phase === 'done' ? "TIME'S UP" : hostRound.remaining;
    return (
      <main className="shell shell--game">
        <header className="game-header"><div className="brand"><span className="brand-dot">ITC</span><span>ITCFun</span></div><div className="room-pill">ROOM <strong>{roomCode}</strong></div></header>
        <section className="host-stage">
          <img className="disco-ball disco-ball--host" src="/discoball.gif" alt="" aria-hidden="true" />
          <p className="eyebrow">Host control</p>
          <h1>{hostRound.category.name}</h1>
          <div className={`host-timer ${hostRound.phase === 'done' ? 'host-timer--done' : ''}`}>{countdownText}</div>
          <p>{hostRound.phase === 'ready' ? 'Category ready. Start when every team is set.' : hostRound.phase === 'running' ? '45 seconds on the clock.' : hostRound.phase === 'countdown' ? 'Get ready...' : "Time's up. Reveal the answer out loud."}</p>
          <div className="host-actions"><button className="button button--primary" onClick={startHostRound} disabled={hostRound.phase === 'countdown' || hostRound.phase === 'running'}>{hostRound.phase === 'done' ? 'START AGAIN' : 'START ROUND'}</button><button className="button button--secondary" onClick={newHostRound}>NEW CATEGORY</button></div>
        </section>
        <section className="teams-panel">
          <div className="teams-panel__header"><div><p className="eyebrow">Live room</p><h2>Teams in the room</h2></div><strong>{teams.length}/15</strong></div>
          {teams.length === 0 ? <p className="empty-state">Waiting for teams to join with the room code.</p> : <div className="team-list">{teams.map((team) => <div className="team-row" key={team.id}><span className="team-name">{team.name}</span><span className="team-progress">{(team.marked_cells || []).length}/25 marked</span></div>)}</div>}
        </section>
        <p className="micro-copy">Share room code <strong>{roomCode}</strong> with every team.</p>
      </main>
    );
  }

  const categoryByColor = Object.fromEntries(CATEGORIES.map((categoryItem) => [categoryItem.color, categoryItem]));
  return (
    <main className="shell shell--game">
      <header className="game-header"><div className="brand"><span className="brand-dot">ITC</span><span>ITCFun</span></div><div className="room-pill">ROOM <strong>{roomCode}</strong></div></header>
      <section className={`round-strip round-strip--${remoteRound.phase}`}>
        <div><p className="eyebrow">Host challenge</p><strong>{remoteRound.category.name}</strong></div>
        <div className="round-strip__timer">{remoteRound.phase === 'done' ? "TIME'S UP" : remoteRound.phase === 'ready' ? 'READY' : remoteRound.remaining}</div>
      </section>
      <section className="board-header"><div><p className="eyebrow">Team board</p><h1>{teamName}</h1></div><div className={`bingo-badge ${hasBingo ? 'bingo-badge--active' : ''}`}>{hasBingo ? 'BINGO!' : `${completedLines.length} LINES`}</div></section>
      <section className="legend">{CATEGORIES.map((categoryItem) => <span key={categoryItem.name}><i className={`swatch swatch--${categoryItem.color}`} />{categoryItem.name}</span>)}</section>
      <section className="board" aria-label={`${teamName} bingo board`}>{board.map((cell) => { const categoryItem = categoryByColor[cell.color]; return <button key={cell.id} className={`board-cell board-cell--${cell.color} ${marked.includes(cell.id) ? 'board-cell--marked' : ''}`} onClick={() => toggleCell(cell.id)} aria-label={`${categoryItem.name}, ${marked.includes(cell.id) ? 'marked' : 'unmarked'}`}><span>{categoryItem.icon}</span><small>{marked.includes(cell.id) ? 'DONE' : categoryItem.name}</small></button>; })}</section>
      <div className="board-actions"><button className="button button--secondary" onClick={resetBoard}>RESET MARKS</button><button className="text-button" onClick={leaveTeam}>Leave room</button></div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
