/* Pantalla «Mostrador» (docs/MOSTRADOR.md): quién va llegando, para la compu de recepción.
   - Entra con la contraseña del kiosco (acción `entrar` con dispositivo «mostrador»); su token va firmado como «mostrador»
     y se guarda en `hera_mostrador_token` (nunca toca las llaves del kiosco, que vive en el mismo origen).
   - Sondeo en dos tiempos (Olmo 21-nov, ≤ 5 s desde el toque): mientras hay clases pregunta cada 3 s SOLO la señal (acción
     `senal`: 1 lectura por id, sin cálculos) y pide `llegadas` completo cuando cambia; además, `llegadas` cada 30 s de
     todos modos (check-ins del panel, «faltan por llegar», revisar si un pendiente ya se cerró). Fuera de horario, lento.
   - Cada check-in de la TABLET sale en un recuadro arriba a la derecha (~8 s, máx. 3 a la vista): nombre de pila grande,
     clase y, si trae pendiente, «ver en Por resolver». Los del panel de Wix no (no hay nadie en la tablet).
   - La lista solo lleva a quien trae pendiente, en dos bloques: «Van llegando» (su clase no ha terminado) y «Se van yendo»
     (terminó hace ≤ 45 min: alcanzarla en la puerta). Pasados los 45 min, o si el pendiente se cerró en Wix, sale.
   - Llegada nueva con la pestaña en segundo plano → notificación del sistema (Notification API). Todo lo que no se ha visto
     desde que la pestaña pasó a segundo plano va en UNA notificación resumida (un aviso nuevo nunca borra uno con pendiente);
     primero quien trae pendiente, luego primera clase. Con detalle por omisión (Olmo 21-nov, 1B); «Avisos» la hace discreta.
   - Sonido opcional: un golpe de cuenco breve (Web Audio, sin archivos), uno por tanda de llegadas, volumen bajo/medio/alto.
   - El reloj del sondeo vive en un Worker (mostrador.worker.js): Chrome frena a 1 por minuto los temporizadores de una
     pestaña oculta más de 5 min, pero no los de un Worker. Si el Worker no carga, setTimeout de siempre.
   - Con dos pestañas abiertas en la misma compu, solo UNA avisa y suena (candado en localStorage); la otra solo pinta.
   - Solo pinta con textContent/createElement (un nombre «<img onerror>» sale como texto). Ningún script de terceros.
   ?dev=1 usa /_functions-dev (el código del Editor, sin publicar). En *.localhost habla con el servidor local. */
