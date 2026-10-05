// A failed logging sink must never change the financial or HTTP outcome.
// Only fixed diagnostic text is emitted on failure; exception messages may
// contain transport credentials and are deliberately not echoed.
function reportFailure() {
  try { process.stderr.write('telemetry_log_write_failed\n'); }
  catch { /* The request's outcome remains authoritative. */ }
}
export function safeLogger(sink) {
  if (typeof sink !== 'function') throw new TypeError('log_sink_must_be_a_function');
  return record => {
    try {
      const pending = sink(record);
      if (pending && typeof pending.then === 'function') {
        // Attach the rejection handler immediately. An asynchronous sink must
        // not cause an unhandled rejection after the payout has committed.
        void Promise.resolve(pending).catch(reportFailure);
      }
    } catch { reportFailure(); }
  };
}
