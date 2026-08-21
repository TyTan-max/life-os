export interface BaseRecord {
  id: string;
  createdAt: string;
  updatedAt?: string;
}

export type Priority = 'Low' | 'Medium' | 'High' | 'Urgent';
export type Frequency = 'Daily' | 'Weekly' | 'Monthly' | 'Yearly';
export type TaskStatus = 'Not Started' | 'In Progress' | 'Completed';

export interface Task extends BaseRecord {
  title: string;
  status: TaskStatus;
  priority: Priority;
  dueDate: string;
  category?: string;
  project?: string;
  notes?: string;
  reminderAt?: string;
  recurring?: boolean;
  frequency?: Frequency;
  completedAt?: string;
}

export type HabitFrequency = 'Daily' | 'Weekdays' | 'Weekly' | 'Custom';

export interface Habit extends BaseRecord {
  name: string;
  description?: string;
  frequency: HabitFrequency;
  scheduledDays?: number[];
  checkins: string[];
  active?: boolean;
  reminderAt?: string;
  category?: string;
  order?: number;
  targetPerWeek?: number;
  excusedDates?: string[];
  // Which routine set(s) this habit belongs to — only shows up when one of these routines is
  // the selected view. There's no untagged fallback: once routines exist, an untagged habit
  // won't appear in any routine view.
  routineIds?: string[];
}

// A named routine (e.g. "Routine A", "Routine B") that habits can be tagged with — selecting one
// in the Weekly History view swaps in just that routine's habits instead of the whole list.
export interface HabitRoutine extends BaseRecord {
  name: string;
  order?: number;
}

// Labels a calendar date with whichever routine you were checking off habits under — set
// automatically the moment you toggle a habit while a specific routine is selected, so the
// Habit History Calendar shows which routine each day actually belonged to.
export interface RoutineDateAssignment extends BaseRecord {
  date: string;
  routineId: string;
}

export type GoalHorizon = 'Annual' | 'Quarterly' | 'Monthly' | 'Weekly';
export type GoalStatus = 'Not Started' | 'In Progress' | 'On Track' | 'At Risk' | 'Completed';
export type GoalProgressMode = 'percent' | 'range';

export interface Goal extends BaseRecord {
  title: string;
  horizon: GoalHorizon;
  progress: number;
  category?: string;
  targetDate?: string;
  notes?: string;
  parentId?: string;
  status?: GoalStatus;
  progressLabel?: string;
  progressMode?: GoalProgressMode;
  rangeStart?: number;
  rangeTarget?: number;
  rangeValue?: number;
  rangeUnit?: string;
}

export interface CalendarEvent extends BaseRecord {
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  reminderAt?: string;
  notes?: string;
}

export interface Budget extends BaseRecord {
  categoryId: string;
  month: string;
  limit: number;
  rolloverEnabled?: boolean;
}

export type FinanceAccountType = string;
export const CORE_ACCOUNT_TYPES = [
  'Checking', 'Savings', 'Cash', 'Credit Card', 'Personal Loan',
  'Student Loan', 'Auto Loan', 'Mortgage', 'Investment', 'Retirement', 'Other'
] as const;
export const CORE_DEBT_TYPES = ['Credit Card', 'Personal Loan', 'Student Loan', 'Auto Loan', 'Mortgage'] as const;

export type FinanceAccountStatus = 'Active' | 'Closed' | 'Frozen';

export interface FinanceAccount extends BaseRecord {
  name: string;
  type: FinanceAccountType;
  institution?: string;
  balance: number;
  availableBalance?: number;
  interestRate?: number;
  status: FinanceAccountStatus;
  lastSyncedAt?: string;
  notes?: string;
  costBasis?: number;
  assetClass?: InvestmentAssetClass;
  minimumPayment?: number;
  order?: number;
}

export type InvestmentAssetClass = 'Stocks' | 'ETFs' | 'Bonds' | 'Cash' | 'Real Estate' | 'Cryptocurrency' | 'Other';

export type FinanceCategoryKind = 'income' | 'expense';
export type BudgetGroup = 'Needs' | 'Wants';

export interface FinanceCategory extends BaseRecord {
  name: string;
  kind: FinanceCategoryKind;
  parentId?: string;
  color: string;
  icon?: string;
  order?: number;
  budgetGroup?: BudgetGroup;
}

export type TransactionType = string;
export const CORE_TRANSACTION_TYPES = ['Income', 'Expense', 'Transfer'] as const;

