import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import Busboy from 'busboy';
import { requireAdmin } from '../auth.js';
import { MAX_PACKAGE_BYTES } from './archive.js';
import { isPublicFile, PluginError } from './manifest.js';
import type { PluginRuntime } from './runtime.js';
import { readManifestDir } from './store.js';
import { addRegistry, createRemoteDeps, fetchRegistry, fetchVerifiedPackage, installRemote, listRegistries, previewOf, removeRegistry, type RemoteDeps } from './remote.js';

/**
 * The HTTP side of the plugin host:
 *   /api/plugins/<id>/...        the dispatcher, into each running plugin
 *   /api/plugins-web             public list of the active web bundles (the SPA loads these)
 *   /api/admin/plugins/...       admin API: list, upload, enable, update, roll back, settings, logs
 *   /plugins/<id>/<version>/...  the installed files of a version, public and cached forever
 */

type Handler = (req: Request, res: Response) => Promise<void> | void;

/** Express 4 does not await handlers: wrap so a thrown PluginError becomes its status, and anything else goes to the host. */
function route(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err: unknown) => {
        if (err instanceof PluginError) {
          if (!res.headersSent) res.status(err.status).json({ error: err.message });
          return;
        }
        next(err);
      });
  };
}

/** The `package` file of a multipart upload, held in memory, or null if none was sent. */
function readUpload(req: IncomingMessage, limitBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let bb: Busboy.Busboy;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: limitBytes, files: 1, fields: 10, parts: 12 } });
    } catch {
      return reject(new PluginError('Expected a multipart/form-data upload'));
    }
    let file: Buffer | null = null;
    let failed: PluginError | null = null;
    const refuse = (err: PluginError): void => {
      failed ??= err;
      req.unpipe(bb);
      reject(err);
    };
    bb.on('file', (name, stream) => {
      if (name !== 'package') {
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => refuse(new PluginError('The package is larger than 50 MB', 413)));
      stream.on('close', () => {
        file = Buffer.concat(chunks);
      });
    });
    bb.on('filesLimit', () => refuse(new PluginError('Send one plugin package at a time')));
    bb.on('partsLimit', () => refuse(new PluginError('Too many parts in the upload')));
    bb.on('fieldsLimit', () => refuse(new PluginError('Too many form fields')));
    bb.on('error', () => refuse(new PluginError('Malformed upload')));
    bb.on('close', () => (failed ? reject(failed) : resolve(file)));
    req.pipe(bb);
  });
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The admin API, to be mounted at /api/admin/plugins. Every route needs an admin. */
export function pluginAdminRouter(runtime: PluginRuntime, remoteOpts: Partial<RemoteDeps> = {}): express.Router {
  const router = express.Router();
  const remote = createRemoteDeps(remoteOpts);
  router.use((req, res, next) => {
    if (requireAdmin(req, res)) next();
  });

  // Distribution: registries and install-from-registry. Declared before the /:id routes, so DELETE /registries is not read as an id.
  const body = (req: Request): Record<string, unknown> => (typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {});

  router.get(
    '/registries',
    route((_req, res) => {
      res.json({ registries: listRegistries(remote) });
    }),
  );

  router.post(
    '/registries',
    route(async (req, res) => {
      res.json({ registries: await addRegistry(remote, body(req).url) });
    }),
  );

  router.delete(
    '/registries',
    route((req, res) => {
      res.json({ registries: removeRegistry(remote, body(req).url) });
    }),
  );

  router.get(
    '/registry',
    route(async (req, res) => {
      const { plugins } = await fetchRegistry(remote, typeof req.query.url === 'string' ? req.query.url : undefined);
      res.json({ plugins });
    }),
  );

  router.post(
    '/preview-remote',
    route(async (req, res) => {
      res.json(previewOf(await fetchVerifiedPackage(remote, body(req) as { registryUrl: unknown; id: unknown; version?: unknown })));
    }),
  );

  router.post(
    '/install-remote',
    route(async (req, res) => {
      const { created, id, version, status } = await installRemote(runtime, remote, body(req) as { registryUrl: unknown; id: unknown; version?: unknown });
      res.status(created ? 201 : 200).json({ ok: true, id, version, status });
    }),
  );

  router.get(
    '/',
    route((_req, res) => {
      res.json({ ...runtime.meta(), plugins: runtime.statuses() });
    }),
  );

  router.post(
    '/upload',
    route(async (req, res) => {
      const zip = await readUpload(req, MAX_PACKAGE_BYTES);
      if (!zip) throw new PluginError('Upload the plugin .zip in the "package" field');
      const { created, id, version, status } = await runtime.installPackage(zip);
      res.status(created ? 201 : 200).json({ ok: true, id, version, status });
    }),
  );

  router.post(
    '/:id/enable',
    route(async (req, res) => {
      res.json(await runtime.setEnabled(req.params.id, true));
    }),
  );

  router.post(
    '/:id/disable',
    route(async (req, res) => {
      res.json(await runtime.setEnabled(req.params.id, false));
    }),
  );

  router.post(
    '/:id/reload',
    route(async (req, res) => {
      res.json(await runtime.reload(req.params.id));
    }),
  );

  router.post(
    '/:id/rollback',
    route(async (req, res) => {
      res.json(await runtime.rollback(req.params.id));
    }),
  );

  router.delete(
    '/:id',
    route(async (req, res) => {
      await runtime.uninstall(req.params.id, { keepData: req.query.keepData === '1' });
      res.json({ ok: true });
    }),
  );

  router.get(
    '/:id/settings',
    route((req, res) => {
      res.json(runtime.settings(req.params.id));
    }),
  );

  router.put(
    '/:id/settings',
    route((req, res) => {
      res.json(runtime.updateSettings(req.params.id, req.body));
    }),
  );

  router.get(
    '/:id/logs',
    route((req, res) => {
      res.json({ logs: runtime.logs(req.params.id) });
    }),
  );

  return router;
}

