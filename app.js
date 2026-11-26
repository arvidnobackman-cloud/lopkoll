// app.js – Löpkoll: allt som appen gör. Mäter löpturen med GPS, räknar ut tempo och rekord, och sparar i telefonen.
'use strict';

// ===== Ändra här! Julhälsningen som Oscar ser första gången han öppnar appen =====
const HÄLSNING_RUBRIK = 'God jul, pappa! 🎄';
const HÄLSNING_TEXT = 'Här är din egen löparapp! Den mäter hur långt och hur fort du springer, och berättar kul fakta efter varje löptur. Kram från mig ❤️';

const NYCKEL = 'löpkoll';
const $ = id => document.getElementById(id);

// ---------- Det som sparas i telefonen ----------
let data = { namn: 'Oscar', vikt: 80, röst: true, sett: false, turer: [] };
try { Object.assign(data, JSON.parse(localStorage.getItem(NYCKEL)) || {}); } catch (e) { /* börja om */ }
if (!Array.isArray(data.turer)) data.turer = [];
function spara() {
  try { localStorage.setItem(NYCKEL, JSON.stringify(data)); }
  catch (e) { visa('Telefonens minne är fullt – ta bort några gamla löpturer'); }
}

// ---------- Små hjälpare ----------
function tidText(sek) {
  sek = Math.round(sek);
  const h = Math.floor(sek / 3600), m = Math.floor(sek % 3600 / 60), s = sek % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function tempoText(sekPerKm) {
  if (!isFinite(sekPerKm) || sekPerKm <= 0 || sekPerKm > 3600) return '–:––';
  return tidText(sekPerKm);
}
function km(meter, dec = 2) {
  return (meter / 1000).toLocaleString('sv-SE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function tal(x, dec = 0) {
  return x.toLocaleString('sv-SE', { maximumFractionDigits: dec });
}
// Avståndet i meter mellan två platser på jorden
function avstånd(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
}
function skydda(t) {
  return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
let meddTimer;
function visa(text) {
  const m = $('meddelande');
  m.textContent = text;
  m.hidden = false;
  clearTimeout(meddTimer);
  meddTimer = setTimeout(() => { m.hidden = true; }, 3500);
}
function fråga(text, ja = 'Ja') {
  return new Promise(svar => {
    $('fråga-text').textContent = text;
    $('fråga-ja').textContent = ja;
    $('fråga').hidden = false;
    const klar = v => { $('fråga').hidden = true; svar(v); };
    $('fråga-ja').onclick = () => klar(true);
    $('fråga-nej').onclick = () => klar(false);
  });
}
function visaSida(id) {
  for (const s of document.querySelectorAll('.sida')) s.hidden = s.id !== id;
  scrollTo(0, 0);
}

// ---------- Rösten ----------
function säg(text) {
  if (!data.röst || !window.speechSynthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'sv-SE';
    const röst = speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('sv'));
    if (röst) u.voice = röst;
    speechSynthesis.speak(u);
  } catch (e) { /* ingen röst */ }
}
function sägTid(sek) {
  const m = Math.floor(sek / 60), s = Math.round(sek % 60);
  return `${m} ${m === 1 ? 'minut' : 'minuter'}${s ? ` och ${s} sekunder` : ''}`;
}

// ===================================================================
// Löpturen
// ===================================================================
let lopp = null;        // Löpturen som pågår
let gpsId = null, skärmlås = null, ritTimer = null, låtsasTimer = null;

function nu() {
  // I låtsasläget går klockan 30 gånger fortare
  return lopp && lopp.låtsas ? lopp.realStart + (Date.now() - lopp.realStart) * 30 : Date.now();
}
function körtid() {
  return (lopp.aktiv + (lopp.körSedan ? nu() - lopp.körSedan : 0)) / 1000;
}

async function starta(låtsas = false) {
  if (!låtsas && !window.isSecureContext) {
    visa('GPS fungerar bara när appen ligger på en https-adress. Prova låtsasläget!');
    return;
  }
  if (!låtsas && !navigator.geolocation) { visa('Den här telefonen har ingen GPS för webben'); return; }
  const t = Date.now();
  lopp = { start: t, realStart: t, aktiv: 0, körSedan: null, d: 0, sista: null, punkter: [], splits: [], kmTid: 0, låtsas };
  lopp.körSedan = nu();
  visaSida('spring');
  säg(`Nu kör vi, ${data.namn || 'Oscar'}!`);
  $('paus').textContent = 'Paus';
  $('gps-status').textContent = låtsas ? 'Låtsasläge – ingen riktig GPS' : 'Letar efter GPS ...';
  $('gps-status').className = 'gps';
  if (låtsas) startaLåtsas();
  else gpsId = navigator.geolocation.watchPosition(nyPlats, gpsFel, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  hållSkärmenPå();
  ritTimer = setInterval(uppdateraLopp, 500);
  uppdateraLopp();
}

function gpsFel(e) {
  if (e.code === 1) {
    $('gps-status').textContent = 'GPS är inte tillåten. Slå på platstjänster för Safari i Inställningar.';
    $('gps-status').className = 'gps dålig';
  } else {
    $('gps-status').textContent = 'Svag GPS – försöker igen ...';
    $('gps-status').className = 'gps dålig';
  }
}

// En ny plats från GPS:en
function nyPlats(pos) {
  if (!lopp) return;
  const c = pos.coords, nog = c.accuracy;
  const st = $('gps-status');
  st.textContent = nog <= 15 ? 'GPS: bra' : nog <= 35 ? 'GPS: okej' : 'GPS: svag – vänta lite';
  st.className = 'gps ' + (nog <= 15 ? 'bra' : nog <= 35 ? '' : 'dålig');
  if (!lopp.körSedan || nog > 40) return;                 // Pausad, eller för osäker plats
  const p = [c.latitude, c.longitude], t = nu();
  if (!lopp.sista) {
    lopp.sista = { p, t };
    lopp.punkter.push([+p[0].toFixed(6), +p[1].toFixed(6), Math.round(körtid() * 10) / 10, Math.round(lopp.d)]);
    return;
  }
  const dd = avstånd(lopp.sista.p, p), dt = (t - lopp.sista.t) / 1000;
  if (dd < Math.max(4, nog * 0.4)) return;                // Små hopp är bara GPS-darr
  if (dt > 0 && dd / dt > 9) return;                      // Ingen springer så fort: ett fel i GPS:en
  const förraD = lopp.d, förraT = lopp.punkter.length ? lopp.punkter[lopp.punkter.length - 1][2] : 0;
  lopp.d += dd;
  lopp.sista = { p, t };
  const tid = körtid();
  lopp.punkter.push([+p[0].toFixed(6), +p[1].toFixed(6), Math.round(tid * 10) / 10, Math.round(lopp.d)]);
  // Har vi passerat en hel kilometer?
  while (lopp.d >= (lopp.splits.length + 1) * 1000) {
    const mål = (lopp.splits.length + 1) * 1000;
    const tKm = förraT + (tid - förraT) * (mål - förraD) / (lopp.d - förraD);
    const split = tKm - lopp.kmTid;
    lopp.splits.push(Math.round(split));
    lopp.kmTid = tKm;
    const n = lopp.splits.length;
    säg(`${n} ${n === 1 ? 'kilometer' : 'kilometer'}. Tid ${sägTid(tKm)}. Senaste kilometern ${sägTid(split)}.`);
  }
  if (lopp.låtsas && lopp.d >= 2000) stoppa();
}

function tempoNu() {
  // Tempot de senaste 30 sekunderna
  const p = lopp.punkter;
  if (p.length < 2) return NaN;
  const sista = p[p.length - 1];
  let i = p.length - 2;
  while (i > 0 && sista[2] - p[i][2] < 30) i--;
  const dd = sista[3] - p[i][3], dt = sista[2] - p[i][2];
  if (dd < 25 || körtid() - sista[2] > 20) return NaN;
  return dt / (dd / 1000);
}

function uppdateraLopp() {
  if (!lopp) return;
  const t = körtid();
  $('s-km').textContent = km(lopp.d);
  $('s-tid').textContent = tidText(t);
  $('s-tempo').textContent = tempoText(tempoNu());
  $('s-snitt').textContent = lopp.d > 50 ? tempoText(t / (lopp.d / 1000)) : '–:––';
  $('l-km').textContent = km(lopp.d);
  $('l-tid').textContent = tidText(t);
  if (Date.now() % 2000 < 500) ritaKarta($('s-karta'), lopp.punkter, lopp.splits.length);
  if (!lopp.låtsas && Date.now() - (lopp.sparad || 0) > 10000) {
    lopp.sparad = Date.now();
    try { localStorage.setItem(NYCKEL + '-pågår', JSON.stringify({ ...lopp, sista: null, aktiv: körtid() * 1000, körSedan: null })); } catch (e) { /* fullt */ }
  }
}

function paus() {
  if (!lopp) return;
  if (lopp.körSedan) {
    lopp.aktiv += nu() - lopp.körSedan;
    lopp.körSedan = null;
    $('paus').textContent = 'Fortsätt';
    säg('Paus');
  } else {
    lopp.körSedan = nu();
    lopp.sista = null;                   // Räkna inte vägen man gick medan det var pausat
    $('paus').textContent = 'Paus';
    säg('Nu kör vi igen');
  }
}

async function stoppa() {
  if (!lopp) return;
  if (lopp.körSedan) { lopp.aktiv += nu() - lopp.körSedan; lopp.körSedan = null; }
  if (gpsId !== null) navigator.geolocation.clearWatch(gpsId);
  gpsId = null;
  clearInterval(ritTimer);
  clearInterval(låtsasTimer);
  släppSkärmen();
  $('låst').hidden = true;
  localStorage.removeItem(NYCKEL + '-pågår');
  const l = lopp;
  lopp = null;
  if (l.d < 50) {
    visa('Löpturen var för kort för att sparas');
    visaSida('hem');
    ritaHem();
    return;
  }
  const tur = { id: Date.now().toString(36), start: l.start, tid: Math.round(l.aktiv / 1000), d: Math.round(l.d), splits: l.splits,
                sista: Math.round(l.aktiv / 1000 - l.kmTid), punkter: l.punkter, låtsas: l.låtsas || undefined };
  const nya = nyaRekord(tur);
  data.turer.push(tur);
  spara();
  säg(`Bra sprunget! ${km(tur.d, 1).replace(',', ' komma ')} kilometer.`);
  visaTur(tur, nya);
}

// Håll skärmen tänd (annars slutar GPS:en när telefonen somnar)
async function hållSkärmenPå() {
  try { if ('wakeLock' in navigator) skärmlås = await navigator.wakeLock.request('screen'); } catch (e) { /* går inte */ }
}
function släppSkärmen() {
  try { if (skärmlås) skärmlås.release(); } catch (e) { /* redan släppt */ }
  skärmlås = null;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && lopp) hållSkärmenPå();
});

// Knappar man ska hålla inne (så att de inte trycks av misstag i fickan)
function hållInne(knapp, fyll, tid, klar) {
  let start = null, raf = null;
  const släpp = () => { start = null; cancelAnimationFrame(raf); fyll.style.height = '0'; };
  const steg = () => {
    if (start === null) return;
    const andel = (performance.now() - start) / tid;
    fyll.style.height = Math.min(100, andel * 100) + '%';
    if (andel >= 1) { släpp(); klar(); } else raf = requestAnimationFrame(steg);
  };
  knapp.addEventListener('pointerdown', e => { e.preventDefault(); start = performance.now(); steg(); });
  for (const h of ['pointerup', 'pointerleave', 'pointercancel']) knapp.addEventListener(h, släpp);
  knapp.addEventListener('contextmenu', e => e.preventDefault());
}

// ---------- Låtsasläget: en påhittad löptur runt en sjö ----------
function startaLåtsas() {
  let v = 0, steg = 0;
  const mitt = [59.3326, 18.0649];
  låtsasTimer = setInterval(() => {
    if (!lopp) return;
    steg++;
    v += 0.026 + 0.005 * Math.sin(steg * 0.05);     // Ungefär 3 m/s, ibland lite fortare och ibland lite långsammare
    const r = 0.0032 * (1 + 0.18 * Math.sin(v * 3));
    const lat = mitt[0] + Math.sin(v) * r, lon = mitt[1] + Math.cos(v) * r * 1.9;
    nyPlats({ coords: { latitude: lat, longitude: lon, accuracy: 6 } });
  }, 100);
}

// ===================================================================
// Uträkningar: rekord och fakta
// ===================================================================
// Snabbaste tiden för en sträcka (till exempel 5000 m) någonstans under löpturen
function bästaTid(tur, sträcka) {
  const p = tur.punkter;
  if (!p || tur.d < sträcka) return null;
  let bäst = Infinity, i = 0;
  for (let j = 1; j < p.length; j++) {
    while (i + 1 < j && p[j][3] - p[i + 1][3] >= sträcka) i++;
    const dd = p[j][3] - p[i][3];
    if (dd >= sträcka) bäst = Math.min(bäst, (p[j][2] - p[i][2]) * sträcka / dd);
  }
  return isFinite(bäst) ? bäst : null;
}

const REKORD = [
  { namn: 'Längsta löptur', värde: t => t.d, bättre: (a, b) => a > b, text: v => `${km(v)} km` },
  { namn: 'Längsta tid', värde: t => t.tid, bättre: (a, b) => a > b, text: v => tidText(v) },
  { namn: 'Snabbaste 1 km', värde: t => bästaTid(t, 1000), bättre: (a, b) => a < b, text: v => tidText(v) },
  { namn: 'Snabbaste 5 km', värde: t => bästaTid(t, 5000), bättre: (a, b) => a < b, text: v => tidText(v) },
  { namn: 'Snabbaste 10 km', värde: t => bästaTid(t, 10000), bättre: (a, b) => a < b, text: v => tidText(v) },
];
function bästa(turer, r) {
  let bäst = null;
  for (const t of turer) {
    const v = r.värde(t);
    if (v !== null && v !== undefined && (bäst === null || r.bättre(v, bäst))) bäst = v;
  }
  return bäst;
}
function nyaRekord(tur) {
  const ut = [];
  if (!data.turer.length) return ut;
  for (const r of REKORD) {
    const v = r.värde(tur), förut = bästa(data.turer, r);
    if (v !== null && (förut === null || r.bättre(v, förut))) ut.push(`${r.namn}: ${r.text(v)}`);
  }
  return ut;
}

function fakta(tur) {
  const d = tur.d, kcal = (data.vikt || 80) * d / 1000;
  const totalt = data.turer.reduce((s, t) => s + t.d, 0);
  const f = [
    ['🔥', `Du gjorde av med ungefär <b>${tal(kcal)} kalorier</b>. Det är lika mycket som ${tal(kcal / 280, 1)} kanelbullar!`],
    ['⚽', `Det är lika långt som <b>${tal(d / 105)} fotbollsplaner</b> på rad.`],
    ['👣', `Du tog ungefär <b>${tal(Math.round(d / 1.1 / 10) * 10)} steg</b>.`],
    ['🗼', `Lägger man Eiffeltorn på rad behövs <b>${tal(d / 330, 1)} stycken</b> för att nå lika långt.`],
    ['⚡', `Världens snabbaste människa skulle springa det på <b>${tidText(d / 10.44)}</b> – om han orkade!`],
    ['🐢', `En sköldpadda skulle behöva <b>${tal(d / 270, 1)} timmar</b>. Du var ${tal(tur.tid ? d / 270 * 3600 / tur.tid : 0)} gånger snabbare.`],
    ['🚶', `Promenerar man tar det <b>${tidText(d / 1.4)}</b>. Du sparade ${tidText(Math.max(0, d / 1.4 - tur.tid))}!`],
    ['🌍', `Totalt har du sprungit <b>${km(totalt, 1)} km</b> med Löpkoll. Det är ${tal(totalt / 470000 * 100, 1)} % av vägen Stockholm–Göteborg.`],
  ];
  return f;
}

// ===================================================================
// Rita sidorna
// ===================================================================
function veckoStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);          // Måndag
  return d.getTime();
}

