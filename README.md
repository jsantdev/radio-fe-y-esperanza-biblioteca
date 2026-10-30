# Biblioteca musical

Servicio HTTP con una interfaz web para organizar, escuchar y subir archivos de audio por disco. También incluye una API para crear discos, cargar y listar temas, transmitir audio (incluidos rangos para reproducción parcial) y eliminar temas.

## Requisitos

- Node.js 18 o posterior.
- Un volumen persistente para conservar los archivos entre reinicios y nuevos despliegues.

El proyecto no requiere paquetes npm de terceros.

## Despliegue en Easypanel

1. Crea un servicio de tipo **App** conectado a este repositorio y a la rama `main`. Usa la raíz del repositorio como directorio del proyecto.
2. Deja que Nixpacks detecte Node.js mediante `package.json`. El comando de inicio es `npm start`; no se necesita un Dockerfile.
3. Añade un volumen persistente y móntalo, por ejemplo, en `/data`.
4. Define la variable de entorno `BIBLIOTECA_DATA_DIR` con la ruta `/data/discs`. La aplicación crea esa carpeta si aún no existe.
5. Configura el puerto interno del servicio como `3001` si Easypanel solicita uno. El proceso escucha en `PORT` cuando la plataforma lo proporciona y, si no, en `3001`; también se puede cambiar mediante `HOST` (por defecto `0.0.0.0`).
6. Asigna un dominio o una ruta de proxy al servicio. Comprueba el estado con `GET /api/health`.

**No omitas el volumen persistente.** Sin él, los discos y audios se guardan en el sistema de archivos efímero del contenedor y pueden perderse al reconstruir o reemplazar el servicio. Haz copias de seguridad del volumen montado.

Al abrir el dominio del servicio se muestra el administrador web de la biblioteca. Desde ahí puedes crear y seleccionar un disco, elegir un archivo, escucharlo antes de subirlo, cambiar el nombre con el que se guardará y consultar o reproducir los temas existentes. Para guardar un tema siempre hay que seleccionar un disco. El nombre cambiado se aplica al archivo guardado; el archivo original del dispositivo no se modifica.

### Seguridad de publicación

La API no tiene autenticación ni autorización: cualquier cliente que pueda acceder al servicio puede listar y reproducir los temas, cargar archivos y eliminar temas. Publícala sólo en una red privada o protégela con autenticación y controles de acceso en un proxy inverso. El servicio tampoco configura CORS; las aplicaciones web en otro origen necesitan un proxy del mismo origen o una política CORS configurada delante del servicio.

## Ejecución local

```sh
npm start
```

Por defecto escucha en `http://localhost:3001` y guarda los datos en `data/discs`, junto a `server.js`. Para cambiar la ubicación, define `BIBLIOTECA_DATA_DIR` antes de iniciar el proceso. También puedes definir `PORT` y `HOST`.

Para ejecutar las pruebas:

```sh
npm test
```

## Almacenamiento y límites

- Cada disco se guarda en una carpeta cuyo identificador se genera a partir de su nombre (minúsculas, sin acentos y con guiones).
- El nombre original del disco se conserva en `.disc-name.json`.
- Se aceptan archivos `.aac`, `.m4a`, `.mp3`, `.ogg`, `.opus` y `.wav`, sin distinguir mayúsculas de minúsculas en la extensión.
- El tamaño máximo de la solicitud para crear un disco o cargar un tema es 100 MiB. Para archivos de audio, se recomienda mantener el tamaño por debajo de ese límite.
- El nombre de un disco admite hasta 100 caracteres. El nombre de archivo admite hasta 180 caracteres y debe ser un nombre simple, sin rutas ni caracteres de control.
- No se permite cargar dos archivos con el mismo nombre en el mismo disco. La API devuelve `409 Conflict` en ese caso.
- Eliminar el último tema no elimina la carpeta ni el disco.

## API HTTP

Sustituye `https://biblioteca.ejemplo.com` por la URL pública o privada configurada para el servicio. Las respuestas JSON usan UTF-8.

