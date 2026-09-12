import './styles.css';
import { readPublicConfig } from './config';
import { createBrowserDatabase } from './supabase';
import { checkAccess } from './auth';
import { readRecentCandidates } from './workspace-repository';

const app = document.querySelector<HTMLElement>('#app')!;
// All API/user text uses textContent. HTML templates below contain static markup only.
function message(title: string, detail: string) {
  app.innerHTML = '<section class="panel narrow"><p class="eyebrow">Workspace access</p><h1></h1><p class="description"></p><div class="actions"></div></section>';
  app.querySelector('h1')!.textContent = title;
  app.querySelector('.description')!.textContent = detail;
}

async function start() {
  let config;
  try { config = readPublicConfig(__PUBLIC_CONFIG__); }
  catch {
    message('Workspace setup pending', 'The Supabase connection has not been configured. Once setup is complete, sign in here with your internal account.');
    const note = document.createElement('p');
    note.className = 'footnote';
    note.textContent = 'Administrator: follow the Supabase setup steps in the repository documentation.';
    app.querySelector('.panel')!.append(note);
    return;
  }
  const client = createBrowserDatabase(config);
  let revision = 0;

  function action(label: string, handler: () => void) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', handler);
    app.querySelector('.actions')!.append(button);
  }

  async function signOut() {
    revision++;
    message('Signing out…', 'Clearing this workspace session.');
    const result = await client.auth.signOut({ scope: 'local' });
    if (result.error) {
      message('Sign-out could not complete', 'Please try again. Closing this tab also clears its stored session.');
      action('Try again', () => { void signOut(); });
    } else { void refresh(); }
  }

  function login() {
    app.innerHTML = `<section class="panel narrow">
      <p class="eyebrow">Workspace access</p><h1>Sign in</h1>
      <p class="description">Use your internal account to open the ecommerce workspace.</p>
      <form><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" required />
      <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required />
      <p class="form-error" role="alert"></p><button type="submit">Sign in to workspace <span aria-hidden="true">→</span></button></form>
      <p class="footnote">Access is managed by your workspace administrator.</p></section>`;
    const form = app.querySelector('form')!;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button')!;
      button.disabled = true;
      const data = new FormData(form);
      try {
        const result = await client.auth.signInWithPassword({ email: String(data.get('email')), password: String(data.get('password')) });
        if (result.error) throw new Error();
        (form.elements.namedItem('password') as HTMLInputElement).value = '';
        void refresh();
      } catch {
        form.querySelector('.form-error')!.textContent = 'Sign-in failed. Check your email and password, or try again shortly.';
        button.disabled = false;
      }
    });
  }

  async function refresh() {
    const current = ++revision;
    message('Checking access…', 'Connecting to your workspace.');
    try {
      const access = await checkAccess(client);
      if (current !== revision) return;
      if (access.status === 'signed_out') { login(); return; }
      if (access.status === 'denied') {
        message('Access not granted', 'Your account is signed in, but has not been authorized for this workspace. Contact your administrator.');
        action('Sign out', () => { void signOut(); });
        return;
      }
      const candidates = await readRecentCandidates(client);
      if (current !== revision) return;
      app.innerHTML = `<section class="workspace"><div class="workspace-heading"><div><p class="eyebrow">Overview</p><h1>Product workspace</h1></div><div class="actions"></div></div>
        <p class="account"></p><section class="panel"><div class="section-heading"><h2>Recent candidates</h2><span class="badge">Read only</span></div>
        <div class="candidates"></div></section><p class="footnote">Product discovery and review actions will be added in the next phase.</p></section>`;
      app.querySelector('.account')!.textContent = `Signed in as ${access.email}`;
      action('Refresh', () => { void refresh(); });
      action('Sign out', () => { void signOut(); });
      const list = app.querySelector('.candidates')!;
      if (!candidates.length) {
        list.innerHTML = '<div class="empty"><span class="empty-mark" aria-hidden="true">＋</span><h3>No candidates yet</h3><p>Products will appear here after the first supplier import.</p></div>';
      } else {
        const ul = document.createElement('ul');
        for (const candidate of candidates) {
          const li = document.createElement('li');
          const title = document.createElement('strong');
          title.textContent = candidate.products.title;
          const status = document.createElement('span');
          status.className = 'badge';
          status.textContent = candidate.status.replaceAll('_', ' ');
          li.append(title, status);
          ul.append(li);
        }
        list.append(ul);
      }
    } catch (error) {
      if (current !== revision) return;
      message('Workspace unavailable', error instanceof Error ? error.message : 'Please try again shortly.');
      action('Try again', () => { void refresh(); });
      action('Sign out', () => { void signOut(); });
    }
  }

  // Keep the callback synchronous; Supabase calls inside it can deadlock Auth.
  client.auth.onAuthStateChange(() => {
    revision++; // Discard in-flight responses after session changes.
    app.replaceChildren();
    setTimeout(() => { void refresh(); }, 0);
  });
  // INITIAL_SESSION triggers the first load. Recheck membership after tab inactivity.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { revision++; app.replaceChildren(); }
    else void refresh();
  });
}

void start();
