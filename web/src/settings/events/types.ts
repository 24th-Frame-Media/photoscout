// Types and calls for the events service's settings, all through PhotoScout's admin proxy.
export interface SourceStatus {
  name: string;
  label: string;
  unofficial: boolean;
  state: 'ok' | 'disabled' | 'missing_config' | 'error' | 'never_run';
  message: string;
  lastFetch: string | null;
  count: number;
}

export interface Settings {
  city: string;
  lat: number | null;
  lng: number | null;
  radiusKm: number;
  ticketmasterKey: string | null;
  seatgeekClientId: string | null;
  eventbriteToken: string | null;
  eventbriteOrganizerIds: string[];
  /**
   * Credentials are never sent back — these arrive as '' whatever is stored,
   * and `secretsSet` says which exist. Sending '' back leaves the stored value
   * alone, which is what makes saving the whole settings object safe; `null`
   * is how one is cleared on purpose.
   */
  fbCookie: string | null;
  fbSearchTerms: string[];
  fbPages: string[];
  webSearchTerms: string[];
  webSearchDisabledEngines?: string[];
  eventTopics: string[];
  eventAreas: { name: string; lat?: number; lng?: number; radiusKm?: number }[];
  /** Keep events well outside every area out of sight. Never deletes; undoes itself. */
  cullOutsideAreas: boolean;
  /** Categories kept out of sight. */
  excludedCategories: string[];
  icalFeeds: { name: string; url: string }[];
  midnightspecStates: string[];
  tasksDisabled: string[];
  /** Which credentials are stored. Read-only; sending it back changes nothing. */
  secretsSet?: Record<'ticketmasterKey' | 'seatgeekClientId' | 'eventbriteToken' | 'fbCookie' | 'matrixAccessToken', boolean>;
  /**
   * Origins allowed to read the API from a page served elsewhere. Empty means
   * none, which is what a browser does by default. "*" means any. Only ever
   * grants the open reads — never a write, never this settings object.
   */
  corsOrigins: string[];
  llmEnabled: boolean;
  crawlerUrl: string;
  crawlerUrls: string[];
  llmUrl: string;
  llmModel: string;
  llmJobs: string[];
  llmIntervalMinutes: number;
  eventRefreshIntervalMinutes?: number;
  llmMaxPerRun: number;
  visionEnabled: boolean;
  visionModel: string;
  visionIntervalMinutes: number;
  visionMaxPerRun: number;
  enabledSources: Record<string, boolean>;
  densityEnabled: boolean;
  densityIntervalMinutes: number;
  densityCities: string[];
  densityAreas: { name: string; lat?: number; lng?: number; radiusKm?: number }[];
  densitySearches: string[];
  densityPlaces: string[];
  densityMaxVenues: number;
  densityRequestDelayMs?: number;
  densityWaitMs?: number;
  densityPlacesPerName?: number;
  /** Discord webhooks and Matrix rooms to tell about events. */
  notifyTargets: NotifyTarget[];
  matrixBot: {
    enabled: boolean;
    homeserver: string;
    commandPrefix: string;
    allowedUsers: string[];
    commandsEverywhere: boolean;
    /** !chat start in a room: the local model answering. Blank model uses the listing pass's. The prompt is who it is (blank: the default persona); how the room works is always added. */
    chat: { enabled: boolean; eventContext: boolean; model: string; systemPrompt: string; historyMessages: number };
  };
  /** Arrives as ''; see secretsSet. */
  matrixAccessToken: string | null;
  /** This app's address as notification readers reach it, for "Open in Event Scout". */
  appUrl: string;
}

export interface NotifyFilters {
  /** Town names, or 'unknown' for events with no place. */
  places: string[];
  categories: string[];
  excludeCategories: string[];
  minPhotoScore: number;
  keywords: string[];
  excludeKeywords: string[];
  starredOnly: boolean;
}

