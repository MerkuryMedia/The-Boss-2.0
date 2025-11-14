import {
  BetActionMessage,
  Card,
  ComboSelection,
  ComboSubmitMessage,
  ComboUpdateMessage,
  HandResult,
  Phase,
  PlayerAction,
  PlayerPrivateState,
  PlayerSummary,
  SeatIndex,
  TableSnapshot,
  SEAT_COUNT,
} from '../shared/types';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const;

export interface EnginePlayer {
  id: string;
  username: string;
  seatIndex?: SeatIndex;
  stack: number;
  entryHand: number;
  hand: Card[];
  inHand: boolean;
  hasFolded: boolean;
  betThisRound: number;
  totalBet: number;
  comboSelection: ComboSelection[];
  comboRevealed?: Card[];
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  lastAction?: string;
}

export type EngineEvent =
  | { type: 'snapshot'; snapshot: TableSnapshot }
  | { type: 'private'; playerId: string; state: PlayerPrivateState }
  | { type: 'result'; result: HandResult }
  | { type: 'error'; playerId?: string; message: string };

const STARTING_STACK = 500;
const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const RAISE_INCREMENT = 10;

export class GameEngine {
  private players = new Map<string, EnginePlayer>();
  private seats: (string | null)[] = Array(SEAT_COUNT).fill(null);
  private handNumber = 0;
  private deck: Card[] = [];
  private bossCards: Card[] = [];
  private bossRevealedCount = 0;
  private bossVisible = false;
  private smallBlindSeat?: SeatIndex;
  private phase: Phase = 'waiting';
  private dealerSeat?: SeatIndex;
  private currentBet = 0;
  private minimumRaise = RAISE_INCREMENT;
  private pot = 0;
  private sidePot = 0;
  private actingSeat?: SeatIndex;
  private message = 'Waiting for players';
  private actedThisRound = new Set<SeatIndex>();
  private awaitingCombo = new Set<string>();
  private comboQueue: SeatIndex[] = [];
  private comboIndex = 0;
  private lastResult?: HandResult;

  private broadcastCallback?: (event: EngineEvent) => void;

  onBroadcast(callback: (event: EngineEvent) => void) {
    this.broadcastCallback = callback;
  }

  private emit(event: EngineEvent) {
    if (this.broadcastCallback) {
      this.broadcastCallback(event);
    }
  }

  getPlayer(playerId: string) {
    return this.players.get(playerId);
  }

  join(playerId: string, username: string) {
    if (!this.players.has(playerId)) {
      this.players.set(playerId, {
        id: playerId,
        username,
        stack: STARTING_STACK,
        entryHand: this.handNumber + (this.isHandActive() ? 1 : 0),
        hand: [],
        inHand: false,
        hasFolded: false,
        betThisRound: 0,
        totalBet: 0,
        comboSelection: [],
        isDealer: false,
        isSmallBlind: false,
        isBigBlind: false,
      });
    } else {
      const existing = this.players.get(playerId)!;
      existing.username = username;
    }
    this.updatePrivate(playerId);
    this.broadcast();
  }

  seatTake(playerId: string, seatIndex: SeatIndex) {
    const player = this.players.get(playerId);
    if (!player) return this.emit({ type: 'error', playerId, message: 'Join first' });
    const seatSlot = seatIndex - 1;
    if (this.seats[seatSlot] && this.seats[seatSlot] !== playerId) {
      return this.emit({ type: 'error', playerId, message: 'Seat taken' });
    }
    if (player.seatIndex) {
      this.seats[player.seatIndex - 1] = null;
    }
    this.seats[seatSlot] = playerId;
    player.seatIndex = seatIndex;
    player.entryHand = this.handNumber + (this.isHandActive() ? 1 : 0);
    if (!this.dealerSeat) {
      this.dealerSeat = seatIndex;
      player.isDealer = true;
    }
    this.broadcast();
  }

