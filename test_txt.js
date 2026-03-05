// Test TXT parsing logic
const line = ' arcp_vers=2.8.9 arcp_min=0.2.4 router_vers=4.3 router_info=Audinate\\ DCM mf=Powersft model=_0000000700000003';
console.log('input:', JSON.stringify(line));

const raw = line.trim().replace(/\\ /g, '\u00A0');
console.log('after replace:', JSON.stringify(raw));

const parts = raw.split(/\s+/);
console.log('parts:', parts);

const txt = {};
for (const kv of parts) {
  const eq = kv.indexOf('=');
  if (eq > 0) txt[kv.slice(0, eq)] = kv.slice(eq + 1).replace(/\u00A0/g, ' ');
}
console.log('txt:', JSON.stringify(txt, null, 2));
