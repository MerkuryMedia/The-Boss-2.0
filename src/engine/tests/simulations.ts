import { GameEngine } from '..';
import type { BetActionMessage, Card, SeatIndex, TableSnapshot } from '../../shared/types';

type Action = BetActionMessage['action'];

interface PlayerSetup {
  id: string;
  seat: SeatIndex;
  username: string;
}

interface Harness {
  engine: GameEngine;
  getSnapshot: () => TableSnapshot;
}

const expectCondition = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const createHarness = (setups: PlayerSetup[]): Harness => {
  const engine = new GameEngine();
  let lastSnapshot: TableSnapshot | null = null;
  engine.onBroadcast((event) => {
    if (event.type === 'snapshot') {
      lastSnapshot = event.snapshot;
    }
  });
  setups.forEach(({ id, username }) => engine.join(id, username));
  setups.forEach(({ id, seat }) => engine.seatTake(id, seat));
  return {
    engine,
    getSnapshot: () => {
      if (!lastSnapshot) {
        throw new Error('Snapshot unavailable');
      }
      return lastSnapshot;
    },
  };
};

const act = (engine: GameEngine, getSnapshot: () => TableSnapshot, playerId: string, action: Action) => {
  engine.betAction(playerId, { action });
  return getSnapshot();
};

const runDirectionTest = () => {
  const harness = createHarness([
    { id: 'p1', seat: 1 as SeatIndex, username: 'Dealer' },
    { id: 'p2', seat: 2 as SeatIndex, username: 'Left' },
    { id: 'p3', seat: 3 as SeatIndex, username: 'Right' },
  ]);
  harness.engine.startHand('p1');
  let snapshot = harness.getSnapshot();
  const sbSeat = snapshot.seats.find((seat) => seat.player?.isSmallBlind)?.seatIndex;
  const bbSeat = snapshot.seats.find((seat) => seat.player?.isBigBlind)?.seatIndex;
  expectCondition(sbSeat === (2 as SeatIndex), 'Small blind should be seat 2');
  expectCondition(bbSeat === (3 as SeatIndex), 'Big blind should be seat 3');
  expectCondition(snapshot.actingSeat === sbSeat, 'Rush should start with small blind');

  snapshot = act(harness.engine, harness.getSnapshot, 'p2', 'call');
  expectCondition(snapshot.actingSeat === bbSeat, 'Action should pass left to big blind');
  snapshot = act(harness.engine, harness.getSnapshot, 'p3', 'check');
  expectCondition(snapshot.actingSeat === (1 as SeatIndex), 'Dealer should act after blinds');
  snapshot = act(harness.engine, harness.getSnapshot, 'p1', 'call');
  expectCondition(snapshot.phase === 'charge', 'Rush betting should transition to Charge');
  expectCondition(snapshot.actingSeat === sbSeat, 'Charge should begin with the small blind or next survivor');
  snapshot = act(harness.engine, harness.getSnapshot, 'p2', 'check');
  expectCondition(snapshot.actingSeat === bbSeat, 'Charge betting rotates left');
  snapshot = act(harness.engine, harness.getSnapshot, 'p3', 'check');
  expectCondition(snapshot.actingSeat === (1 as SeatIndex), 'Dealer should next act in Charge');
  snapshot = act(harness.engine, harness.getSnapshot, 'p1', 'check');
  expectCondition(snapshot.phase === 'stomp', 'Charge betting should only finish after all active seats act');
  expectCondition(snapshot.actingSeat === sbSeat, 'Stomp should start at the next seat to the left');
};

const runGapTest = () => {
  const harness = createHarness([
    { id: 'p1', seat: 1 as SeatIndex, username: 'Dealer' },
    { id: 'p2', seat: 3 as SeatIndex, username: 'Seat3' },
    { id: 'p3', seat: 5 as SeatIndex, username: 'Seat5' },
    { id: 'p4', seat: 6 as SeatIndex, username: 'Seat6' },
  ]);
  harness.engine.startHand('p1');
  let snapshot = harness.getSnapshot();
  const sbSeat = snapshot.seats.find((seat) => seat.player?.isSmallBlind)?.seatIndex;
  const bbSeat = snapshot.seats.find((seat) => seat.player?.isBigBlind)?.seatIndex;
  expectCondition(sbSeat === (3 as SeatIndex), 'Small blind should skip empty seat 2');
  expectCondition(bbSeat === (5 as SeatIndex), 'Big blind should be the next occupied seat after SB');
  expectCondition(snapshot.actingSeat === sbSeat, 'Rush action starts with SB even with gaps');

  snapshot = act(harness.engine, harness.getSnapshot, 'p2', 'call');
  expectCondition(snapshot.actingSeat === bbSeat, 'Action should move left to seat 5');
  snapshot = act(harness.engine, harness.getSnapshot, 'p3', 'check');
  expectCondition(snapshot.actingSeat === (6 as SeatIndex), 'Seat 6 should act after seat 5');
  snapshot = act(harness.engine, harness.getSnapshot, 'p4', 'call');
  expectCondition(snapshot.actingSeat === (1 as SeatIndex), 'Dealer should act last before wrap');
  snapshot = act(harness.engine, harness.getSnapshot, 'p1', 'call');
  expectCondition(snapshot.phase === 'charge', 'Rush round should complete only after dealer action');
};

