// Start screen. The shell reports what the worker is doing (`worker-state`); when the worker is ready the
// shell replaces this page with the worker's own UI.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const el = (id) => document.getElementById(id);

function show(state) {
  // `running`: the shell is about to show the worker's UI; keep the spinner until then.
  const view = state.kind === 'external' || state.kind === 'error' ? state.kind : 'starting';
  for (const id of ['starting', 'external', 'error']) el(id).hidden = id !== view;
  if (view === 'starting') el('starting-message').textContent = state.kind === 'running' ? 'Opening the worker…' : state.message;
  if (view === 'error') el('error-message').textContent = state.message;
  if (state.version) el('version').textContent = `Version ${state.version}`;
  for (const button of document.querySelectorAll('button')) button.disabled = false;
}

function action(id, command) {
  el(id).addEventListener('click', (event) => {
    event.currentTarget.disabled = true;
    void invoke(command);
  });
}
action('take-over', 'take_over');
action('use-existing', 'use_existing');
action('retry', 'retry_start');
el('logs').addEventListener('click', () => void invoke('open_logs'));

void listen('worker-state', (event) => show(event.payload));
void invoke('app_state').then(show);
