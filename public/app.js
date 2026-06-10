console.log('✅ app.js loaded successfully');

// Load live movie posters into auth background
(async function loadAuthBackground() {
  try {
    const res = await fetch('/api/home/trending');
    if (!res.ok) return;
    const movies = await res.json();
    const overlay = document.getElementById('authBgOverlay');
    if (!overlay) return;
    // Use up to 8 posters
    const posters = movies.filter(m => m.poster).slice(0, 8);
    overlay.innerHTML = posters.map(m =>
      `<img src="${m.poster}" alt="" loading="lazy">`
    ).join('');
  } catch(e) {}
})();

// ===== THEME =====
function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  updateThemeIcon(isLight);
}

function updateThemeIcon(isLight) {
  document.querySelectorAll('#themeToggle, #themeToggleAuth').forEach(btn => {
    if (btn) btn.textContent = isLight ? '☀️' : '🌙';
  });
}

// Apply saved theme on load
(function() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') {
    document.body.classList.add('light-mode');
    updateThemeIcon(true);
  }
})();

let allMovies = [];
let allWatchlist = [];
let currentFilter = 'all';
let selectedMovieId = null;
let ratingCallback = null;
let confirmCallback = null;
let selectedRating = 0;
let currentUserId = null;
let currentIsAdmin = false;

// ===== CHECK AUTHENTICATION =====
window.addEventListener('load', async function() {
  // Apply saved language on load
  document.documentElement.lang = currentLang;
  document.documentElement.dir = currentLang === 'ar' ? 'rtl' : 'ltr';
  applyTranslations();

  const response = await fetch('/auth/status');
  const data = await response.json();

  if (data.authenticated) {
    currentUserId = data.userId;
    currentIsAdmin = data.isAdmin || false;
    if (currentIsAdmin) {
      document.getElementById('adminBtn').style.display = 'flex';
      const da = document.getElementById('drawerAdminBtn');
      if (da) da.style.display = 'flex';
    }
    showApp();
    await waitForServer(20000); // wait up to 20s for Railway to wake up
    await loadMovies();
    showSection('home');
    // Special welcome popup for bro
    if (sessionStorage.getItem('broWelcome')) {
      sessionStorage.removeItem('broWelcome');
      setTimeout(() => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;`;
        overlay.innerHTML = `<div style="background:#1c2228;border:1px solid #E8B84B;border-radius:20px;padding:40px 48px;text-align:center;max-width:340px;animation:authCardIn 0.4s ease;">
          <div style="font-size:3em;margin-bottom:12px;">👋🍿</div>
          <div style="font-size:1.5em;font-weight:800;color:#E8B84B;margin-bottom:8px;">Mra7ba b kho moul chi</div>
          <div style="color:#7a8a99;font-size:0.9em;margin-bottom:24px;">Welcome to PopcornLog!</div>
          <button onclick="this.closest('div[style*=fixed]').remove()" style="padding:10px 28px;background:#E8B84B;color:#000;border:none;border-radius:8px;font-weight:800;font-size:1em;cursor:pointer;font-family:inherit;">Let's go 🎬</button>
        </div>`;
        document.body.appendChild(overlay);
      }, 800);
    }
    // Backfill any badges earned before the badge system existed
    fetch('/api/badges/recalculate', { method: 'POST' })
      .then(r => r.json())
      .then(d => { if (d.newBadges?.length) handleNewBadges(d.newBadges); })
      .catch(() => {});
  } else {
    showAuth();
  }
});

function showAuth() {
  document.getElementById('authPage').style.display = 'flex';
  document.getElementById('appPage').style.display = 'none';
}

function showApp() {
  document.getElementById('authPage').style.display = 'none';
  document.getElementById('appPage').style.display = 'flex';
  startNotificationPolling();
}

// ===== MOBILE DRAWER =====
function toggleMobileMenu() {
  const drawer = document.getElementById('mobileDrawer');
  const overlay = document.getElementById('mobileDrawerOverlay');
  const open = drawer.style.display === 'flex';
  drawer.style.display = open ? 'none' : 'flex';
  overlay.style.display = open ? 'none' : 'block';
}
function closeMobileMenu() {
  document.getElementById('mobileDrawer').style.display = 'none';
  document.getElementById('mobileDrawerOverlay').style.display = 'none';
}
function mobileNav(section) {
  closeMobileMenu();
  showSection(section);
  // Sync active state in drawer
  document.querySelectorAll('.drawer-btn').forEach(b => b.classList.remove('active'));
  const map = { home:'Home', movies:'My Movies', watchlist:'Watch Later', toprated:'Top Rated', recommended:'Recommended', quiz:'Quiz', friends:'Friends', chat:'Chat', profile:'Profile', admin:'Admin' };
  document.querySelectorAll('.drawer-btn').forEach(b => {
    if (b.textContent.trim().includes(map[section] || '')) b.classList.add('active');
  });
}

// ===== NOTIFICATIONS =====
let notifPollInterval = null;
let lastSeenActivityId = 0;
let seenActivityIds = new Set();

// Load persisted notifications from localStorage
function loadStoredNotifs() {
  try { return JSON.parse(localStorage.getItem('popcorn_notifs') || '[]'); } catch { return []; }
}
function saveStoredNotifs(notifs) {
  localStorage.setItem('popcorn_notifs', JSON.stringify(notifs.slice(0, 50)));
}

function startNotificationPolling() {
  if (notifPollInterval) return;
  // Mark already-stored activity IDs as seen so we don't re-add them
  loadStoredNotifs().forEach(n => { if (n.activityId) seenActivityIds.add(n.activityId); });
  pollNotifications();
  notifPollInterval = setInterval(pollNotifications, 30000);
}

async function pollNotifications() {
  try {
    const res = await fetch('/api/notifications');
    if (!res.ok) return;
    const data = await res.json();

    const stored = loadStoredNotifs();
    let changed = false;

    // Friend requests — sync them
    // Remove old friend-request notifs and re-add current ones
    const withoutRequests = stored.filter(n => n.type !== 'friend_request');
    // We'll add one consolidated or individual ones from server
    // For simplicity: if pending > 0 and no request notif, add a refresh notif
    // Actually better: reload pending requests to get details
    if (data.pendingRequests > 0) {
      // Fetch full request list for names
      const reqRes = await fetch('/api/friends/requests');
      if (reqRes.ok) {
        const requests = await reqRes.json();
        const existingRequestIds = new Set(withoutRequests.filter(n=>n.type==='friend_request').map(n=>n.requestId));
        requests.forEach(r => {
          if (!stored.find(n => n.type === 'friend_request' && n.requestId === r.id)) {
            withoutRequests.unshift({
              id: `req_${r.id}`,
              type: 'friend_request',
              requestId: r.id,
              username: r.username,
              avatar: r.avatar || '🎬',
              time: new Date().toISOString(),
              read: false
            });
            changed = true;
          }
        });
        // Remove request notifs that are no longer pending
        const pendingIds = new Set(requests.map(r => r.id));
        for (let i = withoutRequests.length - 1; i >= 0; i--) {
          if (withoutRequests[i].type === 'friend_request' && !pendingIds.has(withoutRequests[i].requestId)) {
            withoutRequests.splice(i, 1);
            changed = true;
          }
        }
      }
    } else {
      // Remove all friend request notifs
      const before = withoutRequests.length;
      for (let i = withoutRequests.length - 1; i >= 0; i--) {
        if (withoutRequests[i].type === 'friend_request') withoutRequests.splice(i, 1);
      }
      if (withoutRequests.length !== before) changed = true;
    }

    // New movie activity
    if (data.newActivity) {
      data.newActivity.forEach(activity => {
        if (seenActivityIds.has(activity.id)) return;
        seenActivityIds.add(activity.id);
        if (activity.id > lastSeenActivityId) lastSeenActivityId = activity.id;
        const d = activity.data;
        withoutRequests.unshift({
          id: `act_${activity.id}`,
          type: 'movie_added',
          activityId: activity.id,
          username: d.username,
          avatar: d.avatar || '🎬',
          title: d.title,
          poster: d.poster,
          year: d.year,
          time: activity.created_at,
          read: false
        });
        changed = true;
      });
      if (lastSeenActivityId > 0) {
        fetch('/api/notifications/seen', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ lastActivityId: lastSeenActivityId })
        }).catch(() => {});
      }
    }

    if (changed) saveStoredNotifs(withoutRequests);
    renderNotifBadge();
    if (document.getElementById('notifPanel').style.display !== 'none') renderNotifPanel();
  } catch (e) { /* silently fail */ }
}

function renderNotifBadge() {
  const notifs = loadStoredNotifs();
  const unread = notifs.filter(n => !n.read).length;
  const badge = document.getElementById('notifBadge');
  const friendBadge = document.getElementById('friendRequestBadge');
  const friendReqs = notifs.filter(n => n.type === 'friend_request').length;

  if (badge) {
    if (unread > 0) { badge.textContent = unread > 9 ? '9+' : unread; badge.style.display = 'flex'; }
    else badge.style.display = 'none';
  }
  if (friendBadge) {
    if (friendReqs > 0) { friendBadge.textContent = friendReqs; friendBadge.style.display = 'flex'; }
    else friendBadge.style.display = 'none';
  }
}

function toggleNotifPanel() {
  const panel = document.getElementById('notifPanel');
  const isOpen = panel.style.display !== 'none';
  if (isOpen) {
    panel.style.display = 'none';
  } else {
    renderNotifPanel();
    panel.style.display = 'block';
    // Mark all as read
    const notifs = loadStoredNotifs();
    notifs.forEach(n => n.read = true);
    saveStoredNotifs(notifs);
    renderNotifBadge();
  }
}

// Close panel when clicking outside
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notifPanel');
  const btn = document.getElementById('notifBtn');
  if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
    panel.style.display = 'none';
  }
});

function renderNotifPanel() {
  const notifs = loadStoredNotifs();
  const list = document.getElementById('notifList');
  if (!list) return;

  if (notifs.length === 0) {
    list.innerHTML = `<div style="padding:28px; text-align:center; color:var(--text-muted); font-size:0.88em;">No notifications yet</div>`;
    return;
  }

  list.innerHTML = notifs.map(n => {
    const time = n.time ? new Date(n.time).toLocaleString('en-US', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '';
    if (n.type === 'friend_request') {
      return `
        <div style="padding:14px 16px; border-bottom:1px solid var(--border); background:${n.read ? 'transparent' : 'rgba(0,224,84,0.04)'};">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
            <span style="font-size:1.4em;">${n.avatar}</span>
            <div style="flex:1;">
              <div style="color:var(--text); font-size:0.88em;"><strong>${n.username}</strong> sent you a friend request</div>
              <div style="color:var(--text-muted); font-size:0.75em; margin-top:2px;">${time}</div>
            </div>
          </div>
          <div style="display:flex; gap:8px;">
            <button onclick="notifRespondRequest(${n.requestId}, 'accept', '${n.id}')" style="flex:1; padding:6px; background:var(--green); color:#000; border:none; border-radius:4px; cursor:pointer; font-weight:700; font-size:0.8em; font-family:inherit;">Accept</button>
            <button onclick="notifRespondRequest(${n.requestId}, 'decline', '${n.id}')" style="flex:1; padding:6px; background:transparent; color:var(--red); border:1px solid var(--red); border-radius:4px; cursor:pointer; font-weight:700; font-size:0.8em; font-family:inherit;">Decline</button>
          </div>
        </div>`;
    }
    if (n.type === 'movie_added') {
      return `
        <div style="padding:14px 16px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:12px; background:${n.read ? 'transparent' : 'rgba(0,224,84,0.04)'};">
          <img src="${n.poster && n.poster !== 'N/A' ? n.poster : ''}" onerror="this.style.display='none'" style="width:36px; height:52px; object-fit:cover; border-radius:4px; flex-shrink:0;">
          <div style="flex:1; min-width:0;">
            <div style="color:var(--text); font-size:0.88em;"><strong>${n.avatar} ${n.username}</strong> added <strong>${n.title}</strong></div>
            <div style="color:var(--text-muted); font-size:0.75em; margin-top:2px;">${n.year || ''} · ${time}</div>
          </div>
          <button onclick="dismissNotif('${n.id}')" style="background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:1.1em; flex-shrink:0;">✕</button>
        </div>`;
    }
    return '';
  }).join('');
}

async function notifRespondRequest(requestId, action, notifId) {
  await fetch(`/api/friends/request/${requestId}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ action })
  });
  dismissNotif(notifId);
  if (action === 'accept') loadFriends();
  loadPendingRequests();
}

function dismissNotif(notifId) {
  const notifs = loadStoredNotifs().filter(n => n.id !== notifId);
  saveStoredNotifs(notifs);
  renderNotifPanel();
  renderNotifBadge();
}

function clearAllNotifs() {
  saveStoredNotifs([]);
  renderNotifPanel();
  renderNotifBadge();
}

function togglePw(inputId, btn) {
  const input = document.getElementById(inputId);
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  btn.textContent = isHidden ? '🙈' : '👁';
}

function checkGmailHint() {
  const email = document.getElementById('signupEmail').value.trim();
  const hint = document.getElementById('gmailHint');
  if (email.length > 0 && !email.toLowerCase().endsWith('@gmail.com')) {
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
}

let pendingVerifyEmail = '';

function toggleAuth() {
  document.getElementById('loginForm').style.display =
    document.getElementById('loginForm').style.display === 'none' ? 'block' : 'none';
  document.getElementById('signupForm').style.display =
    document.getElementById('signupForm').style.display === 'none' ? 'block' : 'none';
  document.getElementById('verifyForm').style.display = 'none';
}

function showLoginForm() {
  document.getElementById('loginForm').style.display = 'block';
  document.getElementById('signupForm').style.display = 'none';
  document.getElementById('verifyForm').style.display = 'none';
}

function showVerifyForm(email) {
  pendingVerifyEmail = email;
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('signupForm').style.display = 'none';
  document.getElementById('verifyForm').style.display = 'block';
  document.getElementById('verifyCode').value = '';
  document.getElementById('verifyEmailHint').textContent = `We sent a 6-digit code to ${email}`;
}

async function submitVerify() {
  const code = document.getElementById('verifyCode').value.trim();
  if (code.length !== 6) { showAlert('❌ Enter the 6-digit code'); return; }

  try {
    const res = await fetch('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingVerifyEmail, code })
    });
    const data = await res.json();
    if (!res.ok) { showAlert('❌ ' + data.error); return; }

    currentUserId = data.userId;
    currentIsAdmin = data.isAdmin || false;
    if (currentIsAdmin) document.getElementById('adminBtn').style.display = 'flex';
    showApp();
    loadMovies();
  } catch (e) {
    showAlert('❌ Verification failed');
  }
}

