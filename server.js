require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const NEGOCIO_ID = process.env.NEGOCIO_ID;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const MI_NUMERO = process.env.MI_NUMERO;
const ALIAS_MP = process.env.ALIAS_MERCADOPAGO || '';
const ALIAS_NOMBRE = process.env.ALIAS_NOMBRE || '';
const BOT_DESDE = process.env.HORARIO_BOT_DESDE || '07:00';
const BOT_HASTA = process.env.HORARIO_BOT_HASTA || '22:00';
const HORARIOS_PERMITIDOS = process.env.HORARIOS_PERMITIDOS
  ? process.env.HORARIOS_PERMITIDOS.split(',').map(h => h.trim())
  : null;

// Meta WhatsApp API
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'groomercopilot2026';

const INFO_NEGOCIO = {
  direccion: process.env.NEGOCIO_DIRECCION || '',
  referencia: process.env.NEGOCIO_REFERENCIA || '',
  maps: process.env.NEGOCIO_MAPS || '',
  instagram: process.env.NEGOCIO_INSTAGRAM || '',
  facebook: process.env.NEGOCIO_FACEBOOK || '',
  formasPago: process.env.NEGOCIO_FORMAS_PAGO || 'Efectivo y transferencia',
  recargoCuotas: process.env.NEGOCIO_RECARGO_CUOTAS || '',
  politicaCancelacion: process.env.NEGOCIO_CANCELACION || 'Avisame con al menos 2 horas de anticipación si no podés venir',
  noShow: process.env.NEGOCIO_NO_SHOW || 'En caso de no presentarse sin aviso se aplica una penalización para el próximo turno',
  politicaCompleta: process.env.NEGOCIO_POLITICA_COMPLETA || '',
  clienteEspera: process.env.NEGOCIO_CLIENTE_ESPERA || '',
  llegadaTarde: process.env.NEGOCIO_LLEGADA_TARDE || 'Si llegás más de 15 minutos tarde el turno puede perderse',
  vacunasRequeridas: process.env.NEGOCIO_VACUNAS || 'No requerimos libreta sanitaria',
  edadMinimaCachorro: process.env.NEGOCIO_EDAD_MIN || '3 meses',
  otrosDatos: process.env.NEGOCIO_OTROS || '',
};

// ── Estado en memoria ────────────────────────────────────────
const fichasEnProceso = {};
let esperandoRespuestaConsejo = false;
let listaEsperaPendiente = null;

// ── Ping Supabase cada 3 días ────────────────────────────────
setInterval(async () => {
  try {
    await supabase.from('negocios').select('id').limit(1);
    console.log('💓 Ping Supabase OK');
  } catch (e) { console.error('Error ping:', e.message); }
}, 1000 * 60 * 60 * 24 * 3);

// ── Enviar mensaje via API de Meta ───────────────────────────
async function enviarMensaje(telefono, texto) {
  try {
    const response = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: telefono,
        type: 'text',
        text: { body: texto }
      })
    });
    const data = await response.json();
    if (data.error) console.error('Error Meta API:', data.error);
    return data;
  } catch (e) {
    console.error('Error enviando mensaje:', e.message);
  }
}

async function enviarImagen(telefono, urlImagen, caption) {
  try {
    await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: telefono,
        type: 'image',
        image: { url: urlImagen, caption: caption || '' }
      })
    });
  } catch (e) { console.error('Error enviando imagen:', e.message); }
}

// ── Descargar media de Meta ──────────────────────────────────
async function descargarMedia(mediaId) {
  try {
    // Obtener URL del media
    const urlRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
    });
    const urlData = await urlRes.json();

    // Descargar el archivo
    const mediaRes = await fetch(urlData.url, {
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
    });
    const buffer = await mediaRes.arrayBuffer();
    return {
      data: Buffer.from(buffer).toString('base64'),
      mimetype: urlData.mime_type || 'image/jpeg'
    };
  } catch (e) {
    console.error('Error descargando media:', e.message);
    return null;
  }
}

// ── Verificar horario ────────────────────────────────────────
function botActivo() {
  const hora = new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  return hora >= BOT_DESDE && hora < BOT_HASTA;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Detectar cliente conocido ────────────────────────────────
function pareceClienteConocido(texto) {
  const t = texto.toLowerCase();
  return [
    /\baxel\b/, /\bpara\s+[a-záéíóúñ]+\b/i,
    /\bhace\s+(rato|tiempo|mucho)\b/, /\bcomo\s+siempre\b/,
    /\bquiero\s+turno\s+para\s+[a-záéíóúñ]+/i,
    /\bestá\s+peludo\b/, /\bnecesita\s+corte\b/,
  ].some(r => r.test(t));
}

// ── Analizar foto con Claude Vision ─────────────────────────
async function analizarFotoPerro(mediaBase64, mimetype) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimetype, data: mediaBase64 } },
          { type: 'text', text: `Sos un peluquero canino experto. Analizá esta foto y respondé en español rioplatense, máximo 3 líneas:
1. Raza probable
2. Tamaño (mini/pequeño/mediano/grande)
3. Estado del pelaje y servicio recomendado
Formato: "Parece un [raza], [tamaño]. El pelaje está [estado], le vendría bien [servicio]."
Si no hay perro respondé solo: "NO_ES_PERRO"` }
        ]
      }]
    });
    const texto = response.content[0].text;
    if (texto.includes('NO_ES_PERRO')) return null;
    return texto;
  } catch (e) { console.error('Error foto:', e.message); return null; }
}

// ── Google Calendar ──────────────────────────────────────────
function getGoogleAuth() {
  const creds = process.env.GOOGLE_CREDENTIALS
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
    : JSON.parse(fs.readFileSync('credentials.json'));
  const { client_secret, client_id } = creds.web;
  const auth = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3000/callback');
  const token = process.env.GOOGLE_TOKEN
    ? JSON.parse(process.env.GOOGLE_TOKEN)
    : JSON.parse(fs.readFileSync('token.json'));
  auth.setCredentials(token);
  return auth;
}

async function getEventosCalendar() {
  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const ahora = new Date();
    const hasta = new Date();
    hasta.setDate(hasta.getDate() + 7);
    const { data } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: ahora.toISOString(),
      timeMax: hasta.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    const eventos = data.items || [];
    console.log(`📅 Calendar: ${eventos.length} eventos encontrados`);
    eventos.forEach(e => console.log(`  - ${e.summary} → ${e.start.dateTime || e.start.date}`));
    return eventos;
  } catch (e) { console.error('Error Calendar:', e.message); return []; }
}

