/** Reminders go to staff only; customers remain assigned until explicit closure. */
const { remind } = require('./human-attention');
let running = false;
async function sweepEscalations() {
  if (running) return;
  running = true;
  try { await remind(); }
  catch (error) { console.error('[HumanAttention] recordatorio falló:', error.message); }
  finally { running = false; }
}
function startEscalationWatchJob() {
  setTimeout(sweepEscalations, 90000);
  setInterval(sweepEscalations, 60000);
}
module.exports = { startEscalationWatchJob, sweepEscalations };