async function resendCode() {
  if (!pendingVerifyEmail) return;
  try {
    const res = await fetch('/auth/resend-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingVerifyEmail })
    });
    const data = await res.json();
    if (res.ok) showAlert('✅ New code sent! Check your email.');
    else showAlert('❌ ' + data.error);
  } catch(e) {
    showAlert('❌ Failed to resend');
  }
}

// ===== SIGN UP =====
async function handleSignup() {
  const username = document.getElementById('signupUsername').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;

  if (!username || !email || !password) {
    showAlert('❌ All fields required!');
    return;
  }

  if (password.length < 6) {
    showAlert('❌ Password must be at least 6 characters!');
    return;
  }

  if (!email.toLowerCase().endsWith('@gmail.com')) {
    showConfirm('Are you sure about your email? It doesn\'t look like a Gmail address (@gmail.com). Go back to fix it?', (confirmed) => {
      if (confirmed) return;
      submitSignup(username, email, password);
    });
    return;
  }

  submitSignup(username, email, password);
}

async function submitSignup(username, email, password) {
  try {
    const response = await fetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });

    const data = await response.json();

    if (!response.ok) {
      showAlert('❌ ' + data.error);
      return;
    }

    if (data.needsVerification) {
      showVerifyForm(data.email);
      return;
    }

    currentUserId = data.userId;
    currentIsAdmin = data.isAdmin || false;
    if (currentIsAdmin) document.getElementById('adminBtn').style.display = 'flex';
    showAlert('✅ Account created! Welcome ' + username);
    showApp();
    loadMovies();
  } catch (error) {
    showAlert('❌ Signup failed: ' + error.message);
  }
}

// ===== SIGN IN =====
async function handleLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  if (!email || !password) {
    showAlert('❌ Email and password required!');
    return;
  }

  try {
    const response = await fetch('/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (!response.ok) {
      if (data.needsVerification) { showVerifyForm(data.email); return; }
      showAlert('❌ ' + data.error);
      return;
    }

    // Special welcome for bro
    if (email.toLowerCase() === 'ragraguinawfal6@gmail.com') {
      sessionStorage.setItem('broWelcome', '1');
    }
    // Reload the page so the server is fully warm before loading home data
    sessionStorage.setItem('justLoggedIn', '1');
    location.reload();
  } catch (error) {
    showAlert('❌ Login failed: ' + error.message);
  }
}

// ===== LOGOUT =====
async function handleLogout() {
  await fetch('/auth/logout', { method: 'POST' });
  currentUserId = null;
  document.getElementById('loginEmail').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('signupUsername').value = '';
  document.getElementById('signupEmail').value = '';
  document.getElementById('signupPassword').value = '';
  showAuth();
}

// ===== ALERT & CONFIRM =====
function showAlert(message) {
  document.getElementById('alertMessage').textContent = message;
  document.getElementById('alertModal').classList.add('active');
}

function closeAlert() {
  document.getElementById('alertModal').classList.remove('active');
}

function showConfirm(message, callback) {
  document.getElementById('confirmMessage').textContent = message;
  confirmCallback = callback;
  document.getElementById('confirmModal').classList.add('active');
}

function confirmYes() {
  document.getElementById('confirmModal').classList.remove('active');
  if (confirmCallback) confirmCallback(true);
  confirmCallback = null;
}

function confirmNo() {
  document.getElementById('confirmModal').classList.remove('active');
  if (confirmCallback) confirmCallback(false);
  confirmCallback = null;
}

window.addEventListener('click', function(event) {
  const alertModal = document.getElementById('alertModal');
  const confirmModal = document.getElementById('confirmModal');
  const avatarModal = document.getElementById('avatarModal');
  if (alertModal && event.target === alertModal) closeAlert();
  if (confirmModal && event.target === confirmModal) confirmNo();
  if (avatarModal && event.target === avatarModal) closeAvatarPicker();
});

// ===== SECTION NAVIGATION =====
function showSectionEl(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'block';
  el.classList.remove('section-visible');
  // force reflow so animation retriggers
  void el.offsetWidth;
  el.classList.add('section-visible');
}

// ===== HOME PAGE =====
// Wait for server to be alive (handles Railway cold start)
async function waitForServer(maxWaitMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await fetch('/api/ping');
      if (r.ok) return true;
    } catch (e) { /* still waking */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

function renderHomeData(d) {
  const s = d.stats || {};
  const statsEl = document.getElementById('homeStats');
  const podium  = document.getElementById('leaderboardPodium');
  const feedEl  = document.getElementById('homeFeed');
  const trendEl = document.getElementById('homeTrending');

  // Stats
  if (statsEl) {
    const days = Math.round((s.hours || 0) / 24 * 10) / 10;
    statsEl.innerHTML = `
      <div class="home-stat-card stat-green">
        <div class="stat-icon">🎬</div>
        <div class="stat-value">${s.total || 0}</div>
        <div class="stat-label">Films Logged</div>
        <div class="stat-sub">${s.topGenre ? `Top genre: ${s.topGenre}` : 'Keep watching!'}</div>
      </div>
      <div class="home-stat-card stat-blue">
        <div class="stat-icon">⏱️</div>
        <div class="stat-value">${s.hours || 0}<span style="font-size:0.5em;font-weight:500;margin-left:3px;">hrs</span></div>
        <div class="stat-label">Time Watched</div>
        <div class="stat-sub">${days} days of cinema</div>
      </div>
      <div class="home-stat-card stat-gold">
        <div class="stat-icon">⭐</div>
        <div class="stat-value">${s.avgRating || '—'}</div>
        <div class="stat-label">Avg Rating</div>
        <div class="stat-sub">${s.avgRating >= 4 ? 'You love movies!' : s.avgRating ? 'Picky critic 🎭' : 'Rate some films'}</div>
      </div>
      <div class="home-stat-card stat-orange">
        <div class="stat-icon">${(s.streak || 0) > 2 ? '🔥' : '📅'}</div>
        <div class="stat-value">${s.streak || 0}</div>
        <div class="stat-label">Day Streak</div>
        <div class="stat-sub">${(s.streak || 0) > 0 ? `${s.streak} day${s.streak > 1 ? 's' : ''} in a row` : 'Start your streak!'}</div>
      </div>`;
  }

  // Leaderboard
  if (podium) {
    const lb = d.leaderboard || [];
    if (!lb.length) {
      podium.innerHTML = `<div style="color:var(--text-muted);font-size:0.85em;padding:16px 0;text-align:center;">No data yet</div>`;
    } else {
      const rankColors = ['#FFD700','#C0C0C0','#CD7F32'];
      podium.innerHTML = lb.map((u, i) => {
        const pct = lb[0].movie_count > 0 ? Math.round((u.movie_count / lb[0].movie_count) * 100) : 0;
        return `<div class="leaderboard-card">
          <div class="lb-rank" style="color:${rankColors[i] || 'var(--text-muted)'}">${['🥇','🥈','🥉'][i] || i+1}</div>
          <div class="lb-avatar">${avatarWithBadge(u.avatar, u.active_badge, '1.8em')}</div>
          <div class="lb-info">
            <div class="lb-name">${u.username}</div>
            <div class="lb-bar-track"><div class="lb-bar-fill" style="width:${pct}%;background:${rankColors[i]}"></div></div>
          </div>
          <div class="lb-count">${u.movie_count} <span style="font-size:0.7em;opacity:0.6">films</span></div>
        </div>`;
      }).join('');
    }
  }

  // Feed
  if (feedEl) {
    const feed = d.feed || [];
    if (!feed.length) {
      feedEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.85em;padding:20px 0;text-align:center;">Add some friends to see their activity here 👥</div>`;
    } else {
      feedEl.innerHTML = feed.map(item => {
        const raw = item.data;
        const fd = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        const time = new Date(item.created_at).toLocaleString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
        if (item.type === 'movie_added') {
          const safeTitle = (fd.title||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
          const poster = fd.poster && fd.poster !== 'N/A' ? fd.poster : '';
          const stars = fd.rating ? '⭐'.repeat(Math.min(fd.rating,5)) : '';
          return `<div class="feed-card">
            <div class="feed-poster-wrap"><img src="${poster}" onerror="this.style.display='none'" class="feed-poster"></div>
            <div class="feed-body">
              <div class="feed-meta">
                <span class="feed-avatar">${avatarWithBadge(item.avatar, item.active_badge, '1.3em')}</span>
                <span class="feed-username">${item.username||''}</span>
                <span class="feed-action">added a movie</span>
              </div>
              <div class="feed-title">${fd.title||'a movie'}</div>
              ${stars ? `<div class="feed-stars">${stars}</div>` : ''}
              <div class="feed-time">${time}</div>
            </div>
            <button onclick="addMovieFromFeed('${safeTitle}')" class="feed-add-btn">+ Later</button>
          </div>`;
        }
        return '';
      }).join('');
    }
  }

  // Trending
  if (trendEl) {
    const movies = d.trending || [];
    if (!movies.length) {
      trendEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.85em;padding:16px 0;text-align:center;">Trending unavailable</div>`;
    } else {
      trendEl.innerHTML = `<div class="trending-list">` +
        movies.map((m, i) => `
          <div class="trending-card">
            <div class="trending-rank">${i+1}</div>
            <img src="${m.poster||''}" onerror="this.style.display='none'" class="trending-poster">
            <div class="trending-info">
              <div class="trending-title">${m.title}</div>
              <div class="trending-meta">${m.year||''}</div>
            </div>
            <div class="trending-rating">⭐ ${m.rating}</div>
            <button onclick="addMovieFromFeed('${(m.title||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")}') " class="trending-add-btn">+ Later</button>
          </div>`).join('') + `</div>`;
    }
  }
}

async function loadHome() {
  document.getElementById('moodResult').style.display = 'none';
  const statsEl = document.getElementById('homeStats');
  const podium  = document.getElementById('leaderboardPodium');
  const feedEl  = document.getElementById('homeFeed');
  const trendEl = document.getElementById('homeTrending');
  const loadingHTML = `<div class="home-loading">Loading…</div>`;
  if (statsEl) statsEl.innerHTML = loadingHTML;
  if (podium)  podium.innerHTML  = loadingHTML;
  if (feedEl)  feedEl.innerHTML  = loadingHTML;
  if (trendEl) trendEl.innerHTML = loadingHTML;

  // Ping first — ensures Railway server is awake before we fire the real request
  await waitForServer(25000);

  let lastErr = '';
  // Retry the single combined endpoint up to 6 times with 2s gaps
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch('/api/home/all');
      const data = await res.json();
      // Even a 500 with partial data is better than nothing
      if (data.stats || data.leaderboard || data.trending) {
        renderHomeData(data);
        return; // success
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      renderHomeData(data);
      return;
    } catch (err) {
      lastErr = err.message;
      console.warn(`loadHome attempt ${attempt} failed:`, err.message);
      if (attempt < 6) await new Promise(r => setTimeout(r, 2000));
    }
  }
  // All attempts failed — show visible retry button with error
  const errHTML = `<div style="color:var(--text-muted);font-size:0.85em;text-align:center;padding:20px 0;">
    Failed to load. <span style="font-size:0.8em;opacity:0.6">${lastErr}</span><br>
    <button onclick="loadHome()" style="margin-top:10px;padding:7px 18px;background:var(--green);color:#000;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-family:inherit;">Retry</button>
  </div>`;
  if (statsEl) statsEl.innerHTML = errHTML;
  if (podium)  podium.innerHTML  = errHTML;
  if (trendEl) trendEl.innerHTML = errHTML;
  if (feedEl)  feedEl.innerHTML  = errHTML;
}

async function addMovieFromFeed(title) {
  try {
    await fetch('/api/watchlist', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ movieName: title })
    });
    showBadgeToast({ emoji: '📋', name: `"${title}" added to Watch Later!` });
  } catch(e) {}
}

// Keep old individual loaders for leaderboard (used elsewhere)
async function loadLeaderboard() {}
async function loadHomeStats() {}
async function loadHomeFeed() {}
async function loadHomeTrending() {}

const moodMap = {
  chill:    ['Drama', 'Romance'],
  intense:  ['Thriller', 'Action'],
  laugh:    ['Comedy'],
  surprise: ['Action', 'Comedy', 'Drama', 'Thriller', 'Sci-Fi', 'Horror', 'Romance']
};

async function pickMood(mood) {
  const el = document.getElementById('moodResult');
  el.style.display = 'block';
  el.innerHTML = `<div style="color:var(--text-muted); font-size:0.83em; text-align:center; padding:8px;">Finding something…</div>`;
  try {
    const genres = moodMap[mood];
    const genre = genres[Math.floor(Math.random() * genres.length)];
    const res = await fetch(`/api/recommendations/${genre}`);
    const data = await res.json();
    const movies = data.results || data;
    if (!movies.length) { el.innerHTML = `<div style="color:var(--text-muted); font-size:0.83em;">Nothing found. Try again!</div>`; return; }
    const pick = movies[Math.floor(Math.random() * movies.length)];
    el.innerHTML = `
      <div style="display:flex; gap:12px; align-items:flex-start; padding:12px; background:var(--surface2); border-radius:8px; border:1px solid var(--border);">
        <img src="${pick.poster || ''}" onerror="this.style.display='none'" style="width:52px; height:76px; object-fit:cover; border-radius:5px; flex-shrink:0;">
        <div style="flex:1;">
          <div style="font-weight:700; color:var(--text); font-size:0.9em;">${pick.title}</div>
          <div style="color:var(--text-muted); font-size:0.75em; margin:3px 0;">${pick.year || ''} · ${genre}</div>
          <div style="color:var(--text-dim); font-size:0.75em; line-height:1.4; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden;">${pick.overview || pick.plot || ''}</div>
          <div style="display:flex; gap:6px; margin-top:8px;">
            <button onclick="addMovieFromFeed('${(pick.title||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')" style="padding:5px 10px; background:transparent; border:1px solid var(--border); border-radius:6px; color:var(--text-dim); font-size:0.75em; cursor:pointer; font-family:inherit;">+ Watch Later</button>
            <button onclick="pickMood('${mood}')" style="padding:5px 10px; background:transparent; border:1px solid var(--border); border-radius:6px; color:var(--text-dim); font-size:0.75em; cursor:pointer; font-family:inherit;">🔀 Try again</button>
          </div>
        </div>
      </div>`;
  } catch(e) { el.innerHTML = `<div style="color:var(--text-muted); font-size:0.83em;">Something went wrong.</div>`; }
}