async function crearEventoCalendar(titulo, inicio, fin, descripcion) {
  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const { data } = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: titulo, description: descripcion,
        start: { dateTime: inicio, timeZone: 'America/Argentina/Buenos_Aires' },
        end: { dateTime: fin, timeZone: 'America/Argentina/Buenos_Aires' },
      },
    });
    return data.id;
  } catch (e) { console.error('Error evento:', e.message); return null; }
}

// ── Supabase helpers ─────────────────────────────────────────
async function getNegocio() {
  const { data } = await supabase.from('negocios').select('*').eq('id', NEGOCIO_ID).single();
  return data;
}

async function getOCreateCliente(telefono) {
  const { data: existente } = await supabase
    .from('clientes').select('*, mascotas(*)')
    .eq('negocio_id', NEGOCIO_ID).eq('telefono', telefono).single();
  if (existente) return existente;
  const { data: nuevo } = await supabase
    .from('clientes').insert({ negocio_id: NEGOCIO_ID, telefono, tipo: 'nuevo' })
    .select('*, mascotas(*)').single();
  return nuevo;
}

async function getHistorial(telefono) {
  const { data } = await supabase
    .from('conversaciones').select('rol, contenido')
    .eq('negocio_id', NEGOCIO_ID).eq('telefono', telefono)
    .order('creado_en', { ascending: true }).limit(20);
  return data || [];
}

async function guardarMensaje(telefono, clienteId, rol, contenido) {
  await supabase.from('conversaciones').insert({
    negocio_id: NEGOCIO_ID, cliente_id: clienteId || null,
    telefono, rol, contenido, tipo: 'texto'
  });
}

async function actualizarCliente(clienteId, campos) {
  if (!clienteId) return;
  await supabase.from('clientes').update(campos).eq('id', clienteId);
}

async function guardarMascota(clienteId, nombre, razaTexto, tamanio, notas) {
  if (!nombre || !clienteId) return;
  const { data: existente } = await supabase
    .from('mascotas').select('id').eq('cliente_id', clienteId).eq('nombre', nombre).single();
  if (existente) {
    if (notas) await supabase.from('mascotas').update({ notas }).eq('id', existente.id);
    return existente.id;
  }
  const { data } = await supabase.from('mascotas').insert({
    cliente_id: clienteId, negocio_id: NEGOCIO_ID,
    nombre, raza_texto: razaTexto || null, tamanio: tamanio || null, notas: notas || null
  }).select('id').single();
  return data?.id;
}

async function getUltimaFicha(mascotaId) {
  const { data } = await supabase.from('fichas_servicio').select('*')
    .eq('mascota_id', mascotaId).order('fecha', { ascending: false }).limit(1).single();
  return data;
}

async function getHerramientas() {
  const { data } = await supabase.from('herramientas_negocio').select('*')
    .eq('negocio_id', NEGOCIO_ID).eq('activo', true);
  return data || [];
}

async function getTurnosHoy() {
  const tz = 'America/Argentina/Buenos_Aires';
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const { data } = await supabase.from('turnos').select('*, clientes(*), mascotas(*)')
    .eq('negocio_id', NEGOCIO_ID)
    .gte('fecha_hora_inicio', `${hoy}T00:00:00`)
    .lte('fecha_hora_inicio', `${hoy}T23:59:59`)
    .in('estado', ['pendiente', 'confirmado'])
    .order('fecha_hora_inicio', { ascending: true });
  return data || [];
}

async function registrarFalta(turnoId, clienteId, mascotaId) {
  await supabase.from('turnos').update({ estado: 'cancelado', notas: 'No se presentó sin aviso' }).eq('id', turnoId);
  await supabase.from('fichas_servicio').insert({
    negocio_id: NEGOCIO_ID, turno_id: turnoId, mascota_id: mascotaId, cliente_id: clienteId,
    fecha: new Date().toISOString().split('T')[0],
    comportamiento: 'no_se_presento', notas: 'No se presentó sin aviso'
  });
  await supabase.from('clientes').update({ notas: 'FALTA_SIN_AVISO — requiere seña en próximo turno' }).eq('id', clienteId);
}

async function guardarFichaServicio(datos) {
  const { data } = await supabase.from('fichas_servicio').insert(datos).select('id').single();
  return data?.id;
}

// ── Lista de espera ──────────────────────────────────────────
async function agregarListaEspera(clienteId, telefono, fechaPreferida, horarioPreferido, flexibilidad) {
  try {
    const { data: existente } = await supabase.from('lista_espera').select('id')
      .eq('negocio_id', NEGOCIO_ID).eq('telefono', telefono).eq('estado', 'esperando').single();
    if (existente) return;
    await supabase.from('lista_espera').insert({
      negocio_id: NEGOCIO_ID, cliente_id: clienteId, telefono,
      fecha_preferida: fechaPreferida || null,
      horario_preferido: horarioPreferido || null,
      flexibilidad: flexibilidad || 'cualquier horario',
    });
  } catch (e) { console.error('Error lista espera:', e.message); }
}

const RECORDATORIO_HORAS = parseInt(process.env.RECORDATORIO_HORAS || '24');

// ── Obtener precios y penalizaciones ────────────────────────
async function getPrecioServicio(servicioNombre, tamanio) {
  try {
    // Buscar el servicio por nombre
    const { data: servicio } = await supabase
      .from('servicios').select('id')
      .eq('negocio_id', NEGOCIO_ID)
      .ilike('nombre', `%${servicioNombre}%`)
      .single();
    if (!servicio) return null;

    const { data: precio } = await supabase
      .from('precios_servicios').select('precio_min, precio_max')
      .eq('negocio_id', NEGOCIO_ID)
      .eq('servicio_id', servicio.id)
      .eq('tamanio', tamanio)
      .single();

    return precio || null;
  } catch (e) { return null; }
}

async function getPenalizaciones() {
  try {
    const { data } = await supabase
      .from('penalizaciones').select('nombre, precio')
      .eq('negocio_id', NEGOCIO_ID).eq('activo', true);
    return data || [];
  } catch (e) { return []; }
}

async function getRazasExcluidas() {
  try {
    const { data } = await supabase
      .from('razas_excluidas').select('raza_texto')
      .eq('negocio_id', NEGOCIO_ID);
    return data?.map(r => r.raza_texto) || [];
  } catch (e) { return []; }
}