Los ejemplos con `curl` usan sintaxis de shell POSIX. En Windows PowerShell, ejecuta `curl.exe` en lugar del alias `curl` y sustituye los saltos de línea `\` por una sola línea o por el carácter de continuación de PowerShell.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/health` | Comprueba que el servicio responde. |
| `GET` | `/api/discs` | Lista los discos y sus temas. |
| `POST` | `/api/discs` | Crea un disco vacío o devuelve el existente. |
| `POST` | `/api/tracks?disc={nombre}` | Carga un archivo de audio en un disco. |
| `GET` | `/api/audio?id={disco}/{archivo}` | Reproduce o descarga un tema; admite `Range`. |
| `DELETE` | `/api/tracks?id={disco}/{archivo}` | Elimina un tema. |

### Comprobar el servicio

```sh
curl https://biblioteca.ejemplo.com/api/health
```

Respuesta:

```json
{"ok":true}
```

### Listar discos y temas

```sh
curl https://biblioteca.ejemplo.com/api/discs
```

La respuesta contiene `discs`; cada disco incluye `id`, `name` y `tracks`. Cada tema incluye `id`, `name`, `title`, `discId` y `discName`. Usa el `id` del tema tal como lo devuelve la API para reproducirlo o eliminarlo.

### Crear un disco vacío

Envía el nombre como JSON:

```sh
curl -X POST https://biblioteca.ejemplo.com/api/discs \
  -H "Content-Type: application/json" \
  -d '{"name":"Rock en español"}'
```

Una creación nueva devuelve `201 Created`; si el disco ya existe, devuelve `200 OK`. En ambos casos la respuesta incluye `disc` (`id` y `name`) y `created` (`true` o `false`).

### Cargar un tema

El cuerpo de la solicitud es el archivo binario, no JSON. El parámetro `disc` contiene el nombre del disco y la cabecera `X-File-Name` contiene el nombre del archivo codificado con URL encoding:

```sh
curl -X POST "https://biblioteca.ejemplo.com/api/tracks?disc=Rock%20en%20espa%C3%B1ol" \
  -H "X-File-Name: tema.mp3" \
  -H "Content-Type: audio/mpeg" \
  --data-binary "@tema.mp3"
```

Una carga correcta devuelve `201 Created` y el objeto `track`. El disco se crea automáticamente si no existe. Se devuelve `409 Conflict` si ya existe un tema con ese nombre.

### Reproducir o descargar un tema

Pasa en `id` el identificador de tema devuelto al listar o cargar archivos. Codifica el valor como parámetro de URL; por ejemplo:

```sh
curl --get "https://biblioteca.ejemplo.com/api/audio" \
  --data-urlencode "id=rock-en-espanol/tema.mp3" \
  --output tema.mp3
```

El endpoint admite solicitudes `Range` de bytes y responde `206 Partial Content` para permitir reproducción por partes. Sin un rango, responde `200 OK`.

### Eliminar un tema

La eliminación es permanente. Verifica el `id` antes de ejecutar la solicitud:

```sh
curl -X DELETE --get "https://biblioteca.ejemplo.com/api/tracks" \
  --data-urlencode "id=rock-en-espanol/tema.mp3"
```

Una eliminación correcta responde `{"ok":true}`. El disco permanece aunque quede vacío.

## Errores

Las operaciones que devuelven errores JSON incluyen `ok: false` y un mensaje:

- `400 Bad Request`: JSON, nombre de disco o nombre/formato de archivo inválido; también se rechazan cargas vacías.
- `404 Not Found`: ruta, disco/archivo solicitado o tema inexistente.
- `409 Conflict`: ya existe un tema con ese nombre en el disco.
- `413 Payload Too Large`: la solicitud supera 100 MiB.
- `500 Internal Server Error`: error interno de almacenamiento.

Una respuesta `416 Range Not Satisfiable` indica que el rango de bytes solicitado para reproducir el archivo no es válido.
