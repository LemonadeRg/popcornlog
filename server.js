const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const session = require('express-session');
const bcrypt = require('bcrypt');
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

// Initialize SQLite Database
const db = new sqlite3.Database('./movies.db', (err) => {
  if (err) console.error('Database error:', err);
  else console.log('✅ Connected to SQLite database');
});

// Create Users Table
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    bio TEXT DEFAULT '',
    avatar TEXT DEFAULT '🎬',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add bio/avatar columns for existing databases (ignore error if already exists)
db.run(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`, () => {});
db.run(`ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT '🎬'`, () => {});

// Create Movies Table (with user_id)
db.run(`
  CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    genres TEXT,
    director TEXT,
    mainCharacter TEXT,
    year INTEGER,
    imdbRating REAL,
    runtime TEXT,
    posterUrl TEXT,
    plot TEXT,
    rating INTEGER,
    userNotes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, title)
  )
`, () => {
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_movies_user_title ON movies(user_id, title)`);
});

// Create Watchlist Table (with user_id)
db.run(`
  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    genres TEXT,
    director TEXT,
    mainCharacter TEXT,
    year INTEGER,
    imdbRating REAL,
    runtime TEXT,
    posterUrl TEXT,
    plot TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, title)
  )
`, () => {
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_user_title ON watchlist(user_id, title)`);
});

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

    db.run(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      [username, email, hashedPassword],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Email or username already exists' });
          }
          return res.status(500).json({ error: 'Signup failed' });
        }

        req.session.userId = this.lastID;
        req.session.username = username;
        res.json({ success: true, message: 'Account created!' });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Signup error' });
  }
});

// Sign In
app.post('/auth/signin', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err || !user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    try {
      const validPassword = await bcrypt.compare(password, user.password);
      
      if (!validPassword) {
        return res.status(400).json({ error: 'Invalid email or password' });
      }

      req.session.userId = user.id;
req.session.username = user.username;
res.json({ 
  success: true, 
  message: 'Logged in!', 
  username: user.username,
  userId: user.id 
});
    } catch (error) {
      res.status(500).json({ error: 'Login error' });
    }
  });
});

// Check Auth Status
app.get('/auth/status', (req, res) => {
  if (req.session.userId) {
    res.json({ 
      authenticated: true, 
      username: req.session.username,
      userId: req.session.userId 
    });
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
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
};

// ===== MOVIES ROUTES =====

// Get all movies for user
app.get('/api/movies', requireAuth, (req, res) => {
  db.all(
    'SELECT * FROM movies WHERE user_id = ? ORDER BY created_at DESC',
    [req.session.userId],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json(rows || []);
      }
    }
  );
});

// Add movie
app.post('/api/movies', requireAuth, async (req, res) => {
  const { movieName, rating, notes } = req.body;

  try {
    const response = await axios.get(`http://www.omdbapi.com/`, {
      params: { apikey: OMDB_API_KEY, t: movieName, type: 'movie' }
    });

    if (response.data.Response === 'False') {
      return res.status(404).json({ error: 'Movie not found' });
    }

    const movie = response.data;
    db.run(
      `INSERT INTO movies 
       (user_id, title, genres, director, mainCharacter, year, imdbRating, runtime, posterUrl, plot, rating, userNotes) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.session.userId,
        movie.Title,
        movie.Genre,
        movie.Director,
        movie.Actors,
        movie.Year,
        movie.imdbRating,
        movie.Runtime,
        movie.Poster,
        movie.Plot,
        rating,
        notes
      ],
      (err) => {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'You already have this movie in your list' });
          }
          res.status(500).json({ error: err.message });
        } else {
          res.json({ success: true });
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Failed to add movie' });
  }
});

// Update movie
app.put('/api/movies/:id', requireAuth, (req, res) => {
  const { rating, userNotes } = req.body;
  const movieId = req.params.id;

  db.run(
    'UPDATE movies SET rating = ?, userNotes = ? WHERE id = ? AND user_id = ?',
    [rating, userNotes, movieId, req.session.userId],
    (err) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json({ success: true });
      }
    }
  );
});

// Delete movie
app.delete('/api/movies/:id', requireAuth, (req, res) => {
  const movieId = req.params.id;

  db.run(
    'DELETE FROM movies WHERE id = ? AND user_id = ?',
    [movieId, req.session.userId],
    (err) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json({ success: true });
      }
    }
  );
});

// ===== WATCHLIST ROUTES =====

// Get watchlist
app.get('/api/watchlist', requireAuth, (req, res) => {
  db.all(
    'SELECT * FROM watchlist WHERE user_id = ? ORDER BY created_at DESC',
    [req.session.userId],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json(rows || []);
      }
    }
  );
});

// Add to watchlist
app.post('/api/watchlist', requireAuth, async (req, res) => {
  const { movieName } = req.body;

  try {
    const response = await axios.get(`http://www.omdbapi.com/`, {
      params: { apikey: OMDB_API_KEY, t: movieName, type: 'movie' }
    });

    if (response.data.Response === 'False') {
      return res.status(404).json({ error: 'Movie not found' });
    }

    const movie = response.data;
    db.run(
      `INSERT INTO watchlist 
       (user_id, title, genres, director, mainCharacter, year, imdbRating, runtime, posterUrl, plot) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.session.userId,
        movie.Title,
        movie.Genre,
        movie.Director,
        movie.Actors,
        movie.Year,
        movie.imdbRating,
        movie.Runtime,
        movie.Poster,
        movie.Plot
      ],
      (err) => {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'This movie is already in your watchlist' });
          }
          res.status(500).json({ error: err.message });
        } else {
          res.json({ success: true });
        }
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
});

// Remove from watchlist
app.delete('/api/watchlist/:id', requireAuth, (req, res) => {
  const watchlistId = req.params.id;

  db.run(
    'DELETE FROM watchlist WHERE id = ? AND user_id = ?',
    [watchlistId, req.session.userId],
    (err) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json({ success: true });
      }
    }
  );
});

// Move from watchlist to movies
app.post('/api/watchlist-to-movies/:id', requireAuth, async (req, res) => {
  const { rating, notes } = req.body;
  const watchlistId = req.params.id;

  db.get(
    'SELECT * FROM watchlist WHERE id = ? AND user_id = ?',
    [watchlistId, req.session.userId],
    (err, watchlistMovie) => {
      if (err || !watchlistMovie) {
        return res.status(500).json({ error: 'Movie not found' });
      }

      db.run(
        `INSERT INTO movies 
         (user_id, title, genres, director, mainCharacter, year, imdbRating, runtime, posterUrl, plot, rating, userNotes) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.session.userId,
          watchlistMovie.title,
          watchlistMovie.genres,
          watchlistMovie.director,
          watchlistMovie.mainCharacter,
          watchlistMovie.year,
          watchlistMovie.imdbRating,
          watchlistMovie.runtime,
          watchlistMovie.posterUrl,
          watchlistMovie.plot,
          rating,
          notes
        ],
        (err) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }

          db.run(
            'DELETE FROM watchlist WHERE id = ? AND user_id = ?',
            [watchlistId, req.session.userId],
            (err) => {
              if (err) {
                res.status(500).json({ error: err.message });
              } else {
                res.json({ success: true });
              }
            }
          );
        }
      );
    }
  );
});

