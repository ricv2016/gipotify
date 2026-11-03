# Gipotify

Reproductor de música personal para Android que funciona **sin internet** (incluso en modo avión).
Es una PWA: se instala desde Chrome y luego abre como una app más.

- **Tu música, no la de terceros:** MP3, WAV, M4A, FLAC, OGG. No descarga nada de internet.
- **Tarjeta SD:** "Buscar en la tarjeta SD o el celular" enlaza una carpeta y lee la música directo de ahí, sin copiarla
  (Chrome 132+ en Android). "Volver a escanear" agrega lo nuevo y quita lo que ya no está.
- **Copiar a la app:** alternativa que guarda las canciones dentro de la app.
- Biblioteca por canciones, álbumes y artistas; búsqueda sin importar acentos; Favoritas y listas propias.
- Lee etiquetas ID3 (v1, v2.2–2.4) y RIFF INFO de WAV, carátulas incrustadas y `cover.jpg`/`folder.jpg`.
- Controles en pantalla bloqueada y botones de audífonos Bluetooth (Media Session API).
- Batería: la música suena con la pantalla apagada; solo al importar o escanear se mantiene encendida.

La música nunca sale del celular: este repositorio solo contiene el código de la app.

## Instalar en el celular

1. Abrir la dirección de GitHub Pages del proyecto en Chrome (Android).
2. Menú ⋮ → "Instalar app" o "Agregar a la pantalla principal".
3. Abrir Gipotify y elegir la carpeta de música.

## Desarrollo

Sin dependencias ni compilación: HTML, CSS y JavaScript (módulos ES).

```
python -m http.server 8765
```

y abrir `http://localhost:8765`.

**Importante:** al cambiar cualquier archivo, subir `VERSION` en `sw.js`; si no, los celulares siguen usando la versión guardada.

Íconos: `python tools/make_icons.py` (requiere Pillow).
