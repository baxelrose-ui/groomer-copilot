require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const NEGOCIO_ID = process.env.NEGOCIO_ID;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
let MI_NUMERO = process.env.MI_NUMERO || '';
const MI_NUMERO_FILE = '.admin_numero'; // archivo donde se guarda el número del admin
const ALIAS_MP = process.env.ALIAS_MERCADOPAGO || '';
const ALIAS_NOMBRE = process.env.ALIAS_NOMBRE || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const BOT_DESDE = process.env.HORARIO_BOT_DESDE || '00:00';
const BOT_HASTA = process.env.HORARIO_BOT_HASTA || '23:59';
const HORARIOS_PERMITIDOS = process.env.HORARIOS_PERMITIDOS
  ? process.env.HORARIOS_PERMITIDOS.split(',').map(h => h.trim())
  : null;

const INFO_NEGOCIO = {
  direccion: process.env.NEGOCIO_DIRECCION || '',
  referencia: process.env.NEGOCIO_REFERENCIA || '',
  barrio: process.env.NEGOCIO_BARRIO || '',
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

// ── Cargar número admin guardado ─────────────────────────────
function cargarNumeroAdmin() {
  try {
    if (fs.existsSync(MI_NUMERO_FILE)) {
      const numero = fs.readFileSync(MI_NUMERO_FILE, 'utf8').trim();
      if (numero) {
        MI_NUMERO = numero;
        console.log(`👤 Admin cargado: ${MI_NUMERO}`);
      }
    }
  } catch (e) { console.error('Error cargando admin:', e.message); }
}

function guardarNumeroAdmin(numero) {
  try {
    fs.writeFileSync(MI_NUMERO_FILE, numero);
    MI_NUMERO = numero;
    console.log(`👤 Admin registrado: ${numero}`);
  } catch (e) { console.error('Error guardando admin:', e.message); }
}

// Cargar al iniciar
cargarNumeroAdmin();
const fichasEnProceso = {};
let esperandoRespuestaConsejo = false;
let listaEsperaPendiente = null;

// Cache de números reales para evitar repetir getContact()
const cacheNumeros = {};

// ── Ping a Supabase cada 3 días ──────────────────────────────
setInterval(async () => {
  try {
    await supabase.from('negocios').select('id').limit(1);
    console.log('💓 Ping Supabase OK');
  } catch (e) { console.error('Error ping:', e.message); }
}, 1000 * 60 * 60 * 24 * 3);

// ── Extraer teléfono real — intenta todas las formas posibles ─
async function extraerTelefono(msg) {
  try {
    const from = msg.from;

    // Si ya está en cache, devolver directo
    if (cacheNumeros[from]) return cacheNumeros[from];

    // Si no es @lid, extraer directamente
    if (!from.includes('@lid')) {
      const tel = from.replace('@c.us', '');
      cacheNumeros[from] = tel;
      return tel;
    }

    // Es @lid — intentar múltiples métodos

    // Método 1: msg.author
    if (msg.author && !msg.author.includes('@lid')) {
      const tel = msg.author.replace('@c.us', '');
      cacheNumeros[from] = tel;
      console.log(`📱 Número real (author): ${tel}`);
      return tel;
    }

    // Método 2: getContact() — número del perfil
    try {
      const contacto = await msg.getContact();

      // Intentar número directo
      if (contacto.number && !contacto.number.includes('@') && contacto.number.length > 8) {
        cacheNumeros[from] = contacto.number;
        console.log(`📱 Número real (contact.number): ${contacto.number}`);
        return contacto.number;
      }

      // Intentar id.user del contacto
      if (contacto.id?.user && !contacto.id.user.includes('@') && contacto.id.user.length > 8) {
        cacheNumeros[from] = contacto.id.user;
        console.log(`📱 Número real (contact.id.user): ${contacto.id.user}`);
        return contacto.id.user;
      }

      // Intentar _serialized limpio
      if (contacto.id?._serialized) {
        const serialized = contacto.id._serialized.replace('@c.us', '').replace('@lid', '');
        if (!serialized.includes('@') && serialized.length > 8) {
          cacheNumeros[from] = serialized;
          console.log(`📱 Número real (serialized): ${serialized}`);
          return serialized;
        }
      }
    } catch (e) {
      console.log(`⚠️ getContact() falló: ${e.message}`);
    }

    // Método 4: JavaScript injection en WhatsApp Web
    // Accede directamente a los datos internos del store de WhatsApp
    try {
      const waId = from.replace('@lid', '').replace('@c.us', '');
      const numeroReal = await msg.client.pupPage.evaluate(async (lid) => {
        try {
          // Buscar en el store de contactos de WhatsApp Web
          const store = window.Store;
          if (!store) return null;

          // Método 1: buscar por LID en ContactCollection
          if (store.Contact) {
            const contactos = store.Contact.getModelsArray();
            for (const c of contactos) {
              if (c.id?._serialized?.includes(lid) || c.lid?._serialized?.includes(lid)) {
                const num = c.id?.user || c.phoneNumber;
                if (num && !num.includes('@') && num.length > 8) return num;
              }
            }
          }

          // Método 2: buscar en Chat store
          if (store.Chat) {
            const chats = store.Chat.getModelsArray();
            for (const chat of chats) {
              if (chat.id?._serialized?.includes(lid)) {
                const num = chat.id?.user;
                if (num && !num.includes('@') && num.length > 8) return num;
              }
            }
          }

          return null;
        } catch (e) {
          return null;
        }
      }, waId);

      if (numeroReal && !numeroReal.includes('@') && numeroReal.length > 8) {
        cacheNumeros[from] = numeroReal;
        console.log(`📱 Número real (JS injection): ${numeroReal}`);
        return numeroReal;
      }
    } catch (e) {
      console.log(`⚠️ JS injection falló: ${e.message}`);
    }
    try {
      const data = msg._data;
      if (data?.author && !data.author.includes('@lid')) {
        const tel = data.author.replace('@c.us', '');
        cacheNumeros[from] = tel;
        console.log(`📱 Número real (_data.author): ${tel}`);
        return tel;
      }
      if (data?.from && !data.from.includes('@lid')) {
        const tel = data.from.replace('@c.us', '');
        cacheNumeros[from] = tel;
        return tel;
      }
      // Intentar notifyName como último recurso de identificación
      // (no es el número pero ayuda a identificar al usuario)
    } catch (e) {}

    // Fallback: usar el @lid limpio como identificador único
    const lidLimpio = from.replace('@lid', '');
    console.log(`⚠️ No se pudo obtener número real, usando LID: ${lidLimpio}`);
    cacheNumeros[from] = lidLimpio;
    return lidLimpio;

  } catch (e) {
    console.error('Error extrayendo teléfono:', e.message);
    return msg.from.replace('@c.us', '').replace('@lid', '').replace('@', '');
  }
}

// ── Verificar horario del bot ────────────────────────────────
function botActivo() {
  const hora = new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  return hora >= BOT_DESDE && hora < BOT_HASTA;
}

// ── Delays ───────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function delayHumano() { return delay(Math.floor(Math.random() * 10000) + 8000); }

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

// ── Avisar cliente nuevo ─────────────────────────────────────
async function avisarClienteNuevo(waClient, telefono, primerMensaje, esConocido, nombreWA) {
  if (!MI_NUMERO || !waClient) return;
  try {
    const tipo = esConocido ? '🟡 *Parece cliente conocido no registrado*' : '🔵 *Cliente nuevo detectado*';
    const instrucciones = esConocido
      ? `Para registrarlo:\n/admin cliente|Nombre Apellido|${telefono}|NombreMascota|Raza|Tamaño|Notas`
      : `Lo estoy atendiendo como cliente nuevo.`;
    await waClient.sendMessage(`${MI_NUMERO}@c.us`,
      `${tipo}\n\nNúmero: ${telefono}\n` +
      (nombreWA ? `Nombre WhatsApp: ${nombreWA}\n` : '') +
      `Primer mensaje: "${primerMensaje}"\n\n${instrucciones}`
    );
  } catch (e) { console.error('Error aviso:', e.message); }
}

// ── Guardar mensaje fuera de horario ─────────────────────────
async function guardarMensajeFueraHorario(telefono, texto) {
  try {
    const cliente = await getOCreateCliente(telefono);
    await supabase.from('conversaciones').insert({
      negocio_id: NEGOCIO_ID, cliente_id: cliente?.id || null,
      telefono, rol: 'user', contenido: texto, tipo: 'texto'
    });
    console.log(`💤 Guardado fuera de horario: ${telefono}`);
  } catch (e) { console.error('Error guardando fuera de horario:', e.message); }
}

// ── Responder mensajes fuera de horario al arrancar ──────────
async function responderMensajesFueraHorario(waClient) {
  try {
    const tz = 'America/Argentina/Buenos_Aires';
    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 1);
    const ayerStr = ayer.toLocaleDateString('en-CA', { timeZone: tz });

    const { data: msgs } = await supabase
      .from('conversaciones').select('telefono')
      .eq('negocio_id', NEGOCIO_ID).eq('rol', 'user')
      .gte('creado_en', `${ayerStr}T00:00:00`)
      .order('creado_en', { ascending: false });

    if (!msgs?.length) return;

    const telefonos = [...new Set(msgs.map(c => c.telefono))];
    let respondidos = 0;

    for (const tel of telefonos) {
      if (tel === MI_NUMERO) continue;
      const { data: ultimo } = await supabase
        .from('conversaciones').select('rol')
        .eq('negocio_id', NEGOCIO_ID).eq('telefono', tel)
        .order('creado_en', { ascending: false }).limit(1);

      if (ultimo?.[0]?.rol === 'user') {
        try {
          // Obtener nombre si está registrado
          const { data: cli } = await supabase
            .from('clientes').select('nombre')
            .eq('negocio_id', NEGOCIO_ID).eq('telefono', tel).single();
          const nombre = cli?.nombre ? ` ${cli.nombre.split(' ')[0]}` : '';
          await waClient.sendMessage(`${tel}@c.us`,
            `Hola${nombre}! Vi tu mensaje de antes, ¿en qué te puedo ayudar? 😊`
          );
          respondidos++;
          await delay(3000);
        } catch (e) { console.error(`Error respondiendo a ${tel}:`, e.message); }
      }
    }
    if (respondidos > 0) console.log(`📬 ${respondidos} mensajes fuera de horario respondidos`);
  } catch (e) { console.error('Error respondiendo fuera de horario:', e.message); }
}