export interface NotifyTarget {
  id: string;
  kind: 'discord' | 'matrix';
  name: string;
  enabled: boolean;
  /** Arrives as '', with webhookSet saying whether one is stored. '' keeps it, null clears it. */
  webhookUrl: string | null;
  webhookSet?: boolean;
  username: string;
  avatarUrl: string;
  mention: string;
  style: 'full' | 'compact';
  showImage: boolean;
  roomId: string;
  /** Matrix: ordinary messages, which notify phones, rather than quiet notices. */
  matrixLoud: boolean;
  /** Matrix: answer commands in this room, listing only what this target's filters let through. */
  commands: boolean;
  /** Matrix: a card each, a line each, a table, or plain text. */
  matrixLook: 'cards' | 'minimal' | 'table' | 'plain';
  triggers: {
    newEvents: { enabled: boolean; settleMinutes: number; maxPerRun: number };
    digest: { enabled: boolean; cadence: 'daily' | 'weekly'; weekday: number; hour: number; daysAhead: number };
    reminders: { enabled: boolean; hoursBefore: number[] };
    starredChanges: { enabled: boolean };
    /** A place's live busyness reaching the threshold; no venues picked means all. */
    busy: { enabled: boolean; threshold: number; venues: string[]; cooldownHours: number };
  };
  filters: NotifyFilters;
  quietHours: { enabled: boolean; from: number; to: number };
}

export interface NotifyStatus {
  matrix: {
    state: 'off' | 'starting' | 'running' | 'error';
    userId: string;
    rooms: number;
    lastError: string;
    lastSyncAt: string | null;
    /** Invites turned down because the inviter is not on the allowed list. */
    ignoredInvites?: { roomId: string; from: string; at: string }[];
    /** The rooms the bot is in, with their names. */
    joinedRooms?: { roomId: string; name: string }[];
  };
  targets: Record<string, { at: string; ok: boolean; message: string } | null>;
}

export interface DensityStatus {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  lastRun: string | null;
  lastResult: string | null;
  nextDue: string | null;
  areas: DensityArea[];
  log: string[];
}

/** What this build is. See server/src/version.ts. */
export interface VersionInfo {
  version: string;
  /** Short commit sha, '' when the build did not name one. */
  commit: string;
  builtAt: string;
  /** Ready to show: the number, with the commit appended off a release. */
  display: string;
}

/** What the local model can be asked to do, and how the pass is getting on. */
export interface LlmStatus {
  enabled: boolean;
  url: string;
  model: string;
  jobs: string[];
  reachable: boolean;
  /** Why not, when unreachable. */
  problem: string;
  models: { name: string; size: number }[];
  modelInstalled: boolean;
  /** Events still waiting to be read. */
  backlog: number;
  /** Events already read, so a reset can say what it is throwing away. */
  read: number;
  availableJobs: { key: string; label: string; hint: string }[];
  /** The flyer pass, which shares the server and the model list. */
  vision: { enabled: boolean; model: string; modelInstalled: boolean; backlog: number; read: number };
}

export interface LlmQueueItem {
  id: number;
  title: string;
  startTime: string;
  source: string;
  venueName?: string;
  address?: string;
  url?: string;
  vettedAt?: string;
  vetNote?: string;
  status: 'waiting' | 'accepted' | 'rejected' | 'failed' | 'enriched';
}

export interface LlmQueueResponse {
  queue: LlmQueueItem[];
  totalWaiting: number;
  count: number;
}

/** One line in the tasks console. */
export interface LogEntry {
  seq: number;
  at: string;
  task: string;
  kind: 'start' | 'log' | 'end';
  line: string;
  failed?: boolean;
}

/** One background job, as the Tasks page shows it. */
export interface TaskStatus {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  /** False for jobs with no off switch, like venue discovery. */
  canDisable: boolean;
  /** True for jobs that only ever run when asked. */
  manualOnly: boolean;
  running: boolean;
  /** Set when something sharing this job's lock is running instead. */
  blockedBy: string | null;
  schedule: string | null;
  intervalMinutes: number | null;
  lastRun: string | null;
  lastResult: string | null;
  lastOk: boolean | null;
  nextDue: string | null;
  log: string[];
}

/** What a running refresh is doing and what it has turned up so far. */
export interface RefreshProgress {
  startedAt: string | null;
  /** Newest last. */
  lines: string[];
  found: number;
  /** Source name to what it is doing right now. */
  active: Record<string, string>;
}

export interface StatusResponse {
  sources: SourceStatus[];
  lastRefresh: string | null;
  refreshing: boolean;
  progress?: RefreshProgress;
}

