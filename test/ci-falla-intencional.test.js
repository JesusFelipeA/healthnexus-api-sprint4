// Prueba fallida a propósito para validar que el pipeline bloquea cambios rotos (CP-SIT-23).
// NO fusionar: el pull request se cierra y la rama se borra al terminar la prueba.
const test = require('node:test');
const assert = require('node:assert/strict');

test('CP-SIT-23: el pipeline detecta una prueba fallida', () => {
  assert.equal(1 + 2, 2, 'Falla intencional para validar el pipeline (CP-SIT-23)');
});