async function buildInfoPrecios() {
  try {
    const tamanios = ['Mini', 'Pequeño', 'Mediano', 'Grande', 'Gigante'];
    const { data: servicios } = await supabase
      .from('servicios').select('id, nombre')
      .eq('negocio_id', NEGOCIO_ID).eq('activo', true);

    if (!servicios?.length) return '';

    const penalizaciones = await getPenalizaciones();
    const razasExcluidas = await getRazasExcluidas();

    // Traer todos los precios de una sola vez
    const { data: todosPrecios } = await supabase
      .from('precios_servicios').select('servicio_id, tamanio, precio_min, precio_max')
      .eq('negocio_id', NEGOCIO_ID);

    let info = `PRECIOS (consultá siempre estos precios, no inventes):\n`;

    for (const servicio of servicios) {
      info += `\n${servicio.nombre}:\n`;
      for (const tam of tamanios) {
        const precio = (todosPrecios || []).find(
          p => p.servicio_id === servicio.id && p.tamanio === tam
        );
        if (precio) {
          const precioStr = precio.precio_min === precio.precio_max
            ? `$${precio.precio_min.toLocaleString('es-AR')}`
            : `$${precio.precio_min.toLocaleString('es-AR')} a $${precio.precio_max.toLocaleString('es-AR')}`;
          info += `  ${tam}: ${precioStr}\n`;
        }
      }
    }

    if (penalizaciones.length > 0) {
      info += `\nPENALIZACIONES (se suman al precio base):\n`;
      penalizaciones.forEach(p => info += `  ${p.nombre}: +$${p.precio.toLocaleString('es-AR')}\n`);
    }

    if (razasExcluidas.length > 0) {
      info += `\nRAZAS QUE NO ATENDÉS: ${razasExcluidas.join(', ')}\n`;
      info += `Si un cliente consulta por estas razas decile amablemente que no trabajás con esa raza.\n`;
      info += `Excepción: si el cliente tiene nota de "Excepción aprobada" en su ficha, sí lo atendés.\n`;
    }

    return info;
  } catch (e) {
    console.error('Error precios:', e.message);
    return '';
  }
}
async function enviarRecordatorios() {
  try {
    const tz = 'America/Argentina/Buenos_Aires';
    const ahora = new Date();

    // Calcular la ventana de tiempo: turnos que empiezan en exactamente RECORDATORIO_HORAS horas
    const desde = new Date(ahora.getTime() + (RECORDATORIO_HORAS - 0.5) * 60 * 60 * 1000);
    const hasta = new Date(ahora.getTime() + (RECORDATORIO_HORAS + 0.5) * 60 * 60 * 1000);

    const { data: turnos } = await supabase
      .from('turnos').select('*, clientes(*), mascotas(*)')
      .eq('negocio_id', NEGOCIO_ID)
      .gte('fecha_hora_inicio', desde.toISOString())
      .lte('fecha_hora_inicio', hasta.toISOString())
      .in('estado', ['pendiente', 'confirmado'])
      .is('recordatorio_enviado', null);

    if (!turnos?.length) return;

    for (const turno of turnos) {
      const telefono = turno.clientes?.telefono;
      if (!telefono) continue;

      const nombre = turno.clientes?.nombre?.split(' ')[0] || 'Hola';
      const mascota = turno.mascotas?.nombre || 'tu perrito';
      const hora = new Date(turno.fecha_hora_inicio).toLocaleTimeString('es-AR', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
      });
      const dia = new Date(turno.fecha_hora_inicio).toLocaleDateString('es-AR', {
        timeZone: tz, weekday: 'long', day: 'numeric', month: 'long'
      });

      const mensaje = `Hola ${nombre}! Te recuerdo que ${RECORDATORIO_HORAS <= 24 ? 'mañana' : `el ${dia}`} tenés turno a las ${hora}hs para ${mascota}. Te esperamos! 🐾`;

      await enviarMensaje(telefono, mensaje);

      // Marcar el turno como recordatorio enviado
      await supabase.from('turnos').update({ notas: (turno.notas || '') + ' | recordatorio_enviado' }).eq('id', turno.id);

      console.log(`🔔 Recordatorio enviado a ${nombre} (${telefono}) — ${hora}hs`);
    }
  } catch (e) { console.error('Error recordatorios:', e.message); }
}

// Ejecutar cada hora
setInterval(enviarRecordatorios, 60 * 60 * 1000);
// También al arrancar
setTimeout(enviarRecordatorios, 10000);
async function enviarResumenDia() {
  if (!MI_NUMERO) return;
  try {
    const negocio = await getNegocio();
    const turnos = await getTurnosHoy();
    const tz = 'America/Argentina/Buenos_Aires';
    let mensaje = `🐾 *Buenos días ${negocio.nombre_agente}!*\n\n`;
    if (turnos.length === 0) {
      mensaje += `Para hoy no hay turnos agendados.\n\n`;
    } else {
      mensaje += `*Turnos de hoy:*\n\n`;
      for (let i = 0; i < turnos.length; i++) {
        const t = turnos[i];
        const hora = new Date(t.fecha_hora_inicio).toLocaleTimeString('es-AR', {
          timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
        });
        mensaje += `*${i + 1}. ${hora}hs — ${t.mascotas?.nombre || 'Mascota'}* (${t.mascotas?.raza_texto || 'sin raza'})\n`;
        mensaje += `   👤 ${t.clientes?.nombre || 'Sin nombre'}\n`;
        if (t.mascotas?.id) {
          const ficha = await getUltimaFicha(t.mascotas.id);
          if (ficha) {
            const dias = Math.round((new Date() - new Date(ficha.fecha)) / (1000 * 60 * 60 * 24));
            mensaje += `   📋 Última vez: hace ${dias} días — ${ficha.servicio || 'sin datos'}\n`;
            if (ficha.comportamiento && ficha.comportamiento !== 'tranquilo') mensaje += `   ⚠️ ${ficha.comportamiento}\n`;
          } else { mensaje += `   ⭐ Primera vez\n`; }
        }
        if (t.clientes?.telefono) mensaje += `   👉 /admin ver|${t.clientes.telefono}\n`;
        mensaje += '\n';
      }
      mensaje += `📊 *Total: ${turnos.length} turno${turnos.length > 1 ? 's' : ''}*\n\n`;
    }
    mensaje += `¿Querés un consejo para conseguir más clientes hoy?\nRespondé *si* o *no*`;
    await enviarMensaje(MI_NUMERO, mensaje);
    esperandoRespuestaConsejo = true;
    programarAvisosTurnos(turnos);
    console.log('📋 Resumen del día enviado');
  } catch (e) { console.error('Error resumen:', e.message); }
}