const sectionNames = {
  home: '🏠 Home',
  movies: '🎬 My Movies',
  watchlist: '📋 Watch Later',
  toprated: '⭐ Top Rated',
  recommended: '🎯 Recommended',
  games: '🎮 Games',
  quiz: '🎮 Games',
  friends: '👥 Friends',
  chat: '💬 Chat',
  profile: '👤 Profile',
  admin: '🛡️ Admin'
};

async function showSection(section) {
  document.getElementById('homeSection').style.display = 'none';
  document.getElementById('moviesSection').style.display = 'none';
  document.getElementById('watchlistSection').style.display = 'none';
  document.getElementById('topratedSection').style.display = 'none';
  document.getElementById('recommendedSection').style.display = 'none';
  document.getElementById('quizSection').style.display = 'none';
  document.getElementById('gamesSection').style.display = 'none';
  document.getElementById('profileSection').style.display = 'none';
  document.getElementById('friendsSection').style.display = 'none';
  document.getElementById('chatSection').style.display = 'none';
  document.getElementById('adminSection').style.display = 'none';

  // Remove active from all sidebar buttons
  document.querySelectorAll('.sidebar-btn').forEach(b => b.classList.remove('active'));
  stopChatPolling();

  // Update topbar title
  const titleEl = document.getElementById('topbarSectionName');
  if (titleEl) titleEl.textContent = sectionNames[section] || '';

  if (section === 'home') {
    showSectionEl('homeSection');
    document.getElementById('homeBtn').classList.add('active');
    loadHome();
  } else if (section === 'movies') {
    showSectionEl('moviesSection');
    document.getElementById('moviesBtn').classList.add('active');
  } else if (section === 'watchlist') {
    showSectionEl('watchlistSection');
    document.getElementById('watchlistBtn').classList.add('active');
    loadWatchlist();
  } else if (section === 'profile') {
    showSectionEl('profileSection');
    document.getElementById('profileBtn').classList.add('active');
    loadProfile();
  } else if (section === 'games' || section === 'quiz') {
    showSectionEl('gamesSection');
    document.getElementById('gamesBtn').classList.add('active');
    // Show hub by default; quiz shortcut goes straight in
    document.getElementById('gamesHub').style.display = 'block';
    document.getElementById('gameQuiz').style.display = 'none';
    document.getElementById('gameBattle').style.display = 'none';
    document.getElementById('gamePoster').style.display = 'none';
    loadGamesHub();
    if (section === 'quiz') openGame('quiz');
  } else if (section === 'recommended') {
    showSectionEl('recommendedSection');
    document.getElementById('recommendedBtn').classList.add('active');
    loadRecommendations();
  } else if (section === 'toprated') {
    showSectionEl('topratedSection');
    document.getElementById('topratedBtn').classList.add('active');
    displayMovies(allMovies.filter(m => m.rating === 5), 'topratedContainer');
  } else if (section === 'friends') {
    showSectionEl('friendsSection');
    document.getElementById('friendsBtn').classList.add('active');
    loadFriends();
    loadPendingRequests();
  } else if (section === 'chat') {
    showSectionEl('chatSection');
    document.getElementById('chatBtn').classList.add('active');
    initChat();
  } else if (section === 'admin') {
    showSectionEl('adminSection');
    const adminBtn = document.getElementById('adminBtn');
    if (adminBtn) adminBtn.classList.add('active');
    loadAdminUsers();
    loadAdminChat();
  }
}

// ===== ADD MOVIE =====
async function addMovie() {
  const movieInput = document.getElementById('movieInput').value.trim();

  if (!movieInput) {
    showAlert('Please enter a movie name');
    return;
  }

  openRatingModal(async (rating, notes) => {
    try {
      const response = await fetch('/api/movies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          movieName: movieInput,
          rating: rating,
          notes: notes || '',
        }),
      });

      if (!response.ok) throw new Error('Movie not found');

      const data = await response.json();
      handleNewBadges(data.newBadges);
      document.getElementById('movieInput').value = '';
      loadMovies();
      showAlert('Movie added! ✅');
    } catch (error) {
      showAlert('Error: ' + error.message);
    }
  });
}

// ===== LOAD & DISPLAY MOVIES =====
async function loadMovies() {
  // Retry up to 5 times — ensures server is warm before home page loads
  for (let i = 0; i < 5; i++) {
    try {
      const response = await fetch('/api/movies');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      allMovies = await response.json();
      displayMovies(allMovies);
      return; // success
    } catch (error) {
      console.warn(`loadMovies attempt ${i+1} failed:`, error.message);
      if (i < 4) await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function loadLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) return;
    const top = await res.json();
    const medals = ['🥇','🥈','🥉'];
    const podium = document.getElementById('leaderboardPodium');
    if (!podium) return;
    const rankColors = ['#FFD700','#C0C0C0','#CD7F32'];
    const rankBg = ['rgba(255,215,0,0.07)','rgba(192,192,192,0.05)','rgba(205,127,50,0.05)'];
    const maxCount = top[0]?.movie_count || 1;
    podium.innerHTML = top.map((u, i) => `
      <div class="leaderboard-card" style="border-color:${rankColors[i]}40; background:${rankBg[i]};">
        <div class="lb-rank" style="color:${rankColors[i]};">${medals[i]}</div>
        <div class="lb-avatar">${avatarWithBadge(u.avatar, u.active_badge, '1.8em')}</div>
        <div class="lb-username">${u.username}</div>
        <div class="lb-count">${u.movie_count} film${u.movie_count == 1 ? '' : 's'}</div>
        <div class="lb-bar-track">
          <div class="lb-bar-fill" style="width:${Math.round(u.movie_count/maxCount*100)}%; background:${rankColors[i]};"></div>
        </div>
      </div>
    `).join('');
  } catch(e) {}
}

function displayMovies(movies, containerId = 'moviesContainer') {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  if (movies.length === 0) {
    let isEmpty;
    if (containerId === 'topratedContainer') {
      isEmpty = `<h2>${t('noTopRated')}</h2><p>${t('noTopRatedSub')}</p>`;
    } else if (containerId === 'watchlistContainer') {
      isEmpty = `<h2>${t('noWatchlistYet')}</h2><p>${t('addWatchlistEmpty')}</p>`;
    } else {
      isEmpty = `<h2>${t('noMoviesYet')}</h2><p>${t('startAdding')}</p>`;
    }
    container.innerHTML = `<div class="empty-state">${isEmpty}</div>`;
    return;
  }

  movies.forEach((movie) => {
    const movieCard = document.createElement('div');
    movieCard.className = 'movie-card';
    movieCard.innerHTML = `
      <div class="poster-container" onclick="openMovieDetails(${movie.id})">
        <img src="${movie.posterUrl}" alt="${movie.title}" class="poster">
        <div class="play-button">▶</div>
      </div>
      <div class="movie-info">
        <h3>${movie.title}</h3>
        <p class="genre">${movie.genres}</p>
        <p class="director"><strong>Dir:</strong> ${movie.director.substring(0, 30)}</p>
        <p class="actor"><strong>Actor:</strong> ${movie.mainCharacter}</p>
        <div class="rating">
          <span class="stars">${'⭐'.repeat(movie.rating)}</span>
          <span class="rating-number">${movie.rating}/5</span>
        </div>
        <div class="actions">
          <button class="view-btn" onclick="openMovieDetails(${movie.id})">View</button>
          <button class="delete-btn" onclick="deleteMovie(${movie.id})">Delete</button>
        </div>
      </div>
    `;
    container.appendChild(movieCard);
  });
}

// ===== FILTER MOVIES =====
function filterMovies(genre) {
  currentFilter = genre;
  document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');

  if (genre === 'all') {
    displayMovies(allMovies);
  } else {
    const filtered = allMovies.filter((movie) =>
      movie.genres.toLowerCase().includes(genre.toLowerCase())
    );
    displayMovies(filtered);
  }
}

// ===== MOVIE DETAILS =====
async function openMovieDetails(movieId) {
  const movie = allMovies.find(m => m.id === movieId);
  if (!movie) return;

  selectedMovieId = movieId;

  document.getElementById('modalTitle').textContent = movie.title;
  document.getElementById('modalPoster').src = movie.posterUrl;
  document.getElementById('modalGenre').textContent = movie.genres || 'N/A';
  document.getElementById('modalDirector').textContent = movie.director || 'N/A';
  document.getElementById('modalActor').textContent = movie.mainCharacter || 'N/A';
  document.getElementById('modalPlot').textContent = movie.plot || 'Plot not available';
  document.getElementById('modalYear').textContent = movie.year || 'N/A';
  document.getElementById('modalIMDbRating').textContent = movie.imdbRating || 'N/A';
  document.getElementById('modalRuntime').textContent = movie.runtime || 'N/A';

  document.getElementById('modalUserRating').innerHTML = `
    <div class="user-stars">${'⭐'.repeat(movie.rating)}</div>
    <div style="color: #00d9ff; font-weight: bold;">${movie.rating}/5</div>
  `;

  if (movie.userNotes) {
    document.getElementById('modalUserNotes').innerHTML = `<strong>Your Notes:</strong> ${movie.userNotes}`;
  } else {
    document.getElementById('modalUserNotes').textContent = 'No notes added';
  }

  const trailerContainer = document.getElementById('trailerContainer');
  trailerContainer.innerHTML = `<div style="background:#1c2228; padding:40px; border-radius:6px; border:1px solid #2c3440; text-align:center;"><p style="color:#7a8a99;">${t('loadingTrailer')}</p></div>`;

  fetch(`/api/trailer/${encodeURIComponent(movie.title)}`)
    .then(r => r.json())
    .then(data => {
      if (data.videoId) {
        trailerContainer.innerHTML = `<div class="video-container"><iframe src="https://www.youtube.com/embed/${data.videoId}" allowfullscreen></iframe></div>`;
      } else throw new Error();
    })
    .catch(() => {
      trailerContainer.innerHTML = `<div style="background:#1c2228; padding:50px 30px; border-radius:6px; border:1px solid #2c3440; text-align:center;"><h3 style="color:#7a8a99;">${t('trailerUnavailable')}</h3></div>`;
    });

  const modalActions = document.querySelector('.modal-actions');
  modalActions.innerHTML = `
    <button class="edit-btn" onclick="editMovieFromModal()">Edit Rating & Notes</button>
    <button class="delete-modal-btn" onclick="deleteMovieFromModal()">Delete</button>
  `;

  document.getElementById('movieModal').classList.add('active');
}

function closeModal() {
  document.getElementById('movieModal').classList.remove('active');
  document.getElementById('trailerContainer').innerHTML = '';
  selectedMovieId = null;
}

function editMovieFromModal() {
  if (!selectedMovieId) return;
  const movie = allMovies.find(m => m.id === selectedMovieId);
  const newRating = prompt('New rating (1-5):', movie.rating);
  if (newRating) {
    const newNotes = prompt('Update notes:', movie.userNotes || '');
    updateMovie(selectedMovieId, parseInt(newRating), newNotes);
    closeModal();
  }
}

function deleteMovieFromModal() {
  showConfirm('Delete this movie?', (confirmed) => {
    if (confirmed) {
      deleteMovie(selectedMovieId);
      closeModal();
    }
  });
}

async function updateMovie(id, rating, notes) {
  await fetch(`/api/movies/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating, userNotes: notes }),
  });
  loadMovies();
}

async function deleteMovie(id) {
  showConfirm('Delete this movie?', async (confirmed) => {
    if (confirmed) {
      await fetch(`/api/movies/${id}`, { method: 'DELETE' });
      loadMovies();
    }
  });
}

window.addEventListener('click', function(event) {
  const modal = document.getElementById('movieModal');
  if (modal && event.target === modal) closeModal();
});

// ===== WATCHLIST =====
async function addToWatchlist() {
  const input = document.getElementById('watchlistInput').value.trim();
  if (!input) {
    showAlert('Please enter a movie name');
    return;
  }

  try {
    const response = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movieName: input }),
    });

    if (!response.ok) throw new Error('Movie not found on IMDb');

    document.getElementById('watchlistInput').value = '';
    showAlert('Added to Watch Later! ✅');
    loadWatchlist();
  } catch (error) {
    showAlert('Error: ' + error.message);
  }
}

async function loadWatchlist() {
  try {
    const response = await fetch('/api/watchlist');
    allWatchlist = await response.json();
    displayWatchlist(allWatchlist);
    // Reset filter to All
    document.querySelectorAll('#watchlistSection .filter-btn').forEach(b => b.classList.remove('active'));
    const allBtn = document.getElementById('wl-filter-all');
    if (allBtn) allBtn.classList.add('active');
  } catch (error) {
    console.error('Error loading watchlist:', error);
  }
}

function filterWatchlist(genre) {
  document.querySelectorAll('#watchlistSection .filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  if (genre === 'all') {
    displayWatchlist(allWatchlist);
  } else {
    displayWatchlist(allWatchlist.filter(m => m.genres && m.genres.toLowerCase().includes(genre.toLowerCase())));
  }
}

function displayWatchlist(movies) {
  const container = document.getElementById('watchlistContainer');
  container.innerHTML = '';

  if (movies.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No movies yet</h2>
        <p>Add movies you want to watch later! 🎬</p>
      </div>
    `;
    return;
  }

  movies.forEach((movie) => {
    const card = document.createElement('div');
    card.className = 'movie-card';
    card.innerHTML = `
      <div class="poster-container" onclick="openWatchlistDetails(${movie.id})">
        <img src="${movie.posterUrl}" alt="${movie.title}" class="poster">
        <div class="play-button">▶</div>
      </div>
      <div class="movie-info">
        <h3>${movie.title}</h3>
        <p class="genre">${movie.genres}</p>
        <p class="director"><strong>Dir:</strong> ${movie.director.substring(0, 30)}</p>
        <p class="actor"><strong>Actor:</strong> ${movie.mainCharacter}</p>
        <p style="color: #ffd700; margin: 10px 0; font-size: 0.9em;"><strong>IMDb:</strong> ⭐ ${movie.imdbRating}</p>
        <div class="watchlist-actions">
          <button class="watch-btn" onclick="markAsWatched(${movie.id})">✅ Watched</button>
          <button class="remove-btn" onclick="removeFromWatchlist(${movie.id})">Remove</button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

async function openWatchlistDetails(movieId) {
  const movie = allWatchlist.find(m => m.id === movieId);
  if (!movie) return;

  document.getElementById('modalTitle').textContent = movie.title;
  document.getElementById('modalPoster').src = movie.posterUrl;
  document.getElementById('modalGenre').textContent = movie.genres || 'N/A';
  document.getElementById('modalDirector').textContent = movie.director || 'N/A';
  document.getElementById('modalActor').textContent = movie.mainCharacter || 'N/A';
  document.getElementById('modalPlot').textContent = movie.plot || 'Plot not available';
  document.getElementById('modalYear').textContent = movie.year || 'N/A';
  document.getElementById('modalIMDbRating').textContent = movie.imdbRating || 'N/A';
  document.getElementById('modalRuntime').textContent = movie.runtime || 'N/A';

  document.getElementById('modalUserRating').innerHTML = `<div style="color: #aaa; font-style: italic;">Not watched yet</div>`;
  document.getElementById('modalUserNotes').innerHTML = `<div style="color: #aaa;">Click "Watched" on the card to add your rating!</div>`;

  const modalActions = document.querySelector('.modal-actions');
  modalActions.innerHTML = `
    <button class="edit-btn" onclick="closeModal(); markAsWatched(${movie.id})">✅ Mark as Watched</button>
    <button class="delete-modal-btn" onclick="closeModal(); removeFromWatchlist(${movie.id})">Remove from List</button>
  `;

  const trailerContainer = document.getElementById('trailerContainer');
  trailerContainer.innerHTML = `<div style="background:#1c2228; padding:40px; border-radius:6px; border:1px solid #2c3440; text-align:center;"><p style="color:#7a8a99;">${t('loadingTrailer')}</p></div>`;

  fetch(`/api/trailer/${encodeURIComponent(movie.title)}`)
    .then(r => r.json())
    .then(data => {
      if (data.videoId) {
        trailerContainer.innerHTML = `<div class="video-container"><iframe src="https://www.youtube.com/embed/${data.videoId}" allowfullscreen></iframe></div>`;
      } else throw new Error();
    })
    .catch(() => {
      trailerContainer.innerHTML = `<div style="background:#1c2228; padding:50px 30px; border-radius:6px; border:1px solid #2c3440; text-align:center;"><h3 style="color:#7a8a99;">${t('trailerUnavailable')}</h3></div>`;
    });

  document.getElementById('movieModal').classList.add('active');
}

async function removeFromWatchlist(id) {
  showConfirm('Remove from Watch Later?', async (confirmed) => {
    if (confirmed) {
      await fetch(`/api/watchlist/${id}`, { method: 'DELETE' });
      loadWatchlist();
    }
  });
}

async function markAsWatched(id) {
  openRatingModal(async (rating, notes) => {
    try {
      const response = await fetch(`/api/watchlist-to-movies/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: rating, notes: notes || '' }),
      });

      if (!response.ok) throw new Error('Error');
      
      showAlert('Moved to My Movies! ✅');
      loadWatchlist();
      loadMovies();
    } catch (error) {
      showAlert('Error: ' + error.message);
    }
  });
}

