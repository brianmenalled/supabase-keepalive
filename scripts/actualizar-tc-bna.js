// Actualiza tc_bna en Supabase (STATUS COMEX) usando la misma fuente que ya usa
// el DolarBot existente (ArgentinaDatos -> "oficial" venta), con propagacion de
// fin de semana / feriado (sin dato real ese dia -> se repite el ultimo valor conocido).

const SB_URL = 'https://vkpbyyclghbihglewipb.supabase.co';
const SB_KEY = 'sb_publishable_QzPcc8tirq3MhR3KUrzQqg_j1ktAJEf';
const SB_H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

function fechaArgentinaHoy() {
  // Argentina es UTC-3 fijo (sin horario de verano)
  const ahoraUtc = new Date();
  const ahoraArg = new Date(ahoraUtc.getTime() - 3 * 60 * 60 * 1000);
  return ahoraArg.toISOString().slice(0, 10); // YYYY-MM-DD
}
function sumarDias(fechaISO, dias) {
  const d = new Date(fechaISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function obtenerMaxFechaEnDB() {
  const r = await fetch(`${SB_URL}/rest/v1/tc_bna?select=fecha&order=fecha.desc&limit=1`, { headers: SB_H });
  if (!r.ok) throw new Error('No se pudo leer tc_bna: ' + (await r.text()));
  const rows = await r.json();
  return rows.length ? rows[0].fecha : '2023-01-01'; // fallback si la tabla estuviera vacia
}

async function obtenerSerieArgentinaDatos() {
  const r = await fetch('https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial');
  if (!r.ok) throw new Error('No se pudo consultar ArgentinaDatos: ' + (await r.text()));
  const data = await r.json();
  const mapa = {};
  for (const row of data) {
    // fecha viene como "YYYY-MM-DD"
    const fecha = String(row.fecha).slice(0, 10);
    if (row.venta != null) mapa[fecha] = Number(row.venta);
  }
  return mapa;
}

async function obtenerUltimoValorConocido(hastaFecha) {
  const r = await fetch(`${SB_URL}/rest/v1/tc_bna?select=fecha,valor&fecha=lte.${hastaFecha}&order=fecha.desc&limit=1`, { headers: SB_H });
  if (!r.ok) throw new Error('No se pudo leer ultimo valor conocido: ' + (await r.text()));
  const rows = await r.json();
  return rows.length ? Number(rows[0].valor) : null;
}

async function upsertFilas(filas) {
  if (!filas.length) return;
  const r = await fetch(`${SB_URL}/rest/v1/tc_bna?on_conflict=fecha`, {
    method: 'POST',
    headers: { ...SB_H, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(filas),
  });
  if (!r.ok) throw new Error('No se pudo guardar en tc_bna: ' + (await r.text()));
  return r.json();
}

async function main() {
  const hoy = fechaArgentinaHoy();
  const maxFechaDB = await obtenerMaxFechaEnDB();
  console.log('Fecha (ART) de hoy:', hoy);
  console.log('Ultima fecha ya cargada en tc_bna:', maxFechaDB);

  if (maxFechaDB >= hoy) {
    console.log('tc_bna ya esta al dia. Nada para hacer.');
    return;
  }

  const serie = await obtenerSerieArgentinaDatos();
  let ultimoValor = await obtenerUltimoValorConocido(maxFechaDB);

  const filas = [];
  let cursor = sumarDias(maxFechaDB, 1);
  while (cursor <= hoy) {
    const valorReal = serie[cursor];
    if (valorReal != null) {
      ultimoValor = valorReal;
      filas.push({ fecha: cursor, valor: ultimoValor });
    } else if (ultimoValor != null) {
      // fin de semana / feriado / sin dato en la API -> propaga el ultimo valor conocido
      filas.push({ fecha: cursor, valor: ultimoValor });
    } else {
      console.warn('Sin valor real ni valor previo para propagar en', cursor, '- se omite.');
    }
    cursor = sumarDias(cursor, 1);
  }

  console.log(`Insertando/actualizando ${filas.length} dia(s):`, filas.map(f => `${f.fecha}=${f.valor}`).join(', '));
  await upsertFilas(filas);
  console.log('Listo.');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