export interface EventTopic { key: string; label: string; terms: string[] }


export interface GeocodeResult {
  displayName: string;
  lat: number;
  lng: number;
}
/** What the crawler says about itself, passed through by the server. */
export interface CrawlerCycle {
  startedAt: string;
  finishedAt: string | null;
  seeded: number;
  fetched: number;
  failed: number;
  blocked: number;
  events: number;
  feeds: number;
  lines: string[];
}

/** One finished cycle, with the queue and the finds as they stood at its end. */
export interface CrawlerHistoryRow {
  startedAt: string;
  finishedAt: string;
  fetched: number;
  events: number;
  failed: number;
  blocked: number;
  seeded: number;
  feeds: number;
  queued: number;
  finds: number;
}

/** What is in a calendar feed, read without adding it. */
export interface IcalPreview {
  ok: boolean;
  url: string;
  message?: string;
  calendarName?: string;
  /** Every event in the file. */
  total?: number;
  /** The ones the source would keep: from yesterday to six months out. */
  upcoming?: number;
  /** The first hundred of those, soonest first. */
  events?: { title: string; startTime: string; dateOnly: boolean; where: string; url: string }[];
}

export interface CrawlerStatus {
  reachable: boolean;
  /** The last day or so of finished cycles, oldest first. */
  history?: CrawlerHistoryRow[];
  /** Instagram read, and Facebook events noted for the app to read. */
  social?: {
    enabled: boolean;
    instagramProfiles: number;
    instagramPostsRead: number;
    instagramEvents: number;
    facebookEvents: number;
  };
  url?: string;
  problem?: string;
  enabled?: boolean;
  running?: boolean;
  current?: CrawlerCycle | null;
  last?: CrawlerCycle | null;
  pages?: Record<string, number>;
  finds?: number;
  feeds?: number;
  /** Each area, how many phrases it has, and the ones being searched this hour. */
  interests?: { city: string; terms: number; thisCycle: string[] }[];
  /** Pages it reads every six hours whatever the searches find. */
  seeds?: string[];
  config?: {
    maxPagesPerRun: number;
    maxDepth: number;
    concurrency: number;
    minHostDelayMs: number;
    intervalMinutes: number;
    userAgent: string;
  };
  feedList?: { url: string; site: string; foundOn: string }[];
}

/** A single event held in the crawler's queue, before server filtering. */
export interface CrawlerFind {
  id: string;
  title: string;
  startTime: string;
  dateOnly?: boolean;
  venueName?: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  url?: string;
  sourceId?: string;
}

/** What reading one page turned up. */
export interface CrawlPageReport {
  url: string;
  finalUrl?: string;
  ok: boolean;
  message: string;
  events: { title: string; startTime: string; dateOnly?: boolean; venueName?: string; url?: string }[];
  links: number;
  feeds: string[];
  /** Times the crawler has read this page, this time included. */
  reads?: number;
}

/** A page the crawler has read, and how often. */
export interface CrawlerPageRow {
  url: string;
  site: string;
  state: string;
  reads: number;
  events: number;
  fetchedAt: string | null;
  note: string;
  /** What the page has been worth: a decaying average of good events per read. */
  yield: number;
  /** When it is next due; null when it is never read again (a post, or a page given up on). */
  nextDue: string | null;
  /** Reads in a row that found nothing new. */
  emptyReads: number;
}

/** Which reader filled a field of an imported event. */
export type FoundBy = 'json-ld' | 'facebook' | 'instagram' | 'page' | 'text' | 'model';

/** One event read off a page by "Add from a link", for checking before it is saved. */
export interface ImportCandidate {
  title: string;
  description: string;
  /** '' when the page gave no date. */
  startTime: string;
  dateOnly: boolean;
  endTime: string;
  venueName: string;
  address: string;
  lat: number | null;
  lng: number | null;
  url: string;
  imageUrl: string;
  priceText: string;
  found: Partial<Record<'title' | 'description' | 'startTime' | 'endTime' | 'venueName' | 'address' | 'imageUrl', FoundBy>>;
}

export interface ImportPreview {
  ok: boolean;
  url: string;
  message: string;
  candidates: ImportCandidate[];
}

