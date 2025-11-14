export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';

export type Rank =
  | 'A'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10'
  | 'J'
  | 'Q'
  | 'K';

export interface Card {
  id: string;
  rank: Rank;
  suit: Suit;
}

export const SEAT_COUNT = 6;
export type SeatIndex = 1 | 2 | 3 | 4 | 5 | 6;

export type Phase =
  | 'waiting'
  | 'rush'
  | 'charge'
  | 'stomp'
  | 'combo'
  | 'oxtail'
  | 'showdown'
  | 'hand_end';

export interface PlayerSummary {
  id: string;
  username: string;
  seatIndex: SeatIndex;
  stack: number;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  inHand: boolean;
  hasFolded: boolean;
  isActing: boolean;
  betThisRound: number;
  comboRevealed?: Card[];
}

export interface SeatInfo {
  seatIndex: SeatIndex;
  occupied: boolean;
  player?: PlayerSummary;
}

export interface TableSnapshot {
  seats: SeatInfo[];
  phase: Phase;
  handNumber: number;
  pot: number;
  sidePot: number;
  currentBet: number;
  minimumRaise: number;
  actingSeat?: SeatIndex;
  bossCards: Card[];
  bossRevealedCount: number;
  message: string;
}

export type ComboMode = 'low' | 'high';

export interface ComboSelection {
  cardId: string;
  mode: ComboMode;
}

export interface PlayerPrivateState {
  playerId: string;
  seatIndex?: SeatIndex;
  stack: number;
  hand: Card[];
  comboSelection: ComboSelection[];
  comboTotal: number;
  actions: PlayerAction[];
}

export type PlayerAction = 'fold' | 'check' | 'call' | 'raise' | 'submit_combo';

export interface HandResult {
  winners: { playerId: string; username: string; amount: number }[];
  bossTotal: number;
  description: string;
}

export interface JoinTableMessage {
  username: string;
}

export interface SeatTakeMessage {
  seatIndex: SeatIndex;
}

export interface BetActionMessage {
  action: 'fold' | 'check' | 'call' | 'raise';
}

export interface ComboUpdateMessage {
  selections: ComboSelection[];
}

export interface ComboSubmitMessage {
  selections: ComboSelection[];
}

export interface ClientToServerEvents {
  join_table: (msg: JoinTableMessage) => void;
  seat_take: (msg: SeatTakeMessage) => void;
  seat_leave: () => void;
  start_hand: () => void;
  bet_action: (msg: BetActionMessage) => void;
  combo_update: (msg: ComboUpdateMessage) => void;
  combo_submit: (msg: ComboSubmitMessage) => void;
  restart_table: () => void;
  heartbeat: () => void;
}

export interface ServerToClientEvents {
  table_snapshot: (snapshot: TableSnapshot) => void;
  player_private_state: (state: PlayerPrivateState) => void;
  hand_result: (result: HandResult) => void;
  error: (message: string) => void;
  table_reset: () => void;
}