// ===== SEARCH =====
let searchTimeout;

async function searchMovies(inputId, suggestionsId) {
  const input = document.getElementById(inputId);
  const suggestionsBox = document.getElementById(suggestionsId);
  const query = input.value.trim();

  clearTimeout(searchTimeout);

  if (query.length < 2) {
    suggestionsBox.classList.remove('active');
    suggestionsBox.innerHTML = '';
    return;
  }

  searchTimeout = setTimeout(async () => {
    try {
      const response = await fetch(`/api/search/${encodeURIComponent(query)}`);
      const data = await response.json();

      if (data.results && data.results.length > 0) {
        suggestionsBox.innerHTML = data.results.map(movie => `
          <div class="suggestion-item" onclick="selectSuggestion('${inputId}', '${suggestionsId}', '${movie.title.replace(/'/g, "\\'")}')">
            <img src="${movie.poster || ''}" alt="" class="suggestion-poster" onerror="this.style.display='none'">
            <div class="suggestion-info">
              <div class="suggestion-title">${movie.title}</div>
              <div class="suggestion-year">${movie.year}</div>
            </div>
          </div>
        `).join('');
        suggestionsBox.classList.add('active');
      } else {
        suggestionsBox.innerHTML = '<div class="suggestion-empty">No movies found</div>';
        suggestionsBox.classList.add('active');
      }
    } catch (error) {
      console.error('Search error:', error);
    }
  }, 300);
}

function selectSuggestion(inputId, suggestionsId, title) {
  document.getElementById(inputId).value = title;
  document.getElementById(suggestionsId).classList.remove('active');
  document.getElementById(suggestionsId).innerHTML = '';
}

document.addEventListener('click', function(event) {
  if (!event.target.closest('.search-wrapper')) {
    document.querySelectorAll('.suggestions-box').forEach(box => {
      box.classList.remove('active');
    });
  }
});

// ===== RATING MODAL =====
function openRatingModal(callback) {
  selectedRating = 0;
  ratingCallback = callback;
  document.getElementById('ratingModal').classList.add('active');
  document.getElementById('notesInput').value = '';
  document.getElementById('selectedRatingDisplay').textContent = 'Select a rating';
  
  document.querySelectorAll('.star-rating .star').forEach(star => {
    star.classList.remove('selected');
  });
}

function closeRatingModal() {
  document.getElementById('ratingModal').classList.remove('active');
  selectedRating = 0;
  ratingCallback = null;
}

function selectRating(rating) {
  selectedRating = rating;
  
  document.querySelectorAll('.star-rating .star').forEach((star, index) => {
    if (index < rating) {
      star.classList.add('selected');
    } else {
      star.classList.remove('selected');
    }
  });
  
  document.getElementById('selectedRatingDisplay').textContent = `Rating: ${rating}/5 ⭐`;
}

function submitRating() {
  if (selectedRating === 0) {
    showAlert('Please select a rating!');
    return;
  }
  
  const notes = document.getElementById('notesInput').value.trim();
  
  if (ratingCallback) {
    ratingCallback(selectedRating, notes);
  }
  
  closeRatingModal();
}

window.addEventListener('click', function(event) {
  const ratingModal = document.getElementById('ratingModal');
  if (ratingModal && event.target === ratingModal) {
    closeRatingModal();
  }
});

// ===== PROFILE =====
// ===== BADGES =====
function showBadgeToast(badge) {
  const toast = document.getElementById('badgeToast');
  document.getElementById('badgeToastEmoji').textContent = badge.emoji;
  document.getElementById('badgeToastName').textContent = badge.name;
  document.getElementById('badgeToastDesc').textContent = badge.desc;
  toast.style.display = 'flex';
  clearTimeout(window._badgeToastTimer);
  window._badgeToastTimer = setTimeout(() => { toast.style.display = 'none'; }, 4000);
}

function handleNewBadges(newBadges) {
  if (!newBadges || newBadges.length === 0) return;
  let delay = 0;
  newBadges.forEach(badge => {
    setTimeout(() => showBadgeToast(badge), delay);
    delay += 4500;
  });
}

async function loadBadges() {
  try {
    const res = await fetch('/api/badges');
    const data = await res.json();
    const grid = document.getElementById('badgesGrid');
    if (!grid) return;

    // Show active badge on avatar
    const activeBadgeEl = document.getElementById('profileActiveBadge');
    if (activeBadgeEl) {
      if (data.activeBadge) {
        const active = data.badges.find(b => b.id === data.activeBadge);
        activeBadgeEl.textContent = active ? active.emoji : '';
        activeBadgeEl.style.display = 'block';
      } else {
        activeBadgeEl.style.display = 'none';
      }
    }

    grid.innerHTML = data.badges.map(b => `
      <div onclick="${b.earned ? `equipBadge('${b.id}', '${data.activeBadge}')` : ''}"
        title="${b.earned ? (data.activeBadge === b.id ? 'Equipped — click to unequip' : 'Click to equip') : 'Not earned yet'}"
        style="
          text-align:center; padding:12px 6px; border-radius:8px; cursor:${b.earned ? 'pointer' : 'default'};
          background:${b.earned ? 'var(--surface2)' : 'transparent'};
          border:1px solid ${data.activeBadge === b.id ? 'var(--green)' : 'var(--border)'};
          opacity:${b.earned ? '1' : '0.35'};
          transition:all 0.15s;
        ">
        <div style="font-size:1.8em; margin-bottom:5px;">${b.emoji}</div>
        <div style="font-size:0.68em; font-weight:700; color:var(--text); text-transform:uppercase; letter-spacing:0.5px;">${b.name}</div>
        <div style="font-size:0.62em; color:var(--text-muted); margin-top:2px;">${b.desc}</div>
      </div>
    `).join('');
  } catch (e) { console.error('Failed to load badges', e); }
}

async function equipBadge(badgeId, currentActive) {
  const equip = currentActive === badgeId ? null : badgeId; // toggle off if already equipped
  await fetch('/api/badges/equip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ badgeId: equip })
  });
  loadBadges();
}

const BANNER_COLORS = [
  { color: '#1c2228', label: 'Dark' },
  { color: '#0d1b2a', label: 'Navy' },
  { color: '#1a1a2e', label: 'Midnight' },
  { color: '#1b1b2f', label: 'Purple Dark' },
  { color: '#2d1b0e', label: 'Warm Brown' },
  { color: '#0a2a1a', label: 'Forest' },
  { color: '#2a0a0a', label: 'Deep Red' },
  { color: '#1a1200', label: 'Gold Dark' },
  { color: '#16213e', label: 'Ocean' },
  { color: '#0f3460', label: 'Blue' },
  { color: '#533483', label: 'Purple' },
  { color: '#c9410a', label: 'Orange' },
  { color: '#0a7a4e', label: 'Green' },
  { color: '#8b0000', label: 'Red' },
  { color: '#b8860b', label: 'Gold' },
];

let currentBannerColor = '#1c2228';

async function loadProfile() {
  try {
    const res = await fetch('/api/profile');
    const data = await res.json();

    document.getElementById('profileAvatar').textContent = data.avatar;
    document.getElementById('profileUsername').textContent = data.username;
    document.getElementById('profileEmail').textContent = data.email;
    document.getElementById('profileBio').value = data.bio;
    const unInput = document.getElementById('newUsernameInput');
    if (unInput) unInput.value = data.username;
    document.getElementById('statMovies').textContent = data.totalMovies;
    document.getElementById('statAvg').textContent = data.avgRating;
    document.getElementById('statWatchlist').textContent = data.watchlistCount;

    const joined = new Date(data.joinDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    document.getElementById('profileJoinDate').textContent = `Member since ${joined}`;

    // Banner — use fav movie TMDB backdrop if available, else color
    currentBannerColor = data.bannerColor || '#1c2228';
    if (data.favoriteMovie) {
      await applyBannerFromMovie(data.favoriteMovie);
    } else {
      applyBanner(currentBannerColor, null);
    }

    // Active badge
    const badgeEl = document.getElementById('profileActiveBadge');
    if (data.activeBadge && badgeEl) {
      badgeEl.textContent = BADGE_EMOJI[data.activeBadge] || '';
      badgeEl.style.display = badgeEl.textContent ? 'block' : 'none';
    }

    // Favorite movie display
    renderFavMovie(data.favoriteMovie);

    // Populate favorite movie dropdown from allMovies
    const sel = document.getElementById('favMovieSelect');
    if (sel) {
      sel.innerHTML = '<option value="">— None —</option>' +
        (allMovies || []).map(m => `<option value="${m.id}" ${data.favoriteMovie?.id === m.id ? 'selected' : ''}>${m.title}${m.year ? ' ('+m.year+')' : ''}</option>`).join('');
      // Live banner preview when dropdown changes
      sel.onchange = async () => {
        const picked = (allMovies||[]).find(m => m.id == sel.value);
        renderFavMovie(picked ? { id: picked.id, title: picked.title, posterUrl: picked.posterUrl, year: picked.year, rating: picked.rating, genres: picked.genres } : null);
        if (picked) {
          await applyBannerFromMovie(picked);
        } else {
          applyBanner(currentBannerColor, null);
        }
      };
    }

    loadBadges();
  } catch (e) {
    console.error('Failed to load profile', e);
  }
}

function applyBanner(color, posterUrl) {
  const banner = document.getElementById('profileBanner');
  if (!banner) return;
  if (posterUrl) {
    // Movie poster as banner with dark gradient overlay so text stays readable
    banner.style.backgroundImage = `linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.65) 100%), url('${posterUrl}')`;
    banner.style.backgroundSize = 'cover';
    banner.style.backgroundPosition = 'center center';
    banner.style.backgroundColor = '';
  } else {
    banner.style.backgroundImage = `linear-gradient(135deg, ${color} 0%, ${color}cc 60%, #E8B84B22 100%)`;
    banner.style.backgroundSize = '';
    banner.style.backgroundPosition = '';
    banner.style.backgroundColor = color;
  }
  banner.onmouseenter = () => { const h = banner.querySelector('.banner-edit-hint'); if(h) h.style.opacity='1'; };
  banner.onmouseleave = () => { const h = banner.querySelector('.banner-edit-hint'); if(h) h.style.opacity='0'; };
}

// Fetch TMDB backdrop (wide landscape) and use it as banner
async function applyBannerFromMovie(movie) {
  try {
    const r = await fetch(`/api/backdrop?title=${encodeURIComponent(movie.title)}&year=${movie.year||''}`);
    const d = await r.json();
    applyBanner(currentBannerColor, d.backdrop || movie.posterUrl || null);
  } catch(e) {
    applyBanner(currentBannerColor, movie.posterUrl || null);
  }
}

function renderFavMovie(movie) {
  const el = document.getElementById('favMovieDisplay');
  if (!el) return;
  if (!movie) {
    el.innerHTML = `<div style="color:var(--text-muted);font-size:0.85em;">No favorite movie pinned yet.</div>`;
    return;
  }
  const stars = movie.rating ? '⭐'.repeat(Math.min(movie.rating, 5)) : '';
  el.innerHTML = `<div style="display:flex;gap:12px;align-items:center;background:var(--surface2);border-radius:10px;padding:12px;">
    <img src="${movie.posterUrl||''}" onerror="this.style.display='none'" style="width:44px;height:64px;object-fit:cover;border-radius:6px;flex-shrink:0;">
    <div>
      <div style="font-weight:700;color:var(--text);font-size:0.95em;">${movie.title}</div>
      <div style="color:var(--text-muted);font-size:0.78em;margin-top:2px;">${movie.year||''} ${movie.genres ? '· '+movie.genres : ''}</div>
      ${stars ? `<div style="margin-top:4px;font-size:0.85em;">${stars}</div>` : ''}
    </div>
    <div style="margin-left:auto;font-size:1.4em;" title="Pinned favorite">📌</div>
  </div>`;
}

function openBannerPicker() {
  const modal = document.getElementById('bannerPickerModal');
  const grid = document.getElementById('bannerColorGrid');
  if (!modal || !grid) return;
  grid.innerHTML = BANNER_COLORS.map(b => `
    <div onclick="selectBanner('${b.color}')" title="${b.label}"
      style="width:100%;aspect-ratio:1;border-radius:8px;background:${b.color};cursor:pointer;border:2px solid ${b.color === currentBannerColor ? '#E8B84B' : 'transparent'};transition:border 0.15s;">
    </div>`).join('');
  modal.style.display = 'flex';
}

function closeBannerPicker() {
  document.getElementById('bannerPickerModal').style.display = 'none';
}

function selectBanner(color) {
  currentBannerColor = color;
  // When user picks a color, clear the movie poster from banner
  applyBanner(color, null);
  closeBannerPicker();
}

async function saveProfile() {
  const bio = document.getElementById('profileBio').value.trim();
  const avatar = document.getElementById('profileAvatar').textContent;
  const favoriteMovieId = document.getElementById('favMovieSelect')?.value || null;

  const res = await fetch('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bio, avatar, bannerColor: currentBannerColor, favoriteMovieId: favoriteMovieId || null })
  });
  const data = await res.json();
  if (res.ok) {
    const selMovie = favoriteMovieId ? (allMovies||[]).find(m => m.id == favoriteMovieId) : null;
    renderFavMovie(selMovie ? { id: selMovie.id, title: selMovie.title, posterUrl: selMovie.posterUrl, year: selMovie.year, rating: selMovie.rating, genres: selMovie.genres } : null);
    if (selMovie) await applyBannerFromMovie(selMovie);
    else applyBanner(currentBannerColor, null);
    showAlert('✅ Profile saved!');
  } else {
    showAlert('❌ ' + data.error);
  }
}

