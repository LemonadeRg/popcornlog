const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

require('dotenv').config();

const app = express();
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p/w500';

// Helper: fetch full movie details from TMDB by title
async function tmdbFetchByTitle(title) {
  // Search
  const search = await axios.get(`${TMDB_BASE}/search/movie`, {
    params: { api_key: TMDB_API_KEY, query: title, language: 'en-US', page: 1 }
  });
  if (!search.data.results || search.data.results.length === 0) return null;
  const found = search.data.results[0];
  return tmdbFetchById(found.id);
}

// Helper: fetch full movie details from TMDB by TMDB id
async function tmdbFetchById(id) {
  const [details, credits] = await Promise.all([
    axios.get(`${TMDB_BASE}/movie/${id}`, { params: { api_key: TMDB_API_KEY, language: 'en-US' } }),
    axios.get(`${TMDB_BASE}/movie/${id}/credits`, { params: { api_key: TMDB_API_KEY } })
  ]);
  const m = details.data;
  const director = credits.data.crew.find(c => c.job === 'Director');
  const actors = credits.data.cast.slice(0, 3).map(a => a.name).join(', ');
  return {
    title:      m.title,
    year:       m.release_date ? m.release_date.substring(0, 4) : 'N/A',
    poster:     m.poster_path ? TMDB_IMG + m.poster_path : 'N/A',
    genre:      m.genres.map(g => g.name).join(', '),
    director:   director ? director.name : 'N/A',
    actors,
    runtime:    m.runtime ? `${m.runtime} min` : 'N/A',
    imdbRating: m.vote_average ? m.vote_average.toFixed(1) : 'N/A',
    plot:       m.overview || 'N/A',
    tmdbId:     m.id
  };
}
const ADMIN_EMAIL = 'ragraguiriyad@gmail.com';


// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 hours
}));

// PostgreSQL connection
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialize tables
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      bio TEXT DEFAULT '',
      avatar TEXT DEFAULT '🎬',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS movies (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      genres TEXT,
      director TEXT,
      "mainCharacter" TEXT,
      year INTEGER,
      "imdbRating" REAL,
      runtime TEXT,
      "posterUrl" TEXT,
      plot TEXT,
      rating INTEGER,
      "userNotes" TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, title)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      genres TEXT,
      director TEXT,
      "mainCharacter" TEXT,
      year INTEGER,
      "imdbRating" REAL,
      runtime TEXT,
      "posterUrl" TEXT,
      plot TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, title)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_badges (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id TEXT NOT NULL,
      earned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, badge_id)
    )
  `);

  // Add active_badge column if not exists
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_badge TEXT DEFAULT NULL`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_color TEXT DEFAULT '#1c2228'`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS favorite_movie_id INTEGER REFERENCES movies(id) ON DELETE SET NULL`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS public_profile BOOLEAN DEFAULT TRUE`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS show_leaderboard BOOLEAN DEFAULT TRUE`);

  // Games hub
  await db.query(`
    CREATE TABLE IF NOT EXISTS game_stats (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      total_games INTEGER DEFAULT 0,
      quiz_wins INTEGER DEFAULT 0,
      battle_votes INTEGER DEFAULT 0,
      poster_guesses INTEGER DEFAULT 0,
      current_streak INTEGER DEFAULT 0,
      best_streak INTEGER DEFAULT 0,
      last_played DATE
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS battle_votes (
      id SERIAL PRIMARY KEY,
      movie_a TEXT NOT NULL,
      movie_b TEXT NOT NULL,
      voted_for TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Friend activity feed (for movie notifications)
  await db.query(`
    CREATE TABLE IF NOT EXISTS friend_activity (
      id SERIAL PRIMARY KEY,
      from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      data JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Track which notifications each user has seen
  await db.query(`
    CREATE TABLE IF NOT EXISTS notification_seen (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_seen_activity_id INTEGER DEFAULT 0,
      last_seen_request_count INTEGER DEFAULT 0,
      PRIMARY KEY (user_id)
    )
  `);

  console.log('✅ Database tables ready');
}

initDB().catch(err => console.error('DB init error:', err));

// ===== PING (wake-up endpoint) =====
// Fetch TMDB backdrop for a movie title (used for profile banner)
app.get('/api/backdrop', async (req, res) => {
  const { title, year } = req.query;
  if (!title) return res.json({ backdrop: null });
  try {
    const search = await fetch(`${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&language=en-US${year ? '&year='+year : ''}`);
    const data = await search.json();
    const movie = data.results?.[0];
    if (!movie?.backdrop_path) return res.json({ backdrop: null });
    res.json({ backdrop: `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` });
  } catch(e) {
    res.json({ backdrop: null });
  }
});

app.get('/api/ping', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false });
  }
});

// ===== BADGES =====
const BADGES = {
  first_movie:    { id: 'first_movie',    name: 'First Log',     emoji: '🎬', desc: 'Add your first movie' },
  movie_buff:     { id: 'movie_buff',     name: 'Movie Buff',    emoji: '🍿', desc: 'Add 10 movies' },
  cinephile:      { id: 'cinephile',      name: 'Cinephile',     emoji: '🏆', desc: 'Add 25 movies' },
  film_fanatic:   { id: 'film_fanatic',   name: 'Film Fanatic',  emoji: '🌟', desc: 'Add 50 movies' },
  the_critic:     { id: 'the_critic',     name: 'The Critic',    emoji: '⭐', desc: 'Give a 5-star rating' },
  planner:        { id: 'planner',        name: 'Planner',       emoji: '📋', desc: 'Add to your watchlist' },
  social:         { id: 'social',         name: 'Social',        emoji: '👥', desc: 'Accept a friend request' },
  chatter:        { id: 'chatter',        name: 'Chatter',       emoji: '💬', desc: 'Send your first chat message' },
  explorer:       { id: 'explorer',       name: 'Explorer',      emoji: '🗺️', desc: 'Watch movies in 5+ genres' },
  quiz_master:    { id: 'quiz_master',    name: 'Quiz Master',   emoji: '🎲', desc: 'Get 5 quiz answers correct' },
};

// Award badge if not already earned, returns badge if newly earned
async function awardBadge(userId, badgeId) {
  try {
    const result = await db.query(
      `INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING badge_id`,
      [userId, badgeId]
    );
    // Only return the badge if a row was actually inserted (newly earned)
    return result.rows.length > 0 ? (BADGES[badgeId] || null) : null;
  } catch (e) { return null; }
}

