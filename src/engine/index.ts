import {
  BetActionMessage,
  Card,
  ClientToServerEvents,
  ComboSubmitMessage,
  ComboUpdateMessage,
  HandResult,
  Phase,
  PlayerAction,
  PlayerPrivateState,
  PlayerSummary,
  SeatIndex,
  SeatInfo,
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
  comboSelection: string[];
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
  private phase: Phase = 'waiting';
  private dealerSeat?: SeatIndex;
  private currentBet = 0;
  private minimumRaise = RAISE_INCREMENT;
  private pot = 0;
  private sidePot = 0;
  private actingSeat?: SeatIndex;
  private message = 'Waiting for players';
  private bettingAnchorSeat?: SeatIndex;
  private lastAggressorSeat?: SeatIndex;
  private awaitingCombo = new Set<string>();
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
        stack: 500,
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
      player.seatIndex = undefined;
    }
    if (player.inHand) {
      player.hasFolded = true;
      player.inHand = false;
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
      case 'raise':
        if (player.stack <= 0) {
          return this.emit({ type: 'error', playerId, message: 'No chips' });
        }
        const target = this.currentBet + RAISE_INCREMENT;
        const needed = target - player.betThisRound;
        if (needed <= 0) {
          return this.emit({ type: 'error', playerId, message: 'Cannot raise' });
        }
        this.commitAmount(player, needed);
        this.currentBet = player.betThisRound;
        this.minimumRaise = RAISE_INCREMENT;
        this.lastAggressorSeat = player.seatIndex;
        player.lastAction = 'Raise';
        break;
    }
    this.advanceTurn();
    this.broadcast();
  }

  comboUpdate(playerId: string, message: ComboUpdateMessage) {
    const player = this.players.get(playerId);
    if (!player || !player.inHand || player.hasFolded) return;
    if (this.phase !== 'combo') return;
    if (!this.awaitingCombo.has(playerId)) return;
    const unique = Array.from(new Set(message.cardIds));
    if (!this.validateComboCards(player, unique)) {
      return;
    }
    player.comboSelection = unique;
    this.updatePrivate(playerId);
  }

  comboSubmit(playerId: string, message: ComboSubmitMessage) {
    const player = this.players.get(playerId);
    if (!player || !player.inHand || player.hasFolded) return;
    if (this.phase !== 'combo') {
      return this.emit({ type: 'error', playerId, message: 'Not combo phase' });
    }
    if (!this.awaitingCombo.has(playerId)) return;
    const unique = Array.from(new Set(message.cardIds));
    if (!this.validateComboCards(player, unique)) {
      return this.emit({ type: 'error', playerId, message: 'Invalid combo' });
    }
    const total = this.computeComboTotal(unique.map((id) => this.findCardInHand(player, id)!));
    const bossTotal = this.computeBossTotal();
    if (total > bossTotal) {
      return this.emit({ type: 'error', playerId, message: 'Combo exceeds Boss total' });
    }
    player.comboSelection = unique;
    player.comboRevealed = unique.map((id) => this.findCardInHand(player, id)!);
    this.awaitingCombo.delete(playerId);
    if (this.awaitingCombo.size === 0) {
      this.evaluateCombos();
    } else {
      this.broadcast();
    }
  }

  private beginHand(players: EnginePlayer[]) {
    this.handNumber += 1;
    this.resetPlayersForHand(players);
    this.deck = this.buildDeck();
    this.bossCards = this.drawCards(5);
    this.bossRevealedCount = 3;
    this.phase = 'rush';
    this.pot = 0;
    this.sidePot = 0;
    this.currentBet = 0;
    this.minimumRaise = RAISE_INCREMENT;
    this.message = 'The Rush';
    this.dealHands(players);
    this.assignBlinds(players);
    this.startBettingRound(this.getSeatLeftOfDealer());
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
      this.lastAggressorSeat = bbSeat;
    }
  }

  private startBettingRound(startSeat: SeatIndex) {
    this.bettingAnchorSeat = startSeat;
    this.actingSeat = this.findNextActingSeat(startSeat);
    for (const player of this.players.values()) {
      player.betThisRound = player.inHand && !player.hasFolded ? player.betThisRound : 0;
    }
    this.message = this.phase === 'rush' ? 'The Rush' : this.phase === 'charge' ? 'The Charge' : this.phase === 'stomp' ? 'The Stomp' : this.phase === 'oxtail' ? 'Oxtail Betting' : this.message;
  }

  private advanceTurn() {
    if (!this.actingSeat) return;
    const currentSeat = this.actingSeat;
    if (this.isBettingRoundComplete()) {
      this.finishBettingRound();
      return;
    }
    this.actingSeat = this.findNextActingSeat(this.getNextSeatIndex(currentSeat));
    if (!this.actingSeat) {
      this.finishBettingRound();
    }
  }

  private isBettingRoundComplete() {
    const active = this.activePlayers();
    if (active.length <= 1) return true;
    return active.every((p) => p.betThisRound === this.currentBet || p.stack === 0);
  }

  private finishBettingRound() {
    this.actingSeat = undefined;
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
        this.startBettingRound(this.getSeatLeftOfDealer());
        break;
      case 'charge':
        this.phase = 'stomp';
        this.bossRevealedCount = 5;
        this.startBettingRound(this.getSeatLeftOfDealer());
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
    for (const player of this.activePlayers()) {
      this.awaitingCombo.add(player.id);
      if (!oxtail) {
        player.comboSelection = [];
        player.comboRevealed = undefined;
      }
    }
    this.message = oxtail ? 'Rebuild combos' : 'Submit combos';
    if (this.awaitingCombo.size === 0) {
      this.evaluateCombos();
    } else {
      this.broadcast();
    }
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
      const cards = player.comboSelection.map((id) => this.findCardInHand(player, id)!);
      const total = this.computeComboTotal(cards);
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
    this.message = 'Oxtail!';
    this.startBettingRound(this.getSeatLeftOfDealer());
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
    this.actingSeat = undefined;
    this.message = 'Waiting for dealer';
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
    return this.getNextOccupiedSeat(this.dealerSeat!) || this.dealerSeat!;
  }

  private getNextOccupiedSeat(start: SeatIndex): SeatIndex | undefined {
    for (let i = 1; i <= SEAT_COUNT; i += 1) {
      const seat = ((start - 1 + i) % SEAT_COUNT) + 1;
      const playerId = this.seats[seat - 1];
      if (playerId) {
        const player = this.players.get(playerId);
        if (player && player.seatIndex === seat) {
          return seat as SeatIndex;
        }
      }
    }
    return undefined;
  }

  private findNextActingSeat(start: SeatIndex | undefined): SeatIndex | undefined {
    if (!start) return undefined;
    let seat = start;
    for (let i = 0; i < SEAT_COUNT; i += 1) {
      const playerId = this.seats[seat - 1];
      if (playerId) {
        const player = this.players.get(playerId);
        if (player && player.inHand && !player.hasFolded && player.stack >= 0) {
          if (player.betThisRound < this.currentBet || this.currentBet === 0 || this.lastAggressorSeat === seat) {
            return seat;
          }
          if (this.currentBet === 0) {
            return seat;
          }
        }
      }
      seat = this.getNextSeatIndex(seat);
    }
    return undefined;
  }

  private getNextSeatIndex(seat: SeatIndex): SeatIndex {
    return ((seat % SEAT_COUNT) + 1) as SeatIndex;
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

  private validateComboCards(player: EnginePlayer, cardIds: string[]) {
    if (cardIds.length === 0) return true;
    return cardIds.every((id) => this.findCardInHand(player, id));
  }

  private findCardInHand(player: EnginePlayer, cardId: string) {
    return player.hand.find((card) => card.id === cardId);
  }

  private computeComboTotal(cards: Card[]) {
    let total = 0;
    let aces = 0;
    for (const card of cards) {
      const value = this.getCardValue(card.rank);
      total += value;
      if (card.rank === 'A') aces += 1;
    }
    while (aces > 0 && total + 10 <= this.computeBossTotal()) {
      total += 10;
      aces -= 1;
    }
    return total;
  }

  private computeBossTotal() {
    const cards = this.bossCards.slice(0, this.bossRevealedCount);
    return cards.reduce((sum, card) => sum + this.getBossCardValue(card.rank), 0);
  }

  private countSuitMatches(cards: Card[]) {
    const bossSuits = this.bossCards.slice(0, this.bossRevealedCount).map((card) => card.suit);
    let matches = 0;
    for (const card of cards) {
      if (bossSuits.includes(card.suit)) matches += 1;
    }
    return matches;
  }

  private getCardValue(rank: Card['rank']) {
    switch (rank) {
      case 'A':
        return 1;
      case 'K':
      case 'Q':
      case 'J':
        return 10;
      default:
        return parseInt(rank, 10);
    }
  }

  private getBossCardValue(rank: Card['rank']) {
    if (rank === 'A') return 1;
    return this.getCardValue(rank);
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
      comboTotal: this.computeComboTotal(
        player.comboSelection.map((id) => this.findCardInHand(player, id)!),
      ),
      actions: this.getAvailableActions(player),
    };
    this.emit({ type: 'private', playerId, state });
  }

  private getAvailableActions(player: EnginePlayer): PlayerAction[] {
    if (!player.inHand || player.hasFolded) return [];
    if (this.phase === 'combo' && this.awaitingCombo.has(player.id)) {
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
      bossCards: this.bossCards.slice(0, this.bossRevealedCount),
      bossRevealedCount: this.bossRevealedCount,
      message: this.message,
    };
    this.emit({ type: 'snapshot', snapshot });
    for (const playerId of this.players.keys()) {
      this.updatePrivate(playerId);
    }
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
