/* Pantalla «Mostrador» (docs/MOSTRADOR.md): lista de llegadas para la compu de recepción.
   - Entra con la contraseña del kiosco (acción `entrar` con dispositivo «mostrador»); su token va firmado como «mostrador»
     y se guarda en `hera_mostrador_token` (nunca toca las llaves del kiosco, que vive en el mismo origen).
   - Pregunta `llegadas` cada ~15 s mientras hay clases (el servidor dice cuándo dormir) y al volver a la pestaña.
   - Llegada nueva con la pestaña en segundo plano → notificación del sistema (Notification API). Todo lo que no se ha visto
     desde que la pestaña pasó a segundo plano va en UNA notificación resumida (un aviso nuevo nunca borra uno con pendiente);
     primero quien trae pendiente, luego primera clase. Discreta por omisión: nombre + inicial y «trae pendiente», sin decir
     cuál pendiente (Olmo eligió «con detalle» por omisión el 21-nov); el botón «Avisos» lo cambia a discreto.
   - El reloj del sondeo vive en un Worker (mostrador.worker.js): Chrome frena a 1 por minuto los temporizadores de una
     pestaña oculta más de 5 min, pero no los de un Worker. Si el Worker no carga, setTimeout de siempre.
   - Con dos pestañas abiertas en la misma compu, solo UNA avisa y suena (candado en localStorage); la otra solo pinta.
   - Solo pinta con textContent/createElement (un nombre «<img onerror>» sale como texto). Ningún script de terceros.
   ?dev=1 usa /_functions-dev (el código del Editor, sin publicar). En *.localhost habla con el servidor local. */