// Check and award movie-count badges
async function checkMovieBadges(userId) {
  const result = await db.query('SELECT COUNT(*) as cnt FROM movies WHERE user_id=$1', [userId]);
  const count = parseInt(result.rows[0].cnt);
  const newBadges = [];
  if (count >= 1)  newBadges.push(await awardBadge(userId, 'first_movie'));
  if (count >= 10) newBadges.push(await awardBadge(userId, 'movie_buff'));
  if (count >= 25) newBadges.push(await awardBadge(userId, 'cinephile'));
  if (count >= 50) newBadges.push(await awardBadge(userId, 'film_fanatic'));
  // Check genre explorer
  const genreRes = await db.query('SELECT genres FROM movies WHERE user_id=$1', [userId]);
  const genres = new Set();
  genreRes.rows.forEach(r => { if (r.genres) r.genres.split(',').forEach(g => genres.add(g.trim().toLowerCase())); });
  if (genres.size >= 5) newBadges.push(await awardBadge(userId, 'explorer'));
  return newBadges.filter(Boolean);
}

// ===== AUTHENTICATION ROUTES =====

// Sign Up
app.post('/auth/signup', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }

  if (!email.toLowerCase().endsWith('@gmail.com')) {
    return res.status(400).json({ error: 'Only Gmail accounts are allowed' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id',
      [username, email, hashedPassword]
    );
    req.session.userId = result.rows[0].id;
    req.session.username = username;
    req.session.isAdmin = email === ADMIN_EMAIL;
    res.json({ success: true, message: 'Account created!', userId: result.rows[0].id, isAdmin: req.session.isAdmin });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email or username already exists' });
    }
    res.status(500).json({ error: 'Signup failed' });
  }
});

// Sign In
app.post('/auth/signin', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) return res.status(400).json({ error: 'Invalid email or password' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ error: 'Invalid email or password' });

    if (user.is_banned) return res.status(403).json({ error: '🚫 Your account has been banned.' });

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.email === ADMIN_EMAIL;
    res.json({ success: true, message: 'Logged in!', username: user.username, userId: user.id, isAdmin: req.session.isAdmin });
  } catch (err) {
    res.status(500).json({ error: 'Login error' });
  }
});

// Check Auth Status
app.get('/auth/status', (req, res) => {
  if (req.session.userId) {
    res.json({ authenticated: true, username: req.session.username, userId: req.session.userId, isAdmin: req.session.isAdmin || false });
  } else {
    res.json({ authenticated: false });
  }
});

// Logout
app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Middleware to check authentication
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
};

// ===== MOVIES ROUTES =====

