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
//   TRANSACTIONS — financial recordsgit 
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
let _db = null;
function _client() {
  if (!_db) {
    if (!window.supabase) {
      throw new Error(
        'Supabase SDK not loaded. Make sure the CDN <script> tag appears ' +
        'BEFORE <script src="supabase.js"> in index.html.'
      );
    }
    _db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _db;
}
 
 
// ════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════
 
/**
 * Register a new user.
 * Creates a Supabase Auth account + a matching profiles row.
 * @returns {{ id, email, name, mode: null }}
 */
async function dbSignUp(name, email, password) {
  const { data, error } = await _client().auth.signUp({
    email,
    password,
    options: { data: { name } }   // stored in auth.users.raw_user_meta_data
  });
  if (error) throw error;
 
  // Insert profile row (mode null until user picks one on landing screen)
  const { error: profileErr } = await _client().from('profiles').insert({
    id:            data.user.id,
    name,
    mode:          null,
    notif_enabled: true
  });
  // Ignore duplicate key — can happen if a DB trigger already created the row
  if (profileErr && !profileErr.message.includes('duplicate')) throw profileErr;
 
  return { id: data.user.id, email, name, mode: null };
}
 
/**
 * Sign in with email + password.
 * @returns {{ id, email, name, mode }}
 */
async function dbSignIn(email, password) {
  const { data, error } = await _client().auth.signInWithPassword({ email, password });
  if (error) throw error;
  const profile = await dbGetProfile(data.user.id);
  return _buildSession(data.user, profile);
}
 
/**
 * Trigger Google OAuth redirect.
 * The user returns to the same page; dbOnAuthChange picks up the session.
 */
async function dbSignInWithGoogle() {
  const { error } = await _client().auth.signInWithOAuth({
    provider: 'google',
    options:  { redirectTo: window.location.href }
  });
  if (error) throw error;
}
 
/**
 * Sign out the current user.
 */
async function dbSignOut() {
  const { error } = await _client().auth.signOut();
  if (error) throw error;
}
 
/**
 * Return the active session (survives page reload) or null.
 * @returns {{ id, email, name, mode } | null}
 */
async function dbGetSession() {
  const { data: { session } } = await _client().auth.getSession();
  if (!session) return null;
  const profile = await dbGetProfile(session.user.id);
  return _buildSession(session.user, profile);
}
 
/**
 * Listen for auth state changes (OAuth redirects, token refresh, sign-out).
 * callback receives a session object or null.
 */
function dbOnAuthChange(callback) {
  _client().auth.onAuthStateChange(async (event, session) => {
    if (!session) { callback(null); return; }
    const profile = await dbGetProfile(session.user.id);
    callback(_buildSession(session.user, profile));
  });
}
 
/** Internal — shapes Supabase user + profile row into our session object */
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
  const { data } = await _client()
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();   // returns null (not an error) when row doesn't exist
  return data;
}
 
/**
 * Create or update a user's profile.
 * Pass only the fields you want to change, e.g. { mode: 'business' }
 */
async function dbSaveProfile(userId, updates) {
  const { error } = await _client()
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
  const { data, error } = await _client()
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
  const { data, error } = await _client()
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
  const { error } = await _client()
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
 * Load all saved contacts for a user, sorted A-Z.
 * @returns {Array<{ id, name, note }>}
 */
async function dbLoadContacts(userId) {
  const { data, error } = await _client()
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
  const { data, error } = await _client()
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
  const { error } = await _client()
    .from('contacts')
    .update({ name: updates.name, note: updates.note || '' })
    .eq('id', contactId);
  if (error) throw error;
}
 
/**
 * Delete a contact permanently.
 */
async function dbDeleteContact(contactId) {
  const { error } = await _client()
    .from('contacts')
    .delete()
    .eq('id', contactId);
  if (error) throw error;
}