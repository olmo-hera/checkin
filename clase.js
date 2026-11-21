/* «Ver clase» (F4 de docs/CONTROL_RECEPCION.md): pinta la lista de UNA clase que regresa la acción `verClase` del API.
   Reglas (seguridad M5, comparte origen con el kiosco):
   - Solo pinta con textContent y createElement: nunca mete HTML (un nombre como «img onerror=…» sale como texto).
     scripts/empaquetar.mjs se niega a copiar este archivo si aparece alguna API que pinte HTML o toque el almacenamiento.
   - No lee ni escribe el almacenamiento del navegador ni cookies (ahí vive el token del kiosco). Ningún script de terceros.
   - El sello viaja en el #fragmento (#v=…): no llega a GitHub Pages, ni al Referer, ni al desenrollado de Slack.
   ?dev=1 usa /_functions-dev (el código del Editor, sin publicar). En *.localhost habla con el servidor local. */
(function (raiz) {
  'use strict';
  var ZONA = 'America/Mexico_City';
  var RE_SELLO = /^[A-Za-z0-9_-]{8,40}\.[A-Za-z0-9_-]{8,1800}\.[A-Za-z0-9_-]{16,40}$/;
  var RE_FICHA = /^https:\/\/manage\.wix\.com\/dashboard\/[0-9a-f-]{36}\/contacts\/view\/[0-9a-f-]{36}$/i;
  var TEXTOS = {
    vencida: 'Esta liga ya venció. Abre la del aviso más reciente en #recepcion.',
    demasiadas: 'Esta liga ya se abrió muchas veces. Abre la del aviso más reciente en #recepcion, o revisa la clase en Wix o en la tablet.',
    despacio: 'Demasiadas consultas seguidas. Espera unos minutos y toca «Actualizar».',
    sinClase: 'Esta clase ya no tiene reservas confirmadas (¿se canceló?).',
    error: 'No se pudo cargar la lista. Revisa la conexión y toca «Actualizar».',
    sinTope: 'No se pudo revisar la liga en este momento. Usa Wix o la tablet y vuelve a tocar «Actualizar» en unos minutos.',
    vacia: 'Nadie reservó esta clase.'
  };

  /** Sello del #fragmento (#v=…), o null si falta o no tiene forma de sello. */
  function leerSello(hash) {
    var m = /(?:^#|&)v=([^&]+)/.exec(String(hash || ''));
    var v = m ? m[1] : '';
    return RE_SELLO.test(v) ? v : null;
  }
  function apiUrl(loc) {
    var host = (loc && loc.hostname) || '';
    if (/\.localhost$/.test(host)) return '/_functions/checkinApi';
    var dev = /[?&]dev(=|&|$)/.test((loc && loc.search) || '');
    return 'https://www.herazenter.com/' + (dev ? '_functions-dev' : '_functions') + '/checkinApi';
  }
  function hora(iso, h12) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    try { return d.toLocaleTimeString('es-MX', { timeZone: ZONA, hour: 'numeric', minute: '2-digit', hour12: h12 !== false }); }
    catch (_) { return d.toISOString().slice(11, 16); }
  }
  function dia(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    try { return d.toLocaleDateString('es-MX', { timeZone: ZONA, weekday: 'short', day: 'numeric', month: 'short' }); }
    catch (_) { return ''; }
  }
  function el(doc, tag, cls, texto) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (texto != null) e.textContent = String(texto);
    return e;
  }
  function vaciar(nodo) { while (nodo.firstChild) nodo.removeChild(nodo.firstChild); }
  var CLASE_ESTADO = { 'llegó': 'estado llego', 'no llegó': 'estado falto' };

  /** Una tarjeta por alumna (o por marketplace). Todo texto entra con textContent. */
  function tarjeta(doc, a) {
    var li = el(doc, 'li', 'alumna'), f1 = el(doc, 'div', 'fila1');
    var nombre = String(a.nombre || 'Alumna');
    var n;
    if (a.ficha && RE_FICHA.test(String(a.ficha))) {
      n = el(doc, 'a', 'nombre', nombre);
      n.href = String(a.ficha); n.target = '_blank'; n.rel = 'noopener noreferrer';
    } else n = el(doc, 'span', 'nombre', nombre);
    f1.appendChild(n);
    var lug = Number(a.lugares) || 1;               // dobles: la misma persona con 2+ lugares (el marketplace ya dice ×N)
    if (lug >= 2 && !a.market) f1.appendChild(el(doc, 'span', 'lugares', '· ' + lug + ' lugares'));
    var est = String(a.estado || 'reservada');
    f1.appendChild(el(doc, 'span', CLASE_ESTADO[est] || 'estado', est));
    li.appendChild(f1);
    var plan = el(doc, 'p', 'plan');
    plan.appendChild(el(doc, 'b', null, String(a.plan || 'sin plan')));
    if (a.saldo) plan.appendChild(doc.createTextNode(' · ' + String(a.saldo)));
    li.appendChild(plan);
    var ps = Array.isArray(a.pendientes) ? a.pendientes : [];
    if (ps.length) {
      var ul = el(doc, 'ul', 'pendientes');
      for (var i = 0; i < ps.length; i++) ul.appendChild(el(doc, 'li', null, String(ps[i])));
      li.appendChild(ul);
    }
    return li;
  }

  /** Pinta la respuesta del API en el documento (sin red: así se prueba en Node con un DOM falso). */
  function pintar(doc, datos) {
    var c = (datos && datos.clase) || {};
    var lista = Array.isArray(datos && datos.lista) ? datos.lista : [];
    doc.getElementById('titulo').textContent = (c.disciplina || 'Clase') + ' · ' + hora(c.inicio);
    doc.getElementById('sub').textContent = [dia(c.inicio), c.coach ? 'con ' + c.coach : ''].filter(Boolean).join(' · ');
    doc.getElementById('sello').textContent = datos && datos.actualizado ? 'actualizado ' + hora(datos.actualizado, false) : '';
    var ul = doc.getElementById('lista');
    vaciar(ul);
    for (var i = 0; i < lista.length; i++) ul.appendChild(tarjeta(doc, lista[i]));
    var conPend = lista.filter(function (a) { return a && Array.isArray(a.pendientes) && a.pendientes.length; }).length;
    // El total va en LUGARES, como en Wix (dobles y marketplace cuentan cada lugar); «en la lista» solo si no coincide.
    var lugares = 0;
    for (var j = 0; j < lista.length; j++) lugares += Math.max(1, Number(lista[j] && lista[j].lugares) || 1);
    var conteo = doc.getElementById('conteo');
    conteo.textContent = lista.length ? (lugares === 1 ? '1 lugar' : lugares + ' lugares') + (lugares !== lista.length ? ' · ' + lista.length + ' en la lista' : '') +
      (conPend ? ' · ' + conPend + ' con algo por resolver' : '') : '';
    conteo.hidden = !lista.length;
    mensaje(doc, lista.length ? null : TEXTOS.vacia);
  }
  function mensaje(doc, texto) {
    var a = doc.getElementById('aviso');
    a.textContent = texto || '';
    a.hidden = !texto;
  }
  /** Texto para un error del API (status + cuerpo). */
  function textoError(status, cuerpo) {
    var e = cuerpo && cuerpo.error;
    if (status === 401 || e === 'liga-vencida') return TEXTOS.vencida;
    if (status === 429) return e === 'despacio' ? TEXTOS.despacio : TEXTOS.demasiadas;
    if (status === 404) return TEXTOS.sinClase;
    if (status === 503 && e === 'sin-tope') return TEXTOS.sinTope;
    return TEXTOS.error;
  }

  function arrancar(win) {
    var doc = win.document, sello = leerSello(win.location.hash), url = apiUrl(win.location);
    var boton = doc.getElementById('actualizar');
    var vencida = function (t) {                    // sin datos viejos en pantalla: ni la clase ni la lista anterior
      mensaje(doc, t); vaciar(doc.getElementById('lista')); doc.getElementById('conteo').hidden = true;
      doc.getElementById('titulo').textContent = 'Ver clase'; doc.getElementById('sub').textContent = ''; doc.getElementById('sello').textContent = '';
    };
    if (!sello) { boton.hidden = true; vencida(TEXTOS.vencida); return; }
    var cargando = false;
    function cargar() {
      if (cargando) return;
      cargando = true; boton.disabled = true;
      win.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: 'verClase', v: sello }),
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
        .then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (x) {
          if (x.s === 200 && x.j && x.j.ok) pintar(doc, x.j);
          else { var t = textoError(x.s, x.j); vencida(t); if (t === TEXTOS.vencida || t === TEXTOS.demasiadas) boton.hidden = true; }
        })
        .catch(function () { mensaje(doc, TEXTOS.error); })
        .then(function () { cargando = false; boton.disabled = false; });
    }
    boton.addEventListener('click', cargar);
    win.addEventListener('hashchange', function () { sello = leerSello(win.location.hash); if (sello) { boton.hidden = false; cargar(); } else vencida(TEXTOS.vencida); });
    cargar();
  }

  raiz.HeraClase = { pintar: pintar, leerSello: leerSello, apiUrl: apiUrl, textoError: textoError, TEXTOS: TEXTOS };
  if (raiz.document && raiz.location && raiz.fetch && !raiz.HeraClaseSinArranque) {
    if (raiz.document.readyState === 'loading') raiz.document.addEventListener('DOMContentLoaded', function () { arrancar(raiz); });
    else arrancar(raiz);
  }
})(typeof window !== 'undefined' ? window : this);
