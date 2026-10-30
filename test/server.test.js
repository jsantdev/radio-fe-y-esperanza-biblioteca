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
