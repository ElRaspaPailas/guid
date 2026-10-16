# Pantallas de Embarque — GIDS (Gate Information Display System)
### Sistema de Información de Puertas de Embarque para Aeropuertos

Aplicación web desacoplada, configurable y de estándar aeroportuario internacional para proyectar la información en tiempo real de cada puerta de embarque (Gate Display). Se integra de forma limpia y transparente con **TV-Controler** como gestor de contenidos y señalización digital (Digital Signage).

---

## 1. Características Principales

- **Multi-Aeropuerto:** Totalmente parametrizable mediante variables de entorno (`.env`) y panel de configuración web administrativo (`/panel`).
- **Resiliente y Tolerante a Fallos:** Caché inteligente local de vuelos, persistencia de estado y modo Standby institucional cuando no hay operaciones activas o hay intermitencia de red.
- **Auto-Ajuste de Destinos:** Motor dinámico de escalado de tipografía que ajusta automáticamente los nombres de ciudades largas sin recortar texto ni desbordar la interfaz.
- **Pantalla Completa Automática:** Soporte para maximizado en televisores mediante clic/toque, atajos de teclado (`f` / `F11`) y comunicación por `postMessage` para reproductores embebidos (TV-Controler).
- **Seguridad Robusta:** Autenticación delegada contra TV-Controler, cookies firmadas criptográficamente con HMAC-SHA256, protección anti-SSRF para redes locales privadas y ejecución como usuario sin privilegios (`node:alpine` no-root).

---

## 2. Requisitos Previos

- **Node.js** >= 18.x (si se instala directamente en el host) o **Docker** + **Docker Compose**.
- Conectividad de red hacia el servidor **FIDS central** del aeropuerto.
- Conectividad hacia la instancia de **TV-Controler** (recomendado: alojados en el mismo servidor/IP o en la misma red local).

---

## 3. Instalación Rápida

### Opción A: Despliegue con Docker (Recomendado)

1. Clonar o copiar el proyecto en el servidor de destino:
   ```bash
   cd /opt/pantallas
   ```

2. Crear y personalizar el archivo de variables de entorno:
   ```bash
   cp .env.example .env
   nano .env
   ```

3. Iniciar el contenedor:
   ```bash
   docker compose up -d
   ```

### Opción B: Instalación Tradicional con Node.js / Systemd

1. Instalar dependencias de producción:
   ```bash
   npm install --omit=dev
   ```

2. Configurar el archivo `.env`:
   ```bash
   cp .env.example .env
   nano .env
   ```

3. Iniciar el servicio:
   ```bash
   node server.js
   ```

---

## 4. Configuración del Entorno (`.env`)

| Variable | Descripción | Valor por Defecto |
| :--- | :--- | :--- |
| `PORT` | Puerto HTTP donde corre el servicio GIDS | `3002` |
| `FIDS_URL` | Dirección URL o IP del FIDS central del aeropuerto | `http://127.0.0.1:8080` |
| `AIRPORT_NAME` | Nombre oficial del aeropuerto que se mostrará en pantallas | `Aeropuerto Internacional` |
| `AIRPORT_CODE` | Código IATA o OACI del aeropuerto | `AER` |
| `POLL_INTERVAL_MS`| Frecuencia de actualización hacia el FIDS en milisegundos | `15000` (15 segundos) |
| `DEFAULT_GATES` | Lista de puertas habilitadas por defecto (separadas por coma) | `1,2,3,4,5,6,7,8,9,10` |
| `TV_CONTROLER_URL`| URL de TV-Controler para autenticar el panel administrativo | `http://127.0.0.1:3001` |
| `PANEL_SESSION_SECRET`| Clave secreta para firmar cookies de sesión del panel | *(cadena aleatoria segura)* |
| `PANEL_SESSION_TTL_MS`| Duración de la sesión administrativa en ms | `14400000` (4 horas) |
| `ENABLE_GENERAL_FIDS`| Activa la retransmisión de FIDS general en puertas sin vuelo | `false` |
| `CORS_ORIGINS` | Orígenes adicionales permitidos para CORS | *(vacío)* |
| `ALLOWED_FIDS_HOSTS`| Lista blanca de hosts FIDS adicionales | *(permite RFC1918)* |

---

## 5. Integración con TV-Controler

Cada televisor ubicado en una puerta de embarque debe configurarse en TV-Controler con un widget tipo **Webpage** apuntando a su URL correspondiente:

```
http://<IP_SERVIDOR_GIDS>:3002/?puerta=1
http://<IP_SERVIDOR_GIDS>:3002/?puerta=2
http://<IP_SERVIDOR_GIDS>:3002/?puerta=3
...
```

El sistema detecta automáticamente la puerta tanto por parámetro (`?puerta=N`), ruta (`/puerta/N`) o por el nombre asignado a la pantalla en TV-Controler.

---

## 6. Panel de Administración y Supervisión

Acceso web al panel de control:
```
http://<IP_SERVIDOR_GIDS>:3002/panel
```

Permite:
- Probar conectividad en tiempo real con el servidor FIDS.
- Cambiar la URL del FIDS sin reiniciar el servicio.
- Configurar el nombre oficial y código del aeropuerto con vista previa interactiva.
- Activar o desactivar puertas de embarque operativas.
- Monitorear el estado de cada puerta y vuelo asignado.

---

## 7. Licencia

Proyecto desarrollado bajo estándar aeroportuario. Licencia MIT.
