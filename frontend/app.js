// FILE: frontend/app.js
// Replace the existing file at this path with this one.
// ===================================================================
// Relay frontend — API_ORIGIN below points at wherever the backend is
// hosted. Leave it as '' if frontend+backend are served by the SAME app
// (e.g. Express serving both, as in backend/src/server.js). Set it to the
// backend's full URL if they're deployed as two separate services (e.g.
// two separate Render services, or Netlify/Vercel frontend + Render API).
// ===================================================================

const API_ORIGIN = 'https://crm-system-inhouse-backend.onrender.com';
const API_BASE = API_ORIGIN + '/api/v1';

const state = {
  accessToken: localStorage.getItem('relay_access_token') || null,
  refreshToken: localStorage.getItem('relay_refresh_token') || null,
  me: null,
  socket: null,
  conversations: [],
  activeConversationId: null,
  orgUsers: [], // cached for the "New DM" / "New group" pickers — reset on every enterApp() so a Super Admin org switch never leaks the previous tenant's list
};

// ------------------------- API helper with auto-refresh -------------------------

async function api(path, { method = 'GET', body, isRetry = false } = {}) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.accessToken ? { Authorization: `Bearer ${state.accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && state.refreshToken && !isRetry) {
    const refreshed = await tryRefreshToken();
    if (refreshed) return api(path, { method, body, isRetry: true });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function tryRefreshToken() {
  try {
    const res = await fetch(API_BASE + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: state.refreshToken }),
    });
    if (!res.ok) return false;
    const { data } = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

function setTokens(accessToken, refreshToken) {
  state.accessToken = accessToken;
  state.refreshToken = refreshToken;
  localStorage.setItem('relay_access_token', accessToken);
  localStorage.setItem('relay_refresh_token', refreshToken);
}

function clearTokens() {
  state.accessToken = null;
  state.refreshToken = null;
  localStorage.removeItem('relay_access_token');
  localStorage.removeItem('relay_refresh_token');
}

// ------------------------- Screens -------------------------

const setupScreen = document.getElementById('setupScreen');
const authScreen = document.getElementById('authScreen');
const buSelectScreen = document.getElementById('buSelectScreen');
const buCreateModal = document.getElementById('buCreateModal');
const appShell = document.getElementById('appShell');
const orgSwitchScreen = document.getElementById('orgSwitchScreen');

function showScreen(name) {
  setupScreen.classList.toggle('hidden', name !== 'setup');
  authScreen.classList.toggle('hidden', name !== 'auth');
  buSelectScreen.classList.toggle('hidden', name !== 'buSelect');
  appShell.classList.toggle('hidden', name !== 'app');
  if (name !== 'app') orgSwitchScreen.classList.add('hidden');
}

document.getElementById('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('setupError');
  errEl.textContent = '';
  try {
    const displayName = document.getElementById('setupDisplayName').value.trim();
    const email = document.getElementById('setupEmail').value.trim();
    const password = document.getElementById('setupPassword').value;
    const { data } = await api('/setup/super-admin', { method: 'POST', body: { displayName, email, password } });
    setTokens(data.accessToken, data.refreshToken);
    await afterAuth();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('loginForm').classList.toggle('hidden', tab !== 'login');
    document.getElementById('registerForm').classList.toggle('hidden', tab !== 'register');
  });
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const { data } = await api('/auth/login', { method: 'POST', body: { email, password } });
    setTokens(data.accessToken, data.refreshToken);
    await afterAuth();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('registerError');
  errEl.textContent = '';
  try {
    const orgName = document.getElementById('regOrgName').value.trim();
    const ownerDisplayName = document.getElementById('regDisplayName').value.trim();
    const ownerEmail = document.getElementById('regEmail').value.trim();
    const ownerPassword = document.getElementById('regPassword').value;
    const { data } = await api('/auth/register-organization', {
      method: 'POST',
      body: { orgName, ownerDisplayName, ownerEmail, ownerPassword },
    });
    setTokens(data.accessToken, data.refreshToken);
    await afterAuth();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  clearTokens();
  if (state.socket) state.socket.disconnect();
  // IMPORTANT: don't location.reload() — that re-requests whatever deep path
  // you were on (e.g. /settings, /accounts). Render's static site (and most
  // static hosts) only serve index.html for paths that don't match a real
  // file, and 404 on a hard reload/refetch of a client-side route. Always
  // send the browser to the real root path on logout instead.
  window.location.href = '/';
});

// ------------------------- Organization switching ("Who's working?") -------------------------
// Runs right after login/register/setup, BEFORE the main app shell. Not another login step —
// the user is already authenticated; this only resolves which BUSINESS UNIT (the JioHotstar-style
// "workspace") they land in. This is distinct from the Super-Admin "Switch Account" page further
// below, which switches which TENANT ORGANIZATION a Super Admin is viewing.
// See backend/src/routes/v1/businessUnits.js.

const buTileGrid = document.getElementById('buTileGrid');
const buSelectError = document.getElementById('buSelectError');
const buCreateBtn = document.getElementById('buCreateBtn');

async function afterAuth() {
  let units = [];
  try {
    const { data } = await api('/business-units');
    units = data || [];
  } catch {
    // Super Admin (or any account with no tenant) has no business units — just proceed.
    return enterApp();
  }

  if (units.length === 0) return enterApp(); // nothing to choose from yet (shouldn't normally happen post-signup)
  if (units.length === 1) return selectBusinessUnit(units[0].id); // only one workspace — skip the picker entirely

  renderBuTiles(units);
  buCreateBtn.classList.remove('hidden');
  showScreen('buSelect');
}

function renderBuTiles(units) {
  buSelectError.textContent = '';
  buTileGrid.innerHTML = units.map((u) => `
    <button class="bu-tile" data-bu-id="${u.id}">
      <div class="bu-tile-avatar">${escapeHtml((u.name || '?').slice(0, 1).toUpperCase())}</div>
      ${escapeHtml(u.name)}
    </button>
  `).join('');
  buTileGrid.querySelectorAll('.bu-tile').forEach((btn) => {
    btn.addEventListener('click', () => selectBusinessUnit(btn.dataset.buId));
  });
}

async function selectBusinessUnit(businessUnitId) {
  try {
    const { data } = await api('/business-units/switch', { method: 'POST', body: { businessUnitId } });
    setTokens(data.accessToken, data.refreshToken);
    await enterApp();
  } catch (err) {
    buSelectError.textContent = err.message;
  }
}

document.getElementById('buCreateCancel').addEventListener('click', () => buCreateModal.classList.add('hidden'));
buCreateBtn.addEventListener('click', () => buCreateModal.classList.remove('hidden'));

document.getElementById('buCreateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('buCreateError');
  errEl.textContent = '';
  try {
    const name = document.getElementById('buCreateName').value.trim();
    const code = document.getElementById('buCreateCode').value.trim();
    const { data: bu } = await api('/business-units', { method: 'POST', body: { name, code: code || undefined } });
    buCreateModal.classList.add('hidden');
    document.getElementById('buCreateForm').reset();
    await selectBusinessUnit(bu.id); // jump straight into the new workspace
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// ------------------------- Header switcher: "Rupesh / Acme India ▾" (tenant users) -------------------------

const buSwitcherBtn = document.getElementById('buSwitcherBtn');
const buSwitcherMenu = document.getElementById('buSwitcherMenu');

async function refreshBuSwitcher() {
  let units = [];
  try {
    const { data } = await api('/business-units');
    units = data || [];
  } catch { /* Super Admin / no tenant — leave the switcher hidden */ }

  if (units.length === 0) {
    buSwitcherBtn.classList.add('hidden');
    return;
  }

  const active = units.find((u) => u.active) || units[0];
  document.getElementById('buSwitcherLabel').textContent = active.name;
  buSwitcherBtn.classList.remove('hidden');

  buSwitcherMenu.innerHTML = units.map((u) => `
    <div class="bu-menu-item ${u.active ? 'active' : ''}" data-bu-id="${u.id}">
      ${escapeHtml(u.name)} ${u.active ? '✓' : ''}
    </div>
  `).join('') + `
    <div class="bu-menu-divider"></div>
    <div class="bu-menu-item bu-menu-create" id="buSwitcherCreate">＋ Create workspace</div>
  `;

  buSwitcherMenu.querySelectorAll('.bu-menu-item[data-bu-id]').forEach((item) => {
    item.addEventListener('click', async () => {
      buSwitcherMenu.classList.add('hidden');
      if (item.dataset.buId === active.id) return; // already there
      await selectBusinessUnit(item.dataset.buId); // re-enters the app in the new context
    });
  });
  document.getElementById('buSwitcherCreate').addEventListener('click', () => {
    buSwitcherMenu.classList.add('hidden');
    buCreateModal.classList.remove('hidden');
  });
}

buSwitcherBtn.addEventListener('click', () => buSwitcherMenu.classList.toggle('hidden'));
document.addEventListener('click', (e) => {
  if (!document.getElementById('buSwitcher').contains(e.target)) buSwitcherMenu.classList.add('hidden');
});

// ------------------------- Super Admin — account switching page -------------------------
// Only visible/reachable for me.isSuperAdmin. Lets a Super Admin step into any tenant's data
// context (without impersonating any individual user in it) via POST /organizations/:id/switch-context,
// and step back out via POST /organizations/exit-context. See backend/src/routes/v1/organizations.js.

const switchOrgBtn = document.getElementById('switchOrgBtn');
const actingBanner = document.getElementById('actingBanner');
let orgSwitchCache = [];
let lastViewBeforeSwitch = 'dashboard';

async function openOrgSwitchPage({ push = true } = {}) {
  lastViewBeforeSwitch = document.querySelector('.nav-item.active')?.dataset.view || 'dashboard';
  appShell.classList.add('hidden');
  orgSwitchScreen.classList.remove('hidden');
  if (push && location.pathname !== '/accounts') history.pushState({ orgSwitch: true }, '', '/accounts');
  document.title = 'Relay — Switch Organization';

  const errEl = document.getElementById('orgSwitchError');
  errEl.textContent = '';
  document.getElementById('orgSwitchList').innerHTML = '<div class="stub">Loading organizations…</div>';
  try {
    const { data } = await api('/organizations');
    orgSwitchCache = data || [];
    renderOrgSwitchList(orgSwitchCache);
  } catch (err) {
    document.getElementById('orgSwitchList').innerHTML = '';
    errEl.textContent = err.message;
  }
}

function closeOrgSwitchPage({ push = true, restoreView = true } = {}) {
  orgSwitchScreen.classList.add('hidden');
  appShell.classList.remove('hidden');
  const view = restoreView ? lastViewBeforeSwitch : (pathToView(location.pathname) || 'dashboard');
  if (push) setActiveView(view);
}

function renderOrgSwitchList(orgs) {
  const el = document.getElementById('orgSwitchList');
  if (!orgs.length) {
    el.innerHTML = '<div class="stub">No organizations yet.</div>';
    return;
  }
  el.innerHTML = orgs.map((org) => `
    <div class="org-switch-item" data-org-id="${org.id}">
      <div class="org-switch-avatar">${escapeHtml((org.name || '?').slice(0, 1).toUpperCase())}</div>
      <div class="org-switch-meta">
        <div class="org-switch-name">${escapeHtml(org.name)}</div>
        <div class="org-switch-sub">${escapeHtml(org.email || 'no contact email')} · ${escapeHtml(org.status || 'ACTIVE')}</div>
      </div>
      <button class="primary-btn org-switch-go" type="button" style="margin:0;">Switch →</button>
    </div>
  `).join('');
  el.querySelectorAll('.org-switch-item').forEach((item) => {
    item.addEventListener('click', () => selectOrganizationContext(item.dataset.orgId));
  });
}

document.getElementById('orgSwitchSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  renderOrgSwitchList(orgSwitchCache.filter((o) =>
    o.name.toLowerCase().includes(q) || (o.email || '').toLowerCase().includes(q)));
});

async function selectOrganizationContext(orgId) {
  const errEl = document.getElementById('orgSwitchError');
  errEl.textContent = '';
  try {
    const { data } = await api(`/organizations/${orgId}/switch-context`, { method: 'POST' });
    setTokens(data.accessToken, data.refreshToken);
    orgSwitchScreen.classList.add('hidden');
    appShell.classList.remove('hidden');
    history.pushState({ view: 'dashboard' }, '', '/dashboard');
    await enterApp();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

switchOrgBtn.addEventListener('click', () => openOrgSwitchPage());
document.getElementById('orgSwitchBackBtn').addEventListener('click', () => closeOrgSwitchPage());

// ------------------------- Super Admin — Add Account (create + auto-switch) -------------------------
// Creates a brand-new tenant organization UNDER THE CURRENT IDENTITY (same
// login as whoever is already authenticated — no separate owner email or
// password anymore; see backend routes/v1/organizations.js POST /). Then
// immediately switches context into it using the accessToken/refreshToken
// the create call already returns.

const orgAddModal = document.getElementById('orgAddModal');
const orgAddForm = document.getElementById('orgAddForm');

document.getElementById('orgAddAccountBtn').addEventListener('click', () => {
  document.getElementById('orgAddError').textContent = '';
  orgAddForm.reset();
  orgAddModal.classList.remove('hidden');
});
document.getElementById('orgAddModalClose').addEventListener('click', () => orgAddModal.classList.add('hidden'));
orgAddModal.addEventListener('click', (e) => { if (e.target === orgAddModal) orgAddModal.classList.add('hidden'); });

orgAddForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('orgAddError');
  const submitBtn = document.getElementById('orgAddSubmitBtn');
  errEl.textContent = '';

  const orgName = document.getElementById('orgAddOrgName').value.trim();

  if (!orgName) {
    errEl.textContent = 'Organization name is required.';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating…';
  try {
    // Creates the new isolated organization under the CURRENT identity and
    // immediately returns tokens already scoped into it — no separate
    // switch-context call needed (see routes/v1/organizations.js POST /).
    const { data } = await api('/organizations', {
      method: 'POST',
      body: { orgName },
    });
    setTokens(data.accessToken, data.refreshToken);

    orgAddModal.classList.add('hidden');
    orgSwitchScreen.classList.add('hidden');
    appShell.classList.remove('hidden');
    history.pushState({ view: 'dashboard' }, '', '/dashboard');
    await enterApp();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create & switch into account';
  }
});

document.getElementById('exitContextBtn').addEventListener('click', async () => {
  try {
    const { data } = await api('/organizations/exit-context', { method: 'POST' });
    setTokens(data.accessToken, data.refreshToken);
    history.pushState({ view: 'dashboard' }, '', '/dashboard');
    await enterApp();
  } catch (err) {
    alert(err.message);
  }
});

// ------------------------- URL routing (address bar reflects the open view) -------------------------

const VIEW_ROUTES = {
  dashboard: '/dashboard',
  permissions: '/permissions',
  analytics: '/analytics',
  task: '/task',
  activities: '/activities',
  crm: '/crm',
  products: '/products',
  quotes: '/quotes',
  orders: '/orders',
  automations: '/automations',
  chat: '/chat',
  users: '/team',
  settings: '/settings',
};
const PATH_TO_VIEW = Object.fromEntries(Object.entries(VIEW_ROUTES).map(([view, path]) => [path, view]));

function pathToView(pathname) {
  return PATH_TO_VIEW[pathname] || null;
}

window.addEventListener('popstate', (e) => {
  if (appShell.classList.contains('hidden') && orgSwitchScreen.classList.contains('hidden')) return; // not logged in yet
  if (location.pathname === '/accounts') { openOrgSwitchPage({ push: false }); return; }
  if (!orgSwitchScreen.classList.contains('hidden')) { orgSwitchScreen.classList.add('hidden'); appShell.classList.remove('hidden'); }
  const view = (e.state && e.state.view) || pathToView(location.pathname) || 'dashboard';
  setActiveView(view, { push: false });
});

// ------------------------- Entering the app -------------------------

async function enterApp() {
  const { data: me } = await api('/auth/me');
  state.me = me;
  state.orgUsers = []; // never carry a cached user list across a Super Admin org switch

  showScreen('app');

  document.getElementById('meName').textContent = me.displayName;
  document.getElementById('meEmail').textContent = me.email;
  document.getElementById('orgNameLabel').textContent = me.isSuperAdmin ? 'Super Admin' : '';

  let orgName = null;
  if (me.orgId) {
    try {
      const { data: org } = await api(`/organizations/${me.orgId}`);
      orgName = org.name;
      document.getElementById('orgNameLabel').textContent = me.isSuperAdmin ? `Super Admin — ${org.name}` : org.name;
    } catch {}
  }

  // Super Admin only: "Switch Account" button (always available) + the
  // "acting as tenant" banner (only while activeOrgId is set — see tokens.js).
  switchOrgBtn.classList.toggle('hidden', !me.isSuperAdmin);
  const acting = !!(me.isSuperAdmin && me.activeOrgId);
  actingBanner.classList.toggle('hidden', !acting);
  if (acting) {
    document.getElementById('actingBannerText').textContent =
      `🔒 Viewing as Super Admin inside "${orgName || 'this organization'}" — data stays isolated to this tenant`;
  }

  await refreshBuSwitcher();

  connectSocket();
  await loadConversations();

  const initialView = pathToView(location.pathname) || 'dashboard';
  setActiveView(initialView, { push: location.pathname !== VIEW_ROUTES[initialView] });

  // Reload directly on /accounts (e.g. hard refresh while on the switch page) -> reopen it.
  if (location.pathname === '/accounts' && me.isSuperAdmin) {
    await openOrgSwitchPage({ push: false });
  }
}

// ------------------------- Sidebar navigation -------------------------

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => setActiveView(btn.dataset.view));
});

function setActiveView(view, { push = true } = {}) {
  if (!document.getElementById(`view-${view}`)) view = 'dashboard';

  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));

  const path = VIEW_ROUTES[view] || `/${view}`;
  if (push && location.pathname !== path) history.pushState({ view }, '', path);
  document.title = `Relay — ${view.charAt(0).toUpperCase()}${view.slice(1)}`;

  if (view === 'users') loadTeamMembers();
  if (view === 'permissions') loadPermissionsView();
  if (view === 'dashboard') refreshDashboardStats();
}

// ------------------------- Dashboard -------------------------

async function refreshDashboardStats() {
  if (!state.me) return;
  document.getElementById('dashWelcomeName').textContent = state.me.displayName;
  document.getElementById('dashWelcomeSub').textContent = state.me.isSuperAdmin
    ? (state.me.activeOrgId ? 'Super Admin — viewing a tenant' : 'Super Admin — platform view')
    : (state.me.role?.label || 'Team member');
  document.getElementById('dashConvCount').textContent = state.conversations.length;
  document.getElementById('dashRoleValue').textContent = state.me.isSuperAdmin ? 'Super Admin' : (state.me.role?.label || '—');

  const teamCountEl = document.getElementById('dashTeamCount');
  if (!state.me.orgId) {
    teamCountEl.textContent = '—';
    return;
  }
  try {
    const users = await ensureOrgUsersLoaded();
    teamCountEl.textContent = users.length + 1; // +1 for the current user, excluded by ensureOrgUsersLoaded
  } catch {
    teamCountEl.textContent = '—';
  }
}

// ------------------------- Permissions view -------------------------

async function loadPermissionsView() {
  const noOrgEl = document.getElementById('permissionsNoOrg');
  const bodyEl = document.getElementById('permissionsBody');
  const errEl = document.getElementById('permissionsError');
  errEl.textContent = '';
  bodyEl.innerHTML = '';

  if (!state.me.orgId) {
    noOrgEl.classList.remove('hidden');
    return;
  }
  noOrgEl.classList.add('hidden');

  try {
    const rolesPath = state.me.isSuperAdmin ? `/roles?orgId=${encodeURIComponent(state.me.orgId)}` : '/roles';
    const [{ data: roles }, { data: catalog }] = await Promise.all([api(rolesPath), api('/permissions')]);
    renderPermissions(roles, catalog);
  } catch (err) {
    errEl.textContent = err.message;
  }
}

function renderPermissions(roles, catalog) {
  const bodyEl = document.getElementById('permissionsBody');
  if (!roles.length) {
    bodyEl.innerHTML = '<div class="stub">No roles yet for this organization.</div>';
    return;
  }
  bodyEl.innerHTML = roles.map((role) => `
    <div class="role-card" data-role-id="${role.id}">
      <div class="role-card-header">
        <div>
          <div class="role-card-title">${escapeHtml(role.label)} ${role.systemProtected ? '<span class="role-badge">system</span>' : ''}</div>
          <div class="role-card-key">${escapeHtml(role.key)}</div>
        </div>
        ${role.systemProtected ? '' : '<button class="primary-btn save-role-btn" type="button" style="margin:0;">Save</button>'}
      </div>
      <div class="role-groups">
        ${Object.entries(catalog.groups).map(([group, perms]) => `
          <div class="role-group">
            <div class="role-group-title">${escapeHtml(group)}</div>
            ${perms.map((p) => `
              <label class="perm-check">
                <input type="checkbox" value="${p}" ${role.permissions.includes(p) ? 'checked' : ''} ${role.systemProtected ? 'disabled' : ''} />
                ${escapeHtml(p)}
              </label>
            `).join('')}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  bodyEl.querySelectorAll('.role-card').forEach((card) => {
    const saveBtn = card.querySelector('.save-role-btn');
    if (!saveBtn) return;
    saveBtn.addEventListener('click', async () => {
      const roleId = card.dataset.roleId;
      const permissions = [...card.querySelectorAll('input[type=checkbox]:checked')].map((cb) => cb.value);
      const original = saveBtn.textContent;
      try {
        await api(`/roles/${roleId}`, { method: 'PATCH', body: { permissions } });
        saveBtn.textContent = 'Saved ✓';
        setTimeout(() => { saveBtn.textContent = original; }, 1500);
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

document.getElementById('permissionsSwitchPrompt').addEventListener('click', () => openOrgSwitchPage());

document.getElementById('createRoleBtn').addEventListener('click', () => {
  if (!state.me.orgId) { alert('Switch into an organization first — see the button above.'); return; }
  openModal('New role', `
    <label style="font-size:12px;color:#8b93a3;">Key (e.g. SALES_MANAGER)</label>
    <input type="text" id="newRoleKey" placeholder="SALES_MANAGER" />
    <label style="font-size:12px;color:#8b93a3;">Label</label>
    <input type="text" id="newRoleLabel" placeholder="Sales Manager" />
    <button class="primary-btn" id="createRoleSaveBtn">Create role</button>
    <p class="error-msg" id="createRoleError"></p>
  `);
  document.getElementById('createRoleSaveBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('createRoleError');
    errEl.textContent = '';
    const key = document.getElementById('newRoleKey').value.trim().toUpperCase().replace(/\s+/g, '_');
    const label = document.getElementById('newRoleLabel').value.trim();
    if (!key || !label) { errEl.textContent = 'Key and label are required.'; return; }
    try {
      await api('/roles', { method: 'POST', body: { orgId: state.me.orgId, key, label, permissions: [] } });
      closeModal();
      await loadPermissionsView();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
});

// ------------------------- Realtime (Socket.IO) -------------------------

function connectSocket() {
  if (state.socket) state.socket.disconnect(); // re-entering enterApp() after a workspace/org switch — avoid stacking connections
  state.socket = io(API_ORIGIN || window.location.origin, { auth: { token: state.accessToken } });

  state.socket.on('chat:message', (message) => {
    if (message.conversationId === state.activeConversationId) {
      renderMessage(message);
      scrollMessagesToBottom();
    }
    bumpConversationPreview(message);
  });

  state.socket.on('presence:update', ({ userId, status }) => {
    if (state.activeConversation && state.activeConversation.type === 'DIRECT') {
      const otherId = state.activeConversation.userAId === state.me.id ? state.activeConversation.userBId : state.activeConversation.userAId;
      if (otherId === userId) {
        document.getElementById('chatPresence').classList.toggle('online', status === 'ONLINE');
      }
    }
  });

  state.socket.on('chat:typing', ({ conversationId, displayName, isTyping }) => {
    if (conversationId === state.activeConversationId) {
      document.getElementById('chatTitle').dataset.baseTitle = document.getElementById('chatTitle').dataset.baseTitle || document.getElementById('chatTitle').textContent;
      const base = document.getElementById('chatTitle').dataset.baseTitle;
      document.getElementById('chatTitle').textContent = isTyping ? `${base} — ${displayName} is typing…` : base;
    }
  });
}

// ------------------------- Conversations list -------------------------

async function loadConversations() {
  const { data: conversations } = await api('/conversations');
  state.conversations = conversations;
  renderConversationList();
}

function renderConversationList() {
  const el = document.getElementById('conversationList');
  el.innerHTML = '';
  state.conversations.forEach((conv) => {
    const item = document.createElement('div');
    item.className = 'conversation-item' + (conv.id === state.activeConversationId ? ' active' : '');
    item.innerHTML = `
      <div class="conv-title">${escapeHtml(conv.title)}</div>
      <div class="conv-preview">${conv.lastMessage ? escapeHtml(conv.lastMessage.content) : 'No messages yet'}</div>
    `;
    item.addEventListener('click', () => openConversation(conv));
    el.appendChild(item);
  });
}

function bumpConversationPreview(message) {
  const conv = state.conversations.find((c) => c.id === message.conversationId);
  if (conv) {
    conv.lastMessage = message;
    conv.lastMessageAt = message.createdAt;
    state.conversations.sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt));
    renderConversationList();
  }
}

async function openConversation(conv) {
  state.activeConversationId = conv.id;
  state.activeConversation = conv;
  renderConversationList();

  document.getElementById('chatTitle').textContent = conv.title;
  document.getElementById('chatTitle').dataset.baseTitle = conv.title;
  document.getElementById('messageForm').classList.remove('hidden');
  state.socket.emit('chat:join', { conversationId: conv.id });

  const { data: messages } = await api(`/conversations/${conv.id}/messages`);
  const list = document.getElementById('messageList');
  list.innerHTML = '';
  messages.forEach(renderMessage);
  scrollMessagesToBottom();
}

function renderMessage(message) {
  const list = document.getElementById('messageList');
  const bubble = document.createElement('div');
  const mine = message.senderId === state.me.id;
  bubble.className = 'message-bubble' + (mine ? ' mine' : '');
  bubble.innerHTML = `
    <div>${escapeHtml(message.content)}</div>
    <div class="message-meta">${mine ? 'You' : escapeHtml(message.sender?.displayName || 'Unknown')} · ${new Date(message.createdAt).toLocaleTimeString()}</div>
  `;
  list.appendChild(bubble);
}

function scrollMessagesToBottom() {
  const list = document.getElementById('messageList');
  list.scrollTop = list.scrollHeight;
}

// ------------------------- Sending messages -------------------------

document.getElementById('messageForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  if (!content || !state.activeConversationId) return;
  state.socket.emit('chat:send', { conversationId: state.activeConversationId, content }, (ack) => {
    if (ack?.error) alert(ack.error);
  });
  input.value = '';
});

let typingTimeout;
document.getElementById('messageInput').addEventListener('input', () => {
  if (!state.activeConversationId) return;
  state.socket.emit('chat:typing', { conversationId: state.activeConversationId, isTyping: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    state.socket.emit('chat:typing', { conversationId: state.activeConversationId, isTyping: false });
  }, 1500);
});

// ------------------------- New DM / New Group modals -------------------------

const modalBackdrop = document.getElementById('modalBackdrop');
document.getElementById('modalClose').addEventListener('click', closeModal);
function closeModal() { modalBackdrop.classList.add('hidden'); }
function openModal(title, bodyHtml) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  modalBackdrop.classList.remove('hidden');
}

async function ensureOrgUsersLoaded() {
  if (state.orgUsers.length) return state.orgUsers;
  try {
    const { data } = await api('/users');
    state.orgUsers = data.filter((u) => u.id !== state.me.id);
  } catch {
    state.orgUsers = []; // caller may lack user.view permission — degrade gracefully
  }
  return state.orgUsers;
}

document.getElementById('newDmBtn').addEventListener('click', async () => {
  const users = await ensureOrgUsersLoaded();
  const listHtml = users.length
    ? users.map((u) => `<div class="user-option" data-user-id="${u.id}">${escapeHtml(u.displayName)} <span style="color:#8b93a3">(${escapeHtml(u.email)})</span></div>`).join('')
    : '<div style="color:#8b93a3;font-size:13px;">No other teammates found yet.</div>';
  openModal('Start a direct message', listHtml);
  document.querySelectorAll('.user-option').forEach((opt) => {
    opt.addEventListener('click', async () => {
      try {
        const { data: conv } = await api('/conversations/direct', { method: 'POST', body: { userId: opt.dataset.userId } });
        closeModal();
        await loadConversations();
        const full = state.conversations.find((c) => c.id === conv.id) || { ...conv, title: opt.textContent };
        openConversation(full);
      } catch (err) {
        alert(err.message);
      }
    });
  });
});

document.getElementById('newGroupBtn').addEventListener('click', async () => {
  const users = await ensureOrgUsersLoaded();
  const checkboxes = users.map((u) => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;">
      <input type="checkbox" value="${u.id}" class="group-member-cb" /> ${escapeHtml(u.displayName)}
    </label>`).join('');
  openModal('Create a group', `
    <input type="text" id="newGroupName" placeholder="Group name" />
    <div style="max-height:160px;overflow-y:auto;margin-top:8px;">${checkboxes || '<div style="color:#8b93a3;font-size:13px;">No other teammates to add yet — you can add people later.</div>'}</div>
    <button class="primary-btn" id="createGroupBtn">Create</button>
  `);
  document.getElementById('createGroupBtn').addEventListener('click', async () => {
    const name = document.getElementById('newGroupName').value.trim();
    if (!name) return;
    try {
      const memberIds = [...document.querySelectorAll('.group-member-cb:checked')].map((cb) => cb.value);
      const { data } = await api('/groups', { method: 'POST', body: { name, memberIds, kind: 'GROUP' } });
      closeModal();
      await loadConversations();
      const conv = state.conversations.find((c) => c.id === data.conversationId);
      if (conv) openConversation(conv);
    } catch (err) {
      alert(err.message);
    }
  });
});