async function changeUsername() {
  const input = document.getElementById('newUsernameInput');
  const msg = document.getElementById('usernameMsg');
  const username = input.value.trim();
  if (!username) { msg.style.color = 'var(--red)'; msg.textContent = 'Please enter a username.'; return; }
  msg.style.color = 'var(--text-muted)'; msg.textContent = 'Saving…';
  const res = await fetch('/api/profile/username', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  });
  const data = await res.json();
  if (res.ok) {
    msg.style.color = 'var(--green)'; msg.textContent = '✅ Username updated!';
    document.getElementById('profileUsername').textContent = data.username;
    input.value = data.username;
    setTimeout(() => { msg.textContent = ''; }, 3000);
  } else {
    msg.style.color = 'var(--red)'; msg.textContent = '❌ ' + data.error;
  }
}

async function changePassword() {
  const currentPassword = document.getElementById('currentPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  if (!currentPassword || !newPassword || !confirmPassword) {
    showAlert('❌ All fields required');
    return;
  }
  if (newPassword !== confirmPassword) {
    showAlert('❌ New passwords do not match');
    return;
  }

  const res = await fetch('/api/profile/password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword })
  });
  const data = await res.json();
  if (res.ok) {
    showAlert('✅ Password updated!');
    document.getElementById('currentPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
  } else {
    showAlert('❌ ' + data.error);
  }
}

function deleteAccount() {
  const password = prompt('Enter your password to confirm account deletion:');
  if (!password) return;

  showConfirm('This will permanently delete your account and ALL your movies. Are you sure?', async (confirmed) => {
    if (!confirmed) return;

    const res = await fetch('/api/profile', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (res.ok) {
      showAuth();
    } else {
      showAlert('❌ ' + data.error);
    }
  });
}

const AVATARS = ['🎬','🍿','🎥','🎞️','🦁','🐺','🦊','🐻','🐼','🎭','👻','🤖','🦸','🧙','🧛','🎃','🌟','🔥','💎','🎮','🏆','🎯','🎸','🎨'];

// Level-locked avatar unlocks — avatar emoji + min level required
const LEVEL_AVATARS = [
  { emoji: '🌙', level: 2,  label: 'Night Owl' },
  { emoji: '⚡', level: 3,  label: 'Electric' },
  { emoji: '🎖️', level: 4,  label: 'Decorated' },
  { emoji: '🦅', level: 5,  label: 'Eagle Eye' },
  { emoji: '🌊', level: 6,  label: 'Wave' },
  { emoji: '🔮', level: 7,  label: 'Oracle' },
  { emoji: '🐉', level: 8,  label: 'Dragon' },
  { emoji: '👑', level: 10, label: 'Royalty' },
  { emoji: '🌌', level: 12, label: 'Galaxy' },
  { emoji: '🦄', level: 15, label: 'Unicorn' },
  { emoji: '💀', level: 20, label: 'Legend' },
  { emoji: '🌠', level: 25, label: 'Star Lord' },
];

// Badge ID → emoji map (mirrors server BADGES object)
const BADGE_EMOJI = {
  first_movie: '🎬', movie_buff: '🍿', cinephile: '🏆', film_fanatic: '🌟',
  the_critic: '⭐', planner: '📋', social: '👥', chatter: '💬',
  explorer: '🗺️', quiz_master: '🎲'
};

// Helper: render avatar + badge bubble together
function avatarWithBadge(avatar, activeBadgeId, size = '1.6em') {
  const badgeEmoji = activeBadgeId ? (BADGE_EMOJI[activeBadgeId] || null) : null;
  if (!badgeEmoji) return `<span style="font-size:${size};">${avatar || '🎬'}</span>`;
  return `<span style="position:relative;display:inline-block;">
    <span style="font-size:${size};">${avatar || '🎬'}</span>
    <span style="position:absolute;bottom:-2px;right:-5px;font-size:0.65em;line-height:1;">${badgeEmoji}</span>
  </span>`;
}

async function openAvatarPicker() {
  // Get current game level to show unlocked avatars
  let currentLevel = 1;
  try {
    const r = await fetch('/api/games/profile');
    const gs = await r.json();
    currentLevel = gs.level || 1;
  } catch(e) {}

  const baseGrid = AVATARS.map(e =>
    `<span onclick="selectAvatar('${e}')" title="Select"
      style="font-size:2em;cursor:pointer;padding:8px;border-radius:6px;border:2px solid transparent;transition:all 0.15s;display:block;"
      onmouseover="this.style.borderColor='var(--green)';this.style.background='var(--surface2)'"
      onmouseout="this.style.borderColor='transparent';this.style.background='transparent'">${e}</span>`
  ).join('');

  const levelGrid = LEVEL_AVATARS.map(a => {
    const unlocked = currentLevel >= a.level;
    return unlocked
      ? `<span onclick="selectAvatar('${a.emoji}')" title="🔓 ${a.label} (Level ${a.level})"
          style="font-size:2em;cursor:pointer;padding:8px;border-radius:6px;border:2px solid #E8B84B44;transition:all 0.15s;display:block;position:relative;"
          onmouseover="this.style.borderColor='#E8B84B';this.style.background='var(--surface2)'"
          onmouseout="this.style.borderColor='#E8B84B44';this.style.background='transparent'">${a.emoji}</span>`
      : `<span title="🔒 ${a.label} — Unlock at Level ${a.level}"
          style="font-size:2em;padding:8px;border-radius:6px;border:2px solid var(--border);display:block;opacity:0.35;cursor:not-allowed;filter:grayscale(1);">${a.emoji}</span>`;
  }).join('');

  document.getElementById('avatarGrid').innerHTML = `
    <div style="font-size:0.72em;text-transform:uppercase;letter-spacing:2px;color:var(--text-muted);font-weight:700;margin-bottom:10px;grid-column:1/-1;">Standard</div>
    ${baseGrid}
    <div style="font-size:0.72em;text-transform:uppercase;letter-spacing:2px;color:#E8B84B;font-weight:700;margin:14px 0 10px;grid-column:1/-1;">🏆 Level Rewards · You are Level ${currentLevel}</div>
    ${levelGrid}
  `;
  document.getElementById('avatarModal').classList.add('active');
}

function closeAvatarPicker() {
  document.getElementById('avatarModal').classList.remove('active');
}

function selectAvatar(emoji) {
  document.getElementById('profileAvatar').textContent = emoji;
  closeAvatarPicker();
}

// ===== QUIZ =====
// ===== GAMES HUB =====

async function loadGamesHub() {
  // Load game profile stats
  try {
    const res = await fetch('/api/games/profile');
    const gs = await res.json();
    const xpToNext = 500 - (gs.xp % 500);
    const xpPct = Math.round(((gs.xp % 500) / 500) * 100);
    document.getElementById('gameStatsRow').innerHTML = `
      <div class="home-stat-card stat-gold">
        <div class="stat-icon">⚡</div>
        <div class="stat-value">${gs.level}</div>
        <div class="stat-label">Level</div>
        <div class="stat-sub">${gs.xp % 500} / 500 XP</div>
        <div style="margin-top:8px;height:4px;background:var(--border);border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${xpPct}%;background:#E8B84B;border-radius:4px;transition:width 0.6s;"></div>
        </div>
      </div>
      <div class="home-stat-card stat-green">
        <div class="stat-icon">🎮</div>
        <div class="stat-value">${gs.total_games}</div>
        <div class="stat-label">Games Played</div>
        <div class="stat-sub">Keep playing!</div>
      </div>
      <div class="home-stat-card stat-orange">
        <div class="stat-icon">🔥</div>
        <div class="stat-value">${gs.current_streak}</div>
        <div class="stat-label">Day Streak</div>
        <div class="stat-sub">Best: ${gs.best_streak} days</div>
      </div>
      <div class="home-stat-card stat-blue">
        <div class="stat-icon">🏆</div>
        <div class="stat-value">${gs.quiz_wins + gs.poster_guesses}</div>
        <div class="stat-label">Total Wins</div>
        <div class="stat-sub">🗳️ ${gs.battle_votes} votes cast</div>
      </div>`;
    // Update game card meta
    const qs = document.getElementById('gcQuizStreak');
    const bv = document.getElementById('gcBattleVotes');
    const pg = document.getElementById('gcPosterGuesses');
    if (qs) qs.textContent = `🔥 Streak: ${gs.current_streak} day${gs.current_streak !== 1 ? 's' : ''}`;
    if (bv) bv.textContent = `🗳️ ${gs.battle_votes} battle${gs.battle_votes !== 1 ? 's' : ''} voted`;
    if (pg) pg.textContent = `🎯 ${gs.poster_guesses} poster${gs.poster_guesses !== 1 ? 's' : ''} guessed`;
  } catch(e) {}
}

function openGame(type) {
  document.getElementById('gamesHub').style.display = 'none';
  document.getElementById('gameQuiz').style.display = 'none';
  document.getElementById('gameBattle').style.display = 'none';
  document.getElementById('gamePoster').style.display = 'none';
  if (type === 'quiz') {
    document.getElementById('gameQuiz').style.display = 'block';
    quizCorrect = 0; quizWrong = 0;
    document.getElementById('quizCorrect').textContent = '0';
    document.getElementById('quizWrong').textContent = '0';
    loadQuiz();
  } else if (type === 'battle') {
    document.getElementById('gameBattle').style.display = 'block';
    loadBattle();
  } else if (type === 'poster') {
    document.getElementById('gamePoster').style.display = 'block';
    posterUsedTitles = [];
    loadPosterGame();
  }
}

function closeGame() {
  document.getElementById('gamesHub').style.display = 'block';
  document.getElementById('gameQuiz').style.display = 'none';
  document.getElementById('gameBattle').style.display = 'none';
  document.getElementById('gamePoster').style.display = 'none';
  loadGamesHub();
}

async function awardGameXP(xp, gameType) {
  try {
    const prevLevel = await fetch('/api/games/profile').then(r=>r.json()).then(g=>g.level).catch(()=>1);
    const res = await fetch('/api/games/xp', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ xp, gameType, won: true })
    });
    const data = await res.json();
    if (data.level > prevLevel) {
      showLevelUpToast(data.level);
    }
  } catch(e) {}
}

function showLevelUpToast(level) {
  const unlock = LEVEL_AVATARS.find(a => a.level === level);
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.3s ease;';
  overlay.innerHTML = `<div style="background:#1c2228;border:2px solid #E8B84B;border-radius:20px;padding:40px 48px;text-align:center;max-width:340px;animation:authCardIn 0.4s ease;">
    <div style="font-size:3em;margin-bottom:8px;">⚡</div>
    <div style="font-size:1.6em;font-weight:900;color:#E8B84B;margin-bottom:6px;">Level ${level}!</div>
    <div style="color:var(--text-dim);font-size:0.92em;margin-bottom:${unlock?'16px':'24px'};">You leveled up in Cinema Games!</div>
    ${unlock ? `<div style="background:#E8B84B18;border:1px solid #E8B84B44;border-radius:12px;padding:14px;margin-bottom:20px;">
      <div style="font-size:2.2em;margin-bottom:4px;">${unlock.emoji}</div>
      <div style="color:#E8B84B;font-weight:700;font-size:0.9em;">New avatar unlocked!</div>
      <div style="color:var(--text-muted);font-size:0.78em;margin-top:2px;">${unlock.label} · Available in your profile</div>
    </div>` : ''}
    <button onclick="this.closest('div[style*=fixed]').remove()" style="padding:10px 28px;background:#E8B84B;color:#000;border:none;border-radius:8px;font-weight:800;font-size:1em;cursor:pointer;font-family:inherit;">Awesome! 🎬</button>
  </div>`;
  document.body.appendChild(overlay);
}

// ===== MOVIE BATTLES =====
let battleData = null;

async function loadBattle() {
  const arena = document.getElementById('battleArena');
  arena.innerHTML = `<div class="home-loading">Loading matchup…</div>`;
  try {
    const res = await fetch('/api/games/battle');
    battleData = await res.json();
    renderBattle(battleData, false);
  } catch(e) {
    arena.innerHTML = `<div style="color:var(--text-muted);padding:20px;">Failed to load battle.</div>`;
  }
}