export interface Transaction extends BaseRecord {
  date: string;
  merchant: string;
  amount: number;
  accountId?: string;
  type: TransactionType;
  categoryId?: string;
  tags?: string[];
  notes?: string;
  recurring?: boolean;
  transfer?: boolean;
  transferAccountId?: string;
}

export type BillFrequency = 'Weekly' | 'Biweekly' | 'Monthly' | 'Quarterly' | 'Semiannual' | 'Yearly' | 'Once';

// Bills and subscriptions share one collection ("recurring costs"), distinguished by `kind`.
// Undefined `kind` is treated as 'Bill' for backward compatibility with pre-existing records.
export type RecurringKind = 'Bill' | 'Subscription';

export interface AmountHistoryEntry {
  date: string;
  amount: number;
}

export interface Bill extends BaseRecord {
  name: string;
  amount: number;
  nextDue: string;
  frequency?: BillFrequency;
  accountId?: string;
  categoryId?: string;
  reminderDaysBefore?: number;
  reminderAt?: string;
  autopay?: boolean;
  notes?: string;
  kind?: RecurringKind;
  // Bill-specific metadata
  isVariable?: boolean;
  varianceThresholdPct?: number;
  amountHistory?: AmountHistoryEntry[];
  // Subscription-specific metadata
  isFreeTrial?: boolean;
  trialEndDate?: string;
  usageRating?: number;
  priceHistory?: AmountHistoryEntry[];
  order?: number;
}

export type FinanceGoalCategory = string;
export const CORE_SAVINGS_CATEGORIES = [
  'Emergency Fund', 'House Down Payment', 'Vehicle', 'Vacation', 'Debt Payoff',
  'Investment Target', 'Retirement', 'Major Purchase', 'Custom'
] as const;

export interface FinanceGoal extends BaseRecord {
  name: string;
  category: FinanceGoalCategory;
  targetAmount: number;
  currentAmount: number;
  targetDate?: string;
  linkedAccountId?: string;
  notes?: string;
  order?: number;
}

// PARA method (Projects, Areas, Resources, Archives). Untyped notes (paraType
// undefined) are treated as "Inbox" — captured but not yet triaged.
export type ParaType = 'Project' | 'Area' | 'Resource';
export type ParaProjectStatus = 'Not Started' | 'In Progress' | 'Blocked' | 'Completed';
export type ResourceKind = 'Article' | 'Snippet' | 'Reference' | 'Idea' | 'Book Note' | 'Repo';
export type ReviewCadence = 'Weekly' | 'Monthly' | 'Quarterly';

export interface Note extends BaseRecord {
  title: string;
  body: string;
  tags?: string[];
  pinned?: boolean;

  paraType?: ParaType;
  // Archived is a status layered on top of paraType, not a separate type — kept
  // reversible by design (see [[Second Brain PARA Blueprint]] "golden rule").
  archived?: boolean;
  archivedAt?: string;

  // Projects
  status?: ParaProjectStatus;
  dueDate?: string;
  areaId?: string;
  nextAction?: string;

  // Areas
  standard?: string;
  reviewCadence?: ReviewCadence;
  lastReviewedAt?: string;

  // Resources
  resourceKind?: ResourceKind;
  sourceUrl?: string;

  // Code Vault (Resources where resourceKind is 'Snippet' or 'Repo')
  language?: string;
  repoUrl?: string;
  docsUrl?: string;
}

// A single session's per-set weights for one exercise (e.g. a 4-set ramp: [40, 50, 60, 70]),
// plus the rep count achieved on the final set — mirrors a ramping-weight training log where
// each set within one session can carry a different load, not a running history across sessions.
// Kept flat on the routine (keyed by exerciseId+date) rather than nested inside RoutineExercise
// so logged history survives structural edits/versioning of the exercise it belongs to.
export interface ExerciseSetLog {
  exerciseId: string;
  date: string;
  weights: (number | undefined)[];
  lastReps?: number;
}

export interface RoutineExercise {
  id: string;
  name: string;
  targetSets: number;
  // Free text rather than a number — reps targets are often a range ("10-12") or a
  // duration ("45 sec"), not always a plain rep count.
  targetReps: string;
}

export interface RoutineDay {
  id: string;
  name: string;
  warmup?: string;
  exercises: RoutineExercise[];
}

// A snapshot of the day/exercise structure effective from a given date onward. Editing the
// plan (renaming exercises, changing sets/reps, adding/removing exercises or days) while
// viewing a given date branches a new version effective from that date forward — earlier
// dates keep resolving to whichever version was active for them, untouched.
export interface RoutineVersion {
  effectiveFrom: string;
  days: RoutineDay[];
}

