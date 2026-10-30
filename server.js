const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pipeline } = require('node:stream');

const audioExtensions = new Set(['.aac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);
const maxAudioFileSize = 100 * 1024 * 1024;

function createLibraryServer({
  dataDirectory = process.env.BIBLIOTECA_DATA_DIR || path.join(__dirname, 'data', 'discs'),
  maxFileSize = maxAudioFileSize,
} = {}) {
  const rootDirectory = path.resolve(dataDirectory);
  fs.mkdirSync(rootDirectory, { recursive: true });

  function getTrackPath(id) {
    if (typeof id !== 'string') return null;
    const [discId, filename, ...extra] = id.split('/');
    if (extra.length || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(discId || '')
      || !filename || filename !== path.basename(filename) || filename.includes('\\')
      || filename.startsWith('.') || /[\u0000-\u001f]/.test(filename)
      || !audioExtensions.has(path.extname(filename).toLowerCase())) {
      return null;
    }

    const discDirectory = path.resolve(rootDirectory, discId);
    const filePath = path.resolve(discDirectory, filename);
    if (path.dirname(discDirectory) !== rootDirectory || path.dirname(filePath) !== discDirectory) return null;
    return filePath;
  }

  function listDiscs() {
    return fs.readdirSync(rootDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name))
      .map((entry) => {
        const discDirectory = path.join(rootDirectory, entry.name);
        const metadataPath = path.join(discDirectory, '.disc-name.json');
        let discName = entry.name.replace(/-/g, ' ');
        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          if (!metadata || typeof metadata.name !== 'string' || !metadata.name.trim()) {
            throw new Error(`El nombre guardado del disco "${entry.name}" no es válido.`);
          }
          discName = metadata.name.trim();
        }
        const tracks = fs.readdirSync(discDirectory, { withFileTypes: true })
          .filter((file) => file.isFile() && audioExtensions.has(path.extname(file.name).toLowerCase()))
          .map((file) => ({
            id: `${entry.name}/${file.name}`,
            name: file.name,
            title: path.parse(file.name).name,
            discId: entry.name,
            discName,
          }))
          .sort((first, second) => first.name.localeCompare(second.name, 'es'));
        return {
          id: entry.name,
          name: discName,
          tracks,
        };
      })
      .sort((first, second) => first.name.localeCompare(second.name, 'es'));
  }

  function getDiscId(name) {
    return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  }

  function createDisc(name) {
    const discName = name.trim();
    const discId = getDiscId(discName);
    if (!discName || discName.length > 100 || !discId) {
      const error = new Error('El nombre del disco debe tener entre 1 y 100 caracteres válidos.');
      error.status = 400;
      throw error;
    }

    const discDirectory = path.join(rootDirectory, discId);
    const existed = fs.existsSync(discDirectory);
    fs.mkdirSync(discDirectory, { recursive: true });
    const metadataPath = path.join(discDirectory, '.disc-name.json');
    let savedName = discName;
    try {
      fs.writeFileSync(metadataPath, JSON.stringify({ name: discName }), { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      if (typeof metadata.name !== 'string' || !metadata.name.trim()) {
        throw new Error(`El nombre guardado del disco "${discId}" no es válido.`);
      }
      savedName = metadata.name.trim();
    }
    return { disc: { id: discId, name: savedName }, created: !existed };
  }

  function sendJson(response, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    response.end(body);
  }

  async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxFileSize) {
        const error = new Error('El archivo no puede superar 100 MB.');
        error.status = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function handleRequest(request, response) {
    const requestUrl = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/discs') {
      sendJson(response, 200, { discs: listDiscs() });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/discs') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch (error) {
        if (error.status) throw error;
        const invalidJson = new Error('El nombre del disco debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      if (!payload || typeof payload.name !== 'string') {
        const error = new Error('Indica el nombre del disco.');
        error.status = 400;
        throw error;
      }
      const result = createDisc(payload.name);
      sendJson(response, result.created ? 201 : 200, result);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/tracks') {
      const discName = requestUrl.searchParams.get('disc')?.trim() || '';
      const discId = getDiscId(discName);
      let filename;
      try {
        filename = decodeURIComponent(request.headers['x-file-name'] || '');
      } catch {
        const error = new Error('El nombre del archivo no es válido.');
        error.status = 400;
        throw error;
      }
      if (!discId || discName.length > 100 || !filename || filename.length > 180 || filename !== path.basename(filename)
        || filename.includes('/') || filename.includes('\\') || filename.startsWith('.')
        || /[\u0000-\u001f]/.test(filename) || !audioExtensions.has(path.extname(filename).toLowerCase())) {
        const error = new Error('El disco o el nombre/formato del archivo de audio no es válido.');
        error.status = 400;
        throw error;
      }
      const contents = await readBody(request);
      if (!contents.length) {
        const error = new Error('El archivo debe tener contenido.');
        error.status = 400;
        throw error;
      }
      const { disc } = createDisc(discName);
      const discDirectory = path.join(rootDirectory, disc.id);
      const filePath = path.join(discDirectory, filename);
      try {
        fs.writeFileSync(filePath, contents, { flag: 'wx' });
      } catch (error) {
        if (error.code === 'EEXIST') {
          error.status = 409;
          error.message = 'Ya existe un tema con ese nombre en este disco.';
        }
        throw error;
      }
      sendJson(response, 201, {
        track: {
          id: `${disc.id}/${filename}`,
          name: filename,
          title: path.parse(filename).name,
          discId: disc.id,
          discName: disc.name,
        },
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/audio') {
      const filePath = getTrackPath(requestUrl.searchParams.get('id'));
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(response, 404, { ok: false, message: 'No se encontró el tema.' });
        return;
      }
      const { size } = fs.statSync(filePath);
      const range = request.headers.range;
      let start = 0;
      let end = size - 1;
      let status = 200;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          response.writeHead(416, { 'Content-Range': `bytes */${size}` });
          response.end();
          return;
        }
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : end;
        } else {
          start = Math.max(0, size - Number(match[2]));
        }
        if (start > end || start >= size) {
          response.writeHead(416, { 'Content-Range': `bytes */${size}` });
          response.end();
          return;
        }
        end = Math.min(end, size - 1);
        status = 206;
      }
      const headers = {
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'application/octet-stream',
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      response.writeHead(status, headers);
      pipeline(fs.createReadStream(filePath, { start, end }), response, () => {});
      return;
    }
    if (request.method === 'DELETE' && requestUrl.pathname === '/api/tracks') {
      const filePath = getTrackPath(requestUrl.searchParams.get('id'));
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(response, 404, { ok: false, message: 'No se encontró el tema.' });
        return;
      }
      fs.unlinkSync(filePath);
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { ok: false, message: 'Ruta no encontrada.' });
  }

  return http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      sendJson(response, error.status || 500, {
        ok: false,
        message: error.status ? error.message : 'No se pudo completar la operación de almacenamiento.',
      });
    });
  });
}

function startServer({
  port = Number(process.env.PORT || 3001),
  host = process.env.HOST || '0.0.0.0',
  createServer = createLibraryServer,
} = {}) {
  const server = createServer();
  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : port;
    console.log(`Biblioteca externa disponible en http://localhost:${listeningPort}`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { createLibraryServer, startServer };