function renderBattle(data, voted, votedFor) {
  const arena = document.getElementById('battleArena');
  const { movieA, movieB } = data;
  if (!voted) {
    arena.innerHTML = `
      <div class="battle-vs-row">
        <div class="battle-card" onclick="castVote('${movieA.title.replace(/'/g,"\\'")}', '${movieB.title.replace(/'/g,"\\'")}', 'A')">
          <img src="${movieA.poster}" class="battle-poster" onerror="this.style.display='none'">
          <div class="battle-title">${movieA.title}</div>
          <div class="battle-meta">${movieA.year} · ⭐ ${movieA.rating}</div>
          <button class="battle-vote-btn">Vote</button>
        </div>
        <div class="battle-vs">VS</div>
        <div class="battle-card" onclick="castVote('${movieA.title.replace(/'/g,"\\'")}', '${movieB.title.replace(/'/g,"\\'")}', 'B')">
          <img src="${movieB.poster}" class="battle-poster" onerror="this.style.display='none'">
          <div class="battle-title">${movieB.title}</div>
          <div class="battle-meta">${movieB.year} · ⭐ ${movieB.rating}</div>
          <button class="battle-vote-btn">Vote</button>
        </div>
      </div>`;
  } else {
    const vA = data.votesA, vB = data.votesB, total = vA + vB || 1;
    const pctA = Math.round(vA/total*100), pctB = Math.round(vB/total*100);
    const winnerColor = vA > vB ? '#E8B84B' : vB > vA ? '#E8B84B' : 'var(--green)';
    arena.innerHTML = `
      <div class="battle-results">
        <div class="battle-result-row ${votedFor==='A'?'voted':''}">
          <img src="${movieA.poster}" class="battle-result-poster" onerror="this.style.display='none'">
          <div style="flex:1;">
            <div style="font-weight:700;color:var(--text);margin-bottom:6px;">${movieA.title} ${votedFor==='A'?'<span style="color:#E8B84B;">✓ Your vote</span>':''}</div>
            <div class="battle-bar-track"><div class="battle-bar-fill" style="width:${pctA}%;background:${vA>=vB?winnerColor:'var(--border)'}"></div></div>
          </div>
          <div class="battle-pct" style="color:${vA>=vB?winnerColor:'var(--text-dim)'}">${pctA}%</div>
        </div>
        <div class="battle-result-row ${votedFor==='B'?'voted':''}">
          <img src="${movieB.poster}" class="battle-result-poster" onerror="this.style.display='none'">
          <div style="flex:1;">
            <div style="font-weight:700;color:var(--text);margin-bottom:6px;">${movieB.title} ${votedFor==='B'?'<span style="color:#E8B84B;">✓ Your vote</span>':''}</div>
            <div class="battle-bar-track"><div class="battle-bar-fill" style="width:${pctB}%;background:${vB>=vA?winnerColor:'var(--border)'}"></div></div>
          </div>
          <div class="battle-pct" style="color:${vB>=vA?winnerColor:'var(--text-dim)'}">${pctB}%</div>
        </div>
        <div style="margin-top:8px;color:var(--text-muted);font-size:0.8em;">${total} vote${total!==1?'s':''} total</div>
        <button onclick="loadBattle()" style="margin-top:20px;padding:11px 32px;background:var(--green);color:#000;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-family:inherit;font-size:0.9em;">Next Battle ⚔️</button>
      </div>`;
  }
}

async function castVote(movieA, movieB, side) {
  try {
    const res = await fetch('/api/games/battle/vote', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ movieA, movieB, votedFor: side==='A'?movieA:movieB })
    });
    const data = await res.json();
    battleData.votesA = data.votesA;
    battleData.votesB = data.votesB;
    renderBattle(battleData, true, side);
    awardGameXP(25, 'battle');
  } catch(e) {}
}

// ===== GUESS THE POSTER =====
let posterData = null;
let posterHintsUsed = 0;
let posterBlurLevel = 20;
let posterAnswered = false;
let posterUsedTitles = [];

async function loadPosterGame() {
  const arena = document.getElementById('posterArena');
  arena.innerHTML = `<div class="home-loading">Loading poster…</div>`;
  posterHintsUsed = 0;
  posterBlurLevel = 20;
  posterAnswered = false;
  try {
    const params = posterUsedTitles.length ? '?exclude=' + encodeURIComponent(JSON.stringify(posterUsedTitles)) : '';
    const res = await fetch('/api/games/poster' + params);
    if (!res.ok) {
      const d = await res.json();
      arena.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center;">${d.error || 'Failed to load.'}</div>`;
      return;
    }
    posterData = await res.json();
    if (posterData.reset) posterUsedTitles = [];
    posterUsedTitles.push(posterData.answer);
    renderPosterGame();
  } catch(e) {
    arena.innerHTML = `<div style="color:var(--text-muted);padding:20px;">Failed to load poster.</div>`;
  }
}

function renderPosterGame() {
  const pts = [100, 75, 50, 25][posterHintsUsed] || 25;
  const hints = [
    { label: '📅 Year', value: posterData.year },
    { label: '🎭 Genre', value: posterData.genre },
    { label: '🎬 Lead Actor', value: posterData.lead }
  ];
  const revealedHints = hints.slice(0, posterHintsUsed).map(h =>
    `<div class="poster-hint-revealed">${h.label}: <strong>${h.value}</strong></div>`).join('');
  const nextHint = hints[posterHintsUsed];

  const blur = posterAnswered ? 0 : posterBlurLevel;
  document.getElementById('posterArena').innerHTML = `
    <div style="position:relative;display:inline-block;margin-bottom:20px;">
      <img src="${posterData.poster}" id="posterImg"
        style="width:220px;height:330px;object-fit:cover;border-radius:12px;filter:blur(${blur}px);transition:filter 0.5s;"
        onerror="this.style.display='none'">
      <div style="position:absolute;top:10px;right:10px;background:rgba(0,0,0,0.8);color:#E8B84B;font-weight:800;padding:5px 12px;border-radius:20px;font-size:0.85em;">${posterAnswered ? '✅' : pts + ' pts'}</div>
    </div>
    <div style="margin-bottom:16px;">${revealedHints}</div>
    ${!posterAnswered ? `
      <div style="display:flex;gap:10px;justify-content:center;margin-bottom:16px;flex-wrap:wrap;">
        ${nextHint && posterHintsUsed < 3 ? `<button onclick="useHint()" class="poster-hint-btn">💡 Hint: ${nextHint.label} (-${pts - ([100,75,50,25][posterHintsUsed+1]||0)} pts)</button>` : ''}
      </div>
      <div style="display:flex;gap:10px;justify-content:center;">
        <input id="posterGuessInput" type="text" placeholder="Type the movie title…"
          style="padding:11px 16px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:0.95em;width:260px;"
          onkeydown="if(event.key==='Enter')submitPosterGuess()">
        <button onclick="submitPosterGuess()" style="padding:11px 20px;background:var(--green);color:#000;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-family:inherit;">Guess</button>
      </div>
      <div id="posterFeedback" style="margin-top:14px;min-height:24px;font-weight:700;font-size:1em;"></div>
    ` : `
      <button onclick="loadPosterGame()" style="padding:11px 28px;background:var(--green);color:#000;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:8px;">Next Poster 🎬</button>
    `}`;
}

function useHint() {
  if (posterHintsUsed >= 3) return;
  posterHintsUsed++;
  posterBlurLevel = [20, 14, 8, 3][posterHintsUsed] || 3;
  renderPosterGame();
  // Animate blur reduction
  setTimeout(() => {
    const img = document.getElementById('posterImg');
    if (img) img.style.filter = `blur(${posterBlurLevel}px)`;
  }, 50);
}

function submitPosterGuess() {
  const input = document.getElementById('posterGuessInput');
  if (!input) return;
  const guess = input.value.trim().toLowerCase();
  const answer = posterData.answer.toLowerCase();
  const correct = guess === answer || answer.includes(guess) || guess.includes(answer.split(':')[0].trim());
  const pts = [100, 75, 50, 25][posterHintsUsed] || 25;
  const fb = document.getElementById('posterFeedback');
  if (correct) {
    awardGameXP(pts, 'poster');
    // Unblur then re-render with answered state (shows single Next button)
    setTimeout(() => {
      posterAnswered = true;
      renderPosterGame();
    }, 600);
  } else {
    fb.textContent = `❌ Not quite — try again!`;
    fb.style.color = 'var(--red)';
    input.value = '';
    input.focus();
  }
}

let quizCorrect = 0;
let quizWrong = 0;
let quizAnswer = null;
let quizAnswered = false;
let quizUsedTitles = [];

async function loadQuiz() {
  quizAnswered = false;
  document.getElementById('quizFeedback').textContent = '';
  document.getElementById('quizPlot').textContent = 'Loading...';
  document.getElementById('quizOptions').innerHTML = '';
  document.getElementById('quizNextBtn').style.display = 'none';

  try {
    const params = quizUsedTitles.length
      ? '?exclude=' + encodeURIComponent(JSON.stringify(quizUsedTitles))
      : '';
    const res = await fetch('/api/quiz' + params);
    if (!res.ok) {
      const d = await res.json();
      document.getElementById('quizPlot').textContent = d.error;
      document.getElementById('quizNextBtn').style.display = 'inline-block';
      return;
    }
    const data = await res.json();

    // If all movies used, reset and start over
    if (data.reset) {
      quizUsedTitles = [];
    }
    quizUsedTitles.push(data.answer);
    quizAnswer = data.answer;

    document.getElementById('quizPlot').textContent = data.plot;

    document.getElementById('quizOptions').innerHTML = data.options.map(opt => `
      <button onclick="answerQuiz('${opt.replace(/'/g, "\\'")}')"
        style="padding:14px 10px; background:var(--surface2); color:var(--text); border:1px solid var(--border);
               border-radius:6px; cursor:pointer; font-size:0.9em; font-family:inherit; font-weight:600;
               transition:all 0.2s; text-align:center;">
        ${opt}
      </button>
    `).join('');
  } catch (e) {
    document.getElementById('quizPlot').textContent = 'Failed to load quiz.';
    document.getElementById('quizNextBtn').style.display = 'inline-block';
  }
}

function answerQuiz(chosen) {
  if (quizAnswered) return;
  quizAnswered = true;

  const buttons = document.getElementById('quizOptions').querySelectorAll('button');
  buttons.forEach(btn => {
    btn.style.cursor = 'default';
    if (btn.textContent.trim() === quizAnswer) {
      btn.style.background = '#00e054';
      btn.style.color = '#000';
      btn.style.borderColor = '#00e054';
    } else if (btn.textContent.trim() === chosen && chosen !== quizAnswer) {
      btn.style.background = '#e84040';
      btn.style.color = '#fff';
      btn.style.borderColor = '#e84040';
    }
  });

  const feedback = document.getElementById('quizFeedback');
  if (chosen === quizAnswer) {
    quizCorrect++;
    feedback.innerHTML = `✅ Correct! <span style="color:#E8B84B;font-size:0.85em;">+50 XP</span>`;
    feedback.style.color = '#00e054';
    awardGameXP(50, 'quiz');
    fetch('/api/badges/quiz-correct', { method: 'POST' })
      .then(r => r.json()).then(d => handleNewBadges(d.newBadges)).catch(() => {});
  } else {
    quizWrong++;
    feedback.innerHTML = `❌ Wrong! It was <span style="color:#00e054;">${quizAnswer}</span>`;
    feedback.style.color = '#e84040';
  }

  document.getElementById('quizCorrect').textContent = quizCorrect;
  document.getElementById('quizWrong').textContent = quizWrong;
  document.getElementById('quizNextBtn').style.display = 'inline-block';
}

// ===== RECOMMENDATIONS =====
async function loadRecommendations(genre = 'top') {
  const container = document.getElementById('recommendedContainer');
  const subtitle = document.getElementById('recommendedSubtitle');

  // Update active filter button
  document.querySelectorAll('#recommendedSection .filter-btn').forEach(b => b.classList.remove('active'));
  if (event && event.target) event.target.classList.add('active');
  else { const topBtn = document.getElementById('rec-filter-top'); if (topBtn) topBtn.classList.add('active'); }

  container.innerHTML = `<div style="text-align:center; color:#aaa; padding:40px; width:100%;">Loading...</div>`;

  try {
    const url = genre === 'top' ? '/api/recommendations' : `/api/recommendations/${encodeURIComponent(genre)}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      subtitle.textContent = '';
      container.innerHTML = `<div class="empty-state"><h2>No recommendations found</h2><p>Try a different genre or add more movies to your list.</p></div>`;
      return;
    }

    subtitle.textContent = genre === 'top'
      ? `Top-rated ${data.genre} movies you haven't seen yet`
      : `Top-rated ${genre} movies you haven't seen yet`;

    container.innerHTML = data.results.map(movie => `
      <div class="movie-card">
        <div class="poster-container" onclick="openRecommendedDetails('${movie.title.replace(/'/g, "\\'")}', '${movie.poster}', '${genre}', '${movie.year}', '${movie.imdbRating}')">
          <img src="${movie.poster}" alt="${movie.title}" class="poster" onerror="this.src='https://via.placeholder.com/300x450?text=No+Poster'">
          <div class="play-button">▶</div>
        </div>
        <div class="movie-info">
          <h3>${movie.title}</h3>
          <p class="genre">${genre === 'top' ? data.genre : genre}</p>
          <p style="color:#ffd700; font-size:0.9em;">⭐ ${movie.imdbRating}</p>
          <p style="color:#aaa; font-size:0.85em;">${movie.year}</p>
          <div class="actions" style="margin-top:10px;">
            <button class="view-btn" onclick="openRecommendedDetails('${movie.title.replace(/'/g, "\\'")}', '${movie.poster}', '${genre}', '${movie.year}', '${movie.imdbRating}')">View</button>
            <button class="delete-btn" onclick="addRecommendedToWatchlist('${movie.title.replace(/'/g, "\\'")}')">+ Watchlist</button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><h2>Failed to load recommendations</h2></div>`;
  }
}

function openRecommendedDetails(title, poster, genre, year, imdbRating) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalPoster').src = poster;
  document.getElementById('modalGenre').textContent = genre || 'N/A';
  document.getElementById('modalDirector').textContent = 'N/A';
  document.getElementById('modalActor').textContent = 'N/A';
  document.getElementById('modalPlot').textContent = 'Loading...';
  document.getElementById('modalYear').textContent = year || 'N/A';
  document.getElementById('modalIMDbRating').textContent = imdbRating || 'N/A';
  document.getElementById('modalRuntime').textContent = 'N/A';
  document.getElementById('modalUserRating').innerHTML = `<div style="color:#aaa; font-style:italic;">Not watched yet</div>`;
  document.getElementById('modalUserNotes').innerHTML = '';

  const modalActions = document.querySelector('.modal-actions');
  modalActions.innerHTML = `
    <button class="edit-btn" onclick="closeModal(); addRecommendedToWatchlist('${title.replace(/'/g, "\\'")}')">+ Add to Watchlist</button>
  `;

  // Load trailer
  const trailerContainer = document.getElementById('trailerContainer');
  trailerContainer.innerHTML = `<div style="background:#0f1424; padding:40px; border-radius:10px; border:1px solid #00d9ff; text-align:center;"><p style="color:#aaa;">Loading trailer...</p></div>`;

  fetch(`/api/trailer/${encodeURIComponent(title)}`)
    .then(r => r.json())
    .then(data => {
      if (data.videoId) {
        trailerContainer.innerHTML = `<div class="video-container"><iframe src="https://www.youtube.com/embed/${data.videoId}" allowfullscreen></iframe></div>`;
      } else throw new Error();
    })
    .catch(() => {
      trailerContainer.innerHTML = `<div style="background:#0f1424; padding:50px 30px; border-radius:10px; border:1px solid #ff006e; text-align:center;"><h3 style="color:#ff006e;">🎬 Trailer Not Available</h3></div>`;
    });

  // Also fetch full OMDB details for plot/director/actors
  fetch(`/api/search/${encodeURIComponent(title)}`)
    .then(r => r.json())
    .then(() => {
      return fetch(`/api/movies-detail/${encodeURIComponent(title)}`);
    }).catch(() => {});

  document.getElementById('movieModal').classList.add('active');
}

