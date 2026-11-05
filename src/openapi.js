// Especificación OpenAPI 3.0 de la API de HealthNexus. La sirve Swagger UI en /api/docs (src/docs.js).
// Mantenla al día con las rutas: test/openapi.test.js falla si una ruta de Express no está documentada
// aquí o si aquí hay una ruta que ya no existe.
const { version } = require('../package.json');

const NIVELES = ['rojo', 'naranja', 'amarillo', 'verde', 'azul'];

// ---------- ayudantes ----------
const ref = (nombre) => ({ $ref: `#/components/schemas/${nombre}` });
const resp = (nombre) => ({ $ref: `#/components/responses/${nombre}` });
const json = (schema, ejemplo) => ({ content: { 'application/json': { schema, ...(ejemplo ? { example: ejemplo } : {}) } } });
const ok = (descripcion, schema, ejemplo, extra = {}) => ({ description: descripcion, ...json(schema, ejemplo), ...extra });
const lista = (schema) => ({ type: 'array', items: schema });
const obj = (props, requeridos) => ({ type: 'object', properties: props, ...(requeridos ? { required: requeridos } : {}) });
const s = (type, extra = {}) => ({ type, ...extra });
const str = (extra) => s('string', extra);
const int = (extra) => s('integer', extra);
const num = (extra) => s('number', extra);
const bool = (extra) => s('boolean', extra);
const q = (name, schema, description, required = false) => ({ in: 'query', name, schema, description, required });
const idPath = (name = 'id', description = 'Identificador numérico') => ({ in: 'path', name, required: true, schema: int({ minimum: 1 }), description });
const PAGINA = [q('page', int({ minimum: 1, default: 1 }), 'Página (empieza en 1)'), q('limit', int({ minimum: 1 }), 'Registros por página')];
const TOTAL_HEADER = { 'X-Total-Count': { description: 'Total de registros sin paginar', schema: int() } };
const paginado = (item) => obj({ total: int(), page: int(), limit: int(), data: lista(item) });

const ROL_TXT = {
  todos: 'Cualquier usuario con sesión.',
  admin: 'Solo **administrador**.',
};
// Construye una operación. `roles`: lista de roles permitidos (el administrador siempre pasa) o 'todos'/'admin'.
function op({ tag, resumen, desc = '', roles, publico = false, huella = false, params, body, ok: respuestas, errores = [] }) {
  const quien = publico ? 'Pública (sin token).'
    : roles === 'todos' ? ROL_TXT.todos
      : roles === 'admin' ? ROL_TXT.admin
        : `Roles: **${roles.join(', ')}** y administrador.`;
  const security = [];
  if (!publico) security.push(huella ? { bearerAuth: [], huellaDispositivo: [] } : { bearerAuth: [] });
  else if (huella) security.push({ huellaDispositivo: [] });
  const r = { ...respuestas };
  if (!publico) { r[401] = resp('NoAutenticado'); if (roles !== 'todos') r[403] = resp('SinPermiso'); }
  for (const e of errores) r[e] = resp({ 400: 'Invalido', 404: 'NoEncontrado', 409: 'Conflicto', 429: 'DemasiadasPeticiones' }[e]);
  return {
    tags: [tag], summary: resumen, description: `${desc}${desc ? '\n\n' : ''}${quien}`,
    security, ...(params ? { parameters: params } : {}),
    ...(body ? { requestBody: { required: true, ...json(body.schema, body.ejemplo) } } : {}),
    responses: r,
  };
}

