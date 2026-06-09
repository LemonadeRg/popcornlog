const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const OMDB_API_KEY = process.env.OMDB_API_KEY;

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

  console.log('✅ Database tables ready');
}

initDB().catch(err => console.error('DB init error:', err));

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
    res.json({ success: true, message: 'Account created!' });
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

    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true, message: 'Logged in!', username: user.username, userId: user.id });
  } catch (err) {
    res.status(500).json({ error: 'Login error' });
  }
});

// Check Auth Status
app.get('/auth/status', (req, res) => {
  if (req.session.userId) {
    res.json({ authenticated: true, username: req.session.username, userId: req.session.userId });
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
  const { movieName, rating, notes } = req.body;

  try {
    const response = await axios.get('http://www.omdbapi.com/', {
      params: { apikey: OMDB_API_KEY, t: movieName, type: 'movie' }
    });

    if (response.data.Response === 'False') {
      return res.status(404).json({ error: 'Movie not found' });
    }

    const movie = response.data;
    await db.query(
      `INSERT INTO movies (user_id, title, genres, director, "mainCharacter", year, "imdbRating", runtime, "posterUrl", plot, rating, "userNotes")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [req.session.userId, movie.Title, movie.Genre, movie.Director, movie.Actors,
       movie.Year, movie.imdbRating, movie.Runtime, movie.Poster, movie.Plot, rating, notes]
    );
    res.json({ success: true });
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
    const response = await axios.get('http://www.omdbapi.com/', {
      params: { apikey: OMDB_API_KEY, t: movieName, type: 'movie' }
    });

    if (response.data.Response === 'False') {
      return res.status(404).json({ error: 'Movie not found' });
    }

    const movie = response.data;
    await db.query(
      `INSERT INTO watchlist (user_id, title, genres, director, "mainCharacter", year, "imdbRating", runtime, "posterUrl", plot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.session.userId, movie.Title, movie.Genre, movie.Director, movie.Actors,
       movie.Year, movie.imdbRating, movie.Runtime, movie.Poster, movie.Plot]
    );
    res.json({ success: true });
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

// ===== SEARCH & TRAILER =====

// Search movies
app.get('/api/search/:query', requireAuth, async (req, res) => {
  try {
    const response = await axios.get('http://www.omdbapi.com/', {
      params: { apikey: OMDB_API_KEY, s: req.params.query, type: 'movie' }
    });

    if (response.data.Response === 'False') return res.json({ results: [] });

    const results = response.data.Search.slice(0, 5).map(movie => ({
      title: movie.Title,
      year: movie.Year,
      poster: movie.Poster
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
      'SELECT id, username, email, bio, avatar, created_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const statsResult = await db.query(
      'SELECT COUNT(*) as total, AVG(rating) as "avgRating" FROM movies WHERE user_id = $1',
      [req.session.userId]
    );
    const wlResult = await db.query(
      'SELECT COUNT(*) as "watchlistCount" FROM watchlist WHERE user_id = $1',
      [req.session.userId]
    );

    const stats = statsResult.rows[0];
    const wl = wlResult.rows[0];

    res.json({
      username: user.username,
      email: user.email,
      bio: user.bio || '',
      avatar: user.avatar || '🎬',
      joinDate: user.created_at,
      totalMovies: parseInt(stats.total) || 0,
      avgRating: stats.avgRating ? parseFloat(stats.avgRating).toFixed(1) : 'N/A',
      watchlistCount: parseInt(wl.watchlistCount) || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update bio and avatar
app.put('/api/profile', requireAuth, async (req, res) => {
  const { bio, avatar } = req.body;
  try {
    await db.query('UPDATE users SET bio = $1, avatar = $2 WHERE id = $3', [bio, avatar, req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change password
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
app.get('/api/recommendations', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT title, genres FROM movies WHERE user_id = $1',
      [req.session.userId]
    );
    const allWatched = result.rows;
    const watchedTitles = new Set(allWatched.map(m => m.title.toLowerCase()));

    const genreCount = {};
    allWatched.forEach(row => {
      if (!row.genres) return;
      row.genres.split(',').forEach(g => {
        const genre = g.trim();
        genreCount[genre] = (genreCount[genre] || 0) + 1;
      });
    });

    if (!Object.keys(genreCount).length) return res.json({ results: [], genre: null });

    const topGenre = Object.entries(genreCount).sort((a, b) => b[1] - a[1])[0][0];

    const shuffled = [...IMDB_TOP_250].sort(() => Math.random() - 0.5);
    const recommendations = [];

    for (let i = 0; i < shuffled.length && recommendations.length < 6; i += 10) {
      const batch = shuffled.slice(i, i + 10);
      const batchDetails = await Promise.all(
        batch.map(id =>
          axios.get('http://www.omdbapi.com/', {
            params: { apikey: OMDB_API_KEY, i: id }
          }).then(r => r.data).catch(() => null)
        )
      );

      batchDetails.forEach(m => {
        if (
          m && m.Response !== 'False' &&
          m.Poster && m.Poster !== 'N/A' &&
          !watchedTitles.has(m.Title.toLowerCase()) &&
          m.Genre && m.Genre.toLowerCase().includes(topGenre.toLowerCase()) &&
          recommendations.length < 6
        ) {
          recommendations.push({
            title: m.Title, year: m.Year, poster: m.Poster,
            imdbRating: m.imdbRating, genre: m.Genre
          });
        }
      });
    }

    res.json({ results: recommendations, genre: topGenre });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

// ===== FRIENDS =====

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
    res.json({ success: true });
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

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎬 PopcornLog running on http://localhost:${PORT}`);
});