async function addRecommendedToWatchlist(title) {
  try {
    const response = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movieName: title })
    });
    const data = await response.json();
    if (!response.ok) {
      showAlert('❌ ' + data.error);
    } else {
      showAlert('Added to Watch Later! ✅');
    }
  } catch (error) {
    showAlert('❌ Error adding to watchlist');
  }
}
// ===== FRIENDS =====
let userSearchTimeout;

async function searchUsers() {
  const q = document.getElementById('friendSearchInput').value.trim();
  const container = document.getElementById('userSearchResults');
  clearTimeout(userSearchTimeout);

  if (q.length < 2) { container.innerHTML = ''; return; }

  userSearchTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
      const users = await res.json();

      if (users.length === 0) {
        container.innerHTML = `<p style="color:var(--text-muted); font-size:0.9em;">No users found</p>`;
        return;
      }

      container.innerHTML = users.map(u => {
        let btn = '';
        if (u.friendStatus === 'accepted') {
          btn = `<span style="color:var(--green); font-size:0.85em; font-weight:700;">✅ Friends</span>`;
        } else if (u.friendStatus === 'pending' && u.direction === 'sent') {
          btn = `<span style="color:var(--text-muted); font-size:0.85em;">Requested</span>`;
        } else if (u.friendStatus === 'pending' && u.direction === 'received') {
          btn = `<span style="color:var(--text-muted); font-size:0.85em;">Sent you a request</span>`;
        } else {
          btn = `<button onclick="sendFriendRequest(${u.id}, this)"
            style="padding:6px 16px; background:var(--green); color:#000; border:none; border-radius:4px; cursor:pointer; font-weight:700; font-size:0.8em; font-family:inherit;">
            + Add Friend</button>`;
        }
        return `
          <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border);">
            <div style="display:flex; align-items:center; gap:12px;">
              <span style="font-size:1.8em;">${u.avatar || '🎬'}</span>
              <span style="color:var(--text); font-weight:600;">${u.username}</span>
            </div>
            ${btn}
          </div>`;
      }).join('');
    } catch (e) {
      container.innerHTML = `<p style="color:var(--red);">Search failed</p>`;
    }
  }, 300);
}

async function sendFriendRequest(userId, btn) {
  try {
    const res = await fetch(`/api/friends/request/${userId}`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      btn.outerHTML = `<span style="color:var(--text-muted); font-size:0.85em;">Requested</span>`;
    } else {
      showAlert('❌ ' + data.error);
    }
  } catch (e) {
    showAlert('❌ Failed to send request');
  }
}

async function loadPendingRequests() {
  try {
    const res = await fetch('/api/friends/requests');
    const requests = await res.json();

    // Update sidebar badge
    const badge = document.getElementById('friendRequestBadge');
    if (badge) {
      if (requests.length > 0) { badge.textContent = requests.length; badge.style.display = 'flex'; }
      else badge.style.display = 'none';
    }

    const card = document.getElementById('pendingRequestsCard');
    const list = document.getElementById('pendingRequestsList');

    if (requests.length === 0) {
      card.style.display = 'none';
      return;
    }

    card.style.display = 'block';
    list.innerHTML = requests.map(r => `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:12px;">
          <span style="font-size:1.8em;">${r.avatar || '🎬'}</span>
          <span style="color:var(--text); font-weight:600;">${r.username}</span>
        </div>
        <div style="display:flex; gap:8px;">
          <button onclick="respondToRequest(${r.id}, 'accept', this.closest('div').closest('div'))"
            style="padding:6px 14px; background:var(--green); color:#000; border:none; border-radius:4px; cursor:pointer; font-weight:700; font-size:0.8em; font-family:inherit;">Accept</button>
          <button onclick="respondToRequest(${r.id}, 'decline', this.closest('div').closest('div'))"
            style="padding:6px 14px; background:transparent; color:var(--red); border:1px solid var(--red); border-radius:4px; cursor:pointer; font-weight:700; font-size:0.8em; font-family:inherit;">Decline</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error('Failed to load requests', e);
  }
}

async function respondToRequest(requestId, action, rowEl) {
  try {
    const res = await fetch(`/api/friends/request/${requestId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    handleNewBadges(data.newBadges);
    rowEl.remove();
    loadFriends();
    loadPendingRequests();
  } catch (e) {
    showAlert('❌ Failed');
  }
}

async function loadFriends() {
  try {
    const res = await fetch('/api/friends');
    const friends = await res.json();
    const list = document.getElementById('friendsList');

    if (friends.length === 0) {
      list.innerHTML = `<p style="color:var(--text-muted); font-size:0.9em; text-align:center; padding:20px 0;">No friends yet — search for someone above! 👆</p>`;
      return;
    }

    list.innerHTML = friends.map(f => `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:12px 0; border-bottom:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:14px;">
          <span style="font-size:2em;">${f.avatar || '🎬'}</span>
          <div>
            <div style="color:var(--text); font-weight:700;">${f.username}</div>
            <div style="color:var(--text-muted); font-size:0.8em;">${f.movie_count} movies watched</div>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button onclick="viewFriendProfile(${f.id}, '${f.username}')"
            style="padding:7px 14px; background:var(--surface2); color:var(--text); border:1px solid var(--border); border-radius:4px; cursor:pointer; font-weight:600; font-size:0.82em; font-family:inherit; transition:all 0.2s;"
            onmouseover="this.style.borderColor='var(--green)';this.style.color='var(--green)'"
            onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text)'">👤 Profile</button>
          <button onclick="viewFriendMovies(${f.id}, '${f.username}', '${f.avatar || '🎬'}')"
            style="padding:7px 14px; background:var(--surface2); color:var(--text); border:1px solid var(--border); border-radius:4px; cursor:pointer; font-weight:600; font-size:0.82em; font-family:inherit; transition:all 0.2s;"
            onmouseover="this.style.borderColor='var(--green)';this.style.color='var(--green)'"
            onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text)'">🎬 Movies</button>
          <button onclick="removeFriend(${f.id}, '${f.username}')"
            style="padding:7px 10px; background:transparent; color:var(--text-muted); border:1px solid var(--border); border-radius:4px; cursor:pointer; font-size:0.82em; font-family:inherit;"
            onmouseover="this.style.borderColor='var(--red)';this.style.color='var(--red)'"
            onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">Remove</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error('Failed to load friends', e);
  }
}

async function viewFriendMovies(friendId, username, avatar) {
  document.getElementById('friendMoviesTitle').textContent = `${avatar} ${username}'s Movies`;
  const container = document.getElementById('friendMoviesContainer');
  container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">Loading...</div>`;
  document.getElementById('friendMoviesModal').classList.add('active');

  try {
    const res = await fetch(`/api/friends/${friendId}/movies`);
    const movies = await res.json();

    if (movies.length === 0) {
      container.innerHTML = `<div class="empty-state"><h2>${username} hasn't added any movies yet</h2></div>`;
      return;
    }

    container.innerHTML = movies.map(movie => `
      <div class="movie-card">
        <div class="poster-container" onclick="openFriendMovieDetails('${movie.title.replace(/'/g,"\\'")}', '${(movie.posterUrl||'').replace(/'/g,"\\'")}', '${(movie.genres||'').replace(/'/g,"\\'")}', '${movie.year||''}', '${movie.imdbRating||''}', '${movie.director||''}', '${(movie.mainCharacter||'').replace(/'/g,"\\'")}', '${movie.runtime||''}')">
          <img src="${movie.posterUrl}" alt="${movie.title}" class="poster">
          <div class="play-button">▶</div>
        </div>
        <div class="movie-info">
          <h3>${movie.title}</h3>
          <p class="genre">${movie.genres || ''}</p>
          <div class="rating">
            <span class="stars">${'⭐'.repeat(movie.rating || 0)}</span>
            <span class="rating-number">${movie.rating || '?'}/5</span>
          </div>
          <div class="actions" style="margin-top:8px;">
            <button class="view-btn" onclick="openFriendMovieDetails('${movie.title.replace(/'/g,"\\'")}', '${(movie.posterUrl||'').replace(/'/g,"\\'")}', '${(movie.genres||'').replace(/'/g,"\\'")}', '${movie.year||''}', '${movie.imdbRating||''}', '${movie.director||''}', '${(movie.mainCharacter||'').replace(/'/g,"\\'")}', '${movie.runtime||''}')">▶ Trailer</button>
            <button class="delete-btn" style="background:var(--green);color:#000;border-color:var(--green);" onclick="addFriendMovieToWatchlist('${movie.title.replace(/'/g,"\\'")}')">+ Watchlist</button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><h2>Failed to load movies</h2></div>`;
  }
}

function openFriendMovieDetails(title, poster, genre, year, imdbRating, director, actor, runtime) {
  // Close friend movies modal and open the main movie modal with trailer
  document.getElementById('friendMoviesModal').classList.remove('active');

  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalPoster').src = poster;
  document.getElementById('modalGenre').textContent = genre || 'N/A';
  document.getElementById('modalDirector').textContent = director || 'N/A';
  document.getElementById('modalActor').textContent = actor || 'N/A';
  document.getElementById('modalYear').textContent = year || 'N/A';
  document.getElementById('modalIMDbRating').textContent = imdbRating || 'N/A';
  document.getElementById('modalRuntime').textContent = runtime || 'N/A';
  document.getElementById('modalPlot').textContent = 'Loading...';
  document.getElementById('modalUserRating').innerHTML = '';
  document.getElementById('modalUserNotes').innerHTML = '';

  const modalActions = document.querySelector('.modal-actions');
  modalActions.innerHTML = `
    <button class="edit-btn" onclick="closeModal(); addFriendMovieToWatchlist('${title.replace(/'/g,"\\'")}')">+ Add to Watchlist</button>
  `;

  const trailerContainer = document.getElementById('trailerContainer');
  trailerContainer.innerHTML = `<div style="background:var(--surface); padding:40px; border-radius:6px; border:1px solid var(--border); text-align:center;"><p style="color:var(--text-muted);">Loading trailer...</p></div>`;

  fetch(`/api/trailer/${encodeURIComponent(title)}`)
    .then(r => r.json())
    .then(data => {
      if (data.videoId) {
        trailerContainer.innerHTML = `<div class="video-container"><iframe src="https://www.youtube.com/embed/${data.videoId}" allowfullscreen></iframe></div>`;
      } else throw new Error();
    })
    .catch(() => {
      trailerContainer.innerHTML = `<div style="background:var(--surface); padding:50px 30px; border-radius:6px; border:1px solid var(--border); text-align:center;"><h3 style="color:var(--text-muted);">🎬 Trailer Not Available</h3></div>`;
    });

  document.getElementById('movieModal').classList.add('active');
}

async function addFriendMovieToWatchlist(title) {
  try {
    const res = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movieName: title })
    });
    const data = await res.json();
    if (res.ok) showAlert(`✅ "${title}" added to your Watch Later!`);
    else showAlert('❌ ' + data.error);
  } catch(e) {
    showAlert('❌ Failed to add to watchlist');
  }
}

function closeFriendMovies() {
  document.getElementById('friendMoviesModal').classList.remove('active');
}

async function removeFriend(friendId, username) {
  showConfirm(`Remove ${username} from your friends?`, async (confirmed) => {
    if (!confirmed) return;
    await fetch(`/api/friends/${friendId}`, { method: 'DELETE' });
    loadFriends();
  });
}

window.addEventListener('click', function(event) {
  const fm = document.getElementById('friendMoviesModal');
  if (fm && event.target === fm) closeFriendMovies();
});

// ===== CHAT =====
let chatLastId = 0;
let chatPollInterval = null;
let chatMyUserId = null;

async function initChat() {
  chatMyUserId = currentUserId;
  const container = document.getElementById('chatMessages');
  container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:20px;">Loading messages...</div>`;

  try {
    const res = await fetch('/api/chat');
    const messages = await res.json();
    container.innerHTML = '';
    messages.forEach(m => appendChatMessage(m, false));
    if (messages.length > 0) chatLastId = messages[messages.length - 1].id;
    scrollChatToBottom();
  } catch (e) {
    container.innerHTML = `<div style="text-align:center; color:var(--red);">Failed to load chat</div>`;
  }

  // Poll for new messages every 3 seconds
  chatPollInterval = setInterval(pollChat, 3000);
}

async function pollChat() {
  try {
    const res = await fetch(`/api/chat/since/${chatLastId}`);
    const messages = await res.json();
    if (messages.length > 0) {
      messages.forEach(m => appendChatMessage(m, true));
      chatLastId = messages[messages.length - 1].id;
    }
  } catch (e) {}
}

function stopChatPolling() {
  if (chatPollInterval) {
    clearInterval(chatPollInterval);
    chatPollInterval = null;
  }
}

function appendChatMessage(msg, scroll) {
  const container = document.getElementById('chatMessages');
  const isMe = parseInt(msg.user_id) === parseInt(chatMyUserId);
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Parse attached movie if any
  let movie = null;
  if (msg.movie_data) {
    try { movie = typeof msg.movie_data === 'string' ? JSON.parse(msg.movie_data) : msg.movie_data; } catch(e) {}
  }

  // Build movie card HTML
  let movieCardHtml = '';
  if (movie) {
    movieCardHtml = `
      <div style="
        display:flex; gap:10px; align-items:flex-start;
        background:${isMe ? 'rgba(0,0,0,0.15)' : 'var(--surface)'};
        border-radius:8px; padding:10px; margin-top:${msg.message ? '8px' : '0'};
        border:1px solid ${isMe ? 'rgba(0,0,0,0.2)' : 'var(--border)'};
        max-width:260px;
      ">
        ${movie.poster ? `<img src="${movie.poster}" style="width:44px; height:64px; object-fit:cover; border-radius:4px; flex-shrink:0;" onerror="this.style.display='none'">` : ''}
        <div style="min-width:0;">
          <div style="font-weight:800; font-size:0.88em; color:${isMe ? '#000' : 'var(--text)'}; margin-bottom:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(movie.title || '')}</div>
          ${movie.year ? `<div style="font-size:0.75em; color:${isMe ? 'rgba(0,0,0,0.6)' : 'var(--text-muted)'};">${movie.year}</div>` : ''}
          ${movie.genre ? `<div style="font-size:0.72em; color:${isMe ? 'rgba(0,0,0,0.55)' : 'var(--text-muted)'}; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(movie.genre)}</div>` : ''}
          ${movie.imdbRating ? `<div style="font-size:0.75em; color:${isMe ? '#333' : '#f0b429'}; margin-top:4px; font-weight:700;">⭐ ${movie.imdbRating}</div>` : ''}
          ${movie.rating ? `<div style="font-size:0.75em; margin-top:2px;">${'⭐'.repeat(movie.rating)} <span style="color:${isMe ? 'rgba(0,0,0,0.6)' : 'var(--text-muted)'};">My rating</span></div>` : ''}
        </div>
      </div>`;
  }

  const div = document.createElement('div');
  div.style.cssText = `display:flex; flex-direction:column; align-items:${isMe ? 'flex-end' : 'flex-start'};`;
  div.innerHTML = `
    <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px; ${isMe ? 'flex-direction:row-reverse;' : ''}">
      <span style="font-size:1.3em;">${msg.avatar || '🎬'}</span>
      <span style="color:var(--text-muted); font-size:0.75em; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">${isMe ? 'You' : msg.username}</span>
      <span style="color:var(--text-muted); font-size:0.7em;">${time}</span>
    </div>
    <div style="
      max-width:75%;
      padding:${msg.message ? '10px 14px' : '10px'};
      border-radius:${isMe ? '14px 14px 4px 14px' : '14px 14px 14px 4px'};
      background:${isMe ? 'var(--green)' : 'var(--surface2)'};
      color:${isMe ? '#000' : 'var(--text)'};
      font-size:0.95em;
      line-height:1.5;
      word-break:break-word;
    ">${msg.message ? escapeHtml(msg.message) : ''}${movieCardHtml}</div>
  `;
  container.appendChild(div);
  if (scroll) scrollChatToBottom();
}

function scrollChatToBottom() {
  const c = document.getElementById('chatMessages');
  if (c) c.scrollTop = c.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message && !chatAttachedMovie) return;

  const movieData = chatAttachedMovie;
  input.value = '';
  clearChatMovie();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, movie_data: movieData || undefined })
    });
    const msg = await res.json();
    if (res.ok) {
      appendChatMessage(msg, true);
      chatLastId = msg.id;
      handleNewBadges(msg.newBadges);
    }
  } catch (e) {
    showAlert('❌ Failed to send message');
  }
}

// ===== CHAT MOVIE ATTACHMENT =====
let chatAttachedMovie = null;
let pickerSearchTimeout;

function openMoviePicker() {
  document.getElementById('moviePickerModal').classList.add('active');
  // Populate with user's movies
  const list = document.getElementById('pickerMyMovies');
  list.innerHTML = allMovies.map(m => `
    <div onclick="attachMovie(${JSON.stringify(JSON.stringify({
      title: m.title, poster: m.posterUrl, year: m.year,
      genre: m.genres, rating: m.rating, imdbRating: m.imdbRating
    }))})" style="display:flex; align-items:center; gap:12px; padding:8px 10px; border-radius:6px; background:var(--surface2); cursor:pointer; border:1px solid transparent; transition:all 0.15s;"
      onmouseover="this.style.borderColor='var(--green)'"
      onmouseout="this.style.borderColor='transparent'">
      <img src="${m.posterUrl}" style="width:32px; height:46px; object-fit:cover; border-radius:3px;" onerror="this.style.display='none'">
      <div>
        <div style="color:var(--text); font-weight:600; font-size:0.9em;">${m.title}</div>
        <div style="color:var(--text-muted); font-size:0.78em;">${m.year || ''} · ${'⭐'.repeat(m.rating || 0)}</div>
      </div>
    </div>
  `).join('') || `<p style="color:var(--text-muted); font-size:0.9em;">No movies in your list yet</p>`;
}

function closeMoviePicker() {
  document.getElementById('moviePickerModal').classList.remove('active');
  document.getElementById('pickerSearchInput').value = '';
  document.getElementById('pickerSuggestions').classList.remove('active');
}

function searchMoviePicker() {
  const q = document.getElementById('pickerSearchInput').value.trim();
  const box = document.getElementById('pickerSuggestions');
  clearTimeout(pickerSearchTimeout);
  if (q.length < 2) { box.classList.remove('active'); return; }

  pickerSearchTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search/${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data.results || data.results.length === 0) {
        box.innerHTML = '<div class="suggestion-empty">No results</div>';
        box.classList.add('active');
        return;
      }
      box.innerHTML = data.results.map(m => `
        <div class="suggestion-item" onclick="attachMovieFromSearch('${m.title.replace(/'/g,"\\'")}', '${(m.poster||'').replace(/'/g,"\\'")}', '${m.year||''}')">
          <img src="${m.poster||''}" alt="" class="suggestion-poster" onerror="this.style.display='none'">
          <div class="suggestion-info">
            <div class="suggestion-title">${m.title}</div>
            <div class="suggestion-year">${m.year}</div>
          </div>
        </div>
      `).join('');
      box.classList.add('active');
    } catch(e) {}
  }, 300);
}

async function attachMovieFromSearch(title, poster, year) {
  attachMovie(JSON.stringify({ title, poster, year, genre: '', rating: null, imdbRating: null }));
}

function attachMovie(movieJsonStr) {
  const movie = JSON.parse(movieJsonStr);
  chatAttachedMovie = movie;
  document.getElementById('chatPreviewPoster').src = movie.poster || '';
  document.getElementById('chatPreviewTitle').textContent = movie.title;
  document.getElementById('chatPreviewInfo').textContent =
    [movie.year, movie.genre, movie.imdbRating ? `IMDb ${movie.imdbRating}` : null].filter(Boolean).join(' · ');
  document.getElementById('chatMoviePreview').style.display = 'flex';
  closeMoviePicker();
}

function clearChatMovie() {
  chatAttachedMovie = null;
  document.getElementById('chatMoviePreview').style.display = 'none';
  document.getElementById('chatPreviewPoster').src = '';
}

window.addEventListener('click', function(e) {
  const mp = document.getElementById('moviePickerModal');
  if (mp && e.target === mp) closeMoviePicker();
});

// ===== ADMIN =====
async function loadAdminUsers() {
  const list = document.getElementById('adminUsersList');
  list.innerHTML = `<p style="color:var(--text-muted);">Loading...</p>`;
  try {
    const res = await fetch('/api/admin/users');
    const users = await res.json();
    if (!res.ok) { list.innerHTML = `<p style="color:var(--red);">Access denied</p>`; return; }

    list.innerHTML = users.map(u => `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border); gap:10px;">
        <div style="display:flex; align-items:center; gap:12px; min-width:0;">
          <span style="font-size:1.6em; flex-shrink:0;">${u.avatar || '🎬'}</span>
          <div style="min-width:0;">
            <div style="color:${u.is_banned ? '#e84040' : 'var(--text)'}; font-weight:700; font-size:0.9em;">
              ${u.username} ${u.is_banned ? '<span style="color:#e84040; font-size:0.75em;">[BANNED]</span>' : ''}
            </div>
            <div style="color:var(--text-muted); font-size:0.75em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${u.email}</div>
            <div style="color:var(--text-muted); font-size:0.72em;">${u.movie_count} movies · joined ${new Date(u.created_at).toLocaleDateString()}</div>
          </div>
        </div>
        ${u.email !== 'ragraguiriyad@gmail.com' ? `
        <button onclick="toggleBan(${u.id}, ${!u.is_banned}, this)"
          style="flex-shrink:0; padding:6px 14px; background:transparent; color:${u.is_banned ? 'var(--green)' : '#e84040'}; border:1px solid ${u.is_banned ? 'var(--green)' : '#e84040'}; border-radius:4px; cursor:pointer; font-weight:700; font-size:0.78em; font-family:inherit; white-space:nowrap;">
          ${u.is_banned ? '✅ Unban' : '🚫 Ban'}
        </button>` : '<span style="color:var(--text-muted); font-size:0.75em;">You</span>'}
      </div>
    `).join('');
  } catch(e) {
    list.innerHTML = `<p style="color:var(--red);">Failed to load users</p>`;
  }
}

async function toggleBan(userId, ban, btn) {
  const action = ban ? 'Ban' : 'Unban';
  showConfirm(`${action} this user?`, async (confirmed) => {
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}/ban`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ban })
      });
      if (res.ok) {
        showAlert(`✅ User ${action.toLowerCase()}ned successfully`);
        loadAdminUsers();
      }
    } catch(e) {
      showAlert('❌ Failed');
    }
  });
}