// ── Lista de espera ──────────────────────────────────────────
async function agregarListaEspera(clienteId, telefono, fechaPreferida, horarioPreferido, flexibilidad) {
  try {
    const { data: existente } = await supabase
      .from('lista_espera').select('id')
      .eq('negocio_id', NEGOCIO_ID).eq('telefono', telefono).eq('estado', 'esperando').single();
    if (existente) return;
    await supabase.from('lista_espera').insert({
      negocio_id: NEGOCIO_ID, cliente_id: clienteId, telefono,
      fecha_preferida: fechaPreferida || null,
      horario_preferido: horarioPreferido || null,
      flexibilidad: flexibilidad || 'cualquier horario',
    });
    console.log(`📋 Lista de espera: ${telefono}`);
  } catch (e) { console.error('Error lista espera:', e.message); }
}

async function getListaEsperaParaFecha(fecha) {
  const { data } = await supabase
    .from('lista_espera')
    .select('*, clientes(nombre, telefono, mascotas(nombre, raza_texto))')
    .eq('negocio_id', NEGOCIO_ID).eq('estado', 'esperando')
    .or(`fecha_preferida.eq.${fecha},flexibilidad.eq.cualquier horario,fecha_preferida.is.null`);
  return data || [];
}

async function avisarCancelacionConListaEspera(waClient, turno, fecha, hora) {
  if (!MI_NUMERO) return;
  try {
    const candidatos = await getListaEsperaParaFecha(fecha);
    const tz = 'America/Argentina/Buenos_Aires';
    const fechaFormato = new Date(turno.fecha_hora_inicio).toLocaleDateString('es-AR', {
      timeZone: tz, weekday: 'long', day: 'numeric', month: 'long'
    });
    let mensaje = `🔔 *Cancelación*\n\n${turno.mascotas?.nombre || 'Mascota'} (${turno.clientes?.nombre || 'Cliente'}) canceló el turno del ${fechaFormato} a las ${hora}hs.\n\n`;
    if (candidatos.length === 0) {
      mensaje += `No hay nadie en lista de espera para ese día.`;
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, mensaje);
      return;
    }
    mensaje += `*En lista de espera:*\n\n`;
    candidatos.forEach((c, i) => {
      const nombre = c.clientes?.nombre || 'Sin nombre';
      const mascota = c.clientes?.mascotas?.[0]?.nombre || 'sin mascota';
      const raza = c.clientes?.mascotas?.[0]?.raza_texto || '';
      const pref = c.horario_preferido ? `prefiere las ${c.horario_preferido}` : c.flexibilidad;
      mensaje += `${i + 1}. ${nombre} — ${mascota}${raza ? ` (${raza})` : ''} · ${pref}\n`;
    });
    mensaje += `\n¿A quién le ofrezco? Respondé el número o *nadie*`;
    listaEsperaPendiente = {
      turnoId: turno.id, fecha, hora,
      candidatos: candidatos.map((c, i) => ({
        numero: i + 1, id: c.id, telefono: c.telefono,
        nombre: c.clientes?.nombre || 'Cliente',
        mascota: c.clientes?.mascotas?.[0]?.nombre || 'mascota',
      }))
    };
    await waClient.sendMessage(`${MI_NUMERO}@c.us`, mensaje);
  } catch (e) { console.error('Error aviso cancelación:', e.message); }
}