const STATIC_TYPES = new Set(['.js', '.css', '.png', '.svg', '.webp', '.jpg', '.json', '.woff2']);
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Whether the manifest in this installed folder lets the public route serve the file. False if the manifest cannot be read. */
function servesFile(dir: string, rel: string): boolean {
  try {
    return isPublicFile(readManifestDir(dir), rel);
  } catch {
    return false;
  }
}

/**
 * The files of the running plugin versions, at /plugins/<id>/<version>/<file>.
 * Only the version that is running, and of its files only the web bundle, the
 * icon and what is under assets/. Only these file types, and never a dot-file
 * or anything outside the version's folder.
 */
export function pluginStaticRouter(runtime: PluginRuntime): express.Router {
  const router = express.Router();
  router.get('/:id/:version/*', (req, res) => {
    const { id, version } = req.params;
    const rel = (req.params as Record<string, string | undefined>)[0] ?? '';
    const parts = rel.split('/');
    const dir = runtime.resolveDir(id, version);
    const refuse = (): void => {
      res.status(404).type('text/plain').send('Not found');
    };
    if (!dir || !STATIC_TYPES.has(path.extname(rel).toLowerCase())) return refuse();
    if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.') || p.includes('\\'))) return refuse();
    if (!servesFile(dir, rel)) return refuse();
    const file = path.join(dir, ...parts);
    if (!file.startsWith(dir + path.sep) || !isFile(file)) return refuse();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file, { dotfiles: 'deny', maxAge: ONE_YEAR_MS, immutable: true }, (err) => {
      if (err && !res.headersSent) refuse();
    });
  });
  return router;
}

/** Mount everything the plugin host serves. Call before the /api 404 handler and the SPA fallback. */
export function mountPlugins(app: express.Express, runtime: PluginRuntime, remote: Partial<RemoteDeps> = {}): void {
  app.get('/api/plugins-web', (_req, res) => {
    res.json(runtime.webEntries());
  });
  app.use('/api/plugins', runtime.dispatcher);
  app.use('/api/admin/plugins', pluginAdminRouter(runtime, remote));
  app.use('/plugins', pluginStaticRouter(runtime));
}