function ritaHem() {
  const namn = data.namn || 'Oscar';
  $('hej').textContent = `Hej ${namn}! 👋`;
  const turer = data.turer;
  const vecka = veckoStart(Date.now());
  const denna = turer.filter(t => t.start >= vecka);
  $('vecka').textContent = denna.length ? `Den här veckan: ${km(denna.reduce((s, t) => s + t.d, 0), 1)} km på ${denna.length} ${denna.length === 1 ? 'tur' : 'turer'}` : 'Ingen löptur den här veckan än. Dags att springa?';
  const tot = turer.reduce((s, t) => s + t.d, 0), tid = turer.reduce((s, t) => s + t.tid, 0);
  $('summa').innerHTML = `<div><b>${km(tot, 1)}</b><small>km totalt</small></div><div><b>${turer.length}</b><small>löpturer</small></div><div><b>${tot ? tempoText(tid / (tot / 1000)) : '–:––'}</b><small>snittempo /km</small></div>`;
  $('rekord').innerHTML = REKORD.map(r => {
    const v = bästa(turer, r);
    return `<div class="rek"><span>${r.namn}</span><span>${v === null ? '–' : r.text(v)}</span></div>`;
  }).join('');
  ritaVeckor();
  if (!turer.length) $('historik').innerHTML = '<div class="tom">Här hamnar dina löpturer. Tryck på STARTA!</div>';
  else $('historik').innerHTML = [...turer].reverse().slice(0, 50).map(t => {
    const d = new Date(t.start);
    return `<div class="tur" data-tur="${t.id}"><div class="km">${km(t.d)}<small style="font-size:13px;color:var(--grå)"> km</small></div>
      <div class="info"><b>${d.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'short' })}</b>${t.låtsas ? ' (låtsas)' : ''}<br>
      ${tidText(t.tid)} · ${tempoText(t.tid / (t.d / 1000))} /km</div><span>›</span></div>`;
  }).join('');
  $('namn').value = data.namn || '';
  $('vikt').value = data.vikt || '';
  $('röst').checked = !!data.röst;
  $('gps-info').textContent = window.isSecureContext ? '' : 'Obs: GPS fungerar först när appen ligger på en https-adress. Prova låtsasläget så länge!';
}