const runBettingRoundTest = () => {
  const harness = createHarness([
    { id: 'p1', seat: 1 as SeatIndex, username: 'Dealer' },
    { id: 'p2', seat: 2 as SeatIndex, username: 'Left' },
    { id: 'p3', seat: 3 as SeatIndex, username: 'Right' },
  ]);
  harness.engine.startHand('p1');
  // Finish Rush
  act(harness.engine, harness.getSnapshot, 'p2', 'call');
  act(harness.engine, harness.getSnapshot, 'p3', 'check');
  let snapshot = act(harness.engine, harness.getSnapshot, 'p1', 'call');
  expectCondition(snapshot.phase === 'charge', 'Rush complete before testing Charge');

  snapshot = act(harness.engine, harness.getSnapshot, 'p2', 'check');
  expectCondition(snapshot.phase === 'charge', 'Charge should not finish after SB action');
  snapshot = act(harness.engine, harness.getSnapshot, 'p3', 'check');
  expectCondition(snapshot.phase === 'charge', 'Charge waits for all seats');
  snapshot = act(harness.engine, harness.getSnapshot, 'p1', 'check');
  expectCondition(snapshot.phase === 'stomp', 'Charge only ends once everyone acts');

  snapshot = act(harness.engine, harness.getSnapshot, 'p2', 'raise');
  expectCondition(snapshot.phase === 'stomp', 'Stomp should continue after SB raise');
  expectCondition(snapshot.actingSeat === (3 as SeatIndex), 'Seat 3 must respond to the raise');
  snapshot = act(harness.engine, harness.getSnapshot, 'p3', 'call');
  expectCondition(snapshot.actingSeat === (1 as SeatIndex), 'Dealer acts after seat 3');
  snapshot = act(harness.engine, harness.getSnapshot, 'p1', 'call');
  expectCondition(snapshot.phase === 'combo', 'Stomp should only complete after all calls are resolved');
};

const runCourtValueTest = () => {
  const harness = createHarness([{ id: 'p1', seat: 1 as SeatIndex, username: 'Dealer' }]);
  harness.engine.startHand('p1');
  const player = harness.engine.getPlayer('p1');
  expectCondition(player, 'Player should exist');
  if (!player) return;
  player.hand = [
    { id: 'c-j', rank: 'J', suit: 'clubs' },
    { id: 'd-q', rank: 'Q', suit: 'diamonds' },
    { id: 'h-k', rank: 'K', suit: 'hearts' },
  ];
  const total = (harness.engine as any).computeComboTotal(player, [
    { cardId: 'c-j', mode: 'low' },
    { cardId: 'd-q', mode: 'low' },
    { cardId: 'h-k', mode: 'low' },
  ]);
  expectCondition(total === 11 + 12 + 13, `Court cards should total 36, got ${total}`);
};

const runSuitMatchUniquenessTest = () => {
  const engine = new GameEngine();
  (engine as any).bossCards = [
    { id: 'b1', rank: '2', suit: 'hearts' },
    { id: 'b2', rank: '3', suit: 'clubs' },
    { id: 'b3', rank: '4', suit: 'clubs' },
    { id: 'b4', rank: '5', suit: 'diamonds' },
  ];
  (engine as any).bossRevealedCount = 4;
  const cards: Card[] = [
    { id: 'p1', rank: '6', suit: 'hearts' },
    { id: 'p2', rank: '7', suit: 'hearts' },
    { id: 'p3', rank: '8', suit: 'clubs' },
    { id: 'p4', rank: '9', suit: 'spades' },
  ];
  const matches = (engine as any).countSuitMatches(cards);
  expectCondition(matches === 2, `Suit matches should cap at available boss cards, got ${matches}`);
};

const main = () => {
  runDirectionTest();
  runGapTest();
  runBettingRoundTest();
  runCourtValueTest();
  runSuitMatchUniquenessTest();
  // eslint-disable-next-line no-console
  console.log('Engine simulations passed');
};

main();
