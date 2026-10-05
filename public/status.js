const status = document.getElementById('status');
const detail = document.getElementById('detail');
try {
  const response = await fetch('/api/v1/status', {
    cache: 'no-store', signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('status_unavailable');
  const result = await response.json();
  if (result.settlement === 'configured') {
    status.textContent = 'API configuration loaded';
    detail.textContent = 'Server credentials and signing keys are configured. Database connectivity, ledger provisioning and the refund scheduler require separate operational verification.';
  } else if (result.settlement === 'configuration_required') {
    status.textContent = 'Settlement configuration required';
    detail.textContent = 'The service is online. Settlement remains disabled until its server credentials and telemetry signing keys are configured.';
  } else throw new Error('invalid_status');
} catch {
  status.textContent = 'Status check unavailable';
  detail.textContent = 'The service status could not be verified. Retry this page shortly.';
}