export interface WorkoutRoutine extends BaseRecord {
  name: string;
  versions: RoutineVersion[];
  exerciseLogs: ExerciseSetLog[];
  progressionNotes?: string;
  loggedDates?: string[];
}

// A free string, not a fixed union — the picklist shown in the UI starts from this default
// set but is fully user-editable (rename/delete/add) via Settings.workoutTypes, the same
// pattern Finance uses for custom debt types.
export type WorkoutType = string;
export const WORKOUT_TYPES: WorkoutType[] = ['Run', 'Walk', 'Strength', 'Cycling', 'Swim', 'Yoga', 'HIIT', 'Sports', 'Other'];

export interface WorkoutEntry extends BaseRecord {
  date: string;
  type: WorkoutType;
  durationMin: number;
  avgHr?: number;
  maxHr?: number;
  caloriesBurned?: number;
  // Rate of Perceived Exertion, 1-10 — the manual-entry stand-in for a device-measured strain score.
  rpe?: number;
  notes?: string;
}

export type WeightUnit = 'lb' | 'kg';

export interface WeightEntry extends BaseRecord {
  date: string;
  // Stored in whichever unit Settings.weightUnit was active at entry time — entries aren't
  // retroactively converted if the unit preference changes later.
  weight: number;
  bodyFatPct?: number;
  notes?: string;
}

export type GlucoseUnit = 'mg/dL' | 'mmol/L';
export type GlucoseContext = 'Fasting' | 'Before Meal' | 'After Meal' | 'Bedtime' | 'Random';
export const GLUCOSE_CONTEXTS: GlucoseContext[] = ['Fasting', 'Before Meal', 'After Meal', 'Bedtime', 'Random'];

export interface GlucoseEntry extends BaseRecord {
  date: string;
  time?: string;
  // Stored in whichever unit Settings.glucoseUnit was active at entry time.
  value: number;
  context?: GlucoseContext;
  notes?: string;
}

export type MealType = 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack';
export const MEAL_TYPES: MealType[] = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];

export interface MealEntry extends BaseRecord {
  date: string;
  mealType: MealType;
  description: string;
  calories?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
}

export interface SleepEntry extends BaseRecord {
  // The date you woke up, not the date you went to bed.
  date: string;
  bedTime?: string;
  wakeTime?: string;
  durationHours: number;
  quality?: number;
  remHours?: number;
  deepHours?: number;
  lightHours?: number;
  restingHr?: number;
  notes?: string;
}

export type MedicationFrequency = 'Once Daily' | 'Twice Daily' | 'Three Times Daily' | 'Weekly' | 'As Needed';
export const MEDICATION_FREQUENCIES: MedicationFrequency[] = ['Once Daily', 'Twice Daily', 'Three Times Daily', 'Weekly', 'As Needed'];

// Self-reported flags driving contextual nudges (see src/lib/healthInsights.ts) — not a
// clinical interaction database, just what the user knows about their own prescription.
export type MedicationFlag = 'Requires Dietary Fat' | 'Empty Stomach Only' | 'Affects Heart Rate' | 'Affects Blood Pressure';
export const MEDICATION_FLAGS: MedicationFlag[] = ['Requires Dietary Fat', 'Empty Stomach Only', 'Affects Heart Rate', 'Affects Blood Pressure'];

export interface MedicationDose {
  date: string;
  time: string;
  takenAt?: string;
  skipped?: boolean;
}

export interface Medication extends BaseRecord {
  name: string;
  dosage: string;
  frequency: MedicationFrequency;
  // Scheduled times of day, e.g. ['08:00', '20:00'] — length should generally match frequency.
  times: string[];
  withFood?: boolean;
  pillsRemaining?: number;
  refillThreshold?: number;
  prescriber?: string;
  notes?: string;
  active: boolean;
  doseLog: MedicationDose[];
  flags?: MedicationFlag[];
}

export type BucketListCategory = 'Travel' | 'Experience' | 'Skill' | 'Other';
export type BucketListStatus = 'Someday' | 'Planning' | 'Achieved';
export type CostTier = '$' | '$$' | '$$$';

export interface BucketListSubtask {
  id: string;
  text: string;
  done: boolean;
}

