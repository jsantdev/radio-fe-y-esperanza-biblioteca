const assert = require('node:assert/strict');
const fs = require('node:fs');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLibraryServer } = require('../server');

test('external library creates named empty discs and reuses them when uploading tracks', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-library-'));
  const server = createLibraryServer({ dataDirectory: path.join(storage, 'discs') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(baseUrl).then((response) => response.text());
    assert.match(page, /Subir temas por disco/);
    assert.match(page, /Borrar disco/);
    assert.match(page, /Borrar tema/);
    assert.match(page, /Repetir playlist al llegar al final/);
    assert.match(page, /Programar canciones/);
    assert.match(page, /rel="manifest" href="\/manifest.webmanifest"/);
    assert.match(page, /serviceWorker\.register\('\/service-worker\.js'\)/);
    const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
    for (const size of [192, 512]) {
      const iconResponse = await fetch(`${baseUrl}/icons/icon-${size}.png`);
      assert.equal(iconResponse.status, 200);
      const icon = Buffer.from(await iconResponse.arrayBuffer());
      assert.equal(icon.toString('hex', 0, 8), '89504e470d0a1a0a');
      assert.equal(icon.readUInt32BE(16), size);
      assert.equal(icon.readUInt32BE(20), size);
    }

    const created = await fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Álbum Favorito' }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      disc: { id: 'album-favorito', name: 'Álbum Favorito' },
      created: true,
    });
    assert.deepEqual((await fetch(`${baseUrl}/api/discs`).then((response) => response.json())).discs[0].tracks, []);

    const existing = await fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Álbum Favorito' }),
    });
    assert.equal(existing.status, 200);
    assert.equal((await existing.json()).created, false);

    const uploaded = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent('Álbum Favorito')}`, {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent('Canción.mp3'), 'Content-Type': 'audio/mpeg' },
      body: Buffer.from('audio'),
    });
    assert.equal(uploaded.status, 201);
    const library = await fetch(`${baseUrl}/api/discs`).then((response) => response.json());
    assert.equal(library.discs[0].name, 'Álbum Favorito');
    assert.equal(library.discs[0].tracks.length, 1);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('library persists the player queue and current playback across restarts', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-player-state-'));
  const dataDirectory = path.join(storage, 'discs');
  let server = createLibraryServer({ dataDirectory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const created = await fetch(`${baseUrl}/api/discs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temas de prueba' }),
    });
    assert.equal(created.status, 201);
    for (const filename of ['Primera.mp3', 'Segunda.mp3']) {
      const uploaded = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent('Temas de prueba')}`, {
        method: 'POST',
        headers: { 'X-File-Name': encodeURIComponent(filename) },
        body: Buffer.from(filename),
      });
      assert.equal(uploaded.status, 201);
    }

    const queue = ['temas-de-prueba/Primera.mp3', 'temas-de-prueba/Segunda.mp3'];
    const updated = await fetch(`${baseUrl}/api/player/playlist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: queue, repeat: false }),
    });
    assert.equal(updated.status, 200);
    const selected = await fetch(`${baseUrl}/api/player/current`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 1 }),
    });
    assert.equal(selected.status, 200);
    const playing = await fetch(`${baseUrl}/api/player/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPlaying: true }),
    });
    assert.equal(playing.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(storage, 'player-state.json'), 'utf8')), {
      queue,
      currentIndex: 1,
      isPlaying: true,
      repeat: false,
    });

    const closed = once(server, 'close');
    server.close();
    await closed;
    server = createLibraryServer({ dataDirectory });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const restored = await fetch(`${baseUrl}/api/player/state`).then((response) => response.json());
    assert.deepEqual(restored.queue.map((track) => track.id), queue);
    assert.equal(restored.currentIndex, 1);
    assert.equal(restored.currentTrack.title, 'Segunda');
    assert.equal(restored.isPlaying, true);
    assert.equal(restored.repeat, false);
    assert.equal(await fetch(`${baseUrl}/api/player/audio`).then((response) => response.text()), 'Segunda.mp3');
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('external library creates, lists, reads, and deletes audio grouped by disc', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-library-'));
  const server = createLibraryServer({ dataDirectory: path.join(storage, 'discs') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const audio = Buffer.from('audio bytes');

  try {
    const upload = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent('Mi Álbum')}`, {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent('Canción.mp3'), 'Content-Type': 'audio/mpeg' },
      body: audio,
    });
    assert.equal(upload.status, 201);
    const { track } = await upload.json();
    assert.equal(track.id, 'mi-album/Canción.mp3');

    const discs = await fetch(`${baseUrl}/api/discs`).then((response) => response.json());
    assert.equal(discs.discs[0].id, 'mi-album');
    assert.equal(discs.discs[0].name, 'Mi Álbum');
    assert.equal(discs.discs[0].tracks[0].title, 'Canción');

    const read = await fetch(`${baseUrl}/api/audio?id=${encodeURIComponent(track.id)}`);
    assert.equal(read.status, 200);
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), audio);
    const partial = await fetch(`${baseUrl}/api/audio?id=${encodeURIComponent(track.id)}`, {
      headers: { Range: 'bytes=0-4' },
    });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), 'audio');

    const deleted = await fetch(`${baseUrl}/api/tracks?id=${encodeURIComponent(track.id)}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const remainingDisc = (await fetch(`${baseUrl}/api/discs`).then((response) => response.json())).discs[0];
    assert.equal(remainingDisc.name, 'Mi Álbum');
    assert.deepEqual(remainingDisc.tracks, []);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('deleting a disc removes its tracks from the library, playlist, and schedules', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-delete-disc-'));
  const server = createLibraryServer({ dataDirectory: path.join(storage, 'discs') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function upload(disc, filename) {
    const response = await fetch(`${baseUrl}/api/tracks?disc=${encodeURIComponent(disc)}`, {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent(filename), 'Content-Type': 'audio/mpeg' },
      body: Buffer.from(filename),
    });
    assert.equal(response.status, 201);
    return (await response.json()).track;
  }

  try {
    const first = await upload('Disco para borrar', 'Primera.mp3');
    const second = await upload('Disco para borrar', 'Segunda.mp3');
    const keep = await upload('Disco conservado', 'Conservar.mp3');
    const playlist = await fetch(`${baseUrl}/api/player/playlist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: [first.id, keep.id, second.id] }),
    });
    assert.equal(playlist.status, 200);
    const schedule = await fetch(`${baseUrl}/api/schedules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schedules: [{
          id: 'delete-disc-schedule',
          trackId: second.id,
          scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          recurrence: 'once',
        }],
      }),
    });
    assert.equal(schedule.status, 200);

    const deleted = await fetch(`${baseUrl}/api/discs?id=${encodeURIComponent(first.discId)}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const library = await fetch(`${baseUrl}/api/discs`).then((response) => response.json());
    assert.deepEqual(library.discs.map((disc) => disc.id), [keep.discId]);
    const player = await fetch(`${baseUrl}/api/player/state`).then((response) => response.json());
    assert.deepEqual(player.queue.map((track) => track.id), [keep.id]);
    assert.equal(player.currentTrack.id, keep.id);
    const schedules = await fetch(`${baseUrl}/api/schedules`).then((response) => response.json());
    assert.deepEqual(schedules.schedules, []);
    assert.equal((await fetch(`${baseUrl}/api/audio?id=${encodeURIComponent(first.id)}`)).status, 404);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('external library rejects invalid names and duplicate tracks', async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-library-'));
  const server = createLibraryServer({ dataDirectory: path.join(storage, 'discs') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const options = {
    method: 'POST',
    headers: { 'X-File-Name': encodeURIComponent('Tema.mp3'), 'Content-Type': 'audio/mpeg' },
    body: Buffer.from('audio'),
  };
  try {
    assert.equal((await fetch(`${baseUrl}/api/tracks?disc=Rock`, options)).status, 201);
    assert.equal((await fetch(`${baseUrl}/api/tracks?disc=Rock`, options)).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/tracks?disc=Rock`, {
      ...options,
      headers: { ...options.headers, 'X-File-Name': encodeURIComponent('..\\outside.mp3') },
    })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/audio?id=${encodeURIComponent('../outside.mp3')}`)).status, 404);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});
