import { createAuthSession } from './auth-session.mjs';

export const authSession = createAuthSession(localStorage, () => window.location.reload());
window.addEventListener('storage', event => authSession.onStorage(event));