function ritaVeckor() {
  const c = $('veckodiagram'), dpr = devicePixelRatio || 1;
  const w = c.clientWidth || 300, h = 140;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext('2d');
  x.scale(dpr, dpr);
  const vecka = veckoStart(Date.now()), V = 7 * 864e5;
  const veckor = [];
  for (let i = 7; i >= 0; i--) {
    const s = vecka - i * V;
    veckor.push({ s, d: data.turer.filter(t => t.start >= s && t.start < s + V).reduce((a, t) => a + t.d, 0) });
  }
  const max = Math.max(5000, ...veckor.map(v => v.d));
  const bw = w / veckor.length;
  x.font = '11px -apple-system, sans-serif';
  x.textAlign = 'center';
  veckor.forEach((v, i) => {
    const bh = (h - 36) * v.d / max;
    x.fillStyle = i === veckor.length - 1 ? '#ff7a1a' : '#4a5562';
    x.beginPath();
    x.roundRect ? x.roundRect(i * bw + 6, h - 20 - bh, bw - 12, Math.max(bh, 2), 4) : x.rect(i * bw + 6, h - 20 - bh, bw - 12, Math.max(bh, 2));
    x.fill();
    x.fillStyle = '#8b949e';
    const d = new Date(v.s);
    x.fillText(i === veckor.length - 1 ? 'nu' : `v${veckonummer(d)}`, i * bw + bw / 2, h - 5);
    if (v.d) { x.fillStyle = '#f2f4f6'; x.fillText(km(v.d, v.d >= 10000 ? 0 : 1), i * bw + bw / 2, h - 25 - bh); }
  });
}
function veckonummer(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}

