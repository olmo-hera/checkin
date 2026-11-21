/* Reloj del sondeo de la pantalla Mostrador (web/mostrador.js). Chrome frena a 1 por minuto los temporizadores de una
   pestaña oculta más de 5 min («intensive throttling»), pero no los de un Worker dedicado. La página le manda cuántos ms
   esperar (0 = cancelar) y el Worker le contesta «tick» cuando toca. No lee ni guarda nada. */
(function (yo) {
  'use strict';
  var h = null;
  yo.onmessage = function (e) {
    if (h) { clearTimeout(h); h = null; }
    var ms = Number(e && e.data);
    if (Number.isFinite(ms) && ms > 0) h = setTimeout(function () { h = null; yo.postMessage('tick'); }, Math.min(ms, 3600000));
  };
})(self);
