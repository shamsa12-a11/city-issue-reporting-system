/**
 * Express application (no network listening here, so tests can import it).
 *
 * Request pipeline:
 *   helmet -> cors -> /uploads (photo files) -> JSON body parser
 *   -> rate limiter -> /api routes -> 404 handler -> central error handler
 */
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { env } = require('./config/env');
const apiRoutes = require('./routes');
const { apiLimiter } = require('./middleware/rateLimiters');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { isValidStoragePath, PUBLIC_URL_PREFIX } = require('./storage/photoStorage');

const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(
  cors({
    origin: env.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Uploaded photos (local storage). Only paths created by photoStorage
// ("issues/<uuid>.jpg|png|webp") are served; anything else falls through to
// the JSON 404. Helmet's default Cross-Origin-Resource-Policy (same-origin)
// would stop the React app on another port from showing the images, so it is
// relaxed for photo files only; all other responses keep same-origin.
const uploads = express.Router();
uploads.use((req, _res, next) => (isValidStoragePath(req.path.slice(1)) ? next() : next('router')));
uploads.use(helmet.crossOriginResourcePolicy({ policy: 'cross-origin' }));
uploads.use(
  express.static(env.uploadsDir, {
    index: false,
    dotfiles: 'deny',
    redirect: false,
    fallthrough: true, // missing file -> JSON 404
    maxAge: '7d',
    immutable: true, // file names are random and never reused
  })
);
app.use(PUBLIC_URL_PREFIX, uploads);

app.use(express.json({ limit: '100kb' }));

app.use('/api', apiLimiter, apiRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
