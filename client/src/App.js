import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import clsx from 'clsx';
import tableImg from './assets/table.svg';
import bossImg from './assets/boss-v2.png';
import bossStomp1 from './assets/bossStomp1.png';
import bossStomp2 from './assets/bossStomp2.png';
const buildSeatLayouts = () => {
    const base = {
        1: { top: 7, left: 20 },
        2: { top: 34, left: 8 },
        3: { top: 69, left: 22 },
    };
    const mirror = (coords) => ({
        top: coords.top,
        left: 100 - coords.left,
    });
    const numericLayouts = {
        1: base[1],
        2: base[2],
        3: base[3],
        4: mirror(base[3]),
        5: mirror(base[2]),
        6: mirror(base[1]),
    };
    return Object.entries(numericLayouts).reduce((layouts, [seat, coords]) => {
        const seatIndex = Number(seat);
        layouts[seatIndex] = { top: `${coords.top}%`, left: `${coords.left}%` };
        return layouts;
    }, {});
};
const seatLayouts = buildSeatLayouts();
const phaseLabels = {
    waiting: 'Waiting',
    rush: 'The Rush',
    charge: 'The Charge',
    stomp: 'The Stomp',
    combo: 'Combos',
    oxtail: 'Oxtail',
    showdown: 'Showdown',
    hand_end: 'Hand End',
};
const suitIcons = {
    hearts: '\u2665',
    diamonds: '\u2666',
    clubs: '\u2663',
    spades: '\u2660',
};
const resolveServerUrl = () => {
    if (import.meta.env.VITE_SERVER_URL) {
        return import.meta.env.VITE_SERVER_URL;
    }
    return undefined;
};
const useSocket = () => {
    const socketRef = useRef(null);
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
    const [snapshot, setSnapshot] = useState(null);
    const [privateState, setPrivateState] = useState(null);
    const [handResult, setHandResult] = useState(null);
    const [errorMessage, setErrorMessage] = useState(null);
    const [raiseAmount, setRaiseAmount] = useState(10);
    useEffect(() => {
        if (!socket.current)
            return;
        const s = socket.current;
        const handleSnapshot = (data) => {
            setSnapshot(data);
        };
        const handlePrivate = (data) => {
            setPrivateState(data);
        };
        const handleError = (msg) => {
            setErrorMessage(msg);
            setTimeout(() => setErrorMessage(null), 3000);
        };
        const handleResult = (result) => setHandResult(result);
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
    useEffect(() => {
        if (snapshot?.phase === 'rush' && handResult) {
            setHandResult(null);
        }
    }, [snapshot?.phase, handResult]);
    const joinTable = () => {
        if (!socket.current || username.trim().length === 0)
            return;
        socket.current.emit('join_table', { username: username.trim() });
        setJoined(true);
    };
    const restartTable = () => {
        if (!socket.current)
            return;
        socket.current.emit('restart_table');
        setJoined(false);
        setPrivateState(null);
        setHandResult(null);
    };
    const takeSeat = (seatIndex) => {
        if (!socket.current)
            return;
        socket.current.emit('seat_take', { seatIndex });
    };
    const leaveSeat = () => {
        if (!socket.current)
            return;
        socket.current.emit('seat_leave');
    };
    const startHand = () => {
        if (!socket.current)
            return;
        socket.current.emit('start_hand');
    };
    const sendBetAction = (action, amount) => {
        if (!socket.current)
            return;
        socket.current.emit('bet_action', { action, amount });
    };
    const submitCombo = () => {
        if (!socket.current || !privateState)
            return;
        const payload = {
            selections: privateState.comboSelection,
        };
        socket.current.emit('combo_submit', payload);
    };
    const toggleCardSelection = (card) => {
        if (!socket.current || !privateState)
            return;
        const current = privateState.comboSelection ?? [];
        const existing = current.find((sel) => sel.cardId === card.id);
        let next;
        if (!existing) {
            next = [...current, { cardId: card.id, mode: 'low' }];
        }
        else if (card.rank === 'A' && existing.mode === 'low') {
            next = current.map((sel) => sel.cardId === card.id ? { ...sel, mode: 'high' } : sel);
        }
        else {
            next = current.filter((sel) => sel.cardId !== card.id);
        }
        const payload = { selections: next };
        socket.current.emit('combo_update', payload);
    };
    const isDealer = snapshot?.seats.some((seat) => seat.player?.id === privateState?.playerId && seat.player?.isDealer);
    const canStartHand = useMemo(() => {
        if (!snapshot || !privateState)
            return false;
        const seatedCount = snapshot.seats.filter((seat) => seat.occupied).length;
        return seatedCount >= 2 && isDealer && snapshot.phase === 'waiting';
    }, [snapshot, privateState, isDealer]);
    const actingSeat = snapshot?.actingSeat;
    const renderSeat = (seatIndex) => {
        const seat = snapshot?.seats.find((s) => s.seatIndex === seatIndex);
        const occupant = seat?.player;
        const isSelf = occupant?.id === privateState?.playerId;
        return (_jsxs("div", { className: clsx('absolute w-32 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-emerald-600/50 bg-black/60 p-3 text-center text-emerald-100 shadow-lg transition', actingSeat === seatIndex && 'border-yellow-400 shadow-yellow-400/70'), style: { top: seatLayouts[seatIndex].top, left: seatLayouts[seatIndex].left }, children: [_jsxs("div", { className: "text-xs uppercase tracking-wide text-emerald-200", children: ["Seat ", seatIndex] }), occupant ? (_jsxs("div", { className: "mt-1 space-y-1", children: [_jsx("div", { className: "text-sm font-semibold", children: occupant.username }), _jsxs("div", { className: "text-xs text-emerald-300", children: ["$", occupant.stack] }), _jsxs("div", { className: "flex flex-wrap items-center justify-center gap-1 text-[10px] uppercase", children: [occupant.isDealer && _jsx("span", { className: "rounded-full bg-yellow-500/80 px-2 py-0.5 text-black", children: "Dealer" }), occupant.isSmallBlind && _jsx("span", { className: "rounded-full bg-cyan-500/70 px-2 py-0.5 text-black", children: "SB" }), occupant.isBigBlind && _jsx("span", { className: "rounded-full bg-purple-500/70 px-2 py-0.5 text-black", children: "BB" })] }), occupant.comboRevealed && occupant.comboRevealed.length > 0 && (_jsx("div", { className: "flex justify-center gap-1", children: occupant.comboRevealed.map((card) => (_jsx(PlayingCard, { rank: card.rank, suit: card.suit, small: true }, card.id))) })), isSelf ? (_jsx("button", { onClick: leaveSeat, className: "mt-2 w-full rounded bg-red-600/80 py-1 text-xs font-semibold text-white hover:bg-red-500", children: "Leave Seat" })) : null] })) : (_jsx("button", { className: "mt-2 w-full rounded border border-emerald-400/70 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20", onClick: () => takeSeat(seatIndex), disabled: !joined, children: "Take Seat" }))] }, seatIndex));
    };
    const canSubmitCombo = Boolean(privateState?.actions.includes('submit_combo'));
    const selectionMap = useMemo(() => {
        const map = new Map();
        (privateState?.comboSelection ?? []).forEach((selection) => {
            map.set(selection.cardId, selection.mode);
        });
        return map;
    }, [privateState?.comboSelection]);
    const mySeatSummary = useMemo(() => {
        if (!snapshot || !privateState)
            return undefined;
        return snapshot.seats.find((seat) => seat.player?.id === privateState.playerId)?.player;
    }, [snapshot, privateState?.playerId]);
    const actionButtons = (privateState?.actions ?? []).filter((action) => action !== 'submit_combo');
    const raiseAvailable = actionButtons.includes('raise');
    const nonRaiseActions = actionButtons.filter((action) => action !== 'raise');
    const bossTotal = snapshot ? snapshot.bossCards.reduce((sum, card) => sum + getBossValue(card), 0) : 0;
    const comboSuitMatches = useMemo(() => {
        if (!privateState?.hand)
            return 0;
        const selectedCards = [];
        const handLookup = new Map(privateState.hand.map((card) => [card.id, card]));
        (privateState.comboSelection ?? []).forEach((selection) => {
            const card = handLookup.get(selection.cardId);
            if (card)
                selectedCards.push(card);
        });
        return countSuitMatches(selectedCards, snapshot?.bossCards ?? []);
    }, [privateState?.comboSelection, privateState?.hand, snapshot?.bossCards]);
    const raiseStep = 10;
    const callNeeded = Math.max(0, (snapshot?.currentBet ?? 0) - (mySeatSummary?.betThisRound ?? 0));
    const availableRaise = Math.max(0, (privateState?.stack ?? 0) - callNeeded);
    const maxRaiseAmount = Math.floor(availableRaise / raiseStep) * raiseStep;
    const minRaiseBase = Math.max(snapshot?.minimumRaise ?? raiseStep, raiseStep);
    const canRaise = raiseAvailable && maxRaiseAmount >= minRaiseBase;
    useEffect(() => {
        if (!raiseAvailable) {
            setRaiseAmount(minRaiseBase);
            return;
        }
        if (!canRaise) {
            setRaiseAmount(minRaiseBase);
            return;
        }
        setRaiseAmount((prev) => {
            const clamped = Math.min(Math.max(prev, minRaiseBase), maxRaiseAmount);
            return Number.isNaN(clamped) ? minRaiseBase : clamped;
        });
    }, [raiseAvailable, minRaiseBase, maxRaiseAmount, canRaise]);
    const adjustRaiseAmount = (delta) => {
        if (!canRaise)
            return;
        setRaiseAmount((prev) => {
            const next = Math.min(Math.max(prev + delta, minRaiseBase), maxRaiseAmount);
            return Number.isNaN(next) ? prev : next;
        });
    };
    const comboWinPhrases = {
        1: 'a Bullseye',
        2: 'The Horns',
        3: 'a Tackle',
        4: 'a Hoof',
        5: 'a Matador',
        6: 'a Scramble',
        7: 'a Flag',
    };
    const formatPot = (amount) => `$${amount.toLocaleString()}`;
    const resultMessage = useMemo(() => {
        if (!handResult)
            return null;
        const primaryWinner = handResult.winners[0];
        if (!primaryWinner)
            return null;
        const totalPot = handResult.winners.reduce((sum, winner) => sum + winner.amount, 0);
        const potText = formatPot(totalPot);
        switch (handResult.winType) {
            case 'fold':
                return `${primaryWinner.username} wins ${potText} pot with a rake`;
            case 'closest':
                return `${primaryWinner.username} wins ${potText} pot with a Nosehair`;
            case 'oxtail':
                return `${primaryWinner.username} wins ${potText} pot and grabs the Oxtail`;
            case 'exact': {
                const phrase = comboWinPhrases[handResult.comboCardCount ?? 0] ?? 'an exact match';
                return `${primaryWinner.username} wins ${potText} pot with ${phrase}`;
            }
            case 'split':
                return `${handResult.description} (${potText} total)`;
            default:
                return handResult.description
                    ? `${handResult.description} (${potText} pot)`
                    : `${primaryWinner.username} wins ${potText} pot`;
        }
    }, [handResult]);
    const displayMessage = resultMessage ?? snapshot?.message ?? '';
    return (_jsx("div", { className: "poker-background text-emerald-50", children: _jsxs("div", { className: "mx-auto max-w-6xl px-4 py-6", children: [_jsxs("header", { className: "flex flex-col gap-4 rounded-2xl border border-emerald-600/40 bg-black/60 px-4 py-4 shadow-lg shadow-black/60 md:flex-row md:items-center md:justify-between", children: [_jsx("div", { children: _jsx("h1", { className: "font-headline text-3xl tracking-wide text-transparent bg-gradient-to-r from-yellow-300 via-amber-200 to-yellow-400 bg-clip-text drop-shadow-[0_2px_6px_rgba(255,215,0,0.4)]", children: "THE BOSS" }) }), _jsxs("div", { className: "flex flex-wrap items-center gap-4 text-sm", children: [_jsxs("div", { className: "rounded-full border border-emerald-500/40 px-3 py-1", children: ["Connection:", ' ', _jsx("span", { className: connected ? 'text-emerald-300' : 'text-red-400', children: connected ? 'Connected' : 'Disconnected' })] }), _jsxs("div", { children: ["Hand #", snapshot?.handNumber ?? 0] }), _jsxs("div", { children: ["Phase: ", phaseLabels[snapshot?.phase ?? 'waiting']] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { className: "rounded border border-emerald-600/50 bg-black/60 px-3 py-1 text-sm outline-none focus:border-emerald-300", placeholder: "Username", minLength: 1, value: username, onChange: (e) => setUsername(e.target.value) }), _jsx("button", { className: "rounded bg-emerald-600/80 px-3 py-1 text-sm font-semibold uppercase tracking-wider text-white hover:bg-emerald-500 disabled:opacity-40", onClick: joined ? restartTable : joinTable, disabled: joined ? !connected : !connected || username.trim().length === 0, children: joined ? 'Restart' : 'Join' })] })] })] }), _jsxs("div", { className: "relative mt-6 rounded-[36px] border border-emerald-800/60 bg-gradient-to-b from-[#02140c] to-[#021f12] p-4 shadow-2xl shadow-black/70", children: [_jsxs("div", { className: "relative mx-auto flex h-[520px] w-full max-w-4xl items-center justify-center", children: [_jsx("img", { src: tableImg, alt: "Poker table", className: "table-shadow w-full rounded-[60px] object-contain" }), _jsxs("div", { className: "pointer-events-none absolute top-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2 text-center", children: [_jsx(BossImage, { phase: snapshot?.phase }), _jsx("div", { className: "font-headline text-2xl font-bold tracking-wide text-yellow-200 drop-shadow-[0_6px_12px_rgba(0,0,0,0.7)]", children: bossTotal }), _jsx("div", { className: "flex gap-2", children: snapshot?.bossCards.map((card) => (_jsx(PlayingCard, { rank: card.rank, suit: card.suit, small: true }, card.id))) })] }), [1, 2, 3, 4, 5, 6].map((seatIndex) => renderSeat(seatIndex)), _jsxs("div", { className: "absolute bottom-6 left-1/2 -translate-x-1/2 text-center text-2xl font-bold text-white", children: ["Pot: $", snapshot?.pot ?? 0] })] }), canStartHand && (_jsx("div", { className: "mt-4 flex justify-center", children: _jsx("button", { className: "rounded-full bg-yellow-500 px-6 py-2 text-base font-bold uppercase text-black shadow-lg hover:bg-yellow-400", onClick: startHand, children: "Start Hand" }) }))] }), displayMessage ? (_jsx("div", { className: "mt-6 rounded-2xl border border-emerald-600/50 bg-emerald-900/70 px-4 py-3 text-center text-sm text-emerald-50", children: displayMessage })) : null, _jsxs("section", { className: "mt-6 rounded-2xl border border-emerald-800/60 bg-black/70 p-5 shadow-xl shadow-black/70", children: [_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-4 text-sm text-emerald-300", children: [_jsxs("div", { children: [_jsxs("div", { children: ["Combo: ", privateState?.comboTotal ?? 0, ' ', canSubmitCombo && '(must not exceed Boss)'] }), _jsxs("div", { className: "text-xs text-emerald-400", children: ["Suit Matches: ", comboSuitMatches] })] }), _jsxs("div", { className: "text-sm text-emerald-300", children: ["Current bet: $", snapshot?.currentBet ?? 0, " | Minimum raise: $", snapshot?.minimumRaise ?? 0] })] }), _jsx("div", { className: "mt-3 flex flex-wrap justify-center gap-2", children: privateState?.hand?.map((card) => {
                                const selectedMode = selectionMap.get(card.id);
                                const selected = Boolean(selectedMode);
                                const aceHigh = selectedMode === 'high';
                                return (_jsxs("button", { className: clsx('flex flex-col items-center gap-2 rounded-xl border px-3 py-3 text-center transition', selected ? 'border-yellow-400 bg-yellow-400/15' : 'border-emerald-700/60 bg-emerald-900/20'), onClick: () => toggleCardSelection(card), children: [_jsx(PlayingCard, { rank: card.rank, suit: card.suit, className: clsx(selected && 'ring-2 ring-yellow-300 ring-offset-2 ring-offset-black/40', 'transition-all') }), card.rank === 'A' && selected ? (_jsx("div", { className: "mt-1 text-xs text-yellow-300", children: aceHigh ? 'Ace = 11' : 'Ace = 1' })) : null] }, card.id));
                            }) }), _jsx("div", { className: "mt-4 flex flex-wrap items-center justify-between gap-3", children: _jsxs("div", { className: "flex flex-wrap gap-2", children: [nonRaiseActions.map((action) => (_jsx("button", { className: "rounded bg-emerald-600/80 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-white hover:bg-emerald-500 disabled:opacity-40", onClick: () => sendBetAction(action), children: action }, action))), raiseAvailable && (_jsxs("div", { className: "flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/50 bg-black/30 px-3 py-2", children: [_jsx("button", { className: "rounded bg-emerald-700/70 px-2 py-1 text-white disabled:opacity-30", onClick: () => adjustRaiseAmount(-raiseStep), disabled: !canRaise || raiseAmount <= minRaiseBase, children: "-" }), _jsxs("div", { className: "min-w-[70px] text-center text-sm font-semibold text-emerald-100", children: ["$", raiseAmount] }), _jsx("button", { className: "rounded bg-emerald-700/70 px-2 py-1 text-white disabled:opacity-30", onClick: () => adjustRaiseAmount(raiseStep), disabled: !canRaise || raiseAmount >= maxRaiseAmount, children: "+" }), _jsx("button", { className: "rounded bg-yellow-400 px-4 py-1 text-sm font-semibold uppercase tracking-wide text-black hover:bg-yellow-300 disabled:opacity-40", onClick: () => sendBetAction('raise', raiseAmount), disabled: !canRaise, children: "Raise" })] })), canSubmitCombo && (_jsx("button", { className: "rounded bg-yellow-400 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-black hover:bg-yellow-300", onClick: submitCombo, children: "Submit Combo" }))] }) })] }), errorMessage && (_jsx("div", { className: "mt-4 rounded-xl border border-red-600/50 bg-red-900/60 px-4 py-2 text-center text-sm text-red-100", children: errorMessage }))] }) }));
}
const countSuitMatches = (cards, bossCards) => {
    const bossCounts = new Map();
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
function BossImage({ phase }) {
    const [frame, setFrame] = useState(bossImg);
    useEffect(() => {
        if (phase !== 'stomp') {
            setFrame(bossImg);
            return;
        }
        setFrame(bossStomp1);
        const second = window.setTimeout(() => setFrame(bossStomp2), 120);
        const reset = window.setTimeout(() => setFrame(bossImg), 700);
        return () => {
            window.clearTimeout(second);
            window.clearTimeout(reset);
        };
    }, [phase]);
    return (_jsx("img", { src: frame, alt: "The Boss", className: "w-60 drop-shadow-[0_12px_20px_rgba(0,0,0,0.8)] transition-all duration-150" }));
}
const getBossValue = (card) => {
    if (card.rank === 'A')
        return 1;
    if (card.rank === 'J')
        return 11;
    if (card.rank === 'Q')
        return 12;
    if (card.rank === 'K')
        return 13;
    return Number(card.rank);
};
function PlayingCard({ rank, suit, small = false, className, }) {
    const symbol = suitIcons[suit];
    const isRed = suit === 'hearts' || suit === 'diamonds';
    const colorClass = isRed ? 'text-rose-600' : 'text-slate-900';
    const sizeClass = small ? 'w-12' : 'w-16';
    return (_jsxs("div", { className: clsx('relative flex items-center justify-center rounded-lg border border-slate-600 bg-slate-50 shadow-md', sizeClass, className), style: { aspectRatio: '3 / 5' }, children: [_jsxs("div", { className: clsx('absolute left-2 top-2 text-xs font-bold leading-tight', colorClass), children: [_jsx("div", { children: rank }), _jsx("div", { children: symbol })] }), _jsxs("div", { className: clsx('absolute right-2 bottom-2 text-xs font-bold leading-tight rotate-180', colorClass), children: [_jsx("div", { children: rank }), _jsx("div", { children: symbol })] }), _jsx("div", { className: clsx('text-3xl font-semibold', colorClass), children: symbol })] }));
}
export default App;