function programarAvisosTurnos(turnos) {
  const tz = 'America/Argentina/Buenos_Aires';
  turnos.forEach(t => {
    const msHasta = new Date(t.fecha_hora_inicio) - new Date();
    if (msHasta > 0) {
      setTimeout(async () => {
        const hora = new Date(t.fecha_hora_inicio).toLocaleTimeString('es-AR', {
          timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
        });
        await enviarMensaje(MI_NUMERO,
          `🔔 *Turno ahora: ${hora}hs*\n\n${t.mascotas?.nombre} — ${t.clientes?.nombre}\n\n` +
          `¿Vino?\n/asistio|${t.id}|${t.clientes?.telefono}\n/falto|${t.id}|${t.clientes?.telefono}`
        );
      }, msHasta);
    }
  });
}

// ── Consejo de marketing ─────────────────────────────────────
async function generarConsejo(negocio) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 300,
      messages: [{ role: 'user', content: `Sos un experto en marketing para pequeños negocios. Generá UN consejo práctico para hoy para una peluquería canina llamada "${negocio.nombre}". Máximo 4 líneas. Español rioplatense. Sin título ni listas.` }]
    });
    return response.content[0].text;
  } catch (e) { return null; }
}

// ── Agenda ───────────────────────────────────────────────────
function calcularHorariosDisponibles(eventos, negocio) {
  const tz = 'America/Argentina/Buenos_Aires';
  const apertura = negocio.horario_apertura.slice(0, 5);
  const cierre = negocio.horario_cierre.slice(0, 5);
  const cierreH = parseInt(cierre.split(':')[0]);

  function toMin(h) { const [hh, mm] = h.split(':').map(Number); return hh * 60 + mm; }
  function toStr(m) { return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }

  const aperturaMin = toMin(apertura);
  const cierreMin = toMin(cierre);
  const porDia = {};

  (eventos || []).forEach(ev => {
    if (!ev.start.dateTime || !ev.end.dateTime) return;
    const ini = new Date(ev.start.dateTime);
    const fin = new Date(ev.end.dateTime);
    const hi = ini.toLocaleTimeString('es-AR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const hf = fin.toLocaleTimeString('es-AR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const iniMin = toMin(hi); const finMin = toMin(hf);
    if (finMin <= aperturaMin || iniMin >= cierreMin) return;
    const dia = ini.toLocaleDateString('es-AR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
    if (!porDia[dia]) porDia[dia] = [];
    porDia[dia].push({ inicio: hi, fin: hf, iniMin, finMin, titulo: ev.summary || 'Ocupado' });
  });

  let agenda = `HORARIO: ${apertura} a ${cierre}hs\n`;
  agenda += `ÚLTIMO INICIO: Baño ${cierreH-1}:00hs · Baño y corte ${cierreH-2}:00hs\n`;
  agenda += `NUNCA ofrezcas turno que termine después de las ${cierre}hs.\n`;
  if (HORARIOS_PERMITIDOS?.length > 0) agenda += `HORARIOS HABILITADOS: ${HORARIOS_PERMITIDOS.join(', ')}hs\n`;
  agenda += `⚠️ Solo ofrecé los horarios que aparecen como "✓ Disponibles". Si un día dice "✓ Disponibles: 16:00hs" ESE DÍA SOLO HAY LUGAR A LAS 16HS.\n\n`;

  if (Object.keys(porDia).length === 0) {
    agenda += `Sin eventos. Libre en horarios habilitados.`;
  } else {
    Object.entries(porDia).forEach(([dia, evs]) => {
      const bloques = evs.sort((a, b) => a.iniMin - b.iniMin);
      agenda += `${dia.toUpperCase()}:\n`;
      bloques.forEach(b => agenda += `  ✗ ${b.inicio}-${b.fin} (${b.titulo})\n`);
      const huecos = []; let cursor = aperturaMin;
      bloques.forEach(b => {
        const bi = Math.max(b.iniMin, aperturaMin); const bf = Math.min(b.finMin, cierreMin);
        if (cursor < bi) huecos.push({ desdeMin: cursor, hastaMin: bi });
        cursor = Math.max(cursor, bf);
      });
      if (cursor < cierreMin) huecos.push({ desdeMin: cursor, hastaMin: cierreMin });
      huecos.forEach(h => {
        if (HORARIOS_PERMITIDOS?.length > 0) {
          const hab = HORARIOS_PERMITIDOS.filter(hr => { const m = toMin(hr); return m >= h.desdeMin && m < h.hastaMin; });
          if (hab.length > 0) agenda += `  ✓ Disponibles: ${hab.join(', ')}hs\n`;
        } else { agenda += `  ✓ Libre ${toStr(h.desdeMin)}-${toStr(h.hastaMin)}\n`; }
      });
    });
    agenda += `\nDías no mencionados: libres en horarios habilitados.`;
  }
  return agenda;
}

function buildInfoNegocio(negocio) {
  let info = `NEGOCIO: ${negocio.nombre}\n`;
  if (INFO_NEGOCIO.direccion) info += `Dirección: ${INFO_NEGOCIO.direccion}${INFO_NEGOCIO.referencia ? ` (${INFO_NEGOCIO.referencia})` : ''}\n`;
  if (INFO_NEGOCIO.maps) info += `Maps: ${INFO_NEGOCIO.maps}\n`;
  if (INFO_NEGOCIO.instagram) info += `Instagram: ${INFO_NEGOCIO.instagram}\n`;
  info += `Formas de pago: ${INFO_NEGOCIO.formasPago}\n`;
  if (INFO_NEGOCIO.recargoCuotas) info += `Cuotas: ${INFO_NEGOCIO.recargoCuotas}\n`;
  if (INFO_NEGOCIO.llegadaTarde) info += `Llegada tarde: ${INFO_NEGOCIO.llegadaTarde}\n`;
  if (INFO_NEGOCIO.clienteEspera) info += `Si preguntan si pueden esperar: ${INFO_NEGOCIO.clienteEspera}\n`;
  if (INFO_NEGOCIO.vacunasRequeridas) info += `Vacunas: ${INFO_NEGOCIO.vacunasRequeridas}\n`;
  if (INFO_NEGOCIO.edadMinimaCachorro) info += `Edad mínima cachorros: ${INFO_NEGOCIO.edadMinimaCachorro}\n`;
  if (INFO_NEGOCIO.otrosDatos) info += `Otros: ${INFO_NEGOCIO.otrosDatos}\n`;
  const politica = INFO_NEGOCIO.politicaCompleta || `${INFO_NEGOCIO.politicaCancelacion}. ${INFO_NEGOCIO.noShow}`;
  info += `\nPOLÍTICA AL CONFIRMAR (enviá siempre después, como mensaje separado):\n"${politica}"`;
  return info;
}

// ── System prompt ────────────────────────────────────────────
async function buildSystemPrompt(cliente, primerMensaje, analisisFoto) {
  const negocio = await getNegocio();
  if (!negocio) return '';
  const eventos = await getEventosCalendar();
  const mascotas = cliente?.mascotas || [];
  const infoPrecios = await buildInfoPrecios();
  const ahora = new Date();
  const fechaHora = ahora.toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const soloHora = ahora.toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false
  });
  const hoyFecha = ahora.toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  const manana = new Date(ahora);
  manana.setDate(manana.getDate() + 1);
  const mananaFecha = manana.toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: 'numeric', month: 'long'
  });
  const mascotasInfo = mascotas.map(m =>
    `- ${m.nombre}${m.raza_texto ? ` (${m.raza_texto})` : ''}${m.tamanio ? `, ${m.tamanio}` : ''}${m.notas ? `. NOTA: ${m.notas}` : ''}`
  ).join('\n');
  const clienteConocido = cliente?.nombre && cliente.nombre.trim() !== '';
  const esNuevo = mascotas.length === 0;
  const perfil = cliente?.notas || '';
  const tieneFalta = perfil.includes('FALTA_SIN_AVISO');
  const pareceFamiliar = primerMensaje ? pareceClienteConocido(primerMensaje) : false;

  return `Sos ${negocio.nombre_agente}, dueño de ${negocio.nombre}, una peluquería canina.
Hablás en primera persona. NUNCA digas que sos una IA.
TONO: Natural y cálido, sin exagerar. Máximo UN emoji por mensaje. Sin signos de exclamación dobles. Sin markdown. Máximo 3-4 líneas. Español rioplatense.
${negocio.modo_descanso ? `\nHOY NO PODÉS ATENDER: ${negocio.motivo_descanso}.\n` : ''}

AHORA: ${fechaHora} — SON LAS ${soloHora}hs
HOY ES: ${hoyFecha}
MAÑANA ES: ${mananaFecha}

⚠️ FECHAS IMPORTANTE: Cuando el cliente diga "mañana" significa ${mananaFecha}. Siempre confirmá el turno con el día de la semana Y la fecha exacta (ej: "martes 12 de mayo a las 10:00hs"). Nunca confundas "mañana" con otro día.

${calcularHorariosDisponibles(eventos, negocio)}
${buildInfoNegocio(negocio)}
${infoPrecios}

CLIENTE:
${clienteConocido ? `Nombre: ${cliente.nombre}` : 'Sin nombre registrado'}
Primer contacto: ${esNuevo ? 'SÍ' : 'NO'} · Parece conocido: ${pareceFamiliar ? 'SÍ' : 'NO'}
${perfil && !tieneFalta ? `Perfil: ${perfil}` : ''}
${tieneFalta ? `⚠️ FALTA SIN AVISO — al confirmar turno pedí seña obligatoriamente` : ''}
${mascotas.length > 0 ? `Mascotas:\n${mascotasInfo}` : 'Sin mascotas registradas.'}
${ALIAS_MP ? `\nALIAS MP: ${ALIAS_MP}${ALIAS_NOMBRE ? ` (a nombre de ${ALIAS_NOMBRE})` : ''}` : ''}
${analisisFoto ? `\nANÁLISIS FOTO: ${analisisFoto}` : ''}

FLUJO CLIENTE NUEVO:
1. "Antes de continuar, ¿me decís tu nombre y apellido así te agendo?"
2. "Mucho gusto [nombre]! ¿Cómo llegaste a nosotros?"
3. "Bueno [nombre], contame. ¿Qué perrito tenés y qué trabajo le buscabas hacer?"
4. Raza → foto → edad → cuidados especiales (de a una pregunta)
5. SIEMPRE preguntá el nombre del perro antes de confirmar el turno: "¿Y cómo se llama tu perrito?"
6. Ofrecé servicio y horarios disponibles
7. Al confirmar: primero el mensaje de confirmación, después la política — NO repitas estos mensajes

FLUJO CLIENTE CONOCIDO: directo, por nombre, asumir mascota si tiene una sola.

CUANDO RETOMÁS CONVERSACIÓN PREVIA:
→ "Hola [nombre]! ¿Me escribías por los horarios que estábamos viendo o por alguna otra cosa?"

PEDIDO DE FOTO: "¿Me mandás una foto de tu perrito así te doy un precio más exacto? 😊"

NOMBRE DE LA MASCOTA — MUY IMPORTANTE:
- SIEMPRE preguntá el nombre del perro antes de confirmar el turno
- Si el cliente lo dice en el mismo mensaje que confirma (ej: "Dale, se llama Pedro"), usá ese nombre directamente
- Si no lo dijo, preguntá: "¿Y cómo se llama tu perrito?"
- Nunca confirmes un turno sin tener el nombre de la mascota

CONFIRMACIÓN DE TURNO — SOLO UNA VEZ:
- Enviá UN solo mensaje de confirmación: "Perfecto, te espero el [día fecha] a las [hora] con [nombre mascota] 🐾"
- Luego UN mensaje con la política de cancelación
- Si el cliente ya confirmó y vuelve a escribir algo, NO repitas la confirmación

SERVICIOS:
- Rizado/largo (Caniche, Yorkshire, Shih Tzu, Maltés): Baño o Baño y corte
- Doble manto (Golden, Labrador, Husky): Baño o Deslanado — SIN corte
- Corto (Chihuahua, Boxer, Dóberman): Solo Baño

CONFIRMAR TURNO — dos mensajes:
1. "Perfecto, te espero el [día] a las [hora] 🐾"
2. La política de cancelación

Le parece caro → "Entiendo que te parezca un poco caro, pero trato de cobrar un precio justo para los dos 😊"
Por el perro → "Todavía estamos con él, en un ratito te aviso 👍"
Silencio → "¿Te reservo ese horario?" una sola vez.

REGLAS: sin duración salvo que pidan · sin explicar horarios ocupados · sin turnos después de ${negocio.horario_cierre}hs.

COMANDOS AL FINAL:
TURNO_CONFIRMADO|inicio_ISO|fin_ISO|cliente|mascota|servicio
GUARDAR_CLIENTE|nombre
GUARDAR_MASCOTA|nombre|raza|tamanio|notas
GUARDAR_PERFIL|descripcion
AVISAR_SEÑA|cliente|mascota
AGREGAR_ESPERA|fecha|horario|flexibilidad
TURNO_CANCELADO|x`;
}

