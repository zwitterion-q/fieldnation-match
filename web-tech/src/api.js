const TOKEN_KEY = "fn_token";
const USER_KEY  = "fn_user";

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const getUser  = () => { try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; } };
export const clearAuth = () => { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch {} };

export async function login(email, password) {
  const r = await fetch("/id/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.message || "login failed");
  try { localStorage.setItem(TOKEN_KEY, d.access_token); localStorage.setItem(USER_KEY, JSON.stringify(d.user)); } catch {}
  return d.user;
}

/** Adds the bearer token and turns a 401 into a forced re-login. */
export async function api(path, opts = {}) {
  const token = getToken();
  const r = await fetch(path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (r.status === 401) { clearAuth(); window.location.reload(); return; }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || `${r.status}`);
  return body;
}

export const can = (perm) => (getUser()?.permissions || []).includes(perm);