/** What the form sends back to be saved. */
export interface ImportEvent {
  url: string;
  title: string;
  description: string;
  startTime: string;
  dateOnly: boolean;
  endTime: string;
  venueName: string;
  address: string;
  imageUrl: string;
  priceText: string;
  category: string;
}


export interface DensityArea {
  slug: string;
  name: string;
  venues: number;
  withProfile: number;
}


// --- places, conditions, the density grid and hand-edited events ---------------

export interface SunDay {
  date: string;
  sunrise: string | null;
  sunset: string | null;
  solarNoon: string | null;
  dayLength: string | null;
  goldenMorning: { start: string; end: string } | null;
  goldenEvening: { start: string; end: string } | null;
  blueMorning: { start: string; end: string } | null;
  blueEvening: { start: string; end: string } | null;
}

export interface WeatherDay {
  date: string;
  summary: string;
  tempMax: number | null;
  tempMin: number | null;
  cloudCover: number | null;
  rainChance: number | null;
  uvMax: number | null;
  windMax: number | null;
}

export interface MoonInfo { phase: string; illumination: number; age: number }

export interface PhotoConditions {
  location: { city: string; lat: number; lon: number } | null;
  today: { sun: SunDay; moon: MoonInfo; weather: WeatherDay | null };
  tomorrow: { sun: SunDay; moon: MoonInfo; weather: WeatherDay | null };
  now: { temp: number | null; cloudCover: number | null; summary: string; wind: number | null } | null;
  fetchedAt: string;
}

export type Light = 'golden' | 'day' | 'blue' | 'night';

export interface ShootVerdict {
  score: number;
  label: 'Prime' | 'Good' | 'Fair' | 'Quiet' | 'Dead' | 'Unknown';
  why: string;
  light?: Light;
  surge?: boolean;
  estimated?: boolean;
}

export interface ObservedHour { avg: number; samples: number }
export interface HistoryPoint { ts: number; live: number | null; typical: number | null }
export interface DaySummary {
  readings: number;
  live: number;
  best: { from: number; to: number; score: number; label: string } | null;
}

export interface VenueReading {
  name: string;
  lat: number;
  lon: number;
  live: number | null;
  typical: number | null;
  score: number;
  observedAt: string | null;
  busiestDay: string | null;
  busiestHour: number | null;
  quietestDay: string | null;
  openDays: string[] | null;
  shoot: ShootVerdict;
}

export interface VenueHistory {
  name: string;
  lat: number;
  lon: number;
  points: HistoryPoint[];
  byDay: Record<string, Record<string, number>> | null;
  busiestDay: string | null;
  busiestHour: number | null;
  /** weekday (0 = Sunday) -> hour -> measured average. */
  observedByDay: Record<number, Record<number, ObservedHour>>;
  daySummary: Record<number, DaySummary>;
  lightByDay: Record<number, Record<number, Light>>;
  now: ShootVerdict | null;
}

/** The density grid for one area: a square per cell, scored 0 to 1. */
export interface DensityGrid {
  type: 'FeatureCollection';
  metadata: { label: string; area: string; observations: number; snapshots: number };
  features: {
    properties: { score: number; raw: number; colour: string; topName: string | null };
    geometry: { type: 'Polygon'; coordinates: [number, number][][] };
  }[];
}

/** One listing behind an event, as the admin sees it. */
export interface EventMember {
  id: number;
  source: string;
  title: string;
  url: string;
  imageUrl: string;
  startTime: string;
  venueName: string;
  parent: boolean;
}

/** An event as the engine holds it: the parts the admin edit, merge and archive screens need. */
export interface AdminEvent {
  group: string;
  title: string;
  description: string;
  startTime: string;
  venueName: string;
  address: string;
  category: string;
  priceText: string;
  imageUrl: string;
  photoScore: number;
  hidden: boolean;
  manual: boolean;
  members: EventMember[];
  /** The fields a person has changed by hand. */
  edited: string[];
}

/** What an edit may change; null puts back what the sources, the flyer or the model said. */
export type EventEdit = Partial<Record<'title' | 'description' | 'startTime' | 'venueName' | 'address' | 'category' | 'priceText' | 'imageUrl', string | null>>
  & { photoScore?: number | null };