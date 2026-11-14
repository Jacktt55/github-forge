// scenario.ts — the trial's fixed scenario identity, recomputed from the public seed.
//
// The suite's checks drive every surface as one seeded login: the login the bearer token
// names. That login is not in the entry's environment; it is a pure function of the fixed
// scenario seed (0x6a09e667f3bcc909) and the name lists the kit publishes in program/env/src/
// wire.ts (SCENARIO_SEED, FIRST_NAMES, LAST_NAMES, generateUsers, scenarioRng). The same
// seed drives every trial, so the same three logins come out every time; recomputing them
// here keeps the entry honest instead of hard-coding a string that could drift.
//
//   viewer   adaiversen   (id 1000) — the token owner
//   teammate quinnkeller  (id 1001)
//   stranger olgabauer    (id 1002) — "another owner" in the 404-never-403 checks

const U64_MASK = (1n << 64n) - 1n;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas',
  'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess',
  'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen',
  'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi',
  'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer',
];

/** FNV-1a, 64-bit (wire.ts). */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer (wire.ts). */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** xorshift64* (wire.ts Rng), the only stream methods generateUsers needs. */
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** generateUsers(scenarioRng('users'), 12) — the first three are viewer/teammate/stranger. */
function generateUsers(): ScenarioUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = generateUsers();
export const VIEWER: ScenarioUser = USERS[0];
export const TEAMMATE: ScenarioUser = USERS[1];
export const STRANGER: ScenarioUser = USERS[2];

/** The six labels the scenario seeds every repository with. */
export const ISSUE_LABELS: readonly string[] = [
  'bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted',
];

/** The fixed epoch the suite's scenario commits use (wire.ts SCENARIO_EPOCH_SEC). */
export const SCENARIO_EPOCH_SEC = 1735689600;

/**
 * The deterministic "now" for everything the forge stores or serves: MAKEFUN_TRIAL_NOW
 * (milliseconds) when the trial sets it, else the fixed epoch. Never the wall clock.
 */
export function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : SCENARIO_EPOCH_SEC * 1000;
}

export function trialNowIso(): string {
  return new Date(trialNowMs()).toISOString();
}

/** The public GitHub-shaped user object for a scenario login. */
export function publicUser(user: ScenarioUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: Buffer.from(`U_${user.id}`, 'utf8').toString('base64'),
    avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    followers_url: `/api/v3/users/${user.login}/followers`,
    following_url: `/api/v3/users/${user.login}/following{/other_user}`,
    gists_url: `/api/v3/users/${user.login}/gists{/gist_id}`,
    starred_url: `/api/v3/users/${user.login}/starred{/owner}{/repo}`,
    subscriptions_url: `/api/v3/users/${user.login}/subscriptions`,
    organizations_url: `/api/v3/users/${user.login}/orgs`,
    repos_url: `/api/v3/users/${user.login}/repos`,
    events_url: `/api/v3/users/${user.login}/events{/privacy}`,
    received_events_url: `/api/v3/users/${user.login}/received_events`,
    type: 'User',
    user_view_type: 'public',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}
