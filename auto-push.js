/**
 * auto-push.js — Vigila el proyecto y hace commit + push automático.
 *
 * Cada vez que cambia un archivo (o cada POLL_MS por si el watcher no ve el
 * cambio) hace:  git add -A  →  git commit  →  git push
 * Así Railway y el frontend redeployan solos, sin que tengas que teclear git.
 *
 * USO:
 *   1) Abre una terminal en la carpeta del proyecto (donde está la carpeta .git).
 *   2) Corre:  node auto-push.js
 *   3) Déjala abierta. Para detener: Ctrl+C.
 *
 * Resiliencia (v2):
 *   - Además del watcher, revisa solo cada POLL_MS (por si fs.watch se pierde
 *     un cambio, p.ej. archivos escritos desde otra vía).
 *   - Si encuentra un .git/index.lock viejo (> LOCK_STALE_MS) lo borra solo.
 *   - Si el push es rechazado (fetch first), hace pull --rebase y reintenta.
 *   - Loguea un latido cada HEARTBEAT_MS para que sepas que sigue vivo.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const DEBOUNCE_MS = 8000;      // calma tras el último cambio antes de subir
const POLL_MS = 30000;         // revisión periódica aunque el watcher no dispare
const HEARTBEAT_MS = 300000;   // latido en consola cada 5 min
const LOCK_STALE_MS = 60000;   // index.lock más viejo que esto se considera colgado
const IGNORE = [
  '.git', 'node_modules', '.expo', 'dist', 'build', '.next',
  'android', 'ios', '.gradle', 'coverage', '.cache',
];

function ignored(rel) {
  return IGNORE.some(seg => rel === seg || rel.startsWith(seg + path.sep) || rel.includes(path.sep + seg + path.sep));
}

function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: ROOT, windowsHide: true, maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, out: (stdout || '') + (stderr || '') });
    });
  });
}

function clearStaleLock() {
  const lock = path.join(ROOT, '.git', 'index.lock');
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      fs.unlinkSync(lock);
      console.log(`[${ts()}] 🔓 index.lock viejo eliminado (estaba colgado).`);
    }
  } catch { /* no existe: ok */ }
}

let timer = null;
let running = false;
let pendingWhileRunning = false;

function ts() {
  return new Date().toLocaleString('es-CL');
}

async function commitAndPush() {
  if (running) { pendingWhileRunning = true; return; }
  running = true;
  try {
    clearStaleLock();
    const status = await git(['status', '--porcelain']);
    const ahead = await git(['rev-list', '--count', '@{u}..HEAD']);
    const nAhead = parseInt((ahead.out || '0').trim(), 10) || 0;
    // Nada que subir NI commits locales pendientes → salir.
    if (!status.out.trim() && nAhead === 0) { running = false; return; }

    if (status.out.trim()) {
      console.log(`\n[${ts()}] Cambios detectados — subiendo...`);
      await git(['add', '-A']);
      const commit = await git(['commit', '-m', `auto: cambios ${ts()}`]);
      if (commit.code !== 0 && !/nothing to commit/i.test(commit.out)) {
        console.log('  commit:', commit.out.trim().split('\n').slice(-3).join(' | '));
      }
    } else {
      console.log(`\n[${ts()}] Hay ${nAhead} commit(s) local(es) sin subir — empujando...`);
    }

    let push = await git(['push']);
    if (push.code !== 0 && /fetch first|rejected|non-fast-forward/i.test(push.out)) {
      console.log('  ↻ push rechazado, haciendo pull --rebase y reintentando...');
      const pull = await git(['pull', '--rebase']);
      if (pull.code !== 0) {
        console.log('  ⚠️ pull --rebase falló:', pull.out.trim().split('\n').slice(-4).join(' | '));
      }
      push = await git(['push']);
    }
    if (push.code === 0) {
      console.log(`  ✅ push OK — Railway/Frontend redeployan solos.`);
    } else {
      console.log('  ⚠️ push falló:', push.out.trim().split('\n').slice(-4).join(' | '));
    }
  } catch (e) {
    console.log('  ⚠️ error:', e.message);
  } finally {
    running = false;
    if (pendingWhileRunning) { pendingWhileRunning = false; schedule(); }
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(commitAndPush, DEBOUNCE_MS);
}

// Verificar que estamos en un repo git
(async () => {
  const check = await git(['rev-parse', '--is-inside-work-tree']);
  if (check.code !== 0) {
    console.error('❌ Esta carpeta no es un repositorio git. Corre el script dentro del proyecto (donde está .git).');
    process.exit(1);
  }
  console.log('👀 auto-push v2 activo en:', ROOT);
  console.log(`   Watcher + revisión cada ${POLL_MS / 1000}s + auto-limpia locks colgados. Ctrl+C para detener.\n`);

  // Watcher de archivos
  try {
    fs.watch(ROOT, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (ignored(rel)) return;
      schedule();
    });
  } catch (e) {
    console.error('⚠️ fs.watch falló, sigo solo con revisión periódica:', e.message);
  }

  // Red de seguridad: revisión periódica aunque el watcher no dispare
  setInterval(commitAndPush, POLL_MS);
  // Latido
  setInterval(() => console.log(`[${ts()}] 💓 auto-push vivo.`), HEARTBEAT_MS);
  // Primera pasada por si quedaron cambios/commits sin subir
  commitAndPush();
})();
