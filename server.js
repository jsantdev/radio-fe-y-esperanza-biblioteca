const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pipeline } = require('node:stream');

const audioExtensions = new Set(['.aac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);
const maxAudioFileSize = 100 * 1024 * 1024;

function createLibraryServer({
  dataDirectory = process.env.BIBLIOTECA_DATA_DIR || path.join(__dirname, 'data', 'discs'),
  maxFileSize = maxAudioFileSize,
  logger = console,
} = {}) {
  const rootDirectory = path.resolve(dataDirectory);
  const stateDirectory = path.dirname(rootDirectory);
  const playerStatePath = path.join(stateDirectory, 'player-state.json');
  const schedulesPath = path.join(stateDirectory, 'song-schedules.json');
  fs.mkdirSync(rootDirectory, { recursive: true });
  let playerState = { queue: [], currentIndex: null, isPlaying: false, repeat: true };
  let schedules = [];
  if (fs.existsSync(schedulesPath)) {
    const savedSchedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
    if (!Array.isArray(savedSchedules)) throw new Error('La programación de canciones no es válida.');
    schedules = savedSchedules;
  }

  function saveSchedules(nextSchedules) {
    fs.mkdirSync(path.dirname(schedulesPath), { recursive: true });
    fs.writeFileSync(schedulesPath, JSON.stringify(nextSchedules, null, 2));
    schedules = nextSchedules;
  }

  function validateSchedules(value) {
    if (!Array.isArray(value) || value.length > 200) {
      const error = new Error('La programación debe incluir hasta 200 canciones.');
      error.status = 400;
      throw error;
    }
    const trackIds = new Set(listDiscs().flatMap((disc) => disc.tracks.map((track) => track.id)));
    const ids = new Set();
    return value.map((schedule) => {
      if (!schedule || typeof schedule.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(schedule.id)
        || ids.has(schedule.id) || typeof schedule.trackId !== 'string' || !trackIds.has(schedule.trackId)
        || typeof schedule.scheduledAt !== 'string' || !Number.isFinite(Date.parse(schedule.scheduledAt))
        || !['once', 'daily', 'weekly'].includes(schedule.recurrence)) {
        const error = new Error('Cada programación debe tener un tema y una fecha válidos.');
        error.status = 400;
        throw error;
      }
      ids.add(schedule.id);
      return {
        id: schedule.id,
        trackId: schedule.trackId,
        scheduledAt: new Date(schedule.scheduledAt).toISOString(),
        recurrence: schedule.recurrence,
      };
    });
  }

  function savePlayerState(nextState) {
    fs.mkdirSync(path.dirname(playerStatePath), { recursive: true });
    fs.writeFileSync(playerStatePath, JSON.stringify(nextState, null, 2));
    playerState = nextState;
    return getPlayerSnapshot();
  }

  function removeTracksFromPlayer(trackIds) {
    const removed = new Set(trackIds);
    if (playerState.queue.some((id) => removed.has(id))) {
      const selectedTrack = playerState.currentIndex === null ? null : playerState.queue[playerState.currentIndex];
      const queue = playerState.queue.filter((id) => !removed.has(id));
      const currentIndex = selectedTrack && queue.includes(selectedTrack)
        ? queue.indexOf(selectedTrack)
        : queue.length ? 0 : null;
      savePlayerState({
        ...playerState,
        queue,
        currentIndex,
        isPlaying: currentIndex === null ? false : playerState.isPlaying,
      });
    }
    const nextSchedules = schedules.filter((schedule) => !removed.has(schedule.trackId));
    if (nextSchedules.length !== schedules.length) saveSchedules(nextSchedules);
  }

  function getPlayerSnapshot() {
    const tracks = new Map(listDiscs().flatMap((disc) => disc.tracks.map((track) => [track.id, track])));
    const queue = playerState.queue.map((id) => {
      const track = tracks.get(id);
      return track && { ...track, url: '/api/player/audio' };
    }).filter(Boolean);
    const currentTrack = playerState.currentIndex === null ? null : queue[playerState.currentIndex] || null;
    return {
      status: queue.length ? 'ready' : 'empty',
      audioSource: 'library',
      queue,
      currentIndex: currentTrack ? playerState.currentIndex : null,
      currentTrack,
      isPlaying: Boolean(currentTrack && playerState.isPlaying),
      repeat: playerState.repeat,
    };
  }

  function validatePlayerPlaylist(value) {
    if (!Array.isArray(value) || value.length > 5000
      || value.some((id) => typeof id !== 'string')
      || new Set(value).size !== value.length) {
      const error = new Error('La playlist debe incluir hasta 5000 temas disponibles y sin duplicados.');
      error.status = 400;
      throw error;
    }
    const availableTracks = new Set(listDiscs().flatMap((disc) => disc.tracks.map((track) => track.id)));
    if (value.some((id) => !availableTracks.has(id))) {
      const error = new Error('La playlist incluye temas que no están en la biblioteca.');
      error.status = 400;
      throw error;
    }
  }

  function updatePlayerPlaylist(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const error = new Error('La playlist debe enviarse como JSON válido.');
      error.status = 400;
      throw error;
    }
    validatePlayerPlaylist(payload.tracks);
    if (payload.repeat !== undefined && typeof payload.repeat !== 'boolean') {
      const error = new Error('La repetición de playlist debe ser booleana.');
      error.status = 400;
      throw error;
    }
    const selectedTrack = playerState.currentIndex === null ? null : playerState.queue[playerState.currentIndex];
    const queue = payload.tracks;
    const currentIndex = selectedTrack && queue.includes(selectedTrack)
      ? queue.indexOf(selectedTrack)
      : queue.length ? 0 : null;
    return { state: savePlayerState({
      queue,
      currentIndex,
      isPlaying: currentIndex === null ? false : playerState.isPlaying,
      repeat: payload.repeat === undefined ? playerState.repeat : payload.repeat,
    }) };
  }

  function setCurrentTrack(index) {
    if (!Number.isInteger(index) || index < 0 || index >= playerState.queue.length) {
      const error = new Error('El índice no corresponde a una canción de la playlist.');
      error.status = 400;
      throw error;
    }
    return { state: savePlayerState({ ...playerState, currentIndex: index }) };
  }

  function movePlayerTrack(direction) {
    const { queue, currentIndex, repeat } = playerState;
    if (!queue.length) {
      const error = new Error('La playlist está vacía.');
      error.status = 409;
      throw error;
    }
    if (currentIndex === null) return { state: savePlayerState({ ...playerState, currentIndex: 0 }) };
    if (direction > 0 && currentIndex === queue.length - 1 && !repeat) {
      return { state: savePlayerState({ ...playerState, isPlaying: false }) };
    }
    const nextIndex = direction < 0 && currentIndex === 0 && !repeat
      ? 0
      : (currentIndex + direction + queue.length) % queue.length;
    return { state: savePlayerState({ ...playerState, currentIndex: nextIndex }) };
  }

  function setPlaybackState(isPlaying) {
    if (typeof isPlaying !== 'boolean') {
      const error = new Error('El estado de reproducción debe ser booleano.');
      error.status = 400;
      throw error;
    }
    return { state: savePlayerState({ ...playerState, isPlaying: isPlaying && playerState.queue.length > 0 }) };
  }

  function playScheduledTrack(trackId) {
    validatePlayerPlaylist({ tracks: [trackId] });
    const queue = playerState.queue.includes(trackId) ? playerState.queue : [...playerState.queue, trackId];
    return savePlayerState({
      ...playerState,
      queue,
      currentIndex: queue.indexOf(trackId),
      isPlaying: true,
    });
  }

  async function processDueSchedules() {
    const now = new Date();
    const due = schedules.filter((schedule) => Date.parse(schedule.scheduledAt) <= now.getTime());
    for (const schedule of due) {
      try {
        playScheduledTrack(schedule.trackId);
        const nextSchedules = schedules.map((entry) => {
          if (entry.id !== schedule.id) return entry;
          if (entry.recurrence === 'once') return null;
          const nextAt = new Date(entry.scheduledAt);
          const interval = entry.recurrence === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
          do {
            nextAt.setTime(nextAt.getTime() + interval);
          } while (nextAt.getTime() <= now.getTime());
          return { ...entry, scheduledAt: nextAt.toISOString() };
        }).filter(Boolean);
        saveSchedules(nextSchedules);
      } catch (error) {
        logger.error(`No se pudo reproducir una canción programada: ${error.message}`);
      }
    }
  }

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

  if (fs.existsSync(playerStatePath)) {
    const savedState = JSON.parse(fs.readFileSync(playerStatePath, 'utf8'));
    if (!savedState || !Array.isArray(savedState.queue)
      || savedState.queue.some((id) => typeof id !== 'string')
      || new Set(savedState.queue).size !== savedState.queue.length
      || typeof savedState.isPlaying !== 'boolean' || typeof savedState.repeat !== 'boolean'
      || !(savedState.currentIndex === null
        || Number.isInteger(savedState.currentIndex) && savedState.currentIndex >= 0
          && savedState.currentIndex < savedState.queue.length)) {
      throw new Error('El estado guardado del reproductor no es válido.');
    }
    const availableTracks = new Set(listDiscs().flatMap((disc) => disc.tracks.map((track) => track.id)));
    const queue = savedState.queue.filter((id) => availableTracks.has(id));
    const currentTrack = savedState.currentIndex === null ? null : savedState.queue[savedState.currentIndex];
    playerState = {
      ...savedState,
      queue,
      currentIndex: currentTrack && queue.includes(currentTrack)
        ? queue.indexOf(currentTrack)
        : queue.length ? 0 : null,
      isPlaying: Boolean(queue.length && savedState.isPlaying),
    };
    if (JSON.stringify(playerState) !== JSON.stringify(savedState)) {
      fs.writeFileSync(playerStatePath, JSON.stringify(playerState, null, 2));
    }
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

  function streamAudio(response, filePath, range) {
    const { size } = fs.statSync(filePath);
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
  }

  async function handleRequest(request, response) {
    const requestUrl = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && ['/', '/index.html'].includes(requestUrl.pathname)) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/manifest.webmanifest') {
      response.writeHead(200, {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      response.end(fs.readFileSync(path.join(__dirname, 'public', 'manifest.webmanifest')));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/service-worker.js') {
      response.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
      });
      response.end(fs.readFileSync(path.join(__dirname, 'public', 'service-worker.js')));
      return;
    }
    const icon = /^\/icons\/(icon-(?:192|512)\.png)$/.exec(requestUrl.pathname);
    if (request.method === 'GET' && icon) {
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      response.end(fs.readFileSync(path.join(__dirname, 'public', 'icons', icon[1])));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/player/state') {
      sendJson(response, 200, getPlayerSnapshot());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/player/playlist') {
      sendJson(response, 200, getPlayerSnapshot());
      return;
    }
    if (request.method === 'PUT' && requestUrl.pathname === '/api/player/playlist') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch {
        const invalidJson = new Error('La playlist debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      sendJson(response, 200, updatePlayerPlaylist(payload));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/player/current') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch {
        const invalidJson = new Error('La canción debe seleccionarse con JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      sendJson(response, 200, setCurrentTrack(payload?.index));
      return;
    }
    const playerAction = /^\/api\/player\/(next|previous|playback)$/.exec(requestUrl.pathname);
    if (playerAction && request.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch {
        const invalidJson = new Error('La acción del reproductor debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      const result = playerAction[1] === 'playback'
        ? setPlaybackState(payload?.isPlaying)
        : movePlayerTrack(playerAction[1] === 'next' ? 1 : -1);
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/player/audio') {
      const currentTrackId = playerState.currentIndex === null
        ? null
        : playerState.queue[playerState.currentIndex];
      const filePath = getTrackPath(currentTrackId);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(response, 404, { ok: false, message: 'No hay una canción activa para reproducir.' });
        return;
      }
      streamAudio(response, filePath, request.headers.range);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/schedules') {
      sendJson(response, 200, { schedules });
      return;
    }
    if (request.method === 'PUT' && requestUrl.pathname === '/api/schedules') {
      let payload;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8'));
      } catch {
        const invalidJson = new Error('La programación debe enviarse como JSON válido.');
        invalidJson.status = 400;
        throw invalidJson;
      }
      const nextSchedules = validateSchedules(payload?.schedules);
      saveSchedules(nextSchedules);
      sendJson(response, 200, { schedules });
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
    if (request.method === 'DELETE' && requestUrl.pathname === '/api/discs') {
      const discId = requestUrl.searchParams.get('id');
      if (typeof discId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(discId)) {
        sendJson(response, 400, { ok: false, message: 'El disco indicado no es válido.' });
        return;
      }
      const discDirectory = path.resolve(rootDirectory, discId);
      if (path.dirname(discDirectory) !== rootDirectory || !fs.existsSync(discDirectory)
        || !fs.statSync(discDirectory).isDirectory()) {
        sendJson(response, 404, { ok: false, message: 'No se encontró el disco.' });
        return;
      }
      const trackIds = listDiscs().find((disc) => disc.id === discId)?.tracks.map((track) => track.id) || [];
      fs.rmSync(discDirectory, { recursive: true });
      removeTracksFromPlayer(trackIds);
      sendJson(response, 200, { ok: true });
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
      streamAudio(response, filePath, request.headers.range);
      return;
    }
    if (request.method === 'DELETE' && requestUrl.pathname === '/api/tracks') {
      const trackId = requestUrl.searchParams.get('id');
      const filePath = getTrackPath(trackId);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(response, 404, { ok: false, message: 'No se encontró el tema.' });
        return;
      }
      fs.unlinkSync(filePath);
      removeTracksFromPlayer([trackId]);
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { ok: false, message: 'Ruta no encontrada.' });
  }

  const server = http.createServer((request, response) => {
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
  const scheduleTimer = setInterval(() => {
    processDueSchedules().catch((error) => logger.error(`No se pudo revisar la programación: ${error.message}`));
  }, 10000);
  scheduleTimer.unref();
  server.once('close', () => clearInterval(scheduleTimer));
  return server;
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