async function procesarEleccionListaEspera(texto, waClient) {
  if (!listaEsperaPendiente) return false;
  const t = texto.trim().toLowerCase();
  if (t === 'nadie') {
    listaEsperaPendiente = null;
    await waClient.sendMessage(`${MI_NUMERO}@c.us`, `Ok, no se ofrece el turno a nadie.`);
    return true;
  }
  const numero = parseInt(texto.trim());
  if (isNaN(numero)) return false;
  const elegido = listaEsperaPendiente.candidatos.find(c => c.numero === numero);
  if (!elegido) {
    await waClient.sendMessage(`${MI_NUMERO}@c.us`, `❌ Opción no encontrada. Respondé un número de la lista o "nadie".`);
    return true;
  }
  const { fecha, hora } = listaEsperaPendiente;
  const fechaFormateada = new Date(fecha + 'T12:00:00').toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: 'numeric', month: 'long'
  });
  try {
    await waClient.sendMessage(`${elegido.telefono}@c.us`,
      `Hola ${elegido.nombre}! Se liberó un turno para el ${fechaFormateada} a las ${hora}hs. ¿Te sirve para ${elegido.mascota}? 😊`
    );
    await supabase.from('lista_espera').update({ estado: 'ofrecido' }).eq('id', elegido.id);
    await waClient.sendMessage(`${MI_NUMERO}@c.us`,
      `✅ Le ofrecí el turno a ${elegido.nombre} (${elegido.mascota}). Te aviso cuando responda.`
    );
    console.log(`📋 Turno ofrecido a ${elegido.nombre}`);
  } catch (e) {
    await waClient.sendMessage(`${MI_NUMERO}@c.us`, `❌ No pude enviarle el mensaje a ${elegido.nombre}.`);
  }
  listaEsperaPendiente = null;
  return true;
}

// ── Analizar foto del perro ──────────────────────────────────
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
1. Raza probable (o mestizo)
2. Tamaño aproximado (mini/pequeño/mediano/grande)
3. Estado del pelaje y servicio recomendado (baño / baño y corte / deslanado)
Formato: "Parece un [raza], [tamaño]. El pelaje está [estado], le vendría bien [servicio]."
Si no hay un perro en la foto respondé solo: "NO_ES_PERRO"` }
        ]
      }]
    });
    const texto = response.content[0].text;
    if (texto.includes('NO_ES_PERRO')) return null;
    return texto;
  } catch (e) { console.error('Error foto:', e.message); return null; }
}

async function guardarFotoMascota(clienteId, mascotaNombre, mediaBase64, mimetype) {
  try {
    const ext = mimetype.includes('jpeg') ? 'jpg' : 'png';
    const filename = `${clienteId}_${mascotaNombre}_${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from('mascotas-fotos')
      .upload(filename, Buffer.from(mediaBase64, 'base64'), { contentType: mimetype, upsert: true });
    if (error) return null;
    const { data } = supabase.storage.from('mascotas-fotos').getPublicUrl(filename);
    return data?.publicUrl || null;
  } catch (e) { return null; }
}

