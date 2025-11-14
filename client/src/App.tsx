import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import clsx from 'clsx';
import type {
  BetActionMessage,
  Card,
  ComboSelection,
  ComboSubmitMessage,
  ComboUpdateMessage,
  HandResult,
  PlayerPrivateState,
  TableSnapshot,
  SeatIndex,
} from '@shared/types';
import tableImg from './assets/table.svg';
import bossImg from './assets/boss-v2.png';

const buildSeatLayouts = () => {
  const base: Record<1 | 2 | 3, { top: number; left: number }> = {
    1: { top: 7, left: 20 },
    2: { top: 34, left: 8 },
    3: { top: 69, left: 22 },
  };
  const mirror = (coords: { top: number; left: number }) => ({
    top: coords.top,
    left: 100 - coords.left,
  });
  const numericLayouts: Record<SeatIndex, { top: number; left: number }> = {
    1: base[1],
    2: base[2],
    3: base[3],
    4: mirror(base[3]),
    5: mirror(base[2]),
    6: mirror(base[1]),
  };
  return Object.entries(numericLayouts).reduce((layouts, [seat, coords]) => {
    const seatIndex = Number(seat) as SeatIndex;
    layouts[seatIndex] = { top: `${coords.top}%`, left: `${coords.left}%` };
    return layouts;
  }, {} as Record<SeatIndex, { top: string; left: string }>);
};

const seatLayouts = buildSeatLayouts();

const phaseLabels: Record<string, string> = {
  waiting: 'Waiting',
  rush: 'The Rush',
  charge: 'The Charge',
  stomp: 'The Stomp',
  combo: 'Combos',
  oxtail: 'Oxtail',
  showdown: 'Showdown',
  hand_end: 'Hand End',
};

const suitIcons: Record<Card['suit'], string> = {
  hearts: '\u2665',
  diamonds: '\u2666',
  clubs: '\u2663',
  spades: '\u2660',
};

const resolveServerUrl = () => {
  if (import.meta.env.VITE_SERVER_URL) {
    return import.meta.env.VITE_SERVER_URL as string;
  }
  return undefined;
};

const useSocket = () => {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const serverUrl = resolveServerUrl();
    const socket = serverUrl ? io(serverUrl) : io();
    socketRef.current = socket;
    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  return { socket: socketRef, connected };
};

