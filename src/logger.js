export function makeLogger(level = 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = order[level] ?? 20;
  const out = (lvl, scope, msg, extra) => {
    if (order[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase()} [${scope}] ${msg}` + (extra ? ' ' + JSON.stringify(extra) : '');
    (lvl === 'error' ? console.error : console.log)(line);
  };
  return (scope) => ({
    debug: (m, e) => out('debug', scope, m, e),
    info: (m, e) => out('info', scope, m, e),
    warn: (m, e) => out('warn', scope, m, e),
    error: (m, e) => out('error', scope, m, e),
  });
}