// Rita löprundan som en linje (utan karta under)
function ritaKarta(c, punkter, antalKm) {
  const dpr = devicePixelRatio || 1, w = c.clientWidth || 300, h = c.clientHeight || 200;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext('2d');
  x.scale(dpr, dpr);
  if (!punkter || punkter.length < 2) {
    x.fillStyle = '#8b949e'; x.font = '14px -apple-system, sans-serif'; x.textAlign = 'center';
    x.fillText('Här ritas din runda', w / 2, h / 2);
    return;
  }
  const lat0 = punkter[0][0], k = Math.cos(lat0 * Math.PI / 180);
  const xy = punkter.map(p => [(p[1] - punkter[0][1]) * 111320 * k, -(p[0] - lat0) * 110540]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [a, b] of xy) { minX = Math.min(minX, a); maxX = Math.max(maxX, a); minY = Math.min(minY, b); maxY = Math.max(maxY, b); }
  const sk = Math.min((w - 40) / Math.max(maxX - minX, 50), (h - 40) / Math.max(maxY - minY, 50));
  const ox = w / 2 - (minX + maxX) / 2 * sk, oy = h / 2 - (minY + maxY) / 2 * sk;
  // Rutnät, som på en karta
  x.strokeStyle = '#262c34'; x.lineWidth = 1;
  const ruta = 100 * sk >= 30 ? 100 : 500;
  for (let gx = Math.floor(minX / ruta) * ruta - ruta * 5; gx < maxX + ruta * 5; gx += ruta) { x.beginPath(); x.moveTo(ox + gx * sk, 0); x.lineTo(ox + gx * sk, h); x.stroke(); }
  for (let gy = Math.floor(minY / ruta) * ruta - ruta * 5; gy < maxY + ruta * 5; gy += ruta) { x.beginPath(); x.moveTo(0, oy + gy * sk); x.lineTo(w, oy + gy * sk); x.stroke(); }
  x.lineJoin = x.lineCap = 'round';
  x.strokeStyle = '#ff7a1a55'; x.lineWidth = 9;
  x.beginPath(); xy.forEach(([a, b], i) => i ? x.lineTo(ox + a * sk, oy + b * sk) : x.moveTo(ox + a * sk, oy + b * sk)); x.stroke();
  x.strokeStyle = '#ff7a1a'; x.lineWidth = 4; x.stroke();
  // Kilometerprickar
  x.font = 'bold 10px -apple-system, sans-serif'; x.textAlign = 'center';
  let nästa = 1000;
  for (let i = 0; i < punkter.length; i++) {
    if (punkter[i][3] >= nästa) {
      const [a, b] = xy[i];
      x.fillStyle = '#fff'; x.beginPath(); x.arc(ox + a * sk, oy + b * sk, 8, 0, 7); x.fill();
      x.fillStyle = '#111'; x.fillText(nästa / 1000, ox + a * sk, oy + b * sk + 3.5);
      nästa += 1000;
    }
  }
  const [sa, sb] = xy[0], [ea, eb] = xy[xy.length - 1];
  x.fillStyle = '#3ddc84'; x.beginPath(); x.arc(ox + sa * sk, oy + sb * sk, 6, 0, 7); x.fill();
  x.fillStyle = '#f0484f'; x.beginPath(); x.arc(ox + ea * sk, oy + eb * sk, 6, 0, 7); x.fill();
  // Skala
  x.fillStyle = '#8b949e'; x.font = '11px -apple-system, sans-serif'; x.textAlign = 'left';
  x.fillText(`rutor: ${ruta} m`, 8, h - 8);
}

