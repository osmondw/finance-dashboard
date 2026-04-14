// ═══════════════════════════════════════════════════════════
// supabase.js — Database layer for Mong's Finance
// ═══════════════════════════════════════════════════════════
//
// SETUP (one-time):
//   1. Go to https://supabase.com → create a free project
//   2. Paste your Project URL and anon key into the CONFIG block below
//      (Dashboard → Project Settings → API)
//   3. Open the Supabase SQL Editor and run the full schema
//      found at the bottom of this file
//   4. (Optional) Enable Google OAuth:
//      Dashboard → Authentication → Providers → Google
//
// FILE STRUCTURE:
//   CONFIG      — credentials
//   CLIENT      — Supabase instance
//   AUTH        — sign-up, sign-in, sign-out, session
//   PROFILE     — user preferences (mode, notif)
//   TRANSACTIONS — financial records
//   CONTACTS    — split-bill participants
//   SCHEMA      — SQL to paste into Supabase SQL Editor
// ═══════════════════════════════════════════════════════════


// ── CONFIG ──────────────────────────────────────────────────
// ⚠  Replace both values with your own project credentials
const SUPABASE_URL      = 'https://wenjrfbevgbfwrpfzotd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndlbmpyZmJldmdiZndycGZ6b3RkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxMzY3OTEsImV4cCI6MjA5MTcxMjc5MX0.1D-WEx7FgRyyIwgtVle1iOzT5qlnBYM4dgCqMdrfWP4';


// ── CLIENT ──────────────────────────────────────────────────
// Relies on the Supabase CDN script loaded before this file in index.html:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
const { createClient } = window.supabase;
const _db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


// ════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════

/**
 * Register a new user.
 * Creates a Supabase Auth account + a matching profiles row.
 * @returns {{ id, email, name, mode: null }}
 */
async function dbSignUp(name, email, password) {
  const { data, error } = await _db.auth.signUp({
    email,
    password,
    options: { data: { name } }          // stored in auth.users.raw_user_meta_data
  });
  if (error) throw error;

  // Insert profile row (mode is null until the user picks one on the landing screen)
  await _db.from('profiles').insert({
    id:             data.user.id,
    name,
    mode:           null,
    notif_enabled:  true
  });

  return { id: data.user.id, email, name, mode: null };
}

/**
 * Sign in with email + password.
 * @returns {{ id, email, name, mode }}
 */
async function dbSignIn(email, password) {
  const { data, error } = await _db.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const profile = await dbGetProfile(data.user.id);
  return _buildSession(data.user, profile);
}

/**
 * Trigger Google OAuth redirect.
 * The user will return to the same page; onAuthStateChange handles the session.
 */
async function dbSignInWithGoogle() {
  const { error } = await _db.auth.signInWithOAuth({
    provider: 'google',
    options:  { redirectTo: window.location.href }
  });
  if (error) throw error;
}

/**
 * Sign out the current user.
 */
async function dbSignOut() {
  const { error } = await _db.auth.signOut();
  if (error) throw error;
}

/**
 * Return the active session (survives page reload) or null if not logged in.
 * @returns {{ id, email, name, mode } | null}
 */
async function dbGetSession() {
  const { data: { session } } = await _db.auth.getSession();
  if (!session) return null;
  const profile = await dbGetProfile(session.user.id);
  return _buildSession(session.user, profile);
}

/**
 * Listen for auth changes (OAuth redirects, token refresh, sign-out).
 * Pass a callback(session | null) — session is the same shape as dbGetSession.
 */
function dbOnAuthChange(callback) {
  _db.auth.onAuthStateChange(async (event, session) => {
    if (!session) { callback(null); return; }
    const profile = await dbGetProfile(session.user.id);
    callback(_buildSession(session.user, profile));
  });
}

/** Internal helper — shapes a Supabase user + profile row into our session object */
function _buildSession(user, profile) {
  return {
    id:    user.id,
    email: user.email,
    name:  profile?.name || user.user_metadata?.name || user.email.split('@')[0],
    mode:  profile?.mode || null
  };
}


// ════════════════════════════════════════════════════════════
// PROFILE
// ════════════════════════════════════════════════════════════

/**
 * Fetch a user's profile row.
 * @returns {Object | null}
 */
async function dbGetProfile(userId) {
  const { data } = await _db
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();       // returns null instead of error when row doesn't exist
  return data;
}

/**
 * Create or update a user's profile.
 * Pass only the fields you want to change, e.g. { mode: 'business' }
 */