// ===== SEARCH & TRAILER =====

// Search movies
app.get('/api/search/:query', requireAuth, async (req, res) => {
  const query = req.params.query;

  try {
    const response = await axios.get(`http://www.omdbapi.com/`, {
      params: { apikey: OMDB_API_KEY, s: query, type: 'movie' }
    });

    if (response.data.Response === 'False') {
      return res.json({ results: [] });
    }

    const results = response.data.Search.slice(0, 5).map(movie => ({
      title: movie.Title,
      year: movie.Year,
      poster: movie.Poster
    }));

    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get trailer
app.get('/api/trailer/:movieTitle', requireAuth, async (req, res) => {
  try {
    const search = require('yt-search');
    const results = await search(`${req.params.movieTitle} trailer`);

    if (results.videos.length > 0) {
      const videoId = results.videos[0].videoId;
      res.json({ videoId });
    } else {
      res.json({ videoId: null });
    }
  } catch (error) {
    res.json({ videoId: null });
  }
});

// IMDb Top 250 movie IDs (hardcoded for reliable recommendations)
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
app.get('/api/profile', requireAuth, (req, res) => {
  db.get('SELECT id, username, email, bio, avatar, created_at FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err || !user) return res.status(500).json({ error: 'User not found' });

    db.get('SELECT COUNT(*) as total, AVG(rating) as avgRating FROM movies WHERE user_id = ?', [req.session.userId], (err, stats) => {
      db.get('SELECT COUNT(*) as watchlistCount FROM watchlist WHERE user_id = ?', [req.session.userId], (err2, wl) => {
        res.json({
          username: user.username,
          email: user.email,
          bio: user.bio || '',
          avatar: user.avatar || '🎬',
          joinDate: user.created_at,
          totalMovies: stats.total || 0,
          avgRating: stats.avgRating ? parseFloat(stats.avgRating).toFixed(1) : 'N/A',
          watchlistCount: wl.watchlistCount || 0
        });
      });
    });
  });
});

// Update bio and avatar
app.put('/api/profile', requireAuth, (req, res) => {
  const { bio, avatar } = req.body;
  db.run('UPDATE users SET bio = ?, avatar = ? WHERE id = ?', [bio, avatar, req.session.userId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Change password
app.put('/api/profile/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  db.get('SELECT password FROM users WHERE id = ?', [req.session.userId], async (err, user) => {
    if (err || !user) return res.status(500).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, 10);
    db.run('UPDATE users SET password = ? WHERE id = ?', [hashed, req.session.userId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

// Delete account
app.delete('/api/profile', requireAuth, async (req, res) => {
  const { password } = req.body;

  db.get('SELECT password FROM users WHERE id = ?', [req.session.userId], async (err, user) => {
    if (err || !user) return res.status(500).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Incorrect password' });

    db.run('DELETE FROM users WHERE id = ?', [req.session.userId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      req.session.destroy();
      res.json({ success: true });
    });
  });
});

// ===== QUIZ =====
app.get('/api/quiz', requireAuth, (req, res) => {
  let exclude = [];
  try {
    if (req.query.exclude) exclude = JSON.parse(req.query.exclude);
  } catch (e) {}

  db.all(
    'SELECT id, title, plot, posterUrl FROM movies WHERE user_id = ? AND plot IS NOT NULL AND plot != ""',
    [req.session.userId],
    (err, movies) => {
      if (err) return res.status(500).json({ error: err.message });
      if (movies.length < 4) return res.status(400).json({ error: 'Add at least 4 movies to play the quiz!' });

      // Filter out already used movies
      let available = movies.filter(m => !exclude.includes(m.title));

      // If all used, reset
      let reset = false;
      if (available.length === 0) {
        available = movies;
        reset = true;
      }

      // Pick a random correct answer from unused
      const correct = available[Math.floor(Math.random() * available.length)];

      // Pick 3 random wrong answers from all movies
      const others = movies.filter(m => m.id !== correct.id);
      const wrong = others.sort(() => Math.random() - 0.5).slice(0, 3);

      // Shuffle all 4 options
      const options = [...wrong.map(m => m.title), correct.title].sort(() => Math.random() - 0.5);

      res.json({
        plot: correct.plot,
        poster: correct.posterUrl,
        options,
        answer: correct.title,
        reset
      });
    }
  );
});

// ===== RECOMMENDATIONS =====
app.get('/api/recommendations', requireAuth, async (req, res) => {
  db.all(
    'SELECT title, genres FROM movies WHERE user_id = ?',
    [req.session.userId],
    async (err, allWatched) => {
      if (err) return res.status(500).json({ error: err.message });

      const watchedTitles = new Set(allWatched.map(m => m.title.toLowerCase()));

      // Find top genre from all watched movies
      const genreCount = {};
      allWatched.forEach(row => {
        if (!row.genres) return;
        row.genres.split(',').forEach(g => {
          const genre = g.trim();
          genreCount[genre] = (genreCount[genre] || 0) + 1;
        });
      });

      if (!Object.keys(genreCount).length) {
        return res.json({ results: [], genre: null });
      }

      const topGenre = Object.entries(genreCount).sort((a, b) => b[1] - a[1])[0][0];

      try {
        // Shuffle top 250 list and fetch details in batches until we have 6 matches
        const shuffled = [...IMDB_TOP_250].sort(() => Math.random() - 0.5);
        const results = [];

        for (let i = 0; i < shuffled.length && results.length < 6; i += 10) {
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
              results.length < 6
            ) {
              results.push({
                title: m.Title,
                year: m.Year,
                poster: m.Poster,
                imdbRating: m.imdbRating,
                genre: m.Genre
              });
            }
          });
        }

        res.json({ results, genre: topGenre });
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch recommendations' });
      }
    }
  );
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎬 Movie Tracker Server running on http://localhost:${PORT}`);
});