let visadTur = null;
function visaTur(tur, nya = []) {
  visadTur = tur;
  visaSida('klar');
  const d = new Date(tur.start);
  const namn = data.namn || 'Oscar';
  $('k-rubrik').textContent = nya.length ? `Grymt, ${namn}! 🏆` : `Bra sprunget, ${namn}! 💪`;
  $('k-datum').textContent = d.toLocaleString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + (tur.låtsas ? ' (låtsas)' : '');
  $('k-rekord').hidden = !nya.length;
  $('k-rekord').innerHTML = nya.length ? '🏆 Nytt rekord!<br>' + nya.map(skydda).join('<br>') : '';
  const kmh = tur.d / tur.tid * 3.6;
  $('k-siffror').innerHTML = [
    [km(tur.d), 'km'], [tidText(tur.tid), 'tid'], [tempoText(tur.tid / (tur.d / 1000)), 'snittempo /km'],
    [tal(kmh, 1), 'km/h'], [tal((data.vikt || 80) * tur.d / 1000), 'kalorier'], [bästaTid(tur, 1000) ? tidText(bästaTid(tur, 1000)) : '–', 'snabbaste km'],
  ].map(([v, t]) => `<div><b>${v}</b><small>${t}</small></div>`).join('');
  // Varje kilometer, med en stapel: kortare stapel = snabbare
  const s = tur.splits || [];
  if (!s.length) $('k-km').innerHTML = '<div class="tips">Spring minst 1 km så syns varje kilometer här.</div>';
  else {
    const max = Math.max(...s), min = Math.min(...s);
    const rader = s.map((t, i) => `<div class="split"><span>${i + 1}</span><div class="stapel${t === min ? ' bäst' : ''}" style="width:${(t / max * 100).toFixed(0)}%"></div><span>${tidText(t)}</span></div>`);
    const rest = tur.d - s.length * 1000;
    if (rest > 50 && tur.sista > 0) rader.push(`<div class="split"><span style="color:var(--grå)">+${tal(rest)} m</span><div></div><span>${tempoText(tur.sista / (rest / 1000))}/km</span></div>`);
    $('k-km').innerHTML = rader.join('');
  }
  $('k-fakta').innerHTML = fakta(tur).map(([e, t]) => `<div class="fakta"><span>${e}</span><span>${t}</span></div>`).join('');
  requestAnimationFrame(() => ritaKarta($('k-karta'), tur.punkter, (tur.splits || []).length));
}

