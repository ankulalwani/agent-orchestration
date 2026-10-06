// Log viewer: shows the end of the worker's log file and follows it.
const { invoke } = window.__TAURI__.core;
const el = (id) => document.getElementById(id);
const log = el('log');
/** Characters kept on screen; older text is dropped (the file has everything). */
const MAX_SHOWN = 400_000;

let offset = null;
async function read() {
  try {
    const chunk = await invoke('read_log', { offset });
    // A smaller offset than before means the file was rotated: start a new view.
    if (offset !== null && chunk.offset < offset) log.textContent = '';
    offset = chunk.offset;
    el('path').textContent = chunk.path;
    el('path').title = chunk.path;
    if (chunk.text) {
      log.append(chunk.text);
      if (log.textContent.length > MAX_SHOWN) log.textContent = log.textContent.slice(-MAX_SHOWN / 2);
      if (el('follow').checked) log.scrollTop = log.scrollHeight;
    }
  } catch (error) {
    el('path').textContent = String(error);
  }
}

function flash(button, text) {
  const before = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = before), 2000);
}

el('folder').addEventListener('click', () => void invoke('open_log_folder'));
el('diagnostics').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    const checks = JSON.parse(await invoke('diagnostics'));
    const lines = checks.map((c) => `[${c.status}] ${c.label ?? c.id}${c.detail ? `: ${c.detail}` : ''}`);
    await navigator.clipboard.writeText(lines.join('\n'));
    flash(button, 'Copied');
  } catch (error) {
    flash(button, 'Not available');
    console.error(error);
  }
});

void read();
setInterval(read, 1500);