// ── Procesar comandos ────────────────────────────────────────
async function procesarComandos(respuesta, cliente, telefono) {
  const lineas = respuesta.split('\n');
  let limpia = respuesta;
  for (const linea of lineas) {
    if (linea.startsWith('GUARDAR_CLIENTE|')) {
      const [, n] = linea.split('|');
      if (n && cliente?.id) await actualizarCliente(cliente.id, { nombre: n.trim() });
      limpia = limpia.replace(linea, '').trim();
    }
    if (linea.startsWith('GUARDAR_MASCOTA|')) {
      const [, nm, r, t, no] = linea.split('|');
      if (nm && cliente?.id) await guardarMascota(cliente.id, nm.trim(), r?.trim(), t?.trim(), no?.trim());
      limpia = limpia.replace(linea, '').trim();
    }
    if (linea.startsWith('GUARDAR_PERFIL|')) {
      const [, p] = linea.split('|');
      if (p && cliente?.id && !cliente.notas) await actualizarCliente(cliente.id, { notas: p.trim() });
      limpia = limpia.replace(linea, '').trim();
    }
    if (linea.startsWith('AVISAR_SEÑA|')) {
      const [, nc, nm] = linea.split('|');
      if (MI_NUMERO) await enviarMensaje(MI_NUMERO, `🔔 Seña\nCliente: ${nc} · Mascota: ${nm} · Tel: ${telefono}`);
      limpia = limpia.replace(linea, '').trim();
    }
    if (linea.startsWith('AGREGAR_ESPERA|')) {
      const [, fecha, horario, flex] = linea.split('|');
      if (cliente?.id) await agregarListaEspera(cliente.id, telefono, fecha === 'null' ? null : fecha, horario === 'null' ? null : horario, flex);
      limpia = limpia.replace(linea, '').trim();
    }
    if (linea.startsWith('TURNO_CANCELADO|')) {
      const { data: turnos } = await supabase.from('turnos').select('*, clientes(*), mascotas(*)')
        .eq('negocio_id', NEGOCIO_ID).eq('cliente_id', cliente?.id)
        .in('estado', ['pendiente', 'confirmado'])
        .order('fecha_hora_inicio', { ascending: true }).limit(1);
      if (turnos?.length > 0) {
        const turno = turnos[0];
        await supabase.from('turnos').update({ estado: 'cancelado', notas: 'Cancelado por cliente' }).eq('id', turno.id);
        if (MI_NUMERO) {
          const hora = new Date(turno.fecha_hora_inicio).toLocaleTimeString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false
          });
          await enviarMensaje(MI_NUMERO, `🔔 Cancelación\n${turno.mascotas?.nombre} (${turno.clientes?.nombre}) canceló el turno del ${hora}hs.`);
        }
      }
      limpia = limpia.replace(linea, '').trim();
    }
    if (linea.startsWith('TURNO_CONFIRMADO|')) {
      const [, ini, fin, nc, nm, serv] = linea.split('|');
      const titulo = `🐾 ${nm} (${nc}) — ${serv}`;
      const eventId = await crearEventoCalendar(titulo, ini, fin, `Cliente: ${nc}\nMascota: ${nm}\nServicio: ${serv}\nTel: ${telefono}`);
      if (eventId) console.log(`📅 ${titulo}`);
      await supabase.from('turnos').insert({
        negocio_id: NEGOCIO_ID, cliente_id: cliente?.id || null,
        duracion_minutos: Math.round((new Date(fin) - new Date(ini)) / 60000),
        fecha_hora_inicio: ini, fecha_hora_fin: fin,
        estado: 'confirmado', origen: 'whatsapp',
        google_calendar_event_id: eventId, notas: `${nm} — ${serv}`
      });
      limpia = limpia.replace(linea, '').trim();
    }
  }
  return limpia;
}