// ------------------------- CRM sub-tabs (Contacts / Leads / Deals / Companies) -------------------------

document.querySelectorAll('.crm-subtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.crm-subtab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.crmtab;
    document.querySelectorAll('.crm-subview').forEach((v) => v.classList.toggle('hidden', v.id !== `crm-subview-${tab}`));
  });
});

// ------------------------- Team view + Invite -------------------------

async function loadTeamMembers() {
  const errEl = document.getElementById('teamError');
  errEl.textContent = '';
  try {
    const { data: users } = await api('/users');
    renderTeamList(users);
  } catch (err) {
    // Most likely the current user lacks user.view permission — degrade gracefully.
    renderTeamList([]);
    errEl.textContent = err.message;
  }
}

function renderTeamList(users) {
  const el = document.getElementById('teamList');
  el.innerHTML = '';
  if (!users.length) {
    el.innerHTML = '<div style="padding:16px;color:#8b93a3;font-size:13px;">No teammates to show yet.</div>';
    return;
  }
  users.forEach((u) => {
    const item = document.createElement('div');
    item.className = 'conversation-item';
    item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
    item.innerHTML = `
      <div>
        <div class="conv-title">${escapeHtml(u.displayName)}${u.isSuperAdmin ? ' <span style="color:#7dd3fc;font-size:11px;">(Super Admin)</span>' : ''}</div>
        <div class="conv-preview">${escapeHtml(u.email)}${u.enabled ? '' : ' · disabled'}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="icon-btn edit-user-btn" data-user-id="${u.id}">Edit</button>
        <button class="icon-btn delete-user-btn" data-user-id="${u.id}" style="color:#f87171;border-color:#4a2a2a;">Delete</button>
      </div>
    `;
    el.appendChild(item);
  });

  document.querySelectorAll('.edit-user-btn').forEach((btn) => {
    btn.addEventListener('click', () => openEditUserModal(users.find((u) => u.id === btn.dataset.userId)));
  });
  document.querySelectorAll('.delete-user-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteUser(users.find((u) => u.id === btn.dataset.userId)));
  });
}