function App() {
  const { socket, connected } = useSocket();
  const [username, setUsername] = useState('');
  const [joined, setJoined] = useState(false);
  const [snapshot, setSnapshot] = useState<TableSnapshot | null>(null);
  const [privateState, setPrivateState] = useState<PlayerPrivateState | null>(null);
  const [handResult, setHandResult] = useState<HandResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!socket.current) return;
    const s = socket.current;
    const handleSnapshot = (data: TableSnapshot) => {
      setSnapshot(data);
    };
    const handlePrivate = (data: PlayerPrivateState) => {
      setPrivateState(data);
    };
    const handleError = (msg: string) => {
      setErrorMessage(msg);
      setTimeout(() => setErrorMessage(null), 3000);
    };
    const handleResult = (result: HandResult) => setHandResult(result);
    const handleTableReset = () => {
      setJoined(false);
      setPrivateState(null);
      setHandResult(null);
    };
    s.on('table_snapshot', handleSnapshot);
    s.on('player_private_state', handlePrivate);
    s.on('error', handleError);
    s.on('hand_result', handleResult);
    s.on('table_reset', handleTableReset);
    return () => {
      s.off('table_snapshot', handleSnapshot);
      s.off('player_private_state', handlePrivate);
      s.off('error', handleError);
      s.off('hand_result', handleResult);
      s.off('table_reset', handleTableReset);
    };
  }, [socket]);

  const joinTable = () => {
    if (!socket.current || username.trim().length === 0) return;
    socket.current.emit('join_table', { username: username.trim() });
    setJoined(true);
  };

  const restartTable = () => {
    if (!socket.current) return;
    socket.current.emit('restart_table');
    setJoined(false);
    setPrivateState(null);
    setHandResult(null);
  };

  const takeSeat = (seatIndex: SeatIndex) => {
    if (!socket.current) return;
    socket.current.emit('seat_take', { seatIndex });
  };

  const leaveSeat = () => {
    if (!socket.current) return;
    socket.current.emit('seat_leave');
  };

  const startHand = () => {
    if (!socket.current) return;
    socket.current.emit('start_hand');
  };

  const sendBetAction = (action: BetActionMessage['action']) => {
    if (!socket.current) return;
    socket.current.emit('bet_action', { action });
  };

  const submitCombo = () => {
    if (!socket.current || !privateState) return;
    const payload: ComboSubmitMessage = {
      selections: privateState.comboSelection,
    };
    socket.current.emit('combo_submit', payload);
  };

  const toggleCardSelection = (card: Card) => {
    if (!socket.current || !privateState) return;
    const current = privateState.comboSelection ?? [];
    const existing = current.find((sel) => sel.cardId === card.id);
    let next: ComboSelection[];
    if (!existing) {
      next = [...current, { cardId: card.id, mode: 'low' }];
    } else if (card.rank === 'A' && existing.mode === 'low') {
      next = current.map((sel) =>
        sel.cardId === card.id ? { ...sel, mode: 'high' } : sel,
      );
    } else {
      next = current.filter((sel) => sel.cardId !== card.id);
    }
    const payload: ComboUpdateMessage = { selections: next };
    socket.current.emit('combo_update', payload);
  };

  const isDealer = snapshot?.seats.some(
    (seat) => seat.player?.id === privateState?.playerId && seat.player?.isDealer,
  );

  const canStartHand = useMemo(() => {
    if (!snapshot || !privateState) return false;
    const seatedCount = snapshot.seats.filter((seat) => seat.occupied).length;
    return seatedCount >= 2 && isDealer && snapshot.phase === 'waiting';
  }, [snapshot, privateState, isDealer]);

  const actingSeat = snapshot?.actingSeat;

  const renderSeat = (seatIndex: SeatIndex) => {
    const seat = snapshot?.seats.find((s) => s.seatIndex === seatIndex);
    const occupant = seat?.player;
    const isSelf = occupant?.id === privateState?.playerId;
    return (
      <div
        key={seatIndex}
        className={clsx(
          'absolute w-32 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-emerald-600/50 bg-black/60 p-3 text-center text-emerald-100 shadow-lg transition',
          actingSeat === seatIndex && 'border-yellow-400 shadow-yellow-400/70',
        )}
        style={{ top: seatLayouts[seatIndex].top, left: seatLayouts[seatIndex].left }}
      >
        <div className="text-xs uppercase tracking-wide text-emerald-200">Seat {seatIndex}</div>
        {occupant ? (
          <div className="mt-1 space-y-1">
            <div className="text-sm font-semibold">{occupant.username}</div>
            <div className="text-xs text-emerald-300">${occupant.stack}</div>
            <div className="flex flex-wrap items-center justify-center gap-1 text-[10px] uppercase">
              {occupant.isDealer && <span className="rounded-full bg-yellow-500/80 px-2 py-0.5 text-black">Dealer</span>}
              {occupant.isSmallBlind && <span className="rounded-full bg-cyan-500/70 px-2 py-0.5 text-black">SB</span>}
              {occupant.isBigBlind && <span className="rounded-full bg-purple-500/70 px-2 py-0.5 text-black">BB</span>}
            </div>
            {occupant.comboRevealed && occupant.comboRevealed.length > 0 && (
              <div className="flex justify-center gap-1">
                {occupant.comboRevealed.map((card) => (
                  <PlayingCard key={card.id} rank={card.rank} suit={card.suit} small />
                ))}
              </div>
            )}
            {isSelf ? (
              <button
                onClick={leaveSeat}
                className="mt-2 w-full rounded bg-red-600/80 py-1 text-xs font-semibold text-white hover:bg-red-500"
              >
                Leave Seat
              </button>
            ) : null}
          </div>
        ) : (
          <button
            className="mt-2 w-full rounded border border-emerald-400/70 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20"
            onClick={() => takeSeat(seatIndex)}
            disabled={!joined}
          >
            Take Seat
          </button>
        )}
      </div>
    );
  };

  const canSubmitCombo = Boolean(privateState?.actions.includes('submit_combo'));
  const selectionMap = useMemo(() => {
    const map = new Map<string, ComboSelection['mode']>();
    (privateState?.comboSelection ?? []).forEach((selection) => {
      map.set(selection.cardId, selection.mode);
    });
    return map;
  }, [privateState?.comboSelection]);
  const actionButtons = (privateState?.actions ?? []).filter((action) => action !== 'submit_combo');

  const bossTotal = snapshot ? snapshot.bossCards.reduce((sum, card) => sum + getBossValue(card), 0) : 0;
  const comboSuitMatches = useMemo(() => {
    if (!privateState?.hand) return 0;
    const selectedCards: Card[] = [];
    const handLookup = new Map(privateState.hand.map((card) => [card.id, card] as const));
    (privateState.comboSelection ?? []).forEach((selection) => {
      const card = handLookup.get(selection.cardId);
      if (card) selectedCards.push(card);
    });
    return countSuitMatches(selectedCards, snapshot?.bossCards ?? []);
  }, [privateState?.comboSelection, privateState?.hand, snapshot?.bossCards]);

  return (
    <div className="poker-background text-emerald-50">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="flex flex-col gap-4 rounded-2xl border border-emerald-600/40 bg-black/60 px-4 py-4 shadow-lg shadow-black/60 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="font-headline text-3xl tracking-wide text-emerald-100">THE BOSS</h1>
            <p className="text-sm text-emerald-300">High stakes rush, charge, stomp.</p>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <div className="rounded-full border border-emerald-500/40 px-3 py-1">
              Connection:{' '}
              <span className={connected ? 'text-emerald-300' : 'text-red-400'}>
                {connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <div>Hand #{snapshot?.handNumber ?? 0}</div>
            <div>Phase: {phaseLabels[snapshot?.phase ?? 'waiting']}</div>
            <div className="flex items-center gap-2">
              <input
                className="rounded border border-emerald-600/50 bg-black/60 px-3 py-1 text-sm outline-none focus:border-emerald-300"
                placeholder="Username"
                minLength={1}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <button
                className="rounded bg-emerald-600/80 px-3 py-1 text-sm font-semibold uppercase tracking-wider text-white hover:bg-emerald-500 disabled:opacity-40"
                onClick={joined ? restartTable : joinTable}
                disabled={joined ? !connected : !connected || username.trim().length === 0}
              >
                {joined ? 'Restart' : 'Join'}
              </button>
            </div>
          </div>
        </header>

        <div className="relative mt-6 rounded-[36px] border border-emerald-800/60 bg-gradient-to-b from-[#02140c] to-[#021f12] p-4 shadow-2xl shadow-black/70">
          <div className="relative mx-auto flex h-[520px] w-full max-w-4xl items-center justify-center">
            <img src={tableImg} alt="Poker table" className="table-shadow w-full rounded-[60px] object-contain" />
            <div className="pointer-events-none absolute top-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-3 text-center">
              <div className="font-headline text-3xl font-bold uppercase tracking-wide text-yellow-300 drop-shadow-[0_6px_12px_rgba(0,0,0,0.7)]">
                Boss Total: {bossTotal}
              </div>
              <img
                src={bossImg}
                alt="The Boss"
                className="w-48 drop-shadow-[0_12px_20px_rgba(0,0,0,0.8)]"
              />
              <div className="flex gap-2">
                {snapshot?.bossCards.map((card) => (
                  <PlayingCard key={card.id} rank={card.rank} suit={card.suit} small />
                ))}
              </div>
            </div>
            {([1, 2, 3, 4, 5, 6] as SeatIndex[]).map((seatIndex) => renderSeat(seatIndex))}
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-6 text-center text-sm uppercase text-emerald-200">
              <div>Pot: ${snapshot?.pot ?? 0}</div>
              {snapshot?.sidePot ? <div>Side Pot: ${snapshot.sidePot}</div> : null}
              <div>Message: {snapshot?.message ?? ''}</div>
            </div>
          </div>
          {canStartHand && (
            <div className="mt-4 flex justify-center">
              <button
                className="rounded-full bg-yellow-500 px-6 py-2 text-base font-bold uppercase text-black shadow-lg hover:bg-yellow-400"
                onClick={startHand}
              >
                Start Hand
              </button>
            </div>
          )}
        </div>

        <section className="mt-6 rounded-2xl border border-emerald-800/60 bg-black/70 p-5 shadow-xl shadow-black/70">
          <div className="flex flex-wrap items-center justify-start gap-4 text-sm text-emerald-300">
            <div>
              <div>
                Combo total: {privateState?.comboTotal ?? 0}{' '}
                {canSubmitCombo && '(must not exceed Boss)'}
              </div>
              <div className="text-xs text-emerald-400">
                Suit matches with Boss: {comboSuitMatches}
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {privateState?.hand?.map((card) => {
              const selectedMode = selectionMap.get(card.id);
              const selected = Boolean(selectedMode);
              const aceHigh = selectedMode === 'high';
              return (
                <button
                  key={card.id}
                  className={clsx(
                    'flex flex-col items-center gap-2 rounded-xl border px-3 py-3 text-center transition',
                    selected ? 'border-yellow-400 bg-yellow-400/15' : 'border-emerald-700/60 bg-emerald-900/20',
                  )}
                  onClick={() => toggleCardSelection(card)}
                >
                  <PlayingCard
                    rank={card.rank}
                    suit={card.suit}
                    className={clsx(
                      selected && 'ring-2 ring-yellow-300 ring-offset-2 ring-offset-black/40',
                      'transition-all',
                    )}
                  />
                  {card.rank === 'A' && selected ? (
                    <div className="mt-1 text-xs text-yellow-300">{aceHigh ? 'Ace = 11' : 'Ace = 1'}</div>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {actionButtons.map((action) => (
                <button
                  key={action}
                  className="rounded bg-emerald-600/80 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-white hover:bg-emerald-500 disabled:opacity-40"
                  onClick={() => sendBetAction(action)}
                >
                  {action}
                </button>
              ))}
              {canSubmitCombo && (
                <button
                  className="rounded bg-yellow-400 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-black hover:bg-yellow-300"
                  onClick={submitCombo}
                >
                  Submit Combo
                </button>
              )}
            </div>
            <div className="text-sm text-emerald-300">
              Current bet: ${snapshot?.currentBet ?? 0} | Minimum raise: ${snapshot?.minimumRaise ?? 0}
            </div>
          </div>
        </section>

        {errorMessage && (
          <div className="mt-4 rounded-xl border border-red-600/50 bg-red-900/60 px-4 py-2 text-center text-sm text-red-100">
            {errorMessage}
          </div>
        )}

        {handResult && (
          <div className="mt-4 rounded-2xl border border-emerald-600/50 bg-emerald-900/70 px-4 py-3 text-center text-sm text-emerald-50">
            <div className="font-semibold">Hand Result</div>
            <div>{handResult.description}</div>
            <div className="mt-1">
              Winners:{' '}
              {handResult.winners.map((winner) => `${winner.username} +$${winner.amount}`).join(', ')}
            </div>
            <button
              className="mt-2 rounded-full border border-emerald-400/60 px-3 py-1 text-xs uppercase tracking-wide text-emerald-200"
              onClick={() => setHandResult(null)}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const countSuitMatches = (cards: Card[], bossCards: Card[]) => {
  const bossCounts = new Map<Card['suit'], number>();
  bossCards.forEach((card) => {
    bossCounts.set(card.suit, (bossCounts.get(card.suit) ?? 0) + 1);
  });
  let matches = 0;
  for (const card of cards) {
    const available = bossCounts.get(card.suit) ?? 0;
    if (available > 0) {
      matches += 1;
      bossCounts.set(card.suit, available - 1);
    }
  }
  return matches;
};

const getBossValue = (card: Card) => {
  if (card.rank === 'A') return 1;
  if (card.rank === 'J') return 11;
  if (card.rank === 'Q') return 12;
  if (card.rank === 'K') return 13;
  return Number(card.rank);
};

function PlayingCard({
  rank,
  suit,
  small = false,
  className,
}: {
  rank: Card['rank'];
  suit: Card['suit'];
  small?: boolean;
  className?: string;
}) {
  const symbol = suitIcons[suit];
  const isRed = suit === 'hearts' || suit === 'diamonds';
  const colorClass = isRed ? 'text-rose-600' : 'text-slate-900';
  const sizeClass = small ? 'w-12' : 'w-16';
  return (
    <div
      className={clsx(
        'relative flex items-center justify-center rounded-lg border border-slate-600 bg-slate-50 shadow-md',
        sizeClass,
        className,
      )}
      style={{ aspectRatio: '3 / 5' }}
    >
      <div className={clsx('absolute left-2 top-2 text-xs font-bold leading-tight', colorClass)}>
        <div>{rank}</div>
        <div>{symbol}</div>
      </div>
      <div className={clsx('absolute right-2 bottom-2 text-xs font-bold leading-tight rotate-180', colorClass)}>
        <div>{rank}</div>
        <div>{symbol}</div>
      </div>
      <div className={clsx('text-3xl font-semibold', colorClass)}>{symbol}</div>
    </div>
  );
}

export default App;

