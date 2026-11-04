// Documentación interactiva de la API (Swagger UI) en /api/docs y la especificación en /api/docs/openapi.json.
// Se desactiva con API_DOCS=0 (por ejemplo, si no se quiere publicar en producción).
const swaggerUi = require('swagger-ui-express');
const spec = require('./openapi');

const habilitada = (env = process.env) => String(env.API_DOCS ?? '1') !== '0';

function montar(app) {
  app.get('/api/docs/openapi.json', (req, res) => res.json(spec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, {
    customSiteTitle: 'HealthNexus API · Documentación',
    customCss: '.swagger-ui .topbar { display: none }',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, docExpansion: 'none', tryItOutEnabled: false },
  }));
}

module.exports = { montar, habilitada, spec };