// ── Procesar mensaje de cliente ──────────────────────────────
async function procesarMensaje(telefono, texto, esPrimero, analisisFoto) {
  try {
    const cliente = await getOCreateCliente(telefono);
    const historial = await getHistorial(telefono);
    const prompt = await buildSystemPrompt(cliente, esPrimero ? texto : null, analisisFoto);
    await guardarMensaje(telefono, cliente?.id, 'user', texto);
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 500,
      system: prompt,
      messages: [...historial.map(h => ({ role: h.rol, content: h.contenido })), { role: 'user', content: texto }]
    });
    let respuesta = response.content[0].text;
    respuesta = await procesarComandos(respuesta, cliente, telefono);
    await guardarMensaje(telefono, cliente?.id, 'assistant', respuesta);
    return respuesta;
  } catch (e) {
    console.error('Error:', e);
    return 'Perdón, tuve un problema técnico. Intentalo de nuevo.';
  }
}

// ── Procesar comandos /admin desde tu número ─────────────────
async function procesarAdmin(texto, telefono) {
  // Consejo de marketing
  if (esperandoRespuestaConsejo && (texto === 'si' || texto === 'sí' || texto === 'no')) {
    esperandoRespuestaConsejo = false;
    if (texto === 'si' || texto === 'sí') {
      const negocio = await getNegocio();
      const consejo = await generarConsejo(negocio);
      if (consejo) await enviarMensaje(MI_NUMERO, `💡 *Consejo de hoy:*\n\n${consejo}`);
    } else {
      await enviarMensaje(MI_NUMERO, `Perfecto, que tengas un buen día de trabajo 🐾`);
    }
    return true;
  }

  // Lista de espera
  if (listaEsperaPendiente) {
    const t = texto.trim().toLowerCase();
    if (t === 'nadie') {
      listaEsperaPendiente = null;
      await enviarMensaje(MI_NUMERO, `Ok, no se ofrece el turno a nadie.`);
      return true;
    }
    const num = parseInt(texto.trim());
    if (!isNaN(num)) {
      const elegido = listaEsperaPendiente.candidatos.find(c => c.numero === num);
      if (elegido) {
        await enviarMensaje(elegido.telefono, `Hola ${elegido.nombre}! Se liberó un turno. ¿Te sirve? 😊`);
        await supabase.from('lista_espera').update({ estado: 'ofrecido' }).eq('id', elegido.id);
        await enviarMensaje(MI_NUMERO, `✅ Le ofrecí el turno a ${elegido.nombre}.`);
        listaEsperaPendiente = null;
      }
      return true;
    }
  }

  // Ficha técnica
  if (fichasEnProceso[MI_NUMERO]) {
    await procesarFichaTecnica(texto);
    return true;
  }

  // Asistencia
  if (texto.startsWith('/asistio') || texto.startsWith('/falto')) {
    await procesarAsistencia(texto);
    return true;
  }

  if (!texto.startsWith('/admin')) return false;

  const partes = texto.replace('/admin ', '').split('|').map(p => p.trim());
  const cmd = partes[0].toLowerCase();

  if (cmd === 'cliente') {
    const [, nombre, tel, mascota, raza, tam, notas] = partes;
    if (!nombre || !tel) { await enviarMensaje(MI_NUMERO, '❌ /admin cliente|Nombre|tel|mascota|raza|tamaño|notas'); return true; }
    let { data: cli } = await supabase.from('clientes').select('id').eq('negocio_id', NEGOCIO_ID).eq('telefono', tel).single();
    if (!cli) {
      const { data: n } = await supabase.from('clientes').insert({ negocio_id: NEGOCIO_ID, telefono: tel, nombre, tipo: 'frecuente' }).select('id').single();
      cli = n;
    } else { await supabase.from('clientes').update({ nombre }).eq('id', cli.id); }
    if (mascota) await guardarMascota(cli.id, mascota, raza, tam, notas);
    await enviarMensaje(MI_NUMERO, `✅ Cliente: ${nombre} · ${tel}${mascota ? ` · ${mascota}` : ''}`);
    return true;
  }
  if (cmd === 'ver') {
    const [, tel] = partes;
    if (!tel) { await enviarMensaje(MI_NUMERO, '❌ /admin ver|tel'); return true; }
    const { data: cli } = await supabase.from('clientes').select('*, mascotas(*)').eq('negocio_id', NEGOCIO_ID).eq('telefono', tel).single();
    if (!cli) { await enviarMensaje(MI_NUMERO, `❌ No encontré ${tel}`); return true; }
    let msg = `📋 *${cli.nombre || 'Sin nombre'}*\nTel: ${tel}\n`;
    if (cli.notas) msg += `Perfil: ${cli.notas}\n`;
    msg += `\nMascotas:\n`;
    for (const m of (cli.mascotas || [])) {
      msg += `  • ${m.nombre}${m.raza_texto ? ` (${m.raza_texto})` : ''}\n`;
      if (m.notas) msg += `    📝 ${m.notas}\n`;
      const ficha = await getUltimaFicha(m.id);
      if (ficha) msg += `    📋 Última: ${ficha.fecha} — ${ficha.servicio || 'sin datos'}\n`;
    }
    await enviarMensaje(MI_NUMERO, msg);
    return true;
  }
  if (cmd === 'borrar_historial') {
    const [, tel] = partes;
    await supabase.from('conversaciones').delete().eq('negocio_id', NEGOCIO_ID).eq('telefono', tel);
    await enviarMensaje(MI_NUMERO, `✅ Historial borrado para ${tel}`);
    return true;
  }
  if (cmd === 'nota') {
    const [, tel, ...np] = partes;
    const { data: cli } = await supabase.from('clientes').select('id').eq('negocio_id', NEGOCIO_ID).eq('telefono', tel).single();
    if (cli) { await supabase.from('clientes').update({ notas: np.join('|') }).eq('id', cli.id); }
    await enviarMensaje(MI_NUMERO, `✅ Nota guardada para ${tel}`);
    return true;
  }
  if (cmd === 'ayuda') {
    await enviarMensaje(MI_NUMERO,
      `📋 *Comandos:*\n\n/admin cliente|Nombre|tel|mascota|raza|tamaño|notas\n/admin ver|tel\n/admin nota|tel|texto\n/admin borrar_historial|tel\n\n/asistio|turno_id|tel\n/falto|turno_id|tel\n\n/admin ayuda`
    );
    return true;
  }
  return false;
}