async function dbSaveProfile(userId, updates) {
  const { error } = await _db
    .from('profiles')
    .upsert({ id: userId, ...updates }, { onConflict: 'id' });
  if (error) throw error;
}


// ════════════════════════════════════════════════════════════
// TRANSACTIONS
// ════════════════════════════════════════════════════════════

/**
 * Load all transactions for a user, newest first.
 * @returns {Array<{ id, type, cat, desc, amount, date }>}
 */
async function dbLoadTransactions(userId) {
  const { data, error } = await _db
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('date',       { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(_rowToTx);
}

/**
 * Insert a single transaction and return its new UUID.
 * @param {string} userId
 * @param {{ type, cat, desc, amount, date }} tx
 * @returns {string} new row id
 */
async function dbInsertTransaction(userId, tx) {
  const { data, error } = await _db
    .from('transactions')
    .insert({
      user_id:     userId,
      type:        tx.type,
      cat:         tx.cat,
      description: tx.desc,
      amount:      tx.amount,
      date:        tx.date
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * Permanently delete a transaction by its UUID.
 */
async function dbDeleteTransaction(txId) {
  const { error } = await _db
    .from('transactions')
    .delete()
    .eq('id', txId);
  if (error) throw error;
}

/** Internal mapper — DB row → app object */
function _rowToTx(row) {
  return {
    id:     row.id,
    type:   row.type,
    cat:    row.cat,
    desc:   row.description,
    amount: parseFloat(row.amount),
    date:   row.date
  };
}


// ════════════════════════════════════════════════════════════
// CONTACTS
// ════════════════════════════════════════════════════════════

/**
 * Load all saved contacts for a user, sorted A–Z.
 * @returns {Array<{ id, name, note }>}
 */
async function dbLoadContacts(userId) {
  const { data, error } = await _db
    .from('contacts')
    .select('*')
    .eq('user_id', userId)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data || []).map(row => ({
    id:   row.id,
    name: row.name,
    note: row.note || ''
  }));
}

/**
 * Insert a new contact and return its UUID.
 * @returns {string} new row id
 */
async function dbInsertContact(userId, contact) {
  const { data, error } = await _db
    .from('contacts')
    .insert({
      user_id: userId,
      name:    contact.name,
      note:    contact.note || ''
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * Update an existing contact's name and/or note.
 */
async function dbUpdateContact(contactId, updates) {
  const { error } = await _db
    .from('contacts')
    .update({ name: updates.name, note: updates.note || '' })
    .eq('id', contactId);
  if (error) throw error;
}

/**
 * Delete a contact permanently.
 */
async function dbDeleteContact(contactId) {
  const { error } = await _db
    .from('contacts')
    .delete()
    .eq('id', contactId);
  if (error) throw error;
}


// ════════════════════════════════════════════════════════════
// SCHEMA
// Copy everything below and paste into:
//   Supabase Dashboard → SQL Editor → New query → Run
// ════════════════════════════════════════════════════════════
/*

-- ── PROFILES ──────────────────────────────────────────────
create table if not exists profiles (
  id             uuid primary key references auth.users on delete cascade,
  name           text        not null,
  mode           text        check (mode in ('personal', 'business')),
  notif_enabled  boolean     not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── TRANSACTIONS ───────────────────────────────────────────
create table if not exists transactions (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users on delete cascade,
  type        text        not null check (type in ('income', 'expense')),
  cat         text        not null default 'Other',
  description text        not null default '',
  amount      numeric     not null check (amount >= 0),
  date        date        not null,
  created_at  timestamptz not null default now()
);

create index if not exists transactions_user_date
  on transactions (user_id, date desc);

-- ── CONTACTS ───────────────────────────────────────────────
create table if not exists contacts (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users on delete cascade,
  name       text        not null,
  note       text        not null default '',
  created_at timestamptz not null default now()
);

create index if not exists contacts_user_name
  on contacts (user_id, name);

-- ── ROW LEVEL SECURITY ─────────────────────────────────────
-- Ensures each user can only see and edit their own data.

alter table profiles     enable row level security;
alter table transactions enable row level security;
alter table contacts     enable row level security;

-- profiles
create policy "profiles: own rows" on profiles
  for all using (auth.uid() = id);

-- transactions
create policy "transactions: own rows" on transactions
  for all using (auth.uid() = user_id);

-- contacts
create policy "contacts: own rows" on contacts
  for all using (auth.uid() = user_id);

-- ── AUTO-UPDATE updated_at ─────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger profiles_updated_at
  before update on profiles
  for each row execute function update_updated_at();

*/