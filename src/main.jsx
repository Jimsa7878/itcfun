import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { ensureAnonymousSession, supabase } from './lib/supabase';

const CATEGORIES = [
  { name: 'SONG TITLE', color: 'green', icon: '♫', rule: 'Name the song.' },
  { name: 'EXACT YEAR', color: 'pink', icon: '#', rule: 'Name the release year.' },
  { name: 'ARTIST / BAND', displayName: 'ARTIST/\nBAND', color: 'yellow', icon: '★', rule: 'Name the artist or band.' },
  { name: 'DECADE', color: 'purple', icon: '◉', rule: 'Name the release decade.' },
  { name: 'YEAR +/- 3', color: 'blue', icon: '±', rule: 'Within 3 years is correct.' }
];
const BOARD_SIZE = 25;
const STORAGE_KEY = 'itcfun-local-state';
const DISCO_BALL_URL = `${import.meta.env.BASE_URL}discoball.gif`;

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
  return String(Math.floor(1000 + Math.random() * 9000));
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
  const [authUserId, setAuthUserId] = useState(null);
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
  const teamsWithBingo = teams.filter((team) => bingoLines.some((line) => line.every((index) => (team.marked_cells || []).includes(index))));

  useEffect(() => {
    let active = true;
    ensureAnonymousSession()
      .then((session) => {
        if (active) setAuthUserId(session.user.id);
      })
      .catch((error) => {
        console.error('Anonymous Supabase sign-in failed:', error);
        if (active) setMessage(`Secure connection failed: ${error.message}`);
      });
    return () => {
      active = false;
    };
  }, []);

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
    if (hostRound.phase === 'countdown' && hostRound.remaining === 0) {
      const goTimer = window.setTimeout(() => {
        const nextRound = { ...hostRound, phase: 'running', remaining: 45 };
        setHostRound(nextRound);
        saveRound(nextRound);
      }, 700);
      return () => window.clearTimeout(goTimer);
    }
    const timer = window.setInterval(() => {
      setHostRound((current) => {
        const nextRound = current.remaining <= 1
          ? current.phase === 'countdown'
            ? { ...current, remaining: 0 }
            : { ...current, phase: 'done', remaining: 0 }
          : { ...current, remaining: current.remaining - 1 };
        saveRound(nextRound);
        return nextRound;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [view, hostRoomId, hostRound.phase, hostRound.remaining]);

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
    const channel = supabase.channel(`host-teams-${hostRoomId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: `room_id=eq.${hostRoomId}` }, (payload) => {
      if (payload.eventType === 'DELETE') {
        setTeams((current) => current.filter((team) => team.id !== payload.old.id));
        return;
      }
      const nextTeam = { id: payload.new.id, name: payload.new.name, marked_cells: payload.new.marked_cells || [] };
      setTeams((current) => {
        const existing = current.some((team) => team.id === nextTeam.id);
        if (!existing) return [...current, nextTeam];
        return current.map((team) => team.id === nextTeam.id ? nextTeam : team);
      });
    }).subscribe();
    const refreshTimer = window.setInterval(loadTeams, 3000);
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      supabase.removeChannel(channel);
    };
  }, [view, hostRoomId]);

  useEffect(() => {
    if (view !== 'host') return undefined;
    const handleKeyDown = (event) => {
      if (event.code !== 'Space' || event.repeat) return;
      event.preventDefault();
      if (!['countdown', 'running'].includes(hostRound.phase)) newHostRound();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view, hostRound.phase]);

  const enterTeam = async (event) => {
    event.preventDefault();
    const cleanRoom = roomCode.trim().toUpperCase();
    const cleanTeam = teamName.trim();
    if (!/^\d{4}$/.test(cleanRoom) || !cleanTeam) {
      setMessage('Enter the four-digit room code and your team name first.');
      return;
    }
    if (!authUserId) {
      setMessage('Still connecting securely. Please try again in a moment.');
      return;
    }
    setMessage('Connecting to room...');
    const { data: room, error: roomError } = await supabase.from('rooms').select('id, code, category, phase, remaining').eq('code', cleanRoom).maybeSingle();
    if (roomError || !room) {
      setMessage(roomError?.message || 'Room not found. Check the code and try again.');
      return;
    }
    const nextBoard = createBoard(cleanRoom, cleanTeam);
    const { data: team, error: teamError } = await supabase.from('teams').upsert({ room_id: room.id, name: cleanTeam, user_id: authUserId, board_colors: nextBoard.map((cell) => cell.color) }, { onConflict: 'room_id,name' }).select('id, marked_cells').single();
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
    if (!authUserId) {
      setMessage('Still connecting securely. Please try again in a moment.');
      return;
    }
    const nextRoomCode = createRoomCode();
    const nextRound = { category: CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)], phase: 'ready', remaining: 45 };
    setMessage('Creating room...');
    const { data: room, error } = await supabase.from('rooms').insert({ code: nextRoomCode, host_user_id: authUserId, category: nextRound.category.name, phase: nextRound.phase, remaining: nextRound.remaining }).select('id').single();
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
    const nextRound = { category: CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)], phase: 'countdown', remaining: 3 };
    setHostRound(nextRound);
    await saveRound(nextRound);
  };

  const toggleCell = async (cellId) => {
    const nextMarked = marked.includes(cellId) ? marked.filter((id) => id !== cellId) : [...marked, cellId];
    setMarked(nextMarked);
    if (teamId && authUserId) await supabase.from('teams').update({ marked_cells: nextMarked }).eq('id', teamId).eq('user_id', authUserId);
  };

  const resetBoard = async () => {
    setMarked([]);
    if (teamId && authUserId) await supabase.from('teams').update({ marked_cells: [] }).eq('id', teamId).eq('user_id', authUserId);
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
        <header className="brand"><span className="brand-dot">ITC</span><span>HITSTER BINGO</span></header>
        <section className="landing-stage">
          <p className="panel-kicker">The music contest starts here</p>
          <h1>Welcome to<br /><em>ITC Hitster Bingo</em></h1>
          <div className="landing-disco-ball">
            <img src={DISCO_BALL_URL} alt="" aria-hidden="true" />
          </div>
          <div className="landing-actions">
            <button className="button button--primary" onClick={createHostRoom}>CREATE HOST ROOM</button>
            <button className="button button--secondary" onClick={() => setView('join')}>JOIN THE ROOM</button>
          </div>
          {message && <p className="form-message">{message}</p>}
        </section>
      </main>
    );
  }

  if (view === 'join') {
    return (
      <main className="shell shell--centered">
        <header className="brand"><span className="brand-dot">ITC</span><span>HITSTER BINGO</span></header>
        <form className="join-card" onSubmit={enterTeam}>
          <p className="eyebrow">Join the game</p>
          <h1>Find your team board.</h1>
          <label>Room code<input inputMode="numeric" pattern="[0-9]{4}" value={roomCode} onChange={(event) => setRoomCode(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="1234" maxLength="4" /></label>
          <label>Team name<input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="The Vinyl Squad" maxLength="24" /></label>
          {message && <p className="form-message">{message}</p>}
          <button className="button button--primary" type="submit">OPEN MY BOARD</button>
          <button className="text-button" type="button" onClick={() => setView('landing')}>Back</button>
        </form>
      </main>
    );
  }

  if (view === 'host') {
    const countdownText = hostRound.phase === 'countdown' && hostRound.remaining === 0 ? 'GO' : hostRound.phase === 'done' ? "TIME'S UP" : hostRound.remaining;
    return (
      <main className="shell shell--game shell--host">
        <header className="game-header"><div className="brand"><span className="brand-dot">ITC</span><span>HITSTER BINGO</span></div><div className="room-pill">ROOM <strong>{roomCode}</strong></div></header>
           <section className="host-stage host-stage--disco">
             <p className="panel-kicker">Next challenge</p>
             <div className={`host-category host-category--${hostRound.category.color} ${hostRound.phase === 'done' ? 'host-category--done' : ''}`}>
               {hostRound.phase !== 'done' && <span className="host-category__icon" aria-hidden="true">{hostRound.category.icon}</span>}
              <span>{hostRound.phase === 'done' ? "TIME'S UP!" : (hostRound.category.displayName || hostRound.category.name)}</span>
             </div>
             <div className={`host-disco-ball ${hostRound.phase === 'done' ? 'host-disco-ball--done' : ''}`}>
               <img className="host-disco-ball__image" src={DISCO_BALL_URL} alt="" aria-hidden="true" />
              <div className={`host-timer ${hostRound.phase === 'done' ? 'host-timer--done' : ''} ${hostRound.phase === 'countdown' && hostRound.remaining === 0 ? 'host-timer--go' : ''} ${hostRound.phase === 'running' && hostRound.remaining <= 5 ? 'host-timer--warning' : ''}`}>{countdownText}</div>
             </div>
          <p>{hostRound.phase === 'ready' ? 'Category ready. Start when every team is set.' : hostRound.phase === 'running' ? '45 seconds on the clock.' : hostRound.phase === 'countdown' ? 'Get ready...' : "Time's up. Reveal the answer out loud."}</p>
          <div className="host-actions"><button className="button button--primary" onClick={newHostRound}>START NEXT CATEGORY</button></div>
        </section>
        <section className="teams-panel">
          <div className="teams-panel__header"><div><p className="eyebrow">Live room</p><h2>Teams in the room</h2></div><strong>{teams.length}/15</strong></div>
          {teamsWithBingo.length > 0 && <div className="host-bingo-alert">BINGO! {teamsWithBingo.map((team) => team.name).join(', ')}</div>}
          {teams.length === 0 ? <p className="empty-state">Waiting for teams to join with the room code.</p> : <div className="team-list">{teams.map((team) => { const teamHasBingo = teamsWithBingo.some((winner) => winner.id === team.id); return <div className={`team-row ${teamHasBingo ? 'team-row--bingo' : ''}`} key={team.id}><span className="team-name">{team.name}{teamHasBingo && <strong className="team-row__bingo">BINGO!</strong>}</span><span className="team-progress">{(team.marked_cells || []).length}/25 marked</span></div>; })}</div>}
        </section>
      </main>
    );
  }

  const categoryByColor = Object.fromEntries(CATEGORIES.map((categoryItem) => [categoryItem.color, categoryItem]));
  return (
    <main className="shell shell--game shell--team">
      <header className="game-header"><div className="brand"><span className="brand-dot">ITC</span><span>HITSTER BINGO</span></div><div className="room-pill">ROOM <strong>{roomCode}</strong></div></header>
      <section className={`round-strip round-strip--${remoteRound.phase} ${remoteRound.phase === 'running' && remoteRound.remaining <= 5 ? 'round-strip--warning' : ''}`}>
        <div><p className="eyebrow">Host challenge</p><strong>{remoteRound.category.name}</strong></div>
        <div className="round-strip__timer">{remoteRound.phase === 'done' ? "TIME'S UP" : remoteRound.phase === 'ready' ? 'READY' : remoteRound.phase === 'countdown' && remoteRound.remaining === 0 ? 'GO' : remoteRound.remaining}</div>
      </section>
      <section className="board-header"><div><p className="eyebrow">Team board</p><h1>{teamName}</h1></div>{hasBingo && <div className="bingo-badge bingo-badge--active">BINGO!</div>}</section>
      <section className="legend">{CATEGORIES.map((categoryItem) => <span key={categoryItem.name}><i className={`swatch swatch--${categoryItem.color}`} />{categoryItem.name}</span>)}</section>
      <section className="board" aria-label={`${teamName} bingo board`}>{board.map((cell) => { const categoryItem = categoryByColor[cell.color]; return <button key={cell.id} className={`board-cell board-cell--${cell.color} ${marked.includes(cell.id) ? 'board-cell--marked' : ''}`} onClick={() => toggleCell(cell.id)} aria-label={`${categoryItem.name}, ${marked.includes(cell.id) ? 'marked' : 'unmarked'}`}><span>{categoryItem.icon}</span><small>{marked.includes(cell.id) ? 'DONE' : categoryItem.name}</small></button>; })}</section>
      <div className="board-actions"><button className="button button--secondary" onClick={resetBoard}>RESET MARKS</button><button className="text-button" onClick={leaveTeam}>Leave room</button></div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
