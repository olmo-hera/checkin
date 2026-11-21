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
  var RE_FICHA = /^https:\/\/manage\.wix\.com\/dashboard\/[0-9a-f-]{36}\/contacts\/view\/[0-9a-f-]{36}$/i;
  var ELEMENTOS = { FUEGO: 1, AGUA: 1, AIRE: 1, TIERRA: 1 };
  /** ¿`k` es una llave PROPIA de `o`? («constructor» o «__proto__» no pasan como color o elemento.) */
  function tiene(o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); }
  var MARCA_NUEVA_MS = 90000;                  // cuánto dura el resaltado de una llegada nueva
  var YENDO_MS = 45 * 60000;                   // «Se van yendo»: su clase terminó hace ≤ 45 min; después sale de la lista
  var TOPE_BLOQUE = 12;                        // renglones por bloque («+N más» abajo)
  var RECUADRO_MS = 8000;                      // cuánto dura el recuadro de una llegada de la tablet
  var RECUADROS_VISIBLES = 3;                  // máx. a la vista; las demás «+N» (esperan su turno: su reloj corre al verse)
  var RECUADROS_TOPE = 8;                      // en la cola, como mucho 8 (una clase de Fitpass que llega junta no se eterniza)
  var RECUADRO_RECIENTE_MS = 3 * 60000;        // al volver la conexión no se anuncia como «hizo check-in» lo de hace rato
  var REINTENTOS_SENAL = 2;                    // la señal pudo llegar antes que el ATTENDED de Wix: hasta 2 relecturas…
  var REINTENTO_SEG = 2.1;                     // …a los 2.1 s (el tope del servidor es 1 «llegadas» cada 2 s)
  var DETALLE_PRONTO_SEG = 2.1;                // una llegada nueva sin detalle (la lectura por la señal no lo calcula): otra vez a los 2.1 s
  var ESPERA_ERROR_SEG = 30;
  var TIEMPO_FETCH_MS = 20000;                 // una consulta colgada (wifi) se corta a los 20 s…
  var TIEMPO_SENAL_MS = 5000;                  // …y una señal (1 lectura por id) a los 5 s: no frena el repaso hasta 20 s
  var GRACIA_VIGIA_MS = 60000;                 // si pasó 1 min de la hora en que tocaba el sondeo, la pantalla se pone en rojo
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
  function sinNada(t) { return t.detalle ? 'Sin pendientes' : 'Sin detalle todavía · revisa la pantalla'; }

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
      proximas: Array.isArray(resp.proximas) ? resp.proximas : [], horas: resp.horas !== false,
      total: Number(resp.total) > tarjetas.length ? Number(resp.total) : tarjetas.length, rezago: Number(resp.rezagoPanel) > 0,
      ahora: resp.ahora || null }, nuevas: nuevas, llegaron: llegaron, cambio: cambio };
  }

  /** Junta lo que no se ha visto (por id, sin repetir) mientras la pestaña sigue en segundo plano: el resumen sale de TODO
   *  eso, así un aviso nuevo sin pendiente no borra el de quien sí traía. Se vacía al volver a la pestaña. */
  function acumular(sinVer, nuevas) {
    var out = (sinVer || []).slice(), ids = {};
    out.forEach(function (t) { ids[t.id] = 1; });
    (nuevas || []).forEach(function (t) { if (!ids[t.id]) { ids[t.id] = 1; out.push(t); } });
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
  var COLORES = { pago: 1, canje: 1, offline: 1, pausa: 1, nota: 1, neutro: 1, primera: 1, cumple: 1, aviso: 1 };
  function temaDe(p) {
    if (p && p.tema) {
      var x = { icono: String(p.icono || ''), tema: String(p.tema), accion: String(p.accion || ''), urgencia: Number(p.urgencia) || 6,
        color: tiene(COLORES, p.color) ? p.color : 'neutro', texto: p.texto };
      if (p.ficha && RE_FICHA.test(String(p.ficha))) x.ficha = String(p.ficha);   // 💵 plan en otra ficha: liga a ESA ficha
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
    var ins = det.insignias || [];
    if (ins.some(function (x) { return x.tipo === 'primera'; })) out.push({ icono: '🌱', tema: 'Primera clase', accion: '', color: 'primera', texto: 'Es su primera clase en Hera: recibirla' });
    if (ins.some(function (x) { return x.tipo === 'cumple'; })) out.push({ icono: '🎂', tema: 'Cumple', accion: '', color: 'cumple', texto: 'Cumple años hoy: felicitarla' });
    if (det.market || t.market) out.push({ icono: '🎟️', tema: String(det.plan || t.nombre || 'Marketplace'), accion: 'validar su código', color: 'neutro', texto: (det.avisos || [])[0] });
    else if (det.sinFicha) out.push({ icono: '', tema: 'Sin ficha en Wix', accion: 'revisar', color: 'neutro', texto: (det.avisos || [])[0] });
    else (det.avisos || []).forEach(function (a) { out.push({ icono: '', tema: String(a), accion: '', color: 'aviso', texto: String(a) }); });
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
  function bloques(ts, ahoraMs) {
    var ahora = ahoraMs || Date.now(), van = [], yendo = [], fuera = 0, sd = 0, ct = 0;
    (ts || []).forEach(function (t) {
      if (!t.detalle) { sd++; return; }
      if (!conTema(t)) return;
      ct++;
      var f = finClase(t.clase);
      if (!Number.isFinite(f) || ahora < f) van.push(t);
      else if (ahora - f <= YENDO_MS) yendo.push(t);
      else fuera++;
    });
    var porHora = function (a, b) { return String(b.hora || '').localeCompare(String(a.hora || '')); };
    van.sort(porHora);
    // Por fin de su clase y, si dos clases terminan juntas (Reformer y Mat), por clase: sus renglones no se intercalan y el
    // encabezado «Terminó…» sale una vez por clase.
    var claseDe = function (t) { return String((t.clase && (t.clase.id || t.clase.inicio)) || ''); };
    yendo.sort(function (a, b) { return finClase(b.clase) - finClase(a.clase) || claseDe(a).localeCompare(claseDe(b)) || porHora(a, b); });
    return { van: van, yendo: yendo, fuera: fuera, sinDetalle: sd, conTema: ct, total: (ts || []).length };
  }
  /** Ids que se le piden al servidor para revisar (¿ya se cerró su pendiente en Wix?): las que se VEN en la lista (12 por
   *  bloque, máx. 24): con 10 o más en «Van llegando», las de «Se van yendo» también se revisan. El marketplace no (Wix no
   *  sabe si ya se validó su código). */
  function idsRevisar(b) {
    var ok = function (t) { return t.id && !(t.detalle && t.detalle.market); };
    return b.van.filter(ok).slice(0, TOPE_BLOQUE).concat(b.yendo.filter(ok).slice(0, TOPE_BLOQUE)).map(function (t) { return t.id; });
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
    var ps = String((t && t.nombre) || '').trim().split(/\s+/).filter(Boolean), det = t && t.detalle;
    var extra = '', tipo = '';
    if (det && det.pendientes && det.pendientes.length) { extra = 'trae pendiente → ver en Por resolver'; tipo = 'pendiente'; }
    else if (det && det.sinDetalle) { extra = 'sin detalle → ver en Por resolver'; tipo = 'pendiente'; }
    else if (det && (det.insignias || []).some(function (x) { return x.tipo === 'primera'; })) { extra = '🌱 primera clase'; tipo = 'primera'; }
    else if (det && (det.insignias || []).some(function (x) { return x.tipo === 'cumple'; })) { extra = '🎂 cumple hoy'; tipo = 'cumple'; }
    else if (det && det.market) extra = '🎟️ validar su código';
    return { id: t && t.id, nombre: ps[0] || 'Alumna', inicial: ps.length > 1 ? ps[1].charAt(0).toLocaleUpperCase('es-MX') + '.' : '',
      linea: 'hizo check-in · ' + claseCorta(t && t.clase), extra: extra, tipo: tipo, iniciales: (t && t.iniciales) || '?',
      elemento: det && tiene(ELEMENTOS, det.elemento) ? det.elemento : '', market: !!(t && t.market) };
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
  function pastilla(doc, x) {
    var s = el(doc, 'span', 'pill ' + (tiene(COLORES, x.color) ? x.color : 'neutro'));
    s.appendChild(el(doc, 'span', 'pill-tema', (x.icono ? x.icono + ' ' : '') + x.tema));
    if (x.accion || x.ficha) {
      var a = el(doc, 'span', 'pill-accion', x.accion || '');
      if (x.ficha && RE_FICHA.test(x.ficha)) {
        a.appendChild(el(doc, 'span', null, x.accion ? ' · ' : ''));
        var lk = el(doc, 'a', 'pill-liga', 'abrir esa ficha'); lk.href = x.ficha; lk.target = '_blank'; lk.rel = 'noopener noreferrer';
        a.appendChild(lk);
      }
      s.appendChild(a);
    }
    if (x.texto) s.setAttribute('title', (x.color === 'aviso' || x.color === 'primera' || x.color === 'cumple' ? '' : 'Al llegar: ') + String(x.texto));
    return s;
  }
  /** Línea gris: plan y saldo primero (lo que se corta con «…» es lo de menos), luego ⭐ hito, 👋 regreso y años.
   *  Sin lo que ya va en pastilla (🌱 🎂 🔚 ⏳). */
  function metaDe(t) {
    var det = t.detalle || null;
    if (!det) return 'Sin detalle todavía (llegó antes de abrir esta pantalla, o no se pudo leer)';
    if (det.sinDetalle) return '';
    var xs = [];
    if (!det.market && !det.sinFicha) xs.push(String(det.plan || 'sin plan') + (det.saldo ? ' · ' + String(det.saldo) : ''));
    (det.insignias || []).forEach(function (x) { if (x.tipo !== 'primera' && x.tipo !== 'cumple' && x.texto) xs.push(String(x.texto)); });
    return xs.join(' · ');
  }

  /** Un renglón: hora · círculo · nombre y clase (y la línea gris) · a la derecha el tema en pastilla (o ✓ discreto). */
  function fila(doc, t, ahoraMs, animar) {
    var det = t.detalle || null, ps = pastillasDe(t);
    var li = el(doc, 'li', 'fila');
    if (t.prioridad === 1) li.className += ' con-pendiente c-' + (ps.length ? ps[0].color : 'neutro');   // ps[0] = su pendiente más urgente
    else if (ps.length && ps[0].color === 'primera') li.className += ' c-primera';
    else if (det && det.market) li.className += ' c-neutro';      // 🎟️ validar su código
    else if (!ps.length && det) li.className += ' tenue';          // tenue = «se sabe que no trae nada»; sin detalle, no
    if (ahoraMs - (t.desde || 0) < MARCA_NUEVA_MS && t.nueva) li.className += ' nueva' + (animar ? ' entra' : '');
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
    var cl = el(doc, 'span', 'f-clase', ' · ' + claseCorta(t.clase) + (t.clase && t.clase.coach ? ' · ' + t.clase.coach : ''));
    l1.appendChild(cl);
    info.appendChild(l1);
    var meta = metaDe(t);
    if (meta) { var m = el(doc, 'div', 'f-meta', meta); m.setAttribute('title', meta); info.appendChild(m); }   // se corta con «…»: completo al pasar el ratón
    li.appendChild(info);
    if (ps.length) {
      var temas = el(doc, 'div', 'f-temas');
      ps.forEach(function (x) { temas.appendChild(pastilla(doc, x)); });
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
  /** Un bloque de la lista: sus renglones (tope 12 + «+N más»). En «Se van yendo», arriba de cada grupo la hora a la que
   *  terminó su clase. */
  function pintarBloque(doc, ul, ts, ahora, conFin) {
    vaciar(ul);
    var ultimoFin = null;
    ts.slice(0, TOPE_BLOQUE).forEach(function (t) {
      if (conFin) {
        var f = finClase(t.clase), k = String(f) + '|' + ((t.clase && t.clase.id) || '');
        if (k !== ultimoFin) {
          ultimoFin = k;
          ul.appendChild(el(doc, 'li', 'sub-fin', 'Terminó ' + hora(new Date(f).toISOString()) + ' · ' + claseCorta(t.clase) +
            ' · hace ' + Math.max(0, Math.round((ahora - f) / 60000)) + ' min'));
        }
      }
      ul.appendChild(fila(doc, t, ahora, !animadas[t.id]));
    });
    if (ts.length > TOPE_BLOQUE) ul.appendChild(el(doc, 'li', 'sub-mas', 'y ' + (ts.length - TOPE_BLOQUE) + ' más'));
    ul.hidden = !ts.length;
  }
  function pintar(doc, estado, ahoraMs) {
    var ts = (estado && estado.tarjetas) || [], ahora = ahoraMs || Date.now();
    var b = bloques(ts, ahora), tx = textosLista(b, estado && estado.total), hay = b.van.length + b.yendo.length;
    pintarBloque(doc, doc.getElementById('van'), b.van, ahora, false);
    pintarBloque(doc, doc.getElementById('yendo'), b.yendo, ahora, true);
    ts.forEach(function (t) { if (t.nueva) animadas[t.id] = 1; });
    // Los dos bloques con su separador salen siempre que haya alguien en la lista (el vacío dice «nadie»).
    doc.getElementById('bloqueVan').hidden = !hay;
    doc.getElementById('bloqueYendo').hidden = !hay;
    doc.getElementById('vacioVan').hidden = !!b.van.length;
    doc.getElementById('vacioYendo').hidden = !!b.yendo.length;
    doc.getElementById('cuentaVan').textContent = b.van.length ? '(' + b.van.length + ')' : '';
    doc.getElementById('cuentaYendo').textContent = b.yendo.length ? '(' + b.yendo.length + ')' : '';
    var sr = doc.getElementById('sinResolver');
    sr.hidden = !!hay;
    sr.textContent = tx.vacio;
    sr.className = 'vacio-mini' + (tx.ok ? '' : ' espera');
    doc.getElementById('conteoResolver').textContent = hay ? '(' + hay + ')' : '';
    doc.getElementById('conteo').textContent = tx.conteo;
    var nota = doc.getElementById('notaHoras');
    if (nota) { nota.textContent = ts.length && estado && !estado.horas ? TEXTOS.sinHoras : ''; nota.hidden = !nota.textContent; }
    pintarProximas(doc, (estado && estado.proximas) || []);
    return b;
  }

  function pintarProximas(doc, ps) {
    var cont = doc.getElementById('proximas');
    vaciar(cont);
    doc.getElementById('sinProximas').hidden = !!ps.length;
    ps.forEach(function (p) {
      var s = el(doc, 'section', 'proxima');
      var h = el(doc, 'h3'), cl = el(doc, 'span', 'px-clase', claseCorta(p));
      if (p.coach) cl.appendChild(el(doc, 'small', null, ' · ' + p.coach));
      h.appendChild(cl);
      h.appendChild(el(doc, 'span', 'px-cuenta', (p.llegaron || 0) + ' de ' + (p.lugares || 0) + (p.empezo ? ' · ya empezó' : '')));
      s.appendChild(h);
      var fs = Array.isArray(p.faltan) ? p.faltan : [];
      if (!fs.length) s.appendChild(el(doc, 'p', 'listo', 'Ya llegaron todas ✓'));
      else {
        var ul = el(doc, 'ul', 'faltan');
        fs.forEach(function (f) {
          var li = el(doc, 'li', 'falta');
          li.appendChild(el(doc, 'span', 'mini', f.iniciales || '?'));
          li.appendChild(nombreNodo(doc, String(f.nombre || 'Alumna') + (f.lugares >= 2 ? ' (' + f.lugares + ')' : ''), f.ficha, null));
          ul.appendChild(li);
        });
        s.appendChild(ul);
      }
      cont.appendChild(s);
    });
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
    var estado = null, timer = null, cargando = false, inicioCarga = 0, ultimaCarga = 0, tocaba = 0, tituloBase = doc.title;
    var sinVer = [], alerta = '', avisoSesion = false, worker = null;
    // Señal (Olmo 21-nov, ≤ 5 s): `senalSeg` > 0 solo con un servidor que la tiene y mientras hay clases.
    var senalSeg = 0, senalVista = null, proximoRepaso = 0, pideFresco = false, reintentos = 0, fallasSenal = 0, ahoraServidor = 0;
    // Desfase del reloj de la compu contra el del servidor: el cambio de bloque («Se van yendo») usa la hora del servidor.
    var desfase = 0, ahoraMs = function () { return Date.now() + desfase; };
    var recuadros = [], sonaron = {};
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
      var p = win.fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(cuerpo),
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined })
        .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { s: r.status, j: j }; }); });
      return conTiempo(p, ms || TIEMPO_FETCH_MS, function () { if (ctl) ctl.abort(); }, win);
    }
    function ponerTitulo() { doc.title = tituloDe(tituloBase, sinVer.length, alerta); }
    function red(ok, txt, dormido) {
      $('punto').className = 'punto' + (ok ? (dormido ? ' dormido' : '') : ' off');
      $('estadoTxt').textContent = txt;
      alerta = ok ? '' : 'Sin conexión'; ponerTitulo();
    }
    function irClave(msg) {
      clearTimeout(timer); if (worker) worker.postMessage(0); tocaba = 0; estado = null; senalSeg = 0; senalVista = null; pideFresco = false;
      recuadros = []; pintarRecuadros(doc, recuadros, null);
      $('vistaLista').hidden = true; $('vistaClave').hidden = false;
      $('errorClave').textContent = msg || '';
      try { $('clave').focus(); } catch (_) {}
    }
    function irLista() { $('vistaClave').hidden = true; $('vistaLista').hidden = false; alerta = ''; avisoSesion = false; ponerTitulo(); permisoUi(); sonidoUi(); avisosUi(); }

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
    function notificar(n) {
      if (!n || !Notif || Notif.permission !== 'granted') return;
      try {
        // Callada solo si el cuenco de verdad suena; si el audio no corre, que suene la del sistema.
        var x = new Notif(n.titulo, { body: n.cuerpo, tag: n.tag || TAG_AVISO, renotify: true, requireInteraction: !!n.fija, silent: sonidoOn() && sonido.corriendo(),
          icon: 'https://static.wixstatic.com/media/9d6afa_e930e021d3564d24bc04bdc3e4c172f3~mv2.png/v1/fill/w_192,h_192/favicon.png' });
        x.onclick = function () { try { win.focus(); } catch (_) {} x.close(); };
      } catch (_) {}
    }
    /** Notificación del sistema (solo en segundo plano) de lo que ya trae su detalle. El cuenco va aparte (`tanda`). */
    function avisarNuevas(nuevas) {
      if (!nuevas.length) return;
      nuevas.forEach(function (t) { t.nueva = true; });
      if (!enSegundoPlano(doc)) return;
      sinVer = acumular(sinVer, nuevas);
      ponerTitulo();
      if (!lider()) return;
      notificar(resumenNotificacion(sinVer, { detallado: detallado() }));
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
        var r = recuadroDe(t); r.hasta = ahora + RECUADRO_MS; r.entra = true;
        recuadros = recuadros.filter(function (x) { return x.id !== r.id; });
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
        var n = recuadroDe(t);
        if (n.extra === r.extra && n.elemento === r.elemento) return r;
        // El detalle llegó tarde («trae pendiente»): que se alcance a leer (≥ 4 s más).
        cambio = true; n.hasta = n.extra && n.extra !== r.extra ? Math.max(r.hasta, Date.now() + 4000) : r.hasta; return n;
      });
      if (cambio) pintarRecuadros(doc, recuadros, cerrarRecuadro);
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
      var ms = Math.max(0.5, seg) * 1000;
      clearTimeout(timer); tocaba = Date.now() + ms; tocaRepaso = false;
      if (worker) { try { worker.postMessage(ms); return; } catch (_) { worker = null; } }
      timer = setTimeout(tic, ms);
    }
    /** Qué toca: la relectura tras la señal, el repaso de `llegadas` (cada 30 s, o el que diga el servidor) o la señal.
     *  La señal solo la lee la pestaña que avisa: con dos pestañas en la misma compu (mismo token e IP) no chocan con el
     *  tope de 1.5 s ni duplican lecturas; la otra solo pinta con el repaso. */
    function tic() {
      if (pideFresco) return cargar({ fresco: senalVista || 1 });
      if (!senalSeg || tocaRepaso || Date.now() >= proximoRepaso - 300) return cargar(null);
      if (!lider()) return alRepaso();
      consultarSenal();
    }
    function alRepaso() { programar(Math.max(0.5, (proximoRepaso - Date.now()) / 1000)); tocaRepaso = true; }
    function siguiente() {
      if (pideFresco) return programar(REINTENTO_SEG);
      if (!senalSeg || proximoRepaso - Date.now() <= senalSeg * 1000) return alRepaso();
      programar(senalSeg);
    }
    function consultarSenal() {
      if (cargando) return;
      if (!ls.get(TOKEN_KEY)) { irClave(); return; }
      cargando = true; inicioCarga = Date.now();
      var yaMismo = false;
      api('senal', null, TIEMPO_SENAL_MS)
        .then(function (x) {
          if (x.s === 401 || x.s === 403) { sesionPerdida(); return; }
          if (x.s === 429) { programar((x.j && x.j.espera) || 2); return; }
          if (x.s !== 200 || !x.j || !x.j.ok) throw new Error('senal');
          if (fallasSenal >= 3) red(true, 'Conectado de nuevo');
          fallasSenal = 0;
          var v = typeof x.j.v === 'string' ? x.j.v : null;
          if (v && v !== senalVista) {
            // La primera lectura solo fija la base, salvo que la señal sea de justo antes (o después) de la última lista.
            var nueva = senalVista != null || !(Date.parse(v.split('~')[0]) < ahoraServidor - 5000);
            senalVista = v;
            if (nueva) { pideFresco = true; reintentos = REINTENTOS_SENAL; yaMismo = true; return; }   // «llegadas» YA, no en el siguiente tic
          }
          siguiente();
        })
        .catch(function () {
          fallasSenal++;
          if (fallasSenal >= 3) red(false, 'Sin conexión con Wix · reintentando');
          programar(Math.min(ESPERA_ERROR_SEG, 3 * fallasSenal));
        })
        .then(function () { cargando = false; if (yaMismo) tic(); });
    }
    function cargar(opc) {
      if (cargando) return;
      if (!ls.get(TOKEN_KEY)) { irClave(); return; }
      cargando = true; inicioCarga = Date.now(); clearTimeout(timer);
      // `fresco`: la versión de la señal que se vio (el servidor salta su caché solo si es de antes) o 1 («Actualizar»).
      var fresco = !!(opc && opc.fresco), datos = {};
      if (estado && estado.cursor) datos.desde = estado.cursor;
      if (estado && estado.rezago) datos.rezago = 1;
      if (fresco) datos.fresco = typeof opc.fresco === 'string' ? opc.fresco : 1;
      // La revisión (¿ya se cerró en Wix?) no va en la lectura por la señal: esa es solo para el recuadro.
      if (estado && typeof datos.fresco !== 'string') { var rv = idsRevisar(bloques(estado.tarjetas, ahoraMs())); if (rv.length) datos.revisar = rv; }
      api('llegadas', datos)
        .then(function (x) {
          if (x.s === 401 || x.s === 403) { sesionPerdida(); return; }
          if (x.s === 429) { programar((x.j && x.j.espera) || 2); return; }
          if (x.s !== 200 || !x.j || !x.j.ok) { red(false, 'Sin conexión con Wix · reintento en ' + ESPERA_ERROR_SEG + ' s'); pideFresco = false; programar(ESPERA_ERROR_SEG); return; }
          if (x.j.token) ls.set(TOKEN_KEY, x.j.token);
          var r = combinar(estado, x.j);
          estado = r.estado; ultimaCarga = Date.now(); ahoraServidor = Date.parse(x.j.ahora) || Date.now();
          desfase = Math.abs(ahoraServidor - Date.now()) > 5000 ? ahoraServidor - Date.now() : 0;   // < 5 s: es la red, no el reloj
          var conRecuadro = r.llegaron.filter(function (t) { return vaRecuadro(t, x.j.ahora); });
          if (conRecuadro.length) ponerRecuadros(conRecuadro);
          refrescarRecuadros(estado.tarjetas);
          avisarNuevas(r.nuevas);
          tanda(conRecuadro.map(function (t) { return t.id; }).concat(enSegundoPlano(doc) ? r.nuevas.map(function (t) { return t.id; }) : []));
          pintar(doc, estado, ahoraMs());
          // Tras la señal: si todavía no se ve a nadie nuevo (el ATTENDED de Wix va detrás de la señal), otra vez en 2.1 s.
          if (fresco) { if (!r.cambio && reintentos > 0) { reintentos--; pideFresco = true; } else { pideFresco = false; reintentos = 0; } }
          var s = x.j.sondeo || { activo: true, esperaSeg: 15 };
          senalSeg = s.activo && Number(s.senalSeg) > 0 ? Number(s.senalSeg) : 0;
          proximoRepaso = Date.now() + Math.max(2, Number(s.esperaSeg) || 15) * 1000;
          if (Object.keys(estado.esperan || {}).length) proximoRepaso = Math.min(proximoRepaso, Date.now() + DETALLE_PRONTO_SEG * 1000);
          red(true, 'Actualizado ' + hora(x.j.ahora) + (s.activo ? (senalSeg ? ' · al instante' : '') : ' · sin clases ahora, reviso cada ' + Math.round(s.esperaSeg / 60) + ' min'), !s.activo);
          siguiente();
        })
        .catch(function () { red(false, 'Sin internet · reintento en ' + ESPERA_ERROR_SEG + ' s'); pideFresco = false; programar(ESPERA_ERROR_SEG); })
        .then(function () { cargando = false; });
    }
    // Vigía (cada 30 s): si el sondeo se atrasó (consulta colgada, Worker muerto, compu dormida), se dice y se reintenta.
    setInterval(function () {
      if (!ls.get(TOKEN_KEY) || !tocaba) return;
      if (cargando && Date.now() - inicioCarga > TIEMPO_FETCH_MS + 5000) cargando = false;    // red de seguridad
      if (atrasado(Date.now(), tocaba)) {
        red(false, TEXTOS.atrasada + ' ' + (ultimaCarga ? hora(new Date(ultimaCarga).toISOString()) : 'que se abrió') + ' · reintentando');
        cargar();
      }
    }, 30000);
    // Cuando una clase termina, sus pendientes pasan solos de «Van llegando» a «Se van yendo» (y a los 45 min salen).
    setInterval(function () { if (estado && !$('vistaLista').hidden) pintar(doc, estado, ahoraMs()); }, 15000);

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
    temaDe: temaDe, bloques: bloques, textosLista: textosLista, idsRevisar: idsRevisar, finClase: finClase, pastillasDe: pastillasDe, metaDe: metaDe,
    etiquetaAviso: etiquetaAviso, recuadroDe: recuadroDe, vaRecuadro: vaRecuadro, pintarRecuadros: pintarRecuadros,
    recetaCuenco: recetaCuenco, muestrasCuenco: muestrasCuenco, VOLUMENES: VOLUMENES, CUENCO: CUENCO,
    apiUrl: apiUrl, hora: hora, claseCorta: claseCorta, TEXTOS: TEXTOS, TOKEN_KEY: TOKEN_KEY, TAG_PENDIENTE: TAG_PENDIENTE, TAG_AVISO: TAG_AVISO };
  if (raiz.document && raiz.location && raiz.fetch && !raiz.HeraMostradorSinArranque) {
    if (raiz.document.readyState === 'loading') raiz.document.addEventListener('DOMContentLoaded', function () { arrancar(raiz); });
    else arrancar(raiz);
  }
})(typeof window !== 'undefined' ? window : this);