(function (raiz) {
  'use strict';
  var ZONA = 'America/Mexico_City';
  var TOKEN_KEY = 'hera_mostrador_token', SONIDO_KEY = 'hera_mostrador_sonido', AVISOS_KEY = 'hera_mostrador_avisos', LIDER_KEY = 'hera_mostrador_lider';
  var RE_FICHA = /^https:\/\/manage\.wix\.com\/dashboard\/[0-9a-f-]{36}\/contacts\/view\/[0-9a-f-]{36}$/i;
  var ELEMENTOS = { FUEGO: 1, AGUA: 1, AIRE: 1, TIERRA: 1 };
  var TOPE_PINTADAS = 40;                      // tarjetas en pantalla; las demás se cuentan abajo
  var MARCA_NUEVA_MS = 90000;                  // cuánto dura el resaltado de una llegada nueva
  var ESPERA_ERROR_SEG = 30;
  var TIEMPO_FETCH_MS = 20000;                 // una consulta colgada (wifi) se corta a los 20 s
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
    if (det && det.pendientes && det.pendientes.length) return detallado ? det.pendientes.map(function (p) { return p.etiqueta; }).join(' · ') : '⚠ trae pendiente';
    if (det && (det.insignias || []).some(function (x) { return x.tipo === 'primera'; })) return '🌱 primera clase';
    if (det && (det.insignias || []).some(function (x) { return x.tipo === 'cumple'; })) return '🎂 cumple hoy';
    return '';
  }
  /** Cuerpo de una llegada sin nada que resaltar: «Sin pendientes» SOLO si de verdad llegó su detalle. */
  function sinNada(t) { return t.detalle ? 'Sin pendientes' : 'Sin detalle todavía · revisa la pantalla'; }

  /** Mezcla una respuesta de `llegadas` con lo que ya hay. Devuelve { estado, nuevas } (nuevas = tarjetas que no se habían
   *  visto; en la PRIMERA carga desde que se abrió la pantalla no hay «nuevas»: no se avisa de lo de toda la mañana).
   *  Una llegada nueva que vino SIN detalle (falló el cálculo en el servidor) espera UN sondeo a que llegue antes de avisar;
   *  si tampoco llega, se avisa igual («Sin detalle todavía»), nunca «Sin pendientes». */
  function combinar(estado, resp) {
    var e = estado || { dia: null, cursor: null, tarjetas: [], vistos: {}, esperan: {}, cargado: false };
    var cambioDia = e.dia !== resp.dia;
    var previas = {}, vistos = cambioDia ? {} : e.vistos, esperan = cambioDia ? {} : (e.esperan || {}), siguen = {}, i;
    if (!cambioDia) for (i = 0; i < e.tarjetas.length; i++) previas[e.tarjetas[i].id] = e.tarjetas[i];
    var tarjetas = [], nuevas = [];
    var ls = Array.isArray(resp.llegadas) ? resp.llegadas : [];
    for (i = 0; i < ls.length; i++) {
      var l = ls[i], p = previas[l.id], t = {};
      for (var k in l) if (Object.prototype.hasOwnProperty.call(l, k)) t[k] = l[k];
      if (t.detalle === undefined) t.detalle = p ? p.detalle : undefined;   // el servidor solo manda el detalle de las nuevas
      t.prioridad = prioridadDe(t.detalle);
      t.desde = p ? p.desde : Date.now();
      t.nueva = p ? !!p.nueva : false;
      var primeraVez = !vistos[l.id];
      if (primeraVez) vistos[l.id] = 1;
      if (e.cargado && (primeraVez || esperan[l.id])) {
        if (primeraVez && t.detalle === undefined) siguen[l.id] = 1;          // un sondeo más por su detalle
        else nuevas.push(t);
      }
      tarjetas.push(t);
    }
    nuevas.sort(function (a, b) { return a.prioridad - b.prioridad; });
    return { estado: { dia: resp.dia, cursor: resp.cursor || (cambioDia ? null : e.cursor), tarjetas: tarjetas, vistos: vistos, esperan: siguen, cargado: true,
      proximas: Array.isArray(resp.proximas) ? resp.proximas : [], horas: resp.horas !== false,
      total: Number(resp.total) > tarjetas.length ? Number(resp.total) : tarjetas.length, rezago: Number(resp.rezagoPanel) > 0 }, nuevas: nuevas };
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

  function tarjeta(doc, t, ahoraMs) {
    var det = t.detalle || null;
    var li = el(doc, 'li', 'tarjeta');
    if (t.prioridad === 1) li.className += ' con-pendiente';
    else if (t.prioridad === 2) li.className += ' primera';
    if (ahoraMs - (t.desde || 0) < MARCA_NUEVA_MS && t.nueva) li.className += ' nueva';
    var circ = el(doc, 'div', 'circulo', t.iniciales || '?');
    if (t.market) circ.className += ' market';
    else if (det && ELEMENTOS[det.elemento]) circ.className += ' ' + det.elemento;
    circ.setAttribute('aria-hidden', 'true');
    li.appendChild(circ);
    li.appendChild(nombreNodo(doc, String(t.nombre || 'Alumna') + (t.lugares >= 2 ? ' (' + t.lugares + ' lugares)' : ''), det && det.ficha, 'nombre'));
    var h = el(doc, 'div', 'hora');
    h.appendChild(el(doc, 'b', null, t.hora ? hora(t.hora) : '—'));
    h.appendChild(doc.createTextNode(t.origen === 'panel' ? 'panel de Wix · aprox.' : t.origen === 'panel-tarde' ? 'panel de Wix · hora desconocida' : t.origen === 'tablet' ? 'tablet' : ''));
    li.appendChild(h);
    var c = el(doc, 'p', 'clase');
    c.appendChild(el(doc, 'b', null, String((t.clase && t.clase.disciplina) || 'Clase') + ' ' + hora(t.clase && t.clase.inicio)));
    if (t.clase && t.clase.coach) c.appendChild(doc.createTextNode(' · con ' + t.clase.coach));
    li.appendChild(c);
    var d = el(doc, 'div', 'detalle');
    if (det) {
      if (det.insignias && det.insignias.length) {
        var ins = el(doc, 'div', 'insignias');
        det.insignias.forEach(function (x) { ins.appendChild(el(doc, 'span', 'insignia ' + String(x.tipo || '').replace(/[^a-z]/g, ''), x.texto)); });
        d.appendChild(ins);
      }
      var plan = el(doc, 'p', 'plan');
      plan.appendChild(el(doc, 'b', null, String(det.plan || 'sin plan')));
      if (det.saldo) plan.appendChild(doc.createTextNode(' · ' + String(det.saldo)));
      d.appendChild(plan);
      if (det.pendientes && det.pendientes.length) {
        d.appendChild(el(doc, 'p', 'al-llegar', 'Pendiente al llegar (si ya se resolvió, ignóralo):'));
        var ul = el(doc, 'ul', 'pendientes');
        det.pendientes.forEach(function (p) { ul.appendChild(el(doc, 'li', null, p.texto || p.etiqueta)); });
        d.appendChild(ul);
      }
      if (det.avisos && det.avisos.length) {
        var av = el(doc, 'ul', 'avisos');
        det.avisos.forEach(function (x) { av.appendChild(el(doc, 'li', null, x)); });
        d.appendChild(av);
      }
    } else d.appendChild(el(doc, 'p', 'plan', 'Sin detalle (llegó antes de abrir esta pantalla, o no se pudo leer).'));
    li.appendChild(d);
    return li;
  }

  function pintar(doc, estado, ahoraMs) {
    var ts = (estado && estado.tarjetas) || [], ul = doc.getElementById('llegadas');
    vaciar(ul);
    for (var i = 0; i < ts.length && i < TOPE_PINTADAS; i++) ul.appendChild(tarjeta(doc, ts[i], ahoraMs || Date.now()));
    var conP = ts.filter(function (t) { return t.prioridad === 1; }).length, total = Math.max(ts.length, (estado && estado.total) || 0);
    doc.getElementById('conteo').textContent = total ? (total === 1 ? '1 hoy' : total + ' hoy') + (conP ? ' · ' + conP + ' con pendiente' : '') : '';
    var vacio = doc.getElementById('vacio');
    vacio.textContent = ts.length ? (estado.horas ? '' : TEXTOS.sinHoras) : TEXTOS.vacio;
    vacio.hidden = !!ts.length && !!estado.horas;
    var mas = doc.getElementById('mas');
    mas.textContent = total > TOPE_PINTADAS ? 'y ' + (total - Math.min(ts.length, TOPE_PINTADAS)) + ' más temprano' : '';
    mas.hidden = total <= TOPE_PINTADAS;
    pintarProximas(doc, (estado && estado.proximas) || []);
  }

  function pintarProximas(doc, ps) {
    var cont = doc.getElementById('proximas');
    vaciar(cont);
    doc.getElementById('sinProximas').hidden = !!ps.length;
    ps.forEach(function (p) {
      var s = el(doc, 'section', 'proxima');
      var h = el(doc, 'h3', null, String(p.disciplina || 'Clase') + ' ' + hora(p.inicio) + (p.coach ? ' · ' + p.coach : ''));
      h.appendChild(el(doc, 'span', null, (p.llegaron || 0) + ' de ' + (p.lugares || 0) + (p.empezo ? ' · ya empezó' : '')));
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

  // ------------------------------------------------------------------ sonido suave (Web Audio: dos notas cortas, sin archivos)
  function crearSonido(win) {
    var ctx = null;
    return {
      preparar: function () {               // se llama desde un clic (los navegadores exigen un gesto para el audio)
        try { var A = win.AudioContext || win.webkitAudioContext; if (A && !ctx) ctx = new A(); if (ctx && ctx.state === 'suspended') ctx.resume(); } catch (_) {}
      },
      tocar: function (urgente) {
        if (!ctx) return;
        try {
          var t0 = ctx.currentTime;
          (urgente ? [660, 880] : [587]).forEach(function (f, i) {
            var o = ctx.createOscillator(), g = ctx.createGain(), t = t0 + i * 0.18;
            o.type = 'sine'; o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
            o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.55);
          });
        } catch (_) {}
      }
    };
  }

  // ------------------------------------------------------------------ arranque
  function arrancar(win) {
    var doc = win.document, url = apiUrl(win.location), ls = almacen(win), sonido = crearSonido(win);
    var estado = null, timer = null, cargando = false, inicioCarga = 0, ultimaCarga = 0, tocaba = 0, tituloBase = doc.title;
    var sinVer = [], alerta = '', avisoSesion = false, worker = null;
    var miId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var $ = function (id) { return doc.getElementById(id); };
    var Notif = win.Notification;

    function api(accion, datos) {
      var cuerpo = { accion: accion };
      if (accion !== 'entrar') cuerpo.token = ls.get(TOKEN_KEY);
      for (var k in datos || {}) cuerpo[k] = datos[k];
      var ctl = null;
      try { ctl = typeof win.AbortController === 'function' ? new win.AbortController() : null; } catch (_) { ctl = null; }
      // text/plain: petición «simple» entre dominios, sin preflight (igual que el kiosco).
      var p = win.fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(cuerpo),
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined })
        .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { s: r.status, j: j }; }); });
      return conTiempo(p, TIEMPO_FETCH_MS, function () { if (ctl) ctl.abort(); }, win);
    }
    function ponerTitulo() { doc.title = tituloDe(tituloBase, sinVer.length, alerta); }
    function red(ok, txt, dormido) {
      $('punto').className = 'punto' + (ok ? (dormido ? ' dormido' : '') : ' off');
      $('estadoTxt').textContent = txt;
      alerta = ok ? '' : 'Sin conexión'; ponerTitulo();
    }
    function irClave(msg) {
      clearTimeout(timer); if (worker) worker.postMessage(0); tocaba = 0; estado = null;
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
    function sonidoUi() {
      var on = ls.get(SONIDO_KEY) === '1', b = $('sonido');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.textContent = 'Sonido: ' + (on ? 'encendido' : 'apagado');
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
        var x = new Notif(n.titulo, { body: n.cuerpo, tag: n.tag || TAG_AVISO, renotify: true, requireInteraction: !!n.fija, silent: ls.get(SONIDO_KEY) === '1',
          icon: 'https://static.wixstatic.com/media/9d6afa_e930e021d3564d24bc04bdc3e4c172f3~mv2.png/v1/fill/w_192,h_192/favicon.png' });
        x.onclick = function () { try { win.focus(); } catch (_) {} x.close(); };
      } catch (_) {}
    }
    function avisarNuevas(nuevas) {
      if (!nuevas.length) return;
      nuevas.forEach(function (t) { t.nueva = true; });
      var avisa = lider();
      if (!enSegundoPlano(doc)) { if (avisa && ls.get(SONIDO_KEY) === '1') sonido.tocar(resumenNotificacion(nuevas).urgente); return; }
      sinVer = acumular(sinVer, nuevas);
      ponerTitulo();
      if (!avisa) return;
      var n = resumenNotificacion(sinVer, { detallado: detallado() });
      if (ls.get(SONIDO_KEY) === '1') sonido.tocar(n && n.urgente);
      notificar(n);
    }
    function sesionPerdida() {
      ls.del(TOKEN_KEY); alerta = 'Contraseña'; ponerTitulo();
      if (!avisoSesion && enSegundoPlano(doc)) { avisoSesion = true; notificar({ titulo: 'Mostrador: pide la contraseña otra vez', cuerpo: 'Ya no se están viendo las llegadas.', tag: TAG_AVISO }); }
      irClave(TEXTOS.otraVez); doc.title = tituloDe(tituloBase, 0, alerta);
    }

    // Reloj del sondeo: en el Worker (no lo frena la pestaña oculta) o, si no carga, setTimeout.
    try {
      if (typeof win.Worker === 'function') {
        worker = new win.Worker('mostrador.worker.js');
        worker.onmessage = function () { cargar(); };
        worker.onerror = function () { worker = null; if (tocaba) programar(Math.max(5, (tocaba - Date.now()) / 1000)); };
      }
    } catch (_) { worker = null; }
    function programar(seg) {
      var ms = Math.max(5, seg) * 1000;
      clearTimeout(timer); tocaba = Date.now() + ms;
      if (worker) { try { worker.postMessage(ms); return; } catch (_) { worker = null; } }
      timer = setTimeout(cargar, ms);
    }
    function cargar() {
      if (cargando) return;
      if (!ls.get(TOKEN_KEY)) { irClave(); return; }
      cargando = true; inicioCarga = Date.now(); clearTimeout(timer);
      var datos = {};
      if (estado && estado.cursor) datos.desde = estado.cursor;
      if (estado && estado.rezago) datos.rezago = 1;
      api('llegadas', datos)
        .then(function (x) {
          if (x.s === 401 || x.s === 403) { sesionPerdida(); return; }
          if (x.s === 429) { programar((x.j && x.j.espera) || 5); return; }
          if (x.s !== 200 || !x.j || !x.j.ok) { red(false, 'Sin conexión con Wix · reintento en ' + ESPERA_ERROR_SEG + ' s'); programar(ESPERA_ERROR_SEG); return; }
          if (x.j.token) ls.set(TOKEN_KEY, x.j.token);
          var r = combinar(estado, x.j);
          estado = r.estado; ultimaCarga = Date.now();
          avisarNuevas(r.nuevas);
          pintar(doc, estado, Date.now());
          var s = x.j.sondeo || { activo: true, esperaSeg: 15 };
          red(true, 'Actualizado ' + hora(x.j.ahora) + (s.activo ? '' : ' · sin clases ahora, reviso cada ' + Math.round(s.esperaSeg / 60) + ' min'), !s.activo);
          programar(s.esperaSeg || 15);
        })
        .catch(function () { red(false, 'Sin internet · reintento en ' + ESPERA_ERROR_SEG + ' s'); programar(ESPERA_ERROR_SEG); })
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
      if (ls.get(SONIDO_KEY) === '1') sonido.tocar(true);
    });
    $('sonido').addEventListener('click', function () {
      var on = ls.get(SONIDO_KEY) !== '1';
      if (on) { ls.set(SONIDO_KEY, '1'); sonido.preparar(); sonido.tocar(false); } else ls.del(SONIDO_KEY);
      sonidoUi();
    });
    if ($('avisos')) $('avisos').addEventListener('click', function () {
      if (detallado()) ls.set(AVISOS_KEY, 'discreto'); else ls.del(AVISOS_KEY);
      avisosUi();
    });
    $('actualizar').addEventListener('click', function () { sonido.preparar(); cargar(); });
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
    // Primer gesto en la página: deja listo el audio (si el sonido está encendido).
    doc.addEventListener('click', function () { if (ls.get(SONIDO_KEY) === '1') sonido.preparar(); }, { once: true });

    if (ls.get(TOKEN_KEY)) { irLista(); cargar(); } else irClave('');
  }

  raiz.HeraMostrador = { combinar: combinar, resumenNotificacion: resumenNotificacion, acumular: acumular, nombreCorto: nombreCorto,
    soyLider: soyLider, atrasado: atrasado, tituloDe: tituloDe, conTiempo: conTiempo, pintar: pintar, enSegundoPlano: enSegundoPlano,
    apiUrl: apiUrl, hora: hora, claseCorta: claseCorta, TEXTOS: TEXTOS, TOKEN_KEY: TOKEN_KEY, TAG_PENDIENTE: TAG_PENDIENTE, TAG_AVISO: TAG_AVISO };
  if (raiz.document && raiz.location && raiz.fetch && !raiz.HeraMostradorSinArranque) {
    if (raiz.document.readyState === 'loading') raiz.document.addEventListener('DOMContentLoaded', function () { arrancar(raiz); });
    else arrancar(raiz);
  }
})(typeof window !== 'undefined' ? window : this);
