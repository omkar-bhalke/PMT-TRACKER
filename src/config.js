import fs from 'node:fs';

/** Reads and validates environment variables. Fails fast: no built-in secrets, no defaults for secrets. */
export function loadConfig(env = process.env) {
  const need = (k) => {
    const v = (env[k] || '').trim();
    if (!v) throw new Error(`Missing required environment variable ${k}`);
    return v;
  };
  const secret = need('SERVICE_SECRET');
  if (secret.length < 32) throw new Error('SERVICE_SECRET must be at least 32 characters');

  // Railway sets RAILWAY_VOLUME_MOUNT_PATH only when a Volume is attached. Prefer it, so data lands on the volume
  // even if DATA_DIR was typed wrong.
  const volumePath = (env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
  const onRailway = !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
  const dataDir = volumePath || env.DATA_DIR || (fs.existsSync('/data') ? '/data' : './data');
  const persistentStorage = !onRailway || !!volumePath || env.ALLOW_EPHEMERAL_STORAGE === 'true';
  return {
    port: parseInt(env.PORT || '3000', 10),
    dataDir,
    persistentStorage,
    onRailway,
    cpanelApiUrl: need('CPANEL_API_URL').replace(/\/+$/, ''),
    serviceSecret: secret,
    // Initial default for NEW users is set on cPanel (SBI_DEFAULT_TARGET); this is only a fallback label.
    defaultTarget: (env.SBI_TARGET_NUMBER || '919022690226').replace(/\D/g, ''),
    tickMs: parseInt(env.SCHEDULER_TICK_MS || '15000', 10),
    maxConcurrentCycles: parseInt(env.MAX_CONCURRENT_CYCLES || '2', 10),
    cycleTimeoutMs: parseInt(env.CYCLE_TIMEOUT_MS || '120000', 10),
    menuTimeoutMs: parseInt(env.MENU_TIMEOUT_MS || '45000', 10),
    runNowMinGapMs: parseInt(env.RUN_NOW_MIN_GAP_MS || '60000', 10),
    linkWindowMs: parseInt(env.LINK_WINDOW_MS || '180000', 10),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