export interface BucketListItem extends BaseRecord {
  title: string;
  category: BucketListCategory;
  status: BucketListStatus;
  coverArt?: string;
  location?: string;
  costTier?: CostTier;
  targetDate?: string;
  notes?: string;
  subtasks?: BucketListSubtask[];
  order?: number;
  // Memory Journal — populated once the item flips to Achieved.
  achievedAt?: string;
  memoryPhotos?: string[];
  reflection?: string;
}

export type MovieStatus = 'To Watch' | 'Watching' | 'Watched';
export type MediaType = 'Movie' | 'TV Series' | 'Documentary' | 'Anime';

export interface Movie extends BaseRecord {
  title: string;
  coverArt?: string;
  mediaType?: MediaType;
  director?: string;
  releaseYear?: number;
  genres?: string[];
  description?: string;
  runtimeMin?: number;
  seasonsEpisodes?: string;
  episodeProgress?: number;
  status: MovieStatus;
  rating?: number;
  whereToWatch?: string[];
  dateCompleted?: string;
  tags?: string[];
  notes?: string;
  needsReview?: boolean;
}

export type VideogameStatus = 'To Play' | 'Playing' | 'Completed';

export interface Videogame extends BaseRecord {
  title: string;
  coverArt?: string;
  developer?: string;
  publisher?: string;
  platforms?: string[];
  genre?: string[];
  description?: string;
  releaseDate?: string;
  status: VideogameStatus;
  rating?: number;
  playtimeHours?: number;
  completionPct?: number;
  dateCompleted?: string;
  multiplayer?: boolean;
  tags?: string[];
  notes?: string;
  needsReview?: boolean;
}

export type BookStatus = 'To Read' | 'Reading' | 'Read';
export type BookFormat = 'Physical' | 'Ebook' | 'Audiobook';

export interface Book extends BaseRecord {
  title: string;
  coverArt?: string;
  author?: string;
  series?: string;
  seriesNumber?: number;
  genre?: string[];
  description?: string;
  format?: BookFormat;
  pageCount?: number;
  status: BookStatus;
  rating?: number;
  progress?: number;
  dateStarted?: string;
  dateFinished?: string;
  tags?: string[];
  notes?: string;
  needsReview?: boolean;
}

export type Theme = 'light' | 'dark' | 'system';

export interface Settings {
  userName: string;
  theme: Theme;
  notificationsEnabled: boolean;
  launchAtLogin: boolean;
  dailyBriefTime: string;
  currency: string;
  customTransactionTypes?: string[];
  customSavingsCategories?: string[];
  customDebtTypes?: string[];
  weightUnit?: WeightUnit;
  weightGoalTarget?: number;
  sleepTargetHours?: number;
  dailyCalorieTarget?: number;
  proteinTargetG?: number;
  glucoseUnit?: GlucoseUnit;
  glucoseTrackingEnabled?: boolean;
  medicationListHidden?: boolean;
  activeWorkoutRoutineId?: string;
  // Undefined means "use the WORKOUT_TYPES default list" — only set once the user actually
  // customizes it (add/rename/delete), same lazy pattern as customDebtTypes.
  workoutTypes?: string[];
  // Date-ranged history of which program was active, in the same spirit as RoutineVersion:
  // each entry is effective from its date until the next entry's date. Navigating to a date
  // resolves to whichever program was in effect for it and reloads that program automatically;
  // dates before the app ever knew which program was in use are left alone (stay on whatever's
  // currently showing) rather than guessing.
  workoutRoutineAssignments?: ProgramAssignment[];
  // The full category roster (not just additions) — unlike customDebtTypes, built-in categories
  // aren't locked here, so renaming/deleting/reordering any of them must persist too. Undefined
  // means "use the CONTACT_CATEGORIES default list unmodified".
  contactCategories?: string[];
}

export interface ProgramAssignment {
  effectiveFrom: string;
  routineId: string;
}

// Cadence tier — drives how often a contact is "due" for outreach. Tier 1/2/3 in CRM terms:
// Inner Circle (closest people, checked in on every 2 weeks), Close (regular relationships,
// every ~6 weeks), Extended (wider network, every ~4 months). Kept small (3 tiers) on purpose —
// more tiers just adds decision fatigue without changing what you'd actually do differently.
export type ContactTier = 'Inner Circle' | 'Close' | 'Extended';
export const CONTACT_TIERS: ContactTier[] = ['Inner Circle', 'Close', 'Extended'];
export const CONTACT_TIER_DEFAULT_DAYS: Record<ContactTier, number> = {
  'Inner Circle': 14,
  'Close': 42,
  'Extended': 120
};