  seatLeave(playerId: string) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.seatIndex) {
      if (this.dealerSeat === player.seatIndex && this.phase === 'waiting') {
        this.dealerSeat = this.findNextDealerSeat(player.seatIndex);
      }
      this.seats[player.seatIndex - 1] = null;
    }
    if (player.inHand) {
      player.hasFolded = true;
      player.inHand = false;
    }
    const leftSeat = player.seatIndex;
    player.seatIndex = undefined;
    if (this.phase === 'combo' && this.awaitingCombo.delete(player.id)) {
      if (leftSeat === this.actingSeat) {
        if (this.awaitingCombo.size === 0) {
          this.actingSeat = undefined;
          this.updateActionMessage();
          this.evaluateCombos();
        } else if (!this.setNextComboActor(this.comboIndex + 1)) {
          this.evaluateCombos();
        }
      }
    } else if (leftSeat && leftSeat === this.actingSeat) {
      this.advanceTurn();
    }
    this.broadcast();
  }

  startHand(playerId: string) {
    const player = this.players.get(playerId);
    if (!player || !player.isDealer) {
      return this.emit({ type: 'error', playerId, message: 'Only dealer can start' });
    }
    if (this.isHandActive()) {
      return this.emit({ type: 'error', playerId, message: 'Hand already running' });
    }
    const seated = this.getEligibleSeatedPlayers();
    if (seated.length < 2) {
      return this.emit({ type: 'error', playerId, message: 'Need at least two players' });
    }
    this.beginHand(seated);
    this.broadcast();
  }

  betAction(playerId: string, message: BetActionMessage) {
    const player = this.players.get(playerId);
    if (!player || !player.inHand || player.hasFolded) {
      return this.emit({ type: 'error', playerId, message: 'Invalid action' });
    }
    if (!this.actingSeat || player.seatIndex !== this.actingSeat) {
      return this.emit({ type: 'error', playerId, message: 'Not your turn' });
    }
    if (!player.seatIndex) {
      return this.emit({ type: 'error', playerId, message: 'Invalid seat' });
    }
    let resetActed = false;
    switch (message.action) {
      case 'fold':
        player.hasFolded = true;
        player.inHand = false;
        player.lastAction = 'Fold';
        break;
      case 'check':
        if (this.currentBet > player.betThisRound) {
          return this.emit({ type: 'error', playerId, message: 'Cannot check' });
        }
        player.lastAction = 'Check';
        break;
      case 'call':
        this.callContribution(player);
        player.lastAction = 'Call';
        break;
      case 'raise': {
        if (player.stack <= 0) {
          return this.emit({ type: 'error', playerId, message: 'No chips' });
        }
        const desiredRaise = message.amount ?? RAISE_INCREMENT;
        if (desiredRaise < RAISE_INCREMENT || desiredRaise % RAISE_INCREMENT !== 0) {
          return this.emit({ type: 'error', playerId, message: 'Invalid raise amount' });
        }
        const callNeeded = Math.max(0, this.currentBet - player.betThisRound);
        if (player.stack <= callNeeded) {
          return this.emit({ type: 'error', playerId, message: 'Not enough chips to raise' });
        }
        const availableRaise = Math.min(
          desiredRaise,
          Math.floor((player.stack - callNeeded) / RAISE_INCREMENT) * RAISE_INCREMENT,
        );
        if (availableRaise < RAISE_INCREMENT) {
          return this.emit({ type: 'error', playerId, message: 'Raise below minimum' });
        }
        const needed = callNeeded + availableRaise;
        this.commitAmount(player, needed);
        this.currentBet = player.betThisRound;
        this.minimumRaise = Math.max(RAISE_INCREMENT, availableRaise);
        player.lastAction = 'Raise';
        resetActed = true;
        break;
      }
    }
    this.markSeatActed(player.seatIndex, resetActed);
    this.advanceTurn();
    this.broadcast();
  }

  comboUpdate(playerId: string, message: ComboUpdateMessage) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.hand.length === 0) return;
    const selections = this.sanitizeSelections(player, message.selections);
    player.comboSelection = selections;
    this.updatePrivate(playerId);
  }

  comboSubmit(playerId: string, message: ComboSubmitMessage) {
    const player = this.players.get(playerId);
    if (!player || !player.inHand || player.hasFolded) return;
    if (this.phase !== 'combo') {
      return this.emit({ type: 'error', playerId, message: 'Not combo phase' });
    }
    if (!this.awaitingCombo.has(playerId)) return;
    if (!player.seatIndex || player.seatIndex !== this.actingSeat) {
      return this.emit({ type: 'error', playerId, message: 'Not your turn' });
    }
    const selections = this.sanitizeSelections(player, message.selections);
    const total = this.computeComboTotal(player, selections);
    const bossTotal = this.computeBossTotal();
    if (total > bossTotal) {
      return this.emit({ type: 'error', playerId, message: 'Combo exceeds Boss total' });
    }
    player.comboSelection = selections;
    player.comboRevealed = selections.map((selection) => this.findCardInHand(player, selection.cardId)!);
    this.awaitingCombo.delete(playerId);
    if (this.awaitingCombo.size === 0) {
      this.actingSeat = undefined;
      this.updateActionMessage();
      this.evaluateCombos();
    } else if (!this.setNextComboActor(this.comboIndex + 1)) {
      this.evaluateCombos();
    } else {
      this.broadcast();
    }
  }

  restartTable() {
    for (const player of this.players.values()) {
      player.stack = STARTING_STACK;
      player.seatIndex = undefined;
      player.entryHand = 0;
      player.hand = [];
      player.inHand = false;
      player.hasFolded = false;
      player.betThisRound = 0;
      player.totalBet = 0;
      player.comboSelection = [];
      player.comboRevealed = undefined;
      player.isDealer = false;
      player.isSmallBlind = false;
      player.isBigBlind = false;
    }
    this.seats = Array(SEAT_COUNT).fill(null);
    this.handNumber = 0;
    this.deck = [];
    this.bossCards = [];
    this.bossRevealedCount = 0;
    this.bossVisible = false;
    this.smallBlindSeat = undefined;
    this.phase = 'waiting';
    this.dealerSeat = undefined;
    this.currentBet = 0;
    this.minimumRaise = RAISE_INCREMENT;
    this.pot = 0;
    this.sidePot = 0;
    this.actingSeat = undefined;
    this.message = 'Waiting for players';
    this.awaitingCombo.clear();
    this.comboQueue = [];
    this.comboIndex = 0;
    this.lastResult = undefined;
    this.actedThisRound.clear();
    this.broadcast();
  }

  private beginHand(players: EnginePlayer[]) {
    this.handNumber += 1;
    this.resetPlayersForHand(players);
    this.deck = this.buildDeck();
    this.bossCards = this.drawCards(5);
    this.bossRevealedCount = 3;
    this.bossVisible = false;
    this.phase = 'rush';
    this.pot = 0;
    this.sidePot = 0;
    this.currentBet = 0;
    this.minimumRaise = RAISE_INCREMENT;
    this.message = 'The Rush';
    this.dealHands(players);
    this.bossVisible = true;
    this.assignBlinds(players);
    this.startBettingRound(this.smallBlindSeat);
  }

  private resetPlayersForHand(players: EnginePlayer[]) {
    for (const player of this.players.values()) {
      player.inHand = false;
      player.hasFolded = false;
      player.betThisRound = 0;
      player.totalBet = 0;
      player.comboSelection = [];
      player.comboRevealed = undefined;
      player.isSmallBlind = false;
      player.isBigBlind = false;
      player.hand = [];
      player.lastAction = undefined;
    }
    for (const p of players) {
      p.inHand = true;
    }
  }

  private dealHands(players: EnginePlayer[]) {
    for (const player of players) {
      player.hand = this.drawCards(7);
    }
  }

  private assignBlinds(players: EnginePlayer[]) {
    if (!this.dealerSeat) {
      this.dealerSeat = players[0].seatIndex!;
      players[0].isDealer = true;
    }
    for (const player of players) {
      player.isDealer = player.seatIndex === this.dealerSeat;
    }
    const playerCount = players.length;
    let sbSeat: SeatIndex;
    let bbSeat: SeatIndex;
    if (playerCount === 2) {
      sbSeat = this.dealerSeat!;
      bbSeat = this.getNextOccupiedSeat(sbSeat)!;
    } else {
      sbSeat = this.getNextOccupiedSeat(this.dealerSeat!)!;
      bbSeat = this.getNextOccupiedSeat(sbSeat)!;
    }
    this.smallBlindSeat = sbSeat;
    const sbPlayer = this.getPlayerBySeat(sbSeat);
    const bbPlayer = this.getPlayerBySeat(bbSeat);
    if (sbPlayer) {
      sbPlayer.isSmallBlind = true;
      this.commitAmount(sbPlayer, SMALL_BLIND);
      sbPlayer.betThisRound = SMALL_BLIND;
      this.currentBet = Math.max(this.currentBet, sbPlayer.betThisRound);
    }
    if (bbPlayer) {
      bbPlayer.isBigBlind = true;
      this.commitAmount(bbPlayer, BIG_BLIND);
      bbPlayer.betThisRound = BIG_BLIND;
      this.currentBet = Math.max(this.currentBet, bbPlayer.betThisRound);
    }
  }

  private startBettingRound(referenceSeat?: SeatIndex) {
    const startSeat = referenceSeat ?? this.smallBlindSeat ?? this.getSeatLeftOfDealer();
    this.actedThisRound.clear();
    this.actingSeat = this.findNextActingSeat(startSeat, true);
    if (!this.actingSeat) {
      this.finishBettingRound();
      return;
    }
    this.updateActionMessage();
  }

  private advanceTurn() {
    if (!this.actingSeat) return;
    if (this.isBettingRoundComplete()) {
      this.finishBettingRound();
      return;
    }
    const currentSeat = this.actingSeat;
    this.actingSeat = this.findNextActingSeat(currentSeat, false);
    if (!this.actingSeat) {
      this.finishBettingRound();
    } else {
      this.updateActionMessage();
    }
  }

  private isBettingRoundComplete() {
    const active = this.activePlayers();
    if (active.length <= 1) return true;
    if (!this.haveAllRequiredPlayersActed()) return false;
    return active.every((p) => p.betThisRound === this.currentBet || p.stack === 0);
  }

  private haveAllRequiredPlayersActed() {
    for (const player of this.players.values()) {
      if (!player.inHand || player.hasFolded) continue;
      if (!player.seatIndex) continue;
      if (player.stack === 0) continue;
      if (!this.actedThisRound.has(player.seatIndex)) {
        return false;
      }
    }
    return true;
  }

  private markSeatActed(seat: SeatIndex | undefined, reset = false) {
    if (!seat) return;
    if (reset) {
      this.actedThisRound.clear();
    }
    this.actedThisRound.add(seat);
  }

  private finishBettingRound() {
    this.actingSeat = undefined;
    this.actedThisRound.clear();
    for (const player of this.players.values()) {
      player.betThisRound = 0;
    }
    this.currentBet = 0;
    this.minimumRaise = RAISE_INCREMENT;
    if (this.activePlayers().length <= 1) {
      this.resolveHandByFold();
      return;
    }
    switch (this.phase) {
      case 'rush':
        this.phase = 'charge';
        this.bossRevealedCount = 4;
        this.startBettingRound(this.smallBlindSeat);
        break;
      case 'charge':
        this.phase = 'stomp';
        this.bossRevealedCount = 5;
        this.startBettingRound(this.smallBlindSeat);
        break;
      case 'stomp':
        this.enterComboPhase();
        break;
      case 'oxtail':
        this.enterComboPhase(true);
        break;
    }
  }

  private enterComboPhase(oxtail = false) {
    this.phase = 'combo';
    this.awaitingCombo.clear();
    const active = this.activePlayers();
    for (const player of active) {
      this.awaitingCombo.add(player.id);
      if (!oxtail) {
        player.comboSelection = [];
        player.comboRevealed = undefined;
      }
    }
    this.comboQueue = this.buildComboOrder();
    this.comboIndex = 0;
    if (this.awaitingCombo.size === 0) {
      this.actingSeat = undefined;
      this.updateActionMessage();
      this.evaluateCombos();
      return;
    }
    if (!this.setNextComboActor(0)) {
      this.evaluateCombos();
      return;
    }
    this.broadcast();
  }

  private resolveHandByFold() {
    const remaining = this.activePlayers();
    const recipient = remaining[0];
    if (recipient) {
      const award = this.totalPot();
      recipient.stack += award;
      this.lastResult = {
        winners: [{ playerId: recipient.id, username: recipient.username, amount: award }],
        bossTotal: this.computeBossTotal(),
        description: `${recipient.username} wins by default`,
      };
      this.emit({ type: 'result', result: this.lastResult });
    }
    this.endHand();
  }

  private evaluateCombos() {
    const contenders = this.activePlayers().filter((p) => !p.hasFolded);
    if (contenders.length === 0) {
      this.resolveHandByFold();
      return;
    }
    const evaluated = contenders.map((player) => {
      const cards = player.comboSelection
        .map((selection) => this.findCardInHand(player, selection.cardId))
        .filter((card): card is Card => Boolean(card));
      const total = this.computeComboTotal(player, player.comboSelection);
      const bossTotal = this.computeBossTotal();
      return {
        player,
        total,
        diff: Math.abs(bossTotal - total),
        under: total <= bossTotal,
        suitMatches: this.countSuitMatches(cards),
      };
    });
    evaluated.sort((a, b) => {
      if (a.diff !== b.diff) return a.diff - b.diff;
      if (a.under !== b.under) return a.under ? -1 : 1;
      if (a.suitMatches !== b.suitMatches) return b.suitMatches - a.suitMatches;
      return 0;
    });
    const best = evaluated[0];
    const ties = evaluated.filter(
      (item) =>
        item.diff === best.diff && item.under === best.under && item.suitMatches === best.suitMatches,
    );
    if (ties.length > 1) {
      if (this.deck.length === 0) {
        this.splitPot(ties.map((t) => t.player));
      } else {
        this.startOxtail();
      }
      return;
    }
    this.awardPot(best.player);
  }

  private startOxtail() {
    this.phase = 'oxtail';
    const newCard = this.drawCards(1)[0];
    this.bossCards.push(newCard);
    this.bossRevealedCount += 1;
    this.startBettingRound(this.smallBlindSeat);
  }

  private splitPot(players: EnginePlayer[]) {
    const award = Math.floor(this.totalPot() / players.length);
    for (const player of players) {
      player.stack += award;
    }
    this.lastResult = {
      winners: players.map((p) => ({ playerId: p.id, username: p.username, amount: award })),
      bossTotal: this.computeBossTotal(),
      description: `Split pot among ${players.length} players`,
    };
    this.emit({ type: 'result', result: this.lastResult });
    this.endHand();
  }

  private awardPot(player: EnginePlayer) {
    const total = this.totalPot();
    player.stack += total;
    this.lastResult = {
      winners: [{ playerId: player.id, username: player.username, amount: total }],
      bossTotal: this.computeBossTotal(),
      description: `${player.username} wins ${total}`,
    };
    this.emit({ type: 'result', result: this.lastResult });
    this.endHand();
  }

  private endHand() {
    this.phase = 'waiting';
    this.bossCards = [];
    this.bossRevealedCount = 0;
    this.bossVisible = false;
    this.actingSeat = undefined;
    this.message = 'Waiting for dealer';
    this.awaitingCombo.clear();
    this.comboQueue = [];
    this.comboIndex = 0;
    this.rotateDealer();
    for (const player of this.players.values()) {
      player.inHand = false;
      player.hasFolded = false;
      player.comboSelection = [];
      player.comboRevealed = undefined;
      player.betThisRound = 0;
    }
    this.broadcast();
  }

  private rotateDealer() {
    if (!this.dealerSeat) {
      const seat = this.getNextOccupiedSeat(1 as SeatIndex);
      if (seat) this.dealerSeat = seat;
      return;
    }
    const next = this.getNextOccupiedSeat(this.dealerSeat);
    if (next) {
      this.dealerSeat = next;
      for (const player of this.players.values()) {
        player.isDealer = player.seatIndex === this.dealerSeat;
      }
    }
  }

  private drawCards(count: number) {
    const cards: Card[] = [];
    for (let i = 0; i < count; i += 1) {
      const card = this.deck.pop();
      if (!card) break;
      cards.push(card);
    }
    return cards;
  }

  private buildDeck() {
    const deck: Card[] = [];
    let counter = 0;
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({ id: `${rank}-${suit}-${counter++}`, rank, suit });
      }
    }
    for (let i = deck.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  private getSeatLeftOfDealer(): SeatIndex {
    if (!this.dealerSeat) return 1 as SeatIndex;
    return this.getNextOccupiedSeat(this.dealerSeat) || this.dealerSeat;
  }

  private getNextOccupiedSeat(start: SeatIndex): SeatIndex | undefined {
    return this.findSeatInDirection(start, (player) => Boolean(player), false);
  }

  private findNextActingSeat(start: SeatIndex | undefined, includeStart: boolean): SeatIndex | undefined {
    return this.findSeatInDirection(
      start,
      (player) => Boolean(player && player.inHand && !player.hasFolded && player.stack > 0),
      includeStart,
    );
  }

  private getNextSeatIndex(seat: SeatIndex): SeatIndex {
    return ((seat % SEAT_COUNT) + 1) as SeatIndex;
  }

  private findSeatInDirection(
    start: SeatIndex | undefined,
    predicate: (player: EnginePlayer | undefined) => boolean,
    includeStart = false,
  ): SeatIndex | undefined {
    if (!start) return undefined;
    let seat = includeStart ? start : this.getNextSeatIndex(start);
    for (let i = 0; i < SEAT_COUNT; i += 1) {
      const player = this.getPlayerBySeat(seat);
      if (predicate(player)) {
        return seat;
      }
      seat = this.getNextSeatIndex(seat);
    }
    return undefined;
  }

  private commitAmount(player: EnginePlayer, amount: number) {
    const contribution = Math.min(player.stack, amount);
    player.stack -= contribution;
    player.betThisRound += contribution;
    player.totalBet += contribution;
    this.pot = this.totalPot();
    this.updateSidePotValues();
  }

  private callContribution(player: EnginePlayer) {
    const needed = this.currentBet - player.betThisRound;
    if (needed <= 0) return;
    this.commitAmount(player, needed);
  }

  private totalPot() {
    let total = 0;
    for (const player of this.players.values()) {
      total += player.totalBet;
    }
    return total;
  }

  private updateSidePotValues() {
    const allInPlayers = this.activePlayers().filter((p) => p.stack === 0);
    if (allInPlayers.length === 0) {
      this.pot = this.totalPot();
      this.sidePot = 0;
      return;
    }
    const cap = Math.min(...allInPlayers.map((p) => p.totalBet));
    let main = 0;
    let side = 0;
    for (const player of this.players.values()) {
      const contrib = player.totalBet;
      main += Math.min(contrib, cap);
      if (contrib > cap) {
        side += contrib - cap;
      }
    }
    this.pot = main;
    this.sidePot = side;
  }

  private sanitizeSelections(player: EnginePlayer, selections: ComboSelection[]) {
    const result: ComboSelection[] = [];
    const seen = new Set<string>();
    for (const selection of selections) {
      if (seen.has(selection.cardId)) continue;
      const card = this.findCardInHand(player, selection.cardId);
      if (!card) continue;
      const mode = card.rank === 'A' && selection.mode === 'high' ? 'high' : 'low';
      result.push({ cardId: card.id, mode });
      seen.add(card.id);
    }
    return result;
  }

  private findCardInHand(player: EnginePlayer, cardId: string) {
    return player.hand.find((card) => card.id === cardId);
  }

  private computeComboTotal(player: EnginePlayer, selections: ComboSelection[]) {
    let total = 0;
    for (const selection of selections) {
      const card = this.findCardInHand(player, selection.cardId);
      if (!card) continue;
      if (card.rank === 'A') {
        total += selection.mode === 'high' ? 11 : 1;
      } else {
        total += this.getCardValue(card.rank);
      }
    }
    return total;
  }

  private computeBossTotal() {
    const cards = this.bossCards.slice(0, this.bossRevealedCount);
    return cards.reduce((sum, card) => sum + this.getBossCardValue(card.rank), 0);
  }

  private countSuitMatches(cards: Card[]) {
    const bossCounts = new Map<Card['suit'], number>();
    for (const card of this.bossCards.slice(0, this.bossRevealedCount)) {
      bossCounts.set(card.suit, (bossCounts.get(card.suit) ?? 0) + 1);
    }
    let matches = 0;
    for (const card of cards) {
      const remaining = bossCounts.get(card.suit) ?? 0;
      if (remaining > 0) {
        matches += 1;
        bossCounts.set(card.suit, remaining - 1);
      }
    }
    return matches;
  }

  private getCardValue(rank: Card['rank']) {
    switch (rank) {
      case 'A':
        return 1;
      case 'J':
        return 11;
      case 'Q':
        return 12;
      case 'K':
        return 13;
      default:
        return parseInt(rank, 10);
    }
  }

  private getBossCardValue(rank: Card['rank']) {
    if (rank === 'A') return 1;
    return this.getCardValue(rank);
  }

  private buildComboOrder() {
    const order: SeatIndex[] = [];
    const startSeat = this.smallBlindSeat ?? this.getSeatLeftOfDealer();
    let seat = startSeat;
    for (let i = 0; i < SEAT_COUNT; i += 1) {
      const player = this.getPlayerBySeat(seat);
      if (player && player.inHand && !player.hasFolded) {
        order.push(seat);
      }
      seat = this.getNextSeatIndex(seat);
    }
    return order;
  }

  private setNextComboActor(startIndex: number) {
    for (let idx = startIndex; idx < this.comboQueue.length; idx += 1) {
      const seat = this.comboQueue[idx];
      const player = this.getPlayerBySeat(seat);
      if (player && this.awaitingCombo.has(player.id) && player.inHand && !player.hasFolded) {
        this.comboIndex = idx;
        this.actingSeat = seat;
        this.updateActionMessage();
        return true;
      }
    }
    this.comboIndex = this.comboQueue.length;
    this.actingSeat = undefined;
    this.updateActionMessage();
    return false;
  }

  private getPhaseLabel() {
    switch (this.phase) {
      case 'rush':
        return 'The Rush';
      case 'charge':
        return 'The Charge';
      case 'stomp':
        return 'The Stomp';
      case 'combo':
        return 'Submit combos';
      case 'oxtail':
        return 'Oxtail betting';
      case 'waiting':
      default:
        return 'Waiting for dealer';
    }
  }

  private updateActionMessage() {
    if (this.actingSeat) {
      const player = this.getPlayerBySeat(this.actingSeat);
      if (player) {
        const comboSuffix = this.phase === 'combo' ? ' – Submit combo' : '';
        this.message = `Action to ${player.username}${comboSuffix}`;
        return;
      }
    }
    this.message = this.getPhaseLabel();
  }

  private getEligibleSeatedPlayers() {
    const list: EnginePlayer[] = [];
    for (const seat of this.seats) {
      if (!seat) continue;
      const player = this.players.get(seat);
      if (!player || !player.seatIndex) continue;
      if (this.handNumber >= player.entryHand) list.push(player);
    }
    return list;
  }

  private activePlayers() {
    const list: EnginePlayer[] = [];
    for (const player of this.players.values()) {
      if (player.inHand && !player.hasFolded) list.push(player);
    }
    return list;
  }

  private findNextDealerSeat(current: SeatIndex) {
    for (let i = 0; i < SEAT_COUNT; i += 1) {
      const seat = ((current - 1 + i + 1) % SEAT_COUNT) + 1;
      if (this.seats[seat - 1]) {
        return seat as SeatIndex;
      }
    }
    return undefined;
  }

  private updatePrivate(playerId: string) {
    const player = this.players.get(playerId);
    if (!player) return;
    const state: PlayerPrivateState = {
      playerId,
      seatIndex: player.seatIndex,
      stack: player.stack,
      hand: player.hand,
      comboSelection: player.comboSelection,
      comboTotal: this.computeComboTotal(player, player.comboSelection),
      actions: this.getAvailableActions(player),
    };
    this.emit({ type: 'private', playerId, state });
  }

  private getAvailableActions(player: EnginePlayer): PlayerAction[] {
    if (!player.inHand || player.hasFolded) return [];
    if (
      this.phase === 'combo' &&
      this.awaitingCombo.has(player.id) &&
      player.seatIndex === this.actingSeat
    ) {
      return ['submit_combo'];
    }
    if (!this.actingSeat || player.seatIndex !== this.actingSeat) return [];
    const actions: PlayerAction[] = ['fold'];
    if (this.currentBet === player.betThisRound) {
      actions.push('check', 'raise');
    } else if (this.currentBet > player.betThisRound) {
      actions.push('call', 'raise');
    } else {
      actions.push('raise');
    }
    return Array.from(new Set(actions));
  }

  private broadcast() {
    for (const playerId of this.players.keys()) {
      this.updatePrivate(playerId);
    }

    const snapshot: TableSnapshot = {
      seats: this.seats.map((playerId, index) => {
        const seatIndex = (index + 1) as SeatIndex;
        const player = playerId ? this.players.get(playerId) : undefined;
        const summary: PlayerSummary | undefined = player
          ? {
              id: player.id,
              username: player.username,
              seatIndex,
              stack: player.stack,
              isDealer: player.isDealer,
              isSmallBlind: player.isSmallBlind,
              isBigBlind: player.isBigBlind,
              inHand: player.inHand,
              hasFolded: player.hasFolded,
              isActing: this.actingSeat === seatIndex,
              betThisRound: player.betThisRound,
              comboRevealed: player.comboRevealed,
            }
          : undefined;
        return {
          seatIndex,
          occupied: Boolean(playerId),
          player: summary,
        };
      }),
      phase: this.phase,
      handNumber: this.handNumber,
      pot: this.pot,
      sidePot: this.sidePot,
      currentBet: this.currentBet,
      minimumRaise: this.minimumRaise,
      actingSeat: this.actingSeat,
      bossCards: this.bossVisible ? this.bossCards.slice(0, this.bossRevealedCount) : [],
      bossRevealedCount: this.bossVisible ? this.bossRevealedCount : 0,
      message: this.message,
    };
    this.emit({ type: 'snapshot', snapshot });
  }

  private isHandActive() {
    return this.phase !== 'waiting';
  }

  private getPlayerBySeat(seatIndex: SeatIndex) {
    const playerId = this.seats[seatIndex - 1];
    if (!playerId) return undefined;
    return this.players.get(playerId);
  }
}