// Get all movies for user
// Home page: ALL data in one shot (avoids parallel cold-start failures)
app.get('/api/home/all', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    // Use allSettled so one bad query doesn't kill everything
    const results = await Promise.allSettled([
      db.query(`SELECT COUNT(*) as total, COALESCE(SUM(NULLIF(regexp_replace(runtime, '[^0-9]', '', 'g'), '')::int), 0) as minutes FROM movies WHERE user_id=$1`, [userId]),
      db.query(`SELECT ROUND(AVG(rating)::numeric,1) as avg_rating FROM movies WHERE user_id=$1 AND rating > 0`, [userId]),
      db.query(`SELECT genres as genre, COUNT(*) as cnt FROM movies WHERE user_id=$1 AND genres IS NOT NULL AND genres != '' GROUP BY genres ORDER BY cnt DESC LIMIT 1`, [userId]),
      db.query(`SELECT created_at::date as day FROM movies WHERE user_id=$1 ORDER BY created_at DESC`, [userId]),
      db.query(`SELECT CASE WHEN from_user_id=$1 THEN to_user_id ELSE from_user_id END as friend_id FROM friend_requests WHERE (from_user_id=$1 OR to_user_id=$1) AND status='accepted'`, [userId]),
      db.query(`SELECT u.id, u.username, u.avatar, u.active_badge, COUNT(m.id) AS movie_count FROM users u LEFT JOIN movies m ON m.user_id = u.id WHERE u.show_leaderboard IS NOT FALSE GROUP BY u.id, u.username, u.avatar, u.active_badge ORDER BY movie_count DESC LIMIT 3`)
    ]);
    const val = (i, fallback) => results[i].status === 'fulfilled' ? results[i].value : { rows: fallback || [] };
    const moviesRes     = val(0, [{total:0, minutes:0}]);
    const ratingsRes    = val(1);
    const genreRes      = val(2);
    const streakRes     = val(3);
    const feedFriendsRes= val(4);
    const leaderboardRes= val(5);

    // Log any failures for debugging
    results.forEach((r, i) => { if (r.status === 'rejected') console.error(`home/all query[${i}] failed:`, r.reason?.message); });

    // Streak
    let streak = 0;
    const days = streakRes.rows.map(r => r.day?.toISOString?.()?.slice(0,10));
    const uniqueDays = [...new Set(days)].sort().reverse();
    const today = new Date().toISOString().slice(0,10);
    let check = today;
    for (const d of uniqueDays) {
      if (d === check) { streak++; const dt = new Date(check); dt.setDate(dt.getDate()-1); check = dt.toISOString().slice(0,10); }
      else if (d < check) break;
    }
    // Feed
    const friendIds = feedFriendsRes.rows.map(r => r.friend_id);
    let feed = [];
    if (friendIds.length) {
      try {
        const feedRes = await db.query(
          `SELECT fa.*, u.username, u.avatar, u.active_badge FROM friend_activity fa JOIN users u ON u.id = fa.from_user_id WHERE fa.from_user_id = ANY($1) ORDER BY fa.created_at DESC LIMIT 10`,
          [friendIds]
        );
        feed = feedRes.rows;
      } catch(e) { console.error('feed query failed:', e.message); }
    }
    // Trending from TMDB
    let trending = [];
    try {
      const tr = await fetch(`${TMDB_BASE}/trending/movie/week?api_key=${TMDB_API_KEY}&language=en-US`);
      const td = await tr.json();
      trending = (td.results || []).slice(0, 10).map(m => ({
        title: m.title, poster: m.poster_path ? `${TMDB_IMG}${m.poster_path}` : null,
        year: m.release_date?.slice(0,4), rating: m.vote_average?.toFixed(1), overview: m.overview
      }));
    } catch(_) {}

    res.json({
      username: req.session.username || '',
      stats: {
        total: parseInt(moviesRes.rows[0]?.total) || 0,
        hours: Math.round((moviesRes.rows[0]?.minutes || 0) / 60),
        avgRating: parseFloat(ratingsRes.rows[0]?.avg_rating) || 0,
        topGenre: genreRes.rows[0]?.genre || null,
        streak
      },
      leaderboard: leaderboardRes.rows,
      feed,
      trending
    });
  } catch(err) {
    console.error('/api/home/all error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Home page: personal stats
app.get('/api/home/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const [moviesRes, ratingsRes, genreRes, streakRes] = await Promise.all([
      db.query(`SELECT COUNT(*) as total, COALESCE(SUM(NULLIF(regexp_replace(runtime, '[^0-9]', '', 'g'), '')::int), 0) as minutes FROM movies WHERE user_id=$1`, [userId]),
      db.query(`SELECT ROUND(AVG(rating)::numeric,1) as avg_rating FROM movies WHERE user_id=$1 AND rating > 0`, [userId]),
      db.query(`SELECT genres as genre, COUNT(*) as cnt FROM movies WHERE user_id=$1 AND genres IS NOT NULL AND genres != '' GROUP BY genres ORDER BY cnt DESC LIMIT 1`, [userId]),
      db.query(`SELECT created_at::date as day FROM movies WHERE user_id=$1 ORDER BY created_at DESC`, [userId])
    ]);
    // Calculate streak
    let streak = 0;
    const days = streakRes.rows.map(r => r.day?.toISOString?.()?.slice(0,10));
    const uniqueDays = [...new Set(days)].sort().reverse();
    const today = new Date().toISOString().slice(0,10);
    let check = today;
    for (const d of uniqueDays) {
      if (d === check) { streak++; const dt = new Date(check); dt.setDate(dt.getDate()-1); check = dt.toISOString().slice(0,10); }
      else if (d < check) break;
    }
    res.json({
      total: parseInt(moviesRes.rows[0].total) || 0,
      hours: Math.round((moviesRes.rows[0].minutes || 0) / 60),
      avgRating: parseFloat(ratingsRes.rows[0]?.avg_rating) || 0,
      topGenre: genreRes.rows[0]?.genre || null,
      streak
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Home page: friend activity feed
app.get('/api/home/feed', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const friendsRes = await db.query(
      `SELECT CASE WHEN from_user_id=$1 THEN to_user_id ELSE from_user_id END as friend_id
       FROM friend_requests WHERE (from_user_id=$1 OR to_user_id=$1) AND status='accepted'`, [userId]
    );
    const friendIds = friendsRes.rows.map(r => r.friend_id);
    if (!friendIds.length) return res.json([]);
    const feed = await db.query(
      `SELECT fa.*, u.username, u.avatar, u.active_badge FROM friend_activity fa
       JOIN users u ON u.id = fa.from_user_id
       WHERE fa.from_user_id = ANY($1)
       ORDER BY fa.created_at DESC LIMIT 10`,
      [friendIds]
    );
    res.json(feed.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Home page: trending from TMDB
app.get('/api/home/trending', async (req, res) => { // public — used for auth page background
  try {
    const r = await fetch(`${TMDB_BASE}/trending/movie/week?api_key=${TMDB_API_KEY}&language=en-US`);
    const data = await r.json();
    const movies = (data.results || []).slice(0, 10).map(m => ({
      title: m.title,
      poster: m.poster_path ? `${TMDB_IMG}${m.poster_path}` : null,
      year: m.release_date?.slice(0,4),
      rating: m.vote_average?.toFixed(1),
      overview: m.overview
    }));
    res.json(movies);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/trailers', requireAuth, async (req, res) => {
  try {
    const tr = await fetch(`${TMDB_BASE}/trending/movie/week?api_key=${TMDB_API_KEY}&language=en-US`);
    const data = await tr.json();
    const movies = (data.results || []).slice(0, 8);
    const withTrailers = await Promise.all(movies.map(async m => {
      try {
        const vr = await fetch(`${TMDB_BASE}/movie/${m.id}/videos?api_key=${TMDB_API_KEY}&language=en-US`);
        const vd = await vr.json();
        const trailer = vd.results?.find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
        if (!trailer) return null;
        return {
          title: m.title,
          year: m.release_date?.slice(0,4),
          poster: m.poster_path ? `https://image.tmdb.org/t/p/w300${m.poster_path}` : null,
          backdrop: m.backdrop_path ? `https://image.tmdb.org/t/p/w780${m.backdrop_path}` : null,
          youtubeKey: trailer.key,
          type: trailer.type,
          rating: m.vote_average?.toFixed(1)
        };
      } catch { return null; }
    }));
    res.json(withTrailers.filter(Boolean).slice(0, 5));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leaderboard', requireAuth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT u.id, u.username, u.avatar, u.active_badge, COUNT(m.id) AS movie_count
      FROM users u
      LEFT JOIN movies m ON m.user_id = u.id
      WHERE u.show_leaderboard IS NOT FALSE
      GROUP BY u.id, u.username, u.avatar, u.active_badge
      ORDER BY movie_count DESC
      LIMIT 3
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/movies', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM movies WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add movie
app.post('/api/movies', requireAuth, async (req, res) => {
  const { movieName, tmdbId, rating, notes } = req.body;
  try {
    const movie = tmdbId ? await tmdbFetchById(tmdbId) : await tmdbFetchByTitle(movieName);
    if (!movie) return res.status(404).json({ error: 'Movie not found' });

    // Check for duplicate (case-insensitive) before inserting
    const dup = await db.query(
      'SELECT id FROM movies WHERE user_id=$1 AND LOWER(title)=LOWER($2)',
      [req.session.userId, movie.title]
    );
    if (dup.rows.length > 0) return res.status(400).json({ error: 'You already have this movie in your list' });

    await db.query(
      `INSERT INTO movies (user_id, title, genres, director, "mainCharacter", year, "imdbRating", runtime, "posterUrl", plot, rating, "userNotes")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [req.session.userId, movie.title, movie.genre, movie.director, movie.actors,
       movie.year, movie.imdbRating, movie.runtime, movie.poster, movie.plot, rating, notes]
    );
    // Check rating badge
    const newBadges = await checkMovieBadges(req.session.userId);
    if (parseInt(rating) === 5) { const b = await awardBadge(req.session.userId, 'the_critic'); if (b) newBadges.push(b); }

    // Record activity for friends
    const userRes = await db.query('SELECT username, avatar FROM users WHERE id=$1', [req.session.userId]);
    const actor = userRes.rows[0];
    await db.query(
      `INSERT INTO friend_activity (from_user_id, type, data) VALUES ($1, 'movie_added', $2)`,
      [req.session.userId, JSON.stringify({ title: movie.title, poster: movie.poster, year: movie.year, username: actor.username, avatar: actor.avatar || '🎬' })]
    );

    res.json({ success: true, newBadges });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'You already have this movie in your list' });
    }
    res.status(500).json({ error: 'Failed to add movie' });
  }
});

// Update movie
app.put('/api/movies/:id', requireAuth, async (req, res) => {
  const { rating, userNotes } = req.body;
  try {
    await db.query(
      'UPDATE movies SET rating = $1, "userNotes" = $2 WHERE id = $3 AND user_id = $4',
      [rating, userNotes, req.params.id, req.session.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete movie
app.delete('/api/movies/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM movies WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== WATCHLIST ROUTES =====

// Get watchlist
app.get('/api/watchlist', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM watchlist WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add to watchlist
app.post('/api/watchlist', requireAuth, async (req, res) => {
  const { movieName } = req.body;
  try {
    const movie = await tmdbFetchByTitle(movieName);
    if (!movie) return res.status(404).json({ error: 'Movie not found' });

    await db.query(
      `INSERT INTO watchlist (user_id, title, genres, director, "mainCharacter", year, "imdbRating", runtime, "posterUrl", plot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.session.userId, movie.title, movie.genre, movie.director, movie.actors,
       movie.year, movie.imdbRating, movie.runtime, movie.poster, movie.plot]
    );
    const newBadges = [];
    const b = await awardBadge(req.session.userId, 'planner');
    if (b) newBadges.push(b);
    res.json({ success: true, newBadges });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'This movie is already in your watchlist' });
    }
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
});

// Remove from watchlist
app.delete('/api/watchlist/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM watchlist WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move from watchlist to movies
app.post('/api/watchlist-to-movies/:id', requireAuth, async (req, res) => {
  const { rating, notes } = req.body;

  try {
    const result = await db.query(
      'SELECT * FROM watchlist WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );
    const w = result.rows[0];
    if (!w) return res.status(404).json({ error: 'Movie not found' });

    await db.query(
      `INSERT INTO movies (user_id, title, genres, director, "mainCharacter", year, "imdbRating", runtime, "posterUrl", plot, rating, "userNotes")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [req.session.userId, w.title, w.genres, w.director, w.mainCharacter,
       w.year, w.imdbRating, w.runtime, w.posterUrl, w.plot, rating, notes]
    );

    await db.query('DELETE FROM watchlist WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== BADGES ROUTES =====

// Get my badges
app.get('/api/badges', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT badge_id, earned_at FROM user_badges WHERE user_id=$1',
      [req.session.userId]
    );
    const earned = new Set(result.rows.map(r => r.badge_id));
    const all = Object.values(BADGES).map(b => ({
      ...b,
      earned: earned.has(b.id),
      earnedAt: result.rows.find(r => r.badge_id === b.id)?.earned_at || null
    }));
    const userRes = await db.query('SELECT active_badge FROM users WHERE id=$1', [req.session.userId]);
    res.json({ badges: all, activeBadge: userRes.rows[0]?.active_badge || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Equip a badge
app.post('/api/badges/equip', requireAuth, async (req, res) => {
  const { badgeId } = req.body;
  try {
    // Make sure user has earned it
    if (badgeId) {
      const check = await db.query(
        'SELECT id FROM user_badges WHERE user_id=$1 AND badge_id=$2',
        [req.session.userId, badgeId]
      );
      if (check.rows.length === 0) return res.status(403).json({ error: 'Badge not earned' });
    }
    await db.query('UPDATE users SET active_badge=$1 WHERE id=$2', [badgeId || null, req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retroactively award all badges based on existing data
app.post('/api/badges/recalculate', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const newBadges = [];

    // Movie count badges
    const movieRes = await db.query('SELECT COUNT(*) as cnt FROM movies WHERE user_id=$1', [userId]);
    const count = parseInt(movieRes.rows[0].cnt);
    if (count >= 1)  { const b = await awardBadge(userId, 'first_movie');  if (b) newBadges.push(b); }
    if (count >= 10) { const b = await awardBadge(userId, 'movie_buff');   if (b) newBadges.push(b); }
    if (count >= 25) { const b = await awardBadge(userId, 'cinephile');    if (b) newBadges.push(b); }
    if (count >= 50) { const b = await awardBadge(userId, 'film_fanatic'); if (b) newBadges.push(b); }

    // 5-star rating
    const criticRes = await db.query('SELECT id FROM movies WHERE user_id=$1 AND rating=5 LIMIT 1', [userId]);
    if (criticRes.rows.length) { const b = await awardBadge(userId, 'the_critic'); if (b) newBadges.push(b); }

    // Watchlist (planner)
    const plannerRes = await db.query('SELECT id FROM watchlist WHERE user_id=$1 LIMIT 1', [userId]);
    if (plannerRes.rows.length) { const b = await awardBadge(userId, 'planner'); if (b) newBadges.push(b); }

    // Accepted friend request (social)
    const socialRes = await db.query(
      `SELECT id FROM friend_requests WHERE (from_user_id=$1 OR to_user_id=$1) AND status='accepted' LIMIT 1`, [userId]
    );
    if (socialRes.rows.length) { const b = await awardBadge(userId, 'social'); if (b) newBadges.push(b); }

    // Sent a chat message (chatter)
    const chatterRes = await db.query('SELECT id FROM chat_messages WHERE user_id=$1 LIMIT 1', [userId]);
    if (chatterRes.rows.length) { const b = await awardBadge(userId, 'chatter'); if (b) newBadges.push(b); }

    // 5+ genres (explorer)
    const genreRes = await db.query('SELECT genres FROM movies WHERE user_id=$1', [userId]);
    const genres = new Set();
    genreRes.rows.forEach(r => { if (r.genres) r.genres.split(',').forEach(g => genres.add(g.trim().toLowerCase())); });
    if (genres.size >= 5) { const b = await awardBadge(userId, 'explorer'); if (b) newBadges.push(b); }

    res.json({ newBadges });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Award quiz badge
app.post('/api/badges/quiz-correct', requireAuth, async (req, res) => {
  try {
    // Track quiz correct count in session
    req.session.quizCorrect = (req.session.quizCorrect || 0) + 1;
    const newBadges = [];
    if (req.session.quizCorrect >= 5) {
      const b = await awardBadge(req.session.userId, 'quiz_master');
      if (b) newBadges.push(b);
    }
    res.json({ newBadges, total: req.session.quizCorrect });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== NOTIFICATIONS =====

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;

    // Get pending friend requests count
    const reqResult = await db.query(
      `SELECT COUNT(*) as cnt FROM friend_requests WHERE to_user_id=$1 AND status='pending'`,
      [userId]
    );
    const pendingRequests = parseInt(reqResult.rows[0].cnt);

    // Get user's friends
    const friendsRes = await db.query(
      `SELECT CASE WHEN from_user_id=$1 THEN to_user_id ELSE from_user_id END as friend_id
       FROM friend_requests WHERE (from_user_id=$1 OR to_user_id=$1) AND status='accepted'`,
      [userId]
    );
    const friendIds = friendsRes.rows.map(r => r.friend_id);

    // Get last seen state
    const seenRes = await db.query(
      `SELECT last_seen_activity_id FROM notification_seen WHERE user_id=$1`,
      [userId]
    );
    const lastSeenId = seenRes.rows[0]?.last_seen_activity_id || 0;

    // Get new activity from friends since last seen
    let newActivity = [];
    if (friendIds.length > 0) {
      const actRes = await db.query(
        `SELECT * FROM friend_activity WHERE from_user_id = ANY($1) AND id > $2 ORDER BY created_at DESC LIMIT 10`,
        [friendIds, lastSeenId]
      );
      newActivity = actRes.rows.map(r => ({ ...r, data: r.data }));
    }

    res.json({ pendingRequests, newActivity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark activity as seen
app.post('/api/notifications/seen', requireAuth, async (req, res) => {
  try {
    const { lastActivityId } = req.body;
    await db.query(
      `INSERT INTO notification_seen (user_id, last_seen_activity_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET last_seen_activity_id = GREATEST(notification_seen.last_seen_activity_id, $2)`,
      [req.session.userId, lastActivityId || 0]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== SEARCH & TRAILER =====

// Search movies
app.get('/api/search/:query', requireAuth, async (req, res) => {
  try {
    const response = await axios.get(`${TMDB_BASE}/search/movie`, {
      params: { api_key: TMDB_API_KEY, query: req.params.query, language: 'en-US', page: 1 }
    });
    if (!response.data.results || response.data.results.length === 0) return res.json({ results: [] });

    const results = response.data.results.slice(0, 6).map(m => ({
      id:     m.id,
      title:  m.title,
      year:   m.release_date ? m.release_date.substring(0, 4) : 'N/A',
      poster: m.poster_path ? TMDB_IMG + m.poster_path : null
    }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get trailer
app.get('/api/trailer/:movieTitle', requireAuth, async (req, res) => {
  try {
    const search = require('yt-search');
    const results = await search(`${req.params.movieTitle} trailer`);
    if (results.videos.length > 0) {
      res.json({ videoId: results.videos[0].videoId });
    } else {
      res.json({ videoId: null });
    }
  } catch (err) {
    res.json({ videoId: null });
  }
});

// IMDb Top 250 movie IDs
const IMDB_TOP_250 = [
  'tt0111161','tt0068646','tt0071562','tt0468569','tt0050083','tt0108052',
  'tt0167260','tt0110912','tt0060196','tt0120737','tt0137523','tt0109830',
  'tt1375666','tt0167261','tt0080684','tt0073486','tt0099685','tt0133093',
  'tt0047478','tt0317248','tt0816692','tt0114369','tt0102926','tt0038650',
  'tt0245429','tt0120689','tt0076759','tt0118799','tt0114814','tt0034583',
  'tt0120586','tt0361748','tt0253474','tt0209144','tt0172495','tt1675434',
  'tt0482571','tt0120815','tt2582802','tt1853728','tt0910970','tt0114709',
  'tt0435761','tt0088763','tt0062622','tt0064116','tt0066921','tt0078748',
  'tt0078788','tt0082971','tt0083658','tt0086879','tt0093058','tt0095327',
  'tt0095765','tt0096283','tt0103064','tt0105236','tt0107290','tt0110357',
  'tt0112573','tt0113277','tt0116282','tt0117951','tt0118715','tt0119217',
  'tt0119698','tt0120382','tt0167404','tt0169547','tt0211915','tt0266543',
  'tt0298148','tt0347149','tt0364569','tt0372784','tt0407887','tt0477348',
  'tt1187043','tt1255953','tt1392190','tt2106476','tt2278388','tt2562232',
  'tt3783958','tt4633694','tt6751668','tt0050825','tt0053604','tt0056592',
  'tt0070735','tt0071853','tt0097576','tt0180093','tt0097165','tt0198781'
];

// ===== PROFILE =====

// Get profile + stats
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const userResult = await db.query(
      'SELECT id, username, email, bio, avatar, active_badge, banner_color, favorite_movie_id, created_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [statsResult, wlResult, favResult] = await Promise.all([
      db.query('SELECT COUNT(*) as total, AVG(rating) as "avgRating" FROM movies WHERE user_id = $1', [req.session.userId]),
      db.query('SELECT COUNT(*) as "watchlistCount" FROM watchlist WHERE user_id = $1', [req.session.userId]),
      user.favorite_movie_id
        ? db.query('SELECT id, title, "posterUrl", year, rating, genres FROM movies WHERE id = $1 AND user_id = $2', [user.favorite_movie_id, req.session.userId])
        : Promise.resolve({ rows: [] })
    ]);

    const stats = statsResult.rows[0];
    const wl = wlResult.rows[0];

    res.json({
      username: user.username,
      email: user.email,
      bio: user.bio || '',
      avatar: user.avatar || '🎬',
      activeBadge: user.active_badge || null,
      bannerColor: user.banner_color || '#1c2228',
      favoriteMovie: favResult.rows[0] || null,
      joinDate: user.created_at,
      totalMovies: parseInt(stats.total) || 0,
      avgRating: stats.avgRating ? parseFloat(stats.avgRating).toFixed(1) : 'N/A',
      watchlistCount: parseInt(wl.watchlistCount) || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update bio, avatar, banner, favorite movie
app.put('/api/profile', requireAuth, async (req, res) => {
  const { bio, avatar, bannerColor, favoriteMovieId } = req.body;
  try {
    await db.query(
      'UPDATE users SET bio = $1, avatar = $2, banner_color = $3, favorite_movie_id = $4 WHERE id = $5',
      [bio, avatar, bannerColor || '#1c2228', favoriteMovieId || null, req.session.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change password
// Change username
// Get privacy settings
app.get('/api/settings/privacy', requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT public_profile, show_leaderboard FROM users WHERE id=$1', [req.session.userId]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Save privacy settings
app.put('/api/settings/privacy', requireAuth, async (req, res) => {
  const { publicProfile, showLeaderboard } = req.body;
  try {
    await db.query('UPDATE users SET public_profile=$1, show_leaderboard=$2 WHERE id=$3',
      [publicProfile !== false, showLeaderboard !== false, req.session.userId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/profile/username', requireAuth, async (req, res) => {
  const { username } = req.body;
  if (!username || username.trim().length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
  if (username.trim().length > 30) return res.status(400).json({ error: 'Username must be 30 characters or less' });
  if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) return res.status(400).json({ error: 'Only letters, numbers and underscores allowed' });
  try {
    await db.query('UPDATE users SET username=$1 WHERE id=$2', [username.trim(), req.session.userId]);
    req.session.username = username.trim();
    res.json({ success: true, username: username.trim() });
  } catch(err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username already taken' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/profile/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  try {
    const result = await db.query('SELECT password FROM users WHERE id = $1', [req.session.userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete account
app.delete('/api/profile', requireAuth, async (req, res) => {
  const { password } = req.body;

  try {
    const result = await db.query('SELECT password FROM users WHERE id = $1', [req.session.userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Incorrect password' });

    await db.query('DELETE FROM users WHERE id = $1', [req.session.userId]);
    req.session.destroy();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== QUIZ =====
// ===== GAMES HUB =====

// Get or init game profile
app.get('/api/games/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    await db.query(`INSERT INTO game_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
    const r = await db.query(`SELECT * FROM game_stats WHERE user_id=$1`, [userId]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Award XP after a game
app.post('/api/games/xp', requireAuth, async (req, res) => {
  const { xp, gameType, won } = req.body;
  const userId = req.session.userId;
  try {
    await db.query(`INSERT INTO game_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
    const r = await db.query(`SELECT * FROM game_stats WHERE user_id=$1`, [userId]);
    const gs = r.rows[0];
    const today = new Date().toISOString().slice(0,10);
    const lastPlayed = gs.last_played ? gs.last_played.toISOString().slice(0,10) : null;
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
    let newStreak = gs.current_streak;
    if (lastPlayed === today) { /* same day, no change */ }
    else if (lastPlayed === yesterday) newStreak++;
    else newStreak = 1;
    const newBestStreak = Math.max(gs.best_streak, newStreak);
    const newXP = gs.xp + (xp || 0);
    const newLevel = Math.floor(newXP / 500) + 1;
    const colMap = { quiz: 'quiz_wins', battle: 'battle_votes', poster: 'poster_guesses' };
    const col = colMap[gameType] || 'total_games';
    await db.query(`
      UPDATE game_stats SET xp=$1, level=$2, total_games=total_games+1,
      ${col}=${col}+1, current_streak=$3, best_streak=$4, last_played=$5
      WHERE user_id=$6`,
      [newXP, newLevel, newStreak, newBestStreak, today, userId]
    );
    res.json({ xp: newXP, level: newLevel, streak: newStreak });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Movie Battles — get two random TMDB popular movies
app.get('/api/games/battle', async (req, res) => {
  try {
    const page = Math.floor(Math.random() * 5) + 1;
    const r = await fetch(`${TMDB_BASE}/movie/popular?api_key=${TMDB_API_KEY}&language=en-US&page=${page}`);
    const data = await r.json();
    const pool = (data.results || []).filter(m => m.poster_path);
    if (pool.length < 2) return res.status(500).json({ error: 'Not enough movies' });
    const shuffled = pool.sort(() => Math.random() - 0.5);
    const [a, b] = shuffled.slice(0, 2);
    const fmt = m => ({
      id: m.id, title: m.title,
      poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`,
      year: m.release_date?.slice(0,4),
      rating: m.vote_average?.toFixed(1)
    });
    // Get vote counts
    const votesA = await db.query(`SELECT COUNT(*) as cnt FROM battle_votes WHERE movie_a=$1 AND movie_b=$2 AND voted_for=$1`, [a.title, b.title]);
    const votesB = await db.query(`SELECT COUNT(*) as cnt FROM battle_votes WHERE movie_a=$1 AND movie_b=$2 AND voted_for=$2`, [a.title, b.title]);
    res.json({ movieA: fmt(a), movieB: fmt(b), votesA: parseInt(votesA.rows[0].cnt), votesB: parseInt(votesB.rows[0].cnt) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Movie Battles — submit a vote
app.post('/api/games/battle/vote', requireAuth, async (req, res) => {
  const { movieA, movieB, votedFor } = req.body;
  try {
    await db.query(`INSERT INTO battle_votes (movie_a, movie_b, voted_for, user_id) VALUES ($1,$2,$3,$4)`,
      [movieA, movieB, votedFor, req.session.userId]);
    const vA = await db.query(`SELECT COUNT(*) as cnt FROM battle_votes WHERE movie_a=$1 AND movie_b=$2 AND voted_for=$1`, [movieA, movieB]);
    const vB = await db.query(`SELECT COUNT(*) as cnt FROM battle_votes WHERE movie_a=$1 AND movie_b=$2 AND voted_for=$2`, [movieA, movieB]);
    res.json({ votesA: parseInt(vA.rows[0].cnt), votesB: parseInt(vB.rows[0].cnt) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Guess The Poster — get a random TMDB movie with cast info
app.get('/api/games/poster', requireAuth, async (req, res) => {
  try {
    const exclude = req.query.exclude ? JSON.parse(req.query.exclude) : [];
    const result = await db.query(
      `SELECT title, "posterUrl", year, genres, "mainCharacter", director
       FROM movies WHERE user_id=$1 AND "posterUrl" IS NOT NULL AND "posterUrl" != '' AND "posterUrl" != 'N/A'`,
      [req.session.userId]
    );
    let pool = result.rows.filter(m => !exclude.includes(m.title));
    if (pool.length === 0) pool = result.rows; // reset if all used
    if (pool.length === 0) return res.status(400).json({ error: 'Add at least 1 movie with a poster to play!' });
    const movie = pool[Math.floor(Math.random() * pool.length)];
    res.json({
      poster: movie.posterUrl,
      answer: movie.title,
      year: movie.year || '?',
      genre: movie.genres || 'Unknown',
      lead: movie.mainCharacter || movie.director || 'Unknown',
      reset: pool.length === result.rows.length && exclude.length > 0
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/quiz', requireAuth, async (req, res) => {
  let exclude = [];
  try {
    if (req.query.exclude) exclude = JSON.parse(req.query.exclude);
  } catch (e) {}

  try {
    const result = await db.query(
      'SELECT id, title, plot, "posterUrl" FROM movies WHERE user_id = $1 AND plot IS NOT NULL AND plot != \'\'',
      [req.session.userId]
    );
    const movies = result.rows;

    if (movies.length < 4) return res.status(400).json({ error: 'Add at least 4 movies to play the quiz!' });

    let available = movies.filter(m => !exclude.includes(m.title));
    let reset = false;
    if (available.length === 0) {
      available = movies;
      reset = true;
    }

    const correct = available[Math.floor(Math.random() * available.length)];
    const others = movies.filter(m => m.id !== correct.id);
    const wrong = others.sort(() => Math.random() - 0.5).slice(0, 3);
    const options = [...wrong.map(m => m.title), correct.title].sort(() => Math.random() - 0.5);

    res.json({ plot: correct.plot, poster: correct.posterUrl, options, answer: correct.title, reset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== RECOMMENDATIONS =====
// TMDB genre name → ID map (cached)
const TMDB_GENRE_MAP = {
  'Action': 28, 'Adventure': 12, 'Animation': 16, 'Comedy': 35,
  'Crime': 80, 'Documentary': 99, 'Drama': 18, 'Family': 10751,
  'Fantasy': 14, 'History': 36, 'Horror': 27, 'Music': 10402,
  'Mystery': 9648, 'Romance': 10749, 'Sci-Fi': 878, 'Science Fiction': 878,
  'Thriller': 53, 'War': 10752, 'Western': 37
};

async function fetchMoviesForGenre(genreId, watchedTitles, limit = 15) {
  const movies = [];
  let page = 1;
  while (movies.length < limit && page <= 5) {
    const res = await axios.get(`${TMDB_BASE}/discover/movie`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'en-US',
        sort_by: 'vote_average.desc',
        'vote_count.gte': 500,
        with_genres: genreId,
        page
      }
    });
    for (const m of res.data.results) {
      if (movies.length >= limit) break;
      if (!m.poster_path) continue;
      if (watchedTitles.has(m.title.toLowerCase())) continue;
      movies.push({
        title: m.title,
        year: m.release_date ? m.release_date.substring(0, 4) : 'N/A',
        poster: TMDB_IMG + m.poster_path,
        imdbRating: m.vote_average.toFixed(1),
        overview: m.overview || ''
      });
    }
    page++;
  }
  return movies;
}

// Get recommendations for a specific genre
app.get('/api/recommendations/:genre', requireAuth, async (req, res) => {
  try {
    const genre = req.params.genre;
    const watchedRes = await db.query('SELECT title FROM movies WHERE user_id=$1', [req.session.userId]);
    const watchedTitles = new Set(watchedRes.rows.map(r => r.title.toLowerCase()));

    // Find TMDB genre ID
    let genreId = null;
    for (const [name, id] of Object.entries(TMDB_GENRE_MAP)) {
      if (name.toLowerCase() === genre.toLowerCase()) { genreId = id; break; }
    }
    if (!genreId) return res.status(400).json({ error: 'Unknown genre' });

    const movies = await fetchMoviesForGenre(genreId, watchedTitles, 15);
    res.json({ results: movies, genre });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

// Legacy: get recommendations based on user's top genre
app.get('/api/recommendations', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT genres FROM movies WHERE user_id=$1', [req.session.userId]);
    const watchedRes = await db.query('SELECT title FROM movies WHERE user_id=$1', [req.session.userId]);
    const watchedTitles = new Set(watchedRes.rows.map(r => r.title.toLowerCase()));

    const genreCount = {};
    result.rows.forEach(row => {
      if (!row.genres) return;
      row.genres.split(',').forEach(g => {
        const genre = g.trim();
        genreCount[genre] = (genreCount[genre] || 0) + 1;
      });
    });

    if (!Object.keys(genreCount).length) return res.json({ results: [], genre: null });
    const topGenre = Object.entries(genreCount).sort((a, b) => b[1] - a[1])[0][0];

    let genreId = null;
    for (const [name, id] of Object.entries(TMDB_GENRE_MAP)) {
      if (name.toLowerCase() === topGenre.toLowerCase() || topGenre.toLowerCase().includes(name.toLowerCase())) {
        genreId = id; break;
      }
    }

    const movies = await fetchMoviesForGenre(genreId || 28, watchedTitles, 15);
    res.json({ results: movies, genre: topGenre });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

// ===== CHAT =====
async function initChatTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      avatar TEXT DEFAULT '🎬',
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
initChatTable().catch(err => console.error('Chat table error:', err));

// Get last 60 messages
app.get('/api/chat', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, user_id, username, avatar, message, movie_data, created_at
       FROM chat_messages ORDER BY created_at DESC LIMIT 60`
    );
    res.json(result.rows.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get only messages newer than a given id (for polling)
app.get('/api/chat/since/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, user_id, username, avatar, message, movie_data, created_at
       FROM chat_messages WHERE id > $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a message
app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, movie_data } = req.body;
  if ((!message || !message.trim()) && !movie_data) return res.status(400).json({ error: 'Empty message' });
  if (message && message.length > 500) return res.status(400).json({ error: 'Message too long' });

  try {
    const userResult = await db.query('SELECT username, avatar FROM users WHERE id=$1', [req.session.userId]);
    const user = userResult.rows[0];
    const movieDataStr = movie_data ? JSON.stringify(movie_data) : null;
    const result = await db.query(
      'INSERT INTO chat_messages (user_id, username, avatar, message, movie_data) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.session.userId, user.username, user.avatar || '🎬', (message || '').trim(), movieDataStr]
    );
    const newBadges = [];
    const b = await awardBadge(req.session.userId, 'chatter');
    if (b) newBadges.push(b);
    res.json({ ...result.rows[0], newBadges });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== FRIENDS =====

// Add is_banned column if not exists
async function initUserColumns() {
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE`);
}
initUserColumns().catch(() => {});

// Add movie_data column to chat if not exists
async function initChatMovieColumn() {
  await db.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS movie_data TEXT`);
}
initChatMovieColumn().catch(() => {});

// Create friends table on init (added to initDB)
async function initFriendsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_user_id, to_user_id)
    )
  `);
}
initFriendsTable().catch(err => console.error('Friends table error:', err));

// Search users by username
app.get('/api/users/search', requireAuth, async (req, res) => {
  const q = req.query.q || '';
  if (q.length < 2) return res.json([]);
  try {
    const result = await db.query(
      `SELECT id, username, avatar FROM users
       WHERE username ILIKE $1 AND id != $2 LIMIT 10`,
      [`%${q}%`, req.session.userId]
    );
    // Also get friendship status for each result
    const users = await Promise.all(result.rows.map(async (u) => {
      const fr = await db.query(
        `SELECT status, from_user_id FROM friend_requests
         WHERE (from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)`,
        [req.session.userId, u.id]
      );
      let status = 'none';
      let direction = null;
      if (fr.rows.length > 0) {
        status = fr.rows[0].status;
        direction = fr.rows[0].from_user_id === req.session.userId ? 'sent' : 'received';
      }
      return { ...u, friendStatus: status, direction };
    }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send friend request
app.post('/api/friends/request/:userId', requireAuth, async (req, res) => {
  const toId = parseInt(req.params.userId);
  if (toId === req.session.userId) return res.status(400).json({ error: 'Cannot add yourself' });
  try {
    await db.query(
      'INSERT INTO friend_requests (from_user_id, to_user_id) VALUES ($1, $2)',
      [req.session.userId, toId]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Request already sent' });
    res.status(500).json({ error: err.message });
  }
});

// Get pending requests (received)
app.get('/api/friends/requests', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT fr.id, u.username, u.avatar, u.id as from_id
       FROM friend_requests fr
       JOIN users u ON u.id = fr.from_user_id
       WHERE fr.to_user_id = $1 AND fr.status = 'pending'`,
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept/decline request
app.put('/api/friends/request/:id', requireAuth, async (req, res) => {
  const { action } = req.body; // 'accept' or 'decline'
  try {
    await db.query(
      `UPDATE friend_requests SET status = $1 WHERE id = $2 AND to_user_id = $3`,
      [action === 'accept' ? 'accepted' : 'declined', req.params.id, req.session.userId]
    );
    const newBadges = [];
    if (action === 'accept') { const b = await awardBadge(req.session.userId, 'social'); if (b) newBadges.push(b); }
    res.json({ success: true, newBadges });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get friends list
app.get('/api/friends', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.username, u.avatar,
        (SELECT COUNT(*) FROM movies WHERE user_id = u.id) as movie_count
       FROM friend_requests fr
       JOIN users u ON (
         CASE WHEN fr.from_user_id = $1 THEN u.id = fr.to_user_id
              ELSE u.id = fr.from_user_id END
       )
       WHERE (fr.from_user_id = $1 OR fr.to_user_id = $1) AND fr.status = 'accepted'`,
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove friend
app.delete('/api/friends/:userId', requireAuth, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM friend_requests
       WHERE (from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)`,
      [req.session.userId, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// View a friend's profile
app.get('/api/friends/:userId/profile', requireAuth, async (req, res) => {
  const friendId = parseInt(req.params.userId);
  try {
    const check = await db.query(
      `SELECT id FROM friend_requests
       WHERE ((from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1))
       AND status='accepted'`,
      [req.session.userId, friendId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not friends' });

    const userRes = await db.query(
      'SELECT id, username, avatar, bio, created_at, active_badge, banner_color, favorite_movie_id, public_profile FROM users WHERE id=$1',
      [friendId]
    );
    const user = userRes.rows[0];
    if (user && user.public_profile === false) return res.status(403).json({ error: 'This user has a private profile' });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [statsRes, wlRes, topRes, recentRes, badgesRes] = await Promise.all([
      db.query('SELECT COUNT(*) as total, AVG(rating) as avg_rating FROM movies WHERE user_id=$1', [friendId]),
      db.query('SELECT COUNT(*) as count FROM watchlist WHERE user_id=$1', [friendId]),
      db.query('SELECT COUNT(*) as count FROM movies WHERE user_id=$1 AND rating=5', [friendId]),
      db.query('SELECT title, "posterUrl", rating FROM movies WHERE user_id=$1 ORDER BY created_at DESC LIMIT 6', [friendId]),
      db.query('SELECT badge_id FROM user_badges WHERE user_id=$1', [friendId])
    ]);

    let favMovie = null;
    if (user.favorite_movie_id) {
      const favRes = await db.query('SELECT title, "posterUrl", year, rating, genres FROM movies WHERE id=$1', [user.favorite_movie_id]);
      if (favRes.rows.length > 0) favMovie = favRes.rows[0];
    }

    const stats = statsRes.rows[0];
    res.json({
      username: user.username,
      avatar: user.avatar || '🎬',
      bio: user.bio || '',
      joinDate: user.created_at,
      bannerColor: user.banner_color || '#1c2228',
      activeBadge: user.active_badge || null,
      badges: badgesRes.rows.map(r => r.badge_id),
      favMovie,
      totalMovies: parseInt(stats.total) || 0,
      avgRating: stats.avg_rating ? parseFloat(stats.avg_rating).toFixed(1) : 'N/A',
      watchlistCount: parseInt(wlRes.rows[0].count) || 0,
      topRatedCount: parseInt(topRes.rows[0].count) || 0,
      recentMovies: recentRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// View a friend's movies
app.get('/api/friends/:userId/movies', requireAuth, async (req, res) => {
  const friendId = parseInt(req.params.userId);
  try {
    // Verify they are actually friends
    const check = await db.query(
      `SELECT id FROM friend_requests
       WHERE (from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)
       AND status='accepted'`,
      [req.session.userId, friendId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not friends' });

    const result = await db.query(
      'SELECT * FROM movies WHERE user_id = $1 ORDER BY created_at DESC',
      [friendId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ADMIN =====
const requireAdmin = (req, res, next) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  next();
};

// Get all users
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, username, email, avatar, is_banned, created_at,
        (SELECT COUNT(*) FROM movies WHERE user_id = users.id) as movie_count
       FROM users ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ban or unban a user
app.put('/api/admin/users/:id/ban', requireAuth, requireAdmin, async (req, res) => {
  const { ban } = req.body; // true or false
  const targetId = parseInt(req.params.id);
  if (targetId === req.session.userId) return res.status(400).json({ error: 'Cannot ban yourself' });
  try {
    await db.query('UPDATE users SET is_banned = $1 WHERE id = $2', [ban, targetId]);
    // Destroy their session by deleting their movies access won't help much but ban prevents login
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete any chat message
app.delete('/api/admin/chat/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM chat_messages WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎬 PopcornLog running on http://localhost:${PORT}`);
  // Keep-alive ping every 14 minutes so Railway never hibernates
  const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/ping`
    : `http://localhost:${PORT}/api/ping`;
  setInterval(async () => {
    try {
      await fetch(SELF_URL);
      console.log('🏓 Keep-alive ping sent');
    } catch(e) {
      console.warn('Keep-alive ping failed:', e.message);
    }
  }, 14 * 60 * 1000); // every 14 minutes
});