// A string (not a closed union) so users can add their own categories on top of the built-in
// roster below — same open/extensible pattern as FinanceAccountType + customDebtTypes.
export type ContactCategory = string;

export const CONTACT_CATEGORIES: ContactCategory[] = [
  'Family', 'Friends', 'Relatives', 'Acquaintances',
  'Colleagues', 'Clients', 'Influencers',
  'College', 'Sport Club', 'Mentors & Mentees', 'Service Providers',
  'VIP / High-Value Contacts', 'Neighbors & Community', 'Inactive / Archive'
];

export interface Contact extends BaseRecord {
  name: string;
  tier: ContactTier;
  category?: ContactCategory;
  company?: string;
  role?: string;
  email?: string;
  phone?: string;
  city?: string;
  region?: string;
  // "MM-DD" — the birth year is frequently unknown/irrelevant for reminder purposes, so it's
  // deliberately not required the way a full date would be. birthYear is separate and only
  // used to compute an age to display — the reminder logic never needs it.
  birthday?: string;
  birthYear?: number;
  address?: string;
  linkedin?: string;
  instagram?: string;
  facebook?: string;
  howWeMet?: string;
  tags?: string[];
  // Overrides the tier's default cadence for this one person — undefined means "use the tier default".
  frequencyDays?: number;
  // Explicit next-check-up date (YYYY-MM-DD), set from the calendar picker in the contact form
  // and surfaced on the CRM's Calendar view alongside birthdays.
  nextCheckup?: string;
  // Split from a single "Preferences / Notes" field so personal context (family, likes/dislikes)
  // and business context (deals, work history) don't run together in one block.
  personalNotes?: string;
  businessNotes?: string;
  archived?: boolean;
}

// Interaction log is the single source of truth for "last contacted" — it's derived from
// these entries rather than stored redundantly on the Contact, so logging a past-dated
// interaction (e.g. backfilling a call from last week) correctly updates cadence status
// without a separate field to keep in sync.
export type InteractionType = 'Check-in' | 'Meeting' | 'Life Event' | 'Collaboration' | 'Gift' | 'Other';
export const INTERACTION_TYPES: InteractionType[] = ['Check-in', 'Meeting', 'Life Event', 'Collaboration', 'Gift', 'Other'];

export interface ContactInteraction extends BaseRecord {
  contactId: string;
  date: string;
  type: InteractionType;
  summary: string;
  notes?: string;
  // Only meaningful when type === 'Gift'.
  giftDirection?: 'Given' | 'Received';
}

export interface AppData {
  tasks: Task[];
  habits: Habit[];
  habitRoutines: HabitRoutine[];
  routineAssignments: RoutineDateAssignment[];
  goals: Goal[];
  events: CalendarEvent[];
  budgets: Budget[];
  transactions: Transaction[];
  bills: Bill[];
  movies: Movie[];
  videogames: Videogame[];
  books: Book[];
  financeAccounts: FinanceAccount[];
  financeCategories: FinanceCategory[];
  financeGoals: FinanceGoal[];
  notes: Note[];
  bucketList: BucketListItem[];
  workouts: WorkoutEntry[];
  weightEntries: WeightEntry[];
  sleepEntries: SleepEntry[];
  medications: Medication[];
  meals: MealEntry[];
  glucoseEntries: GlucoseEntry[];
  workoutRoutines: WorkoutRoutine[];
  contacts: Contact[];
  contactInteractions: ContactInteraction[];
  settings: Settings;
}

export type CollectionName = Exclude<keyof AppData, 'settings'>;

export type CollectionRecord =
  | Task | Habit | HabitRoutine | RoutineDateAssignment | Goal | CalendarEvent | Budget | Transaction | Bill
  | Movie | Videogame | Book | FinanceAccount | FinanceCategory | FinanceGoal | Note | BucketListItem
  | WorkoutEntry | WeightEntry | SleepEntry | Medication | MealEntry | GlucoseEntry | WorkoutRoutine
  | Contact | ContactInteraction;

export const COLLECTION_NAMES: CollectionName[] = [
  'tasks', 'habits', 'habitRoutines', 'routineAssignments', 'goals', 'events', 'budgets', 'transactions',
  'bills', 'movies', 'videogames', 'books', 'notes', 'bucketList', 'contacts', 'contactInteractions',
  'financeAccounts', 'financeCategories', 'financeGoals',
  'workouts', 'weightEntries', 'sleepEntries', 'medications', 'meals', 'glucoseEntries', 'workoutRoutines'
];