function openEditUserModal(user) {
  if (!user) return;
  openModal(`Edit ${user.displayName}`, `
    <label style="font-size:12px;color:#8b93a3;">Full name</label>
    <input type="text" id="editDisplayName" value="${escapeHtml(user.displayName)}" />
    <label style="font-size:12px;color:#8b93a3;">Designation</label>
    <input type="text" id="editDesignation" value="${escapeHtml(user.designation || '')}" placeholder="e.g. Sales Rep" />
    <label style="font-size:12px;color:#8b93a3;">Phone</label>
    <input type="text" id="editPhone" value="${escapeHtml(user.phone || '')}" />
    <button class="primary-btn" id="saveUserBtn">Save changes</button>
    <p class="error-msg" id="editUserError"></p>
  `);

  document.getElementById('saveUserBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('editUserError');
    errEl.textContent = '';
    const displayName = document.getElementById('editDisplayName').value.trim();
    const designation = document.getElementById('editDesignation').value.trim();
    const phone = document.getElementById('editPhone').value.trim();
    if (!displayName) { errEl.textContent = 'Full name is required.'; return; }

    try {
      await api(`/users/${user.id}`, { method: 'PATCH', body: { displayName, designation, phone } });
      closeModal();
      await loadTeamMembers();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

async function deleteUser(user) {
  if (!user) return;
  if (user.id === state.me.id) { alert("You can't delete your own account."); return; }
  if (!confirm(`Delete ${user.displayName} (${user.email})? This can't be undone.`)) return;

  try {
    await api(`/users/${user.id}`, { method: 'DELETE' });
    await loadTeamMembers();
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('inviteBtn').addEventListener('click', () => {
  openModal('Invite a teammate', `
    <label style="font-size:12px;color:#8b93a3;">Full name</label>
    <input type="text" id="inviteDisplayName" placeholder="Jane Doe" />
    <label style="font-size:12px;color:#8b93a3;">Email</label>
    <input type="email" id="inviteEmail" placeholder="jane@company.com" />
    <label style="font-size:12px;color:#8b93a3;">Password</label>
    <input type="password" id="invitePassword" minlength="8" placeholder="min 8 characters" />
    <p style="font-size:12px;color:#8b93a3;margin:4px 0 0;">
      Share this email and password with them personally — they'll use it to log in.
    </p>
    <button class="primary-btn" id="createInviteBtn">Create account</button>
    <p class="error-msg" id="inviteError"></p>
  `);

  document.getElementById('createInviteBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('inviteError');
    errEl.textContent = '';
    const displayName = document.getElementById('inviteDisplayName').value.trim();
    const email = document.getElementById('inviteEmail').value.trim();
    const password = document.getElementById('invitePassword').value;

    if (!displayName || !email || !password) { errEl.textContent = 'All fields are required.'; return; }
    if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }

    try {
      await api('/users/invite', { method: 'POST', body: { displayName, email, password } });
      closeModal();
      await loadTeamMembers();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
});

// ------------------------- utils -------------------------

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------- Boot -------------------------

(async function boot() {
  if (state.accessToken) {
    try {
      await enterApp();
      return;
    } catch {
      clearTokens(); // stale/expired tokens with no valid refresh — fall through below
    }
  }

  try {
    const { data } = await api('/setup/status');
    showScreen(data.superAdminExists ? 'auth' : 'setup');
  } catch {
    showScreen('auth'); // if the status check itself fails, default to the normal login screen
  }
})();