// ===================================================================
// Knapparna
// ===================================================================
$('starta').addEventListener('click', () => starta(false));
$('låtsas').addEventListener('click', () => starta(true));
$('paus').addEventListener('click', paus);
hållInne($('stopp'), $('stopp-fyll'), 1200, stoppa);
$('lås').addEventListener('click', () => { $('låst').hidden = false; });
hållInne($('låsupp'), $('låsupp-fyll'), 1500, () => { $('låst').hidden = true; });
$('k-tillbaka').addEventListener('click', () => { visaSida('hem'); ritaHem(); });
$('k-ta-bort').addEventListener('click', async () => {
  if (!visadTur || !(await fråga('Ta bort den här löpturen? Det går inte att ångra.', 'Ta bort'))) return;
  data.turer = data.turer.filter(t => t !== visadTur);
  spara();
  visaSida('hem');
  ritaHem();
  visa('Löpturen är borttagen');
});
$('historik').addEventListener('click', e => {
  const rad = e.target.closest('[data-tur]');
  const tur = rad && data.turer.find(t => t.id === rad.dataset.tur);
  if (tur) visaTur(tur);
});
$('namn').addEventListener('change', () => { data.namn = $('namn').value.trim(); spara(); ritaHem(); });
$('vikt').addEventListener('change', () => {
  const v = parseInt($('vikt').value, 10);
  data.vikt = v >= 20 && v <= 250 ? v : 80;
  spara(); ritaHem();
});
$('röst').addEventListener('change', () => { data.röst = $('röst').checked; spara(); if (data.röst) säg('Rösten är på'); });
$('hälsning-ok').addEventListener('click', () => { $('hälsning').hidden = true; data.sett = true; spara(); });
addEventListener('resize', () => { if (!$('hem').hidden) ritaVeckor(); });

// ---------- Start ----------
ritaHem();
if (!data.sett) {
  $('hälsning-rubrik').textContent = HÄLSNING_RUBRIK;
  $('hälsning-text').textContent = HÄLSNING_TEXT;
  $('hälsning').hidden = false;
}
// Stängdes appen mitt i en löptur? Då kan man spara det man hann springa.
(async () => {
  let gammal = null;
  try { gammal = JSON.parse(localStorage.getItem(NYCKEL + '-pågår')); } catch (e) { /* inget */ }
  if (!gammal || !(gammal.d >= 50)) return;
  if (await fråga(`Appen stängdes mitt i en löptur (${km(gammal.d)} km). Vill du spara den?`, 'Spara')) {
    const tur = { id: Date.now().toString(36), start: gammal.start, tid: Math.round(gammal.aktiv / 1000), d: Math.round(gammal.d), splits: gammal.splits || [],
                  sista: Math.round(gammal.aktiv / 1000 - (gammal.kmTid || 0)), punkter: gammal.punkter || [] };
    data.turer.push(tur);
    spara();
    ritaHem();
  }
  localStorage.removeItem(NYCKEL + '-pågår');
})();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