// ---------- esquemas ----------
const schemas = {
  Error: obj({ error: str({ example: 'Mensaje para el usuario' }), code: str({ description: 'Código fijo para errores que la app trata distinto', example: 'SESION_REVOCADA' }) }, ['error']),
  Usuario: obj({ id: int(), nombre: str(), email: str({ format: 'email' }), rol: str({ enum: ['administrador', 'medico', 'enfermeria', 'farmacia', 'sin_rol'] }) }),
  Sesion: obj({ token: str({ description: 'JWT de acceso (8 h). Úsalo como `Authorization: Bearer <token>`' }), user: ref('Usuario') }),
  PasoPin: obj({ requierePin: bool({ example: true }), pinToken: str({ description: 'Token temporal (5 min) que solo sirve para `POST /api/auth/pin`' }) }),
  NivelTriage: str({ enum: NIVELES, description: 'Escala de Manchester: rojo = I, naranja = II, amarillo = III, verde = IV, azul = V' }),
  PacienteResumen: obj({
    id: int(), name: str({ example: 'Laura Méndez Ortega' }), age: int({ example: 52 }), sexo: str({ enum: ['hombre', 'mujer', 'otro'] }),
    curp: str({ nullable: true }), telefono: str({ nullable: true }), triageLevel: { ...ref('NivelTriage'), nullable: true },
  }),
  Paciente: obj({
    id: int(), nombre: str(), apellidoPaterno: str(), apellidoMaterno: str({ nullable: true }), fechaNacimiento: str({ format: 'date' }), edad: int(),
    sexo: str(), estadoCivil: str({ nullable: true }), nacionalidad: str(), paisNacimiento: str({ nullable: true }), estadoNacimiento: str({ nullable: true }),
    curp: str({ nullable: true }), pasaporte: str({ nullable: true }), telefonoPrincipal: str({ nullable: true }), correoElectronico: str({ nullable: true }),
    ocupacion: str({ nullable: true }), responsableNombre: str({ nullable: true }), tipoSanguineo: str({ nullable: true }),
    alergias: str({ nullable: true }), enfermedadesCronicas: str({ nullable: true }), estadoId: int({ nullable: true }), estado: str({ nullable: true }),
    municipioId: int({ nullable: true }), municipio: str({ nullable: true }), colonia: str({ nullable: true }), calle: str({ nullable: true }),
    numeroExterior: str({ nullable: true }), numeroInterior: str({ nullable: true }), activo: int(), creadoEn: str({ format: 'date-time' }),
  }),
  PacienteNuevo: obj({
    nombre: str({ maxLength: 255 }), apellidoPaterno: str({ maxLength: 255 }), apellidoMaterno: str(),
    fechaNacimiento: str({ format: 'date', description: 'AAAA-MM-DD, entre 1900 y hoy' }), sexo: str({ enum: ['hombre', 'mujer', 'otro'] }),
    estadoCivil: str({ enum: ['Soltero', 'Casado', 'Divorciado', 'Unión Libre', 'Viudo'] }), nacionalidad: str({ enum: ['MEXICANA', 'EXTRANJERA'], default: 'MEXICANA' }),
    paisNacimiento: str({ description: 'Obligatorio si es EXTRANJERA' }), pasaporte: str({ maxLength: 30, description: 'Obligatorio si es EXTRANJERA' }),
    estadoNacimiento: str({ description: 'Solo MEXICANA; debe existir en el catálogo' }), curp: str({ pattern: '^[A-Z]{4}\\d{6}[HMX][A-Z]{2}[B-DF-HJ-NP-TV-Z]{3}[A-Z0-9]\\d$' }),
    telefonoPrincipal: str({ description: '10 dígitos (MEXICANA) o 7 a 15 (EXTRANJERA)' }), correoElectronico: str({ format: 'email' }), ocupacion: str(),
    responsableNombre: str({ description: 'Obligatorio para menores de 18 años' }), tipoSanguineo: str({ enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] }),
    alergias: str({ maxLength: 2000 }), enfermedadesCronicas: str({ maxLength: 2000 }), estadoId: int(), municipioId: int({ description: 'Debe pertenecer a estadoId' }),
    colonia: str(), calle: str(), numeroExterior: str({ maxLength: 30 }), numeroInterior: str({ maxLength: 30 }),
  }, ['nombre', 'apellidoPaterno', 'fechaNacimiento', 'sexo']),
  TriagePaciente: obj({
    id: int(), name: str(), age: int(), sexo: str(), admisionId: int({ nullable: true }), triageLevel: { ...ref('NivelTriage'), nullable: true },
    status: str({ nullable: true, enum: ['en_espera', 'atendido', 'hospitalizado'] }), arrivedAt: str({ nullable: true }),
    reason: str({ nullable: true, description: 'Motivo de consulta' }), diagnosticoPresuntivo: str({ nullable: true }),
  }),
  Emergencia: obj({
    id: int(), mensaje: str(), estado: str({ enum: ['activa', 'vista'] }), creada: str({ example: '2026-10-30 22:57:10' }),
    activadaPor: str({ nullable: true }), activadaPorId: int({ nullable: true }), ubicacion: { ...ref('Ubicacion'), nullable: true },
  }),
  Ubicacion: obj({ lat: num({ minimum: -90, maximum: 90, example: 19.2826 }), lng: num({ minimum: -180, maximum: 180, example: -99.6557 }) }, ['lat', 'lng']),
  Signos: obj({
    id: int(), pacienteId: int(), paciente: str(), temperatura: num({ nullable: true }), fc: int({ nullable: true }), fr: int({ nullable: true }),
    presion: str({ nullable: true, example: '120/80' }), spo2: int({ nullable: true }), glucosa: int({ nullable: true }), peso: num({ nullable: true }),
    talla: num({ nullable: true }), dolor: int({ nullable: true }), triage: str({ nullable: true }), motivo: str({ nullable: true }),
    notas: str({ nullable: true }), registradoPor: str({ nullable: true }), fecha: str({ format: 'date-time' }),
  }),
  SignosNuevos: obj({
    pacienteId: int(), temperatura: num({ minimum: 25, maximum: 45 }), frecuenciaCardiaca: int({ minimum: 10, maximum: 300 }),
    frecuenciaRespiratoria: int({ minimum: 3, maximum: 100 }), saturacionOxigeno: int({ minimum: 30, maximum: 100 }), glucosa: int({ minimum: 10, maximum: 1500 }),
    peso: num({ minimum: 0.3, maximum: 500 }), talla: num({ minimum: 0.2, maximum: 2.6 }), escalaDolor: int({ minimum: 0, maximum: 10 }),
    presionArterial: str({ pattern: '^\\d{2,3}/\\d{2,3}$', example: '120/80' }), triage: ref('NivelTriage'), motivoConsulta: str(), notas: str(),
  }, ['pacienteId']),
  Administracion: obj({
    id: int(), pacienteId: int(), paciente: str(), medicamento: str(), dosis: str(), via: str(), fecha: str({ format: 'date-time' }),
    reaccionAdversa: int({ enum: [0, 1] }), observaciones: str({ nullable: true }), administradoPor: str({ nullable: true }),
  }),
  Medicamento: obj({
    id: int(), nombre: str(), sustancia: str(), presentacion: str(), concentracion: str(), grupo: str({ nullable: true }),
    controlado: int(), antibiotico: int(), psicotropico: int(), unidad: str(), stock: int(), stockMinimo: int(), stockMaximo: int({ nullable: true }),
    precioVenta: num({ nullable: true }), estado: str({ enum: ['ok', 'bajo', 'sin_stock'] }),
  }),
  Lote: obj({
    id: int(), medicamentoId: int(), medicamento: str(), presentacion: str(), lote: str(), caducidad: str({ format: 'date' }),
    diasParaCaducar: int(), disponible: int(), inicial: int(), proveedor: str({ nullable: true }),
  }),
  Movimiento: obj({
    id: int(), tipo: str({ enum: ['entrada', 'salida', 'ajuste', 'devolucion'] }), cantidad: int(), stockAnterior: int(), stockNuevo: int(),
    medicamento: str(), lote: str({ nullable: true }), usuario: str({ nullable: true }), motivo: str({ nullable: true }), fecha: str({ format: 'date-time' }),
  }),
  AlertaFarmacia: obj({
    tipo: str({ enum: ['sin_stock', 'caducado', 'stock_bajo', 'por_caducar'] }), nivel: str({ enum: ['critico', 'advertencia'] }),
    medicamento: str(), detalle: str(), medicamentoId: int(), loteId: int(), fecha: str({ format: 'date' }),
  }),
  Hospital: obj({
    id: int(), nombre: str(), tipo: str(), nivel: str(), direccion: str(), telefono: str(), latitud: num(), longitud: num(),
    tieneUrgencias: int(), tieneUci: int(), camasTotales: int(), camasDisponibles: int(),
    distanciaKm: num({ nullable: true, description: 'Solo cuando se envían lat y lng' }),
  }),
  Cuenta: obj({
    id: int(), folio: str(), estado: str({ enum: ['abierta', 'cerrada', 'cancelada'] }), subtotal: num(), descuento: num(),
    motivoDescuento: str({ nullable: true }), total: num(), pagado: num(), saldo: num(), cerradaEn: str({ nullable: true }),
    notas: str({ nullable: true }), creada: str({ nullable: true }), paciente: str(), curp: str({ nullable: true }),
  }),
};