// ── Asistencia ───────────────────────────────────────────────
async function procesarAsistencia(texto) {
  const partes = texto.split('|');
  const cmd = partes[0];
  const turnoId = partes[1];
  if (!turnoId) return;
  const { data: turno } = await supabase.from('turnos').select('*, clientes(*), mascotas(*)').eq('id', turnoId).single();
  if (!turno) { await enviarMensaje(MI_NUMERO, '❌ No encontré ese turno'); return; }
  if (cmd === '/falto') {
    await registrarFalta(turnoId, turno.cliente_id, turno.mascota_id);
    await enviarMensaje(MI_NUMERO, `❌ Falta registrada — ${turno.clientes?.nombre}. El próximo turno requerirá seña.`);
  }
  if (cmd === '/asistio') {
    await supabase.from('turnos').update({ estado: 'completado' }).eq('id', turnoId);
    const herramientas = await getHerramientas();
    fichasEnProceso[MI_NUMERO] = {
      paso: 1, turnoId, clienteId: turno.cliente_id, mascotaId: turno.mascota_id,
      nombreMascota: turno.mascotas?.nombre || 'la mascota',
      herramientasDisponibles: herramientas,
      ficha: {
        negocio_id: NEGOCIO_ID, turno_id: turnoId,
        cliente_id: turno.cliente_id, mascota_id: turno.mascota_id,
        fecha: new Date().toISOString().split('T')[0],
        servicio: turno.notas || '', detalle_corte: {}, herramientas_usadas: [],
      }
    };
    await enviarMensaje(MI_NUMERO, `✅ *Turno completado — ${turno.mascotas?.nombre}*\n\n*1. ¿Qué servicio se le hizo?*\nBaño / Baño y corte / Deslanado / Otro`);
  }
}