(function (raiz) {
  'use strict';
  var ZONA = 'America/Mexico_City';
  var TOKEN_KEY = 'hera_mostrador_token', SONIDO_KEY = 'hera_mostrador_sonido', AVISOS_KEY = 'hera_mostrador_avisos', LIDER_KEY = 'hera_mostrador_lider';
  var VOLUMEN_KEY = 'hera_mostrador_volumen';
  var RE_FICHA = /^https:\/\/manage\.wix\.com\/dashboard\/([0-9a-f-]{36})\/contacts\/view\/([0-9a-f-]{36})$/i;
  var SITIO_WIX = '21d18206-19d9-4b9f-9cc4-3c7a471ae6c4', RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /** Liga del subtítulo de una clase (Olmo 22-nov): la Lista de reservas de Wix filtrada por su servicio y HOY, de la más
   *  temprana a la más tarde (ahí cada reserva trae «Canjear sesión» / «Ir a la página de pago»). La vista «Administrar
   *  participantes» de una sesión no se puede ligar: su `dataCapsuleId` vive en el navegador que abrió el calendario. Se arma
   *  aquí con piezas validadas (sitio fijo, id del servicio con forma de UUID, nombre codificado); null si no hay servicio. */
  function ligaClase(c) {
    if (!c || !RE_UUID.test(String(c.servicio || ''))) return null;
    var q = 'tab=' + encodeURIComponent(JSON.stringify([{ id: 'booking-list', name: 'Citas y clases' }])) +
      '&bookingDate=TODAY&serviceName=' + encodeURIComponent(JSON.stringify([{ id: String(c.servicio).toLowerCase(), name: String(c.servicioNombre || c.disciplina || 'Clase').slice(0, 60) }])) +
      '&bookingStatus=' + encodeURIComponent(JSON.stringify([{ id: 'CONFIRMED', name: 'Confirmada' }])) + '&sort=' + encodeURIComponent('startDate asc');
    return 'https://manage.wix.com/dashboard/' + SITIO_WIX + '/bookings/bookings/bookings-list?' + q;
  }
  // v3 (Olmo 21-nov): cada pastilla lleva a la vista de Wix donde se resuelve. Lista blanca: solo manage.wix.com (armada aquí
  // con la ficha ya validada) y el permalink de una nota de #recepcion. Pestaña «Suscripciones» de la ficha (verificado en
  // Chrome el 21-nov). La sesión de la clase no tiene liga estable: la lista de reservas filtrada por ella es lo más cerca.
  var RE_SLACK = /^https:\/\/herazenter\.slack\.com\/archives\/[A-Z0-9]{8,12}\/p\d{16}$/;
  var TAB_SUSCRIPCIONES = 'efee1eb7-361a-4608-a229-9b2665ad668b';
  var DESTINOS = { canjear: '⋯ → Gestionar participantes → Canjear sesión', cobrar: '⋯ → Gestionar participantes → cobrar',
    suscripciones: 'abrir sus suscripciones', 'otra-ficha': 'abrir esa ficha', nota: 'abrir la nota en Slack' };
  var ELEMENTOS = { FUEGO: 1, AGUA: 1, AIRE: 1, TIERRA: 1 };
  var RE_ID_SENAL = /^[A-Za-z0-9_-]{6,80}$/;
  /** ¿`k` es una llave PROPIA de `o`? («constructor» o «__proto__» no pasan como color o elemento.) */
  function tiene(o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); }
  var MARCA_NUEVA_MS = 90000;                  // cuánto dura el resaltado de una llegada nueva
  var YENDO_MS = 45 * 60000;                   // «Se van yendo»: su clase terminó hace ≤ 45 min; después sale de la lista
  var TOPE_BLOQUE = 12;                        // renglones por bloque («+N más» abajo)
  var RECUADRO_MS = 8000;                      // cuánto dura el recuadro de una llegada de la tablet
  var RECUADROS_VISIBLES = 3;                  // máx. a la vista; las demás «+N» (esperan su turno: su reloj corre al verse)
  var RECUADROS_TOPE = 8;                      // en la cola, como mucho 8 (una clase de Fitpass que llega junta no se eterniza)
  var RECUADRO_RECIENTE_MS = 3 * 60000;        // al volver la conexión no se anuncia como «hizo check-in» lo de hace rato
  // El recuadro sale de la señal; la LISTA espera a que Bookings muestre el ATTENDED (revisión 21-nov M3): si la señal trajo
  // una llegada que la lista todavía no tiene, relecturas con espera creciente hasta verla (≈ 18 s tras la primera lectura);
  // si no trae ninguna nueva (una retirada de la lista, una señal vieja sin lista), hasta 3 si nada cambió.
  var ESPERAS_FRESCO = [2.1, 3, 5, 8];         // el tope del servidor es 1 «llegadas» cada 2 s
  var REINTENTOS_CAMBIO = 3;
  var ESPERADA_MS = 25000;                     // una llegada de la señal que la lista no trae en 25 s ya no se busca
  var SILENCIO_MS = 90000;                     // falla pasajera de Wix (`f`): la cola de la tablet reintenta cada ~20 s
  // v3.1 (caso real 21-nov, 17:22): el renglón PROVISIONAL de «Por resolver» (de la señal, con los pendientes que ya calculó
  // el 🛎️) dura hasta que la lista trae su detalle; si la lista nunca la trae (Bookings muy atrás, o la quitaron en el
  // panel), se va a los 5 min de su check-in.
  var PROVISIONAL_MS = 5 * 60000;
  var RE_CODIGO = /^[a-z-]{2,24}(?::[a-z0-9áéíóúñ*-]{1,24})?$/;
  var DETALLE_PRONTO_SEG = 2.1;                // una llegada nueva sin detalle (la lectura por la señal no lo calcula): otra vez a los 2.1 s
  var ESPERA_ERROR_SEG = 30;
  var TIEMPO_FETCH_MS = 20000;                 // una consulta colgada (wifi) se corta a los 20 s…
  var TIEMPO_SENAL_MS = 5000;                  // …y una señal (1 lectura por id) a los 5 s: no frena el repaso hasta 20 s
  var GRACIA_VIGIA_MS = 60000;                 // si pasó 1 min de la hora en que tocaba el sondeo, la pantalla se pone en rojo
  var LATIDO_VIEJO_MS = 20 * 60000;            // Ideas v3: con clases en horario, la tablet lleva más de 20 min sin pedir datos
  var LIDER_VENCE_MS = 90000;                  // la pestaña que avisa debe renovar su candado cada 90 s
  var TAG_AVISO = 'hera-mostrador', TAG_PENDIENTE = 'hera-mostrador-pend';
  var TEXTOS = {
    vacio: 'Todavía no llega nadie hoy.',
    sinProximas: 'Ninguna clase está por empezar.',
    sinHoras: 'No se pudo leer la hora de llegada: el orden es aproximado.',
    clave: 'Contraseña incorrecta.',
    muchos: 'Demasiados intentos. Espera 10 minutos.',
    red: 'No se pudo conectar. Revisa el internet.',
    cerrado: 'El kiosco está cerrado en Wix (falta su contraseña).',
    otraVez: 'La pantalla necesita la contraseña otra vez.',
    atrasada: 'Sin datos nuevos desde',
    permisoNo: 'Los avisos están bloqueados en este navegador. En docs/MOSTRADOR.md dice cómo activarlos.',
    sinNotif: 'Este navegador no da avisos del sistema; deja esta pestaña a la vista.'
  };

  // ------------------------------------------------------------------ utilidades puras
  function apiUrl(loc) {
    var host = (loc && loc.hostname) || '';
    if (/\.localhost$/.test(host)) return '/_functions/checkinApi';
    var dev = /[?&]dev(=|&|$)/.test((loc && loc.search) || '');
    return 'https://www.herazenter.com/' + (dev ? '_functions-dev' : '_functions') + '/checkinApi';
  }
  function hora(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    try { return d.toLocaleTimeString('es-MX', { timeZone: ZONA, hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s+/g, ' ').replace(/\s?a\.\s?m\./i, ' am').replace(/\s?p\.\s?m\./i, ' pm'); }
    catch (_) { return d.toISOString().slice(11, 16); }
  }
  /** «Reformer 7:30 am» (sin «Pilates» para que quepa en la notificación). */
  function claseCorta(c) {
    var d = String((c && c.disciplina) || 'Clase').replace(/^Pilates\s+/i, '');
    return d + ' ' + hora(c && c.inicio);
  }
  var prioridadDe = function (det) {
    if (!det) return 3;
    if (det.pendientes && det.pendientes.length) return 1;
    if ((det.insignias || []).some(function (x) { return x.tipo === 'primera'; })) return 2;
    return 3;
  };
  /** «Clienta A Ejemplo» → «Clienta A.» (para la notificación: nombre y la inicial del apellido). */
  function nombreCorto(n) {
    var ps = String(n || '').trim().split(/\s+/).filter(Boolean);
    if (!ps.length) return 'Alumna';
    return ps.length === 1 ? ps[0] : ps[0] + ' ' + ps[1].charAt(0).toLocaleUpperCase('es-MX') + '.';
  }
  /** Lo más importante de una llegada para la notificación: su pendiente, o 🌱, o 🎂, o nada.
   *  `detallado` = el modo «Avisos: con detalle» (dice CUÁL pendiente); si no, solo «trae pendiente». */
  function resaltado(t, detallado) {
    var det = t.detalle;
    if (det && det.pendientes && det.pendientes.length) return detallado ? det.pendientes.map(etiquetaAviso).join(' · ') : '⚠ trae pendiente';
    // Por la señal: se sabe que trae y (v3.1) CUÁL, con los códigos que calculó el 🛎️ en el check-in.
    if (!det && t.senal && t.senal.p) return detallado && (t.senal.temas || []).length ? t.senal.temas.map(etiquetaAviso).join(' · ') : '⚠ trae pendiente';
    if (det && (det.insignias || []).some(function (x) { return x.tipo === 'primera'; })) return '🌱 primera clase';
    if (det && (det.insignias || []).some(function (x) { return x.tipo === 'cumple'; })) return '🎂 cumple hoy';
    return '';
  }
  /** Lo que dice la notificación de un pendiente: el MISMO tema que su pastilla («💵 Su plan está en otra ficha»); un
   *  servidor viejo sin tema usa su etiqueta. */
  function etiquetaAviso(p) {
    if (p && p.tema) return (p.icono ? String(p.icono) + ' ' : '') + String(p.tema);
    return String((p && p.etiqueta) || 'pendiente');
  }
  /** Cuerpo de una llegada sin nada que resaltar: «Sin pendientes» SOLO si de verdad llegó su detalle. */
  function sinNada(t) { return t.detalle ? 'Sin pendientes' : t.senal ? 'hizo check-in' : 'Sin detalle todavía · revisa la pantalla'; }

  /** Mezcla una respuesta de `llegadas` con lo que ya hay. Devuelve { estado, nuevas, llegaron, cambio }:
   *  - `llegaron` = tarjetas vistas por primera vez (para el recuadro y el cuenco: en cuanto se ven, con o sin detalle);
   *  - `nuevas` = las que ya se pueden notificar. Una llegada nueva que vino SIN detalle (falló el cálculo en el servidor)
   *    espera UN sondeo a que llegue antes de avisar; si tampoco llega, se avisa igual («Sin detalle todavía»), nunca
   *    «Sin pendientes»;
   *  - `cambio` = llegó o se fue alguien (la relectura tras la señal ya no hace falta).
   *  En la PRIMERA carga desde que se abrió la pantalla no hay ni «nuevas» ni «llegaron»: no se avisa de lo de toda la mañana.
   *  Si el servidor manda otra vez el detalle de una tarjeta, gana el nuevo. `abiertos` (revisión: ¿ya se cerró en Wix?) quita
   *  de su detalle los pendientes que ya no siguen abiertos. Con `ligera` (lectura por la señal: el servidor aplazó el
   *  detalle de las recién llegadas), la que no trae detalle sigue esperando: no se avisa «Sin detalle todavía». */
  function cerrarPendientes(det, abiertos) {
    if (!det || !Array.isArray(det.pendientes) || !Array.isArray(abiertos)) return det;
    var out = {}, k;
    for (k in det) if (Object.prototype.hasOwnProperty.call(det, k)) out[k] = det[k];
    // La llave es el tipo; una 📝, `nota:<acción>` (dos notas de la misma clienta se cierran por separado con su botón).
    // `nota:*`: el servidor no pudo leer las notas, ninguna 📝 se da por cerrada.
    var notasSinLeer = abiertos.indexOf('nota:*') >= 0;
    out.pendientes = det.pendientes.filter(function (p) {
      if (!p) return false;
      var l = String(p.llave || p.tipo);
      return abiertos.indexOf(l) >= 0 || (notasSinLeer && l.indexOf('nota:') === 0);
    });
    return out;
  }
  function combinar(estado, resp) {
    var e = estado || { dia: null, cursor: null, tarjetas: [], vistos: {}, esperan: {}, cargado: false };
    var cambioDia = e.dia !== resp.dia;
    var previas = {}, vistos = cambioDia ? {} : e.vistos, esperan = cambioDia ? {} : (e.esperan || {}), siguen = {}, i;
    if (!cambioDia) for (i = 0; i < e.tarjetas.length; i++) previas[e.tarjetas[i].id] = e.tarjetas[i];
    var tarjetas = [], nuevas = [], llegaron = [], antes = 0;
    for (var pk in previas) if (Object.prototype.hasOwnProperty.call(previas, pk)) antes++;
    var ls = Array.isArray(resp.llegadas) ? resp.llegadas : [];
    for (i = 0; i < ls.length; i++) {
      var l = ls[i], p = previas[l.id], t = {};
      for (var k in l) if (Object.prototype.hasOwnProperty.call(l, k)) t[k] = l[k];
      if (t.detalle === undefined) t.detalle = p ? p.detalle : undefined;   // el servidor solo manda el detalle de las nuevas
      if (Array.isArray(l.abiertos)) t.detalle = cerrarPendientes(t.detalle, l.abiertos);
      delete t.abiertos;
      t.prioridad = prioridadDe(t.detalle);
      t.desde = p ? p.desde : Date.now();
      t.nueva = p ? !!p.nueva : false;
      var primeraVez = !vistos[l.id];
      if (primeraVez) vistos[l.id] = 1;
      if (e.cargado && primeraVez) llegaron.push(t);
      if (e.cargado && (primeraVez || esperan[l.id])) {
        if (t.detalle === undefined && (primeraVez || resp.ligera)) siguen[l.id] = 1;   // un sondeo (no ligero) más por su detalle
        else nuevas.push(t);
      }
      tarjetas.push(t);
    }
    nuevas.sort(function (a, b) { return a.prioridad - b.prioridad; });
    var siguenTodas = tarjetas.filter(function (t) { return previas[t.id]; }).length;
    var cambio = !!llegaron.length || siguenTodas !== antes || tarjetas.length !== antes;
    return { estado: { dia: resp.dia, cursor: resp.cursor || (cambioDia ? null : e.cursor), tarjetas: tarjetas, vistos: vistos, esperan: siguen, cargado: true,
      proximas: conMarcasPrevias(Array.isArray(resp.proximas) ? resp.proximas : [], cambioDia ? [] : e.proximas), horas: resp.horas !== false,
      total: Number(resp.total) > tarjetas.length ? Number(resp.total) : tarjetas.length, rezago: Number(resp.rezagoPanel) > 0,
      ahora: resp.ahora || null,
      // v3: conteo por clase (subtítulos), latido de la tablet (la lectura por la señal no lo trae: se conserva) y si hay clases.
      clases: Array.isArray(resp.clases) ? resp.clases : (cambioDia ? [] : (e.clases || [])),
      tablet: resp.tablet !== undefined ? resp.tablet : (cambioDia ? null : (e.tablet || null)),
      activo: resp.sondeo ? !!resp.sondeo.activo : (cambioDia ? true : e.activo !== false) }, nuevas: nuevas, llegaron: llegaron, cambio: cambio };
  }

  /** Junta lo que no se ha visto (por id, sin repetir) mientras la pestaña sigue en segundo plano: el resumen sale de TODO
   *  eso, así un aviso nuevo sin pendiente no borra el de quien sí traía. Se vacía al volver a la pestaña. */
  function acumular(sinVer, nuevas) {
    var out = (sinVer || []).slice(), pos = {};
    out.forEach(function (t, i) { pos[t.id] = i; });
    // La misma llegada otra vez (primero por la señal, luego con su detalle): gana la más nueva, en su lugar.
    (nuevas || []).forEach(function (t) { if (pos[t.id] != null) out[pos[t.id]] = t; else { pos[t.id] = out.length; out.push(t); } });
    return out;
  }

  /** Una sola notificación. 1 llegada: «Llegó Clienta A. · Reformer 7:30 am» + «⚠ trae pendiente» (o, con detalle,
   *  «💳 pago pendiente»). Varias: «Llegaron 3 · Reformer 7:30 am» y en el cuerpo primero quien trae pendiente o es
   *  primera clase. `tag`: las que traen pendiente usan su propia etiqueta (una sin pendiente no la puede pisar).
   *  `fija` (se queda hasta cerrarla) solo en modo discreto: no dice qué pendiente ni el apellido. */
  function resumenNotificacion(nuevas, opciones) {
    var detallado = !!(opciones && opciones.detallado);
    var xs = (nuevas || []).slice().sort(function (a, b) { return (a.prioridad || 3) - (b.prioridad || 3); });
    if (!xs.length) return null;
    var urgente = xs.some(function (t) { return t.prioridad === 1; });
    var fin = function (n) { n.urgente = urgente; n.tag = urgente ? TAG_PENDIENTE : TAG_AVISO; n.fija = urgente && !detallado; return n; };
    if (xs.length === 1) {
      var t = xs[0];
      return fin({ titulo: 'Llegó ' + nombreCorto(t.nombre) + ' · ' + claseCorta(t.clase), cuerpo: resaltado(t, detallado) || sinNada(t) });
    }
    var clases = {}, nClases = 0;
    xs.forEach(function (x) { var k = claseCorta(x.clase); if (!clases[k]) { clases[k] = 1; nClases++; } });
    var titulo = 'Llegaron ' + xs.length + ' · ' + (nClases === 1 ? claseCorta(xs[0].clase) : nClases + ' clases');
    var conAlgo = xs.filter(function (x) { return resaltado(x, detallado); }), sinAlgo = xs.filter(function (x) { return !resaltado(x, detallado); });
    var partes = conAlgo.slice(0, 3).map(function (x) { return nombreCorto(x.nombre) + ': ' + resaltado(x, detallado); });
    var resto = conAlgo.length - Math.min(3, conAlgo.length) + sinAlgo.length;
    var nombres = sinAlgo.slice(0, conAlgo.length ? 0 : 3).map(function (x) { return nombreCorto(x.nombre); });
    if (nombres.length) partes.push(nombres.join(', '));
    resto -= nombres.length;
    if (resto > 0) partes.push('y ' + resto + ' más');
    return fin({ titulo: titulo, cuerpo: partes.join(' · ') });
  }

  /** ¿Esta pestaña es la que avisa? Sí si nadie tiene el candado, si es suyo o si el de otra venció (90 s sin renovar). */
  function soyLider(valor, miId, ahoraMs) {
    var v = null;
    try { v = valor ? JSON.parse(valor) : null; } catch (_) { v = null; }
    if (!v || typeof v.id !== 'string' || !Number.isFinite(v.t)) return true;
    return v.id === miId || ahoraMs - v.t > LIDER_VENCE_MS || v.t > ahoraMs + LIDER_VENCE_MS;
  }

  /** ¿El sondeo ya se atrasó? (consulta colgada, Worker muerto, compu dormida): pasó 1 min de cuando tocaba. */
  function atrasado(ahoraMs, tocaba) { return !!tocaba && ahoraMs > tocaba + GRACIA_VIGIA_MS; }

  /** Título de la pestaña: «⚠ …» si hay un problema (sin conexión, contraseña), «(3)» con las que no se han visto. */
  function tituloDe(base, sinVer, alerta) {
    return (alerta ? '⚠ ' + alerta + ' · ' : '') + (sinVer ? '(' + sinVer + ') ' : '') + base;
  }

  /** Corta una promesa a los `ms` (la consulta colgada ya no congela la pantalla en verde). */
  function conTiempo(p, ms, alCortar, reloj) {
    var st = (reloj && reloj.setTimeout) || setTimeout, ct = (reloj && reloj.clearTimeout) || clearTimeout;
    return new Promise(function (ok, mal) {
      var h = st(function () { try { if (alCortar) alCortar(); } catch (_) {} mal(new Error('tiempo')); }, ms);
      p.then(function (v) { ct(h); ok(v); }, function (e) { ct(h); mal(e); });
    });
  }

  /** ¿La pestaña está en segundo plano? (oculta, o la ventana no tiene el foco: recepción está en Wix o en WhatsApp). */
  function enSegundoPlano(doc) {
    if (!doc) return false;
    if (doc.hidden || doc.visibilityState === 'hidden') return true;
    return typeof doc.hasFocus === 'function' ? !doc.hasFocus() : false;
  }

  // ------------------------------------------------------------------ pintar (sin red: se prueba en Node con un DOM falso)
  function el(doc, tag, cls, texto) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (texto != null) e.textContent = String(texto);
    return e;
  }
  function vaciar(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function nombreNodo(doc, nombre, ficha, cls) {
    var n;
    if (ficha && RE_FICHA.test(String(ficha))) { n = el(doc, 'a', cls, nombre); n.href = String(ficha); n.target = '_blank'; n.rel = 'noopener noreferrer'; }
    else n = el(doc, 'span', cls, nombre);
    return n;
  }

  /** Tema de un pendiente para su pastilla: { icono, tema, accion, urgencia, color } (lo manda el servidor). Si no viene
   *  (servidor viejo), se arma con su texto: lo de antes de «→» es el tema y lo de después la acción. */
  var COLORES = { pago: 1, canje: 1, offline: 1, pausa: 1, nota: 1, neutro: 1, primera: 1, cumple: 1, aviso: 1, equipo: 1 };
  function temaDe(p) {
    if (p && p.tema) {
      var x = { icono: String(p.icono || ''), tema: String(p.tema), accion: String(p.accion || ''), urgencia: Number(p.urgencia) || 6,
        color: tiene(COLORES, p.color) ? p.color : 'neutro', texto: p.texto };
      if (p.ficha && RE_FICHA.test(String(p.ficha))) x.ficha = String(p.ficha);   // 💵 plan en otra ficha: liga a ESA ficha
      if (tiene(DESTINOS, p.destino)) x.destino = p.destino;                       // a qué vista de Wix lleva (v3)
      if (p.destino === 'nota' && RE_SLACK.test(String(p.liga || ''))) x.liga = String(p.liga);
      return x;
    }
    var partes = String((p && (p.texto || p.etiqueta)) || 'Pendiente').split(/\s*→\s*/);
    return { icono: '', tema: partes[0], accion: partes[1] || '', urgencia: 6, color: 'neutro', texto: p && p.texto };
  }
  /** Pastillas de una llegada, en orden: sus pendientes (más urgente primero), luego 🌱 primera clase, 🎂 cumple, el
   *  marketplace (validar su código) y los avisos de renovar (🔚 ⏳, pastilla gris chica: son oportunidad de venta y en la
   *  línea gris se cortaban). Lo demás (⭐, años, plan, saldo) va en la línea gris. */
  function pastillasDe(t) {
    var det = t.detalle || null, out = [];
    if (!det) return out;
    if (det.sinDetalle) return [{ icono: '', tema: 'Sin detalle', accion: 'revisar su ficha', color: 'neutro', texto: (det.avisos || [])[0] }];
    (det.pendientes || []).map(temaDe).sort(function (a, b) { return a.urgencia - b.urgencia; }).forEach(function (x) { out.push(x); });
    equipoDe(t).forEach(function (x) { out.push({ icono: '', tema: textoEquipo(x), accion: 'no se cobra', color: 'equipo', texto: TEXTO_EQUIPO }); });
    var ins = det.insignias || [];
    if (ins.some(function (x) { return x.tipo === 'primera'; })) out.push({ icono: '🌱', tema: 'Primera clase', accion: '', color: 'primera', texto: 'Es su primera clase en Hera: recibirla' });
    if (ins.some(function (x) { return x.tipo === 'cumple'; })) out.push({ icono: '🎂', tema: 'Cumple', accion: '', color: 'cumple', texto: 'Cumple años hoy: felicitarla' });
    if (det.market || t.market) out.push({ icono: '🎟️', tema: String(det.plan || t.nombre || 'Marketplace'), accion: 'validar su código', color: 'neutro', texto: (det.avisos || [])[0] });
    else if (det.sinFicha) out.push({ icono: '', tema: 'Sin ficha en Wix', accion: 'revisar', color: 'neutro', texto: (det.avisos || [])[0] });
    else (det.avisos || []).forEach(function (a) { out.push({ icono: '', tema: String(a), accion: '', color: 'aviso', texto: String(a) }); });
    return out;
  }
  /** Liga de una pastilla a la vista donde se resuelve (v3), o null. Se arma AQUÍ con piezas validadas (lista blanca): el
   *  sitio y el contacto salen de su ficha (RE_FICHA), las pestañas son fijas y el nombre va codificado; de fuera solo entra
   *  el permalink de una nota de #recepcion (RE_SLACK) y la OTRA ficha (RE_FICHA).
   *  - canjear / cobrar → la lista de reservas filtrada por ella (cada reserva dice «Estado del pago»; «⋯ → Gestionar
   *    participantes» abre la sesión, donde está «Canjear sesión»);
   *  - suscripciones → su ficha en la pestaña Suscripciones; otra-ficha → la otra ficha; nota → la nota en Slack. */
  function ligaDe(x, t) {
    if (!x || !tiene(DESTINOS, x.destino)) return null;
    if (x.destino === 'nota') return RE_SLACK.test(String(x.liga || '')) ? String(x.liga) : null;
    if (x.destino === 'otra-ficha') return x.ficha && RE_FICHA.test(String(x.ficha)) ? String(x.ficha) : null;
    var ficha = String((t && t.detalle && t.detalle.ficha) || ''), m = RE_FICHA.exec(ficha);
    if (!m) return null;
    if (x.destino === 'suscripciones') return ficha + '?tab_name=' + TAB_SUSCRIPCIONES;
    var tab = JSON.stringify([{ id: 'booking-list', name: 'Citas y clases' }]);
    var quien = JSON.stringify([{ id: m[2].toLowerCase(), name: String((t && t.nombre) || 'Clienta').slice(0, 80) }]);
    return 'https://manage.wix.com/dashboard/' + m[1].toLowerCase() + '/bookings/bookings/bookings-list?tab=' + encodeURIComponent(tab) + '&contact=' + encodeURIComponent(quien);
  }
  // v3.1: equipo y Lobas (alta_bloqueados o plan Lobas): no se les cobra, así que el 💵 se calla (y nunca va a Slack). En el
  // Mostrador sale como pastilla gris informativa «equipo · 💵 sin canjear»: no ocupa «Por resolver» (va como chip en el
  // subtítulo de su clase) ni lanza «trae pendiente» (decisión documentada en docs/MOSTRADOR.md, v3.1).
  var TEXTO_EQUIPO = 'Del equipo o Lobas: no se le cobra (informativo)';
  function equipoDe(t) { var d = t && t.detalle; return (d && Array.isArray(d.equipo) ? d.equipo : []).filter(function (x) { return x && x.tema; }); }
  function minuscula(x) { var s = String(x || ''); return s ? s.charAt(0).toLocaleLowerCase('es-MX') + s.slice(1) : s; }
  function textoEquipo(x) { return 'equipo · ' + (x.icono ? String(x.icono) + ' ' : '') + minuscula(x.tema); }
  /** Las 1–2 primeras pastillas en texto corto («💵 Sin canjear · +1»), para el recuadro. */
  function etiquetas(ps) { var xs = (ps || []).slice(0, 2).map(etiquetaAviso); if ((ps || []).length > 2) xs.push('+' + (ps.length - 2)); return xs.join(' · '); }
  /** v3.1: el catálogo código → pastilla que manda el servidor (`catalogo`, una vez), validado: texto corto, color y destino
   *  conocidos (la 📝 y «otra ficha» sin destino: su liga solo viene con el detalle). */
  function leerCatalogo(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    var out = {}, n = 0;
    for (var k in c) {
      if (!Object.prototype.hasOwnProperty.call(c, k) || !RE_CODIGO.test(k) || n >= 80) continue;
      var x = c[k];
      if (!x || typeof x !== 'object' || typeof x.tema !== 'string' || !x.tema || x.tema.length > 60) continue;
      out[k] = { icono: String(x.icono || '').slice(0, 8), tema: x.tema, accion: String(x.accion || '').slice(0, 80), urgencia: Number(x.urgencia) || 6,
        color: tiene(COLORES, x.color) ? x.color : 'neutro' };
      if (tiene(DESTINOS, x.destino) && x.destino !== 'nota' && x.destino !== 'otra-ficha') out[k].destino = x.destino;
      n++;
    }
    return n ? out : null;
  }
  function codigosDe(xs) {
    var out = [];
    (Array.isArray(xs) ? xs : []).forEach(function (x) { if (typeof x === 'string' && RE_CODIGO.test(x) && out.indexOf(x) < 0 && out.length < 6) out.push(x); });
    return out;
  }
  /** Códigos de la señal → pastillas (con el catálogo). Uno que no está usa el de su tipo («reserva:cobrar» → «reserva»); sin
   *  catálogo (servidor viejo), nada: el recuadro dice «trae pendiente» a secas. */
  function temasDeCodigos(cs, cat) {
    if (!cat) return [];
    return codigosDe(cs).map(function (k) {
      var tipo = k.split(':')[0], x = (tiene(cat, k) && cat[k]) || (tiene(cat, tipo) && cat[tipo]) || (tipo === 'nota' && tiene(cat, 'nota:otra') && cat['nota:otra']) || null;
      var o = x ? { tipo: tipo, icono: x.icono, tema: x.tema, accion: x.accion, urgencia: x.urgencia, color: x.color } : { tipo: tipo, icono: '', tema: 'Pendiente', accion: 'revisar su ficha', urgencia: 6, color: 'neutro' };
      if (x && x.destino) o.destino = x.destino;
      return o;
    }).sort(function (a, b) { return a.urgencia - b.urgencia; });
  }
  /** La señal de una llegada para su recuadro: { p, e } y, si los trae (v3.1), sus temas y lo callado por ser del equipo. */
  function senalDe(e, cat) {
    var sn = { p: e.p ? 1 : 0, e: e.e }, ts = temasDeCodigos(e.t, cat), eq = temasDeCodigos(e.q, cat);
    if (ts.length) sn.temas = ts;
    if (eq.length) sn.eq = eq;
    return sn;
  }
  /** Detalle PROVISIONAL (v3.1) de una llegada, con lo que dijo la señal: sus pendientes como pastillas, el color de su
   *  elemento y su ficha (de «Faltan por llegar»). La lista completa lo confirma o lo reemplaza en segundos. */
  function detalleProvisional(sn, ficha) {
    var d = { elemento: sn && tiene(ELEMENTOS, sn.e) ? sn.e : null, plan: '', saldo: null, ficha: ficha && RE_FICHA.test(String(ficha)) ? String(ficha) : null,
      insignias: [], pendientes: (sn && sn.temas) || [], avisos: [], provisional: true };
    if (sn && sn.eq) d.equipo = sn.eq.map(function (x) { return { tipo: x.tipo, icono: x.icono, tema: x.tema, urgencia: x.urgencia, color: 'equipo' }; });
    return d;
  }
  /** «Por resolver» con los renglones provisionales (v3.1): uno por llegada de la señal que trae pendiente (o lo callado del
   *  equipo) mientras la lista no trae su detalle. Si la lista ya la trae SIN detalle (lectura ligera), su tarjeta toma el
   *  detalle provisional; si la trae CON detalle, manda la lista (nunca dos renglones de la misma). */
  function conProvisionales(ts, provs) {
    var out = (ts || []).slice(), pos = {};
    out.forEach(function (t, i) { pos[t.id] = i; });
    (provs || []).forEach(function (p) {
      if (!p || !p.id || !p.detalle) return;
      var i = pos[p.id], base = i != null ? out[i] : p, o = {}, k;
      if (i != null && base.detalle) return;
      for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) o[k] = base[k];
      o.detalle = p.detalle; o.provisional = true; o.prioridad = prioridadDe(p.detalle);
      if (i != null) out[i] = o; else { pos[p.id] = out.length; out.push(o); }
    });
    return out;
  }
  /** ¿Se sabe qué traía? No si su detalle no ha llegado (primera carga con más de 25, cálculo que falló) o vino vacío. */
  function sinDetalle(t) { return !t.detalle || !!t.detalle.sinDetalle; }
  /** Urgencia de una llegada para «Por resolver» (la de su pendiente más urgente). */
  function urgenciaDe(t) {
    var ps = (t.detalle && t.detalle.pendientes) || [], u = 99;
    for (var i = 0; i < ps.length; i++) u = Math.min(u, temaDe(ps[i]).urgencia);
    return u;
  }
  /** Fin de su clase (ms). El servidor lo manda (`clase.fin`); uno viejo no: inicio + 60 min, como `finDe` del servidor. */
  function finClase(c) {
    var f = Date.parse((c && c.fin) || '');
    if (Number.isFinite(f)) return f;
    var i = Date.parse((c && c.inicio) || '');
    return Number.isFinite(i) ? i + 60 * 60000 : NaN;
  }
  /** ¿Trae tema para la lista? Un pendiente accionable, un detalle que no se pudo armar («Sin detalle / revisar su ficha») o
   *  un marketplace (🎟️ validar su código: si nadie lo valida, se pierde el pago de esa visita). 🌱 primera clase y los
   *  avisos de renovar (🔚 ⏳) NO: solo van en su recuadro y en Slack (decisión pendiente de Olmo, docs/MOSTRADOR.md P3). */
  function conTema(t) { return !!t.detalle && (t.prioridad === 1 || !!t.detalle.sinDetalle || !!t.detalle.market); }
  /** La lista de «Por resolver» (Olmo 21-nov: «si no tienen pendientes no es necesario que se queden en el listado, y que
   *  haya un separador…»): SOLO quien trae tema, en dos bloques.
   *  - `van`: su clase no ha terminado (por empezar o en curso), la más nueva arriba;
   *  - `yendo`: su clase terminó hace ≤ 45 min (alcanzarla en la puerta), la que acaba de terminar arriba;
   *  - `fuera`: con tema pero su clase terminó hace más de 45 min (ya no sale; queda en el resumen de Slack);
   *  - `sinDetalle`: llegadas cuyo detalle no ha llegado (no se sabe si traen tema); `conTema` y `total` para el contador. */
  /** 🌱 primera clase y 🎂 cumple de quien NO trae tema (Ideas v3): un chip en el subtítulo de su clase, sin renglón. */
  function chipsDe(t) {
    var ins = (t.detalle && t.detalle.insignias) || [], out = [];
    if (ins.some(function (x) { return x && x.tipo === 'primera'; })) out.push('🌱');
    if (ins.some(function (x) { return x && x.tipo === 'cumple'; })) out.push('🎂');
    return out;
  }
  function bloques(ts, ahoraMs) {
    var ahora = ahoraMs || Date.now(), van = [], yendo = [], fuera = 0, sd = 0, ct = 0, chipsVan = [], chipsYendo = [];
    (ts || []).forEach(function (t) {
      if (!t.detalle) { sd++; return; }
      var f = finClase(t.clase), aVan = !Number.isFinite(f) || ahora < f, aYendo = !aVan && ahora - f <= YENDO_MS;
      if (!conTema(t)) {
        if (chipsDe(t).length || equipoDe(t).length) { if (aVan) chipsVan.push(t); else if (aYendo) chipsYendo.push(t); }
        return;
      }
      ct++;
      if (aVan) van.push(t);
      else if (aYendo) yendo.push(t);
      else fuera++;
    });
    var porHora = function (a, b) { return String(b.hora || '').localeCompare(String(a.hora || '')); };
    van.sort(porHora);
    // Por fin de su clase y, si dos clases terminan juntas (Reformer y Mat), por clase: sus renglones no se intercalan y el
    // encabezado «Terminó…» sale una vez por clase.
    var claseDe = function (t) { return String((t.clase && (t.clase.id || t.clase.inicio)) || ''); };
    yendo.sort(function (a, b) { return finClase(b.clase) - finClase(a.clase) || claseDe(a).localeCompare(claseDe(b)) || porHora(a, b); });
    return { van: van, yendo: yendo, fuera: fuera, sinDetalle: sd, conTema: ct, total: (ts || []).length, chipsVan: chipsVan, chipsYendo: chipsYendo };
  }
  var claveClase = function (c) { return String((c && (c.id || c.inicio)) || ''); };
  /** Grupos por clase (Olmo 21-nov: «que el nombre de la clase sea una subcategoría, para ver todos juntos por tipo de
   *  clase»): { clase, filas, chips }. En «Van llegando», por hora de la clase (la que empieza antes arriba); en «Se van
   *  yendo», la que acaba de terminar arriba. Dentro, el orden de siempre (la llegada más nueva arriba). */
  function agrupar(filas, chips, yendo) {
    var g = {}, orden = [];
    var de = function (t) { var k = claveClase(t.clase); if (!g[k]) { g[k] = { clase: t.clase || {}, filas: [], chips: [] }; orden.push(g[k]); } return g[k]; };
    (filas || []).forEach(function (t) { de(t).filas.push(t); });
    (chips || []).forEach(function (t) { de(t).chips.push(t); });
    var ini = function (x) { var v = Date.parse(x.clase.inicio || ''); return Number.isFinite(v) ? v : 0; };
    orden.sort(yendo ? function (a, b) { return finClase(b.clase) - finClase(a.clase) || claveClase(a.clase).localeCompare(claveClase(b.clase)); }
      : function (a, b) { return ini(a) - ini(b) || claveClase(a.clase).localeCompare(claveClase(b.clase)); });
    return orden;
  }
  /** «2 con tema · 5/7 llegaron» (llegaron / reservadas, con invitadas; el cupo no viene en las reservas de Wix). */
  function cuentaGrupo(g, resumen) {
    var r = null;
    (resumen || []).forEach(function (x) { if (x && x.id === (g.clase && g.clase.id)) r = x; });
    var partes = [];
    if (g.filas.length) partes.push(g.filas.length + ' con tema');
    if (r && Number(r.lugares) > 0) partes.push((Number(r.llegaron) || 0) + '/' + Number(r.lugares) + ' llegaron');
    return partes.join(' · ');
  }
  /** Aviso de la tablet (Ideas v3): con clases en horario, si lleva más de 20 min sin pedir datos (apagada, sin internet o en
   *  otra pantalla), nadie está haciendo check-in en ella. Sin latido (nunca se escribió) no se dice nada. */
  function avisoTablet(tablet, ahoraMs, activo) {
    var v = Date.parse((tablet && tablet.visto) || '');
    if (!activo || !Number.isFinite(v) || ahoraMs - v <= LATIDO_VIEJO_MS) return '';
    // De otro día lo dice (revisión 21-nov: «desde las 9:00 pm» podía ser de ayer).
    var d = diaDe(v), hoy = diaDe(ahoraMs), ayer = diaDe(ahoraMs - 864e5), cuando = hora(new Date(v).toISOString());
    var desde = d === hoy ? 'desde las ' + cuando : d === ayer ? 'desde ayer a las ' + cuando : 'desde el ' + fechaCorta(v) + ' a las ' + cuando;
    return '⚠ La tablet no ha pedido datos ' + desde + ': revisa que esté prendida, con internet y en el kiosco.';
  }
  function diaDe(ms) { try { return new Date(ms).toLocaleDateString('en-CA', { timeZone: ZONA }); } catch (_) { return new Date(ms).toISOString().slice(0, 10); } }
  function fechaCorta(ms) { try { return new Date(ms).toLocaleDateString('es-MX', { timeZone: ZONA, day: 'numeric', month: 'short' }).replace('.', ''); } catch (_) { return diaDe(ms); } }
  /** Las entradas válidas de la señal (v3), o null si no trae lista (servidor o documento viejo). Las retiradas siempre; las
   *  demás solo si son de los últimos 3 min (al volver la conexión no se anuncia lo de hace rato). */
  function entradasSenal(ll, ahoraMs) {
    if (!Array.isArray(ll)) return null;
    var out = [];
    ll.slice(-8).forEach(function (e) {
      if (!e || !RE_ID_SENAL.test(String(e.id || ''))) return;
      var ts = Date.parse(e.ts || '');
      if (!Number.isFinite(ts)) return;
      var o = { id: String(e.id), ts: new Date(ts).toISOString(), x: e.x === 1, f: e.x === 1 && e.f === 1, p: e.p === 1,
        e: tiene(ELEMENTOS, e.e) ? e.e : '', c: typeof e.c === 'string' ? e.c : '', m: typeof e.m === 'string' && /^[A-Za-zÁÉÍÓÚáéíóúñÑ ]{2,20}$/.test(e.m) ? e.m : '' };
      var t = codigosDe(e.t), q = codigosDe(e.q);               // v3.1: códigos de sus pendientes y de lo callado (equipo)
      if (t.length) o.t = t;
      if (q.length) o.q = q;
      if (!o.x && e.ok === 1) o.ok = true;                      // latencia: un reintento que Wix ya aceptó (no se calla)
      var k = cronoDe(e.k);                                     // cronómetro (solo números)
      if (k) o.k = k;
      if (typeof e.i === 'string' && /^[0-9a-f]{4}$/.test(e.i)) o.i = e.i;
      if (o.x || ahoraMs - ts <= RECUADRO_RECIENTE_MS) out.push(o);
    });
    return out;
  }
  /** Una llegada de la señal como tarjeta para su recuadro: nombre, iniciales y clase salen de «Faltan por llegar» (la
   *  señal no lleva nombres); el Fitpass, de su marca y su clase. null si no se encuentra (llegará por «llegadas»). */
  function deSenal(e, est, cat, dir) {
    var ps = (est && est.proximas) || [], i, j;
    for (i = 0; i < ps.length; i++) {
      var p = ps[i], cl = { id: p.id, disciplina: p.disciplina, inicio: p.inicio, fin: p.fin, coach: p.coach, servicio: p.servicio, servicioNombre: p.servicioNombre };
      if (e.m) { if (e.c && p.id === e.c) return { id: e.id, nombre: e.m, iniciales: '🎟️', market: true, origen: 'tablet', hora: e.ts, clase: cl, senal: { p: 0 } }; continue; }
      var fs = Array.isArray(p.faltan) ? p.faltan : [];
      for (j = 0; j < fs.length; j++) if (fs[j] && fs[j].id === e.id) {
        var t = { id: e.id, nombre: String(fs[j].nombre || 'Alumna'), iniciales: String(fs[j].iniciales || '?'), origen: 'tablet', hora: e.ts, clase: cl,
          lugares: fs[j].lugares, senal: senalDe(e, cat) };
        if (fs[j].ficha && RE_FICHA.test(String(fs[j].ficha))) t.ficha = String(fs[j].ficha);   // para la liga de su renglón provisional
        return t;
      }
    }
    // Latencia (21-nov noche): ya no está en «Faltan por llegar» (Bookings ya la quitó, o la marcan otra vez tras quitarla),
    // pero la pantalla la vio hoy: su nombre sale del directorio (lo que ya se vio en «Faltan por llegar» y en la lista).
    var d = !e.m && dir && Object.prototype.hasOwnProperty.call(dir, e.id) ? dir[e.id] : null;
    if (d) {
      var u = { id: e.id, nombre: d.nombre, iniciales: d.iniciales, origen: 'tablet', hora: e.ts, clase: d.clase, lugares: d.lugares, senal: senalDe(e, cat) };
      if (d.ficha) u.ficha = d.ficha;
      return u;
    }
    return null;
  }
  /** Directorio del día para `deSenal`: id → nombre, iniciales, clase (y ficha) de «Faltan por llegar» y de la lista. Lo
   *  nuevo pisa lo viejo; cambia de día → empieza vacío. Solo vive en la memoria de la página (como `estado`). */
  function alDirectorio(dir, est) {
    var out = dir && dir.dia === (est && est.dia) ? dir : { dia: est && est.dia, ids: {} }, n = 0, k;
    for (k in out.ids) if (Object.prototype.hasOwnProperty.call(out.ids, k)) n++;
    if (n > 600) out = { dia: out.dia, ids: {} };                // tope (un día normal trae ≈ 200)
    var pon = function (id, nombre, iniciales, clase, lugares, ficha) {
      if (!id || !RE_ID_SENAL.test(String(id)) || !nombre) return;
      var o = { nombre: String(nombre), iniciales: String(iniciales || '?'), clase: clase || null };
      if (lugares) o.lugares = lugares;
      if (ficha && RE_FICHA.test(String(ficha))) o.ficha = String(ficha);
      out.ids[id] = o;
    };
    ((est && est.tarjetas) || []).forEach(function (t) { if (!t.provisional && !(t.detalle && t.detalle.market)) pon(t.id, t.nombre, t.iniciales, t.clase, t.lugares, t.detalle && t.detalle.ficha); });
    ((est && est.proximas) || []).forEach(function (p) {
      var cl = { id: p.id, disciplina: p.disciplina, inicio: p.inicio, fin: p.fin, coach: p.coach, servicio: p.servicio, servicioNombre: p.servicioNombre };
      [].concat(Array.isArray(p.faltan) ? p.faltan : [], Array.isArray(p.yaLlegaron) ? p.yaLlegaron : []).forEach(function (f) { if (f && !f.market) pon(f.id, f.nombre, f.iniciales, cl, f.lugares, f.ficha); });
    });
    return out;
  }

  // ------------------------------------------------------------------ cronómetro (?medir=1; latencia, Olmo 21-nov noche)
  /** [tq, te, tr, ts, n, fr, ca] de la señal (M.cronoSenal en el servidor), validado; null si no sirve. */
  function cronoDe(k) {
    if (!Array.isArray(k) || k.length < 7) return null;
    var num = function (x) { return typeof x === 'number' && isFinite(x) ? x : null; };
    var o = { tq: num(k[0]), te: num(k[1]), tr: num(k[2]), ts: num(k[3]), n: num(k[4]), fr: k[5] === 1, ca: k[6] === 1 };
    return o.tr == null || o.ts == null ? null : o;
  }
  /** Una muestra del reloj del servidor como NTP: `srv` = [llegó, salió] (ms del servidor), envío y recibo con el reloj de esta
   *  compu. off = cuánto hay que sumarle a Date.now() para tener la hora del servidor; rtt = ida y vuelta sin el proceso. */
  function muestraReloj(envio, recibo, srv) {
    if (!Array.isArray(srv) || srv.length !== 2 || typeof srv[0] !== 'number' || typeof srv[1] !== 'number' || !isFinite(srv[0]) || !isFinite(srv[1])) return null;
    var rtt = (recibo - envio) - (srv[1] - srv[0]), off = ((srv[0] - envio) + (srv[1] - recibo)) / 2;
    return rtt > -100 && isFinite(off) ? { off: off, rtt: Math.max(0, rtt) } : null;
  }
  /** Se queda con la muestra de menor ida y vuelta (la más exacta); la renueva si tiene más de 10 min. */
  function mejorReloj(prev, m, ahoraLocal) {
    if (!m) return prev;
    if (!prev || m.rtt <= prev.rtt || ahoraLocal - prev.t > 10 * 60000) return { off: m.off, rtt: m.rtt, t: ahoraLocal };
    return prev;
  }
  /** Tramos (ms) de una llegada: toque→servidor (cola de la tablet + red + arranque en frío), servidor→señal (secretos,
   *  candado y lectura), señal→pantalla (escritura, espera del sondeo, lectura y pintado) y total. `tP` = hora del servidor
   *  en que la pantalla pintó el recuadro. Sin cronómetro (llegó por la lista): solo desde su marca (`desde`). */
  function tramosMedicion(k, tP, desde) {
    if (!k) return { aServidor: null, aSenal: null, aPantalla: null, total: Number.isFinite(desde) ? tP - desde : null, sinCrono: true };
    return { aServidor: k.tq != null ? k.tr - k.tq : null, enCola: k.tq != null && k.te != null ? k.te - k.tq : null, aSenal: k.ts - k.tr,
      aPantalla: tP - k.ts, total: tP - (k.tq != null ? k.tq : k.tr), n: k.n, fria: k.fr, cache: k.ca };
  }
  function seg(ms) { return ms == null || !isFinite(ms) ? '—' : (ms / 1000).toFixed(1) + ' s'; }
  /** La fila de la franja y del texto que se copia (solo números; sin nombres ni ids). */
  function textoMedicion(m) {
    var t = m.tramos, extra = [];
    var base = 'toque→servidor ' + seg(t.aServidor) + ' · servidor→señal ' + seg(t.aSenal) + ' · señal→pantalla ' + seg(t.aPantalla) + ' · total ' + seg(t.total);
    extra.push(m.via === 'senal' ? 'por la señal' : 'por la lista');
    if (t.sinCrono) extra.push('sin cronómetro: total desde su marca');
    if (m.vistaSenal != null) extra.push('la señal se vio a los ' + seg(m.vistaSenal));
    if (t.enCola != null && t.enCola >= 500) extra.push('en cola ' + seg(t.enCola));
    if (t.n > 1) extra.push('intento ' + t.n);
    if (t.fria) extra.push('instancia fría');
    if (!t.sinCrono) extra.push(t.cache ? 'con caché' : 'sin caché');
    if (m.inst) extra.push('inst ' + m.inst);
    return (m.hora ? m.hora + ' · ' : '') + base + ' (' + extra.join(' · ') + ')';
  }
  /** Ids que se le piden al servidor para revisar (¿ya se cerró su pendiente en Wix?): las que se VEN en la lista (12 por
   *  bloque, máx. 24): con 10 o más en «Van llegando», las de «Se van yendo» también se revisan. El marketplace no (Wix no
   *  sabe si ya se validó su código). */
  function idsRevisar(b) {
    var ok = function (t) { return t.id && !t.provisional && !(t.detalle && t.detalle.market); };
    var vis = function (ts, yendo) { var v = visibles(ts, yendo); return ts.filter(function (t) { return v[t.id] && ok(t); }); };
    return vis(b.van, false).concat(vis(b.yendo, true)).map(function (t) { return t.id; });
  }
  /** Contador discreto («12 llegadas hoy · 3 con tema») y lo que dice la franja cuando está vacía. */
  function textosLista(b, total) {
    var n = Math.max(b.total, total || 0), partes = [];
    if (n) partes.push(n === 1 ? '1 llegada hoy' : n + ' llegadas hoy');
    if (n && b.conTema) partes.push(b.conTema + ' con tema');
    var hay = b.van.length + b.yendo.length, vacio = '';
    if (b.sinDetalle && hay) partes.push('revisando ' + b.sinDetalle + ' sin detalle');   // sin renglones ya lo dice la franja
    if (!hay) vacio = !n ? 'Todavía no llega nadie hoy.' : b.sinDetalle ? 'Revisando ' + (b.sinDetalle === 1 ? '1 llegada' : b.sinDetalle + ' llegadas') + ' sin detalle…' : 'Nadie con pendiente ahora ✓';
    return { conteo: partes.join(' · '), vacio: vacio, ok: !!n && !b.sinDetalle };
  }

  /** Recuadro de una llegada de la tablet: «Clienta E.» grande, «hizo check-in · Reformer 7:30 am», su círculo y, si trae
   *  pendiente, una línea chica que manda a la franja (el detalle completo vive ahí). */
  function recuadroDe(t) {
    var ps = String((t && t.nombre) || '').trim().split(/\s+/).filter(Boolean), det = t && t.detalle, sn = (t && t.senal) || null;
    var extra = '', tipo = '', eq = det ? equipoDe(t) : ((sn && sn.eq) || []);
    // v3.1: dice CUÁL («trae pendiente: 💵 Sin canjear»), del detalle o de la señal (los mismos códigos que calculó el 🛎️).
    var cual = function (ps) { return ps && ps.length ? 'trae pendiente: ' + etiquetas(ps.map(temaDe)) : 'trae pendiente → ver en Por resolver'; };
    if (det && det.pendientes && det.pendientes.length) { extra = cual(det.pendientes); tipo = 'pendiente'; }
    else if (det && det.sinDetalle) { extra = 'sin detalle → ver en Por resolver'; tipo = 'pendiente'; }
    else if (!det && sn && sn.p) { extra = cual(sn.temas); tipo = 'pendiente'; }   // v3: lo dijo la señal
    else if (eq.length) { extra = textoEquipo(eq[0]); tipo = 'equipo'; }      // informativo: no se cobra
    else if (det && (det.insignias || []).some(function (x) { return x.tipo === 'primera'; })) { extra = '🌱 primera clase'; tipo = 'primera'; }
    else if (det && (det.insignias || []).some(function (x) { return x.tipo === 'cumple'; })) { extra = '🎂 cumple hoy'; tipo = 'cumple'; }
    else if ((det && det.market) || (!det && t && t.market)) extra = '🎟️ validar su código';
    var o = { id: t && t.id, nombre: ps[0] || 'Alumna', inicial: ps.length > 1 ? ps[1].charAt(0).toLocaleUpperCase('es-MX') + '.' : '',
      linea: 'hizo check-in · ' + claseCorta(t && t.clase), extra: extra, tipo: tipo, iniciales: (t && t.iniciales) || '?',
      elemento: det ? (tiene(ELEMENTOS, det.elemento) ? det.elemento : '') : (sn && tiene(ELEMENTOS, sn.e) ? sn.e : ''), market: !!(t && t.market) };
    if (sn) o.senal = sn;
    return o;
  }
  /** ¿Sale recuadro? Solo check-ins de la TABLET (los del panel no: no hay nadie en la tablet) y recientes (al volver la
   *  conexión no se anuncia lo de hace rato). `ahoraServidor` = la hora del servidor en esa respuesta. */
  function vaRecuadro(t, ahoraServidor) {
    if (!t || t.origen !== 'tablet') return false;
    var h = Date.parse(t.hora || ''), a = Date.parse(ahoraServidor || '');
    return !Number.isFinite(h) || !Number.isFinite(a) || a - h <= RECUADRO_RECIENTE_MS;
  }
  /** Pinta la pila de recuadros (los primeros 3; las demás «+N»). Cada uno se cierra al tocarlo (`alCerrar(id)`). */
  function pintarRecuadros(doc, lista, alCerrar) {
    var cont = doc.getElementById('recuadros');
    if (!cont) return;
    vaciar(cont);
    // Debajo de la barra (su altura cambia si los botones bajan a otra línea); a 900 px o menos el CSS lo manda abajo.
    var barra = doc.getElementById('barra');
    if (barra && typeof barra.getBoundingClientRect === 'function' && cont.style) {
      var abajo = barra.getBoundingClientRect().bottom;
      if (abajo > 0) cont.style.top = Math.round(abajo + 10) + 'px';
    }
    (lista || []).slice(0, RECUADROS_VISIBLES).forEach(function (r) {
      var b = el(doc, 'button', 'recuadro' + (r.tipo ? ' r-' + r.tipo : '') + (r.entra ? ' entra' : ''));
      b.type = 'button';
      b.setAttribute('title', 'Tocar para cerrar');
      var c = el(doc, 'span', 'circulo grande' + (r.market ? ' market' : r.elemento ? ' ' + r.elemento : ''), r.iniciales);
      c.setAttribute('aria-hidden', 'true');
      b.appendChild(c);
      var tx = el(doc, 'span', 'r-texto');
      var n = el(doc, 'span', 'r-nombre', r.nombre);
      if (r.inicial) n.appendChild(el(doc, 'span', 'r-inicial', ' ' + r.inicial));
      tx.appendChild(n);
      tx.appendChild(el(doc, 'span', 'r-linea', r.linea));
      if (r.extra) tx.appendChild(el(doc, 'span', 'r-extra', r.extra));
      b.appendChild(tx);
      if (alCerrar && b.addEventListener) b.addEventListener('click', function () { alCerrar(r.id); });
      cont.appendChild(b);
    });
    var mas = (lista || []).length - RECUADROS_VISIBLES;
    if (mas > 0) {
      var m = el(doc, 'button', 'recuadro-mas', '+' + mas + (mas === 1 ? ' llegada más' : ' llegadas más'));
      m.type = 'button';
      if (alCerrar && m.addEventListener) m.addEventListener('click', function () { alCerrar(null); });
      cont.appendChild(m);
    }
  }
  /** Pastilla en dos niveles: el tema arriba (en negritas) y la acción debajo, más chica (cabe en ~200 px a 1024). */
  /** v3: con destino, la pastilla ENTERA es un botón-liga a la vista donde se resuelve (abre otra pestaña), con el paso en
   *  chico («⋯ → Gestionar participantes → Canjear sesión»). Sin destino válido, como antes (sin liga). */
  function pastilla(doc, x, t) {
    var cls = 'pill ' + (tiene(COLORES, x.color) ? x.color : 'neutro'), liga = ligaDe(x, t), s;
    if (liga) { s = el(doc, 'a', cls + ' pill-boton'); s.href = liga; s.target = '_blank'; s.rel = 'noopener noreferrer'; }
    else s = el(doc, 'span', cls);
    s.appendChild(el(doc, 'span', 'pill-tema', (x.icono ? x.icono + ' ' : '') + x.tema));
    if (x.accion) s.appendChild(el(doc, 'span', 'pill-accion', x.accion));
    if (liga) s.appendChild(el(doc, 'span', 'pill-paso', DESTINOS[x.destino] + ' ↗'));
    var tt = x.texto ? (x.color === 'aviso' || x.color === 'primera' || x.color === 'cumple' ? '' : 'Al llegar: ') + String(x.texto) : '';
    if (liga) tt = (tt ? tt + ' · ' : '') + 'Abre en Wix' + (x.destino === 'nota' ? ' (Slack)' : '') + ': ' + DESTINOS[x.destino];
    if (tt) s.setAttribute('title', tt);
    return s;
  }
  /** Línea gris: plan y saldo primero (lo que se corta con «…» es lo de menos), luego ⭐ hito, 👋 regreso y años.
   *  Sin lo que ya va en pastilla (🌱 🎂 🔚 ⏳). */
  function metaDe(t) {
    var det = t.detalle || null;
    if (!det) return 'Sin detalle todavía (llegó antes de abrir esta pantalla, o no se pudo leer)';
    if (det.provisional) return 'confirmando con Wix…';            // v3.1: de la señal; la lista lo confirma o lo reemplaza
    if (det.sinDetalle) return '';
    var xs = [];
    if (!det.market && !det.sinFicha) xs.push(String(det.plan || 'sin plan') + (det.saldo ? ' · ' + String(det.saldo) : ''));
    (det.insignias || []).forEach(function (x) { if (x.tipo !== 'primera' && x.tipo !== 'cumple' && x.texto) xs.push(String(x.texto)); });
    return xs.join(' · ');
  }

  /** Un renglón: hora · círculo · nombre y clase (y la línea gris) · a la derecha el tema en pastilla (o ✓ discreto). */
  function fila(doc, t, ahoraMs, animar, agrupada) {
    var det = t.detalle || null, ps = pastillasDe(t);
    var li = el(doc, 'li', 'fila');
    if (t.prioridad === 1) li.className += ' con-pendiente c-' + (ps.length ? ps[0].color : 'neutro');   // ps[0] = su pendiente más urgente
    else if (ps.length && ps[0].color === 'primera') li.className += ' c-primera';
    else if (det && det.market) li.className += ' c-neutro';      // 🎟️ validar su código
    else if (!ps.length && det) li.className += ' tenue';          // tenue = «se sabe que no trae nada»; sin detalle, no
    if (ahoraMs - (t.desde || 0) < MARCA_NUEVA_MS && t.nueva) li.className += ' nueva' + (animar ? ' entra' : '');
    if (t.provisional) { li.className += ' provisional'; li.setAttribute('title', 'Lo dijo el check-in de la tablet; Wix todavía no lo muestra (se confirma solo)'); }
    var h = el(doc, 'div', 'f-hora', t.hora ? hora(t.hora) : '—');
    var origen = t.origen === 'panel' ? 'panel aprox.' : t.origen === 'panel-tarde' ? 'sin hora' : '';
    if (origen) { var sm = el(doc, 'small', null, origen);
      sm.setAttribute('title', t.origen === 'panel' ? 'Check-in marcado en el panel de Wix: hora aproximada (cuando lo vio esta pantalla)' : 'Check-in marcado en el panel de Wix cuando esta pantalla estaba cerrada: hora desconocida');
      h.appendChild(sm); }
    li.appendChild(h);
    var circ = el(doc, 'div', 'circulo', t.iniciales || '?');
    if (t.market) circ.className += ' market';
    else if (det && tiene(ELEMENTOS, det.elemento)) circ.className += ' ' + det.elemento;
    circ.setAttribute('aria-hidden', 'true');
    li.appendChild(circ);
    var info = el(doc, 'div', 'f-info');
    var l1 = el(doc, 'div', 'f-l1');
    var conDobles = !!(det && (det.pendientes || []).some(function (p) { return p.tipo === 'dobles'; }));   // «2 lugares» ya va en su 👥
    l1.appendChild(nombreNodo(doc, String(t.nombre || 'Alumna') + (t.lugares >= 2 && !conDobles ? ' (' + t.lugares + ' lugares)' : ''), det && det.ficha, 'nombre'));
    // Agrupada bajo el subtítulo de su clase (v3), el renglón ya no la repite.
    if (!agrupada) l1.appendChild(el(doc, 'span', 'f-clase', ' · ' + claseCorta(t.clase) + (t.clase && t.clase.coach ? ' · ' + t.clase.coach : '')));
    info.appendChild(l1);
    var meta = metaDe(t);
    if (meta) { var m = el(doc, 'div', 'f-meta', meta); m.setAttribute('title', meta); info.appendChild(m); }   // se corta con «…»: completo al pasar el ratón
    li.appendChild(info);
    if (ps.length) {
      var temas = el(doc, 'div', 'f-temas');
      ps.forEach(function (x) { temas.appendChild(pastilla(doc, x, t)); });
      li.appendChild(temas);
    } else if (det && !det.sinDetalle) {
      var col = el(doc, 'div', 'f-temas'), ok = el(doc, 'span', 'f-ok', '✓');
      ok.setAttribute('title', 'Sin pendientes al llegar'); ok.setAttribute('aria-label', 'Sin pendientes');
      col.appendChild(ok); li.appendChild(col);
    }
    return li;
  }

  // La entrada animada sale UNA vez por llegada (cada sondeo repinta todo: sin esto, destellaba en cada sondeo, y doble).
  var animadas = {};
  /** Subtítulo de una clase: «Reformer 7:30 am · Coach» (en «Se van yendo», «Terminó 8:20 pm · Reformer 7:30 pm · Coach ·
   *  hace 5 min»), a la derecha «2 con tema · 5/7 llegaron», y abajo los chips 🌱/🎂 de quien no ocupa renglón. */
  function subtitulo(doc, g, resumen, ahora, conFin) {
    var c = g.clase || {}, li = el(doc, 'li', conFin ? 'sub-fin' : 'sub-clase'), f = finClase(c);
    var tit = (conFin ? 'Terminó ' + hora(new Date(f).toISOString()) + ' · ' : '') + claseCorta(c) + (c.coach ? ' · ' + c.coach : '') +
      (conFin ? ' · hace ' + Math.max(0, Math.round((ahora - f) / 60000)) + ' min' : '');
    var lc = ligaClase(c);
    if (lc) {
      var a = el(doc, 'a', 'sub-titulo sub-liga', tit);
      a.href = lc; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.setAttribute('title', 'Abrir en Wix las reservas de hoy de ' + (c.servicioNombre || c.disciplina || 'esta clase') + ' (ahí está «Canjear sesión»)');
      li.appendChild(a);
    } else li.appendChild(el(doc, 'span', 'sub-titulo', tit));
    var cta = cuentaGrupo(g, resumen);
    if (cta) li.appendChild(el(doc, 'span', 'sub-cuenta', cta));
    if (g.chips.length) {
      var ch = el(doc, 'span', 'sub-chips');
      g.chips.forEach(function (t) {
        if (chipsDe(t).length) {
          var x = el(doc, 'span', 'chip ' + (chipsDe(t)[0] === '🌱' ? 'chip-primera' : 'chip-cumple'));
          x.appendChild(el(doc, 'span', null, chipsDe(t).join('') + ' '));
          x.appendChild(nombreNodo(doc, nombreCorto(t.nombre), t.detalle && t.detalle.ficha, null));
          x.setAttribute('title', chipsDe(t)[0] === '🌱' ? 'Primera clase en Hera: recibirla' : 'Cumple años hoy: felicitarla');
          ch.appendChild(x);
        }
        // v3.1: equipo o Lobas: «equipo · 💵 sin canjear · Clienta A.» en gris (informativo, sin renglón).
        if (equipoDe(t).length) {
          var q = el(doc, 'span', 'chip chip-equipo');
          q.appendChild(el(doc, 'span', null, equipoDe(t).map(textoEquipo).join(' · ') + ' · '));
          q.appendChild(nombreNodo(doc, nombreCorto(t.nombre), t.detalle && t.detalle.ficha, null));
          q.setAttribute('title', TEXTO_EQUIPO);
          ch.appendChild(q);
        }
      });
      li.appendChild(ch);
    }
    return li;
  }
  /** Cuántos renglones le tocan a cada grupo (tope 12 por bloque), por turnos: ninguna clase se queda sin renglones porque
   *  otra llenó el bloque (revisión 21-nov: la clase en curso tapaba a la que está llegando). */
  function reparto(gs, tope) {
    var n = gs.map(function () { return 0; }), quedan = tope, hubo = true;
    while (quedan > 0 && hubo) {
      hubo = false;
      gs.forEach(function (g, i) { if (quedan > 0 && n[i] < g.filas.length) { n[i]++; quedan--; hubo = true; } });
    }
    return n;
  }
  /** Ids de los renglones que se ven en un bloque (los más nuevos de cada clase). */
  function visibles(ts, yendo) {
    var gs = agrupar(ts, [], yendo), n = reparto(gs, TOPE_BLOQUE), out = {};
    gs.forEach(function (g, i) { g.filas.slice(0, n[i]).forEach(function (t) { out[t.id] = 1; }); });
    return out;
  }
  /** Un bloque de la lista, agrupado por clase (v3): subtítulo y sus renglones (tope 12 por bloque, repartido entre clases;
   *  cada clase dice «y N más de esta clase» si se le esconden). */
  function pintarBloque(doc, ul, ts, chips, resumen, ahora, conFin) {
    vaciar(ul);
    var gs = agrupar(ts, chips, conFin), n = reparto(gs, TOPE_BLOQUE);
    gs.forEach(function (g, i) {
      ul.appendChild(subtitulo(doc, g, resumen, ahora, conFin));
      g.filas.slice(0, n[i]).forEach(function (t) { ul.appendChild(fila(doc, t, ahora, !animadas[t.id], true)); });
      var resto = g.filas.length - n[i];
      if (resto > 0) ul.appendChild(el(doc, 'li', 'sub-mas', 'y ' + resto + ' más de esta clase'));
    });
    ul.hidden = !ts.length && !(chips || []).length;
  }
  function pintar(doc, estado, ahoraMs, provs) {
    var ts = conProvisionales((estado && estado.tarjetas) || [], provs), ahora = ahoraMs || Date.now();
    var b = bloques(ts, ahora), tx = textosLista(b, estado && estado.total), hay = b.van.length + b.yendo.length;
    var resumen = (estado && estado.clases) || [];
    pintarBloque(doc, doc.getElementById('van'), b.van, b.chipsVan, resumen, ahora, false);
    pintarBloque(doc, doc.getElementById('yendo'), b.yendo, b.chipsYendo, resumen, ahora, true);
    ts.forEach(function (t) { if (t.nueva) animadas[t.id] = 1; });
    // Los dos bloques con su separador salen siempre que haya alguien en la lista (el vacío dice «nadie»); un 🌱/🎂 solo
    // (sin pendiente) también los abre: su chip va en el subtítulo de su clase.
    var conChips = !!(b.chipsVan.length + b.chipsYendo.length);
    doc.getElementById('bloqueVan').hidden = !hay && !conChips;
    doc.getElementById('bloqueYendo').hidden = !hay && !conChips;
    doc.getElementById('vacioVan').hidden = !!(b.van.length + b.chipsVan.length);
    doc.getElementById('vacioYendo').hidden = !!(b.yendo.length + b.chipsYendo.length);
    doc.getElementById('cuentaVan').textContent = b.van.length ? '(' + b.van.length + ')' : '';
    doc.getElementById('cuentaYendo').textContent = b.yendo.length ? '(' + b.yendo.length + ')' : '';
    var sr = doc.getElementById('sinResolver');
    sr.hidden = !!hay || conChips;
    sr.textContent = tx.vacio;
    sr.className = 'vacio-mini' + (tx.ok ? '' : ' espera');
    doc.getElementById('conteoResolver').textContent = hay ? '(' + hay + ')' : '';
    doc.getElementById('conteo').textContent = tx.conteo;
    var nota = doc.getElementById('notaHoras');
    if (nota) { nota.textContent = ts.length && estado && !estado.horas ? TEXTOS.sinHoras : ''; nota.hidden = !nota.textContent; }
    pintarProximas(doc, (estado && estado.proximas) || []);
    var at = doc.getElementById('avisoTablet');
    if (at) { at.textContent = avisoTablet(estado && estado.tablet, ahora, !!(estado && estado.activo)); at.hidden = !at.textContent; }
    return b;
  }

  /** Lugares que faltan en una clase: cada persona su número de lugares (con invitada, 2) y el marketplace su «×N». */
  function lugaresFaltan(fs) {
    return (fs || []).reduce(function (s, f) {
      var m = f && f.market ? /×\s*(\d+)\s*$/.exec(String(f.nombre || '')) : null;
      return s + (m ? Number(m[1]) : Math.max(1, Number(f && f.lugares) || 1));
    }, 0);
  }
  var COLOR_TEMA = { pago: 1, canje: 1, offline: 1, pausa: 1, nota: 1, neutro: 1 };
  /** Temas compactos de una persona de «Faltan por llegar» (`m` del servidor, validado): { t: [{i, t, c}], i: [{i, t}], eq }. */
  function marcasDe(f) {
    var m = f && f.m && typeof f.m === 'object' ? f.m : null;
    var arr = function (v) { return Array.isArray(v) ? v.filter(function (x) { return x && typeof x === 'object'; }) : []; };
    return { t: arr(m && m.t).slice(0, 4), i: arr(m && m.i).slice(0, 3), eq: !!(m && m.eq) };
  }
  /** Las personas de una clase (Olmo 23-nov: «si ya hicieron check-in que no desaparezcan de la clase, que se ponga en
   *  verde»): las que faltan y las que ya llegaron juntas, por nombre (no saltan de lugar al llegar); marketplace al final. */
  function personasProxima(p) {
    var xs = [];
    (Array.isArray(p.faltan) ? p.faltan : []).forEach(function (f) { if (f) xs.push({ f: f, llego: false }); });
    (Array.isArray(p.yaLlegaron) ? p.yaLlegaron : []).forEach(function (f) { if (f) xs.push({ f: f, llego: true }); });
    return xs.sort(function (a, b) {
      if (!!a.f.market !== !!b.f.market) return a.f.market ? 1 : -1;
      if (a.f.market && a.llego !== b.llego) return a.llego ? 1 : -1;
      return String(a.f.nombre || '').localeCompare(String(b.f.nombre || ''), 'es');
    });
  }
  /** La pastilla de una persona: verde con ✓ si ya llegó; con tema, el color de su tema más urgente y sus íconos. */
  function pastillaProxima(doc, x) {
    var f = x.f, m = marcasDe(f), t0 = m.t[0], color = t0 && tiene(COLOR_TEMA, t0.c) ? t0.c : 'neutro';
    var li = el(doc, 'li', 'falta' + (x.llego ? ' llego' : '') + (m.t.length ? ' con-tema t-' + color : ''));
    li.appendChild(el(doc, 'span', 'mini', x.llego ? '✓' : String(f.iniciales || '?')));
    li.appendChild(nombreNodo(doc, String(f.nombre || 'Alumna') + (f.lugares >= 2 ? ' (' + f.lugares + ')' : ''), f.ficha, null));
    var iconos = m.t.map(function (y) { return String(y.i || '•'); }).concat(m.i.map(function (y) { return String(y.i || ''); })).join('');
    if (iconos) li.appendChild(el(doc, 'span', 'px-iconos', iconos));
    var globo = m.t.map(function (y) { return String(y.i || '') + ' ' + String(y.t || ''); }).concat(m.i.map(function (y) { return String(y.t || y.i || ''); }));
    if (m.eq) globo.push('equipo o Lobas: no se cobra');
    globo.push(x.llego ? 'Ya llegó ✓' : 'Falta por llegar');
    li.setAttribute('title', globo.join(' · '));
    return li;
  }
  function pintarProximas(doc, ps) {
    var cont = doc.getElementById('proximas');
    vaciar(cont);
    doc.getElementById('sinProximas').hidden = !!ps.length;
    ps.forEach(function (p) {
      var fs = Array.isArray(p.faltan) ? p.faltan : [];
      // Ideas v3: ya empezó y falta gente → resaltado: llamarla, o a los 20 min Wix la deja en «No se presentó».
      var s = el(doc, 'section', 'proxima' + (p.empezo && fs.length ? ' empezo' : ''));
      var h = el(doc, 'h3'), lc = ligaClase(p), cl;
      // Olmo 23-nov: la clase abre en Wix sus reservas de hoy, como el subtítulo de «Por resolver».
      if (lc) {
        cl = el(doc, 'a', 'px-clase sub-liga', claseCorta(p));
        cl.href = lc; cl.target = '_blank'; cl.rel = 'noopener noreferrer';
        cl.setAttribute('title', 'Abrir en Wix las reservas de hoy de ' + (p.servicioNombre || p.disciplina || 'esta clase') + ' (ahí está «Canjear sesión»)');
      } else cl = el(doc, 'span', 'px-clase', claseCorta(p));
      if (p.coach) cl.appendChild(el(doc, 'small', null, ' · ' + p.coach));
      h.appendChild(cl);
      h.appendChild(el(doc, 'span', 'px-cuenta', (p.llegaron || 0) + ' de ' + (p.lugares || 0) + (p.empezo ? ' · ya empezó' : '')));
      s.appendChild(h);
      // Ya empezó: la línea va ARRIBA de los nombres (revisión 21-nov: los tapaba, justo cuando hay que llamarlas). Cuenta
      // lugares, como «2 de 6»: una invitada y el «Fitpass ×2» cuentan lo que son.
      var nf = lugaresFaltan(fs);
      if (!fs.length) s.appendChild(el(doc, 'p', 'listo', 'Ya llegaron todas ✓'));
      else if (p.empezo) s.appendChild(el(doc, 'p', 'px-empezo', 'Ya empezó: ' + (nf === 1 ? 'falta 1' : 'faltan ' + nf) + ' · a los 20 min Wix las marca «No se presentó»'));
      var xs = personasProxima(p);
      if (xs.length) {
        var ul = el(doc, 'ul', 'faltan');
        xs.forEach(function (x) { ul.appendChild(pastillaProxima(doc, x)); });
        s.appendChild(ul);
      }
      cont.appendChild(s);
    });
  }
  /** Los temas (`m`) que esta respuesta no trae (otra instancia, o la lectura por la señal) se conservan de la anterior del
   *  mismo día; si las dos traen, gana la de sello `s` más nuevo (revisión 23-nov: con dos instancias, una pastilla ya
   *  resuelta no salta de color cada 30 s). Así una pastilla no pierde su color entre sondeos. */
  function conMarcasPrevias(ps, previas) {
    var vistas = {};
    var sello = function (m) { var t = m && typeof m.s === 'string' ? Date.parse(m.s) : NaN; return isFinite(t) ? t : 0; };
    (previas || []).forEach(function (p) {
      [].concat(p.faltan || [], p.yaLlegaron || []).forEach(function (f) { if (f && f.id && f.m) vistas[f.id] = f.m; });
    });
    (ps || []).forEach(function (p) {
      [].concat(p.faltan || [], p.yaLlegaron || []).forEach(function (f) {
        if (!f || !f.id || !tiene(vistas, f.id)) return;
        if (f.m === undefined || sello(vistas[f.id]) > sello(f.m)) f.m = vistas[f.id];
      });
    });
    return ps;
  }

  // ------------------------------------------------------------------ almacenamiento (solo las llaves de esta pantalla)
  function almacen(win) {
    var mem = {}, ok = false;
    try { win.localStorage.setItem('hera_mostrador_p', '1'); win.localStorage.removeItem('hera_mostrador_p'); ok = true; } catch (_) {}
    return {
      get: function (k) { if (!ok) return mem[k] == null ? null : mem[k]; try { return win.localStorage.getItem(k); } catch (_) { return mem[k] == null ? null : mem[k]; } },
      set: function (k, v) { mem[k] = v; if (ok) try { win.localStorage.setItem(k, v); } catch (_) {} },
      del: function (k) { delete mem[k]; if (ok) try { win.localStorage.removeItem(k); } catch (_) {} }
    };
  }

  // ------------------------------------------------------------------ sonido: golpe de cuenco (Web Audio, sin archivos)
  // Olmo 21-nov: «usa algo más Zen, como un golpe de cuenco breve». Cuenco tibetano sintetizado: parciales INARMÓNICOS
  // (razones 1 · 2.71 · 5.12 · 8.43 sobre ~330 Hz) con amplitudes decrecientes, ataque suave de 6 ms, caída exponencial
  // (los agudos se apagan antes) y un leve batido: los dos parciales graves van con dos osciladores desafinados ~1.4 Hz.
  // Revisión 21-nov: a 236 Hz y pico −12.7 dBFS casi no se oía en bocinas de laptop o monitor; ahora el fundamental va a
  // 330 Hz, el 2.º parcial (894 Hz, donde sí suenan) pesa más, el fundamental dura un poco más (τ 1 s: más «cuenco») y el
  // volumen sube (alto ≈ −2.5 dBFS de pico). Sigue en 2.5 s y nunca satura: la suma de los picos es el volumen (≤ 0.85).
  // La MISMA receta la usa scripts/cuenco-wav.mjs para escribir un WAV de muestra (muestrasCuenco).
  var CUENCO = {
    f0: 330, ataque: 0.006, duracion: 2.5, desvanecer: 0.35,
    // [razón, amplitud relativa, constante de caída τ en s, batido en Hz (0 = un solo oscilador)]
    parciales: [[1, 1, 1.0, 1.4], [2.71, 0.7, 0.55, 1.8], [5.12, 0.24, 0.3, 0], [8.43, 0.11, 0.18, 0]]
  };
  var VOLUMENES = { bajo: 0.25, medio: 0.5, alto: 0.85 };    // suma de los picos de las voces (1 = escala completa)
  var RELEVO_S = 0.035;                                      // un golpe nuevo apaga el anterior en ~35 ms (nunca se suman: no satura)
  function volumenDe(v) { return tiene(VOLUMENES, v) ? v : 'medio'; }
  /** Voces del golpe: { f, pico, tau } por oscilador (un parcial con batido = 2 osciladores a f ± batido/2, mitad cada uno). */
  function recetaCuenco(volumen) {
    var total = CUENCO.parciales.reduce(function (s, p) { return s + p[1]; }, 0), pico = VOLUMENES[volumenDe(volumen)], voces = [];
    CUENCO.parciales.forEach(function (p) {
      var f = CUENCO.f0 * p[0], a = pico * p[1] / total;
      if (p[3]) { voces.push({ f: f - p[3] / 2, pico: a / 2, tau: p[2] }); voces.push({ f: f + p[3] / 2, pico: a / 2, tau: p[2] }); }
      else voces.push({ f: f, pico: a, tau: p[2] });
    });
    return { ataque: CUENCO.ataque, duracion: CUENCO.duracion, desvanecer: CUENCO.desvanecer, voces: voces };
  }
  /** El golpe como muestras (−1…1) a `sr` Hz: la misma envolvente que agenda Web Audio (rampa lineal de ataque, luego
   *  e^(−t/τ) por voz, y el desvanecido final del maestro). Para el WAV de muestra y las pruebas. */
  function muestrasCuenco(sr, volumen) {
    var r = recetaCuenco(volumen), n = Math.ceil(r.duracion * sr), out = new Array(n), i, j;
    for (i = 0; i < n; i++) {
      var t = i / sr, m = t < r.duracion - r.desvanecer ? 1 : Math.max(0, (r.duracion - t) / r.desvanecer), x = 0;
      for (j = 0; j < r.voces.length; j++) {
        var v = r.voces[j], e = t < r.ataque ? v.pico * t / r.ataque : v.pico * Math.exp(-(t - r.ataque) / v.tau);
        x += e * Math.sin(2 * Math.PI * v.f * t);
      }
      out[i] = x * m;
    }
    return out;
  }
  /** Audio de la página. El navegador deja crear el AudioContext sin gesto, pero lo deja SUSPENDIDO hasta que alguien toca
   *  la página: `asegurar()` lo crea al arrancar (con el sonido encendido), `preparar()` lo reanuda desde un gesto y
   *  `corriendo()` dice si de verdad suena (si no, el botón dice «toca para activar»). `tocar` reanuda un contexto que se
   *  suspendió (la compu se durmió, cambió la bocina) y solo suena si arranca en ≤ 1.5 s (nunca un golpe atrasado).
   *  `alCambiar` se llama cuando cambia su estado (para el botón). */
  function crearSonido(win, alCambiar) {
    var ctx = null, previo = null, ahora = function () { return Date.now(); };
    function asegurar() {
      try {
        var A = win.AudioContext || win.webkitAudioContext;
        if (A && !ctx) { ctx = new A(); if (ctx && typeof ctx.addEventListener === 'function') ctx.addEventListener('statechange', function () { if (alCambiar) alCambiar(); }); }
      } catch (_) { ctx = null; }
      return ctx;
    }
    function reanudar() { try { if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && ctx.resume) return ctx.resume(); } catch (_) {} return null; }
    function golpe(volumen) {
      try {
        var t = ctx.currentTime, r = recetaCuenco(volumen), t0 = t + (previo ? RELEVO_S : 0.01), fin = t0 + r.duracion;
        if (previo && previo.fin > t) { previo.g.gain.cancelScheduledValues(t); previo.g.gain.setTargetAtTime(0, t, RELEVO_S / 4.5); }
        var maestro = ctx.createGain();
        previo = { g: maestro, fin: fin };
        maestro.gain.setValueAtTime(1, t0); maestro.gain.setValueAtTime(1, fin - r.desvanecer); maestro.gain.linearRampToValueAtTime(0, fin);
        maestro.connect(ctx.destination);
        r.voces.forEach(function (v) {
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = v.f;
          g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(v.pico, t0 + r.ataque); g.gain.setTargetAtTime(0, t0 + r.ataque, v.tau);
          o.connect(g); g.connect(maestro); o.start(t0); o.stop(fin + 0.05);
        });
      } catch (_) {}
    }
    return {
      asegurar: asegurar,
      corriendo: function () { return !!ctx && ctx.state === 'running'; },
      preparar: function () { asegurar(); var p = reanudar(); if (p && p.then) p.then(alCambiar, function () {}); else if (alCambiar) alCambiar(); },
      tocar: function (volumen) {
        if (!asegurar()) return;
        if (ctx.state === 'running') return golpe(volumen);
        var t = ahora(), p = reanudar();
        if (p && typeof p.then === 'function') p.then(function () { if (ctx.state === 'running' && ahora() - t <= 1500) golpe(volumen); }, function () {});
      }
    };
  }

  // ------------------------------------------------------------------ arranque
  function arrancar(win) {
    var doc = win.document, url = apiUrl(win.location), ls = almacen(win), sonido = crearSonido(win, function () { sonidoUi(); });
    // Relojes de la ventana (en las pruebas, unos falsos que no dejan vivo al proceso).
    var setTimeout = function (f, ms) { return win.setTimeout(f, ms); }, clearTimeout = function (h) { return win.clearTimeout(h); };
    var setInterval = function (f, ms) { return win.setInterval(f, ms); };
    var estado = null, timer = null, cargando = false, inicioLlegadas = 0, ultimaCarga = 0, tocaba = 0, tituloBase = doc.title;
    // v3: la señal va por su lado (no se congela mientras corre un «llegadas» largo) y a ritmo fijo (de inicio a inicio).
    var cargandoSenal = false, inicioSenal = 0;
    var anunciadas = {}, notificadasSenal = {};             // llegadas que ya salieron por la señal (recuadro / notificación)
    // Revisión 21-nov: `retiradas` = hora de la última retirada de cada id (lo anterior que otra instancia vuelva a escribir sin
    // retirar no resucita a quien ya se quitó, A1); `silencio` = cuándo se vio su última falla pasajera de Wix (los reintentos
    // de la cola no vuelven a sonar cada 20 s; el recuadro sale cuando la lista ya la trae); `esperadas` = llegadas de la
    // señal que la lista todavía no trae (relecturas con espera creciente, M3).
    // Todo por la hora del SERVIDOR de cada entrada (`ts`), no por el reloj de esta compu.
    var retiradas = {}, anuncioTs = {}, silencio = {}, esperadas = {}, intento = 0, reintentosCambio = 0, vivas = [];
    var consola = win.console && typeof win.console.info === 'function' ? win.console : null;
    var sinVer = [], alerta = '', avisoSesion = false, worker = null;
    // Señal (Olmo 21-nov, ≤ 5 s): `senalSeg` > 0 solo con un servidor que la tiene y mientras hay clases.
    var senalSeg = 0, senalVista = null, proximoRepaso = 0, pideFresco = false, fallasSenal = 0, ahoraServidor = 0;
    // Desfase del reloj de la compu contra el del servidor: el cambio de bloque («Se van yendo») usa la hora del servidor.
    var desfase = 0, ahoraMs = function () { return Date.now() + desfase; };
    var recuadros = [], sonaron = {};
    // v3.1: catálogo de temas (lo manda el servidor una vez), renglones provisionales (id → tarjeta con su detalle de la señal),
    // lo que ya se notificó con sus temas (id → texto) y la tarjeta que salió por la señal (para su renglón provisional).
    var catalogo = null, provisionales = {}, notificadasTemas = {}, deLaSenal = {};
    // Revisión v3.1 (M1): `confirmadas` = hora del SERVIDOR de la última lectura de la lista que traía su tarjeta CON detalle.
    // Si después se va de la lista (la quitaron en el panel de Wix: la señal no trae retirada), su entrada vieja de la señal
    // (sigue ahí 3 min) no revive el provisional cuando otra llegada reescribe la señal. Un check-in nuevo trae hora nueva y sí sale.
    var confirmadas = {};
    // Latencia (Olmo 21-nov noche): directorio de nombres del día (para `deSenal`) y el cronómetro: reloj del servidor como NTP
    // (`srv` de cada respuesta), el de cada llegada que trae la señal (id → {k, i, visto}) y, con ?medir=1, sus filas.
    var directorio = null, relojPag = null, cronos = {}, mediciones = [], medidas = {};
    var MEDIR = /(^|[?&])medir=1(&|$)/.test(String((win.location && win.location.search) || ''));
    var horaServidor = function () { return Date.now() + (relojPag ? relojPag.off : desfase); };
    function listaProv() { var out = [], id; for (id in provisionales) if (Object.prototype.hasOwnProperty.call(provisionales, id)) out.push(provisionales[id]); return out; }
    function repintar() { if (estado && !$('vistaLista').hidden) pintar(doc, estado, ahoraMs(), listaProv()); }
    /** Renglón provisional de una llegada de la señal que ya trae sus pendientes (o lo callado del equipo). */
    function ponerProvisional(e, sn) {
      if (conDetalle(e.id) || (!sn.p && !sn.eq)) return false;
      var ant = provisionales[e.id], b = deLaSenal[e.id] || ((estado && estado.tarjetas) || []).filter(function (x) { return x.id === e.id; })[0];
      if (!b) return false;                                     // sin nombre (no estaba en «Faltan por llegar»): por la lista
      var t = { id: e.id, nombre: b.nombre, iniciales: b.iniciales, origen: 'tablet', hora: e.ts, clase: b.clase, lugares: b.lugares,
        desde: ant ? ant.desde : Date.now(), nueva: true, hasta: Date.parse(e.ts) + PROVISIONAL_MS, detalle: detalleProvisional(sn, b.ficha) };
      provisionales[e.id] = t;
      return true;
    }
    /** La lista ya trae su detalle (lo confirma o lo reemplaza): fuera el provisional. Si nunca la trae, a los 5 min. */
    function limpiarProvisionales() {
      var ya = ahoraMs();
      for (var id in provisionales) if (Object.prototype.hasOwnProperty.call(provisionales, id)) {
        var t = ((estado && estado.tarjetas) || []).filter(function (x) { return x.id === id; })[0];
        if ((t && t.detalle) || (!t && ya > provisionales[id].hasta)) delete provisionales[id];
      }
    }
    var miId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var $ = function (id) { return doc.getElementById(id); };
    var Notif = win.Notification;

    function api(accion, datos, ms) {
      var cuerpo = { accion: accion };
      if (accion !== 'entrar') cuerpo.token = ls.get(TOKEN_KEY);
      for (var k in datos || {}) cuerpo[k] = datos[k];
      var ctl = null;
      try { ctl = typeof win.AbortController === 'function' ? new win.AbortController() : null; } catch (_) { ctl = null; }
      // text/plain: petición «simple» entre dominios, sin preflight (igual que el kiosco).
      var envio = Date.now();
      var p = win.fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(cuerpo),
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined })
        .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) {
          // Cronómetro: el reloj del servidor como NTP (sin el tiempo de proceso); un servidor viejo sin `srv`, con `ahora`.
          var recibo = Date.now();
          if (j && j.srv) relojPag = mejorReloj(relojPag, muestraReloj(envio, recibo, j.srv), recibo);
          else if (j && typeof j.ahora === 'string' && Number.isFinite(Date.parse(j.ahora))) relojPag = mejorReloj(relojPag, { off: Date.parse(j.ahora) - (envio + recibo) / 2, rtt: recibo - envio }, recibo);
          return { s: r.status, j: j }; }); });
      return conTiempo(p, ms || TIEMPO_FETCH_MS, function () { if (ctl) ctl.abort(); }, win);
    }
    function ponerTitulo() { doc.title = tituloDe(tituloBase, sinVer.length, alerta); }
    function red(ok, txt, dormido) {
      $('punto').className = 'punto' + (ok ? (dormido ? ' dormido' : '') : ' off');
      $('estadoTxt').textContent = txt;
      alerta = ok ? '' : 'Sin conexión'; ponerTitulo();
    }
    function irClave(msg) {
      clearTimeout(timer); if (worker) worker.postMessage(0); tocaba = 0; estado = null; senalSeg = 0; senalVista = null; pideFresco = false; inicioSenal = 0;
      recuadros = []; pintarRecuadros(doc, recuadros, null); provisionales = {}; confirmadas = {};
      $('vistaLista').hidden = true; $('vistaClave').hidden = false;
      $('errorClave').textContent = msg || '';
      try { $('clave').focus(); } catch (_) {}
    }
    function irLista() { $('vistaClave').hidden = true; $('vistaLista').hidden = false; alerta = ''; avisoSesion = false; ponerTitulo(); permisoUi(); sonidoUi(); avisosUi(); pintarMedicion(); }

    function permisoUi() {
      var b = $('permiso'), nota = $('notaPermiso'), probar = $('probar');
      if (!Notif) { b.hidden = true; probar.hidden = true; nota.hidden = false; nota.textContent = TEXTOS.sinNotif; return; }
      var p = Notif.permission;
      b.hidden = p !== 'default'; probar.hidden = p !== 'granted';
      nota.hidden = p !== 'denied'; nota.textContent = p === 'denied' ? TEXTOS.permisoNo : '';
    }
    var sonidoOn = function () { return ls.get(SONIDO_KEY) === '1'; };
    var volumen = function () { return volumenDe(ls.get(VOLUMEN_KEY)); };
    function sonidoUi() {
      var on = sonidoOn(), b = $('sonido'), v = $('volumen');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      // Encendido pero el navegador aún no deja sonar (recién abierta, sin ningún toque): se dice, no «encendido».
      b.textContent = 'Sonido: ' + (!on ? 'apagado' : sonido.corriendo() ? 'encendido' : 'toca para activar');
      if (v) { v.hidden = !on; v.textContent = 'Volumen: ' + volumen(); }
    }
    var detallado = function () { return ls.get(AVISOS_KEY) !== 'discreto'; };   // con detalle por omisión (Olmo 21-nov, opción 1B)
    function avisosUi() {
      var b = $('avisos'); if (!b) return;
      b.setAttribute('aria-pressed', detallado() ? 'true' : 'false');
      b.textContent = 'Avisos: ' + (detallado() ? 'con detalle' : 'discretos');
    }
    /** ¿Esta pestaña avisa? (candado entre pestañas de la misma compu; si localStorage no sirve, sí). */
    function lider() {
      var ahoraMs = Date.now();
      if (!soyLider(ls.get(LIDER_KEY), miId, ahoraMs)) return false;
      ls.set(LIDER_KEY, JSON.stringify({ id: miId, t: ahoraMs }));
      return true;
    }
    /** `callada`: rehacer el resumen sin sonar (se retiró una llegada). Se guardan las abiertas para poder cerrarlas. */
    function notificar(n, callada) {
      if (!n || !Notif || Notif.permission !== 'granted') return;
      try {
        // Callada solo si el cuenco de verdad suena; si el audio no corre, que suene la del sistema.
        var x = new Notif(n.titulo, { body: n.cuerpo, tag: n.tag || TAG_AVISO, renotify: !callada, requireInteraction: !!n.fija, silent: !!callada || (sonidoOn() && sonido.corriendo()),
          icon: 'https://static.wixstatic.com/media/9d6afa_e930e021d3564d24bc04bdc3e4c172f3~mv2.png/v1/fill/w_192,h_192/favicon.png' });
        x.onclick = function () { try { win.focus(); } catch (_) {} x.close(); };
        vivas = vivas.filter(function (v) { return v.tag !== (n.tag || TAG_AVISO); }).concat({ tag: n.tag || TAG_AVISO, n: x });
      } catch (_) {}
    }
    function cerrarNotificaciones() { vivas.forEach(function (v) { try { v.n.close(); } catch (_) {} }); vivas = []; }
    /** Se retiró una llegada (Wix no la marcó, o la quitaron): sale del título y de la notificación del sistema (revisión
     *  21-nov M2). Si quedan otras sin ver, el resumen se rehace sin ella y sin sonar; si no, se cierra. */
    function olvidarAviso(id) {
      delete notificadasSenal[id];
      var antes = sinVer.length;
      sinVer = sinVer.filter(function (t) { return t.id !== id; });
      if (sinVer.length === antes) return;
      ponerTitulo();
      cerrarNotificaciones();
      if (sinVer.length && lider()) notificar(resumenNotificacion(sinVer, { detallado: detallado() }), true);
    }
    /** Notificación del sistema (solo en segundo plano) de lo que ya trae su detalle. El cuenco va aparte (`tanda`). */
    function avisarNuevas(nuevas) {
      if (!nuevas.length) return;
      nuevas.forEach(function (t) { t.nueva = true; });
      if (!enSegundoPlano(doc)) return;
      // Ya avisadas por la señal (v3) y sin pendiente: se actualiza el resumen, pero no vuelve a sonar la notificación.
      // v3.1: con pendiente también, si la señal ya dijo CUÁL (sus temas); si el detalle dice otra cosa, se rehace sin sonar.
      var yaDichas = nuevas.every(function (t) { return notificadasSenal[t.id] && (t.prioridad !== 1 || notificadasTemas[t.id]); });
      var otraCosa = yaDichas && nuevas.some(function (t) { return notificadasTemas[t.id] && notificadasTemas[t.id] !== resaltado(t, true); });
      sinVer = acumular(sinVer, nuevas);
      ponerTitulo();
      if (otraCosa && lider()) notificar(resumenNotificacion(sinVer, { detallado: detallado() }), true);
      if (yaDichas || !lider()) return;
      notificar(resumenNotificacion(sinVer, { detallado: detallado() }));
    }
    /** v3: la notificación sale YA con lo que trae la señal («Llegó Clienta E. · Reformer 7:30 am · hizo check-in»); si trae
     *  pendiente, la de su detalle (con su propia etiqueta) llega unos segundos después. */
    function avisarPorSenal(ts) {
      if (!ts.length || !enSegundoPlano(doc)) return;
      ts.forEach(function (t) { notificadasSenal[t.id] = 1; t.prioridad = t.senal && t.senal.p ? 1 : 3; if (t.senal && t.senal.temas) notificadasTemas[t.id] = resaltado(t, true); });
      sinVer = acumular(sinVer, ts);
      ponerTitulo();
      if (lider()) notificar(resumenNotificacion(sinVer, { detallado: detallado() }));
    }
    /** Un solo golpe de cuenco por tanda: por las llegadas que salen en recuadro y, con la pestaña en segundo plano, por las
     *  que se notifican; nunca dos veces por la misma (la que esperaba su detalle ya sonó al verse). */
    function tanda(ids) {
      var nuevos = ids.filter(function (id) { return id && !sonaron[id]; });
      nuevos.forEach(function (id) { sonaron[id] = 1; });
      if (nuevos.length && sonidoOn() && lider()) sonido.tocar(volumen());
    }
    // ---- recuadros (Olmo 21-nov: «un recuadro de notificación de "<nombre> hizo check-in"… y pueda levantar la cabeza»)
    function cerrarRecuadro(id) {
      recuadros = id == null ? recuadros.slice(0, RECUADROS_VISIBLES) : recuadros.filter(function (r) { return r.id !== id; });
      pintarRecuadros(doc, recuadros, cerrarRecuadro);
    }
    function ponerRecuadros(ts) {
      var ahora = Date.now();
      ts.slice().reverse().forEach(function (t) {                // vienen de la más nueva a la más vieja: la más nueva queda arriba
        var r = recuadroDe(t), ya = recuadros.filter(function (x) { return x.id === r.id; })[0];
        if (ya) { r.hasta = ya.hasta; r.entra = false; recuadros = recuadros.map(function (x) { return x === ya ? r : x; }); return; }   // sin repetir la entrada
        r.hasta = ahora + RECUADRO_MS; r.entra = true;
        recuadros.unshift(r);                                   // la más nueva arriba
      });
      recuadros = recuadros.slice(0, RECUADROS_TOPE);
      pintarRecuadros(doc, recuadros, cerrarRecuadro);
      recuadros.forEach(function (r) { r.entra = false; });
    }
    /** El detalle llegó después (o se revisó): el recuadro que sigue a la vista dice ya si trae pendiente. */
    function refrescarRecuadros(ts) {
      var cambio = false;
      recuadros = recuadros.map(function (r) {
        var t = ts.filter(function (x) { return x.id === r.id; })[0];
        if (!t) return r;
        // Sin detalle todavía, lo que dijo la señal («trae pendiente», el color) se conserva.
        var n = recuadroDe(!t.detalle && r.senal ? conSenal(t, r.senal) : t);
        if (n.extra === r.extra && n.elemento === r.elemento) return r;
        // El detalle llegó tarde («trae pendiente»): que se alcance a leer (≥ 4 s más).
        cambio = true; n.hasta = n.extra && n.extra !== r.extra ? Math.max(r.hasta, Date.now() + 4000) : r.hasta; return n;
      });
      if (cambio) pintarRecuadros(doc, recuadros, cerrarRecuadro);
    }
    function conSenal(t, sn) { var o = {}, k; for (k in t) if (Object.prototype.hasOwnProperty.call(t, k)) o[k] = t[k]; o.senal = sn; return o; }
    function quitarRecuadro(id) {
      var antes = recuadros.length;
      recuadros = recuadros.filter(function (r) { return r.id !== id; });
      if (recuadros.length !== antes) pintarRecuadros(doc, recuadros, cerrarRecuadro);
    }
    /** La señal ya sabe que trae pendiente y CUÁL (2.ª escritura del check-in, v3.1): el recuadro que sigue a la vista lo dice
     *  (≥ 4 s más) y, con la pestaña detrás de Wix, la notificación sale otra vez con su detalle (su propia etiqueta). */
    function pendientePorSenal(id, e) {
      var cambio = false, sn = senalDe(e, catalogo);
      if (!sn.e) sn.e = '';
      recuadros = recuadros.map(function (r) {
        if (r.id !== id) return r;
        if (!sn.e && r.senal && r.senal.e) sn.e = r.senal.e;
        var n = recuadroDe({ id: r.id, nombre: r.nombre + (r.inicial ? ' ' + r.inicial : ''), iniciales: r.iniciales, market: r.market, clase: null, senal: sn });
        if (n.extra === r.extra && n.elemento === r.elemento) return r;
        n.linea = r.linea; n.hasta = Math.max(r.hasta, Date.now() + 4000); cambio = true; return n;
      });
      if (cambio) pintarRecuadros(doc, recuadros, cerrarRecuadro);
      if (deLaSenal[id]) deLaSenal[id].senal = sn;
      // La notificación: la que salió con la señal decía «hizo check-in»; ahora, con su pendiente.
      var t = sinVer.filter(function (x) { return x.id === id && !x.detalle; })[0];
      if (sn.p && t && notificadasSenal[id] && !notificadasTemas[id] && enSegundoPlano(doc)) {
        var o = conSenal(t, sn); o.prioridad = 1;
        sinVer = acumular(sinVer, [o]);
        notificadasTemas[id] = resaltado(o, true) || '⚠';
        if (lider()) notificar(resumenNotificacion(sinVer, { detallado: detallado() }));
      }
    }
    var tarjetaDe = function (id) { return ((estado && estado.tarjetas) || []).some(function (t) { return t.id === id; }); };
    var conDetalle = function (id) { return ((estado && estado.tarjetas) || []).some(function (t) { return t.id === id && !!t.detalle; }); };
    function medir(como, t, extra) {
      var ms = ahoraMs() - Date.parse(t.hora || '');
      if (consola && Number.isFinite(ms)) consola.info('[Mostrador] recuadro por ' + como + ': del check-in al recuadro ' + Math.round(ms) + ' ms' + (extra || ''));
      registrarMedicion(t, como === 'la señal' ? 'senal' : 'lista');
    }
    /** Cronómetro: una fila por recuadro que salió (por la señal o por la lista), con los tramos en hora del servidor. */
    function registrarMedicion(t, via) {
      var cr = cronos[t.id] || null, k = cr && cr.k, llave = t.id + '|' + (k ? k.tr : t.hora);
      if (medidas[llave]) return;
      medidas[llave] = 1;
      var tP = horaServidor();
      var m = { via: via, tramos: tramosMedicion(k, tP, Date.parse(t.hora || '')), inst: cr && cr.i, hora: hora(new Date(tP).toISOString()) };
      // Por la lista con cronómetro: la señal SÍ llegó (pero sin nombre, callada o en otra pestaña); ¿a los cuántos s del toque?
      if (via !== 'senal' && k && cr.visto) m.vistaSenal = cr.visto - (k.tq != null ? k.tq : k.tr);
      mediciones.unshift(m);
      mediciones = mediciones.slice(0, 50);
      if (consola) consola.info('[Mostrador] cronómetro: ' + textoMedicion(m));
      pintarMedicion();
    }
    /** Franja de ?medir=1 (arriba, dentro de la barra): las últimas 5 y «Copiar medición». Sin ?medir=1 no existe. */
    var franja = null;
    function pintarMedicion() {
      if (!MEDIR) return;
      var barra = $('barra');
      if (!franja && barra && doc.createElement) {
        franja = doc.createElement('div'); franja.className = 'medicion'; franja.setAttribute('aria-label', 'Medición de latencia');
        barra.appendChild(franja);
      }
      if (!franja) return;
      vaciar(franja);
      var cab = el(doc, 'div', 'med-cab');
      cab.appendChild(el(doc, 'span', 'med-tit', 'Medición · reloj ±' + (relojPag ? Math.round(relojPag.rtt / 2) : '?') + ' ms · ' + (soyLider(ls.get(LIDER_KEY), miId, Date.now()) ? 'pestaña que avisa' : 'otra pestaña avisa')));
      var b = el(doc, 'button', 'chip-btn med-copiar', 'Copiar medición');
      b.type = 'button';
      if (b.addEventListener) b.addEventListener('click', copiarMedicion);
      cab.appendChild(b);
      franja.appendChild(cab);
      if (!mediciones.length) franja.appendChild(el(doc, 'div', 'med-fila', 'Esperando un check-in de la tablet…'));
      mediciones.slice(0, 5).forEach(function (m) { franja.appendChild(el(doc, 'div', 'med-fila', textoMedicion(m))); });
    }
    function textoParaCopiar() {
      return ['Medición Mostrador · ' + mediciones.length + ' llegadas (la más nueva arriba) · reloj ±' + (relojPag ? Math.round(relojPag.rtt / 2) : '?') + ' ms']
        .concat(mediciones.map(textoMedicion)).join('\n');
    }
    function copiarMedicion() {
      var txt = textoParaCopiar(), ok = function () { var b = franja && franja.querySelector && franja.querySelector('.med-copiar'); if (b) b.textContent = 'Copiado ✓'; };
      try {
        if (win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) { win.navigator.clipboard.writeText(txt).then(ok, function () { copiarViejo(txt); ok(); }); return; }
      } catch (_) {}
      copiarViejo(txt); ok();
    }
    function copiarViejo(txt) {
      try {
        var a = doc.createElement('textarea'); a.value = txt; a.setAttribute('readonly', ''); a.style.position = 'fixed'; a.style.opacity = '0';
        doc.body.appendChild(a); a.select(); doc.execCommand('copy'); doc.body.removeChild(a);
      } catch (_) {}
    }
    /** v3: pinta YA el recuadro de cada llegada nueva que trae la señal (sin esperar a «llegadas», que depende de que Bookings
     *  muestre el ATTENDED) y dice si hace falta pedir la lista: sí si alguna es nueva (su renglón y sus pendientes) o no se
     *  pudo armar, o si retiraron una que está en la lista; no si solo trae lo que ya se ve. Sin lista (servidor o documento
     *  viejo): sí, como antes. Una retirada (Wix rechazó el check-in, o lo quitaron) quita su recuadro. */
    function procesarSenal(ll) {
      var xs = entradasSenal(ll, ahoraMs());
      if (!xs) { reintentosCambio = REINTENTOS_CAMBIO; return true; }
      var falta = false, nuevos = [], ya = Date.now(), repinta = false;
      xs.forEach(function (e) {
        var enLista = tarjetaDe(e.id), ts = Date.parse(e.ts);
        // Cronómetro: el de su llegada más nueva, y cuándo la vio esta pantalla (hora del servidor).
        if (!e.x && e.k && (!cronos[e.id] || cronos[e.id].k.tr < e.k.tr)) cronos[e.id] = { k: e.k, i: e.i, visto: horaServidor() };
        if (e.x) {
          // Ya vista (la señal la trae 3 min), o de antes de su último check-in (otra instancia la reescribió): nada.
          if (ts <= (retiradas[e.id] || 0) || ts < (anuncioTs[e.id] || 0)) return;
          retiradas[e.id] = ts;
          if (e.f) silencio[e.id] = ts;
          quitarRecuadro(e.id); delete anunciadas[e.id]; delete esperadas[e.id]; olvidarAviso(e.id);
          if (provisionales[e.id]) { delete provisionales[e.id]; repinta = true; }   // v3.1: su renglón provisional también se va
          delete notificadasTemas[e.id];
          if (enLista) { falta = true; reintentosCambio = REINTENTOS_CAMBIO; }
          return;
        }
        if (ts <= (retiradas[e.id] || 0)) return;                    // de antes de su retirada (la reescribió otra instancia)
        if (!enLista && ts <= (confirmadas[e.id] || 0)) return;      // M1: ya se confirmó y se fue de la lista (quitada en el panel)
        // Latencia (21-nov noche): la marcan OTRA VEZ tras quitarla (su retirada es más nueva que su último anuncio). Aunque
        // siga en la lista (Bookings aún no refleja el «quitar»), es una llegada nueva: recuadro otra vez.
        var otraVez = retiradas[e.id] && ts > retiradas[e.id] && (anuncioTs[e.id] || 0) <= retiradas[e.id];
        anuncioTs[e.id] = Math.max(anuncioTs[e.id] || 0, ts);
        if (otraVez) delete anunciadas[e.id];
        if (!otraVez && (enLista || anunciadas[e.id])) {
          if ((e.p || e.q) && !conDetalle(e.id)) { pendientePorSenal(e.id, e); if (ponerProvisional(e, senalDe(e, catalogo))) repinta = true; }
          if (!enLista) { falta = true; esperadas[e.id] = esperadas[e.id] || ya; }
          return;
        }
        // Un reintento de la cola tras una falla pasajera: sin recuadro, cuenco ni notificación; UNA lectura de la lista (si ya
        // entró, su recuadro sale por ahí). Sin `esperadas`: no se relee cada 2–8 s mientras Wix sigue caído.
        // Latencia (21-nov noche): con `ok` el servidor ya marcó en Wix (lo escribe DESPUÉS de marcar): sí sale su recuadro.
        if (silencio[e.id] && ts - silencio[e.id] < SILENCIO_MS && !e.ok) { falta = true; return; }
        delete silencio[e.id];
        var t = deSenal(e, estado, catalogo, directorio && directorio.ids);
        if (t) { anunciadas[e.id] = ya; nuevos.unshift(t); deLaSenal[e.id] = t; if (ponerProvisional(e, t.senal)) repinta = true; }   // la lista viene de la más vieja a la más nueva
        esperadas[e.id] = esperadas[e.id] || ya;
        falta = true;
      });
      if (nuevos.length) {
        ponerRecuadros(nuevos);
        tanda(nuevos.map(function (t) { return t.id; }));
        avisarPorSenal(nuevos);
        nuevos.forEach(function (t) { medir('la señal', t, ' (la señal tardó ' + (Date.now() - inicioSenal) + ' ms)'); });
      }
      if (repinta) repintar();
      return falta;
    }
    setInterval(function () {                                   // vencen a los ~8 s; un vistazo cada segundo
      if (!recuadros.length) return;
      var ahora = Date.now(), antes = recuadros.length;
      // Los que esperan detrás del «+N» no vencen sin haberse visto: su reloj empieza cuando suben a la vista.
      recuadros.forEach(function (r, i) { if (i >= RECUADROS_VISIBLES) r.hasta = Math.max(r.hasta, ahora + RECUADRO_MS); });
      recuadros = recuadros.filter(function (r) { return r.hasta > ahora; });
      if (recuadros.length !== antes) pintarRecuadros(doc, recuadros, cerrarRecuadro);
    }, 1000);
    function sesionPerdida() {
      ls.del(TOKEN_KEY); alerta = 'Contraseña'; ponerTitulo();
      if (!avisoSesion && enSegundoPlano(doc)) { avisoSesion = true; notificar({ titulo: 'Mostrador: pide la contraseña otra vez', cuerpo: 'Ya no se están viendo las llegadas.', tag: TAG_AVISO }); }
      irClave(TEXTOS.otraVez); doc.title = tituloDe(tituloBase, 0, alerta);
    }

    // Reloj del sondeo: en el Worker (no lo frena la pestaña oculta) o, si no carga, setTimeout.
    try {
      if (typeof win.Worker === 'function') {
        worker = new win.Worker('mostrador.worker.js');
        worker.onmessage = function () { tic(); };
        worker.onerror = function () { worker = null; if (tocaba) programar(Math.max(1, (tocaba - Date.now()) / 1000)); };
      }
    } catch (_) { worker = null; }
    var tocaRepaso = false;                                     // el tic que viene es el del repaso (no el de la señal)
    function programar(seg) {
      var ms = Math.max(0.3, seg) * 1000;
      clearTimeout(timer); tocaba = Date.now() + ms; tocaRepaso = false;
      if (worker) { try { worker.postMessage(ms); return; } catch (_) { worker = null; } }
      timer = setTimeout(tic, ms);
    }
    /** Qué toca: la lectura de la lista tras la señal, el repaso de `llegadas` (cada 30 s, o el que diga el servidor) o la
     *  señal. Mientras corre un «llegadas» (en vivo, 3–8 s con la revisión), la señal SIGUE (v3): el recuadro no espera.
     *  La señal solo la lee la pestaña que avisa: con dos pestañas en la misma compu (mismo token e IP) no chocan con el
     *  tope del servidor ni duplican lecturas; la otra solo pinta con el repaso. */
    function tic() {
      var repaso = !senalSeg || tocaRepaso || Date.now() >= proximoRepaso - 300;
      // Si a la señal ya le toca, va A LA PAR de la lista: las relecturas (hasta ~6 s) no la frenan.
      var senalToca = !!senalSeg && !cargandoSenal && Date.now() - inicioSenal >= senalSeg * 1000 - 300;
      if (!cargando && (pideFresco || repaso)) { cargar(pideFresco ? { fresco: senalVista || 1 } : null); if (senalToca && leeSenal()) consultarSenal(); return; }
      if (senalSeg && leeSenal()) return consultarSenal();
      if (!cargando) alRepaso();
    }
    /** ¿Esta pestaña lee la señal? La que avisa y, latencia (21-nov noche), también la que está A LA VISTA: con dos pestañas,
     *  la que se ve ya no espera al repaso de 30 s para sacar sus recuadros (el tope del servidor es 1 cada 1 s; un 429
     *  solo la recorre 1 s). La oculta que no avisa sigue sin leerla. */
    function leeSenal() { return lider() || !enSegundoPlano(doc); }
    function alRepaso() { programar(Math.max(0.5, (proximoRepaso - Date.now()) / 1000)); tocaRepaso = true; }
    /** Ms hasta la siguiente señal, a ritmo fijo de inicio a inicio (antes: 3 s DESPUÉS de cada respuesta, ~3.5 s reales). */
    function msHastaSenal() { return inicioSenal ? Math.max(500, inicioSenal + senalSeg * 1000 - Date.now()) : senalSeg * 1000; }
    /** La primera lectura de la lista tras la señal, en cuanto el tope del servidor (1 «llegadas» cada 2 s) lo deja; las
     *  relecturas (Bookings aún no muestra el ATTENDED), a los 2.1 s. */
    function esperaFresco() { return !intento ? Math.max(0.3, (inicioLlegadas + 2050 - Date.now()) / 1000) : ESPERAS_FRESCO[Math.min(intento, ESPERAS_FRESCO.length) - 1]; }
    function siguiente() {
      if (pideFresco && !cargando) return programar(esperaFresco());
      var ms = msHastaSenal();
      if (!senalSeg || (!cargando && proximoRepaso - Date.now() <= ms)) return alRepaso();
      programar(ms / 1000);
    }
    function consultarSenal() {
      if (cargandoSenal) return;
      if (!ls.get(TOKEN_KEY)) { irClave(); return; }
      cargandoSenal = true; inicioSenal = Date.now();
      var yaMismo = false;
      api('senal', null, TIEMPO_SENAL_MS)
        .then(function (x) {
          if (x.s === 401 || x.s === 403) { sesionPerdida(); return; }
          if (x.s === 429) { programar((x.j && x.j.espera) || 1); return; }
          if (x.s !== 200 || !x.j || !x.j.ok) throw new Error('senal');
          if (fallasSenal >= 3) red(true, 'Conectado de nuevo');
          fallasSenal = 0;
          var v = typeof x.j.v === 'string' ? x.j.v : null;
          if (v && v !== senalVista) {
            // La primera lectura solo fija la base, salvo que la señal sea de justo antes (o después) de la última lista.
            var nueva = senalVista != null || !(Date.parse(v.split('~')[0]) < ahoraServidor - 5000);
            senalVista = v;
            // v3: el recuadro sale AQUÍ, con lo que trae la señal; la lista se pide solo si hace falta.
            if (nueva && procesarSenal(x.j.ll)) { pideFresco = true; intento = 0; yaMismo = true; }
          }
          if (!yaMismo || cargando) siguiente();
        })
        .catch(function () {
          fallasSenal++;
          if (fallasSenal >= 3) red(false, 'Sin conexión con Wix · reintentando');
          programar(fallasSenal <= 2 ? 1 : Math.min(ESPERA_ERROR_SEG, 3 * fallasSenal));   // una falla suelta: otra vez en 1 s
        })
        .then(function () { cargandoSenal = false; if (yaMismo && !cargando) tic(); });   // «llegadas» YA, no en el siguiente tic
    }
    function cargar(opc) {
      if (cargando) return;
      if (!ls.get(TOKEN_KEY)) { irClave(); return; }
      cargando = true; inicioLlegadas = Date.now();
      // `fresco`: la versión de la señal que se vio (el servidor salta su caché solo si es de antes) o 1 («Actualizar»).
      var fresco = !!(opc && opc.fresco), datos = {};
      if (estado && estado.cursor) datos.desde = estado.cursor;
      if (estado && estado.rezago) datos.rezago = 1;
      if (fresco) datos.fresco = typeof opc.fresco === 'string' ? opc.fresco : 1;
      // La revisión (¿ya se cerró en Wix?) no va en la lectura por la señal: esa es solo para el recuadro.
      if (estado && typeof datos.fresco !== 'string') { var rv = idsRevisar(bloques(estado.tarjetas, ahoraMs())); if (rv.length) datos.revisar = rv; }
      // v3.1: las que tiene SIN detalle (si Bookings las mostró tarde, el cursor ya pasó y el servidor no las calculaba) y,
      // una vez, el catálogo para traducir los temas de la señal.
      if (estado && typeof datos.fresco !== 'string') {
        var sd = estado.tarjetas.filter(function (t) { return t.id && !t.detalle; }).map(function (t) { return t.id; }).slice(0, 24);
        if (sd.length) datos.detalle = sd;
      }
      if (!catalogo) datos.catalogo = 1;
      api('llegadas', datos)
        .then(function (x) {
          if (x.s === 401 || x.s === 403) { sesionPerdida(); return; }
          if (x.s === 429) { cargando = false; programar((x.j && x.j.espera) || 2); return; }
          if (x.s !== 200 || !x.j || !x.j.ok) { red(false, 'Sin conexión con Wix · reintento en ' + ESPERA_ERROR_SEG + ' s'); errorLista(); return; }
          if (x.j.token) ls.set(TOKEN_KEY, x.j.token);
          var r = combinar(estado, x.j);
          estado = r.estado; ultimaCarga = Date.now(); ahoraServidor = Date.parse(x.j.ahora) || Date.now();
          directorio = alDirectorio(directorio, estado);
          if (x.j.catalogo) catalogo = leerCatalogo(x.j.catalogo) || catalogo;
          estado.tarjetas.forEach(function (t) { if (t.id && t.detalle) confirmadas[t.id] = Math.max(confirmadas[t.id] || 0, ahoraServidor); });
          limpiarProvisionales();
          desfase = Math.abs(ahoraServidor - Date.now()) > 5000 ? ahoraServidor - Date.now() : 0;   // < 5 s: es la red, no el reloj
          // Lo que ya salió por la señal no se anuncia otra vez (su recuadro se completa con el detalle, abajo).
          var conRecuadro = r.llegaron.filter(function (t) { return vaRecuadro(t, x.j.ahora) && !anunciadas[t.id]; });
          if (conRecuadro.length) { ponerRecuadros(conRecuadro); conRecuadro.forEach(function (t) { medir('«llegadas»', t); }); }
          refrescarRecuadros(estado.tarjetas);
          avisarNuevas(r.nuevas);
          tanda(conRecuadro.map(function (t) { return t.id; }).concat(enSegundoPlano(doc) ? r.nuevas.map(function (t) { return t.id; }) : []));
          pintar(doc, estado, ahoraMs(), listaProv());
          // Tras la señal: si todavía no se ve a nadie nuevo (el ATTENDED de Wix va detrás de la señal), otra vez en 2.1 s.
          if (fresco) siguienteFresco(r.cambio);
          var s = x.j.sondeo || { activo: true, esperaSeg: 15 };
          senalSeg = s.activo && Number(s.senalSeg) > 0 ? Number(s.senalSeg) : 0;
          proximoRepaso = Date.now() + Math.max(2, Number(s.esperaSeg) || 15) * 1000;
          if (Object.keys(estado.esperan || {}).length) proximoRepaso = Math.min(proximoRepaso, Date.now() + DETALLE_PRONTO_SEG * 1000);
          red(true, 'Actualizado ' + hora(x.j.ahora) + (s.activo ? (senalSeg ? ' · al instante' : '') : ' · sin clases ahora, reviso cada ' + Math.round(s.esperaSeg / 60) + ' min'), !s.activo);
          cargando = false;
          siguiente();
        })
        .catch(function () { red(false, 'Sin internet · reintento en ' + ESPERA_ERROR_SEG + ' s'); errorLista(); })
        .then(function () { cargando = false; });
    }
    /** Falló «llegadas»: la lista se reintenta en 30 s, pero la SEÑAL sigue a su ritmo (latencia 21-nov noche: antes un
     *  502 o un corte de 20 s de la lista también paraba la señal 30 s y los recuadros esperaban). */
    function errorLista() {
      pideFresco = false; cargando = false;
      proximoRepaso = Date.now() + ESPERA_ERROR_SEG * 1000;
      if (senalSeg) siguiente(); else programar(ESPERA_ERROR_SEG);
    }
    /** Tras una lectura «fresca» por la señal: ¿otra? Sí mientras falte en la lista una llegada que trajo la señal (2.1, 3, 5 y
     *  8 s: ≈ 18 s tras la primera, M3) o, si no trajo ninguna nueva, hasta 3 veces mientras nada cambie. */
    function siguienteFresco(cambio) {
      var ya = Date.now(), quedan = 0;
      for (var id in esperadas) if (Object.prototype.hasOwnProperty.call(esperadas, id)) {
        if (tarjetaDe(id) || ya - esperadas[id] > ESPERADA_MS) delete esperadas[id]; else quedan++;
      }
      var otra = quedan ? intento < ESPERAS_FRESCO.length : !cambio && reintentosCambio > 0;
      if (otra && !quedan) reintentosCambio--;
      if (otra) { intento++; pideFresco = true; } else { pideFresco = false; intento = 0; reintentosCambio = 0; esperadas = {}; }
    }
    // Vigía (cada 30 s): si el sondeo se atrasó (consulta colgada, Worker muerto, compu dormida), se dice y se reintenta.
    setInterval(function () {
      if (!ls.get(TOKEN_KEY) || !tocaba) return;
      if (cargando && Date.now() - inicioLlegadas > TIEMPO_FETCH_MS + 5000) cargando = false;    // red de seguridad
      if (cargandoSenal && Date.now() - inicioSenal > TIEMPO_SENAL_MS + 5000) cargandoSenal = false;
      if (atrasado(Date.now(), tocaba)) {
        red(false, TEXTOS.atrasada + ' ' + (ultimaCarga ? hora(new Date(ultimaCarga).toISOString()) : 'que se abrió') + ' · reintentando');
        cargar();
      }
    }, 30000);
    // Cuando una clase termina, sus pendientes pasan solos de «Van llegando» a «Se van yendo» (y a los 45 min salen).
    setInterval(function () { if (estado && !$('vistaLista').hidden) { limpiarProvisionales(); pintar(doc, estado, ahoraMs(), listaProv()); } }, 15000);

    $('formClave').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var clave = $('clave').value, b = $('entrar');
      if (!clave) return;
      b.disabled = true; $('errorClave').textContent = '';
      api('entrar', { clave: clave, dispositivo: 'mostrador' })
        .then(function (x) {
          if (x.s === 200 && x.j && x.j.token) { ls.set(TOKEN_KEY, x.j.token); $('clave').value = ''; irLista(); cargar(); return; }
          $('errorClave').textContent = x.s === 401 ? TEXTOS.clave : x.s === 429 ? TEXTOS.muchos : x.s === 503 ? TEXTOS.cerrado : TEXTOS.red;
        })
        .catch(function () { $('errorClave').textContent = TEXTOS.red; })
        .then(function () { b.disabled = false; });
    });
    $('permiso').addEventListener('click', function () {
      sonido.preparar();
      if (!Notif) return;
      var p = Notif.requestPermission(function () { permisoUi(); });   // Safari viejo usa el callback
      if (p && typeof p.then === 'function') p.then(permisoUi, permisoUi);
    });
    $('probar').addEventListener('click', function () {
      sonido.preparar();
      notificar({ titulo: 'Llegó Clienta A. · Reformer 7:30 am', cuerpo: (detallado() ? '💳 pago pendiente' : '⚠ trae pendiente') + ' (aviso de prueba)', tag: TAG_AVISO });
      ponerRecuadros([{ id: 'prueba', nombre: 'Clienta Ejemplo', iniciales: 'CE', origen: 'tablet', clase: { disciplina: 'Pilates Reformer', inicio: new Date().toISOString() },
        detalle: { elemento: 'FUEGO', pendientes: [{ tema: 'Aviso de prueba' }], insignias: [] } }]);
      if (sonidoOn()) sonido.tocar(volumen());
    });
    $('sonido').addEventListener('click', function () {
      var on = !sonidoOn();
      if (on) { ls.set(SONIDO_KEY, '1'); sonido.preparar(); sonido.tocar(volumen()); } else ls.del(SONIDO_KEY);
      sonidoUi();
    });
    if ($('volumen')) $('volumen').addEventListener('click', function () {   // bajo → medio → alto → bajo (se oye al cambiar)
      var orden = ['bajo', 'medio', 'alto'], v = orden[(orden.indexOf(volumen()) + 1) % orden.length];
      ls.set(VOLUMEN_KEY, v); sonido.preparar(); sonido.tocar(v); sonidoUi();
    });
    if ($('avisos')) $('avisos').addEventListener('click', function () {
      if (detallado()) ls.set(AVISOS_KEY, 'discreto'); else ls.del(AVISOS_KEY);
      avisosUi();
    });
    $('actualizar').addEventListener('click', function () { sonido.preparar(); cargar({ fresco: 1 }); });   // a mano: sin la caché de 10 s
    $('salir').addEventListener('click', function () { ls.del(TOKEN_KEY); irClave(''); });
    var alVolver = function () {
      if (enSegundoPlano(doc)) return;
      sinVer = []; ponerTitulo();
      if (ls.get(TOKEN_KEY) && Date.now() - ultimaCarga > 10000) cargar();
    };
    doc.addEventListener('visibilitychange', alVolver);
    win.addEventListener('focus', alVolver);
    // Al cerrar la pestaña suelta el candado de avisos (la otra pestaña toma el relevo sin esperar 90 s).
    win.addEventListener('pagehide', function () { try { var v = JSON.parse(ls.get(LIDER_KEY) || 'null'); if (v && v.id === miId) ls.del(LIDER_KEY); } catch (_) {} });
    // Audio: con el sonido encendido, el contexto se crea al arrancar (queda suspendido hasta el primer gesto) y CUALQUIER
    // gesto lo activa: un clic, un toque o una tecla (teclear la contraseña y dar Enter también cuenta). Mientras no corra,
    // el botón dice «Sonido: toca para activar».
    var alGesto = function () { if (sonidoOn() && !sonido.corriendo()) sonido.preparar(); };
    ['pointerdown', 'keydown', 'click'].forEach(function (e) { doc.addEventListener(e, alGesto, true); });
    if (sonidoOn()) sonido.asegurar();

    if (ls.get(TOKEN_KEY)) { irLista(); cargar(); } else irClave('');
  }

  raiz.HeraMostrador = { combinar: combinar, resumenNotificacion: resumenNotificacion, acumular: acumular, nombreCorto: nombreCorto,
    soyLider: soyLider, atrasado: atrasado, tituloDe: tituloDe, conTiempo: conTiempo, pintar: pintar, enSegundoPlano: enSegundoPlano,
    temaDe: temaDe, bloques: bloques, textosLista: textosLista, ligaDe: ligaDe, agrupar: agrupar, cuentaGrupo: cuentaGrupo, avisoTablet: avisoTablet,
    entradasSenal: entradasSenal, deSenal: deSenal, alDirectorio: alDirectorio, cronoDe: cronoDe, muestraReloj: muestraReloj, mejorReloj: mejorReloj,
    tramosMedicion: tramosMedicion, textoMedicion: textoMedicion, conProvisionales: conProvisionales, temasDeCodigos: temasDeCodigos, leerCatalogo: leerCatalogo,
    detalleProvisional: detalleProvisional, senalDe: senalDe, DESTINOS: DESTINOS, idsRevisar: idsRevisar, finClase: finClase, pastillasDe: pastillasDe, metaDe: metaDe,
    etiquetaAviso: etiquetaAviso, recuadroDe: recuadroDe, vaRecuadro: vaRecuadro, pintarRecuadros: pintarRecuadros,
    recetaCuenco: recetaCuenco, muestrasCuenco: muestrasCuenco, VOLUMENES: VOLUMENES, CUENCO: CUENCO,
    apiUrl: apiUrl, hora: hora, claseCorta: claseCorta, TEXTOS: TEXTOS, TOKEN_KEY: TOKEN_KEY, TAG_PENDIENTE: TAG_PENDIENTE, TAG_AVISO: TAG_AVISO };
  if (raiz.document && raiz.location && raiz.fetch && !raiz.HeraMostradorSinArranque) {
    if (raiz.document.readyState === 'loading') raiz.document.addEventListener('DOMContentLoaded', function () { arrancar(raiz); });
    else arrancar(raiz);
  }
})(typeof window !== 'undefined' ? window : this);