// ── Transcribir audio ────────────────────────────────────────
async function transcribirAudio(mediaBase64, mimetype) {
  if (!OPENAI_KEY) return null;
  try {
    const ext = mimetype.includes('ogg') ? 'ogg' : 'mp3';
    const tmpPath = path.join(__dirname, `audio_tmp.${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(mediaBase64, 'base64'));
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', fs.createReadStream(tmpPath), { filename: `audio.${ext}`, contentType: mimetype });
    form.append('model', 'whisper-1');
    form.append('language', 'es');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, ...form.getHeaders() },
      body: form,
    });
    const data = await response.json();
    fs.unlinkSync(tmpPath);
    if (data.text) { console.log(`🎤 "${data.text}"`); return data.text; }
    return null;
  } catch (e) { console.error('Error Whisper:', e.message); return null; }
}

// ── Google Calendar ──────────────────────────────────────────
function getGoogleAuth() {
  const creds = JSON.parse(fs.readFileSync('credentials.json'));
  const { client_secret, client_id } = creds.web;
  const auth = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3000/callback');
  auth.setCredentials(JSON.parse(fs.readFileSync('token.json')));
  return auth;
}

async function getEventosCalendar(diasAdelante = 7) {
  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const ahora = new Date();
    const hasta = new Date();
    hasta.setDate(hasta.getDate() + diasAdelante);
    const { data } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: ahora.toISOString(),
      timeMax: hasta.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    return data.items || [];
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
  const { data } = await supabase
    .from('fichas_servicio').select('*')
    .eq('mascota_id', mascotaId)
    .order('fecha', { ascending: false }).limit(1).single();
  return data;
}

async function getHerramientas() {
  const { data } = await supabase
    .from('herramientas_negocio').select('*')
    .eq('negocio_id', NEGOCIO_ID).eq('activo', true);
  return data || [];
}

async function getTurnosHoy() {
  const tz = 'America/Argentina/Buenos_Aires';
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const { data } = await supabase
    .from('turnos').select('*, clientes(*), mascotas(*)')
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
    comportamiento: 'no_se_presento', notas: 'Cliente no se presentó sin aviso previo'
  });
  await supabase.from('clientes').update({ notas: 'FALTA_SIN_AVISO — requiere seña en próximo turno' }).eq('id', clienteId);
}

async function guardarFichaServicio(datos) {
  const { data } = await supabase.from('fichas_servicio').insert(datos).select('id').single();
  return data?.id;
}

// ── Resumen matutino ─────────────────────────────────────────
async function enviarResumenDia(waClient) {
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
        mensaje += `*${i + 1}. ${hora}hs — ${t.mascotas?.nombre || 'Mascota'}* (${t.mascotas?.raza_texto || 'raza no especificada'})\n`;
        mensaje += `   👤 ${t.clientes?.nombre || 'Sin nombre'}\n`;
        if (t.mascotas?.id) {
          const ficha = await getUltimaFicha(t.mascotas.id);
          if (ficha) {
            const dias = Math.round((new Date() - new Date(ficha.fecha)) / (1000 * 60 * 60 * 24));
            mensaje += `   📋 Última vez: hace ${dias} días — ${ficha.servicio || 'sin datos'}`;
            if (ficha.herramientas_usadas?.length > 0) mensaje += ` · ${ficha.herramientas_usadas.join(', ')}`;
            mensaje += '\n';
            if (ficha.comportamiento && ficha.comportamiento !== 'tranquilo') mensaje += `   ⚠️ ${ficha.comportamiento}\n`;
          } else { mensaje += `   ⭐ Primera vez\n`; }
        }
        if (t.clientes?.telefono) mensaje += `   👉 /admin ver|${t.clientes.telefono}\n`;
        mensaje += '\n';
      }
      mensaje += `📊 *Total: ${turnos.length} turno${turnos.length > 1 ? 's' : ''}*\n\n`;
    }
    mensaje += `¿Querés un consejo para conseguir más clientes hoy?\nRespondé *si* o *no*`;
    await waClient.sendMessage(`${MI_NUMERO}@c.us`, mensaje);
    esperandoRespuestaConsejo = true;
    programarAvisosTurnos(waClient, turnos);
    console.log('📋 Resumen del día enviado');
  } catch (e) { console.error('Error resumen:', e.message); }
}

function programarAvisosTurnos(waClient, turnos) {
  const tz = 'America/Argentina/Buenos_Aires';
  turnos.forEach(t => {
    const msHasta = new Date(t.fecha_hora_inicio) - new Date();
    if (msHasta > 0) {
      setTimeout(async () => {
        const hora = new Date(t.fecha_hora_inicio).toLocaleTimeString('es-AR', {
          timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
        });
        await waClient.sendMessage(`${MI_NUMERO}@c.us`,
          `🔔 *Turno ahora: ${hora}hs*\n\n${t.mascotas?.nombre || 'Mascota'} — ${t.clientes?.nombre || 'Cliente'}\n\n` +
          `¿Vino?\n/asistio|${t.id}|${t.clientes?.telefono || ''}\n/falto|${t.id}|${t.clientes?.telefono || ''}`
        );
      }, msHasta);
    }
  });
}

// ── Asistencia ───────────────────────────────────────────────
async function procesarAsistencia(texto, waClient) {
  if (!texto.startsWith('/asistio') && !texto.startsWith('/falto')) return false;
  const partes = texto.split('|');
  const cmd = partes[0];
  const turnoId = partes[1];
  if (!turnoId) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, '❌ Formato: /asistio|turno_id|tel'); return true; }
  const { data: turno } = await supabase.from('turnos').select('*, clientes(*), mascotas(*)')
    .eq('id', turnoId).single();
  if (!turno) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, '❌ No encontré ese turno'); return true; }
  if (cmd === '/falto') {
    await registrarFalta(turnoId, turno.cliente_id, turno.mascota_id);
    await waClient.sendMessage(`${MI_NUMERO}@c.us`,
      `❌ *Falta registrada*\n${turno.clientes?.nombre} — ${turno.mascotas?.nombre}\nEl próximo turno requerirá seña.`
    );
    return true;
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
    await waClient.sendMessage(`${MI_NUMERO}@c.us`,
      `✅ *Turno completado — ${turno.mascotas?.nombre}*\n\nVamos con la ficha:\n\n*1. ¿Qué servicio se le hizo?*\nBaño / Baño y corte / Deslanado / Otro`
    );
    return true;
  }
  return false;
}

// ── Ficha técnica ────────────────────────────────────────────
async function procesarFichaTecnica(texto, waClient) {
  const estado = fichasEnProceso[MI_NUMERO];
  if (!estado) return false;
  const { paso, nombreMascota, ficha, herramientasDisponibles } = estado;
  const listaH = herramientasDisponibles.map(h => h.nombre).join(' / ');
  switch (paso) {
    case 1: ficha.servicio = texto.trim(); estado.paso = 2;
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `*2. Herramientas y zonas:*\n\nDisponibles: ${listaH}\n\nEj: "lomo: cuchilla 7, patas: tijera curva" o "libre"`);
      return true;
    case 2:
      if (texto.toLowerCase() !== 'libre') {
        const z = {}; const u = new Set();
        texto.split(',').forEach(p => { const [a, b] = p.split(':').map(s => s.trim()); if (a && b) { z[a.toLowerCase()] = b; u.add(b); } });
        ficha.detalle_corte = z; ficha.herramientas_usadas = [...u];
      } else { ficha.detalle_corte = { libre: texto }; }
      estado.paso = 3;
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `*3. ¿Qué estilo de corte?*\n\nCorte de raza / Corte bebé / Corte verano / Largo parejo / Otro`);
      return true;
    case 3: ficha.estilo_corte = texto.trim(); estado.paso = 4;
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `*4. ¿Cómo se comportó ${nombreMascota}?*\n\nTranquilo / Nervioso / Agresivo / Inquieto`);
      return true;
    case 4: ficha.comportamiento = texto.trim().toLowerCase(); estado.paso = 5;
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `*5. ¿Cómo toleró el secador?*\n\nBien / Regular / Mal`);
      return true;
    case 5: ficha.tolero_secador = texto.trim().toLowerCase(); estado.paso = 6;
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `*6. ¿Mordió?*\n\nSí / No`);
      return true;
    case 6: ficha.mordio = texto.toLowerCase().includes('si') || texto.toLowerCase().includes('sí'); estado.paso = 7;
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `*7. ¿Cómo llegó el pelaje?*\n\nBueno / Descuidado / Con nudos / Con parásitos`);
      return true;
    case 7: ficha.estado_pelaje_llegada = texto.trim().toLowerCase(); estado.paso = 8;
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `*8. ¿Algo raro en salud?*\n\nEj: Piel irritada / Otitis / Todo bien`);
      return true;
    case 8: ficha.observaciones_salud = texto.toLowerCase() === 'todo bien' ? null : texto.trim(); estado.paso = 9;
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `*9. ¿Cuánto cobraste?*\n\nSolo el número (ej: 15000)`);
      return true;
    case 9: ficha.precio_cobrado = parseInt(texto.replace(/\D/g, '')) || null; estado.paso = 10;
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `*10. ¿Alguna nota?*\n\nEj: "Le dejé el corte más largo" / "Ninguna"`);
      return true;
    case 10:
      ficha.notas = texto.toLowerCase() === 'ninguna' ? null : texto.trim();
      await guardarFichaServicio(ficha);
      if (ficha.comportamiento !== 'tranquilo' || ficha.mordio || ficha.observaciones_salud) {
        let n = '';
        if (ficha.comportamiento !== 'tranquilo') n += `Comportamiento: ${ficha.comportamiento}. `;
        if (ficha.tolero_secador === 'mal') n += 'No tolera el secador. ';
        if (ficha.mordio) n += 'Mordió. ';
        if (ficha.observaciones_salud) n += `Salud: ${ficha.observaciones_salud}. `;
        if (n && estado.mascotaId) await supabase.from('mascotas').update({ notas: n.trim() }).eq('id', estado.mascotaId);
      }
      delete fichasEnProceso[MI_NUMERO];
      await waClient.sendMessage(`${MI_NUMERO}@c.us`,
        `✅ *Ficha guardada — ${nombreMascota}*\n\nServicio: ${ficha.servicio}\nEstilo: ${ficha.estilo_corte || 'no especificado'}\n` +
        `Herramientas: ${ficha.herramientas_usadas?.join(', ') || 'no especificadas'}\nComportamiento: ${ficha.comportamiento}\n` +
        (ficha.precio_cobrado ? `Precio: $${ficha.precio_cobrado.toLocaleString('es-AR')}\n` : '') +
        (ficha.notas ? `Notas: ${ficha.notas}` : '')
      );
      return true;
  }
  return false;
}

// ── Comandos /admin ──────────────────────────────────────────
async function procesarComandoAdmin(texto, waClient) {
  if (!texto.startsWith('/admin')) return false;
  const partes = texto.replace('/admin ', '').split('|').map(p => p.trim());
  const cmd = partes[0].toLowerCase();
  try {
    if (cmd === 'cliente') {
      const [, nombre, tel, mascota, raza, tam, notas] = partes;
      if (!nombre || !tel) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, '❌ /admin cliente|Nombre|tel|mascota|raza|tamaño|notas'); return true; }
      let { data: cli } = await supabase.from('clientes').select('id').eq('negocio_id', NEGOCIO_ID).eq('telefono', tel).single();
      if (!cli) {
        const { data: n } = await supabase.from('clientes').insert({ negocio_id: NEGOCIO_ID, telefono: tel, nombre, tipo: 'frecuente' }).select('id').single();
        cli = n;
      } else { await supabase.from('clientes').update({ nombre }).eq('id', cli.id); }
      if (mascota) await guardarMascota(cli.id, mascota, raza, tam, notas);
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `✅ Cliente: ${nombre} · ${tel}${mascota ? ` · ${mascota}` : ''}`);
      return true;
    }
    if (cmd === 'mascota') {
      const [, tel, mascota, raza, tam, notas] = partes;
      if (!tel || !mascota) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, '❌ /admin mascota|tel|nombre|raza|tamaño|notas'); return true; }
      const { data: cli } = await supabase.from('clientes').select('id').eq('negocio_id', NEGOCIO_ID).eq('telefono', tel).single();
      if (!cli) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, `❌ No encontré ${tel}`); return true; }
      await guardarMascota(cli.id, mascota, raza, tam, notas);
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `✅ Mascota: ${mascota} para ${tel}`);
      return true;
    }
    if (cmd === 'nota') {
      const [, tel, ...np] = partes; const nota = np.join('|');
      if (!tel || !nota) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, '❌ /admin nota|tel|texto'); return true; }
      const { data: cli } = await supabase.from('clientes').select('id').eq('negocio_id', NEGOCIO_ID).eq('telefono', tel).single();
      if (!cli) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, `❌ No encontré ${tel}`); return true; }
      await supabase.from('clientes').update({ notas: nota }).eq('id', cli.id);
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `✅ Nota guardada para ${tel}`);
      return true;
    }
    if (cmd === 'perfil') {
      const [, tel, ...pp] = partes; const perfil = pp.join('|');
      if (!tel || !perfil) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, '❌ /admin perfil|tel|descripcion'); return true; }
      const { data: cli } = await supabase.from('clientes').select('id').eq('negocio_id', NEGOCIO_ID).eq('telefono', tel).single();
      if (!cli) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, `❌ No encontré ${tel}`); return true; }
      await supabase.from('clientes').update({ notas: perfil }).eq('id', cli.id);
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `✅ Perfil actualizado para ${tel}`);
      return true;
    }
    if (cmd === 'ver') {
      const [, tel] = partes;
      if (!tel) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, '❌ /admin ver|tel'); return true; }
      const { data: cli } = await supabase.from('clientes').select('*, mascotas(*)').eq('negocio_id', NEGOCIO_ID).eq('telefono', tel).single();
      if (!cli) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, `❌ No encontré ${tel}`); return true; }
      let msg = `📋 *${cli.nombre || 'Sin nombre'}*\nTel: ${tel} · Tipo: ${cli.tipo}\n`;
      if (cli.notas && !cli.notas.includes('FALTA_SIN_AVISO')) msg += `Perfil: ${cli.notas}\n`;
      if (cli.notas?.includes('FALTA_SIN_AVISO')) msg += `⚠️ Falta sin aviso registrada\n`;
      msg += `\nMascotas:\n`;
      for (const m of (cli.mascotas || [])) {
        msg += `  • ${m.nombre}${m.raza_texto ? ` (${m.raza_texto})` : ''}${m.tamanio ? `, ${m.tamanio}` : ''}\n`;
        if (m.notas) msg += `    📝 ${m.notas}\n`;
        const ficha = await getUltimaFicha(m.id);
        if (ficha) {
          msg += `    📋 Última: ${ficha.fecha} — ${ficha.servicio || 'sin datos'}\n`;
          if (ficha.herramientas_usadas?.length > 0) msg += `    🔧 ${ficha.herramientas_usadas.join(', ')}\n`;
          if (ficha.estilo_corte) msg += `    ✂️ ${ficha.estilo_corte}\n`;
        }
      }
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, msg);
      return true;
    }
    if (cmd === 'borrar_historial') {
      const [, tel] = partes;
      if (!tel) { await waClient.sendMessage(`${MI_NUMERO}@c.us`, '❌ /admin borrar_historial|tel'); return true; }
      await supabase.from('conversaciones').delete().eq('negocio_id', NEGOCIO_ID).eq('telefono', tel);
      await waClient.sendMessage(`${MI_NUMERO}@c.us`, `✅ Historial borrado para ${tel}`);
      return true;
    }
    if (cmd === 'ayuda') {
      await waClient.sendMessage(`${MI_NUMERO}@c.us`,
        `📋 *Comandos /admin:*\n\n` +
        `/admin cliente|Nombre|tel|mascota|raza|tamaño|notas\n` +
        `/admin mascota|tel|nombre|raza|tamaño|notas\n` +
        `/admin nota|tel|texto\n` +
        `/admin perfil|tel|descripcion\n` +
        `/admin ver|tel\n` +
        `/admin borrar_historial|tel\n\n` +
        `*Asistencia:*\n/asistio|turno_id|tel\n/falto|turno_id|tel\n\n` +
        `/admin ayuda`
      );
      return true;
    }
    await waClient.sendMessage(`${MI_NUMERO}@c.us`, '❌ Comando no reconocido. /admin ayuda');
    return true;
  } catch (e) {
    await waClient.sendMessage(`${MI_NUMERO}@c.us`, `❌ Error: ${e.message}`);
    return true;
  }
}

// ── Consejo de marketing ─────────────────────────────────────
async function generarConsejo(negocio) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 300,
      messages: [{ role: 'user', content: `Sos un experto en marketing para pequeños negocios. Generá UN consejo práctico y accionable para hoy para una peluquería canina llamada "${negocio.nombre}". Algo que el dueño pueda hacer hoy mismo. Máximo 4 líneas. Español rioplatense. Sin título ni listas.` }]
    });
    return response.content[0].text;
  } catch (e) { return null; }
}

// ── Agenda con cálculo correcto por minutos ──────────────────
function calcularHorariosDisponibles(eventos, negocio) {
  const tz = 'America/Argentina/Buenos_Aires';
  const apertura = negocio.horario_apertura.slice(0, 5);
  const cierre = negocio.horario_cierre.slice(0, 5);
  const cierreH = parseInt(cierre.split(':')[0]);

  function toMin(horaStr) {
    const [h, m] = horaStr.split(':').map(Number);
    return h * 60 + m;
  }
  function toStr(min) {
    return `${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`;
  }

  const aperturaMin = toMin(apertura);
  const cierreMin = toMin(cierre);

  const porDia = {};
  (eventos || []).forEach(ev => {
    if (!ev.start.dateTime || !ev.end.dateTime) return;
    const ini = new Date(ev.start.dateTime);
    const fin = new Date(ev.end.dateTime);
    const hi = ini.toLocaleTimeString('es-AR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const hf = fin.toLocaleTimeString('es-AR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const iniMin = toMin(hi);
    const finMin = toMin(hf);
    // Ignorar eventos fuera del horario de atención
    if (finMin <= aperturaMin || iniMin >= cierreMin) return;
    const dia = ini.toLocaleDateString('es-AR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
    if (!porDia[dia]) porDia[dia] = [];
    porDia[dia].push({ inicio: hi, fin: hf, iniMin, finMin, titulo: ev.summary || 'Ocupado' });
  });

  let agenda = `HORARIO DE ATENCIÓN: ${apertura} a ${cierre}hs\n`;
  agenda += `ÚLTIMO INICIO PERMITIDO: Baño ${cierreH-1}:00hs · Baño y corte ${cierreH-2}:00hs · Deslanado ${cierreH-2}:00hs\n`;
  agenda += `NUNCA ofrezcas turno que termine después de las ${cierre}hs.\n`;
  if (HORARIOS_PERMITIDOS?.length > 0) {
    agenda += `HORARIOS HABILITADOS: ${HORARIOS_PERMITIDOS.join(', ')}hs — solo ofrecé estos.\n`;
  }
  agenda += `⚠️ MUY IMPORTANTE: Solo podés ofrecer los horarios que aparecen como "✓ Disponibles" en la agenda de cada día. Si un día dice "✓ Disponibles: 16:00hs" entonces ESE DÍA SOLO HAY LUGAR A LAS 16HS. No ofrezcas otros horarios aunque estén en la lista de habilitados.\n\n`;

  if (Object.keys(porDia).length === 0) {
    agenda += `Sin eventos esta semana. Libre en horarios habilitados entre ${apertura} y ${cierre}hs.`;
  } else {
    Object.entries(porDia).forEach(([dia, evs]) => {
      const bloques = evs.sort((a, b) => a.iniMin - b.iniMin);
      agenda += `${dia.toUpperCase()}:\n`;
      bloques.forEach(b => agenda += `  ✗ Ocupado de ${b.inicio} a ${b.fin} (${b.titulo})\n`);
      const huecos = [];
      let cursor = aperturaMin;
      bloques.forEach(b => {
        const bloqueIni = Math.max(b.iniMin, aperturaMin);
        const bloqueFin = Math.min(b.finMin, cierreMin);
        if (cursor < bloqueIni) huecos.push({ desdeMin: cursor, hastaMin: bloqueIni });
        cursor = Math.max(cursor, bloqueFin);
      });
      if (cursor < cierreMin) huecos.push({ desdeMin: cursor, hastaMin: cierreMin });
      if (huecos.length > 0) {
        huecos.forEach(h => {
          if (HORARIOS_PERMITIDOS?.length > 0) {
            const hab = HORARIOS_PERMITIDOS.filter(hr => { const hrMin = toMin(hr); return hrMin >= h.desdeMin && hrMin < h.hastaMin; });
            if (hab.length > 0) agenda += `  ✓ Disponibles: ${hab.join(', ')}hs\n`;
          } else { agenda += `  ✓ Libre de ${toStr(h.desdeMin)} a ${toStr(h.hastaMin)}\n`; }
        });
      } else { agenda += `  ✗ Día completo ocupado\n`; }
    });
    agenda += `\nDías no mencionados: libres en horarios habilitados entre ${apertura} y ${cierre}hs.`;
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
  info += `\nPOLÍTICA AL CONFIRMAR TURNO (enviá siempre después de confirmar, como mensaje separado):\n"${politica}"`;
  return info;
}

// ── System prompt ────────────────────────────────────────────
async function buildSystemPrompt(cliente, primerMensaje, analisisFoto) {
  const negocio = await getNegocio();
  if (!negocio) return '';
  const eventos = await getEventosCalendar();
  const mascotas = cliente?.mascotas || [];
  const ahora = new Date();
  const fechaHora = ahora.toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const soloHora = ahora.toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false
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

TONO: Natural y cálido, sin exagerar. Como alguien que está bien pero tranquilo.
- Máximo UN emoji por mensaje.
- Sin signos de exclamación dobles. Sin "¡Genial!" ni "¡Perfecto!" exaltados.
- Respondé según cómo el cliente lleva la conversación.
- Sin listas, sin negritas, sin markdown. Texto natural como WhatsApp.
- Máximo 3-4 líneas por mensaje. Español rioplatense.

AHORA: ${fechaHora} — SON LAS ${soloHora}hs

${calcularHorariosDisponibles(eventos, negocio)}

${buildInfoNegocio(negocio)}

CLIENTE:
${clienteConocido ? `Nombre: ${cliente.nombre}` : 'Sin nombre registrado'}
Primer contacto: ${esNuevo ? 'SÍ' : 'NO'} · Parece conocido: ${pareceFamiliar ? 'SÍ' : 'NO'}
${perfil && !tieneFalta ? `Perfil: ${perfil}` : ''}
${tieneFalta ? `⚠️ FALTA SIN AVISO — al confirmar turno pedí seña obligatoriamente` : ''}
${mascotas.length > 0 ? `Mascotas:\n${mascotasInfo}` : 'Sin mascotas registradas.'}

${ALIAS_MP ? `ALIAS MP: ${ALIAS_MP}${ALIAS_NOMBRE ? ` (a nombre de ${ALIAS_NOMBRE})` : ''}` : ''}
${analisisFoto ? `\nANÁLISIS FOTO DEL PERRO: ${analisisFoto}\nUsá esta info para sugerir servicio y dar precio más preciso.` : ''}

FLUJO CLIENTE NUEVO:
1. "Antes de continuar, ¿me decís tu nombre y apellido así te agendo?"
2. "Mucho gusto [nombre]! ¿Cómo llegaste a nosotros?" — respondé brevemente.
3. "Bueno [nombre], contame. ¿Qué perrito tenés y qué trabajo le buscabas hacer?"
4. De a una: raza → pedí foto → edad → cuidados especiales.
5. Con foto analizada o raza conocida: ofrecé servicio y horarios disponibles.

FLUJO CLIENTE CONOCIDO: directo, saludar por nombre, asumir mascota si tiene una sola.

CUANDO RETOMÁS UNA CONVERSACIÓN PREVIA:
Si el cliente ya había hablado antes y vuelve a escribir:
→ "Hola [nombre]! ¿Me escribías por los horarios que estábamos viendo o por alguna otra cosa?"
→ Si no tiene nombre: "Hola! ¿Me escribías por lo que estábamos hablando antes o por alguna otra cosa?"
NO uses "Sisi ya te estoy viendo" como saludo inicial.

CUANDO EL CLIENTE MANDA SEÑALES DE IMPACIENCIA ("??", "hola?", "seguís ahí?") MIENTRAS ESPERA EN UNA CONVERSACIÓN ACTIVA:
→ "Ya te estoy viendo, un segundo 😊"

PEDIDO DE FOTO:
Pedila después de saber la raza o cuando pregunte precio sin detalles.
"¿Me mandás una foto de tu perrito así te doy un precio más exacto? 😊"
Si ya tenés el análisis, usalo para precio y servicio.

CUANDO EL CLIENTE PREGUNTA PRECIO SIN DETALLES:
"Depende de la raza y el tamaño. ¿Me contás qué perrito tenés o me mandás una fotito? 😊"

SERVICIOS SEGÚN PELO:
- Rizado/largo (Caniche, Yorkshire, Shih Tzu, Maltés, Cocker): Baño o Baño y corte
- Doble manto (Golden, Labrador, Husky, Pastor Alemán): Baño o Deslanado — SIN corte
- Corto (Chihuahua, Boxer, Dóberman, Beagle): Solo Baño

PISTAS DEL SERVICIO: validar + sugerir + tirar solo los horarios disponibles de ese día.
"Dale, perfecto. Con un baño y corte queda mucho más cómodo 🐶 Para esta semana tengo: [SOLO LOS HORARIOS QUE APARECEN COMO DISPONIBLES] ¿Cuál te viene mejor?"

AL CONFIRMAR TURNO — dos mensajes separados:
1. "Perfecto, te espero el [día] a las [hora] 🐾"
2. La política de cancelación

CLIENTE CON FALTA: pedí seña al confirmar.

Le parece caro → "Entiendo que te parezca un poco caro, pero trato de cobrar un precio justo para los dos 😊"
Por el perro en la peluquería → "Todavía estamos con él, en un ratito te aviso 👍"
Silencio tras oferta → "¿Te reservo ese horario?" — una sola vez.

SEÑAS: ${ALIAS_MP ? `Alias: ${ALIAS_MP}${ALIAS_NOMBRE ? ` (${ALIAS_NOMBRE})` : ''}. Mandame el comprobante 👍` : 'No configuradas.'}

REGLAS: sin duración salvo que pidan · sin explicar horarios ocupados · sin turnos después de ${negocio.horario_cierre}hs.

COMANDOS AL FINAL (el cliente no los ve):
TURNO_CONFIRMADO|inicio_ISO|fin_ISO|cliente|mascota|servicio
GUARDAR_CLIENTE|nombre_completo
GUARDAR_MASCOTA|nombre|raza|tamanio|notas_cuidados
GUARDAR_PERFIL|descripcion
AVISAR_SEÑA|cliente|mascota
AGREGAR_ESPERA|fecha_YYYY-MM-DD|horario|flexibilidad
TURNO_CANCELADO|turno_id`;
}

// ── Procesar comandos del agente ─────────────────────────────
async function procesarComandos(respuesta, cliente, waClient, remoteJid, telefono) {
  const lineas = respuesta.split('\n');
  let limpia = respuesta;
  for (const linea of lineas) {
    if (linea.startsWith('GUARDAR_CLIENTE|')) {
      const [, n] = linea.split('|');
      if (n && cliente?.id) { await actualizarCliente(cliente.id, { nombre: n.trim() }); console.log(`👤 ${n.trim()}`); }
      limpia = limpia.replace(linea, '').trim();
    }
    if (linea.startsWith('GUARDAR_MASCOTA|')) {
      const [, nm, r, t, no] = linea.split('|');
      if (nm && cliente?.id) { await guardarMascota(cliente.id, nm.trim(), r?.trim(), t?.trim(), no?.trim()); }
      limpia = limpia.replace(linea, '').trim();
    }
    if (linea.startsWith('GUARDAR_PERFIL|')) {
      const [, p] = linea.split('|');
      if (p && cliente?.id && !cliente.notas) { await actualizarCliente(cliente.id, { notas: p.trim() }); }
      limpia = limpia.replace(linea, '').trim();
    }
    if (linea.startsWith('AVISAR_SEÑA|')) {
      const [, nc, nm] = linea.split('|');
      if (MI_NUMERO && waClient) {
        try { await waClient.sendMessage(`${MI_NUMERO}@c.us`, `🔔 Seña pendiente\nCliente: ${nc} · Mascota: ${nm} · Tel: ${telefono}`); } catch (e) {}
      }
      limpia = limpia.replace(linea, '').trim();
    }
    if (linea.startsWith('AGREGAR_ESPERA|')) {
      const [, fecha, horario, flexibilidad] = linea.split('|');
      if (cliente?.id) {
        await agregarListaEspera(cliente.id, telefono,
          fecha === 'null' ? null : fecha,
          horario === 'null' ? null : horario,
          flexibilidad || 'cualquier horario'
        );
      }
      limpia = limpia.replace(linea, '').trim();
    }
    if (linea.startsWith('TURNO_CANCELADO|')) {
      const { data: turnos } = await supabase
        .from('turnos').select('*, clientes(*), mascotas(*)')
        .eq('negocio_id', NEGOCIO_ID).eq('cliente_id', cliente?.id)
        .in('estado', ['pendiente', 'confirmado'])
        .order('fecha_hora_inicio', { ascending: true }).limit(1);
      if (turnos?.length > 0) {
        const turno = turnos[0];
        const tz = 'America/Argentina/Buenos_Aires';
        const fecha = new Date(turno.fecha_hora_inicio).toLocaleDateString('en-CA', { timeZone: tz });
        const hora = new Date(turno.fecha_hora_inicio).toLocaleTimeString('es-AR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
        await supabase.from('turnos').update({ estado: 'cancelado', notas: 'Cancelado por el cliente' }).eq('id', turno.id);
        if (waClient) await avisarCancelacionConListaEspera(waClient, turno, fecha, hora);
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

// ── Procesar mensaje ─────────────────────────────────────────
async function procesarMensaje(telefono, texto, waClient, remoteJid, esPrimero, analisisFoto) {
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
    respuesta = await procesarComandos(respuesta, cliente, waClient, remoteJid, telefono);
    await guardarMensaje(telefono, cliente?.id, 'assistant', respuesta);
    return respuesta;
  } catch (e) {
    console.error('Error:', e);
    return 'Perdón, tuve un problema técnico. Intentalo de nuevo.';
  }
}

// ── WhatsApp ─────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--no-first-run', '--disable-gpu', '--disable-extensions',
      '--disable-background-networking', '--disable-default-apps',
      '--disable-sync', '--no-zygote', '--single-process']
  }
});

client.on('qr', (qr) => {
  console.log('\n📱 Escaneá el QR:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('\n✅ Groomer Copilot v20 conectado!');
  console.log(`🕐 Bot: ${BOT_DESDE}-${BOT_HASTA}hs`);
  console.log('📱 Fix @lid: activo (usa getContact())');
  console.log('📸 Análisis de fotos: activo');
  console.log('📋 Fichas técnicas: activo');
  console.log('📬 Mensajes fuera de horario: activo');
  console.log('📋 Lista de espera: activo');
  console.log('💓 Ping Supabase: cada 3 días');
  console.log('🐾 Esperando mensajes...\n');

  if (MI_NUMERO) {
    await client.sendMessage(`${MI_NUMERO}@c.us`,
      `✅ *Groomer Copilot v20*\nHorario: ${BOT_DESDE} a ${BOT_HASTA}hs\n/admin ayuda para ver comandos`
    ).catch(() => {});
  }

  const horaActual = new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false
  });
  if (horaActual >= BOT_DESDE && horaActual <= '07:15') {
    await enviarResumenDia(client);
    await delay(5000);
    await responderMensajesFueraHorario(client);
  }

  const [h, m] = BOT_DESDE.split(':').map(Number);
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  manana.setHours(h, m, 0, 0);
  setTimeout(async () => {
    await enviarResumenDia(client);
    await delay(5000);
    await responderMensajesFueraHorario(client);
    setInterval(async () => {
      await enviarResumenDia(client);
      await delay(5000);
      await responderMensajesFueraHorario(client);
    }, 24 * 60 * 60 * 1000);
  }, manana - new Date());
});

client.on('auth_failure', () => console.log('❌ Error de autenticación.'));
client.on('disconnected', () => { console.log('⚠️ Desconectado. Reiniciando...'); client.initialize(); });

client.on('message', async (msg) => {
  if (msg.from.includes('@g.us')) return;
  if (msg.fromMe) return;
  if (msg.from === 'status@broadcast') return;

  // Extraer teléfono real (resuelve @lid)
  const telefono = await extraerTelefono(msg);
  const esMiNumero = MI_NUMERO && telefono === MI_NUMERO;

  // ── Registro automático del admin ──
  // Si no hay admin configurado, el primero que escriba "admin" se registra
  if (!MI_NUMERO && msg.type === 'chat') {
    const textoAdmin = msg.body?.trim().toLowerCase();
    if (textoAdmin === 'admin' || textoAdmin === '/admin setup') {
      const telAdmin = await extraerTelefono(msg);
      guardarNumeroAdmin(telAdmin);
      await msg.reply(
        `✅ *Tu número quedó registrado como administrador*\n\n` +
        `ID registrado: ${telAdmin}\n\n` +
        `Ya podés usar todos los comandos /admin.\n` +
        `Mandá /admin ayuda para ver los comandos disponibles.`
      );
      console.log(`👤 Admin registrado automáticamente: ${telAdmin}`);
      return;
    }
  }

  // ── Mensajes desde tu número ──
  if (esMiNumero) {
    if (msg.type !== 'chat') return;
    const texto = msg.body.trim();
    if (esperandoRespuestaConsejo) {
      esperandoRespuestaConsejo = false;
      if (texto.toLowerCase() === 'si' || texto.toLowerCase() === 'sí') {
        const negocio = await getNegocio();
        const consejo = await generarConsejo(negocio);
        if (consejo) await client.sendMessage(`${MI_NUMERO}@c.us`, `💡 *Consejo de hoy:*\n\n${consejo}`);
      } else {
        await client.sendMessage(`${MI_NUMERO}@c.us`, `Perfecto, que tengas un buen día de trabajo 🐾`);
      }
      return;
    }
    if (listaEsperaPendiente) {
      const procesado = await procesarEleccionListaEspera(texto, client);
      if (procesado) return;
    }
    if (texto.startsWith('/admin')) { await procesarComandoAdmin(texto, client); return; }
    if (texto.startsWith('/asistio') || texto.startsWith('/falto')) { await procesarAsistencia(texto, client); return; }
    if (fichasEnProceso[MI_NUMERO]) { await procesarFichaTecnica(texto, client); return; }
    return;
  }

  // ── Verificar horario ──
  if (!botActivo()) {
    console.log(`💤 Fuera de horario — guardando mensaje de ${telefono}`);
    if (msg.type === 'chat' && msg.body?.trim()) await guardarMensajeFueraHorario(telefono, msg.body);
    return;
  }

  const esTexto = msg.type === 'chat';
  const esAudio = msg.type === 'audio' || msg.type === 'ptt';
  const esImagen = msg.type === 'image';

  // ── Audio ──
  if (esAudio) {
    if (OPENAI_KEY) {
      try {
        const media = await msg.downloadMedia();
        const transcripcion = await transcribirAudio(media.data, media.mimetype);
        if (transcripcion?.trim()) {
          const historial = await getHistorial(telefono);
          await client.sendPresenceAvailable();
          await delayHumano();
          const chat = await msg.getChat();
          await chat.sendStateTyping();
          await delay(2000);
          const respuesta = await procesarMensaje(telefono, transcripcion, client, msg.from, historial.length === 0, null);
          await msg.reply(respuesta);
        } else { await msg.reply('No pude escuchar bien, ¿me escribís? 😊'); }
      } catch (e) { await msg.reply('No pude escuchar bien, ¿me escribís? 😊'); }
    } else {
      await delay(3000);
      await msg.reply('Por el momento no puedo escuchar audios, ¿me escribís? 😊');
    }
    return;
  }

  // ── Imagen ──
  if (esImagen) {
    try {
      const media = await msg.downloadMedia();
      const clienteData = await getOCreateCliente(telefono);
      const analisis = await analizarFotoPerro(media.data, media.mimetype);
      if (analisis) {
        console.log(`🐶 Foto analizada: ${analisis}`);
        const mascotas = clienteData?.mascotas || [];
        if (mascotas.length > 0 && clienteData?.id) {
          const fotoUrl = await guardarFotoMascota(clienteData.id, mascotas[0].nombre, media.data, media.mimetype);
          if (fotoUrl) await supabase.from('mascotas').update({ foto_url: fotoUrl }).eq('id', mascotas[0].id);
        }
        const historial = await getHistorial(telefono);
        await client.sendPresenceAvailable();
        await delayHumano();
        const chat = await msg.getChat();
        await chat.sendStateTyping();
        await delay(2000);
        const respuesta = await procesarMensaje(telefono, '[El cliente mandó una foto de su perro]', client, msg.from, historial.length === 0, analisis);
        await msg.reply(respuesta);
      } else {
        if (MI_NUMERO) {
          try {
            await client.sendMessage(`${MI_NUMERO}@c.us`, `🔔 *Imagen recibida*\n${clienteData?.nombre || 'Cliente'} · ${clienteData?.mascotas?.[0]?.nombre || 'sin mascota'} · ${telefono}`);
            await client.sendMessage(`${MI_NUMERO}@c.us`, media);
          } catch (e) {}
        }
        await msg.reply('Perfecto, lo reviso y te confirmo en un momento 🙌');
      }
    } catch (e) {
      console.error('Error imagen:', e.message);
      await msg.reply('No pude procesar la imagen. ¿Me la mandás de nuevo?');
    }
    return;
  }

  // ── Texto ──
  if (!esTexto) return;
  const texto = msg.body;
  if (!texto?.trim()) return;

  console.log(`📩 De ${telefono}: ${texto}`);

  let nombreWA = '';
  try {
    const contacto = await msg.getContact();
    nombreWA = contacto.pushname || contacto.name || '';
  } catch (e) {}

  const historial = await getHistorial(telefono);
  const esPrimero = historial.length === 0;

  if (esPrimero && MI_NUMERO) {
    await avisarClienteNuevo(client, telefono, texto, pareceClienteConocido(texto), nombreWA);
  }

  await client.sendPresenceAvailable();
  await delayHumano();
  const chat = await msg.getChat();
  await chat.sendStateTyping();
  await delay(2000);

  const respuesta = await procesarMensaje(telefono, texto, client, msg.from, esPrimero, null);
  console.log(`🤖 ${respuesta}\n`);
  await msg.reply(respuesta);
});

console.log('🐾 Iniciando Groomer Copilot v20...');
client.initialize();