// ── Ficha técnica ────────────────────────────────────────────
async function procesarFichaTecnica(texto) {
  const estado = fichasEnProceso[MI_NUMERO];
  if (!estado) return;
  const { paso, nombreMascota, ficha, herramientasDisponibles } = estado;
  const listaH = herramientasDisponibles.map(h => h.nombre).join(' / ');
  switch (paso) {
    case 1: ficha.servicio = texto; estado.paso = 2;
      await enviarMensaje(MI_NUMERO, `*2. Herramientas y zonas:*\nDisponibles: ${listaH}\nEj: "lomo: cuchilla 7, patas: tijera curva" o "libre"`); break;
    case 2:
      if (texto.toLowerCase() !== 'libre') {
        const z = {}; const u = new Set();
        texto.split(',').forEach(p => { const [a, b] = p.split(':').map(s => s.trim()); if (a && b) { z[a.toLowerCase()] = b; u.add(b); } });
        ficha.detalle_corte = z; ficha.herramientas_usadas = [...u];
      }
      estado.paso = 3;
      await enviarMensaje(MI_NUMERO, `*3. ¿Estilo de corte?*\nCorte de raza / Bebé / Verano / Largo parejo / Otro`); break;
    case 3: ficha.estilo_corte = texto; estado.paso = 4;
      await enviarMensaje(MI_NUMERO, `*4. ¿Comportamiento de ${nombreMascota}?*\nTranquilo / Nervioso / Agresivo / Inquieto`); break;
    case 4: ficha.comportamiento = texto.toLowerCase(); estado.paso = 5;
      await enviarMensaje(MI_NUMERO, `*5. ¿Toleró el secador?*\nBien / Regular / Mal`); break;
    case 5: ficha.tolero_secador = texto.toLowerCase(); estado.paso = 6;
      await enviarMensaje(MI_NUMERO, `*6. ¿Mordió?*\nSí / No`); break;
    case 6: ficha.mordio = texto.toLowerCase().includes('si'); estado.paso = 7;
      await enviarMensaje(MI_NUMERO, `*7. ¿Cómo llegó el pelaje?*\nBueno / Descuidado / Con nudos / Con parásitos`); break;
    case 7: ficha.estado_pelaje_llegada = texto.toLowerCase(); estado.paso = 8;
      await enviarMensaje(MI_NUMERO, `*8. ¿Algo raro en salud?*\nEj: Piel irritada / Todo bien`); break;
    case 8: ficha.observaciones_salud = texto.toLowerCase() === 'todo bien' ? null : texto; estado.paso = 9;
      await enviarMensaje(MI_NUMERO, `*9. ¿Cuánto cobraste?*\nSolo el número (ej: 15000)`); break;
    case 9: ficha.precio_cobrado = parseInt(texto.replace(/\D/g, '')) || null; estado.paso = 10;
      await enviarMensaje(MI_NUMERO, `*10. ¿Alguna nota?*\nEj: "Le dejé el corte más largo" / "Ninguna"`); break;
    case 10:
      ficha.notas = texto.toLowerCase() === 'ninguna' ? null : texto;
      await guardarFichaServicio(ficha);
      delete fichasEnProceso[MI_NUMERO];
      await enviarMensaje(MI_NUMERO,
        `✅ *Ficha guardada — ${nombreMascota}*\nServicio: ${ficha.servicio}\nEstilo: ${ficha.estilo_corte}\n` +
        `Herramientas: ${ficha.herramientas_usadas?.join(', ')}\nComportamiento: ${ficha.comportamiento}\n` +
        (ficha.precio_cobrado ? `Precio: $${ficha.precio_cobrado.toLocaleString('es-AR')}` : '')
      ); break;
  }
}

// ── WEBHOOK — Verificación ───────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado por Meta');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── WEBHOOK — Recibir mensajes ───────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages) return;

    const msg = value.messages[0];
    const telefono = msg.from; // Número real del cliente ✅
    const tipo = msg.type;

    console.log(`📩 De ${telefono} (${tipo})`);

    // ── Mensajes desde tu número personal (admin) ──
    if (MI_NUMERO && telefono === MI_NUMERO) {
      if (tipo === 'text') {
        const texto = msg.text.body.trim().toLowerCase();
        await procesarAdmin(msg.text.body.trim(), telefono);
      }
      return;
    }

    // ── Verificar horario ──
    if (!botActivo()) {
      console.log(`💤 Fuera de horario — ${telefono}`);
      if (tipo === 'text') await guardarMensajeFueraHorario(telefono, msg.text.body);
      return;
    }

    // ── Imagen ──
    if (tipo === 'image') {
      const mediaId = msg.image.id;
      const media = await descargarMedia(mediaId);
      if (media) {
        const analisis = await analizarFotoPerro(media.data, media.mimetype);
        if (analisis) {
          const historial = await getHistorial(telefono);
          const respuesta = await procesarMensaje(telefono, '[El cliente mandó una foto de su perro]', historial.length === 0, analisis);
          await enviarMensaje(telefono, respuesta);
        } else {
          // Es comprobante de seña
          if (MI_NUMERO) await enviarMensaje(MI_NUMERO, `🔔 Comprobante recibido de ${telefono}`);
          await enviarMensaje(telefono, 'Perfecto, lo reviso y te confirmo en un momento 🙌');
        }
      }
      return;
    }

    // ── Audio ──
    if (tipo === 'audio') {
      await enviarMensaje(telefono, 'Por el momento no puedo escuchar audios, ¿me escribís? 😊');
      return;
    }

    // ── Texto ──
    if (tipo !== 'text') return;
    const texto = msg.text.body;
    if (!texto?.trim()) return;

    const historial = await getHistorial(telefono);
    const esPrimero = historial.length === 0;

    if (esPrimero && MI_NUMERO) {
      const esConocido = pareceClienteConocido(texto);
      const tipo_aviso = esConocido ? '🟡 *Parece cliente conocido*' : '🔵 *Cliente nuevo*';
      await enviarMensaje(MI_NUMERO,
        `${tipo_aviso}\n\nNúmero: ${telefono}\nPrimer mensaje: "${texto}"\n\n` +
        (esConocido ? `Para registrarlo:\n/admin cliente|Nombre|${telefono}|Mascota|Raza|Tamaño|Notas` : 'Lo estoy atendiendo como cliente nuevo.')
      );
    }

    const respuesta = await procesarMensaje(telefono, texto, esPrimero, null);
    await enviarMensaje(telefono, respuesta);

  } catch (e) {
    console.error('Error webhook:', e.message);
  }
});

// ── Guardar mensaje fuera de horario ─────────────────────────
async function guardarMensajeFueraHorario(telefono, texto) {
  try {
    const cliente = await getOCreateCliente(telefono);
    await supabase.from('conversaciones').insert({
      negocio_id: NEGOCIO_ID, cliente_id: cliente?.id || null,
      telefono, rol: 'user', contenido: texto, tipo: 'texto'
    });
  } catch (e) { console.error('Error guardando:', e.message); }
}

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', version: 'Groomer Copilot v21', timestamp: new Date().toISOString() });
});

// ── Iniciar servidor ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n✅ Groomer Copilot v21 corriendo en puerto ${PORT}`);
  console.log(`🕐 Horario bot: ${BOT_DESDE}-${BOT_HASTA}hs`);
  console.log(`📱 API oficial de Meta — números reales siempre`);
  console.log(`📅 Google Calendar activo`);
  console.log(`🐾 Esperando mensajes...\n`);

  // Resumen matutino
  const horaActual = new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false
  });
  if (horaActual >= BOT_DESDE && horaActual <= '07:15') {
    await enviarResumenDia();
  }
  const [h, m] = BOT_DESDE.split(':').map(Number);
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  manana.setHours(h, m, 0, 0);
  setTimeout(async () => {
    await enviarResumenDia();
    setInterval(() => enviarResumenDia(), 24 * 60 * 60 * 1000);
  }, manana - new Date());
});