async function loadAdminChat() {
  const list = document.getElementById('adminChatList');
  list.innerHTML = `<p style="color:var(--text-muted);">Loading...</p>`;
  try {
    const res = await fetch('/api/chat');
    const messages = await res.json();

    if (messages.length === 0) {
      list.innerHTML = `<p style="color:var(--text-muted); font-size:0.9em;">No messages yet</p>`;
      return;
    }

    list.innerHTML = [...messages].reverse().map(m => {
      const time = new Date(m.created_at).toLocaleString();
      const movie = m.movie_data ? (() => { try { return JSON.parse(m.movie_data); } catch(e) { return null; } })() : null;
      return `
        <div style="display:flex; align-items:flex-start; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border); gap:12px;">
          <div style="display:flex; align-items:flex-start; gap:10px; min-width:0; flex:1;">
            <span style="font-size:1.4em; flex-shrink:0;">${m.avatar || '🎬'}</span>
            <div style="min-width:0;">
              <span style="color:var(--green); font-weight:700; font-size:0.85em;">${m.username}</span>
              <span style="color:var(--text-muted); font-size:0.72em; margin-left:8px;">${time}</span>
              ${m.message ? `<div style="color:var(--text); font-size:0.9em; margin-top:2px; word-break:break-word;">${escapeHtml(m.message)}</div>` : ''}
              ${movie ? `<div style="color:var(--text-muted); font-size:0.78em; margin-top:2px;">🎬 ${escapeHtml(movie.title || '')}</div>` : ''}
            </div>
          </div>
          <button onclick="deleteAdminMessage(${m.id}, this)"
            style="flex-shrink:0; padding:5px 10px; background:transparent; color:#e84040; border:1px solid #e84040; border-radius:4px; cursor:pointer; font-size:0.75em; font-family:inherit;">
            🗑 Delete
          </button>
        </div>`;
    }).join('');
  } catch(e) {
    list.innerHTML = `<p style="color:var(--red);">Failed to load messages</p>`;
  }
}

async function deleteAdminMessage(msgId, btn) {
  showConfirm('Delete this message from the chat?', async (confirmed) => {
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/admin/chat/${msgId}`, { method: 'DELETE' });
      if (res.ok) {
        btn.closest('div[style*="border-bottom"]').remove();
      }
    } catch(e) {
      showAlert('❌ Failed to delete message');
    }
  });
}

// ===== FRIEND PROFILE =====
async function viewFriendProfile(friendId, username) {
  document.getElementById('friendProfileTitle').textContent = `${username}'s Profile`;
  document.getElementById('friendProfileModal').classList.add('active');

  // Reset
  document.getElementById('fpAvatar').textContent = '⏳';
  document.getElementById('fpUsername').textContent = username;
  document.getElementById('fpJoinDate').textContent = '';
  document.getElementById('fpBio').textContent = '';
  document.getElementById('fpBioBox').style.display = 'none';
  document.getElementById('fpMovies').textContent = '...';
  document.getElementById('fpAvgRating').textContent = '...';
  document.getElementById('fpWatchlist').textContent = '...';
  document.getElementById('fpTopRated').textContent = '...';
  document.getElementById('fpRecentMovies').innerHTML = '';

  try {
    const res = await fetch(`/api/friends/${friendId}/profile`);
    const d = await res.json();
    if (!res.ok) { showAlert('❌ ' + d.error); closeFriendProfile(); return; }

    document.getElementById('fpAvatar').textContent = d.avatar;
    document.getElementById('fpUsername').textContent = d.username;
    document.getElementById('fpJoinDate').textContent = `Member since ${new Date(d.joinDate).toLocaleDateString('en-US', { year:'numeric', month:'long' })}`;

    if (d.bio) {
      document.getElementById('fpBio').textContent = d.bio;
      document.getElementById('fpBioBox').style.display = 'block';
    }

    document.getElementById('fpMovies').textContent = d.totalMovies;
    document.getElementById('fpAvgRating').textContent = d.avgRating;
    document.getElementById('fpWatchlist').textContent = d.watchlistCount;
    document.getElementById('fpTopRated').textContent = d.topRatedCount;

    // Recent movies posters
    const recentEl = document.getElementById('fpRecentMovies');
    if (d.recentMovies.length === 0) {
      recentEl.innerHTML = `<p style="color:var(--text-muted); font-size:0.85em;">No movies yet</p>`;
    } else {
      recentEl.innerHTML = d.recentMovies.map(m => `
        <div style="text-align:center;">
          <img src="${m.posterUrl}" alt="${m.title}"
            style="width:58px; height:84px; object-fit:cover; border-radius:4px; border:2px solid var(--border);"
            onerror="this.style.display='none'" title="${m.title}">
          <div style="font-size:0.7em; color:var(--text-muted); margin-top:4px;">${'⭐'.repeat(m.rating||0)}</div>
        </div>
      `).join('');
    }

    // Wire up "View All Movies" button
    document.getElementById('fpViewMoviesBtn').onclick = () => {
      closeFriendProfile();
      viewFriendMovies(friendId, d.username, d.avatar);
    };

  } catch(e) {
    showAlert('❌ Failed to load profile');
    closeFriendProfile();
  }
}

function closeFriendProfile() {
  document.getElementById('friendProfileModal').classList.remove('active');
}

window.addEventListener('click', function(e) {
  const fp = document.getElementById('friendProfileModal');
  if (fp && e.target === fp) closeFriendProfile();
});
