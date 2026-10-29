const router = require('express').Router();
const { ah, HttpError, auth } = require('../middleware');
const { huellaValida, generarHuella } = require('../dispositivos');
const { tokenValido, guardarToken, quitarToken, pushActivo } = require('../push');

// El token se asocia al dispositivo con el que se inició sesión (cabecera X-Device-Fingerprint).
function exigirHuella(req) {
  if (!huellaValida(req)) throw new HttpError(400, 'Falta una huella de dispositivo válida.');
  return generarHuella(req);
}

// POST /api/notificaciones/token  { token }  -> guarda el token FCM de este dispositivo
router.post('/token', auth, ah(async (req, res) => {
  const huella = exigirHuella(req);
  const { token } = req.body || {};
  if (!tokenValido(token)) throw new HttpError(400, 'Token de notificaciones inválido.');
  const ok = await guardarToken(req.user.id, huella, token);
  if (!ok) throw new HttpError(404, 'Dispositivo no registrado o bloqueado. Inicia sesión de nuevo.');
  res.json({ ok: true, activo: pushActivo() });
}));

// DELETE /api/notificaciones/token  -> deja de enviar notificaciones a este dispositivo (cerrar sesión)
router.delete('/token', auth, ah(async (req, res) => {
  const huella = exigirHuella(req);
  await quitarToken(req.user.id, huella);
  res.json({ ok: true });
}));

module.exports = router;