// ---------- respuestas comunes ----------
const responses = {
  Invalido: { description: 'Datos inválidos', ...json(ref('Error'), { error: 'pacienteId es obligatorio' }) },
  NoAutenticado: { description: 'Sin token, token inválido o vencido, cuenta desactivada o sesión revocada', ...json(ref('Error'), { error: 'Token requerido' }) },
  SinPermiso: { description: 'El rol no tiene permiso para esta acción', ...json(ref('Error'), { error: 'No tienes permiso para esta acción' }) },
  NoEncontrado: { description: 'No existe el registro', ...json(ref('Error'), { error: 'Paciente no encontrado' }) },
  Conflicto: { description: 'La operación choca con el estado actual', ...json(ref('Error'), { error: 'La cama no está disponible' }) },
  DemasiadasPeticiones: { description: 'Se superó un límite de peticiones', ...json(ref('Error'), { error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' }) },
};

// ---------- rutas ----------
const MED_ENF = ['medico', 'enfermeria'];
const paths = {
  '/api/health': {
    get: {
      tags: ['Sistema'], summary: 'Estado de la API y de la base de datos',
      description: 'Pública. Hace `SELECT 1` en la base de datos (máximo 2 s). La usan el HEALTHCHECK de Docker y el monitoreo.', security: [],
      responses: {
        200: ok('API y base de datos en línea', obj({ ok: bool(), db: str({ enum: ['ok'] }) }), { ok: true, db: 'ok' }),
        503: ok('La base de datos no responde (por ejemplo, RDS apagado)', obj({ ok: bool(), db: str({ enum: ['sin_conexion'] }), error: str() }), { ok: false, db: 'sin_conexion', error: 'La base de datos no está disponible.' }),
      },
    },
  },

  // ----- Autenticación -----
  '/api/auth/login': {
    post: op({
      tag: 'Autenticación', resumen: 'Iniciar sesión', publico: true, huella: true,
      desc: 'Médico: responde `requierePin` y un `pinToken`; continúa en `POST /api/auth/pin`. Otros roles: responde el token de acceso.\n\nLímites: 5 intentos fallidos por cuenta y 20 por IP cada 15 minutos. Requiere la cabecera `X-Device-Fingerprint`; un dispositivo bloqueado en la web responde 403 `DISPOSITIVO_BLOQUEADO`.',
      body: { schema: obj({ email: str({ format: 'email' }), password: str({ format: 'password' }) }, ['email', 'password']), ejemplo: { email: 'qa.enfermeria@healthnexus.test', password: '********' } },
      ok: {
        200: ok('Sesión iniciada, o paso del PIN para médicos', { oneOf: [ref('Sesion'), ref('PasoPin')] }),
        400: { description: 'Faltan datos o falta la huella (`HUELLA_REQUERIDA`)', ...json(ref('Error')) },
        401: { description: 'Credenciales incorrectas', ...json(ref('Error'), { error: 'Credenciales incorrectas' }) },
        403: { description: 'Dispositivo bloqueado (`DISPOSITIVO_BLOQUEADO`)', ...json(ref('Error')) },
      },
      errores: [429],
    }),
  },
  '/api/auth/pin': {
    post: op({
      tag: 'Autenticación', resumen: 'Segundo paso del médico: validar el PIN', publico: true, huella: true,
      desc: 'Cambia el `pinToken` (5 min) por el token de acceso. 5 PIN fallidos por usuario cada 15 minutos responden 429.',
      body: { schema: obj({ pinToken: str(), pin: str({ pattern: '^\\d{4}$' }) }, ['pinToken', 'pin']), ejemplo: { pinToken: 'eyJhbGciOi...', pin: '2468' } },
      ok: {
        200: ok('PIN correcto', ref('Sesion')),
        400: { description: 'Falta el pinToken o el PIN no tiene 4 dígitos', ...json(ref('Error')) },
        401: { description: 'PIN incorrecto o verificación expirada', ...json(ref('Error'), { error: 'PIN incorrecto.' }) },
        403: { description: 'Cuenta sin PIN asignado o dispositivo bloqueado', ...json(ref('Error')) },
      },
      errores: [429],
    }),
  },
  '/api/auth/me': {
    get: op({ tag: 'Autenticación', resumen: 'Usuario de la sesión', roles: 'todos', ok: { 200: ok('Datos del usuario', ref('Usuario')) } }),
  },
  '/api/auth/recuperar': {
    post: op({
      tag: 'Recuperar contraseña', resumen: '1. Pedir el código por correo', publico: true,
      desc: 'Responde 202 con el mismo mensaje exista o no la cuenta (no se pueden adivinar correos). El código de 6 dígitos vence en 15 minutos; solo se guarda su hash. Máximo 3 solicitudes por correo cada hora y 10 por IP cada 15 minutos.',
      body: { schema: obj({ email: str({ format: 'email' }) }, ['email']), ejemplo: { email: 'ana.lopez@hospital.mx' } },
      ok: { 202: ok('Solicitud recibida', obj({ mensaje: str(), minutos: int({ example: 15 }) })) },
      errores: [400, 429],
    }),
  },
  '/api/auth/recuperar/verificar': {
    post: op({
      tag: 'Recuperar contraseña', resumen: '2. Verificar el código', publico: true,
      desc: 'Con el código correcto entrega un `resetToken` de 10 minutos (no es token de acceso). Al 5.º código incorrecto el código se invalida (`CODIGO_BLOQUEADO`).',
      body: { schema: obj({ email: str({ format: 'email' }), codigo: str({ pattern: '^\\d{6}$' }) }, ['email', 'codigo']), ejemplo: { email: 'ana.lopez@hospital.mx', codigo: '482913' } },
      ok: {
        200: ok('Código correcto', obj({ resetToken: str(), minutos: int({ example: 10 }) })),
        400: { description: 'Código incorrecto o vencido (`CODIGO_INVALIDO`) o bloqueado (`CODIGO_BLOQUEADO`)', ...json(ref('Error')) },
      },
      errores: [429],
    }),
  },
  '/api/auth/recuperar/restablecer': {
    post: op({
      tag: 'Recuperar contraseña', resumen: '3. Guardar la contraseña nueva', publico: true,
      desc: 'Política: 8 caracteres o más, una mayúscula y un número. El `resetToken` sirve una sola vez. Las sesiones abiertas de la app se cierran (`SESION_REVOCADA`).',
      body: { schema: obj({ resetToken: str(), nueva: str({ format: 'password', minLength: 8 }) }, ['resetToken', 'nueva']), ejemplo: { resetToken: 'eyJhbGciOi...', nueva: 'Hospital2026' } },
      ok: {
        200: ok('Contraseña actualizada', obj({ ok: bool(), mensaje: str() }), { ok: true, mensaje: 'Contraseña actualizada. Ya puedes iniciar sesión.' }),
        400: { description: 'La contraseña no cumple la política (`CLAVE_DEBIL`)', ...json(ref('Error')) },
        401: { description: 'resetToken falso, vencido o ya usado (`RESET_EXPIRADO`)', ...json(ref('Error')) },
      },
      errores: [429],
    }),
  },

  // ----- Pacientes y triage -----
  '/api/stats': {
    get: op({ tag: 'Pacientes', resumen: 'Resumen del turno', desc: 'Pacientes activos y admisiones activas por nivel de triage (para el Inicio).', roles: MED_ENF,
      ok: { 200: ok('Totales', obj({ totalPatients: int(), redCount: int(), yellowCount: int({ description: 'naranja + amarillo' }), greenCount: int({ description: 'verde + azul' }) }), { totalPatients: 202, redCount: 2, yellowCount: 5, greenCount: 9 }) } }),
  },
  '/api/patients': {
    get: op({
      tag: 'Pacientes', resumen: 'Buscar pacientes', roles: MED_ENF,
      params: [q('q', str(), 'Nombre, CURP o teléfono'), q('nivel', str({ enum: [...NIVELES, 'sin'] }), 'Triage actual; `sin` = sin clasificar'), ...PAGINA],
      ok: { 200: ok('Pacientes (máximo 1000 por página)', lista(ref('PacienteResumen'))) }, errores: [400],
    }),
    post: op({
      tag: 'Pacientes', resumen: 'Registrar paciente', roles: MED_ENF, body: { schema: ref('PacienteNuevo'), ejemplo: { nombre: 'Laura', apellidoPaterno: 'Méndez', apellidoMaterno: 'Ortega', fechaNacimiento: '1974-03-12', sexo: 'mujer', alergias: 'Penicilina' } },
      ok: { 201: ok('Paciente creado', ref('Paciente')) }, errores: [400, 409],
    }),
  },
  '/api/patients/{id}': {
    get: op({ tag: 'Pacientes', resumen: 'Ficha completa del paciente', roles: MED_ENF, params: [idPath()], ok: { 200: ok('Paciente', ref('Paciente')) }, errores: [404] }),
  },
  '/api/triage': {
    get: op({
      tag: 'Triage', resumen: 'Lista de triage', desc: 'Pacientes con el triage de su admisión activa, del más grave al menos grave.', roles: MED_ENF,
      params: [q('q', str(), 'Nombre o CURP'), q('nivel', str({ enum: [...NIVELES, 'sin'] }), 'Filtrar por nivel'), ...PAGINA],
      ok: { 200: ok('Pacientes', lista(ref('TriagePaciente'))) }, errores: [400],
    }),
  },
  '/api/patients/{id}/triage': {
    patch: op({
      tag: 'Triage', resumen: 'Clasificar al paciente', roles: ['medico'],
      desc: 'Si el paciente no tiene admisión activa se crea una. Nivel **rojo** envía un aviso push a los médicos (sin datos del paciente). Queda en la bitácora con el nivel anterior y el nuevo.',
      params: [idPath('id', 'Id del paciente')],
      body: { schema: obj({ triageLevel: ref('NivelTriage'), motivo: str({ minLength: 3, maxLength: 1000 }), diagnosticoPresuntivo: str({ minLength: 3, maxLength: 1000 }) }, ['triageLevel']), ejemplo: { triageLevel: 'naranja', motivo: 'Dolor torácico opresivo de 40 minutos', diagnosticoPresuntivo: 'Probable síndrome coronario agudo' } },
      ok: { 200: ok('Triage guardado', obj({ id: int(), admisionId: int(), triageLevel: ref('NivelTriage'), admisionCreada: bool() })) }, errores: [400, 404],
    }),
  },

  // ----- Emergencias -----
  '/api/emergencias': {
    post: op({
      tag: 'Emergencias', resumen: 'Activar código de emergencia', roles: MED_ENF,
      desc: 'Avisa por push a médicos y enfermería. Máximo 3 activaciones por minuto por usuario. La ubicación es opcional.',
      body: { schema: obj({ mensaje: str({ maxLength: 500 }), ubicacion: ref('Ubicacion') }), ejemplo: { mensaje: 'Código de emergencia activado desde la app móvil', ubicacion: { lat: 19.2826, lng: -99.6557 } } },
      ok: { 201: ok('Emergencia registrada', obj({ id: int(), mensaje: str(), estado: str({ example: 'activa' }) })) }, errores: [400, 429],
    }),
  },
  '/api/emergencias/activas': {
    get: op({ tag: 'Emergencias', resumen: 'Emergencias activas', desc: 'Abiertas en las últimas 24 horas, la más reciente primero (máximo 20).', roles: MED_ENF, ok: { 200: ok('Emergencias', lista(ref('Emergencia'))) } }),
  },
  '/api/emergencias/{id}/atender': {
    patch: op({ tag: 'Emergencias', resumen: 'Marcar como atendida', roles: MED_ENF, params: [idPath()], ok: { 200: ok('Emergencia resuelta', obj({ id: int(), estado: str({ example: 'resuelta' }) })) }, errores: [400, 404] }),
  },

  // ----- Enfermería -----
  '/api/enfermeria/signos': {
    get: op({ tag: 'Enfermería', resumen: 'Consultar signos vitales', roles: MED_ENF, params: [q('pacienteId', int(), 'Solo de este paciente'), q('limit', int({ minimum: 1, maximum: 200, default: 50 }), 'Máximo de registros')], ok: { 200: ok('Registros, el más reciente primero', lista(ref('Signos'))) } }),
    post: op({
      tag: 'Enfermería', resumen: 'Registrar signos vitales', roles: ['enfermeria'], desc: 'Todos los valores son opcionales, pero debe venir al menos uno. Fuera de los rangos indicados responde 400.',
      body: { schema: ref('SignosNuevos'), ejemplo: { pacienteId: 501, temperatura: 37.9, frecuenciaCardiaca: 98, presionArterial: '124/80', saturacionOxigeno: 95 } },
      ok: { 201: ok('Registro creado', obj({ id: int() })) }, errores: [400, 404],
    }),
  },
  '/api/enfermeria/administraciones': {
    get: op({ tag: 'Enfermería', resumen: 'Medicamentos administrados', roles: MED_ENF, params: [q('pacienteId', int(), 'Solo de este paciente'), ...PAGINA], ok: { 200: ok('Administraciones', lista(ref('Administracion')), undefined, { headers: TOTAL_HEADER }) } }),
    post: op({
      tag: 'Enfermería', resumen: 'Registrar administración de medicamento', roles: ['enfermeria'],
      desc: 'Igual que la web: el paciente debe estar hospitalizado (el administrador queda exento) y se descuentan `unidades` (1 por defecto) de los lotes vigentes que caducan primero. En la misma transacción se registran los movimientos de salida, la nota de enfermería y la administración. Si no se envía la vía, se usa la del medicamento. 409 `SIN_STOCK` o `NO_HOSPITALIZADO`.',
      body: { schema: obj({ pacienteId: int(), medicamentoId: int(), dosis: str({ maxLength: 50 }), via: str({ maxLength: 50 }), unidades: int({ minimum: 1, maximum: 20, default: 1 }), observaciones: str({ maxLength: 1000 }), reaccionAdversa: bool() }, ['pacienteId', 'medicamentoId', 'dosis']), ejemplo: { pacienteId: 501, medicamentoId: 12, dosis: '1 g', via: 'Intravenosa', unidades: 1, reaccionAdversa: false } },
      ok: { 201: ok('Registrada y descontada del inventario', obj({ id: int(), medicamento: str(), notaId: int(), unidades: int(), stockAnterior: int(), stockNuevo: int(), movimientos: lista(obj({ id: int(), loteId: int(), cantidad: int() })) })) }, errores: [400, 404, 409],
    }),
  },
  '/api/seguimiento': {
    get: op({ tag: 'Enfermería', resumen: 'Seguimiento de pacientes', desc: 'Último registro de seguimiento de cada paciente.', roles: MED_ENF, params: PAGINA,
      ok: { 200: ok('Registros', lista(obj({ id: int(), pacienteId: int(), paciente: str(), tipo: str(), estado: str({ nullable: true }), contenido: str(), cama: str({ nullable: true }), fecha: str(), minutos: int() })), undefined, { headers: TOTAL_HEADER }) } }),
  },

  // ----- Derivaciones y hospitales -----
  '/api/derivaciones/camas': {
    get: op({ tag: 'Derivaciones', resumen: 'Camas disponibles', roles: MED_ENF, ok: { 200: ok('Camas', lista(obj({ id: int(), codigo: str(), area: str(), tipo: str(), servicio: str() }))) } }),
  },
  '/api/derivaciones/internas': {
    get: op({ tag: 'Derivaciones', resumen: 'Traslados internos', roles: MED_ENF, ok: { 200: ok('Traslados (máximo 300)', lista(obj({ id: int(), pacienteId: int(), paciente: str(), destino: str(), cama: str(), responsable: str(), estado: str({ enum: ['confirmada', 'finalizada'] }), fechaIngreso: str(), fechaEgreso: str({ nullable: true }), motivo: str({ nullable: true }) }))) } }),
    post: op({
      tag: 'Derivaciones', resumen: 'Trasladar a otra cama', roles: ['medico'], desc: 'La cama anterior del paciente pasa a limpieza.',
      body: { schema: obj({ pacienteId: int(), camaId: int(), motivo: str() }, ['pacienteId', 'camaId']), ejemplo: { pacienteId: 501, camaId: 14, motivo: 'Pasa a observación' } },
      ok: { 201: ok('Traslado confirmado', obj({ id: int(), estado: str({ example: 'confirmada' }), cama: str() })) }, errores: [400, 404, 409],
    }),
  },
  '/api/derivaciones/internas/{id}': {
    patch: op({ tag: 'Derivaciones', resumen: 'Finalizar traslado', roles: MED_ENF, params: [idPath()], body: { schema: obj({ estado: str({ enum: ['finalizada'] }) }, ['estado']), ejemplo: { estado: 'finalizada' } },
      ok: { 200: ok('Finalizado', obj({ id: int(), estado: str({ example: 'finalizada' }) })) }, errores: [400, 404, 409] }),
  },
  '/api/derivaciones/externas': {
    get: op({ tag: 'Derivaciones', resumen: 'Traslados a otros hospitales', roles: ['medico'], ok: { 200: ok('Traslados (máximo 300)', lista(obj({ id: int(), pacienteId: int(), paciente: str(), hospitalId: int(), hospital: str(), motivo: str(), fecha: str(), estado: str(), folio: str() }))) } }),
    post: op({
      tag: 'Derivaciones', resumen: 'Derivar a otro hospital', roles: ['medico'], desc: 'Marca la última admisión del paciente como derivada; responde el folio para el pase de salida.',
      body: { schema: obj({ pacienteId: int(), hospitalId: int(), motivo: str({ minLength: 3 }) }, ['pacienteId', 'hospitalId', 'motivo']), ejemplo: { pacienteId: 501, hospitalId: 1, motivo: 'Requiere UCI' } },
      ok: { 201: ok('Derivado', obj({ id: int(), folio: str(), hospital: str(), estado: str({ example: 'derivado' }) })) }, errores: [400, 404, 409],
    }),
  },
  '/api/hospitals': {
    get: op({
      tag: 'Derivaciones', resumen: 'Hospitales cercanos', desc: 'Con `lat` y `lng`: los que están dentro de `radioKm`, del más cercano al más lejano. Sin ubicación: todos por nombre.', roles: MED_ENF,
      params: [q('lat', num({ minimum: -90, maximum: 90 }), 'Latitud'), q('lng', num({ minimum: -180, maximum: 180 }), 'Longitud'), q('radioKm', num({ minimum: 1, maximum: 500, default: 50 }), 'Radio de búsqueda'), q('limite', int({ minimum: 1, maximum: 100 }), 'Máximo de resultados')],
      ok: { 200: ok('Hospitales', lista(ref('Hospital'))) }, errores: [400],
    }),
  },
  '/api/hospitals/{id}/reservas': {
    post: op({ tag: 'Derivaciones', resumen: 'Reservar cama en otro hospital', roles: ['medico'], params: [idPath('id', 'Id del hospital')],
      body: { schema: obj({ pacienteId: int() }, ['pacienteId']), ejemplo: { pacienteId: 501 } },
      ok: { 201: ok('Reserva creada', obj({ id: int(), ticket: str({ example: 'TK-LZ8Q2A-4F1C' }), hospital: str(), camasDisponibles: int() })) }, errores: [400, 404, 409] }),
  },

  // ----- Farmacia -----
  '/api/farmacia/resumen': {
    get: op({ tag: 'Farmacia', resumen: 'Resumen de farmacia', roles: ['farmacia'], ok: { 200: ok('Contadores', obj({ totalMedicamentos: int(), stockBajo: int(), sinStock: int(), lotesPorCaducar: int({ description: 'En los próximos 30 días' }), lotesCaducados: int() })) } }),
  },
  '/api/farmacia/medicamentos': {
    get: op({ tag: 'Farmacia', resumen: 'Catálogo con stock', roles: ['farmacia'], params: [q('q', str(), 'Nombre, sustancia o código de barras'), q('estado', str({ enum: ['bajo', 'sin_stock'] }), 'Filtrar por stock'), ...PAGINA], ok: { 200: ok('Medicamentos', paginado(ref('Medicamento'))) } }),
  },
  '/api/farmacia/catalogo': {
    get: op({ tag: 'Farmacia', resumen: 'Lista corta para elegir un medicamento', desc: 'Sin precios. Máximo 500.', roles: ['farmacia', 'enfermeria', 'medico'], params: [q('q', str(), 'Nombre o sustancia')],
      ok: { 200: ok('Medicamentos', lista(obj({ id: int(), nombre: str(), presentacion: str(), concentracion: str(), via: str(), stock: int(), controlado: int() }))) } }),
  },
  '/api/farmacia/existencias': {
    get: op({ tag: 'Farmacia', resumen: 'Existencias por lote', roles: ['farmacia', 'enfermeria', 'medico'],
      params: [q('q', str(), 'Medicamento o lote'), q('caduca', str(), '`vencidos` o número de días (1 a 365)'), q('todos', str({ enum: ['1'] }), 'Incluir lotes agotados'), ...PAGINA],
      ok: { 200: ok('Lotes, el que caduca primero arriba', paginado(ref('Lote'))) }, errores: [400] }),
  },
  '/api/farmacia/movimientos': {
    get: op({ tag: 'Farmacia', resumen: 'Movimientos de inventario', roles: ['farmacia', 'enfermeria'], params: [q('tipo', str({ enum: ['entrada', 'salida', 'ajuste', 'devolucion'] }), 'Tipo'), q('q', str(), 'Medicamento'), ...PAGINA], ok: { 200: ok('Movimientos', paginado(ref('Movimiento'))) } }),
    post: op({
      tag: 'Farmacia', resumen: 'Registrar movimiento', roles: ['farmacia'],
      desc: '`entrada` y `devolucion` suman; `salida` resta; en `ajuste`, `cantidad` es la nueva cantidad del lote. El motivo es obligatorio en salidas y ajustes. Un lote caducado no recibe entradas.',
      body: { schema: obj({ loteId: int(), tipo: str({ enum: ['entrada', 'salida', 'ajuste', 'devolucion'] }), cantidad: int({ minimum: 0, maximum: 1000000 }), motivo: str({ minLength: 3 }) }, ['loteId', 'tipo', 'cantidad']), ejemplo: { loteId: 31, tipo: 'salida', cantidad: 10, motivo: 'Surtido a Urgencias, cama 12' } },
      ok: { 201: ok('Movimiento registrado', obj({ id: int(), tipo: str(), medicamento: str(), stockAnterior: int(), stockNuevo: int(), cantidadLote: int() })) }, errores: [400, 404, 409],
    }),
  },
  '/api/farmacia/alertas': {
    get: op({ tag: 'Farmacia', resumen: 'Alertas de inventario', desc: 'Sin stock y caducados (críticas); stock bajo y por caducar en 30 días (advertencias).', roles: ['farmacia'], ok: { 200: ok('Alertas', obj({ total: int(), data: lista(ref('AlertaFarmacia')) })) } }),
  },

  // ----- Administración -----
  '/api/cuentas': {
    get: op({ tag: 'Administración', resumen: 'Cuentas de pacientes', roles: 'admin',
      params: [q('q', str({ maxLength: 80 }), 'Folio, paciente o CURP'), q('estado', str({ enum: ['abierta', 'cerrada', 'cancelada'] }), 'Estado'), q('con_saldo', str({ enum: ['1'] }), 'Solo con saldo pendiente'), q('paciente_id', int(), 'Solo de este paciente'), ...PAGINA],
      ok: { 200: ok('Cuentas', obj({ total: int(), page: int(), limit: int(), saldoPendiente: num(), data: lista(ref('Cuenta')) })) }, errores: [400] }),
  },
  '/api/cuentas/{id}': {
    get: op({ tag: 'Administración', resumen: 'Estado de cuenta', desc: 'Cargos, pagos (los cancelados marcados) y una verificación de que el saldo cuadra. La consulta queda en la bitácora.', roles: 'admin', params: [idPath()],
      ok: { 200: ok('Estado de cuenta', { allOf: [ref('Cuenta'), obj({ paciente: obj({ id: int(), nombre: str(), curp: str({ nullable: true }) }), cargos: lista(obj({ id: int(), concepto: str(), cantidad: num(), precioUnitario: num(), descuento: num(), importe: num() })), pagos: lista(obj({ id: int(), folio: str(), monto: num(), metodo: str(), estado: str(), cancelado: bool(), pagadoEn: str() })), verificacion: obj({ pagadoCalculado: num(), saldoCalculado: num(), coincide: bool() }) })] }) }, errores: [404] }),
  },
  '/api/pagos/{id}/recibo': {
    get: op({ tag: 'Administración', resumen: 'Recibo de pago en PDF', desc: 'Se descarga como adjunto y queda en la bitácora.', roles: 'admin', params: [idPath('id', 'Id del pago')],
      ok: { 200: { description: 'PDF del recibo', content: { 'application/pdf': { schema: str({ format: 'binary' }) } } } }, errores: [404] }),
  },
  '/api/auditoria': {
    get: op({ tag: 'Administración', resumen: 'Bitácora del sistema', roles: 'admin',
      params: [q('q', str(), 'Usuario, evento, módulo o descripción'), q('desde', str({ format: 'date' }), 'AAAA-MM-DD'), q('hasta', str({ format: 'date' }), 'AAAA-MM-DD'), q('severidad', str({ enum: ['info', 'warning', 'critical'] }), 'Severidad'), ...PAGINA],
      ok: { 200: ok('Registros', paginado(obj({ id: int(), usuario: str(), rol: str(), evento: str(), modulo: str(), accion: str(), severidad: str(), critica: int(), fecha: str() }))) } }),
  },

  // ----- Catálogos y notificaciones -----
  '/api/catalogos/estados': {
    get: op({ tag: 'Catálogos', resumen: 'Estados de la República', roles: MED_ENF, ok: { 200: ok('Estados', lista(obj({ id: int(), nombre: str() }))) } }),
  },
  '/api/catalogos/municipios': {
    get: op({ tag: 'Catálogos', resumen: 'Municipios de un estado', roles: MED_ENF, params: [q('estadoId', int({ minimum: 1 }), 'Id del estado', true)], ok: { 200: ok('Municipios', lista(obj({ id: int(), nombre: str() }))) }, errores: [400] }),
  },
  '/api/notificaciones/token': {
    post: op({ tag: 'Notificaciones', resumen: 'Guardar el token FCM del teléfono', roles: 'todos', huella: true, desc: 'El token se asocia al dispositivo de la cabecera `X-Device-Fingerprint`.',
      body: { schema: obj({ token: str() }, ['token']) }, ok: { 200: ok('Guardado', obj({ ok: bool(), activo: bool({ description: 'false si el servidor no tiene Firebase configurado' }) })) }, errores: [400, 404] }),
    delete: op({ tag: 'Notificaciones', resumen: 'Dejar de enviar notificaciones a este teléfono', roles: 'todos', huella: true, desc: 'La app lo llama al cerrar sesión.', ok: { 200: ok('Quitado', obj({ ok: bool() })) }, errores: [400] }),
  },
};

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'HealthNexus API',
    version,
    description: [
      'API REST de la app móvil de HealthNexus. Comparte la base de datos MySQL con la aplicación web (Laravel).',
      '',
      '**Cómo probarla aquí**',
      '1. En **Authorize** escribe una huella de dispositivo en `huellaDispositivo` (16 a 255 caracteres: letras, números, `. _ : -`), por ejemplo `swagger-pruebas-0001`.',
      '2. Llama a `POST /api/auth/login`. Si la cuenta es de médico, continúa con `POST /api/auth/pin`.',
      '3. Copia el `token` de la respuesta en **Authorize → bearerAuth** (sin la palabra Bearer).',
      '',
      'El rol se vuelve a leer de la base de datos en cada petición. El **administrador** puede usar todas las rutas. Todas las respuestas de error tienen la forma `{ "error": "...", "code"?: "..." }`. Si la base de datos no está disponible, cualquier ruta responde **503** con `code: "SERVICIO_NO_DISPONIBLE"`. Límite global: 120 peticiones por minuto por IP.',
    ].join('\n'),
    contact: { name: 'Equipo HealthNexus', url: 'https://github.com/JesusFelipeA/healthnexus-api-sprint4' },
  },
  servers: [
    { url: '/', description: 'Este servidor' },
    { url: 'https://healthnexus.duckdns.org', description: 'Producción' },
    { url: 'http://localhost:3000', description: 'Local (Docker)' },
  ],
  tags: [
    { name: 'Sistema' }, { name: 'Autenticación', description: 'Login en uno o dos pasos (PIN para médicos)' },
    { name: 'Recuperar contraseña', description: 'Código de 6 dígitos por correo' }, { name: 'Pacientes' }, { name: 'Triage' },
    { name: 'Emergencias' }, { name: 'Enfermería', description: 'Signos vitales, medicación y seguimiento' },
    { name: 'Derivaciones', description: 'Traslados internos, externos y hospitales cercanos' }, { name: 'Farmacia' },
    { name: 'Administración', description: 'Cuentas, recibos y bitácora (solo administrador)' }, { name: 'Catálogos' }, { name: 'Notificaciones' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token de `POST /api/auth/login` o `/api/auth/pin` (8 h)' },
      huellaDispositivo: { type: 'apiKey', in: 'header', name: 'X-Device-Fingerprint', description: 'Identificador del teléfono (la app lo guarda en el Keychain)' },
    },
    schemas, responses,
  },
  security: [{ bearerAuth: [] }],
  paths,
};

module.exports = spec;
